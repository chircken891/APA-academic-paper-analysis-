import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {inflateRawSync} from 'node:zlib';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import {fingerprintV3Json,checkV3StorageSafety,checkSourceEvidenceTextSafety,hasV3CredentialValue} from './semantic-package-validator.mjs';
import {isDeepStrictEqual} from 'node:util';
import {ORIGINAL_XLS_PARSER_PROFILE,validateOriginalXlsParserEvidence} from './original-xls-parser-evidence.mjs';
import {ORIGINAL_XLS_PROFILE,validateOriginalXlsSourceEvidence,originalXlsSourceVisibility} from './original-xls-source-evidence.mjs';
import {validateDerivedWorkbookEvidence,deriveWorkbookParserObservations,validateDerivedWorkbookCoverage,derivedWorkbookVisibility} from './derived-workbook-evidence.mjs';
import {deriveSourceLiteralPdfRun,SOURCE_LITERAL_PDF_SUFFIX} from './source-literal-pdf-derivation.mjs';

const sha=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
const hash=fingerprintV3Json;
const same=isDeepStrictEqual;
const copy=x=>structuredClone(x);
const schema=JSON.parse(await readFile(new URL('../../Schema/phase21/whole-paper.schema.json',import.meta.url),'utf8'));
const ajv=new Ajv2020({allErrors:true,strict:false});ajv.addSchema(schema);
const shape=ajv.compile({$ref:'phase21/whole-paper#/$defs/run'});
const fail=code=>{throw new Error(code)};
const bytes=x=>x instanceof Uint8Array?Buffer.from(x):fail('WHOLE_PAPER_BYTES_REQUIRED');
const safePath=p=>typeof p==='string'&&p.length&&!p.startsWith('/')&&!/[\\:]/.test(p)&&!p.split('/').some(s=>!s||s==='.'||s==='..');
const decode=s=>s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(_,x)=>x[0]==='#'?String.fromCodePoint(x[1].toLowerCase()==='x'?parseInt(x.slice(2),16):Number(x.slice(1))):({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:'\u00a0'})[x.toLowerCase()]);

/** Non-executing markup tree. Paths retain every table ancestor, not a flat text match. */
function markup(input,xml=false,retainSpans=false){
  if(typeof input!=='string'||Buffer.byteLength(input)>32*1024*1024||/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(input))fail('WHOLE_PAPER_MARKUP_INVALID');
  if(xml&&!retainSpans)input=input.replace(/\r\n?/g,'\n');
  const root={tag:'root',path:'',children:[],pieces:[],attrs:{},parent:null},stack=[root],nodes=[];
  const tokens=input.match(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+/g)??[];
  if(tokens.join('')!==input)fail('WHOLE_PAPER_MARKUP_INVALID');
  let offset=0;
  for(const token of tokens){
    const tokenOffset=offset;offset+=token.length;
    if(token.startsWith('<!--')||token.startsWith('<?'))continue;
    if(token.startsWith('<![CDATA[')){stack.at(-1).pieces.push(token.slice(9,-3));continue;}
    if(token.startsWith('</')){const qname=token.slice(2,-1).trim(),tag=qname.split(':').at(-1);if(stack.length<2||stack.at(-1).tag!==tag||xml&&stack.at(-1).qname!==qname)fail('WHOLE_PAPER_MARKUP_INVALID');stack.pop();continue;}
    if(token.startsWith('<')){
      const m=/^<([\w:-]+)([\s\S]*?)(\/?)>$/.exec(token);if(!m)fail('WHOLE_PAPER_MARKUP_INVALID');
      const tag=m[1].split(':').at(-1),attrs={},attrSpans={},tail=m[2];let consumed='';
      const attrPattern=/\s+([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;let a;
      while((a=attrPattern.exec(tail))){
        if(a.index!==consumed.length||Object.hasOwn(attrs,a[1]))fail('WHOLE_PAPER_MARKUP_INVALID');
        const raw=a[2]??a[3];attrs[a[1]]=decode(xml?raw.replace(/\r\n?/g,'\n').replace(/[\t\n]/g,' '):raw);
        if(retainSpans){const start=tokenOffset+1+m[1].length+a.index+a[0].search(/["']/)+1;attrSpans[a[1]]={start,end:start+raw.length};}
        consumed+=a[0];
      }
      if(tail.slice(consumed.length).trim())fail('WHOLE_PAPER_MARKUP_INVALID');
      const parent=stack.at(-1);parent.counts??={};const n=(parent.counts[tag]??0)+1;parent.counts[tag]=n;
      const namespaces={...(parent.namespaces??{}),...Object.fromEntries(Object.entries(attrs).filter(([k])=>k==='xmlns'||k.startsWith('xmlns:')).map(([k,v])=>[k==='xmlns'?'':k.slice(6),v]))};
      if(xml){
        const prefix=m[1].includes(':')?m[1].split(':')[0]:null;
        if(!/^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/.test(m[1])||prefix&&!namespaces[prefix])fail('WHOLE_PAPER_MARKUP_INVALID');
        for(const name of Object.keys(attrs))if(name.includes(':')&&!['xml','xmlns'].includes(name.split(':')[0])&&!namespaces[name.split(':')[0]])fail('WHOLE_PAPER_MARKUP_INVALID');
      }
      const expandedAttrs={};for(const [k,v] of Object.entries(attrs))if(k!=='xmlns'&&!k.startsWith('xmlns:')){const [prefix,local]=k.split(':'),expanded=local?'{'+namespaces[prefix]+'}'+local:k;if(Object.hasOwn(expandedAttrs,expanded))fail('WHOLE_PAPER_MARKUP_INVALID');expandedAttrs[expanded]=v;}
      const node={tag,qname:m[1],attrs,expandedAttrs,namespaces,namespace_uri:namespaces[m[1].includes(':')?m[1].split(':')[0]:'']??null,path:parent.path+'/'+tag+'['+n+']',children:[],pieces:[],parent,...(retainSpans?{attrSpans}:{})};parent.children.push(node);parent.pieces.push(node);nodes.push(node);
      if(!m[3]&&(xml||!['br','hr','img','meta','link','input'].includes(tag)))stack.push(node);
    }else stack.at(-1).pieces.push(decode(token));
  }
  if(stack.length!==1)fail('WHOLE_PAPER_MARKUP_INVALID');
  return {root,nodes};
}
const allText=node=>node.pieces.map(p=>typeof p==='string'?p:p.tag==='br'||p.tag==='cr'?'\n':p.tag==='tab'?'\t':allText(p)).join('');
function wordText(node){return node.pieces.map(p=>typeof p==='string'?'':p.tag==='t'?allText(p):p.tag==='br'||p.tag==='cr'?'\n':p.tag==='tab'?'\t':wordText(p)).join('');}
const ancestors=node=>{const out=[];for(let p=node.parent;p?.parent;p=p.parent)if(['tbl','tr','tc','table','td','th'].includes(p.tag))out.unshift(p.path);return out;};

/** Bind actual archive member bytes, not a caller's editable XML hashes. */
function boundParts(sourceBytes,evidence){
  const b=bytes(sourceBytes);let end=-1;
  for(let i=b.length-22;i>=Math.max(0,b.length-65557);i--)if(b.readUInt32LE(i)===0x06054b50&&i+22+b.readUInt16LE(i+20)===b.length){end=i;break;}
  if(end<0||b.readUInt16LE(end+4)||b.readUInt16LE(end+6))fail('WHOLE_PAPER_SOURCE_ZIP_INVALID');
  const count=b.readUInt16LE(end+10),offset=b.readUInt32LE(end+16),directory=new Map();let pos=offset;
  for(let n=0;n<count;n++){
    if(pos+46>b.length||b.readUInt32LE(pos)!==0x02014b50)fail('WHOLE_PAPER_SOURCE_ZIP_INVALID');
    const nl=b.readUInt16LE(pos+28),el=b.readUInt16LE(pos+30),cl=b.readUInt16LE(pos+32),name=b.subarray(pos+46,pos+46+nl).toString('utf8');
    if(directory.has(name))fail('WHOLE_PAPER_SOURCE_ZIP_INVALID');
    directory.set(name,{flags:b.readUInt16LE(pos+8),method:b.readUInt16LE(pos+10),compressed:b.readUInt32LE(pos+20),length:b.readUInt32LE(pos+24),offset:b.readUInt32LE(pos+42)});pos+=46+nl+el+cl;
  }
  const result=new Map();let total=0;
  for(const part of evidence.parts??[]){
    if(!safePath(part.path)||result.has(part.path))fail('WHOLE_PAPER_SOURCE_PART_INVALID');
    const z=directory.get(part.path);if(!z||(z.flags&1)||![0,8].includes(z.method)||z.length!==part.byte_length||z.offset+30>b.length||b.readUInt32LE(z.offset)!==0x04034b50)fail('WHOLE_PAPER_SOURCE_PART_INVALID');
    total+=z.length;if(total>32*1024*1024)fail('WHOLE_PAPER_XML_LIMIT');
    const start=z.offset+30+b.readUInt16LE(z.offset+26)+b.readUInt16LE(z.offset+28);
    if(start+z.compressed>offset)fail('WHOLE_PAPER_SOURCE_ZIP_INVALID');
    const raw=z.method===0?b.subarray(start,start+z.compressed):inflateRawSync(b.subarray(start,start+z.compressed),{maxOutputLength:32*1024*1024});
    if(raw.length!==z.length||sha(raw)!==part.sha256)fail('WHOLE_PAPER_SOURCE_PART_INVALID');
    const encoding=raw[0]===0xff&&raw[1]===0xfe?'utf-16le':raw[0]===0xfe&&raw[1]===0xff?'utf-16be':'utf-8';
    let decoded;try{decoded=new TextDecoder(encoding,{fatal:true}).decode(raw);}catch{fail('SOURCE_EVIDENCE_RAW_PART_MISMATCH');}
    const tree=markup(decoded,true);
    result.set(part.path,{...part,raw,decoded,encoding:encoding==='utf-8'?'utf-8':'utf-16',tree,nodesByPath:new Map(tree.nodes.map(n=>[n.path,n]))});
  }
  Object.defineProperty(result,'memberNames',{value:new Set(directory.keys())});
  return result;
}

function validateRawParts(e,parts){
  if(!Object.hasOwn(e,'raw_parts'))return;
  const exact=(o,keys)=>o&&typeof o==='object'&&same(Object.keys(o).sort(),[...keys].sort());
  const raw=e.raw_parts;
  if(!Array.isArray(raw)||raw.length!==parts.size||new Set(raw.map(p=>p?.path)).size!==raw.length)fail('SOURCE_EVIDENCE_RAW_PART_MISMATCH');
  for(const p of raw){
    const actual=parts.get(p?.path),whole=exact(p,['path','sha256','byte_length','xml','encoding','raw_base64']),legacy=exact(p,['path','sha256','byte_length','xml','locator_root']);
    if(!actual||!whole&&!legacy||p.sha256!==actual.sha256||p.byte_length!==actual.raw.length)fail('SOURCE_EVIDENCE_RAW_PART_MISMATCH');
    if(whole&&(p.raw_base64!==actual.raw.toString('base64')||p.encoding!==actual.encoding||p.xml!==actual.decoded))fail('SOURCE_EVIDENCE_RAW_PART_MISMATCH');
    if(legacy&&(actual.encoding!=='utf-8'||p.xml!==actual.raw.toString('utf8')||p.locator_root!==actual.tree.root.children[0]?.path))fail('SOURCE_EVIDENCE_RAW_PART_MISMATCH');
  }
}

const REL_NS='http://schemas.openxmlformats.org/package/2006/relationships';
function validateExternalRelationships(e,parts){
  const expected=new Map();
  for(const [name,part]of parts){
    if(!name.endsWith('.rels'))continue;
    const ids=new Set();
    for(const node of part.tree.nodes.filter(n=>n.tag==='Relationship'&&n.parent?.tag==='Relationships')){
      const id=node.attrs.Id;
      if(!id||ids.has(id))fail('SOURCE_EVIDENCE_RELATIONSHIP_MISMATCH');ids.add(id);
      if(node.attrs.TargetMode!=='External')continue;
      if(node.namespace_uri!==REL_NS||node.parent.namespace_uri!==REL_NS||!/^[-A-Za-z_0-9.:]+$/.test(id))fail('SOURCE_EVIDENCE_RELATIONSHIP_MISMATCH');
      const locator='/Relationships/Relationship[@Id="'+id+'"]';expected.set(name+'#'+locator,{part,node,locator});
    }
  }
  const seen=new Set();
  for(const rec of e.records.filter(r=>r.kind==='external_relationship')){
    const item=expected.get(rec.id),loc=rec.locator;
    if(!item||seen.has(rec.id)||!same(Object.keys(rec).sort(),['id','kind','locator','physical_page','evidence_origin','target','relation_type','status','text'].sort())
      ||!loc||!same(Object.keys(loc).sort(),['part','part_sha256','xml_path'])||loc.part!==item.part.path||loc.part_sha256!==item.part.sha256||loc.xml_path!==item.locator
      ||rec.target!==item.node.attrs.Target||rec.relation_type!==item.node.attrs.Type||rec.status!=='not_followed'||rec.text!==null||rec.physical_page!==null||rec.evidence_origin!=='source_only')fail('SOURCE_EVIDENCE_RELATIONSHIP_MISMATCH');
    seen.add(rec.id);
  }
  if(seen.size!==expected.size)fail('SOURCE_EVIDENCE_RELATIONSHIP_MISMATCH');
}

function validateSourceEvidence(payload,source,existingParts=null){
  const e=payload.source_evidence;
  if(!e||e.source?.sha256!==source.source_sha256||!Array.isArray(e.records)||!Array.isArray(e.parts)||!Array.isArray(e.scope?.parts))fail('WHOLE_PAPER_SOURCE_BINDING_MISMATCH');
  const parts=existingParts??boundParts(payload.source_bytes,e);
  validateRawParts(e,parts);validateExternalRelationships(e,parts);
  if(!same([...parts.keys()].sort(),[...e.scope.parts].sort()))fail('WHOLE_PAPER_SOURCE_PART_INVALID');
  if(e.format!==source.format||e.scope.format!==source.format||!['docx','xlsx'].includes(e.format))fail('WHOLE_PAPER_SOURCE_BINDING_MISMATCH');
  const W='http://schemas.openxmlformats.org/wordprocessingml/2006/main',S='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  if(source.kind==='docx'&&(parts.get('word/document.xml')?.tree.root.children[0]?.tag!=='document'||parts.get('word/document.xml')?.tree.root.children[0]?.namespace_uri!==W))fail('WHOLE_PAPER_SOURCE_PART_INVALID');
  const ids=new Set();
  const stringsPart=[...parts.values()].find(p=>p.path.endsWith('/sharedStrings.xml'));
  const sharedStrings=stringsPart?.tree.nodes.filter(n=>n.tag==='si');
  const coordinate=address=>{const m=/^([A-Z]+)([1-9][0-9]*)$/.exec(address??'');if(!m)fail('WHOLE_PAPER_SOURCE_RECORD_INVALID');let column=0;for(const c of m[1])column=column*26+c.charCodeAt(0)-64;return {row:Number(m[2]),column};};
  const rangeOf=value=>{const tokens=String(value).split(':');if(tokens.length>2)fail('WHOLE_PAPER_SOURCE_RECORD_INVALID');const a=coordinate(tokens[0]),b=coordinate(tokens.at(-1));if(a.row>b.row||a.column>b.column)fail('WHOLE_PAPER_SOURCE_RECORD_INVALID');return {start_row:a.row,start_column:a.column,end_row:b.row,end_column:b.column};};
  const inRange=(p,r)=>p.row>=r.start_row&&p.row<=r.end_row&&p.column>=r.start_column&&p.column<=r.end_column;
  const mergesByPart=new Map([...parts].map(([name,p])=>[name,p.tree.nodes.filter(n=>n.tag==='mergeCell').map(n=>({ref:n.attrs.ref,low:coordinate(n.attrs.ref.split(':')[0]),high:coordinate(n.attrs.ref.split(':').at(-1))}))]));
  const sheetByPart=new Map();
  if(source.kind==='workbook'){
    const wb=parts.get('xl/workbook.xml'),rels=parts.get('xl/_rels/workbook.xml.rels');
    if(!wb||!rels||wb.tree.root.children[0]?.namespace_uri!==S||wb.tree.root.children[0]?.tag!=='workbook')fail('WHOLE_PAPER_SOURCE_PART_INVALID');
    const relationMap=new Map();for(const n of rels.tree.nodes.filter(n=>n.tag==='Relationship')){if(relationMap.has(n.attrs.Id)||n.attrs.TargetMode==='External')fail('WHOLE_PAPER_SOURCE_RECORD_INVALID');const target=path.posix.normalize(n.attrs.Target?.startsWith('/')?n.attrs.Target.slice(1):'xl/'+n.attrs.Target);if(!safePath(target))fail('WHOLE_PAPER_SOURCE_PART_INVALID');relationMap.set(n.attrs.Id,target);}
    const sheets=wb.tree.nodes.filter(n=>n.tag==='sheet'&&n.namespace_uri===S);
    if(e.coverage?.sheets?.length!==sheets.length||!sheets.length)fail('WHOLE_PAPER_SOURCE_COVERAGE_INVALID');
    for(const [index,node]of sheets.entries()){
      const rid=Object.entries(node.expandedAttrs).find(([k])=>k==='{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')?.[1],partName=relationMap.get(rid),ws=parts.get(partName);
      if(!ws||ws.tree.root.children[0]?.tag!=='worksheet'||ws.tree.root.children[0]?.namespace_uri!==S||sheetByPart.has(partName))fail('WHOLE_PAPER_SOURCE_PART_INVALID');
      const sheet={index,name:node.attrs.name,sheet_id:node.attrs.sheetId,visibility:node.attrs.state??'visible'},cov=e.coverage.sheets.find(s=>s.index===index);
      const cells=ws.tree.nodes.filter(n=>n.tag==='c'&&n.namespace_uri===S),mergeRanges=(mergesByPart.get(partName)??[]).map(m=>m.ref),declared=ws.tree.nodes.find(n=>n.tag==='dimension')?.attrs.ref;
      const maxRow=Math.max(1,...(cells.length<10000?cells.map(n=>coordinate(n.attrs.r).row):[1])),maxCol=Math.max(1,...(cells.length<10000?cells.map(n=>coordinate(n.attrs.r).column):[1]));
      let extent=declared?rangeOf(declared):{start_row:1,start_column:1,end_row:maxRow,end_column:maxCol};
      if(!declared)for(const n of cells){const p=coordinate(n.attrs.r);extent.end_row=Math.max(extent.end_row,p.row);extent.end_column=Math.max(extent.end_column,p.column);}
      for(const m of mergeRanges){const r=rangeOf(m);if(!declared){extent.end_row=Math.max(extent.end_row,r.end_row);extent.end_column=Math.max(extent.end_column,r.end_column);}}
      if(!cov||cov.name!==sheet.name||cov.serialized_cells!==cells.length||!same(cov.merged_ranges,mergeRanges)||cov.unserialized_not_assumed_blank!==true)fail('WHOLE_PAPER_SOURCE_COVERAGE_INVALID');
      const covered=rangeOf(cov.range);
      if(!inRange({row:covered.start_row,column:covered.start_column},extent)||!inRange({row:covered.end_row,column:covered.end_column},extent)||cells.some(n=>!inRange(coordinate(n.attrs.r),covered)))fail('WHOLE_PAPER_SOURCE_COVERAGE_INVALID');
      if(e.scope.sheets&&!e.scope.sheets.some(s=>s.index===index&&s.name===sheet.name&&same(rangeOf(s.range),covered)))fail('WHOLE_PAPER_SOURCE_COVERAGE_INVALID');
      sheetByPart.set(partName,sheet);
    }
  }
  for(const rec of e.records){
    const part=parts.get(rec.locator?.part),node=part?.nodesByPath.get(rec.locator?.xml_path);
    if(ids.has(rec.id)||!part||rec.locator.part_sha256!==part.sha256||rec.id!==part.path+'#'+rec.locator.xml_path)fail('WHOLE_PAPER_SOURCE_RECORD_INVALID');ids.add(rec.id);
    if(['paragraph','cell','table','row','footnote','endnote','comment','workbook_cell'].includes(rec.kind)&&!node)fail('WHOLE_PAPER_SOURCE_RECORD_INVALID');
    const tagKinds={p:'paragraph',tc:'cell',tbl:'table',tr:'row',footnote:'footnote',endnote:'endnote',comment:'comment',c:'workbook_cell'};
    if(tagKinds[node?.tag]&&tagKinds[node.tag]!==rec.kind)fail('WHOLE_PAPER_SOURCE_RECORD_INVALID');
    if(['paragraph','cell','footnote','endnote','comment'].includes(rec.kind)){
      const actual=rec.kind==='cell'?node.children.filter(n=>n.tag==='p').map(wordText).join('\n'):wordText(node);
      if(rec.text!==actual||!same(rec.ancestry??[],ancestors(node)))fail('WHOLE_PAPER_SOURCE_RECORD_INVALID');
    }
    if(source.kind==='docx'&&tagKinds[node?.tag]){
      if(node.namespace_uri!==W||!same(rec.attributes,node.expandedAttrs))fail('WHOLE_PAPER_SOURCE_RECORD_INVALID');
      if(['table','row','cell'].includes(rec.kind)){
        const descendants=[];const visit=n=>{for(const child of n.children){descendants.push(child);visit(child);}};visit(node);
        const structure={direct_children:node.children.map(n=>n.tag),properties:descendants.filter(n=>['gridSpan','vMerge','gridCol'].includes(n.tag)&&(node.tag==='tc'||node.children.includes(n.parent))).map(n=>({name:n.tag,attributes:n.expandedAttrs}))};
        if(!same(rec.structure,structure))fail('WHOLE_PAPER_SOURCE_RECORD_INVALID');
      }
    }
    if(rec.kind==='workbook_cell'){
      const v=node.children.find(n=>n.tag==='v'),form=node.children.find(n=>n.tag==='f');
      const point=coordinate(node.attrs.r),raw=v?allText(v):null,typ=node.attrs.t??'n';
      if(!same(rec.sheet,sheetByPart.get(part.path))||rec.style_index!==(node.attrs.s??null)||rec.serialized!==true||rec.unresolved!==(!['n','s','inlineStr','b','e','str','d'].includes(typ)||!!form&&['shared','array','dataTable'].includes(form.attrs.t))||node.parent?.tag!=='row'||node.parent.attrs.r&&Number(node.parent.attrs.r)!==point.row)fail('WHOLE_PAPER_SOURCE_RECORD_INVALID');
      const merges=(mergesByPart.get(part.path)??[]).filter(m=>point.row>=m.low.row&&point.row<=m.high.row&&point.column>=m.low.column&&point.column<=m.high.column);
      const covered=merges.length&&!(merges[0].low.row===point.row&&merges[0].low.column===point.column);
      const state=covered?'merged_covered':form&&!v?'formula_uncached':form?'formula_cached':typ==='e'?'error':v||typ==='inlineStr'?'value':'format_only';
      if(merges.length>1||rec.row!==point.row||rec.column!==point.column||rec.state!==state||!same(rec.merges,merges.map(m=>m.ref))||rec.cache?.element_present!==!!v||rec.cache?.raw_value!==raw
        ||rec.address!==node.attrs.r||rec.raw_value!==raw||rec.xml_type!==typ||rec.formula?.present!==!!form||rec.formula?.text!==(form?(allText(form)||null):null)||!same(rec.formula?.attributes,form?.attrs??{}))fail('WHOLE_PAPER_SOURCE_RECORD_INVALID');
      let actual=v?allText(v):null;
      if(rec.xml_type==='inlineStr')actual=node.children.filter(n=>n.tag==='is').map(n=>n.children.map(c=>c.tag==='t'?allText(c):c.children.filter(t=>t.tag==='t').map(allText).join('')).join('')).join('');
      if(rec.xml_type==='s'){
        const si=sharedStrings?.[Number(actual)];if(!si)fail('WHOLE_PAPER_SOURCE_RECORD_INVALID');actual=si.children.map(n=>n.tag==='t'?allText(n):n.children.filter(t=>t.tag==='t').map(allText).join('')).join('');
      }
      if(rec.text!==actual)fail('WHOLE_PAPER_SOURCE_RECORD_INVALID');
    }
  }
  // The sidecar cannot silently drop a node from an explicitly selected content part.
  for(const [name,part] of parts){
    const word=name.startsWith('word/')&&['document','footnotes','endnotes','comments','hdr','ftr'].includes(part.tree.root.children[0]?.tag);
    const sheet=name.startsWith('xl/')&&part.tree.root.children[0]?.tag==='worksheet';
    for(const node of part.tree.nodes)if(word&&['p','tc','tbl','tr','footnote','endnote','comment'].includes(node.tag)||sheet&&node.tag==='c')if(!ids.has(name+'#'+node.path))fail('WHOLE_PAPER_SOURCE_RECORD_INVALID');
  }
  return e;
}

function htmlFrames(tree){
  const tables=tree.nodes.filter(n=>n.tag==='table'),frames=[];
  const owner=n=>{for(let p=n.parent;p;p=p.parent)if(p.tag==='table')return p;return null;};
  for(const table of tables){
    const rows=tree.nodes.filter(n=>n.tag==='tr'&&owner(n)===table),cells=[],rowCells=[];let valid=true,maxColumn=0,active=[];
    for(const [index,row]of rows.entries()){
      const rowNumber=index+1,occupied=active.filter(c=>c.range.end_row>=rowNumber),current=[...occupied];let column=1;
      for(const node of row.children.filter(n=>n.tag==='td'||n.tag==='th')){
        const span=k=>node.attrs[k]===undefined?1:/^[1-9][0-9]*$/.test(node.attrs[k])?Number(node.attrs[k]):NaN;
        const height=span('rowspan'),width=span('colspan');
        while(current.some(c=>column>=c.range.start_column&&column<=c.range.end_column)){const c=current.find(c=>column>=c.range.start_column&&column<=c.range.end_column);column=c.range.end_column+1;}
        const range={start_row:rowNumber,start_column:column,end_row:rowNumber+height-1,end_column:column+width-1};
        if(!Number.isSafeInteger(height)||!Number.isSafeInteger(width)||height<1||width<1||range.end_row>rows.length||current.some(c=>range.start_column<=c.range.end_column&&range.end_column>=c.range.start_column))valid=false;
        const ps=node.children.filter(n=>n.tag==='p'),text=ps.length?ps.map(allText).join('\n'):allText(node);
        const cell={node,range,text,paragraph_paths:ps.length?ps.map(p=>p.path):[node.path]};cells.push(cell);current.push(cell);column=range.end_column+1;maxColumn=Math.max(maxColumn,range.end_column);
      }
      active=current.filter(c=>c.range.end_row>rowNumber);rowCells.push(current.sort((a,b)=>a.range.start_column-b.range.start_column));
    }
    for(const row of rowCells){let next=1;for(const c of row){if(c.range.start_column!==next)valid=false;next=c.range.end_column+1;}if(next!==maxColumn+1)valid=false;}
    if(tables.some(t=>t!==table&&owner(t)===table))valid=false;
    frames.push({table_path:table.path,rows:rows.length,columns:maxColumn,cells,rowCells,valid});
  }
  return frames;
}

function parserObservations(payload,source){
  const raw=bytes(payload.parser_output_bytes),binding=payload.parser_binding;
  if(sha(raw)!==binding?.sha256||!binding.run_id||binding.backend!=='mineru'||!binding.backend_version)fail('WHOLE_PAPER_PARSER_BINDING_MISMATCH');
  const content=JSON.parse(raw.toString('utf8'));if(!Array.isArray(content))fail('WHOLE_PAPER_PARSER_FORMAT_UNSUPPORTED');
  const out=[];Object.defineProperty(out,'frames',{value:[]});let tableIndex=0,textIndex=0;
  const add=(kind,text,pointer,htmlPath=null)=>out.push({id:source.document_id+'#'+pointer+(htmlPath??''),document_id:source.document_id,kind,origin:'mineru_output',locator:null,parser_locator:{json_pointer:pointer,html_path:htmlPath,table_index:htmlPath?tableIndex:null,text_index:htmlPath?null:++textIndex},mapping_status:'unmapped',text,record:null,binding:{...copy(binding),source_sha256:source.source_sha256}});
  content.forEach((entry,n)=>{
    if(entry.type==='table'&&typeof entry.table_body==='string'){
      tableIndex++;
      const tree=markup(entry.table_body);
      for(const frame of htmlFrames(tree))out.frames.push({...frame,table_index:tableIndex,json_pointer:'/'+n+'/table_body'});
      for(const node of tree.nodes.filter(node=>node.tag==='p'||['td','th'].includes(node.tag)&&!node.children.some(c=>c.tag==='p'||c.tag==='table'))){
        add('paragraph',allText(node),'/'+n+'/table_body',node.path);
        let cell=node;while(cell&&!['td','th'].includes(cell.tag))cell=cell.parent;
        const span=k=>cell?.attrs[k]===undefined?1:/^[1-9][0-9]*$/.test(cell.attrs[k])?Number(cell.attrs[k]):0;
        out.at(-1).binding.html_colspan=span('colspan');out.at(-1).binding.html_rowspan=span('rowspan');
      }
    }else if(typeof entry.text==='string')add('paragraph',entry.text,'/'+n+'/text');
  });
  return out;
}

function sourceObservations(e,source){
  const evidenceFingerprint=hash(e),partsFingerprint=hash(e.parts);
  return e.records.filter(r=>['paragraph','table','row','cell','footnote','endnote','comment','workbook_cell'].includes(r.kind)).map(rec=>{
    const locator=source.kind==='docx'?{kind:'docx',document_id:source.document_id,member_path:source.member_path??null,...rec.locator}:{kind:'workbook',document_id:source.document_id,member_path:source.member_path??null,sheet:{index:rec.sheet.index,name:rec.sheet.name},range:{start_row:rec.row,start_column:rec.column,end_row:rec.row,end_column:rec.column}};
    return {id:source.document_id+'#source#'+rec.id,document_id:source.document_id,kind:rec.kind,origin:'source_read',locator,parser_locator:null,mapping_status:'mapped',text:rec.text??null,record:copy(rec),binding:{source_sha256:source.source_sha256,evidence_fingerprint:evidenceFingerprint,record_fingerprint:hash(rec),parts_fingerprint:partsFingerprint}};
  });
}

/** Source-only observation: no parser identity, output, or input-driven file access. */
export function observeBoundOfficeSource({source,sourceBytes,sourceEvidence}={}){
  if(source?.format==='xls'&&sourceEvidence?.profile===ORIGINAL_XLS_PROFILE)return validateOriginalXlsSourceEvidence({source,sourceBytes,evidence:sourceEvidence});
  if(source?.format==='xls')return validateDerivedWorkbookEvidence({source,sourceBytes,evidence:sourceEvidence});
  try{
    if(!source||sha(bytes(sourceBytes))!==source.source_sha256)fail('WHOLE_PAPER_SOURCE_BINDING_MISMATCH');
    const evidence=validateSourceEvidence({source_bytes:sourceBytes,source_evidence:sourceEvidence},source);
    return {ok:true,evidence,observations:sourceObservations(evidence,source),errors:[]};
  }catch(error){return {ok:false,evidence:null,observations:[],errors:[error.message]};}
}

/** Internal producer facts are also needed by archival replay, even when delivery is refused. */
export function deriveBoundOfficeVisibilityFacts({source,sourceBytes,sourceEvidence}={}){
  if(source?.format==='xls'&&sourceEvidence?.profile===ORIGINAL_XLS_PROFILE)return originalXlsSourceVisibility({source,sourceBytes,evidence:sourceEvidence});
  if(source?.format==='xls')return derivedWorkbookVisibility({source,sourceBytes,evidence:sourceEvidence});
  try{
    hash({source,sourceEvidence});
    if(!source||sha(bytes(sourceBytes))!==source.source_sha256)fail('WHOLE_PAPER_SOURCE_BINDING_MISMATCH');
    const bound=boundParts(sourceBytes,sourceEvidence);validateSourceEvidence({source_bytes:sourceBytes,source_evidence:sourceEvidence},source,bound);
    const parts=[],transformations=[],visibility_errors=new Set();
    const apply=(text,edits)=>[...edits].sort((a,b)=>b.start-a.start).reduce((out,e)=>out.slice(0,e.start)+e.value+out.slice(e.end),text);
    for(const [partName,part]of bound){
      const tree=markup(part.decoded,true,true),redactions=[],scanEdits=[];
      for(const node of tree.nodes)for(const [attribute,value]of Object.entries(node.attrs)){
        const span=node.attrSpans[attribute];if(!span)fail('SOURCE_EVIDENCE_VISIBLE_CONTENT_UNSAFE');
        const credential=hasV3CredentialValue(value);if(credential)visibility_errors.add('SOURCE_EVIDENCE_VISIBLE_CONTENT_UNSAFE');
        let packageValue=false;
        if(node.namespace_uri==='http://schemas.openxmlformats.org/package/2006/content-types'&&node.tag==='Override'&&attribute==='PartName'){
          if(!value.startsWith('/')||!safePath(value.slice(1))||!bound.memberNames.has(value.slice(1)))fail('SOURCE_EVIDENCE_RELATIONSHIP_MISMATCH');packageValue=true;
        }
        if(node.tag==='Relationship'&&node.parent?.tag==='Relationships'&&[REL_NS,null].includes(node.namespace_uri)&&partName.endsWith('.rels')&&attribute==='Target'&&node.attrs.TargetMode!=='External'){
          if(/[:\\]/.test(value)||!value)fail('SOURCE_EVIDENCE_RELATIONSHIP_MISMATCH');
          const base=path.posix.dirname(path.posix.dirname(partName)),resolved=path.posix.normalize(value.startsWith('/')?value.slice(1):path.posix.join(base,value));
          if(!safePath(resolved)||!bound.memberNames.has(resolved))fail('SOURCE_EVIDENCE_RELATIONSHIP_MISMATCH');packageValue=true;
        }
        const checks=[];checkV3StorageSafety(value,'/value',(code)=>checks.push(code),'phase21-whole-paper-1.0');
        const reason=node.namespace_uri==='http://schemas.microsoft.com/office/spreadsheetml/2010/11/ac'&&node.tag==='absPath'&&attribute==='url'?'author_save_path'
          :node.namespace_uri==='http://schemas.openxmlformats.org/officeDocument/2006/bibliography'&&node.tag==='Sources'&&attribute==='SelectedStyle'?'bibliography_style_path':null;
        if(checks.some(code=>code!=='UNSAFE_STORAGE'))visibility_errors.add('SOURCE_EVIDENCE_VISIBLE_CONTENT_UNSAFE');
        if(checks.length&&!packageValue&&!reason)visibility_errors.add('SOURCE_EVIDENCE_VISIBLE_CONTENT_UNSAFE');
        if(checks.length&&!packageValue&&reason&&!credential){
          const identity={document_id:source.document_id,part:partName,part_sha256:part.sha256,xml_path:node.path,attribute,source_value_sha256:sha(value),reason_code:reason};
          const transformation_id=hash(identity),replacement='WITHHELD_'+transformation_id.slice(7);
          transformations.push({transformation_id,...identity,replacement});redactions.push({...span,value:replacement});
        }
        scanEdits.push({...span,value:''});
      }
      const scanErrors=[];checkSourceEvidenceTextSafety(apply(part.decoded,scanEdits),'/xml',code=>scanErrors.push(code),'text');
      for(const node of [tree.root,...tree.nodes])for(const piece of node.pieces)if(typeof piece==='string')checkSourceEvidenceTextSafety(piece,'/xml',code=>scanErrors.push(code),'text');
      if(scanErrors.length)visibility_errors.add('SOURCE_EVIDENCE_VISIBLE_CONTENT_UNSAFE');
      parts.push({document_id:source.document_id,part:partName,part_sha256:part.sha256,byte_length:part.byte_length,visible_xml:apply(part.decoded,redactions)});
    }
    const compare=(a,b)=>a<b?-1:a>b?1:0;
    transformations.sort((a,b)=>compare(a.document_id,b.document_id)||compare(a.part,b.part)||compare(a.xml_path,b.xml_path)||compare(a.attribute,b.attribute));
    return {ok:true,parts,transformations,visibility_errors:[...visibility_errors],errors:[]};
  }catch(error){const code=/^(?:WHOLE_PAPER|SOURCE_EVIDENCE)_[A-Z0-9_]+$/.test(error.message)?error.message:'SOURCE_EVIDENCE_VISIBLE_CONTENT_UNSAFE';return {ok:false,parts:null,transformations:[],errors:[code]};}
}

/** Delivery projection enforces visibility; archival callers cannot opt it out with a flag. */
export function buildBoundOfficeVisibleParts(args={}){
  const facts=deriveBoundOfficeVisibilityFacts(args);
  if(!facts.ok||facts.visibility_errors.length)return {ok:false,parts:null,transformations:[],errors:facts.ok?facts.visibility_errors:facts.errors};
  return {ok:true,parts:facts.parts,transformations:facts.transformations,errors:[]};
}

function mappingPathMatches(sourceRecord,parsed,source,evidence){
  const p=parsed.parser_locator;
  if(source.kind==='docx'){
    if(sourceRecord.record.locator.part!=='word/document.xml')return false;
    const sourcePath=sourceRecord.record.locator.xml_path.replace(/^\/document\[1\]\/body\[1\]/,'').replaceAll('/tbl[','/table[').replaceAll('/tc[','/td[');
    if(!p.html_path)return sourcePath===`/p[${p.text_index}]`;
    // XML cell properties are source context, not proof of an arbitrary HTML span.
    const cellPath=sourceRecord.record.ancestry?.filter(x=>/\/tc\[\d+\]$/.test(x)).at(-1),cell=evidence.records.find(r=>r.kind==='cell'&&r.locator.xml_path===cellPath);
    const spans=cell?.structure?.properties?.filter(p=>p.name==='gridSpan')??[];
    if(spans.length>1||cell?.structure?.properties?.some(p=>p.name==='vMerge'))return false;
    const expected=Number(spans[0]?.attributes?.['{http://schemas.openxmlformats.org/wordprocessingml/2006/main}val']??1);
    if(parsed.binding.html_colspan!==expected||parsed.binding.html_rowspan!==1)return false;
    return sourcePath===p.html_path.replace(/^\/table\[1\]/,`/table[${p.table_index}]`).replaceAll('/th[','/td[');
  }
  if(evidence.coverage?.sheets?.length!==1||evidence.coverage.sheets[0].merged_ranges?.length||p.table_index!==1)return false;
  const match=/^\/table\[1\]\/(?:tbody\[1\]\/)?tr\[(\d+)\]\/(?:td|th)\[(\d+)\](?:\/p\[1\])?$/.exec(p.html_path??'');
  return !!match&&sourceRecord.record.row===Number(match[1])&&sourceRecord.record.column===Number(match[2]);
}

function mapWorkbookSource(parsed,sourceRecords,source,evidence,allowTrailingColumns=false){
  if(evidence.coverage?.sheets?.length!==1||parsed.frames.length!==1)return;
  const frame=parsed.frames[0],sheet=evidence.coverage.sheets[0],coord=s=>{const m=/^([A-Z]+)([1-9][0-9]*)$/.exec(s??'');if(!m)return null;let c=0;for(const t of m[1])c=c*26+t.charCodeAt(0)-64;return{row:Number(m[2]),column:c};};
  const bounds=sheet.range.split(':'),low=coord(bounds[0]),high=coord(bounds.at(-1));
  if(!frame.valid||!low||!high||frame.rows>high.row-low.row+1||frame.columns>high.column-low.column+1)return;
  const lastParsedColumn=low.column+frame.columns-1;
  if(lastParsedColumn<high.column){
    if(!allowTrailingColumns)return;
    const tail=sourceRecords.filter(o=>o.record.column>lastParsedColumn);
    if(!tail.length||tail.some(o=>o.record.state!=='format_only'||o.record.text!==null||o.record.raw_value!==null||o.record.formula?.present||o.record.cache?.element_present||o.record.merges?.length))return;
    const occupied=new Set(sourceRecords.filter(o=>o.record.column<=lastParsedColumn&&o.record.state!=='format_only').map(o=>o.record.column));
    for(let column=low.column;column<=lastParsedColumn;column++)if(!occupied.has(column))return;
  }
  const lastParsedRow=low.row+frame.rows-1;
  if(lastParsedRow<high.row){
    const tail=sourceRecords.filter(o=>o.record.row>lastParsedRow);
    if(!tail.length||tail.some(o=>o.record.state!=='format_only'||o.record.text!==null||o.record.raw_value!==null||o.record.formula?.present||o.record.cache?.element_present))return;
    // Do not explain dropped leading/interior empty rows as a verified trailing extent.
    const occupied=new Set(sourceRecords.filter(o=>o.record.row<=lastParsedRow&&o.record.state!=='format_only').map(o=>o.record.row));
    for(let row=low.row;row<=lastParsedRow;row++)if(!occupied.has(row))return;
  }
  const address=(r,c)=>{let s='';while(c){c--;s=String.fromCharCode(65+c%26)+s;c=Math.floor(c/26);}return s+r;};
  const mergeRanges=frame.cells.filter(c=>c.range.end_row!==c.range.start_row||c.range.end_column!==c.range.start_column).map(c=>address(c.range.start_row+low.row-1,c.range.start_column+low.column-1)+':'+address(c.range.end_row+low.row-1,c.range.end_column+low.column-1));
  if(!same([...mergeRanges].sort(),[...(sheet.merged_ranges??[])].sort()))return;
  const byPath=new Map(parsed.map(o=>[o.parser_locator.json_pointer+'#'+o.parser_locator.html_path,o]));
  const frameHash=hash({rows:frame.rows,columns:frame.columns,merged_ranges:mergeRanges});
  for(const src of sourceRecords){
    const r=src.record,rr=r.row-low.row+1,cc=r.column-low.column+1;
    if(r.row>lastParsedRow||r.column>lastParsedColumn)continue; // Source evidence retains these cells; the parser did not observe them.
    const cell=frame.rowCells[rr-1]?.find(c=>cc>=c.range.start_column&&cc<=c.range.end_column);if(!cell)return;
    const anchor=cell.range.start_row===rr&&cell.range.start_column===cc;
    let observed=anchor&&cell.paragraph_paths.length===1?byPath.get(frame.json_pointer+'#'+cell.paragraph_paths[0]):null;
    if(!observed){observed={id:source.document_id+'#frame#'+r.id,document_id:source.document_id,kind:'workbook_cell',origin:'derived_source_mapping',locator:copy(src.locator),parser_locator:{json_pointer:frame.json_pointer,html_path:cell.node.path,table_index:frame.table_index,text_index:null},mapping_status:'mapped',text:null,record:null,binding:{}};parsed.push(observed);}
    const value=anchor?cell.text:null,record=copy(r);
    record.text=r.text===null&&value===''?null:value;
    if(record.state==='value'&&record.xml_type!=='s'&&record.xml_type!=='inlineStr'){record.raw_value=value;record.cache.raw_value=value;}
    observed.origin='derived_source_mapping';observed.locator=copy(src.locator);observed.mapping_status='mapped';observed.text=record.text;observed.record=record;
    observed.binding={...observed.binding,source_sha256:source.source_sha256,mapping_evidence:src.binding.evidence_fingerprint,html_frame_fingerprint:frameHash,html_range:copy(cell.range),source_context_only_fields:['sheet','xml_type','style_index','formula','cache','state'],formula_observed:false};
  }
}

/** Synchronous deterministic core also used by the consuming validator to replay provenance. */
function constructWholePaperPayload({sources,pdfRun,pdfDerivation,officePayloads,parserConfig,approval,requiredCoverage,side}={}){
  try{
    if(pdfDerivation!==undefined){
      if(side!=='candidate'||!pdfDerivation||!same(Object.keys(pdfDerivation).sort(),['parent_run','proof']))fail('WHOLE_PAPER_PDF_DERIVATION_INVALID');
      const derived=deriveSourceLiteralPdfRun(pdfDerivation.parent_run,pdfDerivation.proof);
      if(!same(derived,pdfRun))fail('WHOLE_PAPER_PDF_DERIVATION_MISMATCH');
    }else if(pdfRun?.normalization_version?.includes(SOURCE_LITERAL_PDF_SUFFIX))fail('WHOLE_PAPER_PDF_DERIVATION_REQUIRED');
    if(Object.hasOwn(parserConfig??{},'workbook_mapping_rules')&&parserConfig.workbook_mapping_rules!=='verified-trailing-format-columns-1')fail('WHOLE_PAPER_MAPPING_RULE_INVALID');
    if(!Array.isArray(sources)||!sources.length||!Array.isArray(officePayloads)||!Array.isArray(requiredCoverage)||!['baseline','candidate'].includes(side)||!parserConfig||!/^sha256:[a-f0-9]{64}$/.test(approval?.fingerprint??''))fail('WHOLE_PAPER_INPUT_INVALID');
    if(new Set(sources.map(s=>s.document_id)).size!==sources.length||new Set(officePayloads.map(p=>p.document_id)).size!==officePayloads.length||new Set(requiredCoverage.map(s=>s.document_id)).size!==sources.length)fail('WHOLE_PAPER_SOURCE_SET_MISMATCH');
    const observations=[],coverage=[],capabilities=[],payloads=[];let recordBytes=0;
    for(const source of sources){
      const required=requiredCoverage.find(c=>c.document_id===source.document_id);
      if(!required||required.kind!==source.kind||required.purpose!==source.purpose)fail('WHOLE_PAPER_COVERAGE_SET_MISMATCH');
      if(source.purpose==='catalogue_only'){
        if(source.kind!=='pdf'||!required.reason)fail('WHOLE_PAPER_CATALOGUE_SCOPE_INVALID');
        coverage.push({document_id:source.document_id,status:'catalogue_only',scope_fingerprint:hash(required),reason:required.reason});continue;
      }
      if(source.kind==='pdf'){
        const old=pdfRun?.sources?.find(s=>s.document_id===source.document_id);
        if(!old||old.source_sha256!==source.source_sha256)fail('WHOLE_PAPER_PDF_BINDING_MISMATCH');
        coverage.push({document_id:source.document_id,status:'read',scope_fingerprint:hash(required),reason:''});continue;
      }
      const p=officePayloads.find(p=>p.document_id===source.document_id);
      if(!p){coverage.push({document_id:source.document_id,status:'not_read',scope_fingerprint:hash(required),reason:'No supplied parser output'});continue;}
      if(sha(bytes(p.source_bytes))!==source.source_sha256)fail('WHOLE_PAPER_SOURCE_BINDING_MISMATCH');
      if(source.format==='xls'&&p.xls_parser_evidence?.profile===ORIGINAL_XLS_PARSER_PROFILE){
        const original=validateOriginalXlsSourceEvidence({source,sourceBytes:p.source_bytes,evidence:p.source_evidence});
        if(!original.ok)fail(original.errors[0]);
        const column=n=>{let s='';for(;n;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s;};
        const full=required.sheets?.map(s=>({index:s.index,name:s.name,range:column(s.range.start_column)+s.range.start_row+':'+column(s.range.end_column)+s.range.end_row}));
        if(required.scope_complete!==true||!same(full,original.evidence.coverage.sheets.map(s=>({index:s.index,name:s.name,range:s.range}))))fail('WHOLE_PAPER_SOURCE_COVERAGE_INCOMPLETE');
        const parsed=validateOriginalXlsParserEvidence({source,sourceBytes:p.source_bytes,sourceEvidence:original.evidence,parserOutputBytes:p.parser_output_bytes,parserBinding:p.parser_binding,evidence:p.xls_parser_evidence});
        if(!parsed.ok)fail(parsed.errors[0]);
        if(side==='candidate')for(const observation of original.observations)observations.push(observation);
        for(const observation of parsed.observations)observations.push(observation);
        payloads.push({document_id:source.document_id,source_evidence:copy(original.evidence),source_bytes_base64:bytes(p.source_bytes).toString('base64'),parser_output_base64:bytes(p.parser_output_bytes).toString('base64'),parser_binding:copy(p.parser_binding),xls_parser_evidence:copy(parsed.evidence)});
        recordBytes+=Buffer.byteLength(JSON.stringify(payloads.at(-1)));
        if(recordBytes>512*1024*1024)fail('WHOLE_PAPER_RECORD_LIMIT');
        coverage.push({document_id:source.document_id,status:'read',scope_fingerprint:hash(required),reason:'Exact saved three-XLS parser grid; source-only records and representation differences retained'});
        capabilities.push({document_id:source.document_id,backend:'mineru',status:'observed',native_mapping:'derived_source_mapping',original_format_support:'qualified_saved_grid_only',profile:ORIGINAL_XLS_PARSER_PROFILE,scientific_eligible:false,independent_backend:false});
        continue;
      }
      if(source.format==='xls'){
        const original=validateDerivedWorkbookEvidence({source,sourceBytes:p.source_bytes,evidence:p.source_evidence});
        if(!original.ok)fail(original.errors[0]);
        if(!validateDerivedWorkbookCoverage(original.evidence,required))fail('WHOLE_PAPER_SOURCE_COVERAGE_INCOMPLETE');
        const derived=deriveWorkbookParserObservations({source,sourceBytes:p.source_bytes,evidence:original.evidence,parserOutputBytes:p.parser_output_bytes,parserBinding:p.parser_binding});
        if(!derived.ok)fail(derived.errors[0]);
        if(side==='candidate')observations.push(...original.observations);
        observations.push(...derived.observations);
        payloads.push({document_id:source.document_id,source_evidence:copy(original.evidence),source_bytes_base64:bytes(p.source_bytes).toString('base64'),parser_output_base64:bytes(p.parser_output_bytes).toString('base64'),parser_binding:copy(p.parser_binding)});
        recordBytes+=Buffer.byteLength(JSON.stringify(payloads.at(-1)));
        if(recordBytes>512*1024*1024)fail('WHOLE_PAPER_RECORD_LIMIT');
        coverage.push({document_id:source.document_id,status:'read',scope_fingerprint:hash(required),reason:'Qualified derivative observed; original format fidelity limits retained'});
        capabilities.push({document_id:source.document_id,backend:'mineru',status:'observed',native_mapping:'derived_source_mapping',original_format_support:'qualified_derivative_only',derivation:copy(original.evidence.derivation)});
        continue;
      }
      const parsed=parserObservations(p,source);
      if(p.source_evidence){
        const evidence=validateSourceEvidence(p,source),sourceRecords=sourceObservations(evidence,source);
        if(side==='candidate')for(const observation of sourceRecords)observations.push(observation);
        // DOCX uses exact ordered text/path evidence; workbook mapping requires a complete HTML frame.
        // Workbook text remains the observed HTML value, including mismatches; no source value fills baseline.
        const textRecords=sourceRecords.filter(r=>source.kind==='docx'?r.kind==='paragraph':r.kind==='workbook_cell'&&r.record.state==='value');
        if(source.kind==='workbook')mapWorkbookSource(parsed,sourceRecords,source,evidence,parserConfig.workbook_mapping_rules==='verified-trailing-format-columns-1');
        if(source.kind==='docx'&&textRecords.length===parsed.length&&textRecords.every((r,n)=>r.text===parsed[n].text&&mappingPathMatches(r,parsed[n],source,evidence))){
          parsed.forEach((o,n)=>{o.locator=copy(textRecords[n].locator);o.mapping_status='mapped';o.origin='derived_source_mapping';o.record=copy(textRecords[n].record);o.binding.mapping_evidence=hash(evidence);});
        }
        payloads.push({document_id:source.document_id,source_evidence:copy(evidence),source_bytes_base64:bytes(p.source_bytes).toString('base64'),parser_output_base64:bytes(p.parser_output_bytes).toString('base64'),parser_binding:copy(p.parser_binding)});
      }else payloads.push({document_id:source.document_id,source_bytes_base64:bytes(p.source_bytes).toString('base64'),source_evidence:null,parser_output_base64:bytes(p.parser_output_bytes).toString('base64'),parser_binding:copy(p.parser_binding)});
      for(const observation of parsed)observations.push(observation);
      recordBytes+=Buffer.byteLength(JSON.stringify(payloads.at(-1)));
      if(recordBytes>512*1024*1024||Buffer.byteLength(JSON.stringify(payloads.at(-1)))>256*1024*1024)fail('WHOLE_PAPER_RECORD_LIMIT');
      coverage.push({document_id:source.document_id,status:'read',scope_fingerprint:hash(required),reason:''});
      capabilities.push({document_id:source.document_id,backend:'mineru',status:'observed',native_mapping:parsed.every(p=>p.mapping_status==='mapped')?'derived_source_mapping':'unmapped'});
    }
    if(officePayloads.some(p=>!sources.some(s=>s.document_id===p.document_id&&['docx','workbook'].includes(s.kind)&&s.purpose==='content')))fail('WHOLE_PAPER_SOURCE_SET_MISMATCH');
    const run={schema_version:'phase21-parser-run-whole-paper-1.0',parser_run_id:'sha256:'+'0'.repeat(64),side,sources:copy(sources),required_coverage:copy(requiredCoverage),source_coverage:coverage,capabilities,pdf_run:pdfRun?copy(pdfRun):null,office_observations:observations,provenance:{method:pdfDerivation!==undefined?'source_reviewed_pdf_and_mineru_source_evidence_hybrid':side==='baseline'?'saved_mineru_observations':'mineru_source_evidence_hybrid',independent_backend:false,shared_reader:side==='candidate',new_backend_execution:false,approval_scope:approval.scope??'unspecified',parser_config:copy(parserConfig),office_payloads:payloads,...(pdfDerivation===undefined?{}:{pdf_derivation:copy(pdfDerivation)})},resource_observations:[],config_fingerprint:hash(parserConfig),approval_fingerprint:approval.fingerprint};
    const {parser_run_id,...identity}=run;run.parser_run_id=hash(identity);
    if(!shape(run))fail('WHOLE_PAPER_RUN_STRUCTURE_INVALID');
    return {ok:true,run,errors:[]};
  }catch(error){return {ok:false,run:null,errors:[error.message]};}
}

/** Records supplied bytes only. Never reads files, invokes a parser or consumes a reference. */
export async function translateWholePaperPayload(input){return constructWholePaperPayload(input);}

/** Public comparison is synchronous, so provenance replay must not introduce an async bypass. */
export function replayWholePaperRun(run){
  try{return constructWholePaperPayload({sources:run.sources,pdfRun:run.pdf_run,pdfDerivation:run.provenance.pdf_derivation,officePayloads:run.provenance.office_payloads.map(p=>({document_id:p.document_id,source_bytes:Buffer.from(p.source_bytes_base64,'base64'),parser_output_bytes:Buffer.from(p.parser_output_base64,'base64'),parser_binding:p.parser_binding,source_evidence:p.source_evidence,...(p.xls_parser_evidence===undefined?{}:{xls_parser_evidence:p.xls_parser_evidence})})),parserConfig:run.provenance.parser_config,approval:{fingerprint:run.approval_fingerprint,scope:run.provenance.approval_scope},requiredCoverage:run.required_coverage,side:run.side});}
  catch{return {ok:false,run:null,errors:['WHOLE_PAPER_RUN_REPLAY_MISMATCH']};}
}
