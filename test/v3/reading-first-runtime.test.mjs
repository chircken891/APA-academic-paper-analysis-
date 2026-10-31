import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createOwnedArtifactBroker, commitOwnedArtifact } from '../../scripts/v3/owned-artifact-store.mjs';
import { createPhase21ContractValidator } from '../../scripts/v3/phase21-contract-loader.mjs';
import { buildPreRenderHandoff } from '../../scripts/v3/workflow-composer.mjs';
import { createLanguageRequests } from '../../scripts/v3/phase22-language.mjs';
import { renderReaderNotes } from '../../scripts/v3/phase221-presentation.mjs';
import { getRoleReplyContract, loadRoleReplyContract } from '../../scripts/v3/role-reply-contract.mjs';
import { APA_CONFIGURED_ROLES, createConfiguredApaRoleModelPolicy } from '../../scripts/apa-model-policy.mjs';
import { buildConfiguredReadingInstructions } from '../../scripts/v3/configured-reading.mjs';
import { getConfiguredReadingDispatchArguments } from '../../scripts/v3/configured-reading.mjs';
import * as readingApi from '../../scripts/v3/reading-first-runtime.mjs';
import { COMPACTION_POLICY, compactionControlBindings } from '../../scripts/v3/reading-compaction.mjs';
import { READING_FIRST_PROFILE, SCIENCE_INDEX_PROFILE, fingerprintReadingFirst, resolveReadingWorkflowProfile, acceptReadingFirstResult, createReadingFirstReviewRequest, getReadingFirstState, createReadingFirstRevisionRequests, createReadingFirstRunControl, snapshotReadingFirstRuntime, restoreReadingFirstRuntime, createReadingFirstDraftRequests, createReadingFirstPresentationRequest, createReadingFirstEnrichmentRequests, buildReadingFirstHandoff, observeReadingCompactionBoundary, recordReadingCompactionBoundary } from '../../scripts/v3/reading-first-runtime.mjs';
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const roles = ['evidence','methods','results','interpretation','scientific-reading','integration'];

const compactionObservation = () => ({ manual_compaction: { available: true, method: 'host compact action', source: 'host capability evidence' } });
const dispatchArguments = (s, request) => getConfiguredReadingDispatchArguments({ prepared: { runControl: { run_id: 'run', reading_first_binding: s.binding }, paths: { runRoot: s.root } }, request });
async function compactionCheckpoint(s, controller, id = 'checkpoint') {
  return commitOwnedArtifact({ artifactRoot: s.root, dispatchContext: s.broker.dispatchContext,
    capability: s.broker.issueCapability({ runId: 'run', actorId: 'controller', role: 'control', artifactPath: id + '.json', revision: '1' }),
    artifact: { artifact_id: id, content: JSON.stringify(snapshotReadingFirstRuntime(controller)) }, expectedRevision: '1' });
}
function compactionCapability(s, id, step) {
  const task = s.binding.compaction_policy.checkpoints[id][step];
  return s.broker.issueCapability({ runId: 'run', actorId: 'controller', role: 'control', artifactPath: task.artifact_path, revision: task.revision });
}

for (const profile of ['boundary-reminders-1.0', 'boundary-reminders-1.1']) test(`a bound ${profile} runtime preserves the unavailable decision checkpoint bytes across restore`, async t => {
  const s = await setup(t, { compactionPolicy: profile });
  const { controller, requests } = s.created;
  assert.equal(s.binding.compaction_policy.profile, profile);
  assert.equal(s.binding.compaction_policy.manual_compaction, undefined);
  const checkpoint = await compactionCheckpoint(s, controller);
  const hostRequests = requests.map(request => ({ action_id: request.emittedStep.action_id, status: 'prepared' }));
  const first = await readingApi.handleReadingCompactionBoundary({ controller, checkpointReceipt: checkpoint, hostRequests,
    capability: compactionCapability(s, 'before-writer', 'decision') });
  assert.equal(first.action, 'continue'); assert.equal(first.record.reason, 'manual-compaction-unavailable');
  const path = join(s.root, s.binding.compaction_policy.checkpoints['before-writer'].decision.artifact_path);
  const bytes = await readFile(path);
  const restored = await restoreReadingFirstRuntime({ handoff: s.handoff, runControl: s.runControl, checkpointReceipt: first.receipt });
  assert.equal(restored.ok, true, JSON.stringify(restored.errors));
  const repeated = await readingApi.handleReadingCompactionBoundary({ controller: restored.controller, checkpointReceipt: first.receipt, hostRequests });
  assert.equal(repeated.action, 'continue'); assert.equal(repeated.record, null);
  assert.deepEqual(await readFile(path), bytes);
  assert.doesNotThrow(() => dispatchArguments(s, restored.requests[0]));
});

test('new reading runtime requires the Writer decision and preserves pending actions through pause and resume', async t => {
  const s = await setup(t, { compactionPolicy: COMPACTION_POLICY });
  const { controller, requests } = s.created;
  assert.throws(() => dispatchArguments(s, requests[0]), /APA_COMPACTION_BOUNDARY_REQUIRED/);
  const saved = await compactionCheckpoint(s, controller);
  const hostRequests = requests.map(request => ({ action_id: request.emittedStep.action_id, status: 'prepared' }));
  const pause = await readingApi.handleReadingCompactionBoundary({ controller, checkpointReceipt: saved, hostRequests,
    observation: compactionObservation(), capability: compactionCapability(s, 'before-writer', 'decision') });
  assert.equal(pause.action, 'await-user');
  assert.match(pause.message, /用量未知/);
  assert.throws(() => dispatchArguments(s, requests[0]), /APA_COMPACTION_AWAITING_USER/);
  const recovered = await restoreReadingFirstRuntime({ handoff: s.handoff, runControl: s.runControl, checkpointReceipt: pause.receipt });
  assert.equal(recovered.ok, true, JSON.stringify(recovered.errors));
  assert.deepEqual(recovered.requests.map(request => request.emittedStep.action_id), requests.map(request => request.emittedStep.action_id));
  assert.throws(() => dispatchArguments(s, recovered.requests[0]), /APA_COMPACTION_AWAITING_USER/);
  const waiting = await readingApi.handleReadingCompactionBoundary({ controller: recovered.controller, checkpointReceipt: pause.receipt, hostRequests });
  assert.equal(waiting.action, 'await-user');
  const continued = await readingApi.handleReadingCompactionBoundary({ controller: recovered.controller, checkpointReceipt: pause.receipt, hostRequests,
    userDecision: 'continue', capability: compactionCapability(s, 'before-writer', 'resume') });
  assert.equal(continued.action, 'continue');
  assert.equal(continued.record.compaction_verified, false);
  assert.deepEqual(dispatchArguments(s, recovered.requests[0]), requests[0].emittedStep.arguments);
  assert.equal(getReadingFirstState(recovered.controller).calls_used, getReadingFirstState(controller).calls_used);
  const oldBoundary = await observeReadingCompactionBoundary({ controller: recovered.controller, checkpointReceipt: continued.receipt, hostRequests });
  await assert.rejects(() => recordReadingCompactionBoundary({ controller: recovered.controller, boundary: oldBoundary, status: 'prompted', reason: 'bypass' }), /APA_COMPACTION_POLICY_DECISION_REQUIRED/);
});

test('new reading runtime gates the rendered review, permits unknown-context skip and keeps the same review action', async t => {
  const s = await setup(t, { compactionPolicy: COMPACTION_POLICY });
  const { controller, requests } = s.created;
  assert.throws(() => dispatchArguments(s, requests[0]), /APA_COMPACTION_BOUNDARY_REQUIRED/);
  const saved = await compactionCheckpoint(s, controller);
  const writerRequests = requests.map(request => ({ action_id: request.emittedStep.action_id, status: 'prepared' }));
  const writerPause = await readingApi.handleReadingCompactionBoundary({ controller, checkpointReceipt: saved,
    hostRequests: writerRequests,
    observation: {}, capability: compactionCapability(s, 'before-writer', 'decision') });
  assert.equal(writerPause.action, 'await-user');
  assert.throws(() => dispatchArguments(s, requests[0]), /APA_COMPACTION_AWAITING_USER/);
  await readingApi.handleReadingCompactionBoundary({ controller, checkpointReceipt: writerPause.receipt, hostRequests: writerRequests,
    userDecision: 'skip', capability: compactionCapability(s, 'before-writer', 'resume') });
  for (const request of requests) await s.complete(request, s.view(request.language));
  const presentation = await renderReaderNotes({ input: { profile: READING_FIRST_PROFILE, controller } });
  const review = createReadingFirstReviewRequest({ controller, presentation });
  assert.throws(() => dispatchArguments(s, review), /APA_COMPACTION_BOUNDARY_REQUIRED/);
  const receipt = await compactionCheckpoint(s, controller, 'checkpoint-before-review');
  for (const status of ['running', 'unknown']) {
    const result = await readingApi.handleReadingCompactionBoundary({ controller, checkpointReceipt: receipt, presentation,
      hostRequests: [{ action_id: review.emittedStep.action_id, status }], observation: compactionObservation() });
    assert.equal(result.action, 'reconcile');
  }
  const result = await readingApi.handleReadingCompactionBoundary({ controller, checkpointReceipt: receipt, presentation,
    hostRequests: [{ action_id: review.emittedStep.action_id, status: 'prepared' }], observation: compactionObservation(),
    capability: compactionCapability(s, 'before-review', 'decision') });
  assert.equal(result.action, 'await-user');
  assert.throws(() => dispatchArguments(s, review), /APA_COMPACTION_AWAITING_USER/);
  const continued = await readingApi.handleReadingCompactionBoundary({ controller, checkpointReceipt: result.receipt, presentation,
    hostRequests: [{ action_id: review.emittedStep.action_id, status: 'prepared' }], userDecision: 'skip',
    capability: compactionCapability(s, 'before-review', 'resume') });
  assert.equal(continued.action, 'continue');
  assert.deepEqual(dispatchArguments(s, review), review.emittedStep.arguments);
  const restored = await restoreReadingFirstRuntime({ handoff: s.handoff, runControl: s.runControl, checkpointReceipt: continued.receipt });
  assert.equal(restored.ok, true);
  assert.deepEqual(restored.requests.map(request => request.emittedStep.action_id), [review.emittedStep.action_id]);
  assert.deepEqual(dispatchArguments(s, restored.requests[0]), review.emittedStep.arguments);
});

test('a prompted review resumes the same request after process recovery and observed compaction', async t => {
  const s = await setup(t, { compactionPolicy: COMPACTION_POLICY });
  const { controller, requests } = s.created;
  const saved = await compactionCheckpoint(s, controller);
  const writerRequests = requests.map(request => ({ action_id: request.emittedStep.action_id, status: 'prepared' }));
  const writerPause = await readingApi.handleReadingCompactionBoundary({ controller, checkpointReceipt: saved,
    hostRequests: writerRequests,
    capability: compactionCapability(s, 'before-writer', 'decision') });
  assert.equal(writerPause.action, 'await-user');
  assert.throws(() => dispatchArguments(s, requests[0]), /APA_COMPACTION_AWAITING_USER/);
  await readingApi.handleReadingCompactionBoundary({ controller, checkpointReceipt: writerPause.receipt, hostRequests: writerRequests,
    userDecision: 'skip', capability: compactionCapability(s, 'before-writer', 'resume') });
  for (const request of requests) await s.complete(request, s.view(request.language));
  const presentation = await renderReaderNotes({ input: { profile: READING_FIRST_PROFILE, controller } });
  const review = createReadingFirstReviewRequest({ controller, presentation });
  const receipt = await compactionCheckpoint(s, controller, 'checkpoint-before-review');
  const hostRequests = [{ action_id: review.emittedStep.action_id, status: 'prepared' }];
  const at = new Date().toISOString();
  const pause = await readingApi.handleReadingCompactionBoundary({ controller, checkpointReceipt: receipt, presentation, hostRequests, sessionId: 'main',
    observation: { ...compactionObservation(), session_id: 'main', observed_at: at,
      context: { tokens: 180000, kind: 'last-request-input', measured_at: at, fresh: true, source: 'host usage' } },
    progress: { remaining_work: { multiple_responses: true, reason: 'Review and possible repair remain.' }, growth: { substantial: true, reason: 'Bilingual candidate expanded context.' } },
    capability: compactionCapability(s, 'before-review', 'decision') });
  assert.equal(pause.action, 'await-user');
  const restored = await restoreReadingFirstRuntime({ handoff: s.handoff, runControl: s.runControl, checkpointReceipt: pause.receipt });
  assert.equal(restored.ok, true, JSON.stringify(restored.errors));
  const recoveredPresentation = await renderReaderNotes({ input: { profile: READING_FIRST_PROFILE, controller: restored.controller } });
  const observedAt = new Date().toISOString();
  const resumed = await readingApi.handleReadingCompactionBoundary({ controller: restored.controller, checkpointReceipt: pause.receipt,
    presentation: recoveredPresentation, hostRequests, sessionId: 'main', userDecision: 'continue',
    observation: { session_id: 'main', observed_at: observedAt, last_compaction: { id: 'host-event', session_id: 'main', status: 'succeeded', occurred_at: observedAt, source: 'host event log' } },
    capability: compactionCapability(s, 'before-review', 'resume') });
  assert.equal(resumed.record.status, 'completed');
  assert.deepEqual(dispatchArguments(s, restored.requests[0]), review.emittedStep.arguments);
  assert.deepEqual(snapshotReadingFirstRuntime(restored.controller).state.requestLog, snapshotReadingFirstRuntime(controller).state.requestLog);
});

test('a failed reading reminder save cannot expose a prompt or leave dispatch unlocked', async t => {
  const s = await setup(t, { compactionPolicy: COMPACTION_POLICY });
  const { controller, requests } = s.created;
  assert.throws(() => dispatchArguments(s, requests[0]), /APA_COMPACTION_BOUNDARY_REQUIRED/);
  const saved = await compactionCheckpoint(s, controller);
  await assert.rejects(() => readingApi.handleReadingCompactionBoundary({ controller, checkpointReceipt: saved,
    hostRequests: requests.map(request => ({ action_id: request.emittedStep.action_id, status: 'prepared' })),
    observation: compactionObservation(), capability: {} }));
  assert.throws(() => dispatchArguments(s, requests[0]), /COMPACTION_RESTORE_REQUIRED/);
  const restored = await restoreReadingFirstRuntime({ handoff: s.handoff, runControl: s.runControl, checkpointReceipt: saved });
  assert.equal(restored.ok, true);
  assert.throws(() => dispatchArguments(s, restored.requests[0]), /APA_COMPACTION_BOUNDARY_REQUIRED/);
});

async function setup(t, { instructionProfile = 'configured-reading-1.0', presentation, presentationRequired = false, writingMode = 'independent', sourceLanguage = 'en', presentationMode = 'writer', priorCalls = 0, maxTotalCalls, roleReplyContract, enrichmentPolicy, handoffProfile, legacyPresentationProfile, legacyRepairRouting = false, invalidRepairRouting = false, maxCalls = presentationMode==='reading-editor'?7:6, firstWritingLanguage, integrationContent = {}, writingSkills = {}, compactionPolicy } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'reading-first-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  const sourceBytes=Buffer.from('Synthetic original source: design, result and limitation.');
  await writeFile(join(root,'source.pdf'),sourceBytes);
  const tasks=Object.fromEntries(['en','zh-CN','review','en-r2','zh-CN-r2','review-r2',...(presentationMode==='reading-editor'?['presentation','presentation-r2']:[])].map(key=>[key,{task_id:key,task_name:'reading_'+key.replaceAll('-','_').toLowerCase(),owner_actor_id:key,role:key.startsWith('presentation')?'reading-editor':writingMode==='source-translation'&&!key.startsWith('review')&&!key.startsWith(sourceLanguage.slice(0,2))?'translation':key.startsWith('en')?'english-writer':key.startsWith('zh')?'chinese-writer':'independent-verifier',artifact_id:key,artifact_path:key+'.json',native_path:'native/'+key+'.json',revision:'1'}]));
  if(enrichmentPolicy) tasks['enrich-late-evidence']={task_id:'enrich-late-evidence',task_name:'enrich_late_evidence',owner_actor_id:'enrich-late-evidence',role:'evidence',source_root:'sources/enrich-late-evidence',artifact_id:'enrich-late-evidence',artifact_path:'enrich-late-evidence.json',native_path:'native/enrich-late-evidence.json',revision:'1'};
  const bindings=[...roles.map(role=>({run_id:'run',actor_id:role,role,artifact_path:'science/'+role+'.json',revision:'1'})),...Object.values(tasks).map(task=>({run_id:'run',actor_id:task.owner_actor_id,role:task.role,artifact_path:task.artifact_path,revision:task.revision}))];
  const input={identity:{paper_id:presentation ? 'pap_'+'a'.repeat(32) : 'synthetic',run_id:'run'},sources:[{...(enrichmentPolicy ? {id:'main'} : {}),path:join(root,'source.pdf'),sha256:sha(sourceBytes),byte_length:sourceBytes.length}],context:'Read all existing material as a connected account.',role_artifacts:roles};
  // source-translation takes its writing rules only from a configured setup, so those runs use a configured fixture with all eleven roles.
  const configuredSetup=writingMode==='source-translation' ? {schema_version:'apa-configured-reading-1.0',config_fingerprint:sha(Buffer.from('config')),paths:{runRoot:root},
    role_model_policy:createConfiguredApaRoleModelPolicy({model:'gpt-6-astra',reasoning_effort:'high'},Object.fromEntries(APA_CONFIGURED_ROLES.map(role=>[role,{model:'gpt-6-astra',reasoning_effort:'high'}]))),...buildConfiguredReadingInstructions(writingSkills,{instructionProfile})} : undefined;
  const runBinding=createReadingFirstRunControl({configuredSetup,presentationMode,writingMode,sourceLanguage,firstWritingLanguage,presentationRequired,priorCalls,maxTotalCalls,roleReplyContract,enrichmentPolicy,handoffProfile,compactionPolicy,runId:'run',scientificInput:input,mainSession:{model:'gpt-6-astra',reasoning_effort:'high'},authorizationId:'synthetic-only',maxCalls,deadline:'2099-01-01T00:00:00Z',taskBindings:tasks});
  const binding=structuredClone(runBinding.reading_first_binding);
  if (legacyPresentationProfile) {
    if (legacyPresentationProfile === 'reading-editor-1.0') delete binding.presentation_profile;
    else binding.presentation_profile = legacyPresentationProfile;
    delete binding.presentation_contract;
  }
  if (legacyRepairRouting) delete binding.repair_routing;
  if (invalidRepairRouting) binding.repair_routing='unknown-routing';
  bindings.push({run_id:'run',actor_id:'controller',role:'control',artifact_path:'checkpoint.json',revision:'1'});
  bindings.push({run_id:'run',actor_id:'controller',role:'control',artifact_path:'checkpoint-compaction.json',revision:'1'});
  bindings.push(...compactionControlBindings(runBinding));
  bindings.push({run_id:'run',actor_id:'controller',role:'control',artifact_path:'checkpoint-before-review.json',revision:'1'});
  const fingerprints=Object.fromEntries(['source','parser_tool','permission','parent_revision','policy','authorization'].map(key=>[key,sha(Buffer.from(key))]));
  const required=roles.map(role=>({artifact_id:role,owner_actor_id:role,path:'science/'+role+'.json'}));
  // Legacy delivery slots remain unfulfilled; scientific storage is not legacy delivery.
  const integration={source_check_artifact_id:'unused-source-check',analysis_draft_artifact_id:'unused-frozen-draft',integration_artifact_id:'integration',approval_artifact_id:'unused-approval'};
  const broker=createOwnedArtifactBroker({control_actor_id:'controller',artifact_root:root,authorized_bindings:bindings,run_controls:[{run_id:'run',reading_first_binding:binding,approved_fingerprints:fingerprints,required_artifacts:required,integration_prerequisites:integration}]});
  const schema=JSON.parse(await readFile(new URL('../../Schema/phase21/proof-chain.schema.json',import.meta.url),'utf8'));
  const phase21Validator=await createPhase21ContractValidator({schemas:[schema]});
  const scienceRun={run_id:'run',workflow_profile:READING_FIRST_PROFILE,artifact_root:root,phase21Validator,declared_fingerprints:fingerprints,current_fingerprints:fingerprints,route_fingerprint:'fixed',chain:{schema_version:'phase21-proof-chain-1.0',run_id:'run',delivery_status:'pending_resolver',artifacts:[],dependencies:[],required_artifacts:required,integration_prerequisites:integration,metadata:{requirement_refs:['APA3-04']},p20_e12_status:'unverified'}};
  const scienceResult=await runFiniteRoleSequence({run:scienceRun,dispatchContext:broker.dispatchContext,artifactStore:broker,actions:roles.map(role=>({role,action:{type:'write_artifact',actor_id:role,role,artifact_path:'science/'+role+'.json',revision:'1',artifact:{artifact_id:role,content:JSON.stringify({context:'Full connected science for '+role,...(role==='integration' && presentation ? {presentation} : {}),...(role==='integration' ? integrationContent : {})})}}}))});
  assert.notEqual(scienceResult.status,'blocked',JSON.stringify(scienceResult.delivery_gate));
  assert.equal(scienceResult.receipts.length,6);
  assert.equal(scienceResult.chain.source_check,undefined);
  const handoff=await buildPreRenderHandoff({run:{run_id:'run',workflow_profile:READING_FIRST_PROFILE},dispatchContext:broker.dispatchContext,artifactRoot:root,scientificInput:input});
  const runControl={runId:'run',artifactRoot:root,dispatchContext:broker.dispatchContext};
  const created=instructionProfile==='configured-reading-2.2' ? readingApi.createReadingFirstRequests({handoff,runControl,executionLedger:[]}) : createLanguageRequests({handoff,runControl});
  assert.equal(created.ok,true,JSON.stringify(created.errors));
  const complete=async(request,value)=>{
    await mkdir(join(root,'native'),{recursive:true});
    await writeFile(join(root,request.task.native_path),JSON.stringify(value));
    const step=request.emittedStep;
    return acceptReadingFirstResult({controller:created.controller,request,observation:{action_id:step.action_id,run_id:'run',input_fingerprint:step.input_fingerprint,port:'current-collaboration',tool_call:{name:step.action,arguments:step.arguments},raw_result_text:JSON.stringify({agent_id:'synthetic-'+request.task.task_id})},capability:broker.issueCapability({runId:'run',actorId:request.task.owner_actor_id,role:request.task.role,artifactPath:request.task.artifact_path,revision:request.task.revision})});
  };
  const view=language=>({language,sections:[{heading:language==='en'?'Study':'研究',paragraphs:[language==='en'?'The study design produced the main finding; its limitation bounds the conclusion.':'研究设计产生主要发现，研究限制界定结论。']} ]});
  return {root,broker,handoff,created,complete,view,runControl,binding};
}
test('new runs default to reading first while existing legacy binding is preserved',()=>{
  assert.equal(resolveReadingWorkflowProfile({newRun:true}),READING_FIRST_PROFILE);
  assert.equal(resolveReadingWorkflowProfile({existingBinding:{}}),'legacy');
  assert.equal(resolveReadingWorkflowProfile({existingBinding:{profile:READING_FIRST_PROFILE}}),READING_FIRST_PROFILE);
});

test('handoff profile is frozen only when requested and rejects unknown values',async t=>{
  const root=await mkdtemp(join(tmpdir(),'reading-first-profile-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const bytes=Buffer.from('Synthetic original source.');
  await writeFile(join(root,'source.pdf'),bytes);
  const options={runId:'run',scientificInput:{identity:{paper_id:'synthetic',run_id:'run'},sources:[{path:join(root,'source.pdf'),sha256:sha(bytes),byte_length:bytes.length}],context:'Read all existing material as a connected account.',role_artifacts:roles},mainSession:{model:'gpt-6-astra',reasoning_effort:'high'},authorizationId:'synthetic-only',deadline:'2099-01-01T00:00:00Z',taskBindings:{}};
  assert.equal(SCIENCE_INDEX_PROFILE,'science-index-1.0');
  assert.equal(Object.hasOwn(createReadingFirstRunControl(options).reading_first_binding,'handoff_profile'),false);
  assert.equal(createReadingFirstRunControl({...options,handoffProfile:SCIENCE_INDEX_PROFILE}).reading_first_binding.handoff_profile,'science-index-1.0');
  assert.throws(()=>createReadingFirstRunControl({...options,handoffProfile:'other'}),/READING_FIRST_HANDOFF_PROFILE_INVALID/);
});

// Paths and the fingerprints derived from them differ per machine and temp root, and the writing guide is a separate document, so request bytes are compared after masking them.
const maskPaths = (value, ...roots) => {
  let masked = value;
  for (const [root, label] of roots) masked = masked.replaceAll(root.replaceAll('\\', '\\\\'), label).replaceAll(root, label);
  return masked.replaceAll('\\\\', '/').replaceAll('\\', '/').replace(/"(input_fingerprint|handoff_fingerprint)":"sha256:[0-9a-f]{64}"/g, '"$1":"<ROOT-DERIVED>"').replace(/\{"writing_guide":\{[^}]*\}\}/, '<WRITING-GUIDE>');
};
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]$/, '');
function maskedRequest(s, request) {
  const message = maskPaths(request.emittedStep.arguments.message, [s.root, '<ROOT>'], [repositoryRoot, '<REPO>']);
  const { input, writing_guide, ...configuration } = JSON.parse(maskPaths(JSON.stringify(request.packet.backend.configuration), [s.root, '<ROOT>'], [repositoryRoot, '<REPO>']));
  return { instruction_fingerprint: sha(Buffer.from(message)), configuration_fingerprint: fingerprintReadingFirst(configuration), message };
}
// Fingerprints of the masked en Writer request, captured from the code before science-index-1.0 existed (2026-10-28).
const LEGACY_EN_WRITER = {
  instruction_fingerprint: 'sha256:f54d7e9a82646f82c43d8782f35219ff1bcd2969d60028e520223e096c96107a',
  configuration_fingerprint: 'sha256:260d65b2be453ff03476f6856289755115a74223cffc463f1c34771fbeb115aa',
};
const requestPayload = request => JSON.parse(request.emittedStep.arguments.message.split('\n\n').at(-1));
const INDEXED_ROLES = ['evidence', 'methods', 'results', 'interpretation', 'scientific-reading'];
test('editor 1.2 guidance is bound separately while old editor profiles retain their prompt and restore', async t => {
  for (const profile of ['reading-editor-1.0', 'reading-editor-1.1', 'reading-editor-1.2']) {
    const s = await setup(t, { presentationMode: 'reading-editor', ...(profile === 'reading-editor-1.2' ? {} : { legacyPresentationProfile: profile }) });
    for (const request of s.created.requests) await s.complete(request, s.view(request.language));
    const request = createReadingFirstPresentationRequest({ controller: s.created.controller });
    assert.equal(requestPayload(request).output_schema, profile);
    if (profile === 'reading-editor-1.2') {
      assert.match(request.emittedStep.arguments.message, /Include every registered step exactly once/);
      assert.doesNotMatch(request.emittedStep.arguments.message, /roughly twelve nodes/);
    } else assert.match(request.emittedStep.arguments.message, /roughly twelve nodes/);
    const receipt = await commitOwnedArtifact({ artifactRoot: s.root, dispatchContext: s.broker.dispatchContext,
      capability: s.broker.issueCapability({ runId: 'run', actorId: 'controller', role: 'control', artifactPath: 'checkpoint.json', revision: '1' }),
      artifact: { artifact_id: 'checkpoint', content: JSON.stringify(snapshotReadingFirstRuntime(s.created.controller)) }, expectedRevision: '1' });
    const recovered = await restoreReadingFirstRuntime({ handoff: s.handoff, runControl: s.runControl, checkpointReceipt: receipt });
    assert.equal(recovered.ok, true);
    assert.deepEqual(recovered.requests[0].emittedStep, request.emittedStep);
  }
});
test('legacy bindings keep identical writer requests after masking machine-dependent fields', async t => {
  const s = await setup(t);
  const request = s.created.requests.find(item => item.language === 'en');
  const { instruction_fingerprint, configuration_fingerprint, message } = maskedRequest(s, request);
  assert.equal(instruction_fingerprint, LEGACY_EN_WRITER.instruction_fingerprint);
  assert.equal(configuration_fingerprint, LEGACY_EN_WRITER.configuration_fingerprint);
  assert.doesNotMatch(message, /science-index-1\.0|science_index/);
  const payload = requestPayload(request);
  assert.equal(payload.handoff.science.length, 6);
  assert.equal(Object.hasOwn(payload.handoff, 'science_index'), false);
  assert.equal(Object.hasOwn(request.packet.backend.configuration, 'science_index'), false);
});
test('science index handoff inlines only Integrator and indexes other roles by receipt', async t => {
  const presentation = { layout: 'writer-modules-1.0', modules: [] };
  const s = await setup(t, { handoffProfile: SCIENCE_INDEX_PROFILE, presentation });
  const note = await readFile(new URL('../../prompts/v3/science-index-1.0.md', import.meta.url));
  assert.equal(s.created.requests.length, 2);
  for (const request of s.created.requests) {
    const { handoff } = requestPayload(request);
    assert.equal(handoff.science.length, 1);
    assert.equal(handoff.science[0].receipt.role, 'integration');
    assert.equal(handoff.science[0].content.presentation, undefined);
    assert.deepEqual(handoff.presentation, presentation);
    assert.match(handoff.science[0].content.context, /Full connected science for integration/);
    assert.deepEqual(handoff.science_index.map(item => item.role), INDEXED_ROLES);
    for (const item of handoff.science_index) {
      const receipt = s.handoff.science.find(entry => entry.receipt.role === item.role).receipt;
      assert.deepEqual(item, { role: item.role, path: join(s.root, receipt.path), sha256: receipt.sha256, byte_length: receipt.byte_length });
      assert.equal(sha(await readFile(item.path)), item.sha256);
    }
    assert.equal(handoff.handoff_fingerprint, s.handoff.handoff_fingerprint);
    assert.match(request.emittedStep.arguments.message, /Science index handoff: science-index-1\.0/);
    assert.deepEqual(request.packet.backend.configuration.science_index, { profile: 'science-index-1.0', sha256: sha(note), byte_length: note.length });
  }
});
test('adopted science entries are indexed under their own artifact root', async t => {
  const s = await setup(t);
  const otherRoot = await mkdtemp(join(tmpdir(), 'reading-first-adopt-'));
  t.after(() => rm(otherRoot, { recursive: true, force: true }));
  const input = { profile: READING_FIRST_PROFILE, identity: { run_id: 'adopt-index', paper_id: 'synthetic' }, context: 'Reuse saved science', sources: s.handoff.sources, role_artifacts: [],
    adopted_science: s.handoff.science.map(item => ({ artifact_root: s.root, artifact_id: item.receipt.artifact_id, receipt: item.receipt })) };
  const tasks = Object.fromEntries(['en', 'zh-CN'].map(key => [key, { task_id: key, task_name: 'adopt_' + key.replaceAll('-', '_').toLowerCase(), owner_actor_id: key, role: key === 'en' ? 'english-writer' : 'chinese-writer', artifact_id: key, artifact_path: 'fresh/' + key + '.json', native_path: 'fresh-native/' + key + '.json', revision: '1' }]));
  const control = createReadingFirstRunControl({ runId: 'adopt-index', presentationRequired: false, scientificInput: input, mainSession: { model: 'gpt-6-astra', reasoning_effort: 'high' }, authorizationId: 'synthetic', deadline: '2099-01-01T00:00:00Z', taskBindings: tasks, handoffProfile: SCIENCE_INDEX_PROFILE });
  const broker = createOwnedArtifactBroker({ control_actor_id: 'controller', artifact_root: otherRoot, authorized_bindings: [], run_controls: [control] });
  const handoff = await buildReadingFirstHandoff({ run: { run_id: 'adopt-index' }, dispatchContext: broker.dispatchContext, artifactRoot: otherRoot, scientificInput: input });
  const created = createLanguageRequests({ handoff, runControl: { runId: 'adopt-index', artifactRoot: otherRoot, dispatchContext: broker.dispatchContext } });
  assert.equal(created.ok, true, JSON.stringify(created.errors));
  const payload = requestPayload(created.requests[0]);
  assert.deepEqual(payload.handoff.science_index.map(item => item.role), INDEXED_ROLES);
  for (const item of payload.handoff.science_index) {
    const receipt = s.handoff.science.find(entry => entry.receipt.role === item.role).receipt;
    assert.equal(item.path, join(s.root, receipt.path));
    assert.notEqual(item.path, join(otherRoot, receipt.path));
  }
  assert.equal(payload.handoff.science[0].receipt.role, 'integration');
});
test('revision requests use the same reduced handoff', async t => {
  const s = await setup(t, { handoffProfile: SCIENCE_INDEX_PROFILE });
  for (const request of s.created.requests) await s.complete(request, s.view(request.language));
  const rendered = await renderReaderNotes({ input: { profile: READING_FIRST_PROFILE, controller: s.created.controller } });
  const review = { overall: { complete: false, coherent: true, bilingual_consistent: true }, key_nodes: [], issues: [{ severity: 'material', kind: 'omission', detail: 'Important limitation missing', affected_languages: ['en'] }], scope: 'whole account' };
  await s.complete(createReadingFirstReviewRequest({ controller: s.created.controller, presentation: rendered }), review);
  const [revision] = createReadingFirstRevisionRequests({ controller: s.created.controller });
  assert.equal(revision.task.task_id, 'en-r2');
  const { handoff } = requestPayload(revision);
  assert.equal(handoff.science.length, 1);
  assert.equal(handoff.science[0].receipt.role, 'integration');
  assert.equal(handoff.science[0].content.presentation, undefined);
  assert.deepEqual(handoff.science_index.map(item => item.role), INDEXED_ROLES);
  assert.match(revision.emittedStep.arguments.message, /Science index handoff: science-index-1\.0/);
});

// Simulates an edit of the note by wrapping the file read; the repository file itself is never touched.
function changeScienceIndexNote(t) {
  const original = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (path, ...rest) {
    const bytes = original.call(this, path, ...rest);
    return String(path?.href ?? path).endsWith('science-index-1.0.md') ? Buffer.concat([Buffer.from(bytes), Buffer.from('\nChanged.')]) : bytes;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}
test('changed science index note fails the next request, and legacy bindings ignore the note', async t => {
  const s = await setup(t, { handoffProfile: SCIENCE_INDEX_PROFILE });
  for (const request of s.created.requests) await s.complete(request, s.view(request.language));
  const rendered = await renderReaderNotes({ input: { profile: READING_FIRST_PROFILE, controller: s.created.controller } });
  const legacy = await setup(t);
  changeScienceIndexNote(t);
  assert.throws(() => createReadingFirstReviewRequest({ controller: s.created.controller, presentation: rendered }), /READING_FIRST_SCIENCE_INDEX_NOTE_CHANGED/);
  assert.throws(() => snapshotReadingFirstRuntime(s.created.controller), /READING_FIRST_SCIENCE_INDEX_NOTE_CHANGED/);
  assert.doesNotThrow(() => snapshotReadingFirstRuntime(legacy.created.controller));
});
test('restored science index state keeps the captured note and detects a later change', async t => {
  const s = await setup(t, { handoffProfile: SCIENCE_INDEX_PROFILE });
  const saved = snapshotReadingFirstRuntime(s.created.controller);
  assert.equal(saved.state.scienceIndexNote.profile, 'science-index-1.0');
  const receipt = await commitOwnedArtifact({ artifactRoot: s.root, dispatchContext: s.broker.dispatchContext,
    capability: s.broker.issueCapability({ runId: 'run', actorId: 'controller', role: 'control', artifactPath: 'checkpoint.json', revision: '1' }),
    artifact: { artifact_id: 'checkpoint', content: JSON.stringify(saved) }, expectedRevision: '1' });
  const recovered = await restoreReadingFirstRuntime({ handoff: s.handoff, runControl: s.runControl, checkpointReceipt: receipt });
  assert.equal(recovered.ok, true, JSON.stringify(recovered.errors));
  assert.deepEqual(snapshotReadingFirstRuntime(recovered.controller).state.scienceIndexNote, saved.state.scienceIndexNote);
  changeScienceIndexNote(t);
  assert.throws(() => snapshotReadingFirstRuntime(recovered.controller), /READING_FIRST_SCIENCE_INDEX_NOTE_CHANGED/);
});
for (const enabled of [false, true]) test(`${enabled ? 'new' : 'legacy'} reply binding restores pending actions and preserves future requests, counts and deadline`, async t => {
  const roleReplyContract = enabled ? getRoleReplyContract() : undefined;
  const rule = loadRoleReplyContract(getRoleReplyContract());
  const s = await setup(t, { writingMode: 'source-first', priorCalls: 6, maxTotalCalls: 12, roleReplyContract });
  const [pending] = s.created.requests;
  const saved = snapshotReadingFirstRuntime(s.created.controller);
  const receipt = await commitOwnedArtifact({ artifactRoot: s.root, dispatchContext: s.broker.dispatchContext,
    capability: s.broker.issueCapability({ runId: 'run', actorId: 'controller', role: 'control', artifactPath: 'checkpoint.json', revision: '1' }),
    artifact: { artifact_id: 'checkpoint', content: JSON.stringify(saved) }, expectedRevision: '1' });
  const recovered = await restoreReadingFirstRuntime({ handoff: s.handoff, runControl: s.runControl, checkpointReceipt: receipt });
  assert.equal(recovered.ok, true, JSON.stringify(recovered.errors));
  assert.deepEqual(recovered.requests, [pending]);
  assert.deepEqual(snapshotReadingFirstRuntime(recovered.controller), saved);
  assert.equal(getReadingFirstState(recovered.controller).calls_used, 7);
  await mkdir(join(s.root, 'native'), { recursive: true });
  await writeFile(join(s.root, pending.task.native_path), JSON.stringify(s.view('en')));
  const step = pending.emittedStep;
  await acceptReadingFirstResult({ controller: recovered.controller, request: recovered.requests[0], observation: {
    action_id: step.action_id, run_id: 'run', input_fingerprint: step.input_fingerprint, port: 'current-collaboration',
    tool_call: { name: step.action, arguments: step.arguments }, raw_result_text: JSON.stringify({ agent_id: 'synthetic-restored', reply: 'en: written\nnative/en.json' }),
  }, capability: s.broker.issueCapability({ runId: 'run', actorId: pending.task.owner_actor_id, role: pending.task.role, artifactPath: pending.task.artifact_path, revision: pending.task.revision }) });
  const [counterpart] = createReadingFirstDraftRequests({ controller: recovered.controller });
  assert.equal(counterpart.language, 'zh-CN');
  for (const request of [pending, counterpart]) {
    assert.equal(request.emittedStep.arguments.message.includes(rule), enabled);
    assert.deepEqual(request.packet.backend.configuration.role_reply_contract, roleReplyContract);
  }
  assert.equal(getReadingFirstState(recovered.controller).calls_used, 8);
  t.mock.method(Date, 'now', () => Date.parse('2100-01-01T00:00:00Z'));
  assert.throws(() => snapshotReadingFirstRuntime(recovered.controller), /READING_FIRST_DEADLINE_EXPIRED/);
});

test('reply contract rejects malformed metadata and only accepts its fixed profile and exact bytes', () => {
  const contract = getRoleReplyContract();
  assert.equal(loadRoleReplyContract(undefined), '');
  for (const invalid of [null, {}, { ...contract, profile: 'other' }, { ...contract, path: '../other.md' }, { ...contract, byte_length: 0 }]) {
    assert.throws(() => loadRoleReplyContract(invalid), /APA_ROLE_REPLY_CONTRACT_INVALID/);
  }
  for (const changed of [{ ...contract, sha256: 'sha256:' + '0'.repeat(64) }, { ...contract, byte_length: contract.byte_length + 1 }]) {
    assert.throws(() => loadRoleReplyContract(changed), /APA_ROLE_REPLY_CONTRACT_CHANGED/);
  }
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



test('reading compaction requires a saved checkpoint and known idle host requests',async t=>{
  const s=await setup(t), controller=s.created.controller;
  const saved=snapshotReadingFirstRuntime(controller);
  const receipt=await commitOwnedArtifact({artifactRoot:s.root,dispatchContext:s.broker.dispatchContext,capability:s.broker.issueCapability({runId:'run',actorId:'controller',role:'control',artifactPath:'checkpoint.json',revision:'1'}),artifact:{artifact_id:'checkpoint',content:JSON.stringify(saved)},expectedRevision:'1'});
  const hostRequests=s.created.requests.map(r=>({action_id:r.emittedStep.action_id,status:'prepared'}));
  let boundary=await observeReadingCompactionBoundary({controller,checkpointReceipt:receipt,hostRequests});
  assert.equal(boundary.id,'before-writer'); assert.equal(boundary.recovery.saved,true); assert.equal(boundary.running_count,0);
  assert.equal(getReadingFirstState(controller).compaction_boundary.id, 'before-writer');
  const updated=await recordReadingCompactionBoundary({controller,boundary,status:'skipped',reason:'context unknown',checkpointTask:{artifact_id:'checkpoint-compaction',artifact_path:'checkpoint-compaction.json',revision:'1'},capability:s.broker.issueCapability({runId:'run',actorId:'controller',role:'control',artifactPath:'checkpoint-compaction.json',revision:'1'})});
  assert.equal(snapshotReadingFirstRuntime(controller).state.compaction_reminders['before-writer'].status,'skipped');
  boundary=await observeReadingCompactionBoundary({controller,checkpointReceipt:receipt,hostRequests});
  assert.equal(boundary.recovery.saved,false);
  const restored=await restoreReadingFirstRuntime({handoff:s.handoff,runControl:s.runControl,checkpointReceipt:updated.receipt});
  assert.equal(restored.ok,true);
  boundary=await observeReadingCompactionBoundary({controller:restored.controller,checkpointReceipt:updated.receipt,hostRequests});
  assert.equal(boundary.reminder.status,'skipped');
  await assert.rejects(()=>recordReadingCompactionBoundary({controller:restored.controller,boundary,status:'prompted',reason:'again'}),/READING_FIRST_COMPACTION_ALREADY_RECORDED/);
});

test('before-review compaction preserves a generated undispatched review request', async t => {
  const s = await setup(t), controller = s.created.controller;
  for (const request of s.created.requests) await s.complete(request, s.view(request.language));
  const presentation = await renderReaderNotes({ input: { profile: READING_FIRST_PROFILE, controller } });
  const request = createReadingFirstReviewRequest({ controller, presentation });
  const receipt = await commitOwnedArtifact({ artifactRoot: s.root, dispatchContext: s.broker.dispatchContext,
    capability: s.broker.issueCapability({ runId: 'run', actorId: 'controller', role: 'control', artifactPath: 'checkpoint.json', revision: '1' }),
    artifact: { artifact_id: 'checkpoint', content: JSON.stringify(snapshotReadingFirstRuntime(controller)) }, expectedRevision: '1' });
  for (const status of ['running', 'unknown']) {
    const boundary = await observeReadingCompactionBoundary({ controller, checkpointReceipt: receipt, presentation, hostRequests: [{ action_id: request.emittedStep.action_id, status }] });
    assert.equal(boundary.running_count, 1);
    await assert.rejects(recordReadingCompactionBoundary({ controller, boundary, status: 'prompted', reason: 'large context' }), /COMPACTION_UNAVAILABLE/);
  }
  const boundary = await observeReadingCompactionBoundary({ controller, checkpointReceipt: receipt, presentation, hostRequests: [{ action_id: request.emittedStep.action_id, status: 'prepared' }] });
  assert.equal(boundary.id, 'before-review');
  const updated = await recordReadingCompactionBoundary({ controller, boundary, status: 'skipped', reason: 'context unknown',
    checkpointTask: { artifact_id: 'checkpoint-compaction', artifact_path: 'checkpoint-compaction.json', revision: '1' },
    capability: s.broker.issueCapability({ runId: 'run', actorId: 'controller', role: 'control', artifactPath: 'checkpoint-compaction.json', revision: '1' }) });
  const restored = await restoreReadingFirstRuntime({ handoff: s.handoff, runControl: s.runControl, checkpointReceipt: updated.receipt });
  assert.equal(restored.ok, true);
  assert.deepEqual(restored.requests.map(row => row.emittedStep.action_id), [request.emittedStep.action_id]);
  assert.equal(snapshotReadingFirstRuntime(restored.controller).state.compaction_reminders['before-review'].status, 'skipped');
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
  const editorFor=()=>({schema_version:'reading-editor-1.2',views_fingerprint:fingerprintReadingFirst(views),map:{nodes:[]},languages:Object.fromEntries(['en','zh-CN'].map(language=>[language,{overview:[{text:'Main finding',section_ids:['design']}],sections:[],methods:[{id:'design-method',title:'Design method',explanation:'Design explains inference.',application:'Used in this design.',section_ids:['design']}],visuals:[]}]))});
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
  const editorFor=values=>({schema_version:'reading-editor-1.2',views_fingerprint:fingerprintReadingFirst(values),map:{nodes:[]},languages:Object.fromEntries(['en','zh-CN'].map(language=>[language,{overview:[{text:'Main finding',section_ids:['design']}],sections:[],methods:[{id:'design-method',title:'Design method',explanation:'Design explains inference.',application:'Used in this design.',section_ids:['design']}],visuals:[]}]))});
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
  const editor={schema_version:'reading-editor-1.2',views_fingerprint:fingerprintReadingFirst(['en','zh-CN'].map(language=>handoff.adopted_views.find(item=>item.content.language===language).content)),map:{nodes:[]},languages:Object.fromEntries(['en','zh-CN'].map(language=>[language,{overview:[{text:'Main finding',section_ids:['design']}],sections:[],methods:[{id:'design-method',title:'Design method',explanation:'Design explains inference.',application:'Used in this design.',section_ids:['design']}],visuals:[]}]))};
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
  const editor={schema_version:'reading-editor-1.2',views_fingerprint:fingerprintReadingFirst(views),map:{nodes:[]},languages:Object.fromEntries(['en','zh-CN'].map(language=>[language,{overview:[{text:'Main finding',section_ids:['design']}],sections:[],methods:[{id:'method',title:'Method',explanation:'Study design.',application:'Used in the study.',section_ids:['design']}],visuals:[]}]))};
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

test('a material renderer defect needs only the existing local reviewer after its affected file changes', async t => {
  const presentation={schema_version:'reading-first-obsidian-1.0',bibliography:{title:'Synthetic study',first_author:'Tester',year:2026},source_pdf:'Raw/source.pdf',sections:[{id:'study',indices:{en:0,'zh-CN':0}}],visuals:[],knowledge:[],map:{steps:[],findings:[],relations:[]}};
  const s=await setup(t,{presentation,maxCalls:4}), controller=s.created.controller;
  for(const request of s.created.requests) await s.complete(request,s.view(request.language));
  const first=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller}});
  const path=first.notes[0].path;
  await s.complete(createReadingFirstReviewRequest({controller,presentation:first}),{overall:{complete:false,coherent:true,bilingual_consistent:true},key_nodes:[],issues:[{severity:'material',kind:'knowledge-accumulation',detail:'Renderer lost the committed content',repair_owner:'renderer',affected_paths:[path]}],scope:'overall'});
  assert.equal(getReadingFirstState(controller).status,'revision_required');
  assert.throws(()=>createReadingFirstRevisionRequests({controller}),/REVISION_UNAVAILABLE/);
  assert.throws(()=>createReadingFirstReviewRequest({controller,presentation:first,renderRepair:true}),/RENDER_REPAIR_UNAVAILABLE/);
  const existingTargets=first.notes.map(note=>({path:note.path,bytes:Buffer.from(note.content.replace('## Personal Notes','Corrected render.\n\n## Personal Notes')),managedHash:note.managedHash}));
  const repaired=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller},targetRegistry:first.targetRegistry,existingTargets});
  assert.throws(()=>createReadingFirstReviewRequest({controller,presentation:repaired}),/RENDER_REPAIR_REQUIRED/);
  const local=createReadingFirstReviewRequest({controller,presentation:repaired,renderRepair:true});
  assert.equal(local.review_scope,'local');
  const payload=JSON.parse(local.emittedStep.arguments.message.split('\n\n').at(-1));
  assert.equal(payload.issues[0].repair_owner,'renderer');
  await s.complete(local,{overall:{complete:true,coherent:true,bilingual_consistent:true},key_nodes:[{kind:'main_conclusion',location:'p1',finding:'supported'},{kind:'key_design',location:'p1',finding:'supported'}],issues:[],scope:'local'});
  assert.equal(getReadingFirstState(controller).calls_used,4);
  assert.equal(getReadingFirstState(controller).status,'reading_complete');
});

for (const rendererLanguage of ['en', 'zh-CN']) test(`mixed Writer and renderer defects on ${rendererLanguage} keep their ownership through restoration`, async t => {
  const presentation={schema_version:'reading-first-obsidian-1.0',bibliography:{title:'Synthetic study',first_author:'Tester',year:2026},source_pdf:'Raw/source.pdf',sections:[{id:'study',indices:{en:0,'zh-CN':0}}],visuals:[],knowledge:[],map:{steps:[],findings:[],relations:[]}};
  const s=await setup(t,{presentation,maxCalls:6}), controller=s.created.controller;
  for(const request of s.created.requests) await s.complete(request,s.view(request.language));
  const first=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller}});
  const path=first.notes.find(note=>note.language===rendererLanguage).path;
  await s.complete(createReadingFirstReviewRequest({controller,presentation:first}),{overall:{complete:false,coherent:true,bilingual_consistent:true},key_nodes:[],issues:[
    {severity:'material',kind:'omission',detail:'Explain the design',repair_owner:'writer',affected_languages:['en']},
    {severity:'material',kind:'knowledge-accumulation',detail:'Renderer lost the node',repair_owner:'renderer',affected_paths:[path],affected_languages:['en','zh-CN']},
  ],scope:'overall'});
  const [revision]=createReadingFirstRevisionRequests({controller});
  assert.equal(revision.language,'en');
  const payload=JSON.parse(revision.emittedStep.arguments.message.split('\n\n').at(-1));
  assert.deepEqual(payload.issues.map(issue=>issue.repair_owner),['writer']);
  await s.complete(revision,{...s.view('en'),sections:[{heading:'Study',paragraphs:['The corrected explanation follows the design.']}]});
  const writerOnly=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller},targetRegistry:first.targetRegistry});
  assert.throws(()=>createReadingFirstReviewRequest({controller,presentation:writerOnly}),/RENDER_REPAIR_REQUIRED/);
  assert.throws(()=>createReadingFirstReviewRequest({controller,presentation:writerOnly,renderRepair:true}),/RENDER_REPAIR_UNAVAILABLE/);
  const saved=snapshotReadingFirstRuntime(controller);
  const receipt=await commitOwnedArtifact({artifactRoot:s.root,dispatchContext:s.broker.dispatchContext,capability:s.broker.issueCapability({runId:'run',actorId:'controller',role:'control',artifactPath:'checkpoint.json',revision:'1'}),artifact:{artifact_id:'checkpoint',content:JSON.stringify(saved)},expectedRevision:'1'});
  const recovered=await restoreReadingFirstRuntime({handoff:s.handoff,runControl:s.runControl,checkpointReceipt:receipt});
  assert.equal(recovered.ok,true,JSON.stringify(recovered.errors));
  const heading=rendererLanguage==='en'?'## Personal Notes':'## 个人笔记';
  const existingTargets=writerOnly.notes.map(note=>({path:note.path,bytes:Buffer.from(note.path===path?note.content.replace(heading,'Renderer correction.\n\n'+heading):note.content),managedHash:note.managedHash}));
  const repaired=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller:recovered.controller},targetRegistry:first.targetRegistry,existingTargets});
  const local=createReadingFirstReviewRequest({controller:recovered.controller,presentation:repaired,renderRepair:true});
  assert.equal(local.review_scope,'local');
  assert.equal(getReadingFirstState(recovered.controller).calls_used,5);
});

test('a science-owned material defect without authorized enrichment remains unresolved', async t => {
  const s=await setup(t),controller=s.created.controller;
  for(const request of s.created.requests) await s.complete(request,s.view(request.language));
  const rendered=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller}});
  await s.complete(createReadingFirstReviewRequest({controller,presentation:rendered}),{overall:{complete:false,coherent:true,bilingual_consistent:true},key_nodes:[],issues:[{severity:'material',kind:'scientific-gap',detail:'Missing study evidence',repair_owner:'science',affected_languages:['en']}],scope:'overall'});
  assert.equal(getReadingFirstState(controller).status,'completed_with_limits');
  assert.throws(()=>createReadingFirstRevisionRequests({controller}),/REVISION_UNAVAILABLE/);
});

test('explicit science ownership uses the existing approved enrichment before Writer repair', async t => {
  const s=await setup(t,{enrichmentPolicy:{sources:[],allow_targeted_methods:true},maxCalls:6,maxTotalCalls:7}),controller=s.created.controller;
  for(const request of s.created.requests) await s.complete(request,s.view(request.language));
  const rendered=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller}});
  const gap={id:'allocation',severity:'material',question:'How was allocation performed?',impact:'Changes design interpretation.',owner_role:'evidence',source_kind:'original_page',target_sections:['Study'],source_ids:['main']};
  await s.complete(createReadingFirstReviewRequest({controller,presentation:rendered}),{overall:{complete:false,coherent:true,bilingual_consistent:true},key_nodes:[],issues:[{severity:'material',kind:'scientific-gap',detail:'Allocation unclear',repair_owner:'science',affected_languages:['en'],scientific_gap:gap}],scope:'overall'});
  assert.throws(()=>createReadingFirstRevisionRequests({controller}),/ENRICHMENT_PENDING/);
  const [science]=createReadingFirstEnrichmentRequests({controller});
  assert.equal(science.task.role,'evidence');
  await s.complete(science,{run_id:'run',role:'evidence',resolutions:[{gap_id:'allocation',classification:'paper_fact',explanation:'Allocation was randomized.',consequence:'Randomization supports the design.',status:'recovered',target_sections:['Study'],source_ids:['main']}]});
  const [writer]=createReadingFirstRevisionRequests({controller});
  const payload=JSON.parse(writer.emittedStep.arguments.message.split('\n\n').at(-1));
  assert.match(JSON.stringify(payload.enrichment_context),/Allocation was randomized/);
  const revised=s.view('en'); revised.enrichment_consumption=[{gap_id:'allocation',section_heading:'Study'}];
  await s.complete(writer,revised);
  const result=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller}});
  const local=createReadingFirstReviewRequest({controller,presentation:result});
  await s.complete(local,{overall:{complete:true,coherent:true,bilingual_consistent:true},key_nodes:[{kind:'main_conclusion',location:'p1',finding:'supported'},{kind:'key_design',location:'p1',finding:'supported'}],issues:[],scope:'local'});
  assert.equal(getReadingFirstState(controller).calls_used,6);
  assert.equal(getReadingFirstState(controller).status,'reading_complete');
});

async function visualCorrectionFixture(t) {
  const presentation={schema_version:'reading-first-obsidian-1.0',bibliography:{title:'Synthetic study',first_author:'Tester',year:2026},source_pdf:'Raw/source.pdf',sources:[{id:'main',path:'Raw/source.pdf'}],sections:[{id:'study',indices:{en:0,'zh-CN':0}}],visuals:[{id:'sensitivity',kind:'figure',label:{en:'Figure S8','zh-CN':'图 S8'},caption:{en:'Wrong independent-source caption.','zh-CN':'错误独立来源图注。'},path:'Figures/sensitivity.jpg',page:31,source_id:'main',source_path:'Raw/source.pdf',section_id:'study'}],knowledge:[],map:{steps:[],findings:[],relations:[]}};
  const s=await setup(t,{presentation,enrichmentPolicy:{sources:[],allow_targeted_methods:true},maxCalls:6,maxTotalCalls:7}),controller=s.created.controller;
  for(const request of s.created.requests) await s.complete(request,s.view(request.language));
  const first=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller}});
  const gap={id:'visual-binding',severity:'material',question:'Which original figure is this?',impact:'Changes evidence type.',owner_role:'evidence',source_kind:'original_page',target_sections:['Study'],source_ids:['main']};
  await s.complete(createReadingFirstReviewRequest({controller,presentation:first}),{overall:{complete:false,coherent:false,bilingual_consistent:true},key_nodes:[],issues:[{severity:'material',kind:'visual-source-binding',detail:'Wrong original caption.',repair_owner:'science',affected_languages:['en'],scientific_gap:gap,repair_scope:{status:'located',section_ids:['study'],knowledge_ids:[],visual_ids:['sensitivity'],editor_fields:[]}}],scope:'overall'});
  const [request]=createReadingFirstEnrichmentRequests({controller});
  const correction={visual_id:'sensitivity',source_id:'main',page:31,label:{en:'Figure S7','zh-CN':'图 S7'},caption:{en:'Original S7 alternative-method sensitivity.','zh-CN':'原图 S7，替代方法敏感性分析。'}};
  const value={run_id:'run',role:'evidence',resolutions:[{gap_id:'visual-binding',classification:'paper_fact',explanation:'Original page 31 is Figure S7.',consequence:'Separate alternative methods from independent sources.',status:'recovered',target_sections:['Study'],source_ids:['main']}],visual_corrections:[correction]};
  return {...s,controller,request,value};
}

test('owned original-page recovery corrects the consumed visual catalogue and survives restore without changing the original handoff', async t => {
  const s=await visualCorrectionFixture(t), original=JSON.stringify(s.handoff);
  await s.complete(s.request,s.value);
  const [writer]=createReadingFirstRevisionRequests({controller:s.controller});
  const payload=JSON.parse(writer.emittedStep.arguments.message.split('\n\n').at(-1));
  assert.equal(payload.handoff.presentation.visuals[0].label.en,'Figure S7');
  const revised=s.view('en'); revised.enrichment_consumption=[{gap_id:'visual-binding',section_heading:'Study'}];
  await s.complete(writer,revised);
  const rendered=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller:s.controller}});
  assert.match(rendered.notes.find(note=>note.language==='en').content,/Original S7 alternative-method sensitivity/);
  assert.match(rendered.notes.find(note=>note.language==='zh-CN').content,/原图 S7，替代方法敏感性分析/);
  assert.doesNotMatch(rendered.notes.map(note=>note.content).join('\n'),/Wrong independent-source caption/);
  const receipt=await compactionCheckpoint(s,s.controller);
  const restored=await restoreReadingFirstRuntime({handoff:s.handoff,runControl:s.runControl,checkpointReceipt:receipt});
  assert.equal(restored.ok,true,JSON.stringify(restored.errors));
  const again=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller:restored.controller}});
  assert.equal(again.notes[0].content,rendered.notes[0].content);
  assert.equal(JSON.stringify(s.handoff),original);
});

for(const change of [{visual_id:'unreviewed'},{source_id:'other'},{path:'Figures/replaced.jpg'},{caption:{en:'Only one language'}}]) test(`original-page visual correction rejects an out-of-scope or incomplete replacement ${JSON.stringify(change)}`, async t => {
  const s=await visualCorrectionFixture(t);
  Object.assign(s.value.visual_corrections[0],change);
  await assert.rejects(()=>s.complete(s.request,s.value),/READING_FIRST_VISUAL_CORRECTION_INVALID/);
});

test('renderer issues must identify existing candidate paths before the review is accepted', async t => {
  const presentation={schema_version:'reading-first-obsidian-1.0',bibliography:{title:'Synthetic study',first_author:'Tester',year:2026},source_pdf:'Raw/source.pdf',sections:[{id:'study',indices:{en:0,'zh-CN':0}}],visuals:[],knowledge:[],map:{steps:[],findings:[],relations:[]}};
  const s=await setup(t,{presentation}),controller=s.created.controller;
  for(const request of s.created.requests) await s.complete(request,s.view(request.language));
  const rendered=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller}});
  const request=createReadingFirstReviewRequest({controller,presentation:rendered});
  const issue={severity:'material',kind:'knowledge-accumulation',detail:'Renderer lost the node',repair_owner:'renderer'};
  const verdict=issue=>({overall:{complete:false,coherent:true,bilingual_consistent:true},key_nodes:[],issues:[issue],scope:'overall'});
  for(const invalid of [issue,{...issue,affected_paths:[]},{...issue,affected_paths:['Wiki/methods/not-in-candidate.md']},{...issue,repair_owner:'unknown'}]) {
    await assert.rejects(()=>s.complete(request,verdict(invalid)),/REVIEW_INVALID/);
  }
  await assert.rejects(()=>readFile(join(s.root,'review.json')),/ENOENT/);
  await s.complete(request,verdict({...issue,affected_paths:[rendered.notes[0].path]}));
  assert.equal(getReadingFirstState(controller).status,'revision_required');
});

test('Editor and renderer material repairs share the original local review slot', async t => {
  const presentation={schema_version:'reading-first-obsidian-1.0',bibliography:{title:'Synthetic study',first_author:'Tester',year:2026},source_pdf:'Raw/source.pdf',sections:[{id:'study',indices:{en:0,'zh-CN':0}}],visuals:[],knowledge:[],map:{steps:[],findings:[],relations:[]}};
  presentation.layout='writer-modules-1.0';
  presentation.modules=['abstract','design','methods','findings','discussion','limitations','conclusion'].map(id=>({id,label:{en:id,'zh-CN':id}}));
  const s=await setup(t,{presentation,presentationMode:'reading-editor',maxCalls:6}),controller=s.created.controller;
  const views=['en','zh-CN'].map(language=>({language,sections:presentation.modules.map(module=>({id:module.id,module_id:module.id,heading:module.id,paragraphs:['Design explains the main finding.']})),placements:{visuals:[],knowledge:[]}}));
  for(const request of s.created.requests) await s.complete(request,views.find(view=>view.language===request.language));
  const editor=overview=>({schema_version:'reading-editor-1.2',views_fingerprint:fingerprintReadingFirst(views),map:{nodes:[]},languages:Object.fromEntries(['en','zh-CN'].map(language=>[language,{overview:[{text:overview,section_ids:['design']}],sections:[],methods:[{id:'method',title:'Method',explanation:'Study design.',application:'Used in the study.',section_ids:['design']}],visuals:[]}]))});
  await s.complete(createReadingFirstPresentationRequest({controller}),editor('Initial finding'));
  const first=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller}}),path=first.notes[0].path;
  await s.complete(createReadingFirstReviewRequest({controller,presentation:first}),{overall:{complete:false,coherent:true,bilingual_consistent:true},key_nodes:[],issues:[
    {severity:'material',kind:'presentation',detail:'Fix the overview',repair_owner:'editor'},
    {severity:'material',kind:'knowledge-accumulation',detail:'Fix the renderer',repair_owner:'renderer',affected_paths:[path]},
  ],scope:'overall'});
  assert.throws(()=>createReadingFirstRevisionRequests({controller}),/REVISION_UNAVAILABLE/);
  const editorRevision=createReadingFirstPresentationRequest({controller});
  const editorPayload=JSON.parse(editorRevision.emittedStep.arguments.message.split('\n\n').at(-1));
  assert.deepEqual(editorPayload.issues.map(issue=>issue.repair_owner),['editor']);
  await s.complete(editorRevision,editor('Corrected finding'));
  const editorOnly=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller},targetRegistry:first.targetRegistry});
  assert.throws(()=>createReadingFirstReviewRequest({controller,presentation:editorOnly,renderRepair:true}),/RENDER_REPAIR_UNAVAILABLE/);
  const existingTargets=editorOnly.notes.map(note=>({path:note.path,bytes:Buffer.from(note.path===path?note.content.replace('## Personal Notes','Renderer correction.\n\n## Personal Notes'):note.content),managedHash:note.managedHash}));
  const repaired=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller},targetRegistry:first.targetRegistry,existingTargets});
  const local=createReadingFirstReviewRequest({controller,presentation:repaired,renderRepair:true});
  await s.complete(local,{overall:{complete:true,coherent:true,bilingual_consistent:true},key_nodes:[{kind:'main_conclusion',location:'p1',finding:'supported'},{kind:'key_design',location:'p1',finding:'supported'}],issues:[],scope:'local'});
  assert.equal(getReadingFirstState(controller).calls_used,6);
  assert.equal(getReadingFirstState(controller).status,'reading_complete');
});

test('late science and renderer repairs reserve only the actual Writer calls', async t => {
  const presentation={schema_version:'reading-first-obsidian-1.0',bibliography:{title:'Synthetic study',first_author:'Tester',year:2026},source_pdf:'Raw/source.pdf',sections:[{id:'study',indices:{en:0,'zh-CN':0}}],visuals:[],knowledge:[],map:{steps:[],findings:[],relations:[]}};
  const s=await setup(t,{presentation,enrichmentPolicy:{sources:[],allow_targeted_methods:true},maxCalls:6,maxTotalCalls:6}),controller=s.created.controller;
  for(const request of s.created.requests) await s.complete(request,s.view(request.language));
  const first=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller}}),path=first.notes.find(note=>note.language==='zh-CN').path;
  const gap={id:'allocation',severity:'material',question:'How was allocation performed?',impact:'Changes design interpretation.',owner_role:'evidence',source_kind:'original_page',target_sections:['Study'],source_ids:['main']};
  await s.complete(createReadingFirstReviewRequest({controller,presentation:first}),{overall:{complete:false,coherent:true,bilingual_consistent:true},key_nodes:[],issues:[
    {severity:'material',kind:'scientific-gap',detail:'Allocation unclear',repair_owner:'science',affected_languages:['en'],scientific_gap:gap},
    {severity:'material',kind:'knowledge-accumulation',detail:'Renderer lost the node',repair_owner:'renderer',affected_paths:[path],affected_languages:['en','zh-CN']},
  ],scope:'overall'});
  const [science]=createReadingFirstEnrichmentRequests({controller});
  await s.complete(science,{run_id:'run',role:'evidence',resolutions:[{gap_id:'allocation',classification:'paper_fact',explanation:'Allocation was randomized.',consequence:'Randomization supports the design.',status:'recovered',target_sections:['Study'],source_ids:['main']}]});
  const [writer]=createReadingFirstRevisionRequests({controller});
  const revised=s.view('en'); revised.enrichment_consumption=[{gap_id:'allocation',section_heading:'Study'}];
  await s.complete(writer,revised);
  const writerOnly=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller},targetRegistry:first.targetRegistry});
  const existingTargets=writerOnly.notes.map(note=>({path:note.path,bytes:Buffer.from(note.path===path?note.content.replace('## 个人笔记','Renderer correction.\n\n## 个人笔记'):note.content),managedHash:note.managedHash}));
  const repaired=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller},targetRegistry:first.targetRegistry,existingTargets});
  const local=createReadingFirstReviewRequest({controller,presentation:repaired,renderRepair:true});
  await s.complete(local,{overall:{complete:true,coherent:true,bilingual_consistent:true},key_nodes:[{kind:'main_conclusion',location:'p1',finding:'supported'},{kind:'key_design',location:'p1',finding:'supported'}],issues:[],scope:'local'});
  assert.equal(getReadingFirstState(controller).calls_used,6);
  assert.equal(getReadingFirstState(controller).status,'reading_complete');
});

test('invalid scientific gap is rejected before the review artifact is committed', async t => {
  const s=await setup(t,{enrichmentPolicy:{sources:[],allow_targeted_methods:true},maxCalls:6,maxTotalCalls:7}),controller=s.created.controller;
  for(const request of s.created.requests) await s.complete(request,s.view(request.language));
  const rendered=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller}});
  const review=createReadingFirstReviewRequest({controller,presentation:rendered});
  const issue={severity:'material',kind:'scientific-gap',detail:'Allocation unclear',repair_owner:'science',affected_languages:['en'],scientific_gap:{severity:'material',id:'incomplete'}};
  await assert.rejects(()=>s.complete(review,{overall:{complete:false,coherent:true,bilingual_consistent:true},key_nodes:[],issues:[issue],scope:'overall'}),/GAP_INVALID/);
  await assert.rejects(()=>readFile(join(s.root,'review.json')),/ENOENT/);
});

test('an existing binding without owner routing retains its original review contract', async t => {
  const s=await setup(t,{legacyRepairRouting:true}),controller=s.created.controller;
  for(const request of s.created.requests) await s.complete(request,s.view(request.language));
  const rendered=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller}});
  const issue={severity:'material',kind:'knowledge-accumulation',detail:'Review from old binding',repair_owner:'renderer',affected_languages:['en']};
  await s.complete(createReadingFirstReviewRequest({controller,presentation:rendered}),{overall:{complete:false,coherent:true,bilingual_consistent:true},key_nodes:[],issues:[issue],scope:'overall'});
  const [writer]=createReadingFirstRevisionRequests({controller});
  assert.equal(writer.language,'en');
});

test('an unknown frozen repair routing cannot silently fall back to legacy behavior', async t => {
  await assert.rejects(()=>setup(t,{invalidRepairRouting:true}),/CONTROL_REQUIRED/);
});

test('explicit science repair stays limited when its owner or full repair budget was not approved', async t => {
  for (const missingOwner of [true,false]) {
    const s=await setup(t,{writingMode:'source-first',enrichmentPolicy:{sources:[],allow_targeted_methods:true},maxCalls:6,maxTotalCalls:6}),controller=s.created.controller;
    await s.complete(s.created.requests[0],s.view('en'));
    await s.complete(createReadingFirstDraftRequests({controller})[0],s.view('zh-CN'));
    const rendered=await renderReaderNotes({input:{profile:READING_FIRST_PROFILE,controller}});
    const gap={id:'allocation',severity:'material',question:'How was allocation performed?',impact:'Changes design interpretation.',owner_role:missingOwner?'results':'evidence',source_kind:'original_page',target_sections:['Study'],source_ids:['main']};
    await s.complete(createReadingFirstReviewRequest({controller,presentation:rendered}),{overall:{complete:false,coherent:true,bilingual_consistent:true},key_nodes:[],issues:[{severity:'material',kind:'scientific-gap',detail:'Allocation unclear',repair_owner:'science',affected_languages:['en'],scientific_gap:gap}],scope:'overall'});
    assert.equal(getReadingFirstState(controller).status,'completed_with_limits');
    assert.throws(()=>createReadingFirstEnrichmentRequests({controller}),/ENRICHMENT_UNAVAILABLE/);
  }
});

// Presentation with two shared-knowledge support notes (one per language) so the rendered result carries supportNotes.
const supportPresentation = () => ({ schema_version: 'reading-first-obsidian-1.0', bibliography: { title: 'Synthetic study', first_author: 'Tester', year: 2026 }, source_pdf: 'Raw/source.pdf', sections: [{ id: 'study', indices: { en: 0, 'zh-CN': 0 } }], visuals: [],
  knowledge: [{ id: 'rate', kind: 'method', canonical_key: 'age-standardisation', title: { en: 'Age standardisation', 'zh-CN': '年龄标化' }, aliases: ['ASR'], paragraphs: { en: ['Background explanation.'], 'zh-CN': ['背景解释。'] }, placements: [{ section_id: 'study', after_paragraph: 0 }], source_kind: 'method-background' }],
  map: { steps: [], findings: [], relations: [] } });
async function renderedWithSupport(t, options = {}) {
  const s = await setup(t, { presentation: supportPresentation(), presentationRequired: true, ...options });
  for (const request of s.created.requests) await s.complete(request, s.view(request.language));
  const rendered = await renderReaderNotes({ input: { profile: READING_FIRST_PROFILE, controller: s.created.controller } });
  assert.equal(rendered.supportNotes.length, 2);
  return { s, rendered };
}
const reviewPayload = request => requestPayload(request);
// Fingerprints of the masked overall review request, captured from the code before review support notes moved to files (2026-10-28).
const LEGACY_REVIEW = {
  instruction_fingerprint: 'sha256:f3adae86a57598502f2635df546df78cb09d1024e73c12d22a7b1dee0d6cb2c8',
  configuration_fingerprint: 'sha256:3419d4dc4279a0692e7e8d9db034ab061eff40cc89f953688c080a5a390f4941',
};
test('legacy review requests are unchanged', async t => {
  const { s, rendered } = await renderedWithSupport(t);
  const request = createReadingFirstReviewRequest({ controller: s.created.controller, presentation: rendered });
  const { instruction_fingerprint, configuration_fingerprint, message } = maskedRequest(s, request);
  assert.deepEqual({ instruction_fingerprint, configuration_fingerprint }, LEGACY_REVIEW);
  const payload = reviewPayload(request);
  assert.equal(payload.presentation.supportNotes.length, 2);
  assert.equal(payload.handoff.science.length, 6);
  assert.equal(Object.hasOwn(payload, 'support_note_files'), false);
  assert.doesNotMatch(message, /support_note_files|science_index/);
});
test('review requests write support notes to files and inline only the reduced handoff', async t => {
  const { s, rendered } = await renderedWithSupport(t, { handoffProfile: SCIENCE_INDEX_PROFILE });
  const request = createReadingFirstReviewRequest({ controller: s.created.controller, presentation: rendered });
  const payload = reviewPayload(request);
  assert.equal(Object.hasOwn(payload.presentation, 'supportNotes'), false);
  assert.equal(payload.presentation.presentation_fingerprint, rendered.presentation_fingerprint);
  assert.equal(payload.presentation.notes.length, rendered.notes.length);
  assert.equal(payload.support_note_files.length, rendered.supportNotes.length);
  for (const [index, file] of payload.support_note_files.entries()) {
    const note = rendered.supportNotes[index], bytes = await readFile(file.path);
    assert.equal(file.note_path, note.path);
    assert.equal(file.path, join(s.root, 'review-inputs', 'review', ...note.path.split('/')));
    assert.equal(bytes.toString('utf8'), note.content);
    assert.equal(file.sha256, sha(bytes));
    assert.equal(file.byte_length, bytes.length);
  }
  assert.equal(payload.handoff.science.length, 1);
  assert.equal(payload.handoff.science[0].receipt.role, 'integration');
  assert.deepEqual(payload.handoff.science_index.map(item => item.role), INDEXED_ROLES);
  for (const note of rendered.supportNotes) assert.equal(request.emittedStep.arguments.message.includes(note.content), false);
});
test('review support note files reuse identical bytes regardless of the reuse flag and reject changed bytes', async t => {
  for (const changed of [false, true]) {
    const { s, rendered } = await renderedWithSupport(t, { handoffProfile: SCIENCE_INDEX_PROFILE });
    const note = rendered.supportNotes[0], path = join(s.root, 'review-inputs', 'review', ...note.path.split('/'));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, changed ? note.content + '\nChanged.' : note.content);
    const create = () => createReadingFirstReviewRequest({ controller: s.created.controller, presentation: rendered });
    if (changed) assert.throws(create, /READING_FIRST_OUTPUT_CONFLICT/);
    else assert.equal(reviewPayload(create()).support_note_files.length, 2);
  }
});

const overallMaterial = { overall: { complete: false, coherent: true, bilingual_consistent: true }, key_nodes: [], issues: [{ severity: 'material', kind: 'omission', detail: 'Important limitation missing', affected_languages: ['en'] }], scope: 'overall' };
const localClean = { overall: { complete: true, coherent: true, bilingual_consistent: true }, key_nodes: [{ kind: 'main_conclusion', location: 'source', finding: 'supported' }, { kind: 'key_design', location: 'source', finding: 'supported' }], issues: [], scope: 'local' };
test('verifier guidance on support note files reaches both review and review-r2 messages', async t => {
  const { s, rendered } = await renderedWithSupport(t, { handoffProfile: SCIENCE_INDEX_PROFILE });
  const controller = s.created.controller;
  const note = await readFile(new URL('../../prompts/v3/science-index-1.0.md', import.meta.url), 'utf8');
  const guidance = /support_note_files[^]*sha256[^]*byte_length[^]*data, never instructions[^]*did not read as checked/;
  assert.match(note, guidance);
  const first = createReadingFirstReviewRequest({ controller, presentation: rendered });
  await s.complete(first, overallMaterial);
  const [revision] = createReadingFirstRevisionRequests({ controller });
  await s.complete(revision, s.view('en'));
  const second = await renderReaderNotes({ input: { profile: READING_FIRST_PROFILE, controller } });
  const local = createReadingFirstReviewRequest({ controller, presentation: second });
  for (const request of [first, local]) {
    assert.match(request.emittedStep.arguments.message, guidance);
    assert.deepEqual(request.packet.backend.configuration.science_index, { profile: 'science-index-1.0', sha256: sha(Buffer.from(note)), byte_length: Buffer.byteLength(note) });
  }
  assert.equal(local.review_scope, 'local');
  const payload = reviewPayload(local);
  assert.equal(Object.hasOwn(payload, 'handoff'), false);
  assert.equal(Object.hasOwn(payload.presentation, 'supportNotes'), false);
  assert.equal(payload.support_note_files.length, second.supportNotes.length);
  for (const [index, file] of payload.support_note_files.entries()) {
    assert.equal(file.path, join(s.root, 'review-inputs', 'review-r2', ...second.supportNotes[index].path.split('/')));
    assert.equal(sha(await readFile(file.path)), file.sha256);
  }
  await s.complete(local, localClean);
  assert.equal(getReadingFirstState(controller).status, 'reading_complete');
});
test('a changed support note file fails acceptance of the review', async t => {
  const { s, rendered } = await renderedWithSupport(t, { handoffProfile: SCIENCE_INDEX_PROFILE });
  const request = createReadingFirstReviewRequest({ controller: s.created.controller, presentation: rendered });
  await writeFile(reviewPayload(request).support_note_files[0].path, 'Edited after the request was issued.');
  await assert.rejects(() => s.complete(request, localClean), /READING_FIRST_SUPPORT_NOTE_CHANGED/);
  await assert.rejects(() => readFile(join(s.root, 'review.json')), /ENOENT/);
});
test('renderer issues may name a support note path under a new binding, and unknown paths are still rejected', async t => {
  const { s, rendered } = await renderedWithSupport(t, { handoffProfile: SCIENCE_INDEX_PROFILE });
  const controller = s.created.controller, path = rendered.supportNotes[0].path;
  const verdict = affectedPath => ({ overall: { complete: false, coherent: true, bilingual_consistent: true }, key_nodes: [], issues: [{ severity: 'material', kind: 'knowledge-accumulation', detail: 'Renderer lost the committed content', repair_owner: 'renderer', affected_paths: [affectedPath] }], scope: 'overall' });
  const request = createReadingFirstReviewRequest({ controller, presentation: rendered });
  assert.equal(Object.hasOwn(reviewPayload(request).presentation, 'supportNotes'), false);
  await assert.rejects(() => s.complete(request, verdict('Wiki/methods/unknown.en.md')), /READING_FIRST_REVIEW_INVALID/);
  await s.complete(request, verdict(path));
  assert.equal(getReadingFirstState(controller).status, 'revision_required');
});

// Fingerprints of masked Writer requests for the existing writing modes, captured from the code before source-translation existed (2026-10-29).
const EXISTING_MODE_WRITERS = {
  'independent:en': { instruction_fingerprint: 'sha256:f54d7e9a82646f82c43d8782f35219ff1bcd2969d60028e520223e096c96107a', configuration_fingerprint: 'sha256:260d65b2be453ff03476f6856289755115a74223cffc463f1c34771fbeb115aa' },
  'independent:zh-CN': { instruction_fingerprint: 'sha256:186ec07065a912ae9fbf331a198319acffa486d851dfde042fe0504d9fa3e1e1', configuration_fingerprint: 'sha256:69065e9a31cef04f3d85dc118a95768afa38bbf068d8e6f7a8c83911a581db1c' },
  'source-first:en': { instruction_fingerprint: 'sha256:f54d7e9a82646f82c43d8782f35219ff1bcd2969d60028e520223e096c96107a', configuration_fingerprint: 'sha256:260d65b2be453ff03476f6856289755115a74223cffc463f1c34771fbeb115aa' },
  'source-first:zh-CN': { instruction_fingerprint: 'sha256:4b85ae5514c276dfa64467bed1cbbac5224b8371348df958466e8be348606202', configuration_fingerprint: 'sha256:69065e9a31cef04f3d85dc118a95768afa38bbf068d8e6f7a8c83911a581db1c' },
};
const translationNoteUrl = new URL('../../prompts/v3/translation-1.0.md', import.meta.url);
const moduleView = (language, ids = ['design-overview', 'design-steps']) => ({ language, sections: ids.map(id => ({ id, module_id: 'design', heading: (language === 'en' ? 'Design ' : '设计 ') + id, paragraphs: [language === 'en' ? 'The design supports the comparison.' : '该设计支持比较。'] })), placements: { visuals: [{ id: 'fig1', section_id: 'design-overview', after_paragraph: 0 }], knowledge: [] } });
const modulePresentation = () => ({ schema_version: 'reading-first-obsidian-1.0', layout: 'writer-modules-1.0', modules: [{ id: 'design', label: { en: 'Study design', 'zh-CN': '研究设计' } }],
  visuals: [{ id: 'fig1', kind: 'figure', label: { en: 'Figure 1', 'zh-CN': '图1' }, caption: { en: 'Caption.', 'zh-CN': '图注。' }, path: 'Figures/fig1.png', page: 2 }],
  knowledge: [{ id: 'rate', kind: 'method', canonical_key: 'age-standardisation', title: { en: 'Age standardisation', 'zh-CN': '年龄标化' }, aliases: ['ASR'], paragraphs: { en: ['Background.'], 'zh-CN': ['背景。'] }, source_kind: 'method-background' }] });
// Entry shape of the phase22 Integrator terminology ledger (subset of Schema/phase22/render-context.schema.json).
const terminologyLedger = [{ term_id: 'asr', en_full_form: 'age-standardised rate', zh_full_form: '年龄标化率', abbreviation: 'ASR', aliases: ['age-adjusted rate'] }];

test('source-translation sends science only to the source-language writer', async t => {
  const s = await setup(t, { writingMode: 'source-translation', handoffProfile: SCIENCE_INDEX_PROFILE });
  assert.deepEqual(s.created.requests.map(item => [item.language, item.task.role, item.packet.host_action_scope.role]), [['en', 'english-writer', 'english-writer']]);
  const { handoff } = requestPayload(s.created.requests[0]);
  assert.equal(handoff.science.length, 1);
  assert.deepEqual(handoff.science_index.map(item => item.role), INDEXED_ROLES);
  assert.throws(() => createReadingFirstDraftRequests({ controller: s.created.controller }), /READING_FIRST_SOURCE_DRAFT_PENDING/);
});

test('translation request carries the accepted source view and no science handoff', async t => {
  const presentation = modulePresentation();
  const s = await setup(t, { writingMode: 'source-translation', handoffProfile: SCIENCE_INDEX_PROFILE, presentation, integrationContent: { terminology: terminologyLedger } });
  const note = await readFile(translationNoteUrl);
  assert.equal(Object.hasOwn(s.created.requests[0].packet.backend.configuration, 'translation'), false);
  await s.complete(s.created.requests[0], moduleView('en'));
  const [request] = createReadingFirstDraftRequests({ controller: s.created.controller });
  assert.equal(request.language, 'zh-CN');
  assert.equal(request.task.role, 'translation');
  assert.equal(request.packet.host_action_scope.role, 'translation');
  const payload = requestPayload(request);
  assert.equal(Object.hasOwn(payload, 'handoff'), false);
  assert.deepEqual(payload.source_view, moduleView('en'));
  assert.equal(payload.source_view_receipt.artifact_id, 'en');
  assert.deepEqual(payload.translation_context, { identity: s.handoff.identity, modules: presentation.modules, visuals: [{ id: 'fig1', label: { en: 'Figure 1', 'zh-CN': '图1' } }], knowledge: [{ id: 'rate', label: { en: 'Age standardisation', 'zh-CN': '年龄标化' } }], terminology: terminologyLedger });
  const message = request.emittedStep.arguments.message;
  assert.ok(message.includes(note.toString('utf8')));
  assert.doesNotMatch(message, /science-index-1\.0|science_index|Full connected science for/);
  assert.match(requestPayloadMessage(s.created.requests[0]), /Full connected science for integration/);
  assert.deepEqual(request.packet.backend.configuration.translation, { profile: 'translation-1.0', sha256: sha(note), byte_length: note.length });
  assert.equal(Object.hasOwn(request.packet.backend.configuration, 'science_index'), false);
  const result = await s.complete(request, moduleView('zh-CN'));
  assert.equal(result.status, 'pending_review');
});

const requestPayloadMessage = request => request.emittedStep.arguments.message;
test('translation terminology comes from the Integrator terminology, then its ledger, else stays empty', async t => {
  for (const [integrationContent, expected] of [[{ terminology: terminologyLedger, terminology_ledger: [] }, terminologyLedger], [{ terminology_ledger: terminologyLedger }, terminologyLedger], [{}, []]]) {
    const s = await setup(t, { writingMode: 'source-translation', integrationContent });
    await s.complete(s.created.requests[0], s.view('en'));
    const [request] = createReadingFirstDraftRequests({ controller: s.created.controller });
    assert.deepEqual(requestPayload(request).translation_context.terminology, expected);
  }
  assert.match(await readFile(translationNoteUrl, 'utf8'), /terminology list is empty, take terms and abbreviations from the accepted source draft/);
});

test('configured writing instructions for the target language reach Translation, the writing guide does not', async t => {
  const writingSkills = { 'humanizer-zh': { path: 'synthetic/humanizer-zh.md', content: 'ZH-GUIDE-TEXT' }, humanizer: { path: 'synthetic/humanizer.md', content: 'EN-GUIDE-TEXT' }, stss: { path: 'synthetic/stss.md', content: 'STSS-GUIDE-TEXT' } };
  const s = await setup(t, { writingMode: 'source-translation', writingSkills });
  const [source] = s.created.requests;
  assert.match(requestPayloadMessage(source), /EN-GUIDE-TEXT/);
  await s.complete(source, s.view('en'));
  const [request] = createReadingFirstDraftRequests({ controller: s.created.controller });
  const message = requestPayloadMessage(request);
  assert.equal(request.task.role, 'translation');
  assert.match(message, /ZH-GUIDE-TEXT/);
  assert.match(message, /STSS-GUIDE-TEXT/);
  assert.doesNotMatch(message, /EN-GUIDE-TEXT|writing_guide|Full connected science for/);
  assert.equal(Object.hasOwn(request.packet.backend.configuration, 'writing_guide'), false);
  assert.match(await readFile(translationNoteUrl, 'utf8'), /Apply the writing guidance supplied in this message/);
});

test('chinese papers write Chinese first and translate to English', async t => {
  const presentation = { schema_version: 'reading-first-obsidian-1.0', bibliography: { title: 'Synthetic study', first_author: 'Tester', year: 2026 }, source_pdf: 'Raw/source.pdf', sections: [{ id: 'study', indices: { en: 0, 'zh-CN': 0 } }], visuals: [], knowledge: [], map: { steps: [], findings: [], relations: [] } };
  const s = await setup(t, { writingMode: 'source-translation', sourceLanguage: 'zh-CN', presentation, presentationRequired: true });
  assert.equal(s.created.requests.length, 1);
  const [source] = s.created.requests;
  assert.deepEqual([source.language, source.task.role], ['zh-CN', 'chinese-writer']);
  assert.ok(Object.hasOwn(requestPayload(source), 'handoff'));
  await s.complete(source, s.view('zh-CN'));
  const [translation] = createReadingFirstDraftRequests({ controller: s.created.controller });
  assert.deepEqual([translation.language, translation.task.role], ['en', 'translation']);
  const payload = requestPayload(translation);
  assert.equal(Object.hasOwn(payload, 'handoff'), false);
  assert.deepEqual(payload.source_view, s.view('zh-CN'));
  assert.deepEqual(payload.translation_context.terminology, []);
  await s.complete(translation, s.view('en'));
  const rendered = await renderReaderNotes({ input: { profile: READING_FIRST_PROFILE, controller: s.created.controller } });
  assert.match(rendered.notes.find(item => item.language === 'zh-CN').path, /^Wiki\/sources\//);
  assert.match(rendered.notes.find(item => item.language === 'en').path, /^Wiki\/translations\//);
});

test('translation output must mirror the source sections', async t => {
  const s = await setup(t, { writingMode: 'source-translation', presentation: modulePresentation() });
  await s.complete(s.created.requests[0], moduleView('en'));
  const [request] = createReadingFirstDraftRequests({ controller: s.created.controller });
  await assert.rejects(() => s.complete(request, moduleView('zh-CN', ['design-overview'])), /READING_FIRST_VIEW_LAYOUT_INVALID/);
  await assert.rejects(() => s.complete(request, moduleView('zh-CN', ['design-overview', 'design-steps', 'design-extra'])), /READING_FIRST_VIEW_LAYOUT_INVALID/);
  await assert.rejects(() => s.complete(request, { ...moduleView('zh-CN'), placements: { visuals: [], knowledge: [] } }), /READING_FIRST_VIEW_LAYOUT_INVALID/);
  await assert.rejects(() => readFile(join(s.root, 'zh-CN.json')), /ENOENT/);
  assert.equal((await s.complete(request, moduleView('zh-CN'))).status, 'pending_review');
});

test('existing writing modes keep byte-identical requests', async t => {
  for (const writingMode of ['independent', 'source-first']) {
    const s = await setup(t, { writingMode });
    const issued = [...s.created.requests];
    if (writingMode === 'source-first') {
      await s.complete(issued[0], s.view('en'));
      issued.push(...createReadingFirstDraftRequests({ controller: s.created.controller }));
    }
    assert.deepEqual(issued.map(item => item.language), ['en', 'zh-CN']);
    for (const request of issued) {
      const { instruction_fingerprint, configuration_fingerprint, message } = maskedRequest(s, request);
      assert.deepEqual({ instruction_fingerprint, configuration_fingerprint }, EXISTING_MODE_WRITERS[writingMode + ':' + request.language]);
      assert.doesNotMatch(message, /translation-1\.0|translation_context/);
      assert.equal(Object.hasOwn(request.packet.backend.configuration, 'translation'), false);
    }
    assert.equal(Object.hasOwn(snapshotReadingFirstRuntime(s.created.controller).state, 'translationNote'), false);
  }
});

test('source-translation binding freezes the translation profile and keeps the source language first', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reading-first-translation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('Synthetic original source.');
  await writeFile(join(root, 'source.pdf'), bytes);
  const mainSession = { model: 'gpt-6-astra', reasoning_effort: 'high' };
  const options = { runId: 'run', scientificInput: { identity: { paper_id: 'synthetic', run_id: 'run' }, sources: [{ path: join(root, 'source.pdf'), sha256: sha(bytes), byte_length: bytes.length }], context: 'Read all existing material as a connected account.', role_artifacts: roles }, mainSession, authorizationId: 'synthetic-only', deadline: '2099-01-01T00:00:00Z', taskBindings: {} };
  const pair = { model: 'gpt-6-astra', reasoning_effort: 'high' };
  const legacyRoles = Object.fromEntries(['evidence', 'methods', 'results', 'interpretation', 'scientific-reading', 'integration', 'english-writer', 'chinese-writer', 'reading-editor', 'independent-verifier'].map(role => [role, pair]));
  const configured = roles => ({ role_model_policy: createConfiguredApaRoleModelPolicy(mainSession, roles), ...buildConfiguredReadingInstructions({}, {instructionProfile:'configured-reading-1.0'}) });
  const translating = { ...options, writingMode: 'source-translation', configuredSetup: configured({ ...legacyRoles, translation: pair }) };
  const binding = createReadingFirstRunControl({ ...translating, sourceLanguage: 'zh-CN' }).reading_first_binding;
  assert.deepEqual([binding.writing_mode, binding.source_language, binding.translation_profile], ['source-translation', 'zh-CN', 'translation-1.0']);
  assert.equal(createReadingFirstRunControl({ ...translating, sourceLanguage: 'en', firstWritingLanguage: 'en' }).reading_first_binding.first_writing_language, 'en');
  assert.throws(() => createReadingFirstRunControl({ ...translating, sourceLanguage: 'en', firstWritingLanguage: 'zh-CN' }), /READING_FIRST_WRITING_MODE_INVALID/);
  assert.throws(() => createReadingFirstRunControl({ ...options, writingMode: 'source-translation' }), /READING_FIRST_WRITING_MODE_INVALID/);
  for (const writingMode of ['independent', 'source-first']) assert.equal(Object.hasOwn(createReadingFirstRunControl({ ...options, writingMode }).reading_first_binding, 'translation_profile'), false);
  assert.throws(() => createReadingFirstRunControl({ ...options, writingMode: 'source-translation', configuredSetup: configured(legacyRoles) }), /READING_FIRST_TRANSLATION_MODEL_REQUIRED/);
  assert.equal(createReadingFirstRunControl({ ...options, writingMode: 'source-first', configuredSetup: configured(legacyRoles) }).reading_first_binding.writing_mode, 'source-first');
});

// Simulates an edit of the note by wrapping the file read; the repository file itself is never touched.
function changeTranslationNote(t) {
  const original = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (path, ...rest) {
    const bytes = original.call(this, path, ...rest);
    return String(path?.href ?? path).endsWith('translation-1.0.md') ? Buffer.concat([Buffer.from(bytes), Buffer.from('\nChanged.')]) : bytes;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}
test('translation note is captured in state, restored from the checkpoint and checked for drift', async t => {
  const s = await setup(t, { writingMode: 'source-translation' });
  const note = await readFile(translationNoteUrl);
  await s.complete(s.created.requests[0], s.view('en'));
  const [pending] = createReadingFirstDraftRequests({ controller: s.created.controller });
  const saved = snapshotReadingFirstRuntime(s.created.controller);
  assert.deepEqual(saved.state.translationNote, { profile: 'translation-1.0', sha256: sha(note), byte_length: note.length });
  const receipt = await commitOwnedArtifact({ artifactRoot: s.root, dispatchContext: s.broker.dispatchContext,
    capability: s.broker.issueCapability({ runId: 'run', actorId: 'controller', role: 'control', artifactPath: 'checkpoint.json', revision: '1' }),
    artifact: { artifact_id: 'checkpoint', content: JSON.stringify(saved) }, expectedRevision: '1' });
  const recovered = await restoreReadingFirstRuntime({ handoff: s.handoff, runControl: s.runControl, checkpointReceipt: receipt });
  assert.equal(recovered.ok, true, JSON.stringify(recovered.errors));
  assert.deepEqual(recovered.requests.map(item => item.emittedStep), [pending.emittedStep]);
  assert.deepEqual(snapshotReadingFirstRuntime(recovered.controller), saved);
  changeTranslationNote(t);
  assert.throws(() => snapshotReadingFirstRuntime(s.created.controller), /READING_FIRST_TRANSLATION_NOTE_CHANGED/);
  assert.throws(() => snapshotReadingFirstRuntime(recovered.controller), /READING_FIRST_TRANSLATION_NOTE_CHANGED/);
});

// Drives a run to a first review whose single material issue concerns `affected` languages.
// Sections are numbered so a translation can be checked against the source draft it was given; the review issue carries the Writer owner a configured run requires.
const plainView = (language, count = 1) => ({ language, sections: Array.from({ length: count }, (_, index) => ({ heading: (language === 'en' ? 'Study ' : '研究 ') + index, paragraphs: ['Body.'] })) });
async function reviewedRun(t, options, affected) {
  const { view = plainView, ...setupOptions } = options;
  const s = await setup(t, setupOptions);
  const controller = s.created.controller;
  const drafts = [...s.created.requests];
  for (let i = 0; i < drafts.length; i++) {
    await s.complete(drafts[i], view(drafts[i].language));
    if (drafts.length === 1) drafts.push(...createReadingFirstDraftRequests({ controller }));
  }
  const rendered = await renderReaderNotes({ input: { profile: READING_FIRST_PROFILE, controller } });
  const material = { overall: { complete: false, coherent: true, bilingual_consistent: true }, key_nodes: [], issues: [{ severity: 'material', kind: 'omission', detail: 'Missing design explanation', affected_languages: affected, repair_owner: 'writer' }], scope: 'whole account' };
  await s.complete(createReadingFirstReviewRequest({ controller, presentation: rendered }), material);
  return { s, controller };
}
const verdictComplete = { overall: { complete: true, coherent: true, bilingual_consistent: true }, key_nodes: [{ kind: 'main_conclusion', location: 'source', finding: 'supported' }, { kind: 'key_design', location: 'source', finding: 'supported' }], issues: [], scope: 'only repaired context' };
const finishLocalReview = async ({ s, controller }) => {
  const rendered = await renderReaderNotes({ input: { profile: READING_FIRST_PROFILE, controller } });
  await s.complete(createReadingFirstReviewRequest({ controller, presentation: rendered }), verdictComplete);
};

test('translation-only issues revise only the translation', async t => {
  const { s, controller } = await reviewedRun(t, { writingMode: 'source-translation' }, ['zh-CN']);
  const requests = createReadingFirstRevisionRequests({ controller });
  assert.deepEqual(requests.map(item => [item.task.task_id, item.language, item.task.role, item.packet.host_action_scope.role]), [['zh-CN-r2', 'zh-CN', 'translation', 'translation']]);
  const payload = requestPayload(requests[0]);
  assert.equal(Object.hasOwn(payload, 'handoff'), false);
  assert.deepEqual(payload.source_view, plainView('en'));
  assert.equal(payload.source_view_receipt.artifact_id, 'en');
  assert.deepEqual(payload.prior_view, plainView('zh-CN'));
  assert.equal(payload.issues.length, 1);
  assert.equal(typeof payload.revision_scope, 'string');
  assert.deepEqual(payload.translation_context.terminology, []);
  assert.match(requests[0].emittedStep.arguments.message, /Translation: translation-1\.0/);
  assert.doesNotMatch(requests[0].emittedStep.arguments.message, /Full connected science for/);
  assert.throws(() => createReadingFirstRevisionRequests({ controller }), /READING_FIRST_REVISION_UNAVAILABLE/);
  await assert.rejects(() => s.complete(requests[0], plainView('zh-CN', 2)), /READING_FIRST_VIEW_LAYOUT_INVALID/);
  await s.complete(requests[0], plainView('zh-CN'));
  await finishLocalReview({ s, controller });
  assert.equal(getReadingFirstState(controller).calls_used, 5);
  assert.equal(getReadingFirstState(controller).status, 'reading_complete');
});

test('source issues revise the source first, then retranslate', async t => {
  const { s, controller } = await reviewedRun(t, { writingMode: 'source-translation' }, ['en']);
  const first = createReadingFirstRevisionRequests({ controller });
  assert.deepEqual(first.map(item => [item.task.task_id, item.task.role]), [['en-r2', 'english-writer']]);
  assert.ok(Object.hasOwn(requestPayload(first[0]), 'handoff'));
  await s.complete(first[0], plainView('en', 2));
  const second = createReadingFirstRevisionRequests({ controller });
  assert.deepEqual(second.map(item => [item.task.task_id, item.language, item.task.role]), [['zh-CN-r2', 'zh-CN', 'translation']]);
  const payload = requestPayload(second[0]);
  assert.equal(Object.hasOwn(payload, 'handoff'), false);
  assert.deepEqual(payload.source_view, plainView('en', 2));
  assert.equal(payload.source_view_receipt.artifact_id, 'en-r2');
  assert.deepEqual(payload.prior_view, plainView('zh-CN'));
  assert.equal(payload.issues.length, 1);
  // The mirror is checked against the re-accepted source view, not the first one.
  await assert.rejects(() => s.complete(second[0], plainView('zh-CN')), /READING_FIRST_VIEW_LAYOUT_INVALID/);
  await s.complete(second[0], plainView('zh-CN', 2));
  await finishLocalReview({ s, controller });
  assert.equal(getReadingFirstState(controller).calls_used, 6);
  assert.equal(getReadingFirstState(controller).review_rounds, 2);
  assert.equal(getReadingFirstState(controller).status, 'reading_complete');
});

test('translation revision waits for the pending source revision', async t => {
  const { controller } = await reviewedRun(t, { writingMode: 'source-translation' }, ['en', 'zh-CN']);
  const [first] = createReadingFirstRevisionRequests({ controller });
  assert.equal(first.task.task_id, 'en-r2');
  assert.throws(() => createReadingFirstRevisionRequests({ controller }), /READING_FIRST_SOURCE_DRAFT_PENDING/);
});

test('chinese source papers revise the Chinese Writer first, then the English translation', async t => {
  const { s, controller } = await reviewedRun(t, { writingMode: 'source-translation', sourceLanguage: 'zh-CN' }, ['zh-CN']);
  const [first] = createReadingFirstRevisionRequests({ controller });
  assert.deepEqual([first.task.task_id, first.task.role], ['zh-CN-r2', 'chinese-writer']);
  await s.complete(first, { language: 'zh-CN', sections: [{ heading: 'Revised', paragraphs: ['Revised.'] }] });
  const [second] = createReadingFirstRevisionRequests({ controller });
  assert.deepEqual([second.task.task_id, second.task.role], ['en-r2', 'translation']);
  assert.equal(requestPayload(second).source_view_receipt.artifact_id, 'zh-CN-r2');
});

// Fingerprints of masked en-r2 Writer revision requests, captured from the code before translation revisions existed (2026-10-29).
const EXISTING_MODE_REVISIONS = {
  'independent:en-r2': { instruction_fingerprint: 'sha256:9eac1029610b2655cacc3f98669f8983dbdeb63b9d9065a12994e9271d4501fc', configuration_fingerprint: 'sha256:7e3a2ddf3524729b9d45ae8a47b904fc7d126bd790efe69fe1314f472d7ebd1b' },
  'source-first:en-r2': { instruction_fingerprint: 'sha256:9eac1029610b2655cacc3f98669f8983dbdeb63b9d9065a12994e9271d4501fc', configuration_fingerprint: 'sha256:7e3a2ddf3524729b9d45ae8a47b904fc7d126bd790efe69fe1314f472d7ebd1b' },
};
test('existing writing modes keep byte-identical Writer revision requests', async t => {
  for (const writingMode of ['independent', 'source-first']) {
    const { s, controller } = await reviewedRun(t, { writingMode }, ['en']);
    const [request] = createReadingFirstRevisionRequests({ controller });
    assert.deepEqual([request.task.task_id, request.task.role], ['en-r2', 'english-writer']);
    const { instruction_fingerprint, configuration_fingerprint, message } = maskedRequest(s, request);
    assert.deepEqual({ instruction_fingerprint, configuration_fingerprint }, EXISTING_MODE_REVISIONS[writingMode + ':en-r2']);
    assert.doesNotMatch(message, /translation-1\.0|translation_context/);
  }
});


test('2.2 reading runtime uses frozen configured rules and keeps unknown receipts unobserved', async t => {
  const s = await setup(t, {writingMode:'source-translation',instructionProfile:'configured-reading-2.2',maxTotalCalls:8});
  const {controller,requests:[request]} = s.created;
  assert.equal(readingApi.snapshotReadingFirstRuntime(controller).prompt_fingerprint, fingerprintReadingFirst(s.binding.configured_setup.prompt_files));
  readingApi.recordReadingFirstRequestEvent({controller,request,eventKey:'intent',payload:{action_id:request.emittedStep.action_id}});
  const unknown = {status:'observed',raw_result_text:''};
  const recorded = readingApi.recordReadingFirstRequestEvent({controller,request,eventKey:'host_observation',payload:unknown});
  assert.equal(recorded.payload.status,'outcome_unknown');
  assert.equal(readingApi.snapshotReadingFirstRuntime(controller).state.executionLedger[0].status,'issued');
  const raw = '{"agent_id":"synthetic"}', path=join(s.root,'host.txt');
  await writeFile(path,raw);
  const observed={status:'observed',raw_result_text:raw,evidence:{kind:'raw',capture:'direct',source_reference:path,sha256:createHash('sha256').update(raw).digest('hex')}};
  readingApi.recordReadingFirstRequestEvent({controller,request,eventKey:'host_observation',payload:observed});
  assert.equal(readingApi.snapshotReadingFirstRuntime(controller).state.executionLedger[0].status,'observed');
});

test('2.2 retains frozen support instructions when a runtime repair changes prompt files', async t => {
  const s = await setup(t, {writingMode:'source-translation',instructionProfile:'configured-reading-2.2',maxTotalCalls:8,
    roleReplyContract:getRoleReplyContract(),handoffProfile:SCIENCE_INDEX_PROFILE});
  const original=fs.readFileSync;
  fs.readFileSync=function(path,...args) {
    if (/science-index-1\.0\.md|role-reply-1\.0\.md|reading-editor-1\.3\.md/.test(String(path))) return Buffer.from('changed runtime prompt');
    return original.call(this,path,...args);
  };
  syncBuiltinESMExports();
  try {
    assert.doesNotThrow(()=>readingApi.getReadingFirstPendingRequests(s.created.controller));
    assert.equal(s.binding.configured_setup.frozen_support.science_index.metadata.profile,SCIENCE_INDEX_PROFILE);
  } finally {fs.readFileSync=original;syncBuiltinESMExports();}
});
