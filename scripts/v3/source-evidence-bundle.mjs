import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {isDeepStrictEqual as same} from 'node:util';
import Ajv2020 from 'ajv/dist/2020.js';
import {fingerprintV3Json as hash,checkV3StorageSafety,checkSourceEvidenceTextSafety} from './semantic-package-validator.mjs';
import {ORIGINAL_XLS_PROFILE} from './original-xls-source-evidence.mjs';
import {observeBoundOfficeSource,buildBoundOfficeVisibleParts,deriveBoundOfficeVisibilityFacts} from './whole-paper-adapter.mjs';

const sha=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
const H=/^sha256:[a-f0-9]{64}$/;
const VISIBILITY_POLICY='phase21-source-visibility-policy-1.0';
const fail=code=>{throw Error(code);};
const bytes=b=>b instanceof Uint8Array?Buffer.from(b):fail('SOURCE_EVIDENCE_BYTES_REQUIRED');
const copy=x=>structuredClone(x);
const sorted=x=>[...x].sort((a,b)=>a.document_id.localeCompare(b.document_id));
const safePath=p=>typeof p==='string'&&p.length>0&&!p.startsWith('/')&&!/[\\:]/.test(p)&&!p.split('/').some(s=>!s||s==='.'||s==='..');
const exactKeys=(o,keys)=>o&&typeof o==='object'&&same(Object.keys(o).sort(),[...keys].sort());
const sameIds=(a,b)=>a.length===b.length&&new Set(a).size===a.length&&same([...a].sort(),[...b].sort());
const validRange=r=>r&&['start_row','start_column','end_row','end_column'].every(k=>Number.isSafeInteger(r[k])&&r[k]>0)&&r.start_row<=r.end_row&&r.start_column<=r.end_column;
function addressRange(text){
  const point=s=>{const m=/^([A-Z]+)([1-9][0-9]*)$/.exec(s??'');if(!m)return null;let c=0;for(const v of m[1])c=c*26+v.charCodeAt(0)-64;return{row:Number(m[2]),column:c};};
  const parts=String(text).split(':');if(parts.length>2)return null;const a=point(parts[0]),b=point(parts.at(-1));
  return a&&b?{start_row:a.row,start_column:a.column,end_row:b.row,end_column:b.column}:null;
}
const ajv=new Ajv2020({allErrors:true,strict:false});
for(const name of ['whole-paper','parser-run','original-xls-source-evidence','source-evidence-bundle'])ajv.addSchema(JSON.parse(await readFile(new URL('../../Schema/phase21/'+name+'.schema.json',import.meta.url),'utf8')));
const shape=ajv.getSchema('phase21/source-evidence-bundle'),pdfShape=ajv.getSchema('phase21/parser-run');
const viewShape=ajv.compile({$ref:'phase21/source-evidence-bundle#/$defs/visibleView'});
const sourceShape=ajv.compile({type:'array',minItems:1,items:{$ref:'phase21/whole-paper#/$defs/source'}});
const coverageShape=ajv.compile({type:'array',minItems:1,items:{$ref:'phase21/whole-paper#/$defs/coverage'}});

/** Supplied raw bytes and saved observations only; never a parser run or an authorization verifier. */
export function buildSourceEvidenceBundle({sources,requiredCoverage,pdfRun=null,pdfRunBinding=null,pdfSources=[],officeSources=[],visualSources,approvalBinding,toolBinding}={}){
  try{
    hash({sources,requiredCoverage,pdfRun,approvalBinding,toolBinding});
    if(!sourceShape(sources)||!coverageShape(requiredCoverage)||!Array.isArray(pdfSources)||!Array.isArray(officeSources))fail('SOURCE_EVIDENCE_STRUCTURE_INVALID');
    if(!sameIds(sources.map(s=>s.document_id),requiredCoverage.map(s=>s.document_id)))fail('SOURCE_EVIDENCE_SOURCE_SET_MISMATCH');
    if(!exactKeys(approvalBinding,['authorization_fingerprint','source_scope_fingerprint','policy_fingerprint'])||Object.values(approvalBinding).some(v=>!H.test(v))||approvalBinding.source_scope_fingerprint!==hash({sources:sorted(sources),required_coverage:sorted(requiredCoverage)}))fail('SOURCE_EVIDENCE_APPROVAL_BINDING_MISMATCH');
    if(!exactKeys(toolBinding,['fingerprint','components'])||!Array.isArray(toolBinding.components)||!toolBinding.components.length||toolBinding.components.some(c=>!exactKeys(c,['path','sha256'])||!safePath(c.path)||!H.test(c.sha256))||!same(toolBinding.components.map(c=>c.path),[...new Set(toolBinding.components.map(c=>c.path))].sort())||toolBinding.fingerprint!==hash(toolBinding.components))fail('SOURCE_EVIDENCE_TOOL_BINDING_MISMATCH');
    const office=new Map(),pdf=new Map(),required=new Map(requiredCoverage.map(r=>[r.document_id,r])),containers=new Map();
    for(const p of officeSources){if(!exactKeys(p,['document_id','source_bytes','source_evidence'])||office.has(p.document_id)||!sources.some(s=>s.document_id===p.document_id&&s.purpose==='content'&&['docx','workbook'].includes(s.kind)))fail('SOURCE_EVIDENCE_OFFICE_INPUT_INVALID');hash(p.source_evidence);office.set(p.document_id,p);}
    for(const p of pdfSources){if(!exactKeys(p,['document_id','source_bytes'])||pdf.has(p.document_id)||!sources.some(s=>s.document_id===p.document_id&&s.purpose==='content'&&s.kind==='pdf'))fail('SOURCE_EVIDENCE_PDF_BINDING_MISMATCH');pdf.set(p.document_id,p);}
    const contentPDF=sources.filter(s=>s.kind==='pdf'&&s.purpose==='content');
    let savedBinding=null;
    if(contentPDF.length){
      if(!sameIds(contentPDF.map(s=>s.document_id),[...pdf.keys()])||!pdfShape(pdfRun)||!sameIds(contentPDF.map(s=>s.document_id),pdfRun.sources.map(s=>s.document_id)))fail('SOURCE_EVIDENCE_PDF_BINDING_MISMATCH');
      if(!exactKeys(pdfRunBinding,['record_ref','bytes','sha256'])||!safePath(pdfRunBinding.record_ref))fail('SOURCE_EVIDENCE_PDF_RUN_BINDING_MISMATCH');
      const saved=bytes(pdfRunBinding.bytes);
      if(sha(saved)!==pdfRunBinding.sha256||!same(JSON.parse(saved.toString('utf8')),pdfRun))fail('SOURCE_EVIDENCE_PDF_RUN_BINDING_MISMATCH');
      savedBinding={record_ref:pdfRunBinding.record_ref,bytes_base64:saved.toString('base64'),sha256:pdfRunBinding.sha256};
      for(const s of contentPDF){const p=pdfRun.sources.find(p=>p.document_id===s.document_id);if(sha(bytes(pdf.get(s.document_id).source_bytes))!==s.source_sha256||p.source_sha256!==s.source_sha256||p.role!==s.role||p.critical!==s.critical||p.availability!==s.availability)fail('SOURCE_EVIDENCE_PDF_BINDING_MISMATCH');}
    }else if(pdfRun!==null||pdfRunBinding!==null||pdfSources.length)fail('SOURCE_EVIDENCE_PDF_BINDING_MISMATCH');
    const observations=[],coverage=[],limits=[],provenanceOffice=[],visibility=[];let recordTotal=0,xmlTotal=0;
    const limit=(kind,document_id,source_record_ids,reason,original)=>{const entry={kind,document_id,source_record_ids,reason,original:copy(original)};limits.push({limit_id:hash(entry),...entry});};
    for(const s of sources){
      const r=required.get(s.document_id);
      if(r.kind!==s.kind||r.purpose!==s.purpose)fail('SOURCE_EVIDENCE_COVERAGE_SET_MISMATCH');
      if(s.member_path!=null&&(!safePath(s.member_path)||!s.container))fail('SOURCE_EVIDENCE_ARCHIVE_BINDING_INVALID');
      if(s.container){if(sources.some(x=>x.document_id===s.container.document_id)||containers.has(s.container.document_id)&&containers.get(s.container.document_id)!==s.container.source_sha256)fail('SOURCE_EVIDENCE_ARCHIVE_BINDING_INVALID');containers.set(s.container.document_id,s.container.source_sha256);}
      let status='read',reason='';
      if(s.purpose==='catalogue_only'){
        if(s.kind!=='pdf'||!r.reason)fail('SOURCE_EVIDENCE_CATALOGUE_SCOPE_INVALID');status='catalogue_only';reason=r.reason;
      }else if(s.kind==='pdf'){
        if(!r.required_pages?.length)fail('SOURCE_EVIDENCE_COVERAGE_SET_MISMATCH');
        const p=pdfRun.page_coverage.filter(p=>p.document_id===s.document_id);
        if(p.length!==1||p[0].unknown_item_count!==0||!r.required_pages.every(n=>p[0].known_pages.includes(n)))limit('coverage_incomplete',s.document_id,[],'Saved PDF page coverage is incomplete',p);
      }else{
        if(s.kind==='docx'&&(!r.parts?.length||r.parts.some(p=>!safePath(p))||!r.record_ids?.length)||s.kind==='workbook'&&(!r.sheets?.length||r.sheets.some(x=>!Number.isSafeInteger(x.index)||x.index<0||!x.name||!validRange(x.range))||new Set(r.sheets.map(x=>x.index)).size!==r.sheets.length))fail('SOURCE_EVIDENCE_COVERAGE_SET_MISMATCH');
        const p=office.get(s.document_id);
        if(!p){status='not_read';reason='No supplied original source evidence';limit('source_unread',s.document_id,[],reason,r);}
        else{
          const checked=observeBoundOfficeSource({source:s,sourceBytes:p.source_bytes,sourceEvidence:p.source_evidence});if(!checked.ok)fail(checked.errors[0]);
          const e=checked.evidence;
          if(s.format==='xls'&&e.profile!==ORIGINAL_XLS_PROFILE)limit('derived_representation_difference',s.document_id,[],
            'Qualified XLSX representation retains original XLS truth; format records and scientific interpretation remain bounded',e.derivation);
          if(e.profile===ORIGINAL_XLS_PROFILE)limit('interpretation_unresolved',s.document_id,[],
            'Original BIFF storage was read completely; scientific context, missing records and printed precision remain unresolved',e.source_only_scope);
          const projected=deriveBoundOfficeVisibilityFacts({source:s,sourceBytes:p.source_bytes,sourceEvidence:e});if(!projected.ok)fail(projected.errors[0]);
          for(const transformation of projected.transformations)visibility.push({transformation,source_record_ids:e.records.filter(r=>r.locator?.part===transformation.part&&r.locator.xml_path===transformation.xml_path).map(r=>r.id)});
          const size=Buffer.byteLength(JSON.stringify(e));recordTotal+=size;xmlTotal+=e.parts.reduce((n,p)=>n+p.byte_length,0);
          if(size>256*1024*1024||recordTotal>512*1024*1024)fail('WHOLE_PAPER_RECORD_LIMIT');
          if(xmlTotal>256*1024*1024)fail('WHOLE_PAPER_XML_LIMIT');
          if(s.kind==='docx'&&(!sameIds(r.parts,e.scope.parts)||!sameIds(r.record_ids,checked.observations.map(o=>o.record.id))))fail('SOURCE_EVIDENCE_COVERAGE_INCOMPLETE');
          if(s.kind==='workbook'&&(!sameIds(r.sheets.map(x=>x.index),e.coverage.sheets.map(x=>x.index))||!r.sheets.every(x=>e.coverage.sheets.some(y=>x.index===y.index&&x.name===y.name&&same(x.range,addressRange(y.range))))))fail('SOURCE_EVIDENCE_COVERAGE_INCOMPLETE');
          for(const o of checked.observations)observations.push(o);
          provenanceOffice.push({document_id:s.document_id,source_bytes_base64:bytes(p.source_bytes).toString('base64'),source_evidence:copy(e)});
          for(const rec of e.records){if(rec.unresolved)limit('unresolved_record',s.document_id,[rec.id],'Original source record remains unresolved',rec);if(rec.state==='error'||rec.kind==='error')limit('error_record',s.document_id,[rec.id],'Original source record contains an error',rec);}
          for(const error of e.errors??[])limit('source_error',s.document_id,[],'Original source read error',error);
          if(e.coverage.complete_selected_parts!==true)limit('coverage_incomplete',s.document_id,[],'Original selected parts were not completely read',e.coverage);
          const uninterpreted=Object.hasOwn(e.coverage,'uninterpreted_parts')?e.coverage.uninterpreted_parts:[];
          const partsByPath=new Map(e.parts.map(part=>[part.path,part]));
          if(!Array.isArray(uninterpreted)||new Set(uninterpreted).size!==uninterpreted.length||uninterpreted.some(part=>!safePath(part)||!partsByPath.has(part)))fail('SOURCE_EVIDENCE_INTERPRETATION_SCOPE_INVALID');
          for(const part of uninterpreted)limit('interpretation_unresolved',s.document_id,[],'Selected source part is read but its interpretation remains unresolved',{coverage:e.coverage,part:partsByPath.get(part)});
        }
      }
      if(r.scope_complete!==true||s.availability!=='available')limit('coverage_incomplete',s.document_id,[],'Registered source scope is incomplete or unavailable',{source:s,required_coverage:r});
      coverage.push({document_id:s.document_id,status,scope_fingerprint:hash(r),reason});
    }
    for(const error of pdfRun?.errors??[])limit('pdf_error',error.document_id??'',[],'Saved PDF extraction error',error);
    if(pdfRun?.candidate_eligibility?.eligible===false)limit('pdf_error','',[],'Saved PDF extraction was ineligible',pdfRun.candidate_eligibility);
    const compare=(a,b)=>a<b?-1:a>b?1:0;
    visibility.sort((a,b)=>{const x=a.transformation,y=b.transformation;return compare(x.document_id,y.document_id)||compare(x.part,y.part)||compare(x.xml_path,y.xml_path)||compare(x.attribute,y.attribute);});
    for(const {transformation:t,source_record_ids}of visibility)limit('visibility_withheld',t.document_id,source_record_ids,'Original metadata path is withheld from model-visible content',{...t,policy_version:VISIBILITY_POLICY});
    const bundle={schema_version:'phase21-source-evidence-bundle-1.0',bundle_fingerprint:sha('pending'),sources:copy(sources),required_coverage:copy(requiredCoverage),source_coverage:coverage,pdf_run:copy(pdfRun),office_observations:observations,source_limits:limits,provenance:{office_sources:provenanceOffice,pdf_sources:pdfSources.map(p=>({document_id:p.document_id,source_bytes_base64:bytes(p.source_bytes).toString('base64')})),pdf_run_binding:savedBinding,approval_binding:copy(approvalBinding),tool_binding:copy(toolBinding),office_method:'source_read',pdf_method:'saved_parser_output'}};
    if(visualSources!==undefined){
      const visual=observeVisualSources({visualSources,sources,requiredCoverage,pdfRun});
      bundle.visual_observations=visual.observations;bundle.provenance.visual_sources=visual.provenance;
    }
    const {bundle_fingerprint,...content}=bundle;bundle.bundle_fingerprint=hash(content);
    if(!shape(bundle))fail('SOURCE_EVIDENCE_STRUCTURE_INVALID');
    return {ok:true,bundle,errors:[]};
  }catch(error){return {ok:false,bundle:null,errors:[fixedError(error,'SOURCE_EVIDENCE_STRUCTURE_INVALID')]};}
}

// Explicit saved review + source-page manifest + supplied image bytes. This verifies
// bindings, not scientific entailment, image rendering, or human authorization.
function observeVisualSources({visualSources,sources,requiredCoverage,pdfRun}){
  if(!Array.isArray(visualSources)||!visualSources.length)fail('SOURCE_EVIDENCE_VISUAL_INPUT_INVALID');
  const observations=[],provenance=[],ids=new Set(pdfRun?.blocks.map(b=>b.id)??[]),identities=new Set();
  const normalizePath=p=>typeof p==='string'?p.replaceAll('\\','/'):'';
  const boundBytes=(binding,selector)=>{
    const keys=['record_ref','bytes','sha256',...(selector?[selector]:[])];
    if(!exactKeys(binding,keys)||!safePath(binding.record_ref)||!H.test(binding.sha256)||selector&&typeof binding[selector]!=='string')fail('SOURCE_EVIDENCE_VISUAL_BINDING_INVALID');
    const b=bytes(binding.bytes);if(!b.length||sha(b)!==binding.sha256)fail('SOURCE_EVIDENCE_VISUAL_BYTES_MISMATCH');
    return {b,saved:{record_ref:binding.record_ref,sha256:binding.sha256,bytes_base64:b.toString('base64'),...(selector?{[selector]:binding[selector]}:{})}};
  };
  for(const v of visualSources){
    if(!exactKeys(v,['observation_id','document_id','physical_page','region','literal','text','text_derivation','image','review','manifest'])||typeof v.observation_id!=='string'||!v.observation_id||ids.has(v.observation_id))fail('SOURCE_EVIDENCE_VISUAL_ID_INVALID');
    ids.add(v.observation_id);
    const source=sources.find(s=>s.document_id===v.document_id&&s.kind==='pdf'&&s.purpose==='content');
    if(!source||!Number.isSafeInteger(v.physical_page)||v.physical_page<1||!requiredCoverage.find(r=>r.document_id===v.document_id)?.required_pages?.includes(v.physical_page))fail('SOURCE_EVIDENCE_VISUAL_SOURCE_MISMATCH');
    const image=boundBytes(v.image),review=boundBytes(v.review,'case_id'),manifest=boundBytes(v.manifest,'document_key');
    const reviewData=JSON.parse(review.b.toString('utf8')),manifestData=JSON.parse(manifest.b.toString('utf8'));
    const cases=reviewData.cases?.filter(c=>c.case_id===v.review.case_id),doc=manifestData.documents?.[v.manifest.document_key];
    const c=cases?.length===1?cases[0]:null;
    if(!c||!doc||doc.sha256!==source.source_sha256||!Number.isSafeInteger(doc.pages)||v.physical_page>doc.pages||c.document_id!==v.document_id||c.physical_page!==v.physical_page||c.location!==v.region||c.exact_source_literal!==v.literal||c.reference_text!==v.text||!v.region||!v.literal||!v.text)fail('SOURCE_EVIDENCE_VISUAL_REVIEW_MISMATCH');
    const imageRef=normalizePath(v.image.record_ref),reviewRef=normalizePath(c.source_refs?.image);
    const pageMatch=/^page-([0-9]+)\.(jpg|jpeg|png|webp)$/i.exec(imageRef.split('/').at(-1));
    const entries=doc.images?.filter(i=>{const p=normalizePath(i.path);return p===imageRef||p.endsWith('/'+imageRef);});
    if(reviewRef!==imageRef||!pageMatch||Number(pageMatch[1])!==v.physical_page||entries?.length!==1||'sha256:'+entries[0].sha256.replace(/^sha256:/,'')!==v.image.sha256)fail('SOURCE_EVIDENCE_VISUAL_IMAGE_MISMATCH');
    const identity=hash({document_id:v.document_id,page:v.physical_page,region:v.region,image:v.image.sha256});
    if(identities.has(identity))fail('SOURCE_EVIDENCE_VISUAL_ID_INVALID');identities.add(identity);
    if(v.text_derivation==='identity'?v.text!==v.literal:v.text_derivation!=='reviewed_line_join_only'||!/[\r\n]/.test(v.literal)||v.text!==v.literal.replace(/[ \t]*\r?\n[ \t]*/g,' '))fail('SOURCE_EVIDENCE_VISUAL_TEXT_MISMATCH');
    observations.push({id:v.observation_id,origin:'reviewed_visual_source',document_id:v.document_id,source_sha256:source.source_sha256,locator:{document_id:v.document_id,page_number:v.physical_page,page_status:'known',source_block_id:v.observation_id},physical_page:v.physical_page,region:v.region,literal:v.literal,text:v.text,text_derivation:v.text_derivation,image_sha256:v.image.sha256,review_sha256:v.review.sha256,review_case_id:v.review.case_id,manifest_sha256:v.manifest.sha256});
    provenance.push({...Object.fromEntries(['observation_id','document_id','physical_page','region','literal','text','text_derivation'].map(k=>[k,v[k]])),image:image.saved,review:review.saved,manifest:manifest.saved});
  }
  return {observations,provenance};
}

const fixedError=(error,fallback)=>error?.message==='INVALID_JSON_VALUE'||/^(?:WHOLE_PAPER|SOURCE_EVIDENCE)_[A-Z0-9_]+$/.test(error?.message)?error.message:fallback;
const onlyKeys=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).every(k=>keys.includes(k));

// Metadata shape is checked in addition to byte replay. Unknown sidecar fields are not a storage capability.
function knownSourceEvidence(e,source){
  // The bundle replay has already reconstructed every field from the pinned
  // qualified XLS proof. This branch grants no generic source-evidence exemption.
  if(source?.format==='xls')return (e?.schema_version==='phase21-derived-workbook-evidence-1.0'||e?.schema_version==='phase21-original-xls-source-evidence-1.0'&&e.profile===ORIGINAL_XLS_PROFILE)&&same(e.source_binding,source);
  if(!onlyKeys(e,['format','source','scope','parts','raw_parts','records','coverage','read_accounting','scientific_verification','errors','reader','evidence_level','source_binding'])
    ||!onlyKeys(e.source,['sha256','byte_length','path','member_path','parent_document_id','archive_sha256'])
    ||!onlyKeys(e.scope,['profile','format','parts','sheets','max_xml_bytes','max_source_records','real_pilot','coverage'])
    ||!onlyKeys(e.coverage,['complete_selected_parts','sheets','uninterpreted_parts'])
    ||e.parts.some(p=>!exactKeys(p,['path','sha256','byte_length'])))return false;
  // The successful whole-paper reader emits no errors; unfamiliar error payloads require a separate contract.
  if(Object.hasOwn(e,'errors')&&(!Array.isArray(e.errors)||e.errors.length))return false;
  if(Object.hasOwn(e,'read_accounting')&&(!exactKeys(e.read_accounting,['xml_bytes','source_bytes'])||e.read_accounting.xml_bytes!==e.parts.reduce((n,p)=>n+p.byte_length,0)||e.read_accounting.source_bytes!==e.source.byte_length))return false;
  if(Object.hasOwn(e,'scientific_verification')&&e.scientific_verification!==false)return false;
  const producerWrapper=Object.hasOwn(e,'source_binding')||e.reader&&['profile','module_sha256','authority_sha256'].some(key=>Object.hasOwn(e.reader,key));
  if(producerWrapper){
    // Legacy standalone acquisition records predate evaluation role/coverage fields.
    // Match all five original identity fields exactly; never project an archive member.
    const identityKeys=['document_id','source_sha256','member_path','format','kind'];
    const standaloneIdentity=source&&source.container==null&&source.member_path==null&&exactKeys(e.source_binding,identityKeys)
      &&identityKeys.every(k=>same(e.source_binding[k],source[k]));
    if(!source||!same(e.source_binding,source)&&!standaloneIdentity||!exactKeys(e.reader,['profile','code_sha256','module_sha256','authority_sha256'])
      ||e.reader.profile!=='whole-paper-source-1.0'||e.reader.profile!==e.scope.profile
      ||['code_sha256','module_sha256','authority_sha256'].some(key=>typeof e.reader[key]!=='string'||!H.test(e.reader[key])))return false;
  }else if(Object.hasOwn(e,'reader')&&(!onlyKeys(e.reader,['identity','version','code_sha256','consumer_code_sha256','runtime_path','dependencies'])||Object.values(e.reader).some(v=>typeof v!=='string')))return false;
  if(Object.hasOwn(e,'evidence_level')&&e.evidence_level!=='local_source_only')return false;
  if(!Array.isArray(e.scope.parts)||e.scope.parts.some(p=>typeof p!=='string'))return false;
  if(e.scope.sheets&&(!Array.isArray(e.scope.sheets)||e.scope.sheets.some(s=>!exactKeys(s,['index','name','range'])||!Number.isSafeInteger(s.index)||typeof s.name!=='string'||typeof s.range!=='string')))return false;
  if(!Array.isArray(e.coverage.sheets)||e.coverage.sheets.some(s=>!exactKeys(s,['index','name','range','serialized_cells','merged_ranges','unserialized_not_assumed_blank'])||!Number.isSafeInteger(s.index)||typeof s.name!=='string'||typeof s.range!=='string'||!Number.isSafeInteger(s.serialized_cells)||!Array.isArray(s.merged_ranges)||s.merged_ranges.some(v=>typeof v!=='string')||s.unserialized_not_assumed_blank!==true))return false;
  const common=['id','kind','locator','physical_page','evidence_origin','text'];
  for(const r of e.records){
    const fields=r.kind==='workbook_cell'?['sheet','address','row','column','state','xml_type','raw_value','serialized','merges','formula','cache','unresolved','style_index','number_format_interpretation']
      :r.kind==='external_relationship'?['target','relation_type','status']
      :['paragraph','table','row','cell','footnote','endnote','comment'].includes(r.kind)?['ancestry','attributes',...(['table','row','cell'].includes(r.kind)?['structure']:[])]
      :r.kind==='feature'?['feature','attributes','status']:null;
    if(!fields||!onlyKeys(r,[...common,...fields])||!exactKeys(r.locator,['part','part_sha256','xml_path']))return false;
    if(Object.hasOwn(r,'number_format_interpretation')&&r.number_format_interpretation!=='not_rendered')return false;
    if(r.kind==='workbook_cell'&&(!exactKeys(r.sheet,['index','name','sheet_id','visibility'])||!exactKeys(r.formula,['present','text','attributes'])||!exactKeys(r.cache,['element_present','raw_value'])))return false;
  }
  return true;
}

function scanSourceValue(value,{rawParts=new WeakSet(),archiveBytes=new WeakMap(),relationshipLocators=new WeakSet(),visibleParts=new WeakSet(),typedLocations=new WeakMap()}={}){
  let unsafe=false;
  const add=()=>{unsafe=true;};
  const walk=(v,field='',parent=null)=>{
    if(typeof v==='string'){
      if(parent&&(rawParts.has(parent)&&['xml','raw_base64'].includes(field)||archiveBytes.get(parent)?.has(field)||relationshipLocators.has(parent)&&field==='xml_path'||visibleParts.has(parent)&&field==='visible_xml'))return;
      checkSourceEvidenceTextSafety(v,'/[field]',add,['text','extracted_text','canonical_statement'].includes(field)||typedLocations.get(parent)?.has(field)?field:'');return;
    }
    if(!v||typeof v!=='object')return;
    for(const [key,child]of Object.entries(v)){
      checkV3StorageSafety(key,'/[field]',add);
      walk(child,Array.isArray(v)?field:key,v);
    }
  };
  walk(value);return !unsafe;
}

function sourceTypedLocations(bundle){
  const map=new WeakMap(),mark=(o,key)=>{if(o&&typeof o==='object'){const fields=map.get(o)??new Set();fields.add(key);map.set(o,fields);}};
  const record=r=>{if(!r)return;mark(r.locator,'xml_path');if(Array.isArray(r.ancestry))mark(r.ancestry,'ancestry');};
  for(const p of bundle.provenance?.office_sources??[]){for(const r of p.source_evidence.records)record(r);for(const raw of p.source_evidence.raw_parts??[])mark(raw,'locator_root');}
  for(const o of bundle.office_observations??[]){mark(o.locator,'xml_path');record(o.record);}
  for(const l of bundle.source_limits??[])if(l.kind==='visibility_withheld')mark(l.original,'xml_path');else if(['unresolved_record','error_record'].includes(l.kind))record(l.original);
  for(const t of bundle.transformations??[])mark(t,'xml_path');
  return map;
}

/** Local archival boundary only. A successful result is not model-delivery permission. */
export function validateSourceEvidenceStorageSafety(bundle){
  try{
    const checked=validateSourceEvidenceBundle(bundle);if(!checked.ok)return {ok:false,errors:checked.errors.map(code=>fixedError({message:code},'SOURCE_EVIDENCE_STRUCTURE_INVALID'))};
    const rawParts=new WeakSet(),archiveBytes=new WeakMap(),relationshipLocators=new WeakSet();
    for(const p of bundle.provenance.office_sources){
      const e=p.source_evidence,source=bundle.sources.find(s=>s.document_id===p.document_id);
      if(!knownSourceEvidence(e,source))fail('SOURCE_EVIDENCE_VISIBLE_CONTENT_UNSAFE');
      archiveBytes.set(p,new Set(['source_bytes_base64']));
      if(source.format==='xls')for(const a of Object.values(e.proof))archiveBytes.set(a,new Set(['bytes_base64']));
      for(const part of e.raw_parts??[])rawParts.add(part);
      for(const rec of e.records)if(rec.kind==='external_relationship')relationshipLocators.add(rec.locator);
    }
    for(const p of bundle.provenance.pdf_sources)archiveBytes.set(p,new Set(['source_bytes_base64']));
    if(bundle.provenance.pdf_run_binding)archiveBytes.set(bundle.provenance.pdf_run_binding,new Set(['bytes_base64']));
    for(const v of bundle.provenance.visual_sources??[])for(const k of ['image','review','manifest'])archiveBytes.set(v[k],new Set(['bytes_base64']));
    if(!scanSourceValue(bundle,{rawParts,archiveBytes,relationshipLocators,typedLocations:sourceTypedLocations(bundle)}))fail('SOURCE_EVIDENCE_VISIBLE_CONTENT_UNSAFE');
    return {ok:true,errors:[]};
  }catch(error){return {ok:false,errors:[fixedError(error,'SOURCE_EVIDENCE_VISIBLE_CONTENT_UNSAFE')]};}
}

/** Every XML part is reconstructed from the original bytes; no caller-controlled exemption list. */
export function buildSourceEvidenceVisibleView({bundle}={}){
  try{
    const checked=validateSourceEvidenceStorageSafety(bundle);if(!checked.ok)return {ok:false,view:null,errors:checked.errors};
    const office_parts=[],transformations=[];
    for(const p of bundle.provenance.office_sources){
      const projected=buildBoundOfficeVisibleParts({source:bundle.sources.find(s=>s.document_id===p.document_id),sourceBytes:Buffer.from(p.source_bytes_base64,'base64'),sourceEvidence:p.source_evidence});
      if(!projected.ok)fail(projected.errors[0]);office_parts.push(...projected.parts);transformations.push(...projected.transformations);
    }
    const compare=(a,b)=>a<b?-1:a>b?1:0;
    transformations.sort((a,b)=>compare(a.document_id,b.document_id)||compare(a.part,b.part)||compare(a.xml_path,b.xml_path)||compare(a.attribute,b.attribute));
    const pdfKeys=['blocks','page_coverage','assets','normalization_audit','errors','candidate_eligibility'];
    const view={schema_version:'phase21-source-evidence-visible-view-1.0',policy_version:VISIBILITY_POLICY,source_bundle_fingerprint:bundle.bundle_fingerprint,source_scope_fingerprint:bundle.provenance.approval_binding.source_scope_fingerprint,
      ...Object.fromEntries(['sources','required_coverage','source_coverage','office_observations','source_limits'].map(k=>[k,copy(bundle[k])])),pdf_evidence:bundle.pdf_run?Object.fromEntries(pdfKeys.map(k=>[k,copy(bundle.pdf_run[k])])):null,office_parts,transformations};
    if(bundle.visual_observations)view.visual_observations=copy(bundle.visual_observations);
    const visibleParts=new WeakSet(office_parts);if(!scanSourceValue(view,{visibleParts,typedLocations:sourceTypedLocations(view)}))fail('SOURCE_EVIDENCE_VISIBLE_CONTENT_UNSAFE');
    view.view_fingerprint=hash(view);if(!viewShape(view))fail('SOURCE_EVIDENCE_VISIBLE_VIEW_MISMATCH');
    return {ok:true,view,errors:[]};
  }catch(error){return {ok:false,view:null,errors:[fixedError(error,'SOURCE_EVIDENCE_VISIBLE_CONTENT_UNSAFE')]};}
}

export function validateSourceEvidenceVisibleView({bundle,view}={}){
  try{
    hash(view);if(!viewShape(view))fail('SOURCE_EVIDENCE_VISIBLE_VIEW_MISMATCH');
    const rebuilt=buildSourceEvidenceVisibleView({bundle});if(!rebuilt.ok)return {ok:false,errors:rebuilt.errors};
    if(!same(rebuilt.view,view))fail('SOURCE_EVIDENCE_VISIBLE_VIEW_MISMATCH');return {ok:true,errors:[]};
  }catch(error){return {ok:false,errors:[fixedError(error,'SOURCE_EVIDENCE_VISIBLE_VIEW_MISMATCH')]};}
}

/** Reconstruct from the saved original bytes, not just the caller-editable outer fingerprint. */
export function validateSourceEvidenceBundle(bundle){
  try{
    hash(bundle);if(!shape(bundle))fail('SOURCE_EVIDENCE_STRUCTURE_INVALID');
    const decode=s=>{const b=Buffer.from(s,'base64');if(b.toString('base64')!==s)fail('SOURCE_EVIDENCE_BYTES_INVALID');return b;};
    const p=bundle.provenance,r=p.pdf_run_binding;
    const visual=p.visual_sources?.map(v=>({...v,...Object.fromEntries(['image','review','manifest'].map(k=>{const {bytes_base64,...binding}=v[k];return[k,{...binding,bytes:decode(bytes_base64)}];}))}));
    const replay=buildSourceEvidenceBundle({sources:bundle.sources,requiredCoverage:bundle.required_coverage,pdfRun:bundle.pdf_run,pdfRunBinding:r?{record_ref:r.record_ref,bytes:decode(r.bytes_base64),sha256:r.sha256}:null,pdfSources:p.pdf_sources.map(p=>({document_id:p.document_id,source_bytes:decode(p.source_bytes_base64)})),officeSources:p.office_sources.map(p=>({document_id:p.document_id,source_bytes:decode(p.source_bytes_base64),source_evidence:p.source_evidence})),...(visual?{visualSources:visual}:{}),approvalBinding:p.approval_binding,toolBinding:p.tool_binding});
    if(!replay.ok)return {ok:false,errors:replay.errors};
    if(!same(replay.bundle,bundle))fail('SOURCE_EVIDENCE_REPLAY_MISMATCH');
    return {ok:true,errors:[]};
  }catch(error){return {ok:false,errors:[fixedError(error,'SOURCE_EVIDENCE_STRUCTURE_INVALID')]};}
}
