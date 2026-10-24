import { createHash } from 'node:crypto';
import { readFile, mkdtemp, mkdir, writeFile, lstat, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createPhase21ContractValidator } from './phase21-contract-loader.mjs';
import { canonicalizeV3Json } from './semantic-package-validator.mjs';
import { deriveParserRunIdentity } from './parser-adapter.mjs';
import { checkMineruRuntime } from '../lib/mineru-runtime.mjs';
import { createCurrentMineruBaselinePort } from './phase21-runner.mjs';
import { DEFAULT_APA_MODEL } from '../apa-model-policy.mjs';

export const ARCHIVE_METHOD = 'archive-pdf-representation-1';
// The frozen SCI permits src_ + 32 hex characters. New archive leaves reserve
// this prefix; ordinary source identities keep their existing validation rules.
export const ARCHIVE_SOURCE_NAMESPACE = /^src_a7c1e001[0-9a-f]{24}$/;
export const archiveFingerprint = value => 'sha256:' + createHash('sha256').update(canonicalizeV3Json(value)).digest('hex');
const sha = { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' };
const text = { type: 'string', minLength: 1 };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const array = items => ({ type: 'array', items });
const schema = {
  $id: 'phase21/archive-representation',
  ...object({
    schema_version: { const: 'phase21-archive-representation-1.0' },
    evidence_tier: { enum: ['offline_fixture', 'actual_local'] },
    archive: object({ document_id: text, source_sha256: sha, byte_length: { type: 'integer', minimum: 1 }, member_count: {type:'integer',minimum:1} }),
    inventory: array(object({ member_path: text, original_format: { enum: ['docx','xlsx','pdf','lock'] }, byte_length: { type: 'integer', minimum: 0 }, member_sha256: sha,
      disposition: { enum: ['included','excluded'] }, reason: text, availability: { enum: ['available','missing','unsupported','unknown'] }, required: { type: 'boolean' }, critical: { type: 'boolean' }, required_mapping_ids: array(text) })),
    inventory_fingerprint: sha,
    representations: array(object({ member_path: text, member_sha256: sha, representation_id: text, representation_sha256: sha, format: { const: 'pdf' }, status: { enum: ['converted','pass_through','failed','unknown'] },
      converter: object({ identity: text, version: text, config_fingerprint: sha }), record: object({ request_ref: text, exit_code: { type: ['integer','null'] }, output_ref: text, evidence_tier: { enum: ['offline_fixture','actual_local'] } }) })),
    mappings: array(object({ mapping_id: text, revision: text, member_path: text, member_sha256: sha, representation_id: text, representation_sha256: sha,
      original_locator: { type: 'object', minProperties: 1 }, derived_locator: object({ document_id: text, page_number: { type: 'integer', minimum: 1 }, page_status: { const: 'known' }, source_block_id: text }),
      status: { enum: ['verified','uncovered','unknown'] }, reason: text, fidelity: object({ crop: { enum: ['complete','cropped','unknown'] }, footnotes: { enum: ['preserved','missing','inapplicable','unknown'] }, hidden_content: { enum: ['preserved','missing','inapplicable','unknown'] }, formula_cache: { enum: ['preserved','missing','inapplicable','unknown'] } }),
      page_image: object({ representation_sha256: sha, page_number: { type: 'integer', minimum: 1 }, image_sha256: sha }) })),
    mapping_revision: text,
    source_document_map: array(object({ document_id: text, role: { enum: ['main','attachment'] }, critical: { type: 'boolean' }, availability: { enum: ['available','missing'] }, source_sha256: sha })),
    backend_bindings: object({ baseline: { type: 'object' }, candidate: { type: 'object' }, shared_preprocessing: { const: true } }),
    reference_binding: object({ reference_manifest_id: sha, fingerprint: sha, method: { type: 'object' }, evidence_mappings: array(object({ evidence_id: text, mapping_id: text, original_locator: { type: 'object' }, derived_locator: { type: 'object' } })) }),
  }),
};
const validator = await createPhase21ContractValidator({ schemas: [schema] });
const workbookSchema = JSON.parse(await readFile(new URL('../../Schema/phase21/native-workbook.schema.json',import.meta.url),'utf8'));
const workbookValidator = await createPhase21ContractValidator({schemas:[workbookSchema]});
const parserRunSchema=JSON.parse(await readFile(new URL('../../Schema/phase21/parser-run.schema.json',import.meta.url),'utf8'));
const referenceSchema=JSON.parse(await readFile(new URL('../../Schema/phase21/accepted-reference.schema.json',import.meta.url),'utf8'));
const goldSchema=JSON.parse(await readFile(new URL('../../Schema/phase21/gold-manifest.schema.json',import.meta.url),'utf8'));
const bindingValidator=await createPhase21ContractValidator({schemas:[parserRunSchema,goldSchema,referenceSchema]});
const sortedMap = sources => [...sources].sort((a,b) => a.document_id.localeCompare(b.document_id));
export const hasArchiveMethod = run => typeof run?.normalization_version==='string' && run.normalization_version.split('+')[0] === ARCHIVE_METHOD;
export const hasArchiveSources = run => Array.isArray(run?.sources) && run.sources.some(s => typeof s?.document_id==='string' && ARCHIVE_SOURCE_NAMESPACE.test(s.document_id));
export function deriveArchiveRepresentationId({ archive, member_path, member_sha256, representation_sha256 }) {
  return 'src_a7c1e001' + archiveFingerprint({ archive, member_path, member_sha256, representation_sha256 }).slice(7,31);
}
const validPath = path => typeof path === 'string' && !path.includes('\\') && !path.includes(':') && !path.startsWith('/') && path.split('/').every(part => part && part !== '.' && part !== '..') && path.normalize('NFC') === path;
const same = (a,b) => archiveFingerprint(a) === archiveFingerprint(b);
const plainObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const workbookShape=(kind,value)=>workbookValidator.validate(workbookSchema.$id+'#/$defs/'+kind,value).ok;

/** Local companion contract only; a supplied SHA or offline fixture is not authenticated source evidence. */
export function validateArchiveRepresentation(record) {
  const shape = validator.validate(schema.$id, record);
  if (!shape.ok) return { ok: false, errors: shape.errors.map(e => 'ARCHIVE_SCHEMA_INVALID:' + e) };
  const errors = [], add = code => errors.push(code);
  const members = new Map();
  for (const member of record.inventory) {
    if (!validPath(member.member_path)) add('ARCHIVE_MEMBER_PATH_INVALID');
    const key = member.member_path.normalize('NFC').toLowerCase();
    if (members.has(key)) add('ARCHIVE_MEMBER_DUPLICATE');
    members.set(key, member);
    const lock = member.member_path.split('/').at(-1).startsWith('~$');
    if(!lock && member.member_path.split('.').at(-1).toLowerCase()!==member.original_format)add('ARCHIVE_MEMBER_FORMAT_MISMATCH');
    if (lock !== (member.original_format === 'lock') || lock && (member.disposition !== 'excluded' || member.required || member.critical) || !lock && member.disposition === 'excluded') add('ARCHIVE_LOCK_DISPOSITION_INVALID');
    if (member.critical && !member.required) add('ARCHIVE_CRITICAL_NOT_REQUIRED');
    if (member.required && (member.availability !== 'available' || member.disposition !== 'included')) add('ARCHIVE_REQUIRED_MEMBER_UNAVAILABLE:' + member.member_path);
    if (member.required && !member.required_mapping_ids.length) add('ARCHIVE_REQUIRED_MAPPING_MISSING:' + member.member_path);
  }
  if (!record.inventory.length || record.archive.member_count !== record.inventory.length || record.inventory_fingerprint !== archiveFingerprint(record.inventory)) add('ARCHIVE_INVENTORY_BINDING_MISMATCH');
  const ids = new Set(), paths = new Set();
  for (const representation of record.representations) {
    const member = record.inventory.find(m => m.member_path === representation.member_path);
    if (!member || member.disposition !== 'included' || member.member_sha256 !== representation.member_sha256) add('ARCHIVE_REPRESENTATION_MEMBER_MISMATCH');
    if (ids.has(representation.representation_id) || paths.has(representation.member_path)) add('ARCHIVE_REPRESENTATION_DUPLICATE');
    ids.add(representation.representation_id); paths.add(representation.member_path);
    if (representation.representation_id !== deriveArchiveRepresentationId({ archive:record.archive, ...representation })) add('ARCHIVE_LEAF_IDENTITY_MISMATCH');
    if (member?.original_format === 'pdf' && (representation.status !== 'pass_through' || representation.member_sha256 !== representation.representation_sha256 || representation.converter.identity !== 'pass_through')) add('ARCHIVE_GUIDE_PASSTHROUGH_MISMATCH');
    if (representation.record.evidence_tier !== record.evidence_tier) add('ARCHIVE_EVIDENCE_TIER_MISMATCH');
    if (member?.required && (!['converted','pass_through'].includes(representation.status) || representation.record.exit_code !== 0)) add('ARCHIVE_REQUIRED_REPRESENTATION_UNAVAILABLE');
    const source = record.source_document_map.find(s => s.document_id === representation.representation_id);
    if (!source || source.source_sha256 !== representation.representation_sha256 || source.critical !== member?.critical || source.availability !== 'available') add('ARCHIVE_DERIVED_SOURCE_MISMATCH');
  }
  for (const member of record.inventory.filter(m => m.required)) {
    if (!paths.has(member.member_path)) add('ARCHIVE_REQUIRED_MEMBER_MISSING:' + member.member_path);
    for (const id of member.required_mapping_ids) if (!record.mappings.some(m => m.mapping_id === id && m.member_path === member.member_path)) add('ARCHIVE_REQUIRED_MAPPING_MISSING:' + id);
  }
  const mappingIds = new Set();
  for (const mapping of record.mappings) {
    const member = record.inventory.find(m => m.member_path === mapping.member_path);
    const representation = record.representations.find(r => r.representation_id === mapping.representation_id);
    if (mappingIds.has(mapping.mapping_id)) add('ARCHIVE_MAPPING_DUPLICATE');
    mappingIds.add(mapping.mapping_id);
    if (!member || mapping.member_sha256 !== member.member_sha256 || !representation || representation.member_path !== mapping.member_path || mapping.representation_sha256 !== representation.representation_sha256 || mapping.derived_locator.document_id !== mapping.representation_id) add('ARCHIVE_MAPPING_SOURCE_MISMATCH');
    if (mapping.revision !== record.mapping_revision) add('ARCHIVE_MAPPING_REVISION_MISMATCH');
    if (mapping.page_image.representation_sha256 !== mapping.representation_sha256 || mapping.page_image.page_number !== mapping.derived_locator.page_number) add('ARCHIVE_PAGE_IMAGE_MISMATCH');
    if (member?.required && (mapping.status !== 'verified' || mapping.fidelity.crop !== 'complete' || Object.values(mapping.fidelity).some(v => ['missing','unknown'].includes(v)))) add('ARCHIVE_REQUIRED_MAPPING_UNVERIFIED:' + mapping.mapping_id);
    const locator = mapping.original_locator;
    if (member?.original_format === 'pdf' && (!Number.isInteger(locator.page_number) || locator.page_number < 1)) add('ARCHIVE_GUIDE_LOCATOR_INVALID');
    if (member?.original_format === 'docx' && (!['paragraph','table','row','cell'].includes(locator.kind) || !Number.isInteger(locator.paragraph_index ?? locator.table_index) || (locator.paragraph_index ?? locator.table_index)<0 || ['row','cell'].includes(locator.kind) && (!Number.isInteger(locator.row) || locator.row<1) || locator.kind === 'cell' && (!Number.isInteger(locator.column) || locator.column<1))) add('ARCHIVE_DOCX_LOCATOR_INVALID');
    if (member?.original_format === 'xlsx') {
      if (locator.kind!=='workbook' || !plainObject(locator.sheet) || !plainObject(locator.range) || !Array.isArray(locator.cells) || !locator.cells.length || !Array.isArray(locator.delivered_ranges) || !locator.delivered_ranges.length || !plainObject(locator.context_bindings) || !Array.isArray(locator.merged_ranges)) { add('ARCHIVE_WORKBOOK_LOCATOR_INVALID'); continue; }
      const {visibility,...sheet}=locator.sheet;
      if(!workbookShape('sheet',sheet) || !sheet.name?.trim() || !['visible','hidden','very_hidden','unknown'].includes(visibility)
        || ![['range',locator.range],['context',locator.context_bindings],...locator.cells.map(c=>['cell',c]),...locator.merged_ranges.map(r=>['range',r]),...locator.delivered_ranges.map(r=>['range',r])].every(([kind,value])=>workbookShape(kind,value))) { add('ARCHIVE_WORKBOOK_LOCATOR_INVALID'); continue; }
      if (locator.cells?.some(c => c.state === 'blank' && c.value !== null || c.state === 'error' && typeof c.value !== 'string' || c.state === 'value' && c.value === null || c.formula === null && c.cached_value_status !== 'not_formula')) add('ARCHIVE_WORKBOOK_CELL_STATE_INVALID');
      const range=locator.range;
      if(range && locator.cells?.some(c=>c.row<range.start_row || c.row>range.end_row || c.column<range.start_column || c.column>range.end_column) || range && locator.cells?.length!==(range.end_row-range.start_row+1)*(range.end_column-range.start_column+1)) add('ARCHIVE_WORKBOOK_RANGE_NOT_OBSERVED');
      if(new Set((locator.cells??[]).map(c=>c.row+':'+c.column)).size!==(locator.cells??[]).length)add('ARCHIVE_WORKBOOK_DUPLICATE_CELL');
      if(!locator.delivered_ranges?.some(r=>same(r,range)))add('ARCHIVE_WORKBOOK_RANGE_NOT_DELIVERED');
      for(const merged of locator.merged_ranges??[])if(locator.cells?.some(c=>c.row>=merged.start_row&&c.row<=merged.end_row&&c.column>=merged.start_column&&c.column<=merged.end_column&&(c.row!==merged.start_row||c.column!==merged.start_column)&&c.state!=='blank'))add('ARCHIVE_WORKBOOK_MERGED_STATE_INVALID');
      if (locator.sheet?.visibility !== 'visible' || locator.cells?.some(c => !['value','blank','error'].includes(c.state) || c.formula !== null && c.cached_value_status !== 'observed')) add('ARCHIVE_WORKBOOK_ORIGINAL_OBLIGATIONS_HELD');
      for(const context of Object.values(locator.context_bindings)) {
        if(context.applicability==='inapplicable') {
          if(context.locators.length || !context.reason.trim())add('ARCHIVE_WORKBOOK_CONTEXT_BINDING_INVALID');
          continue;
        }
        if(!context.locators.length)add('ARCHIVE_WORKBOOK_CONTEXT_BINDING_INVALID');
        for(const location of context.locators) {
          if(location.document_id!==mapping.representation_id || location.member_path!==mapping.member_path || !workbookShape('sheet',location.sheet) || !workbookShape('range',location.range)) {add('ARCHIVE_WORKBOOK_CONTEXT_BINDING_INVALID');continue;}
          const blockId='sheet:'+location.sheet.index+':R'+location.range.start_row+'C'+location.range.start_column+':R'+location.range.end_row+'C'+location.range.end_column;
          const observed=record.mappings.some(target=>target.original_locator.kind==='workbook' && target.member_path===mapping.member_path && target.member_sha256===mapping.member_sha256 && target.representation_id===mapping.representation_id && target.representation_sha256===mapping.representation_sha256 && target.status==='verified' && target.revision===record.mapping_revision
            && target.fidelity.crop==='complete' && !Object.values(target.fidelity).some(value=>['missing','unknown'].includes(value)) && plainObject(target.original_locator.sheet) && workbookShape('sheet',{index:target.original_locator.sheet.index,name:target.original_locator.sheet.name})
            && target.original_locator.sheet.index===location.sheet.index && target.original_locator.sheet.name===location.sheet.name && plainObject(target.original_locator.range) && workbookShape('range',target.original_locator.range) && same(target.original_locator.range,location.range)
            && Array.isArray(target.original_locator.cells) && target.original_locator.cells.length===(location.range.end_row-location.range.start_row+1)*(location.range.end_column-location.range.start_column+1) && target.original_locator.cells.every(cell=>workbookShape('cell',cell)));
          if(location.source_block_id!==blockId || !observed)add('ARCHIVE_WORKBOOK_CONTEXT_BINDING_INVALID');
        }
      }
    }
  }
  if (new Set(record.source_document_map.map(s => s.document_id)).size !== record.source_document_map.length) add('ARCHIVE_SOURCE_DUPLICATE');
  if (record.backend_bindings.shared_preprocessing !== true) add('ARCHIVE_SHARED_PREPROCESSING_REQUIRED');
  return { ok: !errors.length, errors: [...new Set(errors)].sort() };
}

function runBinding(run, record) {
  return { parser_run_id: run.parser_run_id, normalization_version: run.normalization_version, backend: run.backend, backend_version: run.backend_version,
    config_fingerprint: run.config_fingerprint, approval_fingerprint: run.approval_fingerprint, run_fingerprint: archiveFingerprint(run),
    input_fingerprint: archiveFingerprint(sortedMap(run.sources)), output_fingerprint: archiveFingerprint({ blocks: run.blocks, assets: run.assets }),
    resource_fingerprint: archiveFingerprint(run.resource_observations), approval_scope: run.approval_scope, evidence_tier: record.evidence_tier };
}

/** Verifies actual consumer identities; does not invent a run, reference, approval, or observation. */
export function bindArchiveRepresentation(record, { baselineRun, candidateRun, referenceManifest, candidateDescriptor } = {}) {
  const checked = validateArchiveRepresentation(record), errors = [...checked.errors];
  if (!checked.ok) return checked;
  for(const [side,run]of [['BASELINE',baselineRun],['CANDIDATE',candidateRun]]) {
    const shape=bindingValidator.validate(parserRunSchema.$id,run);
    if(!shape.ok)errors.push(...shape.errors.map(error=>'ARCHIVE_'+side+'_RUN_INVALID:'+error));
  }
  const referenceShape=bindingValidator.validate(referenceSchema.$id,referenceManifest);
  if(!referenceShape.ok)errors.push(...referenceShape.errors.map(error=>'ARCHIVE_REFERENCE_INVALID:'+error));
  if(!Array.isArray(candidateDescriptor?.source_document_map) || candidateDescriptor.source_document_map.some(source=>!plainObject(source)||typeof source.document_id!=='string'||!/^sha256:[a-f0-9]{64}$/.test(source.source_sha256??'')))errors.push('ARCHIVE_DESCRIPTOR_SOURCE_MISMATCH');
  if(errors.length)return {ok:false,errors:errors.sort()};
  for (const [side, run] of [['baseline',baselineRun],['candidate',candidateRun]]) {
    if (!run || !hasArchiveMethod(run)) { errors.push('ARCHIVE_METHOD_MARKER_REQUIRED:' + side); continue; }
    if (run.parser_run_id !== deriveParserRunIdentity(run)) errors.push('ARCHIVE_RUN_IDENTITY_MISMATCH:' + side);
    const { observation, ...binding }=record.backend_bindings[side];
    if (!same(runBinding(run,record),binding)) errors.push('ARCHIVE_BACKEND_BINDING_MISMATCH:' + side);
    if(!observation || !observation.reader_identity || !observation.record_ref || !/^sha256:[a-f0-9]{64}$/.test(observation.raw_output_sha256??'') || observation.evidence_tier!==record.evidence_tier)errors.push('ARCHIVE_BACKEND_OBSERVATION_MISSING:'+side);
    if(record.evidence_tier==='actual_local' && side==='baseline' && observation?.reader_identity!=='current-mineru')errors.push('ARCHIVE_BASELINE_READER_MISMATCH');
    if (!same(sortedMap(run.sources),sortedMap(record.source_document_map))) errors.push('ARCHIVE_RUN_SOURCE_MAP_MISMATCH:' + side);
    for (const mapping of record.mappings) if (!run.blocks.some(b => same(b.locator,mapping.derived_locator))) errors.push('ARCHIVE_MAPPING_BLOCK_MISSING:' + side);
  }
  if(record.backend_bindings.baseline.observation?.reader_identity===record.backend_bindings.candidate.observation?.reader_identity)errors.push('ARCHIVE_SHARED_READER_NOT_DISTINCT_BACKENDS');
  if (!referenceManifest || record.reference_binding.reference_manifest_id !== referenceManifest.reference_manifest_id || record.reference_binding.fingerprint !== archiveFingerprint(referenceManifest) || !same(record.reference_binding.method,referenceManifest.method) || !same(sortedMap(referenceManifest.source_document_map),sortedMap(record.source_document_map))) errors.push('ARCHIVE_REFERENCE_BINDING_MISMATCH');
  if (record.reference_binding.evidence_mappings.length !== referenceManifest?.items?.length) errors.push('ARCHIVE_REFERENCE_MAPPING_SET_MISMATCH');
  for (const item of referenceManifest?.items ?? []) {
    const binding = record.reference_binding.evidence_mappings.find(m => m.evidence_id === item.evidence_id);
    const mapping = record.mappings.find(m => m.mapping_id === binding?.mapping_id);
    if (!mapping || !same(binding.original_locator,mapping.original_locator) || !same(binding.derived_locator,mapping.derived_locator) || !same(item.locator,mapping.derived_locator)) errors.push('ARCHIVE_REFERENCE_LOCATOR_MISMATCH');
  }
  const descriptor = candidateDescriptor?.source_document_map;
  if (!Array.isArray(descriptor) || !same(sortedMap(descriptor.map(s => ({document_id:s.document_id,source_sha256:s.source_sha256}))),sortedMap(record.source_document_map.map(s => ({document_id:s.document_id,source_sha256:s.source_sha256}))))) errors.push('ARCHIVE_DESCRIPTOR_SOURCE_MISMATCH');
  if (record.evidence_tier === 'actual_local' && (baselineRun?.backend !== 'mineru' || baselineRun?.resource_observations?.every(r => r.status === 'not_invoked'))) errors.push('ARCHIVE_ACTUAL_BASELINE_UNOBSERVED');
  return { ok: !errors.length, errors: [...new Set(errors)].sort(), fingerprint: archiveFingerprint(record) };
}

export function archiveRunBinding(run, record) { return runBinding(run,record); }
export function archiveSourceCheckBinding(record) {
  return { archive_fingerprint: archiveFingerprint(record.archive), inventory_fingerprint: record.inventory_fingerprint,
    mapping_fingerprint: archiveFingerprint(record.mappings), mapping_revision: record.mapping_revision, representation_fingerprint: archiveFingerprint(record.representations) };
}

const byteHash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit=0;bit<8;bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Enumerates controlled ZIP members from actual bytes. No extraction, Office, or parser is invoked. */
export function inventoryArchiveBytes({ bytes, documentId, requirements }) {
  if (!Buffer.isBuffer(bytes) || !documentId || !Array.isArray(requirements)) throw new Error('ARCHIVE_BYTES_AND_REQUIREMENTS_REQUIRED');
  let end=-1;
  for(let at=bytes.length-22;at>=Math.max(0,bytes.length-65557);at--) if(bytes.readUInt32LE(at)===0x06054b50){end=at;break;}
  if(end<0 || bytes.readUInt16LE(end+4)!==0 || bytes.readUInt16LE(end+6)!==0)throw new Error('ARCHIVE_ZIP_UNSUPPORTED');
  const count=bytes.readUInt16LE(end+10),centralSize=bytes.readUInt32LE(end+12),centralOffset=bytes.readUInt32LE(end+16);
  if(count===65535 || centralOffset+centralSize!==end || end+22+bytes.readUInt16LE(end+20)!==bytes.length || bytes.readUInt16LE(end+8)!==count)throw new Error('ARCHIVE_ZIP_DIRECTORY_INVALID');
  const members=[],seen=new Set();let at=centralOffset;
  for(let index=0;index<count;index++) {
    if(at+46>end || bytes.readUInt32LE(at)!==0x02014b50)throw new Error('ARCHIVE_ZIP_DIRECTORY_INVALID');
    const flags=bytes.readUInt16LE(at+8),method=bytes.readUInt16LE(at+10),crc=bytes.readUInt32LE(at+16),compressed=bytes.readUInt32LE(at+20),size=bytes.readUInt32LE(at+24),nameLength=bytes.readUInt16LE(at+28),extraLength=bytes.readUInt16LE(at+30),commentLength=bytes.readUInt16LE(at+32),local=bytes.readUInt32LE(at+42);
    const path=bytes.subarray(at+46,at+46+nameLength).toString(flags&0x800?'utf8':'ascii');
    if(!validPath(path) || path.includes('\0'))throw new Error('ARCHIVE_MEMBER_PATH_INVALID');
    const key=path.toLowerCase();if(seen.has(key))throw new Error('ARCHIVE_MEMBER_DUPLICATE');seen.add(key);
    if(flags&1 || ![0,8].includes(method) || size>64*1024*1024 || local+30>centralOffset || bytes.readUInt32LE(local)!==0x04034b50)throw new Error('ARCHIVE_ZIP_MEMBER_UNSUPPORTED');
    const offset=local+30+bytes.readUInt16LE(local+26)+bytes.readUInt16LE(local+28);
    if(offset+compressed>centralOffset || bytes.subarray(local+30,local+30+bytes.readUInt16LE(local+26)).toString(flags&0x800?'utf8':'ascii')!==path)throw new Error('ARCHIVE_ZIP_MEMBER_MISMATCH');
    const data=method===0?Buffer.from(bytes.subarray(offset,offset+compressed)):inflateRawSync(bytes.subarray(offset,offset+compressed),{maxOutputLength:64*1024*1024});
    if(data.length!==size || crc32(data)!==crc)throw new Error('ARCHIVE_ZIP_MEMBER_BYTES_MISMATCH');
    const req=requirements.find(r=>r.member_path===path),lock=path.split('/').at(-1).startsWith('~$'),format=lock?'lock':path.split('.').at(-1).toLowerCase();
    if(!['lock','docx','xlsx','pdf'].includes(format))throw new Error('ARCHIVE_MEMBER_FORMAT_UNSUPPORTED:'+path);
    if(!lock && !req)throw new Error('ARCHIVE_MEMBER_REQUIREMENT_MISSING:'+path);
    members.push({member_path:path,original_format:format,byte_length:data.length,member_sha256:byteHash(data),disposition:lock?'excluded':'included',reason:lock?'Office lock file':req.reason,availability:'available',required:lock?false:req.required,critical:lock?false:req.critical,required_mapping_ids:lock?[]:req.required_mapping_ids,bytes:data});
    at+=46+nameLength+extraLength+commentLength;
  }
  if(at!==end || requirements.some(r=>!members.some(m=>m.member_path===r.member_path)))throw new Error('ARCHIVE_REQUIRED_MEMBER_MISSING');
  return {archive:{document_id:documentId,source_sha256:byteHash(bytes),byte_length:bytes.length,member_count:members.length},inventory:members.map(({bytes,...member})=>member),members};
}

// Stored ZIP writer is limited to fixtures created here, never arbitrary paper input.
function fixtureZip(entries) {
  const locals=[],central=[];let offset=0;
  for(const [path,value]of entries) {
    const name=Buffer.from(path),data=Buffer.isBuffer(value)?value:Buffer.from(value),crc=crc32(data);
    const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt32LE(crc,14);header.writeUInt32LE(data.length,18);header.writeUInt32LE(data.length,22);header.writeUInt16LE(name.length,26);
    locals.push(header,name,data);
    const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x800,8);c.writeUInt32LE(crc,16);c.writeUInt32LE(data.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(name.length,28);c.writeUInt32LE(offset,42);central.push(c,name);offset+=header.length+name.length+data.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,directory,end]);
}
function syntheticPdf(label) {
  const stream='BT /F1 12 Tf 40 700 Td ('+label+') Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>','<< /Length '+Buffer.byteLength(stream)+' >>\nstream\n'+stream+'\nendstream'];
  let pdf='%PDF-1.4\n';const offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(pdf));pdf+=(i+1)+' 0 obj\n'+objects[i]+'\nendobj\n';}
  const xref=Buffer.byteLength(pdf);pdf+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF\n';return Buffer.from(pdf);
}

/** Generated, non-paper Office/PDF fixture bytes; no source paths or external input accepted. */
export function createSyntheticArchiveFixture({ fullInventory=false } = {}) {
  const types='<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>';
  const rels=target=>'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="'+target+'"/></Relationships>';
  const tableRows=Array.from({length:45},(_,index)=>'<w:tr><w:trPr><w:trHeight w:val="500" w:hRule="atLeast"/></w:trPr><w:tc><w:p><w:r><w:t>OFFLINE row '+(index+1)+'</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Value '+(index+1)+'</w:t></w:r></w:p></w:tc></w:tr>').join('');
  const docx=fixtureZip([
    ['[Content_Types].xml',types+'<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/></Types>'],
    ['_rels/.rels',rels('word/document.xml')],
    ['word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>OFFLINE synthetic paragraph. Not a research paper.</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p><w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc><w:p><w:r><w:t>Repeated header</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Synthetic value</w:t></w:r></w:p></w:tc></w:tr>'+tableRows+'</w:tbl><w:p><w:r><w:br w:type="page"/><w:t>OFFLINE final page and table footnote: units are synthetic counts.</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>'],
    ['word/_rels/document.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdFootnotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/></Relationships>'],
    ['word/footnotes.xml','<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote><w:footnote w:id="1"><w:p><w:r><w:footnoteRef/><w:t>OFFLINE synthetic footnote obligation.</w:t></w:r></w:p></w:footnote></w:footnotes>'],
  ]);
  const xlsx=fixtureZip([['[Content_Types].xml',types+'<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],['_rels/.rels',rels('xl/workbook.xml')],['xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Visible" sheetId="1" r:id="rId1"/><sheet name="Hidden" sheetId="2" state="hidden" r:id="rId2"/></sheets><calcPr calcMode="manual" fullCalcOnLoad="0" forceFullCalc="0"/></workbook>'],['xl/_rels/workbook.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>'],['xl/worksheets/sheet1.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><f>A1+1</f><v>2</v></c><c r="C1"><f>A1+2</f></c><c r="D1" t="e"><v>#N/A</v></c><c r="E1"/></row></sheetData><mergeCells count="1"><mergeCell ref="A2:B2"/></mergeCells></worksheet>'],['xl/worksheets/sheet2.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>99</v></c></row></sheetData></worksheet>']]);
  const guide=syntheticPdf('OFFLINE synthetic Guide, not research'),pdf=syntheticPdf('OFFLINE observed DOCX representation');
  const entries=fullInventory?[...Array.from({length:14},(_,i)=>['Text'+(i+1)+'.docx',docx]),...Array.from({length:7},(_,i)=>['Book'+(i+1)+'.xlsx',xlsx]),['Guide.pdf',guide],...Array.from({length:6},(_,i)=>['~$Lock'+(i+1)+'.docx',Buffer.from('synthetic lock')])]:[['Text.docx',docx],['Guide.pdf',guide],['~$Text.docx',Buffer.from('synthetic lock')]];
  return {archiveBytes:fixtureZip(entries),docxBytes:docx,xlsxBytes:xlsx,guideBytes:guide,representationPdfBytes:pdf,entries};
}

/** Explicit opt-in preflight. No conversion can start before approved fixed-clock and runtime gates. */
export async function qualifyArchiveRepresentation({ approvedPacket, deadline, budgetMinutes = 60, mineruRequests = 2, localOnly = false, vaultRoot = process.cwd(), now = Date.now(), dependencies = {} } = {}) {
  const files=['scripts/v3/archive-representation.mjs','scripts/v3/archive-office-to-pdf.ps1','test/v3/archive-representation.test.mjs','scripts/v3/parser-comparison.mjs','scripts/v3/workflow-composer.mjs'];
  const limits=approvedPacket?.limits,authorization=approvedPacket?.authorization;
  const revision=/^P21-PAPER03-ARCHIVE-QUALIFICATION-(r[1-9]\d*)$/.exec(approvedPacket?.run_id ?? '')?.[1];
  const r6=revision==='r6',newBound=!!revision && Number(revision.slice(1))>=7,boundRun=r6||newBound;
  const outputRelative='Eval/apa-v3/phase21/archive-qualification-'+revision;
  // Historical envelopes keep their original scope. New independent envelopes
  // bind this existing two-file synthetic-only ingress, never a CLI permission.
  const scopeFiles=newBound?[files[0],files[2]]:r6?files.slice(0,3):files;
  const manifest={run_id:approvedPacket?.run_id,scope_files:scopeFiles,output_root:outputRelative,vault_root:resolve(vaultRoot),scope_sha256:authorization?.scope_snapshot?.sha256};
  const binding=authorization?.scope_binding;
  const scopeBound=!boundRun || (approvedPacket.output_root===outputRelative && binding?.manifest && typeof binding.manifest==='object' && !Array.isArray(binding.manifest) && binding?.fingerprint===archiveFingerprint(binding.manifest)
    && same({...binding.manifest,vault_root:resolve(binding.manifest?.vault_root ?? '')},manifest)
    && scopeFiles.every(file=>authorization?.scope_snapshot?.text?.includes(file)) && authorization?.scope_snapshot?.text?.includes(outputRelative)
    && !/closed|expired|cancelled|rejected/.test(approvedPacket.status ?? '') && approvedPacket.budget?.closed_at==null
    && approvedPacket.budget?.max_minutes===60 && limits?.max_office_conversion_attempts===2 && limits.retry_allowance===0 && limits.publication===false && limits.global_configuration===false);
  const currentApproval=!newBound || (approvedPacket.execution_authorized===true && typeof authorization?.context==='string' && authorization.context.trim() && authorization?.scope_snapshot?.text?.includes(approvedPacket.run_id));
  if (!approvedPacket || (!boundRun && revision!=='r5') || !scopeBound || !currentApproval || authorization?.method !== 'A_shared_PDF_representation_synthetic_qualification_only' || authorization.real_paper_method_adopted !== false || !authorization.user_message?.trim()
    || !authorization.scope_snapshot?.text || authorization.scope_snapshot.sha256 !== byteHash(authorization.scope_snapshot.text)
    || !same(approvedPacket.scope_files,scopeFiles) || limits?.real_paper_inputs !== false || limits.network !== false || limits.installation !== false || limits.git_mutations !== false || limits.new_APA_content_LLM_requests !== 0 || limits.max_synthetic_mineru_requests !== 2) throw new Error('ARCHIVE_EXPLICIT_APPROVED_PACKET_REQUIRED');
  const start = Date.parse(approvedPacket.budget?.started_at), end = Date.parse(deadline);
  if (!localOnly || !Number.isFinite(start) || !Number.isFinite(end) || end !== Date.parse(approvedPacket.budget.deadline_at) || end - start !== approvedPacket.budget.max_minutes * 60000 || !Number.isFinite(budgetMinutes) || budgetMinutes <= 0 || budgetMinutes > approvedPacket.budget.max_minutes || budgetMinutes > 60 || !Number.isInteger(mineruRequests) || mineruRequests < 0 || mineruRequests > 2 || approvedPacket.budget.status !== 'active') throw new Error('ARCHIVE_FIXED_BUDGET_MISMATCH');
  // A smaller CLI cap can shorten the existing clock, never restart it.
  const effectiveEnd=Math.min(end,start+budgetMinutes*60000);
  if (now < start || now >= effectiveEnd) return { status: 'blocked', reason: 'ARCHIVE_DEADLINE_EXPIRED', mineru_requests: 0, office_conversions: 0 };
  const root=resolve(vaultRoot),base=resolve(root,outputRelative);
  if(newBound){
    // Resolve every existing output ancestor before preflight or writes, so a
    // junction cannot redirect this run into another vault or old run directory.
    const actualRoot=await realpath(root);let outputAncestor=root;
    for(const segment of outputRelative.split('/')){
      outputAncestor=join(outputAncestor,segment);
      try{await lstat(outputAncestor);}catch(error){if(error.code==='ENOENT')break;throw error;}
      let actual;try{actual=await realpath(outputAncestor);}catch{throw new Error('ARCHIVE_OUTPUT_OUTSIDE_VAULT');}
      const location=relative(actualRoot,actual);
      if(location==='..'||location.startsWith('..\\')||location.startsWith('../')||isAbsolute(location))throw new Error('ARCHIVE_OUTPUT_OUTSIDE_VAULT');
      if(actual!==resolve(actualRoot,relative(root,outputAncestor)))throw new Error('ARCHIVE_OUTPUT_OUTSIDE_VAULT');
    }
  }
  const runtime = await (dependencies.checkMineruRuntime ?? checkMineruRuntime)({ vaultRoot: resolve(vaultRoot) });
  if (!runtime?.ok) return { status: 'blocked', reason: 'CURRENT_MINERU_RUNTIME_UNAVAILABLE:' + (runtime?.reason ?? 'unknown'), runtime, mineru_requests: 0, office_conversions: 0, evidence_tier: 'actual_local_preflight' };
  if (process.platform !== 'win32' && !dependencies.convertOffice) return {status:'blocked',reason:'ARCHIVE_OFFICE_PLATFORM_UNAVAILABLE',runtime,mineru_requests:0,office_conversions:0};
  if (Date.now() >= effectiveEnd && !dependencies.now) return {status:'blocked',reason:'ARCHIVE_DEADLINE_EXPIRED',mineru_requests:0,office_conversions:0};
  const clock=dependencies.now ?? Date.now;
  const observations=[];let requests=approvedPacket.actual_synthetic_mineru_requests ?? 0,conversions=0;
  if(!Number.isInteger(requests) || requests<0 || requests>2)throw new Error('ARCHIVE_REQUEST_LEDGER_INVALID');
  let reservedSlots=0;
  for(let slot=1;slot<=2;slot++)try{
    const stored=JSON.parse(await readFile(join(base,'synthetic-mineru-request-'+slot+'.json'),'utf8'));
    if(boundRun && (stored.run_id!==approvedPacket.run_id || stored.started_at!==approvedPacket.budget.started_at || stored.deadline!==approvedPacket.budget.deadline_at || stored.scope_binding!==binding.fingerprint))throw new Error('ARCHIVE_REQUEST_LEDGER_INVALID');
    reservedSlots++;
  }catch(error){if(error.code!=='ENOENT')throw error;}
  requests=Math.max(requests,reservedSlots);
  if(requests>=mineruRequests)return {status:'blocked',reason:'ARCHIVE_REQUEST_QUOTA_EXHAUSTED',mineru_requests:0,office_conversions:0};
  if(boundRun)for(const format of ['docx','xlsx'])try{
    const stored=JSON.parse(await readFile(join(base,'office-attempt-'+format+'.json'),'utf8'));
    if(newBound && (stored.run_id!==approvedPacket.run_id || stored.format!==format || stored.started_at!==approvedPacket.budget.started_at || stored.deadline!==approvedPacket.budget.deadline_at || stored.scope_binding!==binding.fingerprint))throw new Error('ARCHIVE_ATTEMPT_LEDGER_INVALID');
    return {status:'blocked',reason:'ARCHIVE_OFFICE_ATTEMPT_ALREADY_RESERVED',mineru_requests:0,office_conversions:0};
  }catch(error){if(error.code!=='ENOENT')throw error;}
  const startingRequests=requests;
  await mkdir(base,{recursive:true});
  if(newBound){
    // Persist the first accepted clock before any generated input/attempt. This
    // also prevents an interrupted pre-attempt run from receiving a new clock.
    const clockBinding={run_id:approvedPacket.run_id,started_at:approvedPacket.budget.started_at,deadline:approvedPacket.budget.deadline_at,scope_binding:binding.fingerprint};
    const clockPath=join(base,'synthetic-run-clock.json');
    try{await writeFile(clockPath,JSON.stringify(clockBinding),{flag:'wx'});}catch(error){
      if(error.code!=='EEXIST')throw error;
      if(!same(JSON.parse(await readFile(clockPath,'utf8')),clockBinding))throw new Error('ARCHIVE_FIXED_BUDGET_MISMATCH');
    }
  }
  const outputRoot=await mkdtemp(join(base,'synthetic-'));
  const generated=createSyntheticArchiveFixture({fullInventory:true});await writeFile(join(outputRoot,'synthetic.zip'),generated.archiveBytes,{flag:'wx'});
  const convert=dependencies.convertOffice ?? (async ({sourcePath,outputDirectory,format})=>{
    if(!process.env.SystemRoot)throw new Error('ARCHIVE_WINDOWS_SYSTEM_ROOT_REQUIRED');
    const shellRoot=join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0');
    // A Node child inherits PS7 module paths without PowerShell's cross-edition
    // sanitization. This PS5.1 converter needs only its native system modules.
    const childEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>key.toLowerCase()!=='psmodulepath'));
    childEnv.PSModulePath=join(shellRoot,'Modules');
    const result=await promisify(execFile)(join(shellRoot,'powershell.exe'),['-NoProfile','-NonInteractive','-File',join(root,'scripts','v3','archive-office-to-pdf.ps1'),'-SourcePath',sourcePath,'-OutputDirectory',outputDirectory,'-Format',format,'-DeadlineUtc',new Date(effectiveEnd).toISOString(),'-TimeoutSeconds','90'],{env:childEnv,timeout:Math.min(100000,Math.max(1,effectiveEnd-clock())),windowsHide:true,maxBuffer:1024*1024});
    return JSON.parse(result.stdout.replace(/^\uFEFF/,''));
  });
  const port=dependencies.baselinePort ?? createCurrentMineruBaselinePort({vaultRoot:root});
  const configuration={formula:true,pipeline:'pipeline',table:true};
  for(const [format,bytes]of [['docx',generated.docxBytes],['xlsx',generated.xlsxBytes]]) {
    if(clock()>=effectiveEnd || requests>=mineruRequests)break;
    const sourcePath=join(outputRoot,'synthetic.'+format);await writeFile(sourcePath,bytes,{flag:'wx'});
    const sourceSha=byteHash(bytes),outputDirectory=join(outputRoot,format+'-conversion');
    try {
      if(boundRun)await writeFile(join(base,'office-attempt-'+format+'.json'),JSON.stringify({run_id:approvedPacket.run_id,format,started_at:approvedPacket.budget.started_at,deadline:approvedPacket.budget.deadline_at,scope_binding:binding.fingerprint,status:'attempt_reserved'}),{flag:'wx'});
      conversions++;
      const conversion=await convert({sourcePath,outputDirectory,format,deadline:new Date(effectiveEnd).toISOString()});
      const expectedPdf=join(outputDirectory,'representation.pdf');
      if(conversion.status!=='converted' || (boundRun && conversion.settings_restoration!=='restored_verified') || resolve(conversion.output_path)!==expectedPdf || conversion.source_sha256!==sourceSha || conversion.converter?.source_saved!==false || conversion.converter?.source_recalculated!==false)throw new Error('ARCHIVE_CONVERSION_RECORD_MISMATCH');
      const pdf=await readFile(expectedPdf);if(byteHash(pdf)!==conversion.representation_sha256 || byteHash(await readFile(sourcePath))!==sourceSha)throw new Error('ARCHIVE_CONVERSION_BYTES_MISMATCH');
      if(clock()>=effectiveEnd)throw new Error('ARCHIVE_DEADLINE_EXPIRED');
      const packet={run_id:approvedPacket.run_id+'-'+format,user_approval_id:authorization.user_message,intended_evidence_tier:'host_observation',source:{path:expectedPdf,sha256:byteHash(pdf),byte_length:pdf.length},instruction_fingerprint:authorization.scope_snapshot.sha256,configuration_fingerprint:archiveFingerprint(configuration),allowed_output_root:join(outputRoot,format+'-mineru'),backend:{identity:'current-mineru',version:runtime.version,runtime_configuration_version:runtime.configVersion,configuration},endpoint:{value:null,egress:'denied',retention:'local_only'},host_action_scope:{action:'run_current_mineru',permitted_result_fields:['output_inventory','parser_version','runtime']},expected_resource_fields:['execution_time_ms'],requested_model:DEFAULT_APA_MODEL,observed_model:'unknown',estimate:{value:1,unit:'minutes'},approved_budget_cap:{value:approvedPacket.budget.max_minutes,unit:'minutes'},retry_allowance:0};
      // Each request reserves one persistent slot before dispatch. An interrupted
      // run may conservatively consume a slot, but cannot retry beyond two calls.
      let reserved=false;
      for(let slot=1;slot<=mineruRequests;slot++)try {
        await writeFile(join(base,'synthetic-mineru-request-'+slot+'.json'),JSON.stringify({run_id:approvedPacket.run_id,started_at:approvedPacket.budget.started_at,deadline:approvedPacket.budget.deadline_at,...(boundRun?{scope_binding:binding.fingerprint}:{}),packet_fingerprint:archiveFingerprint(packet),status:'dispatch_reserved',evidence_tier:dependencies.baselinePort?'offline_fixture':'actual_local'}),{flag:'wx'});reserved=true;break;
      }catch(error){if(error.code!=='EEXIST')throw error;}
      if(!reserved)throw new Error('ARCHIVE_REQUEST_QUOTA_EXHAUSTED');
      requests++;
      const observed=await port.run(packet,{signal:AbortSignal.timeout(Math.max(1,effectiveEnd-clock()))});
      observations.push({format,conversion,packet,observation:observed,original_format_obligations:format==='xlsx'?'held_requires_original_workbook_baseline':'mapping_fidelity_unverified'});
    } catch(error) {
      const result={status:'blocked',reason:error.message,runtime,output_root:outputRoot,observations,mineru_requests:requests-startingRequests,office_conversions:conversions,evidence_tier:dependencies.baselinePort||dependencies.convertOffice?'offline_fixture':'actual_local'};
      await writeFile(join(outputRoot,'qualification.json'),JSON.stringify(result,null,2),{flag:'wx'});return result;
    }
  }
  const result={status:observations.length===2?'observed':'blocked',reason:observations.length===2?'SYNTHETIC_PDF_INPUTS_OBSERVED_ORIGINAL_OBLIGATIONS_HELD':'ARCHIVE_DEADLINE_OR_QUOTA_STOP',runtime,output_root:outputRoot,observations,mineru_requests:requests-startingRequests,office_conversions:conversions,evidence_tier:dependencies.baselinePort||dependencies.convertOffice?'offline_fixture':'actual_local',scientific_comparison:'not_performed'};
  await writeFile(join(outputRoot,'qualification.json'),JSON.stringify(result,null,2),{flag:'wx'});return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, ...flags] = process.argv.slice(2);
    if (command !== 'qualify-synthetic') throw new Error('ARCHIVE_QUALIFY_SYNTHETIC_ONLY');
    const value = name => flags[flags.indexOf(name)+1];
    if (!flags.includes('--approved-packet') || !flags.includes('--deadline')) throw new Error('ARCHIVE_EXPLICIT_APPROVED_PACKET_REQUIRED');
    const approvedPacket = JSON.parse(await readFile(value('--approved-packet'),'utf8'));
    console.log(JSON.stringify(await qualifyArchiveRepresentation({ approvedPacket, deadline:value('--deadline'), localOnly:flags.includes('--local-only'), budgetMinutes:Number(value('--budget-minutes')), mineruRequests:Number(value('--mineru-requests')) })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
