import { createV3ContractValidator } from './contract-validator.mjs';
import { createHash } from 'node:crypto';

// RFC 8785: ECMAScript number/string serialization, UTF-16 key ordering,
// no Unicode normalization, and rejection of non-I-JSON values.
export function canonicalizeV3Json(value, active = new Set()) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') {
    if (!value.isWellFormed()) throw new TypeError('INVALID_JSON_VALUE');
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('INVALID_JSON_VALUE');
    return JSON.stringify(value);
  }
  if (!value || typeof value !== 'object' || active.has(value)) throw new TypeError('INVALID_JSON_VALUE');
  const array = Array.isArray(value);
  if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('INVALID_JSON_VALUE');
  if (Object.getOwnPropertySymbols(value).length) throw new TypeError('INVALID_JSON_VALUE');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some(d => !Object.hasOwn(d, 'value'))) throw new TypeError('INVALID_JSON_VALUE');
  active.add(value);
  try {
    if (array) {
      if (Object.keys(value).length !== value.length) throw new TypeError('INVALID_JSON_VALUE');
      const values = [];
      for (let i = 0; i < value.length; i++) {
        if (!Object.hasOwn(descriptors, i)) throw new TypeError('INVALID_JSON_VALUE');
        values.push(canonicalizeV3Json(descriptors[i].value, active));
      }
      return '[' + values.join(',') + ']';
    }
    return '{' + Object.keys(value).sort().map(key => canonicalizeV3Json(key, active) + ':' + canonicalizeV3Json(descriptors[key].value, active)).join(',') + '}';
  } finally { active.delete(value); }
}
const hash = value => 'sha256:' + createHash('sha256').update(canonicalizeV3Json(value)).digest('hex');

/** Identical canonical bytes, bounded buffering for large whole-paper envelopes. */
export function fingerprintV3Json(value) {
  const digest=createHash('sha256'),active=new Set();let pending='',size=0;
  const emit=chunk=>{pending+=chunk;size+=chunk.length;if(size>=65536){digest.update(pending);pending='';size=0;}};
  const visit=value=>{
    if(value===null||typeof value!=='object'){emit(canonicalizeV3Json(value));return;}
    if(active.has(value)||!Array.isArray(value)&&![Object.prototype,null].includes(Object.getPrototypeOf(value))||Object.getOwnPropertySymbols(value).length)throw new TypeError('INVALID_JSON_VALUE');
    const descriptors=Object.getOwnPropertyDescriptors(value),array=Array.isArray(value),keys=Object.keys(value);
    if(Object.values(descriptors).some(d=>!Object.hasOwn(d,'value'))||array&&keys.length!==value.length)throw new TypeError('INVALID_JSON_VALUE');
    active.add(value);
    try{
      emit(array?'[':'{');if(!array)keys.sort();
      for(let i=0;i<keys.length;i++){
        const key=array?String(i):keys[i];if(!Object.hasOwn(descriptors,key))throw new TypeError('INVALID_JSON_VALUE');
        if(i)emit(',');if(!array){emit(canonicalizeV3Json(key));emit(':');}visit(descriptors[key].value);
      }
      emit(array?']':'}');
    }finally{active.delete(value);}
  };
  visit(value);if(pending)digest.update(pending);return 'sha256:'+digest.digest('hex');
}

// Schema I/O is restricted to the project-owned registry at module initialization.
// The exported gate accepts package data only and performs no external action.
const structural = await createV3ContractValidator();
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const result = errors => ({ok: errors.length === 0, errors: errors.sort((a,b) => compare(a.code,b.code) || compare(a.path,b.path)), warnings: []});
const tuple = v => JSON.stringify([v.source_document_id, v.source_hash, v.page_index, v.block_id]);
export function nativeScientificLocationKey(v) {
  return v.kind === 'workbook'
    ? canonicalizeV3Json([v.kind, v.source_document_id, v.source_hash, v.block_id, v.member_path, v.sheet, v.range])
    : canonicalizeV3Json(['pdf', v.source_document_id, v.source_hash, v.page_index, v.block_id]);
}
export function wholePaperScientificLocationKey(v) {
  if(v.kind==='docx')return canonicalizeV3Json(['docx',v.source_document_id,v.source_hash,v.block_id,v.member_path,v.part,v.part_sha256,v.xml_path]);
  return nativeScientificLocationKey(v);
}
const MEMBERS = ['analysis.core.json','analysis.en.json','analysis.zh-CN.json','scientific-reading-card.json'];
const EDGES = {
  'analysis.core.json': ['source_package','schema','profile','run_context'],
  'scientific-reading-card.json': ['analysis.core.json','schema','profile'],
  'analysis.en.json': ['analysis.core.json','scientific-reading-card.json','schema','profile','template','config'],
  'analysis.zh-CN.json': ['analysis.core.json','scientific-reading-card.json','schema','profile','template','config']
};

const PROTECTED = new Set(['personal_notes','evidence_selection_map','evidence_selection_maps','private_annotation','user_authored']);
const DENIED = new Set(['provider_call','model_call','parser_default_change','zotero_access','wiki_write','production_apply','dependency_install','global_config_change','git_operation']);
const SAFE_KEYS = new Set(['source_package','core','units','evidence','views','reading_card','items','manifest','dependency_inputs','schema','profile','template','config','diagnostic_inputs','scope_requests','storage','canonical_statement','text','extracted_text','provenance']);
const normalizedKey = key => key.toLowerCase().replace(/[ -]+/g, '_');
export function hasV3CredentialValue(value) {
  return typeof value==='string'&&/\bsk-(?:proj-)?[a-z0-9_-]{16,}|\bBearer\s+[a-z0-9._-]{16,}|\b(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(value);
}
function unsafe(value) {
  return /(?:^|[\s"'(=])[a-z]:[\\/]|\\\\[^\\\s]+[\\/]|(?:^|[\s"'(=])~[\\/]|(?:^|[\\/\s"'(=])\.\.(?:[\\/]|$)|(?:^|[\s"'(=])\/[a-z0-9_]|file:\/\//i.test(value)
    || hasV3CredentialValue(value);
}

/** Scalar prose only. It never changes stored content or grants an XML/path exemption. */
export function checkSourceEvidenceTextSafety(value,path,add,field='') {
  if(typeof value!=='string'){checkV3StorageSafety(value,path,add,'phase21-whole-paper-1.0',field);return;}
  if(hasV3CredentialValue(value)){add('UNSAFE_STORAGE',path);return;}
  const scan=['text','extracted_text','canonical_statement'].includes(field)
    ?value.replace(/(?<![\w./\\:-])[0-9]+[ \t]*\/[ \t]*[0-9]+(?![\w./\\:-])/g,'0')
      // A complete solvent composition is prose, not an absolute path. Only the
      // separator is masked in this scan copy; stored text and all other checks stay intact.
      .replace(/(?<![\w./\\:%-])[0-9]+(?:\.[0-9]+)?%[ \t]+acetonitrile[ \t]*\/[ \t]*[0-9]+(?:\.[0-9]+)?%[ \t]+formic[ \t]+acid[ \t]+\(Solvent [AB]\)(?![\w/\\:%-]|\.[\w/\\])/gi,composition=>composition.replace('/',' '))
      // Protein-complex lists require the caption's views-of/hubs syntax. Bare
      // slash tokens and suffixed paths do not satisfy this complete grammar.
      .replace(/\bviews?[ \t]+of[ \t]+(?:the[ \t]+)?[A-Z][A-Z0-9-]{1,15}[ \t]*\/[ \t]*[A-Z][A-Z0-9-]{1,15}(?:[ \t]*(?:,[ \t]*(?:and[ \t]+)?|and[ \t]+)[A-Z][A-Z0-9-]{1,15}[ \t]*\/[ \t]*[A-Z][A-Z0-9-]{1,15})*[ \t]+hubs?\b/g,complex=>complex.replaceAll('/',' '))
      // A modified adapter needs biological sequence context, the 5-prime mark,
      // both terminal modifications, and a complete nucleotide sequence.
      .replace(/\b(?:DNA|RNA|oligonucleotide)[ \t]+with[ \t]+the[ \t]+sequence[ \t]+5['’′][ \t]*\/5rApp\/[ \t]*[ACGTU]{6,}[ \t]*\/3ddC\/(?![\w/\\:-]|\.[\w/\\])/g,sequence=>sequence.replaceAll('/',' ')):value;
  checkV3StorageSafety(scan,path,add,'phase21-whole-paper-1.0',field);
}
export function checkV3StorageSafety(value, path, add, locationContract, field = '') {
  if (typeof value === 'string') {
    if (PROTECTED.has(normalizedKey(value))) add('PROTECTED_ASSET', path);
    if (DENIED.has(value)) add('PHASE_SCOPE_DENIED', path);
    const typedMarkupPath=locationContract==='phase21-whole-paper-1.0'&&['xml_path','html_path','ancestry','locator_root'].includes(field)
      &&/^\/[A-Za-z_][A-Za-z0-9_-]*\[[1-9][0-9]*\](?:\/[A-Za-z_][A-Za-z0-9_-]*\[[1-9][0-9]*\])*$/.test(value);
    const typedOutputPointer=locationContract==='phase21-whole-paper-1.0'&&field==='json_pointer'&&/^\/(?:0|[1-9][0-9]*)\/(?:text|table_body)$/.test(value);
    if (!typedMarkupPath && !typedOutputPointer && unsafe(value)) add('UNSAFE_STORAGE', path);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      // Paths are built from fixed contract words and numeric indices only.
      const segment = Array.isArray(value) ? key : SAFE_KEYS.has(key) ? key : '[field]';
      const next = path === '/' ? '/' + segment : path + '/' + segment;
      if (PROTECTED.has(normalizedKey(key))) add('PROTECTED_ASSET', next);
      if (DENIED.has(key)) add('PHASE_SCOPE_DENIED', next);
      if (unsafe(key)) add('UNSAFE_STORAGE', next);
      checkV3StorageSafety(child, next, add, locationContract, Array.isArray(value)?field:key);
    }
  }
}

/** Checks contract consistency, never authenticity of a review or permission to publish. */
export function validateV3Package(p) {
  const errors = [];
  const add = (code, path) => errors.push({code, path, message: code});
  try { canonicalizeV3Json(p); } catch {
    add('STRUCTURE_INVALID', '/'); return result(errors);
  }
  // Rejection-only preflight also classifies unsafe diagnostic/unknown fields.
  // No topology or hash acceptance is attempted until strict schema success.
  checkV3StorageSafety(p, '/', add);
  if (errors.length) return result(errors);
  const shape = structural.validate('v3/analysis-package', p);
  if (!shape.ok) {
    // Never forward raw Ajv paths/messages: untrusted property names may contain secrets.
    for (const key of ['source_package','core','reading_card','views','manifest']) {
      if (!p || !Object.hasOwn(p, key)) add('PACKAGE_MEMBER_MISSING', '/' + key);
    }
    if (!errors.length) add('STRUCTURE_INVALID', '/');
    return result(errors);
  }
  validateSourceCoreReferences(p, add);
  const units = new Map(p.core.units.map(u => [u.unit_id,u]));
  const identities = [['/core',p.core],['/reading_card',p.reading_card],['/manifest',p.manifest],...p.views.map((v,i) => ['/views/' + i,v])];
  for (const [path, record] of identities) {
    if (record.paper_id !== p.source_package.paper_id || record.analysis_revision !== p.analysis_revision) add('IDENTITY_MISMATCH',path);
  }
  return validateCompleteTopology(p, units, add, errors);
}

/** Internal shared reference checks; callers must validate shape first. Not an acceptance gate. */
export function validateSourceCoreReferences(p, add, locationContract) {
  const locationKey = locationContract === 'phase21-whole-paper-1.0' ? wholePaperScientificLocationKey : locationContract === 'phase21-native-workbook-1.0' ? nativeScientificLocationKey : tuple;
  const sources = new Map(p.source_package.source_documents.map(d => [d.source_document_id,d]));
  const attachments = new Map(p.source_package.attachments.map(a => [a.attachment_id,a]));
  const evidence = new Map(p.core.evidence.map(e => [e.evidence_id,e]));
  const units = new Map(p.core.units.map(u => [u.unit_id,u]));
  const locators = new Set();
  for (const [i, d] of p.source_package.source_documents.entries()) {
    for (const [j, loc] of d.locators.entries()) {
      if (loc.source_document_id !== d.source_document_id || loc.source_hash !== d.source_hash) {
        add('SOURCE_LOCATOR_MISMATCH', '/source_package/source_documents/' + i + '/locators/' + j);
      } else if (d.included && d.support_status === 'supported') locators.add(locationKey(loc));
    }
  }
  for (const [i,a] of p.source_package.attachments.entries()) {
    const d = sources.get(a.source_document_id);
    if (!d) add('REFERENCE_UNKNOWN','/source_package/attachments/' + i + '/source_document_id');
    else if (a.included && (!d.included || d.support_status !== 'supported')) add('REFERENCE_UNKNOWN','/source_package/attachments/' + i);
  }
  for (const [i,e] of p.core.evidence.entries()) {
    const base = '/core/evidence/' + i, a = attachments.get(e.attachment_id);
    if (!a || !a.included) add('REFERENCE_UNKNOWN', base + '/attachment_id');
    else if (a.source_document_id !== e.locator.source_document_id) add('SOURCE_LOCATOR_MISMATCH', base + '/locator');
    if (!sources.has(e.locator.source_document_id)) add('REFERENCE_UNKNOWN', base + '/locator/source_document_id');
    if (!locators.has(locationKey(e.locator))) add('SOURCE_LOCATOR_MISMATCH', base + '/locator');
  }
  for (const [i,u] of p.core.units.entries()) {
    for (const [j,id] of u.evidence_ids.entries()) if (!evidence.has(id)) add('REFERENCE_UNKNOWN','/core/units/' + i + '/evidence_ids/' + j);
  }
  for (const [i,item] of p.reading_card.items.entries()) {
    for (const [j,id] of item.unit_ids.entries()) if (!units.has(id)) add('REFERENCE_UNKNOWN','/reading_card/items/' + i + '/unit_ids/' + j);
  }
}

function validateCompleteTopology(p, units, add, errors) {
  const required = p.core.units.filter(u => u.required_for_view).map(u => u.unit_id).sort();
  for (const [i,v] of p.views.entries()) {
    const ids = new Set(v.units.map(u => u.unit_id));
    if (JSON.stringify([...v.required_unit_ids].sort()) !== JSON.stringify(required)
      || required.some(id => !ids.has(id)) || [...ids].some(id => !units.has(id))) add('CORE_VIEW_DIVERGENCE','/views/' + i);
  }
  if (JSON.stringify(p.views[0].units.map(u=>u.unit_id).sort()) !== JSON.stringify(p.views[1].units.map(u=>u.unit_id).sort())) add('CORE_VIEW_DIVERGENCE','/views');
  for (const name of MEMBERS) {
    if (!p.manifest.member_hashes[name]) add('HASH_DEPENDENCY_MISSING','/manifest/member_hashes/' + name);
    for (const dep of EDGES[name]) if (!p.manifest.dependency_hashes[name]?.[dep]) add('HASH_DEPENDENCY_MISSING','/manifest/dependency_hashes/' + name + '/' + dep);
  }
  const current = {
    source_package: hash(p.source_package),
    ...Object.fromEntries(Object.entries(p.dependency_inputs).map(([key,value]) => [key,hash(value)])),
    run_context: hash({run_id:p.run_id,run_label:p.run_label,analysis_revision:p.analysis_revision,revision_label:p.revision_label}),
    'analysis.core.json': hash(p.core),
    'analysis.en.json': hash(p.views.find(v=>v.language === 'en')),
    'analysis.zh-CN.json': hash(p.views.find(v=>v.language === 'zh-CN')),
    'scientific-reading-card.json': hash(p.reading_card),
    'analysis.manifest.json': hash(p.manifest)
  };
  const checkHash = (declared, expected, path) => {
    if (!declared) add('HASH_DEPENDENCY_MISSING',path);
    else if (declared !== expected) add('DEPENDENCY_INVALIDATED',path);
  };
  for (const name of MEMBERS) {
    if (p.manifest.member_hashes[name]) checkHash(p.manifest.member_hashes[name],current[name],'/manifest/member_hashes/' + name);
    for (const dep of EDGES[name]) {
      const declared = p.manifest.dependency_hashes[name]?.[dep];
      if (declared) checkHash(declared,current[dep],'/manifest/dependency_hashes/' + name + '/' + dep);
    }
  }
  for (const [i,v] of p.views.entries()) checkHash(v.analysis_core_hash,current['analysis.core.json'],'/views/' + i + '/analysis_core_hash');
  for (const key of ['review_evidence','approval_evidence']) {
    for (const [dep, expected] of Object.entries(current)) checkHash(p[key].dependency_hashes[dep],expected,'/' + key + '/dependency_hashes/' + dep);
  }
  checkHash(p.approval_evidence.review_hash,hash(p.review_evidence),'/approval_evidence/review_hash');
  return result(errors);
}
