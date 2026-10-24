import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { canonicalizeV3Json, validateV3Package, nativeScientificLocationKey, wholePaperScientificLocationKey } from './semantic-package-validator.mjs';

const schemaUrl = new URL('../../Schema/contracts/v3-scientific/v3-scientific-package.schema.json', import.meta.url);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const digest = value => 'sha256:' + createHash('sha256').update(canonicalizeV3Json(value)).digest('hex');
const response = (errors, fingerprint) => ({
  ok: errors.length === 0,
  errors: errors.sort((a, b) => compare(a.code, b.code) || compare(a.path, b.path)),
  warnings: [],
  ...(errors.length ? {} : { scientific_input_fingerprint: fingerprint })
});
const safeError = (errors, code, path) => errors.push({ code, path, message: code });
const ACTIVE_VERSIONS = Object.freeze({
  scientific_schema_version: 'v3/scientific-package@3.0.0-scientific',
  prompt_contract_version: 'phase20-scientific-prompt@1',
  lens_registry_version: 'phase20-six-lenses@1',
  rubric_version: 'phase20-scientific-rubric@1',
  source_inventory_version: 'phase20-source-inventory@1'
});
let structuralPromise;

async function structuralValidator() {
  structuralPromise ??= (async () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    ajv.addSchema(JSON.parse(await readFile(schemaUrl, 'utf8')));
    return ajv.getSchema('v3/scientific-package');
  })();
  return structuralPromise;
}

const validateScientificShape = await structuralValidator();

function deriveManifest(details, add) {
  const records = Array.isArray(details?.records) ? details.records : [];
  const seen = new Set();
  const obligations = new Set();
  const manifest = [];
  for (const [index, record] of records.entries()) {
    const path = `/scientific_details/records/${index}`;
    if (!record || typeof record !== 'object' || Array.isArray(record)) { add('SCIENTIFIC_RECORD_INVALID', path); continue; }
    const { semantic_unit_id: id, kind, provenance, epistemic_status: epistemic, obligation_id: obligation, boundary_unit_ids: unitIds, required_for_downstream: required } = record;
    if (typeof id !== 'string' || !/^sci_[0-9a-f]{32}$/.test(id) || seen.has(id)) add('SCIENTIFIC_RECORD_INVALID', path + '/semantic_unit_id');
    else seen.add(id);
    if (typeof kind !== 'string' || !/\S/.test(kind) || !['author', 'external', 'analyst', 'user'].includes(provenance)
      || !['report', 'interpretation', 'hypothesis'].includes(epistemic) || !/^SR-(?:0[1-9]|1[0-6])$/.test(obligation)
      || !Array.isArray(unitIds) || unitIds.length === 0 || unitIds.some(unit => typeof unit !== 'string') || required !== true) {
      add('SCIENTIFIC_RECORD_INVALID', path); continue;
    }
    obligations.add(obligation);
    if (required) manifest.push({ semantic_unit_id: id, kind, provenance, epistemic_status: epistemic, obligation_id: obligation, boundary_unit_ids: [...unitIds].sort(), source_block_ids: [...(record.source_block_ids ?? [])].sort(), claim_ids: [...(record.claim_ids ?? [])].sort(), quantity_ids: [...(record.quantity_ids ?? [])].sort(), required_for_downstream: true });
  }
  for (let n = 1; n <= 16; n++) if (!obligations.has(`SR-${String(n).padStart(2, '0')}`)) add('SCIENTIFIC_OBLIGATION_MISSING', '/scientific_details/records');
  const recordById = new Map(records.map(record => [record?.semantic_unit_id, record]));
  const addMaterial = (id, kind, provenance, epistemic, recordId, sourceIds = [], claimIds = [], quantityIds = []) => {
    const parent = recordById.get(recordId) ?? records.find(record => record?.obligation_id === 'SR-16') ?? records[0];
    if (!nonblank(id) || !parent) return add('SCIENTIFIC_REQUIRED_UNIT_INVALID', '/scientific_details');
    if (seen.has(id)) return add('SCIENTIFIC_REQUIRED_UNIT_DUPLICATE', '/scientific_details');
    seen.add(id);
    manifest.push({ semantic_unit_id: id, kind, provenance, epistemic_status: epistemic, obligation_id: parent.obligation_id, boundary_unit_ids: [...(parent.boundary_unit_ids ?? [])].sort(), source_block_ids: [...sourceIds].sort(), claim_ids: [...claimIds].sort(), quantity_ids: [...quantityIds].sort(), required_for_downstream: true });
  };
  for (const claim of details?.claims ?? []) addMaterial(claim?.claim_id, 'claim', 'author', 'report', claim?.record_ids?.[0], claim?.source_block_ids, [claim?.claim_id]);
  for (const quantity of details?.quantities ?? []) addMaterial(quantity?.quantity_id, 'quantity', 'author', 'report', quantity?.record_id, [quantity?.source_block_id], [], [quantity?.quantity_id]);
  for (const statement of details?.statements ?? []) addMaterial(statement?.statement_id, 'statement', statement?.provenance, statement?.epistemic_status, records[0]?.semantic_unit_id, statement?.source_block_ids);
  for (const explanation of details?.explanations ?? []) addMaterial(explanation?.explanation_id, 'explanation', 'analyst', 'interpretation', explanation?.concept_record_id, explanation?.source_block_ids);
  for (const candidate of details?.research_candidates ?? []) addMaterial(candidate?.candidate_id, 'research_candidate', 'analyst', 'hypothesis', records.find(record => record?.obligation_id === 'SR-16')?.semantic_unit_id, candidate?.source_block_ids);
  return manifest.sort((a, b) => compare(a.semantic_unit_id, b.semantic_unit_id));
}

function validateDetailClosure(details, boundary, add, locationContract) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) { add('SCIENTIFIC_DETAILS_INVALID', '/scientific_details'); return; }
  const sourceDocs = new Map(boundary.source_package.source_documents.map(source => [source.source_document_id, source]));
  const units = new Set(boundary.core.units.map(unit => unit.unit_id));
  const evidence = new Set(boundary.core.evidence.map(item => item.evidence_id));
  const blockIds = new Set(), claimIds = new Set(), quantityIds = new Set(), recordIds = new Set();
  for (const [index, block] of (Array.isArray(details.source_blocks) ? details.source_blocks : []).entries()) {
    const path = `/scientific_details/source_blocks/${index}`;
    if (!block || typeof block !== 'object' || blockIds.has(block.source_block_id)) { add('SCIENTIFIC_SOURCE_BLOCK_INVALID', path); continue; }
    blockIds.add(block.source_block_id);
    const source = sourceDocs.get(block.source_document_id);
    if (!source || source.source_hash !== block.source_hash || !source.locators.some(locator => locationContract === 'phase21-whole-paper-1.0'
      ? wholePaperScientificLocationKey(locator) === wholePaperScientificLocationKey(block.native_locator ?? block)
      : locationContract === 'phase21-native-workbook-1.0'
      ? nativeScientificLocationKey(locator) === nativeScientificLocationKey(block.native_locator ?? block)
      : locator.page_index === block.page_index && locator.block_id === block.block_id)) add('SCIENTIFIC_SOURCE_BLOCK_INVALID', path);
  }
  for (const [index, record] of (Array.isArray(details.records) ? details.records : []).entries()) {
    const path = `/scientific_details/records/${index}`;
    if (!record || typeof record !== 'object') { add('SCIENTIFIC_RECORD_INVALID', path); continue; }
    recordIds.add(record.semantic_unit_id);
    if (record.required_for_downstream !== true) add('SCIENTIFIC_REQUIRED_UNIT_WEAKENED', path + '/required_for_downstream');
    for (const id of record.boundary_unit_ids ?? []) if (!units.has(id)) add('SCIENTIFIC_BOUNDARY_MAPPING_UNKNOWN', path + '/boundary_unit_ids');
    for (const id of record.boundary_evidence_ids ?? []) if (!evidence.has(id)) add('SCIENTIFIC_BOUNDARY_MAPPING_UNKNOWN', path + '/boundary_evidence_ids');
    for (const id of record.source_block_ids ?? []) if (!blockIds.has(id)) add('SCIENTIFIC_REFERENCE_UNKNOWN', path + '/source_block_ids');
  }
  for (const [index, claim] of (Array.isArray(details.claims) ? details.claims : []).entries()) {
    const path = `/scientific_details/claims/${index}`;
    if (!claim || typeof claim !== 'object' || claimIds.has(claim.claim_id)) { add('SCIENTIFIC_CLAIM_INVALID', path); continue; }
    claimIds.add(claim.claim_id);
    for (const id of claim.record_ids ?? []) if (!recordIds.has(id)) add('SCIENTIFIC_REFERENCE_UNKNOWN', path + '/record_ids');
    for (const id of claim.source_block_ids ?? []) if (!blockIds.has(id)) add('SCIENTIFIC_REFERENCE_UNKNOWN', path + '/source_block_ids');
  }
  for (const [index, quantity] of (Array.isArray(details.quantities) ? details.quantities : []).entries()) {
    const path = `/scientific_details/quantities/${index}`;
    if (!quantity || typeof quantity !== 'object' || quantityIds.has(quantity.quantity_id)) { add('SCIENTIFIC_QUANTITY_INVALID', path); continue; }
    quantityIds.add(quantity.quantity_id);
    if (!recordIds.has(quantity.record_id) || !blockIds.has(quantity.source_block_id)) add('SCIENTIFIC_REFERENCE_UNKNOWN', path);
  }
  for (const [index, record] of (Array.isArray(details.records) ? details.records : []).entries()) {
    const path = `/scientific_details/records/${index}`;
    for (const id of record?.claim_ids ?? []) if (!claimIds.has(id)) add('SCIENTIFIC_REFERENCE_UNKNOWN', path + '/claim_ids');
    for (const id of record?.quantity_ids ?? []) if (!quantityIds.has(id)) add('SCIENTIFIC_REFERENCE_UNKNOWN', path + '/quantity_ids');
  }
}

const LENSES = Object.freeze({
  methods: ['input_output', 'train_evaluation_isolation', 'comparable_baseline', 'budget_oracle', 'leakage', 'ablation'],
  discovery_mechanism: ['experimental_unit', 'controls_perturbation', 'necessity_sufficiency', 'alternatives', 'replication_batch_extrapolation'],
  resource_dataset: ['source_sampling', 'eligibility', 'annotation_measurement', 'coverage_representativeness', 'split_contamination', 'access_restrictions_validation'],
  clinical_population: ['population_recruitment', 'exposure_intervention_control', 'outcome_follow_up', 'analysis_denominator', 'bias_missingness_adverse_events', 'effect_meaning'],
  materials_engineering: ['conditions_parameters', 'instrument_calibration', 'replication', 'structure_mechanism_performance', 'benchmark', 'scale_boundary'],
  review_meta_analysis: ['search_selection', 'eligibility_protocol', 'overlap', 'bias_heterogeneity', 'sensitivity_publication_bias', 'narrative_systematic_scope']
});
const nonblank = value => typeof value === 'string' && /\S/.test(value);
const nonemptyArray = value => Array.isArray(value) && value.length > 0;
const referenceSet = values => new Set(Array.isArray(values) ? values : []);
const rejectUnknown = (row, allowed, add, path) => {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return add('SCIENTIFIC_READING_STRUCTURE_INVALID', path);
  for (const key of Object.keys(row)) if (!allowed.includes(key)) add('SCIENTIFIC_READING_STRUCTURE_INVALID', `${path}/${key}`);
};

function validateReadingQuality(details, add, locationContract) {
  const required = ['source_status', 'lens_checks', 'statements', 'experiment_claim_matrix', 'explanations', 'research_candidates', 'inventory', 'external_checks'];
  for (const key of required) if (!Object.hasOwn(details, key)) add('SCIENTIFIC_READING_DETAIL_MISSING', `/scientific_details/${key}`);
  rejectUnknown(details.source_status, ['coverage', 'completeness', 'affected_ids'], add, '/scientific_details/source_status');
  const sourceBlocks = new Map((details.source_blocks ?? []).map(block => [block?.source_block_id, block]));
  const blockIds = new Set(sourceBlocks.keys());
  const known = (ids, path, code = 'SCIENTIFIC_REFERENCE_UNKNOWN') => {
    if (!Array.isArray(ids) || ids.some(id => !blockIds.has(id))) add(code, path);
  };
  const status = details.source_status;
  if (!status || !['complete', 'full_paper', 'partial_paper', 'abstract_only', 'metadata_only', 'source_limited'].includes(status.coverage)
    || !['complete', 'partial'].includes(status.completeness) || !Array.isArray(status.affected_ids)) add('SCIENTIFIC_SOURCE_STATUS_INVALID', '/scientific_details/source_status');
  const primary = details.primary_lens;
  const secondary = details.secondary_lens;
  if (!Object.hasOwn(LENSES, primary) || (secondary !== null && (!Object.hasOwn(LENSES, secondary) || secondary === primary))) add('SCIENTIFIC_LENS_INVALID', '/scientific_details');
  const checks = Array.isArray(details.lens_checks) ? details.lens_checks : [];
  const primaryChecks = new Map();
  for (const [i, row] of checks.entries()) {
    const path = `/scientific_details/lens_checks/${i}`;
    rejectUnknown(row, ['lens', 'check_id', 'status', 'reason', 'source_block_ids'], add, path);
    if (!row || typeof row !== 'object' || !Object.hasOwn(LENSES, row.lens) || !nonblank(row.check_id)
      || !['reported', 'not_reported', 'not_applicable', 'not_assessable'].includes(row.status) || !nonblank(row.reason)
      || !Array.isArray(row.source_block_ids)) { add('SCIENTIFIC_LENS_CHECK_INVALID', path); continue; }
    if (row.lens === primary && primaryChecks.has(row.check_id)) add('SCIENTIFIC_LENS_CHECK_DUPLICATE', path + '/check_id');
    if (row.lens === primary) primaryChecks.set(row.check_id, row);
    known(row.source_block_ids, path + '/source_block_ids');
    if (row.status === 'reported' && !nonemptyArray(row.source_block_ids)) add('SCIENTIFIC_LENS_CHECK_CONTENT_MISSING', path);
    if ((row.status === 'not_applicable' || row.status === 'not_assessable') && /^n\/?a$|^not available$|^unknown$|^not applicable$/i.test(row.reason.trim())) add('SCIENTIFIC_APPLICABILITY_UNJUSTIFIED', path + '/reason');
  }
  for (const check of LENSES[primary] ?? []) if (!primaryChecks.has(check)) add('SCIENTIFIC_LENS_CHECK_MISSING', '/scientific_details/lens_checks');
  const records = Array.isArray(details.records) ? details.records : [];
  const recordIds = referenceSet(records.map(record => record?.semantic_unit_id));
  const allNA = records.length > 0 && records.every(record => record?.status === 'not_applicable');
  if (allNA) add('SCIENTIFIC_APPLICABILITY_UNJUSTIFIED', '/scientific_details/records');
  for (const [i, record] of records.entries()) {
    const path = `/scientific_details/records/${i}`;
    if (!['assessed', 'not_applicable', 'not_assessable'].includes(record?.status) || !nonblank(record?.reason)) add('SCIENTIFIC_OBLIGATION_STATUS_INVALID', path);
    if (record?.status === 'assessed' && (!nonblank(record.finding) || record.content_present !== true || !nonemptyArray(record.source_block_ids))) {
      add('SCIENTIFIC_OBLIGATION_CONTENT_MISSING', path + '/finding');
      if (record?.obligation_id === 'SR-06') add('SCIENTIFIC_CORE_IDEA_MISSING', path + '/finding');
    }
    if (record?.status === 'not_applicable' && /^n\/?a$|^not applicable$/i.test(record.reason?.trim() ?? '')) add('SCIENTIFIC_APPLICABILITY_UNJUSTIFIED', path + '/reason');
    known(record?.source_block_ids, path + '/source_block_ids');
  }
  const statements = Array.isArray(details.statements) ? details.statements : [];
  const externalChecks = new Map((details.external_checks ?? []).map(row => [row?.check_id, row]));
  const snapshots = new Map((details.authorised_user_snapshots ?? []).map(row => [row?.snapshot_id, row]));
  for (const [i, statement] of statements.entries()) {
    const path = `/scientific_details/statements/${i}`;
    rejectUnknown(statement, ['statement_id', 'text', 'provenance', 'epistemic_status', 'source_block_ids', 'authorised_snapshot_id', 'asserted_as_established', 'presented_as_user', 'external_check_id', 'claim_asserted'], add, path);
    if (!statement || !['author', 'external', 'analyst', 'user'].includes(statement.provenance)
      || !['report', 'interpretation', 'hypothesis'].includes(statement.epistemic_status) || !nonblank(statement.text)) add('SCIENTIFIC_ATTRIBUTION_MISMATCH', path);
    known(statement?.source_block_ids, path + '/source_block_ids');
    if (statement?.provenance === 'user') {
      const snapshot = snapshots.get(statement.authorised_snapshot_id);
      if (!snapshot || !nonblank(snapshot.scope) || !nonemptyArray(snapshot.source_block_ids) || !nonblank(snapshot.snapshot_hash)
        || snapshot.source_block_ids.some(id => !blockIds.has(id)) || !statement.source_block_ids?.every(id => snapshot.source_block_ids.includes(id))) add('SCIENTIFIC_USER_SNAPSHOT_MISSING', path);
    }
    if (statement?.provenance !== 'user' && statement?.authorised_snapshot_id != null) add('SCIENTIFIC_ATTRIBUTION_MISMATCH', path + '/authorised_snapshot_id');
    if ((statement?.provenance === 'author' && statement?.epistemic_status === 'hypothesis' && statement?.asserted_as_established === true)
      || (statement?.provenance === 'analyst' && statement?.presented_as_user === true)) add('SCIENTIFIC_ATTRIBUTION_MISMATCH', path);
    if (statement?.provenance === 'external' && statement?.claim_asserted === true && externalChecks.get(statement.external_check_id)?.claim_verified !== true) add('SCIENTIFIC_CLAIM_VERIFICATION_UNBOUND', path + '/external_check_id');
  }
  const quantities = Array.isArray(details.quantities) ? details.quantities : [];
  const seenQuantities = new Set();
  for (const [i, q] of quantities.entries()) {
    const path = `/scientific_details/quantities/${i}`;
    rejectUnknown(q, ['quantity_id', 'record_id', 'source_block_id', 'metric_definition', 'raw_value', 'raw_precision', 'unit', 'denominator', 'groups', 'timepoint', 'analysis_set', 'uncertainty_type', 'uncertainty_value', 'source_occurrences'], add, path);
    const identity = [q?.metric_definition, q?.raw_value, q?.raw_precision, q?.unit, q?.denominator, ...(q?.groups ?? []), q?.timepoint, q?.analysis_set, q?.uncertainty_type, q?.uncertainty_value].join('|');
    if (!nonblank(q?.metric_definition) || !nonblank(q?.raw_value) || !nonblank(q?.raw_precision) || !nonblank(q?.unit) || !nonblank(q?.denominator) || !nonemptyArray(q?.groups) || !nonblank(q?.timepoint) || !nonblank(q?.analysis_set) || !nonblank(q?.uncertainty_type) || !nonblank(q?.uncertainty_value) || !nonemptyArray(q?.source_occurrences)) add('SCIENTIFIC_QUANTITY_CONTEXT_MISMATCH', path);
    for (const occurrence of q?.source_occurrences ?? []) {
      const block = sourceBlocks.get(occurrence?.source_block_id);
      const locationMatches = block && (locationContract === 'phase21-whole-paper-1.0'
        ? wholePaperScientificLocationKey(occurrence.native_locator ?? { ...occurrence, source_document_id: block.source_document_id }) === wholePaperScientificLocationKey(block.native_locator ?? block)
        : locationContract === 'phase21-native-workbook-1.0'
        ? nativeScientificLocationKey(occurrence.native_locator ?? { ...occurrence, source_document_id: block.source_document_id }) === nativeScientificLocationKey(block.native_locator ?? block)
        : occurrence.page_index === block.page_index);
      if (!block || occurrence.source_hash !== block.source_hash || !locationMatches || occurrence.block_id !== block.block_id || !nonblank(occurrence.raw_excerpt) || !block.text.includes(occurrence.raw_excerpt)
        || ['metric_definition', 'raw_value', 'raw_precision', 'unit', 'denominator', 'timepoint', 'analysis_set', 'uncertainty_type', 'uncertainty_value'].some(key => occurrence[key] !== q[key])
        || canonicalizeV3Json(occurrence.groups) !== canonicalizeV3Json(q.groups)) add('SCIENTIFIC_QUANTITY_CONTEXT_MISMATCH', path + '/source_occurrences');
    }
    if (seenQuantities.has(identity)) add('SCIENTIFIC_QUANTITY_DUPLICATE_IDENTITY', path); else seenQuantities.add(identity);
  }
  const claimIds = referenceSet(details.claims?.map(claim => claim?.claim_id));
  const matrix = Array.isArray(details.experiment_claim_matrix) ? details.experiment_claim_matrix : [];
  if (!matrix.length) add('SCIENTIFIC_CLAIM_CHAIN_INCOMPLETE', '/scientific_details/experiment_claim_matrix');
  for (const [i, row] of matrix.entries()) {
    const path = `/scientific_details/experiment_claim_matrix/${i}`;
    rejectUnknown(row, ['experiment_id', 'claim_id', 'source_block_ids', 'comparison_conditions', 'result', 'supported_scope', 'forbidden_stronger_interpretation'], add, path);
    if (!nonblank(row?.experiment_id) || !claimIds.has(row?.claim_id) || !nonemptyArray(row?.source_block_ids) || !['comparison_conditions', 'result', 'supported_scope', 'forbidden_stronger_interpretation'].every(key => nonblank(row?.[key]))) add('SCIENTIFIC_CLAIM_CHAIN_INCOMPLETE', path);
    known(row?.source_block_ids, path + '/source_block_ids');
  }
  const explanationIds = new Set();
  for (const [i, row] of (details.explanations ?? []).entries()) {
    const path = `/scientific_details/explanations/${i}`;
    rejectUnknown(row, ['explanation_id', 'concept_record_id', 'meaning_plain', 'role_in_this_paper', 'interpretation_boundary', 'illustrative', 'source_block_ids', 'full_term'], add, path);
    if (!nonblank(row?.explanation_id) || explanationIds.has(row.explanation_id) || !recordIds.has(row?.concept_record_id) || !['meaning_plain', 'role_in_this_paper', 'interpretation_boundary'].every(key => nonblank(row?.[key]))) add('SCIENTIFIC_EXPLANATION_MISSING', path);
    explanationIds.add(row?.explanation_id);
    known(row?.source_block_ids, path + '/source_block_ids');
    if (row?.illustrative === true && nonemptyArray(row.source_block_ids)) add('SCIENTIFIC_ILLUSTRATION_AS_EVIDENCE', path);
    if (row?.illustrative !== true && !nonemptyArray(row?.source_block_ids)) add('SCIENTIFIC_EXPLANATION_MISSING', path + '/source_block_ids');
  }
  for (const [i, row] of (details.research_candidates ?? []).entries()) { const path = `/scientific_details/research_candidates/${i}`; rejectUnknown(row, ['candidate_id', 'gap', 'hypothesis', 'delta', 'verification_method', 'failure_condition', 'source_block_ids'], add, path); if (!['gap', 'hypothesis', 'delta', 'verification_method', 'failure_condition'].every(key => nonblank(row?.[key])) || !nonemptyArray(row?.source_block_ids)) add('SCIENTIFIC_CANDIDATE_GATE_FAILED', path); known(row?.source_block_ids, path + '/source_block_ids'); }
  for (const [i, row] of (details.inventory ?? []).entries()) {
    const path = `/scientific_details/inventory/${i}`;
    rejectUnknown(row, ['inventory_id', 'kind', 'status', 'affected_ids', 'source_block_ids'], add, path);
    known(row?.source_block_ids, path + '/source_block_ids');
    if (row?.status === 'missing' && (!nonemptyArray(row.affected_ids) || !status?.affected_ids?.every(id => recordIds.has(id)))) add('SCIENTIFIC_INVENTORY_GAP_UNSCOPED', path);
    if (row?.status === 'missing' && status?.completeness === 'complete') add('SCIENTIFIC_INVENTORY_BLOCKS_COMPLETE', path);
  }
  for (const [i, row] of (details.external_checks ?? []).entries()) {
    const path = `/scientific_details/external_checks/${i}`;
    rejectUnknown(row, ['check_id', 'metadata_verified', 'claim_verified', 'source_block_ids'], add, path);
    known(row?.source_block_ids, path + '/source_block_ids');
    if (row?.claim_verified === true && !nonemptyArray(row.source_block_ids)) add('SCIENTIFIC_CLAIM_VERIFICATION_UNBOUND', path);
  }
  for (const [i, row] of (details.source_conflicts ?? []).entries()) {
    const path = `/scientific_details/source_conflicts/${i}`;
    rejectUnknown(row, ['conflict_id', 'quantity_id', 'disclosed', 'locator_ids', 'occurrences', 'limited_conclusion'], add, path);
    const conflictsQuantity = quantities.find(quantity => quantity.quantity_id === row?.quantity_id);
    const occurrences = row?.occurrences;
    if (!row?.disclosed || !conflictsQuantity || !nonemptyArray(row.locator_ids) || row.locator_ids.length < 2 || !nonemptyArray(occurrences) || occurrences.length < 2 || !nonblank(row.limited_conclusion)
      || occurrences.some(occurrence => !blockIds.has(occurrence?.source_block_id) || !nonblank(occurrence?.raw_value) || !sourceBlocks.get(occurrence.source_block_id).text.includes(occurrence.raw_value))
      || new Set(occurrences.map(occurrence => occurrence.raw_value)).size < 2
      || canonicalizeV3Json([...row.locator_ids].sort()) !== canonicalizeV3Json([...occurrences.map(occurrence => occurrence.source_block_id)].sort())) add('SCIENTIFIC_SOURCE_CONFLICT_HIDDEN', path);
    known(row?.locator_ids, path + '/locator_ids');
  }
}

function sameJson(a, b) { return canonicalizeV3Json(a) === canonicalizeV3Json(b); }

/** Shared content checks on schema-validated data. No audit or acceptance is manufactured. */
export function validateScientificContent(details, boundary, add, locationContract) {
  validateDetailClosure(details, boundary, add, locationContract);
  validateReadingQuality(details, add, locationContract);
  const manifest = deriveManifest(details, add);
  if (!Array.isArray(details.required_semantic_units) || !sameJson(manifest, details.required_semantic_units)) {
    add('REQUIRED_SEMANTIC_MANIFEST_MISMATCH', '/scientific_details/required_semantic_units');
  }
  for (const [key, oldVersion] of Object.entries(ACTIVE_VERSIONS)) {
    const expectedVersion = key === 'scientific_schema_version' && locationContract === 'phase21-whole-paper-1.0' ? 'phase21/scientific-details@whole-paper-1.0' : key === 'scientific_schema_version' && locationContract === 'phase21-native-workbook-1.0' ? 'phase21/scientific-details@native-workbook-1.0' : oldVersion;
    const value = details[key];
    if (typeof value !== 'string' || !/\S/.test(value)) add('SCIENTIFIC_RULE_VERSION_MISSING', '/scientific_details/' + key);
    else if (value !== expectedVersion) add('SCIENTIFIC_RULE_VERSION_UNTRUSTED', '/scientific_details/' + key);
  }
  return manifest;
}

/** A separately loaded development contract; it never mutates data or authorizes publication. */
export async function createScientificQualityValidator() {
  return { validate: validateScientificPackage };
}

/** Validates the whole frozen boundary plus scientific details and audit as one input. */
export function validateScientificPackage(candidate) {
  const errors = [];
  try { canonicalizeV3Json(candidate); } catch { safeError(errors, 'SCIENTIFIC_STRUCTURE_INVALID', '/'); return response(errors); }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) { safeError(errors, 'SCIENTIFIC_STRUCTURE_INVALID', '/'); return response(errors); }
  for (const key of ['contract_version', 'identity', 'boundary_package', 'scientific_details', 'scientific_audit', 'bindings']) {
    if (!Object.hasOwn(candidate, key)) safeError(errors, 'SCIENTIFIC_COMPLETE_INPUT_REQUIRED', '/' + key);
  }
  if (errors.length) return response(errors);
  if (!validateScientificShape(candidate)) {
    for (const error of validateScientificShape.errors ?? []) {
      let code = 'SCIENTIFIC_STRUCTURE_INVALID';
      let path = error.instancePath || '/';
      if (error.keyword === 'required' && path === '/scientific_details' && Object.hasOwn(ACTIVE_VERSIONS, error.params.missingProperty)) {
        code = 'SCIENTIFIC_RULE_VERSION_MISSING'; path += '/' + error.params.missingProperty;
      } else if (error.keyword === 'const' && path.startsWith('/scientific_details/') && Object.hasOwn(ACTIVE_VERSIONS, path.split('/').at(-1))) {
        code = 'SCIENTIFIC_RULE_VERSION_UNTRUSTED';
      } else if (error.keyword === 'minItems' && /^\/scientific_audit\/dimensions\/\d+\/target_ids$/.test(path)) {
        code = 'SCIENTIFIC_AUDIT_TARGET_MISSING';
      } else if (path.startsWith('/scientific_details/quantities/')) {
        code = 'SCIENTIFIC_QUANTITY_CONTEXT_MISMATCH';
      } else if (path.startsWith('/scientific_details/experiment_claim_matrix/')) {
        code = 'SCIENTIFIC_CLAIM_CHAIN_INCOMPLETE';
      } else if (path.startsWith('/scientific_details/explanations/')) {
        code = 'SCIENTIFIC_EXPLANATION_MISSING';
      } else if (path.startsWith('/scientific_details/statements/')) {
        code = 'SCIENTIFIC_ATTRIBUTION_MISMATCH';
      } else if (path.startsWith('/scientific_details/inventory/')) {
        code = 'SCIENTIFIC_INVENTORY_GAP_UNSCOPED';
      } else if (path.startsWith('/scientific_details/research_candidates/')) {
        code = 'SCIENTIFIC_CANDIDATE_GATE_FAILED';
      } else if (path.startsWith('/scientific_details/records/')) {
        const index = Number(path.split('/')[3]);
        code = candidate.scientific_details?.records?.[index]?.obligation_id === 'SR-06' ? 'SCIENTIFIC_CORE_IDEA_MISSING' : 'SCIENTIFIC_OBLIGATION_CONTENT_MISSING';
      }
      safeError(errors, code, path);
    }
    return response(errors);
  }
  if (!candidate.identity || typeof candidate.identity !== 'object' || Array.isArray(candidate.identity)) { safeError(errors, 'SCIENTIFIC_IDENTITY_MISMATCH', '/identity'); return response(errors); }
  const boundary = validateV3Package(candidate.boundary_package);
  if (!boundary.ok) { safeError(errors, 'FROZEN_BOUNDARY_INVALID', '/boundary_package'); return response(errors); }
  const b = candidate.boundary_package;
  if (candidate.identity.paper_id !== b.source_package.paper_id || candidate.identity.run_id !== b.run_id || candidate.identity.analysis_revision !== b.analysis_revision) {
    safeError(errors, 'SCIENTIFIC_IDENTITY_MISMATCH', '/identity');
  }
  const manifest = validateScientificContent(candidate.scientific_details, b, (code, path) => safeError(errors, code, path));
  const declared = candidate.scientific_details.required_semantic_units;
  const expected = {
    boundary_package_hash: digest(b),
    source_package_hash: digest(b.source_package),
    scientific_details_hash: digest(candidate.scientific_details),
    required_semantic_units_hash: digest(declared),
  };
  const versions = Object.fromEntries(Object.keys(ACTIVE_VERSIONS).filter(key => key !== 'source_inventory_version').map(key => [key, candidate.scientific_details?.[key]]));
  if (errors.length) return response(errors);
  const expectedFingerprint = digest({ contract_version: candidate.contract_version, identity: candidate.identity, ...expected, ...versions });
  for (const [key, value] of Object.entries(expected)) if (candidate.bindings[key] !== value) safeError(errors, 'SCIENTIFIC_BINDING_STALE', '/bindings/' + key);
  if (candidate.bindings.scientific_input_fingerprint !== expectedFingerprint) safeError(errors, 'SCIENTIFIC_BINDING_STALE', '/bindings/scientific_input_fingerprint');
  const audit = candidate.scientific_audit;
  if (audit.input_fingerprint !== expectedFingerprint) safeError(errors, 'SCIENTIFIC_AUDIT_STALE', '/scientific_audit/input_fingerprint');
  const auditProjection = { ...audit }; delete auditProjection.audit_hash;
  if (audit.audit_hash !== digest(auditProjection)) safeError(errors, 'SCIENTIFIC_AUDIT_STALE', '/scientific_audit/audit_hash');
  const requiredIds = new Set(manifest.map(row => row.semantic_unit_id));
  const targeted = new Set();
  if (!Array.isArray(audit.dimensions)) safeError(errors, 'SCIENTIFIC_AUDIT_INVALID', '/scientific_audit/dimensions');
  else {
    const dimensions = new Set();
    let hasBlock = false, hasFlag = false;
    for (const [index, dimension] of audit.dimensions.entries()) {
    const path = `/scientific_audit/dimensions/${index}`;
    if (!dimension || typeof dimension !== 'object' || !/^AUD-[0-9]{2}$/.test(dimension.dimension_id) || dimensions.has(dimension.dimension_id)
      || !['pass', 'flag', 'block'].includes(dimension.verdict) || typeof dimension.reason !== 'string' || !/\S/.test(dimension.reason)
      || !Array.isArray(dimension.target_ids) || !Array.isArray(dimension.evidence_ids) || typeof dimension.checker_kind !== 'string') safeError(errors, 'SCIENTIFIC_AUDIT_INVALID', path);
    else { dimensions.add(dimension.dimension_id); const withinDimension = new Set(); for (const id of dimension.target_ids) { if (withinDimension.has(id)) safeError(errors, 'SCIENTIFIC_AUDIT_TARGET_DUPLICATE', path + '/target_ids'); withinDimension.add(id); if (!requiredIds.has(id)) safeError(errors, 'SCIENTIFIC_AUDIT_TARGET_UNKNOWN', path + '/target_ids'); targeted.add(id); } hasBlock ||= dimension.verdict === 'block'; hasFlag ||= dimension.verdict === 'flag'; }
    }
    const expectedVerdict = hasBlock ? 'block' : hasFlag ? 'flag' : 'pass';
    if (audit.verdict !== expectedVerdict) safeError(errors, 'SCIENTIFIC_AUDIT_VERDICT_INVALID', '/scientific_audit/verdict');
    if (hasBlock) safeError(errors, 'SCIENTIFIC_AUDIT_BLOCK', '/scientific_audit/dimensions');
  }
  for (const id of requiredIds) if (!targeted.has(id)) safeError(errors, 'SCIENTIFIC_AUDIT_TARGET_MISSING', '/scientific_audit/dimensions');
  return response(errors, expectedFingerprint);
}
