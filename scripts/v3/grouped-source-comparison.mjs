import {createHash} from 'node:crypto';
import {canonicalizeV3Json} from './semantic-package-validator.mjs';
import {createParserRunRecord,deriveParserRunIdentity} from './parser-adapter.mjs';

const hash=x=>'sha256:'+createHash('sha256').update(canonicalizeV3Json(x)).digest('hex');
const bytes=x=>'sha256:'+createHash('sha256').update(x).digest('hex');
const norm=x=>String(x??'').replace(/\s+/g,' ').trim();
const need=(ok,why)=>{if(!ok)throw Error('GROUPED_REVIEW_INVALID:'+why);};
const same=(a,b)=>hash(a)===hash(b);
const clean=x=>norm(x.replace(/<[^>]*>/g,'').replaceAll('&amp;','&').replaceAll('&nbsp;',' '));

/** Finite table shapes used by the registered units; all ranges retain original bytes. */
export function reviewedTableRows(block){
 const rows=[],text=block.text;
 const cell=(raw,start,extra={})=>{const lead=raw.length-raw.trimStart().length,end=start+raw.trimEnd().length;return {text:clean(raw),start:start+lead,end,...extra};};
 if(/<table\b/i.test(text)){
  for(const tr of text.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)){const offset=tr.index+tr[0].indexOf('>')+1,cells=[];
   for(const td of tr[1].matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi)){const start=offset+td.index+td[0].indexOf('>')+1;cells.push(cell(td[2],start,{colspan:Number(td[1].match(/colspan=["']?(\d+)/i)?.[1]??1),rowspan:Number(td[1].match(/rowspan=["']?(\d+)/i)?.[1]??1)}));}
   if(cells.length)rows.push({cells,kind:'html'});
  }
 }else for(const line of text.matchAll(/[^\n]+/g)){
  const sep=line[0].includes('|')?'|':line[0].includes('\t')?'\t':null;if(!sep)continue;const cells=[];let offset=line.index;
  for(const [i,raw]of line[0].split(sep).entries()){const m=i===0?raw.match(/^(.+?):\s*(?=[\d.])/):null;if(m){cells.push(cell(m[1],offset));cells.push(cell(raw.slice(m[0].length),offset+m[0].length));}else if(i>0&&raw.includes(';')){let at=offset;for(const piece of raw.split(';')){cells.push(cell(piece,at));at+=piece.length+1;}}else cells.push(cell(raw,offset));offset+=raw.length+1;}
  rows.push({cells,kind:'delimited'});
 }
 const grid=[];rows.forEach((row,ri)=>{grid[ri]??=[];let col=0;for(const c of row.cells){while(grid[ri][col])col++;const w=c.colspan??1,h=c.rowspan??1;need(w>0&&w<=20&&h>0&&h<=10,'table-span');for(let y=0;y<h;y++){grid[ri+y]??=[];for(let x=0;x<w;x++){need(!grid[ri+y][col+x],'overlapping-table-span');grid[ri+y][col+x]=c;}}col+=w;}row.grid=grid[ri];});return rows;
}
const tableTitle=(text,n)=>new RegExp('\\bT\\s*A\\s*B\\s*L\\s*E\\s*'+n+'\\b','i').test(text);

export function reviewedStructuralSelection(block,rule){
 try{
  need(block?.type==='table'&&tableTitle(block.text,rule.kind==='table_row_axis'?3:1),'table-context');const rows=reviewedTableRows(block);let parts;
  if(rule.kind==='paired_column_label'){
   let found=[];
   for(const row of rows){const c=row.grid;if(c.length!==7||c[3]===c[6]||![rule.expected_label,'Incidence: '+rule.expected_label].includes(c[3]?.text)||![rule.expected_label,'Mortality: '+rule.expected_label].includes(c[6]?.text))continue;
    const own=row.kind==='delimited'&&/^Incidence\s*:/.test(c[1]?.text)&&/^Mortality\s*:/.test(c[4]?.text);
    const above=rows.slice(0,rows.indexOf(row)).some(r=>r.grid.length===7&&r.grid.slice(1,4).every(x=>x?.text==='Incidence')&&r.grid.slice(4,7).every(x=>x?.text==='Mortality'));
    if(own||above)found.push([c[3],c[6]].map(x=>({...x,start:x.start+(x.text.endsWith(rule.expected_label)?x.text.length-rule.expected_label.length:0)})));
   }need(found.length===1,'paired-headers');parts=found[0];
  }else if(rule.kind==='table_row_axis'){
   need(rule.source_header_is_blank===true&&rule.numeric_columns_after_label===8&&rule.anchor_rows?.length>=2,'row-axis-contract');
   const line=block.text.split('\n').find(l=>l.startsWith('Columns:'));
   if(line){const actual=[...line.matchAll(/(Incidence|Mortality)—(Males|Females):/g)].map(m=>[m[1],m[2]]);need(same(actual,[['Incidence','Males'],['Incidence','Females'],['Mortality','Males'],['Mortality','Females']]),'axis-column-groups');}
   else {need(rows.some(r=>r.grid.length===9&&r.grid.slice(1,5).every(c=>c?.text==='Incidence')&&r.grid.slice(5,9).every(c=>c?.text==='Mortality')),'axis-metrics');need(rows.some(r=>r.grid.length===9&&[1,3,5,7].every((j,k)=>r.grid[j]?.text.startsWith(k%2?'Females':'Males'))),'axis-sex-groups');}
   parts=rule.anchor_rows.map(label=>{const matches=rows.filter(r=>r.cells.length===9&&r.cells[0].text===label&&r.cells.slice(1).every(c=>/^[\d,]+(?:\.\d+)?$/.test(c.text)&&(c.colspan??1)===1));need(matches.length===1,'axis-row:'+label);return matches[0].cells[0];});
  }else need(false,'structural-kind');
  return {ok:true,parts:parts.map(({start,end})=>({start,end})),unit:{kind:rule.kind,descriptor:rule.expected_descriptor??rule.expected_label}};
 }catch(e){return {ok:false,reason:e.message};}
}

/** Literal equality after only the explicitly registered representational operation. */
export function groupedReviewedUnit(text,rule){
 try{let value=norm(text);need(Array.isArray(rule.glyphs??[]),'glyph-list');
  for(const g of rule.glyphs??[]){if(g==='hyphen')value=value.replaceAll('‐','-');else if(g==='apostrophe')value=value.replaceAll('’',"'");else if(g==='inline-cite11'){const re=/standard population(?:¹¹|<sup>11<\/sup>|\$\s*\^\s*\{?11\}?\s*\$)/g;need([...value.matchAll(re)].length===1,'inline-citation');value=value.replace(re,'standard population[cite:11]');}else if(g==='figure21'){need(/^F\s*I\s*G\s*U\s*R\s*E\s+2\s*1\b/.test(value),'figure-label');value=value.replace(/^F\s*I\s*G\s*U\s*R\s*E\s+2\s*1\b/,'FIGURE 21');}else need(false,'unknown-glyph');}
  if(rule.kind==='citation_digits'){need(/^(?:\d+|[⁰¹²³⁴⁵⁶⁷⁸⁹]+)$/.test(value),'citation-token');value=[...value].map(c=>'⁰¹²³⁴⁵⁶⁷⁸⁹'.includes(c)?String('⁰¹²³⁴⁵⁶⁷⁸⁹'.indexOf(c)):c).join('');}
  else if(rule.kind==='dot_placeholder'){need(value==='.'||value==='·','dot-marker');value='nonnumeric-dot';}
  else if(rule.kind==='grouped_integer'){need(/^\d[\d,]*\d$/.test(value),'integer-token');value=value.replaceAll(',','');}
  else need(rule.kind==='literal','unit-kind');return {ok:true,unit:value};
 }catch(e){return {ok:false,reason:e.message};}
}

function recordMap(binding){const out=new Map();for(const r of binding.records){need(!out.has(r.id)&&bytes(r.bytes)===r.sha256,'record-bytes');out.set(r.id,JSON.parse(r.bytes));}return out;}
function grouped(record,material,id){
 need(record.paper_id===material.paper_id&&record.status==='complete'&&Array.isArray(record.groups)&&Array.isArray(record.unresolved),'record-shape');
 need(record.groups.length===Object.keys(material.groups).length&&new Set(record.groups.map(g=>g.group_id)).size===record.groups.length,'group-set');
 for(const g of record.groups){need(same([...g.covered_case_ids].sort(),[...(material.groups[g.group_id]??[])].sort()),'group-members');const individual=[...(g.decisions??[]),...(g.exceptions??[])];need(new Set(individual.map(d=>d.case_id)).size===individual.length&&individual.every(d=>g.covered_case_ids.includes(d.case_id)),'group-decisions');if(g.shared_decision)need(g.group_id==='placeholder_dots'&&!(g.decisions??[]).length,'shared-group-scope');else need(same(individual.map(d=>d.case_id).sort(),[...g.covered_case_ids].sort()),'individual-coverage');}
 const g=record.groups.find(g=>g.covered_case_ids.includes(id));need(g,'case-membership');return {group:g,decision:[...(g.exceptions??[]),...(g.decisions??[])].find(d=>d.case_id===id)??g.shared_decision};
}
function decode(binding,parent){
 need(binding?.version==='grouped-source-binding-1','version');const {version,fingerprint,...payload}=binding;need(fingerprint===hash(payload),'fingerprint');need(binding.parent_fingerprint===hash(parent)&&['native','hybrid'].includes(binding.side),'parent');
 const records=recordMap(binding),a=records.get('revision'),b=records.get('review');need(a&&b&&binding.materials.paper_id===binding.paper_id,'paper');
 for(const record of [a,b])need(record.unresolved.every(u=>u.case_id?['table1-notes-d2557ba6d89db28d','table3-sample-04acb19e8c0a8d8c'].includes(u.case_id):['Dot placeholders','References 182 and 183','Raster typography','Runtime provenance'].includes(u.scope)),'unresolved-scope');
 for(const s of parent.sources)need(binding.source_files.some(f=>f.document_id===s.document_id&&f.sha256===s.source_sha256&&!f.physical_page),'source-map');
 const cases=new Map(),oldRefs=binding.original_reference.items,newRefs=binding.reference.items;
 need(oldRefs.length===newRefs.length&&new Set(newRefs.map(r=>r.evidence_id)).size===newRefs.length,'denominator');
 for(const r of newRefs){const old=oldRefs.find(o=>o.evidence_id===r.evidence_id),change=binding.reference_changes.find(c=>c.evidence_id===r.evidence_id);need(old,'reference-id');if(!same(old,r)){need(change&&change.old===old.expected_semantic_unit&&change.new===r.expected_semantic_unit,'reference-scope');const strip=o=>{const {expected_semantic_unit,source_record_ref,source_record_revision,source_record_fingerprint,...rest}=o;return rest;};need(same(strip(old),strip(r)),'reference-metadata');}}
 need(new Set(binding.cases.map(c=>c.case_id)).size===binding.cases.length,'duplicate-case');
 need(same(binding.cases.map(c=>c.case_id).sort(),[...binding.materials.cases.map(c=>c.case_id),...binding.reused_case_ids].sort()),'case-set');
 for(const c of binding.cases){const ref=newRefs.find(r=>r.evidence_id===c.case_id),old=oldRefs.find(r=>r.evidence_id===c.case_id);need(ref&&old,'reference');let first,second;
  if(binding.reused_case_ids.includes(c.case_id)){
   need(c.kind==='grouped_integer','reused-profile');const ra=records.get('numeric-a'),rb=records.get('numeric-b');first=ra.cells.find(x=>x.evidence_id===c.case_id);second=rb.cells.find(x=>x.evidence_id===c.case_id);need(first&&second&&first.status==='read'&&second.status==='read'&&first.observed_literal===second.observed_literal&&first.observed_literal===ref.expected_semantic_unit,'numeric-source');need(first.physical_page===ref.locator.page_number&&second.physical_page===first.physical_page&&first.row===second.row&&first.column_path===second.column_path,'numeric-coordinate');need(c.case_id==='table2-r37-mortality_males_cases'&&c.cell?.row_label===first.row&&c.cell.column_id==='mortality_males_cases'&&first.column_path==='Mortality > Males > Cases','numeric-cell-contract');for(const rr of [ra,rb])need(rr.pages.some(p=>p.physical_page===first.physical_page&&p.status==='read'),'numeric-view');
  }else{
   const material=binding.materials.cases.find(m=>m.case_id===c.case_id);need(same(material.reference,old),'reference-origin');
   const kind=material.group_id==='placeholder_dots'?'dot_placeholder':material.group_id==='citation_markers'?'citation_digits':c.case_id==='table3-sample-04acb19e8c0a8d8c'?'table_row_axis':c.case_id==='table1-notes-d2557ba6d89db28d'?'paired_column_label':'literal';need(c.kind===kind,'registered-profile');if(kind==='dot_placeholder')need(c.cell?.row_label===material.registered_cell.row_label&&c.cell.column_id===material.registered_cell.column_id,'registered-cell');
   first=grouped(a,binding.materials,c.case_id).decision;second=grouped(b,binding.materials,c.case_id).decision;need(first&&second&&second.review_status==='verified','review');need(first.reference.status===second.reference.status,'reference-agreement');
   for(const rr of [a,b]){const {group,decision}=grouped(rr,binding.materials,c.case_id);need(group.group_source_evidence.document_id===ref.document_id&&group.group_source_evidence.physical_pages.includes(ref.locator.page_number),'group-source-page');if(c.kind==='dot_placeholder'){const family=group.group_source_evidence.row_family_checks.find(r=>r.row_id===material.registered_cell.row_id);need(family&&family.row===c.cell.row_label&&family.physical_page===ref.locator.page_number&&c.cell.column_id.split('_')[1]===family.sex.toLowerCase(),'source-cell-family');}else need(decision.source_observation.physical_page===ref.locator.page_number,'source-case-page');}
   for(const side of Object.keys(material.failed_sides))need(first.candidates[side]?.classification===second.candidates[side]?.classification,'classification-agreement');
   for(const [rr,dd]of [[a,first],[b,second]]){need(dd.source_observation.document_id===ref.document_id,'source-document');need(rr.actual_viewed_pages.some(p=>p.document_id===ref.document_id&&p.physical_page===ref.locator.page_number&&p.viewed===true&&binding.source_files.some(f=>f.document_id===p.document_id&&f.physical_page===p.physical_page&&f.path===p.path&&/^sha256:[a-f0-9]{64}$/.test(f.sha256))),'source-view');}
   if(ref.expected_semantic_unit!==old.expected_semantic_unit)need(first.reference.status==='needs_correction'&&first.source_observation.literal===second.source_observation.literal&&ref.expected_semantic_unit===first.source_observation.literal,'source-reference-change');
   if(c.kind==='table_row_axis')need(first.reference.status==='structural_description_not_printed','row-axis-source');else need(['source_faithful','needs_correction'].includes(first.reference.status),'reference-support');
   const classification=first.candidates[binding.side]?.classification;if(classification==='unresolved')need(c.kind==='table_row_axis','unresolved-content');
  }
  const allowedGlyphs={hyphen:['ev_b2eb1d08e63110673088757f0e0ff11a','ev_5e74cf078dcbe46af4da5b0bcf82f0dd','draft-citation-182-183-bibliography-title-182','draft-citation-182-183-bibliography-title-183','ev_59d4b8e7dc039a8c4e254c9eebc9baaa','ev_680f75dcf6e6d308004f762dbe3fd2bc'],apostrophe:['ev_059ba23fbd0ce820c14d9245685dd3ce'],'inline-cite11':['ev_59d4b8e7dc039a8c4e254c9eebc9baaa'],figure21:['ev_680f75dcf6e6d308004f762dbe3fd2bc']};need((c.glyphs??[]).every(g=>allowedGlyphs[g]?.includes(c.case_id)),'registered-glyph');
  if(['table_row_axis','paired_column_label'].includes(c.kind)){const original=records.get('legacy');let value=original;for(const key of c.structural.original_descriptor_pointer.split('/').slice(1))value=value?.[key];need(value===ref.expected_semantic_unit&&c.structural.evidence_id===c.case_id,'structural-origin');need(c.kind===c.structural.kind&&c.structural.physical_page===ref.locator.page_number,'structural-kind');if(c.kind==='table_row_axis')need(same(c.structural.anchor_rows,['Eastern Africa','Australia/New Zealand'])&&c.structural.expected_descriptor==='Area','registered-axis');else need(c.structural.expected_label==='% of all sites'&&same(c.structural.required_metric_groups,['Incidence','Mortality']),'registered-headers');}
  cases.set(c.case_id,{rule:c,ref,first,second});
 }return {cases,records};
}

export function deriveGroupedReviewedRun(proof){
 need(proof?.version==='reviewed-derivation-3'&&proof.approval?.scope==='bounded-source-reviewed-derivation'&&typeof proof.approval.id==='string','derivation');const {parent_run:parent,binding,operations}=proof,{cases}=decode(binding,parent),run=createParserRunRecord(parent),seen=new Set(),appended=new Set();need(Array.isArray(operations)&&operations.length>0,'operations');
 for(const op of operations){const c=cases.get(op.case_id),p=parent.blocks.find(b=>b.id===op.parent_id);need(c&&p&&!seen.has(op.operation_id),'operation-case');seen.add(op.operation_id);need(hash(p)===op.parent_fingerprint&&p.locator.document_id===c.ref.document_id&&p.locator.page_number===c.ref.locator.page_number,'operation-parent');
  need(c.first.candidates?.[binding.side]?.affected_parent_ids.includes(p.id)&&c.second.candidates?.[binding.side]?.affected_parent_ids.includes(p.id),'reviewed-parent');
  const literal=c.first.source_observation.literal;need(literal===c.second.source_observation.literal,'two-source-literals');
  if(op.kind==='append_row'){
   need(!appended.has(c.rule.case_id),'repeat-source-row');appended.add(c.rule.case_id);
   need(c.first.candidates[binding.side].classification==='missing_content'&&p.type==='table'&&op.block.id!==p.id&&!run.blocks.some(b=>b.id===op.block.id),'append-scope');need(op.block.text===literal&&norm(literal)===norm(c.ref.expected_semantic_unit),'append-literal');need(same(op.block,{...p,id:op.block.id,text:literal,locator:{...p.locator,source_block_id:op.block.id}}),'append-block');run.blocks.push(structuredClone(op.block));run.normalization_audit.mappings.push({document_id:p.locator.document_id,source_item_index:run.blocks.length-1,disposition:'retained'});
  }else if(op.kind==='replace_text'){
   need(['representation_only','content_error'].includes(c.first.candidates[binding.side].classification)&&typeof op.from==='string'&&op.from&&typeof op.to==='string'&&op.to&&p.text.split(op.from).length===2,'replace-scope');const originalScope=binding.materials.cases.find(m=>m.case_id===op.case_id)?.failed_sides[binding.side]?.mapping;const range=originalScope?.parts[0],offset=p.text.indexOf(op.from);need(originalScope?.parts.length===1&&range.locator.source_block_id===p.id&&offset>=range.start&&offset+op.from.length<=range.end,'replace-range');const result=p.text.replace(op.from,op.to);need(result===op.replacement_text&&bytes(result)===op.replacement_sha256,'replace-bytes');const whole=groupedReviewedUnit(result,c.rule),source=groupedReviewedUnit(literal,c.rule);need(whole.ok&&source.ok&&whole.unit.includes(source.unit),'replace-source-postcondition');need(run.blocks.find(b=>b.id===p.id).text===p.text,'repeat-patch');run.blocks.find(b=>b.id===p.id).text=result;
  }else need(false,'operation-kind');
 }
 for(const [id,c]of cases)if(c.first.candidates?.[binding.side]?.classification==='missing_content')need(appended.has(id),'unapplied-source-row');
 run.normalization_version+='+grouped-source-reviewed-3';run.config_fingerprint=hash({parent:hash(parent),proof:hash(proof)});run.approval_fingerprint=hash(proof.approval);run.parser_run_id=deriveParserRunIdentity(run);return run;
}

function cellScope(value,selection,cell){
 if(value.blocks.length!==1||selection.parts.length!==1)return false;const block=value.blocks[0],part=selection.parts[0],row=reviewedTableRows(block).filter(r=>r.cells[0]?.text===cell.row_label&&r.cells.length===13);if(row.length!==1)return false;const columns=['incidence_males_cases','incidence_males_asr_world_percent','incidence_males_cumulative_risk_percent','incidence_females_cases','incidence_females_asr_world_percent','incidence_females_cumulative_risk_percent','mortality_males_cases','mortality_males_asr_world_percent','mortality_males_cumulative_risk_percent','mortality_females_cases','mortality_females_asr_world_percent','mortality_females_cumulative_risk_percent'];const at=columns.indexOf(cell.column_id);if(at<0)return false;const field=row[0].cells[at+1];return (field.colspan??1)===1&&part.start>=field.start&&part.end<=field.end&&norm(value.selected_text)===field.text;
}

export function applyGroupedReviewedComparison(input,units,baselineObservations,candidateObservations){
 const spec=input.comparisonPolicy.reviewed_comparison,proof=input.candidateDescriptor.reviewed_derivation,binding=spec.binding;need(spec.version==='reviewed-comparison-3'&&proof?.version==='reviewed-derivation-3'&&same(proof.binding,binding),'policy');const {cases,records}=decode(binding,proof.parent_run);
 need(binding.baseline_fingerprint===hash(input.baselineRun)&&same(binding.reference,input.referenceManifest)&&same(deriveGroupedReviewedRun(proof),input.candidateRun),'comparison-inputs');need(same(spec.items.map(i=>i.evidence_id).sort(),[...cases.keys()].sort()),'rule-set');
 const observations=[],known=[];
 for(const [id,c]of cases){const selected=units.resolved.get(id);need(selected,'selected-unit');const observation={evidence_id:id,version:spec.version,reference:{raw_text:c.ref.expected_semantic_unit},source_case_id:id};
  for(const [side,values]of [['baseline',baselineObservations],['candidate',candidateObservations]]){
   const value=selected[side],mapping=selected.mapping[side];let converted,matched=false;
   if(side==='candidate'&&c.first.candidates?.[binding.side]){const cls=c.first.candidates[binding.side].classification;if(cls==='missing_content'){const op=proof.operations.find(o=>o.kind==='append_row'&&o.case_id===id);need(op&&value.blocks.length===1&&value.blocks[0].id===op.block.id&&mapping.parts.length===1&&mapping.parts[0].start===0&&mapping.parts[0].end===op.block.text.length,'source-row-selection');}else need(value.blocks.every(b=>c.first.candidates[binding.side].affected_parent_ids.includes(b.id)&&c.second.candidates[binding.side].affected_parent_ids.includes(b.id)),'selected-parent');}
   if(['table_row_axis','paired_column_label'].includes(c.rule.kind)){
    if(value.blocks.length&&value.outcome!=='wrong_page'){const block=value.blocks[0];converted=reviewedStructuralSelection(block,c.rule.structural);matched=converted.ok&&value.blocks.every(b=>b.id===block.id)&&same(mapping.parts.map(({start,end})=>({start,end})),converted.parts);}
   }else{converted=groupedReviewedUnit(value.selected_text,c.rule);const reference=groupedReviewedUnit(c.ref.expected_semantic_unit,c.rule);need(reference.ok,'reference-profile');matched=!['missing','wrong_page'].includes(value.outcome)&&converted.ok&&converted.unit===reference.unit;if(matched&&['dot_placeholder','grouped_integer'].includes(c.rule.kind))matched=cellScope(value,mapping,c.rule.cell);}
   const outcome=matched?'segmented_match':['missing','wrong_page'].includes(value.outcome)?value.outcome:'wrong_semantic_unit';observation[side]={raw_text:value.selected_text,raw_outcome:value.outcome,...converted,outcome};values.set(id,{...value,outcome});
  }
  const cls=c.first.candidates?.[binding.side]?.classification;if(['missing_content','content_error'].includes(cls)&&observation.candidate.outcome!=='segmented_match')known.push({case_id:id,disposition:'unresolved_candidate_content'});
  observations.push(observation);
 }
 return {reviewed_observations:observations,known_content_defects:known,reviewed_source_limits:{revision:records.get('revision').unresolved,review:records.get('review').unresolved},reviewed_derivation:{disposition:'reviewed_derivative',new_backend_execution:false,parent_run_fingerprint:hash(proof.parent_run),source_review_fingerprint:binding.fingerprint,authority_limit:'Bound source records andfinite local contracts;not source/model authentication,independent gold ornew parser performance.'}};
}
