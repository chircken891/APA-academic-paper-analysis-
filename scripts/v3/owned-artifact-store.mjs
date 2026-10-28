import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, link, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const capabilities = new WeakMap();
const contexts = new WeakMap();
const isolationObservations = new WeakMap();
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const receiptPath = (root, artifactId) => resolve(root, '.phase21-receipts', `${encodeURIComponent(artifactId)}.json`);
const normalizedPath = value => String(value).replaceAll('\\', '/');
const bindingKey = ({ runId, actorId, role, artifactPath, revision }) => JSON.stringify([runId, actorId, role, normalizedPath(artifactPath), revision]);
const controlCopy = value => structuredClone(value);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

async function publishExclusive(target, content) {
  const temp = target + '.' + randomUUID() + '.tmp';
  try { await writeFile(temp, content, { flag: 'wx' }); await link(temp, target); }
  finally { try { await unlink(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}

function relativeOwnedPath(root, value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) fail('ARTIFACT_PATH_INVALID');
  if (isAbsolute(value)) fail('ARTIFACT_PATH_OUTSIDE_ROOT');
  const target = resolve(root, value);
  const rel = relative(root, target);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || resolve(root, rel) !== target) fail('ARTIFACT_PATH_OUTSIDE_ROOT');
  const normalized = normalizedPath(rel);
  if (normalized === '.phase21-receipts' || normalized.startsWith('.phase21-receipts/')) fail('ARTIFACT_PATH_RESERVED');
  return { target, rel: normalized };
}

/**
 * Control-root-only constructor. Capabilities are opaque WeakMap keys and cannot
 * be reconstructed from JSON, a claimed role, model name, or artifact content.
 */
export function createOwnedArtifactBroker(controlConfig = {}) {
  if (!controlConfig || typeof controlConfig.control_actor_id !== 'string' || !controlConfig.control_actor_id) {
    throw new Error('control_actor_id is required to create an owned artifact broker.');
  }
  if (typeof controlConfig.artifact_root !== 'string' || !controlConfig.artifact_root) throw new Error('artifact_root is required to create an owned artifact broker.');
  if (!Array.isArray(controlConfig.authorized_bindings)) throw new Error('authorized_bindings is required to create an owned artifact broker.');
  const artifactRoot = resolve(controlConfig.artifact_root);
  const authorizedBindings = new Set(controlConfig.authorized_bindings.map(binding => bindingKey({
    runId: binding.run_id, actorId: binding.actor_id, role: binding.role, artifactPath: binding.artifact_path, revision: binding.revision,
  })));
  const runControls = new Map((controlConfig.run_controls ?? []).map(control => [control.run_id, controlCopy(control)]));
  const dispatchContext = Object.freeze({ kind: 'phase21-owned-artifact-dispatch' });
  const issuerNonce = randomUUID();
  contexts.set(dispatchContext, { control_actor_id: controlConfig.control_actor_id, issuerNonce, artifactRoot, authorizedBindings, runControls });
  const issueCapability = ({ runId, actorId, role, artifactPath, revision } = {}) => {
    if (![runId, actorId, role, artifactPath, revision].every(value => typeof value === 'string' && value)) {
      throw new Error('runId, actorId, role, artifactPath, and revision are required.');
    }
    const normalizedArtifactPath = normalizedPath(artifactPath);
    if (!authorizedBindings.has(bindingKey({ runId, actorId, role, artifactPath: normalizedArtifactPath, revision }))) fail('SCHEDULE_BINDING_UNAUTHORIZED');
    const capability = Object.freeze({});
    capabilities.set(capability, { issuerNonce, runId, actorId, role, artifactPath: normalizedArtifactPath, revision, consumed: false });
    return capability;
  };
  const issueIsolationObservation = ({ runId } = {}) => {
    if (typeof runId !== 'string' || !runId) throw new Error('runId is required for an isolation observation.');
    const observation = Object.freeze({});
    // This local broker cannot observe host context separation. A later host
    // capability layer must supply its own evidence; config cannot simulate it.
    isolationObservations.set(observation, { issuerNonce, runId, status: 'not_independent' });
    return observation;
  };
  const resolveIsolationObservation = ({ observation, runId } = {}) => {
    const state = isolationObservations.get(observation);
    return state && state.issuerNonce === issuerNonce && state.runId === runId ? state.status : 'not_independent';
  };
  const getRunControl = ({ runId } = {}) => {
    const control = contexts.get(dispatchContext).runControls.get(runId);
    return control ? controlCopy(control) : null;
  };
  const readFromOwnedRoot = async ({ artifactRoot: requestedRoot, artifactId } = {}) => {
    if (typeof requestedRoot !== 'string' || resolve(requestedRoot) !== artifactRoot) fail('ARTIFACT_ROOT_MISMATCH');
    return readOwnedArtifact({ artifactRoot, artifactId });
  };
  return Object.freeze({
    dispatchContext,
    issueCapability,
    issueIsolationObservation,
    resolveIsolationObservation,
    getRunControl,
    artifactStore: Object.freeze({ commitOwnedArtifact, readOwnedArtifact: readFromOwnedRoot }),
    local_enforcement_scope: 'artifact_root_only',
    host_filesystem_enforcement: 'unverified',
  });
}

/** Internal bridge for deterministic delivery gating; forged plain objects have no WeakMap entry. */
export function getRunControlForDispatch({ dispatchContext, runId } = {}) {
  const context = contexts.get(dispatchContext);
  const control = context?.runControls.get(runId);
  return control ? controlCopy(control) : null;
}

export async function commitOwnedArtifact({ artifactRoot, dispatchContext, capability, artifact, expectedRevision } = {}) {
  const context = contexts.get(dispatchContext);
  const state = capabilities.get(capability);
  if (!context || !state || context.issuerNonce !== state.issuerNonce) fail('CAPABILITY_FORGED_OR_WRONG_DISPATCH');
  if (state.consumed) fail('CAPABILITY_ALREADY_CONSUMED');
  if (!artifact || typeof artifact.artifact_id !== 'string' || !artifact.artifact_id) fail('ARTIFACT_ID_REQUIRED');
  if (expectedRevision !== state.revision || artifact.revision !== undefined && artifact.revision !== state.revision) fail('CAPABILITY_REVISION_MISMATCH');
  if (artifact.path !== undefined && String(artifact.path).replaceAll('\\', '/') !== state.artifactPath) fail('CAPABILITY_PATH_MISMATCH');
  if (typeof artifactRoot !== 'string' || !artifactRoot || resolve(artifactRoot) !== context.artifactRoot) fail('ARTIFACT_ROOT_MISMATCH');
  const root = context.artifactRoot;
  const { target, rel } = relativeOwnedPath(root, state.artifactPath);
  if (rel !== state.artifactPath) fail('CAPABILITY_PATH_MISMATCH');
  const bytes = Buffer.isBuffer(artifact.content) ? artifact.content : Buffer.from(String(artifact.content ?? ''), 'utf8');
  const sha256 = digest(bytes);
  const receipt = {
    schema_version: 'phase21-owned-artifact-receipt-1.0', artifact_id: artifact.artifact_id,
    run_id: state.runId, owner_actor_id: state.actorId, role: state.role, path: state.artifactPath,
    revision: state.revision, sha256, byte_length: bytes.length, local_enforcement_scope: 'artifact_root_only',
    host_filesystem_enforcement: 'unverified',
  };
  // A rejected write also consumes this one scheduled capability. Recovery must
  // re-enter through the control root for a fresh capability rather than retry it.
  state.consumed = true;
  try {
    await mkdir(dirname(target), { recursive: true });
    await publishExclusive(target, bytes);
  } catch (error) {
    if (error?.code === 'EEXIST') fail('ARTIFACT_ALREADY_EXISTS');
    throw error;
  }
  try {
    const targetReceipt = receiptPath(root, artifact.artifact_id);
    await mkdir(dirname(targetReceipt), { recursive: true });
    await publishExclusive(targetReceipt, `${JSON.stringify(receipt)}\n`);
  } catch (error) {
    if (error?.code === 'EEXIST') fail('RECEIPT_ALREADY_EXISTS');
    throw error;
  }
  return Object.freeze(receipt);
}

export async function readOwnedArtifact({ artifactRoot, artifactId } = {}) {
  if (typeof artifactId !== 'string' || !artifactId) throw new Error('artifactId is required.');
  if (typeof artifactRoot !== 'string' || !artifactRoot) throw new Error('artifactRoot is required.');
  const root = resolve(artifactRoot);
  let receipt;
  try { receipt = JSON.parse(await readFile(receiptPath(root, artifactId), 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  const { target } = relativeOwnedPath(root, receipt.path);
  const bytes = await readFile(target);
  if (digest(bytes) !== receipt.sha256 || bytes.length !== receipt.byte_length) fail('RECEIPT_BYTE_BINDING_MISMATCH');
  return Object.freeze({ receipt: Object.freeze(receipt), bytes });
}
/** Reconcile a missing receipt only from a durable, validated Controller record. */
export async function repairOwnedArtifactReceipt({ artifactRoot, dispatchContext, capability, artifact, expectedRevision, statePath, role } = {}) {
  const context = contexts.get(dispatchContext), state = capabilities.get(capability);
  if (!context || !state || context.issuerNonce !== state.issuerNonce) fail('CAPABILITY_FORGED_OR_WRONG_DISPATCH');
  if (state.consumed) fail('CAPABILITY_ALREADY_CONSUMED');
  if (resolve(artifactRoot) !== context.artifactRoot || expectedRevision !== state.revision || artifact?.path !== state.artifactPath) fail('CAPABILITY_PATH_MISMATCH');
  const { fingerprintReadingFirst } = await import('./reading-first-runtime.mjs');
  const record = JSON.parse(await readFile(statePath, 'utf8'));
  if (record.schema_version !== 'science-controller-state-1.0' || !record.data || record.fingerprint !== fingerprintReadingFirst(record.data)) fail('RECOVERY_STATE_INVALID');
  const data = record.data, runId = data.prepared?.runControl?.run_id;
  const frozenControl = context.runControls.get(runId);
  if (state.runId !== runId || !frozenControl || fingerprintReadingFirst(frozenControl) !== fingerprintReadingFirst(data.prepared.runControl)
    || resolve(data.prepared.paths.runRoot) !== context.artifactRoot) fail('RECOVERY_AUTHORITY_MISMATCH');
  let task, bytes;
  if (role === 'checkpoint') {
    task = data.handoff?.checkpointTask;
    const snapshot = data.handoff?.snapshot;
    const { checkpoint_fingerprint, ...body } = snapshot ?? {};
    if (!snapshot || snapshot.schema_version !== 'reading-first-checkpoint-1.0' || checkpoint_fingerprint !== fingerprintReadingFirst(body)
      || snapshot.control_fingerprint !== fingerprintReadingFirst(data.prepared.runControl.reading_first_binding)) fail('RECOVERY_CHECKPOINT_INVALID');
    bytes = Buffer.from(JSON.stringify(snapshot));
  } else {
    task = data.tasks?.[role];
    const entry = data.entries?.[role];
    if (!entry?.intent || !entry.raw_observation || entry.observation?.status !== 'observed' || typeof entry.content_base64 !== 'string') fail('RECOVERY_OBSERVATION_REQUIRED');
    const { ingestObservedRunStep } = await import('./phase21-runner.mjs');
    const checked = ingestObservedRunStep({ packet: entry.request.packet, emittedStep: entry.request.emittedStep, observation: entry.raw_observation,
      run: { run_id: runId }, now: entry.observation.observed_at });
    if (checked.status !== 'observed' || fingerprintReadingFirst(checked) !== fingerprintReadingFirst(entry.observation)
      || entry.intent.action_id !== entry.request.emittedStep.action_id) fail('RECOVERY_OBSERVATION_INVALID');
    bytes = Buffer.from(entry.content_base64, 'base64');
    if (digest(bytes) !== entry.content_sha256) fail('RECOVERY_CONTENT_INVALID');
  }
  if (!task || task.artifact_id !== artifact?.artifact_id || task.artifact_path !== state.artifactPath || task.owner_actor_id !== state.actorId
    || task.role !== state.role || task.revision !== state.revision || !Buffer.from(artifact.content).equals(bytes)) fail('RECOVERY_AUTHORITY_MISMATCH');
  const { target } = relativeOwnedPath(context.artifactRoot, state.artifactPath);
  if (!(await readFile(target)).equals(bytes)) fail('RECOVERY_CONTENT_MISMATCH');
  const receipt = { schema_version: 'phase21-owned-artifact-receipt-1.0', artifact_id: artifact.artifact_id, run_id: state.runId,
    owner_actor_id: state.actorId, role: state.role, path: state.artifactPath, revision: state.revision,
    sha256: digest(bytes), byte_length: bytes.length, local_enforcement_scope: 'artifact_root_only', host_filesystem_enforcement: 'unverified' };
  state.consumed = true;
  const targetReceipt = receiptPath(context.artifactRoot, artifact.artifact_id);
  await mkdir(dirname(targetReceipt), { recursive: true });
  try { await publishExclusive(targetReceipt, `${JSON.stringify(receipt)}\n`); }
  catch (error) { if (error?.code === 'EEXIST') fail('RECEIPT_ALREADY_EXISTS'); throw error; }
  return Object.freeze(receipt);
}
