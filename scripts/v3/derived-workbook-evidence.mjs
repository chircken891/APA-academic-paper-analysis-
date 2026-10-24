import {createHash} from 'node:crypto';
import {isDeepStrictEqual as same} from 'node:util';
import {readFile} from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import {fingerprintV3Json as hash,checkSourceEvidenceTextSafety} from './semantic-package-validator.mjs';

const schema=JSON.parse(await readFile(new URL('../../Schema/phase21/derived-workbook.schema.json',import.meta.url),'utf8'));
const shape=new Ajv2020({strict:false,allErrors:true}).compile(schema);
export const DERIVED_WORKBOOK_PROFILE='paper04-qualified-s6-xls-xlsx-1';
const SOURCE='sha256:7df8417a98bfc5d060c04432ddb06561bc34eee1ce3115e0d1b7ce2a7763868d';
const ARCHIVE='sha256:b7c22828ae59931591a400bbfdc0344043f728b2b33d322d639e09d35ee06e42';
// A bounded registry of observed qualification artifacts, not a caller-provided
// "trusted" flag or a general XLS decoder. Changing an artifact requires a new
// qualified profile. Scientific conclusions and platform authentication are absent.
const QUALIFIED=Object.freeze({
  original_snapshot:'d17e64fe9ea4d58313f8a6f5e44450c966930524fc81a5cbbd4218ff2c82640e',
  derived_xlsx:'1ece3f39418492d2911b9cb46f6b5103a494a9153c254f6dbfd24e555be9b5ec',
  parser_output:'ef2177411db1eeb9b058649f9dadc30f7c062215d6d7e9c6190a059fc91564dc',
  parser_observation:'484575abd613e70d287b4b0ab54ffdf2a2dbcca450d96a0c8ef20a9e9ea987a6',
  conversion:'6b8f1b98d0cbaac95470c4f783269bca3f67c7d148a19208a53ad7f07dabef74',
  conversion_guards:'7fe38507129590e70cf34cd3802ba0ce7df56e7cbd274928056a223cd59a49af',
  fidelity:'ab260a628bdee97f6df6ba277df3c0fc2f24ae0622153fba7b65b44802745dfd',
  mapping:'b66a121ad63fd82bb7218b61b8fade7dd30d8a1fbb64fa7025e289e3388fea7d',
  run_history:'5062f35f53cc141e2ea396413ad6303845c8f6917c0a73626f6c3e6527d8e6c1',
});
const sha=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
const copy=structuredClone;
const fail=code=>{throw Error(code);};
const resultError=e=>({ok:false,evidence:null,observations:[],errors:[/^DERIVED_WORKBOOK_[A-Z_]+$/.test(e.message)?e.message:'DERIVED_WORKBOOK_INPUT_INVALID']});
const bytes=b=>b instanceof Uint8Array?Buffer.from(b):fail('DERIVED_WORKBOOK_BYTES_REQUIRED');
const exact=(o,keys)=>o&&same(Object.keys(o).sort(),[...keys].sort());
const decode=b=>JSON.parse(b.toString('utf8').replace(/^\uFEFF/,''));
const xy=s=>{const m=/^([A-Z]+)([1-9][0-9]*)$/.exec(s);let c=0;for(const ch of m[1])c=c*26+ch.charCodeAt(0)-64;return {row:+m[2],column:c};};
const merged=(r,range)=>{const [a,b]=range.split(':').map(xy);return r.row>=a.row&&r.row<=b.row&&r.column>=a.column&&r.column<=b.column;};
function sourceIdentity(source,sourceBytes){
  if(!source||source.kind!=='workbook'||source.format!=='xls'||source.source_sha256!==SOURCE||sha(bytes(sourceBytes))!==SOURCE
    ||source.member_path!=='nature11412-s2/Supplementary Table 6.xls'||source.container?.source_sha256!==ARCHIVE)fail('DERIVED_WORKBOOK_ORIGINAL_IDENTITY_MISMATCH');
}
function proofBytes(artifacts){
  if(!exact(artifacts,Object.keys(QUALIFIED)))fail('DERIVED_WORKBOOK_PROOF_SET_MISMATCH');
  return Object.fromEntries(Object.entries(QUALIFIED).map(([role,h])=>{
    const a=artifacts[role];if(!exact(a,['sha256','bytes_base64'])||typeof a.bytes_base64!=='string'||a.bytes_base64.length>4*1024*1024)fail('DERIVED_WORKBOOK_PROOF_INVALID');
    const b=Buffer.from(a.bytes_base64,'base64');
    if(b.toString('base64')!==a.bytes_base64||a.sha256!=='sha256:'+h||sha(b)!==a.sha256)fail('DERIVED_WORKBOOK_QUALIFICATION_BINDING_MISMATCH');
    return [role,b];
  }));
}
function locator(source,r){return {kind:'workbook',document_id:source.document_id,member_path:source.member_path,sheet:{index:r.sheet.index,name:r.sheet.name},range:{start_row:r.row,start_column:r.column,end_row:r.row,end_column:r.column}};}
function observations(source,evidence){const evidenceHash=hash(evidence);return evidence.records.map(r=>({id:source.document_id+'#source#'+r.id,document_id:source.document_id,kind:'workbook_cell',origin:'source_read',locator:locator(source,r),parser_locator:null,mapping_status:'mapped',text:r.text,record:copy(r),binding:{source_sha256:SOURCE,evidence_fingerprint:evidenceHash,record_fingerprint:hash(r),parts_fingerprint:hash([])}}));}

/** Supplies bytes only. No input-driven filesystem access or backend execution. */
export function buildDerivedWorkbookEvidence({source,sourceBytes,artifacts}={}){
  try{
    hash({source,artifacts});sourceIdentity(source,sourceBytes);const proof=proofBytes(artifacts);
    const snap=decode(proof.original_snapshot),fid=decode(proof.fidelity),map=decode(proof.mapping),conversion=decode(proof.conversion),guards=decode(proof.conversion_guards),observation=decode(proof.parser_observation),history=decode(proof.run_history);
    if(snap.source_sha256!==SOURCE||snap.records.length!==1180||snap.records.filter(r=>['text','number'].includes(r.storage_type)).length!==684
      ||fid.issues.length!==54||fid.checks.filter(c=>c.pass).length!==15||fid.checks.filter(c=>!c.pass).length!==1
      ||map.value_differences.length||map.unmapped_nonempty.length||map.original_blank_positions_outside_html.length!==190
      ||conversion.source_sha256!==SOURCE||conversion.derived_sha256!==artifacts.derived_xlsx.sha256||conversion.save_as_calls!==1||conversion.source_saved
      ||!guards.macros_disabled||!guards.automatic_links_disabled||!guards.source_readonly||guards.calculate_before_save
      ||history.application_setup_attempts!==2||history.successful_conversions!==1||history.mineru_calls!==1||history.content_requests!==0||!history.budget_closed
      ||observation.parser_version!=='3.4.5'||!observation.output_inventory.some(i=>i.path.endsWith('/input_origin.xlsx')&&i.sha256===artifacts.derived_xlsx.sha256)
    )fail('DERIVED_WORKBOOK_QUALIFICATION_INCONSISTENT');
    const records=snap.records.filter(r=>r.storage_type!=='unserialized').map(r=>({id:'xls/Sheet1#'+r.address,kind:'workbook_cell',physical_page:null,evidence_origin:'source_only',sheet:{...snap.sheet,sheet_id:'0'},address:r.address,row:r.row,column:r.column,state:r.storage_type==='formatted_blank'?'format_only':'value',biff_type:r.storage_type,raw_value:r.decoded_lexical_value,text:r.storage_type==='text'?r.value:r.decoded_lexical_value,value:r.value,lexical_origin:'decoded_storage_value',serialized:true,merges:snap.merged_ranges.filter(m=>merged(r,m)),formula:{present:false,text:null,attributes:{}},cache:{element_present:false,raw_value:null},unresolved:false,number_format:r.number_format,number_format_interpretation:'not_rendered'}));
    const evidence={schema_version:'phase21-derived-workbook-evidence-1.0',profile:DERIVED_WORKBOOK_PROFILE,format:'xls',source:{sha256:SOURCE,byte_length:bytes(sourceBytes).length},source_binding:copy(source),proof:copy(artifacts),scope:{profile:DERIVED_WORKBOOK_PROFILE,format:'xls',parts:[],sheets:[{index:0,name:snap.sheet.name,range:snap.range}]},parts:[],records,coverage:{complete_selected_parts:true,sheets:[{index:0,name:snap.sheet.name,range:snap.range,serialized_cells:records.length,merged_ranges:copy(snap.merged_ranges),unserialized_not_assumed_blank:true}],uninterpreted_parts:[]},derivation:{profile:DERIVED_WORKBOOK_PROFILE,original_sha256:SOURCE,derived_sha256:artifacts.derived_xlsx.sha256,parser_output_sha256:artifacts.parser_output.sha256,parser_run_id:observation.run_id,parser_version:'3.4.5',backend:'mineru',source_truth:'original_xls',value_matches:684,merged_range_matches:17,anchor_matches:10,transport_status:'verified_with_record_differences',fidelity_passed:15,fidelity_failed:1,format_blank_omissions:copy(fid.issues),html_omitted_blank_positions:copy(map.original_blank_positions_outside_html),unserialized_original_positions:snap.records.filter(r=>r.storage_type==='unserialized').map(r=>r.address),original_format_lossless:'not_established',printed_precision:'not_established',unevaluated:copy(fid.limits),independent_backend:false,scientific_eligible:false}};
    if(!shape(evidence))fail('DERIVED_WORKBOOK_STRUCTURE_INVALID');
    return {ok:true,evidence,observations:observations(source,evidence),errors:[]};
  }catch(e){return resultError(e);}
}
export function validateDerivedWorkbookEvidence({source,sourceBytes,evidence}={}){
  try{
    hash(evidence);if(!shape(evidence))fail('DERIVED_WORKBOOK_STRUCTURE_INVALID');
    const rebuilt=buildDerivedWorkbookEvidence({source,sourceBytes,artifacts:evidence.proof});
    if(!rebuilt.ok)return rebuilt;if(!same(rebuilt.evidence,evidence))fail('DERIVED_WORKBOOK_REPLAY_MISMATCH');return rebuilt;
  }catch(e){return resultError(e);}
}
export function validateDerivedWorkbookCoverage(evidence,required){
  return same(required?.sheets,[{index:0,name:'Sheet 1',range:{start_row:1,start_column:1,end_row:59,end_column:20}}])&&required.scope_complete===true;
}
const htmlDecode=s=>s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(_,x)=>x[0]==='#'?String.fromCodePoint(x[1].toLowerCase()==='x'?parseInt(x.slice(2),16):Number(x.slice(1))):({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:'\u00a0'})[x.toLowerCase()]);
/** Map only the qualified, byte-identical saved HTML. No source-value fill-in. */
export function deriveWorkbookParserObservations({source,sourceBytes,evidence,parserOutputBytes,parserBinding}={}){
  try{
    const checked=validateDerivedWorkbookEvidence({source,sourceBytes,evidence});if(!checked.ok)return checked;
    const d=evidence.derivation;
    if(sha(bytes(parserOutputBytes))!==d.parser_output_sha256||parserBinding?.sha256!==d.parser_output_sha256||parserBinding.run_id!==d.parser_run_id||parserBinding.backend!=='mineru'||parserBinding.backend_version!=='3.4.5')fail('DERIVED_WORKBOOK_PARSER_BINDING_MISMATCH');
    const entries=decode(bytes(parserOutputBytes)),map=decode(Buffer.from(evidence.proof.mapping.bytes_base64,'base64'));
    const rows=[...entries[0].table_body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(m=>[...m[1].matchAll(/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)].map(c=>htmlDecode(c[1].replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]*>/g,''))));
    const byAddress=new Map(map.cell_mapping.map(m=>[m.source_address,m]));
    const evidenceHash=hash(evidence);
    const out=evidence.records.filter(r=>r.state==='value').map(r=>{
      const m=byAddress.get(r.address),text=rows[m?.html_row-1]?.[m?.html_cell-1];
      if(typeof text!=='string'||r.biff_type==='text'&&text!==r.value||r.biff_type==='number'&&Number(text)!==r.value)fail('DERIVED_WORKBOOK_VALUE_MAPPING_MISMATCH');
      const record={...copy(r),text,raw_value:text,value:r.biff_type==='number'?Number(text):text};
      return {id:source.document_id+'#derived#'+r.address,document_id:source.document_id,kind:'workbook_cell',origin:'derived_source_mapping',locator:locator(source,r),parser_locator:{json_pointer:'/0/table_body',html_path:`/table[1]/tr[${m.html_row}]/td[${m.html_cell}]`,table_index:1,text_index:null},mapping_status:'mapped',text,record,binding:{...copy(parserBinding),source_sha256:SOURCE,derived_sha256:d.derived_sha256,mapping_evidence:evidenceHash,source_context_only_fields:['sheet','biff_type','formula','cache','number_format'],formula_observed:false}};
    });
    return {ok:true,observations:out,errors:[]};
  }catch(e){return resultError(e);}
}
/** Source text is scanned, never exempted as raw XML or encoded binary. */
export function derivedWorkbookVisibility({source,sourceBytes,evidence}={}){
  const checked=validateDerivedWorkbookEvidence({source,sourceBytes,evidence});if(!checked.ok)return checked;
  const errors=[];for(const r of evidence.records){checkSourceEvidenceTextSafety(r.text??'','/text',code=>errors.push(code),'text');checkSourceEvidenceTextSafety(r.number_format??'','/number_format',code=>errors.push(code),'text');}
  return {ok:true,parts:[],transformations:[],visibility_errors:[...new Set(errors)],errors:[]};
}
