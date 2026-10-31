import { readFile, lstat, readdir } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, isAbsolute } from 'node:path';
import { inspectApaConfig, checkHostProfile, evaluateReadingPreflight } from '../lib/apa-config.mjs';
import { prepareConfiguredReading, getConfiguredReadingDispatchArguments, materializeConfiguredReadingCandidate } from './configured-reading.mjs';
import { buildReadingSessionTasks } from './reading-session-tasks.mjs';
import { ingestObservedRunStep } from './phase21-runner.mjs';
import { COMPACTION_POLICY } from './reading-compaction.mjs';
import { createOwnedArtifactBroker, commitOwnedArtifact, readOwnedArtifact } from './owned-artifact-store.mjs';
import { createScienceController, restoreScienceController, getScienceState, prepareScienceRequests, getScienceRequest, recordScienceDispatchIntent, recordScienceHostObservation, acceptScienceResult, createScienceHandoff, handleScienceCompactionBoundary } from './science-controller.mjs';
import { fingerprintReadingFirst, restoreReadingFirstRuntime, snapshotReadingFirstRuntime, getReadingFirstPendingRequests, getReadingFirstState, recordReadingFirstRequestEvent, getReadingFirstRequestEvents, acceptReadingFirstResult, createReadingFirstEnrichmentRequests, createReadingFirstDraftRequests, createReadingFirstPresentationRequest, createReadingFirstReviewRequest, createReadingFirstRevisionRequests, validateReadingFirstRenderRepair, handleReadingCompactionBoundary, captureReadingFirstPublicationSource } from './reading-first-runtime.mjs';

const sessions = new WeakMap();
const fail = code => { throw Object.assign(new Error(code), { code }); };
const text = value => typeof value === 'string' && !!value.trim();
const clone = value => structuredClone(value);
const same = (a, b) => fingerprintReadingFirst(a) === fingerprintReadingFirst(b);
const stateOf = session => { const state = sessions.get(session); if (!state) fail('READING_SESSION_REQUIRED'); return state; };
const capability = (state, task) => state.broker.issueCapability({ runId: state.prepared.runControl.run_id, actorId: task.owner_actor_id, role: task.role, artifactPath: task.artifact_path, revision: task.revision });
const controlPath = root => join(root, 'control', 'science-state.json');
const wrap = state => { const session = Object.freeze({ profile: 'reading-session-1.0' }); sessions.set(session, state); return session; };
const usesCompactionObservation = state => ['boundary-reminders-1.1', COMPACTION_POLICY].includes(state.prepared.runControl.reading_first_binding.compaction_policy?.profile);
const needsCompactionObservation = (state, reminder) => usesCompactionObservation(state)
  && reminder?.status !== 'prompted' && !state.compactionInput?.observation && state.compactionInput?.userDecision === undefined;
function evaluateSessionPreflight(state) {
  const inspection = clone(state.frozenInspection);
  const frozenPolicy = state.prepared.runControl.reading_first_binding.role_model_policy;
  const host = state.prepared.runControl.reading_first_binding.host;
  if (!host || host.dispatch.model_argument !== null) {
    const asChoice = role => ({ mode: 'explicit', ...frozenPolicy.roles[role] });
    inspection.config.models = { science: asChoice('evidence'), overrides: Object.fromEntries(['methods', 'results', 'interpretation', 'scientific-reading', 'integration'].map(role => [role, asChoice(role)])), roles: Object.fromEntries(['english-writer', 'chinese-writer', 'translation', 'reading-editor', 'independent-verifier'].map(role => [role, asChoice(role)])) };
  }
  inspection.dependencies = inspection.dependencies.map(item => {
    try {
      const stat = statSync(item.path), directory = item.key === 'parser.runtime_home';
      return { ...item, status: (directory ? stat.isDirectory() : stat.isFile()) ? 'available' : 'wrong-type' };
    } catch (error) { return { ...item, status: error.code === 'ENOENT' ? 'missing' : 'unavailable' }; }
  });
  if (state.hostProfile) inspection.host_check = checkHostProfile(inspection.config, state.hostProfile);
  const result = evaluateReadingPreflight({ inspection, hostProfile: state.hostProfile, evidence: state.evidence });
  const observed = state.hostProfile?.session, frozen = state.prepared.runControl.reading_first_binding.role_model_policy.main_session;
  const inherited = state.prepared.runControl.reading_first_binding.host?.dispatch.model_argument === null;
  const mustMatch = state.needsInitialSessionMatch || inherited;
  const available = state.hostProfile?.sources?.session && state.hostProfile.sources.session !== 'unavailable' && text(observed?.model);
  const status = !mustMatch ? 'pass' : !available ? 'unknown' : observed.model === frozen.model && (observed.reasoning_effort ?? null) === (frozen.reasoning_effort ?? null) ? 'pass' : 'blocked';
  result.checks.push({ id: 'main_session', status, reason: status === 'pass' ? mustMatch ? 'current session matches frozen identity' : 'frozen model is explicitly dispatched' : status === 'blocked' ? 'current session differs from frozen identity' : 'current session evidence missing' });
  if (status !== 'pass') { result.reasons.push(`main_session: ${result.checks.at(-1).reason}`); if (result.status !== 'blocked') result.status = status; }
  return result;
}
async function sealInitialPreflight(state) {
  if (!state.needsInitialSessionMatch || state.preflight.status !== 'pass') return;
  await commitControl(state, state.checkpoints[1], { schema_version: 'reading-session-preflight-1.0', run_id: state.prepared.runControl.run_id, configuration_fingerprint: state.prepared.configurationFingerprint, main_session: state.prepared.runControl.reading_first_binding.role_model_policy.main_session, host: state.hostProfile.host, session_evidence: state.hostProfile.session });
  state.needsInitialSessionMatch = false;
}
const checkpointBindings = (brokerConfig, runId, actorId) => brokerConfig.authorized_bindings.filter(row => row.run_id === runId && row.actor_id === actorId && row.role === 'control' && /^control\/reading-checkpoint-\d+\.json$/.test(row.artifact_path)).map(row => ({ artifact_id: `reading-checkpoint-${row.revision}`, artifact_path: row.artifact_path, revision: row.revision, owner_actor_id: actorId, role: 'control' })).sort((a, b) => Number(a.revision) - Number(b.revision));
function extendsSnapshot(later, earlier) {
  const a = later.state, b = earlier.state;
  if (a.callsUsed < b.callsUsed || a.reviews < b.reviews) return false;
  for (const key of ['observations', 'requestLog', 'enrichmentRecords', 'enrichmentSources']) {
    const left = a[key] ?? [], right = b[key] ?? [];
    if (!Array.isArray(left) || !Array.isArray(right) || left.length < right.length || right.some((item, index) => !same(item, left[index]))) return false;
  }
  const acceptedReviews = snapshot => snapshot.request_entries.filter(entry => entry.consumed && entry.request.task.role === 'independent-verifier').length;
  if (acceptedReviews(a) === acceptedReviews(b) && b.review && (!a.review || !same(a.review, b.review))) return false;
  for (const prior of b.request_entries) {
    const next = a.request_entries.find(row => row.key === prior.key);
    if (!next || !same(next.request, prior.request) || prior.consumed && !next.consumed) return false;
    for (const [key, event] of Object.entries(prior.events ?? {})) if (!next.events?.[key] || !same(next.events[key], event)) return false;
  }
  for (const [key, prior] of Object.entries(b.compaction_reminders ?? {})) {
    const next = a.compaction_reminders?.[key];
    if (!next || prior.status !== 'prompted' && !same(prior, next) || prior.status === 'prompted' && !['prompted', 'skipped', 'completed'].includes(next.status)) return false;
    if (prior.status === next.status && !same(prior, next)) return false;
  }
  return true;
}
async function existingControl(state, task) {
  const found = await readOwnedArtifact({ artifactRoot: state.prepared.paths.runRoot, artifactId: task.artifact_id });
  if (!found) {
    try { await lstat(join(state.prepared.paths.runRoot, task.artifact_path)); fail('READING_SESSION_CHECKPOINT_ORPHAN'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return null;
  }
  if (found.receipt.path !== task.artifact_path || found.receipt.revision !== task.revision || found.receipt.owner_actor_id !== task.owner_actor_id || found.receipt.role !== 'control' || found.receipt.run_id !== state.prepared.runControl.run_id) fail('READING_SESSION_CHECKPOINT_CONFLICT');
  return found;
}
async function commitControl(state, task, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  const receipt = await commitOwnedArtifact({ artifactRoot: state.prepared.paths.runRoot, dispatchContext: state.broker.dispatchContext, capability: capability(state, task), artifact: { artifact_id: task.artifact_id, path: task.artifact_path, content: bytes }, expectedRevision: task.revision });
  const saved = await readOwnedArtifact({ artifactRoot: state.prepared.paths.runRoot, artifactId: task.artifact_id });
  if (!saved || !same(receipt, saved.receipt) || !saved.bytes.equals(bytes)) fail('READING_SESSION_CHECKPOINT_INVALID');
  return receipt;
}
async function saveReading(state, snapshot = snapshotReadingFirstRuntime(state.reading)) {
  const task = state.checkpoints[state.nextCheckpoint];
  if (!task) fail('CONTROL_CHECKPOINT_CAPACITY');
  let receipt;
  try { receipt = await commitControl(state, task, snapshot); }
  catch (error) { state.poisoned = true; throw error; }
  state.nextCheckpoint++; state.checkpointReceipt = receipt; return receipt;
}

/** Start an explicitly authorized configured reading; no host invocation occurs here. */
export async function createReadingSession(options = {}) {
  const { repoRoot, runId, scientificInput, sourceLanguage, authorizationId, deadline, maxCalls, maxTotalCalls, sessionContext, hostProfile, evidence = {}, sciencePayloads = {}, maxControlCheckpoints = 16 + 8 * maxTotalCalls } = options;
  if (![repoRoot, runId, authorizationId, deadline].every(text) || !scientificInput || !sessionContext || !Number.isSafeInteger(maxTotalCalls) || !Number.isSafeInteger(maxControlCheckpoints) || maxControlCheckpoints < 4) fail('READING_SESSION_INPUT_INVALID');
  const inspection = inspectApaConfig({ repoRoot, hostProfile });
  const presentationMode = inspection.config?.reading?.presentation_mode;
  if (options.presentationMode !== undefined && options.presentationMode !== presentationMode) fail('READING_SESSION_PRESENTATION_CONFLICT');
  const tasks = buildReadingSessionTasks({ runId, scientificInput, sourceLanguage, checkpointCount: maxControlCheckpoints, controllerActorId: options.controllerActorId, taskOverrides: options.taskOverrides, scienceTaskOverrides: options.scienceTaskOverrides, includeRepairs: options.includeRepairs === true, presentationMode, enrichmentPolicy: options.enrichmentPolicy });
  const prepared = prepareConfiguredReading({ repoRoot, runId, scientificInput, sourceLanguage, authorizationId, deadline, maxCalls, maxTotalCalls, priorCalls: 6, sessionContext, hostProfile, taskBindings: tasks.taskBindings, controllerActorId: options.controllerActorId, ...(options.enrichmentPolicy !== undefined ? { enrichmentPolicy: options.enrichmentPolicy, enrichmentSessionProfile: 'reading-session-enrichment-1.0' } : {}) });
  const configBytes = await readFile(join(repoRoot, 'config', 'apa.local.json'));
  if (createHash('sha256').update(configBytes).digest('hex') !== prepared.configurationFingerprint || !same(JSON.parse(configBytes), inspection.config)) fail('READING_SESSION_CONFIG_CHANGED');
  const actor = prepared.runControl.reading_first_binding.controller_actor_id;
  const brokerConfig = { control_actor_id: actor, artifact_root: prepared.paths.runRoot, authorized_bindings: [...tasks.authorizedBindings, ...prepared.compactionControlBindings], run_controls: [prepared.runControl] };
  const broker = createOwnedArtifactBroker(brokerConfig);
  const frozenInspection = { config: clone(inspection.config), validation: clone(inspection.validation), dependencies: clone(inspection.dependencies) };
  const state = { prepared, broker, brokerConfig, tasks: tasks.scienceTasks, checkpoints: tasks.checkpoints, nextCheckpoint: 3, reading: null, handoff: null, checkpointReceipt: null, evidence: clone(evidence), hostProfile: clone(hostProfile), sciencePayloads: clone(sciencePayloads), presentation: null, resources: null, frozenInspection, needsInitialSessionMatch: true };
  const bootReceipt = await commitControl(state, tasks.checkpoints[0], { schema_version: 'reading-session-bootstrap-1.0', run_id: runId, science_state: controlPath(prepared.paths.runRoot), config_text: configBytes.toString('utf8'), inspection: frozenInspection });
  state.evidence.control_write = { status: 'pass', reference: `owned:${bootReceipt.artifact_id}` };
  state.preflight = evaluateSessionPreflight(state);
  await sealInitialPreflight(state);
  state.science = await createScienceController({ prepared, tasks: state.tasks, payloads: state.sciencePayloads, brokerConfig, statePath: controlPath(prepared.paths.runRoot) });
  return wrap(state);
}

/** Rebuild the original controllers from their owned science state and registered checkpoints. */
export async function resumeReadingSession({ runRoot } = {}) {
  if (!text(runRoot) || !isAbsolute(runRoot)) fail('READING_SESSION_ROOT_INVALID');
  const root = resolve(runRoot), statePath = controlPath(root);
  const envelope = JSON.parse(await readFile(statePath, 'utf8'));
  const data = envelope.data;
  if (!data?.prepared || resolve(data.prepared.paths.runRoot) !== root) fail('READING_SESSION_STATE_INVALID');
  const { prepared, tasks, brokerConfig, payloads = {} } = data;
  const science = await restoreScienceController({ statePath, prepared, tasks, payloads, brokerConfig });
  const actor = prepared.runControl.reading_first_binding.controller_actor_id;
  const checkpoints = checkpointBindings(brokerConfig, prepared.runControl.run_id, actor);
  if (checkpoints.length < 4 || checkpoints.some((row, index) => Number(row.revision) !== index + 1 || row.artifact_path !== `control/reading-checkpoint-${index + 1}.json`)) fail('READING_SESSION_STATE_INVALID');
  const broker = createOwnedArtifactBroker(brokerConfig);
  const state = { prepared, broker, brokerConfig, tasks, checkpoints, science, sciencePayloads: payloads, nextCheckpoint: 3, reading: null, handoff: null, checkpointReceipt: null, preflight: { status: 'unknown', reasons: ['current runtime evidence required'] }, evidence: {}, hostProfile: null, presentation: null, resources: null, needsInitialSessionMatch: true };
  const boot = await existingControl(state, checkpoints[0]);
  const bootValue = boot && JSON.parse(boot.bytes);
  if (!boot || bootValue.schema_version !== 'reading-session-bootstrap-1.0' || bootValue.run_id !== prepared.runControl.run_id || bootValue.science_state !== statePath || typeof bootValue.config_text !== 'string' || createHash('sha256').update(bootValue.config_text).digest('hex') !== prepared.configurationFingerprint || !bootValue.inspection?.config || !same(JSON.parse(bootValue.config_text), bootValue.inspection.config) || !Array.isArray(bootValue.inspection.dependencies)) fail('READING_SESSION_BOOTSTRAP_INVALID');
  state.frozenInspection = bootValue.inspection;
  state.evidence.control_write = { status: 'pass', reference: `owned:${boot.receipt.artifact_id}` };
  const seal = await existingControl(state, checkpoints[1]);
  if (seal) {
    const value = JSON.parse(seal.bytes);
    if (value.schema_version !== 'reading-session-preflight-1.0' || value.run_id !== prepared.runControl.run_id || value.configuration_fingerprint !== prepared.configurationFingerprint || !same(value.main_session, prepared.runControl.reading_first_binding.role_model_policy.main_session) || !text(value.host) || !value.session_evidence || value.session_evidence.model !== value.main_session.model || (value.session_evidence.reasoning_effort ?? null) !== (value.main_session.reasoning_effort ?? null)) fail('READING_SESSION_PREFLIGHT_INVALID');
    state.needsInitialSessionMatch = false;
  }
  const scienceState = getScienceState(science);
  if (!seal && (scienceState.reserved_calls || scienceState.handoff)) fail('READING_SESSION_PREFLIGHT_INVALID');
  if (scienceState.handoff) {
    const transferred = await createScienceHandoff({ controller: science, checkpointTask: checkpoints[2] });
    if (transferred.controller) { state.reading = transferred.controller; state.handoff = transferred.handoff; state.broker = transferred.broker; state.checkpointReceipt = transferred.checkpointReceipt; }
    else {
      state.handoff = transferred.handoff; state.broker = transferred.broker; state.checkpointReceipt = transferred.checkpointReceipt;
      const candidates = [{ receipt: state.checkpointReceipt, snapshot: JSON.parse((await readOwnedArtifact({ artifactRoot: root, artifactId: state.checkpointReceipt.artifact_id })).bytes) }];
      let gap = false;
      for (let i = 3; i < checkpoints.length; i++) {
        const found = await existingControl(state, checkpoints[i]);
        if (!found) { gap = true; continue; }
        if (gap) fail('READING_SESSION_CHECKPOINT_CONFLICT');
        candidates.push({ receipt: found.receipt, snapshot: JSON.parse(found.bytes) }); state.nextCheckpoint = i + 1;
      }
      const compactionTasks = Object.values(prepared.runControl.reading_first_binding.compaction_policy?.checkpoints ?? {}).flatMap(steps => Object.values(steps));
      for (const task of compactionTasks) { const found = await existingControl(state, task); if (found) candidates.push({ receipt: found.receipt, snapshot: JSON.parse(found.bytes) }); }
      let latest = candidates[0];
      for (const candidate of candidates) {
        const restored = await restoreReadingFirstRuntime({ handoff: state.handoff, runControl: transferred.runControl, checkpointReceipt: candidate.receipt });
        if (!restored.ok) fail(restored.errors[0].code);
        candidate.controller = restored.controller;
        const forward = extendsSnapshot(candidate.snapshot, latest.snapshot), backward = extendsSnapshot(latest.snapshot, candidate.snapshot);
        if (!forward && !backward || forward && backward && !same(candidate.snapshot, latest.snapshot)) fail('READING_SESSION_CHECKPOINT_CONFLICT');
        if (forward) latest = candidate;
      }
      state.checkpointReceipt = latest.receipt; state.reading = latest.controller;
      const reviewEntry = [...latest.snapshot.state.request_entries].reverse().find(entry => entry.request.task.role === 'independent-verifier' && entry.payload?.presentation);
      if (reviewEntry) state.reviewedPresentation = clone(reviewEntry.payload.presentation);
    }
  }
  state.resumed = true;
  return wrap(state);
}

function requestEventKey(event) {
  if (event.kind === 'host_update') return 'host_update:' + (event.host_event_id ?? fingerprintReadingFirst(event.observation));
  return event.kind;
}
function findReadingRequest(state, actionId) {
  return getReadingFirstPendingRequests(state.reading).find(request => request.emittedStep.action_id === actionId);
}
function actionForScience(state, role) {
  const item = getScienceRequest({ controller: state.science, role });
  return { role, ...item };
}

/** Compute the smallest next action; dispatch actions have already saved intent. */
export async function nextReadingAction(session) {
  const state = stateOf(session);
  if (state.poisoned) return { action: 'reconcile', code: 'READING_SESSION_RESTORE_REQUIRED' };
  if (state.preflight.status !== 'pass') return { action: 'provide-input', kind: 'runtime-evidence', preflight: clone(state.preflight) };
  if (!state.reading) {
    let current = getScienceState(state.science);
    if (current.expired) return { action: 'reconcile', code: 'READING_SESSION_DEADLINE_EXPIRED' };
    const boundary = current.compaction_boundary;
    if (boundary && !['skipped', 'completed'].includes(boundary.reminder.status)) {
      if (needsCompactionObservation(state, boundary.reminder)) return { action: 'provide-input', kind: 'compaction-observation', boundary_id: boundary.id };
      const decision = await handleScienceCompactionBoundary({ controller: state.science, ...(state.compactionInput ?? {}) });
      state.compactionInput = null;
      if (decision.action !== 'continue') return decision;
      current = getScienceState(state.science);
    }
    if (current.accepted_results === 6) {
      const result = await createScienceHandoff({ controller: state.science, checkpointTask: state.checkpoints[2] });
      state.broker = result.broker; state.handoff = result.handoff; state.checkpointReceipt = result.checkpointReceipt;
      if (result.controller) state.reading = result.controller;
      else {
        const restored = await restoreReadingFirstRuntime({ handoff: result.handoff, runControl: result.runControl, checkpointReceipt: result.checkpointReceipt });
        if (!restored.ok) fail(restored.errors[0].code);
        state.reading = restored.controller;
      }
      return nextReadingAction(session);
    }
    const unknown = Object.entries(current.roles).find(([, item]) => item.status === 'outcome_unknown');
    if (unknown) return { action: 'reconcile', role: unknown[0], action_id: unknown[1].action_id };
    const prepared = await prepareScienceRequests({ controller: state.science });
    if (prepared.length) {
      const { role } = prepared[0], intent = await recordScienceDispatchIntent({ controller: state.science, role });
      const request = actionForScience(state, role).request;
      return { action: 'dispatch', stage: 'science', role, action_id: intent.action_id, host_action: intent.action, arguments: intent.arguments, input_fingerprint: request.emittedStep.input_fingerprint, run_id: state.prepared.runControl.run_id, port: request.emittedStep.port };
    }
    const running = Object.entries(current.roles).find(([, item]) => item.status === 'observed');
    if (running) {
      const host = state.prepared.runControl.reading_first_binding.host;
      const handle = host && !host.dispatch.result_handle ? null : running[1].agent_id;
      return handle ? { action: 'wait', stage: 'science', role: running[0], action_id: running[1].action_id, host_handle: handle } : { action: 'reconcile', stage: 'science', role: running[0], action_id: running[1].action_id, code: 'HOST_HANDLE_UNKNOWN' };
    }
    return { action: 'reconcile', code: 'SCIENCE_ACTION_UNAVAILABLE' };
  }
  const current = getReadingFirstState(state.reading);
  if (current.status === 'completed_with_limits') return { action: 'complete', status: current.status, publishable: false };
  if (current.status === 'reading_complete') {
    if (!state.presentation && state.reviewedPresentation) {
      if (!state.resources || !state.renderOptions) return { action: 'provide-input', kind: 'render-assets' };
      const restored = await materializeConfiguredReadingCandidate({ prepared: state.prepared, controller: state.reading, handoff: state.handoff, resources: state.resources, ...state.renderOptions, candidateRevision: current.review_rounds, reuseExisting: true });
      if (restored.candidate.presentation_fingerprint !== state.reviewedPresentation.presentation_fingerprint) fail('READING_SESSION_REVIEWED_CANDIDATE_CHANGED');
      state.presentation = restored.candidate;
    }
    if (!state.presentation) return { action: 'reconcile', code: 'REVIEWED_PRESENTATION_UNAVAILABLE' };
    const source = await captureReadingFirstPublicationSource({ controller: state.reading, presentation: state.presentation });
    return { action: 'complete', status: current.status, publication_source: source, publishable: false };
  }
  let pending = getReadingFirstPendingRequests(state.reading);
  if (!pending.length) {
    if (state.nextCheckpoint >= state.checkpoints.length - 1) return { action: 'reconcile', code: 'CONTROL_CHECKPOINT_CAPACITY' };
    if (current.enrichment?.pending && (current.enrichment.round === 'initial' || current.enrichment.round === 'late' && current.status === 'revision_required')) {
      try { createReadingFirstEnrichmentRequests({ controller: state.reading }); }
      catch (error) { if (error.code === 'READING_FIRST_CALL_BUDGET_EXHAUSTED') return { action: 'reconcile', code: error.code }; throw error; }
    } else if (current.status === 'drafting' || current.status === 'ready_to_draft') createReadingFirstDraftRequests({ controller: state.reading });
    else if (current.status === 'pending_presentation') createReadingFirstPresentationRequest({ controller: state.reading });
    else if (current.status === 'pending_review') {
      const rendererRepair = current.review_rounds && current.review?.issues?.some(issue => issue.severity === 'material' && issue.repair_owner === 'renderer');
      if (rendererRepair && !state.rendererRepairReady) return { action: 'provide-input', kind: 'renderer-repair', review: current.review };
      if (!state.resources || !state.renderOptions) return { action: 'provide-input', kind: 'render-assets' };
      const result = await materializeConfiguredReadingCandidate({ prepared: state.prepared, controller: state.reading, handoff: state.handoff, resources: state.resources, ...state.renderOptions, candidateRevision: current.review_rounds + 1, reuseExisting: true,
        ...(rendererRepair ? { onDependencyBoundary: ({ phase, candidate }) => { if (phase === 'before-finalize') validateReadingFirstRenderRepair({ controller: state.reading, presentation: candidate }); } } : {}) });
      state.presentation = result.candidate;
      createReadingFirstReviewRequest({ controller: state.reading, presentation: state.presentation, ...(rendererRepair ? { renderRepair: true } : {}) });
    } else if (current.status === 'revision_required' || current.status === 'revising') {
      const material = current.review?.issues?.filter(issue => issue.severity === 'material') ?? [];
      if (material.length && material.every(issue => issue.repair_owner === 'renderer')) {
        if (!state.rendererRepairReady) return { action: 'provide-input', kind: 'renderer-repair', review: current.review };
        if (!state.resources || !state.renderOptions) return { action: 'provide-input', kind: 'render-assets' };
        const result = await materializeConfiguredReadingCandidate({ prepared: state.prepared, controller: state.reading, handoff: state.handoff, resources: state.resources, ...state.renderOptions, candidateRevision: 2, reuseExisting: true,
          onDependencyBoundary: ({ phase, candidate }) => { if (phase === 'before-finalize') validateReadingFirstRenderRepair({ controller: state.reading, presentation: candidate }); } });
        state.presentation = result.candidate;
        createReadingFirstReviewRequest({ controller: state.reading, presentation: state.presentation, renderRepair: true });
        await saveReading(state);
        return nextReadingAction(session);
      }
      try { createReadingFirstRevisionRequests({ controller: state.reading }); }
      catch (error) {
        if (error.code !== 'READING_FIRST_REVISION_UNAVAILABLE') throw error;
        try { createReadingFirstPresentationRequest({ controller: state.reading }); }
        catch (editorError) { if (editorError.code === 'READING_FIRST_EDITOR_UNAVAILABLE') return { action: 'provide-input', kind: 'repair', review: current.review }; throw editorError; }
      }
    } else return { action: 'reconcile', code: 'READING_SESSION_STAGE_UNAVAILABLE', status: current.status };
    await saveReading(state);
    pending = getReadingFirstPendingRequests(state.reading);
  }
  const request = pending[0], events = getReadingFirstRequestEvents({ controller: state.reading, request });
  if (events.intent) {
    if (state.resumed && request.task.source_root) {
      try {
        if ((await readdir(join(state.prepared.paths.runRoot, request.task.source_root))).length) return { action: 'reconcile', stage: 'reading', action_id: request.emittedStep.action_id, code: 'READING_SESSION_ENRICHMENT_RESULT_PENDING' };
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!events.host_observation) return { action: 'reconcile', stage: 'reading', action_id: request.emittedStep.action_id };
    const observed = ingestObservedRunStep({ packet: request.packet, emittedStep: request.emittedStep, run: { run_id: state.prepared.runControl.run_id }, observation: events.host_observation.payload });
    const host = state.prepared.runControl.reading_first_binding.host;
    const handle = host && !host.dispatch.result_handle ? null : observed.agent_id;
    return handle ? { action: 'wait', stage: 'reading', action_id: request.emittedStep.action_id, host_handle: handle } : { action: 'reconcile', stage: 'reading', action_id: request.emittedStep.action_id, code: 'HOST_HANDLE_UNKNOWN' };
  }
  // Reserve the intent, initial host return, result event and terminal snapshot.
  if (state.nextCheckpoint >= state.checkpoints.length - 3) return { action: 'reconcile', code: 'CONTROL_CHECKPOINT_CAPACITY' };
  const firstWriter = request.language === state.prepared.runControl.reading_first_binding.source_language && !request.task.task_id.endsWith('-r2');
  const firstReview = request.task.role === 'independent-verifier'
    && (usesCompactionObservation(state)
      ? request.task.task_id === state.prepared.runControl.reading_first_binding.task_bindings.review.task_id : current.review_rounds === 0);
  if (firstWriter || firstReview) {
    const boundaryId = firstReview ? 'before-review' : 'before-writer';
    const snapshot = snapshotReadingFirstRuntime(state.reading);
    const reminder = snapshot.state.compaction_reminders?.[boundaryId];
    if (!reminder || !['completed', 'skipped'].includes(reminder.status)) {
      if (needsCompactionObservation(state, reminder)) return { action: 'provide-input', kind: 'compaction-observation', boundary_id: boundaryId };
      const slot = state.prepared.runControl.reading_first_binding.compaction_policy.checkpoints[boundaryId][reminder?.status === 'prompted' ? 'resume' : 'decision'];
      const decision = await handleReadingCompactionBoundary({ controller: state.reading, checkpointReceipt: state.checkpointReceipt, hostRequests: pending.map(item => ({ action_id: item.emittedStep.action_id, status: 'prepared' })), ...(firstReview ? { presentation: state.presentation } : {}), capability: capability(state, slot), ...(state.compactionInput ?? {}) });
      state.compactionInput = null; state.checkpointReceipt = decision.receipt;
      if (decision.action !== 'continue') return decision;
    }
  }
  const args = getConfiguredReadingDispatchArguments({ prepared: state.prepared, request });
  const intent = { action_id: request.emittedStep.action_id, host_action: request.emittedStep.action, arguments: args };
  recordReadingFirstRequestEvent({ controller: state.reading, request, eventKey: 'intent', payload: intent });
  await saveReading(state);
  return { action: 'dispatch', stage: 'reading', ...intent, input_fingerprint: request.emittedStep.input_fingerprint, run_id: state.prepared.runControl.run_id, port: request.emittedStep.port };
}

/** Record observed host events or explicit runtime inputs without invoking a host tool. */
export async function recordReadingEvent(session, event = {}) {
  const state = stateOf(session);
  if (state.poisoned) fail('READING_SESSION_RESTORE_REQUIRED');
  if (event.kind === 'runtime-evidence') {
    if (!event.hostProfile || !event.evidence) fail('READING_SESSION_INPUT_INVALID');
    state.hostProfile = clone(event.hostProfile); state.evidence = { ...clone(event.evidence), control_write: state.evidence.control_write };
    state.preflight = evaluateSessionPreflight(state);
    await sealInitialPreflight(state);
    return clone(state.preflight);
  }
  if (event.kind === 'compaction') { state.compactionInput = clone(event.input ?? {}); return { recorded: true }; }
  if (event.kind === 'render-assets') { state.resources = clone(event.resources); state.renderOptions = clone(event.renderOptions ?? {}); return { recorded: true }; }
  if (event.kind === 'renderer-repair') {
    if (event.resources !== undefined) state.resources = clone(event.resources);
    if (event.renderOptions !== undefined) state.renderOptions = clone(event.renderOptions);
    state.rendererRepairReady = true;
    return { recorded: true };
  }
  if (!text(event.action_id) || !['host_observation', 'host_update', 'result'].includes(event.kind)) fail('READING_SESSION_EVENT_INVALID');
  if (!state.reading) {
    const found = Object.entries(getScienceState(state.science).roles).find(([, item]) => item.action_id === event.action_id);
    if (!found) fail('READING_SESSION_EVENT_ACTION_INVALID');
    const role = found[0];
    if (event.kind === 'result') return acceptScienceResult({ controller: state.science, role });
    return recordScienceHostObservation({ controller: state.science, role, observation: event.kind === 'host_update' ? { ...event.observation, kind: 'host_update', ...(event.host_event_id ? { host_event_id: event.host_event_id } : {}) } : event.observation });
  }
  const request = findReadingRequest(state, event.action_id);
  if (!request) {
    const snapshot = snapshotReadingFirstRuntime(state.reading);
    const entry = snapshot.state.request_entries.find(item => item.request.emittedStep.action_id === event.action_id);
    if (event.kind === 'result' && entry?.consumed && entry.events?.result) {
      if (!same(entry.events.result.payload, event.observation)) fail('READING_FIRST_REQUEST_EVENT_CONFLICT');
      if (entry.events.terminal) return clone(entry.events.terminal.payload);
      if (snapshot.state.rejection?.task_id === entry.request.task.task_id) return { receipt: clone(snapshot.state.rejection.receipt), status: 'completed_with_limits', rejection: clone(snapshot.state.rejection), checkpoint_required: false, publishable: false };
      fail('READING_SESSION_RESULT_RECONCILE_REQUIRED');
    }
    const previous = entry?.events?.[requestEventKey(event)];
    if (entry?.consumed && previous) {
      if (!same(previous.payload, event.observation)) fail('READING_FIRST_REQUEST_EVENT_CONFLICT');
      return clone(previous.payload);
    }
    fail('READING_SESSION_EVENT_ACTION_INVALID');
  }
  const prior = getReadingFirstRequestEvents({ controller: state.reading, request });
  if (!prior.intent) fail('READING_SESSION_EVENT_INTENT_REQUIRED');
  const key = requestEventKey(event), payload = event.observation;
  if (prior[key]) {
    if (!same(prior[key].payload, payload)) fail('READING_FIRST_REQUEST_EVENT_CONFLICT');
    if (event.kind !== 'result') return clone(prior[key].payload);
  }
  if (event.kind === 'result' && !prior.host_observation) fail('READING_SESSION_EVENT_OBSERVATION_REQUIRED');
  if (event.kind === 'result' && !same(prior.host_observation.payload, payload)) fail('READING_SESSION_OBSERVATION_CONFLICT');
  if (event.kind === 'host_observation' || event.kind === 'result') {
    const checked = ingestObservedRunStep({ packet: request.packet, emittedStep: request.emittedStep, run: { run_id: state.prepared.runControl.run_id }, observation: payload });
    if (checked.status !== 'observed') fail(checked.blocked_reason);
    if (prior.host_observation) {
      const original = ingestObservedRunStep({ packet: request.packet, emittedStep: request.emittedStep, run: { run_id: state.prepared.runControl.run_id }, observation: prior.host_observation.payload });
      if (original.agent_id !== checked.agent_id) fail('READING_SESSION_HOST_HANDLE_MISMATCH');
    }
  }
  if (event.kind === 'host_update') {
    const original = prior.host_observation && ingestObservedRunStep({ packet: request.packet, emittedStep: request.emittedStep, run: { run_id: state.prepared.runControl.run_id }, observation: prior.host_observation.payload });
    const host = state.prepared.runControl.reading_first_binding.host;
    if (!original || !original.agent_id || host && !host.dispatch.result_handle || payload?.action_id !== event.action_id || payload?.agent_id !== original.agent_id || typeof payload?.raw_result_text !== 'string' || !text(payload?.tool_call?.name) || !payload?.tool_call?.arguments) fail('READING_SESSION_HOST_UPDATE_INVALID');
  }
  if (state.nextCheckpoint >= state.checkpoints.length - (event.kind === 'result' ? 1 : 2)) return { action: 'reconcile', code: 'CONTROL_CHECKPOINT_CAPACITY' };
  if (!prior[key]) {
    recordReadingFirstRequestEvent({ controller: state.reading, request, eventKey: key, payload });
    await saveReading(state);
  }
  if (event.kind !== 'result') return clone(payload);
  const result = await acceptReadingFirstResult({ controller: state.reading, request, observation: payload, capability: capability(state, request.task), terminalCheckpoint: snapshot => saveReading(state, snapshot) });
  if (result.checkpoint_required === false && result.status === 'completed_with_limits') return result;
  recordReadingFirstRequestEvent({ controller: state.reading, request, eventKey: 'terminal', payload: result });
  await saveReading(state);
  return result;
}
