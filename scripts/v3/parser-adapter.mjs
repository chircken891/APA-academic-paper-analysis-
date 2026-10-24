import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { verifySavedMineruAssetEvidence } from './mineru-asset-evidence.mjs';

import { createPhase21ContractValidator, validatePhase21Record } from './phase21-contract-loader.mjs';

const parserRunSchemaUrl = new URL('../../Schema/phase21/parser-run.schema.json', import.meta.url);
const workbookSchemaUrl = new URL('../../Schema/phase21/native-workbook.schema.json', import.meta.url);
const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const canonical = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
};
const flattenedText = value => {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (Array.isArray(value)) return value.map(flattenedText).filter(Boolean).join(' ');
  if (!value || typeof value !== 'object') return '';
  return typeof value.content === 'string' ? value.content.trim() : flattenedText(value.children);
};
const joinedText = (entry, keys) => keys.map(key => flattenedText(entry?.[key])).filter(Boolean).join('\n');
const isReferenceList = entry => entry?.type === 'list' && entry.sub_type === 'ref_text' && Array.isArray(entry.list_items) && entry.list_items.every(item => typeof item === 'string');
const textOf = entry => {
  if (isReferenceList(entry)) return entry.list_items.join('\n');
  if (entry?.type === 'table') return joinedText(entry, ['table_caption', 'caption', 'table_body', 'table_footnote', 'content']);
  if (entry?.type === 'image' || entry?.type === 'chart') return joinedText(entry, ['image_caption', 'chart_caption', 'caption', 'image_footnote', 'chart_footnote', 'content']);
  return joinedText(entry, ['text', 'content', 'latex', 'equation', 'math_content']);
};
const typeOf = entry => isReferenceList(entry) ? 'reference' : ({ title: 'heading', table: 'table', image: 'figure', chart: 'figure', equation: 'equation', equation_interline: 'equation', index: 'reference' })[entry?.type] ?? 'paragraph';

function requireTextBytes(source) {
  if (source.available === false) return null;
  if (!(typeof source.bytes === 'string' || Buffer.isBuffer(source.bytes) || source.bytes instanceof Uint8Array)) {
    throw new Error(`Source ${source.document_id} requires independently supplied bytes.`);
  }
  return hash(source.bytes);
}

function sourceRecord(source) {
  if (!source || typeof source.document_id !== 'string' || !source.document_id) throw new Error('Each source requires document_id.');
  if (!['main', 'attachment'].includes(source.role)) throw new Error(`Source ${source.document_id} requires an explicit main or attachment role.`);
  return {
    document_id: source.document_id,
    role: source.role,
    critical: Boolean(source.critical),
    availability: source.available === false ? 'missing' : 'available',
    source_sha256: requireTextBytes(source),
  };
}

function rawEntries(content) {
  if (!Array.isArray(content)) throw new Error('Raw MinerU content must be an array.');
  if (content.every(Array.isArray)) {
    let sourceItemIndex = 0;
    return content.flatMap((page, pageIndex) => page.map(entry => ({ ...entry, page_idx: pageIndex, source_item_index: sourceItemIndex++ })));
  }
  return content.map((entry, index) => ({ ...entry, source_item_index: index }));
}

function locator(documentId, entry) {
  const known = Number.isInteger(entry.page_idx) && entry.page_idx >= 0;
  return {
    document_id: documentId,
    page_number: known ? entry.page_idx + 1 : null,
    page_status: known ? 'known' : 'unknown',
    source_block_id: String(entry.block_id ?? `raw-${entry.source_item_index}`),
  };
}

function qualifiedTableLink(documentId, lookup, blockId, referenceKind, tableLocator, errors) {
  if (!blockId) return undefined;
  const target = lookup.get(String(blockId));
  if (target) return locator(documentId, target);
  errors.push({
    code: 'UNRESOLVED_TABLE_LINK',
    document_id: documentId,
    source_block_id: tableLocator.source_block_id,
    reference_kind: referenceKind,
    referenced_block_id: String(blockId),
  });
  return undefined;
}

export function deriveParserRunIdentity({ sources, backend, backend_version, normalization_version, config_fingerprint, approval_fingerprint }) {
  return hash(canonical({
    sources: [...sources].map(source => ({ document_id: source.document_id, source_sha256: source.source_sha256 })).sort((left, right) => left.document_id.localeCompare(right.document_id)),
    backend, backend_version, normalization_version, config_fingerprint, approval_fingerprint,
  }));
}

/** Creates the record only; no parser, model, V2 CLI, or file write is dispatched. */
export function createParserRunRecord(input) {
  const record = structuredClone(input);
  for (const block of record.blocks ?? []) {
    if (block.formula?.disposition === 'claimed' && block.formula.confidence !== 'high') throw new Error('Ambiguous formula symbols must remain unresolved or rejected.');
    if (block.formula?.disposition === 'claimed' && block.formula.symbol === null) throw new Error('Claimed formulas require an observed symbol.');
  }
  return record;
}

const workbookContract = 'phase21-native-workbook-1.0';
const codepoint = (a,b) => a < b ? -1 : a > b ? 1 : 0;
const sortedSources = sources => [...sources].sort((a,b)=>codepoint(a.document_id,b.document_id));
const rectangleId = (sheet, range) => `sheet:${sheet.index}:R${range.start_row}C${range.start_column}:R${range.end_row}C${range.end_column}`;

/** Binds supplied observations; never opens a workbook, archive or reader. */
export function deriveWorkbookParserRunIdentity(input) {
  const {sources,backend,backend_version,normalization_version,config_fingerprint,approval_fingerprint,required_coverage_fingerprint,observation_fingerprint}=input;
  return hash(canonical({contract_version:workbookContract,sources:sortedSources(sources),backend,backend_version,normalization_version,config_fingerprint,approval_fingerprint,required_coverage_fingerprint,observation_fingerprint}));
}

export function validateWorkbookPayload(payload, {sources,requiredCoverage} = {}) {
  const errors=[];
  if(!payload || !sources?.some(s=>s.document_id===payload.document_id && s.kind==='workbook') || !Array.isArray(payload.sheets)) errors.push('WORKBOOK_SOURCE_BINDING_MISMATCH');
  if(!Array.isArray(requiredCoverage) || !requiredCoverage.length) errors.push('WORKBOOK_COVERAGE_SET_MISMATCH');
  if(errors.length)return {ok:false,errors};
  const source=sources.find(s=>s.document_id===payload.document_id),required=requiredCoverage.find(c=>c.document_id===payload.document_id);
  const unique=(rows,key)=>new Set(rows.map(key)).size===rows.length;
  const valid=r=>r&&['start_row','start_column','end_row','end_column'].every(k=>Number.isInteger(r[k])&&r[k]>0)&&r.start_row<=r.end_row&&r.start_column<=r.end_column&&r.end_row<=(source.format==='xls'?65536:1048576)&&r.end_column<=(source.format==='xls'?256:16384);
  if(!required||required.kind!=='workbook'||!Array.isArray(required.sheets))return {ok:false,errors:['WORKBOOK_COVERAGE_SET_MISMATCH']};
  if(!unique(payload.sheets,s=>s.index)||!unique(payload.sheets,s=>s.name)||!unique(required.sheets,s=>s.index)||!unique(required.sheets,s=>s.name))errors.push('WORKBOOK_DUPLICATE_KEY');
  const keys=rows=>rows.map(s=>[s.index,s.name]).sort((a,b)=>a[0]-b[0]);
  if(canonical(keys(payload.sheets))!==canonical(keys(required.sheets)))errors.push('WORKBOOK_COVERAGE_SET_MISMATCH');
  const allScopes=[];
  for(const s of payload.sheets){
    const req=required.sheets.find(r=>r.index===s.index&&r.name===s.name);
    if(!req||!Array.isArray(s.ranges)) {errors.push('WORKBOOK_COVERAGE_SET_MISMATCH');continue;}
    if(!unique(s.ranges,r=>r.scope_id))errors.push('WORKBOOK_DUPLICATE_KEY');
    if(canonical(s.ranges.map(r=>r.scope_id).sort())!==canonical(req.ranges.map(r=>r.scope_id).sort()))errors.push('WORKBOOK_COVERAGE_SET_MISMATCH');
    for(const o of s.ranges){
      allScopes.push(o.scope_id);const scope=req.ranges.find(r=>r.scope_id===o.scope_id);
      if(!valid(o.range)||!scope||canonical(o.range)!==canonical(scope.range))errors.push('WORKBOOK_RANGE_INVALID');
      if(o.status!=='read')continue;
      if(!Array.isArray(o.cells)||o.cells.length!==(o.range.end_row-o.range.start_row+1)*(o.range.end_column-o.range.start_column+1)){errors.push('WORKBOOK_OBSERVATION_REQUIRED');continue;}
      if(!unique(o.cells,c=>c.row+':'+c.column))errors.push('WORKBOOK_DUPLICATE_OBSERVATION');
      if(o.cells.some(c=>c.row<o.range.start_row||c.row>o.range.end_row||c.column<o.range.start_column||c.column>o.range.end_column))errors.push('WORKBOOK_RANGE_INVALID');
      if(!o.context_bindings||canonical(o.context_bindings)!==canonical(scope.context_bindings))errors.push('WORKBOOK_CONTEXT_BINDING_INVALID');
    }
  }
  if(!unique(allScopes,x=>x))errors.push('WORKBOOK_DUPLICATE_KEY');
  return {ok:!errors.length,errors};
}

export async function translateWorkbookPayload({sources,pdfRun,workbookPayloads,parserConfig,approval,requiredCoverage} = {}) {
  if(!Array.isArray(sources)||!Array.isArray(workbookPayloads)||!parserConfig||!approval||!Array.isArray(requiredCoverage)) throw new Error('WORKBOOK_INPUT_REQUIRED');
  const records=sources.map(source=>{
    const common=sourceRecord(source);
    if(source.kind!=='workbook') return {...common,kind:'pdf'};
    const container=source.container;
    if(!container || !['archive','direct'].includes(container.kind)) throw new Error('WORKBOOK_SOURCE_BINDING_MISMATCH');
    const containerHash=container.kind==='direct'?common.source_sha256:requireTextBytes({...container,available:source.available});
    if(container.kind==='direct' && (container.document_id!==source.document_id || source.member_path!==null)) throw new Error('WORKBOOK_SOURCE_BINDING_MISMATCH');
    if(container.kind==='archive' && (typeof source.member_path!=='string'||!source.member_path||source.member_path.startsWith('/')||source.member_path.includes('\\')||source.member_path.split('/').some(p=>!p||p==='.'||p==='..'))) throw new Error('WORKBOOK_SOURCE_BINDING_MISMATCH');
    return {...common,kind:'workbook',format:source.format,container:{kind:container.kind,document_id:container.document_id,sha256:containerHash},member_path:source.member_path};
  });
  if(new Set(records.map(s=>s.document_id)).size!==records.length || new Set(workbookPayloads.map(p=>p.document_id)).size!==workbookPayloads.length) throw new Error('WORKBOOK_DUPLICATE_KEY');
  const pdfSources=records.filter(s=>s.kind==='pdf');
  if(pdfSources.length){
    const oldShape=await createPhase21ContractValidator({schemas:[JSON.parse(await readFile(parserRunSchemaUrl,'utf8'))]});
    if(!pdfRun||!oldShape.validate('phase21/parser-run',pdfRun).ok || canonical(sortedSources(pdfRun.sources))!==canonical(sortedSources(pdfSources.map(({kind,...s})=>s)))) throw new Error('WORKBOOK_SOURCE_BINDING_MISMATCH');
  } else if(pdfRun) throw new Error('WORKBOOK_SOURCE_BINDING_MISMATCH');
  const blocks=pdfRun?structuredClone(pdfRun.blocks).map(b=>({...b,locator:{...b.locator,kind:'pdf'},...(b.table_links?{table_links:Object.fromEntries(Object.entries(b.table_links).map(([k,v])=>[k,{...v,kind:'pdf'}]))}:{})})):[];
  const source_coverage=pdfRun?structuredClone(pdfRun.page_coverage).map(c=>({...c,kind:'pdf'})):[];
  const capabilities=[],mappings=pdfRun?structuredClone(pdfRun.normalization_audit.mappings):[];
  for(const source of records.filter(s=>s.kind==='workbook')){
    const payload=workbookPayloads.find(p=>p.document_id===source.document_id);
    const validation=validateWorkbookPayload(payload,{sources:records,requiredCoverage});
    if(!validation.ok) throw new Error(validation.errors.join(';'));
    capabilities.push({document_id:source.document_id,format:source.format,...structuredClone(payload.capability)});
    source_coverage.push({document_id:source.document_id,kind:'workbook',status:payload.status,sheets:payload.sheets.map(s=>({index:s.index,name:s.name,visibility:s.visibility,status:s.status,empty_check:structuredClone(s.empty_check),ranges:s.ranges.map(o=>({scope_id:o.scope_id,range:structuredClone(o.range),status:o.status,cells_observed:o.status==='read'?o.cells.length:null,blank_count:o.status==='read'?o.cells.filter(c=>c.state==='blank').length:null,error_count:o.status==='read'?o.cells.filter(c=>c.state==='error').length:null}))}))});
    for(const s of payload.sheets) for(const [index,o] of s.ranges.entries()){
      if(o.status!=='read') continue;
      const source_block_id=rectangleId(s,o.range);
      const block={id:source.document_id+':'+source_block_id,type:'table',text:o.text??'',locator:{kind:'workbook',document_id:source.document_id,source_block_id,member_path:source.member_path,sheet:{index:s.index,name:s.name},range:structuredClone(o.range)},rotation_degrees:0,cells:structuredClone(o.cells).sort((a,b)=>a.row-b.row||a.column-b.column),context_bindings:structuredClone(o.context_bindings),merged_ranges:structuredClone(o.merged_ranges)};
      const prior=blocks.find(b=>b.id===block.id);
      if(prior&&canonical(prior)!==canonical(block))throw new Error('WORKBOOK_DUPLICATE_OBSERVATION');
      if(!prior)blocks.push(block);
      mappings.push({document_id:source.document_id,source_item_index:index,disposition:'retained',original_item_id:String(o.id??index)});
    }
  }
  const config_fingerprint=hash(canonical(parserConfig.configuration??{})),approval_fingerprint=hash(canonical(approval));
  const required_coverage_fingerprint=hash(canonical(requiredCoverage));
  const observation_fingerprint=hash(canonical({blocks,source_coverage,capabilities}));
  const identity={sources:records,backend:parserConfig.backend,backend_version:parserConfig.backend_version,normalization_version:parserConfig.normalization_version,config_fingerprint,approval_fingerprint,required_coverage_fingerprint,observation_fingerprint};
  const record={schema_version:'phase21-parser-run-workbook-1.0',parser_run_id:deriveWorkbookParserRunIdentity(identity),...identity,approval_scope:approval.scope,blocks,source_coverage,required_coverage:structuredClone(requiredCoverage),assets:pdfRun?structuredClone(pdfRun.assets).map(a=>({...a,...(a.locator?{locator:{...a.locator,kind:'pdf'}}:{})})):[],normalization_audit:{mappings,raw_page_policy:'preserve_unknown_before_v2_normalization'},resource_observations:pdfRun?structuredClone(pdfRun.resource_observations):[{kind:'workbook_reader',status:'not_invoked',detail:'supplied offline observations only'}],errors:pdfRun?structuredClone(pdfRun.errors):[],candidate_eligibility:{eligible:true,blockers:[]},metadata:{requirement_refs:['APA3-03','APA3-04']},capabilities};
  const validator=await createPhase21ContractValidator({schemas:[JSON.parse(await readFile(workbookSchemaUrl,'utf8'))]});
  const shape=validator.validate('phase21/native-workbook#/$defs/run',record);
  if(!shape.ok) throw new Error('WORKBOOK_SCHEMA_INVALID:'+shape.errors.join(';'));
  return record;
}

export async function translateMineruPayload({ sources, rawPayloads, parserConfig, approval, normalizedV2Reference, savedAssetEvidence } = {}) {
  if (!Array.isArray(sources) || !Array.isArray(rawPayloads) || !parserConfig || !approval) throw new Error('sources, rawPayloads, parserConfig, and approval are required.');
  // The reference is intentionally neither read nor mutated: V2 normalization can infer page 1.
  void normalizedV2Reference;
  const sourceRecords = sources.map(sourceRecord);
  if (new Set(sourceRecords.map(source => source.document_id)).size !== sourceRecords.length) {
    throw new Error('Duplicate source document_id is not allowed.');
  }
  if (new Set(rawPayloads.map(payload => payload?.document_id)).size !== rawPayloads.length) {
    throw new Error('Duplicate raw payload document_id is not allowed.');
  }
  const sourceById = new Map(sourceRecords.map(source => [source.document_id, source]));
  const savedAssets = savedAssetEvidence === undefined ? null : verifySavedMineruAssetEvidence({
    evidence: savedAssetEvidence, sources, rawPayloads,
    entriesByDocument: new Map(rawPayloads.map(payload => [payload.document_id, rawEntries(payload.content)])),
  });
  const blocks = [], assets = [], errors = [], mappings = [], pageCoverage = [];
  const receivedPayloads = new Set();
  const criticalMissing = sourceRecords.filter(source => source.critical && source.availability === 'missing');
  for (const source of criticalMissing) errors.push({ code: 'MISSING_CRITICAL_INPUT', document_id: source.document_id });
  for (const payload of rawPayloads) {
    const source = sourceById.get(payload.document_id);
    if (!source) throw new Error(`Raw payload refers to undeclared source ${payload.document_id}.`);
    if (source.availability === 'missing') throw new Error(`Raw payload is not allowed for missing source ${payload.document_id}.`);
    receivedPayloads.add(payload.document_id);
    const entries = rawEntries(payload.content);
    if (source.critical && entries.length === 0) errors.push({ code: 'MISSING_CRITICAL_PARSE', document_id: payload.document_id });
    const sourceBlockIds = entries.map(entry => String(entry.block_id ?? `raw-${entry.source_item_index}`));
    if (new Set(sourceBlockIds).size !== sourceBlockIds.length) throw new Error(`Duplicate source block_id is not allowed for ${payload.document_id}.`);
    const lookup = new Map(entries.map(entry => [String(entry.block_id ?? `raw-${entry.source_item_index}`), entry]));
    const pages = new Set();
    let unknownItemCount = 0;
    for (const entry of entries) {
      const blockLocator = locator(payload.document_id, entry);
      if (blockLocator.page_status === 'known') pages.add(blockLocator.page_number);
      else {
        unknownItemCount += 1;
        errors.push({ code: 'UNKNOWN_RAW_PAGE', document_id: payload.document_id, source_block_id: blockLocator.source_block_id });
      }
      const block = {
        id: `${payload.document_id}:${blockLocator.source_block_id}:${entry.source_item_index}`,
        type: typeOf(entry),
        text: textOf(entry),
        locator: blockLocator,
        rotation_degrees: Number.isFinite(entry.rotation_degrees) ? entry.rotation_degrees : 0,
      };
      if (block.type === 'table') {
        const headerLocator = qualifiedTableLink(payload.document_id, lookup, entry.table_header_block_id, 'header', blockLocator, errors);
        const footnoteLocator = qualifiedTableLink(payload.document_id, lookup, entry.table_footnote_block_id, 'footnote', blockLocator, errors);
        if (headerLocator || footnoteLocator) block.table_links = { ...(headerLocator ? { header_locator: headerLocator } : {}), ...(footnoteLocator ? { footnote_locator: footnoteLocator } : {}) };
        // Captions/footnotes and caller asset claims are not a body or crop proof.
        if (!joinedText(entry, ['table_body', 'content'])) {
          const savedAssetId = savedAssets?.resolved.get(payload.document_id + ':' + entry.source_item_index);
          if (savedAssetId) assets.push({ asset_id: savedAssetId, status: 'resolved', locator: blockLocator });
          else {
            assets.push({ asset_id: `${payload.document_id}:${blockLocator.source_block_id}`, status: 'unresolved', locator: blockLocator, unresolved_reason: 'missing_table_body_and_unverified_image' });
            errors.push({ code: 'UNRESOLVED_ASSET', document_id: payload.document_id, source_block_id: blockLocator.source_block_id });
          }
        }
      }
      if (block.type === 'equation') {
        const ambiguous = Boolean(entry.ambiguous_formula) || !textOf(entry);
        if (ambiguous && entry.formula_symbol) throw new Error('Ambiguous formula symbols cannot be claimed from raw input.');
        // Raw parser text is retained in block.text, but is not source verification.
        block.formula = { confidence: 'unknown', disposition: 'unresolved', symbol: null };
        errors.push({ code: 'UNRESOLVED_FORMULA', document_id: payload.document_id, source_block_id: blockLocator.source_block_id });
      }
      blocks.push(block);
      mappings.push({ document_id: payload.document_id, source_item_index: entry.source_item_index, disposition: blockLocator.page_status === 'unknown' ? 'unknown_page' : block.formula?.disposition === 'unresolved' ? 'unresolved_formula' : 'retained' });
      if (['image', 'chart'].includes(entry.type)) {
        const savedAssetId = savedAssets?.resolved.get(payload.document_id + ':' + entry.source_item_index);
        if (savedAssetId || entry.asset_id) assets.push({ asset_id: savedAssetId ?? String(entry.asset_id), status: 'resolved', locator: blockLocator });
        else {
          assets.push({ asset_id: `${payload.document_id}:${blockLocator.source_block_id}`, status: 'unresolved', unresolved_reason: 'missing_parser_asset_id' });
          errors.push({ code: 'UNRESOLVED_ASSET', document_id: payload.document_id, source_block_id: blockLocator.source_block_id });
        }
      }
    }
    pageCoverage.push({ document_id: payload.document_id, known_pages: [...pages].sort((left, right) => left - right), unknown_item_count: unknownItemCount });
  }
  for (const source of sourceRecords.filter(source => source.critical && source.availability === 'available' && !receivedPayloads.has(source.document_id))) {
    errors.push({ code: 'MISSING_CRITICAL_PARSE', document_id: source.document_id });
  }
  for (const source of sourceRecords.filter(source => !pageCoverage.some(coverage => coverage.document_id === source.document_id))) {
    pageCoverage.push({ document_id: source.document_id, known_pages: [], unknown_item_count: 0 });
  }
  const config_fingerprint = hash(canonical(savedAssets
    ? { configuration: parserConfig.configuration ?? {}, saved_asset_evidence_fingerprint: savedAssets.fingerprint }
    : parserConfig.configuration ?? {}));
  const approval_fingerprint = hash(canonical(approval));
  // Bind this adapter's trust semantics as well as the caller's normalization revision.
  const normalization_version = typeof parserConfig.normalization_version === 'string' && parserConfig.normalization_version.length
    ? `${parserConfig.normalization_version}+raw-formula-unverified-1+missing-table-evidence-1${savedAssets ? '+saved-mineru-asset-evidence-1' : ''}`
    : parserConfig.normalization_version;
  const blockers = [...new Set(errors.filter(error => ['MISSING_CRITICAL_INPUT', 'MISSING_CRITICAL_PARSE', 'UNKNOWN_RAW_PAGE', 'UNRESOLVED_ASSET', 'UNRESOLVED_TABLE_LINK'].includes(error.code)).map(error => error.code))].sort();
  const record = createParserRunRecord({
    schema_version: 'phase21-parser-run-1.0',
    parser_run_id: deriveParserRunIdentity({ sources: sourceRecords, backend: parserConfig.backend, backend_version: parserConfig.backend_version, normalization_version, config_fingerprint, approval_fingerprint }),
    sources: sourceRecords,
    backend: parserConfig.backend,
    backend_version: parserConfig.backend_version,
    normalization_version,
    config_fingerprint,
    approval_fingerprint,
    approval_scope: approval.scope,
    blocks,
    page_coverage: pageCoverage,
    assets,
    normalization_audit: { mappings, raw_page_policy: 'preserve_unknown_before_v2_normalization' },
    resource_observations: [{ kind: 'mineru_backend', status: 'not_invoked', detail: 'synthetic payload translation only' }],
    errors,
    candidate_eligibility: { eligible: blockers.length === 0, blockers },
    metadata: { requirement_refs: ['C02', 'C09', 'C14', 'C15', 'V3AT-04', 'V3AT-05', 'V3AT-11', 'D-21-05'] },
  });
  const schema = JSON.parse(await readFile(parserRunSchemaUrl, 'utf8'));
  const validator = await createPhase21ContractValidator({ schemas: [schema] });
  const result = validatePhase21Record(validator, 'phase21/parser-run', record);
  if (!result.ok) throw new Error(`Phase-21 parser record validation failed: ${result.errors.join('; ')}`);
  return record;
}
