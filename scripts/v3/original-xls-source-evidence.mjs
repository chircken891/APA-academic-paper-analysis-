import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {isDeepStrictEqual as same} from 'node:util';
import {readFile} from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import {fingerprintV3Json as hash,checkSourceEvidenceTextSafety} from './semantic-package-validator.mjs';

export const ORIGINAL_XLS_PROFILE='paper04-three-original-xls-source-only-1';
const sha=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
const ARCHIVE='sha256:b7c22828ae59931591a400bbfdc0344043f728b2b33d322d639e09d35ee06e42';
const REPORT='sha256:5db75f1f213748b1e988eb35883660be8db2c45c75c1bb2ead4400353f00c3f0';
const READER='sha256:9eb11376d1d5ae38055886f5b385d76334f3ddf28304ca4dffd95501b5b21c67';
// Registry entries bind the observed source-only qualification bytes. No caller
// flag, derivative, parser eligibility or scientific qualification is admitted.
const MEMBERS=Object.freeze([
  {source:'sha256:28339171e3cbd8430dceb2567da65c862a73d48172a4e725496ae1ac9419d211',member:'nature11412-s2/Supplementary Tables 1-4.xls',snapshot:'sha256:84cab8c356445de04638791538b0f4a0aced7219c6178dd303fc551a261c3618',compressed:'sha256:25aec1eac673f235bf19d51195edb87519d56bd6740fa872de7cd756df07745c',snapshot_bytes:20355109},
  {source:'sha256:17c1fac228f6b65f27e7fc4b397b23b7aad2d4bed1d34431caa8a413606b8418',member:'nature11412-s2/Supplementary Table 5 revised.xls',snapshot:'sha256:fdd1e60f02841774809f41652fcc52df6b5fc08f773d12b79e7a77c3bd3a89bb',compressed:'sha256:f9552b386fb5170c8e0b456e3027f78199a509a6b5da64d226d405648efffe76',snapshot_bytes:52991391},
  {source:'sha256:73800de48b868a11659c0eea96eac182a403e4d79dedb7d51f14e29f7029b092',member:'nature11412-s2/Supplementary Tables 7-8.xls',snapshot:'sha256:36634a40ebe5e1f97e0b13997d8f743a720187af8e2ba05ce2666a560555435d',compressed:'sha256:e928b37060051638e452c82f62563fb19ab7ece6665111e233cb2ec230105fbe',snapshot_bytes:61805496},
]);
const schema=JSON.parse(await readFile(new URL('../../Schema/phase21/original-xls-source-evidence.schema.json',import.meta.url),'utf8'));
const shape=new Ajv2020({strict:false,allErrors:true}).compile(schema);
const fail=code=>{throw Error('SOURCE_EVIDENCE_ORIGINAL_XLS_'+code);};
const exact=(o,keys)=>o&&same(Object.keys(o).sort(),[...keys].sort());
const bytes=b=>b instanceof Uint8Array?Buffer.from(b):fail('BYTES_REQUIRED');
const error=e=>({ok:false,evidence:null,observations:[],errors:[/^SOURCE_EVIDENCE_ORIGINAL_XLS_[A-Z_]+$/.test(e.message)?e.message:'SOURCE_EVIDENCE_ORIGINAL_XLS_INPUT_INVALID']});
const column=n=>{let s='';for(;n;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s;};
const range=s=>s.empty_sheet?null:'A1:'+column(Math.max(1,s.columns))+Math.max(1,s.rows);
const merge=m=>column(m.start_column)+m.start_row+':'+column(m.end_column)+m.end_row;
function proofBytes(proof,member){
  const pins={original_snapshot:member.compressed,qualification_report:REPORT,reader_code:READER,raw_record_validation:'sha256:e5d6c631de3ecb645e670ca45fd262bb8d0eb9d9590a1aef326cd27187f305e8'};
  if(!exact(proof,Object.keys(pins)))fail('PROOF_SET_MISMATCH');
  return Object.fromEntries(Object.entries(pins).map(([key,pin])=>{
    const item=proof[key],snapshot=key==='original_snapshot';
    if(!exact(item,snapshot?['sha256','decoded_sha256','encoding','bytes_base64']:['sha256','bytes_base64'])||typeof item.bytes_base64!=='string'||item.bytes_base64.length>(snapshot?16:4)*1024*1024||snapshot&&(item.encoding!=='gzip'||item.decoded_sha256!==member.snapshot))fail('PROOF_INVALID');
    const b=Buffer.from(item.bytes_base64,'base64');
    if(item.sha256!==pin||b.toString('base64')!==item.bytes_base64||sha(b)!==pin)fail('QUALIFICATION_BINDING_MISMATCH');
    if(snapshot){
      let decoded;try{decoded=gunzipSync(b,{maxOutputLength:member.snapshot_bytes});}catch{fail('DECOMPRESSION_INVALID');}
      if(decoded.length!==member.snapshot_bytes||sha(decoded)!==member.snapshot)fail('DECODED_SNAPSHOT_MISMATCH');
      return [key,decoded];
    }
    return [key,b];
  }));
}
function observations(source,e){
  const evidence_fingerprint=hash(e),parts_fingerprint=hash([]);
  return e.records.map(r=>({id:source.document_id+'#source#'+r.id,document_id:source.document_id,kind:'workbook_cell',origin:'source_read',locator:{kind:'workbook',document_id:source.document_id,member_path:source.member_path,sheet:{index:r.sheet.index,name:r.sheet.name},range:{start_row:r.row,start_column:r.column,end_row:r.row,end_column:r.column}},parser_locator:null,mapping_status:'mapped',text:r.text,record:structuredClone(r),binding:{source_sha256:source.source_sha256,evidence_fingerprint,record_fingerprint:hash(r),parts_fingerprint}}));
}
export function buildOriginalXlsSourceEvidence({source,sourceBytes,artifacts}={}){
  try{
    const member=MEMBERS.find(m=>m.source===source?.source_sha256);
    if(!member||source.format!=='xls'||source.kind!=='workbook'||source.member_path!==member.member||source.container?.source_sha256!==ARCHIVE||sha(bytes(sourceBytes))!==member.source)fail('SOURCE_IDENTITY_MISMATCH');
    const proof=proofBytes(artifacts,member),snapshot=JSON.parse(proof.original_snapshot),report=JSON.parse(proof.qualification_report);
    const qualified=report.validation.members.find(m=>m.document_id===source.document_id);
    if(snapshot.source.document_id!==source.document_id||snapshot.source.sha256!==member.source||snapshot.source.bytes!==sourceBytes.length||snapshot.source.member_path!==member.member||snapshot.source.container.sha256!==ARCHIVE
      ||report.validation.all_source_sheets!==17||report.validation.formula_records!==0||report.validation.materialized_record_cells!==212728||report.producer.sha256!==READER||!qualified||qualified.sheets.length!==snapshot.sheets.length)fail('QUALIFICATION_INCONSISTENT');
    const records=[],sheets=[];
    for(const s of snapshot.sheets){
      const q=qualified.sheets.find(v=>v.index===s.index),headers=new Map(s.record_headers.map(h=>[h.offset,h]));
      if(!q||q.name!==s.name||q.rows!==s.rows||q.columns!==s.columns||q.cells!==s.cells.length||q.records!==s.record_headers.length||q.unmaterialized!==s.unmaterialized_positions||s.formula_record_count!==0||s.duplicate_record_positions.length||s.reader_only_positions.length
        ||!s.worksheet_eof_observed||s.record_headers[0].offset!==s.sheet_bof_offset||s.record_headers.at(-1).offset!==s.sheet_eof_offset||s.record_headers.at(-1).code!==10||headers.size!==s.record_headers.length)fail('COVERAGE_INVALID');
      let next=s.sheet_bof_offset;
      for(const h of s.record_headers){if(h.offset!==next||h.length<4)fail('RECORD_CHAIN_INVALID');next+=h.length;}
      if(next-s.sheet_bof_offset!==s.scanned_bytes)fail('RECORD_CHAIN_INVALID');
      const positions=new Set();let absent=0;
      for(const missing of s.unmaterialized_ranges){if(missing.row<1||missing.row>s.rows||missing.start_column<1||missing.end_column>s.columns||missing.start_column>missing.end_column)fail('COVERAGE_INVALID');absent+=missing.end_column-missing.start_column+1;}
      for(const c of s.cells){
        const h=headers.get(c.record_offset);
        if(!h||h.code!==c.record_code||h.name!==c.record_kind||c.formula.present||!Object.values(c.crosscheck).every(v=>v===true)||c.row<1||c.row>s.rows||c.column<1||c.column>s.columns||c.address!==column(c.column)+c.row||positions.has(c.address))fail('CELL_INVALID');
        positions.add(c.address);
        const merges=s.merged_ranges.filter(m=>c.row>=m.start_row&&c.row<=m.end_row&&c.column>=m.start_column&&c.column<=m.end_column).map(merge);
        records.push({id:'xls/sheet-'+s.index+'#'+c.address,kind:'workbook_cell',physical_page:null,evidence_origin:'source_only',sheet:{index:s.index,name:s.name,sheet_id:String(s.index),visibility:s.visibility===0?'visible':s.visibility===1?'hidden':'veryHidden'},address:c.address,row:c.row,column:c.column,state:c.record_storage_type==='formatted_blank'?'format_only':c.record_storage_type==='error'?'error':'value',biff_type:c.record_storage_type,reader_cell_type:c.ctype_name,raw_value:c.decoded_lexical_value,text:c.decoded_lexical_value,value:c.decoded_value,lexical_origin:c.lexical_origin,serialized:true,merges,formula:{present:false,text:null,attributes:{}},cache:{element_present:false,raw_value:null},unresolved:false,number_format:c.number_format,number_format_interpretation:'not_rendered',biff_record:{offset:c.record_offset,code:c.record_code,expanded_index:c.expanded_index,sha256:h.sha256,xf_index:c.xf_index}});
      }
      if(absent!==s.unmaterialized_positions||positions.size!==s.materialized_positions||positions.size+absent!==s.rows*s.columns)fail('COVERAGE_INVALID');
      sheets.push({index:s.index,name:s.name,range:range(s),serialized_cells:s.cells.length,merged_ranges:s.merged_ranges.map(merge),unserialized_not_assumed_blank:true});
    }
    const evidence={schema_version:'phase21-original-xls-source-evidence-1.0',profile:ORIGINAL_XLS_PROFILE,format:'xls',source:{sha256:member.source,byte_length:sourceBytes.length},source_binding:structuredClone(source),proof:structuredClone(artifacts),scope:{profile:ORIGINAL_XLS_PROFILE,format:'xls',parts:[],sheets:sheets.map(({index,name,range})=>({index,name,range}))},parts:[],records,coverage:{complete_selected_parts:true,sheets:sheets.filter(s=>s.range!==null),empty_sheets:snapshot.sheets.filter(s=>s.empty_sheet).map(s=>({index:s.index,name:s.name,rows:0,columns:0,worksheet_eof_observed:true,materialized_cells:0})),uninterpreted_parts:[]},source_only_scope:{source_truth:'original_xls',scientific_eligible:false,parser_eligible:false,printed_precision:'not_established',formula_records:0,unmaterialized_positions:snapshot.sheets.reduce((n,s)=>n+s.unmaterialized_positions,0),unmaterialized_ranges:snapshot.sheets.map(s=>({index:s.index,name:s.name,ranges:s.unmaterialized_ranges})),date_epochs:snapshot.sheets.map(s=>({index:s.index,...s.date_epoch})),unknown_contexts:91,original_record_absences:36,candidate_denominator:1061}};
    if(!shape(evidence))fail('STRUCTURE_INVALID');
    return {ok:true,evidence,observations:observations(source,evidence),errors:[]};
  }catch(e){return error(e);}
}
export function validateOriginalXlsSourceEvidence({source,sourceBytes,evidence}={}){
  try{
    if(!shape(evidence))fail('STRUCTURE_INVALID');
    const rebuilt=buildOriginalXlsSourceEvidence({source,sourceBytes,artifacts:evidence.proof});
    if(!rebuilt.ok)return rebuilt;if(!same(rebuilt.evidence,evidence))fail('REPLAY_MISMATCH');return rebuilt;
  }catch(e){return error(e);}
}
export function originalXlsSourceVisibility({source,sourceBytes,evidence}={}){
  const checked=validateOriginalXlsSourceEvidence({source,sourceBytes,evidence});if(!checked.ok)return checked;
  const errors=[];
  for(const r of evidence.records){checkSourceEvidenceTextSafety(r.text??'','/text',c=>errors.push(c),'text');checkSourceEvidenceTextSafety(r.number_format??'','/number_format',c=>errors.push(c),'text');}
  return {ok:true,parts:[],transformations:[],visibility_errors:[...new Set(errors)],errors:[]};
}
