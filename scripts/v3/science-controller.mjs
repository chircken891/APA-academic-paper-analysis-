import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, link, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createConfiguredScienceRequest, getConfiguredReadingDispatchArguments } from './configured-reading.mjs';
import { createOwnedArtifactBroker, commitOwnedArtifact, readOwnedArtifact, repairOwnedArtifactReceipt } from './owned-artifact-store.mjs';
import { ingestObservedRunStep } from './phase21-runner.mjs';
import { fingerprintReadingFirst, buildReadingFirstHandoff, createReadingFirstRequests, snapshotReadingFirstRuntime, restoreReadingFirstRuntime } from './reading-first-runtime.mjs';

const roles = ['evidence', 'methods', 'results', 'interpretation', 'scientific-reading', 'integration'];
const dependencies = { evidence: [], methods: ['evidence'], results: ['evidence'], interpretation: ['evidence', 'methods', 'results'], 'scientific-reading': ['evidence', 'methods', 'results', 'interpretation'], integration: ['evidence', 'methods', 'results', 'interpretation', 'scientific-reading'] };
const controllers = new WeakMap();
const copy = value => structuredClone(value);
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => fingerprintReadingFirst(a) === fingerprintReadingFirst(b);
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const promptPath = new URL('../../prompts/v3/phase21-scientific-contracts.md', import.meta.url);
function ownedPath(root, path) {
  if (typeof path !== 'string' || !path || isAbsolute(path)) fail('SCIENCE_PATH_INVALID');
  const target = resolve(root, path), rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) fail('SCIENCE_PATH_INVALID');
  return target;
}
function controllerState(controller) {
  const state = controllers.get(controller);
  if (!state) fail('SCIENCE_CONTROLLER_REQUIRED');
  return state;
}
function receiptMatches(receipt, state, task) {
  return receipt && receipt.schema_version === 'phase21-owned-artifact-receipt-1.0' && receipt.run_id === state.data.prepared.runControl.run_id && receipt.artifact_id === task.artifact_id
    && receipt.owner_actor_id === task.owner_actor_id && receipt.role === task.role && receipt.path === task.artifact_path.replaceAll('\\', '/')
    && receipt.revision === task.revision;
}
async function validateCurrent(state, { deadline = true } = {}) {
  const { data } = state, binding = data.prepared.runControl.reading_first_binding;
  if (deadline && Date.now() >= Date.parse(binding.deadline)) fail('SCIENCE_DEADLINE_EXPIRED');
  if (hash(await readFile(promptPath)) !== data.prompt_sha256) fail('SCIENCE_PROMPT_CHANGED');
  for (const source of data.prepared.scientificInput.sources) {
    const bytes = await readFile(source.path);
    if (hash(bytes) !== source.sha256 || bytes.length !== source.byte_length) fail('SCIENCE_SOURCE_CHANGED');
  }
  for (const role of roles) {
    const entry = data.entries[role];
    if (entry.request) {
      const args = getConfiguredReadingDispatchArguments({ prepared: data.prepared, request: entry.request });
      if (entry.intent && (entry.intent.action_id !== entry.request.emittedStep.action_id || entry.intent.action !== entry.request.emittedStep.action || !same(entry.intent.arguments, args))) fail('SCIENCE_INTENT_INVALID');
    }
    if (entry.observation) {
      if (!entry.intent || !entry.raw_observation) fail('SCIENCE_OBSERVATION_INVALID');
      const checked = ingestObservedRunStep({ packet: entry.request.packet, emittedStep: entry.request.emittedStep, observation: entry.raw_observation, run: { run_id: data.prepared.runControl.run_id }, now: entry.observation.observed_at });
      if (!same(checked, entry.observation)) fail('SCIENCE_OBSERVATION_INVALID');
    }
    if (entry.content_base64) {
      const expected = Buffer.from(entry.content_base64, 'base64'), actual = await readFile(ownedPath(data.prepared.paths.runRoot, data.tasks[role].native_path));
      if (hash(expected) !== entry.content_sha256 || !actual.equals(expected)) fail('SCIENCE_NATIVE_CHANGED');
    }
    if (entry.receipt) {
      const saved = await readOwnedArtifact({ artifactRoot: data.prepared.paths.runRoot, artifactId: data.tasks[role].artifact_id });
      if (!saved || !receiptMatches(saved.receipt, state, data.tasks[role]) || !same(saved.receipt, entry.receipt)) fail('SCIENCE_RECEIPT_INVALID');
    }
  }
}
function envelope(data) { return { schema_version: 'science-controller-state-1.0', data, fingerprint: fingerprintReadingFirst(data) }; }
async function readState(path) {
  const saved = JSON.parse(await readFile(path, 'utf8'));
  if (saved.schema_version !== 'science-controller-state-1.0' || !saved.data || saved.fingerprint !== fingerprintReadingFirst(saved.data) || !Number.isInteger(saved.data.version) || saved.data.version < 1) fail('SCIENCE_STATE_INVALID');
  return saved;
}
async function save(state, initial = false) {
  const data = copy(state.data); data.version += 1;
  const path = state.path, temp = path + '.' + randomUUID() + '.tmp';
  await mkdir(dirname(path), { recursive: true });
  if (!initial) {
    const disk = await readState(path);
    if (disk.data.version !== state.saved.version || !same(disk.data, state.saved)) fail('SCIENCE_STATE_CONFLICT');
  }
  await writeFile(temp, JSON.stringify(envelope(data)) + '\n', { flag: 'wx' });
  if (initial) {
    try { await link(temp, path); }
    catch (error) { if (error.code === 'EEXIST') fail('SCIENCE_STATE_CONFLICT'); throw error; }
    await unlink(temp);
  } else await rename(temp, path);
  state.data = data; state.saved = copy(data);
}
function serial(state, fn) {
  const operation = state.queue.then(async () => {
    if (state.poisoned) fail('SCIENCE_CONTROLLER_RESTORE_REQUIRED');
    try { return await fn(); } catch (error) { if (!same(state.data, state.saved)) state.poisoned = true; throw error; }
  });
  state.queue = operation.catch(() => {});
  return operation;
}
function validateSetup(prepared, tasks, brokerConfig, statePath) {
  const binding = prepared?.runControl?.reading_first_binding, runId = prepared?.runControl?.run_id;
  if (!binding?.configured_setup || binding.profile !== 'reading-first-1.0' || binding.prior_calls !== 6 || !Number.isInteger(binding.max_total_calls) || binding.max_total_calls < binding.max_calls + 6 || !Number.isFinite(Date.parse(binding.deadline))) fail('SCIENCE_BINDING_INVALID');
  if (prepared.scientificInput?.profile !== 'reading-first-1.0' || prepared.scientificInput.identity?.run_id !== runId || !Array.isArray(prepared.scientificInput.sources) || !prepared.scientificInput.sources.length || !same(prepared.scientificInput, { ...prepared.scientificInput, profile: 'reading-first-1.0' }) || fingerprintReadingFirst(prepared.scientificInput) !== binding.input_fingerprint) fail('SCIENCE_INPUT_INVALID');
  if (!Array.isArray(prepared.scientificInput.role_artifacts) || prepared.scientificInput.role_artifacts.length !== roles.length || new Set(prepared.scientificInput.role_artifacts).size !== roles.length) fail('SCIENCE_INPUT_INVALID');
  if (binding.configured_setup.config_fingerprint !== prepared.configurationFingerprint || !same(binding.configured_setup.paths, prepared.paths)) fail('SCIENCE_BINDING_INVALID');
  if (resolve(brokerConfig?.artifact_root ?? '') !== resolve(prepared.paths.runRoot) || brokerConfig.control_actor_id !== binding.controller_actor_id || !Array.isArray(brokerConfig.authorized_bindings) || !Array.isArray(brokerConfig.run_controls) || brokerConfig.run_controls.filter(control => control.run_id === runId && same(control, prepared.runControl)).length !== 1) fail('SCIENCE_BROKER_INVALID');
  const paths = new Set(), ids = new Set();
  for (const role of roles) {
    const task = tasks?.[role];
    if (!task || task.role !== role || !['task_id', 'task_name', 'owner_actor_id', 'artifact_id', 'artifact_path', 'native_path', 'revision'].every(key => typeof task[key] === 'string' && task[key])) fail('SCIENCE_TASK_INVALID');
    if (!prepared.scientificInput.role_artifacts?.includes(task.artifact_id)) fail('SCIENCE_TASK_INVALID');
    for (const path of [task.artifact_path, task.native_path, ...(task.instruction_path ? [task.instruction_path] : [])]) {
      const target = ownedPath(prepared.paths.runRoot, path).normalize('NFC').toLowerCase();
      if (paths.has(target)) fail('SCIENCE_OUTPUT_CONFLICT'); paths.add(target);
    }
    if (ids.has(task.artifact_id)) fail('SCIENCE_OUTPUT_CONFLICT'); ids.add(task.artifact_id);
    if (!brokerConfig.authorized_bindings.some(row => row.run_id === runId && row.actor_id === task.owner_actor_id && row.role === role && row.artifact_path === task.artifact_path && row.revision === task.revision)) fail('SCIENCE_TASK_UNAUTHORIZED');
  }
  for (const task of Object.values(binding.task_bindings ?? {})) {
    for (const path of [task.artifact_path, task.native_path, ...(task.instruction_path ? [task.instruction_path] : [])]) {
      const target = ownedPath(prepared.paths.runRoot, path).normalize('NFC').toLowerCase();
      if (paths.has(target)) fail('SCIENCE_OUTPUT_CONFLICT'); paths.add(target);
    }
    if (ids.has(task.artifact_id)) fail('SCIENCE_OUTPUT_CONFLICT'); ids.add(task.artifact_id);
  }
  const stateTarget = resolve(statePath);
  const stateRelative = relative(resolve(prepared.paths.runRoot), stateTarget);
  if (!stateRelative || stateRelative === '..' || stateRelative.startsWith('..' + sep) || isAbsolute(stateRelative) || stateRelative.split(sep)[0].toLowerCase() === '.phase21-receipts' || paths.has(stateTarget.normalize('NFC').toLowerCase())) fail('SCIENCE_STATE_PATH_INVALID');
}
function makeController(path, data) {
  const controller = Object.freeze({ profile: 'science-controller-1.0' });
  controllers.set(controller, { path: resolve(path), data, saved: copy(data), broker: createOwnedArtifactBroker(data.brokerConfig), queue: Promise.resolve() });
  return controller;
}
export async function createScienceController({ prepared, tasks, payloads = {}, brokerConfig, statePath } = {}) {
  validateSetup(prepared, tasks, brokerConfig, statePath);
  const data = { version: 0, prepared: copy(prepared), tasks: copy(tasks), payloads: copy(payloads), brokerConfig: copy(brokerConfig), prompt_sha256: hash(await readFile(promptPath)), entries: Object.fromEntries(roles.map(role => [role, {}])), handoff: null };
  const controller = makeController(statePath, data), state = controllerState(controller);
  await validateCurrent(state); await save(state, true); return controller;
}
export async function restoreScienceController({ statePath, prepared, tasks, payloads = {}, brokerConfig } = {}) {
  const saved = await readState(statePath);
  validateSetup(prepared, tasks, brokerConfig, statePath);
  if (!same(saved.data.prepared, prepared) || !same(saved.data.tasks, tasks) || !same(saved.data.payloads, payloads) || !same(saved.data.brokerConfig, brokerConfig)) fail('SCIENCE_BINDING_CHANGED');
  const controller = makeController(statePath, saved.data), state = controllerState(controller);
  await validateCurrent(state, { deadline: false }); return controller;
}
export function getScienceState(controller) {
  const { data, path } = controllerState(controller), expired = Date.now() >= Date.parse(data.prepared.runControl.reading_first_binding.deadline);
  return copy({ version: data.version, run_id: data.prepared.runControl.run_id, state_path: path, deadline: data.prepared.runControl.reading_first_binding.deadline, expired,
    reserved_calls: roles.filter(role => data.entries[role].intent).length, observed_calls: roles.filter(role => data.entries[role].observation?.status === 'observed').length,
    accepted_results: roles.filter(role => data.entries[role].receipt).length,
    next_actions: expired ? [{action:'expired_blocked'}] : data.handoff?.status === 'transferred' ? [{action:'continue_downstream'}] : roles.every(role => data.entries[role].receipt) ? [{action: data.handoff ? 'continue_handoff' : 'create_handoff'}] : roles.flatMap(role => { const e = data.entries[role]; return e.receipt ? [] : e.observation?.status === 'observed' ? (e.content_base64 ? [{role,action:'accept_result'}] : [{role,action:'wait_or_query_host'},{role,action:'accept_result_if_complete'}]) : e.intent ? [{role,action:'reconcile_host'}] : e.request ? [{role,action:'record_dispatch_intent'}] : dependencies[role].every(dep => data.entries[dep].receipt) ? [{role,action:'prepare_request'}] : []; }),
    roles: Object.fromEntries(roles.map(role => { const e = data.entries[role]; return [role, { status: e.receipt ? 'accepted' : e.observation?.status === 'observed' ? 'observed' : e.intent ? 'outcome_unknown' : e.request ? 'prepared' : 'waiting', action_id: e.request?.emittedStep.action_id ?? null, agent_id: e.observation?.agent_id ?? null, receipt: e.receipt ?? null }]; })),
    handoff: data.handoff ? { status: data.handoff.status, checkpoint_receipt: data.handoff.checkpointReceipt ?? null } : null });
}
/** Retrieve the immutable original action and actual observation history for host reconciliation. */
export function getScienceRequest({ controller, role } = {}) {
  const entry = controllerState(controller).data.entries[role];
  if (!entry?.request) fail('SCIENCE_REQUEST_UNAVAILABLE');
  return copy({ request: entry.request, intent: entry.intent ?? null, observations: entry.observations ?? [], host_updates: entry.host_updates ?? [] });
}
export async function prepareScienceRequests({ controller } = {}) {
  const state = controllerState(controller);
  return serial(state, async () => {
    await validateCurrent(state);
    const selected = roles.filter(role => !state.data.entries[role].request && dependencies[role].every(dep => state.data.entries[dep].receipt));
    if (selected.length) {
      for (const role of selected) {
        const upstream = {};
        for (const dep of dependencies[role]) {
          const record = await readOwnedArtifact({ artifactRoot: state.data.prepared.paths.runRoot, artifactId: state.data.tasks[dep].artifact_id });
          upstream[dep] = { receipt: record.receipt, content: JSON.parse(record.bytes.toString('utf8')) };
        }
        const request = createConfiguredScienceRequest({ prepared: state.data.prepared, role, task: state.data.tasks[role], dispatchContext: state.broker.dispatchContext, payload: { ...(state.data.payloads[role] ?? {}), upstream } });
        state.data.entries[role].request = copy(request);
      }
      await save(state);
    }
    return copy(roles.filter(role => state.data.entries[role].request && !state.data.entries[role].intent).map(role => ({ role, request: state.data.entries[role].request })));
  });
}
export async function recordScienceDispatchIntent({ controller, role } = {}) {
  const state = controllerState(controller);
  return serial(state, async () => {
    await validateCurrent(state);
    const entry = state.data.entries[role];
    if (!entry?.request || entry.intent) fail('SCIENCE_DISPATCH_UNAVAILABLE');
    if (roles.filter(key => state.data.entries[key].intent).length >= 6) fail('SCIENCE_BUDGET_EXHAUSTED');
    const args = getConfiguredReadingDispatchArguments({ prepared: state.data.prepared, request: entry.request });
    entry.intent = { action_id: entry.request.emittedStep.action_id, action: entry.request.emittedStep.action, arguments: args, recorded_at: new Date().toISOString() };
    await save(state); return copy(entry.intent);
  });
}
export async function recordScienceHostObservation({ controller, role, observation } = {}) {
  const state = controllerState(controller);
  return serial(state, async () => {
    await validateCurrent(state);
    const entry = state.data.entries[role];
    if (!entry?.intent || entry.receipt) fail('SCIENCE_OBSERVATION_UNAVAILABLE');
    if (observation?.kind === 'host_update') {
      if (entry.observation?.status !== 'observed' || observation.action_id !== entry.intent.action_id || observation.agent_id !== entry.observation.agent_id || typeof observation.raw_result_text !== 'string' || !observation.tool_call || typeof observation.tool_call.name !== 'string' || !observation.tool_call.arguments || typeof observation.tool_call.arguments !== 'object') fail('SCIENCE_HOST_UPDATE_INVALID');
      const update = copy(observation); (entry.host_updates ??= []).push(update); await save(state); return update;
    }
    const request = entry.request;
    const checked = ingestObservedRunStep({ packet: request.packet, emittedStep: request.emittedStep, observation, run: { run_id: state.data.prepared.runControl.run_id } });
    if (entry.observation?.agent_id && checked.agent_id && entry.observation.agent_id !== checked.agent_id) fail('SCIENCE_HOST_HANDLE_MISMATCH');
    entry.raw_observation = copy(observation); entry.observation = copy(checked);
    (entry.observations ??= []).push({ raw: copy(observation), validated: copy(checked) });
    await save(state);
    if (checked.status !== 'observed') fail('SCIENCE_OBSERVATION_INVALID');
    return copy(checked);
  });
}
export async function acceptScienceResult({ controller, role } = {}) {
  const state = controllerState(controller);
  return serial(state, async () => {
    await validateCurrent(state);
    const entry = state.data.entries[role], task = state.data.tasks[role], root = state.data.prepared.paths.runRoot;
    if (!entry?.intent || entry.observation?.status !== 'observed') fail('SCIENCE_RESULT_UNAVAILABLE');
    if (entry.receipt) return copy(entry.receipt);
    if (!entry.content_base64) {
      const bytes = await readFile(ownedPath(root, task.native_path));
      const parsed = JSON.parse(bytes.toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.keys(parsed).length) fail('SCIENCE_CONTENT_INVALID');
      entry.content_base64 = bytes.toString('base64'); entry.content_sha256 = hash(bytes); await save(state);
    }
    const bytes = Buffer.from(entry.content_base64, 'base64');
    if (hash(bytes) !== entry.content_sha256) fail('SCIENCE_CONTENT_INVALID');
    let existing = await readOwnedArtifact({ artifactRoot: root, artifactId: task.artifact_id });
    if (existing) {
      if (!receiptMatches(existing.receipt, state, task) || !existing.bytes.equals(bytes)) fail('SCIENCE_RECEIPT_INVALID');
    } else {
      const capability = state.broker.issueCapability({ runId: state.data.prepared.runControl.run_id, actorId: task.owner_actor_id, role, artifactPath: task.artifact_path, revision: task.revision });
      const artifact = { artifact_id: task.artifact_id, path: task.artifact_path, content: bytes };
      let receipt;
      try { receipt = await commitOwnedArtifact({ artifactRoot: root, dispatchContext: state.broker.dispatchContext, capability, artifact, expectedRevision: task.revision }); }
      catch (error) {
        if (error.code !== 'ARTIFACT_ALREADY_EXISTS') throw error;
        const recovery = state.broker.issueCapability({ runId: state.data.prepared.runControl.run_id, actorId: task.owner_actor_id, role, artifactPath: task.artifact_path, revision: task.revision });
        receipt = await repairOwnedArtifactReceipt({ artifactRoot: root, dispatchContext: state.broker.dispatchContext, capability: recovery, artifact, expectedRevision: task.revision, statePath: state.path, role });
      }
      existing = { receipt, bytes };
    }
    state.data.entries[role].receipt = copy(existing.receipt); await save(state); return copy(existing.receipt);
  });
}
/** Freeze the first downstream request and owned checkpoint before science is transferred. */
export async function createScienceHandoff({ controller, checkpointTask } = {}) {
  const state = controllerState(controller);
  return serial(state, async () => {
    await validateCurrent(state);
    if (roles.some(role => !state.data.entries[role].receipt)) fail('SCIENCE_HANDOFF_INCOMPLETE');
    const binding = state.data.prepared.runControl.reading_first_binding, runId = state.data.prepared.runControl.run_id, root = state.data.prepared.paths.runRoot;
    if (!checkpointTask || checkpointTask.role !== 'control' || checkpointTask.owner_actor_id !== binding.controller_actor_id
      || !['artifact_id','artifact_path','revision'].every(key => typeof checkpointTask[key] === 'string' && checkpointTask[key])
      || !state.data.brokerConfig.authorized_bindings.some(row => row.run_id === runId && row.actor_id === checkpointTask.owner_actor_id && row.role === 'control' && row.artifact_path === checkpointTask.artifact_path && row.revision === checkpointTask.revision)) fail('SCIENCE_CHECKPOINT_UNAUTHORIZED');
    const checkpointPath = ownedPath(root, checkpointTask.artifact_path);
    const occupied = [state.path, ...Object.values(state.data.tasks).flatMap(task => [task.artifact_path,task.native_path,...(task.instruction_path ? [task.instruction_path] : [])].map(path => ownedPath(root,path))),
      ...Object.values(binding.task_bindings).flatMap(task => [task.artifact_path,task.native_path,...(task.instruction_path ? [task.instruction_path] : [])].map(path => ownedPath(root,path)))];
    if (occupied.some(path => path.normalize('NFC').toLowerCase() === checkpointPath.normalize('NFC').toLowerCase())
      || roles.some(role => state.data.tasks[role].artifact_id === checkpointTask.artifact_id)
      || Object.values(binding.task_bindings).some(task => task.artifact_id === checkpointTask.artifact_id)) fail('SCIENCE_OUTPUT_CONFLICT');
    if (state.data.handoff && !same(state.data.handoff.checkpointTask, checkpointTask)) fail('SCIENCE_CHECKPOINT_CHANGED');
    const runControl = { runId, artifactRoot: root, dispatchContext: state.broker.dispatchContext };
    const handoff = await buildReadingFirstHandoff({ run: { run_id: runId }, dispatchContext: state.broker.dispatchContext, artifactRoot: root, scientificInput: state.data.prepared.scientificInput });
    if (state.data.handoff?.status === 'transferred') {
      const saved = await readOwnedArtifact({ artifactRoot: root, artifactId: checkpointTask.artifact_id });
      if (!saved || !receiptMatches(saved.receipt, state, checkpointTask) || !same(saved.receipt, state.data.handoff.checkpointReceipt) || !saved.bytes.equals(Buffer.from(JSON.stringify(state.data.handoff.snapshot)))) fail('SCIENCE_CHECKPOINT_INVALID');
      return { status: 'transferred', handoff, checkpointReceipt: copy(saved.receipt), runControl, broker: state.broker };
    }
    if (!state.data.handoff) {
      state.data.handoff = { status: 'request_preparing', checkpointTask: copy(checkpointTask), instructionToken: randomUUID() };
      await save(state);
    }
    if (!state.data.handoff.snapshot) {
      const initial = createReadingFirstRequests({ handoff, runControl, reuseInitialInstruction: true, initialInstructionToken: state.data.handoff.instructionToken });
      if (!initial.ok) fail(initial.errors[0]?.code ?? 'SCIENCE_HANDOFF_FAILED');
      const snapshot = snapshotReadingFirstRuntime(initial.controller);
      state.data.handoff = { ...state.data.handoff, status: 'checkpoint_pending', snapshot: copy(snapshot) };
      await save(state);
    }
    let entry = state.data.handoff, bytes = Buffer.from(JSON.stringify(entry.snapshot));
    let existing = await readOwnedArtifact({ artifactRoot: root, artifactId: checkpointTask.artifact_id });
    if (existing) {
      if (!receiptMatches(existing.receipt, state, checkpointTask) || !existing.bytes.equals(bytes)) fail('SCIENCE_CHECKPOINT_INVALID');
    } else {
      const issue = () => state.broker.issueCapability({ runId, actorId: checkpointTask.owner_actor_id, role: 'control', artifactPath: checkpointTask.artifact_path, revision: checkpointTask.revision });
      const artifact = { artifact_id: checkpointTask.artifact_id, path: checkpointTask.artifact_path, content: bytes };
      let receipt;
      try { receipt = await commitOwnedArtifact({ artifactRoot: root, dispatchContext: state.broker.dispatchContext, capability: issue(), artifact, expectedRevision: checkpointTask.revision }); }
      catch (error) {
        if (error.code !== 'ARTIFACT_ALREADY_EXISTS') throw error;
        receipt = await repairOwnedArtifactReceipt({ artifactRoot: root, dispatchContext: state.broker.dispatchContext, capability: issue(), artifact, expectedRevision: checkpointTask.revision, statePath: state.path, role: 'checkpoint' });
      }
      existing = { receipt, bytes };
    }
    const restored = await restoreReadingFirstRuntime({ handoff, runControl, checkpointReceipt: existing.receipt });
    if (!restored.ok) fail(restored.errors[0]?.code ?? 'SCIENCE_CHECKPOINT_INVALID');
    if (entry.status !== 'transferred') {
      state.data.handoff.checkpointReceipt = copy(existing.receipt); state.data.handoff.status = 'transferred'; await save(state);
    }
    return { status: 'transferred', handoff, controller: restored.controller, requests: restored.requests, checkpointReceipt: copy(existing.receipt), runControl, broker: state.broker };
  });
}
