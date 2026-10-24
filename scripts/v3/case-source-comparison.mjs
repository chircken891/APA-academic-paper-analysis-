import {createHash} from 'node:crypto';
import {canonicalizeV3Json} from './semantic-package-validator.mjs';
import {createParserRunRecord,deriveParserRunIdentity} from './parser-adapter.mjs';
import {reviewedTableRows} from './grouped-source-comparison.mjs';

const hash=x=>'sha256:'+createHash('sha256').update(canonicalizeV3Json(x)).digest('hex');
const bytes=x=>'sha256:'+createHash('sha256').update(x).digest('hex');
const norm=x=>String(x??'').replace(/\s+/g,' ').trim();
const same=(a,b)=>hash(a)===hash(b);
const need=(ok,why)=>{if(!ok)throw Error('CASE_REVIEW_INVALID:'+why);};
const at=(o,p)=>p.split('/').slice(1).reduce((v,k)=>v?.[k.replaceAll('~1','/').replaceAll('~0','~')],o);
export const CASE_SOURCE_PROFILES=Object.freeze({
 ref_215e8d368403591c5df61e9fa45b3268:'neighbour-density',ref_19678abeab82e19575d80a4d61ea3397:'ordered-vector-differences',
 ref_4939de78d337ce951e95857a38f900d5:'radial-birth-logistic',ref_51e3c8439e26f955fcae3e7c0e34d023:'restricted-pair-dispersion',
 ref_f17916442a3e0ba6e484be7454748a58:'pair-weight-product',ref_50b9e75203e3a227524e9d60edba2f21:'clade-log-power',
 ref_91cc1ed916e1c8c682389e6caa5834eb:'mu-clause',ref_437b9271c6877f7afccbb4d3879ba251:'apostrophe-caption',ref_30d7fc5c11dd0f2b2c0aff298b86685e:'simulation-power',
 ref_41c63b80783b6408735b56358fb892f3:'table-parent-offspring',ref_9c1d300a1551c9d8ed63d52b041dbbef:'table-two-tumours'
});
const supers={'⁰':'0','¹':'1','²':'2','³':'3','⁴':'4','⁵':'5','⁶':'6','⁷':'7','⁸':'8','⁹':'9','⁻':'-','ᵐ':'m'};
const subs={'₀':'0','₁':'1','₂':'2','ᵢ':'i','ⱼ':'j','ₖ':'k','ₗ':'l','ₘ':'m','ₙ':'n'};

// Only the six declared formula forms use this lexer. It preserves operations;
// it never evaluates or simplifies algebra, relabels indices, or supplies missing terms.
function mathText(raw,profile){
 need(typeof raw==='string','math-text');let text=raw.trim().replace(/^\$\$?\s*|\s*\$\$?$/g,'');
 function expand(s){let out='',i=0;const ws=()=>{while(i<s.length&&/\s/.test(s[i]))i++;};
  const arg=()=>{ws();need(s[i]==='{','tex-argument');let depth=1,start=++i;while(i<s.length&&depth){if(s[i]==='{')depth++;if(s[i]==='}')depth--;i++;}need(!depth,'tex-braces');return expand(s.slice(start,i-1));};
  while(i<s.length){if(s[i]!=='\\'){out+=s[i++];continue;}i++;if(['{','}',' '].includes(s[i])){out+=s[i++];continue;}const m=s.slice(i).match(/^[A-Za-z]+/);need(m,'tex-command');i+=m[0].length;const c=m[0];
   const symbols={rho:'ρ',sigma:'σ',pi:'π',Delta:'Δ',mu:'μ',sum:'Σ',mid:'|',cdot:'*'};
   if(c in symbols)out+=symbols[c];else if(c==='frac')out+='(('+arg()+')/('+arg()+'))';else if(c==='sqrt')out+='sqrt('+arg()+')';
   else if(c==='exp'||c==='log')out+=c;else if(c==='left'||c==='right'){ws();if(s[i]==='.')i++;}
   else if(c==='mathbf'||c==='mathrm'){const value=arg();if(c==='mathrm')need(['dense','cellradii','cell','radii'].includes(value.replace(/\s/g,'')),'tex-word');out+=value;}
   else if(c==='bf'){}else if(c==='vec'){const v=arg().trim();need(/^[pΔ]$/.test(v),'tex-vector');out+=v+'⃗';}
   else if(c==='tag'){const label=arg().trim(),expected={'neighbour-density':'1','radial-birth-logistic':'2','clade-log-power':'5'}[profile];need(label===expected,'equation-label');}
   else need(false,'tex-command:'+c);
  }return out;
 }
 text=expand(text).replaceAll('−','-').replaceAll('∑','Σ').replaceAll('·','*').replaceAll('√','sqrt')
  .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻ᵐ]+/gu,x=>'^{'+[...x].map(c=>supers[c]).join('')+'}')
  .replace(/[₀₁₂ᵢⱼₖₗₘₙ]+(?:,(?:[₀₁₂ᵢⱼₖₗₘₙ]+|cm))?/gu,x=>'_{'+[...x].map(c=>subs[c]??c).join('')+'}');
 const label={'neighbour-density':'1','radial-birth-logistic':'2','clade-log-power':'5'}[profile];
 if(label)text=text.replace(new RegExp('[.,]?\\s*\\('+label+'\\)\\s*$'),'').replace(/[.,]\s*$/,'');
 if(profile==='ordered-vector-differences')text=text.replace(/p⃗cm\b/g,'p⃗_{cm}');
 return text.trim();
}
function expression(text,profile){
 let i=0;const ws=()=>{while(/\s/.test(text[i]??'')&&i<text.length)i++;},peek=()=>{ws();return text[i];};
 const take=c=>{need(peek()===c,'math-expected:'+c);i++;};
 function script(){ws();if(text[i]==='{'||text[i]==='('){const open=text[i],close=open==='{'?'}':')';let depth=1,start=++i;while(i<text.length&&depth){if(text[i]===open)depth++;if(text[i]===close)depth--;i++;}need(!depth,'script-braces');return text.slice(start,i-1).trim();}
  const m=text.slice(i).match(/^(?:dense|cm|[ijkl],cm|[ijkl],[ijkl]|ij|[A-Za-z0-9]|-\d+)/);need(m,'script');i+=m[0].length;return m[0];}
 const indices=s=>s.replace(/\s/g,'').split(',').flatMap(v=>v==='ij'?['i','j']:[v]);
 function atom(){ws();let c=text[i];if(c==='-'||c==='+'){i++;return [c==='-'?'neg':'pos',expr(30)];}
  if(c==='('||c==='['||c==='{'){i++;const x=expr(0);take(c==='('?')':c==='['?']':'}');return x;}
  if(c==='Σ'){i++;take('_');const condition=script().replace(/\s/g,'');const m=condition.match(/^([a-z]),([a-z])<([a-z])$/);need(m,'sum-range');let body=atom();while(peek()==='*'||(peek()&&/[A-Za-zρσπΔμ0-9]/.test(peek()))){if(peek()==='*')i++;body=['mul',body,atom()];}return ['sum',m.slice(1),body];}
  const number=text.slice(i).match(/^\d+(?:\.\d+)?/);if(number){i+=number[0].length;return ['number',number[0]];}
  const name=text.slice(i).match(/^(sqrt|exp|log|[A-Za-zρσπΔμ])/);need(name,'math-atom');i+=name[0].length;let node=['var',name[0]],sub=null,sup=null;
  if(text[i]==='⃗'){node.push('vector');i++;}else if(text[i]==='̄'||text[i]==='̃'){node.push(text[i]);i++;}
  while(peek()==='_'||peek()==='^'){const op=text[i++],value=script();if(op==='_'){need(sub===null,'duplicate-subscript');sub=indices(value);}else {need(sup===null,'duplicate-superscript');sup=value;}}
  if(sub!==null)node=['index',node,sub];
  if(sup!==null&&['w','f','σ'].includes(name[0])&&/^(?:m|dense)$/.test(sup))node=['index-power',node,sup];
  else if(sup!==null)node=['power',node,expression(sup,profile)];
  if(['sqrt','exp','log','b','ρ','W'].includes(name[0])&&peek()==='('){i++;const args=[expr(0)];while(peek()===','){i++;args.push(expr(0));}take(')');node=['call',node,args];}
  else if(['sqrt','exp','log'].includes(name[0]))node=['call',node,[atom()]];
  return node;
 }
 function expr(min){let lhs=atom();for(;;){const c=peek();if(c==='^'){if(40<min)break;i++;lhs=['power',lhs,expression(script(),profile)];continue;}let op,prec,implicit=false;if(c==='='){op='eq';prec=1;}else if(c==='+'||c==='-'){op=c==='+'?'add':'sub';prec=10;}else if(c==='*'||c==='/'){op=c==='*'?'mul':'div';prec=20;}else if(c&&/[A-Za-zρσπΔμΣ0-9({[]/.test(c)){op='mul';prec=20;implicit=true;}else break;
   if(prec<min)break;if(!implicit)i++;const rhs=expr(prec+1);lhs=[op,lhs,rhs];
  }return lhs;
 }
 const result=expr(0);need(peek()===undefined,'math-tail:'+text.slice(i));return result;
}
export function caseReviewedUnit(raw,profile='literal'){
 try{
  if(profile==='literal')return {ok:true,unit:norm(raw)};
  if(profile==='mu-clause')return {ok:true,unit:norm(raw).replace(/mutation rate [μµ] per cell division/g,'mutation rate μ per cell division')};
  if(profile==='apostrophe-caption')return {ok:true,unit:norm(raw).replace(/samples[’']/g,"samples'")};
  if(profile==='simulation-power')return {ok:true,unit:norm(raw).replace(/(?<!\d)10(?:⁴|\^\{4\}|\^4)(?![\d⁰¹²³⁴⁵⁶⁷⁸⁹])/g,'10^{4}')};
  need(Object.values(CASE_SOURCE_PROFILES).includes(profile)&&!profile.startsWith('table-'),'profile');let text=mathText(raw,profile),unit;
  if(profile==='ordered-vector-differences'){
   const m=norm(text).match(/^determine distances (.+?) between (.+?) and (.+?) and (.+?) between (.+?) and the tumour centre of mass$/);need(m,'vector-prose');unit={profile,relations:[expression(m[1],profile),expression(m[4],profile)],samples:[expression(m[2],profile),expression(m[3],profile),expression(m[5],profile)]};
  }else if(profile==='neighbour-density'){
   text=text.replace(/\s/g,'');need(text.startsWith('ρ(x)=Σ_'),'density-head');let start=7;need(text[start]==='{','density-condition');let depth=1,j=start+1;while(j<text.length&&depth){if(text[j]==='{')depth++;if(text[j]==='}')depth--;j++;}need(!depth,'density-condition');let condition=text.slice(start+1,j-1);while(condition.startsWith('{')&&condition.endsWith('}'))condition=condition.slice(1,-1);
   condition=condition.replace(/x_i/g,'x_{i}');const m=condition.match(/^([a-z])[:|]\|x-x_\{([a-z])\}\|<(\d+)\[cellradii\]$/);need(m,'density-distance-boundary');unit={profile,spatial_role:'vector',condition:m.slice(1),kernel:expression(text.slice(j),profile)};
  }else{if(profile==='pair-weight-product'){need(/^weights\s/.test(text),'weight-label');text=text.replace(/^weights\s+/,'');}unit={profile,expression:expression(text,profile)};need(unit.expression[0]==='eq','formula-equality');
   if(profile==='radial-birth-logistic'){
    // A leading minus on the printed stacked fraction and a minus on its linear
    // numerator denote this same signed ratio. No other algebra is simplified.
    const signed=node=>{if(!Array.isArray(node))return node;const value=node.map(signed);if(value[0]==='call'&&same(value[1],['var','exp'])&&value[2].length===1){const a=value[2][0];if(a[0]==='neg'&&a[1][0]==='div')value[2][0]=['signed-ratio','-',a[1][1],a[1][2]];else if(a[0]==='div'&&a[1][0]==='neg')value[2][0]=['signed-ratio','-',a[1][1],a[2]];}return value;};unit.expression=signed(unit.expression);
   }
  }
  return {ok:true,unit};
 }catch(e){return {ok:false,unit:null,reason:e.message};}
}

export function caseTableSelection(block,profile){
 try{need(block.type==='table','table-type');const rows=reviewedTableRows(block);let headerAt,cells;
  if(profile==='table-parent-offspring'){headerAt=rows.findIndex(r=>same(r.cells.map(c=>c.text),['Parent','Offspring']));need(headerAt>=0,'table-header');need(rows[headerAt+1]?.cells.length===2,'table-row');cells=[...rows[headerAt].cells,...rows[headerAt+1].cells];}
  else{need(profile==='table-two-tumours','table-profile');headerAt=rows.findIndex(r=>same(r.cells.map(c=>c.text),['T1','T2']));need(headerAt>=0,'table-groups');const h=rows[headerAt],children=rows[headerAt+1],row=rows[headerAt+2];need(same(children?.cells.map(c=>c.text),['parent','offspring','mutations','parent','offspring','mutations'])&&row?.cells.length===6,'table-columns');if(h.kind==='html')need(h.cells[0].colspan===3&&h.cells[1].colspan===3,'table-group-spans');cells=[...h.cells,...children.cells,...row.cells];}
  need(cells.every(c=>(c.rowspan??1)===1),'table-rowspan');return {ok:true,parts:cells.map(({start,end})=>({start,end})),text:cells.map(c=>c.text).join(' ')};
 }catch(e){return {ok:false,reason:e.message};}
}

const REFERENCE_EDITS={
 ref_627094ab6f54833f74bdb0f4fa4d1ae4:[['parent and','parental and',1]],ref_6b430b2be042cfea4aa9b13a834a5d48:[['if the cells','if these cells',1]],
 ref_4029885218e26ea2506c171626c8fe7b:[['Out of 308 mutations in T1, 58 appear in more than 4 samples.','(Out of 308 mutations in T1, 58 appear in more than 4 samples.)',1]],
 ref_8a8aef9dcde671a429c4524639d6b8cc:[['however, does','however does',1],['it is possible','it is thus possible',1],['an infinite','a infinite',1]],
 ref_5f2b9fd33f6cfbc79b39b5979eed140b:[['exonic','exomic',1]],ref_39587e06e7eb6bc814e2cc327a972f4d:[['radii','radius',1]],
 ref_eedae44428cfa8c3ffe17f0a6d0a944a:[['surface and volume','volume and surface',1],['inference), we','inference) we',1]],
 ref_19678abeab82e19575d80a4d61ea3397:[['Δ̄','Δ⃗',2],['p̄','p⃗',4]],ref_51e3c8439e26f955fcae3e7c0e34d023:[['i,j<i','j,i<j',2]]
};
const NATIVE_EDITS={ref_1eb6dc6fda39845201f021a31c3d419a:[['dispersion parameter for 217','dispersion parameter σ for 217',1]],ref_8a5d052da2b3aaf62913c84f97d33ba9:[['lower than the planar','lower than in the planar',1]],ref_78010040805087678c3956666b809153:[['deeply sequenced samples and used','deeply sequence samples and used',1]],ref_a7a670afcdc973f2ad559d44ff654ea1:[['estimate of n̄ = 4000','estimate of ñ = 4000',1]]};
const ANNOTATIONS={ref_7f2accf04b276afdc24aa0e590ad0fcd:'bottom left',ref_77df7aa7cd826d7dbedf193b6a684b11:'bottom left',ref_be2197023efdd3a1d51afb9d6e729827:'bottom right'};
const EXTRA='known-purity-ploidy-R2133-03';
const LEGACY_CASES={ref_51e3c8439e26f955fcae3e7c0e34d023:['R2133-02',0],ref_f17916442a3e0ba6e484be7454748a58:['R2133-02',0],ref_50b9e75203e3a227524e9d60edba2f21:['R2133-04',2],[EXTRA]:['R2133-03',1]};
const CROSS_CASES={ref_7c0f0d39c7d42774ce319cb1d3f50c1b:['hybrid-0040',4],ref_21f83371b2d20ba8cda29a29155ed33c:['hybrid-0066',10]};
const edit=(text,changes)=>changes.reduce((s,[from,to,count])=>{need(s.split(from).length-1===count,'edit-occurrences');return s.split(from).join(to);},text);
function decode(binding,parent){
 need(binding?.version==='case-source-binding-1'&&binding.paper_id==='02'&&['native','hybrid'].includes(binding.side),'binding-version');
 const{version,fingerprint,...payload}=binding;need(hash(payload)===fingerprint&&hash(parent)===binding.parent_fingerprint,'binding-fingerprint');
 const records=new Map(),rawMeta=new Map();for(const r of binding.records){need(!records.has(r.id)&&bytes(r.bytes)===r.sha256,'record-bytes');records.set(r.id,JSON.parse(r.bytes));rawMeta.set(r.id,r);}
 const first=records.get('revision'),peer=records.get('review'),legacy=records.get('legacy'),excerpts=records.get('excerpts'),m=binding.materials;
 need(first?.paper_id==='02'&&peer?.paper_id==='02'&&first.task_id==='revision'&&peer.task_id==='review'&&first.status==='complete'&&peer.status==='complete','source-record');
 need(Array.isArray(first.global_unresolved)&&Array.isArray(peer.global_unresolved)&&Array.isArray(first.actual_viewed_pages)&&Array.isArray(peer.actual_viewed_pages),'source-limits');
 const limit=s=>typeof s==='string'&&(/7000.*3300|3300.*7000/.test(s)||/^p17 .*sum/.test(s)||/^Raster source cannot .*μ.*µ/.test(s)||/^p30 printed radius labels 50 and 450/.test(s)||/^Mathematical equivalence of p35 index relabeling and downstream consequences of purity\/ploidy renaming/.test(s));need([...first.global_unresolved,...peer.global_unresolved].every(limit),'unresolved-source-scope');
 for(const id of ['revision','review']){const seal=records.get(id+'-freeze'),completion=records.get(id+'-completion');need(seal?.result_sha256===rawMeta.get(id).sha256&&seal.completion_sha256===rawMeta.get(id+'-completion').sha256&&seal.agent_id===completion.agent_id,'freeze-completion');const message=completion.terminal.last_agent_message.trim().replace(/^```json\s*/,'').replace(/\s*```$/,'');need(same(JSON.parse(message),records.get(id)),'actual-return');}
 const run=records.get('review-run');need(Date.parse(records.get('revision-freeze').frozen_at)<=Date.parse(run.calls.find(c=>c.task_id==='review').started_at),'freeze-order');
 const{fingerprint:materialHash,...materialPayload}=m;need(hash(materialPayload)===materialHash,'material-fingerprint');
 need(m.paper_id==='02'&&same(m.reused_observations.record,legacy)&&m.reused_observations.sha256===rawMeta.get('legacy').sha256&&same(m.reviewed_excerpts.record,excerpts),'legacy-origin');
 for(const source of m.raw_records){const r=[...rawMeta.values()].find(r=>r.path===source.path);need(r?.sha256===source.sha256,'raw-origin');for(const block of source.blocks)need(hash(at(JSON.parse(r.bytes),block.pointer))===block.fingerprint,'raw-block-origin');}
 for(const sides of Object.values(m.page_context))for(const b of sides[binding.side])need(parent.blocks.some(p=>p.id===b.id&&bytes(p.text)===b.text_sha256&&same(p.locator,b.locator)),'original-parent-bytes');
 const ids=[...m.registered_cases.map(c=>c.case_id),m.known_extra_case.case_id];need(ids.length===28&&m.known_extra_case.case_id===EXTRA&&new Set(ids).size===28,'registered-set');
 need(same(peer.cases.map(c=>c.case_id).sort(),[...ids].sort())&&same(first.cases.map(c=>c.case_id).sort(),m.registered_cases.filter(c=>c.first_observation.kind==='new_revision_required').map(c=>c.case_id).sort()),'record-case-set');
 need(same(binding.cases.map(c=>c.case_id).sort(),[...ids].sort()),'rule-set');
 for(const s of parent.sources)need(binding.source_files.some(f=>f.document_id===s.document_id&&f.sha256===s.source_sha256&&!f.physical_page),'source-map');
 const original=binding.original_reference.items,refs=binding.reference.items;need(original.length===51&&refs.length===51&&new Set(refs.map(r=>r.evidence_id)).size===51,'denominator');
 const cases=new Map();for(const config of binding.cases){const material=m.registered_cases.find(c=>c.case_id===config.case_id)??m.known_extra_case,ref=refs.find(r=>r.evidence_id===config.case_id),a=material.first_observation.kind==='reuse_2133'?at(legacy,material.first_observation.pointer):first.cases.find(c=>c.case_id===config.case_id),b=peer.cases.find(c=>c.case_id===config.case_id);need(a&&b?.review_status==='verified','review-status');
  need(config.profile===(CASE_SOURCE_PROFILES[config.case_id]??'literal'),'registered-profile');
  if(config.cross_page){const expected=CROSS_CASES[config.case_id];need(binding.side==='hybrid'&&expected&&config.cross_page.parent_id===expected[0]&&config.cross_page.physical_page===expected[1],'registered-cross-page');}
  if(ref){need(same(material.reference,original.find(r=>r.evidence_id===ref.evidence_id)),'reference-origin');need(b.source_observation.document_id===ref.document_id,'source-document');need(b.source_observation.physical_page===ref.locator.page_number,'source-page');need(b.reference.status===(REFERENCE_EDITS[ref.evidence_id]?'needs_correction':'source_faithful'),'reference-disposition');}
  for(const value of Object.values(b.candidates))need(['representation_only','selection_or_transport','content_error'].includes(value.classification),'unresolved-candidate');
  for(const [record,observation]of material.first_observation.kind==='reuse_2133'?[[peer,b]]:[[first,a],[peer,b]]){
   need(observation.source_observation.document_id===binding.source_files.find(f=>!f.physical_page).document_id,'observation-document');need(record.actual_viewed_pages.some(p=>p.document_id===observation.source_observation.document_id&&p.physical_page===observation.source_observation.physical_page&&binding.source_files.some(f=>f.document_id===p.document_id&&f.physical_page===p.physical_page&&f.path===p.path)),'source-view');
  }
  if(material.first_observation.kind==='reuse_2133'){const expected=LEGACY_CASES[config.case_id];need(expected&&a.case_id===expected[0]&&material.first_observation.pointer==='/case_results/'+expected[1],'legacy-case-scope');need(a.case_id===material.first_observation.case_id&&a.source_read.physical_page===b.source_observation.physical_page&&binding.source_files.some(f=>f.path===a.source_read.image_path&&f.physical_page===a.source_read.physical_page),'legacy-view');}
  else{need(a.source_observation.physical_page===b.source_observation.physical_page,'source-page-agreement');need(a.reference.status===b.reference.status,'reference-agreement');for(const [side,value]of Object.entries(material.sides))if(value.outcome!=='segmented_match')need(a.candidates[side]?.classification===b.candidates[side]?.classification,'candidate-agreement');}
  need((b.unresolved??[]).every(u=>typeof u==='string'),'case-limits');cases.set(config.case_id,{config,material,ref,first:a,second:b});
 }
 for(const ref of refs){const old=original.find(r=>r.evidence_id===ref.evidence_id);need(old,'reference-id');const replacements=REFERENCE_EDITS[ref.evidence_id];if(replacements){const c=cases.get(ref.evidence_id);need(c.second.reference.status==='needs_correction','reference-support');need(ref.expected_semantic_unit===edit(old.expected_semantic_unit,replacements),'reference-edit');
   const firstText=c.material.first_observation.kind==='reuse_2133'?c.first.observed_transcription:c.first.source_observation.literal;for(const[,to]of replacements){const token=to==='if these cells'?'these cells':to==='inference) we'?'inference) we':to;need(firstText.includes(token)&&c.second.source_observation.literal.includes(token),'reference-token-source');}
   const strip=x=>{const{expected_semantic_unit,source_record_ref,source_record_revision,source_record_fingerprint,...rest}=x;return rest;};need(same(strip(ref),strip(old)),'reference-metadata');
  }else need(same(ref,old),'non-target-reference');}
 return{cases,records,rawMeta};
}
function expectedPatches(binding,parent,decoded){
 if(binding.side==='hybrid')return[];const result=[];for(const[id,c]of decoded.cases){if(c.second.candidates.native?.classification!=='content_error')continue;const block=parent.blocks.find(b=>c.second.candidates.native.parent_ids.includes(b.id));need(block,'correction-parent');let changes=NATIVE_EDITS[id];
  if(!changes){const assessment=c.second.corrected_2134_assessment;need(assessment?.status==='source_faithful'&&assessment.path===decoded.rawMeta.get('excerpts').path,'corrected-excerpt-review');const path=assessment.pointer.replace(/\/corrected_text$/,''),excerpt=at(decoded.records.get('excerpts'),path);need(excerpt&&excerpt.original_block.text===block.text,'excerpt-parent');changes=excerpt.declared_replacements.map(p=>[p.from,p.to,p.expected_occurrences]);need(edit(block.text,changes)===excerpt.corrected_text,'excerpt-replacement');}
  result.push({case_id:id,block_id:block.id,text:edit(block.text,changes)});
 }need(result.length===7&&result.some(p=>p.case_id===EXTRA),'known-content-set');return result;
}
function rawField(decoded,recordPath,pointer){const found=[...decoded.rawMeta].find(([,r])=>r.path===recordPath);need(found,'raw-record');return at(decoded.records.get(found[0]),pointer);}
export function deriveCaseReviewedRun(proof){
 need(proof?.version==='reviewed-derivation-4'&&proof.approval?.scope==='bounded-case-source-derivation'&&typeof proof.approval.id==='string','derivation');const{binding,parent_run:parent}=proof,decoded=decode(binding,parent),expected=expectedPatches(binding,parent,decoded),run=createParserRunRecord(parent),seen=new Set();
 for(const p of proof.patches){const exact=expected.find(e=>e.case_id===p.case_id);need(exact&&p.block_id===exact.block_id&&!seen.has(p.case_id),'patch-scope');seen.add(p.case_id);const b=run.blocks.find(b=>b.id===p.block_id);need(bytes(b.text)===p.original_sha256&&p.replacement_text===exact.text,'patch-bytes');b.text=p.replacement_text;}
 for(const p of expected.filter(p=>p.case_id!==EXTRA))need(seen.has(p.case_id),'unapplied-content');
 need(proof.annotations.length===2,'annotation-count');const panels=new Set();for(const op of proof.annotations){const raw=rawField(decoded,op.raw_path,op.raw_pointer),p=parent.blocks.find(b=>b.id===op.parent_id);need(p&&p.type==='figure'&&p.locator.page_number===38&&raw?.text===op.text&&raw.panel===op.panel&&['bottom left','bottom right'].includes(op.panel)&&!panels.has(op.panel),'annotation-binding');panels.add(op.panel);need(!run.blocks.some(b=>b.id===op.new_id),'annotation-id');
  for(const[id,panel]of Object.entries(ANNOTATIONS))if(panel===op.panel){const c=decoded.cases.get(id),pointer=c.second.candidates[binding.side].raw_pointer,aliases=decoded.records.get('review').pointer_aliases;need(c.second.candidates[binding.side].parent_ids.includes(p.id)&&pointer.endsWith(op.raw_pointer+'/text')&&aliases[pointer.split('#')[0]]===op.raw_path&&norm(raw.text).includes(c.ref.expected_semantic_unit),'annotation-case');}
  run.blocks.push({...p,id:op.new_id,text:op.text,locator:{...p.locator,source_block_id:op.new_id}});run.normalization_audit.mappings.push({document_id:p.locator.document_id,source_item_index:run.blocks.length-1,disposition:'retained'});
 }
 run.normalization_version+='+case-source-reviewed-4';run.config_fingerprint=hash({parent:hash(parent),proof:hash(proof)});run.approval_fingerprint=hash(proof.approval);run.parser_run_id=deriveParserRunIdentity(run);return run;
}
export function applyCaseReviewedComparison(input,units,baselineObservations,candidateObservations){
 const spec=input.comparisonPolicy.reviewed_comparison,proof=input.candidateDescriptor.reviewed_derivation,binding=spec.binding;need(spec.version==='reviewed-comparison-4'&&same(proof?.binding,binding),'comparison-policy');const decoded=decode(binding,proof.parent_run);need(same(deriveCaseReviewedRun(proof),input.candidateRun)&&same(binding.reference,input.referenceManifest)&&binding.baseline_fingerprint===hash(input.baselineRun),'comparison-records');need(same(spec.items.map(i=>i.evidence_id).sort(),[...decoded.cases.keys()].filter(id=>id!==EXTRA).sort()),'comparison-unit-set');
 const observations=[],known=[];
 for(const[id,c]of decoded.cases){if(id===EXTRA)continue;const selected=units.resolved.get(id);need(selected,'selected-unit');const row={evidence_id:id,version:spec.version,reference:{raw_text:c.ref.expected_semantic_unit},source_case_id:id};
  for(const[side,values]of[['baseline',baselineObservations],['candidate',candidateObservations]]){const value=selected[side],mapping=selected.mapping[side];let effective=null,scope=true,converted;
   if(side==='candidate'&&c.second.candidates[binding.side]){const parents=c.second.candidates[binding.side].parent_ids,annotation=proof.annotations.find(a=>ANNOTATIONS[id]===a.panel);need(value.blocks.every(b=>parents.includes(b.id)||annotation?.new_id===b.id),'selected-case-parent');}
   if(c.config.cross_page&&side==='candidate'){
    const loc=c.config.cross_page,p=proof.parent_run.blocks.find(b=>b.id===loc.parent_id),raw=rawField(decoded,loc.raw_path,loc.raw_pointer),part=mapping.parts[0];need(binding.side==='hybrid'&&mapping.parts.length===1&&value.blocks.length===1&&p?.id===value.blocks[0].id&&bytes(p.text)===loc.parent_text_sha256&&part.start===loc.start&&part.end===loc.end&&p.text.slice(loc.start,loc.end)===loc.text&&value.selected_text===loc.text,'cross-page-range');
    const rawPages=raw?.['region/object']?.physical_pages;need(raw.text===p.text&&Array.isArray(rawPages)&&rawPages.includes(loc.physical_page)&&loc.physical_page===c.ref.locator.page_number&&c.first.source_observation.physical_page===loc.physical_page&&c.second.source_observation.physical_page===loc.physical_page,'cross-page-source');effective={document_id:c.ref.document_id,page_number:loc.physical_page,source_block_id:p.id,selection:{start:loc.start,end:loc.end},basis:'two-source-reviewed-exact-continuation'};
   }
   if(c.config.profile.startsWith('table-')){
    if(value.blocks.length){const block=value.blocks[0],table=caseTableSelection(block,c.config.profile);scope=table.ok&&value.blocks.every(b=>b.id===block.id)&&same(mapping.parts.map(({start,end})=>({start,end})),table.parts);if(side==='candidate'){const contract=c.config.table,raw=rawField(decoded,contract.raw_path,contract.raw_pointer);need(raw?.text===block.text&&same(raw.headers,contract.headers)&&same(raw.selected_cells,contract.selected_cells),'table-original-fields');const fields=raw.selected_cells;need(fields.every((f,j)=>(f.row??f.data_row)===1&&f.column===j+1),'table-cell-order');const headers=c.config.profile==='table-parent-offspring'?[['Parent'],['Offspring']]:[['T1','parent'],['T1','offspring'],['T1','mutations'],['T2','parent'],['T2','offspring'],['T2','mutations']];need(fields.length===headers.length&&fields.every((f,j)=>same(f.header_path??f.headers??[f.header],headers[j])),'table-header-association');}
    }else scope=false;converted={ok:scope,unit:norm(value.selected_text)};
   }else converted=caseReviewedUnit(value.selected_text,c.config.profile);
   const reference=c.config.profile.startsWith('table-')?{ok:true,unit:norm(c.ref.expected_semantic_unit)}:caseReviewedUnit(c.ref.expected_semantic_unit,c.config.profile);need(reference.ok,'reference-profile');const match=scope&&value.outcome!=='missing'&&(value.outcome!=='wrong_page'||effective)&&converted.ok&&same(converted.unit,reference.unit),outcome=match?'segmented_match':['missing','wrong_page'].includes(value.outcome)?value.outcome:'wrong_semantic_unit';row[side]={raw_text:value.selected_text,raw_outcome:value.outcome,...converted,outcome,...(effective?{effective_source_locator:effective}:{})};values.set(id,{...value,outcome,...(effective?{raw_outcome:value.outcome,effective_source_locator:effective}:{})});
  }observations.push(row);
 }
 const extra=expectedPatches(binding,proof.parent_run,decoded).find(p=>p.case_id===EXTRA);if(extra&&input.candidateRun.blocks.find(b=>b.id===extra.block_id)?.text!==extra.text)known.push({case_id:EXTRA,disposition:'unresolved_candidate_content'});
 return{reviewed_observations:observations,known_content_defects:known,reviewed_source_limits:{revision:decoded.records.get('revision').global_unresolved,review:decoded.records.get('review').global_unresolved,cases:[...decoded.cases].map(([case_id,c])=>({case_id,unresolved:c.second.unresolved}))},reviewed_derivation:{disposition:'reviewed_derivative',new_backend_execution:false,parent_run_fingerprint:hash(proof.parent_run),source_review_fingerprint:binding.fingerprint,authority_limit:'Bound actual source records andfinite local contracts;not source/model authentication,independent gold orunchanged backend accuracy.'}};
}
