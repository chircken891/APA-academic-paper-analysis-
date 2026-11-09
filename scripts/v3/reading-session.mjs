import { readFile, lstat, readdir, link, unlink, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join, isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectApaConfig, checkHostProfile, evaluateReadingPreflight } from '../lib/apa-config.mjs';
import { prepareConfiguredReading, getConfiguredReadingDispatchArguments, materializeConfiguredReadingCandidate, DEFAULT_CONFIGURED_INSTRUCTION_PROFILE } from './configured-reading.mjs';
import { resolveHostContinuation } from '../lib/apa-host-capabilities.mjs';
import { buildReadingActionSummary } from './reading-action-summary.mjs';
import { assertBatchRunOptions, readBatchRun, writeBatchCheckpoint } from './reading-batch-summary.mjs';
import { readCommittedReadingFirstKnowledgeRegistry } from './reading-first-knowledge-registry.mjs';
import { assertReadingFirstRegisteredSourcesCurrent } from './reading-first-publication.mjs';
import { readingFirstUsedMethodSources } from './reading-first-runtime.mjs';
import { readRegisteredSourceMatchMetadata } from './reading-source-policy.mjs';
import { checkTranslationProgress, evaluateTranslationContinuation } from './reading-translation-progress.mjs';
import { getScienceBudgetSummary, getSciencePendingContinuations, getScienceContinuation, reserveScienceContinuation, markScienceContinuationDispatched, recordScienceContinuationReceipt, recordScienceComputerControlObservation, getScienceComputerControlReport } from './science-controller.mjs';
import { assertReadingBindingCurrent, getReadingBudgetSummary, getReadingPendingContinuations, reserveReadingContinuation, markReadingContinuationDispatched, recordReadingContinuationReceipt } from './reading-first-runtime.mjs';
import { buildReadingSessionTasks } from './reading-session-tasks.mjs';
import { ingestObservedRunStep } from './phase21-runner.mjs';
import { COMPACTION_POLICY } from './reading-compaction.mjs';
import { validateHostReceiptEvidence, normalizeHostReceipt } from './reading-host-evidence.mjs';
import { inspectReadingRuntime, validateRuntimeRepairApproval, validateHistoricalRuntimeRepairApproval, validateRuntimeRebindApproval, describeReadingRuntimeChanges } from './reading-runtime-binding.mjs';
import { abandonReadingRuntimeSnapshotReference, prepareReadingRuntimeSnapshot, previewReadingRuntimeSnapshot, readReadingRuntimeSnapshotReference, registerReadingRuntimeSnapshotReference, verifyReadingRuntimeSnapshot } from './reading-runtime-snapshot.mjs';
import { closeReadingRuntimeRun, cleanupReadingRuntimeRun, readReadingRuntimeTerminal, registerReadingRuntimeCleanupFiles, withReadingRuntimeConsumer } from './reading-runtime-cleanup.mjs';
import { prepareReadingSessionExecution, readReadingSessionExecution, retryReadingSessionCleanup } from './reading-session-cli.mjs';
import { createOwnedArtifactBroker, commitOwnedArtifact, readOwnedArtifact } from './owned-artifact-store.mjs';
import { recoverReadingFirstRejectedEditor, authorizeReadingFirstContinuation, inspectReadingFirstContinuation, annotateReadingFirstReviewScope, inspectReadingFirstSavedCandidate, registerReadingFirstUserRevision, finalizeReadingFirstUserRevision, retainReviewedReadingFirstCandidate, recordReadingFirstKnowledgeIdentityResolution, recordReadingFirstResourceRepair, getReadingFirstRenderedResources } from './reading-first-runtime.mjs';
import { createScienceController, restoreScienceController, getScienceState, prepareScienceRequests, getScienceRequest, recordScienceDispatchIntent, recordScienceHostObservation, acceptScienceResult, createScienceHandoff, handleScienceCompactionBoundary } from './science-controller.mjs';
import { fingerprintReadingFirst, restoreReadingFirstRuntime, snapshotReadingFirstRuntime, getReadingFirstPendingRequests, getReadingFirstState, recordReadingFirstRequestEvent, getReadingFirstRequestEvents, acceptReadingFirstResult, createReadingFirstEnrichmentRequests, createReadingFirstDraftRequests, createReadingFirstPresentationRequest, createReadingFirstReviewRequest, createReadingFirstRevisionRequests, validateReadingFirstRenderRepair, handleReadingCompactionBoundary, captureReadingFirstPublicationSource } from './reading-first-runtime.mjs';

const sessions = new WeakMap();
const delegatedSessions = new WeakMap();
const CODE_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const snapshotBinding = manifest => manifest?.profile === 'reading-runtime-snapshot-1.0';
const snapshotApi = manifest => import(pathToFileURL(join(manifest.repo_root, 'scripts', 'v3', 'reading-session.mjs')).href);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const text = value => typeof value === 'string' && !!value.trim();
const clone = value => structuredClone(value);
const validRenderOptions = value => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => ['targetRegistry', 'existingTargets', 'knowledgeRegistry'].includes(key));
const same = (a, b) => fingerprintReadingFirst(a) === fingerprintReadingFirst(b);
const stateOf = session => { const state = sessions.get(session); if (!state) fail('READING_SESSION_REQUIRED'); return state; };
// These output checks run before acceptReadingFirstResult commits or consumes the task.
const resumableResultCodes = new Set([
  'READING_FIRST_EDITOR_SCHEMA_INVALID',
  'READING_FIRST_EDITOR_FINGERPRINT_INVALID',
  'READING_FIRST_EDITOR_CONTENT_INVALID',
  'READING_FIRST_EDITOR_SECTION_INVALID',
  'READING_FIRST_EDITOR_EMPHASIS_INVALID',
  'READING_FIRST_EDITOR_SUBHEADING_INVALID',
  'READING_FIRST_EDITOR_VISUAL_INVALID',
  'READING_FIRST_EDITOR_METHOD_INVALID',
  'READING_FIRST_EDITOR_BILINGUAL_METHODS_INVALID',
  'READING_FIRST_EDITOR_ARGUMENT_INVALID',
  'READING_FIRST_EDITOR_ARGUMENT_SECTION_INVALID',
  'READING_FIRST_EDITOR_ARGUMENT_TEXT_INVALID',
  'READING_FIRST_EDITOR_ARGUMENT_CLAIMS_INVALID',
  'READING_FIRST_EDITOR_ARGUMENT_BRANCHES_INVALID',
  'READING_FIRST_EDITOR_ARGUMENT_FINDINGS_INVALID',
  'READING_FIRST_EDITOR_ARGUMENT_RELATIONS_INVALID',
  'READING_FIRST_EDITOR_ARGUMENT_CYCLE',
  'READING_FIRST_EDITOR_ARGUMENT_PATH_INVALID',
  'READING_FIRST_VIEW_INVALID',
  'READING_FIRST_VIEW_LAYOUT_INVALID',
  'READING_FIRST_ENRICHMENT_CONSUMPTION_REQUIRED',
  'RF_OBSIDIAN_KNOWLEDGE_CONTENT_INVALID',
  'READING_FIRST_REVIEW_INVALID',
]);
const capability = (state, task) => state.broker.issueCapability({ runId: state.prepared.runControl.run_id, actorId: task.owner_actor_id, role: task.role, artifactPath: task.artifact_path, revision: task.revision });
const controlPath = root => join(root, 'control', 'science-state.json');
const runtimeLocation = state => ({ repoRoot: state.prepared.runControl.reading_first_binding.configured_setup.knowledge_registry.vault_root,
  runId: state.prepared.runControl.run_id, runRoot: state.prepared.paths.runRoot });
const runtimeInspection = state => inspectReadingRuntime({ manifest: state.runtimeBinding, ...(snapshotBinding(state.runtimeBinding) ? runtimeLocation(state) : {}) });
const approvalCheckpoint = (approval, runId) => approval.checkpoint_fingerprints?.[runId] ?? approval.checkpoint_fingerprint;

function delegateSession(session, api, execution) {
  delegatedSessions.set(session, { api, execution });
  return session;
}

function withSessionConsumer(state, work) {
  if (!snapshotBinding(state.runtimeBinding)) return work();
  const location = runtimeLocation(state);
  const guarded = async () => {
    if (await readReadingRuntimeTerminal(location)) fail('READING_SESSION_TERMINATED');
    const reference = readReadingRuntimeSnapshotReference(location);
    const current = reference?.pending_manifest ? (await readReadingSessionExecution(location.runRoot)).manifest : reference?.manifest;
    if (current?.fingerprint !== state.runtimeBinding.fingerprint && !state.runtimeRestartRequired) fail('READING_SESSION_RUNTIME_RESTART_REQUIRED');
    return work();
  };
  return state.consumerHeld ? guarded() : withReadingRuntimeConsumer(location, guarded);
}
async function runtimeCheckpoint(state) {
  const science = JSON.parse(await readFile(controlPath(state.prepared.paths.runRoot), 'utf8'));
  const receipts = [];
  for (const task of state.checkpoints) {
    const found = await existingControl(state, task);
    if (found) receipts.push({ path: task.artifact_path, sha256: found.receipt.sha256 });
  }
  const compaction = Object.values(state.prepared.runControl.reading_first_binding.compaction_policy?.checkpoints ?? {}).flatMap(steps => Object.values(steps));
  for (const task of compaction) {
    const found = await existingControl(state, task);
    if (found) receipts.push({ path: task.artifact_path, sha256: found.receipt.sha256 });
  }
  return fingerprintReadingFirst({ science: science.fingerprint, receipts });
}
const sessionBindings = (brokerConfig, runId, actorId) => brokerConfig.authorized_bindings.filter(row => row.run_id === runId && row.actor_id === actorId && row.role === 'control' && /^control\/session-state-\d+\.json$/.test(row.artifact_path)).map(row => ({ artifact_id: `session-state-${row.revision}`, artifact_path: row.artifact_path, revision: row.revision, owner_actor_id: actorId, role: 'control' })).sort((a, b) => Number(a.revision) - Number(b.revision));
async function readSessionMetadata(state) {
  let latest = null, gap = false;
  for (const task of state.sessionCheckpoints) {
    const found = await existingControl(state, task);
    if (!found) { gap = true; continue; }
    if (gap) fail('READING_SESSION_METADATA_CONFLICT');
    const value = JSON.parse(found.bytes);
    if (value.schema_version !== 'reading-session-state-2.2' || value.run_id !== state.prepared.runControl.run_id || !Array.isArray(value.approvals)
      || latest && (value.approvals.length < latest.approvals.length || latest.approvals.some((item, index) => !same(item, value.approvals[index])))) fail('READING_SESSION_METADATA_CONFLICT');
    latest = value; state.nextSessionCheckpoint++;
  }
  const initial = state.prepared.runControl.reading_first_binding.configured_setup.runtime_binding;
  let prior = initial;
  for (const item of latest?.approvals ?? []) {
    if (!item || !same(item.previous, prior) || item.approval?.previous_runtime_fingerprint !== prior.fingerprint || item.approval?.current_runtime_fingerprint !== item.current?.fingerprint) fail('READING_SESSION_METADATA_CONFLICT');
    const runId = state.prepared.runControl.run_id;
    if (!validateHistoricalRuntimeRepairApproval({ approval: item.approval, runId, checkpointFingerprint: approvalCheckpoint(item.approval, runId), previous: item.previous, current: item.current,
      ...(snapshotBinding(item.current) ? runtimeLocation(state) : {}) }).valid) fail('READING_SESSION_APPROVAL_INVALID');
    prior = item.current;
  }
  state.runtimeBinding = prior;
  state.approvals = clone(latest?.approvals ?? []);
  state.runtimeRestartRequired = state.approvals.at(-1)?.restart_process_id === process.pid;
  if (latest?.render_options !== undefined && !validRenderOptions(latest.render_options)) fail('READING_SESSION_METADATA_CONFLICT');
  state.renderOptions = latest?.render_options === undefined ? undefined : clone(latest.render_options);
  state.rendererRepairReady = latest?.renderer_repair_ready === true;
  state.translationStop = clone(latest?.translation_stop ?? null);
}
async function refreshSessionResources(state) {
  if (!state.reading) return;
  const binding=state.prepared.runControl.reading_first_binding;
  const resource=await getReadingFirstRenderedResources({controller:state.reading});
  if (!resource) fail('READING_SESSION_RESOURCE_MANIFEST_INVALID');
  const {ref,receipt,resources:rows}=resource;
  const integration=state.handoff.science.find(item=>item.receipt.role==='integration');
  const value=integration.content, sources=state.handoff.sources;
  if (!integration.artifact_root && (!same(ref,state.visualHandoff?.resource_manifest)
    || !same(receipt,state.visualHandoff?.receipt) || !same(sources,state.visualHandoff?.sources))) fail('READING_SESSION_RESOURCE_MANIFEST_INVALID');
  if (!Array.isArray(value.presentation?.sources)) fail('READING_SESSION_RESOURCE_MANIFEST_INVALID');
  const registered = value.presentation.sources.map(item => {
    const source = sources.find(row => row.id === item.id);
    if (!source || sources.filter(row => row.id === item.id).length !== 1 || typeof item.path !== 'string' || !/^(Raw|Clippings)\//.test(item.path)) fail('READING_SESSION_RESOURCE_MANIFEST_INVALID');
    if (binding.configured_setup.source_policy === 'clippings-originals-1.0') {
      const location = binding.configured_setup.source_locations?.find(row => row.source_id === item.id);
      if (!item.path.startsWith('Clippings/') || location?.vault_path !== item.path || location.path !== source.path
        || location.sha256 !== source.sha256 || location.byte_length !== source.byte_length) fail('READING_SESSION_RESOURCE_MANIFEST_INVALID');
    }
    return { path: item.path, source_path: source.path, sha256: source.sha256, byte_length: source.byte_length };
  });
  state.resources = [...registered, ...rows.map(row => ({ path: row.path, source_path: row.source_path, sha256: row.sha256, byte_length: row.byte_length }))];
}
function sessionMetadata(state, approvals = state.approvals) {
  return { schema_version: 'reading-session-state-2.2', run_id: state.prepared.runControl.run_id, approvals: clone(approvals),
    ...(state.renderOptions !== undefined ? { render_options: clone(state.renderOptions) } : {}), renderer_repair_ready: state.rendererRepairReady === true, ...(state.translationStop ? { translation_stop: clone(state.translationStop) } : {}) };
}

async function saveSessionMetadata(state, value = sessionMetadata(state)) {
  const task = state.sessionCheckpoints[state.nextSessionCheckpoint];
  if (!task) fail('CONTROL_CHECKPOINT_CAPACITY');
  try { await commitControl(state, task, value); } catch (error) { state.poisoned = true; throw error; }
  state.nextSessionCheckpoint++;
}

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
  const result = evaluateReadingPreflight({ inspection, hostProfile: state.hostProfile, evidence: state.evidence, instructionProfile: state.prepared.runControl.reading_first_binding.configured_setup?.instruction_profile });
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
  await commitControl(state, state.checkpoints[1], { schema_version: 'reading-session-preflight-1.0', run_id: state.prepared.runControl.run_id, configuration_fingerprint: state.prepared.configurationFingerprint, main_session: state.prepared.runControl.reading_first_binding.role_model_policy.main_session, host: state.hostProfile.host, session_evidence: state.hostProfile.session, evidence: clone(state.evidence) });
  state.needsInitialSessionMatch = false;
}
const checkpointBindings = (brokerConfig, runId, actorId) => brokerConfig.authorized_bindings.filter(row => row.run_id === runId && row.actor_id === actorId && row.role === 'control' && /^control\/reading-checkpoint-\d+\.json$/.test(row.artifact_path)).map(row => ({ artifact_id: `reading-checkpoint-${row.revision}`, artifact_path: row.artifact_path, revision: row.revision, owner_actor_id: actorId, role: 'control' })).sort((a, b) => Number(a.revision) - Number(b.revision));
function extendsSnapshot(later, earlier) {
  const a = later.state, b = earlier.state;
  if (a.callsUsed < b.callsUsed || a.reviews < b.reviews) return false;
  if (b.reviewExtension && (!a.reviewExtension || !same(a.reviewExtension,b.reviewExtension))) return false;
  if ((b.continuationAuthorizations ?? []).some((row,index)=>!a.continuationAuthorizations?.[index] || !same(a.continuationAuthorizations[index],row))) return false;
  if (b.repairContinuation && (!a.repairContinuation || !same(a.repairContinuation,b.repairContinuation))) return false;
  if (b.resourceRepair && (!a.resourceRepair || !same(a.resourceRepair, b.resourceRepair))) return false;
  if (b.executionLedger) {
    if (!a.executionLedger || a.executionLedger.length < b.executionLedger.length) return false;
    const rank = { prepared: 0, issued: 1, observed: 2 };
    for (let i = 0; i < b.executionLedger.length; i++) {
      const { status: oldStatus, receipt: oldReceipt, ...oldRow } = b.executionLedger[i];
      const { status: newStatus, receipt: newReceipt, ...newRow } = a.executionLedger[i];
      if (!same(oldRow, newRow) || rank[newStatus] < rank[oldStatus]
        || oldReceipt && (!newReceipt || !same(oldReceipt, newReceipt)) && !(oldReceipt.status === 'outcome_unknown' && newReceipt && newReceipt.status !== 'outcome_unknown')) return false;
    }
  }
  for (const key of ['observations', 'requestLog', 'enrichmentRecords', 'enrichmentSources', 'repairRecoveries', 'reviewScopeNotes', 'candidateInventories', 'user_revisions', 'userRevisionChecks', 'userRevisionWithdrawals', 'knowledgeIdentityResolutions']) {
    const left = a[key] ?? [], right = b[key] ?? [];
    if (!Array.isArray(left) || !Array.isArray(right) || left.length < right.length || right.some((item, index) => !same(item, left[index]))) return false;
  }
  const acceptedReviews = snapshot => snapshot.request_entries.filter(entry => entry.consumed && entry.request.task.role === 'independent-verifier').length;
  if (acceptedReviews(a) === acceptedReviews(b) && b.review && (!a.review || !same(a.review, b.review))) return false;
  for (const prior of b.request_entries) {
    const next = a.request_entries.find(row => row.key === prior.key);
    if (!next || !same(next.request, prior.request) || prior.consumed && !next.consumed) return false;
    for (const [key, event] of Object.entries(prior.events ?? {})) {
      const newer = next.events?.[key];
      if (!newer || !same(newer, event) && !(key === 'host_observation' && event.payload?.status === 'outcome_unknown' && newer.payload?.status !== 'outcome_unknown')) return false;
    }
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

// The owned store writes the artifact before its receipt. Preserve only the exact staged bytes if that write was interrupted.
async function archiveUnreceiptedRebind(state, reference) {
  const checkpoint = reference.pending_checkpoint;
  if (!checkpoint) return;
  const task = state.sessionCheckpoints.find(item => item.artifact_id === checkpoint.artifact_id);
  if (!task) fail('READING_SESSION_METADATA_CONFLICT');
  const runRoot = state.prepared.paths.runRoot;
  if (await readOwnedArtifact({ artifactRoot: runRoot, artifactId: task.artifact_id })) return;
  const source = join(runRoot, task.artifact_path);
  let file;
  try { file = await lstat(source); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!file.isFile()) fail('READING_SESSION_CHECKPOINT_ORPHAN');
  const bytes = await readFile(source), hash = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
  if (hash !== checkpoint.sha256 || bytes.length !== checkpoint.byte_length) fail('READING_SESSION_CHECKPOINT_ORPHAN');
  const archivePath = task.artifact_path + '.abandoned-' + hash.slice(7), target = join(runRoot, archivePath);
  try { await link(source, target); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (!(await lstat(target)).isFile() || !(await readFile(target)).equals(bytes)) fail('READING_SESSION_METADATA_CONFLICT');
  const recordPath = target + '.json';
  const record = Buffer.from(JSON.stringify({ artifact_id: task.artifact_id, original_path: task.artifact_path, archive_path: archivePath,
    sha256: hash, byte_length: bytes.length, pending_runtime_fingerprint: reference.pending_manifest.fingerprint }) + '\n');
  const staging = recordPath + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(staging, record, { flag: 'wx' });
    try { await link(staging, recordPath); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  } finally {
    try { await unlink(staging); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!(await lstat(recordPath)).isFile() || !(await readFile(recordPath)).equals(record) || !(await readFile(source)).equals(bytes)) fail('READING_SESSION_METADATA_CONFLICT');
  await unlink(source);
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
export async function createReadingSession(options = {}, execution) {
  execution ??= await prepareReadingSessionExecution(options);
  verifyReadingRuntimeSnapshot(execution);
  if (resolve(execution.manifest.repo_root) !== CODE_ROOT) {
    const api = await snapshotApi(execution.manifest);
    return delegateSession(await api.createReadingSession(options, execution), api, execution);
  }
  const start = async () => {
    if (await readReadingRuntimeTerminal(execution)) fail('READING_SESSION_TERMINATED');
    return createSession(options, execution);
  };
  return execution.consumerHeld ? start() : withReadingRuntimeConsumer(execution, start);
}

async function createSession(options, execution) {
  const { repoRoot, runId, scientificInput, sourceLanguage, authorizationId, maxCalls, maxTotalCalls, sessionContext, hostProfile, evidence = {}, sciencePayloads = {}, maxControlCheckpoints = 16 + 8 * maxTotalCalls } = options;
  if (![repoRoot, runId, authorizationId].every(text) || !scientificInput || !sessionContext || !Number.isSafeInteger(maxTotalCalls) || !Number.isSafeInteger(maxControlCheckpoints) || maxControlCheckpoints < 4) fail('READING_SESSION_INPUT_INVALID');
  const inspection = inspectApaConfig({ repoRoot, hostProfile });
  const reference = execution && readReadingRuntimeSnapshotReference({ repoRoot, runId });
  const batchRun = execution && readBatchRun(execution.runRoot, runId, reference?.batch_run_sha256);
  if (batchRun) assertBatchRunOptions(batchRun, options, { manifest: execution.manifest, configurationFingerprint: inspection.fingerprint });
  const presentationMode = inspection.config?.reading?.presentation_mode;
  if (options.presentationMode !== undefined && options.presentationMode !== presentationMode) fail('READING_SESSION_PRESENTATION_CONFLICT');
  const instructionProfile = options.instructionProfile ?? DEFAULT_CONFIGURED_INSTRUCTION_PROFILE;
  if (instructionProfile !== DEFAULT_CONFIGURED_INSTRUCTION_PROFILE) fail('READING_BINDING_RETIRED');
  const tasks = buildReadingSessionTasks({ runId, scientificInput, sourceLanguage, instructionProfile, checkpointCount: maxControlCheckpoints, controllerActorId: options.controllerActorId, taskOverrides: options.taskOverrides, scienceTaskOverrides: options.scienceTaskOverrides, includeRepairs: options.includeRepairs === true, presentationMode, enrichmentPolicy: options.enrichmentPolicy });
  const sourceMatchMetadata = await readRegisteredSourceMatchMetadata({ vaultRoot: repoRoot });
  const prepared = prepareConfiguredReading({ repoRoot, runId, scientificInput, sourceMatchMetadata, sourceLanguage, instructionProfile, authorizationId, maxCalls, maxTotalCalls, priorCalls: 6, sessionContext, hostProfile, taskBindings: tasks.taskBindings, controllerActorId: options.controllerActorId, ...(options.enrichmentPolicy !== undefined ? { enrichmentPolicy: options.enrichmentPolicy, enrichmentSessionProfile: 'reading-session-enrichment-1.0' } : {}) }, execution?.manifest);
  const configBytes = await readFile(join(repoRoot, 'config', 'apa.local.json'));
  if (createHash('sha256').update(configBytes).digest('hex') !== prepared.configurationFingerprint || !same(JSON.parse(configBytes), inspection.config)) fail('READING_SESSION_CONFIG_CHANGED');
  const actor = prepared.runControl.reading_first_binding.controller_actor_id;
  const brokerConfig = { control_actor_id: actor, artifact_root: prepared.paths.runRoot, authorized_bindings: [...tasks.authorizedBindings, ...prepared.compactionControlBindings], run_controls: [prepared.runControl] };
  const broker = createOwnedArtifactBroker(brokerConfig);
  const frozenInspection = { config: clone(inspection.config), validation: clone(inspection.validation), dependencies: clone(inspection.dependencies) };
  const state = { prepared, batchRun, runtimeBinding: prepared.runControl.reading_first_binding.configured_setup?.runtime_binding, consumerHeld: execution?.consumerHeld === true, sessionCheckpoints: tasks.sessionCheckpoints ?? [], nextSessionCheckpoint: 0, approvals: [], broker, brokerConfig, tasks: tasks.scienceTasks, checkpoints: tasks.checkpoints, nextCheckpoint: 3, reading: null, handoff: null, checkpointReceipt: null, evidence: clone(evidence), hostProfile: clone(hostProfile), sciencePayloads: clone(sciencePayloads), presentation: null, resources: null, frozenInspection, needsInitialSessionMatch: true };
  const bootReceipt = await commitControl(state, tasks.checkpoints[0], { schema_version: 'reading-session-bootstrap-1.0', run_id: runId, science_state: controlPath(prepared.paths.runRoot), config_text: configBytes.toString('utf8'), inspection: frozenInspection });
  state.evidence.control_write = { status: 'pass', reference: `owned:${bootReceipt.artifact_id}` };
  state.preflight = evaluateSessionPreflight(state);
  await sealInitialPreflight(state);
  state.science = await createScienceController({ prepared, tasks: state.tasks, payloads: state.sciencePayloads, brokerConfig, statePath: controlPath(prepared.paths.runRoot) });
  await saveBatchProgress(state, state.preflight.status === 'pass'
    ? { action: 'ready' } : { action: 'provide-input', kind: 'runtime-evidence' });
  return wrap(state);
}

/** Rebuild the original controllers from their owned science state and registered checkpoints. */
export async function resumeReadingSession({ runRoot, readOnly = false } = {}, execution) {
  execution ??= await readReadingSessionExecution(runRoot);
  if (!execution) return resumeSession({ runRoot, readOnly });
  if (execution.terminal) fail('READING_SESSION_TERMINATED');
  if (resolve(execution.manifest.repo_root) !== CODE_ROOT) {
    const api = await snapshotApi(execution.manifest);
    return delegateSession(await api.resumeReadingSession({ runRoot, readOnly }, execution), api, execution);
  }
  const resume = async () => {
    if (await readReadingRuntimeTerminal(execution)) fail('READING_SESSION_TERMINATED');
    return resumeSession({ runRoot, readOnly }, execution);
  };
  return execution.consumerHeld ? resume() : withReadingRuntimeConsumer(execution, resume);
}

async function resumeSession({ runRoot, readOnly }, execution) {
  if (!text(runRoot) || !isAbsolute(runRoot)) fail('READING_SESSION_ROOT_INVALID');
  const root = resolve(runRoot), statePath = controlPath(root);
  const envelope = JSON.parse(await readFile(statePath, 'utf8'));
  const data = envelope.data;
  if (!data?.prepared || resolve(data.prepared.paths.runRoot) !== root) fail('READING_SESSION_STATE_INVALID');
  const { prepared, tasks, brokerConfig, payloads = {} } = data;
  assertReadingBindingCurrent(prepared.runControl?.reading_first_binding);
  const actor = prepared.runControl.reading_first_binding.controller_actor_id;
  const checkpoints = checkpointBindings(brokerConfig, prepared.runControl.run_id, actor);
  if (checkpoints.length < 4 || checkpoints.some((row, index) => Number(row.revision) !== index + 1 || row.artifact_path !== `control/reading-checkpoint-${index + 1}.json`)) fail('READING_SESSION_STATE_INVALID');
  const broker = createOwnedArtifactBroker(brokerConfig);
  const state = { prepared, runtimeBinding: prepared.runControl.reading_first_binding.configured_setup?.runtime_binding, sessionCheckpoints: sessionBindings(brokerConfig, prepared.runControl.run_id, actor), nextSessionCheckpoint: 0, approvals: [], broker, brokerConfig, tasks, checkpoints, science: null, sciencePayloads: payloads, nextCheckpoint: 3, reading: null, handoff: null, checkpointReceipt: null, preflight: { status: 'unknown', reasons: ['current runtime evidence required'] }, evidence: {}, hostProfile: null, presentation: null, resources: null, needsInitialSessionMatch: true };
  if (state.sessionCheckpoints.length !== checkpoints.length || state.sessionCheckpoints.some((row, index) => Number(row.revision) !== index + 1)) fail('READING_SESSION_STATE_INVALID');
  const reference = execution && readReadingRuntimeSnapshotReference(runtimeLocation(state));
  if (execution && !reference) fail('READING_SESSION_RUNTIME_REFERENCE_CONFLICT');
  state.batchRun = execution && readBatchRun(root, prepared.runControl.run_id, reference.batch_run_sha256);
  const uncommitted = reference?.pending_manifest && execution.manifest.fingerprint === reference.fingerprint;
  if (uncommitted && !readOnly) await archiveUnreceiptedRebind(state, reference);
  await readSessionMetadata(state);
  if (execution) {
    state.consumerHeld = execution.consumerHeld === true;
    if (state.runtimeBinding.fingerprint !== execution.manifest.fingerprint) fail('READING_SESSION_RUNTIME_REFERENCE_CONFLICT');
    if (!readOnly && reference.pending_manifest) {
      const location = runtimeLocation(state);
      if (uncommitted) await abandonReadingRuntimeSnapshotReference({ ...location, expectedFingerprint: reference.fingerprint, pendingFingerprint: reference.pending_manifest.fingerprint });
      else await registerReadingRuntimeSnapshotReference({ ...location, manifest: state.runtimeBinding, expectedFingerprint: reference.fingerprint });
    }
  }
  if (state.runtimeRestartRequired) return wrap(state);
  const drift = runtimeInspection(state);
  if (drift.status === 'drift') { state.resumed = true; return wrap(state); }
  const last = state.approvals.at(-1);
  if (last && !snapshotBinding(last.current) && !validateRuntimeRepairApproval({ approval: last.approval, runId: prepared.runControl.run_id,
    checkpointFingerprint: approvalCheckpoint(last.approval, prepared.runControl.run_id), previous: last.previous, current: last.current }).valid) fail('READING_SESSION_APPROVAL_INVALID');
  const science = await restoreScienceController({ statePath, prepared, tasks, payloads, brokerConfig });
  state.science = science;
  const boot = await existingControl(state, checkpoints[0]);
  const bootValue = boot && JSON.parse(boot.bytes);
  if (!boot || bootValue.schema_version !== 'reading-session-bootstrap-1.0' || bootValue.run_id !== prepared.runControl.run_id || bootValue.science_state !== statePath || typeof bootValue.config_text !== 'string' || createHash('sha256').update(bootValue.config_text).digest('hex') !== prepared.configurationFingerprint || !bootValue.inspection?.config || !same(JSON.parse(bootValue.config_text), bootValue.inspection.config) || !Array.isArray(bootValue.inspection.dependencies)) fail('READING_SESSION_BOOTSTRAP_INVALID');
  state.frozenInspection = bootValue.inspection;
  state.evidence.control_write = { status: 'pass', reference: `owned:${boot.receipt.artifact_id}` };
  const seal = await existingControl(state, checkpoints[1]);
  if (seal) {
    const value = JSON.parse(seal.bytes);
    if (value.schema_version !== 'reading-session-preflight-1.0' || value.run_id !== prepared.runControl.run_id || value.configuration_fingerprint !== prepared.configurationFingerprint || !same(value.main_session, prepared.runControl.reading_first_binding.role_model_policy.main_session) || !text(value.host) || !value.session_evidence || value.session_evidence.model !== value.main_session.model || (value.session_evidence.reasoning_effort ?? null) !== (value.main_session.reasoning_effort ?? null)) fail('READING_SESSION_PREFLIGHT_INVALID');
    if (!value.evidence?.results_tools || !value.evidence?.control_write) fail('READING_SESSION_PREFLIGHT_INVALID');
    state.needsInitialSessionMatch = false;
    state.publicationPreflightSealed = true;
  }
  const scienceState = getScienceState(science);
  if (!seal && (scienceState.reserved_calls || scienceState.handoff)) fail('READING_SESSION_PREFLIGHT_INVALID');
  if (readOnly && scienceState.handoff && scienceState.handoff.status!=='transferred') fail('READING_SESSION_HANDOFF_RECONCILIATION_REQUIRED');
  if (scienceState.handoff) {
    const transferred = await createScienceHandoff({ controller: science, checkpointTask: checkpoints[2] });
    state.visualHandoff = clone(transferred.visual_handoff);
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
  if (state.reading) await refreshSessionResources(state);
  state.resumed = true;
  return wrap(state);
}

/** Read an already completed session without materializing a candidate or emitting another action. */
export async function captureCompletedReadingSessionPublicationSource({ runRoot, vaultRoot, run } = {}, execution) {
  execution ??= await readReadingSessionExecution(runRoot);
  if (execution?.terminal) fail('READING_SESSION_TERMINATED');
  if (execution && resolve(execution.manifest.repo_root) !== CODE_ROOT) {
    const api = await snapshotApi(execution.manifest);
    return api.captureCompletedReadingSessionPublicationSource({ runRoot, vaultRoot, run }, execution);
  }
  const capture = () => capturePublicationSource({ runRoot, vaultRoot, run }, execution && { ...execution, consumerHeld: true });
  return execution ? withReadingRuntimeConsumer(execution, capture) : capture();
}

async function capturePublicationSource({ runRoot, vaultRoot, run }, execution) {
  await assertReadingFirstRegisteredSourcesCurrent({ vaultRoot });
  const state = stateOf(await resumeReadingSession({ runRoot, readOnly: true }, execution));
  if (!state.science) fail('READING_SESSION_RUNTIME_DRIFT');
  const binding = state.prepared.runControl.reading_first_binding;
  if (run !== state.prepared.runControl.run_id || typeof vaultRoot !== 'string'
    || resolve(vaultRoot) !== resolve(binding.configured_setup.knowledge_registry.vault_root)) fail('RF_ONE_STEP_RUN_MISMATCH');
  if (!state.publicationPreflightSealed || !state.reading || getReadingFirstState(state.reading).status !== 'reading_complete'
    || state.translationStop || pendingContinuations(state).length) fail('READING_FIRST_PUBLICATION_NOT_READY');
  return captureReadingFirstPublicationSource({ controller: state.reading, runtimeBinding: snapshotBinding(state.runtimeBinding) ? state.runtimeBinding : undefined, restoreRendering: async () => ({
    ...state.renderOptions, knowledgeRegistry: await readCommittedReadingFirstKnowledgeRegistry({ binding }),
  }) });
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

const pendingContinuations = state => state.reading ? getReadingPendingContinuations({ controller: state.reading }) : getSciencePendingContinuations({ controller: state.science });
const continuationRow = (state, executionId) => state.reading
  ? snapshotReadingFirstRuntime(state.reading).state.executionLedger?.find(row => row.execution_id === executionId && row.kind === 'continuation') ?? null
  : getScienceContinuation({ controller: state.science, executionId });
const finalizeContinuations = (state, taskId) => (snapshotReadingFirstRuntime(state.reading).state.executionLedger ?? [])
  .filter(row => row.kind === 'continuation' && row.task_id === taskId && row.context?.translation_decision?.finalize_only);
const sessionQueue = (state, work) => {
  const result = (state.queue ?? Promise.resolve()).then(work);
  state.queue = result.catch(() => {});
  return result;
};

function addSourceMatchSummary(summary, prepared) {
  const matches = prepared.raw_source_matches;
  if (!matches || !matches.exact_matches.length && !matches.possible_matches.length) return summary;
  const evidence = { exact_count: matches.exact_matches.length, possible_count: matches.possible_matches.length,
    preparation_ref: controlPath(prepared.paths.runRoot), exact_examples: [], possible_examples: [] };
  const withinLimit = () => Buffer.byteLength(JSON.stringify({ ...summary, raw_source_matches: evidence }), 'utf8') <= 8192;
  if (!withinLimit()) return summary;
  for (const kind of ['exact', 'possible']) for (const row of matches[kind + '_matches'].slice(0, 2)) {
    evidence[kind + '_examples'].push(row);
    if (!withinLimit()) evidence[kind + '_examples'].pop();
  }
  return { ...summary, raw_source_matches: evidence };
}

async function saveBatchProgress(state, action = {}, summary, snapshot) {
  if (!state.batchRun) return;
  const reading = state.reading && (snapshot ?? snapshotReadingFirstRuntime(state.reading)).state;
  const science = !reading && state.science && getScienceState(state.science);
  const budget = summary?.budget ?? (reading ? getReadingBudgetSummary({ controller: state.reading })
    : science ? getScienceBudgetSummary({ controller: state.science }) : undefined);
  const observed = reading ? reading.executionLedger?.filter(row => row.status === 'observed').length
    : science ? science.observed_calls + budget.continuations
      - getSciencePendingContinuations({ controller: state.science }).filter(row => row.status === 'issued').length : null;
  await writeBatchCheckpoint(state.prepared.paths.runRoot, {
    runId: state.batchRun.run_id, stage: summary?.stage ?? action.stage ?? (reading ? 'reading' : 'science'),
    status: summary?.status ?? action.terminal?.status ?? reading?.status ?? action.action ?? 'checkpointed',
    action: action.action, kind: action.kind, code: action.code,
    task: summary?.task?.id ?? action.role ?? (science ? science.next_actions[0]?.role : null),
    budget: { ...budget, observed_calls: observed,
      issued_unconfirmed: budget?.total_used == null || observed == null ? null : budget.total_used - observed },
    checkpoint: state.checkpointReceipt?.path ?? 'control/science-state.json',
  });
}

/** Compute the next action and a bounded projection for routine Controller replies. */
export async function nextReadingAction(session) {
  const delegated = delegatedSessions.get(session);
  if (delegated) return delegated.api.nextReadingAction(session);
  const state = stateOf(session);
  return sessionQueue(state, () => withSessionConsumer(state, async () => {
    const action = await nextSessionAction(session);
    if (!state.science || action.kind === 'runtime-drift' || action.code === 'READING_SESSION_RUNTIME_RESTART_REQUIRED') {
      await saveBatchProgress(state, action);
      return action;
    }
    const snapshot = state.reading ? snapshotReadingFirstRuntime(state.reading) : null;
    const task = snapshot?.state.request_entries.find(row => row.request.emittedStep.action_id === action.original_action_id || row.request.emittedStep.action_id === action.action_id)?.request.task;
    const budget = state.reading ? getReadingBudgetSummary({ controller: state.reading }) : getScienceBudgetSummary({ controller: state.science });
    const statePath = state.reading && state.checkpointReceipt?.path ? join(state.prepared.paths.runRoot, state.checkpointReceipt.path) : controlPath(state.prepared.paths.runRoot);
    const artifacts = task ? [task.artifact_path, task.native_path, task.instruction_path].filter(Boolean).map(path => ({ path: join(state.prepared.paths.runRoot, path) })) : [];
    const summary = addSourceMatchSummary(buildReadingActionSummary({ runId: state.prepared.runControl.run_id, stage: action.stage ?? (state.reading ? 'reading' : 'science'),
      status: action.status ?? snapshot?.state.status ?? action.action, action: action.action, taskId: task?.task_id ?? action.role, handle: action.host_handle,
      budget, blockCode: action.code, artifacts, statePath }), state.prepared);
    await saveBatchProgress(state, action, summary, snapshot);
    const methods = action.status === 'reading_complete' ? readingFirstUsedMethodSources(snapshot?.state) : [];
    return { ...action, summary, ...(methods.length ? { used_method_sources: methods.map(row => ({ ...row,
      notes: state.presentation.notes.map(note => note.path), raw_status: 'pending_publication' })) } : {}),
    ...(action.action === 'complete' ? { native_presentation: { status: 'not_run' }, computer_control: getScienceComputerControlReport({ controller: state.science }) } : {}) };
  }));
}

async function nextSessionAction(session) {
  const state = stateOf(session);
  if (state.poisoned) return { action: 'reconcile', code: 'READING_SESSION_RESTORE_REQUIRED' };
  if (state.runtimeRestartRequired) return { action: 'reconcile', code: 'READING_SESSION_RUNTIME_RESTART_REQUIRED' };
  const drift = runtimeInspection(state);
  if (drift.status === 'drift') return { action: 'reconcile', kind: 'runtime-drift', code: 'READING_SESSION_RUNTIME_DRIFT', runtime: drift, checkpoint_fingerprint: await runtimeCheckpoint(state) };
  if (!state.science) return { action: 'reconcile', code: 'READING_SESSION_RESTORE_REQUIRED' };
  if (state.preflight.status !== 'pass') return { action: 'provide-input', kind: 'runtime-evidence', preflight: clone(state.preflight) };
  if (state.translationStop) {
    const { action_id, decision, final_rejection } = state.translationStop;
    const entry = final_rejection && snapshotReadingFirstRuntime(state.reading).state.request_entries.find(row => row.request.emittedStep.action_id === action_id);
    const finalizations = entry ? finalizeContinuations(state, entry.request.task.task_id) : [];
    if (!finalizations.length) return decision.action === 'complete' ? { ...clone(decision), action: 'provide-input', kind: 'accept-translation' } : clone(decision);
    if (finalizations.length !== 1 || finalizations[0].status !== 'prepared') return { action: 'reconcile', code: 'READING_TRANSLATION_FINAL_INVALID', action_id };
    if (state.nextSessionCheckpoint >= state.sessionCheckpoints.length) return { action: 'reconcile', code: 'CONTROL_CHECKPOINT_CAPACITY' };
    // The reading checkpoint reserved this execution before the stop could be cleared.
    state.translationStop = null;
    await saveSessionMetadata(state);
  }
  const continuation = pendingContinuations(state)[0];
  if (continuation) {
    const stage = state.reading ? 'reading' : 'science';
    if (continuation.status !== 'prepared') return { action: 'reconcile', kind: 'continuation', stage, execution_id: continuation.execution_id, action_id: continuation.action_id, code: 'HOST_CONTINUATION_OUTCOME_UNKNOWN' };
    if (state.reading) {
      if (state.nextCheckpoint >= state.checkpoints.length - 2) return { action: 'reconcile', code: 'CONTROL_CHECKPOINT_CAPACITY' };
      markReadingContinuationDispatched({ controller: state.reading, executionId: continuation.execution_id });
      await saveReading(state);
    } else await markScienceContinuationDispatched({ controller: state.science, executionId: continuation.execution_id });
    return { action: 'dispatch', kind: 'continuation', stage, execution_id: continuation.execution_id, action_id: continuation.action_id,
      original_action_id: continuation.context?.continuation_request?.action_id, host_handle: continuation.handle,
      host_action: continuation.tool, arguments: continuation.arguments, run_id: state.prepared.runControl.run_id };
  }
  if (!state.reading) {
    let current = getScienceState(state.science);
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
      state.visualHandoff = clone(result.visual_handoff);
      if (result.controller) state.reading = result.controller;
      else {
        const restored = await restoreReadingFirstRuntime({ handoff: result.handoff, runControl: result.runControl, checkpointReceipt: result.checkpointReceipt });
        if (!restored.ok) fail(restored.errors[0].code);
        state.reading = restored.controller;
      }
      await refreshSessionResources(state);
      return nextSessionAction(session);
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
  await refreshSessionResources(state);
  const current = getReadingFirstState(state.reading);
  if (current.status==='user_revision_pending') return {action:'await-user',kind:'authorize-continuation',
    continuation:await inspectReadingFirstContinuation({controller:state.reading,checkpointReceipt:state.checkpointReceipt}),
    ...(current.user_revision?.scientific===false ? {zero_call_alternative:'Publish the exact reviewed baseline with separate approval, then edit the registered Wiki note manually.'} : {})};
  const inspectContinuation=()=>inspectReadingFirstContinuation({controller:state.reading,checkpointReceipt:state.checkpointReceipt});
  if (current.revision_needs_continuation) {
    const continuation=await inspectContinuation();
    return {action:'reconcile',code:continuation.can_continue ? 'READING_FIRST_CALL_BUDGET_EXHAUSTED' : continuation.reason,continuation};
  }
  if (current.status === 'review_unroutable') return { action:'provide-input', kind:'review-scope', routing:current.routing };
  if (current.status === 'completed_with_limits') return { action: 'complete', status: current.status, publishable: false,continuation:await inspectContinuation() };
  if (current.status === 'reading_complete') {
    if (!state.presentation && state.reviewedPresentation) {
      if (!state.resources || !state.renderOptions) return { action: 'provide-input', kind: 'render-assets' };
      const restored = await materializeConfiguredReadingCandidate({ prepared: state.prepared, controller: state.reading, handoff: state.handoff, resources: state.resources, ...state.renderOptions, candidateRevision: current.candidate_revision, reuseExisting: true });
      if (restored.candidate.presentation_fingerprint !== (current.candidate_fingerprint ?? state.reviewedPresentation.presentation_fingerprint)) fail('READING_SESSION_REVIEWED_CANDIDATE_CHANGED');
      state.presentation = restored.candidate;
    }
    if (!state.presentation) {
      if (!state.resources || !state.renderOptions) return {action:'provide-input',kind:'render-assets'};
      const restored=await materializeConfiguredReadingCandidate({prepared:state.prepared,controller:state.reading,handoff:state.handoff,resources:state.resources,...state.renderOptions,candidateRevision:current.candidate_revision,reuseExisting:true});
      state.presentation=restored.candidate;
    }
    const source = await captureReadingFirstPublicationSource({ controller: state.reading, presentation: state.presentation,
      runtimeBinding: snapshotBinding(state.runtimeBinding) ? state.runtimeBinding : undefined });
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
      const result = await materializeConfiguredReadingCandidate({ prepared: state.prepared, controller: state.reading, handoff: state.handoff, resources: state.resources, ...state.renderOptions, candidateRevision: current.candidate_revision + 1, reuseExisting: true,
        ...(rendererRepair ? { onDependencyBoundary: ({ phase, candidate }) => { if (phase === 'before-finalize') validateReadingFirstRenderRepair({ controller: state.reading, presentation: candidate }); } } : {}) });
      state.presentation = result.candidate;
      if (current.user_revision?.scientific===false) {
        await finalizeReadingFirstUserRevision({controller:state.reading,presentation:state.presentation});
        await saveReading(state);
        return nextSessionAction(session);
      }
      createReadingFirstReviewRequest({ controller: state.reading, presentation: state.presentation, ...(rendererRepair ? { renderRepair: true } : {}) });
    } else if (current.status === 'revision_required' || current.status === 'revising') {
      const material = current.review?.issues?.filter(issue => issue.severity === 'material') ?? [];
      if (material.length && material.every(issue => issue.repair_owner === 'renderer')) {
        if (!state.rendererRepairReady) return { action: 'provide-input', kind: 'renderer-repair', review: current.review };
        if (!state.resources || !state.renderOptions) return { action: 'provide-input', kind: 'render-assets' };
        const result = await materializeConfiguredReadingCandidate({ prepared: state.prepared, controller: state.reading, handoff: state.handoff, resources: state.resources, ...state.renderOptions, candidateRevision: current.candidate_revision + 1, reuseExisting: true,
          ...(current.user_revision?.scientific===false ? {} : {onDependencyBoundary: ({ phase, candidate }) => { if (phase === 'before-finalize') validateReadingFirstRenderRepair({ controller: state.reading, presentation: candidate }); } }) });
        state.presentation = result.candidate;
        if (current.user_revision?.scientific===false) await finalizeReadingFirstUserRevision({controller:state.reading,presentation:state.presentation});
        else createReadingFirstReviewRequest({ controller: state.reading, presentation: state.presentation, renderRepair: true });
        await saveReading(state);
        return nextSessionAction(session);
      }
      try { createReadingFirstRevisionRequests({ controller: state.reading }); }
      catch (error) {
        if (error.code==='READING_FIRST_CALL_BUDGET_EXHAUSTED') return {action:'reconcile',code:error.code};
        if (error.code !== 'READING_FIRST_REVISION_UNAVAILABLE') throw error;
        try { createReadingFirstPresentationRequest({ controller: state.reading }); }
        catch (editorError) { if (editorError.code==='READING_FIRST_CALL_BUDGET_EXHAUSTED') return {action:'reconcile',code:editorError.code}; if (editorError.code === 'READING_FIRST_EDITOR_UNAVAILABLE') return { action: 'provide-input', kind: 'repair', review: current.review }; throw editorError; }
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
    if (!events.host_observation || events.host_observation.payload?.status === 'outcome_unknown') return { action: 'reconcile', stage: 'reading', action_id: request.emittedStep.action_id, code: 'HOST_OBSERVATION_OUTCOME_UNKNOWN' };
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
  if (firstReview && !state.presentation && state.reviewedPresentation) {
    if (!state.resources || !state.renderOptions) return { action: 'provide-input', kind: 'render-assets' };
    const restored = await materializeConfiguredReadingCandidate({ prepared: state.prepared, controller: state.reading, handoff: state.handoff, resources: state.resources, ...state.renderOptions, candidateRevision: current.candidate_revision, reuseExisting: true });
    if (restored.candidate.presentation_fingerprint !== (current.candidate_fingerprint ?? state.reviewedPresentation.presentation_fingerprint)) fail('READING_SESSION_REVIEWED_CANDIDATE_CHANGED');
    state.presentation = restored.candidate;
  }
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

async function readingProgress(state, entry, expectedCompleted) {
  let nativeOutput;
  try { nativeOutput = JSON.parse(await readFile(join(state.prepared.paths.runRoot, entry.request.task.native_path), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw Object.assign(new Error('READING_TRANSLATION_PROGRESS_RECONCILE'), { code: 'READING_TRANSLATION_PROGRESS_RECONCILE' }); }
  return checkTranslationProgress({ artifactRoot: state.prepared.paths.runRoot, task: entry.request.task, runId: state.prepared.runControl.run_id,
    sourceView: entry.payload.source_view, nativeOutput, expectedCompleted });
}

async function continuationIntent(state, event) {
  const binding = state.prepared.runControl.reading_first_binding;
  if (state.preflight.status !== 'pass') return { action: 'provide-input', kind: 'runtime-evidence', preflight: clone(state.preflight) };
  if (![event.action_id, event.execution_id, event.message].every(text)) fail('READING_SESSION_CONTINUATION_INVALID');
  const requestIdentity = { action_id: event.action_id, message: event.message };
  const existing = continuationRow(state, event.execution_id);
  if (existing) {
    if (!same(existing.context?.continuation_request, requestIdentity)) fail('READING_SESSION_CONTINUATION_CONFLICT');
    return { recorded: true, execution_id: existing.execution_id, status: existing.status };
  }
  let handle, taskId, role, entry, progress, translationDecision, scopeOutput;
  if (state.reading) {
    entry = snapshotReadingFirstRuntime(state.reading).state.request_entries.find(row => row.request.emittedStep.action_id === event.action_id);
    const current=getReadingFirstState(state.reading);
    if (current.status==='review_unroutable' && entry?.consumed && entry.request.task.role==='independent-verifier') scopeOutput='native/'+entry.request.task.task_id+'-scope.json';
    if (!entry || (entry.consumed && !scopeOutput) || !entry.events?.host_observation
      || entry.events.host_observation.payload?.status === 'outcome_unknown') fail('READING_SESSION_CONTINUATION_INVALID');
    const observed = ingestObservedRunStep({ packet: entry.request.packet, emittedStep: entry.request.emittedStep,
      run: { run_id: state.prepared.runControl.run_id }, observation: entry.events.host_observation.payload });
    handle = observed.agent_id; taskId = entry.request.task.task_id;
  } else {
    const found = Object.entries(getScienceState(state.science).roles).find(([, item]) => item.action_id === event.action_id);
    if (!found || found[1].status !== 'observed') fail('READING_SESSION_CONTINUATION_INVALID');
    role = found[0]; handle = found[1].agent_id;
  }
  let message = event.message + '\nContinue only the original task, output ownership, model and authorized scope. Desktop control and native observation require explicit user authorization.';
  if (scopeOutput) {
    const routing=getReadingFirstState(state.reading).routing;
    message+='\nSupply only the missing fields for these existing issue IDs. Preserve the original review file and all scientific judgments. Write an array of {issue_id, fields} to '+join(state.prepared.paths.runRoot,scopeOutput)+'\n'+JSON.stringify(routing);
  }
  if (entry?.request.task.role === 'translation') {
    try { progress = await readingProgress(state, entry); }
    catch (error) { if (error.message === 'READING_TRANSLATION_PROGRESS_RECONCILE') return { action: 'reconcile', code: error.message, action_id: event.action_id }; throw error; }
    const rows = (snapshotReadingFirstRuntime(state.reading).state.executionLedger ?? []).filter(row => row.kind === 'continuation' && row.task_id === taskId && row.status === 'observed');
    translationDecision = evaluateTranslationContinuation({ progress, previousProgress: rows.at(-1)?.context?.translation_progress, priorUnknownZeroProgress: rows.filter(row => row.context?.translation_decision?.unknown_zero_progress_retry).length, stopReason: event.stop_reason });
    // A complete manifest whose final output was rejected allows one finalize-only continuation.
    const rejection = translationDecision.action === 'complete' && state.translationStop?.action_id === event.action_id ? state.translationStop.final_rejection : undefined;
    if (rejection) {
      if (finalizeContinuations(state, taskId).length) return { action: 'reconcile', code: 'READING_TRANSLATION_FINAL_INVALID', action_id: event.action_id };
      translationDecision = { ...translationDecision, finalize_only: true, final_rejection: clone(rejection) };
      message += '\nThe previous final output was rejected (' + rejection.code + '). Validate and finalize the complete original output JSON.';
    } else if (translationDecision.action !== 'continue') {
      state.translationStop = { action_id: event.action_id, execution_id: event.execution_id, decision: clone(translationDecision), stop_reason: clone(event.stop_reason ?? { kind: 'unknown' }) };
      await saveSessionMetadata(state);
      return translationDecision.action === 'complete' ? { ...translationDecision, action: 'provide-input', kind: 'accept-translation' } : translationDecision;
    }
    message += '\nRead the original frozen input references from ' + entry.request.instruction_file.path
      + '. Preserve every completed translation fragment. Translate only the following remaining IDs, then finalize and validate the complete original output JSON.\n'
      + JSON.stringify({ remaining_sections: progress.remaining_sections, remaining_knowledge: progress.remaining_knowledge,
        progress_path: join(state.prepared.paths.runRoot, entry.request.task.progress_path), source_fingerprint: progress.source_fingerprint });
  }
  const host = resolveHostContinuation(state.hostProfile, { hostName: binding.host?.name ?? state.hostProfile?.host, handle, message });
  if (host.status !== 'detected') return { action: 'provide-input', kind: 'host-continuation', code: host.code };
  const input = { executionId: event.execution_id, actionId: `${event.action_id}:continuation:${event.execution_id}`, handle, tool: host.host_action,
    arguments: host.arguments, context: { continuation_request: requestIdentity, host_evidence: host.evidence, ...(scopeOutput ? {review_scope_output:scopeOutput} : {}), ...(progress ? { translation_progress: progress } : {}), ...(translationDecision ? { translation_decision: translationDecision, stop_reason: clone(event.stop_reason ?? { kind: 'unknown' }) } : {}) } };
  let row;
  if (state.reading) {
    if (state.nextCheckpoint >= state.checkpoints.length - 3) return { action: 'reconcile', code: 'CONTROL_CHECKPOINT_CAPACITY' };
    row = reserveReadingContinuation({ controller: state.reading, taskId, ...input });
    await saveReading(state);
    // The stop (and any final rejection) is released only once the continuation is actually reserved.
    if (state.translationStop) { state.translationStop = null; await saveSessionMetadata(state); }
  } else row = await reserveScienceContinuation({ controller: state.science, role, ...input });
  return { recorded: true, execution_id: row.execution_id, status: row.status };
}

async function continuationReceipt(state, event) {
  if (!text(event.execution_id) || !event.observation) fail('READING_SESSION_CONTINUATION_INVALID');
  const row = continuationRow(state, event.execution_id);
  if (!row) fail('READING_SESSION_CONTINUATION_INVALID');
  if (row.context?.translation_progress && event.observation.status === 'observed') {
    const entry = snapshotReadingFirstRuntime(state.reading).state.request_entries.find(item => item.request.task.task_id === row.task_id);
    await readingProgress(state, entry, row.context.translation_progress);
  }
  if (!state.reading) return recordScienceContinuationReceipt({ controller: state.science, executionId: event.execution_id, receipt: event.observation });
  if (state.nextCheckpoint >= state.checkpoints.length - 1) return { action: 'reconcile', code: 'CONTROL_CHECKPOINT_CAPACITY' };
  const unchanged = row.receipt !== undefined && same(row.receipt, event.observation);
  const result = recordReadingContinuationReceipt({ controller: state.reading, executionId: event.execution_id, receipt: event.observation });
  if (!unchanged) await saveReading(state);
  return result;
}

/** Record observed host events or explicit runtime inputs without invoking a host tool. */
export async function recordReadingEvent(session, event = {}) {
  const delegated = delegatedSessions.get(session);
  if (delegated) {
    if (event.kind === 'terminate' || event.kind === 'close-with-limits') {
      const terminal = await readReadingRuntimeTerminal(delegated.execution);
      if (terminal) return retryReadingSessionCleanup({ ...delegated.execution, terminal }, event);
    }
    const result = await delegated.api.recordReadingEvent(session, event);
    if (result?.cleanup_pending !== true) return result;
    const cleanup = await cleanupReadingRuntimeRun(delegated.execution);
    return { ...result, cleanup_pending: false, cleanup };
  }
  const state = stateOf(session);
  return sessionQueue(state, () => withSessionConsumer(state, async () => {
    const result = await recordSessionEvent(session, event);
    const evidence = event.observation?.evidence;
    const path = evidence?.source_reference, hash = evidence?.sha256 ?? evidence?.source_sha256;
    if (snapshotBinding(state.runtimeBinding) && isAbsolute(path ?? '') && /^(?:sha256:)?[a-f0-9]{64}$/.test(hash ?? '')) {
      const location = runtimeLocation(state), suffix = relative(location.runRoot, path);
      if (suffix && !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..' + sep)) {
        await registerReadingRuntimeCleanupFiles({ ...location, files: [{ path, kind: 'host', sha256: hash.startsWith('sha256:') ? hash : 'sha256:' + hash }] });
      }
    }
    if (!event.kind?.startsWith('inspect-')) {
      const progress = event.kind === 'runtime-evidence' && result?.status !== 'pass'
        ? { action: 'provide-input', kind: 'runtime-evidence' } : result;
      await saveBatchProgress(state, progress);
    }
    return result;
  }));
}

async function inspectRuntimeRebind(state) {
  if (!snapshotBinding(state.runtimeBinding)) fail('READING_SESSION_RUNTIME_REBIND_UNAVAILABLE');
  const location = runtimeLocation(state);
  const previous = state.runtimeBinding;
  const current = previewReadingRuntimeSnapshot({ ...location, codeRoot: previous.source_code_root });
  return { previous_runtime_fingerprint: previous.fingerprint, current_runtime_fingerprint: current.fingerprint,
    checkpoint_fingerprint: await runtimeCheckpoint(state), changed_files: describeReadingRuntimeChanges(previous, current), current_snapshot_hash: current.snapshot_hash };
}

async function rebindRuntime(state, approval) {
  if (!snapshotBinding(state.runtimeBinding)) fail('READING_SESSION_RUNTIME_REBIND_UNAVAILABLE');
  const task = state.sessionCheckpoints[state.nextSessionCheckpoint];
  if (!task) fail('CONTROL_CHECKPOINT_CAPACITY');
  if (await existingControl(state, task)) fail('READING_SESSION_METADATA_CONFLICT');
  const location = runtimeLocation(state), previous = state.runtimeBinding, codeRoot = previous.source_code_root;
  const checkpointFingerprint = await runtimeCheckpoint(state);
  const proposed = previewReadingRuntimeSnapshot({ ...location, codeRoot });
  if (!validateRuntimeRebindApproval({ approval, ...location, codeRoot, checkpointFingerprint, previous, current: proposed }).valid) fail('READING_SESSION_APPROVAL_INVALID');
  let metadata;
  const current = prepareReadingRuntimeSnapshot({ ...location, codeRoot, reference: manifest => {
    if (manifest.fingerprint !== proposed.fingerprint) fail('READING_SESSION_RUNTIME_REBIND_CHANGED');
    metadata = sessionMetadata(state, [...state.approvals, { approval, previous, current: manifest, restart_process_id: process.pid }]);
    const bytes = Buffer.from(JSON.stringify(metadata));
    const pendingCheckpoint = { artifact_id: task.artifact_id, sha256: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), byte_length: bytes.length };
    return { expectedFingerprint: previous.fingerprint, pending: true, pendingCheckpoint };
  } });
  await saveSessionMetadata(state, metadata);
  registerReadingRuntimeSnapshotReference({ ...location, manifest: current, expectedFingerprint: previous.fingerprint });
  state.approvals = metadata.approvals;
  state.runtimeBinding = current;
  state.runtimeRestartRequired = true;
  return { recorded: true, runtime_fingerprint: current.fingerprint, action: 'reconcile', code: 'READING_SESSION_RUNTIME_RESTART_REQUIRED' };
}

async function terminateRuntime(state, event) {
  if (!snapshotBinding(state.runtimeBinding) || !state.science) fail('READING_SESSION_TERMINAL_UNAVAILABLE');
  const reading = state.reading && getReadingFirstState(state.reading);
  if (event.kind === 'close-with-limits' && reading?.status !== 'completed_with_limits') fail('READING_SESSION_TERMINAL_STATUS_INVALID');
  const hostRunning = reading
    ? snapshotReadingFirstRuntime(state.reading).state.request_entries.some(entry => entry.events?.intent && !entry.consumed)
    : Object.values(getScienceState(state.science).roles).some(role => ['outcome_unknown', 'observed'].includes(role.status));
  if (hostRunning || pendingContinuations(state).some(row => row.status !== 'prepared')) fail('READING_SESSION_TERMINAL_HOST_ACTIVE');
  return closeReadingRuntimeRun({ ...runtimeLocation(state), manifest: state.runtimeBinding, consumerHeld: true, deferCleanup: true,
    terminal: { status: event.kind === 'terminate' ? 'terminated' : 'completed_with_limits', authorization_id: event.authorization_id, user_reply: event.user_reply } });
}

async function recordSessionEvent(session, event = {}) {
  const state = stateOf(session);
  if (state.poisoned) fail('READING_SESSION_RESTORE_REQUIRED');
  if (event.kind === 'runtime-repair-approval') {
    if (snapshotBinding(state.runtimeBinding)) fail('READING_SESSION_RUNTIME_REBIND_REQUIRED');
    const drift = runtimeInspection(state);
    const checkpointFingerprint = await runtimeCheckpoint(state);
    const checked = validateRuntimeRepairApproval({ approval: event.approval, runId: state.prepared.runControl.run_id, checkpointFingerprint, previous: state.runtimeBinding, current: drift.current });
    if (!checked.valid) fail('READING_SESSION_APPROVAL_INVALID');
    const restart = drift.changed_files.some(row => /\.[cm]?js$/i.test(row.path));
    state.approvals.push({ approval: clone(event.approval), previous: clone(state.runtimeBinding), current: clone(drift.current), ...(restart ? { restart_process_id: process.pid } : {}) });
    await saveSessionMetadata(state); state.runtimeBinding = drift.current; state.runtimeRestartRequired = restart;
    if (!state.science && !restart) { const resumed = await resumeReadingSession({ runRoot: state.prepared.paths.runRoot }); sessions.set(session, stateOf(resumed)); }
    return { recorded: true, runtime_fingerprint: drift.current.fingerprint, ...(restart ? { action: 'reconcile', code: 'READING_SESSION_RUNTIME_RESTART_REQUIRED' } : {}) };
  }
  if (state.runtimeRestartRequired) fail('READING_SESSION_RUNTIME_RESTART_REQUIRED');
  if (event.kind !== 'runtime-evidence' || snapshotBinding(state.runtimeBinding)) {
    const drift = runtimeInspection(state);
    if (drift.status === 'drift') fail('READING_SESSION_RUNTIME_DRIFT');
  }
  if (event.kind === 'inspect-runtime-rebind') return inspectRuntimeRebind(state);
  if (event.kind === 'rebind') return rebindRuntime(state, event.approval);
  if (event.kind === 'terminate' || event.kind === 'close-with-limits') return terminateRuntime(state, event);
  if (['host_observation', 'continuation-receipt'].includes(event.kind)) event = { ...event, observation: normalizeHostReceipt(event.observation, { strict: true }) };
  if (['host_update', 'result'].includes(event.kind)) { validateHostReceiptEvidence(event.observation, { strict: true }); if (event.observation?.status === 'outcome_unknown') fail('READING_SESSION_EVENT_OBSERVATION_REQUIRED'); }
  if (event.kind === 'continuation-intent') return continuationIntent(state, event);
  if (event.kind === 'continuation-receipt') return continuationReceipt(state, event);
  if (event.kind === 'computer-control-observation') return recordScienceComputerControlObservation({ controller: state.science, observation: event.observation });
  if (event.kind === 'runtime-evidence') {
    if (!event.hostProfile || !event.evidence) fail('READING_SESSION_INPUT_INVALID');
    state.hostProfile = clone(event.hostProfile); state.evidence = { ...clone(event.evidence), control_write: state.evidence.control_write };
    state.preflight = evaluateSessionPreflight(state);
    await sealInitialPreflight(state);
    return clone(state.preflight);
  }
  if (event.kind === 'compaction') { state.compactionInput = clone(event.input ?? {}); return { recorded: true }; }
  if (event.kind==='inspect-candidate') {
    if (!state.reading) fail('READING_SESSION_CANDIDATE_UNAVAILABLE');
    return inspectReadingFirstSavedCandidate({controller:state.reading,revision:event.revision});
  }
  if (event.kind==='retain-reviewed-candidate') {
    if (!state.reading || state.preflight.status!=='pass') fail('READING_SESSION_RECOVERY_PREFLIGHT_REQUIRED');
    if (state.nextCheckpoint>=state.checkpoints.length-1) return {action:'reconcile',code:'CONTROL_CHECKPOINT_CAPACITY'};
    const result=retainReviewedReadingFirstCandidate({controller:state.reading,revisionId:event.revision_id});
    await saveReading(state);
    return result;
  }
  if (event.kind==='user-revision') {
    if (!state.reading || state.preflight.status!=='pass') fail('READING_SESSION_RECOVERY_PREFLIGHT_REQUIRED');
    if (state.nextCheckpoint>=state.checkpoints.length-1) return {action:'reconcile',code:'CONTROL_CHECKPOINT_CAPACITY'};
    const result=await registerReadingFirstUserRevision({controller:state.reading,request:event.request});
    state.rendererRepairReady=false;
    await saveReading(state);
    return result;
  }
  if (event.kind === 'annotate-review-scope' || event.kind === 'accept-review-scope') {
    if (!state.reading || state.preflight.status!=='pass') fail('READING_SESSION_RECOVERY_PREFLIGHT_REQUIRED');
    if (state.nextCheckpoint>=state.checkpoints.length-1) return {action:'reconcile',code:'CONTROL_CHECKPOINT_CAPACITY'};
    if (event.kind==='accept-review-scope' && !text(event.execution_id)) fail('READING_SESSION_CONTINUATION_INVALID');
    const result=annotateReadingFirstReviewScope({controller:state.reading,
      ...(event.kind==='accept-review-scope' ? {executionId:event.execution_id} : {annotations:event.annotations})});
    await saveReading(state);
    return result;
  }
  if (event.kind === 'inspect-continuation') {
    if (!state.reading) fail('READING_SESSION_RECOVERY_PREFLIGHT_REQUIRED');
    return inspectReadingFirstContinuation({controller:state.reading,checkpointReceipt:state.checkpointReceipt});
  }
  if (event.kind === 'authorize-continuation') {
    if (!state.reading || state.preflight.status!=='pass') fail('READING_SESSION_RECOVERY_PREFLIGHT_REQUIRED');
    const before=snapshotReadingFirstRuntime(state.reading);
    if (state.nextCheckpoint>=state.checkpoints.length-1 && !before.state.continuationAuthorizations?.some(row=>row.authorization.authorization_id===event.authorization?.authorization_id)) return {action:'reconcile',code:'CONTROL_CHECKPOINT_CAPACITY'};
    const result=await authorizeReadingFirstContinuation({controller:state.reading,checkpointReceipt:state.checkpointReceipt,authorization:event.authorization});
    if (snapshotReadingFirstRuntime(state.reading).checkpoint_fingerprint!==before.checkpoint_fingerprint) {
      await saveReading(state);
      state.presentation=null;
    }
    return result;
  }
  if (event.kind === 'recover-rejected-editor') {
    if (!state.reading || state.preflight.status!=='pass') fail('READING_SESSION_RECOVERY_PREFLIGHT_REQUIRED');
    if (state.nextCheckpoint>=state.checkpoints.length-1) return { action:'reconcile', code:'CONTROL_CHECKPOINT_CAPACITY' };
    const result=await recoverReadingFirstRejectedEditor({controller:state.reading,checkpointReceipt:state.checkpointReceipt,authorization:event.authorization,saveCheckpoint:snapshot=>saveReading(state,snapshot)});
    state.presentation=null;
    return result;
  }
  if (event.kind === 'knowledge-identity-resolution') {
    if (!state.reading || state.preflight.status !== 'pass') fail('READING_SESSION_RECOVERY_PREFLIGHT_REQUIRED');
    if (state.nextCheckpoint >= state.checkpoints.length - 1) return { action: 'reconcile', code: 'CONTROL_CHECKPOINT_CAPACITY' };
    const result = await recordReadingFirstKnowledgeIdentityResolution({ controller: state.reading, resolution: event.resolution });
    if (result.recorded) await saveReading(state);
    return result;
  }
  if (event.kind === 'render-assets') {
    if (event.resources !== undefined || !validRenderOptions(event.renderOptions ?? {})) fail('READING_SESSION_RESOURCE_INPUT_INVALID');
    state.renderOptions = clone(event.renderOptions ?? {}); await saveSessionMetadata(state); return { recorded: true };
  }
  if (event.kind === 'renderer-repair') {
    if (event.resources !== undefined || event.renderOptions !== undefined && !validRenderOptions(event.renderOptions)) fail('READING_SESSION_RESOURCE_INPUT_INVALID');
    if (event.resourceRepair !== undefined) {
      if (!state.reading || state.preflight.status !== 'pass') fail('READING_SESSION_RECOVERY_PREFLIGHT_REQUIRED');
      const result = await recordReadingFirstResourceRepair({ controller: state.reading, repair: event.resourceRepair });
      if (result.recorded) await saveReading(state);
      await refreshSessionResources(state);
    }
    if (event.renderOptions !== undefined) state.renderOptions = clone(event.renderOptions);
    state.rendererRepairReady = true;
    await saveSessionMetadata(state);
    return { recorded: true };
  }
  if (!text(event.action_id) || !['host_observation', 'host_update', 'result'].includes(event.kind)) fail('READING_SESSION_EVENT_INVALID');
  if (event.instruction_hash_recovery !== undefined && (event.kind !== 'result' || state.reading || state.preflight.status !== 'pass')) fail('READING_SESSION_EVENT_INVALID');
  if (event.kind === 'result' && pendingContinuations(state).some(row => row.context?.continuation_request?.action_id === event.action_id)) fail('READING_SESSION_CONTINUATION_OUTCOME_UNKNOWN');
  if (!state.reading) {
    const found = Object.entries(getScienceState(state.science).roles).find(([, item]) => item.action_id === event.action_id);
    if (!found) fail('READING_SESSION_EVENT_ACTION_INVALID');
    const role = found[0];
    if (event.kind === 'result') return acceptScienceResult({ controller: state.science, role, instructionHashRecovery: event.instruction_hash_recovery });
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
  const upgradeUnknown = key === 'host_observation' && prior[key]?.payload?.status === 'outcome_unknown' && payload?.status !== 'outcome_unknown';
  if (prior[key] && !upgradeUnknown) {
    if (!same(prior[key].payload, payload)) fail('READING_FIRST_REQUEST_EVENT_CONFLICT');
    if (event.kind !== 'result') return clone(prior[key].payload);
  }
  if (event.kind === 'result' && (!prior.host_observation || prior.host_observation.payload?.status === 'outcome_unknown')) fail('READING_SESSION_EVENT_OBSERVATION_REQUIRED');
  if (event.kind === 'result' && !same(prior.host_observation.payload, payload)) fail('READING_SESSION_OBSERVATION_CONFLICT');
  if ((event.kind === 'host_observation' || event.kind === 'result') && payload?.status !== 'outcome_unknown') {
    const checked = ingestObservedRunStep({ packet: request.packet, emittedStep: request.emittedStep, run: { run_id: state.prepared.runControl.run_id }, observation: payload });
    if (checked.status !== 'observed') fail(checked.blocked_reason);
    if (prior.host_observation && prior.host_observation.payload?.status !== 'outcome_unknown') {
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
  if (!prior[key] || upgradeUnknown) {
    recordReadingFirstRequestEvent({ controller: state.reading, request, eventKey: key, payload });
    await saveReading(state);
  }
  if (event.kind !== 'result') return clone(payload);
  let result;
  try { result = await acceptReadingFirstResult({ controller: state.reading, request, observation: payload, capability: () => capability(state, request.task), terminalCheckpoint: snapshot => saveReading(state, snapshot) }); }
  catch (error) {
    const stopped = state.translationStop?.action_id === event.action_id && state.translationStop.decision?.action === 'complete';
    const finalized = finalizeContinuations(state, request.task.task_id).at(-1);
    // Only a rejected final translation body spends the single finalize-only continuation.
    const code = error.code ?? error.message, content = /^READING_FIRST_(?:VIEW|TRANSLATION)_/.test(code);
    const translationFinal = request.task.role === 'translation' && (stopped || finalized);
    const repeated = stopped && state.translationStop.final_rejection !== undefined && same(state.translationStop.final_rejection, { code });
    if (translationFinal && content && !repeated) {
      state.translationStop = { ...(stopped ? state.translationStop : { action_id: event.action_id, execution_id: finalized.execution_id, decision: clone(finalized.context.translation_decision), stop_reason: { kind: 'unknown' } }), final_rejection: { code } };
      try { await saveSessionMetadata(state); }
      catch (saveError) { error.cause = saveError; }
    }
    if (!translationFinal && resumableResultCodes.has(code)) error.recovery = { action: 'continuation-intent', action_id: event.action_id, code };
    throw error;
  }
  if (result.checkpoint_required === false && result.status === 'completed_with_limits') return result;
  recordReadingFirstRequestEvent({ controller: state.reading, request, eventKey: 'terminal', payload: result });
  await saveReading(state);
  if (state.translationStop?.action_id === event.action_id) { state.translationStop = null; await saveSessionMetadata(state); }
  return result;
}
