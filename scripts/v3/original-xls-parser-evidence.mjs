import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {isDeepStrictEqual as same} from 'node:util';
import {fingerprintV3Json as hash} from './semantic-package-validator.mjs';
import {validateOriginalXlsSourceEvidence,ORIGINAL_XLS_PROFILE} from './original-xls-source-evidence.mjs';

export const ORIGINAL_XLS_PARSER_PROFILE='paper04-three-saved-xls-parser-grid-1';
const MEMBERS=[{"source":"sha256:28339171e3cbd8430dceb2567da65c862a73d48172a4e725496ae1ac9419d211","pins":{"packet":{"sha256":"sha256:bc7a4a0b79deccf55f5cde9bdb32bf87da3eaf2ba492697ebf30fe1ffddce787","bytes":1649},"observation":{"sha256":"sha256:384320378a1fa25b4b32bafb4c3d757b0452bd1af8c77f6f2666b75be8908cfb","bytes":1802},"conversion":{"sha256":"sha256:0610b0642348a6681b3284045124b6628febcb7fcf2d1f3bce7d84658c7544a2","bytes":680},"fidelity":{"sha256":"sha256:764ba3f387ae8e6100266fd7c2249403891f3b361ab63124fd1cc56a084f1ffc","bytes":12248},"mapping":{"sha256":"sha256:139f0400f2e2002a675f28555df88ac3e21e921f85a2e3be6d9cadf5f596235c","bytes":3434808}}},{"source":"sha256:17c1fac228f6b65f27e7fc4b397b23b7aad2d4bed1d34431caa8a413606b8418","pins":{"packet":{"sha256":"sha256:40d8cf9e92f3acf16d625148aedb37ec84b7ccb702f58f1a94a2b7317c08238a","bytes":1649},"observation":{"sha256":"sha256:4aaf52e8849e31e8287052c4abd4a786a064c48f93e8c748e9c1167c698eb3d7","bytes":1807},"conversion":{"sha256":"sha256:63aaa50310ac67690e31df2e3ae3607d72070e124e8c018c4cb65f61390e3b75","bytes":689},"fidelity":{"sha256":"sha256:c9cd888d7f5bcb4a5620599d5b9dbb289c46d416271880a2a12c1f6187790272","bytes":27889},"mapping":{"sha256":"sha256:20779a79ebc2f732161363a2ad7f47df69ee363468a6d499a035df2a2320065c","bytes":29254985}}},{"source":"sha256:73800de48b868a11659c0eea96eac182a403e4d79dedb7d51f14e29f7029b092","pins":{"packet":{"sha256":"sha256:d2e2aded39fa1450e90924130d2a9989d19229958874cb01024005ed4c598ab5","bytes":1649},"observation":{"sha256":"sha256:e9c1d92b509d6910f8d683884f10b585191b65e094c49efa42e8e7d6c060d5ed","bytes":1807},"conversion":{"sha256":"sha256:16069fb761167f399b68327f5cccea408208127a516b2579bc1292c15bd1d608","bytes":1139},"fidelity":{"sha256":"sha256:8c3b62b60763ffd5f6ff0755c258e40fda4faa7df344b0176556f9a2067c14fa","bytes":6342},"mapping":{"sha256":"sha256:05f12339b8f20a057ff726f6f4ca236b60f618956eaa5f3dbdc8d1da500217d8","bytes":9836521}}}];
const sha=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
const copy=x=>structuredClone(x);
const fail=reason=>{throw Error('ORIGINAL_XLS_PARSER_'+reason);};
const bytes=x=>x instanceof Uint8Array?Buffer.from(x):fail('BYTES_REQUIRED');
const error=e=>({ok:false,evidence:null,observations:[],errors:[/^ORIGINAL_XLS_PARSER_[A-Z_]+$/.test(e.message)?e.message:'ORIGINAL_XLS_PARSER_INVALID']});
const column=n=>{let s='';for(;n;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s;};
const decode=s=>s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(_,x)=>x[0]==='#'?String.fromCodePoint(x[1].toLowerCase()==='x'?parseInt(x.slice(2),16):Number(x.slice(1))):({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:'\u00a0'})[x.toLowerCase()]);
function proof(artifacts,member){
  if(!artifacts||!same(Object.keys(artifacts).sort(),Object.keys(member.pins).sort()))fail('PROOF_SET');
  return Object.fromEntries(Object.entries(member.pins).map(([key,pin])=>{
    const item=artifacts[key];if(!item||typeof item.bytes_base64!=='string'||item.bytes_base64.length>48*1024*1024)fail('PROOF_BYTES');
    const encoded=Buffer.from(item.bytes_base64,'base64');if(encoded.toString('base64')!==item.bytes_base64||sha(encoded)!==item.sha256)fail('PROOF_HASH');
    let raw=encoded;
    if(item.encoding!==undefined){if(key!=='mapping'||item.encoding!=='gzip'||item.decoded_sha256!==pin.sha256)fail('PROOF_ENCODING');raw=gunzipSync(encoded,{maxOutputLength:pin.bytes});}
    if(raw.length!==pin.bytes||sha(raw)!==pin.sha256)fail('QUALIFICATION_BINDING');
    return [key,JSON.parse(raw.toString('utf8').replace(/^\uFEFF/,''))];
  }));
}
function htmlRows(html){
  if(typeof html!=='string'||/<!\s*(DOCTYPE|ENTITY)/i.test(html))fail('HTML_INVALID');
  const rows=[...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(row=>[...row[1].matchAll(/<(td|th)\b([^>]*)>([\s\S]*?)<\/(?:td|th)>/gi)].map(cell=>{
    const span=key=>{const m=new RegExp('\\b'+key+'\\s*=\\s*["\x27]([0-9]+)["\x27]','i').exec(cell[2]);const value=m?Number(m[1]):1;if(!Number.isSafeInteger(value)||value<1)fail('HTML_SPAN');return value;};
    return {text:decode(cell[3].replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]*>/g,'')),rowspan:span('rowspan'),colspan:span('colspan'),tag:cell[1].toLowerCase()};
  }));
  return rows;
}
/** Exact three-workbook qualification only; no XLS reader, parser or file access. */
export function buildOriginalXlsParserEvidence({source,sourceBytes,sourceEvidence,parserOutputBytes,parserBinding,artifacts}={}){
  try{
    const member=MEMBERS.find(m=>m.source===source?.source_sha256);if(!member||sourceEvidence?.profile!==ORIGINAL_XLS_PROFILE)fail('PROFILE_BINDING');
    const original=validateOriginalXlsSourceEvidence({source,sourceBytes,evidence:sourceEvidence});if(!original.ok)fail('SOURCE_EVIDENCE');
    const p=proof(artifacts,member),{packet,observation,conversion,fidelity,mapping}=p;
    const raw=bytes(parserOutputBytes),rawSha=sha(raw);
    const inventory=observation.output_inventory?.filter(f=>f.path==='input/office/input_content_list.json');
    if(packet.run_id!==observation.run_id||packet.run_id!==mapping.parser_run_id||packet.allowed_output_root!==observation.output_path||packet.backend?.identity!=='current-mineru'||observation.port!=='current-mineru'||packet.backend.version!=='3.4.5'||observation.parser_version!=='3.4.5'||inventory?.length!==1||inventory[0].sha256!==rawSha||inventory[0].byte_length!==raw.length||mapping.parser_output_sha256!==rawSha||parserBinding?.sha256!==rawSha||parserBinding.run_id!==packet.run_id||parserBinding.backend!=='mineru'||parserBinding.backend_version!=='3.4.5')fail('PARSER_BINDING');
    if(conversion.source_sha256!==member.source||fidelity.original_sha256!==member.source||mapping.source.sha256!==member.source||conversion.save_as_calls!==1||packet.source.sha256!==conversion.derived_sha256||fidelity.derived_sha256!==conversion.derived_sha256||packet.source.byte_length!==conversion.derived_bytes||!fidelity.checks.every(c=>c.pass===true)||fidelity.value_differences.length||fidelity.format_differences.length||fidelity.storage_differences.length)fail('DERIVATION_BINDING');
    const content=JSON.parse(raw),sourceRecords=new Map(sourceEvidence.records.map(r=>[r.sheet.index+':'+r.row+':'+r.column,r]));
    const observations=[],differences=[],usedPointers=new Set(),usedCells=new Set();
    const mappingHash=member.pins.mapping.sha256,proofHash=hash(artifacts);
    function observed({sheet,row,col,text,pointer,htmlPath,tableIndex,recordIndex}){
      const src=sourceRecords.get(sheet.index+':'+row+':'+col),address=column(col)+row;
      const numeric=src?.biff_type==='number'&&src.reader_cell_type!=='date_serial'&&text.trim()!==''&&Number.isFinite(Number(text));
      const record={id:'xls/sheet-'+sheet.index+'#'+address,kind:'workbook_cell',sheet:copy(sheet),address,row,column:col,state:text===''?'blank':'value',text,raw_value:text,value:numeric?Number(text):text,serialized:true,evidence_origin:'parser_html'};
      const locator={kind:'workbook',document_id:source.document_id,member_path:source.member_path,sheet:{index:sheet.index,name:sheet.name},range:{start_row:row,start_column:col,end_row:row,end_column:col}};
      observations.push({id:source.document_id+'#saved-grid#'+pointer+'#'+recordIndex,document_id:source.document_id,kind:'workbook_cell',origin:'derived_source_mapping',locator,parser_locator:{json_pointer:pointer,html_path:htmlPath,table_index:tableIndex,text_index:null},mapping_status:'mapped',text,record,binding:{...copy(parserBinding),source_sha256:member.source,derived_sha256:packet.source.sha256,mapping_evidence:mappingHash,proof_fingerprint:proofHash,source_context_only_fields:['source_storage_type','source_reader_type'],source_storage_type:src?.biff_type??null,source_reader_type:src?.reader_cell_type??null,formula_observed:false}});
    }
    for(const [tableIndex,t] of mapping.tables.entries()){
      if(usedPointers.has(t.json_pointer))fail('MAPPING_DUPLICATE');usedPointers.add(t.json_pointer);
      const match=/^\/(\d+)\/table_body$/.exec(t.json_pointer),entry=match?content[Number(match[1])]:null;
      const sheet=sourceEvidence.scope.sheets.find(s=>s.index===t.sheet_index&&s.name===t.sheet_name);if(!sheet||entry?.type!=='table'||!Array.isArray(t.selected_offset)||t.selected_offset.length!==2||!t.selected_offset.every(Number.isSafeInteger))fail('MAPPING_FRAME');
      const rows=htmlRows(entry.table_body),occupied=new Set();let n=0;
      for(const [ri,cells] of rows.entries()){
        let col=1;
        for(const [ci,cell] of cells.entries()){
          while(occupied.has((ri+1)+':'+col))col++;
          const m=t.mapping[n++],row=ri+1+t.selected_offset[0],sourceCol=col+t.selected_offset[1];
          if(!m||m.html_row!==ri+1||m.html_cell!==ci+1||m.source_row!==row||m.source_column!==sourceCol||m.text!==cell.text||m.rowspan!==cell.rowspan||m.colspan!==cell.colspan||row<1||sourceCol<1)fail('HTML_MAPPING');
          for(let dr=0;dr<cell.rowspan;dr++)for(let dc=0;dc<cell.colspan;dc++){const key=(ri+1+dr)+':'+(col+dc);if(occupied.has(key))fail('HTML_OVERLAP');occupied.add(key);}
          const key=sheet.index+':'+row+':'+sourceCol;if(usedCells.has(key))fail('MAPPING_DUPLICATE');usedCells.add(key);
          observed({sheet,row,col:sourceCol,text:cell.text,pointer:t.json_pointer,htmlPath:`/table[1]/tr[${ri+1}]/${cell.tag}[${ci+1}]`,tableIndex:tableIndex+1,recordIndex:n});
          col+=cell.colspan;
        }
      }
      if(n!==t.mapping.length)fail('HTML_MAPPING');
      for(const d of t.differences)differences.push({sheet_index:sheet.index,...copy(d)});
    }
    for(const s of mapping.sheets)for(const [n,t] of s.text_observations.entries()){
      const match=/^\/(\d+)\/text$/.exec(t.json_pointer),entry=match?content[Number(match[1])]:null;
      if(entry?.text!==t.text||t.exact_source_positions.length!==1)fail('TEXT_MAPPING');
      const [row,col]=t.exact_source_positions[0],sheet=sourceEvidence.scope.sheets.find(q=>q.index===s.index&&q.name===s.name),src=sourceRecords.get(s.index+':'+row+':'+col);
      if(!sheet||src?.text!==t.text)fail('TEXT_MAPPING');
      observed({sheet,row,col,text:entry.text,pointer:t.json_pointer,htmlPath:null,tableIndex:null,recordIndex:'text-'+n});
    }
    const evidence={profile:ORIGINAL_XLS_PARSER_PROFILE,source_sha256:member.source,source_evidence_fingerprint:hash(sourceEvidence),derived_sha256:packet.source.sha256,parser_output_sha256:rawSha,parser_run_id:packet.run_id,mapping_fingerprint:mappingHash,proof_fingerprint:proofHash,proof:copy(artifacts),representation_differences:differences,scientific_eligible:false,independent_backend:false,original_format_lossless:'not_established',source_truth:'original_xls',mapping_status:'qualified_saved_grid_only'};
    return {ok:true,evidence,observations,errors:[]};
  }catch(e){return error(e);}
}
export function validateOriginalXlsParserEvidence(args={}){
  const rebuilt=buildOriginalXlsParserEvidence({...args,artifacts:args.evidence?.proof});
  if(!rebuilt.ok)return rebuilt;
  return same(rebuilt.evidence,args.evidence)?rebuilt:error(Error('ORIGINAL_XLS_PARSER_REPLAY_MISMATCH'));
}
