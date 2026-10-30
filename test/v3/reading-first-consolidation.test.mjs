import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadingFirstRunControl } from '../../scripts/v3/reading-first-runtime.mjs';
import { validateRepairScopes, assertEditorRepairScope } from '../../scripts/v3/reading-first-repair-scope.mjs';
import { reviewedReadingFirstFixture } from './helpers/reading-first-publication-source-fixtures.mjs';
import { acceptReadingFirstResult, createReadingFirstPresentationRequest, readingFirstEditorPresentation, getReadingFirstState, snapshotReadingFirstRuntime, restoreReadingFirstRuntime, recordReadingFirstRequestEvent, getReadingFirstRequestEvents, getReadingFirstPendingRequests } from '../../scripts/v3/reading-first-runtime.mjs';
import { commitOwnedArtifact } from '../../scripts/v3/owned-artifact-store.mjs';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readingEditorInstructions } from '../../scripts/v3/reading-first-editor-contract.mjs';
import { buildConfiguredReadingInstructions } from '../../scripts/v3/configured-reading.mjs';
import { dirname } from 'node:path';

const options = { runId:'run', scientificInput:{identity:{run_id:'run'}}, mainSession:{model:'gpt-6-astra',reasoning_effort:'high'}, authorizationId:'synthetic', deadline:'2099-01-01T00:00:00Z', taskBindings:{}, presentationMode:'reading-editor' };

test('new controls freeze the selected editor profile', () => {
  assert.equal(createReadingFirstRunControl(options).reading_first_binding.presentation_profile, 'reading-editor-1.2');
  for (const profile of ['reading-editor-1.0','reading-editor-1.1','reading-editor-1.2','reading-editor-1.3']) {
    assert.equal(createReadingFirstRunControl({...options,presentationProfile:profile}).reading_first_binding.presentation_profile, profile);
  }
  assert.throws(() => createReadingFirstRunControl({...options,presentationProfile:'invalid'}), /READING_FIRST_EDITOR_PROFILE_INVALID/);
});

test('1.3 removes only knowledge content already supplied by the same language view', () => {
  const presentation={knowledge_layout:'shared-bilingual-1.0',knowledge:[{id:'k',paragraphs:{en:['old'], 'zh-CN':['保留']},sections:{en:[{heading:'Keep',paragraphs:['section']}],'zh-CN':[{heading:'保留',paragraphs:['内容']}]}}]};
  const views=[{language:'en',knowledge_content:[{id:'k',paragraphs:['new']}]}];
  const reduced=readingFirstEditorPresentation({presentation,views,profile:'reading-editor-1.3'});
  assert.equal(reduced.knowledge[0].paragraphs.en,undefined);
  assert.deepEqual(reduced.knowledge[0].paragraphs['zh-CN'],['保留']);
  assert.deepEqual(reduced.knowledge[0].sections.en,presentation.knowledge[0].sections.en);
  assert.deepEqual(presentation.knowledge[0].paragraphs.en,['old']);
  assert.deepEqual(readingFirstEditorPresentation({presentation,views,profile:'reading-editor-1.2'}).knowledge[0].paragraphs.en,['new']);
});

test('rejected editor revision survives an owned checkpoint without a new dispatch', async t => {
  const issue={severity:'material',kind:'presentation',detail:'Fix the finding overview.',repair_owner:'editor',repair_scope:{status:'located',section_ids:['findings'],knowledge_ids:[],visual_ids:[],editor_fields:[]}};
  const review={overall:{complete:true,coherent:true,bilingual_consistent:true},key_nodes:[{kind:'main_conclusion',location:'findings',finding:'finding'},{kind:'key_design',location:'design',finding:'design'}],issues:[issue],scope:'overall'};
  const s=await reviewedReadingFirstFixture(t,{controlOptions:{presentationProfile:'reading-editor-1.3'},review});
  const request=createReadingFirstPresentationRequest({controller:s.controller});
  recordReadingFirstRequestEvent({controller:s.controller,request,eventKey:'dispatch',payload:{handle:'synthetic'}});
  const before=snapshotReadingFirstRuntime(s.controller);
  assert.deepEqual(before.state.renderRepairBaseEditor,s.editor);
  assert.ok(before.state.renderRepairBaseEditorReceipt);
  const revised=structuredClone(s.editor); revised.languages.en.methods[0].explanation='Outside the finding scope.';
  const result=await s.complete(request,revised);
  assert.equal(result.status,'completed_with_limits'); assert.equal(result.checkpoint_required,true);
  assert.match(result.rejection.reason,/SCOPE_EXCEEDED/);
  const snapshot=snapshotReadingFirstRuntime(s.controller);
  const receipt=await commitOwnedArtifact({artifactRoot:s.root,dispatchContext:s.broker.dispatchContext,capability:s.broker.issueCapability({runId:s.runId,actorId:'controller',role:'control',artifactPath:'checkpoint.json',revision:'1'}),artifact:{artifact_id:'checkpoint',content:JSON.stringify(snapshot)},expectedRevision:'1'});
  const restored=await restoreReadingFirstRuntime({handoff:s.handoff,runControl:s.runControl,checkpointReceipt:receipt});
  assert.equal(restored.ok,true,JSON.stringify(restored.errors));
  assert.equal(getReadingFirstState(restored.controller).status,'completed_with_limits');
  assert.equal(getReadingFirstState(restored.controller).calls_used,snapshot.state.callsUsed);
  assert.deepEqual(restored.requests,[]);
  assert.throws(()=>createReadingFirstPresentationRequest({controller:restored.controller}),/EDITOR_UNAVAILABLE/);
});

test('an unresolved verifier scope records the real output and ends without repair', async t => {
  const issue={severity:'material',kind:'presentation',detail:'Scope is unknown.',repair_owner:'editor',repair_scope:{status:'unresolved',section_ids:[],knowledge_ids:[],visual_ids:[],editor_fields:[]}};
  const review={overall:{complete:true,coherent:true,bilingual_consistent:true},key_nodes:[],issues:[issue],scope:'overall'};
  const s=await reviewedReadingFirstFixture(t,{controlOptions:{presentationProfile:'reading-editor-1.3'},review});
  const state=getReadingFirstState(s.controller);
  assert.equal(state.status,'completed_with_limits');
  assert.equal(state.rejection.reason,'READING_FIRST_REPAIR_SCOPE_UNRESOLVED');
  assert.equal(state.rejection.receipt.artifact_id,'review');
  assert.ok(state.rejection.sha256);
  assert.throws(()=>createReadingFirstPresentationRequest({controller:s.controller}),/EDITOR_UNAVAILABLE/);
});

test('configured 2.0 material review without repair owner is retained as a limited terminal result', async t => {
  const configured=buildConfiguredReadingInstructions({}, {instructionProfile:'configured-reading-2.0'});
  const issue={severity:'material',kind:'layout',detail:'An ownership decision is missing.',repair_scope:{status:'located',section_ids:['findings'],knowledge_ids:[],visual_ids:[],editor_fields:[]}};
  const review={overall:{complete:true,coherent:true,bilingual_consistent:true},key_nodes:[],issues:[issue],scope:'overall'};
  const s=await reviewedReadingFirstFixture(t,{translationLanguage:null,controlOptions:{presentationProfile:'reading-editor-1.3'},review,createRunControl:args=>createReadingFirstRunControl({...args,configuredSetup:{...configured,paths:{runRoot:dirname(args.scientificInput.sources[0].path)}}})});
  const state=getReadingFirstState(s.controller);
  assert.equal(state.status,'completed_with_limits');
  assert.equal(state.rejection.reason,'READING_FIRST_REPAIR_OWNER_REQUIRED');
  assert.equal(state.rejection.receipt.artifact_id,'review');
  assert.ok(state.rejection.sha256);
  assert.throws(()=>createReadingFirstPresentationRequest({controller:s.controller}),/EDITOR_UNAVAILABLE/);
  const snapshot=snapshotReadingFirstRuntime(s.controller);
  const receipt=await commitOwnedArtifact({artifactRoot:s.root,dispatchContext:s.broker.dispatchContext,capability:s.broker.issueCapability({runId:s.runId,actorId:'controller',role:'control',artifactPath:'checkpoint.json',revision:'1'}),artifact:{artifact_id:'checkpoint',content:JSON.stringify(snapshot)},expectedRevision:'1'});
  const restored=await restoreReadingFirstRuntime({handoff:s.handoff,runControl:s.runControl,checkpointReceipt:receipt});
  assert.equal(restored.ok,true,JSON.stringify(restored.errors));
  assert.equal(getReadingFirstState(restored.controller).rejection.reason,'READING_FIRST_REPAIR_OWNER_REQUIRED');
  assert.deepEqual(getReadingFirstPendingRequests(restored.controller),[]);
});

test('legacy material review without an owner keeps its prior routing', async t => {
  const review={overall:{complete:true,coherent:true,bilingual_consistent:true},key_nodes:[],issues:[{severity:'material',kind:'content',detail:'A correction is required.',affected_languages:['zh-CN']}],scope:'overall'};
  const s=await reviewedReadingFirstFixture(t,{review});
  assert.equal(getReadingFirstState(s.controller).status,'revision_required');
  assert.equal(getReadingFirstState(s.controller).rejection,undefined);
});

test('scope validates actual identifiers and confines editor changes', () => {
  const views=[{sections:[{id:'s1'},{id:'s2'}]}], presentation={knowledge:[{id:'k1'}],visuals:[{id:'v1'}]};
  const scope={status:'located',section_ids:['s1'],knowledge_ids:[],visual_ids:[],editor_fields:[]};
  const review={issues:[{severity:'material',repair_scope:scope}]};
  validateRepairScopes(review, views, presentation);
  assert.throws(()=>validateRepairScopes({issues:[{severity:'material',repair_scope:{...scope,section_ids:['absent']}}]},views,presentation),/SCOPE_INVALID/);
  assert.throws(()=>validateRepairScopes({issues:[{severity:'material',repair_scope:{...scope,status:'unresolved'}}]},views,presentation),/SCOPE_UNRESOLVED/);
  const language={overview:[{text:'x',section_ids:['s1']}],sections:[{section_id:'s1',takeaway:'x'},{section_id:'s2',takeaway:'y'}],methods:[],visuals:[]};
  const base={schema_version:'reading-editor-1.3',views_fingerprint:'a',map:{nodes:[]},languages:{en:structuredClone(language),'zh-CN':structuredClone(language)}};
  const revised=structuredClone(base); revised.views_fingerprint='b'; revised.languages.en.sections[0].takeaway='changed';
  assertEditorRepairScope(base,revised,review);
  revised.languages.en.sections[1].takeaway='outside';
  assert.throws(()=>assertEditorRepairScope(base,revised,review),/SCOPE_EXCEEDED/);
  const reordered=structuredClone(base); reordered.languages.en.sections.reverse();
  assert.throws(()=>assertEditorRepairScope(base,reordered,review),/SCOPE_EXCEEDED/);
  const added=structuredClone(base); added.languages.en.overview.push({text:'new',section_ids:['s1']});
  assert.throws(()=>assertEditorRepairScope(base,added,review),/SCOPE_EXCEEDED/);
  const expanded=structuredClone(base); expanded.languages.en.overview[0].section_ids.push('s2');
  assert.throws(()=>assertEditorRepairScope(base,expanded,review),/SCOPE_EXCEEDED/);
});

test('legacy editor guidance keeps its captured bytes', () => {
  const prompt=readFileSync(new URL('../../prompts/v3/reading-first-contracts.md',import.meta.url),'utf8');
  const section=[...prompt.matchAll(/^## (.+)\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)].find(match=>match[1]==='Reading Editor')[2].trim();
  assert.equal(createHash('sha256').update(readingEditorInstructions(section,'reading-editor-1.2')).digest('hex'),'0a6d5c0b9194d7119ae69ed6b5356975f25512b7901d4a390cdb93a4ddb00523');
});

test('1.2 synthetic editor request matches the pre-change runtime baseline', async t => {
  const s=await reviewedReadingFirstFixture(t,{runId:'run_'+'a'.repeat(32)});
  let message=snapshotReadingFirstRuntime(s.controller).state.request_entries.find(row=>row.key==='presentation').request.emittedStep.arguments.message;
  message=message.replaceAll(JSON.stringify(resolve(s.root)).slice(1,-1),'<ROOT>').replaceAll(resolve(s.root),'<ROOT>').replaceAll(JSON.stringify(s.root).slice(1,-1),'<ROOT>').replaceAll(s.root,'<ROOT>').replace(/"input_fingerprint":"sha256:[a-f0-9]{64}"/g,'"input_fingerprint":"<INPUT>"').replaceAll(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g,'<TIME>');
  assert.equal(createHash('sha256').update(message).digest('hex'),'5684727cf78dafcd06b8197c0706f80aa62500ea1da80e50d0429d40a1191bfd');
});

test('request events and original request bytes survive restoration', async t => {
  const s=await reviewedReadingFirstFixture(t,{completeReview:false});
  const request=s.reviewRequest, message=request.emittedStep.arguments.message;
  recordReadingFirstRequestEvent({controller:s.controller,request,eventKey:'dispatch',payload:{id:'native-1'}});
  assert.throws(()=>recordReadingFirstRequestEvent({controller:s.controller,request,eventKey:'dispatch',payload:{id:'other'}}),/EVENT_CONFLICT/);
  const snapshot=snapshotReadingFirstRuntime(s.controller);
  const receipt=await commitOwnedArtifact({artifactRoot:s.root,dispatchContext:s.broker.dispatchContext,capability:s.broker.issueCapability({runId:s.runId,actorId:'controller',role:'control',artifactPath:'checkpoint.json',revision:'1'}),artifact:{artifact_id:'checkpoint',content:JSON.stringify(snapshot)},expectedRevision:'1'});
  const restored=await restoreReadingFirstRuntime({handoff:s.handoff,runControl:s.runControl,checkpointReceipt:receipt});
  assert.equal(restored.ok,true,JSON.stringify(restored.errors));
  const [pending]=getReadingFirstPendingRequests(restored.controller);
  assert.equal(pending.emittedStep.arguments.message,message);
  assert.deepEqual(getReadingFirstRequestEvents({controller:restored.controller,request:pending}).dispatch.payload,{id:'native-1'});
});

test('an already committed result can be reconciled after a checkpoint failure', async t => {
  const s=await reviewedReadingFirstFixture(t,{completeReview:false});
  const snapshot=snapshotReadingFirstRuntime(s.controller);
  const checkpoint=await commitOwnedArtifact({artifactRoot:s.root,dispatchContext:s.broker.dispatchContext,capability:s.broker.issueCapability({runId:s.runId,actorId:'controller',role:'control',artifactPath:'checkpoint.json',revision:'1'}),artifact:{artifact_id:'checkpoint',content:JSON.stringify(snapshot)},expectedRevision:'1'});
  const first=await s.complete(s.reviewRequest,s.review);
  const restored=await restoreReadingFirstRuntime({handoff:s.handoff,runControl:s.runControl,checkpointReceipt:checkpoint});
  assert.equal(restored.ok,true,JSON.stringify(restored.errors));
  const [request]=getReadingFirstPendingRequests(restored.controller), step=request.emittedStep;
  const result=await acceptReadingFirstResult({controller:restored.controller,request,observation:{action_id:step.action_id,run_id:s.runId,input_fingerprint:step.input_fingerprint,port:'current-collaboration',tool_call:{name:step.action,arguments:step.arguments},raw_result_text:JSON.stringify({agent_id:'synthetic-'+request.task.task_id})}});
  assert.deepEqual(result.receipt,first.receipt);
  assert.equal(result.status,'reading_complete');
});

test('terminal checkpoint callback persists an unresolved review before return', async t => {
  const s=await reviewedReadingFirstFixture(t,{completeReview:false,controlOptions:{presentationProfile:'reading-editor-1.3'}});
  const review={...s.review,issues:[{severity:'material',kind:'presentation',detail:'Unknown location',repair_owner:'editor',repair_scope:{status:'unresolved',section_ids:[],knowledge_ids:[],visual_ids:[],editor_fields:[]}}]};
  const request=s.reviewRequest, step=request.emittedStep;
  await writeFile(join(s.root,request.task.native_path),JSON.stringify(review));
  let checkpoint;
  const result=await acceptReadingFirstResult({controller:s.controller,request,observation:{action_id:step.action_id,run_id:s.runId,input_fingerprint:step.input_fingerprint,port:'current-collaboration',tool_call:{name:step.action,arguments:step.arguments},raw_result_text:JSON.stringify({agent_id:'synthetic-'+request.task.task_id})},capability:s.broker.issueCapability({runId:s.runId,actorId:request.task.owner_actor_id,role:request.task.role,artifactPath:request.task.artifact_path,revision:'1'}),terminalCheckpoint:async snapshot=>{checkpoint=await commitOwnedArtifact({artifactRoot:s.root,dispatchContext:s.broker.dispatchContext,capability:s.broker.issueCapability({runId:s.runId,actorId:'controller',role:'control',artifactPath:'checkpoint.json',revision:'1'}),artifact:{artifact_id:'checkpoint',content:JSON.stringify(snapshot)},expectedRevision:'1'});}});
  assert.equal(result.checkpoint_required,false);
  const restored=await restoreReadingFirstRuntime({handoff:s.handoff,runControl:s.runControl,checkpointReceipt:checkpoint});
  assert.equal(restored.ok,true,JSON.stringify(restored.errors));
  assert.equal(getReadingFirstState(restored.controller).rejection.reason,'READING_FIRST_REPAIR_SCOPE_UNRESOLVED');
  assert.deepEqual(getReadingFirstPendingRequests(restored.controller),[]);
});

test('configured 2.0 uses its already assembled editor section once', async t => {
  const configured=buildConfiguredReadingInstructions({}, {instructionProfile:'configured-reading-2.0'});
  const s=await reviewedReadingFirstFixture(t,{translationLanguage:null,controlOptions:{presentationProfile:'reading-editor-1.3'},createRunControl:args=>createReadingFirstRunControl({...args,configuredSetup:{...configured,paths:{runRoot:dirname(args.scientificInput.sources[0].path)}}})});
  const entry=snapshotReadingFirstRuntime(s.controller).state.request_entries.find(row=>row.key==='presentation');
  const message=entry.request.emittedStep.arguments.message, section=configured.sections['Reading Editor'];
  assert.equal(message.split(section).length-1,1);
  assert.equal(getReadingFirstState(s.controller).status,'reading_complete');
});
