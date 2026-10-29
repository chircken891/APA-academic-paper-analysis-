import { readFile, writeFile, mkdir, lstat, realpath } from 'node:fs/promises';
import { resolve, relative, sep, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createPublicKey } from 'node:crypto';
import { isDeepStrictEqual as same } from 'node:util';
import { loadBilingualPublication } from './phase22-publication.mjs';
import { fingerprintScientificInput, validateScientificInput } from './scientific-input-validator.mjs';
import { fingerprintV3Json as fingerprint } from './semantic-package-validator.mjs';
import { createOwnedArtifactBroker, readOwnedArtifact } from './owned-artifact-store.mjs';
import { advanceRun } from './workflow-orchestrator.mjs';
import { buildPreRenderHandoff, buildSourceEvidencePreRenderHandoff } from './workflow-composer.mjs';
import { consumePhase21Handoff, getReadingBasisContent } from './phase22-input.mjs';
import { decodeWholePaperArtifact } from './whole-paper-storage.mjs';
import { ingestObservedRunStep } from './phase21-runner.mjs';
import { resolveApaRoleModel, validateApaRoleModelPolicy } from '../apa-model-policy.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const LANGUAGES = ['en', 'zh-CN'];
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const nonblank = value => typeof value === 'string' && Boolean(value.trim());
const fail = (code, details = {}) => { throw Object.assign(new Error(code), { code, details }); };
const json = bytes => JSON.parse(bytes.toString('utf8'));
const decode = bytes => { const value = json(bytes); return value.storage_contract ? decodeWholePaperArtifact(bytes, { expectedKind: value.logical_kind }).value : value; };
const ids = (prefix, n) => Array.from({ length: n }, (_, i) => prefix + String(i + 1).padStart(2, '0'));
const sourceDeltas = new WeakMap();

function inside(root, path) {
  const target = resolve(root, path), rel = relative(resolve(root), target);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || /[\x00-\x1f]/.test(path)) fail('P221_ACCEPTANCE_PATH_INVALID');
  return target;
}
async function bytesAt(path) {
  path = resolve(path);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || await realpath(path) !== path) fail('P221_ACCEPTANCE_FILE_INVALID', { path });
  return readFile(path);
}
async function boundBytes(binding) {
  const bytes = await bytesAt(binding.path);
  if (sha(bytes) !== binding.sha256) fail('P221_PROPOSAL_BYTES_CHANGED', { path: binding.path });
  return bytes;
}

function assertSourceOnly(original, derived) {
  if (derived.input_fingerprint !== fingerprintScientificInput(derived) || original.input_fingerprint !== fingerprintScientificInput(original)) fail('P221_SOURCE_DELTA_FINGERPRINT_INVALID');
  const stripped = structuredClone(derived), originalBlocks = original.scientific_details.source_blocks;
  const additions = derived.scientific_details.source_blocks.slice(originalBlocks.length);
  if (!additions.length || derived.source_package.source_documents.length !== original.source_package.source_documents.length) fail('P221_SOURCE_DELTA_NOT_APPEND_ONLY');
  stripped.scientific_details.source_blocks.splice(originalBlocks.length);
  const addedLocators = [];
  stripped.source_package.source_documents.forEach((document, index) => {
    const count = original.source_package.source_documents[index].locators.length;
    addedLocators.push(...document.locators.slice(count)); document.locators.splice(count);
  });
  stripped.input_fingerprint = original.input_fingerprint;
  if (!same(stripped, original)) fail('P221_SOURCE_DELTA_CHANGED_SCIENCE');
  const locations = additions.map(({ source_document_id, source_hash, page_index, block_id }) => ({ source_document_id, source_hash, page_index, block_id }));
  if (locations.length !== addedLocators.length || locations.some(location => addedLocators.filter(row => same(row, location)).length !== 1)) fail('P221_SOURCE_DELTA_LOCATOR_INVALID');
  const checked = validateScientificInput(derived);
  if (!checked.ok) fail('P221_SOURCE_DELTA_INVALID', { errors: checked.errors });
  return additions;
}

/** Pure parameterized equivalent of the r2 exact-source-only delta. Never writes
 * old/new science, creates receipts, approves content or performs a parser run. */
export async function deriveReaderSourceOnlyInput({ scientificInput, proposalBytes, approval, sample } = {}) {
  const proposal = json(proposalBytes), proposalSha256 = sha(proposalBytes);
  const profile = proposalProfile(proposal);
  if (proposal.schema_version !== undefined && !profile) fail('P221_PROPOSAL_REQUIRED');
  if (!proposalAuthorizationValid(proposal, proposalSha256, approval) || !nonblank(approval.authorization_id)) fail('P221_NEW_AUTHORIZATION_REQUIRED');
  if (profile?.reuse && !profile.sourceSupplement) fail('P221_REUSE_SOURCE_CHANGE_FORBIDDEN');
  if (profile?.sourceSupplement && (sample !== '07' || !sourceSupplementValid(proposal))) fail('P221_SOURCE_ADOPTION_REQUIRED');
  const adoptions = proposal.source_adoptions?.filter(row => row.sample === sample) ?? [];
  if (!adoptions.length) fail('P221_SOURCE_ADOPTION_REQUIRED');
  const checked = validateScientificInput(scientificInput);
  if (!checked.ok) fail('P221_ORIGINAL_SCI_INVALID', { errors: checked.errors });
  const derived = structuredClone(scientificInput), used = new Set(derived.scientific_details.source_blocks.map(block => block.source_block_id)), records = [];
  for (const row of adoptions) {
    if (row.original_input_fingerprint !== scientificInput.input_fingerprint) fail('P221_SOURCE_ADOPTION_INPUT_CHANGED');
    if (!proposal.bindings?.some(binding => binding.path === row.file.path && binding.sha256 === row.file.sha256)) fail('P221_SOURCE_NOT_IN_PROPOSAL');
    const container = json(await boundBytes(row.file));
    if (typeof row.pointer !== 'string' || !row.pointer.startsWith('/')) fail('P221_SOURCE_RANGE_INVALID');
    const source = row.pointer.slice(1).split('/').reduce((value, key) => value?.[key.replaceAll('~1', '/').replaceAll('~0', '~')], container);
    if (typeof source !== 'string' || !Number.isInteger(row.start) || !Number.isInteger(row.end) || row.start < 0 || row.end <= row.start || row.end > source.length) fail('P221_SOURCE_RANGE_INVALID');
    const text = source.slice(row.start, row.end);
    if (sha(Buffer.from(text)) !== row.text_sha256) fail('P221_SOURCE_RANGE_CHANGED');
    const document = derived.source_package.source_documents.find(item => item.source_document_id === row.source_document_id && item.source_hash === row.source_hash);
    if (!document || used.has(row.source_block_id) || !nonblank(row.source_block_id) || !nonblank(row.block_id) || !Number.isInteger(row.page_index) || row.page_index < 0) fail('P221_SOURCE_IDENTITY_INVALID');
    const locator = { source_document_id: row.source_document_id, source_hash: row.source_hash, page_index: row.page_index, block_id: row.block_id };
    if (document.locators.some(item => same(item, locator))) fail('P221_SOURCE_LOCATOR_DUPLICATE');
    document.locators.push(locator);
    derived.scientific_details.source_blocks.push({ source_block_id: row.source_block_id, ...locator, role: row.role, text });
    used.add(row.source_block_id); records.push(structuredClone(row));
  }
  derived.input_fingerprint = fingerprintScientificInput(derived);
  assertSourceOnly(scientificInput, derived);
  const sourceDelta = { schema_version: 'phase221-source-only-delta-1.0', authorization_id: approval.authorization_id,
    proposal_sha256: proposalSha256, sample, original_input_fingerprint: scientificInput.input_fingerprint, derived_input_fingerprint: derived.input_fingerprint,
    adoptions: records, science_except_source_additions_equal: true, required_units_unchanged: true, reading_obligations_unchanged: true,
    original_source_seal_retained: true, new_role_execution: false, new_parser_execution: false, new_scientific_acceptance: false };
  sourceDeltas.set(sourceDelta, { hash: sha(Buffer.from(JSON.stringify(sourceDelta))) });
  return { scientificInput: derived, sourceDelta };
}

/** Metadata adoption only. The current broker/proof-chain/handoff must still
 * consume this new artifact; this return value grants no execution authority. */
export async function adoptReaderSourceOnlyDelta({ original, derived, artifact, sourceBinding, sourceDelta } = {}) {
  assertSourceOnly(original, derived);
  if (!sourceDeltas.has(sourceDelta) || sourceDeltas.get(sourceDelta).hash !== sha(Buffer.from(JSON.stringify(sourceDelta)))
    || sourceDelta?.schema_version !== 'phase221-source-only-delta-1.0' || sourceDelta.original_input_fingerprint !== original.input_fingerprint
    || sourceDelta.derived_input_fingerprint !== derived.input_fingerprint || artifact?.scientific_input_fingerprint !== original.input_fingerprint
    || !nonblank(sourceBinding?.path) || !/^sha256:[0-9a-f]{64}$/.test(sourceBinding.sha256)) fail('P221_SOURCE_ADOPTION_BINDING_INVALID');
  if (!same(decode(await boundBytes(sourceBinding)), artifact)) fail('P221_SOURCE_ADOPTION_ARTIFACT_CHANGED');
  const adopted = structuredClone(artifact);
  adopted.scientific_input_fingerprint = derived.input_fingerprint;
  adopted.p221_source_only_delta_adoption = { ...structuredClone(sourceDelta), original_artifact: structuredClone(sourceBinding),
    operation: 'Adopt unchanged historical role content/source check with exact approved same-source excerpts; no new role or parser acceptance.' };
  return adopted;
}

/** Exact new-root assembly of the existing r2 adoption route. All destinations
 * must already be in the approved proposal. No role execution or publication. */
export async function assembleReaderSourceAdoption({ prior, original, derived, sourceDelta, proposalBytes, approval, sample,
  phase21Validator = prior?.phase21Validator, phase22Validator } = {}) {
  const proposal = json(proposalBytes), spec = proposal.source_adoption_assembly?.find(row => row.sample === sample);
  if (!proposalAuthorizationValid(proposal, sha(proposalBytes), approval)
    || !spec) fail('P221_NEW_AUTHORIZATION_REQUIRED');
  const changedSource = original.input_fingerprint !== derived.input_fingerprint;
  const profile = proposalProfile(proposal);
  if (proposal.schema_version !== undefined && !profile) fail('P221_PROPOSAL_REQUIRED');
  if (profile?.reuse && (sample !== '07' || changedSource && !profile.sourceSupplement)) fail('P221_REUSE_SOURCE_CHANGE_FORBIDDEN');
  if (profile?.sourceSupplement && (!changedSource || !sourceSupplementValid(proposal))) fail('P221_SOURCE_ADOPTION_REQUIRED');
  if (changedSource) {
    if (sourceDelta?.proposal_sha256 !== sha(proposalBytes) || sourceDelta.authorization_id !== approval.authorization_id) fail('P221_NEW_AUTHORIZATION_REQUIRED');
    assertSourceOnly(original, derived);
  } else if (!same(original, derived)) fail('P221_SOURCE_DELTA_CHANGED_SCIENCE');
  const previous = await consumePhase21Handoff({ ...prior, phase21Validator, phase22Validator });
  if (!previous.ok) fail('P221_PRIOR_ADMISSION_REJECTED', { errors: previous.errors });
  const previousScience = getReadingBasisContent(previous.basis);
  if (!same(previousScience.source_package, original.source_package) || !same(previousScience.scientific_details, original.scientific_details)
    || !same(previousScience.core, original.core) || !same(previousScience.reading_card, original.reading_card)
    || prior.handoff.scientific_input_fingerprint !== original.input_fingerprint) fail('P221_SOURCE_ADOPTION_INPUT_CHANGED');
  const oldControl = prior.currentControl, oldRun = oldControl.run, root = resolve(spec.artifact_root), actor = spec.controller_actor_id;
  if (root === resolve(oldControl.artifactRoot) || !nonblank(actor)) fail('P221_ADOPTION_NEW_ROOT_REQUIRED');
  const entries = spec.artifacts, byId = new Map(entries.map(row => [row.artifact_id, row]));
  if (byId.size !== entries.length || new Set(entries.map(row => row.path)).size !== entries.length) fail('P221_ADOPTION_PATH_COLLISION');
  for (const entry of entries) {
    inside(root, entry.path);
    if (!proposal.owned_artifact_paths.includes(spec.root_relative + '/' + entry.path)) fail('P221_ADOPTION_PATH_NOT_APPROVED');
  }
  const scienceEntry = byId.get(spec.scientific_input_artifact_id), producerEntry = byId.get(spec.producer_artifact_id);
  if (!scienceEntry || !producerEntry || scienceEntry.role !== 'control' || producerEntry.role !== 'control') fail('P221_ADOPTION_CONTROL_MISSING');
  const bindings = entries.map(row => ({ run_id: oldRun.run_id, actor_id: actor, role: row.role, artifact_path: row.path, revision: row.revision }));
  const fingerprints = { ...oldRun.current_fingerprints, permission: fingerprint({ authorization_id: approval.authorization_id, bindings }),
    // Source-evidence acquisition remains bound to its original authority, as in
    // r2. New adoption permission is separate; actual content uses the new runtime
    // authorization and shared budget, never this historical acquisition field.
    authorization: derived.schema_version === 'phase21-scientific-input-source-evidence-1.0' ? oldRun.current_fingerprints.authorization : sha(proposalBytes),
    parent_revision: fingerprint({ prior: oldRun.current_fingerprints, sourceDelta: sourceDelta ?? null }) };
  const required = oldRun.chain.required_artifacts.map(row => {
    const entry = byId.get(row.artifact_id); if (!entry) fail('P221_REQUIRED_ADOPTION_MISSING');
    return { artifact_id: row.artifact_id, owner_actor_id: actor, path: entry.path };
  });
  const config = { control_actor_id: actor, artifact_root: root, authorized_bindings: bindings,
    run_controls: [{ run_id: oldRun.run_id, approved_fingerprints: fingerprints, required_artifacts: required,
      integration_prerequisites: oldRun.chain.integration_prerequisites,
      p221_source_only_adoption: { authorization_id: approval.authorization_id, proposal_sha256: sha(proposalBytes), original_source_seal_retained: true, new_role_execution: false } }] };
  const broker = createOwnedArtifactBroker(config), receipts = [], adoption = [];
  const commit = async (entry, bytes) => broker.artifactStore.commitOwnedArtifact({ artifactRoot: root, dispatchContext: broker.dispatchContext,
    capability: broker.issueCapability({ runId: oldRun.run_id, actorId: actor, role: entry.role, artifactPath: entry.path, revision: entry.revision }),
    expectedRevision: entry.revision, artifact: { artifact_id: entry.artifact_id, content: bytes } });
  for (const entry of entries.filter(row => row.artifact_id !== spec.producer_artifact_id)) {
    let bytes, originalBinding = null;
    if (entry.artifact_id === spec.scientific_input_artifact_id) bytes = changedSource ? Buffer.from(JSON.stringify(derived))
      : (await prior.artifactResolver(oldControl.scientific_input_artifact_id)).bytes;
    else {
      const originalRow = await prior.artifactResolver(entry.source_artifact_id ?? entry.artifact_id);
      if (!originalRow?.receipt || sha(originalRow.bytes) !== originalRow.receipt.sha256) fail('P221_OLD_ARTIFACT_CHANGED');
      if (entry.role !== originalRow.receipt.role || !changedSource && derived.schema_version === 'phase21-scientific-input-source-evidence-1.0'
        && entry.revision !== originalRow.receipt.revision) fail('P221_ORIGINAL_RECEIPT_BINDING_CHANGED');
      originalBinding = { path: resolve(oldControl.artifactRoot, originalRow.receipt.path), sha256: originalRow.receipt.sha256 };
      const content = decode(originalRow.bytes);
      if (changedSource && content.scientific_input_fingerprint === original.input_fingerprint) {
        const adopted = await adoptReaderSourceOnlyDelta({ original, derived, artifact: content, sourceBinding: originalBinding, sourceDelta });
        bytes = Buffer.from(JSON.stringify(adopted));
      } else bytes = originalRow.bytes;
    }
    const receipt = await commit(entry, bytes); receipts.push(receipt);
    adoption.push({ artifact_id: entry.artifact_id, original: originalBinding, current_receipt: receipt, new_role_execution: false });
  }
  const chain = structuredClone(oldRun.chain);
  chain.delivery_status = 'pending_resolver'; chain.required_artifacts = required;
  chain.dependencies = chain.dependencies.map(row => ({ ...row, fingerprints, status: 'current' }));
  chain.artifacts = chain.artifacts.map(row => {
    const receipt = receipts.find(item => item.artifact_id === row.artifact_id); if (!receipt) fail('P221_CHAIN_ADOPTION_MISSING');
    return { ...row, path: receipt.path, owner_actor_id: receipt.owner_actor_id, revision: receipt.revision, sha256: receipt.sha256, receipt_sha256: receipt.sha256, status: 'current' };
  });
  const { phase21Validator: ignored, ...plainRun } = oldRun;
  let run = { ...structuredClone(plainRun), artifact_root: root, declared_fingerprints: fingerprints, current_fingerprints: fingerprints, receipts, chain, phase21Validator, delivery_requested: true };
  run = await advanceRun({ run, dispatchContext: broker.dispatchContext, artifactStore: broker,
    action: { type: 'compare', actor_id: actor, role: 'control', artifact_path: producerEntry.path, revision: producerEntry.revision } });
  if (!run.delivery_gate?.ok || run.chain.delivery_status !== 'deliverable') fail('P221_ADOPTION_CHAIN_INVALID', { gate: run.delivery_gate });
  const sourceReceipt = receipts.find(row => row.artifact_id === spec.source_check_artifact_id);
  if (!sourceReceipt) fail('P221_SOURCE_CHECK_REQUIRED');
  const sourceCheck = { ...decode((await readOwnedArtifact({ artifactRoot: root, artifactId: sourceReceipt.artifact_id })).bytes), artifact_sha256: sourceReceipt.sha256 };
  const conflicts = (prior.handoff.important_disagreements ?? []).map(row => ({ ...row, kind: 'scientific_disagreement', important: true }));
  const build = derived.schema_version === 'phase21-scientific-input-source-evidence-1.0' ? buildSourceEvidencePreRenderHandoff : buildPreRenderHandoff;
  const handoff = await build({ run, dispatchContext: broker.dispatchContext, artifactRoot: root, phase21Validator, scientificInput: derived, sourceCheck, proofChain: run.chain, conflicts });
  const producerReceipt = await commit(producerEntry, Buffer.from(JSON.stringify(handoff))); receipts.push(producerReceipt); run.receipts = receipts;
  const currentControl = { run, dispatchContext: broker.dispatchContext, proofChain: run.chain, artifactRoot: root,
    producer_artifact_id: spec.producer_artifact_id, scientific_input_artifact_id: spec.scientific_input_artifact_id, registry: Object.fromEntries(receipts.map(row => [row.artifact_id, row])) };
  const artifactResolver = artifactId => readOwnedArtifact({ artifactRoot: root, artifactId });
  const consumed = await consumePhase21Handoff({ handoff, currentControl, artifactResolver, phase21Validator, phase22Validator });
  if (!consumed.ok) fail('P221_ADOPTION_CONSUMER_REJECTED', { errors: consumed.errors });
  return { ...consumed, handoff, currentControl, artifactResolver, broker, controlConfig: config, run, adoption,
    original_source_seal_retained: true, new_role_execution: false, scientific_acceptance: 'not_run' };
}
function proposalProfile(proposal) {
  if (proposal?.schema_version === 'phase221-single-reader-source-supplement-proposal-1.0') return { single: true, reuse: true, sourceSupplement: true, samples: ['07'], stages: ['en', 'zh_cn', 'parity', 'quantity', 'post_render'] };
  if (proposal?.schema_version === 'phase221-single-reader-reuse-proposal-1.0') return { single: true, reuse: true, samples: ['07'], stages: ['en', 'zh_cn', 'parity', 'quantity', 'post_render'] };
  if (proposal?.schema_version === 'phase221-reader-proposal-1.0') return { single: false, samples: ['01', '05'], stages: ['integration', 'en', 'zh_cn', 'parity', 'quantity', 'post_render'] };
  return null;
}
function scopeValid(proposal, profile) {
  return profile && (!(profile.single || proposal.scope !== undefined) || same(proposal.scope?.samples, profile.samples))
    && same(proposal.papers?.map(row => row.sample).sort(), profile.samples)
    && (proposal.roles ?? []).every(task => profile.samples.includes(task.sample));
}
function newReuseWindow(proposal) {
  return proposalProfile(proposal)?.reuse && proposal.budget?.status === 'proposed_not_started';
}
function sourceSupplementValid(proposal) {
  const policy = proposal.reuse_policy;
  return policy?.mode === 'reuse_completed_analysis_with_source_supplement' && policy.new_source_blocks === true
    && ['source_first', 'source_reread', 'old_scientific_roles_rerun'].every(key => policy[key] === false)
    && ['source_adoptions', 'source_adoption_assembly'].every(key => Array.isArray(proposal[key]) && proposal[key].length > 0
    && proposal[key].every(row => row.sample === '07'));
}
function budgetValid(budget, profile) {
  return budget && (!profile?.sourceSupplement || budget.status === 'proposed_not_started' && budget.min_calls === 5
    && budget.expected_calls === 5 && budget.repair_calls === 5 && budget.max_calls === 10 && budget.max_minutes === 180)
    && ['min_calls', 'expected_calls', 'max_calls', 'repair_calls', 'max_minutes'].every(key => Number.isInteger(budget[key]) && budget[key] >= 0)
    && budget.min_calls > 0 && budget.max_minutes > 0 && budget.min_calls <= budget.expected_calls
    && budget.expected_calls <= budget.max_calls && budget.expected_calls + budget.repair_calls + (profile?.reuse ? budget.prior_calls : 0) === budget.max_calls
    && (profile?.reuse && budget.status !== 'proposed_not_started' ? budget.status === 'active' && Number.isInteger(budget.prior_calls) && budget.prior_calls > 0
      && Number.isFinite(Date.parse(budget.started_at)) && Date.parse(budget.deadline) === Date.parse(budget.started_at) + budget.max_minutes * 60000
      : budget.status === 'proposed_not_started' && budget.started_at === null && budget.deadline === null && (!profile?.reuse || budget.prior_calls === 0))
    && budget.deadline_rule === `first_content_call_started_at + ${budget.max_minutes} minutes; shared by ${profile?.single ? 'the declared package' : 'both papers'}; never reset`;
}

const stageRoles = { en: 'english-writer', zh_cn: 'chinese-writer', parity: 'bilingual-verifier', post_render: 'bilingual-verifier', quantity: 'integration', mapping: 'integration', integration: 'integration' };
const rolePolicy = proposal => proposal.approval?.role_model_policy;
function readerProfile(proposal) {
  const policy = rolePolicy(proposal);
  if (policy === undefined) return { model: 'gpt-6.1-sol', reasoning_effort: 'medium' };
  if (!validateApaRoleModelPolicy(policy)) fail('P221_MODEL_INVALID');
  return resolveApaRoleModel('english-writer', policy.main_session);
}
function taskModelValid(proposal, task) {
  const policy = rolePolicy(proposal);
  if (policy === undefined) return task.model === 'gpt-6.1-sol' && task.reasoning_effort === 'medium' && task.fork_turns === 'none';
  try {
    if (!validateApaRoleModelPolicy(policy) || !stageRoles[task.stage] || task.role !== stageRoles[task.stage]) return false;
    const expected = resolveApaRoleModel(task.stage === 'post_render' ? 'post-render-verifier' : ['quantity', 'mapping'].includes(task.stage) ? task.stage : task.role, policy.main_session);
    return task.model === expected.model && task.reasoning_effort === expected.reasoning_effort && task.fork_turns === 'none';
  } catch { return false; }
}
function proposalAuthorizationValid(proposal, proposalSha256, approval) {
  let profile;
  try { profile = readerProfile(proposal); } catch { return false; }
  if (rolePolicy(proposal) !== undefined && (!same(approval?.role_model_policy, rolePolicy(proposal))
    || approval?.requested_model !== profile.model || approval?.requested_reasoning_effort !== profile.reasoning_effort)) return false;
  if (!proposalProfile(proposal)?.reuse) return approval?.explicit_user_approval === true && approval.proposal_sha256 === proposalSha256;
  return (!newReuseWindow(proposal) || approval?.explicit_new_budget === true)
    && scopeValid(proposal, proposalProfile(proposal)) && approval?.explicit_user_instruction === true && approval.bound_proposal_sha256 === proposalSha256
    && nonblank(approval.authorization_id) && approval.package_id === proposal.package_id && approval.selected_sample === '07'
    && approval.source_inputs_sha256 === proposal.source_inputs?.sha256
    && approval.requested_model === profile.model && approval.requested_reasoning_effort === profile.reasoning_effort
    && nonblank(proposal.evidence_root) && approval.evidence_root === proposal.evidence_root
    && nonblank(proposal.delivery_root) && approval.delivery_root === proposal.delivery_root
    && approval.max_calls === proposal.budget.max_calls && approval.max_minutes === proposal.budget.max_minutes;
}

async function verifyPriorConsumption(proposal) {
  const prior = proposal.prior_consumption, run = json(await boundBytes(prior.run));
  if (newReuseWindow(proposal)) {
    const supplement = proposalProfile(proposal)?.sourceSupplement;
    if (prior.disposition !== 'historical_results_adopted_no_budget_credit'
      || (supplement ? !Number.isInteger(prior.calls_used) || prior.calls_used <= 0 || !Number.isInteger(run.max_calls)
        || run.calls_used !== run.max_calls || !Array.isArray(run.calls) || run.calls.some(call => !['completed', 'failed', 'cancelled'].includes(call.status)) : prior.calls_used !== 2)
      || run.calls_used !== prior.calls_used
      || run.sample !== '07' || !nonblank(run.package_id) || run.package_id === proposal.package_id
      || prior.deadline !== run.deadline || !Number.isFinite(Date.parse(run.started_at))
      || !Number.isInteger(run.max_minutes) || run.max_minutes <= 0
      || Date.parse(run.deadline) !== Date.parse(run.started_at) + run.max_minutes * 60000) fail('P221_PRIOR_CONSUMPTION_INVALID');
    return 0;
  }
  if (prior.disposition !== 'discarded_not_adopted' || !Number.isInteger(prior.calls_used) || prior.calls_used !== proposal.budget.prior_calls || prior.calls_used !== run.calls_used
    || run.sample !== '07' || !nonblank(run.package_id) || run.package_id === proposal.package_id
    || run.started_at !== proposal.budget.started_at || run.deadline !== proposal.budget.deadline
    || run.max_calls !== proposal.budget.max_calls || run.max_minutes !== proposal.budget.max_minutes) fail('P221_PRIOR_CONSUMPTION_INVALID');
  return prior.calls_used;
}

/** Preparation verifies physical evidence only. No role dispatch, source parsing or asset derivation. */
export async function checkReaderProposal({ proposal } = {}) {
  const errors = [], add = (code, details) => errors.push({ code, ...(details ? { details } : {}) });
  const profile = proposalProfile(proposal);
  if (!profile) return { ready: false, dispatch_authorized: false, errors: [{ code: 'P221_PROPOSAL_REQUIRED' }] };
  if (proposal.presentation_requirements !== undefined && !same(proposal.presentation_requirements,
    { research_map: { required: true, allowed_layouts: ['staged', 'swimlane'] }, shared_explanations: { required: true, mode: 'create_candidate' }, audit_display: 'compact', mapping_source: 'owned_integration' })) add('P221_PRESENTATION_REQUIREMENTS_INVALID');
  try { readerProfile(proposal); } catch { add('P221_MODEL_INVALID'); }
  if (proposal.prerequisite?.plan07 !== 'complete') add('P221_PLAN07_PENDING');
  if (proposal.prior_budget?.eligible_for_reuse !== false) add('P221_OLD_BUDGET_NOT_REUSABLE');
  if (!budgetValid(proposal.budget, profile)) add('P221_BUDGET_INVALID');
  if (proposal.dispatch_authorized !== false || proposal.status !== (profile.reuse && !newReuseWindow(proposal) ? 'prepared_for_authorized_continuation' : 'prepared_not_authorized')) add('P221_PREPARATION_NOT_AUTHORITY');
  if (!proposal.bindings?.length || !proposal.current_tools?.length) add('P221_BINDINGS_REQUIRED');
  for (const binding of [...proposal.bindings ?? [], ...proposal.current_tools ?? []]) {
    try { await boundBytes(binding); } catch (error) { add(error.code ?? 'P221_BINDING_UNREADABLE', { path: binding.path }); }
  }
  let actualContentCalls = 0;
  if (profile.reuse) {
    const policy = proposal.reuse_policy ?? proposal.source_scope;
    if (policy?.mode !== (profile.sourceSupplement ? 'reuse_completed_analysis_with_source_supplement' : 'reuse_completed_analysis')
      || ['source_first', 'source_reread', 'old_scientific_roles_rerun'].some(key => policy[key] !== false)
      || policy.new_source_blocks !== Boolean(profile.sourceSupplement)) add('P221_REUSE_POLICY_REQUIRED');
    if (profile.sourceSupplement && !sourceSupplementValid(proposal)) add('P221_SOURCE_ADOPTION_REQUIRED');
    try {
      if (!proposal.bindings?.some(row => row.path === proposal.source_inputs?.path && row.sha256 === proposal.source_inputs?.sha256)) fail('P221_SOURCE_INPUTS_UNBOUND');
      await boundBytes(proposal.source_inputs);
      actualContentCalls = await verifyPriorConsumption(proposal);
    } catch (error) { add(error.code ?? 'P221_PRIOR_CONSUMPTION_INVALID'); }
    if ((proposal.roles ?? []).some(task => !(newReuseWindow(proposal) ? profile.stages : [...profile.stages, 'mapping']).includes(task.stage))) add('P221_REUSE_SCIENTIFIC_RERUN_FORBIDDEN');
  }
  const outputPaths = proposal.owned_artifact_paths ?? [];
  if (new Set(outputPaths).size !== outputPaths.length) add('P221_ROLE_PATH_INVALID');
  const rolePaths = (proposal.roles ?? []).flatMap(task => [task.request_path, task.native_path, task.owned_path]);
  if (new Set(rolePaths).size !== rolePaths.length) add('P221_ROLE_PATH_INVALID');
  const mandatory = (proposal.roles ?? []).filter(task => task.optional === false), optional = (proposal.roles ?? []).filter(task => task.optional === true);
  const selection = proposal.repair_selection;
  const selectiveRepair = selection && typeof selection === 'object' && !Array.isArray(selection) && profile.reuse && proposal.budget?.status === 'active'
    && same(Object.keys(selection).sort(), ['available_tasks', 'max_calls']) && selection.available_tasks === 5 && selection.max_calls === 4
    && proposal.budget.prior_calls === 1 && proposal.budget.min_calls === 5 && proposal.budget.expected_calls === 5
    && proposal.budget.repair_calls === 4 && proposal.budget.max_calls === 10 && optional.length === 5
    && profile.samples.every(sample => profile.stages.every(stage => optional.filter(task => task.sample === sample && task.stage === stage).length === 1));
  if (selection !== undefined && !selectiveRepair) add('P221_REPAIR_SELECTION_INVALID');
  const repairCapacity = selectiveRepair ? selection.max_calls : optional.length;
  if (mandatory.length !== proposal.budget?.expected_calls || mandatory.length !== proposal.budget?.min_calls
    || repairCapacity !== proposal.budget?.repair_calls || mandatory.length + repairCapacity + (profile.reuse ? proposal.budget?.prior_calls : 0) !== proposal.budget?.max_calls
    || profile.samples.some(sample => profile.stages.some(stage => mandatory.filter(task => task.sample === sample && task.stage === stage).length !== 1))) add('P221_ROLE_BUDGET_UNBOUND');
  for (const task of proposal.roles ?? []) {
    if (!taskModelValid(proposal, task)) add('P221_MODEL_INVALID');
    for (const key of ['request_path', 'native_path', 'owned_path']) if (!nonblank(task[key]) || !outputPaths.includes(task[key]) || task[key].includes('..')) add('P221_ROLE_PATH_INVALID', { task_id: task.task_id, key });
  }
  if (!proposal.roles?.length || !scopeValid(proposal, profile)) add('P221_SCOPE_INVALID');
  if (proposal.evidence_mode === 'actual' && proposal.integrator_capability?.status !== 'executable') add('P221_INTEGRATOR_ROUTE_UNRESOLVED');
  for (const paper of proposal.papers ?? []) {
    if (proposal.evidence_mode === 'actual') {
      if (!nonblank(proposal.delivery_root) || paper.candidate_output_root !== (profile.single ? join(resolve(proposal.delivery_root), 'candidate-vault') : join(resolve(proposal.delivery_root), paper.sample, 'candidate-vault'))
        || !Array.isArray(paper.final_payload_targets) || !paper.final_payload_targets.length) add('P221_OUTPUT_ROOT_REQUIRED', { sample: paper.sample });
      if (profile.single) {
        if (!nonblank(proposal.evidence_root) || paper.candidate_registration?.vaultRoot !== join(resolve(proposal.evidence_root), 'draft-vault')) add('P221_OUTPUT_ROOT_REQUIRED', { sample: paper.sample });
      }
      try {
        const anchor = await readReaderTrustAnchor(paper.candidate_trust_anchor);
        if (anchor.vault_root !== resolve(paper.candidate_registration.vaultRoot) || anchor.run_id !== paper.candidate_registration.run) add('P221_TRUST_ANCHOR_SCOPE_CHANGED');
      } catch (error) { add(error.code ?? 'P221_TRUST_ANCHOR_REQUIRED', { sample: paper.sample }); }
    }
    const repairs = paper.repairs ?? [];
    for (const id of ids('SR-', 16)) {
      const rows = repairs.filter(row => row.id === id);
      if (rows.length !== 1 || !nonblank(rows[0].owner) || !nonblank(rows[0].reason) || !LANGUAGES.every(language => Array.isArray(rows[0].locations?.[language]))) add('P221_REPAIR_UNRESOLVED', { sample: paper.sample, id });
    }
    for (const visual of paper.visuals ?? []) if (visual.required && !['existing_registered_image', 'proposed_same_source_registration', 'proposed_native_table_grid'].includes(visual.readiness)) add('P221_VISUAL_NOT_READY', { sample: paper.sample, id: visual.id });
    if (!['source_structured', 'analyst_summary'].includes(paper.abstract?.decision)) add('P221_ABSTRACT_UNRESOLVED', { sample: paper.sample });
  }
  for (const blocker of proposal.blockers ?? []) if (blocker.status !== 'resolved') add(blocker.code, { reason: blocker.reason, owner: blocker.owner });
  return { ready: errors.length === 0, dispatch_authorized: false, actual_content_calls: actualContentCalls,
    ...(profile.reuse ? { calls_evidence: newReuseWindow(proposal) ? 'historical_snapshot_not_current_calls' : 'prior_consumption_snapshot_only',
      ...(newReuseWindow(proposal) ? { historical_consumed_calls: proposal.prior_consumption?.calls_used } : {}) } : {}), errors };
}

/** Approval must be supplied from the Controller's exact user-authorization record. */
export function checkReaderAuthorization({ proposal, proposalSha256, approval, run, now = Date.now() } = {}) {
  const reject = code => ({ ok: false, code });
  const profile = proposalProfile(proposal);
  if (!scopeValid(proposal, profile)) return reject('P221_SCOPE_INVALID');
  if (profile.sourceSupplement && !sourceSupplementValid(proposal)) return reject('P221_SOURCE_ADOPTION_REQUIRED');
  if (!budgetValid(proposal?.budget, profile) || !proposalAuthorizationValid(proposal, proposalSha256, approval)
    || approval.max_calls !== proposal.budget.max_calls || approval.max_minutes !== proposal.budget.max_minutes) return reject('P221_NEW_AUTHORIZATION_REQUIRED');
  const start = Date.parse(run?.started_at), deadline = Date.parse(run?.deadline);
  if ((profile.reuse ? run?.bound_proposal_sha256 !== proposalSha256 || run.package_id !== proposal.package_id || run.sample !== '07'
    || run.authorization_id !== approval.authorization_id || run.source_inputs_sha256 !== proposal.source_inputs.sha256
    || !same(run.prior_consumption, proposal.prior_consumption)
    || (newReuseWindow(proposal) ? !Number.isFinite(Date.parse(proposal.prior_consumption?.deadline)) || start <= Date.parse(proposal.prior_consumption.deadline)
      : run.started_at !== proposal.budget.started_at || run.deadline !== proposal.budget.deadline)
    || run.max_calls !== proposal.budget.max_calls || run.max_minutes !== proposal.budget.max_minutes || run.calls_used < proposal.budget.prior_calls
    : run?.proposal_sha256 !== proposalSha256) || !Number.isFinite(start) || !Number.isFinite(deadline)
    || deadline !== start + proposal.budget.max_minutes * 60000 || start > now) return reject('P221_DEADLINE_INVALID');
  if (now >= deadline) return reject('P221_BUDGET_EXPIRED');
  if (!Number.isInteger(run.calls_used) || run.calls_used < 0 || run.calls_used > proposal.budget.max_calls) return reject('P221_CALL_LIMIT_EXCEEDED');
  return { ok: true, deadline: run.deadline, remaining_calls: proposal.budget.max_calls - run.calls_used };
}

export async function prepareReaderAcceptance({ proposal, recordPath, evidenceRoot, controllerTrustAnchors } = {}) {
  const path = inside(evidenceRoot, recordPath);
  if (controllerTrustAnchors) {
    const bytes = Buffer.from(JSON.stringify(controllerTrustAnchors, null, 2) + '\n');
    for (const paper of proposal.papers) {
      const binding = paper.candidate_trust_anchor, anchor = controllerTrustAnchors[binding.array_index];
      if (!anchor || binding.sha256 !== sha(bytes) || sha(Buffer.from(anchor.public_key, 'base64')) !== binding.expected_key_fingerprint
        || anchor.vault_root !== resolve(paper.candidate_registration.vaultRoot) || anchor.run_id !== paper.candidate_registration.run) fail('P221_TRUST_ANCHOR_SCOPE_CHANGED');
      createPublicKey({ key: Buffer.from(anchor.public_key, 'base64'), type: 'spki', format: 'der' });
    }
    await mkdir(resolve(evidenceRoot), { recursive: true });
    await writeFile(inside(evidenceRoot, proposal.controller_session.public_anchor_file), bytes, { flag: 'wx' });
  }
  const readiness = await checkReaderProposal({ proposal });
  const value = { ...proposal, readiness };
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, { flag: 'wx' });
  return { ...readiness, proposal_path: path, proposal_sha256: sha(bytes) };
}

export async function readReaderTrustAnchor(binding) {
  const values = json(await boundBytes(binding));
  const anchor = binding.array_index === undefined ? values : values[binding.array_index];
  if (!anchor || typeof anchor.public_key !== 'string') fail('P221_TRUST_ANCHOR_CHANGED');
  const der = Buffer.from(anchor.public_key, 'base64');
  if (der.toString('base64') !== anchor.public_key || sha(der) !== binding.expected_key_fingerprint) fail('P221_TRUST_ANCHOR_CHANGED');
  createPublicKey({ key: der, type: 'spki', format: 'der' });
  return anchor;
}

export async function inspectRegisteredReaderEvidence({ registration, trustAnchorBinding } = {}) {
  const trustAnchor = await readReaderTrustAnchor(trustAnchorBinding);
  const pointerPath = inside(registration.vaultRoot, '.apa-v3/phase22/runs/' + registration.run + '/CURRENT.json');
  const pointerBytes = await bytesAt(pointerPath), pointer = json(pointerBytes);
  const bundleBytes = await bytesAt(inside(registration.vaultRoot, pointer.bundle.path));
  if (sha(bundleBytes) !== pointer.bundle.sha256) fail('P221_REGISTERED_BYTES_CHANGED');
  const loaded = await loadBilingualPublication({ ...registration, trustAnchor });
  if (sha(await bytesAt(pointerPath)) !== sha(pointerBytes)) fail('P221_REGISTERED_BYTES_CHANGED');
  if (loaded.reviewManifest.profile !== 'phase22-reader-note-1.0') fail('P221_READER_PROFILE_REQUIRED');
  const bundle = json(bundleBytes);
  if (!same(bundle.reviewManifest, loaded.reviewManifest)) fail('P221_REGISTERED_BYTES_CHANGED');
  const evidence = bundle.schema_version === 'phase22-registered-publication-2.0' ? bundle.reader_evidence : {
    runtimeBinding: bundle.reader_recipe?.runtime?.binding, renderer: bundle.reader_recipe?.renderer,
    presentationPlanProof: bundle.reader_recipe?.presentationPlanProof,
  };
  if (!evidence?.runtimeBinding || !evidence.renderer) fail('P221_REGISTERED_READER_EVIDENCE_REQUIRED');
  return { ...loaded, runtimeBinding: evidence.runtimeBinding, runtimeCheckpoint: bundle.control_snapshot.runtime,
    renderer: evidence.renderer, presentationPlanProof: evidence.presentationPlanProof };
}

/** New presentation requirements require the exact owned Integrator return that
 * the sealed call ledger validates; Controller-authored options are insufficient. */
export async function verifyReaderPresentationBinding({ proposal, renderer, presentationPlanProof, externalRoles = [] } = {}) {
  if (proposal.presentation_requirements === undefined) return true;
  const required = { research_map: { required: true, allowed_layouts: ['staged', 'swimlane'] }, shared_explanations: { required: true, mode: 'create_candidate' }, audit_display: 'compact', mapping_source: 'owned_integration' };
  if (!same(proposal.presentation_requirements, required)) fail('P221_PRESENTATION_REQUIREMENTS_INVALID');
  const proof = presentationPlanProof, task = proposal.roles.find(row => row.stage === 'quantity' && row.external_evidence?.artifact_id === proof?.artifactId);
  if (!task || proof.artifactRoot !== task.external_evidence.artifact_root || !externalRoles.some(row => row.task_id === task.task_id)) fail('P221_PRESENTATION_OWNED_MAPPING_REQUIRED');
  const owned = await readOwnedArtifact({ artifactRoot: proof.artifactRoot, artifactId: proof.artifactId });
  if (!owned || owned.receipt.role !== 'integration' || owned.receipt.owner_actor_id !== task.owner_actor_id || owned.receipt.sha256 !== proof.sha256) fail('P221_PRESENTATION_OWNED_MAPPING_REQUIRED');
  const raw = json(owned.bytes), input = json(await boundBytes(json(await bytesAt(inside(proof.artifactRoot, task.request_path))).input));
  if (!same(input.presentation_requirements, required) || !same(raw.presentation_dependencies, input.presentation_dependencies)
    || !same(input.presentation_dependencies, { context: fingerprint(input.context), target_registry: fingerprint(input.target_registry), requirements: fingerprint(required) })
    || input.dependencies.context !== input.context?.context_fingerprint || !same(renderer.targetRegistry, input.target_registry)) fail('P221_PRESENTATION_MAPPING_DEPENDENCY_CHANGED');
  const plan = raw.presentation_plan, options = renderer.presentationOptions;
  if (!plan || !required.research_map.allowed_layouts.includes(plan.researchMap?.layout) || plan.auditDisplay !== 'compact' || !Array.isArray(plan.sharedExplanations)
    || !same(plan, { researchMap: options?.researchMap, sharedExplanations: options?.sharedExplanations, auditDisplay: options?.auditDisplay })) fail('P221_PRESENTATION_MAPPING_CHANGED');
  return true;
}

/** Verify every final candidate payload, including assets and shared support.
 * History/commit are transaction internals, not delivered candidate files. */
export async function verifyReaderDeliverables({ plan, outputs, ownedPaths, evidenceRoot, outputRoot, fixedTargets = [], contentAddressedTargets = [] } = {}) {
  if (!Array.isArray(outputs) || new Set(outputs.map(row => row.path)).size !== outputs.length
    || !outputRoot && new Set(outputs.map(row => row.saved_path)).size !== outputs.length) fail('P221_COMPLETE_OUTPUT_REQUIRED');
  const required = [...new Map([...plan.inventory.filter(item => !['history', 'commit'].includes(item.kind)),
    ...(plan.read_dependencies ?? []).map(row => ({ ...row, kind: row.kind ?? 'support' }))].map(row => [row.path, row])).values()];
  for (const output of required) {
    const reference = outputs.find(item => item.path === output.path);
    if (!reference || reference.sha256 !== output.byte_sha256) fail('P221_COMPLETE_OUTPUT_REQUIRED', { path: output.path, kind: output.kind });
    let target;
    if (outputRoot) {
      if (reference.saved_path !== undefined && reference.saved_path !== output.path || !fixedTargets.includes(output.path)
        && !(output.kind === 'reading-review' && contentAddressedTargets.includes(output.path)
          && /^\.apa-v3\/phase221\/reading-review\/[0-9a-f]{64}\.json$/.test(output.path))) fail('P221_OUTPUT_PATH_NOT_APPROVED', { path: output.path });
      target = inside(outputRoot, output.path);
    } else {
      if (!ownedPaths.includes(reference.saved_path)) fail('P221_COMPLETE_OUTPUT_REQUIRED', { path: output.path, kind: output.kind });
      target = inside(evidenceRoot, reference.saved_path);
    }
    if (sha(await bytesAt(target)) !== output.byte_sha256) fail('P221_FINAL_OUTPUT_CHANGED', { path: output.path, kind: output.kind });
  }
  return { checked_files: required.length, excluded_kinds: ['history', 'commit'] };
}

/** Mapping and quantity Integrators use the same owned request/host/return seal.
 * Their calls are outside the language checkpoint, but share its original cap. */
export async function verifyReaderCallLedger({ proposal, externalRoles = [], languageTasks = [], authorization, run } = {}) {
  const tasks = [...languageTasks];
  if (!Array.isArray(externalRoles) || languageTasks.some(task => !['en', 'zh_cn', 'parity', 'post_render'].includes(proposal.roles.find(row => row.task_id === task.task_id)?.stage))) fail('P221_EXTERNAL_ROLE_EVIDENCE_REQUIRED');
  for (const row of externalRoles) {
    const task = proposal.roles.find(item => item.task_id === row.task_id), spec = task?.external_evidence;
    if (!spec || !(newReuseWindow(proposal) ? ['quantity'] : ['mapping', 'quantity']).includes(task.stage) || task.sample !== '07' || task.role !== 'integration'
      || spec.artifact_root !== join(resolve(proposal.evidence_root), 'controller')) fail('P221_EXTERNAL_ROLE_UNBOUND');
    const control = {};
    for (const kind of ['request', 'packet', 'step', 'host', 'seal']) {
      const path = kind === 'request' ? task.request_path : spec[kind + '_path'];
      if (!nonblank(path) || row[kind]?.path !== inside(spec.artifact_root, path)) fail('P221_EXTERNAL_ROLE_UNBOUND');
      const bytes = await boundBytes(row[kind]);
      const owned = await readOwnedArtifact({ artifactRoot: spec.artifact_root, artifactId: spec[kind + '_artifact_id'] });
      if (!owned || owned.receipt.path !== path || owned.receipt.sha256 !== sha(bytes) || owned.receipt.role !== 'control'
        || owned.receipt.owner_actor_id !== spec.control_actor_id || owned.receipt.run_id !== spec.run_id || owned.receipt.revision !== spec.revision) fail('P221_EXTERNAL_ROLE_OWNERSHIP_INVALID');
      control[kind] = { bytes, value: json(bytes) };
    }
    const { request: { bytes: requestBytes, value: request }, packet: { value: packet }, step: { value: step }, host: { value: host }, seal: { value: seal } } = control;
    const owned = await readOwnedArtifact({ artifactRoot: spec.artifact_root, artifactId: spec.artifact_id });
    if (!owned || owned.receipt.path !== task.owned_path || owned.receipt.owner_actor_id !== spec.owner_actor_id || owned.receipt.role !== task.role
      || owned.receipt.run_id !== spec.run_id || owned.receipt.revision !== spec.revision
      || sha(await bytesAt(inside(spec.artifact_root, task.native_path))) !== owned.receipt.sha256) fail('P221_EXTERNAL_ROLE_OWNERSHIP_INVALID');
    const completion = seal.completion, args = host.tool_call?.arguments;
    if (proposal.presentation_requirements !== undefined) {
      const prompt = request.prompt_binding;
      if (!prompt || !same(prompt.sections, ['Common scientific contract', 'Integrator'])
        || prompt.path !== join(ROOT, 'prompts/v3/phase21-scientific-contracts.md')
        || !proposal.current_tools.some(row => row.path === prompt.path && row.sha256 === prompt.sha256)
        || !same(packet.backend.configuration.prompt_binding, prompt)) fail('P221_PRESENTATION_PROMPT_UNBOUND');
      const text = (await boundBytes(prompt)).toString('utf8').replaceAll('\r\n', '\n');
      for (const name of prompt.sections) {
        const section = text.split('## ' + name + '\n')[1]?.split('\n## ')[0]?.trim();
        if (!section || !args?.message?.includes('## ' + name + '\n' + section)) fail('P221_PRESENTATION_PROMPT_UNBOUND');
      }
    }
    if (request.package_id !== proposal.package_id || request.sample !== '07' || request.task_id !== task.task_id
      || request.artifact_id !== spec.artifact_id || request.owner_actor_id !== spec.owner_actor_id || request.role !== task.role || request.revision !== spec.revision
      || request.identity?.run_id !== spec.run_id || request.authorization_id !== authorization.authorization_id || request.evidence_mode !== 'actual'
      || request.shared_started_at !== run.started_at || request.deadline !== run.deadline || request.max_calls !== proposal.budget.max_calls
      || request.allowed_output?.native_path !== task.native_path || request.allowed_output?.owned_path !== task.owned_path
      || request.input?.path !== spec.input?.path || spec.input.sha256 !== undefined && request.input.sha256 !== spec.input.sha256
      || !nonblank(spec.scientific_input_fingerprint) || request.scientific_input_fingerprint !== spec.scientific_input_fingerprint
      || packet.source.path !== request.input.path || packet.source.sha256 !== request.input.sha256 || packet.run_id !== spec.run_id
      || packet.user_approval_id !== authorization.authorization_id || packet.allowed_output_root !== spec.artifact_root
      || packet.approved_budget_cap?.value !== proposal.budget.max_calls || packet.approved_budget_cap.unit !== 'tool_calls'
      || packet.backend.configuration.request_sha256 !== sha(requestBytes) || packet.backend.configuration.input_sha256 !== request.input.sha256
      || packet.host_action_scope.role !== task.role || packet.host_action_scope.output_path !== inside(spec.artifact_root, task.native_path)
      || args?.task_name !== request.task_name || args.model !== task.model || args.reasoning_effort !== task.reasoning_effort || args.fork_turns !== task.fork_turns
      || seal.schema_version !== `phase221-reuse-${task.stage}-seal-1.0` || seal.package_id !== proposal.package_id || seal.task_id !== task.task_id || seal.request_sha256 !== sha(requestBytes)
      || seal.input_sha256 !== request.input.sha256 || seal.raw_return_sha256 !== owned.receipt.sha256 || !same(seal.hostObservation, host)
      || completion?.agent_id !== host.agent_id || completion.task_id !== task.task_id || !nonblank(completion.call_id) || !nonblank(completion.return_id)
      || !Number.isFinite(Date.parse(host.observed_at)) || Date.parse(host.observed_at) < Date.parse(run.started_at)
      || !Number.isFinite(Date.parse(completion.completed_at)) || Date.parse(completion.completed_at) < Date.parse(host.observed_at)
      || Date.parse(completion.completed_at) > Date.parse(run.completed_at) || Date.parse(completion.completed_at) >= Date.parse(run.deadline)) fail('P221_EXTERNAL_ROLE_CALL_UNBOUND');
    await boundBytes(request.input);
    const input = await readOwnedArtifact({ artifactRoot: spec.artifact_root, artifactId: spec.input_artifact_id });
    if (!input || inside(spec.artifact_root, input.receipt.path) !== request.input.path || input.receipt.sha256 !== request.input.sha256
      || input.receipt.role !== 'control' || input.receipt.owner_actor_id !== spec.control_actor_id || input.receipt.run_id !== spec.run_id
      || input.receipt.revision !== spec.revision) fail('P221_EXTERNAL_ROLE_OWNERSHIP_INVALID');
    const replayed = ingestObservedRunStep({ packet, emittedStep: step, observation: host, run: { run_id: spec.run_id }, now: host.observed_at });
    if (replayed.status !== 'observed' || !same(replayed, host)) fail('P221_EXTERNAL_ROLE_HOST_INVALID');
    tasks.push({ task_id: task.task_id, call_id: completion.call_id, return_id: completion.return_id });
  }
  if (proposal.roles.some(task => task.optional === false && !tasks.some(row => row.task_id === task.task_id))
    || tasks.some(task => !proposal.roles.some(row => row.task_id === task.task_id))
    || ['task_id', 'call_id', 'return_id'].some(key => tasks.some(task => !nonblank(task[key])) || new Set(tasks.map(task => task[key])).size !== tasks.length)) fail('P221_AGGREGATE_CALL_LEDGER_INVALID');
  const prior = await verifyPriorConsumption(proposal);
  const actual = tasks.map(({ task_id, call_id, return_id }) => ({ task_id, call_id, return_id })).sort((a, b) => a.task_id.localeCompare(b.task_id));
  const declared = run.calls?.map(({ task_id, call_id, return_id }) => ({ task_id, call_id, return_id })).sort((a, b) => a.task_id.localeCompare(b.task_id));
  if (!same(actual, declared) || prior + tasks.length !== run.calls_used || run.calls_used > proposal.budget.max_calls) fail('P221_AGGREGATE_CALL_LEDGER_INVALID');
  return { calls_used: prior + tasks.length, prior_calls: prior, current_calls: tasks.length };
}

/** The frozen reader profile describes Writers and Verifiers; quantity/mapping
 * retain their independent role profiles in the proposal and call ledger. */
export function verifyReaderRuntimeBinding({ proposal, authorization, run, binding, checkpoint } = {}) {
  let profile;
  try { profile = readerProfile(proposal); } catch { fail('P221_RUNTIME_AUTHORIZATION_MISMATCH'); }
  const policy = rolePolicy(proposal);
  if (policy !== undefined && (!same(policy, binding?.role_model_policy) || !same(policy, authorization?.role_model_policy)
    || authorization.requested_model !== profile.model || authorization.requested_reasoning_effort !== profile.reasoning_effort)
    || binding?.requested_model !== profile.model || binding.requested_reasoning !== profile.reasoning_effort
    || binding.authorization_id !== authorization.authorization_id || checkpoint?.authorization_id !== authorization.authorization_id
    || checkpoint.deadline !== run.deadline || binding.deadline !== run.deadline
    || checkpoint.max_calls > proposal.budget.max_calls || checkpoint.calls_used > checkpoint.max_calls) fail('P221_RUNTIME_AUTHORIZATION_MISMATCH');
  return true;
}

/** Full signed reconstruction is mandatory; summary JSON cannot supply review authority. */
export async function checkReaderAcceptance({ recordPath, evidenceRoot, now = Date.now() } = {}) {
  try {
    const proposalPath = join(resolve(evidenceRoot), 'PROPOSAL.json'), proposalBytes = await bytesAt(proposalPath), proposal = json(proposalBytes);
    const readiness = await checkReaderProposal({ proposal });
    if (!readiness.ready) fail('P221_PROPOSAL_NOT_READY', { errors: readiness.errors });
    const record = json(await bytesAt(inside(evidenceRoot, recordPath)));
    if (record.proposal_sha256 !== sha(proposalBytes)) fail('P221_PROPOSAL_BINDING_CHANGED');
    // The proposal freezes the future Controller approval path. Its bytes cannot be
    // hashed in the proposal that the approval itself must name (a circular binding).
    const authorization = json(await bytesAt(inside(evidenceRoot, proposal.authorization_record.path)));
    const run = json(await boundBytes(record.run));
    const completed = Date.parse(run.completed_at);
    if (!Number.isFinite(completed) || completed > now) fail('P221_COMPLETED_RUN_REQUIRED');
    const authorized = checkReaderAuthorization({ proposal, proposalSha256: sha(proposalBytes), approval: authorization, run, now: completed });
    if (!authorized.ok) fail(authorized.code);
    const profile = proposalProfile(proposal);
    if (!same(record.papers?.map(row => row.sample).sort(), profile.samples)) fail('P221_READING_PAPERS_INCOMPLETE');
    const results = [], runtimeTasks = [], presentationBindings = [];
    for (const row of record.papers) {
      const expected = proposal.papers.find(paper => paper.sample === row.sample);
      if (!same(row.registration, expected.candidate_registration)) fail('P221_CANDIDATE_REGISTRATION_CHANGED');
      const loaded = await inspectRegisteredReaderEvidence({ registration: row.registration, trustAnchorBinding: expected.candidate_trust_anchor });
      const manifest = loaded.reviewManifest;
      if (manifest.profile !== 'phase22-reader-note-1.0' || manifest.evidence_mode !== 'actual') fail('P221_ACTUAL_READER_REQUIRED');
      const binding = loaded.runtimeBinding, checkpoint = loaded.runtimeCheckpoint;
      presentationBindings.push({ proposal, renderer: loaded.renderer, presentationPlanProof: loaded.presentationPlanProof, externalRoles: record.external_roles });
      verifyReaderRuntimeBinding({ proposal, authorization, run, binding, checkpoint });
      for (const task of checkpoint.tasks.filter(task => task.call_id)) {
        const expectedTask = proposal.roles.find(role => role.sample === row.sample && role.task_id === task.task_id);
        if (!expectedTask || !task.return_id || task.status !== 'completed' || Date.parse(task.completed_at) > Date.parse(run.deadline)) fail('P221_RUNTIME_TASK_UNBOUND');
        runtimeTasks.push(task);
      }
      const gates = manifest.reading_gates;
      if (gates?.completeness !== 'pass' || gates?.readability !== 'pass') fail('P221_READING_GATES_NOT_PASSED', { sample: row.sample, gates });
      // loadBilingualPublication has re-read the original owned raw review, complete prepared
      // pages and source payload, and rerun assessReaderReview; it rejects lost tails, missing
      // union records, stale source/tools, fabricated judgments and unowned returns.
      if (row.output_root !== undefined && row.output_root !== expected.candidate_output_root) fail('P221_OUTPUT_ROOT_CHANGED');
      await verifyReaderDeliverables({ plan: loaded.plan, outputs: row.outputs, outputRoot: expected.candidate_output_root,
        fixedTargets: expected.final_payload_targets, contentAddressedTargets: [manifest.reading_review.path] });
      results.push({ sample: row.sample, gates, content_reading_accepted: true, native_presentation: gates.native_presentation, phase_accepted: false });
    }
    if (profile.reuse) await verifyReaderCallLedger({ proposal, externalRoles: record.external_roles, languageTasks: runtimeTasks, authorization, run });
    for (const binding of presentationBindings) await verifyReaderPresentationBinding(binding);
    if (runtimeTasks.length > run.calls_used || runtimeTasks.length > proposal.budget.max_calls
      || new Set(runtimeTasks.map(task => task.call_id)).size !== runtimeTasks.length) fail('P221_AGGREGATE_CALL_LEDGER_INVALID');
    return { ok: true, content_reading_accepted: true, phase_accepted: false, papers: results };
  } catch (error) {
    return { ok: false, content_reading_accepted: false, phase_accepted: false, errors: [{ code: error.code ?? 'P221_READING_CHECK_FAILED', details: error.details ?? { message: error.message } }] };
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2), options = {};
  if (!['prepare', 'check-reading'].includes(command) || args.length % 2) fail('P221_ACCEPTANCE_ARGUMENT_INVALID');
  for (let i = 0; i < args.length; i += 2) {
    if (!['--record', '--evidence-root', '--proposal-input'].includes(args[i]) || options[args[i]]) fail('P221_ACCEPTANCE_ARGUMENT_INVALID');
    options[args[i]] = args[i + 1];
  }
  const evidenceRoot = resolve(ROOT, options['--evidence-root'] ?? ''), recordPath = resolve(ROOT, options['--record'] ?? '');
  if (!options['--record'] || !options['--evidence-root']) fail('P221_EXPLICIT_PATHS_REQUIRED');
  let result;
  if (command === 'prepare') {
    if (options['--proposal-input']) {
      const proposal = json(await bytesAt(resolve(ROOT, options['--proposal-input'])));
      result = await prepareReaderAcceptance({ proposal, recordPath, evidenceRoot });
    } else {
      // Persistent Controller creates the proposal and its public anchor first.
      // A fresh CLI may recheck it, but must never create a short-lived signing key.
      const bytes = await bytesAt(inside(evidenceRoot, recordPath));
      result = { ...await checkReaderProposal({ proposal: json(bytes) }), proposal_path: recordPath, proposal_sha256: sha(bytes) };
    }
    process.exitCode = result.ready ? 0 : 1;
  } else {
    result = await checkReaderAcceptance({ recordPath, evidenceRoot }); process.exitCode = result.ok ? 0 : 1;
  }
  process.stdout.write(JSON.stringify(result) + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  process.stdout.write(JSON.stringify({ ok: false, code: error.code ?? 'P221_ACCEPTANCE_FAILED', details: error.details ?? { message: error.message } }) + '\n'); process.exitCode = 2;
});
