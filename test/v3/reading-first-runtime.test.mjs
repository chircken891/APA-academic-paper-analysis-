import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createOwnedArtifactBroker, commitOwnedArtifact } from '../../scripts/v3/owned-artifact-store.mjs';
import { createPhase21ContractValidator } from '../../scripts/v3/phase21-contract-loader.mjs';
import { buildPreRenderHandoff } from '../../scripts/v3/workflow-composer.mjs';
import { createLanguageRequests } from '../../scripts/v3/phase22-language.mjs';
import { renderReaderNotes } from '../../scripts/v3/phase221-presentation.mjs';
import { READING_FIRST_PROFILE, fingerprintReadingFirst, resolveReadingWorkflowProfile, acceptReadingFirstResult, createReadingFirstReviewRequest, getReadingFirstState, createReadingFirstRevisionRequests, createReadingFirstRunControl, snapshotReadingFirstRuntime, restoreReadingFirstRuntime, createReadingFirstDraftRequests, createReadingFirstPresentationRequest, buildReadingFirstHandoff } from '../../scripts/v3/reading-first-runtime.mjs';
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const roles = ['evidence','methods','results','interpretation','scientific-reading','integration'];
async function setup(t, { presentation, presentationRequired = false, writingMode = 'independent', sourceLanguage = 'en', presentationMode = 'writer', priorCalls = 0, maxTotalCalls, maxCalls = presentationMode==='reading-editor'?7:6 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'reading-first-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  const sourceBytes=Buffer.from('Synthetic original source: design, result and limitation.');
  await writeFile(join(root,'source.pdf'),sourceBytes);
  const tasks=Object.fromEntries(['en','zh-CN','review','en-r2','zh-CN-r2','review-r2',...(presentationMode==='reading-editor'?['presentation','presentation-r2']:[])].map(key=>[key,{task_id:key,task_name:'reading_'+key.replaceAll('-','_').toLowerCase(),owner_actor_id:key,role:key.startsWith('presentation')?'reading-editor':key.startsWith('en')?'english-writer':key.startsWith('zh')?'chinese-writer':'independent-verifier',artifact_id:key,artifact_path:key+'.json',native_path:'native/'+key+'.json',revision:'1'}]));
  const bindings=[...roles.map(role=>({run_id:'run',actor_id:role,role,artifact_path:'science/'+role+'.json',revision:'1'})),...Object.values(tasks).map(task=>({run_id:'run',actor_id:task.owner_actor_id,role:task.role,artifact_path:task.artifact_path,revision:task.revision}))];
  const input={identity:{paper_id:presentation ? 'pap_'+'a'.repeat(32) : 'synthetic',run_id:'run'},sources:[{path:join(root,'source.pdf'),sha256:sha(sourceBytes),byte_length:sourceBytes.length}],context:'Read all existing material as a connected account.',role_artifacts:roles};
  const runBinding=createReadingFirstRunControl({presentationMode,writingMode,sourceLanguage,presentationRequired,priorCalls,maxTotalCalls,runId:'run',scientificInput:input,mainSession:{model:'gpt-6-astra',reasoning_effort:'high'},authorizationId:'synthetic-only',maxCalls,deadline:'2099-01-01T00:00:00Z',taskBindings:tasks});
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
  const scienceResult=await runFiniteRoleSequence({run:scienceRun,dispatchContext:broker.dispatchContext,artifactStore:broker,actions:roles.map(role=>({role,action:{type:'write_artifact',actor_id:role,role,artifact_path:'science/'+role+'.json',revision:'1',artifact:{artifact_id:role,content:JSON.stringify({context:'Full connected science for '+role,...(role==='integration' && presentation ? {presentation} : {})})}}}))});
  assert.notEqual(scienceResult.status,'blocked',JSON.stringify(scienceResult.delivery_gate));
  assert.equal(scienceResult.receipts.length,6);
  assert.equal(scienceResult.chain.source_check,undefined);
  const handoff=await buildPreRenderHandoff({run:{run_id:'run',workflow_profile:READING_FIRST_PROFILE},dispatchContext:broker.dispatchContext,artifactRoot:root,scientificInput:input});
  const runControl={runId:'run',artifactRoot:root,dispatchContext:broker.dispatchContext};
  const created=createLanguageRequests({handoff,runControl});
  assert.equal(created.ok,true,JSON.stringify(created.errors));
  const complete=async(request,value)=>{
    await mkdir(join(root,'native'),{recursive:true});
    await writeFile(join(root,request.task.native_path),JSON.stringify(value));
    const step=request.emittedStep;
    return acceptReadingFirstResult({controller:created.controller,request,observation:{action_id:step.action_id,run_id:'run',input_fingerprint:step.input_fingerprint,port:'current-collaboration',tool_call:{name:step.action,arguments:step.arguments},raw_result_text:JSON.stringify({agent_id:'synthetic-'+request.task.task_id})},capability:broker.issueCapability({runId:'run',actorId:request.task.owner_actor_id,role:request.task.role,artifactPath:request.task.artifact_path,revision:request.task.revision})});
  };
  const view=language=>({language,sections:[{heading:language==='en'?'Study':'研究',paragraphs:[language==='en'?'The study design produced the main finding; its limitation bounds the conclusion.':'研究设计产生主要发现，研究限制界定结论。']} ]});
  return {root,broker,handoff,created,complete,view,runControl};
}
test('new runs default to reading first while existing legacy binding is preserved',()=>{
  assert.equal(resolveReadingWorkflowProfile({newRun:true}),READING_FIRST_PROFILE);
  assert.equal(resolveReadingWorkflowProfile({existingBinding:{}}),'legacy');
  assert.equal(resolveReadingWorkflowProfile({existingBinding:{profile:READING_FIRST_PROFILE}}),READING_FIRST_PROFILE);
});
test('prior actual calls remain charged through checkpoint restoration and exhaust the total budget',async t=>{
  const s=await setup(t,{priorCalls:3,maxCalls:3,maxTotalCalls:6});
  assert.equal(getReadingFirstState(s.created.controller).calls_used,5);
  for (const request of s.created.requests) await s.complete(request,s.view(request.language));
  const rendered=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller:s.created.controller}});
  const review=createReadingFirstReviewRequest({controller:s.created.controller,presentation:rendered});
  assert.equal(getReadingFirstState(s.created.controller).calls_used,6);
  const saved=snapshotReadingFirstRuntime(s.created.controller);
  const receipt=await commitOwnedArtifact({artifactRoot:s.root,dispatchContext:s.broker.dispatchContext,capability:s.broker.issueCapability({runId:'run',actorId:'controller',role:'control',artifactPath:'checkpoint.json',revision:'1'}),artifact:{artifact_id:'checkpoint',content:JSON.stringify(saved)},expectedRevision:'1'});
  const recovered=await restoreReadingFirstRuntime({handoff:s.handoff,runControl:s.runControl,checkpointReceipt:receipt});
  assert.equal(recovered.ok,true,JSON.stringify(recovered.errors));
  assert.equal(getReadingFirstState(recovered.controller).calls_used,6);
  assert.deepEqual(recovered.requests[0].emittedStep,review.emittedStep);
  assert.equal(saved.state.requestLog.length,3);
  await s.complete(review,{overall:{complete:false,coherent:true,bilingual_consistent:true},key_nodes:[],issues:[{severity:'material',kind:'omission',detail:'Synthetic missing context',affected_languages:['en']}],scope:'Synthetic bounded review'});
  assert.equal(getReadingFirstState(s.created.controller).status,'completed_with_limits');
  assert.throws(()=>createReadingFirstRevisionRequests({controller:s.created.controller}),/REVISION/);
});
test('prior call count and independent total cap must be valid and reserve downstream calls',()=>{
  const args={runId:'test',scientificInput:{identity:{run_id:'test'}},mainSession:{model:'gpt-6-astra',reasoning_effort:'high'},authorizationId:'test',deadline:'2099-01-01T00:00:00Z',maxCalls:3,taskBindings:{}};
  for(const patch of [{priorCalls:-1},{priorCalls:0.5},{priorCalls:3},{priorCalls:3,maxTotalCalls:5},{maxTotalCalls:2}]) assert.throws(()=>createReadingFirstRunControl({...args,...patch}),/CALL_BUDGET_INVALID/);
  assert.equal(createReadingFirstRunControl({...args,priorCalls:3,maxTotalCalls:10}).reading_first_binding.prior_calls,3);
  assert.equal(createReadingFirstRunControl({...args,maxTotalCalls:10}).reading_first_binding.max_total_calls,10);
});
test('Writer knowledge content is validated before owned commit and composed for Reading Editor',async t=>{
  const presentation={knowledge_layout:'shared-bilingual-1.0',knowledge:[{id:'method',paragraphs:{en:['Original English.'],'zh-CN':['原中文。']}}]};
  const s=await setup(t,{presentation,presentationMode:'reading-editor'});
  const english=s.created.requests.find(request=>request.language==='en');
  const invalid={...s.view('en'),knowledge_content:[{id:'unknown',paragraphs:['Invented node.']}]};
  await assert.rejects(()=>s.complete(english,invalid),/KNOWLEDGE_CONTENT_INVALID/);
  await assert.rejects(()=>readFile(join(s.root,'en.json')),/ENOENT/);
  const entry={id:'method',paragraphs:['Detailed supported English.'],sections:[{heading:'Principle',paragraphs:['Useful explanation.']}]};
  await assert.rejects(()=>s.complete(english,{...s.view('en'),knowledge_content:[entry,entry]}),/KNOWLEDGE_CONTENT_INVALID/);
  await s.complete(english,{...s.view('en'),knowledge_content:[entry]});
  const chinese=s.created.requests.find(request=>request.language==='zh-CN');
  await s.complete(chinese,{...s.view('zh-CN'),knowledge_content:[{id:'method',paragraphs:['充分解释中文原理。']}]});
  const request=createReadingFirstPresentationRequest({controller:s.created.controller});
  const payload=JSON.parse(request.emittedStep.arguments.message.split('\n\n').at(-1));
  assert.deepEqual(payload.presentation.knowledge[0].paragraphs,{en:['Detailed supported English.'],'zh-CN':['充分解释中文原理。']});
  assert.equal(payload.presentation.knowledge[0].sections.en[0].heading,'Principle');
  assert.deepEqual(payload.sources,s.handoff.sources);
  assert.equal(payload.context,s.handoff.context);
  assert.equal(presentation.knowledge[0].paragraphs.en[0],'Original English.');
});
test('controlled host/owned path writes both complete drafts, renders without parity and makes one overall review',async t=>{
  const s=await setup(t);
  assert.equal(s.handoff.review_status,'pending');
  assert.equal(s.handoff.publishable,false);
  const englishInstruction=s.created.requests.find(request=>request.language==='en').emittedStep.arguments.message;
  const chineseInstruction=s.created.requests.find(request=>request.language==='zh-CN').emittedStep.arguments.message;
  assert.match(englishInstruction,/Apply Humanizer in embedded mode/);
  assert.match(chineseInstruction,/Humanizer-zh 的嵌入方式/);
  assert.match(englishInstruction,/Apply stss/);
  assert.match(chineseInstruction,/用 stss/);
  assert.match(englishInstruction,/do not produce a separate prose-only draft/);
  assert.match(chineseInstruction,/不另交纯文字初稿/);
  for (const request of s.created.requests) {
    const instruction=request.emittedStep.arguments.message;
    const guide=request.packet.backend.configuration.writing_guide;
    const guideBytes=await readFile(guide.path);
    assert.equal(guide.sha256,sha(guideBytes));
    assert.equal(guide.byte_length,guideBytes.length);
    assert.match(instruction,/Nature \+ Humanizer, on demand/);
    assert.ok(instruction.includes(JSON.stringify({writing_guide:guide})));
    assert.match(instruction,/Read only the rows or sections relevant/);
    assert.doesNotMatch(instruction,/Title and title page|\| 标题与短标题 \|/);
  }
  for(const request of s.created.requests) await s.complete(request,s.view(request.language));
  const rendered=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller:s.created.controller}});
  assert.equal(rendered.notes.length,2);
  assert.match(rendered.notes[0].content,/main finding/);
  assert.equal(rendered.review_status,'pending');
  const request=createReadingFirstReviewRequest({controller:s.created.controller,presentation:rendered});
  assert.equal(request.task.role,'independent-verifier');
  assert.doesNotMatch(request.emittedStep.arguments.message,/Nature \+ Humanizer, on demand/);
  await s.complete(request,{overall:{complete:true,coherent:true,bilingual_consistent:true,format:false},key_nodes:[{kind:'main_conclusion',location:'source.pdf p1',finding:'supported'},{kind:'key_design',location:'source.pdf p1',finding:'supported'}],issues:[{severity:'minor',kind:'format',detail:'ordinary punctuation'}],scope:'Only conclusion, key design and conclusion-changing values checked.'});
  const state=getReadingFirstState(s.created.controller);
  assert.equal(state.status,'reading_complete');
  assert.equal(state.calls_used,3);
  assert.equal(state.publishable,false);
  assert.deepEqual(state.requests.map(x=>x.role),['english-writer','chinese-writer','independent-verifier']);
  assert.throws(()=>createReadingFirstReviewRequest({controller:s.created.controller,presentation:rendered}),/REVIEW_ALREADY_REQUESTED/);
});
test('material omission requires local correction; one local review closes unresolved with limits',async t=>{
  const s=await setup(t);
  for(const request of s.created.requests) await s.complete(request,s.view(request.language));
  let rendered=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller:s.created.controller}});
  const review={overall:{complete:false,coherent:true,bilingual_consistent:true},key_nodes:[],issues:[{severity:'material',kind:'omission',detail:'Important limitation missing',affected_languages:['en']}],scope:'whole account'};
  await s.complete(createReadingFirstReviewRequest({controller:s.created.controller,presentation:rendered}),review);
  assert.equal(getReadingFirstState(s.created.controller).status,'revision_required');
  const revisions=createReadingFirstRevisionRequests({controller:s.created.controller});
  assert.equal(revisions.length,1);
  assert.equal(revisions[0].language,'en');
  await s.complete(revisions[0],s.view('en'));
  rendered=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller:s.created.controller}});
  const local=createReadingFirstReviewRequest({controller:s.created.controller,presentation:rendered});
  assert.equal(local.review_scope,'local');
  await s.complete(local,review);
  assert.equal(getReadingFirstState(s.created.controller).status,'completed_with_limits');
  assert.equal(getReadingFirstState(s.created.controller).calls_used,5);
});
test('original source drift prevents acceptance and a forged observation cannot become an owned result',async t=>{
  const s=await setup(t);
  const request=s.created.requests[0];
  await writeFile(join(s.root,'source.pdf'),'changed');
  await assert.rejects(()=>s.complete(request,s.view('en')),/SOURCE_CHANGED/);
});



test('owned Controller checkpoint restores existing requests and budget without a second writer dispatch',async t=>{
  const s=await setup(t);
  await s.complete(s.created.requests[0],s.view('en'));
  const saved=snapshotReadingFirstRuntime(s.created.controller);
  assert.deepEqual(saved.state.writingGuide,s.created.requests[0].packet.backend.configuration.writing_guide);
  const receipt=await commitOwnedArtifact({artifactRoot:s.root,dispatchContext:s.broker.dispatchContext,capability:s.broker.issueCapability({runId:'run',actorId:'controller',role:'control',artifactPath:'checkpoint.json',revision:'1'}),artifact:{artifact_id:'checkpoint',content:JSON.stringify(saved)},expectedRevision:'1'});
  const recovered=await restoreReadingFirstRuntime({handoff:s.handoff,runControl:s.runControl,checkpointReceipt:receipt});
  assert.equal(recovered.ok,true);
  assert.equal(recovered.requests.length,1);
  assert.deepEqual(recovered.requests[0].emittedStep,s.created.requests[1].emittedStep);
  assert.equal(getReadingFirstState(recovered.controller).calls_used,2);
  assert.equal(getReadingFirstState(recovered.controller).observations.length,1);
});
test('a zero-key-check review ends with explicit limits, not scientific completion',async t=>{
 const s=await setup(t);
 for(const request of s.created.requests) await s.complete(request,s.view(request.language));
 const presentation=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller:s.created.controller}});
 await s.complete(createReadingFirstReviewRequest({controller:s.created.controller,presentation}),{overall:{complete:true,coherent:true,bilingual_consistent:true},key_nodes:[],issues:[],scope:'No source checking possible'});
 assert.equal(getReadingFirstState(s.created.controller).status,'completed_with_limits');
});
import { runFiniteRoleSequence } from '../../scripts/v3/phase21-runner.mjs';
test('new six-role scientific sequence uses the existing controlled store without hidden source-first actions',async t=>{
 const s=await setup(t), seen=[];
 const result=await runFiniteRoleSequence({run:{run_id:'run',workflow_profile:READING_FIRST_PROFILE},dispatchContext:s.broker.dispatchContext,actions:roles.map(role=>({role,action:{type:'write_artifact',role}})),dependencies:{advanceRun:async({run,action})=>{seen.push(action.role);return run;}}});
 assert.equal(result.run_id,'run');assert.deepEqual(seen,roles);
});
test('native host correlation rejects a forged observation without creating a result receipt',async t=>{
 const s=await setup(t),request=s.created.requests[0];
 await mkdir(join(s.root,'native'),{recursive:true});await writeFile(join(s.root,request.task.native_path),JSON.stringify(s.view('en')));
 await assert.rejects(()=>acceptReadingFirstResult({controller:s.created.controller,request,observation:{raw_result_text:'{"agent_id":"forged"}'},capability:{}}),/OBSERVATION_CORRELATION_MISMATCH/);
 await assert.rejects(()=>readFile(join(s.root,'en.json')),/ENOENT/);
});


test('owned Integrator presentation reaches both Writers and the existing final review without extra calls',async t=>{
  const presentation={schema_version:'reading-first-obsidian-1.0',bibliography:{title:'Synthetic study',first_author:'Tester',year:2026},source_pdf:'Raw/source.pdf',sections:[{id:'study',indices:{en:0,'zh-CN':0}}],visuals:[],knowledge:[],map:{steps:[],findings:[],relations:[]}};
  const s=await setup(t,{presentation,presentationRequired:true});
  assert.deepEqual(s.handoff.presentation,presentation);
  for(const request of s.created.requests) {
    assert.ok(request.emittedStep.arguments.message.includes('reading-first-obsidian-1.0'));
    await s.complete(request,s.view(request.language));
  }
  const rendered=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller:s.created.controller}});
  assert.equal(rendered.notes.length,2);
  assert.match(rendered.notes[0].content,/rendering_profile: reading-first-obsidian-1.0/);
  assert.match(rendered.notes[0].content,/Personal Notes/);
  assert.match(rendered.notes[0].path,/^Wiki\/sources\//);
  const request=createReadingFirstReviewRequest({controller:s.created.controller,presentation:rendered});
  assert.ok(request.emittedStep.arguments.message.includes(rendered.notes[0].path));
  assert.equal(getReadingFirstState(s.created.controller).calls_used,3);
  assert.equal(rendered.publishable,false);
  await s.complete(request,{overall:{complete:true,coherent:true,bilingual_consistent:true},key_nodes:[{kind:'main_conclusion',location:'p1',finding:'supported'},{kind:'key_design',location:'p1',finding:'supported'}],issues:[],scope:'Final rendered candidate.'});
  const again=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller:s.created.controller},targetRegistry:rendered.targetRegistry});
  assert.equal(again.review_status,'complete');
  const existingTargets=rendered.notes.map(note=>({path:note.path,bytes:Buffer.from(note.content.replace('## Personal Notes','Human note.\n\n## Personal Notes')),managedHash:note.managedHash}));
  const changed=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller:s.created.controller},targetRegistry:rendered.targetRegistry,existingTargets});
  assert.equal(changed.review_status,'pending');
  assert.equal(getReadingFirstState(s.created.controller).calls_used,3);
});


test('presentation-required runs cannot silently finish as text-only notes',async t=>{
  const s=await setup(t,{presentationRequired:true});
  for(const request of s.created.requests) await s.complete(request,s.view(request.language));
  await assert.rejects(()=>renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller:s.created.controller}}),/READING_FIRST_PRESENTATION_REQUIRED/);
});


test('source-first waits for actual source output and restores only the emitted counterpart with original budget',async t=>{
  const s=await setup(t,{writingMode:'source-first'});
  assert.deepEqual(s.created.requests.map(item=>item.language),['en']);
  assert.throws(()=>createReadingFirstDraftRequests({controller:s.created.controller}),/SOURCE_DRAFT_PENDING/);
  await s.complete(s.created.requests[0],s.view('en'));
  const [counterpart]=createReadingFirstDraftRequests({controller:s.created.controller});
  const packet=JSON.parse(counterpart.emittedStep.arguments.message.split('\n\n').at(-1));
  assert.deepEqual(packet.source_view,s.view('en'));
  assert.equal(packet.source_view_receipt.artifact_id,'en');
  const saved=snapshotReadingFirstRuntime(s.created.controller);
  const receipt=await commitOwnedArtifact({artifactRoot:s.root,dispatchContext:s.broker.dispatchContext,capability:s.broker.issueCapability({runId:'run',actorId:'controller',role:'control',artifactPath:'checkpoint.json',revision:'1'}),artifact:{artifact_id:'checkpoint',content:JSON.stringify(saved)},expectedRevision:'1'});
  const recovered=await restoreReadingFirstRuntime({handoff:s.handoff,runControl:s.runControl,checkpointReceipt:receipt});
  assert.equal(recovered.ok,true);
  assert.deepEqual(recovered.requests.map(item=>item.task.artifact_id),['zh-CN']);
  assert.deepEqual(recovered.requests[0].emittedStep,counterpart.emittedStep);
  assert.equal(getReadingFirstState(recovered.controller).calls_used,2);
});

test('source-first repairs source then counterpart before the sole local review and uses at most six calls',async t=>{
  const s=await setup(t,{writingMode:'source-first'}),controller=s.created.controller;
  await s.complete(s.created.requests[0],s.view('en'));
  await s.complete(createReadingFirstDraftRequests({controller})[0],s.view('zh-CN'));
  let rendered=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller}});
  const material={overall:{complete:false,coherent:true,bilingual_consistent:true},key_nodes:[],issues:[{severity:'material',kind:'omission',detail:'Missing design explanation',affected_languages:['en']}],scope:'whole account'};
  await s.complete(createReadingFirstReviewRequest({controller,presentation:rendered}),material);
  const [first]=createReadingFirstRevisionRequests({controller});
  assert.equal(first.language,'en');
  assert.throws(()=>createReadingFirstRevisionRequests({controller}),/SOURCE_DRAFT_PENDING/);
  await s.complete(first,s.view('en'));
  await assert.rejects(()=>renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller}}),/REVISION_PENDING/);
  const [second]=createReadingFirstRevisionRequests({controller});
  assert.equal(second.language,'zh-CN');
  const payload=JSON.parse(second.emittedStep.arguments.message.split('\n\n').at(-1));
  assert.equal(payload.source_view_receipt.artifact_id,'en-r2');
  await s.complete(second,s.view('zh-CN'));
  rendered=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller}});
  const local=createReadingFirstReviewRequest({controller,presentation:rendered});
  assert.equal(local.review_scope,'local');
  await s.complete(local,{overall:{complete:true,coherent:true,bilingual_consistent:true},key_nodes:[{kind:'main_conclusion',location:'source',finding:'supported'},{kind:'key_design',location:'source',finding:'supported'}],issues:[],scope:'only repaired context'});
  assert.equal(getReadingFirstState(controller).calls_used,6);
  assert.equal(getReadingFirstState(controller).review_rounds,2);
  assert.equal(getReadingFirstState(controller).status,'reading_complete');
});

for (const maxCalls of [7,8]) test(`source-first Reading Editor respects a frozen ${maxCalls}-call budget for bilingual repair`,async t=>{
  const s=await setup(t,{writingMode:'source-first',presentationMode:'reading-editor',priorCalls:6,maxTotalCalls:14,maxCalls}),controller=s.created.controller;
  const views=['en','zh-CN'].map(language=>({...s.view(language),sections:[{id:'design',heading:'Design',paragraphs:['The main finding follows the design.']}]}));
  const editorFor=()=>({schema_version:'reading-editor-1.0',views_fingerprint:fingerprintReadingFirst(views),languages:Object.fromEntries(['en','zh-CN'].map(language=>[language,{overview:[{text:'Main finding',section_ids:['design']}],sections:[],methods:[{id:'design-method',title:'Design method',explanation:'Design explains inference.',application:'Used in this design.',section_ids:['design']}]}]))});
  await s.complete(s.created.requests[0],views[0]);
  await s.complete(createReadingFirstDraftRequests({controller})[0],views[1]);
  await s.complete(createReadingFirstPresentationRequest({controller}),editorFor());
  let rendered=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller}});
  await s.complete(createReadingFirstReviewRequest({controller,presentation:rendered}),{overall:{complete:false,coherent:true,bilingual_consistent:true},key_nodes:[],issues:[{severity:'material',kind:'omission',detail:'Design explanation missing',affected_languages:['en']}],scope:'overall'});
  if(maxCalls===7){
    assert.equal(getReadingFirstState(controller).status,'completed_with_limits');
    assert.throws(()=>createReadingFirstRevisionRequests({controller}),/REVISION_UNAVAILABLE/);
    assert.equal(getReadingFirstState(controller).calls_used,10);
    return;
  }
  assert.equal(getReadingFirstState(controller).status,'revision_required');
  const [source]=createReadingFirstRevisionRequests({controller});
  assert.equal(source.language,'en');
  await s.complete(source,views[0]);
  const [counterpart]=createReadingFirstRevisionRequests({controller});
  assert.equal(counterpart.language,'zh-CN');
  await s.complete(counterpart,views[1]);
  const editor=createReadingFirstPresentationRequest({controller});
  assert.equal(editor.task.artifact_id,'presentation-r2');
  await s.complete(editor,editorFor());
  rendered=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller}});
  const local=createReadingFirstReviewRequest({controller,presentation:rendered});
  assert.equal(local.review_scope,'local');
  await s.complete(local,{overall:{complete:true,coherent:true,bilingual_consistent:true},key_nodes:[{kind:'main_conclusion',location:'source',finding:'supported'},{kind:'key_design',location:'source',finding:'supported'}],issues:[],scope:'local'});
  const state=getReadingFirstState(controller);
  assert.equal(state.calls_used,14);
  assert.equal(state.requests.length,8);
  assert.equal(state.review_rounds,2);
  assert.equal(state.status,'reading_complete');
  assert.throws(()=>createReadingFirstReviewRequest({controller,presentation:rendered}),/REVIEW_ALREADY_REQUESTED/);
});

test('eight-call editor binding retains the independent total cap and writer limit',()=>{
  const args={runId:'test',scientificInput:{identity:{run_id:'test'}},mainSession:{model:'gpt-6-astra',reasoning_effort:'high'},authorizationId:'test',deadline:'2099-01-01T00:00:00Z',taskBindings:{},presentationMode:'reading-editor',maxCalls:8,priorCalls:6};
  assert.throws(()=>createReadingFirstRunControl({...args,maxTotalCalls:13}),/CALL_BUDGET_INVALID/);
  assert.throws(()=>createReadingFirstRunControl({...args,maxTotalCalls:14,presentationMode:'writer'}),/CONTROL_INVALID/);
  assert.throws(()=>createReadingFirstRunControl({...args,maxCalls:9,maxTotalCalls:15}),/CONTROL_INVALID/);
  assert.throws(()=>createReadingFirstRunControl({...args,maxTotalCalls:14,existingBinding:{max_calls:7}}),/EXISTING_BINDING_PRESERVED/);
});

test('adopted scientific receipts retain original run/root and reject altered receipts or mixed inputs',async t=>{
  const s=await setup(t);
  const make=async(change={})=>{
    const input={profile:READING_FIRST_PROFILE,identity:{run_id:'adoption',paper_id:'synthetic'},context:'Reuse only saved science',sources:s.handoff.sources,role_artifacts:[],adopted_science:s.handoff.science.map(item=>({artifact_root:s.root,artifact_id:item.receipt.artifact_id,receipt:item.receipt})),presentation:{layout:'writer-modules-1.0'},...change};
    const control=createReadingFirstRunControl({runId:'adoption',scientificInput:input,mainSession:{model:'gpt-6-astra',reasoning_effort:'high'},authorizationId:'synthetic',deadline:'2099-01-01T00:00:00Z',taskBindings:{}});
    const broker=createOwnedArtifactBroker({control_actor_id:'controller',artifact_root:s.root,authorized_bindings:[],run_controls:[control]});
    return buildReadingFirstHandoff({run:{run_id:'adoption'},dispatchContext:broker.dispatchContext,artifactRoot:s.root,scientificInput:input});
  };
  const adopted=await make();
  assert.equal(adopted.science.length,6);
  assert.equal(adopted.science[0].receipt.run_id,'run');
  assert.equal(adopted.science[0].artifact_root,s.root);
  assert.deepEqual(adopted.science[0].receipt,s.handoff.science[0].receipt);
  assert.equal(adopted.presentation.layout,'writer-modules-1.0');
  await assert.rejects(()=>make({role_artifacts:['evidence']}),/SCIENCE_RECEIPT_INVALID/);
  const entries=s.handoff.science.map(item=>({artifact_root:s.root,artifact_id:item.receipt.artifact_id,receipt:{...item.receipt}}));
  entries[0].receipt.run_id='forged';
  await assert.rejects(()=>make({adopted_science:entries}),/SCIENCE_RECEIPT_INVALID/);
});


test('module-layout Writer results require module IDs and explicit placements before owned commit',async t=>{
  const presentation={schema_version:'reading-first-obsidian-1.0',layout:'writer-modules-1.0',modules:[{id:'design',label:{en:'Study design','zh-CN':'研究设计'}}]};
  const s=await setup(t,{presentation,writingMode:'source-first'});
  await assert.rejects(()=>s.complete(s.created.requests[0],s.view('en')),/VIEW_LAYOUT_INVALID/);
  await assert.rejects(()=>readFile(join(s.root,'en.json')),/ENOENT/);
  const value={language:'en',sections:[{id:'design-step',module_id:'design',heading:'Design',paragraphs:['The design supports the comparison.']}],placements:{visuals:[],knowledge:[]}};
  await s.complete(s.created.requests[0],value);
  assert.equal(getReadingFirstState(s.created.controller).observations.length,1);
});


test('dedicated reading editor owns its output and must refresh after a Writer correction within seven calls',async t=>{
  const s=await setup(t,{presentationMode:'reading-editor'}),controller=s.created.controller;
  const views=['en','zh-CN'].map(language=>({...s.view(language),sections:[{id:'design',heading:'Design',paragraphs:['The main finding follows the design.']}]}));
  for(const request of s.created.requests) await s.complete(request,views.find(view=>view.language===request.language));
  await assert.rejects(()=>renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller}}),/EDITOR_REQUIRED/);
  const editorFor=values=>({schema_version:'reading-editor-1.0',views_fingerprint:fingerprintReadingFirst(values),languages:Object.fromEntries(['en','zh-CN'].map(language=>[language,{overview:[{text:'Main finding',section_ids:['design']}],sections:[],methods:[{id:'design-method',title:'Design method',explanation:'Design explains inference.',application:'Used in this design.',section_ids:['design']}]}]))});
  const first=createReadingFirstPresentationRequest({controller});
  assert.equal(first.task.role,'reading-editor');
  assert.equal(first.emittedStep.arguments.model,'gpt-6-astra');
  const accepted=await s.complete(first,editorFor(views));
  assert.equal(accepted.receipt.role,'reading-editor');
  let rendered=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller}});
  await s.complete(createReadingFirstReviewRequest({controller,presentation:rendered}),{overall:{complete:false,coherent:true,bilingual_consistent:true},key_nodes:[],issues:[{severity:'material',kind:'omission',detail:'Design explanation missing',affected_languages:['en']}],scope:'overall'});
  const revision=createReadingFirstRevisionRequests({controller})[0];
  views[0].sections[0].paragraphs[0]='The revised main finding follows the design.';
  await s.complete(revision,views[0]);
  await assert.rejects(()=>renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller}}),/EDITOR_REQUIRED/);
  const refresh=createReadingFirstPresentationRequest({controller});
  assert.equal(refresh.task.artifact_id,'presentation-r2');
  await assert.rejects(()=>s.complete(refresh,editorFor([{...views[0],sections:[]},views[1]])),/FINGERPRINT_INVALID/);
  await s.complete(refresh,editorFor(views));
  rendered=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller}});
  const local=createReadingFirstReviewRequest({controller,presentation:rendered});
  await s.complete(local,{overall:{complete:true,coherent:true,bilingual_consistent:true},key_nodes:[{kind:'main_conclusion',location:'source',finding:'supported'},{kind:'key_design',location:'source',finding:'supported'}],issues:[],scope:'local'});
  assert.equal(getReadingFirstState(controller).calls_used,7);
  assert.equal(getReadingFirstState(controller).review_rounds,2);
  assert.equal(getReadingFirstState(controller).status,'reading_complete');
});

test('presentation-only run adopts authentic Writer receipts and restores pending editor without resetting budget',async t=>{
  const s=await setup(t);
  const adopted=[];
  for(const request of s.created.requests) {
    const value={language:request.language,sections:[{id:'design',heading:'Design',paragraphs:['Design explains the main finding.']}]};
    const accepted=await s.complete(request,value);
    adopted.push({artifact_root:s.root,artifact_id:accepted.receipt.artifact_id,receipt:accepted.receipt});
  }
  const input={profile:READING_FIRST_PROFILE,identity:{run_id:'presentation-only',paper_id:'synthetic'},context:'Reuse saved science and accepted prose.',sources:s.handoff.sources,role_artifacts:[],adopted_science:s.handoff.science.map(item=>({artifact_root:s.root,artifact_id:item.receipt.artifact_id,receipt:item.receipt})),adopted_views:adopted};
  const tasks=Object.fromEntries(['presentation','presentation-r2','review','review-r2'].map(key=>[key,{task_id:key,task_name:key.replaceAll('-','_'),owner_actor_id:key,role:key.startsWith('presentation')?'reading-editor':'independent-verifier',artifact_id:key,artifact_path:'fresh/'+key+'.json',native_path:'fresh-native/'+key+'.json',revision:'1'}]));
  const control=createReadingFirstRunControl({runId:'presentation-only',presentationRequired:false,scientificInput:input,presentationMode:'reading-editor',mainSession:{model:'gpt-6-astra',reasoning_effort:'high'},authorizationId:'synthetic',deadline:'2099-01-01T00:00:00Z',maxCalls:4,taskBindings:tasks});
  const authorized=Object.values(tasks).map(task=>({run_id:'presentation-only',actor_id:task.owner_actor_id,role:task.role,artifact_path:task.artifact_path,revision:'1'}));
  authorized.push({run_id:'presentation-only',actor_id:'controller',role:'control',artifact_path:'fresh-checkpoint.json',revision:'1'});
  const broker=createOwnedArtifactBroker({control_actor_id:'controller',artifact_root:s.root,authorized_bindings:authorized,run_controls:[control]});
  const handoff=await buildReadingFirstHandoff({run:{run_id:'presentation-only'},dispatchContext:broker.dispatchContext,artifactRoot:s.root,scientificInput:input});
  const runControl={runId:'presentation-only',artifactRoot:s.root,dispatchContext:broker.dispatchContext};
  const created=createLanguageRequests({handoff,runControl});assert.equal(created.ok,true,JSON.stringify(created.errors));assert.equal(created.requests.length,0);
  const request=createReadingFirstPresentationRequest({controller:created.controller});
  assert.equal(getReadingFirstState(created.controller).calls_used,1);
  const checkpoint=snapshotReadingFirstRuntime(created.controller);
  const receipt=await commitOwnedArtifact({artifactRoot:s.root,dispatchContext:broker.dispatchContext,capability:broker.issueCapability({runId:'presentation-only',actorId:'controller',role:'control',artifactPath:'fresh-checkpoint.json',revision:'1'}),artifact:{artifact_id:'fresh-checkpoint',content:JSON.stringify(checkpoint)},expectedRevision:'1'});
  const recovered=await restoreReadingFirstRuntime({handoff,runControl,checkpointReceipt:receipt});
  assert.equal(recovered.ok,true,JSON.stringify(recovered.errors));assert.equal(recovered.requests.length,1);assert.deepEqual(recovered.requests[0].emittedStep,request.emittedStep);assert.equal(getReadingFirstState(recovered.controller).calls_used,1);
  const complete=async(request,value)=>{
    await mkdir(join(s.root,'fresh-native'),{recursive:true}); await writeFile(join(s.root,request.task.native_path),JSON.stringify(value));
    const step=request.emittedStep;
    return acceptReadingFirstResult({controller:recovered.controller,request,observation:{action_id:step.action_id,run_id:'presentation-only',input_fingerprint:step.input_fingerprint,port:'current-collaboration',tool_call:{name:step.action,arguments:step.arguments},raw_result_text:JSON.stringify({agent_id:'synthetic-editor-'+request.task.task_id})},capability:broker.issueCapability({runId:'presentation-only',actorId:request.task.owner_actor_id,role:request.task.role,artifactPath:request.task.artifact_path,revision:'1'})});
  };
  const editor={schema_version:'reading-editor-1.0',views_fingerprint:fingerprintReadingFirst(['en','zh-CN'].map(language=>handoff.adopted_views.find(item=>item.content.language===language).content)),languages:Object.fromEntries(['en','zh-CN'].map(language=>[language,{overview:[{text:'Main finding',section_ids:['design']}],sections:[],methods:[{id:'design-method',title:'Design method',explanation:'Design explains inference.',application:'Used in this design.',section_ids:['design']}]}]))};
  await complete(recovered.requests[0],editor);
  let rendered=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller:recovered.controller}});
  await complete(createReadingFirstReviewRequest({controller:recovered.controller,presentation:rendered}),{overall:{complete:true,coherent:true,bilingual_consistent:true},key_nodes:[],issues:[{severity:'material',kind:'presentation',detail:'Reading emphasis needs repair'}],scope:'overall'});
  assert.equal(getReadingFirstState(recovered.controller).status,'revision_required');
  await complete(createReadingFirstPresentationRequest({controller:recovered.controller}),editor);
  rendered=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller:recovered.controller}});
  await complete(createReadingFirstReviewRequest({controller:recovered.controller,presentation:rendered}),{overall:{complete:true,coherent:true,bilingual_consistent:true},key_nodes:[{kind:'main_conclusion',location:'source',finding:'supported'},{kind:'key_design',location:'source',finding:'supported'}],issues:[],scope:'local'});
  assert.equal(getReadingFirstState(recovered.controller).calls_used,4);
  assert.equal(getReadingFirstState(recovered.controller).status,'reading_complete');
  const altered={...input,adopted_views:adopted.map(entry=>({...entry,receipt:{...entry.receipt,role:'reading-editor'}}))};
  const forgedControl=createReadingFirstRunControl({runId:'presentation-only',presentationRequired:false,scientificInput:altered,presentationMode:'reading-editor',mainSession:{model:'gpt-6-astra',reasoning_effort:'high'},authorizationId:'synthetic',deadline:'2099-01-01T00:00:00Z',maxCalls:4,taskBindings:tasks});
  const forgedBroker=createOwnedArtifactBroker({control_actor_id:'controller',artifact_root:s.root,authorized_bindings:[],run_controls:[forgedControl]});
  await assert.rejects(()=>buildReadingFirstHandoff({run:{run_id:'presentation-only'},dispatchContext:forgedBroker.dispatchContext,artifactRoot:s.root,scientificInput:altered}),/VIEW_RECEIPT_INVALID/);
});

test('authorized continuation adopts one genuine source-language view and restores only its pending counterpart',async t=>{
  const s=await setup(t);
  const english=s.created.requests.find(request=>request.language==='en');
  const accepted=await s.complete(english,s.view('en'));
  const input={profile:READING_FIRST_PROFILE,identity:{run_id:'continue',paper_id:'synthetic'},context:'Explicitly approved continuation; old window unchanged.',sources:s.handoff.sources,role_artifacts:[],adopted_science:s.handoff.science.map(item=>({artifact_root:s.root,artifact_id:item.receipt.artifact_id,receipt:item.receipt})),adopted_views:[{artifact_root:s.root,artifact_id:accepted.receipt.artifact_id,receipt:accepted.receipt}]};
  const task={task_id:'continue-zh',task_name:'continue_zh',owner_actor_id:'zh',role:'chinese-writer',artifact_id:'continue-zh',artifact_path:'continue/zh.json',native_path:'continue-native/zh.json',revision:'1'};
  const control=createReadingFirstRunControl({runId:'continue',presentationRequired:false,scientificInput:input,presentationMode:'reading-editor',writingMode:'source-first',sourceLanguage:'en',mainSession:{model:'gpt-6-astra',reasoning_effort:'high'},authorizationId:'new-explicit-budget',deadline:'2099-01-01T00:00:00Z',maxCalls:5,taskBindings:{'zh-CN':task}});
  const broker=createOwnedArtifactBroker({control_actor_id:'controller',artifact_root:s.root,authorized_bindings:[{run_id:'continue',actor_id:'controller',role:'control',artifact_path:'continue/checkpoint.json',revision:'1'}],run_controls:[control]});
  const handoff=await buildReadingFirstHandoff({run:{run_id:'continue'},dispatchContext:broker.dispatchContext,artifactRoot:s.root,scientificInput:input});
  const runControl={runId:'continue',artifactRoot:s.root,dispatchContext:broker.dispatchContext};
  const created=createLanguageRequests({handoff,runControl});assert.equal(created.ok,true,JSON.stringify(created.errors));assert.equal(created.requests.length,1);assert.equal(created.requests[0].language,'zh-CN');
  const payload=JSON.parse(created.requests[0].emittedStep.arguments.message.split('\n\n').at(-1));
  assert.deepEqual(payload.source_view,s.view('en'));assert.deepEqual(payload.source_view_receipt,accepted.receipt);
  assert.equal(getReadingFirstState(created.controller).status,'drafting');assert.equal(getReadingFirstState(created.controller).calls_used,1);
  const snapshot=snapshotReadingFirstRuntime(created.controller);
  const receipt=await commitOwnedArtifact({artifactRoot:s.root,dispatchContext:broker.dispatchContext,capability:broker.issueCapability({runId:'continue',actorId:'controller',role:'control',artifactPath:'continue/checkpoint.json',revision:'1'}),artifact:{artifact_id:'continue-checkpoint',content:JSON.stringify(snapshot)},expectedRevision:'1'});
  const restored=await restoreReadingFirstRuntime({handoff,runControl,checkpointReceipt:receipt});assert.equal(restored.ok,true,JSON.stringify(restored.errors));assert.equal(restored.requests.length,1);assert.deepEqual(restored.requests[0].emittedStep,created.requests[0].emittedStep);assert.equal(getReadingFirstState(restored.controller).calls_used,1);
});

for (const issueKind of ['layout', 'presentation']) test(`renderer-only minor ${issueKind} repair uses one local review and restores its pending action`,async t=>{
  const presentation={schema_version:'reading-first-obsidian-1.0',bibliography:{title:'Synthetic study',first_author:'Tester',year:2026},source_pdf:'Raw/source.pdf',sections:[{id:'study',indices:{en:0,'zh-CN':0}}],visuals:[],knowledge:[],map:{steps:[],findings:[],relations:[]}};
  presentation.layout='writer-modules-1.0';
  presentation.modules=['abstract','design','methods','findings','discussion','limitations','conclusion'].map(id=>({id,label:{en:id,'zh-CN':id}}));
  const s=await setup(t,{presentation,presentationMode:'reading-editor'}),controller=s.created.controller;
  const views=['en','zh-CN'].map(language=>({language,sections:presentation.modules.map(module=>({id:module.id,module_id:module.id,heading:module.id,paragraphs:['Design explains the main finding.']})),placements:{visuals:[],knowledge:[]}}));
  for(const request of s.created.requests) await s.complete(request,views.find(view=>view.language===request.language));
  const editor={schema_version:'reading-editor-1.0',views_fingerprint:fingerprintReadingFirst(views),languages:Object.fromEntries(['en','zh-CN'].map(language=>[language,{overview:[{text:'Main finding',section_ids:['design']}],sections:[],methods:[{id:'method',title:'Method',explanation:'Study design.',application:'Used in the study.',section_ids:['design']}]}]))};
  await s.complete(createReadingFirstPresentationRequest({controller}),editor);
  const rendered=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller}});
  const verdict={overall:{complete:true,coherent:true,bilingual_consistent:true},key_nodes:[{kind:'main_conclusion',location:'p1',finding:'supported'},{kind:'key_design',location:'p1',finding:'supported'}],issues:[{severity:'minor',kind:issueKind,detail:'Directory is too deep'}],scope:'overall'};
  await s.complete(createReadingFirstReviewRequest({controller,presentation:rendered}),verdict);
  assert.throws(()=>createReadingFirstReviewRequest({controller,presentation:rendered,renderRepair:true}),/RENDER_REPAIR_UNAVAILABLE/);
  assert.equal(getReadingFirstState(controller).calls_used,4);
  const existingTargets=rendered.notes.map(note=>({path:note.path,bytes:Buffer.from(note.content.replace('## Personal Notes','Reader note.\n\n## Personal Notes')),managedHash:note.managedHash}));
  const changed=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller},targetRegistry:rendered.targetRegistry,existingTargets});
  assert.throws(()=>createReadingFirstReviewRequest({controller,presentation:changed}),/REVIEW_ALREADY_REQUESTED/);
  const local=createReadingFirstReviewRequest({controller,presentation:changed,renderRepair:true});
  assert.equal(local.review_scope,'local');
  const payload=JSON.parse(local.emittedStep.arguments.message.split('\n\n').at(-1));
  assert.equal(payload.issues[0].severity,'minor');assert.match(payload.revision_scope,/Renderer-only/);
  assert.throws(()=>createReadingFirstReviewRequest({controller,presentation:changed,renderRepair:true}),/RENDER_REPAIR_UNAVAILABLE/);
  const checkpoint=snapshotReadingFirstRuntime(controller);
  const receipt=await commitOwnedArtifact({artifactRoot:s.root,dispatchContext:s.broker.dispatchContext,capability:s.broker.issueCapability({runId:'run',actorId:'controller',role:'control',artifactPath:'checkpoint.json',revision:'1'}),artifact:{artifact_id:'checkpoint',content:JSON.stringify(checkpoint)},expectedRevision:'1'});
  const recovered=await restoreReadingFirstRuntime({handoff:s.handoff,runControl:s.runControl,checkpointReceipt:receipt});
  assert.equal(recovered.ok,true,JSON.stringify(recovered.errors));assert.equal(recovered.requests.length,1);assert.deepEqual(recovered.requests[0].emittedStep,local.emittedStep);
  assert.equal(getReadingFirstState(recovered.controller).calls_used,5);assert.equal(getReadingFirstState(recovered.controller).review_rounds,2);
});
