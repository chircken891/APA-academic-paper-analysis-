import { runFiniteRoleSequence } from '../../scripts/v3/phase21-runner.mjs';
import * as runtime from '../../scripts/v3/reading-first-runtime.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createOwnedArtifactBroker, commitOwnedArtifact } from '../../scripts/v3/owned-artifact-store.mjs';
import { getRoleReplyContract, loadRoleReplyContract } from '../../scripts/v3/role-reply-contract.mjs';
import { createPhase21ContractValidator } from '../../scripts/v3/phase21-contract-loader.mjs';
import { buildPreRenderHandoff } from '../../scripts/v3/workflow-composer.mjs';
import { createLanguageRequests } from '../../scripts/v3/phase22-language.mjs';
import { renderReaderNotes } from '../../scripts/v3/phase221-presentation.mjs';
import { READING_FIRST_PROFILE, fingerprintReadingFirst, resolveReadingWorkflowProfile, acceptReadingFirstResult, createReadingFirstReviewRequest, getReadingFirstState, createReadingFirstRevisionRequests, createReadingFirstRunControl, snapshotReadingFirstRuntime, restoreReadingFirstRuntime } from '../../scripts/v3/reading-first-runtime.mjs';
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const roles = ['evidence','methods','results','interpretation','scientific-reading','integration'];
async function setup(t, gaps = [], policy = true, total = 12, languageCalls = 6, hostResultAgentIdPath, scienceGaps = {}, roleReplyContract, enrichmentSessionProfile) {
  const root = await mkdtemp(join(tmpdir(), 'reading-first-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  const sourceBytes=Buffer.from('Synthetic original source: design, result and limitation.');
  await writeFile(join(root,'source.pdf'),sourceBytes);
  const tasks=Object.fromEntries(['en','zh-CN','review','en-r2','zh-CN-r2','review-r2'].map(key=>[key,{task_id:key,task_name:'reading_'+key.replaceAll('-','_').toLowerCase(),owner_actor_id:key,role:key.startsWith('en')?'english-writer':key.startsWith('zh')?'chinese-writer':'independent-verifier',artifact_id:key,artifact_path:key+'.json',native_path:'native/'+key+'.json',revision:'1'}]));
  for (const round of ['initial','late']) for (const role of ['evidence','methods','results']) { const key='enrich-'+round+'-'+role; tasks[key]={task_id:key,task_name:key.replaceAll('-','_'),owner_actor_id:key,role,source_root:'sources/'+key,artifact_id:key,artifact_path:key+'.json',native_path:'native/'+key+'.json',revision:'1'}; }
  const bindings=[...roles.map(role=>({run_id:'run',actor_id:role,role,artifact_path:'science/'+role+'.json',revision:'1'})),...Object.values(tasks).map(task=>({run_id:'run',actor_id:task.owner_actor_id,role:task.role,artifact_path:task.artifact_path,revision:task.revision}))];
  const input={identity:{paper_id:'synthetic',run_id:'run'},sources:[{id:'main',path:join(root,'source.pdf'),sha256:sha(sourceBytes),byte_length:sourceBytes.length}],context:'Read all existing material as a connected account.',role_artifacts:roles,important_gaps:gaps};
  const runBinding=createReadingFirstRunControl({presentationRequired:false,runId:'run',scientificInput:input,mainSession:{model:'gpt-6-astra',reasoning_effort:'high'},authorizationId:'synthetic-only',...(hostResultAgentIdPath===undefined?{}:{hostResultAgentIdPath}),maxCalls:languageCalls,deadline:'2099-01-01T00:00:00Z',taskBindings:policy?tasks:Object.fromEntries(Object.entries(tasks).filter(([k])=>!k.startsWith('enrich-'))),...(policy?{enrichmentPolicy:{sources:[],allow_targeted_methods:true},maxTotalCalls:total}:{}),roleReplyContract,enrichmentSessionProfile});
  const binding=runBinding.reading_first_binding;
  bindings.push({run_id:'run',actor_id:'controller',role:'control',artifact_path:'checkpoint.json',revision:'1'});
  const fingerprints=Object.fromEntries(['source','parser_tool','permission','parent_revision','policy','authorization'].map(key=>[key,sha(Buffer.from(key))]));
  const required=roles.map(role=>({artifact_id:role,owner_actor_id:role,path:'science/'+role+'.json'}));
  // Legacy delivery slots remain unfulfilled; scientific storage is not legacy delivery.
  const integration={source_check_artifact_id:'unused-source-check',analysis_draft_artifact_id:'unused-frozen-draft',integration_artifact_id:'integration',approval_artifact_id:'unused-approval'};
  const broker=createOwnedArtifactBroker({control_actor_id:'controller',artifact_root:root,authorized_bindings:bindings,run_controls:[{run_id:'run',reading_first_binding:binding,approved_fingerprints:fingerprints,required_artifacts:required,integration_prerequisites:integration}]});
  const schema=JSON.parse(await readFile(new URL('../../Schema/phase21/proof-chain.schema.json',import.meta.url),'utf8'));
  const phase21Validator=await createPhase21ContractValidator({schemas:[schema]});
  const scienceRun={run_id:'run',workflow_profile:READING_FIRST_PROFILE,artifact_root:root,phase21Validator,declared_fingerprints:fingerprints,current_fingerprints:fingerprints,route_fingerprint:'fixed',chain:{schema_version:'phase21-proof-chain-1.0',run_id:'run',delivery_status:'pending_resolver',artifacts:[],dependencies:[],required_artifacts:required,integration_prerequisites:integration,metadata:{requirement_refs:['APA3-04']},p20_e12_status:'unverified'}};
  const scienceResult=await runFiniteRoleSequence({run:scienceRun,dispatchContext:broker.dispatchContext,artifactStore:broker,actions:roles.map(role=>({role,action:{type:'write_artifact',actor_id:role,role,artifact_path:'science/'+role+'.json',revision:'1',artifact:{artifact_id:role,content:JSON.stringify({context:'Full connected science for '+role,...(Object.hasOwn(scienceGaps,role)?{important_gaps:scienceGaps[role]}:{})})}}}))});
  assert.notEqual(scienceResult.status,'blocked',JSON.stringify(scienceResult.delivery_gate));
  assert.equal(scienceResult.receipts.length,6);
  assert.equal(scienceResult.chain.source_check,undefined);
  const handoff=await buildPreRenderHandoff({run:{run_id:'run',workflow_profile:READING_FIRST_PROFILE},dispatchContext:broker.dispatchContext,artifactRoot:root,scientificInput:input});
  const runControl={runId:'run',artifactRoot:root,dispatchContext:broker.dispatchContext};
  const created=createLanguageRequests({handoff,runControl});
  assert.equal(created.ok,true,JSON.stringify(created.errors));
  const complete=async(request,value,rawResult=JSON.stringify({agent_id:'synthetic-'+request.task.task_id}),observationOverrides={})=>{
    await mkdir(join(root,'native'),{recursive:true});
    await writeFile(join(root,request.task.native_path),JSON.stringify(value));
    const step=request.emittedStep;
    return acceptReadingFirstResult({controller:created.controller,request,observation:{action_id:step.action_id,run_id:'run',input_fingerprint:step.input_fingerprint,port:'current-collaboration',tool_call:{name:step.action,arguments:step.arguments},raw_result_text:rawResult,...observationOverrides},capability:broker.issueCapability({runId:'run',actorId:request.task.owner_actor_id,role:request.task.role,artifactPath:request.task.artifact_path,revision:request.task.revision})});
  };
  const view=language=>({language,sections:[{heading:language==='en'?'Study':'研究',paragraphs:[language==='en'?'The study design produced the main finding; its limitation bounds the conclusion.':'研究设计产生主要发现，研究限制界定结论。']} ]});
  return {root,broker,handoff,created,complete,view,runControl,binding};
}
const gap = (id='design', overrides={}) => ({id,question:'What allocation was used?',impact:'Changes interpretation of the main result',severity:'material',owner_role:'evidence',source_kind:'original_page',source_ids:[],target_sections:['Study'],...overrides});
const answer = (g, overrides={}) => ({gap_id:g.id,classification:'paper_fact',explanation:'The recovered main-text page states allocation was randomized.',consequence:'Randomization supports the design account but does not remove attrition bias.',status:'recovered',target_sections:g.target_sections,source_ids:['main'],...overrides});

test('Integrator final gaps replace paraphrased upstream copies with one directed scientific question',async t=>{
 const canonical=gap('method-gap',{owner_role:'methods',source_kind:'cited_method',question:'Which uncertainty procedure supports the reported interval?'});
 const s=await setup(t,[],true,12,6,undefined,{methods:[{...canonical,question:'How were interval uncertainties estimated?'}],interpretation:[{...canonical,question:'What method underlies these uncertainty intervals?'}],integration:[canonical]});
 assert.equal(s.created.requests.length,0);
 const [request]=runtime.createReadingFirstEnrichmentRequests({controller:s.created.controller});
 assert.equal(request.task.role,'methods');
 const payload=JSON.parse(request.emittedStep.arguments.message.split('\n\n').at(-1));
 assert.equal(payload.gaps.length,1);
 assert.equal(payload.gaps[0].id,canonical.id);
 assert.equal(payload.gaps[0].question,canonical.question);
 await s.complete(request,{run_id:'run',role:'methods',resolutions:[answer(canonical,{classification:'background',status:'unreported',source_ids:[]})]});
 assert.equal(runtime.createReadingFirstDraftRequests({controller:s.created.controller}).length,2);
});

test('explicit empty Integrator final gaps do not reopen resolved upstream questions',async t=>{
 const s=await setup(t,[],true,12,6,undefined,{methods:[gap()],interpretation:[gap('design',{question:'How was treatment assigned?'})],integration:[]});
 assert.equal(s.created.requests.length,2);
 assert.equal(getReadingFirstState(s.created.controller).status,'drafting');
 assert.throws(()=>runtime.createReadingFirstEnrichmentRequests({controller:s.created.controller}),/ENRICHMENT_UNAVAILABLE/);
});

test('missing Integrator final list retains upstream fallback and explicit handoff gaps remain required',async t=>{
 const upstream=gap(),fallback=await setup(t,[],true,12,6,undefined,{methods:[upstream]});
 const [request]=runtime.createReadingFirstEnrichmentRequests({controller:fallback.created.controller});
 assert.equal(request.task.role,'evidence');
 assert.match(request.emittedStep.arguments.message,/What allocation was used/);
 const explicit=await setup(t,[upstream],true,12,6,undefined,{integration:[]});
 assert.equal(explicit.created.requests.length,0);
 assert.equal(runtime.createReadingFirstEnrichmentRequests({controller:explicit.created.controller}).length,1);
});
test('important initial gap delays Writers, deduplicates and writes recovered content into both notes',async t=>{
 const g=gap(),s=await setup(t,[g,gap('duplicate',{target_sections:['Interpretation']}),gap('minor',{severity:'minor'})]);
 assert.equal(s.created.requests.length,0);
 const batch=runtime.createReadingFirstEnrichmentRequests({controller:s.created.controller});assert.equal(batch.length,1);assert.match(batch[0].packet.host_action_scope.arguments.message,/Interpretation/);
 assert.throws(()=>runtime.createReadingFirstDraftRequests({controller:s.created.controller}),/ENRICHMENT_PENDING/);
 await s.complete(batch[0],{run_id:'run',role:'evidence',resolutions:[answer(g,{target_sections:['Study','Interpretation']})]});
 const drafts=runtime.createReadingFirstDraftRequests({controller:s.created.controller});assert.equal(drafts.length,2);
 for(const request of drafts){assert.match(request.packet.host_action_scope.arguments.message,/canonical/);assert.match(request.packet.host_action_scope.arguments.message,/randomized/);const v=s.view(request.language);v.sections[0].paragraphs.push('The recovered allocation was randomized.');v.enrichment_consumption=[{gap_id:'design',section_heading:v.sections[0].heading}];await s.complete(request,v);}
 const rendered=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller:s.created.controller}});for(const note of rendered.notes)assert.match(note.content,/allocation was randomized/);
 assert.throws(()=>runtime.createReadingFirstEnrichmentRequests({controller:s.created.controller}),/UNAVAILABLE/);
});
test('unreported gap requires useful explanation and consequence; background cannot become paper fact',async t=>{
 const g=gap('method',{owner_role:'methods',source_kind:'cited_method'}),s=await setup(t,[g]);
 const request=runtime.createReadingFirstEnrichmentRequests({controller:s.created.controller})[0];
 await assert.rejects(()=>s.complete(request,{run_id:'run',role:'methods',resolutions:[answer(g)]}),/CLASSIFICATION/);
 await assert.rejects(()=>s.complete(request,{run_id:'run',role:'methods',resolutions:[answer(g,{classification:'background',status:'unreported',explanation:'',consequence:''})]}),/ENRICHMENT_RESULT_INVALID/);
 await s.complete(request,{run_id:'run',role:'methods',resolutions:[answer(g,{classification:'background',status:'unreported',explanation:'Standard practice estimates uncertainty by resampling; study settings were not reported.',consequence:'The study-specific number of replicates remains unknown, limiting reproducibility.'})]});
 const writers=runtime.createReadingFirstDraftRequests({controller:s.created.controller});assert.match(writers[0].packet.host_action_scope.arguments.message,/study-specific/);
 await assert.rejects(()=>s.complete(writers[0],s.view('en')),/CONSUMPTION/);
});

const reviewValue = issues => ({overall:{complete:issues.length===0,coherent:true,bilingual_consistent:true},key_nodes:[{kind:'main_conclusion',location:'p1',finding:'supported'},{kind:'key_design',location:'p1',finding:'supported'}],issues,scope:'Whole candidate and critical nodes'});
async function checkpoint(s) {
 const saved=snapshotReadingFirstRuntime(s.created.controller);
 const receipt=await commitOwnedArtifact({artifactRoot:s.root,dispatchContext:s.broker.dispatchContext,capability:s.broker.issueCapability({runId:'run',actorId:'controller',role:'control',artifactPath:'checkpoint.json',revision:'1'}),artifact:{artifact_id:'checkpoint',content:JSON.stringify(saved)},expectedRevision:'1'});
 const restored=await restoreReadingFirstRuntime({handoff:s.handoff,runControl:s.runControl,checkpointReceipt:receipt});assert.equal(restored.ok,true,JSON.stringify(restored.errors));s.created.controller=restored.controller;return restored;
}
test('new binding keeps its reply rule on restored enrichment and subsequently created Writers',async t=>{
 const contract=getRoleReplyContract(),rule=loadRoleReplyContract(contract),g=gap(),s=await setup(t,[g],true,12,6,undefined,{},contract);
 const [request]=runtime.createReadingFirstEnrichmentRequests({controller:s.created.controller});
 assert.deepEqual(request.packet.backend.configuration.role_reply_contract,contract);
 assert.ok(request.emittedStep.arguments.message.includes(rule));
 const restored=await checkpoint(s);
 assert.equal(restored.requests.length,1);
 assert.deepEqual(restored.requests[0].emittedStep,request.emittedStep);
 assert.deepEqual(restored.requests[0].packet.backend.configuration.role_reply_contract,contract);
 await s.complete(restored.requests[0],{run_id:'run',role:'evidence',resolutions:[answer(g)]},JSON.stringify({agent_id:'synthetic-enrich',reply:'evidence written: native/enrich-initial-evidence.json'}));
 const writers=runtime.createReadingFirstDraftRequests({controller:s.created.controller});
 assert.equal(writers.length,2);
 for(const writer of writers){assert.deepEqual(writer.packet.backend.configuration.role_reply_contract,contract);assert.ok(writer.emittedStep.arguments.message.includes(rule));}
 assert.equal(getReadingFirstState(s.created.controller).calls_used,3);
});
test('late scientific gap returns to its owner before affected Writer, preserving the other draft',async t=>{
 const s=await setup(t);
 for(const r of s.created.requests)await s.complete(r,s.view(r.language));
 const presentation=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller:s.created.controller}});
 const g=gap('late');await s.complete(createReadingFirstReviewRequest({controller:s.created.controller,presentation}),reviewValue([{severity:'material',kind:'science_missing',detail:'Allocation not yet recovered',affected_languages:['en'],scientific_gap:g}]));
 assert.throws(()=>createReadingFirstRevisionRequests({controller:s.created.controller}),/ENRICHMENT_PENDING/);
 const [repair]=runtime.createReadingFirstEnrichmentRequests({controller:s.created.controller});assert.equal(repair.task.role,'evidence');assert.equal(repair.packet.requested_model??repair.packet.host_action_scope.arguments.model,'gpt-6.1-sol');
 await s.complete(repair,{run_id:'run',role:'evidence',resolutions:[answer(g)]});
 const [writer]=createReadingFirstRevisionRequests({controller:s.created.controller});assert.equal(writer.language,'en');const v=s.view('en');v.sections[0].paragraphs.push('Allocation was randomized.');v.enrichment_consumption=[{gap_id:'late',section_heading:'Study'}];await s.complete(writer,v);
 const after=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller:s.created.controller}});assert.equal(after.notes.find(note=>note.language==='zh-CN').content,presentation.notes.find(note=>note.language==='zh-CN').content);
 const local=createReadingFirstReviewRequest({controller:s.created.controller,presentation:after});assert.match(local.packet.host_action_scope.arguments.message,/enrichment_context/);assert.match(local.packet.host_action_scope.arguments.message,/randomized/);await s.complete(local,reviewValue([]));assert.equal(getReadingFirstState(s.created.controller).status,'reading_complete');assert.equal(getReadingFirstState(s.created.controller).calls_used,6);
});
test('targeted method snapshot is admitted as background and source drift blocks further consumption',async t=>{
 const g=gap('method',{owner_role:'methods',source_kind:'cited_method'}),s=await setup(t,[g]);const [request]=runtime.createReadingFirstEnrichmentRequests({controller:s.created.controller});
 const bytes=Buffer.from('Official bootstrap method: resample observations to estimate sampling uncertainty.');const source={id:'method-v1',path:join(s.root,'sources',request.task.task_id,'method.txt'),sha256:sha(bytes),byte_length:bytes.length,version:'v1',kind:'cited_method',scope:'direct citation relevant resampling section',reference:'Synthetic cited method, section 2'};await mkdir(join(s.root,'sources',request.task.task_id),{recursive:true});await writeFile(source.path,bytes);
 await s.complete(request,{run_id:'run',role:'methods',sources:[source],resolutions:[answer(g,{classification:'background',source_ids:['method-v1']})]});
 const writers=runtime.createReadingFirstDraftRequests({controller:s.created.controller});assert.match(writers[0].packet.host_action_scope.arguments.message,/method-v1/);
 await writeFile(source.path,'drift');await assert.rejects(()=>s.complete(writers[0],s.view('en')),/SOURCE_CHANGED/);
});
test('checkpoint before scientific acceptance restores the same action and frozen budget',async t=>{
 const g=gap(),s=await setup(t,[g]),[request]=runtime.createReadingFirstEnrichmentRequests({controller:s.created.controller});const restored=await checkpoint(s);assert.equal(restored.requests.length,1);assert.deepEqual(restored.requests[0].emittedStep,request.emittedStep);assert.equal(getReadingFirstState(s.created.controller).calls_used,1);
 await s.complete(restored.requests[0],{run_id:'run',role:'evidence',resolutions:[answer(g)]});assert.equal(runtime.createReadingFirstDraftRequests({controller:s.created.controller}).length,2);
});
test('checkpoint after scientific acceptance preserves common content and does not reissue science',async t=>{
 const g=gap(),s=await setup(t,[g]),[request]=runtime.createReadingFirstEnrichmentRequests({controller:s.created.controller});await s.complete(request,{run_id:'run',role:'evidence',resolutions:[answer(g)]});await checkpoint(s);assert.throws(()=>runtime.createReadingFirstEnrichmentRequests({controller:s.created.controller}),/UNAVAILABLE/);const drafts=runtime.createReadingFirstDraftRequests({controller:s.created.controller});assert.match(drafts[1].packet.host_action_scope.arguments.message,/randomized/);
});
test('late repair batch cannot create calls beyond explicitly approved total',async t=>{
 const s=await setup(t,[],true,6);for(const r of s.created.requests)await s.complete(r,s.view(r.language));const presentation=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller:s.created.controller}});
 await s.complete(createReadingFirstReviewRequest({controller:s.created.controller,presentation}),reviewValue([gap('a'),gap('b',{question:'Which uncertainty estimate?',owner_role:'results'})].map(g=>({severity:'material',kind:'science_missing',detail:g.question,affected_languages:['en'],scientific_gap:g}))));
 assert.throws(()=>runtime.createReadingFirstEnrichmentRequests({controller:s.created.controller}),/BUDGET_EXHAUSTED/);assert.equal(getReadingFirstState(s.created.controller).calls_used,3);
});

test('owned same-run scientific record can be adopted; arbitrary science artifacts cannot be relabeled',async t=>{
 const g=gap(),s=await setup(t,[g]);
 await assert.rejects(()=>runtime.acceptReadingFirstEnrichmentArtifact({controller:s.created.controller,artifactId:'evidence'}),/RESULT_OWNER_INVALID/);
 const key='enrich-initial-evidence';await commitOwnedArtifact({artifactRoot:s.root,dispatchContext:s.broker.dispatchContext,capability:s.broker.issueCapability({runId:'run',actorId:key,role:'evidence',artifactPath:key+'.json',revision:'1'}),artifact:{artifact_id:key,content:JSON.stringify({run_id:'run',role:'evidence',resolutions:[answer(g)]})},expectedRevision:'1'});
 await runtime.acceptReadingFirstEnrichmentArtifact({controller:s.created.controller,artifactId:key});assert.equal(getReadingFirstState(s.created.controller).calls_used,0);await checkpoint(s);assert.equal(runtime.createReadingFirstDraftRequests({controller:s.created.controller}).length,2);
});
test('old binding without policy cannot issue or admit enrichment',async t=>{
 const s=await setup(t,[gap()],false);assert.equal(s.created.requests.length,2);
 assert.throws(()=>runtime.createReadingFirstEnrichmentRequests({controller:s.created.controller}),/UNAVAILABLE/);
 await assert.rejects(()=>runtime.acceptReadingFirstEnrichmentArtifact({controller:s.created.controller,artifactId:'evidence'}),/UNAVAILABLE/);
});
test('scientific output keeps owner/run identity and frozen deadline',async t=>{
 const g=gap(),s=await setup(t,[g]),[request]=runtime.createReadingFirstEnrichmentRequests({controller:s.created.controller});
 await assert.rejects(()=>s.complete(request,{run_id:'other',role:'evidence',resolutions:[answer(g)]}),/RESULT_INVALID/);
 await assert.rejects(()=>s.complete(request,{run_id:'run',role:'methods',resolutions:[answer(g)]}),/RESULT_INVALID/);
 t.mock.method(Date,'now',()=>Date.parse('2100-01-01T00:00:00Z'));
 await assert.rejects(()=>s.complete(request,{run_id:'run',role:'evidence',resolutions:[answer(g)]}),/DEADLINE_EXPIRED/);assert.equal(getReadingFirstState(s.created.controller).calls_used,1);
});
test('new method sources must stay in the assigned snapshot root and cannot become study facts',async t=>{
 const g=gap('method',{owner_role:'methods',source_kind:'cited_method'}),s=await setup(t,[g]),[request]=runtime.createReadingFirstEnrichmentRequests({controller:s.created.controller});
 const bytes=Buffer.from('Synthetic authoritative method background.');const source={id:'external',path:join(s.root,'outside.txt'),sha256:sha(bytes),byte_length:bytes.length,version:'1',kind:'authoritative_method',scope:'method principle',reference:'Synthetic authoritative original method'};await writeFile(source.path,bytes);
 await assert.rejects(()=>s.complete(request,{run_id:'run',role:'methods',sources:[source],resolutions:[answer(g,{classification:'background',source_ids:['external']})]}),/SOURCE_SCOPE/);
 source.path=join(s.root,request.task.source_root,'source.txt');await mkdir(join(s.root,request.task.source_root),{recursive:true});await writeFile(source.path,bytes);
 await assert.rejects(()=>s.complete(request,{run_id:'run',role:'methods',sources:[source],resolutions:[answer(g,{classification:'paper_fact',source_ids:['external']})]}),/CLASSIFICATION/);
 await s.complete(request,{run_id:'run',role:'methods',sources:[source],resolutions:[answer(g,{classification:'background',source_ids:['external']})]});
});

test('enrichment total cap cannot silently increase a smaller language call allowance',async t=>{
 const s=await setup(t,[],true,12,3);for(const r of s.created.requests)await s.complete(r,s.view(r.language));const presentation=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller:s.created.controller}});
 await s.complete(createReadingFirstReviewRequest({controller:s.created.controller,presentation}),reviewValue([{severity:'material',kind:'science_missing',detail:'Missing allocation',affected_languages:['en'],scientific_gap:gap('late')} ]));
 assert.equal(getReadingFirstState(s.created.controller).status,'completed_with_limits');assert.throws(()=>runtime.createReadingFirstEnrichmentRequests({controller:s.created.controller}),/UNAVAILABLE/);assert.throws(()=>createReadingFirstRevisionRequests({controller:s.created.controller}),/ENRICHMENT_PENDING|REVISION_UNAVAILABLE/);
});

for (const recover of [false,true]) test('partial owned adoption dispatches only remaining science'+(recover?' after restore':''),async t=>{
 const evidence=gap(),results=gap('outcome',{owner_role:'results',question:'Which outcome was measured?'}),s=await setup(t,[evidence,results],true,6);
 const key='enrich-initial-evidence';await commitOwnedArtifact({artifactRoot:s.root,dispatchContext:s.broker.dispatchContext,capability:s.broker.issueCapability({runId:'run',actorId:key,role:'evidence',artifactPath:key+'.json',revision:'1'}),artifact:{artifact_id:key,content:JSON.stringify({run_id:'run',role:'evidence',resolutions:[answer(evidence)]})},expectedRevision:'1'});
 await runtime.acceptReadingFirstEnrichmentArtifact({controller:s.created.controller,artifactId:key});if(recover)await checkpoint(s);
 const batch=runtime.createReadingFirstEnrichmentRequests({controller:s.created.controller});assert.equal(batch.length,1);assert.equal(batch[0].task.role,'results');assert.equal(getReadingFirstState(s.created.controller).calls_used,1);
 const payload=JSON.parse(batch[0].packet.host_action_scope.arguments.message.split('\n\n').at(-1));assert.equal(payload.source_root,join(s.root,batch[0].task.source_root));assert.equal(payload.output_contract.role,'results');assert.equal(payload.output_contract.resolutions[0].gap_id,'assigned id');
 assert.throws(()=>runtime.createReadingFirstEnrichmentRequests({controller:s.created.controller}),/ENRICHMENT_UNAVAILABLE/);assert.equal(getReadingFirstState(s.created.controller).calls_used,1);
 await s.complete(batch[0],{run_id:'run',role:'results',resolutions:[answer(results)]});const drafts=runtime.createReadingFirstDraftRequests({controller:s.created.controller});assert.equal(drafts.length,2);assert.equal(getReadingFirstState(s.created.controller).calls_used,3);
});

test('frozen host task_name return path accepts the actual raw shape and rejects other paths or forged correlation',async t=>{
 const s=await setup(t,[],true,12,6,['task_name']),request=s.created.requests[0];
 assert.deepEqual(request.packet.host_action_scope.result_bindings.agent_id,['task_name']);
 const raw='{ "task_name": "/root/reading_en" }';
 await assert.rejects(()=>s.complete(request,s.view('en'),JSON.stringify({agent_id:'invented'})),/HOST_AGENT_ID_UNAVAILABLE/);
 await assert.rejects(()=>s.complete(request,s.view('en'),raw,{action_id:'forged'}),/OBSERVATION_CORRELATION_MISMATCH/);
 await s.complete(request,s.view('en'),raw);
 const host=getReadingFirstState(s.created.controller).observations[0].host;assert.equal(host.raw_result_text,raw);assert.equal(host.agent_id,'/root/reading_en');assert.equal(JSON.parse(host.raw_result_text).agent_id,undefined);
});
test('default frozen host path remains agent_id and does not guess task_name',async t=>{
 const s=await setup(t),request=s.created.requests[0];assert.deepEqual(request.packet.host_action_scope.result_bindings.agent_id,['agent_id']);
 await assert.rejects(()=>s.complete(request,s.view('en'),JSON.stringify({task_name:'/root/reading_en'})),/HOST_AGENT_ID_UNAVAILABLE/);
 await s.complete(request,s.view('en'));
});
test('host identity path must be a nonempty array of nonempty strings',()=>{
 for(const path of [[],[''],['task_name',0],'task_name',null])assert.throws(()=>createReadingFirstRunControl({presentationRequired:false,runId:'run',scientificInput:{identity:{run_id:'run'}},mainSession:{model:'gpt-6-astra',reasoning_effort:'high'},authorizationId:'synthetic-only',deadline:'2099-01-01T00:00:00Z',hostResultAgentIdPath:path}),/HOST_RESULT_PATH_INVALID/);
});

const sessionProfile='reading-session-enrichment-1.0';
test('session profile freezes independently and exposes pending state',async t=>{
 const s=await setup(t,[gap()],true,12,6,undefined,{},undefined,sessionProfile);
 assert.deepEqual(getReadingFirstState(s.created.controller).enrichment,{round:'initial',pending:true});
 assert.equal(s.binding.enrichment_session_profile,sessionProfile);
});
for (const total of [6,7]) test('science repair plans both languages before total budget '+total,async t=>{
 const s=await setup(t,[],true,total,6,undefined,{},undefined,sessionProfile);
 for(const r of s.created.requests)await s.complete(r,s.view(r.language));
 const presentation=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller:s.created.controller}});
 const g=gap('late');
 await s.complete(createReadingFirstReviewRequest({controller:s.created.controller,presentation}),reviewValue([{severity:'material',kind:'scientific-gap',detail:'Allocation unclear',repair_owner:'science',affected_languages:['zh-CN'],scientific_gap:g}]));
 assert.equal(getReadingFirstState(s.created.controller).status,total===6?'completed_with_limits':'revision_required');
 if(total===7){const [r]=runtime.createReadingFirstEnrichmentRequests({controller:s.created.controller});await s.complete(r,{run_id:'run',role:'evidence',resolutions:[answer(g)]});assert.deepEqual(createReadingFirstRevisionRequests({controller:s.created.controller}).map(x=>x.language).sort(),['en','zh-CN']);}
});
test('new empty enrichment leaves draft payload free of empty context',async t=>{
 const s=await setup(t,[],true,12,6,undefined,{},undefined,sessionProfile);
 const payload=JSON.parse(s.created.requests[0].packet.host_action_scope.arguments.message.split('\n\n').at(-1));
 assert.equal(Object.hasOwn(payload,'enrichment_context'),false);
});

test('new profile requires matching policy and rejects unknown profiles',()=>{
 const base={presentationRequired:false,runId:'run',scientificInput:{identity:{run_id:'run'}},mainSession:{model:'gpt-6-astra',reasoning_effort:'high'},authorizationId:'synthetic-only',deadline:'2099-01-01T00:00:00Z'};
 assert.throws(()=>createReadingFirstRunControl({...base,enrichmentSessionProfile:sessionProfile}),/ENRICHMENT_POLICY_INVALID/);
 assert.throws(()=>createReadingFirstRunControl({...base,enrichmentSessionProfile:'unknown',enrichmentPolicy:{sources:[]},maxTotalCalls:6}),/ENRICHMENT_POLICY_INVALID/);
});
for(const total of [3,4]) test('initial budget reserves only remaining actual calls '+total,async t=>{
 const s=await setup(t,[gap()],true,total,3,undefined,{},undefined,sessionProfile);
 if(total===3) assert.throws(()=>runtime.createReadingFirstEnrichmentRequests({controller:s.created.controller}),/CALL_BUDGET_EXHAUSTED/);
 else assert.equal(runtime.createReadingFirstEnrichmentRequests({controller:s.created.controller}).length,1);
});
test('legacy enrichment keeps translation-only science routing',async t=>{
 const s=await setup(t,[],true,6);
 for(const r of s.created.requests)await s.complete(r,s.view(r.language));
 const presentation=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller:s.created.controller}}),g=gap('late');
 await s.complete(createReadingFirstReviewRequest({controller:s.created.controller,presentation}),reviewValue([{severity:'material',kind:'scientific-gap',detail:'Allocation unclear',repair_owner:'science',affected_languages:['zh-CN'],scientific_gap:g}]));
 assert.equal(getReadingFirstState(s.created.controller).status,'revision_required');
 const [r]=runtime.createReadingFirstEnrichmentRequests({controller:s.created.controller});await s.complete(r,{run_id:'run',role:'evidence',resolutions:[answer(g)]});
 assert.deepEqual(createReadingFirstRevisionRequests({controller:s.created.controller}).map(x=>x.language),['zh-CN']);
});

test('new science repair cannot exceed independent language call limit',async t=>{
 const s=await setup(t,[],true,12,5,undefined,{},undefined,sessionProfile);
 for(const r of s.created.requests)await s.complete(r,s.view(r.language));
 const presentation=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller:s.created.controller}}),g=gap('late');
 await s.complete(createReadingFirstReviewRequest({controller:s.created.controller,presentation}),reviewValue([{severity:'material',kind:'scientific-gap',detail:'Allocation unclear',repair_owner:'science',affected_languages:['zh-CN'],scientific_gap:g}]));
 assert.equal(getReadingFirstState(s.created.controller).status,'completed_with_limits');
 assert.throws(()=>runtime.createReadingFirstEnrichmentRequests({controller:s.created.controller}),/UNAVAILABLE/);
});
