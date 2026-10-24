import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { createPhase21ContractValidator, validatePhase21Record } from './phase21-contract-loader.mjs';
import { canonicalizeV3Json } from './semantic-package-validator.mjs';
import { createParserRunRecord, deriveParserRunIdentity, deriveWorkbookParserRunIdentity } from './parser-adapter.mjs';
import {deriveGroupedReviewedRun,applyGroupedReviewedComparison} from './grouped-source-comparison.mjs';
import {deriveCaseReviewedRun,applyCaseReviewedComparison} from './case-source-comparison.mjs';
import {deriveSnfReviewedRun,applySnfReviewedComparison} from './snf-source-comparison.mjs';
import {deriveSnfGlyphReviewedRun,applySnfGlyphComparison} from './snf-glyph-comparison.mjs';
import { hasArchiveMethod, hasArchiveSources, bindArchiveRepresentation } from './archive-representation.mjs';
import { compareOfficeOriginalRuns } from './office-original-comparison.mjs';
import {compareWholePaperParserRuns} from './whole-paper-comparison.mjs';

const parserRunSchemaUrl = new URL('../../Schema/phase21/parser-run.schema.json', import.meta.url);
const goldManifestSchemaUrl = new URL('../../Schema/phase21/gold-manifest.schema.json', import.meta.url);
const acceptedReferenceSchemaUrl = new URL('../../Schema/phase21/accepted-reference.schema.json', import.meta.url);
const parserRunSchema = JSON.parse(await readFile(parserRunSchemaUrl, 'utf8'));
const goldManifestSchema = JSON.parse(await readFile(goldManifestSchemaUrl, 'utf8'));
const acceptedReferenceSchema = JSON.parse(await readFile(acceptedReferenceSchemaUrl, 'utf8'));
const phase21Validator = await createPhase21ContractValidator({ schemas: [parserRunSchema, goldManifestSchema, acceptedReferenceSchema] });
const workbookSchema = JSON.parse(await readFile(new URL('../../Schema/phase21/native-workbook.schema.json',import.meta.url),'utf8'));
const workbookValidator = await createPhase21ContractValidator({schemas:[workbookSchema]});

const CATEGORIES = ['text', 'table', 'formula', 'citation', 'figure', 'attachment', 'locator'];
const hash = value => 'sha256:' + createHash('sha256').update(canonicalizeV3Json(value)).digest('hex');
const stableSort = values => [...values].sort((left, right) => String(left).localeCompare(String(right)));
const locatorKey = locator => canonicalizeV3Json(locator);
const sameLocator = (left, right) => locatorKey(left) === locatorKey(right);
const normalizeText = value => String(value ?? '').replace(/\s+/g, ' ').trim();

function runFingerprint(run) {
  // A validated parser-run is a complete comparison input. Do not curate a
  // shorter list here: an omitted validated field could alter output, reuse,
  // approval, or resource semantics without invalidating the identity.
  return hash(run);
}

function sourceDocumentMap(sources) {
  return [...sources].map(source => ({
    document_id: source.document_id,
    role: source.role,
    critical: source.critical,
    availability: source.availability,
    source_sha256: source.source_sha256,
  })).sort((a, b) => a.document_id.localeCompare(b.document_id));
}

function plainError(result, prefix) {
  return result.ok ? [] : result.errors.map(error => `${prefix}:${error}`);
}

function validateIndependentGold(manifest) {
  const result = validatePhase21Record(phase21Validator, 'phase21/gold-manifest', manifest);
  const errors = plainError(result, 'GOLD_SCHEMA_INVALID');
  if (!result.ok) return { ok: false, errors: stableSort(errors) };
  const declaredSources = sourceDocumentMap(manifest.source_document_map);
  if (new Set(declaredSources.map(source => source.document_id)).size !== declaredSources.length) errors.push('GOLD_SOURCE_DOCUMENT_DUPLICATE');
  if (manifest.input_fingerprint !== hash(declaredSources)) errors.push('GOLD_INPUT_SOURCE_MAP_FINGERPRINT_MISMATCH');
  for (const item of manifest.items) {
    if (item.document_id !== item.locator.document_id) errors.push(`GOLD_DOCUMENT_LOCATOR_MISMATCH:${item.evidence_id}`);
    if (item.independent_input_fingerprint !== manifest.input_fingerprint) errors.push(`GOLD_INPUT_FINGERPRINT_MISMATCH:${item.evidence_id}`);
  }
  return { ok: errors.length === 0, errors: stableSort(errors) };
}

/** Validates declared independence; offline fields never authenticate a human review. */
export function validateGoldManifest(manifest) {
  return validateIndependentGold(manifest);
}

/** Validates declared provenance and coverage, not the authenticity of acceptance or scientific truth. */
export function validateAcceptedReferenceManifest(manifest) {
  const result = validatePhase21Record(phase21Validator, 'phase21/accepted-reference', manifest);
  const errors = plainError(result, 'REFERENCE_SCHEMA_INVALID');
  if (!result.ok) return { ok: false, errors: stableSort(errors) };
  const declaredSources = sourceDocumentMap(manifest.source_document_map);
  const sources = new Map(declaredSources.map(source => [source.document_id, source]));
  if (sources.size !== declaredSources.length) errors.push('REFERENCE_SOURCE_DOCUMENT_DUPLICATE');
  if (manifest.input_fingerprint !== hash(declaredSources)) errors.push('REFERENCE_INPUT_SOURCE_MAP_FINGERPRINT_MISMATCH');
  for (const source of declaredSources) {
    if (source.availability === 'available' && source.source_sha256 === null) errors.push(`REFERENCE_AVAILABLE_SOURCE_BYTES_UNKNOWN:${source.document_id}`);
  }
  const evidenceIds = new Set();
  for (const item of manifest.items) {
    if (evidenceIds.has(item.evidence_id)) errors.push(`REFERENCE_EVIDENCE_ID_DUPLICATE:${item.evidence_id}`);
    evidenceIds.add(item.evidence_id);
    if (item.document_id !== item.locator.document_id) errors.push(`REFERENCE_DOCUMENT_LOCATOR_MISMATCH:${item.evidence_id}`);
    if (!sources.has(item.document_id)) errors.push(`REFERENCE_ITEM_SOURCE_MISSING:${item.evidence_id}`);
    else if (sources.get(item.document_id).availability !== 'available') errors.push(`REFERENCE_ITEM_SOURCE_UNAVAILABLE:${item.evidence_id}`);
  }
  const dispositions = new Map();
  for (const entry of manifest.scope.category_dispositions) {
    if (dispositions.has(entry.category)) errors.push(`REFERENCE_CATEGORY_DUPLICATE:${entry.category}`);
    dispositions.set(entry.category, entry.disposition);
  }
  for (const category of CATEGORIES) {
    const count = manifest.items.filter(item => item.category === category).length;
    const disposition = dispositions.get(category);
    if (!disposition) errors.push(`REFERENCE_CATEGORY_UNDECLARED:${category}`);
    else if (disposition === 'covered' && count === 0) errors.push(`REFERENCE_COVERED_CATEGORY_EMPTY:${category}`);
    else if (disposition === 'inapplicable' && count > 0) errors.push(`REFERENCE_APPLICABLE_CATEGORY_MARKED_INAPPLICABLE:${category}`);
    else if (disposition === 'uncovered') errors.push(`REFERENCE_CATEGORY_UNCOVERED:${category}`);
  }
  if (manifest.scope.status !== 'complete') errors.push('REFERENCE_SCOPE_INCOMPLETE');
  if (manifest.scope.uncovered_items.length) errors.push('REFERENCE_ITEMS_UNCOVERED');
  const itemAccess = manifest.items.map(item => item.parser_output_access);
  const aggregateAccess = itemAccess.includes('used') ? 'used' : itemAccess.includes('unknown') ? 'unknown' : 'not_used';
  if (manifest.method.parser_output_access !== aggregateAccess) errors.push('REFERENCE_METHOD_ACCESS_MISMATCH');
  const sourceAccess = manifest.items.map(item => item.source_access);
  const aggregateSourceAccess = sourceAccess.includes('not_used') ? 'not_used' : sourceAccess.includes('unknown') ? 'unknown' : 'used';
  if (manifest.method.source_access !== aggregateSourceAccess) errors.push('REFERENCE_METHOD_SOURCE_ACCESS_MISMATCH');
  const aggregateVerification = manifest.items.some(item => item.verification === 'user_and_assisted') ? 'user_and_assisted' : 'assisted';
  if (manifest.method.verification !== aggregateVerification) errors.push('REFERENCE_METHOD_VERIFICATION_MISMATCH');
  return { ok: errors.length === 0, errors: stableSort(errors) };
}

function validateSourceMap(baselineRun, candidateRun) {
  const errors = [];
  const baselineSources = new Map(sourceDocumentMap(baselineRun.sources).map(source => [source.document_id, source]));
  const candidateSources = new Map(sourceDocumentMap(candidateRun.sources).map(source => [source.document_id, source]));
  if (baselineSources.size !== candidateSources.size) errors.push('SOURCE_DOCUMENT_SET_MISMATCH');
  for (const [documentId, source] of baselineSources) {
    if (!candidateSources.has(documentId)) errors.push(`SOURCE_DOCUMENT_MISSING:${documentId}`);
    else if (candidateSources.get(documentId).source_sha256 !== source.source_sha256) errors.push(`SOURCE_BYTES_MISMATCH:${documentId}`);
    else if (canonicalizeV3Json(candidateSources.get(documentId)) !== canonicalizeV3Json(source)) errors.push(`SOURCE_DESCRIPTOR_MISMATCH:${documentId}`);
  }
  return stableSort(errors);
}

function validateGoldSourceMap(goldManifest, baselineRun, candidateRun, label = 'GOLD') {
  const errors = [];
  const expected = new Map(sourceDocumentMap(baselineRun.sources).map(source => [source.document_id, source]));
  const candidate = new Map(sourceDocumentMap(candidateRun.sources).map(source => [source.document_id, source]));
  const gold = new Map(sourceDocumentMap(goldManifest.source_document_map).map(source => [source.document_id, source]));
  if (gold.size !== expected.size) errors.push(`${label}_SOURCE_DOCUMENT_SET_MISMATCH`);
  for (const [documentId, source] of expected) {
    const goldSource = gold.get(documentId);
    if (!goldSource) {
      errors.push(`${label}_SOURCE_DOCUMENT_MISSING:${documentId}`);
      continue;
    }
    if (goldSource.source_sha256 !== source.source_sha256) errors.push(`${label}_SOURCE_BYTES_MISMATCH:${documentId}`);
    if (canonicalizeV3Json(goldSource) !== canonicalizeV3Json(source)) errors.push(`${label}_SOURCE_DESCRIPTOR_MISMATCH:${documentId}`);
    const candidateSource = candidate.get(documentId);
    if (!candidateSource || candidateSource.source_sha256 !== goldSource.source_sha256 || canonicalizeV3Json(candidateSource) !== canonicalizeV3Json(goldSource)) errors.push(`${label}_SOURCE_CANDIDATE_MISMATCH:${documentId}`);
  }
  return stableSort(errors);
}

function validateParserEligibility(run, label) {
  const errors = [];
  if (run.candidate_eligibility?.eligible !== true) errors.push(`${label}_PARSER_RUN_INELIGIBLE`);
  for (const blocker of run.candidate_eligibility?.blockers ?? []) errors.push(`${label}_PARSER_BLOCKER:${blocker}`);
  for (const error of run.errors ?? []) {
    if (['MISSING_CRITICAL_INPUT', 'MISSING_CRITICAL_PARSE'].includes(error.code)) errors.push(`${label}_CRITICAL_PARSER_ERROR:${error.code}:${error.document_id}`);
  }
  return stableSort(errors);
}

function locatorMaps(policy) {
  if (!policy || typeof policy !== 'object' || policy.policy_version === undefined || policy.central_evidence_rule !== 'reject' || !Array.isArray(policy.locator_maps)) {
    return { ok: false, errors: ['COMPARISON_POLICY_INVALID'], maps: [] };
  }
  const errors = [];
  for (const mapping of policy.locator_maps) {
    if (!mapping || !['split', 'merge'].includes(mapping.kind) || !mapping.gold_locator || !Array.isArray(mapping.baseline_locators) || !Array.isArray(mapping.candidate_locators) || mapping.baseline_locators.length === 0 || mapping.candidate_locators.length === 0) {
      errors.push('LOCATOR_MAP_INVALID');
      continue;
    }
    const documentId = mapping.gold_locator.document_id;
    if (![...mapping.baseline_locators, ...mapping.candidate_locators].every(locator => locator?.document_id === documentId)) errors.push('LOCATOR_MAP_DOCUMENT_MISMATCH');
  }
  return { ok: errors.length === 0, errors: stableSort(errors), maps: policy.locator_maps };
}

function locatorCandidates(item, mappings, side) {
  const direct = [item.locator];
  for (const mapping of mappings) {
    if (sameLocator(mapping.gold_locator, item.locator)) direct.push(...mapping[`${side}_locators`]);
  }
  return direct;
}

function matchedBlocks(run, item, mappings, side) {
  const candidates = locatorCandidates(item, mappings, side);
  return run.blocks.filter(block => candidates.some(candidate => sameLocator(block.locator, candidate)));
}

function itemObservation(run, item, mappings, side) {
  const blocks = matchedBlocks(run, item, mappings, side);
  if (blocks.length === 0) return { outcome: 'missing', blocks: [] };
  const semantic = normalizeText(blocks.map(block => block.text).join(' '));
  if (semantic !== normalizeText(item.expected_semantic_unit)) return { outcome: 'wrong_semantic_unit', blocks };
  const direct = blocks.some(block => sameLocator(block.locator, item.locator));
  return { outcome: direct ? 'matched' : 'segmented_match', blocks };
}

const unitTextHash = text => 'sha256:' + createHash('sha256').update(text).digest('hex');
const exactUnitKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function requireReview(condition, detail) {
  if (!condition) throw new Error('REVIEWED_BINDING_INVALID:' + detail);
}

// Verifies supplied records and their declared bytes, not reviewer independence or user authority.
function reviewBinding(binding, parent) {
  requireReview(binding?.version === 'source-review-binding-1', 'version');
  const { version, fingerprint, ...payload } = binding;
  requireReview(fingerprint === hash(payload), 'fingerprint');
  const { materials, revision, review } = binding;
  requireReview(hash(JSON.parse(binding.revision_bytes)) === hash(revision)
    && hash(JSON.parse(binding.review_bytes)) === hash(review), 'review-bytes');
  requireReview(binding.parent_fingerprint === hash(parent), 'parent');
  requireReview(Array.isArray(materials?.cases) && materials.cases.length > 0
    && Array.isArray(revision?.cases) && Array.isArray(review?.cases)
    && Array.isArray(revision.unresolved) && Array.isArray(review.unresolved), 'complete-records');
  const ids = records => records.map(x => x.case_id).sort();
  requireReview(new Set(ids(materials.cases)).size === materials.cases.length
    && hash(ids(materials.cases)) === hash(ids(revision.cases))
    && hash(ids(materials.cases)) === hash(ids(review.cases)), 'problem-list');
  requireReview(materials.paper_id === revision.paper_id && revision.paper_id === review.paper_id, 'paper');
  requireReview(parent.sources.every(source => materials.source_files.some(file =>
    'sha256:' + file.sha256.replace(/^sha256:/, '') === source.source_sha256)), 'sources');
  for (const entry of materials.cases) {
    const first = revision.cases.find(x => x.case_id === entry.case_id);
    const second = review.cases.find(x => x.case_id === entry.case_id);
    requireReview(['representation_only','content_error','unresolved'].includes(first.candidate_class)
      && first.candidate_class === second.candidate_class_reviewed, 'classification');
    requireReview(Array.isArray(entry.candidate_blocks) && entry.candidate_blocks.length > 0, 'reviewed-blocks');
    for (const block of entry.candidate_blocks)
      requireReview(hash(parent.blocks.find(x => x.id === block.id) ?? null) === hash(block), 'reviewed-block');
    const pages = first.physical_pages ?? [first.physical_page];
    requireReview(hash(pages) === hash(second.physical_pages ?? [second.physical_page])
      && pages.every(page => Number.isInteger(page) && entry.candidate_blocks.some(b => b.locator.page_number === page)), 'page');
    for (const record of [revision, review]) for (const physicalPage of pages)
      requireReview(record.viewed_source_pages?.some(page => page.physical_page === physicalPage && page.viewed === true
        && materials.source_files.some(file => file.path.replaceAll('\\','/').endsWith(page.path))), 'source-page');
  }
  return materials.cases;
}

/** One source-reviewed correction; keeps historical backend, assets and resources intact. */
export function deriveReviewedParserRun(proof) {
  if (proof?.version === 'reviewed-derivation-6') return deriveSnfGlyphReviewedRun(proof);
  if (proof?.version === 'reviewed-derivation-5') return deriveSnfReviewedRun(proof);
  if (proof?.version === 'reviewed-derivation-4') return deriveCaseReviewedRun(proof);
  if (proof?.version === 'reviewed-derivation-3') return deriveGroupedReviewedRun(proof);
  if (proof?.version === 'reviewed-derivation-2') return deriveSourceReviewedRunV2(proof);
  requireReview(proof?.version === 'reviewed-derivation-1', 'derivation-version');
  requireReview(exactUnitKeys(proof,['version','parent_run','patch','source_review_binding','approval']), 'one-derivation');
  const { parent_run: parent, patch, source_review_binding: binding, approval } = proof;
  reviewBinding(binding, parent);
  requireReview(typeof approval?.id === 'string' && approval.id.length > 0
    && approval.scope === 'single-reviewed-correction-offline', 'approval');
  const proposal = binding.revision.proposed_corrections?.find(x => x.case_id === patch?.case_id);
  const checked = binding.review.correction_reviews?.find(x => x.case_id === patch?.case_id);
  const issue = binding.revision.cases.find(x => x.case_id === patch?.case_id);
  requireReview(patch && Object.keys(patch).every(key => ['case_id','block_id','side','original_block_text','replacement_text',
    'changed_span','source_basis','application_status','original_locator','original_text_sha256','replacement_text_sha256',
    'source_revision_sha256','source_review_sha256','review_scope'].includes(key))
    && exactUnitKeys(patch.changed_span,['from','to']), 'one-patch');
  requireReview(proposal && checked?.status === 'verified' && issue?.candidate_class === 'content_error', 'correction-review');
  requireReview(patch.side === 'candidate' && patch.block_id === proposal.block_id && patch.block_id === checked.block_id
    && patch.original_block_text === proposal.original_block_text && patch.replacement_text === proposal.replacement_text
    && hash(patch.changed_span) === hash(proposal.changed_span) && hash(patch.changed_span) === hash(checked.changed_span), 'patch');
  requireReview(patch.source_revision_sha256 === unitTextHash(binding.revision_bytes)
    && patch.source_review_sha256 === unitTextHash(binding.review_bytes), 'patch-review-bytes');
  const matches = parent.blocks.filter(b => b.id === patch.block_id);
  requireReview(matches.length === 1, 'patch-target');
  const block = matches[0], { from, to } = patch.changed_span;
  requireReview(typeof from === 'string' && from.length > 0 && typeof to === 'string' && to.length > 0 && from !== to
    && block.text.split(from).length === 2 && block.text.replace(from,to) === patch.replacement_text
    && block.text === patch.original_block_text && sameLocator(block.locator,patch.original_locator)
    && unitTextHash(block.text) === patch.original_text_sha256
    && unitTextHash(patch.replacement_text) === patch.replacement_text_sha256, 'patch-span');
  const run = createParserRunRecord(parent);
  run.blocks.find(b => b.id === patch.block_id).text = patch.replacement_text;
  run.normalization_version = parent.normalization_version + '+reviewed-1';
  run.config_fingerprint = hash({ parent_fingerprint: hash(parent), proof_fingerprint: hash(proof) });
  run.approval_fingerprint = hash(approval);
  run.parser_run_id = deriveParserRunIdentity(run);
  requireReview(run.parser_run_id !== parent.parser_run_id, 'new-identity');
  return run;
}

// Opt-in finite source-reviewed forms. This is notation parsing, not algebraic simplification.
function sourceMathV2(raw, kind) {
  if (typeof raw !== 'string' || /[§]/u.test(raw)) throw new Error('math-input');
  let s = raw.trim().replace(/^\$\$?\s*|\s*\$\$?$/g, '');
  const supers = {'ᵐ':'m','ᵀ':'T','ᵏ':'k','ᵃ':'a','⁰':'0','¹':'1','²':'2'};
  const subs = {'₀':'0','₁':'1','₂':'2','ₖ':'k','ₘ':'m','ₙ':'n'};
  s = s.replace(/[ᵐᵀᵏᵃ⁰¹²]+/gu, x => '^{'+[...x].map(c=>supers[c]).join('')+'}')
    .replace(/[₀₁₂ₖₘₙ]+/gu, x => '_{'+[...x].map(c=>subs[c]).join('')+'}');
  const commands = {epsilon:'ε',alpha:'α',theta:'θ',in:'∈',times:'×',mid:'|',cdots:'…',ldots:'…'};
  function expand(text) {
    let out='',i=0;
    const space=()=>{while(/\s/.test(text[i]??'')&&i<text.length)i++;};
    const argument=()=>{space();if(text[i]!=='{'){if(!/[A-Za-z01]/.test(text[i]??''))throw new Error('math-argument');return text[i++];}
      const begin=++i;let depth=1;while(i<text.length&&depth){if(text[i]==='{')depth++;if(text[i]==='}')depth--;i++;}if(depth)throw new Error('math-braces');return expand(text.slice(begin,i-1));};
    while(i<text.length){if(text[i]!=='\\'){out+=text[i++];continue;}i++;if(['{','}'].includes(text[i])){out+=text[i++];continue;}const m=text.slice(i).match(/^[A-Za-z]+/);if(!m)throw new Error('math-command');const command=m[0];i+=command.length;
      if(Object.hasOwn(commands,command))out+=commands[command];
      else if(command==='mathbf')out+=argument();
      else if(command==='mathbb'){const a=argument().trim();if(!['R','N','1'].includes(a))throw new Error('math-domain');out+=a==='N'?'ℕ':a;}
      else if(command==='mathcal'){if(argument().trim()!=='N')throw new Error('math-distribution');out+='𝒩';}
      else if(command==='hat'){if(argument().replace(/\s/g,'')!=='Y')throw new Error('math-hat');out+='§hatY';}
      else if(command==='frac'){const a=argument().replace(/\s/g,''),b=argument().replace(/\s/g,'');if(!/^\d+$/.test(a)||!/^α(?:\^\{?\d+\}?)?$/.test(b))throw new Error('math-fraction');out+=a+'/'+b;}
      else throw new Error('math-command');
    }return out;
  }
  s=expand(s).replace(/\s/g,'').replaceAll('ℝ','R').replaceAll('−','-').replaceAll('Ŷ','§hatY').replace(/(?:\.\.\.|···|⋯)/g,'…');
  function scripts(text){let out='',i=0;while(i<text.length){const atom=text[i++];out+=atom;if(!/[A-Za-z0-9αθε]/u.test(atom))continue;const values={};
    while(text[i]==='_'||text[i]==='^'){const op=text[i++];if(Object.hasOwn(values,op))throw new Error('math-repeated-script');let value='';
      if(text[i]==='{'||text[i]==='('){const open=text[i++],close=open==='{'?'}':')',begin=i;let depth=1;while(i<text.length&&depth){if(text[i]===open)depth++;if(text[i]===close)depth--;i++;}if(depth)throw new Error('math-script');value=scripts(text.slice(begin,i-1));}
      else{const m=text.slice(i).match(/^[A-Za-z0-9]+/);if(!m)throw new Error('math-script');value=m[0];i+=value.length;}
      if(op==='_'&&/^[A-Za-z],[A-Za-z]$/.test(value))value=value.replace(',','');values[op]=value;
    }if(values._!==undefined)out+='_{'+values._+'}';if(values['^']!==undefined)out+='^{'+values['^']+'}';
  }return out;}
  s=scripts(s);
  let match;
  if(kind==='factorization') {match=s.match(/^([A-Za-z])\^\{([A-Za-z])\}=([A-Za-z])([A-Za-z])\^\{([A-Za-z])T\}([+-])([αθε])\^\{([A-Za-z])\}$/);if(match)return {kind,terms:match.slice(1),transpose:true};}
  if(kind==='factor-matrix'){match=s.match(/^([A-Za-z])=\[([A-Za-z])_\{([A-Za-z]{2})\}\]∈R\^\{([A-Za-z])×([A-Za-z])\}$/);if(match)return {kind,terms:match.slice(1)};}
  if(kind==='loading-matrix'){match=s.match(/^([A-Za-z])\^\{([A-Za-z])\}=\[([A-Za-z])_\{([A-Za-z]{2})\}\^\{([A-Za-z])\}\]∈R\^\{([A-Za-z])_\{([A-Za-z])\}×([A-Za-z])\}$/);if(match)return {kind,terms:match.slice(1)};}
  if(kind==='spike-slab'){s=s.replace(/N(?=\()/g,'𝒩');match=s.match(/^p\(([A-Za-z])\)=\((\d+)-([αθε])\)(\d+)_\{(\d+)\}\(([A-Za-z])\)\+([αθε])𝒩\(([A-Za-z])\|(\d+),(\d+)\/([αθε])\)$/);if(match)return {kind,terms:match.slice(1)};}
  if(kind==='indexed-parameter'){match=s.match(/^([αθ])_\{([A-Za-z])\}\^\{([A-Za-z])\}$/);if(match)return {kind,terms:match.slice(1)};}
  if(kind==='natural-set'){s=s.replace('∈N=','∈ℕ=');match=s.match(/^([A-Za-z])∈ℕ=\{(\d+),(\d+),…\}$/);if(match)return {kind,terms:match.slice(1)};}
  if(kind==='binary-set'){match=s.match(/^([A-Za-z])∈\{(\d+),(\d+)\}$/);if(match)return {kind,terms:match.slice(1)};}
  if(kind==='hatted-Y'&&s==='§hatY')return {kind,base:'Y'};
  throw new Error('math-unsupported-structure');
}

function sourceReviewedUnitV2(text, spec) {
  try {
    let unit=normalizeText(text);if(!Array.isArray(spec.typography??[])||(spec.typography??[]).some(x=>!['harrell-apostrophe','naive-diaeresis'].includes(x)))throw new Error('typography');
    for(const rule of spec.typography??[]){if(rule==='harrell-apostrophe')unit=unit.replace(/Harrell[’']/g,"Harrell'");if(rule==='naive-diaeresis')unit=unit.replace(/\bnaïve\b/gu,'naive');}
    const mark=(before,after,kind)=>{const start=unit.indexOf(before);if(start<0||unit.indexOf(before,start+1)>=0)throw new Error('math-anchor');const a=start+before.length,b=after===null?unit.length:unit.indexOf(after,a);if(b<a)throw new Error('math-anchor');const raw=unit.slice(a,b);unit=unit.slice(0,a)+'§'+JSON.stringify(sourceMathV2(raw,kind))+'§'+unit.slice(b);};
    if(['factorization','factor-matrix','loading-matrix','spike-slab'].includes(spec.profile))unit=JSON.stringify(sourceMathV2(unit,spec.profile));
    else if(spec.profile==='poisson-opening')mark('count data ', ', they', 'natural-set');
    else if(spec.profile==='bernoulli-opening')mark('binary, ', ', they', 'binary-set');
    else if(spec.profile==='indexed-parameters'){mark('In this formulation ', ' controls the strength','indexed-parameter');mark(' and ', ' controls the degree','indexed-parameter');}
    else if(spec.profile==='pseudo-data'){if(!unit.endsWith('.'))throw new Error('sentence-period');mark('pseudo-data ','.','hatted-Y');}
    else if(spec.profile!=='literal')throw new Error('unit-profile');
    return {ok:true,unit};
  }catch(cause){return {ok:false,unit:null,reason:cause.message};}
}

function sourceBindingV2(binding, parent) {
  requireReview(binding?.version==='source-review-binding-2','v2-version');
  const {version,fingerprint,...payload}=binding;requireReview(fingerprint===hash(payload),'v2-fingerprint');
  requireReview(['native','hybrid'].includes(binding.candidate_side)&&binding.parent_fingerprint===hash(parent),'v2-parent');
  requireReview(Array.isArray(binding.records)&&Array.isArray(binding.materials?.cases)&&Array.isArray(binding.cases),'v2-records');
  const records=new Map();for(const r of binding.records){requireReview(typeof r.record_id==='string'&&!records.has(r.record_id)&&unitTextHash(r.bytes)===r.sha256,'v2-record-bytes');let body;try{body=JSON.parse(r.bytes);}catch{requireReview(false,'v2-record-json');}
    requireReview(body.paper_id===binding.paper_id&&body.status==='complete'&&Array.isArray(body.cases)&&Array.isArray(body.viewed_source_pages)&&Array.isArray(body.unresolved)&&!body.unresolved.length,'v2-record-shape');records.set(r.record_id,body);}
  requireReview(parent.sources.every(s=>binding.source_files.some(f=>f.document_id===s.document_id&&f.sha256===s.source_sha256&&!Object.hasOwn(f,'physical_page'))),'v2-source-map');
  const found=new Map();for(const c of binding.cases){
    requireReview(!found.has(c.case_id),'v2-duplicate-case');const material=binding.materials.cases.find(m=>m.case_id===c.case_id),first=records.get(c.revision_id)?.cases.find(r=>r.case_id===c.case_id),second=records.get(c.review_id)?.cases.find(r=>r.case_id===c.case_id);
    requireReview(material&&first&&second&&first.document_id===material.reference.document_id&&second.document_id===first.document_id,'v2-case-document');
    const side=binding.candidate_side,parentBlock=material.candidate_parents[side];requireReview(parentBlock&&hash(parent.blocks.find(b=>b.id===parentBlock.id))===hash(parentBlock)&&first[side]?.parent_id===parentBlock.id,'v2-case-parent');
    requireReview(['representation_only','content_error','location_error','unresolved'].includes(first[side].classification)&&first[side].classification===second[side]?.classification_reviewed,'v2-classification');
    requireReview(second[side].status==='verified'&&second.reference?.status==='verified'&&!(first.unresolved??[]).length&&!(second.unresolved??[]).length,'v2-unresolved');
    requireReview(JSON.stringify(first.source_physical_pages)===JSON.stringify(second.source_physical_pages),'v2-source-pages');
    for(const id of [c.revision_id,c.review_id])for(const page of first.source_physical_pages){const record=records.get(id);requireReview(record.viewed_source_pages.some(v=>v.document_id===first.document_id&&v.physical_page===page&&v.viewed===true&&binding.source_files.some(f=>f.document_id===v.document_id&&f.physical_page===page&&f.path===v.path&&/^sha256:[a-f0-9]{64}$/.test(f.sha256))),'v2-viewed-source');}
    const ref=binding.reference_manifest.items.find(r=>r.evidence_id===c.case_id),old=binding.original_reference_manifest.items.find(r=>r.evidence_id===c.case_id);requireReview(ref&&old&&hash(old)===hash(material.reference),'v2-reference-origin');
    if(ref.expected_semantic_unit!==old.expected_semantic_unit){const edit=binding.reference_changes.find(e=>e.evidence_id===c.case_id);requireReview(edit?.old===old.expected_semantic_unit&&edit.new===ref.expected_semantic_unit&&first.reference.status==='needs_correction'&&second.reference.classification_reviewed==='needs_correction','v2-reference-change');}
    requireReview(c.unit?.version==='reviewed-unit-2','v2-unit');const referenceUnit=sourceReviewedUnitV2(ref.expected_semantic_unit,c.unit);requireReview(referenceUnit.ok,'v2-reference-unit');
    const sourceUnits=[];for(const [key,record]of [['revision',first],['review',second]]){const span=c.source_selections?.[key];requireReview(span&&span.quote_sha256===unitTextHash(record.source_quote)&&Number.isInteger(span.start)&&Number.isInteger(span.end)&&span.start>=0&&span.end>span.start&&span.end<=record.source_quote.length,'v2-source-selection');const unit=sourceReviewedUnitV2(record.source_quote.slice(span.start,span.end),c.unit);requireReview(unit.ok&&unit.unit===referenceUnit.unit,'v2-source-reference-equivalence');sourceUnits.push(unit.unit);}
    found.set(c.case_id,{config:c,material,first,second,parentBlock,ref,referenceUnit,sourceUnits});
  }
  requireReview(binding.reference_manifest.items.length===binding.original_reference_manifest.items.length&&binding.reference_manifest.items.every(r=>{const old=binding.original_reference_manifest.items.find(o=>o.evidence_id===r.evidence_id);return old&&(hash(old)===hash(r)||binding.reference_changes.some(c=>c.evidence_id===r.evidence_id));}),'v2-reference-scope');
  return found;
}

function deriveSourceReviewedRunV2(proof) {
  requireReview(proof?.version==='reviewed-derivation-2'&&proof.approval?.scope==='single-reviewed-correction-offline'&&typeof proof.approval.id==='string','v2-derivation');
  const {parent_run:parent,patch,source_review_binding:binding}=proof,cases=sourceBindingV2(binding,parent),c=cases.get(patch?.case_id);
  requireReview(c&&c.first[binding.candidate_side].classification==='content_error'&&patch.block_id===c.parentBlock.id,'v2-correction-case');
  const proposed=c.first.proposed_corrections.find(p=>p.target===patch.block_id),review=c.second.correction_reviews.find(r=>r.target===patch.block_id);
  requireReview(proposed&&review?.status==='verified'&&patch.changed_span?.from===proposed.from&&patch.changed_span.to===proposed.to,'v2-correction-proposal');
  if(review.from!==undefined)requireReview(review.from===patch.changed_span.from&&review.to===patch.changed_span.to,'v2-correction-reviewed-span');
  const block=parent.blocks.find(b=>b.id===patch.block_id),{from,to}=patch.changed_span;
  requireReview(typeof from==='string'&&from&&typeof to==='string'&&to&&from!==to&&block.text===patch.original_block_text&&sameLocator(block.locator,patch.original_locator)&&unitTextHash(block.text)===patch.original_text_sha256&&block.text.split(from).length===2&&block.text.replace(from,to)===patch.replacement_text&&unitTextHash(patch.replacement_text)===patch.replacement_text_sha256,'v2-correction-bytes');
  const run=createParserRunRecord(parent);run.blocks.find(b=>b.id===patch.block_id).text=patch.replacement_text;run.normalization_version+='+source-reviewed-2';run.config_fingerprint=hash({parent:hash(parent),proof:hash(proof)});run.approval_fingerprint=hash(proof.approval);run.parser_run_id=deriveParserRunIdentity(run);return run;
}

function applySourceReviewedComparisonV2(input, units, baselineObservations, candidateObservations) {
  const spec=input.comparisonPolicy.reviewed_comparison,proof=input.candidateDescriptor.reviewed_derivation,binding=spec.source_review_binding,parent=proof?.parent_run??input.candidateRun;
  requireReview(input.referenceManifest&&spec.version==='reviewed-comparison-2'&&Array.isArray(spec.items),'v2-policy');
  const cases=sourceBindingV2(binding,parent);requireReview(binding.baseline_fingerprint===hash(input.baselineRun)&&hash(binding.baseline_blocks)===hash(input.baselineRun.blocks)&&hash(binding.reference_manifest)===hash(input.referenceManifest)&&binding.reference_fingerprint===hash(input.referenceManifest),'v2-comparison-inputs');
  if(proof)requireReview(proof.version==='reviewed-derivation-2'&&hash(proof.source_review_binding)===hash(binding)&&hash(deriveSourceReviewedRunV2(proof))===hash(input.candidateRun),'v2-derived-record');
  const seen=new Set(),observations=[],known=[];
  for(const rule of spec.items){const c=cases.get(rule.evidence_id),selected=units.resolved.get(rule.evidence_id);requireReview(c&&selected&&!seen.has(rule.evidence_id),'v2-rule-scope');seen.add(rule.evidence_id);
    const classification=c.first[binding.candidate_side].classification;requireReview(classification!=='unresolved','v2-unresolved');
    if(classification==='content_error')requireReview(proof?.patch.case_id===c.config.case_id,'v2-unapplied-content-error');
    const observation={evidence_id:rule.evidence_id,version:spec.version,reference:{raw_text:c.ref.expected_semantic_unit,...c.referenceUnit},source_case_id:c.config.case_id,source_observation_review:c.second.source_observation_review,correction_reviews:structuredClone(c.second.correction_reviews)};
    for(const [side,run,observed]of [['baseline',input.baselineRun,baselineObservations],['candidate',input.candidateRun,candidateObservations]]){
      const value=selected[side],before=structuredClone(value);let effective=null;
      for(const context of value.context){const original=side==='candidate'?parent.blocks.find(b=>b.id===context.id):binding.baseline_blocks.find(b=>b.id===context.id);const patched=side==='candidate'&&proof?.patch.block_id===context.id&&context.text===proof.patch.replacement_text&&sameLocator(context.locator,proof.patch.original_locator);requireReview(original&&(hash(original)===hash(context)||patched),'v2-context-parent');}
      if(side==='candidate')requireReview(value.blocks.length===1&&value.blocks[0].id===c.parentBlock.id,'v2-selected-case-parent');
      if(side==='candidate'&&classification==='content_error')requireReview(value.blocks.some(b=>b.id===proof.patch.block_id),'v2-corrected-selection');
      if(side==='candidate'&&classification==='location_error'){
        const loc=c.config.verified_source_span,parts=selected.mapping.candidate.parts;
        requireReview(loc&&loc.case_id===c.config.case_id&&loc.side==='candidate'&&parts.length===1&&value.blocks.length===1&&loc.parent_block_id===c.parentBlock.id&&loc.parent_text_sha256===unitTextHash(c.parentBlock.text)&&sameLocator(loc.parent_locator,c.parentBlock.locator),'v2-location-parent');
        requireReview(parts[0].start===loc.start&&parts[0].end===loc.end&&parts[0].parent_text_sha256===loc.parent_text_sha256&&sameLocator(parts[0].locator,loc.parent_locator)&&value.selected_text===loc.text&&c.parentBlock.text.slice(loc.start,loc.end)===loc.text,'v2-location-range');
        requireReview(loc.verified_document_id===c.ref.document_id&&loc.verified_physical_page===c.ref.locator.page_number&&c.first.source_physical_pages.includes(loc.verified_physical_page)&&c.second.source_physical_pages.includes(loc.verified_physical_page),'v2-location-page');
        effective={document_id:loc.verified_document_id,page_number:loc.verified_physical_page,source_block_id:c.parentBlock.id,selection:{start:loc.start,end:loc.end},basis:'two-source-reviewed-exact-clause'};
      }
      const converted=sourceReviewedUnitV2(value.selected_text,c.config.unit),matched=value.outcome!=='missing'&&(value.outcome!=='wrong_page'||effective)&&converted.ok&&converted.unit===c.referenceUnit.unit;
      const outcome=matched?'segmented_match':['missing','wrong_page'].includes(value.outcome)?value.outcome:'wrong_semantic_unit';
      observation[side]={raw_text:value.selected_text,raw_outcome:before.outcome,...converted,outcome,...(effective?{effective_source_locator:effective}: {})};
      observed.set(rule.evidence_id,{...value,outcome,...(effective?{raw_outcome:before.outcome,effective_source_locator:effective}:{})});
    }
    if(classification==='content_error')requireReview(observation.candidate.outcome==='segmented_match','v2-post-correction-source-check');
    observations.push(observation);
  }
  for(const [id,c]of cases)if(!seen.has(id)&&c.first[binding.candidate_side].classification!=='representation_only')known.push({case_id:id,disposition:'unresolved_candidate_content'});
  return {known_content_defects:known,reviewed_observations:observations,reviewed_derivation:{disposition:proof?'reviewed_derivative':'original_unmodified',new_backend_execution:false,parent_run_fingerprint:hash(parent),source_review_fingerprint:binding.fingerprint,authority_limit:'actual records and scoped bytes;not cryptographic user/source/model authentication orindependent gold'}};
}

const REVIEW_RULES = ['range','punctuation','scientific','labelled-values','table-row','cited-pairs','quote-glyph','symbolic-power'];
const SUPERSCRIPT_LETTERS = { ᵃ:'a', ᵇ:'b', ᶜ:'c', ᵈ:'d', ᵉ:'e', ᶠ:'f', ᵍ:'g', ʰ:'h', ⁱ:'i', ʲ:'j', ᵏ:'k', ˡ:'l', ᵐ:'m', ⁿ:'n', ᵒ:'o', ᵖ:'p', ʳ:'r', ˢ:'s', ᵗ:'t', ᵘ:'u', ᵛ:'v', ʷ:'w', ˣ:'x', ʸ:'y', ᶻ:'z' };
/** Finite textual grammar, deliberately not a general equation or HTML-table parser. */
export function reviewedComparisonUnit(text, spec, { context = '', side = 'candidate' } = {}) {
  if (spec?.version === 'reviewed-unit-2') return sourceReviewedUnitV2(text, spec);
  let unit = normalizeText(text);
  const fail = reason => ({ ok: false, unit: null, reason });
  if (!Array.isArray(spec?.rules) || spec.rules.some(rule => !REVIEW_RULES.includes(rule))
    || new Set(spec.rules).size !== spec.rules.length) return fail('unsupported-rule');
  for (const rule of spec.rules) {
    if (rule === 'quote-glyph') unit = unit.replace(/“([^“”"]+)”/g, '"$1"');
    if (rule === 'symbolic-power') unit = unit.replace(/(?<![A-Za-z0-9_])([A-Za-z])([ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖʳˢᵗᵘᵛʷˣʸᶻ])(?![A-Za-z0-9_])/gu,
      (_, base, exponent) => `${base}^${SUPERSCRIPT_LETTERS[exponent]}`);
    if (rule === 'range') unit = unit.replace(/\b(\d{4})–(\d{4})\b/g,'$1-$2')
      .replace(/\b(\d+)–(\d+)%/g,'$1-$2%').replace(/\bone–five\b/g,'one-five');
    if (rule === 'punctuation') unit = unit.replace(/,”/g,'”,')
      .replace(/([A-Za-z]),(?=\s+[A-Za-z])/g,'$1').replace(/\.$/,'');
    if (rule === 'scientific') unit = unit.replace(/(\d(?:\.\d+)?)\s+[X×]\s+10([⁻⁺]?[⁰¹²³⁴⁵⁶⁷⁸⁹]+)/g,'$1 × 10$2')
      .replace(/μ_([sg])\b/g,'μ$1');
    if (rule === 'labelled-values') {
      const m = unit.match(/^Unaffected (\d+-\d+%);? Unilateral (\d+-\d+%);? Bilateral (\d+-\d+%)\.?$/);
      if (!m) return fail('label-range-structure');
      unit = JSON.stringify([['Unaffected',m[1]],['Unilateral',m[2]],['Bilateral',m[3]]]);
    }
    if (rule === 'table-row') {
      if (!['none','unilateral','bilateral'].includes(spec.row) || spec.table_id !== 'TABLE 3'
        || spec.header !== 'Frequencies for various values of m: 1 | 2 | 3 | 4 | 5.') return fail('table-contract');
      const m = unit.match(/^(none|unilateral|bilateral):? (\d+\.\d+)(?: \| | )(\d+\.\d+)(?: \| | )(\d+\.\d+)(?: \| | )(\d+\.\d+)(?: \| | )(\d+\.\d+)\.?$/);
      if (!m || m[1] !== spec.row) return fail('table-row-structure');
      if (side !== 'reference') {
        const normalizedContext = normalizeText(context);
        const headerAt = normalizedContext.indexOf(spec.header);
        // The selected row must occur intact under the one declared table/header.
        if (normalizedContext.split(spec.table_id).length !== 2 || normalizedContext.split(spec.header).length !== 2
          || headerAt < normalizedContext.indexOf(spec.table_id) || normalizedContext.indexOf(normalizeText(text),headerAt) < 0
          || [...normalizedContext.matchAll(/\b(none|unilateral|bilateral):? (?=\d)/g)].filter(match=>match[1]===spec.row).length !== 1)
          return fail('table-context');
      }
      unit = JSON.stringify([spec.table_id, spec.row, ['1','2','3','4','5'], m.slice(2)]);
    }
    if (rule === 'cited-pairs') {
      const m = unit.match(/^(The respective mean ages at diagnosis for bilateral and unilateral cases have been reported in other series as )(\d+) and (\d+) months \((\d+)\)(?: and |, )(\d+) and (\d+) months \((\d+)\), and in the present series are (\d+) and (\d+) months\.$/);
      if (!m) return fail('cited-pair-structure');
      unit = JSON.stringify([m[1], [m[2],m[3],m[4]], [m[5],m[6],m[7]], ['present series',m[8],m[9],'months']]);
    }
  }
  return { ok: true, unit };
}

function applyReviewedComparison(input, units, baselineObservations, candidateObservations) {
  const spec = input.comparisonPolicy.reviewed_comparison;
  if (spec?.version === 'reviewed-comparison-6') return applySnfGlyphComparison(input, units, baselineObservations, candidateObservations, compareParserRuns);
  if (spec?.version === 'reviewed-comparison-5') return applySnfReviewedComparison(input, units, baselineObservations, candidateObservations);
  if (spec?.version === 'reviewed-comparison-4') return applyCaseReviewedComparison(input, units, baselineObservations, candidateObservations);
  if (spec?.version === 'reviewed-comparison-3') return applyGroupedReviewedComparison(input, units, baselineObservations, candidateObservations);
  const proof = input.candidateDescriptor.reviewed_derivation;
  if (spec?.version === 'reviewed-comparison-2') return applySourceReviewedComparisonV2(input, units, baselineObservations, candidateObservations);
  if (!spec && !proof) return null;
  requireReview(input.referenceManifest && spec?.version === 'reviewed-comparison-1' && Array.isArray(spec.items), 'policy');
  const parent = proof?.parent_run ?? input.candidateRun, binding = spec.source_review_binding;
  const cases = reviewBinding(binding, parent);
  requireReview(binding.baseline_fingerprint === hash(input.baselineRun)
    && binding.reference_fingerprint === hash(input.referenceManifest), 'comparison-inputs');
  if (proof) requireReview(hash(proof.source_review_binding) === hash(binding)
    && hash(deriveReviewedParserRun(proof)) === hash(input.candidateRun), 'derived-record');
  const known = binding.revision.cases.filter(entry => entry.candidate_class !== 'representation_only'
    || binding.review.cases.find(x => x.case_id === entry.case_id).status !== 'verified')
    .filter(entry => !(proof && proof.patch.case_id === entry.case_id && entry.candidate_class === 'content_error'
      && binding.review.cases.find(x => x.case_id === entry.case_id).status === 'verified'))
    .map(entry => ({ case_id: entry.case_id, disposition: 'unresolved_candidate_content' }));
  for (const unresolved of [...binding.revision.unresolved,...binding.review.unresolved])
    known.push({ case_id: typeof unresolved === 'string' ? unresolved : unresolved.case_id ?? 'unresolved', disposition:'unresolved_review' });
  const observations = [], seen = new Set();
  for (const rule of spec.items) {
    const caseId = rule.source_case_id ?? rule.evidence_id;
    const sourceCase = cases.find(entry => entry.case_id === caseId);
    const item = input.referenceManifest.items.find(entry => entry.evidence_id === rule.evidence_id);
    const selected = units.resolved.get(rule.evidence_id);
    const declared = sourceCase?.reference_items ?? (sourceCase?.reference_item ? [sourceCase.reference_item] : []);
    const first = binding.revision.cases.find(x => x.case_id === caseId);
    const second = binding.review.cases.find(x => x.case_id === caseId);
    const corrected = first?.candidate_class === 'content_error' && proof?.patch.case_id === caseId
      && first.post_correction_class === 'representation_only'
      && second?.post_correction_class_reviewed === 'representation_only' && second.status === 'verified';
    const reviewedPages = first?.physical_pages ?? [first?.physical_page];
    requireReview(typeof caseId === 'string' && caseId.length > 0 && !seen.has(rule.evidence_id)
      && !(sourceCase?.reference_item && sourceCase?.reference_items)
      && declared.length > 0 && new Set(declared.map(x => x.evidence_id)).size === declared.length
      && declared.some(reference => reference.evidence_id === rule.evidence_id && hash(reference) === hash(item))
      && item && selected && reviewedPages.includes(item.locator.page_number)
      && sourceCase.candidate_blocks.some(block => block.locator.document_id === item.document_id
        && block.locator.page_number === item.locator.page_number)
      && (corrected ? rule.source_case_id === caseId : (first?.candidate_class === 'representation_only'
        && second?.status === 'verified')), 'rule-scope');
    seen.add(rule.evidence_id);
    const referenceUnit = reviewedComparisonUnit(item.expected_semantic_unit,rule,{side:'reference'});
    requireReview(referenceUnit.ok, 'reference-rule-structure');
    const observation = { evidence_id:item.evidence_id, version:spec.version, rules:structuredClone(rule), reference:{raw_text:item.expected_semantic_unit,...referenceUnit} };
    for (const [side, run, observed] of [['baseline',input.baselineRun,baselineObservations],['candidate',input.candidateRun,candidateObservations]]) {
      const value = selected[side];
      // Preserve conditions and all parent bytes, including blocks outside the selected range.
      let correctedBlockSeen = false;
      for (const context of value.context) {
        const original = sourceCase[side+'_blocks'].some(block => hash(block) === hash(context));
        const patched = side === 'candidate' && corrected && context.id === proof.patch.block_id
          && sourceCase.candidate_blocks.some(block => block.id === context.id
            && block.text === proof.patch.original_block_text && sameLocator(block.locator, context.locator))
          && context.text === proof.patch.replacement_text;
        requireReview(original || patched, 'unreviewed-context');
        if (patched) correctedBlockSeen = true;
      }
      if (side === 'candidate' && corrected) requireReview(correctedBlockSeen
        && value.selected_text.includes(proof.patch.changed_span.to), 'correction-scope');
      const transformed = reviewedComparisonUnit(value.selected_text,rule,{side,context:value.context.map(b=>b.text).join(' ')});
      const matched = !['missing','wrong_page'].includes(value.outcome) && transformed.ok && transformed.unit === referenceUnit.unit;
      observation[side] = { raw_text:value.selected_text, literal_outcome:value.outcome, ...transformed,
        outcome:matched ? 'segmented_match' : ['missing','wrong_page'].includes(value.outcome) ? value.outcome : 'wrong_semantic_unit' };
      observed.set(item.evidence_id,{...value,outcome:observation[side].outcome});
    }
    observations.push(observation);
  }
  return { known_content_defects:known, reviewed_observations:observations,
    reviewed_derivation: { disposition:proof ? 'reviewed_derivative' : 'original_unmodified', new_backend_execution:false,
      parent_run_fingerprint:hash(parent), source_review_fingerprint:binding.fingerprint,
      authority_limit:'local record binding cannot authenticate user approval, source bytes, platform delivery or reviewer independence' } };
}

// Atomic citations opt in through a reference-bound group declaration. Legacy
// bibliography units keep their original numbered-whole-line rule below.
function citationGroups(policy, manifest, acceptedReference, spanMembers = new Map()) {
  const members = new Set(), errors = [];
  if (!Object.hasOwn(policy, 'citation_unit_groups')) return { members, groups: [], errors };
  const spec = policy.citation_unit_groups;
  const reject = detail => errors.push('CITATION_GROUP_INVALID:' + detail);
  if (!acceptedReference || !exactUnitKeys(spec, ['version', 'reference_fingerprint', 'groups'])
    || spec.version !== 'citation-unit-groups-1' || spec.reference_fingerprint !== hash(manifest)
    || !Array.isArray(spec.groups) || !spec.groups.length || !Object.hasOwn(policy, 'evidence_unit_maps')) {
    reject('policy'); return { members, groups: [], errors };
  }
  const items = new Map(manifest.items.map(item => [item.evidence_id, item]));
  const use = id => {
    const item = items.get(id);
    if (!item || item.category !== 'citation' || members.has(id) || spanMembers.has(id)) reject('member:' + id);
    else members.add(id);
    return item;
  };
  for (const group of spec.groups) {
    if (!exactUnitKeys(group, ['body_context_id', 'links']) || !Array.isArray(group.links) || !group.links.length) {
      reject('group'); continue;
    }
    const context = use(group.body_context_id), numbers = new Set();
    if (context && /^\d+$/.test(normalizeText(context.expected_semantic_unit))) reject('numeric-context');
    for (const link of group.links) {
      if (!exactUnitKeys(link, ['reference_number', 'body_number_id', 'bibliography_number_id', 'bibliography_title_id'])
        || typeof link.reference_number !== 'string' || !/^[1-9]\d*$/.test(link.reference_number) || numbers.has(link.reference_number)) {
        reject('link'); continue;
      }
      numbers.add(link.reference_number);
      const body = use(link.body_number_id), number = use(link.bibliography_number_id), title = use(link.bibliography_title_id);
      if (!context || !body || !number || !title) continue;
      if ([body, number].some(item => normalizeText(item.expected_semantic_unit) !== link.reference_number)
        || /^\d+$/.test(normalizeText(title.expected_semantic_unit))
        || [body, number, title].some(item => item.document_id !== context.document_id)
        || body.locator.page_number !== context.locator.page_number || number.locator.page_number !== title.locator.page_number) reject('reference-association');
    }
  }
  // With this policy, every non-legacy citation must be assigned, including
  // unavailable members. Dropping a link cannot reduce the frozen denominator.
  for (const item of manifest.items) if (item.category === 'citation' && !members.has(item.evidence_id) && !spanMembers.has(item.evidence_id)
    && !/reference-\d+$/.test(item.locator.source_block_id)) reject('unassigned:' + item.evidence_id);
  return { members, groups: spec.groups, errors };
}

function citationGroupSelections(groups, resolved) {
  const errors = [], reject = (side, detail) => errors.push('CITATION_GROUP_INVALID:' + side + ':' + detail);
  // Punctuation and explicit superscript markup may separate a phrase and its
  // markers; words or unrelated numbers may not. No text is normalized for scoring.
  const markerGap = /^(?:\s|[.,;:()[\]{}^*]|<\/?sup>|\\(?:cite|textsuperscript)\{)*$/;
  const get = (id, side) => {
    const value = resolved.get(id), observation = value?.[side];
    if (!value || !observation) { reject(side, 'missing-mapping:' + id); return null; }
    if (observation.outcome === 'missing') return null;
    return { parts: value.mapping[side].parts, blocks: observation.blocks, text: observation.selected_text };
  };
  const number = (id, side) => {
    const unit = get(id, side);
    if (!unit) return null;
    // Accept either complete printed shape; keep the selected bytes for literal scoring.
    if (unit.parts.length !== 1 || unit.blocks.length !== 1 || !/^(?:\d+|[⁰¹²³⁴⁵⁶⁷⁸⁹]+)$/.test(unit.text)) { reject(side, 'number-token:' + id); return null; }
    const part = unit.parts[0], block = unit.blocks[0];
    // A baseline year can immediately precede a raised citation (2021–22¹²).
    // Only a same-shape neighbor extends this token; mixed tokens are rejected above.
    const digit = /^\d+$/.test(unit.text) ? /\d/ : /[⁰¹²³⁴⁵⁶⁷⁸⁹]/;
    if (digit.test(block.text[part.start - 1] ?? '') || digit.test(block.text[part.end] ?? '')) reject(side, 'partial-number:' + id);
    return { ...unit, part, block };
  };
  for (const group of groups) for (const side of ['baseline', 'candidate']) {
    const context = get(group.body_context_id, side);
    const bodyNumbers = group.links.map(link => number(link.body_number_id, side));
    // A missing member remains an ordinary missing observation and central failure.
    if (context && bodyNumbers.every(Boolean)) {
      const last = context.parts.at(-1), parent = context.blocks.at(-1);
      let end = last.end;
      for (const unit of [...bodyNumbers].sort((a, b) => a.part.start - b.part.start)) {
        if (!['paragraph', 'reference'].includes(parent.type) || !sameLocator(last.locator, unit.part.locator)
          || unit.part.start < end || !markerGap.test(parent.text.slice(end, unit.part.start))) reject(side, 'body-adjacency:' + group.body_context_id);
        end = unit.part.end;
      }
    }
    for (const link of group.links) {
      const label = number(link.bibliography_number_id, side), title = get(link.bibliography_title_id, side);
      if (!label) continue;
      const { block, part } = label;
      const lineStart = block.text.lastIndexOf('\n', part.start - 1) + 1;
      const prefix = block.text.slice(lineStart).match(/^[ \t]*(\d+)[.)]\s+/);
      if (block.type !== 'reference' || !prefix || part.start !== lineStart + prefix[0].indexOf(prefix[1])
        || part.end !== part.start + prefix[1].length) { reject(side, 'bibliography-label:' + link.bibliography_number_id); continue; }
      const entryStart = lineStart + prefix[0].length;
      const next = /\n[ \t]*\d+[.)]\s+/.exec(block.text.slice(entryStart));
      const entryEnd = next ? entryStart + next.index : block.text.length;
      if (title && title.parts.some(span => !sameLocator(span.locator, part.locator)
        || span.start < entryStart || span.end > entryEnd)) reject(side, 'bibliography-entry:' + link.bibliography_title_id);
    }
  }
  return errors;
}

// A bounded, opt-in citation shape contract. Entry scopes reuse the same
// locator/hash/character-range tuple as evidence-unit parts; no source rewrite.
function citationShape(kind, text) {
  if (kind === 'body_author_year') return /\b\p{Lu}[\p{L}'’.-]*(?:\s+(?:et\s+al\.?|and\s+\p{Lu}[\p{L}'’.-]*|&\s+\p{Lu}[\p{L}'’.-]*))?\s*,?\s*(?:18|19|20)\d{2}[a-z]?\b/u.test(text);
  if (kind === 'body_numbered') return /\[[1-9]\d*(?:\s*[,–-]\s*[1-9]\d*)*\]/u.test(text)
    && /\p{L}/u.test(text.replace(/\[[^\]]*\]/g, ''));
  if (kind === 'bibliography_entry') return /\p{L}/u.test(text) && /\b(?:18|19|20)\d{2}[a-z]?\b/u.test(text);
  return kind === 'bibliography_title' && /\p{L}/u.test(text);
}

function citationSpans(policy, manifest, acceptedReference) {
  const members = new Map(), errors = [];
  if (!Object.hasOwn(policy, 'citation_spans')) return { members, errors };
  const spec = policy.citation_spans, reject = detail => errors.push('CITATION_SPAN_INVALID:' + detail);
  if (!acceptedReference || !exactUnitKeys(spec, ['version', 'reference_fingerprint', 'items'])
      || spec.version !== 'citation-span-1' || spec.reference_fingerprint !== hash(manifest)
      || !Array.isArray(spec.items) || !spec.items.length || !Array.isArray(policy.evidence_unit_maps?.items)) {
    reject('policy'); return { members, errors };
  }
  for (const unit of spec.items) {
    const item = manifest.items.find(item => item.evidence_id === unit?.evidence_id);
    if (!exactUnitKeys(unit, ['evidence_id', 'kind', 'reference_number', 'baseline', 'candidate'])
        || !item || item.category !== 'citation' || members.has(item.evidence_id)
        || !citationShape(unit.kind, item.expected_semantic_unit)
        || !(unit.reference_number === null || (typeof unit.reference_number === 'string' && /^[1-9]\d*$/.test(unit.reference_number)))
        || (unit.kind.startsWith('body_') && unit.reference_number !== null)
        || !policy.evidence_unit_maps.items.some(mapping => mapping?.evidence_id === item.evidence_id)) {
      reject('declaration:' + (unit?.evidence_id ?? 'unknown')); continue;
    }
    // A span declaration cannot override an existing numbered-reference identity.
    const legacyNumber = item.expected_semantic_unit.match(/^([1-9]\d*)[.)]\s+/)?.[1]
      ?? item.locator.source_block_id.match(/reference-?(\d+)(?:-|$)/)?.[1];
    if (legacyNumber && unit.reference_number !== legacyNumber) reject('reference-number:' + item.evidence_id);
    members.set(item.evidence_id, unit);
  }
  return { members, errors };
}

function citationSpanSelections(members, resolved) {
  const errors = [], reject = (id, side, detail) => errors.push(`CITATION_SPAN_INVALID:${id}:${side}:${detail}`);
  for (const [id, unit] of members) for (const side of ['baseline', 'candidate']) {
    const value = resolved.get(id), observation = value?.[side], scope = unit[side];
    if (!value || !observation) { reject(id, side, 'missing-mapping'); continue; }
    if (observation.outcome === 'missing') {
      if (scope !== null) reject(id, side, 'missing-with-scope');
      continue;
    }
    const parts = value.mapping[side].parts, block = observation.blocks[0], part = parts[0];
    if (parts.length !== 1 || observation.blocks.length !== 1
        || !exactUnitKeys(scope, ['locator', 'parent_text_sha256', 'start', 'end'])
        || !sameLocator(scope.locator, part.locator) || scope.parent_text_sha256 !== unitTextHash(block.text)
        || !Number.isInteger(scope.start) || !Number.isInteger(scope.end)
        || scope.start < 0 || scope.end <= scope.start || scope.end > block.text.length
        || part.start < scope.start || part.end > scope.end) {
      reject(id, side, 'scope-binding'); continue;
    }
    const text = observation.selected_text, word = c => Boolean(c) && /[\p{L}\p{N}_]/u.test(c);
    if ((word(block.text[part.start - 1]) && word(text[0])) || (word(text.at(-1)) && word(block.text[part.end]))) {
      reject(id, side, 'partial-token'); continue;
    }
    if (!citationShape(unit.kind, text)) { reject(id, side, 'citation-shape'); continue; }
    if (unit.kind.startsWith('body_')) {
      if (block.type !== 'paragraph' || scope.start !== 0 || scope.end !== block.text.length) reject(id, side, 'body-context');
      continue;
    }
    // Current flat reference lists delimit entries with newlines. Require one
    // complete declared entry, not arbitrary bounds that cross neighbouring items.
    const start = block.text.lastIndexOf('\n', scope.start - 1) + 1;
    const next = block.text.indexOf('\n', start), end = next < 0 ? block.text.length : next;
    const line = block.text.slice(start, end), trimmedStart = start + line.length - line.trimStart().length;
    const trimmedEnd = end - (line.length - line.trimEnd().length);
    if (block.type !== 'reference' || scope.start !== trimmedStart || scope.end !== trimmedEnd) {
      reject(id, side, 'bibliography-entry'); continue;
    }
    const entry = block.text.slice(scope.start, scope.end), label = entry.match(/^([1-9]\d*)[.)]\s+/);
    if ((label?.[1] ?? null) !== unit.reference_number || !citationShape('bibliography_entry', entry)) {
      reject(id, side, 'bibliography-label'); continue;
    }
    const contentStart = scope.start + (label?.[0].length ?? 0);
    if (unit.kind === 'bibliography_entry') {
      if (![scope.start, contentStart].includes(part.start) || part.end !== scope.end) reject(id, side, 'partial-entry');
    } else if (part.start < contentStart) reject(id, side, 'title-in-label');
  }
  return errors;
}

// An explicit, opt-in accepted-reference extension. No text search or rewriting.
function evidenceUnits(policy, manifest, baselineRun, candidateRun, acceptedReference) {
  const resolved = new Map(), errors = [];
  const spans = citationSpans(policy, manifest, acceptedReference);
  if (spans.errors.length) return { enabled: true, resolved, errors: stableSort(spans.errors) };
  const citations = citationGroups(policy, manifest, acceptedReference, spans.members);
  if (citations.errors.length) return { enabled: true, resolved, errors: stableSort(citations.errors) };
  if (!Object.hasOwn(policy, 'evidence_unit_maps')) return { enabled: false, resolved, errors };
  const spec = policy.evidence_unit_maps;
  if (!acceptedReference || !exactUnitKeys(spec, ['version', 'items']) || spec.version !== 'evidence-unit-map-1' || !Array.isArray(spec.items)) {
    return { enabled: true, resolved, errors: ['EVIDENCE_UNIT_POLICY_INVALID'] };
  }
  const items = new Map(manifest.items.map(item => [item.evidence_id, item]));
  for (const mapping of spec.items) {
    const item = items.get(mapping?.evidence_id);
    const reject = detail => errors.push('EVIDENCE_UNIT_INVALID:' + (mapping?.evidence_id ?? 'unknown') + ':' + detail);
    if (!exactUnitKeys(mapping, ['evidence_id', 'basis', 'baseline', 'candidate']) || !item || resolved.has(mapping.evidence_id) || typeof mapping.basis !== 'string' || !mapping.basis.trim()) {
      reject('mapping'); continue;
    }
    const observations = { mapping: structuredClone(mapping) };
    // Reserve even invalid entries so duplicate declarations never override an earlier one.
    resolved.set(mapping.evidence_id, observations);
    for (const [side, run] of [['baseline', baselineRun], ['candidate', candidateRun]]) {
      const selection = mapping[side];
      if (!exactUnitKeys(selection, ['status', 'parts', 'context_locators']) || !['located', 'missing'].includes(selection.status)
          || !Array.isArray(selection.parts) || !Array.isArray(selection.context_locators)) {
        reject(side + ':selection'); continue;
      }
      if (selection.status === 'missing') {
        if (selection.parts.length || selection.context_locators.length) reject(side + ':missing-with-parts');
        observations[side] = { outcome: 'missing', blocks: [], selected_text: null, context: [] };
        continue;
      }
      if (!selection.parts.length || !selection.context_locators.length) { reject(side + ':empty'); continue; }
      const contexts = [];
      for (const loc of selection.context_locators) {
        const matches = run.blocks.filter(block => sameLocator(block.locator, loc));
        if (loc?.document_id !== item.document_id || matches.length !== 1) reject(side + ':context');
        else contexts.push(matches[0]);
      }
      const blocks = [], texts = [];
      let previousIndex = -1, previousEnd = 0;
      for (const part of selection.parts) {
        if (!exactUnitKeys(part, ['locator', 'parent_text_sha256', 'start', 'end'])) { reject(side + ':part'); continue; }
        const matches = run.blocks.map((block, index) => ({ block, index })).filter(({ block }) => sameLocator(block.locator, part.locator));
        if (part.locator?.document_id !== item.document_id || matches.length !== 1) { reject(side + ':locator'); continue; }
        const { block, index } = matches[0];
        if (part.parent_text_sha256 !== unitTextHash(block.text)
          || !Number.isInteger(part.start) || !Number.isInteger(part.end) || part.start < 0 || part.end <= part.start || part.end > block.text.length
          || index < previousIndex || (index === previousIndex && part.start < previousEnd)
          || !contexts.some(context => sameLocator(context.locator, block.locator))) {
          reject(side + ':range-or-binding'); continue;
        }
        if (item.category === 'citation' && !citations.members.has(item.evidence_id) && !spans.members.has(item.evidence_id)) {
          const expectedNumber = item.locator.source_block_id.match(/reference-(\d+)$/)?.[1];
          const lineStart = block.text.lastIndexOf('\n', part.start - 1) + 1;
          const nextLine = block.text.indexOf('\n', lineStart);
          const lineEnd = nextLine < 0 ? block.text.length : nextLine;
          const prefix = block.text.slice(lineStart, lineEnd).match(/^(\d+)\.\s+/);
          if (block.type !== 'reference' || selection.parts.length !== 1 || !expectedNumber || !prefix
            || Number(prefix[1]) !== Number(expectedNumber) || part.start !== lineStart + prefix[0].length || part.end !== lineEnd) {
            reject(side + ':citation-number-or-boundary'); continue;
          }
        }
        previousIndex = index; previousEnd = part.end;
        blocks.push(block); texts.push(block.text.slice(part.start, part.end));
      }
      const selectedText = texts.join(' ');
      const wrongPage = blocks.some(block => block.locator.page_number !== item.locator.page_number);
      observations[side] = {
        outcome: wrongPage ? 'wrong_page' : normalizeText(selectedText) === normalizeText(item.expected_semantic_unit) ? 'segmented_match' : 'wrong_semantic_unit',
        blocks, selected_text: selectedText, context: contexts,
      };
    }
  }
  if (!errors.length) errors.push(...citationGroupSelections(citations.groups, resolved));
  if (!errors.length) errors.push(...citationSpanSelections(spans.members, resolved));
  return { enabled: true, resolved, errors: stableSort(errors) };
}

function metrics(items, baselineObservations, candidateObservations) {
  return Object.fromEntries(CATEGORIES.map(category => {
    const categoryItems = items.filter(item => item.category === category);
    if (!categoryItems.length) return [category, { disposition: 'inapplicable', expected: 0, baseline_matched: null, candidate_matched: null, recall: null, errors: [] }];
    const observations = categoryItems.map(item => ({ item, baseline: baselineObservations.get(item.evidence_id), candidate: candidateObservations.get(item.evidence_id) }));
    const candidateMatched = observations.filter(({ candidate }) => ['matched', 'segmented_match'].includes(candidate.outcome)).length;
    const errors = observations.filter(({ candidate }) => !['matched', 'segmented_match'].includes(candidate.outcome)).map(({ item, candidate }) => ({ evidence_id: item.evidence_id, error_class: category, outcome: candidate.outcome }));
    return [category, {
      disposition: 'observed',
      expected: categoryItems.length,
      baseline_matched: observations.filter(({ baseline }) => ['matched', 'segmented_match'].includes(baseline.outcome)).length,
      candidate_matched: candidateMatched,
      recall: candidateMatched / categoryItems.length,
      errors,
    }];
  }));
}

function resourceObservations(baselineRun, candidateRun) {
  const resources = new Map();
  for (const observation of [...baselineRun.resource_observations, ...candidateRun.resource_observations]) {
    if (!resources.has(observation.kind)) resources.set(observation.kind, []);
    resources.get(observation.kind).push(observation);
  }
  return Object.fromEntries([...resources.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([kind, observations]) => {
    const observed = observations.filter(observation => observation.status === 'observed' && Object.hasOwn(observation, 'value') && observation.value !== null);
    return [kind, observed.length
      ? { availability: 'observed', disposition: 'reported', reported_values: observed.map(observation => ({ value: observation.value, unit: observation.unit })), reported_by: observations.length }
      : { availability: 'unknown', disposition: 'not_observed', value: null, reported_by: observations.length }];
  }));
}

function pageCoverage(baselineRun, candidateRun) {
  const status = run => run.page_coverage.every(coverage => coverage.unknown_item_count === 0 && coverage.known_pages.length > 0);
  return { baseline_complete: status(baselineRun), candidate_complete: status(candidateRun), complete: status(baselineRun) && status(candidateRun), inventory_only: true };
}

function validateCandidateDescriptor(descriptor, candidateRun) {
  const errors = [];
  if (!descriptor || !['mineru', 'native_model', 'hybrid'].includes(descriptor.backend_kind)) errors.push('CANDIDATE_BACKEND_KIND_INVALID');
  if (!descriptor?.backend_version || descriptor.backend_version !== candidateRun.backend_version) errors.push('CANDIDATE_BACKEND_VERSION_MISMATCH');
  const allowedBackends = { mineru: new Set(['mineru', 'current-mineru']), native_model: new Set(['native-model', 'native_model']), hybrid: new Set(['hybrid']) };
  if (descriptor?.backend_kind && !allowedBackends[descriptor.backend_kind]?.has(candidateRun.backend)) errors.push('CANDIDATE_BACKEND_KIND_MISMATCH');
  if (!['local', 'nonlocal'].includes(descriptor?.authority_scope) || !descriptor?.retention?.disposition || !descriptor?.run_authorization_ref) errors.push('CANDIDATE_INGRESS_METADATA_MISSING');
  if (!['local_only', 'no_retention', 'approved'].includes(descriptor?.retention?.disposition)) errors.push('CANDIDATE_RETENTION_DISPOSITION_INVALID');
  if (descriptor?.authority_scope === 'nonlocal' && descriptor?.egress?.data_transfer_decision !== 'approved') errors.push('CANDIDATE_EGRESS_NOT_APPROVED');
  if (descriptor?.authority_scope === 'local' && descriptor?.egress?.data_transfer_decision && descriptor.egress.data_transfer_decision !== 'not_applicable') errors.push('CANDIDATE_LOCAL_EGRESS_INVALID');
  if (descriptor?.observed_model_identity?.basis === 'model_configuration') errors.push('MODEL_CONFIGURATION_NOT_OBSERVED_IDENTITY');
  if (descriptor?.default_change !== false) errors.push('DEFAULT_SWITCH_NOT_AUTHORIZED');
  const declaredSources = new Map((descriptor?.source_document_map ?? []).map(source => [source?.document_id, source?.source_sha256]));
  if (!Array.isArray(descriptor?.source_document_map) || declaredSources.size !== candidateRun.sources.length) errors.push('CANDIDATE_SOURCE_BYTES_IDENTITY_MISSING');
  for (const source of candidateRun.sources) {
    if (declaredSources.get(source.document_id) !== source.source_sha256) errors.push(`CANDIDATE_SOURCE_BYTES_IDENTITY_MISMATCH:${source.document_id}`);
  }
  return stableSort(errors);
}

function resultIdentity({ baselineRun, candidateRun, goldManifest, comparisonPolicy, candidateDescriptor }) {
  return hash({
    baseline_run_fingerprint: runFingerprint(baselineRun),
    candidate_run_fingerprint: runFingerprint(candidateRun),
    source_document_map: sourceDocumentMap(baselineRun.sources),
    gold_manifest_fingerprint: hash(goldManifest),
    comparison_policy_fingerprint: hash(comparisonPolicy),
    candidate_descriptor_fingerprint: hash(candidateDescriptor),
  });
}

function referenceResultIdentity({ baselineRun, candidateRun, referenceManifest, comparisonPolicy, candidateDescriptor }) {
  return hash({
    baseline_run_fingerprint: runFingerprint(baselineRun),
    candidate_run_fingerprint: runFingerprint(candidateRun),
    source_document_map: sourceDocumentMap(baselineRun.sources),
    reference_manifest_fingerprint: hash(referenceManifest),
    comparison_policy_fingerprint: hash(comparisonPolicy),
    candidate_descriptor_fingerprint: hash(candidateDescriptor),
  });
}

function validateReferenceBasis(policy, manifest) {
  const basis = policy?.reference_basis;
  if (!basis || typeof basis !== 'object' || Array.isArray(basis)) return ['REFERENCE_BASIS_REQUIRED'];
  if (!manifest || typeof manifest !== 'object' || !manifest.acceptance || typeof manifest.acceptance.paper_id !== 'string') return ['REFERENCE_BASIS_MISMATCH'];
  const expected = {
    kind: 'accepted_assisted',
    decision_ref: 'D-21-35',
    corpus_id: 'phase21-twelve-paper',
    paper_id: manifest?.acceptance?.paper_id,
    reference_fingerprint: hash(manifest),
  };
  return Object.keys(basis).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, value]) => basis[key] === value)
    && manifest?.acceptance?.decision_ref === expected.decision_ref
    && manifest?.acceptance?.corpus_id === expected.corpus_id
    ? [] : ['REFERENCE_BASIS_MISMATCH'];
}

function nonComparable(errors, candidateErrors = [], acceptedReference = false) {
  return {
    status: 'not_comparable',
    comparison_identity: null,
    errors: stableSort(errors),
    candidate: { status: candidateErrors.length ? 'rejected' : 'not_comparable', errors: stableSort(candidateErrors), disposition: 'candidate_only' },
    limitations: acceptedReference
      ? ['offline comparison contract only; accepted assisted nonblind reference does not authenticate its records or prove independent human gold, approve a real corpus, or change the MinerU production default']
      : ['offline comparison contract only; it does not authenticate human gold, approve a real corpus, or change the MinerU production default'],
  };
}

/** Compares supplied records only; this function never invokes a parser, model, PDF route, or backend. */
export function compareParserRuns(input = {}) {
  if(input?.comparisonPolicy?.location_contract==='phase21-whole-paper-1.0')return compareWholePaperParserRuns(input,{metrics,resourceObservations,observePdfItems:(baseline,candidate,items,policy)=>{
    if(!items.length&&!baseline&&!candidate)return {baseline:new Map(),candidate:new Map(),errors:[]};
    const a=validatePhase21Record(phase21Validator,'phase21/parser-run',baseline),b=validatePhase21Record(phase21Validator,'phase21/parser-run',candidate);
    if(!a.ok||!b.ok)return {errors:['WHOLE_PAPER_PDF_RUN_INVALID']};
    const errors=[...validateSourceMap(baseline,candidate),...validateParserEligibility(baseline,'BASELINE'),...validateParserEligibility(candidate,'CANDIDATE')];
    const maps=locatorMaps({...policy,policy_version:policy.policy_version??'phase21-whole-paper-1.0'});errors.push(...maps.errors);
    if(errors.length)return {errors};
    const units=evidenceUnits(policy,{items},baseline,candidate,true);if(units.errors.length)return {errors:units.errors};
    return {baseline:new Map(items.map(i=>[i.evidence_id,units.resolved.get(i.evidence_id)?.baseline??itemObservation(baseline,i,maps.maps,'baseline')])),candidate:new Map(items.map(i=>[i.evidence_id,units.resolved.get(i.evidence_id)?.candidate??itemObservation(candidate,i,maps.maps,'candidate')])),errors:[]};
  }});
  if (input?.comparisonPolicy?.location_contract === 'phase21-office-original-1.0') return compareOfficeOriginalRuns(input);
  if(input.comparisonPolicy?.location_contract === 'phase21-native-workbook-1.0') return compareWorkbookParserRuns(input);
  if(input.comparisonPolicy?.location_contract || [input.baselineRun,input.candidateRun,input.referenceManifest].some(x=>typeof x?.schema_version==='string'&&x.schema_version.includes('workbook')||Array.isArray(x?.blocks)&&x.blocks.some(b=>b?.locator?.kind==='workbook')||Array.isArray(x?.sources)&&x.sources.some(s=>s?.kind==='workbook'))) return nonComparable(['NATIVE_WORKBOOK_OPT_IN_REQUIRED']);
  const { baselineRun, candidateRun, goldManifest, referenceManifest, comparisonPolicy, candidateDescriptor } = input;
  const acceptedReference = Object.hasOwn(input, 'referenceManifest');
  if (acceptedReference && Object.hasOwn(input, 'goldManifest')) return nonComparable(['REFERENCE_AND_GOLD_MUTUALLY_EXCLUSIVE'], [], true);
  const manifest = acceptedReference ? referenceManifest : goldManifest;
  const baselineShape = validatePhase21Record(phase21Validator, 'phase21/parser-run', baselineRun);
  const candidateShape = validatePhase21Record(phase21Validator, 'phase21/parser-run', candidateRun);
  const reference = acceptedReference ? validateAcceptedReferenceManifest(referenceManifest) : validateIndependentGold(goldManifest);
  const maps = locatorMaps(comparisonPolicy);
  const sourceErrors = baselineShape.ok && candidateShape.ok ? validateSourceMap(baselineRun, candidateRun) : [];
  const manifestSourceErrors = baselineShape.ok && candidateShape.ok && reference.ok
    ? validateGoldSourceMap(manifest, baselineRun, candidateRun, acceptedReference ? 'REFERENCE' : 'GOLD') : [];
  const baselineEligibilityErrors = baselineShape.ok ? validateParserEligibility(baselineRun, 'BASELINE') : [];
  const candidateEligibilityErrors = candidateShape.ok ? validateParserEligibility(candidateRun, 'CANDIDATE') : [];
  const candidateErrors = candidateShape.ok ? validateCandidateDescriptor(candidateDescriptor, candidateRun) : ['CANDIDATE_PARSER_RUN_INVALID'];
  const errors = [
    ...plainError(baselineShape, 'BASELINE_SCHEMA_INVALID'),
    ...plainError(candidateShape, 'CANDIDATE_SCHEMA_INVALID'),
    ...reference.errors,
    ...maps.errors,
    ...sourceErrors,
    ...manifestSourceErrors,
    ...baselineEligibilityErrors,
    ...candidateEligibilityErrors,
    ...(acceptedReference ? reference.ok ? validateReferenceBasis(comparisonPolicy, referenceManifest) : [] : Object.hasOwn(comparisonPolicy ?? {}, 'reference_basis') ? ['GOLD_POLICY_REFERENCE_BASIS_FORBIDDEN'] : []),
  ];
  const archiveMethod = hasArchiveMethod(baselineRun) || hasArchiveMethod(candidateRun)
    || hasArchiveSources(baselineRun) || hasArchiveSources(candidateRun);
  if (archiveMethod || Object.hasOwn(input, 'archiveRepresentation')) for (const [label, run, shape] of [['BASELINE',baselineRun,baselineShape],['CANDIDATE',candidateRun,candidateShape]]) {
    if (shape.ok && run.parser_run_id !== deriveParserRunIdentity(run)) errors.push(label + '_PARSER_RUN_IDENTITY_MISMATCH');
  }
  let archiveBinding;
  if (archiveMethod || Object.hasOwn(input, 'archiveRepresentation')) {
    if (!input.archiveRepresentation) errors.push('ARCHIVE_REPRESENTATION_REQUIRED');
    else if (baselineShape.ok && candidateShape.ok && reference.ok && !candidateErrors.length) {
      archiveBinding = bindArchiveRepresentation(input.archiveRepresentation, { baselineRun, candidateRun, referenceManifest, candidateDescriptor });
      errors.push(...archiveBinding.errors);
    }
  }
  if (!acceptedReference && goldManifest?.scope === 'incomplete') errors.push('INDEPENDENT_GOLD_SCOPE_INCOMPLETE');
  if (errors.length || candidateErrors.length) return nonComparable(errors, candidateErrors, acceptedReference);

  const units = evidenceUnits(comparisonPolicy, manifest, baselineRun, candidateRun, acceptedReference);
  if (units.errors.length) return nonComparable(units.errors, [], acceptedReference);
  const baselineObservations = new Map(manifest.items.map(item => [item.evidence_id, units.resolved.get(item.evidence_id)?.baseline ?? itemObservation(baselineRun, item, maps.maps, 'baseline')]));
  const candidateObservations = new Map(manifest.items.map(item => [item.evidence_id, units.resolved.get(item.evidence_id)?.candidate ?? itemObservation(candidateRun, item, maps.maps, 'candidate')]));
  let reviewed;
  try { reviewed = applyReviewedComparison(input, units, baselineObservations, candidateObservations); }
  catch (error) { return nonComparable(['REVIEWED_COMPARISON_INVALID:' + error.message], [], acceptedReference); }
  const sharedOmissions = manifest.items.filter(item => baselineObservations.get(item.evidence_id).outcome === 'missing' && candidateObservations.get(item.evidence_id).outcome === 'missing');
  const criticalMissing = manifest.items.filter(item => item.centrality === 'central' && !['matched', 'segmented_match'].includes(candidateObservations.get(item.evidence_id).outcome));
  const hasCentralRejection = criticalMissing.length > 0 || (reviewed?.known_content_defects.length ?? 0) > 0;
  return {
    ...(acceptedReference ? { schema_version: 'phase21-reference-comparison-1.0', reference_kind: 'accepted_assisted' } : {}),
    status: hasCentralRejection ? 'rejected' : 'compared',
    ...(reviewed ?? {}),
    comparison_identity: archiveBinding?.ok ? hash({ archive_representation_fingerprint: archiveBinding.fingerprint,
      comparison: referenceResultIdentity({ baselineRun, candidateRun, referenceManifest, comparisonPolicy, candidateDescriptor }) }) : acceptedReference
      ? referenceResultIdentity({ baselineRun, candidateRun, referenceManifest, comparisonPolicy, candidateDescriptor })
      : resultIdentity({ baselineRun, candidateRun, goldManifest, comparisonPolicy, candidateDescriptor }),
    ...(archiveBinding?.ok ? { archive_representation_fingerprint: archiveBinding.fingerprint, archive_evidence_tier: input.archiveRepresentation.evidence_tier,
      original_format_obligations: input.archiveRepresentation.inventory.some(m => m.original_format === 'xlsx') ? 'held_requires_original_workbook_baseline' : 'representation_mapping_only' } : {}),
    baseline_run_fingerprint: runFingerprint(baselineRun),
    candidate_run_fingerprint: runFingerprint(candidateRun),
    ...(acceptedReference
      ? { reference_manifest_fingerprint: hash(referenceManifest), reference_basis: structuredClone(comparisonPolicy.reference_basis), reference_method: structuredClone(referenceManifest.method), reference_scope: structuredClone(referenceManifest.scope) }
      : { gold_manifest_fingerprint: hash(goldManifest) }),
    comparison_policy_fingerprint: hash(comparisonPolicy),
    source_document_map: sourceDocumentMap(baselineRun.sources),
    segmentation_mappings: maps.maps.map(mapping => acceptedReference
      ? { kind: mapping.kind, reference_locator: mapping.gold_locator, baseline_locators: mapping.baseline_locators, candidate_locators: mapping.candidate_locators }
      : { kind: mapping.kind, gold_locator: mapping.gold_locator, baseline_locators: mapping.baseline_locators, candidate_locators: mapping.candidate_locators }),
    shared_omissions: sharedOmissions.map(item => ({ evidence_id: item.evidence_id, category: item.category, locator: item.locator, centrality: item.centrality })),
    critical_missing: criticalMissing.map(item => ({ evidence_id: item.evidence_id, category: item.category, locator: item.locator, centrality: item.centrality })),
    category_metrics: metrics(manifest.items, baselineObservations, candidateObservations),
    ...(units.enabled ? { evidence_unit_observations: manifest.items.map(item => units.resolved.has(item.evidence_id) ? { evidence_id: item.evidence_id, ...structuredClone(units.resolved.get(item.evidence_id)) } : null).filter(Boolean) } : {}),
    page_coverage: pageCoverage(baselineRun, candidateRun),
    resource_observations: resourceObservations(baselineRun, candidateRun),
    candidate: {
      status: 'accepted_for_comparison',
      disposition: candidateDescriptor.backend_kind === 'mineru' ? 'production_default_unchanged' : 'candidate_only',
      backend_kind: candidateDescriptor.backend_kind,
      default_status: 'mineru_production_default_unchanged',
    },
    limitations: acceptedReference
      ? ['offline comparison contract only; accepted assisted nonblind reference may share omissions or interpretation bias with the evaluated parser and does not authenticate source records, prove independent human gold, approve a real corpus, or change the MinerU production default',
        ...(reviewed ? ['reviewed representation comparison; ' + reviewed.reviewed_derivation.disposition + '; no new backend execution; original extraction and assisted correction are distinct evidence'] : [])]
      : ['offline comparison contract only; it does not authenticate human gold, approve a real corpus, or change the MinerU production default'],
  };
}

const workbookSourceDocumentMap = sources => [...sources].map(s=>structuredClone(s)).sort((a,b)=>a.document_id<b.document_id?-1:a.document_id>b.document_id?1:0);

/** The same native candidate shape, identity and required coverage gates used by comparison. */
export function validateWorkbookScientificSourceRun(run) {
  const shape = workbookValidator.validate('phase21/native-workbook#/$defs/run', run);
  if (!shape.ok) return { ok: false, errors: plainError(shape, 'CANDIDATE_WORKBOOK_SCHEMA_INVALID') };
  const errors = validateWorkbookSourceBindings(run, run.required_coverage, 'CANDIDATE');
  return { ok: errors.length === 0, errors };
}

function validateWorkbookReferenceManifest(manifest) {
  const shape=workbookValidator.validate('phase21/native-workbook#/$defs/reference',manifest);
  if(!shape.ok) return {ok:false,errors:plainError(shape,'WORKBOOK_REFERENCE_SCHEMA_INVALID')};
  const errors=[];
  const categories=new Map();
  for(const entry of manifest.scope.category_dispositions){if(categories.has(entry.category))errors.push('REFERENCE_CATEGORY_DUPLICATE:'+entry.category);categories.set(entry.category,entry.disposition);}
  for(const category of CATEGORIES){const count=manifest.items.filter(i=>i.category===category).length,disposition=categories.get(category);if(!disposition)errors.push('REFERENCE_CATEGORY_UNDECLARED:'+category);else if(disposition==='covered'&&!count)errors.push('REFERENCE_COVERED_CATEGORY_EMPTY:'+category);else if(disposition==='inapplicable'&&count)errors.push('REFERENCE_APPLICABLE_CATEGORY_MARKED_INAPPLICABLE:'+category);else if(disposition==='uncovered')errors.push('REFERENCE_CATEGORY_UNCOVERED:'+category);}
  if(manifest.scope.status!=='complete')errors.push('REFERENCE_SCOPE_INCOMPLETE');if(manifest.scope.uncovered_items.length)errors.push('REFERENCE_ITEMS_UNCOVERED');
  const aggregate=(key,first,second,fallback)=>manifest.items.some(i=>i[key]===first)?first:manifest.items.some(i=>i[key]===second)?second:fallback;
  if(manifest.method.parser_output_access!==aggregate('parser_output_access','used','unknown','not_used'))errors.push('REFERENCE_METHOD_ACCESS_MISMATCH');
  if(manifest.method.source_access!==aggregate('source_access','not_used','unknown','used'))errors.push('REFERENCE_METHOD_SOURCE_ACCESS_MISMATCH');
  if(manifest.method.verification!==(manifest.items.some(i=>i.verification==='user_and_assisted')?'user_and_assisted':'assisted'))errors.push('REFERENCE_METHOD_VERIFICATION_MISMATCH');
  if(new Set(manifest.items.map(i=>i.evidence_id)).size!==manifest.items.length)errors.push('WORKBOOK_DUPLICATE_KEY');
  for(const item of manifest.items){if(item.document_id!==item.locator.document_id)errors.push('REFERENCE_DOCUMENT_LOCATOR_MISMATCH:'+item.evidence_id);if(item.locator.kind==='pdf'&&item.locator.page_status!=='known')errors.push('REFERENCE_SCHEMA_INVALID:unknown PDF reference page');}
  if(manifest.input_fingerprint!==hash(workbookSourceDocumentMap(manifest.source_document_map))) errors.push('WORKBOOK_SOURCE_BINDING_MISMATCH');
  return {ok:!errors.length,errors};
}

const validRectangle = (r,format='xlsx') => r && ['start_row','start_column','end_row','end_column'].every(k=>Number.isInteger(r[k])&&r[k]>=1) && r.start_row<=r.end_row && r.start_column<=r.end_column && r.end_row<=(format==='xls'?65536:1048576) && r.end_column<=(format==='xls'?256:16384);
const containsCell = (r,c) => c.row>=r.start_row && c.row<=r.end_row && c.column>=r.start_column && c.column<=r.end_column;
const rectangleBlockId = (s,r) => `sheet:${s.index}:R${r.start_row}C${r.start_column}:R${r.end_row}C${r.end_column}`;
const uniqueBy = (values,key) => new Set(values.map(key)).size===values.length;

function validateWorkbookSourceBindings(run,required,label) {
  const errors=[],sources=new Map(run.sources.map(s=>[s.document_id,s]));
  const add=code=>errors.push(code);
  if(!uniqueBy(run.sources,s=>s.document_id)||!uniqueBy(run.sources.filter(s=>s.kind==='workbook'&&s.container.kind==='archive'),s=>s.container.document_id+':'+s.member_path)||!uniqueBy(run.blocks,b=>b.id))add('WORKBOOK_DUPLICATE_KEY');
  if(!uniqueBy(required,c=>c.document_id)||!uniqueBy(run.required_coverage,c=>c.document_id)||!uniqueBy(run.source_coverage,c=>c.document_id))add('WORKBOOK_DUPLICATE_KEY');
  if(hash(run.required_coverage)!==hash(required))add('WORKBOOK_SOURCE_BINDING_MISMATCH');
  if(run.required_coverage_fingerprint!==hash(run.required_coverage)||run.observation_fingerprint!==hash({blocks:run.blocks,source_coverage:run.source_coverage,capabilities:run.capabilities})||run.parser_run_id!==deriveWorkbookParserRunIdentity(run))add('WORKBOOK_SOURCE_BINDING_MISMATCH');
  const sourceKeys=[...sources.keys()].sort();
  if(hash(required.map(c=>c.document_id).sort())!==hash(sourceKeys)||hash(run.source_coverage.map(c=>c.document_id).sort())!==hash(sourceKeys))add('WORKBOOK_COVERAGE_SET_MISMATCH');
  const workbookSources=run.sources.filter(s=>s.kind==='workbook');
  if(!uniqueBy(run.capabilities,c=>c.document_id)||hash(run.capabilities.map(c=>c.document_id).sort())!==hash(workbookSources.map(s=>s.document_id).sort()))add('WORKBOOK_COVERAGE_SET_MISMATCH');
  for(const source of run.sources){
    if(source.availability!=='available'||!source.source_sha256)add('WORKBOOK_SOURCE_BINDING_MISMATCH');
    if(source.kind==='workbook'){
      if(!source.container.sha256 || (source.container.kind==='direct'&&(source.container.document_id!==source.document_id||source.container.sha256!==source.source_sha256||source.member_path!==null)) || (source.container.kind==='archive'&&(typeof source.member_path!=='string'||source.member_path.startsWith('/')||source.member_path.includes('\\')||source.member_path.split('/').some(p=>!p||p==='.'||p==='..'))))add('WORKBOOK_SOURCE_BINDING_MISMATCH');
      const capability=run.capabilities.find(c=>c.document_id===source.document_id);
      if(capability?.format!==source.format)add('WORKBOOK_SOURCE_BINDING_MISMATCH');
      if(capability?.status==='unsupported')add(label+'_WORKBOOK_UNSUPPORTED');if(capability?.status==='unknown')add('WORKBOOK_CAPABILITY_UNKNOWN');
    }
  }
  const boundLocator=loc=>{
    const source=sources.get(loc.document_id),req=required.find(c=>c.document_id===loc.document_id);
    if(!source||source.kind!==loc.kind)return false;
    if(loc.kind==='pdf')return loc.page_status==='known'&&req?.required_pages?.includes(loc.page_number);
    return source.member_path===loc.member_path&&req?.sheets?.some(s=>s.index===loc.sheet.index&&s.name===loc.sheet.name)&&validRectangle(loc.range,source.format)&&loc.source_block_id===rectangleBlockId(loc.sheet,loc.range);
  };
  const observedLocator=loc=>run.blocks.some(b=>sameLocator(b.locator,loc)&&b.cells?.length>0);
  const checkContext=(context,documentId)=>{
    for(const value of Object.values(context)){
      if(value.applicability==='inapplicable'){if(value.locators.length||!value.reason.trim())add('WORKBOOK_CONTEXT_BINDING_INVALID');continue;}
      if(!value.locators.length)add('WORKBOOK_CONTEXT_BINDING_INVALID');
      for(const loc of value.locators)if(loc.document_id!==documentId||!boundLocator(loc)||!observedLocator(loc))add('WORKBOOK_CONTEXT_BINDING_INVALID');
    }
  };
  for(const block of run.blocks){
    if(!boundLocator(block.locator)){add('WORKBOOK_SOURCE_BINDING_MISMATCH');continue;}
    if(block.locator.kind!=='workbook')continue;
    const rect=block.locator.range,source=sources.get(block.locator.document_id);
    if(!validRectangle(rect,source.format))add('WORKBOOK_RANGE_INVALID');
    if(!uniqueBy(block.cells,c=>c.row+':'+c.column))add('WORKBOOK_DUPLICATE_OBSERVATION');
    if(block.cells.some(c=>!containsCell(rect,c)))add('WORKBOOK_RANGE_INVALID');
    if(block.cells.length!==(rect.end_row-rect.start_row+1)*(rect.end_column-rect.start_column+1))add('WORKBOOK_OBSERVATION_REQUIRED');
    for(const c of block.cells){
      if((c.state==='blank'&&c.value!==null)||(c.state==='error'&&typeof c.value!=='string')||(c.state==='value'&&(c.value===null||typeof c.value==='number'&&!Number.isFinite(c.value)))||(c.formula===null&&c.cached_value_status!=='not_formula')||(c.formula!==null&&c.cached_value_status==='not_formula'))add('WORKBOOK_OBSERVATION_REQUIRED');
    }
    for(const merged of block.merged_ranges){if(!validRectangle(merged,source.format)||!containsCell(rect,{row:merged.start_row,column:merged.start_column})||!containsCell(rect,{row:merged.end_row,column:merged.end_column}))add('WORKBOOK_MERGED_CELL_BINDING_INVALID');for(const c of block.cells)if(containsCell(merged,c)&&(c.row!==merged.start_row||c.column!==merged.start_column)&&c.state!=='blank')add('WORKBOOK_MERGED_CELL_BINDING_INVALID');}
    checkContext(block.context_bindings,block.locator.document_id);
  }
  for(const req of required){
    const source=sources.get(req.document_id),coverage=run.source_coverage.find(c=>c.document_id===req.document_id);
    if(!source||!coverage||req.kind!==source.kind||coverage.kind!==source.kind){add('WORKBOOK_COVERAGE_SET_MISMATCH');continue;}
    if(req.kind==='pdf'){if(!req.required_pages.length||coverage.unknown_item_count||req.required_pages.some(p=>!coverage.known_pages.includes(p)||!run.blocks.some(b=>b.locator.document_id===req.document_id&&b.locator.page_status==='known'&&b.locator.page_number===p)))add('WORKBOOK_COVERAGE_SET_MISMATCH');continue;}
    if(!uniqueBy(req.sheets,s=>s.index)||!uniqueBy(req.sheets,s=>s.name)||!uniqueBy(coverage.sheets,s=>s.index)||!uniqueBy(coverage.sheets,s=>s.name))add('WORKBOOK_DUPLICATE_KEY');
    if(hash(req.sheets.map(s=>[s.index,s.name]).sort())!==hash(coverage.sheets.map(s=>[s.index,s.name]).sort())){add('WORKBOOK_COVERAGE_SET_MISMATCH');add('WORKBOOK_SOURCE_BINDING_MISMATCH');}
    if(coverage.status!=='read')add('WORKBOOK_RANGE_'+coverage.status.toUpperCase());
    const scopes=[];
    for(const s of req.sheets){
      const observed=coverage.sheets.find(c=>c.index===s.index&&c.name===s.name);
      if(!observed)continue;
      if(!uniqueBy(observed.ranges,r=>r.scope_id)||!uniqueBy(s.ranges,r=>r.scope_id))add('WORKBOOK_DUPLICATE_KEY');
      scopes.push(...s.ranges.map(r=>r.scope_id));
      if(s.disposition==='out_of_scope'){if(s.ranges.length||observed.ranges.length)add('WORKBOOK_COVERAGE_SET_MISMATCH');continue;}
      if(!s.ranges.length){if(s.empty_sheet_check!==true)add('WORKBOOK_COVERAGE_SET_MISMATCH');else if(observed.status!=='empty_sheet'||observed.empty_check.status!=='complete'||observed.ranges.length||run.blocks.some(b=>b.locator.document_id===req.document_id&&b.locator.sheet?.index===s.index))add('WORKBOOK_EMPTY_SHEET_UNVERIFIED');continue;}
      if(observed.status==='empty_sheet')add('WORKBOOK_EMPTY_SHEET_UNVERIFIED');
      else if(observed.status!=='read')add('WORKBOOK_SHEET_'+observed.status.toUpperCase());
      if(hash(s.ranges.map(r=>r.scope_id).sort())!==hash(observed.ranges.map(r=>r.scope_id).sort()))add('WORKBOOK_COVERAGE_SET_MISMATCH');
      for(const scope of s.ranges){
        const range=observed.ranges.find(r=>r.scope_id===scope.scope_id);
        if(!validRectangle(scope.range,source.format)||range&&!validRectangle(range.range,source.format))add('WORKBOOK_RANGE_INVALID');
        if(!range)continue;
        if(hash(scope.range)!==hash(range.range))add('WORKBOOK_COVERAGE_SET_MISMATCH');
        if(range.status!=='read'){add('WORKBOOK_RANGE_'+range.status.toUpperCase());if([range.cells_observed,range.blank_count,range.error_count].some(n=>n!==null))add('WORKBOOK_OBSERVATION_REQUIRED');continue;}
        const loc={kind:'workbook',document_id:req.document_id,member_path:source.member_path,sheet:{index:s.index,name:s.name},range:scope.range,source_block_id:rectangleBlockId(s,scope.range)};
        const blocks=run.blocks.filter(b=>sameLocator(b.locator,loc));
        if(blocks.length!==1){add(blocks.length?'WORKBOOK_DUPLICATE_OBSERVATION':'WORKBOOK_OBSERVATION_REQUIRED');continue;}
        const block=blocks[0];
        if(hash(block.context_bindings)!==hash(scope.context_bindings))add('WORKBOOK_CONTEXT_BINDING_INVALID');
        if(range.cells_observed!==block.cells.length||range.blank_count!==block.cells.filter(c=>c.state==='blank').length||range.error_count!==block.cells.filter(c=>c.state==='error').length)add('WORKBOOK_OBSERVATION_REQUIRED');
        // A changed observed association is a semantic mismatch at item comparison;
        // the preregistered context must itself be physically observed.
        checkContext(scope.context_bindings,req.document_id);
      }
    }
    if(!uniqueBy(scopes,x=>x))add('WORKBOOK_DUPLICATE_KEY');
  }
  return [...new Set(errors)];
}

function workbookItemObservation(run,item,policy,side) {
  if(item.locator.kind==='pdf') return itemObservation(run,item,policy.locator_maps??[],side);
  const blocks=run.blocks.filter(b=>sameLocator(b.locator,item.locator));
  if(!blocks.length) return {outcome:'missing',blocks,code:'WORKBOOK_LOCATION_MISMATCH'};
  const block=blocks[0];
  if(hash(block.context_bindings)!==hash(item.context_bindings)) return {outcome:'wrong_context',blocks,code:'WORKBOOK_CONTEXT_BINDING_INVALID'};
  if(block.cells.some(c=>c.formula!==null&&c.cached_value_status==='missing')) return {outcome:'invalid_value',blocks,code:'WORKBOOK_FORMULA_CACHE_MISSING'};
  if(hash(block.cells)!==hash(item.expected_cells)) return {outcome:'wrong_semantic_unit',blocks,code:block.cells.some(c=>c.state!=='value')?'WORKBOOK_REQUIRED_VALUE_INVALID':'WORKBOOK_LOCATION_MISMATCH'};
  return {outcome:'matched',blocks};
}

function compareWorkbookParserRuns(input) {
  const {baselineRun,candidateRun,referenceManifest,comparisonPolicy,candidateDescriptor}=input;
  const errors=[];
  if(Object.hasOwn(input,'goldManifest') || baselineRun?.schema_version!=='phase21-parser-run-workbook-1.0'||candidateRun?.schema_version!=='phase21-parser-run-workbook-1.0'||referenceManifest?.schema_version!=='phase21-accepted-reference-workbook-1.0') return nonComparable(['WORKBOOK_CONTRACT_VERSION_MISMATCH'],[],true);
  for(const [label,run] of [['BASELINE',baselineRun],['CANDIDATE',candidateRun]]) errors.push(...plainError(workbookValidator.validate('phase21/native-workbook#/$defs/run',run),label+'_WORKBOOK_SCHEMA_INVALID'));
  const reference=validateWorkbookReferenceManifest(referenceManifest);errors.push(...reference.errors);
  if(errors.some(e=>e.includes('SCHEMA_INVALID')))return {...nonComparable(errors,[],true),schema_version:'phase21-reference-comparison-workbook-1.0',source_document_map:structuredClone(referenceManifest?.source_document_map??[]),source_coverage:{baseline:structuredClone(baselineRun?.source_coverage??[]),candidate:structuredClone(candidateRun?.source_coverage??[]),required:structuredClone(referenceManifest?.required_coverage??[])},capability_report:{baseline:structuredClone(baselineRun?.capabilities??[]),candidate:structuredClone(candidateRun?.capabilities??[])},evidence_denominator:referenceManifest?.items?.length??0};
  if(!errors.length){
    const sources=hash(workbookSourceDocumentMap(baselineRun.sources));
    if(sources!==hash(workbookSourceDocumentMap(candidateRun.sources))||sources!==hash(workbookSourceDocumentMap(referenceManifest.source_document_map))) errors.push('WORKBOOK_SOURCE_BINDING_MISMATCH');
    errors.push(...validateReferenceBasis(comparisonPolicy,referenceManifest));
    if(comparisonPolicy.central_evidence_rule!=='reject'||!Array.isArray(comparisonPolicy.locator_maps)) errors.push('COMPARISON_POLICY_INVALID');
    const descriptor=candidateDescriptor?.backend_kind==='workbook_reader'?{...candidateDescriptor,backend_kind:'hybrid'}:candidateDescriptor;
    const descriptorRun=candidateDescriptor?.backend_kind==='workbook_reader'?{...candidateRun,backend:'hybrid'}:candidateRun;
    errors.push(...validateCandidateDescriptor(descriptor,descriptorRun));
    if(hash(workbookSourceDocumentMap(candidateDescriptor?.source_document_map??[]))!==sources || hash(candidateDescriptor?.capabilities??[])!==hash(candidateRun.capabilities)) errors.push('WORKBOOK_SOURCE_BINDING_MISMATCH');
    errors.push(...validateWorkbookSourceBindings(baselineRun,referenceManifest.required_coverage,'BASELINE'),...validateWorkbookSourceBindings(candidateRun,referenceManifest.required_coverage,'CANDIDATE'));
    const workbookIds=new Set(referenceManifest.items.filter(i=>i.locator.kind==='workbook').map(i=>i.evidence_id));
    const scopedPdfPolicies=['evidence_unit_maps','citation_spans','citation_unit_groups'];
    const policyTouchesWorkbook=(value)=>value&&typeof value==='object'&&(value.kind==='workbook'||workbookIds.has(value.evidence_id)||Object.values(value).some(v=>typeof v==='object'&&policyTouchesWorkbook(v)));
    if(['reviewed_comparison','derived_review','derived_reviewed_run','citation_groups'].some(k=>Object.hasOwn(comparisonPolicy,k))||scopedPdfPolicies.some(k=>policyTouchesWorkbook(comparisonPolicy[k])))errors.push('WORKBOOK_TEXT_SPAN_POLICY_UNSUPPORTED');
    if(comparisonPolicy.locator_maps.some(m=>[m.gold_locator,...(m.baseline_locators??[]),...(m.candidate_locators??[])].some(l=>l?.kind==='workbook')))errors.push('WORKBOOK_SEGMENTATION_UNSUPPORTED');
    for(const item of referenceManifest.items){
      const required=referenceManifest.required_coverage.find(c=>c.document_id===item.document_id);
      if(item.locator.kind==='workbook'){
        const source=referenceManifest.source_document_map.find(s=>s.document_id===item.document_id),sheet=required?.sheets?.find(s=>s.index===item.locator.sheet.index&&s.name===item.locator.sheet.name);
        if(!source||source.member_path!==item.locator.member_path||!sheet||!sheet.ranges.some(r=>hash(r.range)===hash(item.locator.range)&&hash(r.context_bindings)===hash(item.context_bindings)))errors.push('WORKBOOK_SOURCE_BINDING_MISMATCH');
      }else if(!required?.required_pages?.includes(item.locator.page_number))errors.push('WORKBOOK_COVERAGE_SET_MISMATCH');
    }
  }
  const inventory={schema_version:'phase21-reference-comparison-workbook-1.0',source_document_map:workbookSourceDocumentMap(baselineRun.sources),source_coverage:{baseline:structuredClone(baselineRun.source_coverage),candidate:structuredClone(candidateRun.source_coverage),required:structuredClone(referenceManifest.required_coverage)},capability_report:{baseline:structuredClone(baselineRun.capabilities),candidate:structuredClone(candidateRun.capabilities)},evidence_denominator:referenceManifest.items.length};
  if(errors.length) return {...nonComparable(errors,[],true),...inventory};
  const units=evidenceUnits(comparisonPolicy,referenceManifest,baselineRun,candidateRun,true);
  if(units.errors.length)return {...nonComparable(units.errors,[],true),...inventory};
  const baselineObservations=new Map(),candidateObservations=new Map();
  for(const item of referenceManifest.items){
    baselineObservations.set(item.evidence_id,item.locator.kind==='pdf'&&units.resolved.has(item.evidence_id)?units.resolved.get(item.evidence_id).baseline:workbookItemObservation(baselineRun,item,comparisonPolicy,'baseline'));candidateObservations.set(item.evidence_id,item.locator.kind==='pdf'&&units.resolved.has(item.evidence_id)?units.resolved.get(item.evidence_id).candidate:workbookItemObservation(candidateRun,item,comparisonPolicy,'candidate'));
    if(item.locator.kind==='workbook'){
      const baseline=baselineObservations.get(item.evidence_id),candidate=candidateObservations.get(item.evidence_id);
      if(baseline.blocks.length&&candidate.blocks.length&&hash(baseline.blocks[0].merged_ranges)!==hash(candidate.blocks[0].merged_ranges))return {...nonComparable(['WORKBOOK_MERGED_CELL_BINDING_INVALID'],[],true),...inventory};
      for(const binding of Object.values(item.context_bindings))for(const loc of binding.locators){const a=baselineRun.blocks.find(b=>sameLocator(b.locator,loc)),b=candidateRun.blocks.find(b=>sameLocator(b.locator,loc));if(a&&b&&hash({cells:a.cells,merged_ranges:a.merged_ranges})!==hash({cells:b.cells,merged_ranges:b.merged_ranges}))return {...nonComparable(['WORKBOOK_CONTEXT_BINDING_INVALID'],[],true),...inventory};}
    }
  }
  const matched=x=>['matched','segmented_match'].includes(x.outcome);
  const criticalMissing=referenceManifest.items.filter(i=>i.centrality==='central'&&(!matched(baselineObservations.get(i.evidence_id))||!matched(candidateObservations.get(i.evidence_id))));
  const shared=referenceManifest.items.filter(i=>!matched(baselineObservations.get(i.evidence_id))&&!matched(candidateObservations.get(i.evidence_id)));
  const observationErrors=[...baselineObservations.values(),...candidateObservations.values()].map(x=>x.code).filter(Boolean);
  if(shared.some(i=>i.centrality==='central')) observationErrors.push('WORKBOOK_CENTRAL_EVIDENCE_MISSING');
  return {...inventory,status:criticalMissing.length?'rejected':'compared',comparison_identity:hash({contract_version:'phase21-native-workbook-1.0',...input}),baseline_run_fingerprint:hash(baselineRun),candidate_run_fingerprint:hash(candidateRun),reference_manifest_fingerprint:hash(referenceManifest),comparison_policy_fingerprint:hash(comparisonPolicy),reference_basis:structuredClone(comparisonPolicy.reference_basis),reference_method:structuredClone(referenceManifest.method),reference_scope:structuredClone(referenceManifest.scope),errors:[...new Set(observationErrors)].sort(),shared_omissions:shared.map(i=>structuredClone(i)),critical_missing:criticalMissing.map(i=>structuredClone(i)),category_metrics:metrics(referenceManifest.items,baselineObservations,candidateObservations),workbook_observations:referenceManifest.items.map(i=>({evidence_id:i.evidence_id,baseline:structuredClone(baselineObservations.get(i.evidence_id)),candidate:structuredClone(candidateObservations.get(i.evidence_id))})),resource_observations:resourceObservations(baselineRun,candidateRun),candidate:{status:'accepted_for_comparison',disposition:'candidate_only',backend_kind:candidateDescriptor.backend_kind,default_status:'mineru_production_default_unchanged'},limitations:['offline synthetic contract only; accepted assisted nonblind reference does not authenticate sources or reader identity, prove independent gold, scientific correctness, or authorize scientific handoff']};
}
