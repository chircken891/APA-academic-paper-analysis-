import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {readFile} from 'node:fs/promises';
import {canonicalizeV3Json,fingerprintV3Json,checkV3StorageSafety,checkSourceEvidenceTextSafety,validateSourceCoreReferences,wholePaperScientificLocationKey} from './semantic-package-validator.mjs';
import {isDeepStrictEqual} from 'node:util';
import {validateScientificContent} from './scientific-quality-validator.mjs';
import {validateWholePaperRun} from './whole-paper-comparison.mjs';
import {buildSourceEvidenceVisibleView} from './source-evidence-bundle.mjs';
import {createHash} from 'node:crypto';

const hash=fingerprintV3Json;
const same=isDeepStrictEqual;
const contract='phase21-whole-paper-1.0';
const sourceEvidenceSchemas=await Promise.all(['source-evidence-bundle','source-evidence-scientific-input'].map(async name=>JSON.parse(await readFile(new URL('../../Schema/phase21/'+name+'.schema.json',import.meta.url),'utf8'))));
const bases=Object.fromEntries(await Promise.all(Object.entries({source:'../../Schema/contracts/v3-source-package.schema.json',analysis:'../../Schema/contracts/v3-analysis-package.schema.json',scientific:'../../Schema/contracts/v3-scientific/v3-scientific-package.schema.json',whole:'../../Schema/phase21/whole-paper.schema.json',envelope:'../../Schema/phase21/whole-paper-scientific-input.schema.json'}).map(async([k,p])=>[k,JSON.parse(await readFile(new URL(p,import.meta.url),'utf8'))])));

/** Separate registry: never changes the frozen PDF or native-workbook schema objects/files. */
export function compileWholePaperScientificSchemas(schemaBases=bases){
  for(const key of Object.keys(bases))if(!same(schemaBases?.[key],bases[key]))throw Error('WHOLE_PAPER_SCIENTIFIC_SCHEMA_BASE_MISMATCH');
  const {source,analysis,scientific,whole,envelope}=structuredClone(schemaBases);
  const ids={source:'phase21/whole-paper-scientific-source',analysis:'phase21/whole-paper-scientific-analysis',scientific:'phase21/whole-paper-scientific-details'};
  if(source.$id!=='v3/source-package'||analysis.$id!=='v3/analysis-package'||scientific.$id!=='v3/scientific-package'||!source.$defs.locator.required.includes('page_index'))throw Error('WHOLE_PAPER_SCIENTIFIC_SCHEMA_BASE_MISMATCH');
  const remap=value=>{if(value&&typeof value==='object')for(const[k,v]of Object.entries(value))if(k==='$ref'&&typeof v==='string'){const [base,...fragment]=v.split('#'),target={'v3/source-package':'whole-paper-scientific-source','source-package':'whole-paper-scientific-source','v3/analysis-package':'whole-paper-scientific-analysis','v3/scientific-package':'whole-paper-scientific-details'}[base];if(target)value[k]=target+(fragment.length?'#'+fragment.join('#'):'');}else remap(v);};
  source.$id=ids.source;analysis.$id=ids.analysis;scientific.$id=ids.scientific;
  for(const s of [source,analysis,scientific])remap(s);
  source.properties.schema_version.const='phase21-source-package-whole-paper-1.0';source.properties.content_profile.const='apa-v3.0-whole-paper-1.0';
  const ref=name=>({$ref:'whole-paper-scientific-input#/$defs/'+name});
  const pdf=structuredClone(source.$defs.locator);pdf.properties.kind={const:'pdf'};pdf.required.push('kind');
  source.$defs.locator={oneOf:[pdf,ref('docxLocator'),ref('workbookLocator')]};
  const doc=source.properties.source_documents.items;doc.required.push('kind','purpose');doc.properties.kind={enum:['pdf','docx','workbook']};doc.properties.purpose={enum:['content','catalogue_only']};
  for(const k of ['format','container','member_path']){doc.properties[k]=structuredClone(whole.$defs.source.properties[k]);const rewrite=v=>{if(v&&typeof v==='object')for(const [key,child]of Object.entries(v))if(key==='$ref'&&child.startsWith('#'))v[key]='whole-paper'+child;else rewrite(child);};rewrite(doc.properties[k]);}
  doc.allOf.push({if:{properties:{kind:{enum:['docx','workbook']}},required:['kind']},then:{properties:{format:{},container:{},member_path:{}},required:['format','container','member_path']}});
  for(const name of ['sourceBlock','quantityOccurrence']){
    const base=structuredClone(scientific.$defs[name]),variants=[base];
    for(const kind of ['docx','workbook']){
      const v=structuredClone(base);delete v.properties.page_index;v.required=v.required.filter(k=>k!=='page_index');v.properties.native_locator=ref(kind+'Locator');v.required.push('native_locator');
      if(name==='sourceBlock'){v.properties.observation_fingerprint={$ref:'#/$defs/hash'};v.required.push('observation_fingerprint');}
      else if(kind==='docx'){v.properties.value_span=ref('valueSpan');v.properties.record_fingerprint={$ref:'#/$defs/hash'};v.required.push('value_span','record_fingerprint');}
      else{v.properties.value_cell=ref('valueCell');v.properties.cell_fingerprint={$ref:'#/$defs/hash'};v.required.push('value_cell','cell_fingerprint');}
      variants.push(v);
    }
    scientific.$defs[name]={oneOf:variants};
  }
  scientific.$defs.details.properties.scientific_schema_version.const='phase21/scientific-details@whole-paper-1.0';
  const ajv=new Ajv2020({allErrors:true,strict:true});addFormats(ajv);
  ajv.addKeyword({keyword:'uniqueItemProperty',type:'array',schemaType:'string',errors:false,validate:(key,values)=>new Set(values.map(v=>v?.[key])).size===values.length});
  // Whole-paper transport uses deliberately extensible observation/provenance objects, not frozen V3 shapes.
  const transport=structuredClone(whole);ajv.addSchema(transport);
  for(const s of [source,analysis,scientific,envelope])ajv.addSchema(s);
  for(const s of sourceEvidenceSchemas)ajv.addSchema(structuredClone(s));
  return {shape:ajv.getSchema('phase21/whole-paper-scientific-input'),sourceEvidenceShape:ajv.getSchema('phase21/source-evidence-scientific-input'),reviewShape:ajv.compile({$ref:'phase21/source-evidence-scientific-input#/$defs/review'}),qualificationShape:ajv.compile({$ref:'phase21/source-evidence-scientific-input#/$defs/qualification'}),schemas:{source,analysis,scientific,envelope,whole:transport}};
}
const compiled=compileWholePaperScientificSchemas();

function parserLocator(loc){
  if(loc.kind==='docx')return {kind:'docx',document_id:loc.source_document_id,member_path:loc.member_path,part:loc.part,part_sha256:loc.part_sha256,xml_path:loc.xml_path};
  if(loc.kind==='workbook')return {kind:'workbook',document_id:loc.source_document_id,member_path:loc.member_path,sheet:loc.sheet,range:loc.range};
  return {document_id:loc.source_document_id,page_number:loc.page_index+1,page_status:'known',source_block_id:loc.block_id};
}

function validateEvidence(input,sourceEvidence,add){
  const sources=new Map(sourceEvidence.sources.map(s=>[s.document_id,s])),observations=new Map(),metadata=new Map();
  for(const o of sourceEvidence.office_observations)if(o.locator&&o.mapping_status==='mapped'){
    const key=canonicalizeV3Json(o.locator);if(!observations.has(key)||o.origin==='source_read')observations.set(key,o);
  }
  const find=loc=>loc.kind==='pdf'||!loc.kind?
    sourceEvidence.pdf_run?.blocks.find(b=>same(b.locator,parserLocator(loc)))??sourceEvidence.visual_observations?.find(b=>b.source_sha256===loc.source_hash&&same(b.locator,parserLocator(loc))):observations.get(canonicalizeV3Json(parserLocator(loc)));
  for(const m of input.source_value_metadata){
    const key=wholePaperScientificLocationKey(m.locator),o=find(m.locator),r=o?.record;
    if(metadata.has(key))add('WHOLE_PAPER_METADATA_DUPLICATE','/source_value_metadata');metadata.set(key,m);
    if(!o||!r||m.kind!==m.locator.kind||m.source_document_id!==m.locator.source_document_id||m.locator.block_id!==o.id||m.record_fingerprint!==hash(r)
      ||m.original_type!==(m.kind==='docx'?'docx:text':sources.get(m.source_document_id)?.format==='xls'?'xls:'+r.biff_type:'xlsx:'+r.xml_type)||m.raw_lexical_value!==(m.kind==='docx'?r.text:r.xml_type==='inlineStr'?r.text:r.raw_value??''))add('WHOLE_PAPER_METADATA_MISMATCH','/source_value_metadata');
    if(sources.get(m.source_document_id)?.format==='xls'&&r&&(r.lexical_origin!=='decoded_storage_value'||r.unresolved||r.state!=='value'))add('WHOLE_PAPER_XLS_LITERAL_NOT_QUALIFIED','/source_value_metadata');
  }
  for(const d of input.source_package.source_documents){
    const source=sources.get(d.source_document_id);
    if(!source||source.source_sha256!==d.source_hash||source.kind!==d.kind||source.purpose!==d.purpose||source.role!==(d.role==='main'?'main':'attachment')||source.availability!==(d.included&&d.support_status==='supported'?'available':'missing')
      ||source.critical!==input.source_package.attachments.some(a=>a.source_document_id===d.source_document_id&&a.critical)
      ||(d.kind!=='pdf'||d.member_path!=null)&&(!same(source.container,d.container)||source.member_path!==d.member_path||source.format!==d.format))add('WHOLE_PAPER_SCIENTIFIC_SOURCE_MISMATCH','/source_package/source_documents');
    for(const loc of d.locators){const o=find(loc);if(loc.kind!==d.kind||!o||d.kind!=='pdf'&&loc.block_id!==o.id)add('SOURCE_LOCATOR_MISMATCH','/source_package/source_documents');}
  }
  if(!same([...sources.keys()].sort(),input.source_package.source_documents.map(d=>d.source_document_id).sort()))add('WHOLE_PAPER_SCIENTIFIC_SOURCE_MISMATCH','/source_package');
  for(const b of input.scientific_details.source_blocks){
    const loc=b.native_locator??{kind:'pdf',...b},o=find(loc),key=wholePaperScientificLocationKey(loc);
    const evidences=input.core.evidence.filter(e=>wholePaperScientificLocationKey(e.locator)===key);
    if(!evidences.length)add('SCIENTIFIC_BOUNDARY_MAPPING_UNKNOWN','/core/evidence');
    for(const record of input.scientific_details.records.filter(r=>r.source_block_ids.includes(b.source_block_id)))if(!evidences.some(e=>record.boundary_evidence_ids.includes(e.evidence_id)))add('SCIENTIFIC_BOUNDARY_MAPPING_UNKNOWN','/scientific_details/records');
    if(b.native_locator){
      const m=metadata.get(key);
      if(!o||!m||b.source_document_id!==loc.source_document_id||b.source_hash!==loc.source_hash||b.block_id!==loc.block_id||loc.block_id!==o.id||b.text!==o.text||b.observation_fingerprint!==hash({record:o.record,metadata:m}))add('WHOLE_PAPER_SCIENTIFIC_EVIDENCE_MISMATCH','/scientific_details/source_blocks');
    }else if(!o||b.text!==o.text)add('WHOLE_PAPER_SCIENTIFIC_EVIDENCE_MISMATCH','/scientific_details/source_blocks');
  }
  for(const q of input.scientific_details.quantities)for(const occurrence of q.source_occurrences.filter(o=>o.native_locator)){
    const loc=occurrence.native_locator,o=find(loc),m=metadata.get(wholePaperScientificLocationKey(loc)),r=o?.record;
    if(!o||!r||!m){add('SCIENTIFIC_QUANTITY_CONTEXT_MISMATCH','/scientific_details/quantities');continue;}
    if(loc.kind==='docx'){
      const span=occurrence.value_span;
      if(!span||span.end<=span.start||span.end>o.text.length||o.text.slice(span.start,span.end)!==occurrence.raw_value||occurrence.raw_precision!=='lexical:'+occurrence.raw_value||occurrence.record_fingerprint!==hash(r))add('SCIENTIFIC_QUANTITY_CONTEXT_MISMATCH','/scientific_details/quantities');
    }else{
      // The qualified XLS snapshot has decoded binary storage values, not the
      // author's printed decimal spelling. Keep literal reading available, but
      // do not certify a quantity's claimed lexical precision from that projection.
      if(sources.get(loc.source_document_id)?.format==='xls'&&r.biff_type==='number'&&r.lexical_origin==='decoded_storage_value')add('WHOLE_PAPER_XLS_PRINTED_PRECISION_UNVERIFIED','/scientific_details/quantities');
      if(r.state!=='value'&&r.state!=='formula_cached'||r.unresolved||r.formula?.present&&(!r.cache?.element_present||!r.formula.text))add('WHOLE_PAPER_REQUIRED_VALUE_INVALID','/scientific_details/quantities');
      if(occurrence.value_cell.row!==r.row||occurrence.value_cell.column!==r.column||occurrence.raw_value!==r.text||occurrence.raw_precision!=='lexical:'+m.raw_lexical_value||occurrence.cell_fingerprint!==hash({record:r,metadata:m}))add('SCIENTIFIC_QUANTITY_CONTEXT_MISMATCH','/scientific_details/quantities');
    }
  }
}

export function validateWholePaperScientificInput(candidate){
  const errors=[],add=(code,path)=>errors.push({code,path,message:code});
  const result=()=>({ok:!errors.length,status:errors.length?'invalid_preparation':'preparation_validated',errors:errors.sort((a,b)=>a.code.localeCompare(b.code)||a.path.localeCompare(b.path)),warnings:[],publishable:false,...(!errors.length?{input_fingerprint:candidate.input_fingerprint,scientific_completeness:candidate.scientific_details.source_status.completeness}:{})});
  try{fingerprintV3Json(candidate);}catch{add('SCIENTIFIC_INPUT_STRUCTURE_INVALID','/');return result();}
  checkV3StorageSafety(candidate,'/',add,contract);if(errors.length)return result();
  if(!compiled.shape(candidate)){add('SCIENTIFIC_INPUT_STRUCTURE_INVALID','/');return result();}
  const runCheck=validateWholePaperRun(candidate.source_run);for(const code of runCheck.errors)add(code,'/source_run');
  if(candidate.source_run.side!=='candidate')add('WHOLE_PAPER_SCIENTIFIC_SOURCE_MISMATCH','/source_run');
  if(!runCheck.ok)return result();
  if(candidate.identity.paper_id!==candidate.source_package.paper_id)add('SCIENTIFIC_IDENTITY_MISMATCH','/identity');
  for(const k of ['core','reading_card'])if(candidate[k].paper_id!==candidate.identity.paper_id||candidate[k].analysis_revision!==candidate.identity.analysis_revision)add('IDENTITY_MISMATCH','/'+k);
  validateSourceCoreReferences(candidate,add,contract);validateEvidence(candidate,candidate.source_run,add);validateScientificContent(candidate.scientific_details,candidate,add,contract);
  const {input_fingerprint,...content}=candidate;if(input_fingerprint!==hash(content))add('SCIENTIFIC_INPUT_BINDING_STALE','/input_fingerprint');
  return result();
}

function validateParserDisposition(input,add){
  const disposition=input.parser_evaluation_disposition,bundle=input.source_evidence_bundle;
  const scope=bundle.provenance.approval_binding.source_scope_fingerprint;
  if(disposition.source_scope_fingerprint!==scope)add('SOURCE_EVIDENCE_DISPOSITION_SCOPE_MISMATCH','/parser_evaluation_disposition');
  const refs=new Set();
  for(const record of disposition.evidence_records){
    try{
      if(refs.has(record.record_ref)||record.record_ref.startsWith('/')||/[\\:]/.test(record.record_ref)||record.record_ref.split('/').some(p=>!p||p==='.'||p==='..'))throw Error();refs.add(record.record_ref);
      const bytes=Buffer.from(record.bytes_base64,'base64');
      if(bytes.toString('base64')!==record.bytes_base64||'sha256:'+createHash('sha256').update(bytes).digest('hex')!==record.sha256)throw Error();
      const actual=JSON.parse(bytes.toString('utf8'));
      if(record.kind==='admission'?(disposition.comparison_status!=='not_run'||actual.comparison_status!=='not_run'):(disposition.comparison_status==='not_run'||actual.status!==disposition.comparison_status))throw Error();
      if(actual.source_scope_fingerprint!==undefined&&actual.source_scope_fingerprint!==scope)throw Error();
      const sorted=values=>[...values].sort((a,b)=>a.document_id.localeCompare(b.document_id));
      if(actual.source_document_map!==undefined&&!same(sorted(actual.source_document_map),sorted(bundle.sources)))throw Error();
      if(actual.required_coverage!==undefined&&!same(sorted(actual.required_coverage),sorted(bundle.required_coverage)))throw Error();
    }catch{add('SOURCE_EVIDENCE_DISPOSITION_RECORD_INVALID','/parser_evaluation_disposition/evidence_records');}
  }
}

/** New exact envelope, same typed scientific rules; no stand-in parser run is constructed. */
export function validateSourceEvidenceScientificInput(candidate){
  const errors=[],add=(code,path)=>errors.push({code,path,message:code});
  const result=()=>({ok:!errors.length,status:errors.length?'invalid_preparation':'preparation_validated',errors:errors.sort((a,b)=>a.code.localeCompare(b.code)||a.path.localeCompare(b.path)),warnings:[],publishable:false,...(!errors.length?{input_fingerprint:candidate.input_fingerprint,scientific_completeness:candidate.scientific_details.source_status.completeness}:{})});
  try{hash(candidate);}catch{add('SCIENTIFIC_INPUT_STRUCTURE_INVALID','/');return result();}
  if(!compiled.sourceEvidenceShape(candidate)){add('SCIENTIFIC_INPUT_STRUCTURE_INVALID','/');return result();}
  const bundle=candidate.source_evidence_bundle,checked=buildSourceEvidenceVisibleView({bundle});
  for(const code of checked.errors)add(code,'/source_evidence_bundle');if(!checked.ok)return result();
  // Only the separately byte-checked archive takes the local-storage path. All SCI fields remain visible-data checks.
  const scan=(value,path,field='')=>{
    if(typeof value==='string'){checkSourceEvidenceTextSafety(value,path,add,field);return;}
    if(!value||typeof value!=='object')return;
    for(const [key,child]of Object.entries(value)){
      const next=path+'/'+(Array.isArray(value)?key:'[field]');checkV3StorageSafety(key,next,add);
      scan(child,next,Array.isArray(value)?field:key);
    }
  };
  for(const [key,value]of Object.entries(candidate))if(key!=='source_evidence_bundle')scan(value,'/scientific_content',key);
  if(errors.length)return result();
  if(bundle.source_coverage.some(c=>!['read','catalogue_only'].includes(c.status))||bundle.source_limits.some(l=>['source_unread','coverage_incomplete'].includes(l.kind)))add('SOURCE_EVIDENCE_REQUIRED_SOURCE_UNREAD','/source_evidence_bundle');
  if(candidate.identity.paper_id!==candidate.source_package.paper_id)add('SCIENTIFIC_IDENTITY_MISMATCH','/identity');
  for(const k of ['core','reading_card'])if(candidate[k].paper_id!==candidate.identity.paper_id||candidate[k].analysis_revision!==candidate.identity.analysis_revision)add('IDENTITY_MISMATCH','/'+k);
  validateSourceCoreReferences(candidate,add,contract);validateEvidence(candidate,bundle,add);validateScientificContent(candidate.scientific_details,candidate,add,contract);
  const recordIds=new Set(candidate.scientific_details.records.map(r=>r.semantic_unit_id));
  if(candidate.scientific_details.inventory.some(i=>i.status==='missing'&&i.affected_ids.some(id=>!recordIds.has(id))))add('SCIENTIFIC_EVIDENCE_INVENTORY_TARGET_INVALID','/scientific_details/inventory');
  validateParserDisposition(candidate,add);
  const {input_fingerprint,...content}=candidate;if(input_fingerprint!==hash(content))add('SCIENTIFIC_INPUT_BINDING_STALE','/input_fingerprint');
  return result();
}

/** A constrained record-based qualification, not certification of scientific truth or receipt ownership. */
export function evaluateScientificEvidenceQualification({scientificInput,sourceCheckContent,sourceCheckReceiptSha256}={}){
  const errors=[],reject=code=>errors.push(code),blocked=()=>({ok:false,status:'blocked',errors:[...new Set(errors)].sort(),qualification:null,qualification_fingerprint:null});
  try{
    const checked=validateSourceEvidenceScientificInput(scientificInput);
    if(!checked.ok){for(const e of checked.errors)reject(e.code);return blocked();}
    const review=sourceCheckContent?.scientific_evidence_review;hash(review);
    if(!compiled.reviewShape(review)||!/^sha256:[a-f0-9]{64}$/.test(sourceCheckReceiptSha256??'')){reject('SCIENTIFIC_EVIDENCE_REVIEW_STRUCTURE_INVALID');return blocked();}
    const details=scientificInput.scientific_details,bundle=scientificInput.source_evidence_bundle;
    if(review.scientific_input_fingerprint!==scientificInput.input_fingerprint||review.source_bundle_fingerprint!==bundle.bundle_fingerprint)reject('SCIENTIFIC_EVIDENCE_REVIEW_BINDING_STALE');
    const equalIds=(a,b)=>a.length===b.length&&new Set(a).size===a.length&&same([...a].sort(),[...b].sort());
    const rows=(actual,key,expected)=>{if(!equalIds(actual.map(r=>r[key]),expected))reject('SCIENTIFIC_EVIDENCE_REVIEW_COVERAGE_INCOMPLETE');return new Map(actual.map(r=>[r[key],r]));};
    const obligations=rows(review.obligation_reviews,'semantic_unit_id',details.records.map(r=>r.semantic_unit_id));
    const claims=rows(review.claim_reviews,'claim_id',details.claims.map(c=>c.claim_id));
    const quantities=rows(review.quantity_reviews,'quantity_id',details.quantities.map(q=>q.quantity_id));
    const gaps=rows(review.gap_dispositions,'gap_id',[...bundle.source_limits.map(l=>l.limit_id),...details.inventory.filter(i=>i.status==='missing').map(i=>i.inventory_id)]);
    for(const record of details.records){const r=obligations.get(record.semantic_unit_id);if(!r)continue;
      if(!equalIds(r.source_block_ids,record.source_block_ids)||!r.reason.trim()||record.status!=='assessed'&&r.verdict==='supported')reject('SCIENTIFIC_EVIDENCE_OBLIGATION_REVIEW_MISMATCH');
      if(r.verdict==='blocked')reject('SCIENTIFIC_EVIDENCE_USE_BLOCKED');
    }
    for(const claim of details.claims){const r=claims.get(claim.claim_id);if(!r)continue;
      if(!equalIds(r.record_ids,claim.record_ids)||!equalIds(r.source_block_ids,claim.source_block_ids)||r.allowed_conclusion!==claim.allowed_conclusion||r.forbidden_stronger_interpretation!==claim.forbidden_stronger_interpretation||!r.reason.trim())reject('SCIENTIFIC_EVIDENCE_CLAIM_REVIEW_MISMATCH');
      if(r.verdict==='blocked')reject('SCIENTIFIC_EVIDENCE_USE_BLOCKED');
    }
    for(const quantity of details.quantities){const r=quantities.get(quantity.quantity_id);if(!r)continue;
      if(r.source_occurrences_fingerprint!==hash(quantity.source_occurrences)||!r.reason.trim())reject('SCIENTIFIC_EVIDENCE_QUANTITY_REVIEW_MISMATCH');
      if(r.verdict==='blocked'||!Object.values(r.context_checks).every(v=>v===true))reject('SCIENTIFIC_EVIDENCE_USE_BLOCKED');
    }
    const recordIds=new Set(details.records.map(r=>r.semantic_unit_id)),claimIds=new Set(details.claims.map(c=>c.claim_id)),quantityIds=new Set(details.quantities.map(q=>q.quantity_id));
    for(const gap of review.gap_dispositions){
      const original=gap.origin==='source_limit'?bundle.source_limits.find(l=>l.limit_id===gap.gap_id):details.inventory.find(i=>i.status==='missing'&&i.inventory_id===gap.gap_id);
      if(!original||!gap.reason.trim()||gap.record_ids.some(id=>!recordIds.has(id))||gap.claim_ids.some(id=>!claimIds.has(id))||gap.quantity_ids.some(id=>!quantityIds.has(id)))reject('SCIENTIFIC_EVIDENCE_GAP_DISPOSITION_INVALID');
      if(gap.origin==='source_limit'&&original?.kind==='visibility_withheld'&&!gap.record_ids.length&&!gap.claim_ids.length&&!gap.quantity_ids.length)reject('SCIENTIFIC_EVIDENCE_GAP_DISPOSITION_INVALID');
      if(gap.origin==='inventory'&&original?.affected_ids.some(id=>!recordIds.has(id)||!gap.record_ids.includes(id)))reject('SCIENTIFIC_EVIDENCE_GAP_DISPOSITION_INVALID');
      if(gap.disposition==='blocks_use')reject('SCIENTIFIC_EVIDENCE_USE_BLOCKED');
    }
    if(errors.length)return blocked();
    const qualification={schema_version:'phase21-scientific-evidence-qualification-1.0',status:'qualified',scientific_input_fingerprint:scientificInput.input_fingerprint,source_bundle_fingerprint:bundle.bundle_fingerprint,source_check_receipt_sha256:sourceCheckReceiptSha256,review_fingerprint:hash(review),parser_evaluation_disposition_fingerprint:hash(scientificInput.parser_evaluation_disposition),parser_evaluation_requirement_satisfied:false,scientific_completeness:details.source_status.completeness,bounded_limits:{source_limits:structuredClone(bundle.source_limits),gap_dispositions:structuredClone([...gaps.values()])}};
    qualification.qualification_fingerprint=hash(qualification);
    if(!compiled.qualificationShape(qualification)){reject('SCIENTIFIC_EVIDENCE_QUALIFICATION_STRUCTURE_INVALID');return blocked();}
    return {ok:true,status:'qualified',errors:[],qualification,qualification_fingerprint:qualification.qualification_fingerprint};
  }catch{reject('SCIENTIFIC_EVIDENCE_REVIEW_STRUCTURE_INVALID');return blocked();}
}
