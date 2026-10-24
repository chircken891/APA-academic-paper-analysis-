import { createHash } from 'node:crypto';
import { invalidateProofChain, validateProofChain } from './proof-chain-validator.mjs';

const blockedActions = new Set(['upload', 'install', 'model_switch', 'publish', 'external_transfer']);
const copy = value => structuredClone(value ?? {});
const copyRun = value => {
  const { phase21Validator, ...serializable } = value ?? {};
  return { ...copy(serializable), ...(phase21Validator ? { phase21Validator } : {}) };
};
const error = code => Object.assign(new Error(code), { code });
const storeCommit = store => store?.artifactStore?.commitOwnedArtifact ?? store?.commitOwnedArtifact;
const storeRead = store => store?.artifactStore?.readOwnedArtifact ?? store?.readOwnedArtifact;
const fingerprintNames = ['source', 'parser_tool', 'permission', 'parent_revision', 'policy', 'authorization'];
const recoverableStoreCodes = new Set(['EAGAIN', 'EBUSY', 'ETIMEDOUT', 'EINTR']);

function assertAction(action) {
  if (!action || typeof action !== 'object') throw error('SCHEDULED_ACTION_REQUIRED');
  if (blockedActions.has(action.type)) throw error('ACTION_OUTSIDE_APPROVED_SCOPE');
  if (!['write_artifact', 'seal_source_check', 'freeze_analysis_draft', 'compare'].includes(action.type)) throw error('ACTION_TYPE_UNSUPPORTED');
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function completeFingerprints(value) {
  return value && fingerprintNames.every(name => typeof value[name] === 'string' && value[name]);
}

function validateRunControl(run, artifactStore) {
  const control = artifactStore?.getRunControl?.({ runId: run.run_id });
  if (!control) return { ok: false, reason: 'RUN_CONTROL_REQUIRED' };
  if (!completeFingerprints(control.approved_fingerprints) || !completeFingerprints(run.declared_fingerprints) || !completeFingerprints(run.current_fingerprints)) {
    return { ok: false, reason: 'RUN_FINGERPRINTS_REQUIRED' };
  }
  if (!sameJson(control.required_artifacts, run.chain?.required_artifacts) || !sameJson(control.integration_prerequisites, run.chain?.integration_prerequisites)) {
    return { ok: false, reason: 'RUN_CONTROL_PREREQUISITES_MISMATCH' };
  }
  if (!fingerprintNames.every(name => control.approved_fingerprints[name] === run.declared_fingerprints[name] && run.declared_fingerprints[name] === run.current_fingerprints[name])) {
    return { ok: false, reason: 'DEPENDENCY_INVALIDATED', invalidate: true };
  }
  return { ok: true, control };
}

function attachReceiptToChain(run, receipt, action = {}) {
  const next = run;
  const existing = next.chain.artifacts.find(item => item.artifact_id === receipt.artifact_id);
  if (existing) {
    if (existing.path !== receipt.path || existing.revision !== receipt.revision || existing.owner_actor_id !== receipt.owner_actor_id || existing.sha256 !== receipt.sha256 || existing.receipt_sha256 !== receipt.sha256) throw error('CHAIN_RECEIPT_CONFLICT');
    return next;
  }
  next.chain.artifacts.push({
    artifact_id: receipt.artifact_id, path: receipt.path, revision: receipt.revision,
    owner_actor_id: receipt.owner_actor_id, sha256: receipt.sha256, receipt_sha256: receipt.sha256, status: 'current',
    parent_revision: action.parent_revision ?? null, depends_on: action.depends_on ?? [], evidence_tier: 'offline',
  });
  return next;
}

function appendReceiptOnce(run, receipt) {
  if (!(run.receipts ?? []).some(item => item.artifact_id === receipt.artifact_id && item.run_id === receipt.run_id && item.sha256 === receipt.sha256)) {
    run.receipts = [...(run.receipts ?? []), receipt];
  }
  return run;
}

// A receipt proves stored bytes, not their dependency edges. Recover those only
// from the control-root schedule, or an already-bound current chain entry.
function recoveredDependencies(run, receipt, action) {
  const existing = run.chain.artifacts.find(item => item.artifact_id === receipt.artifact_id);
  if (receipt.run_id !== run.run_id || existing && (existing.status !== 'current'
    || existing.path !== receipt.path || existing.revision !== receipt.revision
    || existing.owner_actor_id !== receipt.owner_actor_id || existing.sha256 !== receipt.sha256
    || existing.receipt_sha256 !== receipt.sha256)) throw error('UNKNOWN_WRITE_RECEIPT_MISMATCH');
  if (!action && !existing) throw error('UNKNOWN_WRITE_ACTION_REQUIRED');
  if (action) {
    assertAction(action);
    if (!action.artifact || action.artifact.artifact_id !== receipt.artifact_id
      || action.artifact_path !== receipt.path || action.revision !== receipt.revision
      || action.actor_id !== receipt.owner_actor_id || action.role !== receipt.role
      || typeof action.role !== 'string' || !action.role
      || action.route_fingerprint && action.route_fingerprint !== run.route_fingerprint) {
      throw error('UNKNOWN_WRITE_ACTION_MISMATCH');
    }
    const bytes = Buffer.isBuffer(action.artifact.content) ? action.artifact.content
      : Buffer.from(String(action.artifact.content ?? ''), 'utf8');
    if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== receipt.sha256) {
      throw error('UNKNOWN_WRITE_CONTENT_MISMATCH');
    }
  }
  const metadata = action ?? existing;
  if (!Object.hasOwn(metadata, 'parent_revision') || !Array.isArray(metadata.depends_on)
    || new Set(metadata.depends_on).size !== metadata.depends_on.length
    || metadata.depends_on.some(id => typeof id !== 'string' || !id || id === receipt.artifact_id)
    || (metadata.depends_on.length === 0 ? metadata.parent_revision !== null
      : typeof metadata.parent_revision !== 'string' || !metadata.parent_revision)) {
    throw error('UNKNOWN_WRITE_DEPENDENCIES_REQUIRED');
  }
  if (metadata.depends_on.some(id => !run.chain.artifacts.some(parent => parent.artifact_id === id && parent.status === 'current'))) {
    throw error('UNKNOWN_WRITE_PARENT_NOT_CURRENT');
  }
  if (existing && action && (existing.parent_revision !== action.parent_revision
    || !sameJson(existing.depends_on, action.depends_on))) throw error('UNKNOWN_WRITE_DEPENDENCY_CONFLICT');
  return { parent_revision: metadata.parent_revision, depends_on: [...metadata.depends_on] };
}

function resolveDelivery(run, dispatchContext) {
  if (!run.phase21Validator || !run.chain) return run;
  const candidate = run.delivery_requested
    ? { ...run.chain, delivery_status: 'deliverable' }
    : run.chain;
  const result = validateProofChain({ chain: candidate, dispatchContext, phase21Validator: run.phase21Validator });
  if (run.delivery_requested) run.chain.delivery_status = result.ok ? 'deliverable' : 'blocked';
  run.delivery_gate = result;
  return run;
}

/** Advances one control-root scheduled action through the broker-backed store. */
export async function advanceRun({ run, dispatchContext, action, artifactStore, now = new Date().toISOString() } = {}) {
  assertAction(action);
  const next = copyRun(run);
  if (!next.chain || !next.phase21Validator) throw error('PROOF_CHAIN_VALIDATOR_REQUIRED');
  const controlState = validateRunControl(next, artifactStore);
  if (!controlState.ok) {
    if (controlState.invalidate) next.chain = invalidateProofChain(next.chain, { invalidateAll: true });
    return { ...next, status: 'blocked', blocked_reason: controlState.reason };
  }
  const currentGate = validateProofChain({ chain: next.chain, dispatchContext, phase21Validator: next.phase21Validator });
  if (!currentGate.ok) return { ...next, status: 'blocked', blocked_reason: 'PROOF_CHAIN_INVALID', delivery_gate: currentGate };
  if (action.type === 'compare' && next.chain?.source_check?.sealed !== true) throw error('SOURCE_CHECK_NOT_SEALED');
  if (action.type === 'compare' && next.chain?.source_check?.distribution_status === 'released' && next.chain?.analysis_draft_frozen !== true) throw error('SOURCE_CHECK_RELEASE_PREMATURE');
  if (action.type === 'freeze_analysis_draft') {
    next.chain = copy(next.chain);
    next.chain.analysis_draft_frozen = true;
    if (next.chain.source_check?.sealed) next.chain.source_check.distribution_status = 'released';
  }
  let receipt = null;
  if (action.artifact) {
    if (!artifactStore?.issueCapability || !storeCommit(artifactStore)) throw error('CONTROL_ROOT_BROKER_REQUIRED');
    const capability = artifactStore.issueCapability({
      runId: next.run_id, actorId: action.actor_id, role: action.role, artifactPath: action.artifact_path, revision: action.revision,
    });
    receipt = await storeCommit(artifactStore)({
      artifactRoot: next.artifact_root, dispatchContext, capability,
      artifact: { artifact_id: action.artifact.artifact_id, content: action.artifact.content, path: action.artifact_path, revision: action.revision },
      expectedRevision: action.revision,
    });
    appendReceiptOnce(next, receipt);
    next.chain = copy(next.chain);
    attachReceiptToChain(next, receipt, action);
    if (action.retry_attempt_number) next.recoverable_retry_count = Number(next.recoverable_retry_count ?? 0) + 1;
    else next.initial_attempt_count = Number(next.initial_attempt_count ?? 0) + 1;
  }
  if (action.type === 'seal_source_check') {
    next.chain = copy(next.chain);
    const isolationStatus = artifactStore?.resolveIsolationObservation?.({ observation: action.isolation_observation, runId: next.run_id }) ?? 'not_independent';
    next.chain.source_check = {
      status: isolationStatus === 'observed' ? 'independent' : 'not_independent',
      sealed: true,
      distribution_status: 'withheld',
    };
    next.chain.isolation_observation = isolationStatus === 'observed' ? 'observed' : 'not_independent';
  }
  next.status = 'active';
  next.last_action = { type: action.type, at: now, receipt_artifact_id: receipt?.artifact_id ?? null };
  return resolveDelivery(next, dispatchContext);
}

/** Reconciles an unknown write before safely retrying the already-approved route. */
export async function resumeRun({ run, dispatchContext, artifactStore, approvedBudget, retryPolicy = {}, now = new Date().toISOString() } = {}) {
  const next = copyRun(run);
  if (!next.chain || !next.phase21Validator || !artifactStore?.issueCapability || !storeRead(artifactStore)) throw error('PROOF_CHAIN_VALIDATOR_AND_BROKER_REQUIRED');
  const controlState = validateRunControl(next, artifactStore);
  if (!controlState.ok) {
    if (controlState.invalidate) next.chain = invalidateProofChain(next.chain, { invalidateAll: true });
    return { ...next, status: 'blocked', blocked_reason: controlState.reason };
  }
  if (!approvedBudget || !Number.isInteger(approvedBudget.max_attempts) || approvedBudget.max_attempts < 0) throw error('APPROVED_ATTEMPT_CAP_REQUIRED');
  if (Number.isInteger(next.approved_budget?.max_attempts) && approvedBudget.max_attempts > next.approved_budget.max_attempts) {
    throw error('APPROVED_ATTEMPT_CAP_EXPANSION');
  }
  if (retryPolicy.route_fingerprint && next.route_fingerprint && retryPolicy.route_fingerprint !== next.route_fingerprint) throw error('ROUTE_CHANGE_NOT_AUTHORIZED');
  if (next.resume_action?.route_fingerprint && next.route_fingerprint && next.resume_action.route_fingerprint !== next.route_fingerprint) throw error('ROUTE_CHANGE_NOT_AUTHORIZED');
  if (next.unknown_write?.artifact_id) {
    const read = storeRead(artifactStore);
    if (!read) throw error('RECEIPT_RECONCILIATION_STORE_REQUIRED');
    const observed = await read({ artifactRoot: next.artifact_root, artifactId: next.unknown_write.artifact_id });
    if (observed) {
      const expected = next.unknown_write;
      const expectedFields = ['run_id', 'artifact_id', 'artifact_path', 'revision', 'owner_actor_id'];
      if (expectedFields.some(field => typeof expected[field] !== 'string' || !expected[field])
        || !completeFingerprints(expected.expected_fingerprints)
        || !fingerprintNames.every(name => expected.expected_fingerprints[name] === controlState.control.approved_fingerprints[name] && expected.expected_fingerprints[name] === next.current_fingerprints[name])
        || expected.expected_sha256 && observed.receipt.sha256 !== expected.expected_sha256
        || observed.receipt.run_id !== expected.run_id || observed.receipt.artifact_id !== expected.artifact_id
        || observed.receipt.path !== expected.artifact_path || observed.receipt.revision !== expected.revision
        || observed.receipt.owner_actor_id !== expected.owner_actor_id) {
        return { ...next, status: 'blocked', blocked_reason: 'UNKNOWN_WRITE_RECEIPT_MISMATCH' };
      }
      let dependencies;
      try { dependencies = recoveredDependencies(next, observed.receipt, run.resume_action); }
      catch (caught) { return { ...next, status: 'blocked', blocked_reason: caught.code ?? caught.message }; }
      next.chain = copy(next.chain);
      attachReceiptToChain(next, observed.receipt, dependencies);
      appendReceiptOnce(next, observed.receipt);
      delete next.unknown_write;
      next.status = 'reconciled';
      next.last_action = { type: 'reconcile_unknown_write', at: now, receipt_artifact_id: observed.receipt.artifact_id };
      return resolveDelivery(next, dispatchContext);
    }
    delete next.unknown_write;
  }
  const initial = Number(next.initial_attempt_count ?? 0);
  let retries = Number(next.recoverable_retry_count ?? 0);
  const remaining = Math.max(0, approvedBudget.max_attempts - initial - retries);
  if (remaining === 0) return { ...next, status: 'blocked', blocked_reason: 'APPROVED_ATTEMPT_CAP_EXHAUSTED', recoverable_retry_count: retries };
  const attempts = Math.min(3, remaining);
  let lastFailure = null;
  for (let index = 1; index <= attempts; index += 1) {
    retries += 1;
    const outcome = await retryPolicy.attempt?.({ retryNumber: retries, run: copyRun(next), now }) ?? { kind: 'nonrecoverable_failure', reason: 'RETRY_POLICY_MISSING' };
    if (outcome?.kind === 'scheduled_action' && outcome.action) {
      try {
        const retried = await advanceRun({
          run: { ...next, recoverable_retry_count: retries - 1 }, dispatchContext, artifactStore,
          action: { ...outcome.action, retry_attempt_number: retries }, now,
        });
        return { ...retried, recoverable_retry_count: retries, last_action: { type: 'recoverable_retry', at: now, retry_number: retries, receipt_artifact_id: retried.last_action?.receipt_artifact_id ?? null } };
      } catch (caught) {
        lastFailure = caught?.code ?? caught?.message ?? 'SCHEDULED_ACTION_FAILURE';
        if (!recoverableStoreCodes.has(caught?.code)) return { ...next, recoverable_retry_count: retries, status: 'blocked', blocked_reason: lastFailure };
        next.unknown_write = {
          run_id: next.run_id, artifact_id: outcome.action.artifact?.artifact_id, artifact_path: outcome.action.artifact_path,
          revision: outcome.action.revision, owner_actor_id: outcome.action.actor_id,
          expected_fingerprints: controlState.control.approved_fingerprints,
        };
        const read = storeRead(artifactStore);
        const observed = next.unknown_write.artifact_id ? await read({ artifactRoot: next.artifact_root, artifactId: next.unknown_write.artifact_id }) : null;
        if (observed) {
          const receipt = observed.receipt;
          if (receipt.run_id !== next.unknown_write.run_id || receipt.path !== next.unknown_write.artifact_path || receipt.revision !== next.unknown_write.revision || receipt.owner_actor_id !== next.unknown_write.owner_actor_id) return { ...next, recoverable_retry_count: retries, status: 'blocked', blocked_reason: 'UNKNOWN_WRITE_RECEIPT_MISMATCH' };
          let dependencies;
          try { dependencies = recoveredDependencies(next, receipt, outcome.action); }
          catch (caught) { return { ...next, recoverable_retry_count: retries, status: 'blocked', blocked_reason: caught.code ?? caught.message }; }
          next.chain = copy(next.chain); attachReceiptToChain(next, receipt, dependencies);
          appendReceiptOnce(next, receipt); delete next.unknown_write;
          return { ...next, recoverable_retry_count: retries, status: 'reconciled', last_action: { type: 'reconcile_unknown_write', at: now, receipt_artifact_id: receipt.artifact_id } };
        }
        delete next.unknown_write;
        continue;
      }
    }
    lastFailure = outcome?.reason ?? 'RECOVERABLE_FAILURE';
    if (outcome?.kind !== 'recoverable_failure') return { ...next, recoverable_retry_count: retries, status: 'blocked', blocked_reason: lastFailure };
  }
  return {
    ...next, recoverable_retry_count: retries,
    status: 'blocked',
    blocked_reason: remaining < 3 ? 'APPROVED_ATTEMPT_CAP_EXHAUSTED' : lastFailure,
    retry_requirement: remaining < 3 ? 'cap_exhausted_before_three_retries' : 'three_recoverable_retries_attempted',
  };
}
