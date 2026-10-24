import { getRunControlForDispatch } from './owned-artifact-store.mjs';

const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const diagnostic = (code, path) => ({ code, path, message: code });
const fingerprintNames = ['source', 'parser_tool', 'permission', 'parent_revision', 'policy', 'authorization'];

function sorted(errors) {
  return [...errors].sort((left, right) => compare(left.code, right.code) || compare(left.path, right.path));
}

function validateArtifactDag(chain, errors) {
  const artifacts = new Map();
  for (const [index, artifact] of (chain.artifacts ?? []).entries()) {
    if (artifacts.has(artifact.artifact_id)) errors.push(diagnostic('ARTIFACT_ID_DUPLICATE', `/artifacts/${index}/artifact_id`));
    artifacts.set(artifact.artifact_id, artifact);
  }
  for (const [index, artifact] of (chain.artifacts ?? []).entries()) {
    for (const parent of artifact.depends_on ?? []) {
      if (!artifacts.has(parent)) errors.push(diagnostic('ARTIFACT_PARENT_MISSING', `/artifacts/${index}/depends_on`));
    }
  }
  const visited = new Set(), active = new Set();
  const visit = id => {
    if (active.has(id)) return true;
    if (visited.has(id)) return false;
    visited.add(id); active.add(id);
    const cycle = (artifacts.get(id)?.depends_on ?? []).some(visit);
    active.delete(id);
    return cycle;
  };
  if ([...artifacts.keys()].some(visit)) errors.push(diagnostic('ARTIFACT_DEPENDENCY_CYCLE', '/artifacts'));
  return artifacts;
}

/** Exact matching is required before a cached review or approval can be reused. */
export function validateCacheReuse({ declared, current } = {}) {
  const errors = [];
  for (const name of fingerprintNames) {
    if (!declared?.[name] || !current?.[name] || declared[name] !== current[name]) {
      errors.push(diagnostic('DEPENDENCY_INVALIDATED', `/fingerprints/${name}`));
    }
  }
  return { ok: errors.length === 0, errors: sorted(errors) };
}

/**
 * Preserves parent records, invalidates downstream records transitively, and
 * leaves Phase-22 as an invalidation-only placeholder.
 */
export function invalidateProofChain(chain, { changedArtifactIds = [], currentFingerprints = {}, invalidateAll = false } = {}) {
  const next = structuredClone(chain);
  const invalid = new Set(changedArtifactIds);
  if (invalidateAll) for (const artifact of next.artifacts ?? []) invalid.add(artifact.artifact_id);
  for (const dependency of next.dependencies ?? []) {
    const current = currentFingerprints[dependency.artifact_id];
    if (invalidateAll || !current || !validateCacheReuse({ declared: dependency.fingerprints, current }).ok) {
      dependency.status = 'invalid';
      invalid.add(dependency.artifact_id);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const artifact of next.artifacts ?? []) {
      if (artifact.depends_on?.some(parent => invalid.has(parent)) && !invalid.has(artifact.artifact_id)) {
        invalid.add(artifact.artifact_id);
        changed = true;
      }
    }
  }
  for (const artifact of next.artifacts ?? []) {
    if (invalid.has(artifact.artifact_id)) artifact.status = 'invalid';
  }
  if (invalid.size) next.delivery_status = 'pending_resolver';
  return next;
}

/** Validates only deterministic local chain state; it never attests host isolation or P20-E12 delivery. */
export function validateProofChain({ chain, dispatchContext, phase21Validator } = {}) {
  const errors = [];
  if (!chain || typeof chain !== 'object') return { ok: false, errors: [diagnostic('STRUCTURE_INVALID', '/')], evidence_verified: false, p20_e12_disposition: 'unverified' };
  if (!phase21Validator) errors.push(diagnostic('PHASE21_VALIDATOR_REQUIRED', '/'));
  else {
    const shape = phase21Validator.validate('phase21/proof-chain', chain);
    if (!shape.ok) errors.push(...shape.errors.map(path => diagnostic('STRUCTURE_INVALID', path)));
  }
  const ids = new Set();
  for (const [index, artifact] of (chain.artifacts ?? []).entries()) {
    const path = `/artifacts/${index}`;
    if (ids.has(artifact.artifact_id)) errors.push(diagnostic('ARTIFACT_ID_DUPLICATE', `${path}/artifact_id`));
    ids.add(artifact.artifact_id);
    if (artifact.status !== 'current') errors.push(diagnostic('ARTIFACT_INVALID', path));
  }
  for (const [index, dependency] of (chain.dependencies ?? []).entries()) {
    if (dependency.status !== 'current') errors.push(diagnostic('DEPENDENCY_INVALIDATED', `/dependencies/${index}`));
  }
  const artifacts = validateArtifactDag(chain, errors);
  const sourceCheck = chain.source_check;
  if (sourceCheck) {
    if (sourceCheck.status === 'independent' && chain.isolation_observation !== 'observed') errors.push(diagnostic('SOURCE_CHECK_NOT_INDEPENDENT', '/source_check/status'));
    if (sourceCheck.distribution_status === 'released' && (!sourceCheck.sealed || !chain.analysis_draft_frozen)) errors.push(diagnostic('SOURCE_CHECK_RELEASE_PREMATURE', '/source_check/distribution_status'));
  }
  const criticalOpen = (chain.critical_defects ?? []).filter(item => item.severity === 'critical' && item.status !== 'resolved');
  const unresolvedDisagreements = (chain.important_disagreements ?? []).filter(item => !Array.isArray(item.evidence_links) || item.evidence_links.length === 0 || !['resolved', 'bounded'].includes(item.disposition));
  if (chain.delivery_status === 'deliverable') {
    const control = getRunControlForDispatch({ dispatchContext, runId: chain.run_id });
    if (!control || JSON.stringify(control.required_artifacts) !== JSON.stringify(chain.required_artifacts) || JSON.stringify(control.integration_prerequisites) !== JSON.stringify(chain.integration_prerequisites)) errors.push(diagnostic('DELIVERY_CONTROL_CONTEXT_REQUIRED', '/delivery_status'));
    const requiredIds = new Set();
    for (const [index, required] of (chain.required_artifacts ?? []).entries()) {
      if (requiredIds.has(required.artifact_id)) errors.push(diagnostic('DELIVERY_REQUIRED_ARTIFACT_DUPLICATE', `/required_artifacts/${index}/artifact_id`));
      requiredIds.add(required.artifact_id);
      const actual = artifacts.get(required.artifact_id);
      if (!actual) errors.push(diagnostic('DELIVERY_REQUIRED_ARTIFACT_MISSING', `/required_artifacts/${index}`));
      else if (actual.status !== 'current' || actual.owner_actor_id !== required.owner_actor_id || actual.path !== required.path || actual.receipt_sha256 !== actual.sha256) errors.push(diagnostic('DELIVERY_REQUIRED_ARTIFACT_NOT_CURRENT', `/required_artifacts/${index}`));
    }
    const prerequisites = chain.integration_prerequisites ?? {};
    if (new Set(Object.values(prerequisites)).size !== 4) errors.push(diagnostic('DELIVERY_INTEGRATION_PREREQUISITES_DUPLICATE', '/integration_prerequisites'));
    for (const [name, artifactId] of Object.entries(prerequisites)) {
      const actual = artifacts.get(artifactId);
      if (!requiredIds.has(artifactId) || !actual || actual.status !== 'current') errors.push(diagnostic('DELIVERY_INTEGRATION_PREREQUISITE_MISSING', `/integration_prerequisites/${name}`));
    }
    if (chain.source_check?.sealed !== true || chain.analysis_draft_frozen !== true) errors.push(diagnostic('DELIVERY_REVIEW_NOT_SEALED', '/source_check'));
    if (criticalOpen.length) errors.push(diagnostic('DELIVERY_CRITICAL_DEFECT_OPEN', '/critical_defects'));
    if (unresolvedDisagreements.length) errors.push(diagnostic('DELIVERY_DISAGREEMENT_UNRESOLVED', '/important_disagreements'));
    if (errors.some(error => ['ARTIFACT_INVALID', 'DEPENDENCY_INVALIDATED'].includes(error.code))) errors.push(diagnostic('DELIVERY_INPUT_NOT_CURRENT', '/delivery_status'));
  }
  // dispatchContext is intentionally opaque to this validator. Source/tool text
  // cannot add authority; only the calling workflow control root can choose an action.
  void dispatchContext;
  return {
    ok: errors.length === 0,
    errors: sorted(errors),
    evidence_verified: false,
    local_enforcement_scope: 'artifact_root_only',
    host_context_isolation: chain.isolation_observation === 'observed' ? 'declared_not_host_attested' : 'not_independent',
    p20_e12_disposition: 'unverified',
  };
}
