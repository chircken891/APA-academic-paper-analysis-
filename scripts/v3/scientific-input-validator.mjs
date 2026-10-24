import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { canonicalizeV3Json, fingerprintV3Json, checkV3StorageSafety, validateSourceCoreReferences } from './semantic-package-validator.mjs';
import { validateScientificContent } from './scientific-quality-validator.mjs';
import { validateNativeScientificInput } from './native-scientific-validator.mjs';
import {validateWholePaperScientificInput,validateSourceEvidenceScientificInput} from './whole-paper-scientific-validator.mjs';
import {buildSourceEvidenceVisibleView} from './source-evidence-bundle.mjs';

// Only project-owned schemas are read at initialization. No input-driven I/O.
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addKeyword({
  keyword: 'uniqueItemProperty', type: 'array', schemaType: 'string', errors: false,
  validate: (property, values) => new Set(values.map(value => value?.[property])).size === values.length,
});
for (const path of [
  '../../Schema/contracts/v3-source-package.schema.json',
  '../../Schema/contracts/v3-analysis-package.schema.json',
  '../../Schema/contracts/v3-scientific/v3-scientific-package.schema.json',
  '../../Schema/phase21/scientific-input.schema.json',
]) ajv.addSchema(JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8')));
const shape = ajv.getSchema('phase21-scientific-input');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const isWholePaper = candidate => candidate !== null && typeof candidate === 'object'
  && ['phase21-scientific-input-whole-paper-1.0','phase21-scientific-input-source-evidence-1.0'].includes(Object.getOwnPropertyDescriptor(candidate, 'schema_version')?.value);

/** Content identity only: no validation, authorization, review, or mutation. */
export function fingerprintScientificInput(candidate) {
  const whole = isWholePaper(candidate);
  if (whole && Object.values(Object.getOwnPropertyDescriptors(candidate)).some(d => !Object.hasOwn(d, 'value'))) throw new TypeError('INVALID_JSON_VALUE');
  const { input_fingerprint, ...content } = candidate;
  if (whole) return fingerprintV3Json(content);
  return 'sha256:' + createHash('sha256').update(canonicalizeV3Json(content)).digest('hex');
}

/** Checks pre-render preparation, never complete_scientific_input or a publishable candidate. */
export function validateScientificInput(candidate) {
  const errors = [];
  const add = (code, path) => errors.push({ code, path, message: code });
  const result = () => ({
    ok: errors.length === 0,
    status: errors.length ? 'invalid_preparation' : 'preparation_validated',
    errors: errors.sort((a, b) => compare(a.code, b.code) || compare(a.path, b.path)),
    warnings: [],
    publishable: false,
    ...(errors.length ? {} : {
      input_fingerprint: candidate.input_fingerprint,
      scientific_completeness: candidate.scientific_details.source_status.completeness,
    }),
  });
  const whole = isWholePaper(candidate);
  try { whole ? fingerprintV3Json(candidate) : canonicalizeV3Json(candidate); } catch {
    add('SCIENTIFIC_INPUT_STRUCTURE_INVALID', '/'); return result();
  }
  if(whole&&candidate.schema_version==='phase21-scientific-input-source-evidence-1.0')return validateSourceEvidenceScientificInput(candidate);
  checkV3StorageSafety(candidate, '/', add, whole?'phase21-whole-paper-1.0':undefined);
  if (errors.length) return result();
  // Exact companion-contract opt-in after the existing JSON/storage preflight.
  if(whole)return validateWholePaperScientificInput(candidate);
  if (candidate?.schema_version === 'phase21-scientific-input-workbook-1.0') return validateNativeScientificInput(candidate);
  if (typeof candidate?.schema_version === 'string' && candidate.schema_version !== 'phase21-scientific-input-1.0') {
    add('SCIENTIFIC_INPUT_CONTRACT_UNSUPPORTED', '/schema_version'); return result();
  }
  if (!shape(candidate)) {
    // Report known field locations only; unknown keys/values are untrusted.
    const roots = new Set(['schema_version', 'identity', 'source_package', 'core', 'reading_card', 'scientific_details', 'input_fingerprint']);
    for (const error of shape.errors ?? []) {
      const root = error.instancePath.split('/')[1] || error.params.missingProperty;
      add('SCIENTIFIC_INPUT_STRUCTURE_INVALID', roots.has(root) ? '/' + root : '/');
    }
    return result();
  }
  if (candidate.identity.paper_id !== candidate.source_package.paper_id) add('SCIENTIFIC_IDENTITY_MISMATCH', '/identity');
  for (const key of ['core', 'reading_card']) {
    if (candidate[key].paper_id !== candidate.identity.paper_id
      || candidate[key].analysis_revision !== candidate.identity.analysis_revision) add('IDENTITY_MISMATCH', '/' + key);
  }
  validateSourceCoreReferences(candidate, add);
  validateScientificContent(candidate.scientific_details, candidate, add);
  if (candidate.input_fingerprint !== fingerprintScientificInput(candidate)) add('SCIENTIFIC_INPUT_BINDING_STALE', '/input_fingerprint');
  return result();
}

/** Whitelisted scientific context for later review/roles; never the source-only first pass. */
export function buildSourceEvidenceModelInput({scientificInput}={}){
  try{
    const checked=validateScientificInput(scientificInput);
    if(!checked.ok)return {ok:false,input:null,errors:[...new Set(checked.errors.map(e=>e.code))].sort()};
    if(scientificInput.schema_version!=='phase21-scientific-input-source-evidence-1.0')return {ok:false,input:null,errors:['SOURCE_EVIDENCE_INPUT_REQUIRED']};
    const projected=buildSourceEvidenceVisibleView({bundle:scientificInput.source_evidence_bundle});if(!projected.ok)return {ok:false,input:null,errors:projected.errors};
    const fields=['identity','source_package','core','reading_card','scientific_details','source_value_metadata','input_fingerprint'];
    const scientific_context=Object.fromEntries(fields.map(key=>[key,structuredClone(scientificInput[key])]));
    scientific_context.parser_evaluation_disposition=Object.fromEntries(['requirement_status','comparison_status','source_scope_fingerprint','reason'].map(key=>[key,structuredClone(scientificInput.parser_evaluation_disposition[key])]));
    const input={source_view:projected.view,scientific_context};input.model_input_fingerprint=fingerprintV3Json(input);
    return {ok:true,input,errors:[]};
  }catch{return {ok:false,input:null,errors:['SOURCE_EVIDENCE_VISIBLE_CONTENT_UNSAFE']};}
}
