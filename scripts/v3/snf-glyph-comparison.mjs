import {createHash} from 'node:crypto';
import {canonicalizeV3Json} from './semantic-package-validator.mjs';
import {deriveParserRunIdentity} from './parser-adapter.mjs';
import {deriveSnfReviewedRun,snfExpandedNotation,SNF_UNRESOLVED} from './snf-source-comparison.mjs';

const hash=x=>'sha256:'+createHash('sha256').update(canonicalizeV3Json(x)).digest('hex');
const bytes=x=>'sha256:'+createHash('sha256').update(x).digest('hex');
const same=(a,b)=>hash(a)===hash(b);
const need=(ok,why)=>{if(!ok)throw Error('SNF_GLYPH_INVALID:'+why);};
const ROOT='Eval/apa-v3/phase21/';
const PREP='.planning/phases/21-parser-evaluation-and-multi-agent-proof-chain/paper08-glyph-adoption-2165/INPUTS.json';
const PREP_HASH='sha256:d8a0e688f6a131c18e00a2aa6dbc79bbc720ed72ae0a91bc4bb39a0dd511bfab';
const DOC='src_3715f82e3980dbae906c95eaf302d0a5';
const PDF='sha256:4fa00006b3f854f1fe1ad4f8bf0ad3d9d16ea7a16b3e0648dd1ccecf7a2e475b';

// The reference literal is used only for the output provenance display.
const REFERENCE='S(i,j)=W(i,j)/Σ_(k∈N_i)W(i,k) if j∈N_i, otherwise 0; P_(t+1)^(1)=S^(1)P_t^(2)(S^(1))ᵀ; P_(t+1)^(2)=S^(2)P_t^(1)(S^(2))ᵀ; for m>2, P^(v)=S^(v)[Σ_(k≠v)P^(k)/(m−1)](S^(v))ᵀ, v=1,2,…,m.';
const notation=raw=>snfExpandedNotation(raw.replaceAll('⁽ᵏ⁾','^{(k)}').replaceAll('ₖ≠ᵥ','_{k≠v}')).replace(/\s+/g,'').replaceAll('...','…');
// Parse only the operators present in these four formulas. Grouping is removed
// by the parse tree, while variables, scripts, conditions and factor order remain.
function expression(raw){
 const s=raw.replace(/N_\{([a-z])\}/g,'N_$1');let i=0;
 const take=x=>{need(s.startsWith(x,i),'expression-token:'+x);i+=x.length;};
 const script=()=>{const open=s[i];if(open==='{'||open==='('){i++;const close=open==='{'?'}':')';let depth=1,start=i;while(i<s.length&&depth){if(s[i]===open)depth++;if(s[i]===close)depth--;i++;}need(!depth,'script-group');return s.slice(start,i-1).replace(/[{}()]/g,'');}const m=s.slice(i).match(/^[a-zA-Z0-9]/);need(m,'script-token');i++;return m[0];};
 const mul=(a,b)=>['mul',...(a[0]==='mul'?a.slice(1):[a]),...(b[0]==='mul'?b.slice(1):[b])];
 function atom(){const c=s[i];need(c,'expression-atom');if('([{'.includes(c)){i++;const a=expr(0);take(c==='('?')':c==='['?']':'}');return a;}
  if(c==='Σ'){i++;take('_');const condition=script();need(/^[a-z](?:∈N_[a-z]|≠[a-z])$/.test(condition),'sum-condition');return['sum',condition,atom()];}
  const number=s.slice(i).match(/^\d+/);if(number){i+=number[0].length;return['number',number[0]];}
  need(/[A-Za-z]/.test(c),'variable');i++;let sub=null,sup=null;
  while(s[i]==='_'||s[i]==='^'){const marker=s[i++],value=script();if(marker==='_'){need(sub===null,'duplicate-subscript');sub=value;}else{need(sup===null,'duplicate-superscript');sup=value;}}
  let a=['var',c,sub,sup];
  if(s[i]==='('&&sub===null&&sup===null&&['W','S','P'].includes(c)){i++;const args=[expr(0)];while(s[i]===','){i++;args.push(expr(0));}take(')');a=['call',a,args];}
  return a;
 }
 function expr(min){let a=atom();while(i<s.length){let op,prec,implicit=false;const c=s[i];if(c==='='){op='eq';prec=1;}else if(c==='+'||c==='-'){op=c==='+'?'add':'sub';prec=10;}else if(c==='*'||c==='/'){op=c==='*'?'mul':'div';prec=20;}else if(/[A-Za-zΣ([{]/.test(c)){op='mul';prec=20;implicit=true;}else if(c==='^'){need(40>=min,'transpose-precedence');i++;const p=script();a=['power',a,p];continue;}else break;if(prec<min)break;if(!implicit)i++;const b=expr(prec+1);a=op==='mul'?mul(a,b):[op,a,b];}return a;}
 const result=expr(0);need(i===s.length,'expression-tail:'+s.slice(i));return result;
}
function branch(raw){const equal=raw.indexOf('=');need(equal>0,'branch-equality');const lhs=expression(raw.slice(0,equal));let body=raw.slice(equal+1);if((body[0]==='{'&&body.at(-1)==='}')||(body[0]==='['&&body.at(-1)===']'))body=body.slice(1,-1);body=body.replaceAll('&','');let m=body.match(/^(.+?)(?:,|if)(j∈N_(?:\{[a-z]\}|[a-z]))(?:;|,otherwise)(.+)$/);need(m,'branch-condition');let zero=m[3];if(zero.endsWith(',otherwise'))zero=zero.slice(0,-10);return{lhs,member:m[2].replace(/[{}]/g,''),when_member:expression(m[1]),otherwise:expression(zero)};}
export function snfGlyphUnit(raw){try{
 need(typeof raw==='string'&&raw.length>0,'unit-text');need(!raw.includes('ν')&&!raw.includes('\\nu'),'greek-nu');const text=notation(raw);let components,applicability='m>2';
 if(text.includes('ifj∈')&&text.includes(';for')){components=text.split(';');need(components.length===4,'reference-components');const m=components[3].match(/^for([a-z]>\d+),(.+)$/);need(m,'applicability');applicability=m[1];components[3]=m[2];}
 else{const matches=[...text.matchAll(/(.+?)(?:@tag\((3|4|5|7)\)|\((3|4|5|7)\))(?=S|P|$)/g)];need(matches.length===4&&matches.map(x=>x[0]).join('')===text&&same(matches.map(x=>Number(x[2]??x[3])),[3,4,5,7]),'four-ordered-labels');components=matches.map(x=>x[1]);}
 const seventh=components[3].replace(/\.$/,'').match(/^(.+),([a-z])=(\d+),(\d+),…,(\w)$/);need(seventh,'index-range');
 return{ok:true,unit:{version:'snf-four-formula-2',components:[{label:3,branches:branch(components[0])},{label:4,equation:expression(components[1])},{label:5,equation:expression(components[2])},{label:7,equation:expression(seventh[1]),range:{index:seventh[2],first:seventh[3],second:seventh[4],last:seventh[5]}}],applicability}};
 }catch(e){return{ok:false,unit:null,reason:e.message};}}

function decode(proof){
 need(proof?.version==='reviewed-derivation-6'&&proof.approval?.scope==='bounded-snf-glyph-adoption'&&typeof proof.approval.id==='string'&&/^sha256:[a-f0-9]{64}$/.test(proof.implementation_fingerprint),'proof');
 const b=proof.binding;
 need(b?.version==='snf-glyph-binding-1'&&['native','hybrid'].includes(b.side),'binding');
 const{version,fingerprint,...payload}=b;need(hash(payload)===fingerprint,'binding-fingerprint');
 const records=new Map(),meta=new Map();
 need(Array.isArray(b.records)&&b.records.length===7,'record-set');
 for(const r of b.records){need(typeof r.bytes==='string'&&!records.has(r.id)&&bytes(r.bytes)===r.sha256&&b.authorized_records?.[r.path]===r.sha256,'record-bytes-authorization');records.set(r.id,JSON.parse(r.bytes));meta.set(r.id,r);}
 const prep=records.get('adoption-inputs'),auth=records.get('adoption-authorization');
 need(meta.get('adoption-inputs')?.path===PREP&&meta.get('adoption-inputs').sha256===PREP_HASH,'approved-inputs');
 need(prep.case_id===SNF_UNRESOLVED&&prep.source_document_id===DOC&&prep.physical_page===7&&prep.source_pdf_sha256===PDF,'source');
 need(meta.get('adoption-authorization')?.path===ROOT+'paper08-glyph-adoption-2165/AUTHORIZATION.json'&&Array.isArray(auth?.bindings)&&auth.approval&&meta.get('adoption-authorization').path===proof.approval.id&&auth.execution_id==='P21-PAPER08-GLYPH-ADOPTION-2165-r1','adoption-authorization');
 need(auth.bindings.some(r=>r.path===PREP&&r.sha256===PREP_HASH),'approval-inputs');
 const paths={'glyph-evidence':ROOT+'paper08-glyph-evidence-2164/attempt3-evidence.json','glyph-validation':ROOT+'paper08-glyph-evidence-2164/CONTINUATION-VALIDATION.json','glyph-authorization':ROOT+'paper08-glyph-evidence-2164/CONTINUATION-AUTHORIZATION.json','parent-input':prep.sides[b.side].input_path,'parent-result':prep.sides[b.side].saved_result_path};
 for(const[id,path]of Object.entries(paths)){const r=meta.get(id),approved=prep.bindings.find(x=>x.path===path);need(r?.path===path&&approved?.sha256===r.sha256&&approved.bytes===Buffer.byteLength(r.bytes)&&auth.bindings.some(x=>x.path===path&&x.sha256===r.sha256&&x.bytes===approved.bytes),'approved-record:'+id);}
 need(same(records.get('parent-input'),proof.parent_input)&&same(records.get('parent-result'),proof.parent_result),'parent-records');
 const parent=proof.parent_input;need(parent.comparisonPolicy?.reviewed_comparison?.version==='reviewed-comparison-5'&&parent.candidateDescriptor?.reviewed_derivation?.version==='reviewed-derivation-5','one-v5-parent');
 need(parent.candidateDescriptor.reviewed_derivation.binding.side===b.side&&same(deriveSnfReviewedRun(parent.candidateDescriptor.reviewed_derivation),parent.candidateRun),'parent-run');
 need(parent.referenceManifest.items.length===62&&same(parent.referenceManifest.items.find(r=>r.evidence_id===SNF_UNRESOLVED),prep.sides[b.side].reference),'whole-reference');
 const ev=records.get('glyph-evidence'),validation=records.get('glyph-validation'),ga=records.get('glyph-authorization');
 need(validation.status==='source_encoding_bindings_pass'&&validation.index_bindings_verified===5&&validation.unique_text_operations===4&&validation.source_page===7&&validation.disposition?.encoding==='confirmed_latin_v','glyph-validation');
 need(ga.source_sha256===PDF&&ga.approval&&ev.source_sha256===PDF&&ev.physical_page===7&&ev.index_bindings.length===5,'glyph-source');
 need(same(ev.index_bindings.map(x=>x.char_id),[3619,3620,3622,3624,3627]),'five-index-identities');
 const ops=[];
 for(const x of ev.index_bindings){need(x.cid===118&&x.decoded==='v'&&x.unique_operation===true&&x.bbox.length===4&&x.bbox.every(Number.isFinite)&&x.font.resource==='/T1_44'&&x.font.object_number===352&&x.font.basefont==='TCLUCG+MinionPro-It'&&x.font.subtype==='/Type1'&&x.font.encoding==='/WinAnsiEncoding'&&x.font.to_unicode===null,'font-code-position');need(x.operation.operator==='TJ'&&x.operation.font_resource==='/T1_44'&&same(x.operation.operands,[x.operation.seq])&&x.operation.seq.some(y=>y?.hex==='76')&&x.operation.position_operations.length>0,'raw-operation');ops.push(x.operation.operation_index);}
 need(same(ops,[1476,1476,1478,1482,1486])&&new Set(ops).size===4,'four-operations');
 for(const id of ['glyph-evidence','glyph-authorization'])need(validation.artifacts.some(x=>x.path===meta.get(id).path&&x.sha256===meta.get(id).sha256),'validation-artifact');
 return{prep,records,side:b.side};
}

export function deriveSnfGlyphReviewedRun(proof){
 const{prep,side}=decode(proof),parent=proof.parent_input.candidateRun,run=structuredClone(parent);
 need(Array.isArray(proof.patches),'patches');
 if(side==='native')need(proof.patches.length===0,'native-no-patch');
 else {need(proof.patches.length<=1,'single-patch');if(proof.patches.length){const p=proof.patches[0],allowed=prep.patch,block=run.blocks.find(x=>x.id===p.block_id);need(p.case_id===SNF_UNRESOLVED&&p.block_id===allowed.block_id&&p.original_sha256===allowed.old_sha256&&block?.text===allowed.old_text&&bytes(block.text)===p.original_sha256&&p.replacement_text===allowed.new_text&&bytes(p.replacement_text)===allowed.new_sha256&&block.text.split('\\nu').length-1===5,'exact-five-index-patch');block.text=p.replacement_text;}}
 run.normalization_version+='+snf-glyph-reviewed-6';run.config_fingerprint=hash({parent:hash(parent),proof:hash(proof)});run.approval_fingerprint=hash(proof.approval);run.parser_run_id=deriveParserRunIdentity(run);return run;
}

export function applySnfGlyphComparison(input,units,baselineObservations,candidateObservations,compareParent){
 const spec=input.comparisonPolicy.reviewed_comparison,proof=input.candidateDescriptor.reviewed_derivation;
 need(spec?.version==='reviewed-comparison-6'&&same(spec.binding,proof?.binding)&&same(spec.items,[{evidence_id:SNF_UNRESOLVED}]),'comparison-spec');
 const{side}=decode(proof),parent=proof.parent_input,saved=proof.parent_result;
 need(typeof compareParent==='function'&&same(compareParent(parent),saved),'parent-replay');
 need(same(deriveSnfGlyphReviewedRun(proof),input.candidateRun),'derived-run');
 const expected=structuredClone(parent);expected.candidateRun=input.candidateRun;expected.candidateDescriptor.reviewed_derivation=proof;expected.candidateDescriptor.run_authorization_ref=proof.approval.id;expected.comparisonPolicy.reviewed_comparison=spec;expected.comparisonPolicy.policy_version+='-2165-snf-glyph';
 const mapping=expected.comparisonPolicy.evidence_unit_maps.items.find(x=>x.evidence_id===SNF_UNRESOLVED);
 for(const p of mapping.candidate.parts){const block=input.candidateRun.blocks.find(x=>x.id===p.locator.source_block_id);p.parent_text_sha256=bytes(block.text);p.end=block.text.length;}
 need(same(expected,input),'immutable-non-target-input');
 const observations=structuredClone(saved.reviewed_observations);
 need(observations.length===32,'reviewed-row-count');
 for(const row of observations.filter(x=>x.evidence_id!==SNF_UNRESOLVED))for(const[s,map]of [['baseline',baselineObservations],['candidate',candidateObservations]]){const v=map.get(row.evidence_id);need(v&&v.selected_text===row[s].raw_text,'unchanged-reviewed-selection');map.set(row.evidence_id,{...v,outcome:row[s].outcome});}
 const row=observations.find(x=>x.evidence_id===SNF_UNRESOLVED),selected=units.resolved.get(SNF_UNRESOLVED),reference=snfGlyphUnit(parent.referenceManifest.items.find(x=>x.evidence_id===SNF_UNRESOLVED).expected_semantic_unit);
 need(reference.ok&&selected,'target-reference');
 row.version=spec.version;row.source_disposition='source_encoding_resolved';row.reference={raw_text:REFERENCE,...reference};
 for(const[s,map]of [['baseline',baselineObservations],['candidate',candidateObservations]]){const v=selected[s],converted=snfGlyphUnit(v.selected_text);const match=converted.ok&&same(converted.unit,reference.unit)&&!['missing','wrong_page'].includes(v.outcome);const outcome=match?'segmented_match':['missing','wrong_page'].includes(v.outcome)?v.outcome:'wrong_semantic_unit';row[s]={raw_text:v.selected_text,raw_outcome:v.outcome,...converted,outcome};map.set(SNF_UNRESOLVED,{...v,outcome});}
 const known=structuredClone(saved.known_content_defects);
 if(side==='hybrid'&&proof.patches.length===0)known.push({case_id:SNF_UNRESOLVED,block_id:'hybrid-0131',disposition:'unresolved_candidate_content'});
 return{reviewed_observations:observations,known_content_defects:known,reviewed_source_limits:{history:structuredClone(saved.reviewed_source_limits),current_target_resolution:{case_id:SNF_UNRESOLVED,disposition:'source_encoding_resolved',encoding:'Latin v',glyph_outlines:'not_inspected',author_intent:'not_inferred',source_evidence_fingerprint:proof.binding.fingerprint}},reviewed_derivation:{disposition:'reviewed_derivative',new_backend_execution:false,parent_run_fingerprint:hash(parent.candidateRun),source_review_fingerprint:proof.binding.fingerprint,authority_limit:'Approved record bytes and bounded source encoding evidence; not glyph outline or author intent authentication, independent gold, or unchanged backend accuracy.'}};
}
