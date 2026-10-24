/**
 * Phase-21 composition is a local, receipt-bound contract.  It deliberately
 * does not render a view, call a model/parser, or treat its offline checks as
 * host delivery or independent-review evidence.
 */
import { READING_FIRST_PROFILE, buildReadingFirstHandoff } from './reading-first-runtime.mjs';
import { createHash } from 'node:crypto';
import { DEFAULT_APA_MODEL } from '../apa-model-policy.mjs';
import { getRunControlForDispatch, readOwnedArtifact } from './owned-artifact-store.mjs';
import { validateProofChain } from './proof-chain-validator.mjs';
import { canonicalizeV3Json, fingerprintV3Json, validateV3Package } from './semantic-package-validator.mjs';
import { validateScientificPackage } from './scientific-quality-validator.mjs';
import { validateScientificInput } from './scientific-input-validator.mjs';
import { compareParserRuns } from './parser-comparison.mjs';
import { archiveSourceCheckBinding } from './archive-representation.mjs';
import {decodeWholePaperArtifact} from './whole-paper-storage.mjs';
import {evaluateScientificEvidenceQualification} from './whole-paper-scientific-validator.mjs';
import {resolveSourceEvidenceScientificInputReference,readSourceEvidenceScientificInputReference,verifySourceEvidenceReuseArtifacts} from './source-evidence-reuse.mjs';
import {isDeepStrictEqual as same} from 'node:util';
import {resolve} from 'node:path';

const ROLE_REQUIREMENTS = Object.freeze([
  ['evidence', 'evidence-map'],
  ['methods', 'methods-design'],
  ['results', 'results-visuals'],
  ['interpretation', 'interpretation-appraisal'],
  ['scientific-reading', 'scientific-reading-card'],
  ['integration', 'integration'],
]);
const DUTIES = Object.freeze(Array.from({ length: 16 }, (_, index) => `SR-${String(index + 1).padStart(2, '0')}`));
const RUN_FINGERPRINTS = Object.freeze(['source', 'parser_tool', 'permission', 'parent_revision', 'policy', 'authorization']);
const copy = value => structuredClone(value);
const fail = (code, details = {}) => Object.assign(new Error(code), { code, details });
const fingerprint = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const canonicalFingerprint = value => `sha256:${createHash('sha256').update(canonicalizeV3Json(value)).digest('hex')}`;
const PRE_RENDER_DEPENDENCIES = Object.freeze([
  'scientific_input', 'required_semantic_unit_manifest', 'run_control', 'source_check',
  'source_check_receipt', 'parser_comparison', ...ROLE_REQUIREMENTS.map(([role]) => `role:${role}`),
]);

function requireCompleteScientificInput(input) {
  const frozen = validateV3Package(input?.boundary_package);
  if (!frozen.ok) throw fail('FROZEN_V3_PACKAGE_INVALID', { errors: frozen.errors });
  const scientific = validateScientificPackage(input);
  if (!scientific.ok) throw fail('COMPLETE_SCIENTIFIC_INPUT_INVALID', { errors: scientific.errors });
  const obligations = new Set(input.scientific_details?.records?.map(record => record.obligation_id));
  if (DUTIES.some(duty => !obligations.has(duty))) throw fail('SCIENTIFIC_DUTY_MISSING');
  const bindings = input.bindings ?? {};
  if (!fingerprint(bindings.scientific_input_fingerprint) || !fingerprint(bindings.required_semantic_units_hash)) {
    throw fail('SCIENTIFIC_INPUT_BINDING_MISSING');
  }
  return Object.freeze({
    fingerprint: bindings.scientific_input_fingerprint,
    requiredManifestFingerprint: bindings.required_semantic_units_hash,
  });
}

function normalizeConflict(conflict, index) {
  const path = `/conflicts/${index}`;
  if (!conflict || typeof conflict !== 'object') throw fail('CONFLICT_INVALID', { path });
  const blockingSystemDefect = conflict.kind === 'system_defect'
    && ['critical', 'major'].includes(conflict.severity)
    && conflict.status !== 'resolved';
  if (blockingSystemDefect) throw fail('SYSTEM_DEFECT_UNRESOLVED', { path });
  if (conflict.kind !== 'scientific_disagreement' || conflict.important !== true) return null;
  if (!['resolved', 'bounded'].includes(conflict.disposition)
    || typeof conflict.issue !== 'string' || !conflict.issue.trim()
    || !Array.isArray(conflict.evidence) || conflict.evidence.length === 0
    || conflict.evidence.some(item => !item || typeof item.locator !== 'string' || !item.locator || !fingerprint(item.fingerprint))
    || typeof conflict.conclusion_boundary !== 'string' || !conflict.conclusion_boundary.trim()) {
    throw fail('IMPORTANT_DISAGREEMENT_UNBOUNDED', { path });
  }
  return Object.freeze({
    issue: conflict.issue,
    evidence: conflict.evidence.map(item => ({ locator: item.locator, fingerprint: item.fingerprint })),
    disposition: conflict.disposition,
    conclusion_boundary: conflict.conclusion_boundary,
  });
}

function requireCurrentRunControl({ run, dispatchContext, proofChain }) {
  const control = getRunControlForDispatch({ dispatchContext, runId: run.run_id });
  if (!control || JSON.stringify(control.required_artifacts) !== JSON.stringify(proofChain.required_artifacts)
    || JSON.stringify(control.integration_prerequisites) !== JSON.stringify(proofChain.integration_prerequisites)) {
    throw fail('RUN_CONTROL_CONTEXT_REQUIRED');
  }
  for (const name of RUN_FINGERPRINTS) {
    if (!fingerprint(control.approved_fingerprints?.[name]) || !fingerprint(run.declared_fingerprints?.[name])
      || !fingerprint(run.current_fingerprints?.[name])
      || control.approved_fingerprints[name] !== run.declared_fingerprints[name]
      || run.declared_fingerprints[name] !== run.current_fingerprints[name]) {
      throw fail('RUN_CONTROL_FINGERPRINT_MISMATCH', { name });
    }
  }
  for (const dependency of proofChain.dependencies ?? []) {
    if (dependency.status !== 'current' || RUN_FINGERPRINTS.some(name => dependency.fingerprints?.[name] !== run.current_fingerprints[name])) {
      throw fail('RUN_DEPENDENCY_FINGERPRINT_MISMATCH', { artifact_id: dependency.artifact_id });
    }
  }
  for (const artifact of proofChain.artifacts ?? []) {
    const receipt = (run.receipts ?? []).find(item => item.artifact_id === artifact.artifact_id);
    if (!receipt || receipt.run_id !== run.run_id || receipt.sha256 !== artifact.sha256 || receipt.owner_actor_id !== artifact.owner_actor_id
      || receipt.path !== artifact.path || receipt.revision !== artifact.revision) {
      throw fail('RUN_RECEIPT_CHAIN_MISMATCH', { artifact_id: artifact.artifact_id });
    }
  }
}

function requireNoOpenChainSystemDefect(proofChain) {
  const defect = (proofChain.critical_defects ?? []).find(item => ['critical', 'major'].includes(item.severity) && item.status !== 'resolved');
  if (defect) throw fail('SYSTEM_DEFECT_UNRESOLVED', { id: defect.id, severity: defect.severity });
}

function artifactLookup(chain) {
  const byId = new Map((chain?.artifacts ?? []).map(artifact => [artifact.artifact_id, artifact]));
  for (const [role, suffix] of ROLE_REQUIREMENTS) {
    const artifact = [...byId.values()].find(item => item.role === role || item.artifact_id.startsWith(`${suffix}-`));
    if (!artifact) throw fail('ROLE_ARTIFACT_MISSING', { role });
    if (artifact.status !== 'current' || !artifact.receipt_sha256 || artifact.receipt_sha256 !== artifact.sha256) {
      throw fail('ROLE_ARTIFACT_NOT_FROZEN', { role });
    }
    byId.set(`role:${role}`, artifact);
  }
  return byId;
}

async function readBoundRoleArtifacts({ artifactRoot, chain, inputFingerprint, sourceCheckFingerprint, inputField = 'complete_scientific_input_fingerprint',allowWholePaperStorage=false }) {
  const artifacts = artifactLookup(chain);
  const loaded = {};
  const contents = {};
  for (const [role] of ROLE_REQUIREMENTS) {
    const expected = artifacts.get(`role:${role}`);
    const observed = await readOwnedArtifact({ artifactRoot, artifactId: expected.artifact_id });
    if (!observed || observed.receipt.run_id !== chain.run_id || observed.receipt.sha256 !== expected.sha256 || observed.receipt.revision !== expected.revision
      || observed.receipt.owner_actor_id !== expected.owner_actor_id || observed.receipt.role !== role || observed.receipt.path !== expected.path) {
      throw fail('OWNED_ARTIFACT_RECEIPT_MISMATCH', { role });
    }
    let content;
    try { content = JSON.parse(observed.bytes.toString('utf8')); } catch { throw fail('ROLE_ARTIFACT_JSON_INVALID', { role }); }
    if(content&&Object.hasOwn(content,'storage_contract')){
      if(!allowWholePaperStorage||role!=='integration')throw fail('ROLE_ARTIFACT_STORAGE_INVALID',{role,storage_code:'WHOLE_PAPER_STORAGE_CONTRACT_UNSUPPORTED'});
      // Do not retain a second parsed graph while the bounded decoder materializes its value.
      content=null;
      try{content=decodeWholePaperArtifact(observed.bytes,{expectedKind:'integration_role'}).value;}
      catch(error){throw fail('ROLE_ARTIFACT_STORAGE_INVALID',{role,storage_code:error.code??'WHOLE_PAPER_STORAGE_STRUCTURE_INVALID'});}
    }
    if (content[inputField] !== inputFingerprint
      || inputField === 'scientific_input_fingerprint' && Object.hasOwn(content, 'complete_scientific_input_fingerprint')
      || content.source_check_fingerprint !== sourceCheckFingerprint) {
      throw fail('ROLE_ARTIFACT_INPUT_BINDING_MISMATCH', { role });
    }
    loaded[role] = Object.freeze({ artifact_id: expected.artifact_id, revision: expected.revision, sha256: expected.sha256 });
    contents[role] = Object.freeze(content);
  }
  const sourceArtifact = (chain.artifacts ?? []).find(artifact => artifact.artifact_id === 'source-check');
  if (!sourceArtifact || sourceArtifact.status !== 'current') throw fail('SOURCE_CHECK_ARTIFACT_MISSING');
  const sourceRead = await readOwnedArtifact({ artifactRoot, artifactId: sourceArtifact.artifact_id });
  if (!sourceRead || sourceRead.receipt.run_id !== chain.run_id || sourceRead.receipt.sha256 !== sourceArtifact.sha256 || sourceRead.receipt.role !== 'source-check'
    || sourceRead.receipt.revision !== sourceArtifact.revision || sourceRead.receipt.owner_actor_id !== sourceArtifact.owner_actor_id || sourceRead.receipt.path !== sourceArtifact.path) {
    throw fail('SOURCE_CHECK_RECEIPT_MISMATCH');
  }
  let sourceContent;
  try { sourceContent = JSON.parse(sourceRead.bytes.toString('utf8')); } catch { throw fail('SOURCE_CHECK_JSON_INVALID'); }
  if (sourceContent[inputField] !== inputFingerprint || sourceContent.source_check_fingerprint !== sourceCheckFingerprint
    || inputField === 'scientific_input_fingerprint' && Object.hasOwn(sourceContent, 'complete_scientific_input_fingerprint')) {
    throw fail('SOURCE_CHECK_INPUT_BINDING_MISMATCH');
  }
  return Object.freeze({
    records: Object.freeze(loaded), contents: Object.freeze(contents),
    source_check: Object.freeze({ content: Object.freeze(sourceContent), artifact_id: sourceArtifact.artifact_id, sha256: sourceArtifact.sha256, revision: sourceArtifact.revision }),
  });
}

function inputSourceMap(sourcePackage, native = false, whole = false) {
  return sourcePackage.source_documents.map(source => ({
    document_id: source.source_document_id,
    role: source.role === 'main' ? 'main' : 'attachment',
    critical: sourcePackage.attachments.some(attachment => attachment.source_document_id === source.source_document_id && attachment.critical === true),
    availability: source.included && source.support_status === 'supported' ? 'available' : 'missing',
    source_sha256: source.source_hash,
    ...(whole ? {kind:source.kind,purpose:source.purpose,...Object.fromEntries(['format','container','member_path'].filter(k=>Object.hasOwn(source,k)).map(k=>[k,copy(source[k])]))}
      : native ? { kind: source.kind, ...(source.kind === 'workbook' ? { format: source.format, container: copy(source.container), member_path: source.member_path } : {}) } : {}),
  })).sort((left, right) => left.document_id.localeCompare(right.document_id));
}

function requireAcceptedParserComparison(roleContents, sourcePackage, scientificInput, sourceCheckContent) {
  const integration = roleContents.integration;
  const inputs = integration?.parser_comparison_inputs;
  const storedResult = integration?.parser_comparison_result;
  const native = scientificInput?.schema_version === 'phase21-scientific-input-workbook-1.0';
  const whole = scientificInput?.schema_version === 'phase21-scientific-input-whole-paper-1.0';
  const comparisonFingerprint=whole?fingerprintV3Json:canonicalFingerprint;
  if(!whole&&(inputs?.comparisonPolicy?.location_contract==='phase21-whole-paper-1.0'||[inputs?.baselineRun,inputs?.candidateRun,storedResult].some(x=>typeof x?.schema_version==='string'&&x.schema_version.includes('whole-paper'))))throw fail('WHOLE_PAPER_SCIENTIFIC_SOURCE_CONTRACT_UNSUPPORTED');
  if(!native && !whole && (inputs?.comparisonPolicy?.location_contract==='phase21-native-workbook-1.0'
    || [inputs?.baselineRun,inputs?.candidateRun,inputs?.referenceManifest,storedResult].some(record=>typeof record?.schema_version==='string'&&record.schema_version.includes('workbook') || Array.isArray(record?.blocks)&&record.blocks.some(block=>block?.locator?.kind==='workbook')))) {
    throw fail('WORKBOOK_SCIENTIFIC_SOURCE_CONTRACT_UNSUPPORTED');
  }
  if (!inputs || !storedResult) throw fail('PARSER_COMPARISON_NOT_ACCEPTED');
  const actualResult = compareParserRuns(inputs);
  if (whole && ([inputs.referenceManifest?.evaluation_profile, inputs.comparisonPolicy?.evaluation_profile].includes('phase21-whole-paper-representation-1.0')
    || actualResult.reference_kind === 'accepted_assisted_source_representation')) {
    throw fail('WHOLE_PAPER_REPRESENTATION_NOT_SCIENTIFIC_ELIGIBLE');
  }
  const expectedSourceMap = inputSourceMap(sourcePackage, native, whole);
  const resultFingerprint = comparisonFingerprint(actualResult);
  const controlsFingerprint = canonicalFingerprint({ comparisonPolicy: inputs.comparisonPolicy, candidateDescriptor: inputs.candidateDescriptor });
  const assisted = Object.hasOwn(inputs, 'referenceManifest');
  const referenceMatches = actualResult.status === 'compared' && (assisted
    ? actualResult.schema_version === (whole ? 'phase21-reference-comparison-whole-paper-1.0' : native ? 'phase21-reference-comparison-workbook-1.0' : 'phase21-reference-comparison-1.0')
      && (native ? actualResult.reference_basis?.kind : actualResult.reference_kind) === 'accepted_assisted'
      && actualResult.reference_manifest_fingerprint === comparisonFingerprint(inputs.referenceManifest)
      && !Object.hasOwn(actualResult, 'gold_manifest_fingerprint')
    : actualResult.gold_manifest_fingerprint === canonicalFingerprint(inputs.goldManifest));
  if (actualResult.status !== 'compared' || storedResult.status !== 'compared'
    || (whole ? comparisonFingerprint(storedResult)!==resultFingerprint : canonicalizeV3Json(storedResult) !== canonicalizeV3Json(actualResult))
    || actualResult.comparison_identity !== storedResult.comparison_identity
    || actualResult.source_document_map && canonicalizeV3Json(actualResult.source_document_map) !== canonicalizeV3Json(expectedSourceMap)
    || canonicalizeV3Json([...(inputs.baselineRun?.sources ?? [])].sort((a, b) => a.document_id.localeCompare(b.document_id))) !== canonicalizeV3Json(expectedSourceMap)
    || canonicalizeV3Json([...(inputs.candidateRun?.sources ?? [])].sort((a, b) => a.document_id.localeCompare(b.document_id))) !== canonicalizeV3Json(expectedSourceMap)
    || !referenceMatches
    || actualResult.comparison_policy_fingerprint !== canonicalFingerprint(inputs.comparisonPolicy)
    || actualResult.baseline_run_fingerprint !== comparisonFingerprint(inputs.baselineRun)
    || actualResult.candidate_run_fingerprint !== comparisonFingerprint(inputs.candidateRun)) {
    throw fail('PARSER_COMPARISON_NOT_ACCEPTED');
  }
  if (native && (!assisted || inputs.comparisonPolicy?.location_contract !== 'phase21-native-workbook-1.0'
    || canonicalizeV3Json(scientificInput.native_source_run) !== canonicalizeV3Json(inputs.candidateRun))) throw fail('PARSER_COMPARISON_NOT_ACCEPTED');
  if(whole&&(!assisted||inputs.comparisonPolicy?.location_contract!=='phase21-whole-paper-1.0'||fingerprintV3Json(scientificInput.source_run)!==actualResult.candidate_run_fingerprint))throw fail('PARSER_COMPARISON_NOT_ACCEPTED');
  for (const content of Object.values(roleContents)) {
    if (content.parser_comparison_result_fingerprint !== resultFingerprint) throw fail('ROLE_COMPARISON_BINDING_MISMATCH');
  }
  if (inputs.archiveRepresentation && canonicalizeV3Json(sourceCheckContent?.archive_representation_binding ?? null)
    !== canonicalizeV3Json(archiveSourceCheckBinding(inputs.archiveRepresentation))) throw fail('ARCHIVE_SOURCE_CHECK_BINDING_MISMATCH');
  return Object.freeze({
    source: canonicalFingerprint(expectedSourceMap),
    ...(assisted ? {
      schema_version: 'phase21-reference-binding-1.0',
      reference_kind: native ? actualResult.reference_basis.kind : actualResult.reference_kind,
      reference_manifest: actualResult.reference_manifest_fingerprint,
      reference_basis: copy(actualResult.reference_basis),
      reference_method: copy(actualResult.reference_method),
      reference_scope: copy(actualResult.reference_scope),
      limitations: copy(actualResult.limitations),
    } : { gold_manifest: actualResult.gold_manifest_fingerprint }),
    control_input: controlsFingerprint,
    result: resultFingerprint,
    comparison_identity: actualResult.comparison_identity,
  });
}

function requireDependencyOrder(run, roleArtifacts) {
  const methods = roleArtifacts.methods;
  const results = roleArtifacts.results;
  const interpretation = roleArtifacts.interpretation;
  const card = roleArtifacts['scientific-reading'];
  const integration = roleArtifacts.integration;
  const byId = new Map((run.chain.artifacts ?? []).map(artifact => [artifact.artifact_id, artifact]));
  const depends = (child, parent) => byId.get(child.artifact_id)?.depends_on?.includes(parent.artifact_id);
  if (!depends(interpretation, methods) || !depends(interpretation, results)) throw fail('INTERPRETATION_DEPENDENCY_MISSING');
  for (const parent of [roleArtifacts.evidence, methods, results, interpretation]) {
    if (!depends(card, parent)) throw fail('SCIENTIFIC_CARD_DEPENDENCY_MISSING');
  }
  for (const parent of [roleArtifacts.evidence, methods, results, interpretation, card]) {
    if (!depends(integration, parent)) throw fail('INTEGRATION_DEPENDENCY_MISSING');
  }
}

function requireSourceCheck({ sourceCheck, sourceReceipt, proofChain, inputFingerprint, inputField = 'complete_scientific_input_fingerprint' }) {
  const actual = sourceReceipt?.content;
  const required = ['fingerprint', inputField, 'received_upstream_analysis', 'independence', 'initial_pass_status', 'conclusion_status'];
  if (!actual || required.some(name => !Object.hasOwn(actual, name))
    || actual[inputField] !== inputFingerprint || !fingerprint(actual.fingerprint)
    || actual.received_upstream_analysis !== false || !['not_independent', 'independent'].includes(actual.independence)
    || actual.initial_pass_status !== 'completed' || actual.conclusion_status !== 'pass') {
    throw fail('SOURCE_CHECK_ARTIFACT_INVALID');
  }
  if (!sourceCheck || typeof sourceCheck !== 'object' || required.some(name => sourceCheck[name] !== actual[name]) || sourceCheck.artifact_sha256 !== sourceReceipt.sha256) {
    throw fail('SOURCE_CHECK_PARAMETER_MISMATCH');
  }
  if (!proofChain.source_check?.sealed || !proofChain.analysis_draft_frozen) throw fail('SOURCE_CHECK_NOT_FROZEN');
  if (proofChain.source_check.status !== actual.independence || actual.independence === 'independent' && proofChain.isolation_observation !== 'observed') throw fail('SOURCE_CHECK_NOT_INDEPENDENT');
  return Object.freeze({ fingerprint: actual.fingerprint, artifact_sha256: sourceReceipt.sha256, independence: proofChain.isolation_observation === 'observed' ? 'declared_not_host_attested' : 'not_independent' });
}

function requireDeliverableRun({ run, dispatchContext, phase21Validator, proofChain }) {
  if (!run || !proofChain || run.run_id !== proofChain.run_id || run.chain !== proofChain) throw fail('RUN_PROOF_CHAIN_MISMATCH');
  requireCurrentRunControl({ run, dispatchContext, proofChain });
  requireNoOpenChainSystemDefect(proofChain);
  const proof = validateProofChain({ chain: proofChain, dispatchContext, phase21Validator });
  if (!proof.ok || proofChain.delivery_status !== 'deliverable') throw fail('PROOF_CHAIN_NOT_DELIVERABLE', { errors: proof.errors });
}

/** Builds only a local contract-complete candidate from existing receipt-bound artifacts. */
export async function buildCompleteCandidate({ run, dispatchContext, artifactRoot, phase21Validator, completeScientificInput, sourceCheck, conflicts = [], proofChain } = {}) {
  if(completeScientificInput?.schema_version==='phase21-scientific-input-whole-paper-1.0'||completeScientificInput?.source_package?.schema_version==='phase21-source-package-whole-paper-1.0'||completeScientificInput?.boundary_package?.source_package?.schema_version==='phase21-source-package-whole-paper-1.0')throw fail('WHOLE_PAPER_COMPLETE_PACKAGE_UNSUPPORTED');
  if (completeScientificInput?.schema_version === 'phase21-scientific-input-workbook-1.0'
    || completeScientificInput?.source_package?.schema_version === 'phase21-source-package-workbook-1.0') throw fail('WORKBOOK_SCIENTIFIC_SOURCE_CONTRACT_UNSUPPORTED');
  requireDeliverableRun({ run, dispatchContext, phase21Validator, proofChain });
  const complete = requireCompleteScientificInput(completeScientificInput);
  const disagreements = conflicts.map(normalizeConflict).filter(Boolean);
  const loadedRoles = await readBoundRoleArtifacts({ artifactRoot, chain: proofChain, inputFingerprint: complete.fingerprint, sourceCheckFingerprint: sourceCheck?.fingerprint });
  const source = requireSourceCheck({ sourceCheck, sourceReceipt: loadedRoles.source_check, proofChain, inputFingerprint: complete.fingerprint });
  const roles = loadedRoles.records;
  const parserComparison = requireAcceptedParserComparison(loadedRoles.contents, completeScientificInput.boundary_package.source_package, undefined, loadedRoles.source_check.content);
  requireDependencyOrder(run, roles);
  const dependencies = Object.freeze({
    complete_scientific_input: complete.fingerprint,
    required_semantic_unit_manifest: complete.requiredManifestFingerprint,
    source_check: source.fingerprint,
    source_check_receipt: source.artifact_sha256,
    parser_comparison: parserComparison.result,
    ...Object.fromEntries(Object.entries(roles).map(([role, artifact]) => [`role:${role}`, artifact.sha256])),
  });
  return Object.freeze({
    schema_version: 'phase21-complete-candidate-1.0',
    status: 'local_contract_complete',
    complete_scientific_input_fingerprint: complete.fingerprint,
    required_semantic_unit_manifest_fingerprint: complete.requiredManifestFingerprint,
    role_artifacts: roles,
    important_disagreements: Object.freeze(disagreements),
    source_check: source,
    parser_comparison: parserComparison,
    execution_boundary: Object.freeze({
      formal_paper_content_model: DEFAULT_APA_MODEL,
      production_parser_default: 'current-mineru',
      authorization_authority: 'user-approved-controls-only',
    }),
    delivery_evidence: 'offline_local_contract_only',
    host_independence: source.independence,
    p20_e12_disposition: 'unverified',
    phase22_dependencies: dependencies,
  });
}

/** Receipt-bound pre-render handoff only; never a complete package or publication authority. */
export async function buildPreRenderHandoff({ run, dispatchContext, artifactRoot, phase21Validator, scientificInput, sourceCheck, conflicts = [], proofChain } = {}) {
  if (scientificInput?.profile === READING_FIRST_PROFILE || getRunControlForDispatch({dispatchContext,runId:run?.run_id})?.reading_first_binding?.profile === READING_FIRST_PROFILE) return buildReadingFirstHandoff({run, dispatchContext, artifactRoot, scientificInput:{...scientificInput,profile:READING_FIRST_PROFILE}});
  if(scientificInput?.schema_version==='phase21-scientific-input-source-evidence-1.0')throw fail('SOURCE_EVIDENCE_MODE_REQUIRED');
  requireDeliverableRun({ run, dispatchContext, phase21Validator, proofChain });
  const checked = validateScientificInput(scientificInput);
  if (!checked.ok) throw fail('PRE_RENDER_SCIENTIFIC_INPUT_INVALID', { errors: checked.errors });
  // Keep the validated content stable while owned artifacts are read asynchronously.
  const input = copy(scientificInput);
  if (input.identity.run_id !== run.run_id) throw fail('SCIENTIFIC_INPUT_RUN_MISMATCH');
  const binding = { inputFingerprint: input.input_fingerprint, inputField: 'scientific_input_fingerprint' };
  const disagreements = conflicts.map(normalizeConflict).filter(Boolean);
  const loaded = await readBoundRoleArtifacts({ artifactRoot, chain: proofChain, ...binding, sourceCheckFingerprint: sourceCheck?.fingerprint,allowWholePaperStorage:input.schema_version==='phase21-scientific-input-whole-paper-1.0' });
  const source = requireSourceCheck({ sourceCheck, sourceReceipt: loaded.source_check, proofChain, ...binding });
  const parserComparison = requireAcceptedParserComparison(loaded.contents, input.source_package, input, loaded.source_check.content);
  requireDependencyOrder(run, loaded.records);
  requireDeliverableRun({ run, dispatchContext, phase21Validator, proofChain });
  const manifestFingerprint = canonicalFingerprint(input.scientific_details.required_semantic_units);
  const dependencies = Object.freeze({
    scientific_input: input.input_fingerprint,
    required_semantic_unit_manifest: manifestFingerprint,
    run_control: canonicalFingerprint(run.current_fingerprints),
    source_check: source.fingerprint,
    source_check_receipt: source.artifact_sha256,
    parser_comparison: parserComparison.result,
    ...Object.fromEntries(Object.entries(loaded.records).map(([role, artifact]) => [`role:${role}`, artifact.sha256])),
  });
  const handoff = {
    schema_version: input.schema_version === 'phase21-scientific-input-whole-paper-1.0' ? 'phase21-pre-render-handoff-whole-paper-1.0' : input.schema_version === 'phase21-scientific-input-workbook-1.0' ? 'phase21-pre-render-handoff-workbook-1.0' : 'phase21-pre-render-handoff-1.0', status: 'local_pre_render_handoff',
    ...(['phase21-scientific-input-workbook-1.0','phase21-scientific-input-whole-paper-1.0'].includes(input.schema_version) ? {
      scientific_contract_version: input.schema_version, source_package_contract_version: input.source_package.schema_version,
      location_contract: input.schema_version==='phase21-scientific-input-whole-paper-1.0'?'phase21-whole-paper-1.0':'phase21-native-workbook-1.0',
    } : {}),
    phase22_owner: 'phase-22', identity: input.identity,
    scientific_input_fingerprint: input.input_fingerprint,
    required_semantic_unit_manifest_fingerprint: manifestFingerprint,
    scientific_completeness: checked.scientific_completeness,
    source_status: input.scientific_details.source_status,
    role_artifacts: loaded.records, source_check: source, parser_comparison: parserComparison,
    important_disagreements: Object.freeze(disagreements),
    invalidation_dependencies: dependencies,
    delivery_evidence: 'offline_local_contract_only', host_independence: source.independence,
    p20_e12_disposition: 'unverified', publishable: false, renders_or_publishes: false,
  };
  return Object.freeze({ ...handoff, handoff_fingerprint: canonicalFingerprint(handoff) });
}

/** Checks an unchanged pre-render record against current bindings, not their authenticity. */
export function validatePreRenderHandoff({ handoff, currentDependencies } = {}) {
  const invalid = () => ({ ok: false, reason: 'PRE_RENDER_HANDOFF_INVALID' });
  if (!['phase21-pre-render-handoff-1.0', 'phase21-pre-render-handoff-workbook-1.0','phase21-pre-render-handoff-whole-paper-1.0'].includes(handoff?.schema_version) || handoff.status !== 'local_pre_render_handoff'
    || handoff.publishable !== false || handoff.renders_or_publishes !== false || !currentDependencies) return invalid();
  if (handoff.schema_version === 'phase21-pre-render-handoff-workbook-1.0'
    && (handoff.scientific_contract_version !== 'phase21-scientific-input-workbook-1.0'
      || handoff.source_package_contract_version !== 'phase21-source-package-workbook-1.0'
      || handoff.location_contract !== 'phase21-native-workbook-1.0')) return invalid();
  if(handoff.schema_version==='phase21-pre-render-handoff-whole-paper-1.0'&&(handoff.scientific_contract_version!=='phase21-scientific-input-whole-paper-1.0'||handoff.source_package_contract_version!=='phase21-source-package-whole-paper-1.0'||handoff.location_contract!=='phase21-whole-paper-1.0'))return invalid();
  const { handoff_fingerprint, ...content } = handoff;
  try { if (canonicalFingerprint(content) !== handoff_fingerprint) return invalid(); } catch { return invalid(); }
  const expected = handoff.invalidation_dependencies;
  if (!expected || Object.keys(expected).length !== PRE_RENDER_DEPENDENCIES.length
    || PRE_RENDER_DEPENDENCIES.some(key => !fingerprint(expected[key]))) return invalid();
  const stale = PRE_RENDER_DEPENDENCIES.filter(key => currentDependencies[key] !== expected[key]);
  return stale.length ? { ok: false, reason: 'PRE_RENDER_HANDOFF_INVALIDATED', stale_dependencies: stale.sort() } : { ok: true };
}

const SOURCE_EVIDENCE_DEPENDENCIES=Object.freeze(PRE_RENDER_DEPENDENCIES.map(key=>key==='parser_comparison'?'scientific_evidence_qualification':key));
const receiptBinding=receipt=>({artifact_id:receipt.artifact_id,revision:receipt.revision,sha256:receipt.sha256});
function parserDispositionSummary(disposition){
  return {requirement_status:disposition.requirement_status,comparison_status:disposition.comparison_status,source_scope_fingerprint:disposition.source_scope_fingerprint,reason:disposition.reason,evidence_records:disposition.evidence_records.map(({kind,record_ref,sha256})=>({kind,record_ref,sha256})),disposition_fingerprint:fingerprintV3Json(disposition)};
}

export function fingerprintSourceEvidenceObservations(bundle){
  return fingerprintV3Json({pdf_run:bundle.pdf_run,office_observations:bundle.office_observations,
    ...(bundle.visual_observations?{visual_observations:bundle.visual_observations}:{})});
}

async function readSourceEvidenceStages({run,artifactRoot,proofChain,input,finalSource,evidenceArtifactId,reference=null}){
  const byId=new Map(proofChain.artifacts.map(a=>[a.artifact_id,a]));
  const read=async(id,role)=>{
    const expected=byId.get(id),required=proofChain.required_artifacts.find(a=>a.artifact_id===id);
    if(!expected||!required||expected.status!=='current')throw fail('SOURCE_EVIDENCE_ARTIFACT_MISSING');
    const observed=await readOwnedArtifact({artifactRoot,artifactId:id}),r=observed?.receipt;
    if(!r||r.artifact_id!==id||r.run_id!==run.run_id||r.role!==role||r.sha256!==expected.sha256||r.sha256!==expected.receipt_sha256||r.revision!==expected.revision||r.path!==expected.path||r.owner_actor_id!==expected.owner_actor_id||r.path!==required.path||r.owner_actor_id!==required.owner_actor_id)throw fail('SOURCE_EVIDENCE_RECEIPT_MISMATCH');
    return observed;
  };
  const first=await read('source-check-initial','source-check'),frozen=await read('scientific-input-frozen','control');
  let initial,decoded;
  try{initial=JSON.parse(first.bytes.toString('utf8'));}catch{throw fail('SOURCE_EVIDENCE_INITIAL_CHECK_INVALID');}
  try{
    if(reference){
      const stored=readSourceEvidenceScientificInputReference(frozen.bytes);
      if(!same(stored,reference))throw fail('SOURCE_EVIDENCE_REUSE_REFERENCE_MISMATCH');
      // These exact refs were resolved from checked original bytes. Reuse their frozen graph, not a second decoded archive.
      decoded={...stored.scientific_input_fields,source_evidence_bundle:input.source_evidence_bundle};
    }else decoded=decodeWholePaperArtifact(frozen.bytes,{expectedKind:'source_evidence_scientific_input'}).value;
  }catch(error){throw fail('SOURCE_EVIDENCE_FROZEN_INPUT_MISMATCH',{storage_code:error.code??'invalid'});}
  if(!same(decoded,input))throw fail('SOURCE_EVIDENCE_FROZEN_INPUT_MISMATCH');
  const bundle=input.source_evidence_bundle;
  const initialFields=['scientific_input_fingerprint','source_check_fingerprint','fingerprint','received_upstream_analysis','independence','initial_pass_status','source_bundle_fingerprint','source_scope_fingerprint','source_observations_fingerprint'];
  if(!same(Object.keys(initial).sort(),[...initialFields].sort())||initial.received_upstream_analysis!==false||initial.independence!==finalSource.content.independence||initial.initial_pass_status!=='completed'
    ||initial.scientific_input_fingerprint!==input.input_fingerprint||initial.source_bundle_fingerprint!==bundle.bundle_fingerprint||initial.source_scope_fingerprint!==bundle.provenance.approval_binding.source_scope_fingerprint
    ||initial.source_observations_fingerprint!==fingerprintSourceEvidenceObservations(bundle)||initial.source_check_fingerprint!==finalSource.content.source_check_fingerprint||initial.fingerprint!==finalSource.content.fingerprint)throw fail('SOURCE_EVIDENCE_INITIAL_CHECK_INVALID');
  if(finalSource.content.final_pass_received_upstream_analysis!==true||!same(finalSource.content.initial_source_check_binding,receiptBinding(first.receipt))||!same(finalSource.content.frozen_scientific_input_binding,receiptBinding(frozen.receipt)))throw fail('SOURCE_EVIDENCE_FINAL_CHECK_INVALID');
  const ordered=['source-check-initial','scientific-input-frozen','source-check',evidenceArtifactId];
  const indices=ordered.map(id=>proofChain.artifacts.findIndex(a=>a.artifact_id===id));
  if(byId.get('source-check-initial').depends_on?.length||!same(byId.get('scientific-input-frozen').depends_on,['source-check-initial'])||!same(byId.get('source-check').depends_on,['scientific-input-frozen'])||indices.some((n,i)=>n<0||i>0&&n<=indices[i-1]))throw fail('SOURCE_EVIDENCE_DEPENDENCY_MISSING');
  return {initial_source_check_binding:receiptBinding(first.receipt),frozen_scientific_input_binding:receiptBinding(frozen.receipt),final_pass_received_upstream_analysis:true};
}

/** Explicit scientific-evidence route; parser evaluation remains unmet and the old route never falls back here. */
export async function buildSourceEvidencePreRenderHandoff({run,dispatchContext,artifactRoot,phase21Validator,scientificInput,scientificInputReference,sourceArtifacts,sourceCheck,conflicts=[],proofChain}={}){
  const reuse=scientificInputReference!==undefined;
  if(reuse&&scientificInput!==undefined||!reuse&&sourceArtifacts!==undefined)throw fail('SOURCE_EVIDENCE_REUSE_MODE_MISMATCH');
  if(!reuse&&scientificInput?.schema_version!=='phase21-scientific-input-source-evidence-1.0')throw fail('SOURCE_EVIDENCE_INPUT_REQUIRED');
  requireDeliverableRun({run,dispatchContext,phase21Validator,proofChain});
  if(typeof artifactRoot!=='string'||typeof run.artifact_root!=='string'||resolve(artifactRoot)!==resolve(run.artifact_root))throw fail('ARTIFACT_ROOT_MISMATCH');
  if(!reuse&&getRunControlForDispatch({dispatchContext,runId:run.run_id}).source_evidence_reuse!==undefined)throw fail('SOURCE_EVIDENCE_REUSE_MODE_MISMATCH');
  const restored=reuse?resolveSourceEvidenceScientificInputReference({scientificInputReference,sourceArtifacts,run,dispatchContext}):null;
  const checked=validateScientificInput(restored?.scientificInput??scientificInput);if(!checked.ok)throw fail('PRE_RENDER_SCIENTIFIC_INPUT_INVALID',{errors:checked.errors});
  const input=restored?.scientificInput??copy(scientificInput),bundle=input.source_evidence_bundle;
  if(input.identity.run_id!==run.run_id)throw fail('SCIENTIFIC_INPUT_RUN_MISMATCH');
  const expectedControls=reuse?{source:bundle.provenance.approval_binding.source_scope_fingerprint}:{source:bundle.provenance.approval_binding.source_scope_fingerprint,parser_tool:bundle.provenance.tool_binding.fingerprint,authorization:bundle.provenance.approval_binding.authorization_fingerprint,policy:bundle.provenance.approval_binding.policy_fingerprint};
  if(Object.entries(expectedControls).some(([key,value])=>run.current_fingerprints[key]!==value))throw fail('SOURCE_EVIDENCE_CONTROL_BINDING_MISMATCH');
  const binding={inputFingerprint:input.input_fingerprint,inputField:'scientific_input_fingerprint'},disagreements=conflicts.map(normalizeConflict).filter(Boolean);
  const loaded=await readBoundRoleArtifacts({artifactRoot,chain:proofChain,...binding,sourceCheckFingerprint:sourceCheck?.fingerprint});
  const source=requireSourceCheck({sourceCheck,sourceReceipt:loaded.source_check,proofChain,...binding});
  const stages=await readSourceEvidenceStages({run,artifactRoot,proofChain,input,finalSource:loaded.source_check,evidenceArtifactId:loaded.records.evidence.artifact_id,reference:restored?.reference});
  const result=evaluateScientificEvidenceQualification({scientificInput:input,sourceCheckContent:loaded.source_check.content,sourceCheckReceiptSha256:loaded.source_check.sha256});
  if(!result.ok)throw fail('SCIENTIFIC_EVIDENCE_NOT_QUALIFIED',{errors:result.errors});
  const disposition=parserDispositionSummary(input.parser_evaluation_disposition);
  for(const content of Object.values(loaded.contents))if(content.scientific_evidence_qualification_fingerprint!==result.qualification_fingerprint||['parser_comparison_inputs','parser_comparison_result','parser_comparison_result_fingerprint','source_evidence_bundle','scientific_input'].some(k=>Object.hasOwn(content,k)))throw fail('SOURCE_EVIDENCE_ROLE_BINDING_MISMATCH');
  if(!same(loaded.contents.integration.scientific_evidence_qualification,result.qualification)||!same(loaded.contents.integration.parser_evaluation_disposition,disposition))throw fail('SOURCE_EVIDENCE_ROLE_BINDING_MISMATCH');
  const byId=new Map(proofChain.artifacts.map(a=>[a.artifact_id,a]));
  if(!byId.get(loaded.records.evidence.artifact_id).depends_on?.includes('source-check')||['methods','results'].some(role=>!byId.get(loaded.records[role].artifact_id).depends_on?.includes(loaded.records.evidence.artifact_id)))throw fail('SOURCE_EVIDENCE_DEPENDENCY_MISSING');
  requireDependencyOrder(run,loaded.records);requireDeliverableRun({run,dispatchContext,phase21Validator,proofChain});
  if(reuse&&verifySourceEvidenceReuseArtifacts({sourceArtifacts,run,dispatchContext,requiredSteps:['scientific_input','source_check','roles','handoff']})!==restored.runControlFingerprint)throw fail('SOURCE_EVIDENCE_REUSE_AUTHORIZATION_MISMATCH');
  const manifestFingerprint=fingerprintV3Json(input.scientific_details.required_semantic_units);
  const dependencies={scientific_input:input.input_fingerprint,required_semantic_unit_manifest:manifestFingerprint,run_control:restored?.runControlFingerprint??canonicalFingerprint(run.current_fingerprints),source_check:source.fingerprint,source_check_receipt:source.artifact_sha256,scientific_evidence_qualification:result.qualification_fingerprint,...Object.fromEntries(Object.entries(loaded.records).map(([role,artifact])=>['role:'+role,artifact.sha256]))};
  const handoff={schema_version:'phase21-pre-render-handoff-source-evidence-1.0',status:'local_pre_render_handoff',handoff_basis:'scientific_evidence',parser_evaluation_requirement_satisfied:false,scientific_contract_version:input.schema_version,source_package_contract_version:input.source_package.schema_version,location_contract:'phase21-whole-paper-1.0',phase22_owner:'phase-22',identity:input.identity,scientific_input_fingerprint:input.input_fingerprint,required_semantic_unit_manifest_fingerprint:manifestFingerprint,scientific_completeness:checked.scientific_completeness,source_status:input.scientific_details.source_status,role_artifacts:loaded.records,source_check:{...source,...stages},scientific_evidence_qualification:result.qualification,parser_evaluation_disposition:disposition,important_disagreements:disagreements,invalidation_dependencies:dependencies,delivery_evidence:'offline_local_contract_only',host_independence:source.independence,p20_e12_disposition:'unverified',publishable:false,renders_or_publishes:false};
  return Object.freeze({...handoff,handoff_fingerprint:fingerprintV3Json(handoff)});
}

/** Invalidation check only; fresh currentDependencies must come from actual current inputs and receipts. */
export function validateSourceEvidencePreRenderHandoff({handoff,currentDependencies}={}){
  const invalid=()=>({ok:false,reason:'SOURCE_EVIDENCE_HANDOFF_INVALID'});
  try{
    fingerprintV3Json(handoff);
    if(handoff.schema_version!=='phase21-pre-render-handoff-source-evidence-1.0'||handoff.status!=='local_pre_render_handoff'||handoff.handoff_basis!=='scientific_evidence'||handoff.parser_evaluation_requirement_satisfied!==false||handoff.publishable!==false||handoff.renders_or_publishes!==false||handoff.p20_e12_disposition!=='unverified'||handoff.scientific_contract_version!=='phase21-scientific-input-source-evidence-1.0'||handoff.source_package_contract_version!=='phase21-source-package-whole-paper-1.0'||handoff.location_contract!=='phase21-whole-paper-1.0'||!currentDependencies||Object.hasOwn(handoff,'parser_comparison'))return invalid();
    const {handoff_fingerprint,...content}=handoff;if(fingerprintV3Json(content)!==handoff_fingerprint)return invalid();
    const deps=handoff.invalidation_dependencies;if(!deps||Object.keys(deps).length!==SOURCE_EVIDENCE_DEPENDENCIES.length||SOURCE_EVIDENCE_DEPENDENCIES.some(key=>!fingerprint(deps[key])))return invalid();
    const q=handoff.scientific_evidence_qualification,{qualification_fingerprint,...qualification}=q;
    if(q.schema_version!=='phase21-scientific-evidence-qualification-1.0'||q.status!=='qualified'||q.parser_evaluation_requirement_satisfied!==false||fingerprintV3Json(qualification)!==qualification_fingerprint||deps.scientific_evidence_qualification!==qualification_fingerprint||deps.scientific_input!==handoff.scientific_input_fingerprint||deps.scientific_input!==q.scientific_input_fingerprint||deps.required_semantic_unit_manifest!==handoff.required_semantic_unit_manifest_fingerprint||deps.source_check!==handoff.source_check.fingerprint||deps.source_check_receipt!==handoff.source_check.artifact_sha256||deps.source_check_receipt!==q.source_check_receipt_sha256||q.scientific_completeness!==handoff.scientific_completeness||handoff.parser_evaluation_disposition.requirement_status!=='unmet'||handoff.parser_evaluation_disposition.disposition_fingerprint!==q.parser_evaluation_disposition_fingerprint||!['not_run','not_comparable','rejected'].includes(handoff.parser_evaluation_disposition.comparison_status)||ROLE_REQUIREMENTS.some(([role])=>deps['role:'+role]!==handoff.role_artifacts[role]?.sha256))return invalid();
    const stale=SOURCE_EVIDENCE_DEPENDENCIES.filter(key=>currentDependencies[key]!==deps[key]);return stale.length?{ok:false,reason:'SOURCE_EVIDENCE_HANDOFF_INVALIDATED',stale_dependencies:stale.sort()}:{ok:true};
  }catch{return invalid();}
}

/** Returns an invalidation-only Phase-22 token; it never produces rendered or published output. */
export function buildPhase22Handoff(candidate) {
  if(candidate?.schema_version==='phase21-pre-render-handoff-whole-paper-1.0'||candidate?.schema_version==='phase21-scientific-input-whole-paper-1.0')throw fail('WHOLE_PAPER_COMPLETE_PACKAGE_UNSUPPORTED');
  if (candidate?.schema_version !== 'phase21-complete-candidate-1.0' || candidate.status !== 'local_contract_complete') {
    throw fail('COMPLETE_CANDIDATE_REQUIRED');
  }
  const dependencies = candidate.phase22_dependencies;
  if (!dependencies || !Object.values(dependencies).every(fingerprint)) throw fail('PHASE22_DEPENDENCY_BINDING_MISSING');
  return Object.freeze({
    schema_version: 'phase21-phase22-handoff-1.0',
    phase22_owner: 'phase-22',
    complete_scientific_input_fingerprint: candidate.complete_scientific_input_fingerprint,
    required_semantic_unit_manifest_fingerprint: candidate.required_semantic_unit_manifest_fingerprint,
    accepted_core_fingerprint: candidate.role_artifacts.integration.sha256,
    accepted_scientific_card_fingerprint: candidate.role_artifacts['scientific-reading'].sha256,
    ...(candidate.parser_comparison?.reference_kind === 'accepted_assisted'
      ? { parser_comparison: copy(candidate.parser_comparison) } : {}),
    invalidation_dependencies: copy(dependencies),
    renders_or_publishes: false,
  });
}

/** Compares a previously issued handoff with current dependencies without refreshing it. */
export function validatePhase22Handoff({ handoff, currentDependencies } = {}) {
  if (handoff?.schema_version !== 'phase21-phase22-handoff-1.0' || !currentDependencies) return { ok: false, reason: 'PHASE22_HANDOFF_INVALID' };
  const expected = handoff.invalidation_dependencies ?? {};
  const stale = Object.keys(expected).filter(key => currentDependencies[key] !== expected[key]);
  return stale.length ? { ok: false, reason: 'PHASE22_HANDOFF_INVALIDATED', stale_dependencies: stale.sort() } : { ok: true };
}
