import {readFile} from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import {canonicalizeV3Json,fingerprintV3Json} from './semantic-package-validator.mjs';
import {isDeepStrictEqual} from 'node:util';
import {ORIGINAL_XLS_PARSER_PROFILE} from './original-xls-parser-evidence.mjs';
import {ORIGINAL_XLS_PROFILE} from './original-xls-source-evidence.mjs';
import {DERIVED_WORKBOOK_PROFILE} from './derived-workbook-evidence.mjs';
import {replayWholePaperRun} from './whole-paper-adapter.mjs';

const hash=fingerprintV3Json;
const same=isDeepStrictEqual;
const copy=x=>structuredClone(x);
const H=/^sha256:[a-f0-9]{64}$/;
const CATEGORIES=['text','table','formula','citation','figure','attachment','locator'];
const REPRESENTATION='phase21-whole-paper-representation-1.0';
const REPRESENTATION_KIND='accepted_assisted_source_representation';
const DISPLAY_RULE='exact-decimal-and-trailing-format-only-1';
const BOOLEAN_DISPLAY_RULE='exact-decimal-boolean-and-trailing-format-only-1';
const RECTANGULAR_DISPLAY_RULE='exact-typed-display-and-trailing-format-rectangle-1';
const DISPLAY_RULES=[DISPLAY_RULE,BOOLEAN_DISPLAY_RULE,RECTANGULAR_DISPLAY_RULE];
const CONTEXT_KEYS=['headers','row_labels','units','footnotes'];
const schema=JSON.parse(await readFile(new URL('../../Schema/phase21/whole-paper.schema.json',import.meta.url),'utf8'));
const ajv=new Ajv2020({strict:false,allErrors:true});ajv.addSchema(schema);
const runShape=ajv.compile({$ref:'phase21/whole-paper#/$defs/run'}),refShape=ajv.compile({$ref:'phase21/whole-paper#/$defs/reference'});
const checkResult=errors=>({ok:errors.length===0,errors:[...new Set(errors)].sort()});
const safePath=p=>typeof p==='string'&&p.length&&!p.startsWith('/')&&!/[\\:]/.test(p)&&!p.split('/').some(x=>!x||x==='.'||x==='..');
const locKey=loc=>canonicalizeV3Json(loc);
const matched=o=>['matched','segmented_match'].includes(o?.outcome);
const sourceMap=sources=>[...sources].sort((a,b)=>a.document_id.localeCompare(b.document_id));

function sourceErrors(sources,required){
  const errors=[],ids=sources.map(s=>s.document_id),containers=new Map();
  if(new Set(ids).size!==ids.length||required.length!==ids.length||new Set(required.map(c=>c.document_id)).size!==ids.length)errors.push('WHOLE_PAPER_SOURCE_SET_MISMATCH');
  for(const s of sources){
    const r=required.find(c=>c.document_id===s.document_id);
    if(!r||r.kind!==s.kind||r.purpose!==s.purpose||r.scope_complete!==true)errors.push('WHOLE_PAPER_COVERAGE_SET_MISMATCH');
    if(s.member_path!=null&&(!safePath(s.member_path)||!s.container))errors.push('WHOLE_PAPER_ARCHIVE_BINDING_INVALID');
    if(s.container){if(containers.has(s.container.document_id)&&containers.get(s.container.document_id)!==s.container.source_sha256||ids.includes(s.container.document_id))errors.push('WHOLE_PAPER_ARCHIVE_BINDING_INVALID');containers.set(s.container.document_id,s.container.source_sha256);}
    if(s.purpose==='catalogue_only'&&(s.kind!=='pdf'||!r?.reason))errors.push('WHOLE_PAPER_CATALOGUE_SCOPE_INVALID');
    if(s.purpose==='content'&&s.kind==='pdf'&&(!r?.required_pages?.length||r.required_pages.some(n=>!Number.isSafeInteger(n)||n<1)))errors.push('WHOLE_PAPER_COVERAGE_SET_MISMATCH');
    if(s.kind==='docx'&&(!r?.parts?.length||r.parts.some(p=>!safePath(p))||!Array.isArray(r.record_ids)||!r.record_ids.length))errors.push('WHOLE_PAPER_COVERAGE_SET_MISMATCH');
    if(s.kind==='workbook'&&(!r?.sheets?.length||new Set(r.sheets.map(x=>x.index)).size!==r.sheets.length||r.sheets.some(x=>!Number.isSafeInteger(x.index)||x.index<0||!x.name||!validRange(x.range))))errors.push('WHOLE_PAPER_COVERAGE_SET_MISMATCH');
  }
  return errors;
}
const validRange=r=>r&&['start_row','start_column','end_row','end_column'].every(k=>Number.isSafeInteger(r[k])&&r[k]>0)&&r.start_row<=r.end_row&&r.start_column<=r.end_column;
const inside=(point,range)=>point.row>=range.start_row&&point.row<=range.end_row&&point.column>=range.start_column&&point.column<=range.end_column;
const relevantRecords=e=>(e?.records??[]).filter(r=>['paragraph','table','row','cell','footnote','endnote','comment','workbook_cell'].includes(r.kind));
const sameIds=(a,b)=>a.length===b.length&&new Set(a).size===a.length&&same([...a].sort(),[...b].sort());
function addressRange(text){const point=s=>{const m=/^([A-Z]+)([1-9][0-9]*)$/.exec(s??'');if(!m)return null;let col=0;for(const c of m[1])col=col*26+c.charCodeAt(0)-64;return{row:Number(m[2]),column:col};};const ends=String(text).split(':'),a=point(ends[0]),b=point(ends.at(-1));return a&&b?{start_row:a.row,start_column:a.column,end_row:b.row,end_column:b.column}:null;}

export function validateWholePaperRun(run){
  const errors=[];
  try{
    fingerprintV3Json(run);
    if(!runShape(run))return checkResult(['WHOLE_PAPER_RUN_STRUCTURE_INVALID']);
    errors.push(...sourceErrors(run.sources,run.required_coverage));
    const {parser_run_id,...content}=run;if(parser_run_id!==hash(content))errors.push('WHOLE_PAPER_RUN_IDENTITY_MISMATCH');
    const replay=replayWholePaperRun(run);
    if(!replay.ok||!same(replay.run,run))errors.push('WHOLE_PAPER_RUN_REPLAY_MISMATCH');
    for(const source of run.sources){
      const required=run.required_coverage.find(c=>c.document_id===source.document_id),coverage=run.source_coverage.filter(c=>c.document_id===source.document_id);
      if(!required||coverage.length!==1||coverage[0].scope_fingerprint!==hash(required)||coverage[0].status!==(source.purpose==='catalogue_only'?'catalogue_only':'read')||source.availability!=='available')errors.push('WHOLE_PAPER_REQUIRED_SOURCE_UNREAD');
      if(source.kind==='pdf'&&source.purpose==='content'){
        const page=run.pdf_run?.page_coverage?.find(c=>c.document_id===source.document_id);
        if(!page||page.unknown_item_count!==0||!required?.required_pages?.every(p=>page.known_pages.includes(p)))errors.push('WHOLE_PAPER_PDF_COVERAGE_INCOMPLETE');
      }
      if(source.kind==='docx'){
        const e=run.provenance.office_payloads.find(p=>p.document_id===source.document_id)?.source_evidence;
        if(!e||!required.parts.every(p=>e.parts.some(x=>x.path===p))||!sameIds(required.record_ids,relevantRecords(e).map(r=>r.id))||relevantRecords(e).some(r=>!required.parts.includes(r.locator.part)))errors.push('WHOLE_PAPER_SOURCE_COVERAGE_INCOMPLETE');
      }
      if(source.kind==='workbook'){
        const e=run.provenance.office_payloads.find(p=>p.document_id===source.document_id)?.source_evidence;
        if(source.format==='xls'){
          const saved=run.provenance.office_payloads.find(p=>p.document_id===source.document_id)?.xls_parser_evidence;
          const originalSaved=e?.profile===ORIGINAL_XLS_PROFILE&&saved?.profile===ORIGINAL_XLS_PARSER_PROFILE&&saved.source_sha256===source.source_sha256&&saved.source_evidence_fingerprint===hash(e)&&saved.source_truth==='original_xls'&&saved.scientific_eligible===false&&saved.independent_backend===false&&saved.original_format_lossless==='not_established';
          if(!originalSaved&&(!e?.derivation||e.derivation.source_truth!=='original_xls'||e.derivation.scientific_eligible!==false||e.derivation.original_format_lossless!=='not_established'))errors.push('WHOLE_PAPER_DERIVED_BOUNDARY_INVALID');
        }
        if(!e||!required.sheets.every(s=>e.coverage?.sheets?.some(x=>{const r=addressRange(x.range);return x.index===s.index&&x.name===s.name&&r&&inside({row:s.range.start_row,column:s.range.start_column},r)&&inside({row:s.range.end_row,column:s.range.end_column},r);})))errors.push('WHOLE_PAPER_SOURCE_COVERAGE_INCOMPLETE');
      }
    }
    if(new Set(run.office_observations.map(o=>o.id)).size!==run.office_observations.length)errors.push('WHOLE_PAPER_OBSERVATION_DUPLICATE');
    if(run.side==='baseline'&&run.office_observations.some(o=>o.origin==='source_read'))errors.push('WHOLE_PAPER_BASELINE_CONTAMINATED');
  }catch{errors.push('WHOLE_PAPER_RUN_STRUCTURE_INVALID');}
  return checkResult(errors);
}

function validateReferenceCoverage(reference,run){
  const errors=[],payloads=new Map(run.provenance.office_payloads.map(p=>[p.document_id,p]));
  for(const source of reference.source_document_map.filter(s=>s.kind!=='pdf')){
    const records=relevantRecords(payloads.get(source.document_id)?.source_evidence),items=reference.items.filter(i=>i.document_id===source.document_id),req=reference.required_coverage.find(c=>c.document_id===source.document_id);
    const covered=new Set();
    for(const item of items){
      const actual=source.kind==='docx'?records.filter(r=>r.locator.part===item.locator.part&&(r.locator.xml_path===item.locator.xml_path||r.locator.xml_path.startsWith(item.locator.xml_path+'/'))):records.filter(r=>r.sheet.index===item.locator.sheet.index&&r.sheet.name===item.locator.sheet.name&&inside(r,item.locator.range));
      const expected=source.kind==='docx'?item.expected_records:item.expected_cells;
      if(!sameIds(expected.map(r=>r.id),actual.map(r=>r.id)))errors.push('WHOLE_PAPER_REFERENCE_COVERAGE_INCOMPLETE');
      for(const r of expected)covered.add(r.id);
      if(source.kind==='workbook'&&!same([...new Set(actual.flatMap(r=>r.merges??[]))].sort(),[...(item.expected_merged_ranges??[])].sort()))errors.push('WHOLE_PAPER_REFERENCE_MERGE_INVALID');
    }
    const mandatory=source.kind==='docx'?req.record_ids:records.filter(r=>req.sheets.some(s=>s.index===r.sheet.index&&s.name===r.sheet.name&&inside(r,s.range))).map(r=>r.id);
    if(mandatory.some(id=>!covered.has(id)))errors.push('WHOLE_PAPER_REFERENCE_COVERAGE_INCOMPLETE');
  }
  return errors;
}

const nonempty=s=>typeof s==='string'&&s.trim().length>0;
const reviewBinding=b=>b&&nonempty(b.record_ref)&&H.test(b.record_fingerprint??'');

// This qualifies serialized relationships only. Source bytes are still checked by run replay.
function sharedFormulaQualification(item){
  const ids=new Set(),errors=[],seen=new Set(),records=item.expected_cells??[];
  const groups=item.verification?.representation_qualifications?.shared_formula_groups??[];
  if(!Array.isArray(groups))return {ids,errors:['WHOLE_PAPER_SHARED_FORMULA_QUALIFICATION_INVALID']};
  const byId=new Map(records.map(r=>[r.id,r])),bySharedIndex=new Map();
  for(const r of records)if(r.formula?.present&&r.formula.attributes?.t==='shared'){
    const key=r.formula.attributes.si;if(!bySharedIndex.has(key))bySharedIndex.set(key,[]);bySharedIndex.get(key).push(r);
  }
  for(const g of groups){
    let valid=true;
    try{
      const key=canonicalizeV3Json([g.document_id,g.sheet,g.shared_index]);
      if(seen.has(key))valid=false;seen.add(key);
      const members=bySharedIndex.get(g.shared_index)??[];
      const anchor=byId.get(g.anchor_record_id),range=addressRange(anchor?.formula?.attributes?.ref);
      const masters=members.filter(r=>nonempty(r.formula.text)||r.formula.attributes.ref!==undefined);
      const memberIds=members.map(r=>r.id),declared=[g.anchor_record_id,...g.follower_record_ids];
      if(g.document_id!==item.document_id||!same(g.sheet,item.locator.sheet)||!nonempty(g.shared_index)||!/^\d+$/.test(g.shared_index)
        ||!validRange(g.range)||!same(range,g.range)||!anchor||masters.length!==1||masters[0]!==anchor||!nonempty(anchor.formula.text)
        ||!/^[A-Z]+[1-9][0-9]*(?::[A-Z]+[1-9][0-9]*)?$/.test(anchor?.formula?.attributes?.ref??'')
        ||!members.length||!sameIds(memberIds,declared)||!reviewBinding(g.review_binding)
        ||g.scientific_uncertainty?.status!=='unresolved'||!nonempty(g.scientific_uncertainty.reason)
        ||!Array.isArray(g.record_fingerprints)||!sameIds(g.record_fingerprints.map(x=>x.record_id),memberIds))valid=false;
      for(const r of members){
        if(!inside(r,g.range)||r.sheet.index!==g.sheet.index||r.sheet.name!==g.sheet.name||r.unresolved!==true
          ||!['n','s','inlineStr','b','e','str','d'].includes(r.xml_type)||!r.cache?.element_present
          ||g.record_fingerprints.find(x=>x.record_id===r.id)?.sha256!==hash(r)
          ||r!==anchor&&(r.formula.text!==null&&r.formula.text!==''||Object.hasOwn(r.formula.attributes,'ref')))valid=false;
      }
      if(valid)for(const id of memberIds)ids.add(id);
    }catch{valid=false;}
    if(!valid)errors.push('WHOLE_PAPER_SHARED_FORMULA_QUALIFICATION_INVALID');
  }
  return {ids,errors};
}

function contextScopeShape(c,item,required,source){
  const b=c.scope_binding;
  const bound=reviewBinding(c.review_binding)&&b?.document_id===item.document_id&&H.test(b.source_evidence_fingerprint??'')
    &&b.required_coverage_fingerprint===hash(required)&&Array.isArray(b.parts);
  if(b?.kind==='qualified_xls_source_records')return bound&&source?.format==='xls'&&b.source_sha256===source.source_sha256
    &&[ORIGINAL_XLS_PROFILE,DERIVED_WORKBOOK_PROFILE].includes(b.source_profile)&&b.parts.length===0;
  return bound&&b.parts.length>0&&new Set(b.parts).size===b.parts.length&&b.parts.every(safePath);
}

function representationUncertainties(reference){
  const result={source_scope:copy(Array.isArray(reference?.scope?.unresolved)?reference.scope.unresolved:[]),shared_formula_groups:[],contexts:[]};
  for(const item of Array.isArray(reference?.items)?reference.items:[]){
    if(!item||typeof item!=='object')continue;
    const groups=item.verification?.representation_qualifications?.shared_formula_groups;
    for(const g of Array.isArray(groups)?groups:[])if(g&&typeof g==='object'){
      const {document_id,sheet,shared_index,anchor_record_id,follower_record_ids,review_binding,scientific_uncertainty}=g;
      result.shared_formula_groups.push(copy({evidence_id:item.evidence_id,document_id,sheet,shared_index,anchor_record_id,follower_record_ids,review_binding,scientific_uncertainty}));
    }
    for(const key of CONTEXT_KEYS){const c=item.context_bindings?.[key];if(c?.applicability==='not_assessable')result.contexts.push({evidence_id:item.evidence_id,context:key,reason:c.reason,locators:copy(c.locators),review_binding:copy(c.review_binding),scope_binding:copy(c.scope_binding)});}
  }
  return result;
}

function representationSourceErrors(reference,run){
  const errors=[],payloads=new Map(run.provenance.office_payloads.map(p=>[p.document_id,p]));
  for(const item of reference.items.filter(i=>i.locator.kind==='workbook')){
    const evidence=payloads.get(item.document_id)?.source_evidence,records=new Map((evidence?.records??[]).map(r=>[r.id,r]));
    for(const g of item.verification.representation_qualifications?.shared_formula_groups??[]){
      if(g.record_fingerprints.some(f=>!records.has(f.record_id)||hash(records.get(f.record_id))!==f.sha256))errors.push('WHOLE_PAPER_SHARED_FORMULA_QUALIFICATION_INVALID');
    }
    for(const key of CONTEXT_KEYS){const c=item.context_bindings[key];if(c.applicability!=='not_assessable')continue;
      const b=c.scope_binding;
      const source=run.sources.find(s=>s.document_id===item.document_id);
      if(b.kind==='qualified_xls_source_records'){
        if(source?.format!=='xls'||b.source_sha256!==source.source_sha256||![ORIGINAL_XLS_PROFILE,DERIVED_WORKBOOK_PROFILE].includes(b.source_profile)
          ||evidence?.profile!==b.source_profile||evidence?.source?.sha256!==source.source_sha256||evidence.coverage?.complete_selected_parts!==true
          ||hash(evidence)!==b.source_evidence_fingerprint||!same(b.parts,[])||!same(evidence.scope?.parts,[])||!same(evidence.parts,[]))errors.push('WHOLE_PAPER_CONTEXT_SCOPE_BINDING_INVALID');
      }else if(!evidence||evidence.coverage?.complete_selected_parts!==true||hash(evidence)!==b.source_evidence_fingerprint
        ||!sameIds(b.parts,evidence.scope.parts)||evidence.parts.length!==b.parts.length||!sameIds(b.parts,evidence.parts.map(p=>p.path)))errors.push('WHOLE_PAPER_CONTEXT_SCOPE_BINDING_INVALID');
    }
  }
  return errors;
}

export function validateWholePaperReference(reference){
  const errors=[];
  try{
    fingerprintV3Json(reference);
    if(Object.hasOwn(reference,'evaluation_profile')&&reference.evaluation_profile!==REPRESENTATION)return checkResult(['WHOLE_PAPER_EVALUATION_PROFILE_MISMATCH']);
    if(!refShape(reference))return checkResult(['WHOLE_PAPER_REFERENCE_STRUCTURE_INVALID']);
    const representation=reference.evaluation_profile===REPRESENTATION;
    errors.push(...sourceErrors(reference.source_document_map,reference.required_coverage));
    const {items,scope,method,acceptance,parent_reference_binding:parent}=reference;
    if(new Set(items.map(i=>i.evidence_id)).size!==items.length)errors.push('WHOLE_PAPER_REFERENCE_ITEM_DUPLICATE');
    if(scope.status!=='complete')errors.push('WHOLE_PAPER_REFERENCE_SCOPE_INCOMPLETE');
    if(representation&&(scope.evaluation_scope!=='source_representation_fidelity'||scope.unresolved!==undefined&&!Array.isArray(scope.unresolved)))errors.push('WHOLE_PAPER_REFERENCE_SCOPE_INCOMPLETE');
    if(method.preparation!=='assisted'||method.verification!=='assisted'||method.source_access!=='used'||method.independence!=='nonblind'||!['used','not_used','unknown'].includes(method.parser_output_access))errors.push('WHOLE_PAPER_REFERENCE_METHOD_INVALID');
    if(acceptance.decision_ref!=='D-21-35'||acceptance.corpus_id!=='phase21-twelve-paper'||!/^\d\d$/.test(acceptance.paper_id??'')||!acceptance.record_ref||!H.test(acceptance.record_fingerprint??''))errors.push('WHOLE_PAPER_REFERENCE_AUTHORITY_INVALID');
    const dispositions=scope.category_dispositions;
    if(!Array.isArray(dispositions)||dispositions.length!==7||new Set(dispositions.map(d=>d.category)).size!==7)errors.push('WHOLE_PAPER_CATEGORY_SCOPE_INVALID');
    else for(const category of CATEGORIES){const d=dispositions.find(d=>d.category===category);if(!d?.reason||d.disposition!==(items.some(i=>i.category===category)?'covered':'inapplicable'))errors.push('WHOLE_PAPER_CATEGORY_SCOPE_INVALID');}
    if(!parent?.manifest||!Array.isArray(parent.manifest.items)||parent.sha256!==hash(parent.manifest))errors.push('WHOLE_PAPER_PARENT_REFERENCE_INVALID');
    else{
      const old=parent.manifest.items,pdfItems=items.filter(i=>i.locator.kind==='pdf');
      if(old.length!==pdfItems.length||new Set(old.map(i=>i.evidence_id)).size!==old.length||old.some(i=>!pdfItems.some(p=>p.evidence_id===i.evidence_id&&same(p.legacy_item,i))))errors.push('WHOLE_PAPER_PARENT_REFERENCE_CHANGED');
      for(const gap of parent.manifest.scope?.uncovered_items??[]){
        const ds=reference.gap_dispositions.filter(d=>d.evidence_id===gap.evidence_id),d=ds[0];
        const expectedStatus=representation&&gap.evidence_id==='r03-gap-zip-content'?'representation_covered':'resolved';
        if(ds.length!==1||d.status!==expectedStatus||!d.reason||!d.supporting_evidence_ids?.length||d.supporting_evidence_ids.some(id=>!items.some(i=>i.evidence_id===id)))errors.push('WHOLE_PAPER_GAP_UNRESOLVED');
        if(gap.evidence_id==='r03-gap-zip-content'){
          const members=reference.source_document_map.filter(s=>s.member_path&&s.purpose==='content').map(s=>s.document_id).sort();
          if(!d||!same([...(d.member_document_ids??[])].sort(),members)||members.some(id=>!items.some(i=>i.document_id===id)))errors.push('WHOLE_PAPER_ARCHIVE_COVERAGE_INCOMPLETE');
          if(representation){
            const uncertain=items.filter(i=>i.verification?.representation_qualifications?.shared_formula_groups?.length||CONTEXT_KEYS.some(k=>i.context_bindings?.[k]?.applicability==='not_assessable'));
            if(!Array.isArray(d?.unresolved_children)||uncertain.some(i=>!d.unresolved_children.some(c=>c.evidence_id===i.evidence_id)))errors.push('WHOLE_PAPER_GAP_UNRESOLVED');
          }
        }
      }
    }
    for(const item of items){
      const source=reference.source_document_map.find(s=>s.document_id===item.document_id),required=reference.required_coverage.find(c=>c.document_id===item.document_id),v=item.verification;
      if(!source||source.purpose!=='content'||item.locator.document_id!==item.document_id||item.locator.kind!==source.kind)errors.push('WHOLE_PAPER_REFERENCE_SOURCE_MISMATCH');
      if(v.status!=='verified'||v.source_access!=='used'||v.method!=='assisted'||!v.record_ref||!H.test(v.record_fingerprint??''))errors.push('WHOLE_PAPER_REFERENCE_REVIEW_REQUIRED');
      if(item.locator.kind==='pdf'){
        const old=item.legacy_item;
        if(!old||!same(item.locator,{kind:'pdf',...old.locator})||['evidence_id','document_id','category','centrality'].some(k=>item[k]!==old[k])||!required?.required_pages?.includes(item.locator.page_number))errors.push('WHOLE_PAPER_PARENT_REFERENCE_CHANGED');
      }else if(item.locator.member_path!==source?.member_path)errors.push('WHOLE_PAPER_ARCHIVE_BINDING_INVALID');
      if(item.locator.kind==='docx'){
        if(!item.expected_records?.length||new Set(item.expected_records.map(r=>r.id)).size!==item.expected_records.length||!required?.parts?.includes(item.locator.part)||item.expected_records.some(r=>r.locator?.part!==item.locator.part||r.locator.part_sha256!==item.locator.part_sha256||!r.locator.xml_path.startsWith(item.locator.xml_path)))errors.push('WHOLE_PAPER_DOCX_REFERENCE_INVALID');
      }
      if(item.locator.kind==='workbook'){
        if(!validRange(item.locator.range)||!item.expected_cells?.length||new Set(item.expected_cells.map(c=>`${c.row}:${c.column}`)).size!==item.expected_cells.length||item.expected_cells.some(c=>!inside(c,item.locator.range)||c.sheet.index!==item.locator.sheet.index||c.sheet.name!==item.locator.sheet.name))errors.push('WHOLE_PAPER_WORKBOOK_REFERENCE_INVALID');
        const registered=required?.sheets?.find(s=>s.index===item.locator.sheet.index&&s.name===item.locator.sheet.name);
        if(!registered||!inside({row:item.locator.range.start_row,column:item.locator.range.start_column},registered.range)||!inside({row:item.locator.range.end_row,column:item.locator.range.end_column},registered.range))errors.push('WHOLE_PAPER_COVERAGE_SET_MISMATCH');
        const qualified=representation?sharedFormulaQualification(item):{ids:new Set(),errors:[]};errors.push(...qualified.errors);
        if(item.expected_cells?.some(c=>(c.unresolved||c.formula?.present&&(!c.cache?.element_present||!c.formula.text))&&!qualified.ids.has(c.id)))errors.push('WHOLE_PAPER_FORMULA_CACHE_UNRESOLVED');
        for(const key of ['headers','row_labels','units','footnotes']){
          const c=item.context_bindings?.[key],unknown=representation&&c?.applicability==='not_assessable';
          if(!c||!['required','inapplicable',...(representation?['not_assessable']:[])].includes(c.applicability)||!c.reason||!Array.isArray(c.locators)||c.applicability==='required'&&!c.locators.length||c.applicability==='inapplicable'&&c.locators.length)errors.push('WHOLE_PAPER_CONTEXT_BINDING_INVALID');
          if(unknown&&(!nonempty(c.reason)||!contextScopeShape(c,item,required,source)))errors.push('WHOLE_PAPER_CONTEXT_SCOPE_BINDING_INVALID');
          if(representation&&c?.applicability==='inapplicable'&&Object.hasOwn(c,'scope_binding'))errors.push('WHOLE_PAPER_CONTEXT_SCOPE_BINDING_INVALID');
        }
      }
    }
  }catch{errors.push('WHOLE_PAPER_REFERENCE_STRUCTURE_INVALID');}
  return checkResult(errors);
}

function observationIndex(run){
  const byLocator=new Map(),byRecord=new Map();
  for(const o of run.office_observations){
    if(o.mapping_status!=='mapped'||!o.locator)continue;
    const key=locKey(o.locator);if(!byLocator.has(key)||o.origin==='source_read')byLocator.set(key,o);
    if(o.record){const k=o.document_id+'#'+o.record.id;if(!byRecord.has(k)||o.origin==='source_read')byRecord.set(k,o);}
  }
  return {byLocator,byRecord};
}
function decimalValue(text){
  if(typeof text!=='string')return null;
  const m=/^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);if(!m)return null;
  let digits=(m[2]+(m[3]??'')).replace(/^0+/,'')||'0',exponent=BigInt(m[4]??0)-BigInt((m[3]??'').length);
  while(digits.length>1&&digits.endsWith('0')){digits=digits.slice(0,-1);exponent++;}
  if(digits==='0')exponent=0n;
  return (m[1]==='-'?'-':'')+digits+'e'+exponent;
}
function sameDecimalRecord(actual,expected){
  if(actual.state!=='value'||expected.state!=='value'||actual.xml_type!=='n'||expected.xml_type!=='n'||actual.formula?.present||expected.formula?.present)return false;
  const a=copy(actual),b=copy(expected);
  for(const key of ['text','raw_value']){const x=decimalValue(a[key]),y=decimalValue(b[key]);if(x===null||x!==y)return false;delete a[key];delete b[key];}
  const x=decimalValue(a.cache?.raw_value),y=decimalValue(b.cache?.raw_value);if(x===null||x!==y)return false;
  delete a.cache.raw_value;delete b.cache.raw_value;return same(a,b);
}
function sameBooleanRecord(actual,expected){
  if(actual.state!=='value'||expected.state!=='value'||actual.xml_type!=='b'||expected.xml_type!=='b'||actual.formula?.present||expected.formula?.present)return false;
  const booleanValue=text=>text==='1'||text==='True'?'1':text==='0'||text==='False'?'0':null;
  const a=copy(actual),b=copy(expected);
  for(const key of ['text','raw_value']){const x=booleanValue(a[key]),y=booleanValue(b[key]);if(x===null||x!==y)return false;delete a[key];delete b[key];}
  const x=booleanValue(a.cache?.raw_value),y=booleanValue(b.cache?.raw_value);if(x===null||x!==y)return false;
  delete a.cache.raw_value;delete b.cache.raw_value;return same(a,b);
}
function officeObservation(index,item,representation=false,displayRule=false,booleanRule=false,rectangularRule=false){
  const expected=item.locator.kind==='docx'?item.expected_records:item.expected_cells;
  const selected=expected.map(r=>index.byRecord.get(item.document_id+'#'+r.id)),differences=[];
  let lastObservedRow=-Infinity,lastObservedColumn=-Infinity;
  if(displayRule&&item.locator.kind==='workbook')for(const o of index.byRecord.values())if(o.document_id===item.document_id&&o.record?.sheet?.index===item.locator.sheet.index&&o.record.sheet.name===item.locator.sheet.name){lastObservedRow=Math.max(lastObservedRow,o.record.row);lastObservedColumn=Math.max(lastObservedColumn,o.record.column);}
  for(const [n,o]of selected.entries()){
    const e=expected[n];
    if(!o){
      if(displayRule&&Number.isFinite(lastObservedRow)&&e.row>lastObservedRow&&e.state==='format_only'&&e.text===null&&e.raw_value===null&&!e.formula?.present&&!e.cache?.element_present&&!e.merges?.length){differences.push({kind:'omitted_trailing_format_only',record_id:e.id});continue;}
      if(rectangularRule&&Number.isFinite(lastObservedColumn)&&e.column>lastObservedColumn&&e.state==='format_only'&&e.text===null&&e.raw_value===null&&!e.formula?.present&&!e.cache?.element_present&&!e.merges?.length){differences.push({kind:'omitted_trailing_format_column',record_id:e.id});continue;}
      return {outcome:'missing',blocks:selected.filter(Boolean),code:'WHOLE_PAPER_UNMAPPED_OR_MISSING'};
    }
  }
  // Preserve the existing missing-record precedence before testing present values.
  for(const [n,o]of selected.entries()){
    if(!o)continue;
    const e=expected[n];
    if(!same(o.record,e)){
      if(displayRule&&item.locator.kind==='workbook'&&sameDecimalRecord(o.record,e)){differences.push({kind:'exact_decimal_spelling',record_id:e.id});continue;}
      if(booleanRule&&item.locator.kind==='workbook'&&sameBooleanRecord(o.record,e)){differences.push({kind:'exact_boolean_spelling',record_id:e.id});continue;}
      return {outcome:'wrong_semantic_unit',blocks:selected.filter(Boolean)};
    }
  }
  const records=selected.filter(Boolean);
  if(item.locator.kind==='workbook'){
    const actualMerges=[...new Set(records.flatMap(o=>o.record.merges??[]))].sort();
    if(!same(actualMerges,[...(item.expected_merged_ranges??[])].sort()))return {outcome:'wrong_semantic_unit',blocks:records,code:'WHOLE_PAPER_MERGE_MISMATCH'};
    if(representation&&records.some(o=>o.record.formula?.present&&o.origin!=='source_read'
      &&(o.binding?.formula_observed!==true||o.binding?.source_context_only_fields?.some(k=>k==='formula'||k==='cache'))))return {outcome:'missing',blocks:records,code:'WHOLE_PAPER_FORMULA_OBSERVATION_MISSING'};
    const qualified=representation?sharedFormulaQualification(item).ids:new Set();
    if(records.some(o=>(o.record.unresolved||o.record.formula?.present&&(!o.record.cache?.element_present||!o.record.formula.text))&&!qualified.has(o.record.id)))return {outcome:'missing',blocks:records,code:'WHOLE_PAPER_FORMULA_CACHE_UNRESOLVED'};
    for(const context of Object.values(item.context_bindings))for(const locator of context.locators)if(!index.byLocator.has(locKey(locator)))return {outcome:'missing',blocks:records,code:'WHOLE_PAPER_CONTEXT_BINDING_INVALID'};
  }
  return {outcome:'matched',blocks:records,...(differences.length?{representation_differences:differences}:{})};
}

export function compareWholePaperParserRuns(input={},services={}){
  const denominator=Array.isArray(input.referenceManifest?.items)?input.referenceManifest.items.length:0;
  const inventory={schema_version:'phase21-reference-comparison-whole-paper-1.0',reference_kind:'accepted_assisted',evidence_denominator:denominator};
  const nonComparable=errors=>({...inventory,status:'not_comparable',comparison_identity:null,errors:[...new Set(errors)].sort(),candidate:{status:'not_comparable',disposition:'candidate_only'},limitations:['Local record validation only; not authentication, independent gold, scientific truth or execution authorization.']});
  try{
    const {baselineRun:b,candidateRun:c,referenceManifest:r,comparisonPolicy:p,candidateDescriptor:d}=input;
    const representationRequested=Object.hasOwn(r??{},'evaluation_profile')||Object.hasOwn(p??{},'evaluation_profile');
    const representation=r?.evaluation_profile===REPRESENTATION&&p?.evaluation_profile===REPRESENTATION;
    if(representationRequested){
      Object.assign(inventory,{evaluation_profile:REPRESENTATION,reference_kind:REPRESENTATION_KIND,evaluation_scope:'source_representation_fidelity',scientific_eligible:false,computation_verified:false,retained_scientific_uncertainties:{source_scope:[],shared_formula_groups:[],contexts:[]}});
      inventory.retained_scientific_uncertainties=representationUncertainties(r);
      if(!representation)return nonComparable(['WHOLE_PAPER_EVALUATION_PROFILE_MISMATCH']);
    }
    if(Object.hasOwn(input,'goldManifest'))return nonComparable(['REFERENCE_AND_GOLD_MUTUALLY_EXCLUSIVE']);
    const errors=[...validateWholePaperRun(b).errors,...validateWholePaperRun(c).errors,...validateWholePaperReference(r).errors];
    if(errors.length)return nonComparable(errors);
    inventory.source_document_map=copy(sourceMap(b.sources));inventory.source_coverage={baseline:copy(b.source_coverage),candidate:copy(c.source_coverage),required:copy(r.required_coverage)};
    errors.push(...validateReferenceCoverage(r,c));
    if(representation)errors.push(...representationSourceErrors(r,c));
    const basis={kind:representation?REPRESENTATION_KIND:'accepted_assisted',decision_ref:'D-21-35',corpus_id:'phase21-twelve-paper',paper_id:r.acceptance.paper_id,reference_fingerprint:hash(r)};
    if(b.side!=='baseline'||c.side!=='candidate'||!same(sourceMap(b.sources),sourceMap(c.sources))||!same(sourceMap(b.sources),sourceMap(r.source_document_map))||!same(b.required_coverage,r.required_coverage)||!same(c.required_coverage,r.required_coverage))errors.push('WHOLE_PAPER_COMPARISON_SOURCE_MISMATCH');
    if(p?.location_contract!=='phase21-whole-paper-1.0'||p.central_evidence_rule!=='reject'||!same(p.reference_basis,basis)||!Array.isArray(p.locator_maps)||Object.keys(p).some(k=>!['location_contract','central_evidence_rule','reference_basis','locator_maps','policy_version','evidence_unit_maps','citation_spans',...(representation?['evaluation_profile','representation_rules']:[])].includes(k))||Object.hasOwn(p??{},'representation_rules')&&!DISPLAY_RULES.includes(p.representation_rules))errors.push('WHOLE_PAPER_POLICY_INVALID');
    const pdfIds=new Set(r.items.filter(i=>i.locator.kind==='pdf').map(i=>i.evidence_id)),pdfDocuments=new Set(r.source_document_map.filter(s=>s.kind==='pdf'&&s.purpose==='content').map(s=>s.document_id));
    if(p?.evidence_unit_maps?.items?.some(i=>!pdfIds.has(i.evidence_id))||p?.citation_spans?.items?.some(i=>!pdfIds.has(i.evidence_id))||p?.locator_maps?.some(m=>![m.gold_locator,...(m.baseline_locators??[]),...(m.candidate_locators??[])].every(l=>l&&pdfDocuments.has(l.document_id)&&(!l.kind||l.kind==='pdf'))))errors.push('WHOLE_PAPER_PDF_POLICY_SCOPE_INVALID');
    if(d?.backend_kind!=='hybrid'||d.independent_backend!==false||d.default_change!==false||!same(sourceMap(d.source_document_map??[]),sourceMap(c.sources)))errors.push('WHOLE_PAPER_CANDIDATE_INVALID');
    if(errors.length)return nonComparable(errors);
    const pdf=services.observePdfItems(b.pdf_run,c.pdf_run,r.items.filter(i=>i.locator.kind==='pdf').map(i=>i.legacy_item),p);
    if(pdf.errors.length)return nonComparable(pdf.errors);
    const bi=observationIndex(b),ci=observationIndex(c),bo=new Map(),co=new Map();
    const displayRule=representation&&DISPLAY_RULES.includes(p.representation_rules),booleanRule=representation&&[BOOLEAN_DISPLAY_RULE,RECTANGULAR_DISPLAY_RULE].includes(p.representation_rules),rectangularRule=representation&&p.representation_rules===RECTANGULAR_DISPLAY_RULE;
    for(const item of r.items){bo.set(item.evidence_id,item.locator.kind==='pdf'?pdf.baseline.get(item.evidence_id):officeObservation(bi,item,representation,displayRule,booleanRule,rectangularRule));co.set(item.evidence_id,item.locator.kind==='pdf'?pdf.candidate.get(item.evidence_id):officeObservation(ci,item,representation,displayRule,booleanRule,rectangularRule));}
    const critical=r.items.filter(i=>i.centrality==='central'&&(!matched(co.get(i.evidence_id))||i.locator.kind==='workbook'&&!matched(bo.get(i.evidence_id))));
    const docxRejected=r.items.some(i=>i.locator.kind==='docx'&&!matched(co.get(i.evidence_id)));
    const shared=r.items.filter(i=>bo.get(i.evidence_id).outcome==='missing'&&co.get(i.evidence_id).outcome==='missing');
    return {...inventory,status:critical.length||docxRejected?'rejected':'compared',comparison_identity:hash({contract:'phase21-whole-paper-1.0',...input}),errors:[],baseline_run_fingerprint:hash(b),candidate_run_fingerprint:hash(c),reference_manifest_fingerprint:hash(r),comparison_policy_fingerprint:hash(p),reference_basis:copy(basis),reference_method:copy(r.method),reference_scope:copy(r.scope),critical_missing:critical.map(copy),shared_omissions:shared.map(copy),category_metrics:services.metrics(r.items,bo,co),resource_observations:services.resourceObservations(b,c),evidence_unit_observations:r.items.map(i=>({evidence_id:i.evidence_id,baseline:copy(bo.get(i.evidence_id)),candidate:copy(co.get(i.evidence_id))})),candidate:{status:'accepted_for_comparison',disposition:'candidate_only',backend_kind:'hybrid',default_status:'mineru_production_default_unchanged'},limitations:['Assisted nonblind reference and source-reading hybrid share evidence; not independent gold or backend.','Compared is source-representation evidence, not verification of scientific truth, derived computations, user authority or publication.']};
  }catch{return nonComparable(['WHOLE_PAPER_COMPARISON_INPUT_INVALID']);}
}
