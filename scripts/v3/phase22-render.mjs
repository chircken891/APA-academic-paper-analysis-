import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fingerprintV3Json as hash } from './semantic-package-validator.mjs';
import { getReadingBasisContent, readPhase22SourceAsset, resolvePhase22ImmutableRange } from './phase22-input.mjs';
import { PHASE22_REGIONS, assertFrozenRenderContext, assertPhase22TargetRegistry } from './phase22-render-context.mjs';
import { collectLanguageSpans, getAcceptedLanguageRecord } from './phase22-language.mjs';
import { assertBilingualParity } from './phase22-parity.mjs';
import { renderReaderNotes, READER_PROFILE } from './phase221-presentation.mjs';

const renders = new WeakMap();
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const fail = (code, path = '/', details = {}) => { throw Object.assign(new Error(code), { code, path, details, owner: 'Integrator' }); };
const heading = {
 en: ['Source','Structured Abstract','Research Question and Study Design','Key Findings','Methods, Concepts, and Measures','Figures and Tables','Discussion','Limitations','Conclusion and Practical Implications','Evidence','Relation Ledger','Coverage Report'],
 'zh-CN': ['来源','结构化摘要','研究问题与研究设计','主要发现','方法、概念与测量','图、表与公式','讨论','局限','结论与实践含义','证据','关系台账','覆盖报告'],
};
const dutySections = ['abstract','key-findings','study-design','study-design','study-design','study-design','methods-concepts-measures','methods-concepts-measures','methods-concepts-measures','key-findings','conclusion','limitations','discussion','discussion','relations','discussion'];
function scientificMap(science) {
 return new Map([['records','semantic_unit_id'],['claims','claim_id'],['quantities','quantity_id'],['statements','statement_id'],['explanations','explanation_id'],['research_candidates','candidate_id']]
  .flatMap(([collection,id]) => science.scientific_details[collection].map(row => [row[id],{collection,row}])));
}
function sectionFor(item, fallback) {
 if(!item)return fallback;
 if(item.collection==='records')return dutySections[Number(item.row.obligation_id.slice(3))-1] ?? fallback;
 return {claims:'key-findings',quantities:'key-findings',statements:'discussion',explanations:'methods-concepts-measures',research_candidates:'discussion'}[item.collection] ?? fallback;
}
const escapeRegex = value => value.replace(/[.*+?^$(){}|[\]\\]/g,'\\$&');
function protectedTextParts(text) {
 const ranges=[];
 const pattern=/\x60[^\x60]*\x60|https?:\/\/[^\s)]+|\[\[[^\]]+\]\]|\$[^$]+\$|\^[A-Za-z0-9-]+|\]\[[^\]]*\]|^\s*\[[^\]]+\]:[^\n]+/gm;
 for(const match of text.matchAll(pattern))ranges.push({from:match.index,to:match.index+match[0].length});
 // Link labels are analyst text; only their destination/title parentheses are immutable.
 for(let start=0;start<text.length-1;start++){
  if(text[start]!==']'||text[start+1]!=='(')continue;
  let depth=1,inAngle=false,end=start+2;
  for(;end<text.length;end++){
   if(text[end]==='\\'){end++;continue;}
   if(text[end]==='<')inAngle=true;
   else if(text[end]==='>')inAngle=false;
   else if(!inAngle && text[end]==='(')depth++;
   else if(!inAngle && text[end]===')' && --depth===0){end++;break;}
  }
  if(depth===0){ranges.push({from:start,to:end});start=end-1;}
 }
 ranges.sort((a,b)=>a.from-b.from||b.to-a.to);
 const merged=[];
 for(const range of ranges){
  const last=merged.at(-1);
  if(last&&range.from<=last.to)last.to=Math.max(last.to,range.to);
  else merged.push({...range});
 }
 const parts=[];let cursor=0;
 for(const range of merged){parts.push(text.slice(cursor,range.from),text.slice(range.from,range.to));cursor=range.to;}
 parts.push(text.slice(cursor));
 return parts;
}
function sourceOrderedVisualRows(rows,science,basis) {
 const blocks=science.scientific_details.source_blocks;
 const blockOrder=new Map(blocks.map((block,index)=>[block.source_block_id,index]));
 const order=row=>{
  if(row.span.kind==='asset'){
   const asset=basis.source_presentation?.assets.find(x=>x.asset_id===row.span.immutable_ref?.id);
   return asset?[asset.source_order,0]:undefined;
  }
  if(row.span.immutable_ref?.authority==='source_block'){
   const block=blockOrder.get(row.span.immutable_ref.id);
   return block===undefined?undefined:[block,row.span.immutable_ref.start];
  }
  const visuals=science.scientific_details.inventory.filter(item=>item.affected_ids.some(id=>row.span.semantic_refs.includes(id)));
  const indices=visuals.flatMap(item=>item.source_block_ids).map(id=>blockOrder.get(id)).filter(index=>index!==undefined);
  return indices.length?[Math.min(...indices),0]:undefined;
 };
 const sortable=rows.map((row,index)=>({row,index,sourceOrder:order(row)})).filter(entry=>entry.sourceOrder!==undefined);
 const sorted=[...sortable].sort((a,b)=>a.sourceOrder[0]-b.sourceOrder[0]||a.sourceOrder[1]-b.sourceOrder[1]||a.index-b.index);
 const output=[...rows];
 sortable.forEach((entry,index)=>{output[entry.index]=sorted[index].row;});
 return output;
}
function presentationPayload(span,basis,assets,plain) {
 if(span.kind==='asset'){
  const asset=assets.find(x=>x.asset_id===span.immutable_ref?.id);
  if(!asset||span.text!==asset.target_path||span.asset_refs?.length!==1||span.asset_refs[0]!==asset.asset_id)fail('P22_ASSET_REFERENCE_INVALID');
  return '![['+asset.target_path+']]';
 }
 if(['formula','code'].includes(span.kind)){
  const range=resolvePhase22ImmutableRange(basis,span.immutable_ref?.classification_id);
  if(range.kind!==span.kind||range.text!==span.text||range.source_block_id!==span.immutable_ref.id
   ||range.start!==span.immutable_ref.start||range.end!==span.immutable_ref.end)fail('P22_IMMUTABLE_VALUE_MISMATCH');
  if(span.kind==='formula')return '$$\n'+range.text+(range.text.endsWith('\n')?'':'\n')+'$$';
  const ticks=String.fromCharCode(96),fence=ticks.repeat(Math.max(3,...[...range.text.matchAll(/`+/g)].map(x=>x[0].length+1)));
  return fence+'\n'+range.text+(range.text.endsWith('\n')?'':'\n')+fence;
 }
 return plain;
}
/** Per-region state, shared across paragraphs and subheadings. */
export function expandPhase22Span(span, {context, language, seen}) {
 if(!['analysis','link_label'].includes(span.kind))return span.text;
 const parts=protectedTextParts(span.text);
 return parts.map((part,i)=>{
  if(i%2)return part;
  const matches=[];
  for(const term of context.terminology_ledger){
   const forms=[term.abbreviation,...term.aliases.en.filter(x=>x.toLowerCase().startsWith(term.abbreviation.toLowerCase()))];
   for(const form of new Set(forms)){
    const regex=new RegExp('(?<![\\p{L}\\p{N}_])'+escapeRegex(form)+'(?![\\p{L}\\p{N}_])','giu');
    for(const match of part.matchAll(regex))matches.push({start:match.index,end:match.index+match[0].length,term,value:match[0]});
   }
  }
  matches.sort((a,b)=>a.start-b.start || b.end-a.end);
  let output='',cursor=0;
  for(const match of matches){
   if(match.start<cursor)continue;
   const candidates=matches.filter(x=>x.start===match.start&&x.end===match.end);
   const selected=candidates.filter(x=>span.term_refs.includes(x.term.term_id));
   const terms=[...new Map((selected.length?selected:candidates).map(x=>[x.term.term_id,x.term])).values()];
   if(terms.length!==1)fail('P22_TERM_SENSE_AMBIGUOUS','/spans/'+span.span_id);
   const term=terms[0];output+=part.slice(cursor,match.start);
   const prefix=part.slice(0,match.start);
   const alreadyExpanded=language==='en'
    ? prefix.toLowerCase().endsWith((term.en_full_form+' (').toLowerCase())&&part[match.end]===')'
    : prefix.endsWith((term.zh_full_form?term.zh_full_form+'（'+term.en_full_form+'，':term.en_full_form+'（'))&&part[match.end]==='）';
   if(alreadyExpanded){output+=match.value;seen.add(term.term_id);}
   else if(seen.has(term.term_id))output+=match.value;
   else{
    if(!term.en_full_form || language==='zh-CN'&&!term.zh_full_form&&term.translation.status!=='no_stable_translation')fail('P22_TERM_DEFINITION_MISSING');
    output+=language==='en'?term.en_full_form+' ('+match.value+')'
      :(term.zh_full_form?term.zh_full_form+'（'+term.en_full_form+'，'+match.value+'）':term.en_full_form+'（'+match.value+'）');
    seen.add(term.term_id);
   }
   cursor=match.end;
  }
  return output+part.slice(cursor);
 }).join('');
}
function serializeSnapshot(value) {
 if(Buffer.isBuffer(value)||value instanceof Uint8Array)return {byte_sha256:sha(value),byte_length:value.length};
 if(Array.isArray(value))return value.map(serializeSnapshot);
 if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,serializeSnapshot(v)]));
 return value;
}
function freezeMetadata(value) {
 if(!value || typeof value!=='object' || Buffer.isBuffer(value))return value;
 for(const item of Object.values(value))freezeMetadata(item);
 return Object.freeze(value);
}
function supports(context, views, existingSupportRefs) {
 if(!isDeepStrictEqual(existingSupportRefs,context.existingSupportRefs))fail('P22_EXISTING_SUPPORT_CONFLICT','/existingSupportRefs');
 assertPhase22TargetRegistry(context.entityMappings);
 return context.entityMappings.map(entity=>{
  const definitions=Object.fromEntries(['en','zh-CN'].map(language=>{
   const spans=collectLanguageSpans(views[language]).map(x=>x.span);
   const text=entity.definition_unit_refs.map(id=>{
    const matches=spans.filter(span=>span.semantic_refs.includes(id)&&span.kind==='analysis'&&!span.explain_only);
    if(!matches.length)fail('P22_ENTITY_DEFINITION_REQUIRED','/entityMappings/'+entity.entity_id,{entity_id:entity.entity_id,revision_owner:'Integrator',missing_definition:id,language});
    return matches.map(span=>span.text).join('\n\n');
   }).join('\n\n');
   return [language,text];
  }));
  const descriptor={entity_id:entity.entity_id,entity_type:entity.entity_type,canonical_key:entity.canonical_key,storage_key:entity.storage_key,target_path:entity.target_path,
   definition_unit_refs:[...entity.definition_unit_refs],labels:structuredClone(entity.labels),aliases:structuredClone(entity.aliases),
   source_refs:[...entity.source_refs],scope:entity.scope,limitations:[...entity.limitations],definition_fingerprint:entity.definition_fingerprint,disposition:entity.disposition};
  if(entity.disposition==='reuse'){
   const ref=existingSupportRefs.find(x=>x.entity_id===entity.entity_id);
   if(!ref || ref.target_path!==entity.target_path || ref.definition_fingerprint!==entity.definition_fingerprint)fail('P22_EXISTING_SUPPORT_CONFLICT');
   return {...descriptor,byte_sha256:ref.byte_sha256};
  }
  const metadata={type:entity.entity_type==='method'?'method':'concept',pipeline_version:'3.0',rendering_profile:'phase22-support-note-1.0',
   status:'candidate',graph_scope:'v3-candidate',entity_id:entity.entity_id,entity_type:entity.entity_type,canonical_key:entity.canonical_key,
   definition_fingerprint:entity.definition_fingerprint,definition_unit_refs:entity.definition_unit_refs,source_refs:entity.source_refs,scope:entity.scope};
  const text='---\n'+Object.entries(metadata).map(([k,v])=>k+': '+JSON.stringify(v)).join('\n')+'\n---\n# '+entity.labels.en+' / '+entity.labels['zh-CN']
   +'\n\n## Definition (English)\n\n'+definitions.en+'\n\n## 中文定义\n\n'+definitions['zh-CN']
   +'\n\n## Scope / 适用范围\n\n'+entity.scope+'\n\n## Limitations / 局限\n\n'+entity.limitations.map(x=>'- '+x).join('\n')
   +'\n\n## Source references / 来源\n\n'+entity.source_refs.map(x=>'- '+x).join('\n')+'\n';
  const bytes=Buffer.from(text,'utf8');
  return {...descriptor,bytes,byte_sha256:sha(bytes)};
 });
}
export { supports as renderPhase22SupportNotes };
/** Pure candidate producer. No Wiki, parser, model or external write. */
export function renderBilingualNotes(options={}) {
 // An already-frozen P22 context retains its historical synchronous profile.
 // New candidates enter with `input` and default to the asynchronous reader producer.
 const {basis,context,views,parity,existingSupportRefs=context?.existingSupportRefs}=options;
 // `profile` already names an upstream scientific-analysis object in existing callers.
 // Rendering dispatch therefore has its own explicit string option.
 const profile=options.renderingProfile ?? (options.input ? READER_PROFILE : 'phase22-managed-note-1.0');
 if(profile===READER_PROFILE)return renderReaderNotes({...options,input:options.input??{basis,context,views,parity}});
 if(profile!=='phase22-managed-note-1.0')fail('P221_PROFILE_UNKNOWN');
 assertBilingualParity(parity,{basis,context,views});
 assertFrozenRenderContext(context,basis);
 const science=getReadingBasisContent(basis),records=scientificMap(science);
 const supportNotes=supports(context,views,existingSupportRefs),semantic_spans=[];
 const assets=(basis.source_presentation?.assets??[]).map(entry=>{
  const {source_path,...asset}=readPhase22SourceAsset(basis,entry.asset_id);
  return asset;
 }).sort((a,b)=>a.source_order-b.source_order||a.asset_id.localeCompare(b.asset_id));
 const output={supportNotes,assets,semantic_spans,paper_targets:{...context.paper_targets},evidence_mode:parity.evidence_mode,review_ready:parity.review_ready};
 for(const language of ['en','zh-CN']){
  const view=views[language],meta=getAcceptedLanguageRecord(view),other=language==='en'?'zh-CN':'en';
  const machine={type:'paper',pipeline_version:'3.0',rendering_profile:'phase22-managed-note-1.0',...basis.identity,language,
   title:science.source_package.paper_label,aliases:[],basis_fingerprint:basis.basis_fingerprint,context_fingerprint:context.context_fingerprint,
   core_fingerprint:hash(science.core),view_fingerprint:meta.view_fingerprint,
   parity_fingerprint:parity.parity_fingerprint,scientific_completeness:basis.scientific_completeness,evidence_mode:parity.evidence_mode,
   review_ready:parity.review_ready,graph_scope:'v3-candidate',alternate_language_path:context.paper_targets[other]};
  const rows=collectLanguageSpans(view).map(row=>{
   const destinations=[...new Set(row.span.semantic_refs.map(id=>sectionFor(records.get(id),row.section_id)))];
   // A reviewed combined span stays whole; choose its declared matching destination, otherwise its first obligation.
   return {...row,section_id:destinations.includes(row.section_id)?row.section_id:(destinations[0]??row.section_id)};
  });
  let text='---\n'+Object.entries(machine).filter(([,v])=>v!==undefined).map(([k,v])=>k+': '+JSON.stringify(v)).join('\n')+'\n---\n\n';
  const emittedAnchors=new Set();
  for(const [i,id]of PHASE22_REGIONS.entries()){
   const seen=new Set();
   text+='<!-- AUTO:START '+id+' -->\n## '+heading[language][i]+'\n\n';
   if(id==='source'){
    text+='[['+context.paper_targets[other]+'|'+(language==='en'?'中文阅读入口':'English')+']]\n\n';
    for(const document of science.source_package.source_documents)text+=document.source_label+' — '+document.source_document_id+' — '+document.source_hash+'\n\n';
    for(const key of ['doi','pmid'])if(science.source_package[key])text+=key.toUpperCase()+': '+science.source_package[key]+'\n\n';
   }
   if(id==='methods-concepts-measures')for(const [ordinal,s]of supportNotes.entries())text+=(ordinal+1)+'. [['+s.target_path+'|'+s.labels[language]+']]\n\n';
   const sectionRows=rows.filter(x=>x.section_id===id);
   for(const row of id==='figures-tables'?sourceOrderedVisualRows(sectionRows,science,basis):sectionRows){
    let payload=expandPhase22Span(row.span,{context,language,seen});
    if(/<!--\s*AUTO:|^---\s*$|^## (?:Personal Notes|个人备注)\s*$/m.test(payload))fail('P22_RENDER_MARKER_INJECTION','/spans/'+row.span.span_id);
    if(['analysis','link_label','link_target'].includes(row.span.kind) && /(?:\]\(\s*|\[\[\s*|<\s*)(?:javascript|data|vbscript):/i.test(payload))fail('P22_UNSAFE_LINK','/spans/'+row.span.span_id);
    if(row.span.kind!=='code' && /!\[\[|!\[[^\]]*\]\(/.test(payload))fail('P22_ASSET_CONTRACT_REQUIRED','/spans/'+row.span.span_id,{revision_owner:'Integrator'});
    payload=presentationPayload(row.span,basis,assets,payload);
    const anchor='p-'+hash({span_id:row.span.span_id}).slice(7,31);
    const from=Buffer.byteLength(text);text+=payload;
    const to=Buffer.byteLength(text);
    const separateAnchor=['asset','formula','code'].includes(row.span.kind)||/^\s*(?:[-+*]|\d+[.)])\s|^\s*\|/m.test(payload);
    text+=(separateAnchor?'\n\n^':' ^')+anchor+'\n\n';
    for(const ref of [...row.span.semantic_refs,...row.span.boundary_refs,...(row.span.immutable_ref?.authority==='source_block'?[row.span.immutable_ref.id]:[])]){
     const mapping=context.anchorMappings.find(x=>x.semantic_id===ref);
     if(mapping&&!emittedAnchors.has(mapping.anchor)){text+='[[#^'+anchor+'|'+ref+']] ^'+mapping.anchor+'\n\n';emittedAnchors.add(mapping.anchor);}
    }
    semantic_spans.push({language,section_id:id,paragraph_id:row.paragraph_id,span_id:row.span.span_id,
     semantic_ids:[...row.span.semantic_refs],claim_ids:[...row.span.claim_refs],evidence_ids:[...row.span.evidence_refs],boundary_ids:[...row.span.boundary_refs],anchor,from,to,text:payload});
   }
   if(id==='figures-tables'){
    const blocks=science.scientific_details.source_blocks,order=entry=>Math.min(...entry.source_block_ids.map(ref=>blocks.findIndex(x=>x.source_block_id===ref)));
    for(const visual of [...science.scientific_details.inventory].sort((a,b)=>order(a)-order(b)))text+=visual.kind+' — '+visual.inventory_id+' — '+visual.status+' — '+visual.source_block_ids.join(', ')+'\n\n';
   }
   if(id==='evidence')for(const evidence of science.core.evidence){
    const anchor=context.anchorMappings.find(x=>x.semantic_id===evidence.evidence_id)?.anchor;
    text+=evidence.evidence_id+' — '+JSON.stringify(evidence.locator)+(anchor&&!emittedAnchors.has(anchor)?' ^'+anchor:'')+'\n\n> '+evidence.extracted_text.split('\n').join('\n> ')+'\n\n';
    if(anchor)emittedAnchors.add(anchor);
   }
   if(id==='relations')for(const relation of science.core.relations??[])text+=JSON.stringify(relation)+'\n\n';
   if(id==='coverage')for(const covered of view.coverage)text+=covered.semantic_id+' — '+covered.status+' — '+covered.reason+'\n\n';
   text+='<!-- AUTO:END '+id+' -->\n\n';
  }
  text+='## '+(language==='en'?'Personal Notes':'个人备注')+'\n';
  output[language==='en'?'en':'zhCN']=Buffer.from(text,'utf8');
 }
 freezeMetadata(output);
 renders.set(output,{basis,context,views,parity,snapshot:hash(serializeSnapshot(output))});
 return output;
}
export function assertRenderedBilingualNotes(rendered,{basis,context,views,parity}={}) {
 assertBilingualParity(parity,{basis,context,views});
 const record=renders.get(rendered);
 if(!record || record.basis!==basis || record.context!==context || record.parity!==parity || record.views.en!==views.en || record.views['zh-CN']!==views['zh-CN'])fail('P22_RENDER_BINDING_INVALID');
 if(hash(serializeSnapshot(rendered))!==record.snapshot)fail('P22_RENDER_BYTES_CHANGED');
 return rendered;
}




