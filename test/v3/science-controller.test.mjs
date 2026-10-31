import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { getReadingBudgetSummary as readingApiBudget, createReadingFirstRunControl, acceptReadingFirstResult, getReadingFirstState, restoreReadingFirstRuntime, snapshotReadingFirstRuntime, createReadingFirstDraftRequests, handleReadingCompactionBoundary } from '../../scripts/v3/reading-first-runtime.mjs';
import { commitOwnedArtifact } from '../../scripts/v3/owned-artifact-store.mjs';
import { createApaRoleModelPolicy } from '../../scripts/apa-model-policy.mjs';
import { buildConfiguredReadingInstructions, prepareConfiguredReading, getConfiguredReadingDispatchArguments } from '../../scripts/v3/configured-reading.mjs';
import * as scienceApi from '../../scripts/v3/science-controller.mjs';
import * as readingApi from '../../scripts/v3/reading-first-runtime.mjs';
import { COMPACTION_POLICY, compactionControlBindings } from '../../scripts/v3/reading-compaction.mjs';
import { createScienceController, restoreScienceController, getScienceState, prepareScienceRequests, prepareScienceCorrection, recordScienceDispatchIntent, recordScienceHostObservation, acceptScienceResult, getScienceRequest, createScienceHandoff, recordScienceCompactionBoundary } from '../../scripts/v3/science-controller.mjs';
import { ingestObservedRunStep } from '../../scripts/v3/phase21-runner.mjs';
const roles = ['evidence','methods','results','interpretation','scientific-reading','integration'];
const sha = b => 'sha256:' + createHash('sha256').update(b).digest('hex');

async function acceptCompactionBatch(f, controller) {
  for (const { role, request } of await prepareScienceRequests({ controller })) {
    const args = getConfiguredReadingDispatchArguments({ prepared: f.options.prepared, request });
    const intent = await recordScienceDispatchIntent({ controller, role });
    assert.deepEqual(intent.arguments, args);
    await recordScienceHostObservation({ controller, role, observation: { action_id: request.emittedStep.action_id, run_id: 'run',
      input_fingerprint: request.emittedStep.input_fingerprint, port: 'current-collaboration',
      tool_call: { name: request.emittedStep.action, arguments: args }, raw_result_text: JSON.stringify({ agent_id: 'host-' + role }) } });
    await writeFile(join(f.root, f.tasks[role].native_path), JSON.stringify({ role, text: 'accepted source' }));
    await acceptScienceResult({ controller, role });
  }
}

test('new science boundaries block dispatch until evaluated and retain the pause across restore', async t => {
  const f = await fixture(t, { compactionPolicy: COMPACTION_POLICY });
  let controller = await createScienceController(f.options);
  await acceptCompactionBatch(f, controller);
  await assert.rejects(() => prepareScienceRequests({ controller }), /APA_COMPACTION_BOUNDARY_REQUIRED/);
  const firstPause = await scienceApi.handleScienceCompactionBoundary({ controller });
  assert.equal(firstPause.action, 'await-user');
  await assert.rejects(() => prepareScienceRequests({ controller }), /APA_COMPACTION_AWAITING_USER/);
  const skipped = await scienceApi.handleScienceCompactionBoundary({ controller, userDecision: 'skip' });
  assert.equal(skipped.action, 'continue');
  assert.equal(getScienceState(controller).compaction_boundary.reminder.status, 'skipped');
  await acceptCompactionBatch(f, controller);
  const at = new Date().toISOString();
  const input = { controller, sessionId: 'main', observation: { session_id: 'main', observed_at: at,
    manual_compaction: { available: true, method: 'compact in host', source: 'host tool contract' },
    context: { tokens: 190000, kind: 'current-context', measured_at: at, fresh: true, source: 'host meter' } },
    progress: { remaining_work: { multiple_responses: true, reason: 'Science and writing remain.' }, growth: { substantial: true, reason: 'Methods and Results added evidence.' } } };
  const pause = await scienceApi.handleScienceCompactionBoundary(input);
  assert.equal(pause.action, 'await-user');
  assert.match(pause.message, /compact in host/);
  const before = getScienceState(controller);
  await assert.rejects(() => prepareScienceRequests({ controller }), /APA_COMPACTION_AWAITING_USER/);
  const restored = await restoreScienceController(f.options); controller = restored;
  assert.equal((await scienceApi.handleScienceCompactionBoundary({ controller })).action, 'await-user');
  await assert.rejects(() => recordScienceCompactionBoundary({ controller, id: 'methods-results-accepted', status: 'skipped', reason: 'bypass' }), /APA_COMPACTION_POLICY_DECISION_REQUIRED/);
  const resumed = await scienceApi.handleScienceCompactionBoundary({ controller, userDecision: 'continue' });
  assert.equal(resumed.action, 'continue');
  assert.equal(resumed.record.compaction_verified, false);
  const after = getScienceState(controller);
  assert.equal(after.reserved_calls, before.reserved_calls);
  assert.equal(after.deadline, before.deadline);
  assert.deepEqual(after.roles, before.roles);
  assert.deepEqual((await prepareScienceRequests({ controller })).map(row => row.role), ['interpretation']);
});

test('a live science process continues after skip and carries reminder history into Writer', async t => {
  const f = await fixture(t, { compactionPolicy: COMPACTION_POLICY });
  const controller = await createScienceController(f.options);
  await acceptCompactionBatch(f, controller);
  const at = new Date().toISOString();
  const pause = await scienceApi.handleScienceCompactionBoundary({ controller, sessionId: 'main',
    observation: { session_id: 'main', observed_at: at,
      manual_compaction: { available: true, method: 'host action', source: 'host contract' },
      context: { tokens: 180000, kind: 'current-context', measured_at: at, fresh: true, source: 'meter' } },
    progress: { remaining_work: { multiple_responses: true, reason: 'Science and writing remain.' }, growth: { substantial: true, reason: 'Evidence increased context.' } } });
  assert.equal(pause.action, 'await-user');
  const before = getScienceState(controller);
  assert.equal((await scienceApi.handleScienceCompactionBoundary({ controller, userDecision: 'skip' })).record.reason, 'user-skipped');
  assert.equal((await scienceApi.handleScienceCompactionBoundary({ controller })).record, null);
  assert.equal(getScienceState(controller).deadline, before.deadline);
  await acceptCompactionBatch(f, controller);
  assert.equal((await scienceApi.handleScienceCompactionBoundary({ controller })).action, 'await-user');
  await assert.rejects(() => prepareScienceRequests({ controller }), /APA_COMPACTION_AWAITING_USER/);
  assert.equal((await scienceApi.handleScienceCompactionBoundary({ controller, userDecision: 'skip' })).record.reason, 'user-skipped');
  for (let i = 0; i < 3; i++) await acceptCompactionBatch(f, controller);
  const created = await createScienceHandoff({ controller, checkpointTask: f.checkpointTask });
  const task = f.options.prepared.runControl.reading_first_binding.compaction_policy.checkpoints['before-writer'].decision;
  const decision = await handleReadingCompactionBoundary({ controller: created.controller, checkpointReceipt: created.checkpointReceipt,
    hostRequests: created.requests.map(request => ({ action_id: request.emittedStep.action_id, status: 'prepared' })),
    observation: { manual_compaction: { available: true, method: 'host action', source: 'host contract' } },
    capability: created.broker.issueCapability({ runId: 'run', actorId: 'controller', role: 'control', artifactPath: task.artifact_path, revision: task.revision }) });
  assert.equal(decision.action, 'await-user');
  assert.throws(() => getConfiguredReadingDispatchArguments({ prepared: f.options.prepared, request: created.requests[0] }), /APA_COMPACTION_AWAITING_USER/);
  const resume = f.options.prepared.runControl.reading_first_binding.compaction_policy.checkpoints['before-writer'].resume;
  const continued = await handleReadingCompactionBoundary({ controller: created.controller, checkpointReceipt: decision.receipt,
    hostRequests: created.requests.map(request => ({ action_id: request.emittedStep.action_id, status: 'prepared' })), userDecision: 'skip',
    capability: created.broker.issueCapability({ runId: 'run', actorId: 'controller', role: 'control', artifactPath: resume.artifact_path, revision: resume.revision }) });
  assert.equal(continued.record.reason, 'user-skipped');
  assert.deepEqual(getConfiguredReadingDispatchArguments({ prepared: f.options.prepared, request: created.requests[0] }), created.requests[0].emittedStep.arguments);
});

test('failed science reminder save never returns a prompt or unlocks a stale controller', async t => {
  const f = await fixture(t, { compactionPolicy: COMPACTION_POLICY });
  const controller = await createScienceController(f.options);
  await acceptCompactionBatch(f, controller);
  await assert.rejects(() => prepareScienceRequests({ controller }), /APA_COMPACTION_BOUNDARY_REQUIRED/);
  const stale = await restoreScienceController(f.options);
  await scienceApi.handleScienceCompactionBoundary({ controller });
  await assert.rejects(() => scienceApi.handleScienceCompactionBoundary({ controller: stale }), /SCIENCE_STATE_CONFLICT/);
  await assert.rejects(() => prepareScienceRequests({ controller: stale }), /SCIENCE_CONTROLLER_RESTORE_REQUIRED/);
});

async function fixture(t, { context = 'synthetic', compactionPolicy, promptFiles, instructionProfile, presentationMode } = {}) {
  const root = await mkdtemp(join(tmpdir(),'science-controller-')); t.after(() => rm(root,{recursive:true,force:true}));
  const source = Buffer.from('synthetic source'); await writeFile(join(root,'paper.pdf'),source);
  const tasks = Object.fromEntries(roles.map(role=>[role,{task_id:role,task_name:role.replace('-','_'),owner_actor_id:role,role,artifact_id:role,artifact_path:'science/'+role+'.json',native_path:'native/'+role+'.json',...(role==='evidence'?{instruction_path:'instructions/evidence.txt'}:{}),revision:'1'}]));
  const downstream = Object.fromEntries(['en','zh-CN','review'].map(key=>[key,{task_id:key,task_name:'writer_'+key.replace('-','_').toLowerCase(),owner_actor_id:key,role:key==='en'?'english-writer':key==='zh-CN'?'chinese-writer':'independent-verifier',artifact_id:key,artifact_path:'writer/'+key+'.json',native_path:'native/'+key+'.json',...(key==='en'?{instruction_path:'instructions/en.txt'}:{}),revision:'1'}]));
  if (presentationMode==='reading-editor') downstream.presentation={task_id:'presentation',task_name:'reading_editor',owner_actor_id:'presentation',role:'reading-editor',artifact_id:'presentation',artifact_path:'writer/presentation.json',native_path:'native/presentation.json',revision:'1'};
  const scientificInput = {profile:'reading-first-1.0',identity:{paper_id:'synthetic',run_id:'run'},sources:[{path:join(root,'paper.pdf'),sha256:sha(source),byte_length:source.length}],context,role_artifacts:roles};
  const mainSession={model:'gpt-6-astra',reasoning_effort:'high'};
  const configuredSetup={schema_version:'apa-configured-reading-1.0',config_fingerprint:sha(Buffer.from('config')),paths:{runRoot:root},role_model_policy:createApaRoleModelPolicy(mainSession),...buildConfiguredReadingInstructions({}),...(promptFiles ? {instruction_profile:instructionProfile ?? 'configured-reading-2.0',prompt_files:promptFiles} : {})};
  const runControl=createReadingFirstRunControl({runId:'run',scientificInput,mainSession,configuredSetup,authorizationId:'synthetic',deadline:'2099-01-01T00:00:00Z',taskBindings:downstream,writingMode:'source-first',maxCalls:6,priorCalls:6,maxTotalCalls:12,compactionPolicy,...(presentationMode ? {presentationMode} : {})});
  const prepared={runControl,scientificInput,configurationFingerprint:sha(Buffer.from('config')),paths:{runRoot:root}};
  const authorized_bindings=[...Object.values(tasks),...Object.values(downstream)].map(task=>({run_id:'run',actor_id:task.owner_actor_id,role:task.role,artifact_path:task.artifact_path,revision:task.revision}));
  const checkpointTask={artifact_id:'checkpoint',artifact_path:'control/checkpoint.json',revision:'1',owner_actor_id:'controller',role:'control'};
  authorized_bindings.push({run_id:'run',actor_id:'controller',role:'control',artifact_path:checkpointTask.artifact_path,revision:'1'});
  authorized_bindings.push({run_id:'run',actor_id:'controller',role:'control',artifact_path:'control/checkpoint-r2.json',revision:'2'});
  authorized_bindings.push(...compactionControlBindings(runControl));
  const brokerConfig={control_actor_id:'controller',artifact_root:root,authorized_bindings,run_controls:[runControl]};
  const options={prepared,tasks,brokerConfig,statePath:join(root,'state.json')};
  await mkdir(join(root,'native')); return {root,options,tasks,checkpointTask};
}

test('configured science freezes actual versioned prompt files and verifies them on restore', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'science-prompt-version-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const prompt = join(directory, 'science-configured-2.0.md'), bytes = Buffer.from('Synthetic versioned science contract.');
  await writeFile(prompt, bytes);
  const promptFiles = [{ path: prompt, sha256: sha(bytes), byte_length: bytes.length }];
  const f = await fixture(t, { promptFiles });
  await createScienceController(f.options);
  const saved = JSON.parse(await readFile(f.options.statePath, 'utf8'));
  assert.deepEqual(saved.data.prompt_files, promptFiles);
  assert.equal(Object.hasOwn(saved.data, 'prompt_sha256'), false);
  await restoreScienceController(f.options);
  await writeFile(prompt, 'Changed science contract.');
  await assert.rejects(() => restoreScienceController(f.options), /SCIENCE_PROMPT_CHANGED/);
});

test('science observations and progress updates are idempotent and reject conflicting event identities', async t => {
  const f = await fixture(t), controller = await createScienceController(f.options);
  const [{ request }] = await prepareScienceRequests({ controller });
  await recordScienceDispatchIntent({ controller, role: 'evidence' });
  const step = request.emittedStep;
  const observation = { action_id: step.action_id, run_id: 'run', input_fingerprint: step.input_fingerprint,
    port: 'current-collaboration', tool_call: { name: step.action, arguments: step.arguments }, raw_result_text: JSON.stringify({ agent_id: 'same-host-task' }) };
  const accepted = await recordScienceHostObservation({ controller, role: 'evidence', observation });
  const version = getScienceState(controller).version;
  assert.deepEqual(await recordScienceHostObservation({ controller, role: 'evidence', observation }), accepted);
  assert.equal(getScienceState(controller).version, version);
  const update = { kind: 'host_update', action_id: step.action_id, agent_id: 'same-host-task', host_event_id: 'progress-1',
    tool_call: { name: 'host.wait', arguments: { id: 'same-host-task' } }, raw_result_text: 'running' };
  await recordScienceHostObservation({ controller, role: 'evidence', observation: update });
  const restored = await restoreScienceController(f.options);
  await recordScienceHostObservation({ controller: restored, role: 'evidence', observation: update });
  assert.equal(getScienceRequest({ controller: restored, role: 'evidence' }).host_updates.length, 1);
  await assert.rejects(() => recordScienceHostObservation({ controller: restored, role: 'evidence', observation: { ...update, raw_result_text: 'different same event' } }), /SCIENCE_HOST_EVENT_CONFLICT/);
  await recordScienceHostObservation({ controller: restored, role: 'evidence', observation: { ...update, host_event_id: 'progress-2', raw_result_text: 'still running' } });
  assert.equal(getScienceRequest({ controller: restored, role: 'evidence' }).host_updates.length, 2);
  await assert.rejects(() => recordScienceHostObservation({ controller: restored, role: 'evidence', observation: { ...observation, raw_result_text: JSON.stringify({ agent_id: 'different' }) } }), /SCIENCE_HOST_EVENT_CONFLICT/);
});

async function failedFinalDispatch(t, { maxTotalCalls = 14, maxCalls = 6 } = {}) {
  const f = await fixture(t);
  f.options.prepared = structuredClone(f.options.prepared);
  f.options.prepared.runControl.reading_first_binding.max_total_calls = maxTotalCalls;
  f.options.prepared.runControl.reading_first_binding.max_calls = maxCalls;
  f.options.brokerConfig.run_controls = [f.options.prepared.runControl];
  let controller = await createScienceController(f.options);
  for (const batch of [['evidence'], ['methods', 'results'], ['interpretation'], ['scientific-reading'], ['integration']]) {
    const requests = await prepareScienceRequests({ controller });
    assert.deepEqual(requests.map(item => item.role), batch);
    for (const { role, request } of requests) {
      await recordScienceDispatchIntent({ controller, role });
      const step = request.emittedStep;
      const args = structuredClone(step.arguments);
      if (role === 'integration') args.message += ' accidental change';
      const observation = { action_id: step.action_id, run_id: 'run', input_fingerprint: step.input_fingerprint, port: 'current-collaboration', tool_call: { name: step.action, arguments: args }, raw_result_text: JSON.stringify({ agent_id: 'original-' + role }) };
      if (role === 'integration') {
        await assert.rejects(() => recordScienceHostObservation({ controller, role, observation }), /SCIENCE_OBSERVATION_INVALID/);
      } else {
        await recordScienceHostObservation({ controller, role, observation });
        await writeFile(join(f.root, f.tasks[role].native_path), JSON.stringify({ role, text: 'source' }));
        await acceptScienceResult({ controller, role });
      }
    }
  }
  controller = await restoreScienceController(f.options);
  const original = getScienceRequest({ controller, role: 'integration' });
  const task = { ...f.tasks.integration, task_id: 'integration-retry', task_name: 'integration_retry', native_path: 'native/integration-retry.json', instruction_path: 'instructions/integration-retry.txt' };
  const grant = { role: 'integration', task, authorizationId: 'explicit-correction', maxScienceCalls: 7, maxTotalCalls, deadline: '2099-01-01T00:00:00Z' };
  return { ...f, controller, original, grant };
}

test('science controller rejects non-text context before any science request', async t => {
  const f = await fixture(t, { context: { source_scope: 'object context' } });
  await assert.rejects(() => createScienceController(f.options), /READING_FIRST_CONTEXT_TEXT_REQUIRED/);
  await assert.rejects(() => readFile(f.options.statePath), { code: 'ENOENT' });
});

test('a role naming the committed registry input is not emitted or dispatched before that file exists', async t => {
  const f = await fixture(t);
  const registry = 'inputs/committed-knowledge-registry.json';
  f.options.payloads = { methods: { committed_knowledge_registry: registry } };
  let controller = await createScienceController(f.options);
  const [{ request }] = await prepareScienceRequests({ controller });
  await recordScienceDispatchIntent({ controller, role: 'evidence' });
  const step = request.emittedStep;
  await recordScienceHostObservation({ controller, role: 'evidence', observation: { action_id: step.action_id, run_id: 'run', input_fingerprint: step.input_fingerprint, port: 'current-collaboration', tool_call: { name: step.action, arguments: step.arguments }, raw_result_text: JSON.stringify({ agent_id: 'evidence-agent' }) } });
  await writeFile(join(f.root, f.tasks.evidence.native_path), JSON.stringify({ role: 'evidence', text: 'source' }));
  await acceptScienceResult({ controller, role: 'evidence' });
  await assert.rejects(() => prepareScienceRequests({ controller }), /SCIENCE_KNOWLEDGE_REGISTRY_INPUT_REQUIRED/);
  assert.equal(getScienceState(controller).roles.methods.status, 'waiting');
  await mkdir(join(f.root, 'inputs'));
  await writeFile(join(f.root, registry), '[]');
  assert.deepEqual((await prepareScienceRequests({ controller })).map(item => item.role), ['methods', 'results']);
  // The precondition is checked again at the dispatch boundary.
  await rm(join(f.root, registry));
  controller = await restoreScienceController(f.options);
  await assert.rejects(() => recordScienceDispatchIntent({ controller, role: 'methods' }), /SCIENCE_KNOWLEDGE_REGISTRY_INPUT_REQUIRED/);
  await recordScienceDispatchIntent({ controller, role: 'results' });
  await writeFile(join(f.root, registry), '[]');
  await recordScienceDispatchIntent({ controller, role: 'methods' });
});

test('authorized correction retains a rejected original, counts both calls, and survives restore', async t => {
  const f = await failedFinalDispatch(t);
  assert.equal(getScienceState(f.controller).reserved_calls, 6);
  const originalReceipts = Object.fromEntries(roles.slice(0, 5).map(role => [role, getScienceState(f.controller).roles[role].receipt]));
  await assert.rejects(() => prepareScienceCorrection({ controller: f.controller, ...f.grant, authorizationId: '' }), /SCIENCE_CORRECTION_UNAUTHORIZED/);
  await assert.rejects(() => prepareScienceCorrection({ controller: f.controller, ...f.grant, authorizationId: 'synthetic' }), /SCIENCE_CORRECTION_UNAUTHORIZED/);
  await assert.rejects(() => prepareScienceCorrection({ controller: f.controller, ...f.grant, maxScienceCalls: 6 }), /SCIENCE_CORRECTION_UNAUTHORIZED/);
  await assert.rejects(() => prepareScienceCorrection({ controller: f.controller, ...f.grant, maxTotalCalls: 15 }), /SCIENCE_CORRECTION_UNAUTHORIZED/);
  await assert.rejects(() => prepareScienceCorrection({ controller: f.controller, ...f.grant, deadline: '2098-01-01T00:00:00Z' }), /SCIENCE_CORRECTION_UNAUTHORIZED/);
  await assert.rejects(() => prepareScienceCorrection({ controller: f.controller, ...f.grant, task: { ...f.grant.task, native_path: f.tasks.evidence.native_path } }), /SCIENCE_CORRECTION_TASK_INVALID/);
  await assert.rejects(() => prepareScienceCorrection({ controller: f.controller, ...f.grant, task: { ...f.grant.task, owner_actor_id: 'another-owner' } }), /SCIENCE_CORRECTION_TASK_INVALID/);
  await assert.rejects(() => prepareScienceCorrection({ controller: f.controller, ...f.grant, role: 'evidence' }), /SCIENCE_CORRECTION_UNAVAILABLE/);
  await prepareScienceCorrection({ controller: f.controller, ...f.grant });
  await assert.rejects(() => prepareScienceCorrection({ controller: f.controller, ...f.grant }), /SCIENCE_CORRECTION_UNAVAILABLE/);
  let controller = await restoreScienceController(f.options);
  const [{ role, request }] = await prepareScienceRequests({ controller });
  assert.equal(role, 'integration');
  assert.equal(request.emittedStep.arguments.task_name, 'integration_retry');
  assert.equal(request.packet.requested_model, f.original.request.packet.requested_model);
  assert.equal(request.emittedStep.arguments.reasoning_effort, f.original.request.emittedStep.arguments.reasoning_effort);
  assert.deepEqual(request.packet.source, f.original.request.packet.source);
  const intent = await recordScienceDispatchIntent({ controller, role });
  assert.equal(getScienceState(controller).reserved_calls, 7);
  controller = await restoreScienceController(f.options);
  assert.deepEqual(await prepareScienceRequests({ controller }), []);
  const resumed = getScienceRequest({ controller, role });
  assert.deepEqual(resumed.intent, intent);
  assert.deepEqual(resumed.original, f.original);
  const step = request.emittedStep;
  await recordScienceHostObservation({ controller, role, observation: { action_id: step.action_id, run_id: 'run', input_fingerprint: step.input_fingerprint, port: 'current-collaboration', tool_call: { name: step.action, arguments: step.arguments }, raw_result_text: JSON.stringify({ agent_id: 'corrected-integration' }) } });
  await writeFile(join(f.root, f.grant.task.native_path), JSON.stringify({ role, text: 'new genuine result' }));
  const receipt = await acceptScienceResult({ controller, role });
  assert.equal(receipt.artifact_id, f.tasks.integration.artifact_id);
  assert.equal(getScienceState(controller).accepted_results, 6);
  for (const role of roles.slice(0, 5)) assert.deepEqual(getScienceState(controller).roles[role].receipt, originalReceipts[role]);
  controller = await restoreScienceController(f.options);
  assert.equal(getScienceState(controller).reserved_calls, 7);
  assert.equal(getScienceState(controller).accepted_results, 6);
  const disk = JSON.parse(await readFile(f.options.statePath, 'utf8')).data;
  assert.deepEqual(disk.entries.integration.request, f.original.request);
  assert.deepEqual(disk.entries.integration.intent, f.original.intent);
  assert.deepEqual(disk.entries.integration.observations, f.original.observations);
  assert.equal(disk.entries.integration.observation.blocked_reason, 'OBSERVATION_CORRELATION_MISMATCH');
  await assert.rejects(() => createScienceHandoff({ controller, checkpointTask: f.checkpointTask }), /SCIENCE_READING_BUDGET_REBIND_REQUIRED/);
});

test('correction is rejected when its budget or original deadline cannot cover reading', async t => {
  const f = await failedFinalDispatch(t, { maxTotalCalls: 9, maxCalls: 3 });
  await assert.rejects(() => prepareScienceCorrection({ controller: f.controller, ...f.grant }), /SCIENCE_CORRECTION_UNAUTHORIZED/);
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2099-01-01T00:00:00Z') });
  await assert.rejects(() => prepareScienceCorrection({ controller: f.controller, ...f.grant }), /SCIENCE_DEADLINE_EXPIRED/);
});
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

test('restore preserves a historical source-metadata rejection and accepts a newly correlated original return', async t => {
  const f = await fixture(t);
  f.options.prepared = structuredClone(f.options.prepared);
  const source = f.options.prepared.scientificInput.sources[0];
  Object.assign(source, { id: 'main', kind: 'main' });
  f.options.prepared.runControl.reading_first_binding.input_fingerprint = (await import('../../scripts/v3/reading-first-runtime.mjs')).fingerprintReadingFirst(f.options.prepared.scientificInput);
  f.options.brokerConfig.run_controls = [f.options.prepared.runControl];
  let controller = await createScienceController(f.options);
  const [{ request }] = await prepareScienceRequests({ controller });
  await recordScienceDispatchIntent({ controller, role: 'evidence' });
  const step = request.emittedStep;
  const observation = { action_id: step.action_id, run_id: 'run', input_fingerprint: step.input_fingerprint, port: 'current-collaboration', tool_call: { name: step.action, arguments: step.arguments }, raw_result_text: JSON.stringify({ agent_id: 'original-evidence' }) };
  const historical = ingestObservedRunStep({ packet: request.packet, emittedStep: step, observation, run: { run_id: 'run' }, legacySourceComparison: true });
  assert.equal(historical.status, 'blocked');
  const saved = JSON.parse(await readFile(f.options.statePath, 'utf8'));
  Object.assign(saved.data.entries.evidence, { raw_observation: observation, observation: historical, observations: [{ raw: observation, validated: historical }] });
  const { fingerprintReadingFirst } = await import('../../scripts/v3/reading-first-runtime.mjs');
  saved.fingerprint = fingerprintReadingFirst(saved.data);
  await writeFile(f.options.statePath, JSON.stringify(saved));
  controller = await restoreScienceController(f.options);
  const accepted = await recordScienceHostObservation({ controller, role: 'evidence', observation });
  assert.equal(accepted.status, 'observed');
  const actual = getScienceRequest({ controller, role: 'evidence' });
  assert.equal(actual.observations.length, 2);
  assert.equal(actual.observations[0].validated.status, 'blocked');
  assert.equal(actual.observations[1].validated.agent_id, 'original-evidence');
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
  assert.equal(getScienceState(recovered).compaction_boundary.id, 'evidence-accepted');
  assert.equal(getScienceState(recovered).compaction_boundary.recovery.saved, true);
  await recordScienceCompactionBoundary({ controller: recovered, id: 'evidence-accepted', status: 'skipped', reason: 'context unknown' });
  const restoredAgain=await restoreScienceController(f.options);
  assert.equal(getScienceState(restoredAgain).compaction_boundary.reminder.status, 'skipped');
  await assert.rejects(() => recordScienceCompactionBoundary({ controller: restoredAgain, id: 'evidence-accepted', status: 'prompted', reason: 'again' }), /SCIENCE_COMPACTION_ALREADY_RECORDED/);
  assert.deepEqual((await prepareScienceRequests({controller:recovered})).map(row=>row.role),['methods','results']);
});

test('handoff is gated by six owned results and restores the same Writer action', async t => {
  const f=await fixture(t); let controller=await createScienceController(f.options);
  await assert.rejects(()=>createScienceHandoff({controller,checkpointTask:f.checkpointTask}),/SCIENCE_HANDOFF_INCOMPLETE/);
  for (const batch of [['evidence'],['methods','results'],['interpretation'],['scientific-reading'],['integration']]) {
    const requests=await prepareScienceRequests({controller}); assert.deepEqual(requests.map(row=>row.role),batch);
    for (const {role,request} of requests) {
      await recordScienceDispatchIntent({controller,role}); const step=request.emittedStep;
      if (role === 'methods') {
        assert.equal(getScienceState(controller).roles.methods.status,'outcome_unknown');
        assert.equal(getScienceState(controller).compaction_boundary,null);
        await assert.rejects(() => recordScienceCompactionBoundary({controller,id:'evidence-accepted',status:'prompted',reason:'unsafe while task may run'}), /SCIENCE_COMPACTION_UNAVAILABLE/);
      }
      await recordScienceHostObservation({controller,role,observation:{action_id:step.action_id,run_id:'run',input_fingerprint:step.input_fingerprint,port:'current-collaboration',tool_call:{name:step.action,arguments:step.arguments},raw_result_text:JSON.stringify({agent_id:'synthetic-'+role})}});
      if (role === 'methods') {
        assert.equal(getScienceState(controller).roles.methods.status,'observed');
        await assert.rejects(() => recordScienceCompactionBoundary({controller,id:'methods-results-accepted',status:'prompted',reason:'task lacks receipt'}), /SCIENCE_COMPACTION_UNAVAILABLE/);
      }
      await writeFile(join(f.root,f.tasks[role].native_path),JSON.stringify({role,text:'synthetic result'}));
      await acceptScienceResult({controller,role});
    }
    if (batch[0] === 'evidence') await recordScienceCompactionBoundary({controller,id:'evidence-accepted',status:'skipped',reason:'context unknown'});
    if (batch[0] === 'methods') {
      const boundary=getScienceState(controller).compaction_boundary;
      assert.equal(boundary.id,'methods-results-accepted');
      assert.equal(boundary.running_count,0);
      assert.equal(boundary.recovery.saved,true);
      await recordScienceCompactionBoundary({controller,id:boundary.id,status:'skipped',reason:'context unknown'});
    }
    controller=await restoreScienceController(f.options);
    if (batch[0] === 'methods') {
      assert.equal(getScienceState(controller).compaction_boundary.reminder.status,'skipped');
      await assert.rejects(() => recordScienceCompactionBoundary({controller,id:'methods-results-accepted',status:'prompted',reason:'again'}),/SCIENCE_COMPACTION_ALREADY_RECORDED/);
    }
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
  assert.equal(snapshotReadingFirstRuntime(downstream.controller).state.compaction_reminders['evidence-accepted'].status,'skipped');
  assert.equal(snapshotReadingFirstRuntime(downstream.controller).state.compaction_reminders['methods-results-accepted'].status,'skipped');
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
  const brokerConfig={...f.options.brokerConfig,artifact_root:prepared.paths.runRoot,authorized_bindings:[...f.options.brokerConfig.authorized_bindings,...prepared.compactionControlBindings],run_controls:[prepared.runControl]};
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
  const brokerConfig={...f.options.brokerConfig,artifact_root:prepared.paths.runRoot,authorized_bindings:[...f.options.brokerConfig.authorized_bindings,...prepared.compactionControlBindings],run_controls:[prepared.runControl]};
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


test('2.1 science continuations survive restore and carry their occupied budget into reading', async t => {
  const directory=await mkdtemp(join(tmpdir(),'science-budget-')); t.after(()=>rm(directory,{recursive:true,force:true}));
  const prompt=join(directory,'prompt.md'), bytes=Buffer.from('Synthetic science contract'); await writeFile(prompt,bytes);
  const f=await fixture(t,{promptFiles:[{path:prompt,sha256:sha(bytes),byte_length:bytes.length}],instructionProfile:'configured-reading-2.1'});
  let controller=await createScienceController(f.options);
  assert.equal(scienceApi.getScienceComputerControlReport({controller}).coverage,'unknown');
  const observation={event_id:'desktop-1',coverage:'partial',operations:[{operation:'read',application:'browser',tool_call:{name:'browser.read',arguments:{tab:'one'}},raw_result_text:'visible',occurred_at:'2026-10-31T00:00:00Z'}],source_reference:'host evidence'};
  await scienceApi.recordScienceComputerControlObservation({controller,observation});
  await scienceApi.recordScienceComputerControlObservation({controller,observation});
  await assert.rejects(()=>scienceApi.recordScienceComputerControlObservation({controller,observation:{...observation,coverage:'complete'}}),/SCIENCE_COMPUTER_CONTROL_CONFLICT/);
  controller=await restoreScienceController(f.options);
  assert.deepEqual(scienceApi.getScienceComputerControlReport({controller}),{coverage:'partial',observations:[observation]});
  const [{request}]=await prepareScienceRequests({controller});
  await recordScienceDispatchIntent({controller,role:'evidence'});
  await recordScienceHostObservation({controller,role:'evidence',observation:{action_id:request.emittedStep.action_id,run_id:'run',input_fingerprint:request.emittedStep.input_fingerprint,port:'current-collaboration',tool_call:{name:request.emittedStep.action,arguments:request.emittedStep.arguments},raw_result_text:JSON.stringify({agent_id:'host-evidence'})}});
  for (let n=1;n<=2;n++) {
    const args={id:'host-evidence',message:'continue '+n};
    const parameters={controller,role:'evidence',executionId:'exec-'+n,actionId:'continue-'+n,handle:'host-evidence',tool:'host.resume',arguments:args,context:{continuation_request:{action_id:'continue-'+n,message:'continue '+n}}};
    await scienceApi.reserveScienceContinuation(parameters); await scienceApi.reserveScienceContinuation(parameters);
    await scienceApi.markScienceContinuationDispatched({controller,executionId:'exec-'+n});
    await scienceApi.recordScienceContinuationReceipt({controller,executionId:'exec-'+n,receipt:{execution_id:'exec-'+n,action_id:'continue-'+n,agent_id:'host-evidence',tool_call:{name:'host.resume',arguments:args},raw_result_text:'ok',status:'observed'}});
    controller=await restoreScienceController(f.options);
    assert.equal(scienceApi.getScienceContinuation({controller,executionId:'exec-'+n}).context.continuation_request.message,'continue '+n);
  }
  assert.equal(scienceApi.getScienceBudgetSummary({controller}).occupied,3);
  await writeFile(join(f.root,f.tasks.evidence.native_path),JSON.stringify({role:'evidence',text:'accepted source'})); await acceptScienceResult({controller,role:'evidence'});
  for (let i=0;i<4;i++) await acceptCompactionBatch(f,controller);
  assert.equal(getScienceState(controller).reserved_calls,6);
  const handoff=await createScienceHandoff({controller,checkpointTask:f.checkpointTask});
  assert.equal(handoff.status,'transferred');
  assert.equal(readingApiBudget({controller:handoff.controller}).occupied,9);
  const writer=handoff.requests[0], reading=handoff.controller;
  readingApi.recordReadingFirstRequestEvent({controller:reading,request:writer,eventKey:'intent',payload:{action_id:writer.emittedStep.action_id}});
  const writerObservation={action_id:writer.emittedStep.action_id,run_id:'run',input_fingerprint:writer.emittedStep.input_fingerprint,port:'current-collaboration',tool_call:{name:writer.emittedStep.action,arguments:writer.emittedStep.arguments},raw_result_text:JSON.stringify({agent_id:'host-writer'})};
  readingApi.recordReadingFirstRequestEvent({controller:reading,request:writer,eventKey:'host_observation',payload:writerObservation});
  const args={id:'host-writer',message:'continue'};
  const continuation={controller:reading,taskId:writer.task.task_id,executionId:'writer-exec',actionId:'writer-continuation',handle:'host-writer',tool:'host.resume',arguments:args,context:{translation_progress:{source_fingerprint:'source'}}};
  readingApi.reserveReadingContinuation(continuation); readingApi.reserveReadingContinuation(continuation);
  assert.equal(readingApiBudget({controller:reading}).reserved,1);
  readingApi.markReadingContinuationDispatched({controller:reading,executionId:'writer-exec'});
  const receipt={execution_id:'writer-exec',action_id:'writer-continuation',agent_id:'host-writer',tool_call:{name:'host.resume',arguments:args},raw_result_text:'pending',status:'outcome_unknown'};
  readingApi.recordReadingContinuationReceipt({controller:reading,executionId:'writer-exec',receipt});
  const checkpoint=await commitOwnedArtifact({artifactRoot:f.root,dispatchContext:handoff.broker.dispatchContext,capability:handoff.broker.issueCapability({runId:'run',actorId:'controller',role:'control',artifactPath:'control/checkpoint-r2.json',revision:'2'}),artifact:{artifact_id:'checkpoint-r2',content:JSON.stringify(snapshotReadingFirstRuntime(reading))},expectedRevision:'2'});
  const recovered=await restoreReadingFirstRuntime({handoff:handoff.handoff,runControl:handoff.runControl,checkpointReceipt:checkpoint});
  assert.equal(recovered.ok,true,JSON.stringify(recovered.errors));
  assert.equal(readingApiBudget({controller:recovered.controller}).occupied,10);
  assert.equal(readingApi.getReadingPendingContinuations({controller:recovered.controller})[0].receipt.status,'outcome_unknown');
  readingApi.recordReadingContinuationReceipt({controller:recovered.controller,executionId:'writer-exec',receipt:{...receipt,status:'observed'}});
  assert.throws(()=>readingApi.reserveReadingContinuation({...continuation,controller:recovered.controller,executionId:'writer-exec-2',actionId:'writer-continuation-2'}),/BUDGET_EXHAUSTED/);
});


for (const presentationMode of ['writer','reading-editor']) test(`2.1 science continuation preserves capacity for unprepared science, drafts and review with ${presentationMode}`, async t => {
  const directory=await mkdtemp(join(tmpdir(),'science-budget-reserve-')); t.after(()=>rm(directory,{recursive:true,force:true}));
  const prompt=join(directory,'prompt.md'),bytes=Buffer.from('Synthetic science contract'); await writeFile(prompt,bytes);
  const f=await fixture(t,{promptFiles:[{path:prompt,sha256:sha(bytes),byte_length:bytes.length}],instructionProfile:'configured-reading-2.1',presentationMode});
  const controller=await createScienceController(f.options),[{request}]=await prepareScienceRequests({controller});
  await recordScienceDispatchIntent({controller,role:'evidence'});
  await recordScienceHostObservation({controller,role:'evidence',observation:{action_id:request.emittedStep.action_id,run_id:'run',input_fingerprint:request.emittedStep.input_fingerprint,port:'current-collaboration',tool_call:{name:request.emittedStep.action,arguments:request.emittedStep.arguments},raw_result_text:JSON.stringify({agent_id:'host-evidence'})}});
  const allowed=presentationMode==='reading-editor'?2:3;
  for(let n=1;n<=allowed;n++) {
    const args={id:'host-evidence',message:'continue '+n}, call={controller,role:'evidence',executionId:'e'+n,actionId:'a'+n,handle:'host-evidence',tool:'host.resume',arguments:args};
    await scienceApi.reserveScienceContinuation(call); await scienceApi.markScienceContinuationDispatched({controller,executionId:'e'+n});
    await scienceApi.recordScienceContinuationReceipt({controller,executionId:'e'+n,receipt:{execution_id:'e'+n,action_id:'a'+n,agent_id:'host-evidence',tool_call:{name:'host.resume',arguments:args},raw_result_text:'ok',status:'observed'}});
  }
  const call={controller,role:'evidence',executionId:'e-next',actionId:'a-next',handle:'host-evidence',tool:'host.resume',arguments:{id:'host-evidence',message:'continue next'}};
  await assert.rejects(()=>scienceApi.reserveScienceContinuation(call),/BUDGET_EXHAUSTED/);
  assert.equal(scienceApi.getScienceBudgetSummary({controller}).occupied,1+allowed);
  await writeFile(join(f.root,f.tasks.evidence.native_path),JSON.stringify({role:'evidence',text:'accepted source'}));
  await acceptScienceResult({controller,role:'evidence'});
  assert.deepEqual((await prepareScienceRequests({controller})).map(row=>row.role),['methods','results']);
  assert.equal(scienceApi.getScienceBudgetSummary({controller}).occupied,3+allowed);
});
