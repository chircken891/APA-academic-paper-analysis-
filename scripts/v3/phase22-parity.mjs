import { isDeepStrictEqual as same } from 'node:util';
import { fingerprintV3Json as hash } from './semantic-package-validator.mjs';
import { getReadingBasisContent, freezePhase22Value } from './phase22-input.mjs';
import { getReviewedSupportContent, getReviewedSupportTargets } from './phase221-reviewed-support.mjs';
import { assertFrozenRenderContext } from './phase22-render-context.mjs';
import { collectLanguageSpans, collectPhase22QuantityFindings, getAcceptedLanguageRecord, getAcceptedReaderLanguageRecord, createReaderParityRequest as createRuntimeReaderParityRequest, createPhase22VerifierRequest, verifyPhase22VerifierResult } from './phase22-language.mjs';

export const PARITY_DIMENSIONS=Object.freeze(['structure','quantities_conditions','epistemic_boundaries','coverage']);
const parityRecords=new WeakMap(), readerParityRecords=new WeakMap();
const fail=(code,path='/',details={})=>{throw Object.assign(new Error(code),{code,path,details});};
export function listParityTargets(basis) {
  const science=getReadingBasisContent(basis),targets=[];
  for(const [collection,key]of [['records','semantic_unit_id'],['claims','claim_id'],['quantities','quantity_id'],['statements','statement_id'],['explanations','explanation_id'],['research_candidates','candidate_id']]){
    for(const [index,row]of science.scientific_details[collection].entries())targets.push({semantic_id:row[key],basis_pointer:'/scientific_details/'+collection+'/'+index,
      summary:row.finding??row.allowed_conclusion??row.text??row.meaning_plain??row.hypothesis??('Reported quantity '+row.raw_value+' '+row.unit+'; denominator '+row.denominator)});
  }
  for(const [index,unit]of science.core.units.entries())if(unit.required_for_view)targets.push({semantic_id:unit.unit_id,basis_pointer:'/core/units/'+index,summary:unit.canonical_statement});
  for(const key of ['source_status','parser_evaluation_disposition','provenance_limits','important_disagreements'])targets.push({
    semantic_id:'basis:'+key,basis_pointer:'/basis/'+key,summary:JSON.stringify(basis[key]),
  });
  for(const [index,asset]of (basis.source_presentation?.assets??[]).entries())targets.push({semantic_id:'asset:'+asset.asset_id,basis_pointer:'/basis/source_presentation/assets/'+index,summary:JSON.stringify(asset)});
  return targets;
}
export function createParityRequest({basis,context,views,controller}={}) {
  try{return createPhase22VerifierRequest({controller,basis,context,views,reviewTargets:listParityTargets(basis)});}
  catch(error){return {ok:false,errors:[{code:error.code??'P22_PARITY_INPUT_INVALID',path:error.path??'/'}]};}
}
function exactRange(range,span) {
  return range&&Number.isInteger(range.start)&&Number.isInteger(range.end)&&range.start>=0&&range.end>range.start&&range.end<=span.text.length&&span.text.slice(range.start,range.end)===range.text;
}
function relevantSpans(view,id) {
  const declared=view.coverage.find(x=>x.semantic_id===id);
  if(declared)return declared.span_ids;
  return collectLanguageSpans(view).filter(x=>x.span.boundary_refs.includes(id)||x.span.support_refs?.includes(id)).map(x=>x.span.span_id);
}
function checkSemanticReviewDraft({basis,context,views,semanticReview,request,validator,dependencies,science,dimensions,add,reviewedSupport}) {
  const shape=validator.validate('phase22/parity-review-1.0',semanticReview);
  if(!shape.ok||semanticReview.kind!=='semantic_review')fail('P22_SEMANTIC_REVIEW_INVALID','/semanticReview',{errors:shape.errors});
  if(semanticReview.request_id!==request.request_id||!same(semanticReview.identity,basis.identity)||semanticReview.basis_fingerprint!==basis.basis_fingerprint
    ||semanticReview.context_fingerprint!==context.context_fingerprint||semanticReview.view_fingerprints.en!==dependencies.en_view||semanticReview.view_fingerprints['zh-CN']!==dependencies.zh_view)fail('P22_SEMANTIC_REVIEW_INVALIDATED');
  const targets=[...listParityTargets(basis),...(reviewedSupport?getReviewedSupportTargets(reviewedSupport):[])],byTarget=new Map(targets.map(x=>[x.semantic_id,x]));
  const allSpans=Object.fromEntries(['en','zh-CN'].map(language=>[language,new Map(collectLanguageSpans(views[language]).map(x=>[x.span.span_id,x.span]))]));
  const reviewed=new Set();
  for(const [index,item]of semanticReview.items.entries()){
    const path='/semanticReview/items/'+index,target=byTarget.get(item.semantic_id),key=item.semantic_id+'|'+item.dimension;
    if(!target||reviewed.has(key)||item.basis_pointer!==target.basis_pointer){add('structure','P22_REVIEW_TARGET_MISMATCH',path,{semantic_id:item.semantic_id});continue;}
    reviewed.add(key);
    for(const [language,field]of [['en','en_spans'],['zh-CN','zh_spans']]){
      const allowed=relevantSpans(views[language],item.semantic_id),ranges=item[field];
      if(!ranges.length||new Set(ranges.map(x=>x.span_id)).size!==ranges.length||ranges.some(r=>!allowed.includes(r.span_id)||!exactRange(r,allSpans[language].get(r.span_id)??{text:''}))){
        add('structure','P22_REVIEW_SPAN_MISMATCH',path+'/'+field,{semantic_id:item.semantic_id,language});
      }
      // Every explicitly declared semantic coverage span must be considered; core/scope can cite a relevant whole proposition.
      const required=views[language].coverage.find(x=>x.semantic_id===item.semantic_id)?.span_ids??(item.semantic_id.startsWith('support:')?allowed:[]);
      if(required.some(id=>!ranges.some(r=>r.span_id===id)))add('coverage','P22_REVIEW_SPAN_COVERAGE_MISSING',path+'/'+field,{semantic_id:item.semantic_id,language});
      dimensions[item.dimension].checked_spans.push(...ranges.map(x=>language+':'+x.span_id));
    }
    dimensions[item.dimension].checked_ids.push(item.semantic_id);
    if(item.verdict!=='aligned')add(item.dimension,'P22_SEMANTIC_'+item.verdict.toUpperCase(),path,{semantic_id:item.semantic_id,verdict:item.verdict,reason:item.rationale,owner:item.revision_owner,recheck_scope:item.recheck_scope});
  }
  for(const target of targets)for(const dimension of PARITY_DIMENSIONS)if(!reviewed.has(target.semantic_id+'|'+dimension))add('coverage','P22_SEMANTIC_REVIEW_COVERAGE_MISSING','/semanticReview/items',{semantic_id:target.semantic_id,missing_dimension:dimension,verdict:'omission'});

  const validPointers=new Set([...targets.map(x=>x.basis_pointer),...science.scientific_details.source_blocks.map((x,i)=>'/scientific_details/source_blocks/'+i),...science.core.evidence.map((x,i)=>'/core/evidence/'+i),...(reviewedSupport?getReviewedSupportContent(reviewedSupport).sources.map((x,i)=>'/reader_support/sources/'+i):[]),...(reviewedSupport?getReviewedSupportContent(reviewedSupport).expressions.map((x,i)=>'/reader_support/expressions/'+i):[])]);
  const reversed=new Set(),propositionIds=new Set();
  for(const [index,row]of semanticReview.reverse_grounding.entries()){
    const path='/semanticReview/reverse_grounding/'+index,span=allSpans[row.language]?.get(row.span_id),key=row.language+':'+row.span_id;
    if(!span||reversed.has(key)||!exactRange(row.checked_range,span)||row.checked_range.start!==0||row.checked_range.end!==span.text.length){
      add('coverage','P22_REVERSE_GROUNDING_RANGE_INVALID',path,{language:row.language,span_id:row.span_id});continue;
    }
    reversed.add(key);let end=0;
    for(const proposition of [...row.propositions].sort((a,b)=>a.range.start-b.range.start)){
      if(propositionIds.has(proposition.proposition_id)||!exactRange(proposition.range,span)||proposition.range.start>end&&span.text.slice(end,proposition.range.start).trim()
        ||proposition.range.start<end||proposition.semantic_refs.some(id=>!byTarget.has(id)||!span.semantic_refs.includes(id)&&!span.boundary_refs.includes(id)&&!span.support_refs?.includes(id)||!proposition.basis_pointers.includes(byTarget.get(id)?.basis_pointer))||proposition.basis_pointers.some(pointer=>!validPointers.has(pointer))){
        add('structure','P22_REVERSE_GROUNDING_INVALID',path,{language:row.language,span_id:row.span_id});
      }
      propositionIds.add(proposition.proposition_id);end=proposition.range.end;
      if(proposition.verdict==='grounded' && (!proposition.basis_pointers.length||!proposition.semantic_refs.length&&!span.immutable_ref)){
        add('coverage','P22_REVERSE_GROUNDING_UNSUPPORTED',path,{language:row.language,span_id:row.span_id});
      }
      if(proposition.verdict==='explanation_only'&&!span.explain_only&&!span.immutable_ref)add('epistemic_boundaries','P22_EXPLANATION_CLASSIFICATION_MISMATCH',path,{language:row.language,span_id:row.span_id});
      if(['unsupported_addition','unassessable'].includes(proposition.verdict))add('epistemic_boundaries',proposition.verdict==='unsupported_addition'?'P22_UNSUPPORTED_ADDITION':'P22_REVERSE_UNASSESSABLE',path,{
        language:row.language,span_id:row.span_id,verdict:proposition.verdict,reason:proposition.rationale,owner:proposition.revision_owner,recheck_scope:proposition.recheck_scope});
    }
    if(end<span.text.length&&span.text.slice(end).trim())add('coverage','P22_REVERSE_GROUNDING_COVERAGE_MISSING',path,{language:row.language,span_id:row.span_id});
  }
  for(const [language,spans]of Object.entries(allSpans))for(const id of spans.keys())if(!reversed.has(language+':'+id))add('coverage','P22_REVERSE_GROUNDING_COVERAGE_MISSING','/semanticReview/reverse_grounding',{language,span_id:id});

  for(const view of Object.values(views))for(const finding of collectPhase22QuantityFindings({basis,view}))add(finding.dimension,finding.code,finding.path,finding.details);
  return hash(semanticReview);
}
/** Deterministic constraints plus a traceable item-by-item semantic adjudication; no heuristic semantic pass. */
function assessParity({basis,context,views,semanticReview,receipts,currentDependencies}={},reader=false) {
  const dimensions=Object.fromEntries(PARITY_DIMENSIONS.map(name=>[name,{verdict:'aligned',checked_ids:[],checked_spans:[]}]));
  const findings=[];
  const add=(dimension,code,path,details={})=>{
    dimensions[dimension].verdict='blocked';
    findings.push({dimension,code,path,semantic_id:details.semantic_id??null,language:details.language??null,span_id:details.span_id??null,
      verdict:details.verdict??'contradiction',reason:details.reason??code,owner:details.owner??'Controller',recheck_scope:details.recheck_scope??[],details});
  };
  let dependencies={},reviewReceipt=null,evidence_mode='unknown',science,metadata={},reviewHash=null;
  try {
    science=getReadingBasisContent(basis);assertFrozenRenderContext(context,basis);
    if(!views||!same(Object.keys(views).sort(),['en','zh-CN']))fail('P22_BOTH_FROZEN_VIEWS_REQUIRED');
    for(const language of ['en','zh-CN']){
      metadata[language]=(reader?getAcceptedReaderLanguageRecord:getAcceptedLanguageRecord)(views[language],currentDependencies);
      if(views[language].language!==language||views[language].basis_fingerprint!==basis.basis_fingerprint||views[language].context_fingerprint!==context.context_fingerprint)fail('P22_VIEW_IDENTITY_MISMATCH');
    }
    if(!same(metadata.en.dependencies,metadata['zh-CN'].dependencies))fail('P22_VIEW_DEPENDENCY_MISMATCH');
    dependencies={...metadata.en.dependencies,en_view:metadata.en.view_fingerprint,zh_view:metadata['zh-CN'].view_fingerprint};
    if(Object.keys(dependencies).some(key=>currentDependencies?.[key]!==dependencies[key]))fail('P22_PARITY_DEPENDENCY_INVALIDATED','/currentDependencies');
    const verified=verifyPhase22VerifierResult({...receipts?.verifier,result:semanticReview,currentDependencies,reader});
    if(!verified.ok)fail(verified.errors[0]?.code??'P22_SEMANTIC_REVIEW_RECEIPT_REQUIRED','/receipts',{errors:verified.errors});
    reviewReceipt=verified.receipt_binding;evidence_mode=verified.evidence_mode;
    if(metadata.en.evidence_mode!==evidence_mode||metadata['zh-CN'].evidence_mode!==evidence_mode)fail('P22_EVIDENCE_MODE_MISMATCH');
    reviewHash=checkSemanticReviewDraft({basis,context,views,semanticReview,request:receipts.verifier.request,validator:verified.validator,dependencies,science,dimensions,add,reviewedSupport:metadata.en.reviewed_support});
  } catch(error){
    add('structure',error.code??'P22_PARITY_INVALID',error.path??'/',{reason:error.message,...error.details});
  }
  for(const dimension of Object.values(dimensions)){
    dimension.checked_ids=[...new Set(dimension.checked_ids)].sort();dimension.checked_spans=[...new Set(dimension.checked_spans)].sort();
  }
  const ok=Object.values(dimensions).every(x=>x.verdict==='aligned');
  const body={schema_version:'phase22/parity-review-1.0',kind:'parity_decision',ok,review_ready:ok&&evidence_mode==='actual',status:ok?(evidence_mode==='actual'?'review_ready':'synthetic_verified'):'rejected',
    identity:basis?.identity??null,basis_fingerprint:basis?.basis_fingerprint??null,context_fingerprint:context?.context_fingerprint??null,
    dimensions,findings,dependencies,semantic_review_fingerprint:reviewHash,semantic_review_receipt:reviewReceipt,evidence_mode,
    provenance_limits:{actual_observable_identity:'unknown',independence:'not_independent'}};
  const result=freezePhase22Value({...body,parity_fingerprint:hash(body)});
  if(ok)(reader?readerParityRecords:parityRecords).set(result,{basis,context,views,dependencies,semanticReview,receipts});
  return result;
}
export function assessBilingualParity(args) { return assessParity(args); }
export function assessReaderBilingualParity(args) { return assessParity(args,true); }
export function listReaderParityTargets(basis,views) {
  const en=getAcceptedReaderLanguageRecord(views?.en),zh=getAcceptedReaderLanguageRecord(views?.['zh-CN']);
  if(en.reviewed_support!==zh.reviewed_support)fail('P221_REVIEWED_SUPPORT_BINDING_INVALID');
  return [...listParityTargets(basis),...(en.reviewed_support?getReviewedSupportTargets(en.reviewed_support):[])];
}
export function createReaderParityRequest({basis,context,views,controller}={}) {
  try { return createRuntimeReaderParityRequest({basis,context,views,controller,reviewTargets:listReaderParityTargets(basis,views)}); }
  catch(error) { return {ok:false,errors:[{code:error.code??'P221_READER_PARITY_INPUT_INVALID',path:error.path??'/'}]}; }
}
/** Advisory draft mechanics only. Native completion/owned receipts and semantic acceptance remain mandatory. */
export function preflightPhase22SemanticReview({basis,context,views,semanticReview,request,validator,currentDependencies,reader=false}={}) {
  const findings=[],dimensions=Object.fromEntries(PARITY_DIMENSIONS.map(name=>[name,{verdict:'aligned',checked_ids:[],checked_spans:[]}]));
  const add=(dimension,code,path,details={})=>findings.push({dimension,code,path,semantic_id:details.semantic_id??null,language:details.language??null,span_id:details.span_id??null,
    verdict:details.verdict??'contradiction',reason:details.reason??code,owner:details.owner??'Controller',recheck_scope:details.recheck_scope??[],details});
  try {
    const science=getReadingBasisContent(basis);assertFrozenRenderContext(context,basis);
    if(!views||!same(Object.keys(views).sort(),['en','zh-CN']))fail('P22_BOTH_FROZEN_VIEWS_REQUIRED');
    const metadata={};
    for(const language of ['en','zh-CN']){
      metadata[language]=(reader?getAcceptedReaderLanguageRecord:getAcceptedLanguageRecord)(views[language],currentDependencies);
      if(views[language].language!==language||views[language].basis_fingerprint!==basis.basis_fingerprint||views[language].context_fingerprint!==context.context_fingerprint)fail('P22_VIEW_IDENTITY_MISMATCH');
    }
    if(!same(metadata.en.dependencies,metadata['zh-CN'].dependencies))fail('P22_VIEW_DEPENDENCY_MISMATCH');
    const dependencies={...metadata.en.dependencies,en_view:metadata.en.view_fingerprint,zh_view:metadata['zh-CN'].view_fingerprint};
    if(Object.keys(dependencies).some(key=>currentDependencies?.[key]!==dependencies[key]||request?.dependencies?.[key]!==dependencies[key]))fail('P22_PARITY_DEPENDENCY_INVALIDATED','/currentDependencies');
    if(request?.role!=='bilingual-verifier')fail('P22_VERIFIER_REQUEST_REQUIRED');
    checkSemanticReviewDraft({basis,context,views,semanticReview,request,validator,dependencies,science,dimensions,add,reviewedSupport:metadata.en.reviewed_support});
  }catch(error){add('structure',error.code??'P22_PARITY_INVALID',error.path??'/',{reason:error.message,...error.details});}
  const semanticCodes=new Set(['P22_SEMANTIC_CONTRADICTION','P22_SEMANTIC_OMISSION','P22_SEMANTIC_UNSUPPORTED_ADDITION','P22_SEMANTIC_UNASSESSABLE','P22_UNSUPPORTED_ADDITION','P22_REVERSE_UNASSESSABLE']);
  const mechanical_errors=findings.filter(x=>!semanticCodes.has(x.code)),semantic_findings=findings.filter(x=>semanticCodes.has(x.code));
  return {ok:mechanical_errors.length===0,preflight_only:true,review_ready:false,mechanical_errors,semantic_findings};
}
function assertParity(parity,{basis,context,views,currentDependencies}={},reader=false) {
  const record=(reader?readerParityRecords:parityRecords).get(parity);
  if(!record||record.basis!==basis||record.context!==context||record.views.en!==views?.en||record.views['zh-CN']!==views?.['zh-CN'])fail('P22_PARITY_NOT_CURRENT');
  if(currentDependencies&&Object.keys(record.dependencies).some(k=>currentDependencies[k]!==record.dependencies[k]))fail('P22_PARITY_DEPENDENCY_INVALIDATED');
  for(const language of ['en','zh-CN'])(reader?getAcceptedReaderLanguageRecord:getAcceptedLanguageRecord)(views[language],currentDependencies??record.dependencies);
  const checked=verifyPhase22VerifierResult({...record.receipts.verifier,result:record.semanticReview,currentDependencies:currentDependencies??record.dependencies,reader});
  if(!checked.ok||checked.receipt_binding.sha256!==parity.semantic_review_receipt.sha256)fail('P22_SEMANTIC_REVIEW_INVALIDATED');
  return parity;
}


export function assertBilingualParity(parity,args) { return assertParity(parity,args); }
export function assertReaderBilingualParity(parity,args) { return assertParity(parity,args,true); }
