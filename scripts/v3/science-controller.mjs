import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, writeFile, link, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createConfiguredScienceRequest, getConfiguredReadingDispatchArguments, validateConfiguredReadingDispatch } from './configured-reading.mjs';
import { createOwnedArtifactBroker, commitOwnedArtifact, readOwnedArtifact, repairOwnedArtifactReceipt } from './owned-artifact-store.mjs';
import { ingestObservedRunStep } from './phase21-runner.mjs';
import { fingerprintReadingFirst, buildReadingFirstHandoff, createReadingFirstRequests, snapshotReadingFirstRuntime, restoreReadingFirstRuntime } from './reading-first-runtime.mjs';
import { compactionEnabled, compactionControlBindings, evaluateCompactionBoundary, assertCompactionSettled, registerCompactionDispatch } from './reading-compaction.mjs';

const roles = ['evidence', 'methods', 'results', 'interpretation', 'scientific-reading', 'integration'];
const dependencies = { evidence: [], methods: ['evidence'], results: ['evidence'], interpretation: ['evidence', 'methods', 'results'], 'scientific-reading': ['evidence', 'methods', 'results', 'interpretation'], integration: ['evidence', 'methods', 'results', 'interpretation', 'scientific-reading'] };
const controllers = new WeakMap();
const copy = value => structuredClone(value);
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => fingerprintReadingFirst(a) === fingerprintReadingFirst(b);
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const promptPath = new URL('../../prompts/v3/phase21-scientific-contracts.md', import.meta.url);
function configuredPromptFiles(prepared) {
  const setup = prepared.runControl.reading_first_binding.configured_setup;
  if (setup?.instruction_profile !== 'configured-reading-2.0') return null;
  if (!Array.isArray(setup.prompt_files) || !setup.prompt_files.length
    || setup.prompt_files.some(file => !isAbsolute(file.path ?? '') || !/^sha256:[a-f0-9]{64}$/.test(file.sha256 ?? '')
      || !Number.isSafeInteger(file.byte_length) || file.byte_length < 1)) fail('SCIENCE_PROMPT_BINDING_INVALID');
  return setup.prompt_files;
}
function ownedPath(root, path) {
  if (typeof path !== 'string' || !path || isAbsolute(path)) fail('SCIENCE_PATH_INVALID');
  const target = resolve(root, path), rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) fail('SCIENCE_PATH_INVALID');
  return target;
}
// A role whose payload names the committed registry input reads that file; it must exist before the request is emitted or dispatched.
async function assertRegistryInput(data, role) {
  const path = data.payloads[role]?.committed_knowledge_registry;
  if (path === undefined) return;
  let info = null;
  if (typeof path === 'string' && path) {
    try { info = await lstat(resolve(data.prepared.paths.runRoot, path)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!info?.isFile()) fail('SCIENCE_KNOWLEDGE_REGISTRY_INPUT_REQUIRED');
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
const activeEntry = (data, role) => data.entries[role]?.correction ?? data.entries[role];
const activeTask = (data, role) => data.entries[role]?.correction?.task ?? data.tasks[role];
const scienceCalls = data => roles.reduce((total, role) => total + (data.entries[role].intent ? 1 : 0) + (data.entries[role].correction?.intent ? 1 : 0), 0);
function validateCorrection(data, statePath, role, correction) {
  const entry = data.entries[role], original = data.tasks[role], task = correction?.task;
  const binding = data.prepared.runControl.reading_first_binding;
  const auth = correction?.authorization;
  if (!auth || typeof auth.authorizationId !== 'string' || !auth.authorizationId.trim() || auth.authorizationId === binding.authorization_id
    || auth.maxScienceCalls !== 7 || auth.maxTotalCalls !== binding.max_total_calls || auth.deadline !== binding.deadline
    || auth.maxTotalCalls - auth.maxScienceCalls < (binding.presentation_mode === 'reading-editor' ? 4 : 3)) fail('SCIENCE_CORRECTION_UNAUTHORIZED');
  if (!entry?.intent || !entry.raw_observation || entry.observation?.status !== 'blocked' || entry.observation.blocked_reason !== 'OBSERVATION_CORRELATION_MISMATCH'
    || entry.receipt || roles.some(key => !data.entries[key].intent || key !== role && !data.entries[key].receipt)
    || roles.some(key => key !== role && data.entries[key].correction)) fail('SCIENCE_CORRECTION_UNAVAILABLE');
  if (!task || !['task_id', 'task_name', 'owner_actor_id', 'role', 'artifact_id', 'artifact_path', 'native_path', 'instruction_path', 'revision'].every(key => typeof task[key] === 'string' && task[key].trim())
    || !['owner_actor_id', 'role', 'artifact_id', 'artifact_path', 'revision'].every(key => task[key] === original[key])
    || task.task_id === original.task_id || task.task_name === original.task_name
    || !/^[a-z0-9_]+$/.test(task.task_name)) fail('SCIENCE_CORRECTION_TASK_INVALID');
  const otherTasks = [...Object.values(data.tasks), ...Object.values(binding.task_bindings ?? {})];
  if (otherTasks.some(other => other.task_id === task.task_id || other.task_name === task.task_name)) fail('SCIENCE_CORRECTION_TASK_INVALID');
  const occupied = new Set(otherTasks.flatMap(other => [other.artifact_path, other.native_path, other.instruction_path].filter(Boolean).map(p => ownedPath(data.prepared.paths.runRoot, p).normalize('NFC').toLowerCase())));
  occupied.add(resolve(statePath).normalize('NFC').toLowerCase());
  const targets = [task.native_path, task.instruction_path].map(p => ownedPath(data.prepared.paths.runRoot, p));
  if (targets.some(p => occupied.has(p.normalize('NFC').toLowerCase()) || relative(data.prepared.paths.runRoot, p).split(sep)[0].toLowerCase() === '.phase21-receipts')
    || targets[0].normalize('NFC').toLowerCase() === targets[1].normalize('NFC').toLowerCase()) fail('SCIENCE_CORRECTION_TASK_INVALID');
}
async function validateCurrent(state, { deadline = true } = {}) {
  const { data } = state, binding = data.prepared.runControl.reading_first_binding;
  if (deadline && Date.now() >= Date.parse(binding.deadline)) fail('SCIENCE_DEADLINE_EXPIRED');
  const promptFiles = configuredPromptFiles(data.prepared);
  if (promptFiles) {
    if (!same(data.prompt_files, promptFiles)) fail('SCIENCE_PROMPT_BINDING_INVALID');
    for (const file of promptFiles) {
      const bytes = await readFile(file.path);
      if (hash(bytes) !== file.sha256 || bytes.length !== file.byte_length) fail('SCIENCE_PROMPT_CHANGED');
    }
  } else if (hash(await readFile(promptPath)) !== data.prompt_sha256) fail('SCIENCE_PROMPT_CHANGED');
  for (const source of data.prepared.scientificInput.sources) {
    const bytes = await readFile(source.path);
    if (hash(bytes) !== source.sha256 || bytes.length !== source.byte_length) fail('SCIENCE_SOURCE_CHANGED');
  }
  for (const role of roles) {
    const original = data.entries[role];
    if (original.correction) validateCorrection(data, state.path, role, original.correction);
    for (const entry of [original, ...(original.correction ? [original.correction] : [])]) {
      const task = entry === original ? data.tasks[role] : entry.task;
      if (entry.request) {
        validateConfiguredReadingDispatch({ prepared: data.prepared, request: entry.request });
        const args = entry.request.emittedStep.arguments;
        if (entry !== original) {
          const nameArgument = binding.host ? binding.host.dispatch.task_name_argument : 'task_name';
          if (entry.request.packet.host_action_scope.output_path !== ownedPath(data.prepared.paths.runRoot, task.native_path)
            || nameArgument !== null && args[nameArgument] !== task.task_name
            || entry.request.instruction_file?.path !== ownedPath(data.prepared.paths.runRoot, task.instruction_path)) fail('SCIENCE_CORRECTION_TASK_INVALID');
        }
        if (entry.intent && (entry.intent.action_id !== entry.request.emittedStep.action_id || entry.intent.action !== entry.request.emittedStep.action || !same(entry.intent.arguments, args))) fail('SCIENCE_INTENT_INVALID');
      }
      if (entry.observation) {
        if (!entry.intent || !entry.raw_observation) fail('SCIENCE_OBSERVATION_INVALID');
        // Replay historical source-envelope rejections with their original comparison;
        // a newly recorded return is validated by the corrected canonical comparison.
        const checked = ingestObservedRunStep({ packet: entry.request.packet, emittedStep: entry.request.emittedStep, observation: entry.raw_observation, run: { run_id: data.prepared.runControl.run_id }, legacySourceComparison: entry.observation.status === 'blocked' && entry.observation.blocked_reason === 'EMITTED_STEP_PACKET_SCOPE_MISMATCH', now: entry.observation.observed_at });
        if (!same(checked, entry.observation)) fail('SCIENCE_OBSERVATION_INVALID');
      }
      if (entry.content_base64) {
        const expected = Buffer.from(entry.content_base64, 'base64'), actual = await readFile(ownedPath(data.prepared.paths.runRoot, task.native_path));
        if (hash(expected) !== entry.content_sha256 || !actual.equals(expected)) fail('SCIENCE_NATIVE_CHANGED');
      }
      if (entry.receipt) {
        const saved = await readOwnedArtifact({ artifactRoot: data.prepared.paths.runRoot, artifactId: task.artifact_id });
        if (!saved || !receiptMatches(saved.receipt, state, task) || !same(saved.receipt, entry.receipt)) fail('SCIENCE_RECEIPT_INVALID');
      }
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
  for (const expected of compactionControlBindings(prepared.runControl)) {
    if (!brokerConfig.authorized_bindings.some(row => same(row, expected))) fail('SCIENCE_COMPACTION_CHECKPOINT_UNAUTHORIZED');
    const target = ownedPath(prepared.paths.runRoot, expected.artifact_path).normalize('NFC').toLowerCase();
    if (paths.has(target) || target === stateTarget.normalize('NFC').toLowerCase()) fail('SCIENCE_OUTPUT_CONFLICT');
    paths.add(target);
  }
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
  // Same shape the later handoff requires; failing here spends no science call.
  if (typeof prepared.scientificInput.context !== 'string' || !prepared.scientificInput.context.trim()) fail('READING_FIRST_CONTEXT_TEXT_REQUIRED');
  const promptFiles = configuredPromptFiles(prepared);
  const data = { version: 0, prepared: copy(prepared), tasks: copy(tasks), payloads: copy(payloads), brokerConfig: copy(brokerConfig),
    ...(promptFiles ? { prompt_files: copy(promptFiles) } : { prompt_sha256: hash(await readFile(promptPath)) }), entries: Object.fromEntries(roles.map(role => [role, {}])), handoff: null };
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
  const state = controllerState(controller), { data, path } = state, expired = Date.now() >= Date.parse(data.prepared.runControl.reading_first_binding.deadline);
  return copy({ version: data.version, run_id: data.prepared.runControl.run_id, state_path: path, deadline: data.prepared.runControl.reading_first_binding.deadline, expired,
    reserved_calls: scienceCalls(data), observed_calls: roles.reduce((total, role) => total + (data.entries[role].observation?.status === 'observed' ? 1 : 0) + (data.entries[role].correction?.observation?.status === 'observed' ? 1 : 0), 0),
    accepted_results: roles.filter(role => activeEntry(data, role).receipt).length,
    next_actions: expired ? [{action:'expired_blocked'}] : data.handoff?.status === 'transferred' ? [{action:'continue_downstream'}] : roles.every(role => activeEntry(data, role).receipt) ? [{action: scienceCalls(data) > data.prepared.runControl.reading_first_binding.prior_calls ? 'prepare_adopted_reading' : data.handoff ? 'continue_handoff' : 'create_handoff'}] : roles.flatMap(role => { const e = activeEntry(data, role); return e.receipt ? [] : e.observation?.status === 'observed' ? (e.content_base64 ? [{role,action:'accept_result'}] : [{role,action:'wait_or_query_host'},{role,action:'accept_result_if_complete'}]) : e.intent ? [{role,action:'reconcile_host'}] : e.request ? [{role,action:'record_dispatch_intent'}] : dependencies[role].every(dep => activeEntry(data, dep).receipt) ? [{role,action:'prepare_request'}] : []; }),
    roles: Object.fromEntries(roles.map(role => { const e = activeEntry(data, role); return [role, { status: e.receipt ? 'accepted' : e.observation?.status === 'observed' ? 'observed' : e.intent ? 'outcome_unknown' : e.request ? 'prepared' : 'waiting', action_id: e.request?.emittedStep.action_id ?? null, agent_id: e.observation?.agent_id ?? null, receipt: e.receipt ?? null }]; })),
    handoff: data.handoff ? { status: data.handoff.status, checkpoint_receipt: data.handoff.checkpointReceipt ?? null } : null,
    compaction_boundary: scienceCompactionBoundary(state) });
}
function scienceCompactionBoundary(state) {
  const { data, path } = state;
  const accepted = role => Boolean(activeEntry(data, role).receipt);
  const pending = role => { const entry = activeEntry(data, role); return Boolean(entry.intent && !entry.receipt); };
  const running = roles.filter(pending).length;
  const id = accepted('methods') && accepted('results') && !activeEntry(data, 'interpretation').intent ? 'methods-results-accepted'
    : accepted('evidence') && !activeEntry(data, 'methods').intent && !activeEntry(data, 'results').intent ? 'evidence-accepted' : null;
  if (!id) return null;
  return { id, reached: true, recovery: { type: 'science-controller-state', saved: same(state.data, state.saved), path }, running_count: running,
    reminder: copy(data.compaction_reminders?.[id] ?? { status: 'pending', reason: null }) };
}
/** Persist an observed reminder outcome in the existing durable science state. */
export async function recordScienceCompactionBoundary({ controller, id, status, reason } = {}) {
  const state = controllerState(controller);
  if (compactionEnabled(state.data.prepared.runControl.reading_first_binding)) fail('APA_COMPACTION_POLICY_DECISION_REQUIRED');
  return serial(state, async () => {
    await validateCurrent(state, { deadline: false });
    const boundary = scienceCompactionBoundary(state);
    if (!boundary || boundary.id !== id || boundary.running_count !== 0 || !boundary.recovery.saved) fail('SCIENCE_COMPACTION_UNAVAILABLE');
    if (!['prompted', 'skipped', 'completed'].includes(status) || typeof reason !== 'string' || !reason.trim()) fail('SCIENCE_COMPACTION_INVALID');
    const previous = boundary.reminder.status;
    if (previous !== 'pending' && !(previous === 'prompted' && ['skipped', 'completed'].includes(status))) fail('SCIENCE_COMPACTION_ALREADY_RECORDED');
    state.data.compaction_reminders ??= {};
    state.data.compaction_reminders[id] = { status, reason };
    await save(state);
    return scienceCompactionBoundary(state);
  });
}
/** Assess and durably record the common policy; returning await-user means the save succeeded. */
export async function handleScienceCompactionBoundary({ controller, observation, sessionId, progress, userDecision } = {}) {
  const state = controllerState(controller);
  return serial(state, async () => {
    await validateCurrent(state);
    const binding = state.data.prepared.runControl.reading_first_binding;
    if (!compactionEnabled(binding)) fail('APA_COMPACTION_POLICY_REQUIRED');
    const result = evaluateCompactionBoundary({ boundary: scienceCompactionBoundary(state), observation, sessionId, progress, userDecision,
      history: state.data.compaction_reminders, startedAt: binding.compaction_policy.started_at, policy: binding.compaction_policy,
      continuation: { run_id: state.data.prepared.runControl.run_id, paper_id: state.data.prepared.scientificInput.identity.paper_id,
        run_root: state.data.prepared.paths.runRoot, checkpoint_path: state.path, binding_source: state.path + '#data.prepared.runControl.reading_first_binding',
        binding, calls_used: scienceCalls(state.data), sources: state.data.prepared.scientificInput.sources,
        accepted_artifacts: roles.filter(role => activeEntry(state.data, role).receipt).map(role => {
          const receipt = activeEntry(state.data, role).receipt;
          return { role, path: resolve(state.data.prepared.paths.runRoot, receipt.path), sha256: receipt.sha256 };
        }) } });
    if (result.record) {
      const boundary = scienceCompactionBoundary(state);
      state.data.compaction_reminders ??= {};
      state.data.compaction_reminders[boundary.id] = result.record;
      await save(state);
    }
    return copy(result);
  });
}

function assertScienceCompactionDispatch(state, role) {
  if (!compactionEnabled(state.data.prepared.runControl.reading_first_binding)) return;
  if (state.poisoned || !same(state.data, state.saved)) fail('SCIENCE_CONTROLLER_RESTORE_REQUIRED');
  const id = ['methods', 'results'].includes(role) ? 'evidence-accepted'
    : ['interpretation', 'scientific-reading', 'integration'].includes(role) ? 'methods-results-accepted'
    : scienceCompactionBoundary(state)?.id;
  assertCompactionSettled(state.data.compaction_reminders, id);
}
function registerScienceRequest(state, request) {
  return registerCompactionDispatch(request, () => assertScienceCompactionDispatch(state, request.packet.host_action_scope.role));
}
/** Retrieve the immutable original action and actual observation history for host reconciliation. */
export function getScienceRequest({ controller, role } = {}) {
  const data = controllerState(controller).data, entry = activeEntry(data, role);
  if (!entry?.request) fail('SCIENCE_REQUEST_UNAVAILABLE');
  const original = data.entries[role];
  return copy({ request: entry.request, intent: entry.intent ?? null, observations: entry.observations ?? [], host_updates: entry.host_updates ?? [],
    ...(original.correction ? { original: { request: original.request, intent: original.intent ?? null, observations: original.observations ?? [], host_updates: original.host_updates ?? [] } } : {}) });
}
/** Register one explicitly authorized correction before its instruction or native output is written. */
export async function prepareScienceCorrection({ controller, role, task, authorizationId, maxScienceCalls, maxTotalCalls, deadline } = {}) {
  const state = controllerState(controller);
  return serial(state, async () => {
    await validateCurrent(state);
    if (!roles.includes(role) || roles.some(key => state.data.entries[key].correction)) fail('SCIENCE_CORRECTION_UNAVAILABLE');
    const correction = { task: copy(task), authorization: { authorizationId, maxScienceCalls, maxTotalCalls, deadline } };
    validateCorrection(state.data, state.path, role, correction);
    if (scienceCalls(state.data) !== 6) fail('SCIENCE_CORRECTION_UNAVAILABLE');
    for (const p of [task.native_path, task.instruction_path]) {
      try { await lstat(ownedPath(state.data.prepared.paths.runRoot, p)); fail('SCIENCE_CORRECTION_TASK_INVALID'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    state.data.entries[role].correction = correction;
    await save(state);
    return copy({ role, task, authorization: correction.authorization });
  });
}
export async function prepareScienceRequests({ controller } = {}) {
  const state = controllerState(controller);
  return serial(state, async () => {
    await validateCurrent(state);
    assertScienceCompactionDispatch(state);
    const selected = roles.filter(role => !activeEntry(state.data, role).request && dependencies[role].every(dep => activeEntry(state.data, dep).receipt));
    for (const role of selected) await assertRegistryInput(state.data, role);
    if (selected.length) {
      for (const role of selected) {
        const upstream = {};
        for (const dep of dependencies[role]) {
          const record = await readOwnedArtifact({ artifactRoot: state.data.prepared.paths.runRoot, artifactId: state.data.tasks[dep].artifact_id });
          upstream[dep] = { receipt: record.receipt, content: JSON.parse(record.bytes.toString('utf8')) };
        }
        const request = createConfiguredScienceRequest({ prepared: state.data.prepared, role, task: activeTask(state.data, role), dispatchContext: state.broker.dispatchContext, payload: { ...(state.data.payloads[role] ?? {}), upstream } });
        activeEntry(state.data, role).request = copy(request);
      }
      await save(state);
    }
    return roles.filter(role => activeEntry(state.data, role).request && !activeEntry(state.data, role).intent)
      .map(role => ({ role, request: registerScienceRequest(state, copy(activeEntry(state.data, role).request)) }));
  });
}
export async function recordScienceDispatchIntent({ controller, role } = {}) {
  const state = controllerState(controller);
  return serial(state, async () => {
    await validateCurrent(state);
    assertScienceCompactionDispatch(state, role);
    const entry = activeEntry(state.data, role);
    if (!entry?.request || entry.intent) fail('SCIENCE_DISPATCH_UNAVAILABLE');
    await assertRegistryInput(state.data, role);
    const maxScienceCalls = roles.map(key => state.data.entries[key].correction?.authorization.maxScienceCalls).find(Boolean) ?? 6;
    if (scienceCalls(state.data) >= maxScienceCalls) fail('SCIENCE_BUDGET_EXHAUSTED');
    const args = getConfiguredReadingDispatchArguments({ prepared: state.data.prepared, request: registerScienceRequest(state, entry.request) });
    entry.intent = { action_id: entry.request.emittedStep.action_id, action: entry.request.emittedStep.action, arguments: args, recorded_at: new Date().toISOString() };
    await save(state); return copy(entry.intent);
  });
}
export async function recordScienceHostObservation({ controller, role, observation } = {}) {
  const state = controllerState(controller);
  return serial(state, async () => {
    await validateCurrent(state);
    const entry = activeEntry(state.data, role);
    if (!entry?.intent) fail('SCIENCE_OBSERVATION_UNAVAILABLE');
    if (observation?.kind === 'host_update') {
      if (entry.observation?.status !== 'observed' || observation.action_id !== entry.intent.action_id || observation.agent_id !== entry.observation.agent_id || typeof observation.raw_result_text !== 'string' || !observation.tool_call || typeof observation.tool_call.name !== 'string' || !observation.tool_call.arguments || typeof observation.tool_call.arguments !== 'object') fail('SCIENCE_HOST_UPDATE_INVALID');
      const previous = (entry.host_updates ?? []).find(update => observation.host_event_id
        ? update.host_event_id === observation.host_event_id : !update.host_event_id && same(update, observation));
      if (previous) {
        if (!same(previous, observation)) fail('SCIENCE_HOST_EVENT_CONFLICT');
        return copy(previous);
      }
      if (entry.receipt) fail('SCIENCE_OBSERVATION_UNAVAILABLE');
      const update = copy(observation); (entry.host_updates ??= []).push(update); await save(state); return update;
    }
    if (entry.observation?.status === 'observed' && same(entry.raw_observation, observation)) return copy(entry.observation);
    if (entry.observation?.status === 'observed') fail('SCIENCE_HOST_EVENT_CONFLICT');
    if (entry.receipt) fail('SCIENCE_OBSERVATION_UNAVAILABLE');
    const request = entry.request;
    const checked = ingestObservedRunStep({ packet: request.packet, emittedStep: request.emittedStep, observation, run: { run_id: state.data.prepared.runControl.run_id } });
    if (entry.raw_observation && same(entry.raw_observation, observation) && same(entry.observation, checked)) {
      if (checked.status !== 'observed') fail('SCIENCE_OBSERVATION_INVALID');
      return copy(checked);
    }
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
    const entry = activeEntry(state.data, role), task = activeTask(state.data, role), root = state.data.prepared.paths.runRoot;
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
    activeEntry(state.data, role).receipt = copy(existing.receipt); await save(state); return copy(existing.receipt);
  });
}
/** Freeze the first downstream request and owned checkpoint before science is transferred. */
export async function createScienceHandoff({ controller, checkpointTask } = {}) {
  const state = controllerState(controller);
  return serial(state, async () => {
    await validateCurrent(state);
    if (scienceCalls(state.data) > state.data.prepared.runControl.reading_first_binding.prior_calls) fail('SCIENCE_READING_BUDGET_REBIND_REQUIRED');
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
      const initial = createReadingFirstRequests({ handoff, runControl, reuseInitialInstruction: true, initialInstructionToken: state.data.handoff.instructionToken, compactionReminders: state.data.compaction_reminders });
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
