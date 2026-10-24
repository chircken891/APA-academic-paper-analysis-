import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import {fingerprintV3Json as fp} from './semantic-package-validator.mjs';
import {createParserRunRecord,deriveParserRunIdentity} from './parser-adapter.mjs';

export const SOURCE_LITERAL_PDF_PROFILE='source-literal-pdf-corrections-1';
export const SOURCE_LITERAL_PDF_SUFFIX='+source-literal-reviewed-1';
export const SOURCE_BOUND_PDF_PROFILE='source-bound-pdf-corrections-2';
export const SOURCE_BOUND_PDF_SUFFIX='+source-bound-reviewed-2';
const sha=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
const need=(ok,code)=>{if(!ok)throw Error('SOURCE_LITERAL_'+code);};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
const normalized=s=>s.replace(/\s+/gu,' ').trim();
const schema=JSON.parse(await readFile(new URL('../../Schema/phase21/parser-run.schema.json',import.meta.url),'utf8'));
const shape=new Ajv2020({allErrors:true,strict:false}).compile(schema);
function unique(records,key){
  need(Array.isArray(records)&&records.length>0&&records.every(r=>r&&Object.hasOwn(r,key)), 'RECORDS');
  need(new Set(records.map(r=>r[key])).size===records.length,'DUPLICATE_RECORD');
  return new Map(records.map(r=>[r[key],r]));
}
function parseBound(text,digest){
  need(typeof text==='string'&&sha(text)===digest,'EVIDENCE_BYTES');
  try{return JSON.parse(text);}catch{throw Error('SOURCE_LITERAL_EVIDENCE_JSON');}
}

/** Replays supplied, nonblind source-review records; never opens paths in them or runs a parser.
 * Fingerprints establish local consistency, not source authenticity or user/model authentication.
 * No implicit normalization or arbitrary replacement is admitted outside the approved patches.
 */
export function deriveSourceLiteralPdfRun(parent,proof){
  if(proof?.version===SOURCE_BOUND_PDF_PROFILE)return deriveSourceBoundPdfRun(parent,proof);
  need(shape(parent)&&!parent.normalization_version.includes(SOURCE_LITERAL_PDF_SUFFIX),'PARENT');
  need(exact(proof,['version','packet_bytes','preparation_bytes','review_bytes','images','patches','approval'])&&proof.version===SOURCE_LITERAL_PDF_PROFILE,'PROOF');
  const a=proof.approval;
  need(exact(a,['scope','id','parent_fingerprint','packet_sha256','preparation_sha256','review_sha256','patches_fingerprint'])&&
    a.scope===SOURCE_LITERAL_PDF_PROFILE&&typeof a.id==='string'&&a.id.length>0&&a.parent_fingerprint===fp(parent),'APPROVAL');
  need(Array.isArray(proof.patches)&&proof.patches.length>0&&proof.patches.length<=3&&a.patches_fingerprint===fp(proof.patches),'PATCH_SCOPE');
  const packet=parseBound(proof.packet_bytes,a.packet_sha256),prepare=parseBound(proof.preparation_bytes,a.preparation_sha256),review=parseBound(proof.review_bytes,a.review_sha256);
  need(prepare.role==='reference-prepare'&&review.role==='reference-review'&&review.verdict==='verified'&&
    Array.isArray(prepare.blockers)&&prepare.blockers.length===0&&Array.isArray(review.blockers)&&review.blockers.length===0&&
    prepare.packet_sha256_provided===a.packet_sha256&&review.packet_sha256_provided===a.packet_sha256,'REVIEW');
  const source=parent.sources.find(s=>s.document_id===packet.source?.document_id);
  need(source?.availability==='available'&&source.source_sha256===packet.source.source_sha256&&
    review.source_document_id===source.document_id&&review.source_pdf_sha256_provided===source.source_sha256,'SOURCE');
  const pc=unique(packet.cases,'evidence_id'),first=unique(prepare.cases,'evidence_id'),second=unique(review.cases,'evidence_id');
  need(pc.size===first.size&&pc.size===second.size&&[...pc.keys()].every(id=>first.has(id)&&second.has(id)),'REVIEW_CASE_SET');
  const registeredImages=unique(packet.images,'physical_page'),images=unique(proof.images,'physical_page'),patches=unique(proof.patches,'evidence_id');
  const requiredPages=new Set(proof.patches.map(p=>pc.get(p.evidence_id)?.page));
  need(images.size===requiredPages.size&&[...requiredPages].every(p=>images.has(p)),'IMAGE_SCOPE');
  for(const [page,image] of images){
    need(exact(image,['physical_page','bytes_base64'])&&typeof image.bytes_base64==='string','IMAGE');
    const bytes=Buffer.from(image.bytes_base64,'base64');
    need(bytes.length>0&&bytes.toString('base64')===image.bytes_base64&&sha(bytes)===registeredImages.get(page)?.sha256,'IMAGE_BYTES');
  }
  const run=createParserRunRecord(parent),parentBlocks=unique(parent.blocks,'id'),changedBlocks=new Set();
  for(const [id,patch] of patches){
    const entry=pc.get(id),p=first.get(id),r=second.get(id),page=entry?.page;
    need(entry&&p&&r&&entry.document_id===source.document_id&&Number.isSafeInteger(page)&&page>0&&
      page===p.physical_page&&page===r.physical_page&&
      prepare.source_access?.physical_pages_read?.includes(page)&&review.source_access?.physical_pages_viewed?.includes(page)&&
      parent.page_coverage.some(c=>c.document_id===source.document_id&&c.known_pages.includes(page)),'PAGE');
    need(r.verdict==='verified'&&r.prepare_text_verified===true&&typeof p.source_exact_text==='string'&&p.source_exact_text.trim().length>0&&
      p.source_exact_text===r.final_source_exact_text&&p.source_image_sha256_provided===registeredImages.get(page)?.sha256&&
      r.source_image_sha256_provided===registeredImages.get(page)?.sha256,'SOURCE_QUOTE');
    const literal=r.final_source_exact_text;
    if(patch.operation==='append_reviewed_literal'){
      need(exact(patch,['evidence_id','operation']),'PATCH_KEYS');
      need(!parent.blocks.some(b=>b.locator.document_id===source.document_id&&b.locator.page_number===page&&normalized(b.text).includes(normalized(literal))),'ALREADY_PRESENT');
      const sourceBlockId='source-reviewed:'+fp({source:source.document_id,page,evidence_id:id,literal}).slice(7);
      const blockId=source.document_id+':'+sourceBlockId;
      need(!parentBlocks.has(blockId),'BLOCK_COLLISION');
      run.blocks.push({id:blockId,type:'paragraph',text:literal,locator:{document_id:source.document_id,page_number:page,page_status:'known',source_block_id:sourceBlockId},rotation_degrees:0});
      continue;
    }
    const keys=['evidence_id','operation','block_id','parent_block_fingerprint','start','end'];
    need(['restore_hyphen','replace_reviewed_literal'].includes(patch.operation)&&
      exact(patch,patch.operation==='restore_hyphen'?[...keys,'from','to']:keys),'PATCH_KEYS');
    const block=parentBlocks.get(patch.block_id);
    need(block&&block.type==='paragraph'&&block.locator.document_id===source.document_id&&block.locator.page_number===page&&
      block.locator.page_status==='known'&&fp(block)===patch.parent_block_fingerprint&&!changedBlocks.has(block.id),'BLOCK');
    need(Number.isSafeInteger(patch.start)&&Number.isSafeInteger(patch.end)&&patch.start>=0&&patch.end>patch.start&&patch.end<=block.text.length,'SPAN');
    changedBlocks.add(block.id);
    const original=block.text.slice(patch.start,patch.end);
    let replacement=literal;
    if(patch.operation==='restore_hyphen'){
      need(typeof patch.from==='string'&&/^[A-Za-z]+$/.test(patch.from)&&typeof patch.to==='string'&&
        /^[A-Za-z]+-[A-Za-z]+$/.test(patch.to)&&patch.to.replace('-','')===patch.from&&original.split(patch.from).length===2,'HYPHEN');
      replacement=original.replace(patch.from,patch.to);
      need(normalized(replacement)===normalized(literal),'HYPHEN_SOURCE_QUOTE');
    }
    need(original!==replacement,'NO_CHANGE');
    run.blocks.find(b=>b.id===block.id).text=block.text.slice(0,patch.start)+replacement+block.text.slice(patch.end);
  }
  run.normalization_version+=SOURCE_LITERAL_PDF_SUFFIX;
  run.config_fingerprint=fp({parent_fingerprint:fp(parent),proof_fingerprint:fp(proof)});
  run.approval_fingerprint=fp(a);
  run.approval_scope='source-reviewed-literal-candidate-only; historical parser observations retained in parent';
  run.parser_run_id=deriveParserRunIdentity(run);
  need(shape(run),'DERIVED_STRUCTURE');
  return run;
}

/** Explicit second profile: original two-pass source-literal reports, source excerpts,
 * simultaneous parent-coordinate patches and a replayable first-profile parent.
 * No paths are opened; reports remain nonblind observations, not authentication.
 */
function deriveSourceBoundPdfRun(parent,proof){
  need(shape(parent)&&!parent.normalization_version.includes(SOURCE_BOUND_PDF_SUFFIX),'PARENT');
  need(exact(proof,['version','parent_derivation','groups','patches','approval']),'PROOF');
  const previous=proof.parent_derivation,a=proof.approval;
  need(exact(previous,['parent_run','proof'])&&previous.proof.version===SOURCE_LITERAL_PDF_PROFILE&&
    fp(deriveSourceLiteralPdfRun(previous.parent_run,previous.proof))===fp(parent),'PARENT_REPLAY');
  need(exact(a,['scope','id','parent_fingerprint','groups_fingerprint','patches_fingerprint','evidence_ids'])&&
    a.scope===SOURCE_BOUND_PDF_PROFILE&&typeof a.id==='string'&&a.id.length>0&&a.parent_fingerprint===fp(parent)&&
    a.groups_fingerprint===fp(proof.groups)&&a.patches_fingerprint===fp(proof.patches),'APPROVAL');
  need(Array.isArray(a.evidence_ids)&&a.evidence_ids.length>0&&a.evidence_ids.length<=17&&new Set(a.evidence_ids).size===a.evidence_ids.length,'PATCH_SCOPE');
  need(Array.isArray(proof.groups)&&proof.groups.length>0&&proof.groups.length<=2&&Array.isArray(proof.patches)&&proof.patches.length>0&&proof.patches.length<=17,'PATCH_SCOPE');
  const groups=new Map();
  for(const g of proof.groups){
    need(exact(g,['packet_bytes','preparation_bytes','review_bytes','images']),'GROUP');
    const packet=JSON.parse(g.packet_bytes),p=JSON.parse(g.preparation_bytes),r=JSON.parse(g.review_bytes),doc=packet.source?.document_id;
    const source=parent.sources.find(s=>s.document_id===doc);
    need(!groups.has(doc)&&source?.availability==='available'&&source.source_sha256===packet.source.source_sha256,'SOURCE');
    need(p.role==='source-literal-prepare'&&r.role==='source-literal-review'&&r.verdict==='verified'&&
      p.document_group===r.document_group&&p.source_document_id===doc&&r.source_document_id===doc&&
      p.source_pdf_sha256_provided===source.source_sha256&&r.source_pdf_sha256_provided===source.source_sha256&&
      p.packet_sha256_provided===sha(g.packet_bytes)&&r.packet_sha256_provided===sha(g.packet_bytes)&&
      r.preparation_sha256_provided===sha(g.preparation_bytes)&&Array.isArray(p.blockers)&&p.blockers.length===0&&Array.isArray(r.blockers)&&r.blockers.length===0,'REVIEW');
    const cases=unique(packet.cases,'evidence_id'),first=unique(p.cases,'evidence_id'),second=unique(r.cases,'evidence_id');
    need(cases.size===first.size&&cases.size===second.size&&[...cases.keys()].every(id=>first.has(id)&&second.has(id)),'REVIEW_CASE_SET');
    const registered=unique(packet.source.images,'physical_page'),images=unique(g.images,'physical_page');
    for(const [page,i]of images){
      need(exact(i,['physical_page','bytes_base64'])&&typeof i.bytes_base64==='string','IMAGE');
      const b=Buffer.from(i.bytes_base64,'base64');need(b.length>0&&b.toString('base64')===i.bytes_base64&&sha(b)===registered.get(page)?.sha256,'IMAGE_BYTES');
    }
    groups.set(doc,{packet,p,r,cases,first,second,registered,images,usedPages:new Set()});
  }
  const blocks=unique(parent.blocks,'id'),edits=new Map(),used=new Set();
  for(const patch of proof.patches){
    need(exact(patch,['document_id','physical_page','evidence_ids','source_text','symbol_roles','parts','changes'])&&Array.isArray(patch.evidence_ids)&&patch.evidence_ids.length>0&&Array.isArray(patch.parts)&&patch.parts.length>0&&Array.isArray(patch.changes)&&patch.changes.length>0,'PATCH_KEYS');
    const g=groups.get(patch.document_id),page=patch.physical_page;
    need(g&&Number.isSafeInteger(page)&&page>0&&g.images.has(page)&&parent.page_coverage.some(c=>c.document_id===patch.document_id&&c.known_pages.includes(page)),'PAGE');
    g.usedPages.add(page);
    for(const id of patch.evidence_ids){
      need(!used.has(id)&&a.evidence_ids.includes(id),'PATCH_SCOPE');used.add(id);
      const c=g.cases.get(id),p=g.first.get(id),r=g.second.get(id),digest=g.registered.get(page)?.sha256;
      need(c&&p&&r&&c.document_id===patch.document_id&&c.physical_page===page&&p.physical_page===page&&r.physical_page===page,'PAGE');
      for(const report of [g.p,g.r])need(report.source_access?.pages?.some(i=>i.physical_page===page&&i.source_image_sha256_provided===digest&&
        (i.viewed===true||['viewed','actually_viewed_in_this_review'].includes(i.status))),'PAGE_ACCESS');
      need(r.verdict==='verified'&&r.prepare_text_verified===true&&p.source_exact_text===r.final_source_exact_text&&
        patch.source_text===r.final_source_exact_text&&typeof patch.source_text==='string'&&patch.source_text.length>0&&
        p.source_image_sha256_provided===digest&&r.source_image_sha256_provided===digest&&
        fp(patch.symbol_roles[id])===fp(r.symbol_and_citation_roles),'SOURCE_QUOTE');
    }
    need(exact(patch.symbol_roles,patch.evidence_ids),'ROLE_SCOPE');
    for(const part of patch.parts){
      need(exact(part,['block_id','parent_block_fingerprint','start','end','original_text','source_start','source_end','transforms']),'PART_KEYS');
      const b=blocks.get(part.block_id);
      need(b&&['paragraph','figure'].includes(b.type)&&b.locator.document_id===patch.document_id&&b.locator.page_number===page&&b.locator.page_status==='known'&&fp(b)===part.parent_block_fingerprint,'BLOCK');
      need(patch.evidence_ids.some(id=>g.cases.get(id).nearby_saved_candidate_blocks?.some(x=>x.id===b.id&&x.text_sha256===sha(b.text)&&fp(x.locator)===fp(b.locator))),'PACKET_BLOCK');
      need(Number.isSafeInteger(part.start)&&Number.isSafeInteger(part.end)&&part.start>=0&&part.end>part.start&&part.end<=b.text.length&&b.text.slice(part.start,part.end)===part.original_text,'SPAN');
      need(Number.isSafeInteger(part.source_start)&&Number.isSafeInteger(part.source_end)&&part.source_start>=0&&part.source_end>part.source_start&&part.source_end<=patch.source_text.length&&Array.isArray(part.transforms),'SOURCE_SPAN');
      let literal=patch.source_text.slice(part.source_start,part.source_end),last=0,out='';
      for(const t of part.transforms){
        need(exact(t,['start','end','from','to','kind','role_evidence_id','role_index'])&&Number.isSafeInteger(t.start)&&Number.isSafeInteger(t.end)&&t.start>=last&&t.end>t.start&&t.end<=literal.length&&literal.slice(t.start,t.end)===t.from&&typeof t.to==='string','TRANSFORM_SPAN');
        const role=patch.symbol_roles[t.role_evidence_id]?.[t.role_index];
        need(role&&Number.isSafeInteger(t.role_index),'TRANSFORM_ROLE');
        const supers={'⁰':'0','¹':'1','²':'2','³':'3','⁴':'4','⁵':'5','⁶':'6','⁷':'7','⁸':'8','⁹':'9','⁻':'−','⁺':'+'};
        const valid=t.kind==='product-glyph'&&t.from==='\\prod'&&t.to==='∏'&&/product operator/.test(role.role)&&role.marker.startsWith('\\prod')||
          t.kind==='legacy-exponent-display'&&/^10[⁻⁺]?[⁰¹²³⁴⁵⁶⁷⁸⁹]+$/u.test(t.from)&&t.to==='10'+[...t.from.slice(2)].map(c=>supers[c]).join('')&&/mathematical exponent/.test(role.role)&&role.marker.includes(t.from)||
          t.kind==='operator-spacing'&&t.from.replace(/\s/g,'')===t.to.replace(/\s/g,'')&&/^>?\s*5%$/.test(t.from)&&/threshold/.test(role.role);
        need(valid,'TRANSFORM_VALUE');out+=literal.slice(last,t.start)+t.to;last=t.end;
      }
      out+=literal.slice(last);
      const list=edits.get(b.id)??[];list.push({...part,replacement:out});edits.set(b.id,list);
    }
  }
  need(used.size===a.evidence_ids.length,'PATCH_SCOPE');
  for(const g of groups.values())need(g.images.size===g.usedPages.size,'IMAGE_SCOPE');
  const run=createParserRunRecord(parent);
  for(const [id,list]of edits){
    list.sort((a,b)=>a.start-b.start);let last=0,out='';const b=blocks.get(id);
    for(const e of list){need(e.start>=last,'OVERLAPPING_SPANS');out+=b.text.slice(last,e.start)+e.replacement;last=e.end;}
    out+=b.text.slice(last);run.blocks.find(b=>b.id===id).text=out;
  }
  need(fp(run.blocks)!==fp(parent.blocks),'NO_CHANGE');
  run.normalization_version+=SOURCE_BOUND_PDF_SUFFIX;
  run.config_fingerprint=fp({parent_fingerprint:fp(parent),proof_fingerprint:fp(proof)});
  run.approval_fingerprint=fp(a);run.approval_scope='source-bound reviewed candidate only; nonblind; parent and source roles retained';
  run.parser_run_id=deriveParserRunIdentity(run);need(shape(run),'DERIVED_STRUCTURE');return run;
}
