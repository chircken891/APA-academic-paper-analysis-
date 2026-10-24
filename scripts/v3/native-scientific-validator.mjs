import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { canonicalizeV3Json, checkV3StorageSafety, validateSourceCoreReferences, nativeScientificLocationKey } from './semantic-package-validator.mjs';
import { validateScientificContent } from './scientific-quality-validator.mjs';
import { validateWorkbookScientificSourceRun } from './parser-comparison.mjs';

const digest=value=>'sha256:'+createHash('sha256').update(canonicalizeV3Json(value)).digest('hex');
const same=(a,b)=>canonicalizeV3Json(a)===canonicalizeV3Json(b);
const locationContract='phase21-native-workbook-1.0';
const bases=Object.fromEntries(await Promise.all(Object.entries({source:'../../Schema/contracts/v3-source-package.schema.json',analysis:'../../Schema/contracts/v3-analysis-package.schema.json',scientific:'../../Schema/contracts/v3-scientific/v3-scientific-package.schema.json',envelope:'../../Schema/phase21/scientific-input.schema.json',workbook:'../../Schema/phase21/native-workbook.schema.json',native:'../../Schema/phase21/native-scientific-input.schema.json'}).map(async([key,path])=>[key,JSON.parse(await readFile(new URL(path,import.meta.url),'utf8'))])));
const ids={source:'phase21/native-scientific-source',analysis:'phase21/native-scientific-analysis',scientific:'phase21/native-scientific-details'};
const remapRefs=value=>{
  if (!value||typeof value!=='object')return;
  for(const [key,child]of Object.entries(value)){
    if(key==='$ref'&&typeof child==='string'){
      const aliases={'v3/source-package':'native-scientific-source','source-package':'native-scientific-source','v3/analysis-package':'native-scientific-analysis','v3/scientific-package':'native-scientific-details'};
      const [base,...fragment]=child.split('#');if(aliases[base])value[key]=aliases[base]+(fragment.length?'#'+fragment.join('#'):'');
    } else remapRefs(child);
  }
};

/** Derives only the approved location/source/version pointers in a separate schema registry. */
export function compileNativeScientificSchemas(schemaBases=bases) {
  // Compare the immutable base objects as well as the named pointers: never guess a changed baseline.
  const mismatch=()=>{throw Object.assign(new Error('NATIVE_SCIENTIFIC_SCHEMA_BASE_MISMATCH'),{code:'NATIVE_SCIENTIFIC_SCHEMA_BASE_MISMATCH'});};
  for(const key of ['source','analysis','scientific','envelope','workbook','native']){
    let matches=false;try{matches=same(schemaBases?.[key],bases[key]);}catch{mismatch();}if(!matches)mismatch();
  }
  const {source,analysis,scientific,envelope}=structuredClone(schemaBases);
  if(source?.$id!=='v3/source-package'||analysis?.$id!=='v3/analysis-package'||scientific?.$id!=='v3/scientific-package'
    ||source.properties?.schema_version?.const!=='3.0.0'||source.properties?.content_profile?.const!=='apa-v3.0'
    ||!source.$defs?.locator?.required?.includes('page_index')||!scientific.$defs?.sourceBlock?.required?.includes('page_index')||!scientific.$defs?.quantityOccurrence?.required?.includes('page_index')
    ||analysis.properties?.core?.properties?.evidence?.items?.properties?.locator?.$ref!=='source-package#/$defs/locator'
    ||envelope.properties?.source_package?.$ref!=='v3/source-package'||scientific.$defs?.details?.properties?.scientific_schema_version?.const!=='v3/scientific-package@3.0.0-scientific')mismatch();
  source.$id=ids.source;analysis.$id=ids.analysis;scientific.$id=ids.scientific;
  for(const schema of [source,analysis,scientific])remapRefs(schema);
  source.properties.schema_version.const='phase21-source-package-workbook-1.0';source.properties.content_profile.const='apa-v3.0-native-workbook-1.0';
  const nativeRef=name=>({'$ref':'native-scientific-input#/$defs/'+name});
  const pdfLocator=structuredClone(source.$defs.locator);pdfLocator.properties.kind={const:'pdf'};pdfLocator.required.push('kind');
  source.$defs.locator={oneOf:[pdfLocator,nativeRef('workbookLocator')]};
  const document=source.properties.source_documents.items;
  document.required.push('kind');document.properties.kind={enum:['pdf','workbook']};
  for(const key of ['format','container','member_path']){
    document.properties[key]=structuredClone(schemaBases.workbook.$defs.workbookSource.properties[key]);
    const rewrite=v=>{if(v&&typeof v==='object')for(const[k,c]of Object.entries(v)){if(k==='$ref'&&c.startsWith('#'))v[k]='native-workbook'+c;else rewrite(c);}};rewrite(document.properties[key]);
  }
  document.allOf.push({if:{properties:{kind:{const:'workbook'}},required:['kind']},then:{properties:{format:{},container:{},member_path:{}},required:['format','container','member_path']},else:{not:{anyOf:['format','container','member_path'].map(key=>({properties:{[key]:{}},required:[key]}))}}});
  for(const name of ['sourceBlock','quantityOccurrence']){
    const pdf=structuredClone(scientific.$defs[name]),workbook=structuredClone(pdf);
    delete workbook.properties.page_index;workbook.required=workbook.required.filter(k=>k!=='page_index');
    workbook.properties.native_locator=nativeRef('workbookLocator');workbook.required.push('native_locator');
    if(name==='sourceBlock'){workbook.properties.observation_fingerprint={'$ref':'#/$defs/hash'};workbook.required.push('observation_fingerprint');}
    else{workbook.properties.value_cell=nativeRef('valueCell');workbook.properties.cell_fingerprint={'$ref':'#/$defs/hash'};workbook.required.push('value_cell','cell_fingerprint');}
    scientific.$defs[name]={oneOf:[pdf,workbook]};
  }
  scientific.$defs.details.properties.scientific_schema_version.const='phase21/scientific-details@native-workbook-1.0';
  const ajv=new Ajv2020({allErrors:true,strict:true});addFormats(ajv);
  ajv.addKeyword({keyword:'uniqueItemProperty',type:'array',schemaType:'string',errors:false,validate:(key,values)=>new Set(values.map(v=>v?.[key])).size===values.length});
  const schemas={source,analysis,scientific,native:structuredClone(schemaBases.native),workbook:structuredClone(schemaBases.workbook)};
  for(const schema of Object.values(schemas))ajv.addSchema(schema);
  return {schemas,shape:ajv.getSchema('phase21/native-scientific-input')};
}
const compiled=compileNativeScientificSchemas();
const metadataKey=m=>canonicalizeV3Json([m.source_document_id,m.sheet,m.row,m.column]);
const metadataFor=(input,block)=>input.native_cell_metadata.filter(m=>m.source_document_id===block.locator.document_id&&same(m.sheet,block.locator.sheet)&&block.cells.some(c=>c.row===m.row&&c.column===m.column));
const parserBlock=(run,loc)=>run.blocks.find(b=>b.locator.document_id===loc.source_document_id&&b.locator.source_block_id===loc.block_id&&b.locator.kind===loc.kind&&(loc.kind==='pdf'?b.locator.page_number===loc.page_index+1:same(b.locator.sheet,loc.sheet)&&same(b.locator.range,loc.range)&&b.locator.member_path===loc.member_path));
function projection(input,block){return {block,metadata:metadataFor(input,block),context:Object.entries(block.context_bindings).map(([kind,binding])=>({kind,binding,observations:binding.locators.map(loc=>{const b=input.native_source_run.blocks.find(b=>same(b.locator,loc));return {block:b,metadata:b?metadataFor(input,b):[]};})}))};}
/** Deterministic observed cells, original metadata and all four context bindings, never generated prose. */
export function nativeScientificExcerpt(input,block){return canonicalizeV3Json(projection(input,block));}
function metadataMatches(source,cell,m){
  if(!m.original_type.startsWith(source.format+':'))return false;
  const type=m.original_type.split(':')[1],raw=m.raw_lexical_value;
  if(['n','number'].includes(type))return cell.state==='value'&&typeof cell.value==='number'&&/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(raw)&&Number.isFinite(Number(raw))&&Number(raw)===cell.value;
  if(['inlineStr','string'].includes(type))return cell.state==='value'&&typeof cell.value==='string'&&raw===cell.value;
  // A shared-string token and its observed resolved text are distinct layers.
  if(type==='s')return cell.state==='value'&&typeof cell.value==='string'&&/^\d+$/.test(raw);
  if(['b','boolean'].includes(type))return cell.state==='value'&&typeof cell.value==='boolean'&&(raw===(cell.value?'1':'0')||source.format==='xls'&&raw===String(cell.value));
  if(['e','error'].includes(type))return cell.state==='error'&&raw===cell.value;
  return type==='blank'&&cell.state==='blank'&&cell.value===null&&raw==='';
}

/** Additional native closure only; all nonlocation science is checked by the existing shared validator. */
export function validateNativeScientificEvidenceBindings(input,add){
  const run=input.native_source_run, sources=new Map(run.sources.map(s=>[s.document_id,s]));
  const keys=new Set();
  for(const m of input.native_cell_metadata){
    const key=metadataKey(m);if(keys.has(key))add('WORKBOOK_DUPLICATE_KEY','/native_cell_metadata');keys.add(key);
    const block=run.blocks.find(b=>b.locator.kind==='workbook'&&b.locator.document_id===m.source_document_id&&same(b.locator.sheet,m.sheet)&&b.cells.some(c=>c.row===m.row&&c.column===m.column));
    const cell=block?.cells.find(c=>c.row===m.row&&c.column===m.column),source=sources.get(m.source_document_id);
    if(!source||!cell||!metadataMatches(source,cell,m))add('NATIVE_SCIENTIFIC_CELL_TYPE_MISMATCH','/native_cell_metadata');
  }
  for(const d of input.source_package.source_documents){
    const source=sources.get(d.source_document_id);
    if(!source||source.kind!==d.kind||source.source_sha256!==d.source_hash||source.role!==(d.role==='main'?'main':'attachment')||source.availability!==(d.included&&d.support_status==='supported'?'available':'missing')
      ||source.critical!==input.source_package.attachments.some(a=>a.source_document_id===d.source_document_id&&a.critical)
      ||d.kind==='workbook'&&(!same(source.container,d.container)||source.member_path!==d.member_path||source.format!==d.format))add('WORKBOOK_SOURCE_BINDING_MISMATCH','/source_package/source_documents');
    for(const loc of d.locators)if(loc.kind!==d.kind||!parserBlock(run,loc))add('SOURCE_LOCATOR_MISMATCH','/source_package/source_documents');
  }
  if(!same([...sources.keys()].sort(),input.source_package.source_documents.map(d=>d.source_document_id).sort())||!input.source_package.source_documents.some(d=>d.kind==='workbook'))add('WORKBOOK_SOURCE_BINDING_MISMATCH','/source_package');
  for(const b of input.scientific_details.source_blocks){
    const evidence=input.core.evidence.filter(e=>nativeScientificLocationKey(e.locator)===nativeScientificLocationKey(b.native_locator??b));
    if(!evidence.length)add('SCIENTIFIC_BOUNDARY_MAPPING_UNKNOWN','/core/evidence');
    for(const record of input.scientific_details.records.filter(r=>r.source_block_ids.includes(b.source_block_id)))if(!evidence.some(e=>record.boundary_evidence_ids.includes(e.evidence_id)))add('SCIENTIFIC_BOUNDARY_MAPPING_UNKNOWN','/scientific_details/records');
  }
  for(const b of input.scientific_details.source_blocks.filter(b=>b.native_locator)){
    const loc=b.native_locator, block=parserBlock(run,loc);
    if(b.source_document_id!==loc.source_document_id||b.source_hash!==loc.source_hash||b.block_id!==loc.block_id||!block){add('SOURCE_LOCATOR_MISMATCH','/scientific_details/source_blocks');continue;}
    for(const observed of [block,...Object.values(block.context_bindings).flatMap(c=>c.locators.map(l=>run.blocks.find(x=>same(x.locator,l))))]){
      if(!observed){add('WORKBOOK_CONTEXT_BINDING_INVALID','/scientific_details/source_blocks');continue;}
      for(const c of observed.cells)if(!input.native_cell_metadata.some(m=>m.source_document_id===observed.locator.document_id&&same(m.sheet,observed.locator.sheet)&&m.row===c.row&&m.column===c.column))add('NATIVE_SCIENTIFIC_CELL_METADATA_MISSING','/native_cell_metadata');
    }
    const p=projection(input,block);
    if(b.observation_fingerprint!==digest(p)||b.text!==canonicalizeV3Json(p))add('WORKBOOK_SOURCE_BINDING_MISMATCH','/scientific_details/source_blocks');
  }
  for(const q of input.scientific_details.quantities)for(const o of q.source_occurrences.filter(o=>o.native_locator)){
    const block=parserBlock(run,o.native_locator), point=o.value_cell;
    const cell=block?.cells.find(c=>c.row===point.row&&c.column===point.column),m=input.native_cell_metadata.find(m=>m.source_document_id===o.native_locator.source_document_id&&same(m.sheet,o.native_locator.sheet)&&m.row===point.row&&m.column===point.column);
    const range=o.native_locator.range;
    if(!cell||!m||point.row<range.start_row||point.row>range.end_row||point.column<range.start_column||point.column>range.end_column){add('SCIENTIFIC_QUANTITY_CONTEXT_MISMATCH','/scientific_details/quantities');continue;}
    if(cell.state!=='value')add('WORKBOOK_REQUIRED_VALUE_INVALID','/scientific_details/quantities');
    if(cell.formula!==null&&cell.cached_value_status!=='observed')add('WORKBOOK_FORMULA_CACHE_MISSING','/scientific_details/quantities');
    const raw=typeof cell.value==='number'?m.raw_lexical_value:String(cell.value);
    if(o.cell_fingerprint!==digest({cell,metadata:m})||o.raw_value!==raw||o.raw_precision!=='lexical:'+m.raw_lexical_value)add('SCIENTIFIC_QUANTITY_CONTEXT_MISMATCH','/scientific_details/quantities');
  }
}

export function validateNativeScientificInput(candidate){
  const errors=[],add=(code,path)=>errors.push({code,path,message:code});
  const result=()=>({ok:!errors.length,status:errors.length?'invalid_preparation':'preparation_validated',errors:errors.sort((a,b)=>a.code<b.code?-1:a.code>b.code?1:a.path<b.path?-1:a.path>b.path?1:0),warnings:[],publishable:false,...(!errors.length?{input_fingerprint:candidate.input_fingerprint,scientific_completeness:candidate.scientific_details.source_status.completeness}:{})});
  try{canonicalizeV3Json(candidate);}catch{add('SCIENTIFIC_INPUT_STRUCTURE_INVALID','/');return result();}
  checkV3StorageSafety(candidate,'/',add);if(errors.length)return result();
  if(!compiled.shape(candidate)){
    add('SCIENTIFIC_INPUT_STRUCTURE_INVALID','/');
    for(const error of compiled.shape.errors??[]){
      if(error.instancePath.startsWith('/scientific_details/source_conflicts/'))add('SCIENTIFIC_SOURCE_CONFLICT_HIDDEN','/scientific_details/source_conflicts');
      if(error.instancePath.startsWith('/scientific_details/experiment_claim_matrix/'))add('SCIENTIFIC_CLAIM_CHAIN_INCOMPLETE','/scientific_details/experiment_claim_matrix');
    }
    return result();
  }
  const runCheck=validateWorkbookScientificSourceRun(candidate.native_source_run);
  for(const code of runCheck.errors)add(code.split(':')[0],'/native_source_run');
  if(!runCheck.ok)return result();
  if(candidate.identity.paper_id!==candidate.source_package.paper_id)add('SCIENTIFIC_IDENTITY_MISMATCH','/identity');
  for(const key of ['core','reading_card'])if(candidate[key].paper_id!==candidate.identity.paper_id||candidate[key].analysis_revision!==candidate.identity.analysis_revision)add('IDENTITY_MISMATCH','/'+key);
  validateSourceCoreReferences(candidate,add,locationContract);
  validateNativeScientificEvidenceBindings(candidate,add);
  validateScientificContent(candidate.scientific_details,candidate,add,locationContract);
  const {input_fingerprint,...content}=candidate;if(input_fingerprint!==digest(content))add('SCIENTIFIC_INPUT_BINDING_STALE','/input_fingerprint');
  return result();
}
