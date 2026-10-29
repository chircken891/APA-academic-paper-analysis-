import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadingFirstRunControl, acceptReadingFirstResult, getReadingFirstState, restoreReadingFirstRuntime, snapshotReadingFirstRuntime, createReadingFirstDraftRequests } from '../../scripts/v3/reading-first-runtime.mjs';
import { commitOwnedArtifact } from '../../scripts/v3/owned-artifact-store.mjs';
import { createApaRoleModelPolicy } from '../../scripts/apa-model-policy.mjs';
import { buildConfiguredReadingInstructions, prepareConfiguredReading } from '../../scripts/v3/configured-reading.mjs';
import { createScienceController, restoreScienceController, getScienceState, prepareScienceRequests, recordScienceDispatchIntent, recordScienceHostObservation, acceptScienceResult, getScienceRequest, createScienceHandoff } from '../../scripts/v3/science-controller.mjs';
const roles = ['evidence','methods','results','interpretation','scientific-reading','integration'];
const sha = b => 'sha256:' + createHash('sha256').update(b).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(),'science-controller-')); t.after(() => rm(root,{recursive:true,force:true}));
  const source = Buffer.from('synthetic source'); await writeFile(join(root,'paper.pdf'),source);
  const tasks = Object.fromEntries(roles.map(role=>[role,{task_id:role,task_name:role.replace('-','_'),owner_actor_id:role,role,artifact_id:role,artifact_path:'science/'+role+'.json',native_path:'native/'+role+'.json',...(role==='evidence'?{instruction_path:'instructions/evidence.txt'}:{}),revision:'1'}]));
  const downstream = Object.fromEntries(['en','zh-CN','review'].map(key=>[key,{task_id:key,task_name:'writer_'+key.replace('-','_').toLowerCase(),owner_actor_id:key,role:key==='en'?'english-writer':key==='zh-CN'?'chinese-writer':'independent-verifier',artifact_id:key,artifact_path:'writer/'+key+'.json',native_path:'native/'+key+'.json',...(key==='en'?{instruction_path:'instructions/en.txt'}:{}),revision:'1'}]));
  const scientificInput = {profile:'reading-first-1.0',identity:{paper_id:'synthetic',run_id:'run'},sources:[{path:join(root,'paper.pdf'),sha256:sha(source),byte_length:source.length}],context:'synthetic',role_artifacts:roles};
  const mainSession={model:'gpt-6-astra',reasoning_effort:'high'};
  const configuredSetup={schema_version:'apa-configured-reading-1.0',config_fingerprint:sha(Buffer.from('config')),paths:{runRoot:root},role_model_policy:createApaRoleModelPolicy(mainSession),...buildConfiguredReadingInstructions({})};
  const runControl=createReadingFirstRunControl({runId:'run',scientificInput,mainSession,configuredSetup,authorizationId:'synthetic',deadline:'2099-01-01T00:00:00Z',taskBindings:downstream,writingMode:'source-first',maxCalls:6,priorCalls:6,maxTotalCalls:12});
  const prepared={runControl,scientificInput,configurationFingerprint:sha(Buffer.from('config')),paths:{runRoot:root}};
  const authorized_bindings=[...Object.values(tasks),...Object.values(downstream)].map(task=>({run_id:'run',actor_id:task.owner_actor_id,role:task.role,artifact_path:task.artifact_path,revision:task.revision}));
  const checkpointTask={artifact_id:'checkpoint',artifact_path:'control/checkpoint.json',revision:'1',owner_actor_id:'controller',role:'control'};
  authorized_bindings.push({run_id:'run',actor_id:'controller',role:'control',artifact_path:checkpointTask.artifact_path,revision:'1'});
  authorized_bindings.push({run_id:'run',actor_id:'controller',role:'control',artifact_path:'control/checkpoint-r2.json',revision:'2'});
  const brokerConfig={control_actor_id:'controller',artifact_root:root,authorized_bindings,run_controls:[runControl]};
  const options={prepared,tasks,brokerConfig,statePath:join(root,'state.json')};
  await mkdir(join(root,'native')); return {root,options,tasks,checkpointTask};
}
test('intent is durable and never reissued while outcome is unknown', async t=>{
  const f=await fixture(t), controller=await createScienceController(f.options);
  assert.equal(getScienceState(controller).accepted_results,0);
  const [{role,request}]=await prepareScienceRequests({controller}); assert.equal(role,'evidence');
  const intent=await recordScienceDispatchIntent({controller,role});
  const recovered=await restoreScienceController(f.options);
  assert.deepEqual(getScienceRequest({controller:recovered,role}).request,request);
  assert.deepEqual(getScienceRequest({controller:recovered,role}).intent,intent);
  assert.deepEqual(await prepareScienceRequests({controller:recovered}),[]);
  await assert.rejects(()=>recordScienceDispatchIntent({controller:recovered,role}),/SCIENCE_DISPATCH_UNAVAILABLE/);
  assert.equal(getScienceState(recovered).reserved_calls,1); assert.equal(getScienceState(recovered).accepted_results,0);
});
test('observed evidence is accepted once and unlocks methods and results in parallel', async t=>{
  const f=await fixture(t), controller=await createScienceController(f.options);
  const [{role,request}]=await prepareScienceRequests({controller}); await recordScienceDispatchIntent({controller,role});
  const step=request.emittedStep;
  await recordScienceHostObservation({controller,role,observation:{action_id:step.action_id,run_id:'run',input_fingerprint:step.input_fingerprint,port:'current-collaboration',tool_call:{name:step.action,arguments:step.arguments},raw_result_text:JSON.stringify({agent_id:'synthetic-1'})}});
  await writeFile(join(f.root,f.tasks.evidence.native_path),JSON.stringify({role:'evidence',text:'source'}));
  const receipt=await acceptScienceResult({controller,role});
  assert.deepEqual(await acceptScienceResult({controller,role}),receipt);
  const recovered=await restoreScienceController(f.options);
  assert.equal(getScienceState(recovered).accepted_results,1);
  assert.deepEqual((await prepareScienceRequests({controller:recovered})).map(row=>row.role),['methods','results']);
});

test('handoff is gated by six owned results and restores the same Writer action', async t => {
  const f=await fixture(t); let controller=await createScienceController(f.options);
  await assert.rejects(()=>createScienceHandoff({controller,checkpointTask:f.checkpointTask}),/SCIENCE_HANDOFF_INCOMPLETE/);
  for (const batch of [['evidence'],['methods','results'],['interpretation'],['scientific-reading'],['integration']]) {
    const requests=await prepareScienceRequests({controller}); assert.deepEqual(requests.map(row=>row.role),batch);
    for (const {role,request} of requests) {
      await recordScienceDispatchIntent({controller,role}); const step=request.emittedStep;
      await recordScienceHostObservation({controller,role,observation:{action_id:step.action_id,run_id:'run',input_fingerprint:step.input_fingerprint,port:'current-collaboration',tool_call:{name:step.action,arguments:step.arguments},raw_result_text:JSON.stringify({agent_id:'synthetic-'+role})}});
      await writeFile(join(f.root,f.tasks[role].native_path),JSON.stringify({role,text:'synthetic result'}));
      await acceptScienceResult({controller,role});
    }
    controller=await restoreScienceController(f.options);
  }
  assert.equal(getScienceState(controller).accepted_results,6);
  const first=await createScienceHandoff({controller,checkpointTask:f.checkpointTask});
  assert.equal(first.requests.length,1);
  assert.equal(first.requests[0].language,'en');
  const firstId=first.requests[0].emittedStep.action_id;
  controller=await restoreScienceController(f.options);
  const resumed=await createScienceHandoff({controller,checkpointTask:f.checkpointTask});
  assert.equal(resumed.requests,undefined);
  assert.equal(getScienceState(controller).handoff.status,'transferred');
  const downstream=await restoreReadingFirstRuntime({handoff:resumed.handoff,runControl:resumed.runControl,checkpointReceipt:resumed.checkpointReceipt});
  assert.equal(downstream.requests[0].emittedStep.action_id,firstId);
  assert.deepEqual(downstream.requests,first.requests);
  const writer=downstream.requests[0], step=writer.emittedStep;
  await writeFile(join(f.root,writer.task.native_path),JSON.stringify({language:'en',sections:[{heading:'Study',paragraphs:['The synthetic study explains its design and limitation.']}]}));
  await acceptReadingFirstResult({controller:downstream.controller,request:writer,observation:{action_id:step.action_id,run_id:'run',input_fingerprint:step.input_fingerprint,port:'current-collaboration',tool_call:{name:step.action,arguments:step.arguments},raw_result_text:JSON.stringify({agent_id:'synthetic-writer'})},capability:resumed.broker.issueCapability({runId:'run',actorId:writer.task.owner_actor_id,role:writer.task.role,artifactPath:writer.task.artifact_path,revision:writer.task.revision})});
  assert.equal(getReadingFirstState(downstream.controller).observations.length,1);
  const [translator]=createReadingFirstDraftRequests({controller:downstream.controller});
  assert.equal(translator.language,'zh-CN');
  const latestSnapshot=snapshotReadingFirstRuntime(downstream.controller);
  const latestReceipt=await commitOwnedArtifact({artifactRoot:f.root,dispatchContext:resumed.broker.dispatchContext,capability:resumed.broker.issueCapability({runId:'run',actorId:'controller',role:'control',artifactPath:'control/checkpoint-r2.json',revision:'2'}),artifact:{artifact_id:'checkpoint-r2',content:JSON.stringify(latestSnapshot)},expectedRevision:'2'});
  controller=await restoreScienceController(f.options);
  const pointer=await createScienceHandoff({controller,checkpointTask:f.checkpointTask});
  assert.equal(pointer.requests,undefined);
  const latest=await restoreReadingFirstRuntime({handoff:pointer.handoff,runControl:pointer.runControl,checkpointReceipt:latestReceipt});
  assert.equal(latest.ok,true,JSON.stringify(latest.errors));
  assert.equal(latest.requests.length,1); assert.equal(latest.requests[0].emittedStep.action_id,translator.emittedStep.action_id);
});

const crashDriver = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const [optionsPath, mode, moduleUrl] = process.argv.slice(1);
const options = JSON.parse(fs.readFileSync(optionsPath, 'utf8'));
const originalWrite = fs.promises.writeFile, originalRename = fs.promises.rename, originalLink = fs.promises.link, originalSyncWrite = fs.writeFileSync, originalSyncLink = fs.linkSync;
fs.writeFileSync = (...args) => {
  const path=String(args[0]).replaceAll(String.fromCharCode(92),'/');
  if ((mode === 'writer-instruction-temp' && path.includes('/instructions/en.txt.') || mode === 'science-instruction-temp' && path.includes('/instructions/evidence.txt.')) && path.endsWith('.tmp')) {
    originalSyncWrite(args[0],Buffer.from(args[1]).subarray(0,5),args[2]); process.exit(77);
  }
  return originalSyncWrite(...args);
};
fs.linkSync = (...args) => {
  const result=originalSyncLink(...args);
  const path=String(args[1]).replaceAll(String.fromCharCode(92),'/');
  if ((mode === 'writer-instruction' && path.endsWith('/instructions/en.txt')) || (mode === 'science-instruction' && path.endsWith('/instructions/evidence.txt'))) process.exit(77);
  return result;
};
fs.promises.writeFile = async (...args) => {
  const path=String(args[0]).replaceAll(String.fromCharCode(92),'/');
  if ((mode === 'science-body-temp' && path.includes('/science/evidence.json.') && path.endsWith('.tmp')) ||
      (mode === 'science-receipt-temp' && path.includes('/.phase21-receipts/evidence.json.') && path.endsWith('.tmp')) ||
      (mode === 'checkpoint-body-temp' && path.includes('/control/checkpoint.json.') && path.endsWith('.tmp')) ||
      (mode === 'checkpoint-receipt-temp' && path.includes('/.phase21-receipts/checkpoint.json.') && path.endsWith('.tmp'))) {
    await originalWrite(args[0],Buffer.from(args[1]).subarray(0,5),args[2]); process.exit(77);
  }
  return originalWrite(...args);
};
fs.promises.link = async (...args) => {
  await originalLink(...args);
  const path=String(args[1]).replaceAll(String.fromCharCode(92),'/');
  if ((mode === 'science-body' && path.endsWith('/science/evidence.json')) ||
      (mode === 'science-receipt' && path.endsWith('/.phase21-receipts/evidence.json')) ||
      (mode === 'checkpoint-body' && path.endsWith('/control/checkpoint.json')) ||
      (mode === 'checkpoint-receipt' && path.endsWith('/.phase21-receipts/checkpoint.json'))) process.exit(77);
};
fs.promises.rename = async (...args) => {
  await originalRename(...args);
  const data = JSON.parse(fs.readFileSync(options.statePath, 'utf8')).data;
  if ((mode === 'intent' && data.entries.evidence.intent) ||
      (mode === 'science-state' && data.entries.evidence.receipt) ||
      (mode === 'handoff-snapshot' && data.handoff?.status === 'checkpoint_pending') ||
      (mode === 'handoff-state' && data.handoff?.status === 'transferred')) process.exit(77);
};
syncBuiltinESMExports();
const api=await import(moduleUrl);
const controller=await api.restoreScienceController(options);
if (mode.startsWith('science-instruction')) await api.prepareScienceRequests({controller});
else if (mode === 'intent') await api.recordScienceDispatchIntent({controller,role:'evidence'});
else if (mode.startsWith('science-')) await api.acceptScienceResult({controller,role:'evidence'});
else await api.createScienceHandoff({controller,checkpointTask:options.checkpointTask});
process.exit(0);
`;
async function latestState(path) { return JSON.parse(await readFile(path,'utf8')); }
async function crashChild(f,mode) {
  const optionsPath=join(f.root,'test-options.json');
  await writeFile(optionsPath,JSON.stringify({...f.options,checkpointTask:f.checkpointTask}));
  const result=spawnSync(process.execPath,['--input-type=module','-e',crashDriver,optionsPath,mode,new URL('../../scripts/v3/science-controller.mjs', import.meta.url).href],{cwd:process.cwd(),encoding:'utf8'});
  assert.equal(result.status,77,`${mode}: ${result.stderr} ${result.stdout}`);
}
test('independent process exit preserves intent and repairs only exact owned result across write boundaries',async t=>{
  const f=await fixture(t); let controller=await createScienceController(f.options);
  const [{request}]=await prepareScienceRequests({controller});
  await crashChild(f,'intent'); controller=await restoreScienceController(f.options);
  assert.equal(getScienceRequest({controller,role:'evidence'}).intent.action_id,request.emittedStep.action_id);
  const step=request.emittedStep;
  await recordScienceHostObservation({controller,role:'evidence',observation:{action_id:step.action_id,run_id:'run',input_fingerprint:step.input_fingerprint,port:'current-collaboration',tool_call:{name:step.action,arguments:step.arguments},raw_result_text:JSON.stringify({agent_id:'synthetic-evidence'})}});
  await writeFile(join(f.root,f.tasks.evidence.native_path),JSON.stringify({role:'evidence',text:'synthetic'}));
  await crashChild(f,'science-body-temp');
  await crashChild(f,'science-body');
  await crashChild(f,'science-receipt-temp');
  await crashChild(f,'science-receipt');
  await crashChild(f,'science-state');
  controller=await restoreScienceController(f.options);
  assert.equal(getScienceState(controller).accepted_results,1);
  assert.deepEqual((await prepareScienceRequests({controller})).map(item=>item.role),['methods','results']);
});
test('independent exits preserve original Writer request across checkpoint write boundaries',async t=>{
  const f=await fixture(t); let controller=await createScienceController(f.options);
  for (const batch of [['evidence'],['methods','results'],['interpretation'],['scientific-reading'],['integration']]) {
    for (const {role,request} of await prepareScienceRequests({controller})) {
      assert.ok(batch.includes(role)); await recordScienceDispatchIntent({controller,role}); const step=request.emittedStep;
      await recordScienceHostObservation({controller,role,observation:{action_id:step.action_id,run_id:'run',input_fingerprint:step.input_fingerprint,port:'current-collaboration',tool_call:{name:step.action,arguments:step.arguments},raw_result_text:JSON.stringify({agent_id:'synthetic-'+role})}});
      await writeFile(join(f.root,f.tasks[role].native_path),JSON.stringify({role,text:'synthetic'})); await acceptScienceResult({controller,role});
    }
  }
  await crashChild(f,'writer-instruction-temp');
  await crashChild(f,'writer-instruction');
  await crashChild(f,'handoff-snapshot');
  let state=await latestState(f.options.statePath);
  const first=state.data.handoff.snapshot.state.request_entries[0].request;
  for (const mode of ['checkpoint-body-temp','checkpoint-body','checkpoint-receipt-temp','checkpoint-receipt','handoff-state']) {
    await crashChild(f,mode); state=await latestState(f.options.statePath);
    assert.deepEqual(state.data.handoff.snapshot.state.request_entries[0].request,first);
  }
  controller=await restoreScienceController(f.options);
  const resumed=await createScienceHandoff({controller,checkpointTask:f.checkpointTask});
  assert.equal(resumed.requests,undefined);
  const downstream=await restoreReadingFirstRuntime({handoff:resumed.handoff,runControl:resumed.runControl,checkpointReceipt:resumed.checkpointReceipt});
  assert.deepEqual(downstream.requests[0],first);
  const writer=downstream.requests[0], step=writer.emittedStep;
  await writeFile(join(f.root,writer.task.native_path),JSON.stringify({language:'en',sections:[{heading:'Study',paragraphs:['Synthetic design and limitation.']}]}));
  await acceptReadingFirstResult({controller:downstream.controller,request:writer,observation:{action_id:step.action_id,run_id:'run',input_fingerprint:step.input_fingerprint,port:'current-collaboration',tool_call:{name:step.action,arguments:step.arguments},raw_result_text:JSON.stringify({agent_id:'synthetic-writer'})},capability:resumed.broker.issueCapability({runId:'run',actorId:writer.task.owner_actor_id,role:writer.task.role,artifactPath:writer.task.artifact_path,revision:writer.task.revision})});
  assert.equal(getReadingFirstState(downstream.controller).observations.length,1);
});

for (const hostStyle of ['codex','mapped']) test(`configured reading binds and restores ${hostStyle} host arguments`,async t=>{
  const f=await fixture(t), base=f.root, configRoot=join(base,'configured'); await mkdir(join(configRoot,'config'),{recursive:true});
  const parser=join(configRoot,'mineru'), bin=join(parser,'venv',process.platform==='win32'?'Scripts':'bin'); await mkdir(bin,{recursive:true});
  await writeFile(join(bin,process.platform==='win32'?'python.exe':'python'),'synthetic'); await writeFile(join(parser,'config.yaml'),'synthetic');
  const choice=hostStyle==='mapped'?{mode:'explicit',model:'opus',reasoning_effort:'high'}:{mode:'explicit',model:'gpt-6.1-sol',reasoning_effort:'low'};
  const config={schema_version:'apa-local-config-1.0',models:{science:choice,overrides:{},roles:Object.fromEntries(['english-writer','chinese-writer','translation','reading-editor','independent-verifier'].map(role=>[role,{mode:'follow-main'}]))},paths:{runs:'runs',parse:'parse',candidates:'candidates'},parser:{runtime_home:parser},reading:{source_language:'en',presentation_mode:'writer'},writing_skills:Object.fromEntries(['nature-writing','nature-polishing','nature-shared','humanizer','humanizer-zh','stss'].map(key=>[key,{enabled:false}]))};
  if(hostStyle==='mapped') config.host={name:'claude-code',dispatch:{tool:'Agent',model_argument:'model',effort_argument:'effort',instruction_argument:'prompt',task_name_argument:'description',fresh_context:null}};
  await writeFile(join(configRoot,'config/apa.local.json'),JSON.stringify(config));
  const old=f.options.prepared, binding=old.runControl.reading_first_binding;
  const prepared=prepareConfiguredReading({repoRoot:configRoot,runId:'run',scientificInput:old.scientificInput,sessionContext:hostStyle==='mapped'?{model:'sonnet'}:{model:'gpt-6-astra',effort:'high'},authorizationId:'synthetic',deadline:binding.deadline,sourceLanguage:'en',taskBindings:{...binding.task_bindings,'zh-CN':{...binding.task_bindings['zh-CN'],role:'translation'}},maxCalls:6,priorCalls:6,maxTotalCalls:12});
  const brokerConfig={...f.options.brokerConfig,artifact_root:prepared.paths.runRoot,run_controls:[prepared.runControl]};
  const options={...f.options,prepared,brokerConfig,statePath:join(prepared.paths.runRoot,'state.json')};
  const controller=await createScienceController(options); const [{request}]=await prepareScienceRequests({controller});
  const intent=await recordScienceDispatchIntent({controller,role:'evidence'});
  assert.equal(intent.action,hostStyle==='mapped'?'Agent':'collaboration.spawn_agent');
  if(hostStyle==='mapped') {assert.equal(intent.arguments.model,'opus');assert.equal(intent.arguments.effort,'high');assert.equal(typeof intent.arguments.prompt,'string');}
  else {assert.equal(intent.arguments.model,'gpt-6.1-sol');assert.equal(intent.arguments.fork_turns,'none');}
  const restored=await restoreScienceController(options); assert.deepEqual(getScienceRequest({controller:restored,role:'evidence'}).request,request);
  assert.deepEqual(getScienceRequest({controller:restored,role:'evidence'}).intent,intent);
});
test('source and frozen binding drift refuse restore without changing the saved run', async t=>{
  const f=await fixture(t), controller=await createScienceController(f.options);
  await prepareScienceRequests({controller});
  const changed=structuredClone(f.options); changed.prepared.runControl.reading_first_binding.authorization_id='other';
  changed.brokerConfig.run_controls=[changed.prepared.runControl];
  await assert.rejects(()=>restoreScienceController(changed),/SCIENCE_BINDING_CHANGED/);
  await writeFile(join(f.root,'paper.pdf'),'different source');
  await assert.rejects(()=>restoreScienceController(f.options),/SCIENCE_SOURCE_CHANGED/);
});
test('expired restored run permits status but blocks new action', async t=>{
  const f=await fixture(t), controller=await createScienceController(f.options);
  await prepareScienceRequests({controller});
  t.mock.method(Date,'now',()=>Date.parse('2100-01-01T00:00:00Z'));
  const recovered=await restoreScienceController(f.options); assert.equal(getScienceState(recovered).expired,true);
  await assert.rejects(()=>recordScienceDispatchIntent({controller:recovered,role:'evidence'}),/SCIENCE_DEADLINE_EXPIRED/);
});
test('wrong orphan bytes cannot acquire a receipt and host updates retain the original handle', async t=>{
  const f=await fixture(t), controller=await createScienceController(f.options);
  const [{request}]=await prepareScienceRequests({controller}); await recordScienceDispatchIntent({controller,role:'evidence'});
  const step=request.emittedStep;
  await recordScienceHostObservation({controller,role:'evidence',observation:{action_id:step.action_id,run_id:'run',input_fingerprint:step.input_fingerprint,port:'current-collaboration',tool_call:{name:step.action,arguments:step.arguments},raw_result_text:JSON.stringify({agent_id:'synthetic-evidence'})}});
  await recordScienceHostObservation({controller,role:'evidence',observation:{kind:'host_update',action_id:step.action_id,agent_id:'synthetic-evidence',tool_call:{name:'host.wait',arguments:{id:'synthetic-evidence'}},raw_result_text:'running'}});
  await assert.rejects(()=>recordScienceHostObservation({controller,role:'evidence',observation:{kind:'host_update',action_id:step.action_id,agent_id:'different',tool_call:{name:'host.wait',arguments:{}},raw_result_text:'done'}}),/SCIENCE_HOST_UPDATE_INVALID/);
  assert.equal(getScienceRequest({controller,role:'evidence'}).host_updates.length,1);
  await writeFile(join(f.root,f.tasks.evidence.native_path),JSON.stringify({role:'evidence',text:'actual'}));
  await mkdir(join(f.root,'science')); await writeFile(join(f.root,f.tasks.evidence.artifact_path),'conflicting orphan');
  await assert.rejects(()=>acceptScienceResult({controller,role:'evidence'}),/RECOVERY_CONTENT_MISMATCH/);
  assert.equal(await readFile(join(f.root,f.tasks.evidence.artifact_path),'utf8'),'conflicting orphan');
  await assert.rejects(()=>readFile(join(f.root,'.phase21-receipts/evidence.json')),/ENOENT/);
});
test('altered owned receipt or native bytes refuse restoration', async t=>{
  const f=await fixture(t), controller=await createScienceController(f.options);
  const [{request}]=await prepareScienceRequests({controller}); await recordScienceDispatchIntent({controller,role:'evidence'}); const step=request.emittedStep;
  await recordScienceHostObservation({controller,role:'evidence',observation:{action_id:step.action_id,run_id:'run',input_fingerprint:step.input_fingerprint,port:'current-collaboration',tool_call:{name:step.action,arguments:step.arguments},raw_result_text:JSON.stringify({agent_id:'synthetic-evidence'})}});
  await writeFile(join(f.root,f.tasks.evidence.native_path),JSON.stringify({role:'evidence',text:'actual'})); await acceptScienceResult({controller,role:'evidence'});
  const receiptPath=join(f.root,'.phase21-receipts/evidence.json'); const original=JSON.parse(await readFile(receiptPath,'utf8')); const receipt={...original,run_id:'another-run'};
  await writeFile(receiptPath,JSON.stringify(receipt)); await assert.rejects(()=>restoreScienceController(f.options),/SCIENCE_RECEIPT_INVALID/);
  await writeFile(receiptPath,JSON.stringify(original)); await writeFile(join(f.root,f.tasks.evidence.native_path),'different');
  await assert.rejects(()=>restoreScienceController(f.options),/SCIENCE_NATIVE_CHANGED/);
});

test('one parallel result does not unlock interpretation or reissue its sibling',async t=>{
  const f=await fixture(t); let controller=await createScienceController(f.options);
  async function complete(role, request) {
    await recordScienceDispatchIntent({controller,role}); const step=request.emittedStep;
    await recordScienceHostObservation({controller,role,observation:{action_id:step.action_id,run_id:'run',input_fingerprint:step.input_fingerprint,port:'current-collaboration',tool_call:{name:step.action,arguments:step.arguments},raw_result_text:JSON.stringify({agent_id:'synthetic-'+role})}});
    await writeFile(join(f.root,f.tasks[role].native_path),JSON.stringify({role,text:'synthetic'})); await acceptScienceResult({controller,role});
  }
  let [evidence]=await prepareScienceRequests({controller}); await complete(evidence.role,evidence.request);
  const [methods,results]=await prepareScienceRequests({controller}); await recordScienceDispatchIntent({controller,role:'results'});
  await complete(methods.role,methods.request); controller=await restoreScienceController(f.options);
  assert.deepEqual(await prepareScienceRequests({controller}),[]);
  assert.equal(getScienceState(controller).roles.results.status,'outcome_unknown');
  assert.equal(getScienceState(controller).roles.interpretation.status,'waiting');
  assert.deepEqual(getScienceRequest({controller,role:'results'}).request,results.request);
});

test('science instruction writes recover from interrupted temporary and published files',async t=>{
  const f=await fixture(t); await createScienceController(f.options);
  await crashChild(f,'science-instruction-temp'); await crashChild(f,'science-instruction');
  const controller=await restoreScienceController(f.options);
  const [{role,request}]=await prepareScienceRequests({controller}); assert.equal(role,'evidence');
  assert.equal(request.instruction_file.path,join(f.root,'instructions/evidence.txt'));
  assert.equal(getScienceState(controller).next_actions[0].action,'record_dispatch_intent');
});
test('claude-code science observations keep the agentId from result text across restore', async t=>{
  const f=await fixture(t), configRoot=join(f.root,'configured'); await mkdir(join(configRoot,'config'),{recursive:true});
  const parser=join(configRoot,'mineru'), bin=join(parser,'venv',process.platform==='win32'?'Scripts':'bin'); await mkdir(bin,{recursive:true});
  await writeFile(join(bin,process.platform==='win32'?'python.exe':'python'),'synthetic'); await writeFile(join(parser,'config.yaml'),'synthetic');
  const resultHandle={source:'text',pattern:'agentId:\\s*([A-Za-z0-9_-]+)'};
  const config={schema_version:'apa-local-config-1.0',models:{science:{mode:'explicit',model:'opus',reasoning_effort:'high'},overrides:{},roles:Object.fromEntries(['english-writer','chinese-writer','translation','reading-editor','independent-verifier'].map(role=>[role,{mode:'follow-main'}]))},paths:{runs:'runs',parse:'parse',candidates:'candidates'},parser:{runtime_home:parser},reading:{source_language:'en',presentation_mode:'writer'},writing_skills:Object.fromEntries(['nature-writing','nature-polishing','nature-shared','humanizer','humanizer-zh','stss'].map(key=>[key,{enabled:false}])),
    host:{name:'claude-code',dispatch:{tool:'Agent',model_argument:'model',effort_argument:'effort',instruction_argument:'prompt',task_name_argument:'description',fresh_context:null,result_handle:resultHandle}}};
  await writeFile(join(configRoot,'config/apa.local.json'),JSON.stringify(config));
  const old=f.options.prepared, binding=old.runControl.reading_first_binding;
  const prepared=prepareConfiguredReading({repoRoot:configRoot,runId:'run',scientificInput:old.scientificInput,sessionContext:{model:'sonnet'},authorizationId:'synthetic',deadline:binding.deadline,sourceLanguage:'en',taskBindings:{...binding.task_bindings,'zh-CN':{...binding.task_bindings['zh-CN'],role:'translation'}},maxCalls:6,priorCalls:6,maxTotalCalls:12});
  const brokerConfig={...f.options.brokerConfig,artifact_root:prepared.paths.runRoot,run_controls:[prepared.runControl]};
  const options={...f.options,prepared,brokerConfig,statePath:join(prepared.paths.runRoot,'state.json')};
  const controller=await createScienceController(options); const [{request}]=await prepareScienceRequests({controller});
  assert.deepEqual(request.packet.host_action_scope.result_bindings.agent_id,resultHandle);
  await recordScienceDispatchIntent({controller,role:'evidence'}); const step=request.emittedStep;
  const raw='Done.\nagentId: sci-evidence-1 (use SendMessage with to: sci-evidence-1 to continue this agent)';
  const observed=await recordScienceHostObservation({controller,role:'evidence',observation:{action_id:step.action_id,run_id:'run',input_fingerprint:step.input_fingerprint,port:'current-collaboration',tool_call:{name:step.action,arguments:step.arguments},raw_result_text:raw}});
  assert.equal(observed.agent_id,'sci-evidence-1'); assert.equal(observed.host_task_handle_status,'extracted');
  const restored=await restoreScienceController(options);
  assert.equal(getScienceState(restored).roles.evidence.agent_id,'sci-evidence-1');
  assert.equal(getScienceRequest({controller:restored,role:'evidence'}).observations[0].raw.raw_result_text,raw);
  await recordScienceHostObservation({controller:restored,role:'evidence',observation:{kind:'host_update',action_id:step.action_id,agent_id:'sci-evidence-1',tool_call:{name:'SendMessage',arguments:{to:'sci-evidence-1'}},raw_result_text:'continued'}});
  assert.equal(getScienceRequest({controller:restored,role:'evidence'}).host_updates.length,1);
});
