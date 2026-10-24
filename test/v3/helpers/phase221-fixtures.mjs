import assert from 'node:assert/strict';

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createPhase22Fixture } from './phase22-fixtures.mjs';
import { createPhase22ContractValidator } from '../../../scripts/v3/phase22-contract-loader.mjs';
import { consumePhase21Handoff, getReadingBasisContent } from '../../../scripts/v3/phase22-input.mjs';
import { createOwnedArtifactBroker } from '../../../scripts/v3/owned-artifact-store.mjs';
import { freezeRenderContext, PHASE22_REGIONS } from '../../../scripts/v3/phase22-render-context.mjs';
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
async function contextFixture(t, options = {}) {
  const f = await createPhase22Fixture({ t, ...(options.fixtureProfile ? { profile: options.fixtureProfile } : {}), presentation:options.presentation, conflicts:options.conflicts??[], mutateScientificInput: sci => { sci.scientific_details.explanations[0].full_term = 'Independent evaluation'; options.mutateScientificInput?.(sci); } });
  const validator = await createPhase22ContractValidator(), admitted = await consumePhase21Handoff({ ...f, phase22Validator:validator });
  assert.equal(admitted.ok,true,JSON.stringify(admitted));
  const basis = admitted.basis, data = getReadingBasisContent(basis), explanation = data.scientific_details.explanations[0];
  const entities = [{ entity_id:'method_independent_evaluation',entity_type:'method',canonical_key:'method:independent-evaluation:synthetic:v1',
    display_ordinal:1,labels:{en:'Independent evaluation','zh-CN':'独立评估'},aliases:{en:['IE'],'zh-CN':['独立评估']},
    definition_unit_refs:[explanation.explanation_id],source_refs:[...explanation.source_block_ids],
    scope:data.core.units[0].conclusion_boundary.allowed,limitations:[explanation.interpretation_boundary] }];
  const terms = [{ term_id:'term_independent_evaluation',canonical_node_id:entities[0].entity_id,en_full_form:'Independent evaluation',zh_full_form:'独立评估',
    abbreviation:'IE',aliases:{en:['IEs'],'zh-CN':['独立评估']},sense:'evaluation on held-out data',domain:'synthetic methods',version:'1',
    definition_unit_refs:[explanation.explanation_id],source_refs:[...explanation.source_block_ids],
    translation:{status:'approved',reason:'Integrator reviewed this translation against the frozen explanation.',source_refs:[...explanation.source_block_ids]},
    disambiguation_note:'' }];
  if(options.mutate)await options.mutate({terms,entities,basis,data,f});
  const payload={schema_version:'phase22-integrator-context-input-1.0',basis_fingerprint:basis.basis_fingerprint,ledger_version:options.version??'terms-1',term_candidates:terms,entity_mappings:entities};
  const bytes=Buffer.from(JSON.stringify(payload)),role=options.role??'integration',actor=options.actor??'integrator';
  const runId=basis.identity.run_id,artifactId='phase22-context-input',path='context/input.json',revision='ctx-r1';
  const broker=createOwnedArtifactBroker({control_actor_id:'context-controller',artifact_root:f.artifactRoot,
    authorized_bindings:[{run_id:runId,actor_id:actor,role,artifact_path:path,revision}],
    run_controls:[{run_id:runId,phase22_context_binding:{basis_fingerprint:basis.basis_fingerprint,payload_sha256:digest(bytes),artifact_id:artifactId,owner_actor_id:'integrator',role:'integration',path,revision}}]});
  await broker.artifactStore.commitOwnedArtifact({artifactRoot:f.artifactRoot,dispatchContext:broker.dispatchContext,
    capability:broker.issueCapability({runId,actorId:actor,role,artifactPath:path,revision}),expectedRevision:revision,artifact:{artifact_id:artifactId,content:bytes}});
  const integratorReceipt={artifactRoot:f.artifactRoot,dispatchContext:broker.dispatchContext,runId,artifactId};
  const args={basis,termCandidates:terms,entityMappings:entities,integratorReceipt,validator,committedSnapshot:options.committedSnapshot};
  return {...f,...args,data,terms,entities,args,freeze:()=>freezeRenderContext(args)};
}

import { createLanguageRequests, acceptLanguageResult, recordPhase22RuntimeEvent, getPhase22LanguageContract, snapshotPhase22Runtime } from '../../../scripts/v3/phase22-language.mjs';
const chineseDuties = [
 '该合成方法示例的研究定位有明确边界。','合成方法仅有其所陈述的有限结果。','合成研究问题比较一个组件与基线。',
 '合成背景说明受所给来源限制。','所述基线构成该合成示例的局限。','合成组件应与其实现组合区分。','合成方法连接输入、组件与输出。',
 '合成组件具有所述用途和比较对象。','材料未提供必要公式；应明确这一点，不编造公式。','合成比较检验所述主张。',
 '合成结果明确限定了不能作出的更强解释。','合成来源没有提出范围更广的局限结论。','此合成对照不能证明普遍优越性。',
 '合成洞见仍只是候选。','合成关联不等于外部验证。','合成后续研究仍只是可检验的假说。'
];
async function languageFixture(t,options={}) {
 const f=await contextFixture(t,options.contextOptions),cr=f.freeze();assert.equal(cr.ok,true,JSON.stringify(cr));
 const context=cr.context,contracts=getPhase22LanguageContract(),runId=f.basis.identity.run_id;
 const tasks=Object.fromEntries([['en','english-writer'],['zh-CN','chinese-writer'],['verifier','bilingual-verifier']].map(([language,role])=>[language,{
   task_id:'task-'+language,task_name:'p22_'+language.replace('-','_').toLowerCase(),owner_actor_id:role,role,revision:'view-r1',
   artifact_id:'artifact-'+language,artifact_path:'owned/'+language+'.json',native_path:'native/'+language+'.json',
   revision_artifact_id:'revision-'+language,revision_artifact_path:'owned/'+language+'-revision.json',revision_native_path:'native/'+language+'-revision.json'
 }]));
 const binding={controller_actor_id:'language-controller',evidence_mode:'synthetic',authorization_id:'synthetic-only-authorization',
  basis_fingerprint:f.basis.basis_fingerprint,context_fingerprint:context.context_fingerprint,requested_model:'gpt-6.1-sol',requested_reasoning:'medium',
  deadline:'2099-01-01T00:00:00.000Z',max_calls:3,configuration_fingerprint:'sha256:'+'a'.repeat(64),
  template_fingerprint:contracts.template_fingerprint,tool_fingerprint:contracts.tool_fingerprint,task_bindings:tasks,
  ...(options.binding??{})};
 const allTasks=[...Object.values(binding.task_bindings),...(binding.revision_bindings??[]).map(x=>x.task)];
 const seedArtifacts=[];
 if(options.revisionSeeds)for(const language of ['en','zh-CN']){
  const bytes=Buffer.from(JSON.stringify({schema_version:'phase22/language-view-1.0',identity:f.basis.identity,language,basis_fingerprint:f.basis.basis_fingerprint,context_fingerprint:context.context_fingerprint,sections:[],coverage:[]}));
  const receipt={artifact_id:'seed-'+language,run_id:runId,owner_actor_id:binding.controller_actor_id,role:'control',path:'control/seed-'+language+'.json',revision:'seed-r1',sha256:digest(bytes),byte_length:bytes.length};
  binding.revision_seeds??={};binding.revision_seeds[language]={receipt,requested_changes:[{semantic_ids:[f.basis.required_semantic_units[0].semantic_unit_id],reason:'Retain supported prose and repair bounded format errors.'}]};
  seedArtifacts.push({receipt,bytes});
 }
 const ownedBindings=allTasks.flatMap(x=>(x.role==='bilingual-verifier'?[x.artifact_path]:[x.artifact_path,x.revision_artifact_path]).map(artifact_path=>({run_id:runId,actor_id:x.owner_actor_id,role:x.role,artifact_path,revision:x.revision})));
 ownedBindings.push(...seedArtifacts.map(({receipt:r})=>({run_id:runId,actor_id:r.owner_actor_id,role:r.role,artifact_path:r.path,revision:r.revision})));
 const broker=createOwnedArtifactBroker({control_actor_id:binding.controller_actor_id,artifact_root:f.artifactRoot,authorized_bindings:ownedBindings,
  run_controls:[{run_id:runId,phase22_language_binding:binding}]});
 for(const {receipt:r,bytes}of seedArtifacts)await broker.artifactStore.commitOwnedArtifact({artifactRoot:f.artifactRoot,dispatchContext:broker.dispatchContext,capability:broker.issueCapability({runId,actorId:r.owner_actor_id,role:r.role,artifactPath:r.path,revision:r.revision}),expectedRevision:r.revision,artifact:{artifact_id:r.artifact_id,content:bytes}});
 const runControl={artifactRoot:f.artifactRoot,inputArtifactRoot:f.artifactRoot,dispatchContext:broker.dispatchContext,runId,validator:f.validator,available_slots:options.slots??3,resources_available:true};
 const created=createLanguageRequests({basis:f.basis,context,runControl});assert.equal(created.ok,true,JSON.stringify(created));
 const emit=event=>recordPhase22RuntimeEvent({controller:created.controller,event});
 const start=request=>{
  const callId='call-'+request.task_id;
  assert.equal(emit({type:'response_item',synthetic_only:true,payload:{type:'function_call',name:'collaboration.spawn_agent',call_id:callId,arguments:JSON.stringify(request.native_call.arguments)}}).ok,true);
  assert.equal(emit({type:'response_item',synthetic_only:true,payload:{type:'function_call_output',call_id:callId,output:JSON.stringify({task_name:'/root/'+request.native_call.arguments.task_name})}}).ok,true);
  return callId;
 };
 const commit=async(request,result,{wrongRole=false,skipComplete=false}={})=>{
  const task=allTasks.find(x=>x.task_id===request.task_id),isRevision=result.schema_version==='phase22-revision-request-1.0';
  const artifactId=isRevision?task.revision_artifact_id:task.artifact_id,path=isRevision?task.revision_artifact_path:task.artifact_path,nativePath=isRevision?task.revision_native_path:task.native_path;
  const bytes=Buffer.from(JSON.stringify(result));await mkdir(join(f.artifactRoot,'native'),{recursive:true});await writeFile(join(f.artifactRoot,nativePath),bytes);
  const role=task.role,actorId=task.owner_actor_id;
  await broker.artifactStore.commitOwnedArtifact({artifactRoot:f.artifactRoot,dispatchContext:broker.dispatchContext,
   capability:broker.issueCapability({runId,actorId,role,artifactPath:path,revision:task.revision}),expectedRevision:task.revision,artifact:{artifact_id:artifactId,content:bytes}});
  if(!skipComplete)assert.equal(emit({type:'event_msg',synthetic_only:true,payload:{type:'phase22_host_completion',observed_from:'collaboration.final_answer',host_task_name:'/root/'+request.native_call.arguments.task_name,
   return_id:'return-'+request.task_id,raw_return:'Synthetic fixture final message; actual owned bytes decide acceptance.'}}).ok,true);
  return {artifactRoot:f.artifactRoot,dispatchContext:broker.dispatchContext,runId,artifactId,task_id:wrongRole?'another-task':request.task_id,
   call_id:'call-'+request.task_id,return_id:'return-'+request.task_id};
 };
 return {...f,context,tasks,binding,broker,runControl,created,emit,start,commit,requests:created.requests,dependencies:created.dependencies};
}
function makeView(f,request) {
 const language=request.language,science=f.data,details=science.scientific_details;
 const collections=[['records','semantic_unit_id'],['claims','claim_id'],['quantities','quantity_id'],['statements','statement_id'],['explanations','explanation_id'],['research_candidates','candidate_id']];
 const all=new Map(collections.flatMap(([collection,key])=>details[collection].map(row=>[row[key],{collection,row}])));
 const sections=PHASE22_REGIONS.map(section_id=>({section_id,paragraphs:[]}));
 const coverage=[];
 let index=0;
 for(const unit of f.basis.required_semantic_units){
  const {collection,row}=all.get(unit.semantic_unit_id);
  let text=row.finding??row.allowed_conclusion??row.text??row.meaning_plain??row.hypothesis??row.raw_value;
  if(language==='zh-CN'){
   if(collection==='records')text=chineseDuties[Number(row.obligation_id.slice(3))-1];
   if(collection==='claims')text='该合成组件在所述比较条件下与所报告的合成结果相关，不能由此推出普遍的因果优越性。';
   if(collection==='statements')text='作者报告的是一个有明确范围限制的关联。';
   if(collection==='explanations')text='独立评估使用未参与方法调优的数据检验表现；它限定了所报告比较的解释范围，并不证明已排除一切偏倚。';
   if(collection==='research_candidates')text='该候选仍是针对所给来源缺口的可证伪假说，须按原验证方法检验并保留失败条件。';
  }
  const quantity_bindings=[];
  if(collection==='quantities'){
   text=language==='en'?'The synthetic score was '+row.raw_value+' in 100 synthetic evaluations, comparing component and baseline in the synthetic evaluation; uncertainty was not reported.':'合成分数为'+row.raw_value+'，分母为100次合成评估，比较组件与基线，时间为合成评估期；未报告不确定性类型。';
   const fields=['quantity_id','raw_value','unit','denominator','groups','timepoint','analysis_set','uncertainty_type','uncertainty_value','metric_definition','raw_precision'];
   quantity_bindings.push({...Object.fromEntries(fields.map(k=>[k,row[k]])),token:{start:text.indexOf(row.raw_value),end:text.indexOf(row.raw_value)+row.raw_value.length}});
  }
  const span={span_id:'span-'+language+'-'+index,kind:'analysis',text,explain_only:false,semantic_refs:[unit.semantic_unit_id],
   claim_refs:unit.claim_ids,evidence_refs:[],quantity_refs:collection==='quantities'?[row.quantity_id]:[],term_refs:[],applicability_refs:[unit.obligation_id],boundary_refs:unit.boundary_unit_ids,
   quantity_bindings,core_quantity_bindings:[]};
  sections[index%sections.length].paragraphs.push({paragraph_id:'paragraph-'+language+'-'+index,spans:[span]});
  coverage.push({semantic_id:unit.semantic_unit_id,span_ids:[span.span_id],status:row.status==='not_applicable'||row.status==='not_assessable'?row.status:'represented',reason:row.reason??'The frozen source-grounded unit is represented.'});
  index++;
 }
 const unit=science.core.units[0],quantity=unit.quantity[0];
 const coreText=language==='en'?'In this invented experiment, seedlings in group A were 2 cm taller at day 7 than group B. This does not establish general effectiveness.':'在这个虚构实验中，第7天A组幼苗比B组高2 cm；这不能证明一般有效性。';
 const coreSpan={span_id:'span-'+language+'-core',kind:'analysis',text:coreText,explain_only:false,semantic_refs:[],claim_refs:[],evidence_refs:unit.evidence_ids,quantity_refs:[],term_refs:[],applicability_refs:[],boundary_refs:[unit.unit_id],quantity_bindings:[],
  core_quantity_bindings:[{unit_id:unit.unit_id,quantity_index:0,quantity:structuredClone(quantity),population:structuredClone(unit.population),comparison:structuredClone(unit.comparison),conditions:structuredClone(unit.conditions),uncertainty:structuredClone(unit.uncertainty),token:{start:coreText.indexOf('2'),end:coreText.indexOf('2')+1}}]};
 sections[3].paragraphs.push({paragraph_id:'paragraph-'+language+'-core',spans:[coreSpan]});
 const scopeText=language==='en'
  ? 'Source coverage is '+f.basis.source_status.coverage+'; scientific completeness is '+f.basis.scientific_completeness+'. Parser evaluation satisfied: '+f.basis.parser_evaluation_disposition.requirement_satisfied+'. Observable model identity is unknown; independence is '+f.basis.provenance_limits.host_independence+'. Important disagreements: '+f.basis.important_disagreements.map(x=>x.issue+' '+x.conclusion_boundary).join(';')+'.'
  : '来源覆盖为'+f.basis.source_status.coverage+'；科学完整性为'+f.basis.scientific_completeness+'。解析评估要求是否满足：'+f.basis.parser_evaluation_disposition.requirement_satisfied+'。可观察模型身份未知；独立性为'+f.basis.provenance_limits.host_independence+'。重要分歧：'+f.basis.important_disagreements.map(x=>x.issue+' '+x.conclusion_boundary).join('；')+'。';
 sections[11].paragraphs.push({paragraph_id:'paragraph-'+language+'-scope',spans:[{span_id:'span-'+language+'-scope',kind:'analysis',text:scopeText,explain_only:false,semantic_refs:[],claim_refs:[],evidence_refs:[],quantity_refs:[],term_refs:[],applicability_refs:[],
 boundary_refs:['basis:source_status','basis:parser_evaluation_disposition','basis:provenance_limits','basis:important_disagreements'],quantity_bindings:[],core_quantity_bindings:[]}]});
 if(language==='zh-CN')for(const section of sections)section.paragraphs.reverse();
 return {schema_version:'phase22/language-view-1.0',identity:f.basis.identity,language,basis_fingerprint:f.basis.basis_fingerprint,context_fingerprint:f.context.context_fingerprint,
  request_id:request.request_id,revision:request.revision,sections,coverage};
}
async function acceptFixtureView(f,request,view=makeView(f,request)) {
 f.start(request);const receipt=await f.commit(request,view);
 return acceptLanguageResult({request,result:view,receipt,currentDependencies:f.dependencies});
}

import { createParityRequest, assessBilingualParity, listParityTargets, PARITY_DIMENSIONS } from '../../../scripts/v3/phase22-parity.mjs';
import { collectLanguageSpans } from '../../../scripts/v3/phase22-language.mjs';
async function parityFixture(t,{mutateView,fixtureOptions={}}={}) {
 const f=await languageFixture(t,fixtureOptions),views={},accepted={};
 for(const request of f.requests) {
  const view=makeView(f,request);if(mutateView)await mutateView(view,request.language,f);
  const r=await acceptFixtureView(f,request,view);assert.equal(r.ok,true,JSON.stringify(r));
  views[request.language]=r.view;accepted[request.language]=r;
 }
 const made=createParityRequest({basis:f.basis,context:f.context,views,controller:f.created.controller});assert.equal(made.ok,true,JSON.stringify(made));
 return {...f,views,accepted,verifierRequest:made.request,parityDependencies:made.dependencies};
}
const range=span=>({span_id:span.span_id,start:0,end:span.text.length,text:span.text});
function makeSemanticReview(f) {
 const targets=listParityTargets(f.basis),all=Object.fromEntries(['en','zh-CN'].map(language=>[language,collectLanguageSpans(f.views[language]).map(x=>x.span)]));
 const spansFor=(id,language)=> {
  const view=f.views[language],coverage=view.coverage.find(x=>x.semantic_id===id);
  if(coverage)return coverage.span_ids.map(spanId=>range(all[language].find(x=>x.span_id===spanId)));
  const matches=all[language].filter(x=>x.boundary_refs.includes(id));
  return matches.filter(x=>id.startsWith('unit_')?x.core_quantity_bindings.length:true).map(range);
 };
 const items=targets.flatMap(target=>PARITY_DIMENSIONS.map(dimension=>({semantic_id:target.semantic_id,basis_pointer:target.basis_pointer,basis_summary:target.summary,
  en_spans:spansFor(target.semantic_id,'en'),zh_spans:spansFor(target.semantic_id,'zh-CN'),dimension,verdict:'aligned',
  rationale:'Synthetic fixed-case adjudication: both exact spans preserve the frozen proposition, attribution and stated limits.',
  revision_owner:'none',recheck_scope:[target.semantic_id]})));
 const byId=new Map(targets.map(x=>[x.semantic_id,x.basis_pointer]));
 const reverse_grounding=Object.entries(all).flatMap(([language,spans])=>spans.map(span=>({language,span_id:span.span_id,checked_range:{start:0,end:span.text.length,text:span.text},
  propositions:[{proposition_id:'proposition-'+span.span_id,range:{start:0,end:span.text.length,text:span.text},
    semantic_refs:[...span.semantic_refs,...span.boundary_refs],basis_pointers:[...span.semantic_refs,...span.boundary_refs].map(id=>byId.get(id)).filter(Boolean),
    verdict:span.explain_only?'explanation_only':'grounded',rationale:'Synthetic fixed-case reverse review accounts for every character of this candidate span.',
    revision_owner:'none',recheck_scope:[span.span_id]}]})));
 return {schema_version:'phase22/parity-review-1.0',kind:'semantic_review',request_id:f.verifierRequest.request_id,identity:f.basis.identity,
  basis_fingerprint:f.basis.basis_fingerprint,context_fingerprint:f.context.context_fingerprint,
  view_fingerprints:{en:f.accepted.en.view_fingerprint,'zh-CN':f.accepted['zh-CN'].view_fingerprint},source_exposure:'same_frozen_basis_and_views',
  items,reverse_grounding,limitations:['Synthetic local protocol evidence only; not independent scientific acceptance.']};
}
async function adjudicate(f,review=makeSemanticReview(f),options={}) {
 f.start(f.verifierRequest);const receipt=await f.commit(f.verifierRequest,review);
 if(options.mutateReceipt)options.mutateReceipt(receipt);
 return assessBilingualParity({basis:f.basis,context:f.context,views:f.views,semanticReview:review,receipts:{verifier:{request:f.verifierRequest,receipt}},
  currentDependencies:options.currentDependencies??f.parityDependencies});
}

// These local scaffolds adapt the upstream protocol example into independent brokers.
// They are synthetic evidence, never imported test modules or scientific approval.
import { buildBilingualReview, assertBilingualReviewCurrent } from '../../../scripts/v3/phase22-review.mjs';
import { renderBilingualNotes } from '../../../scripts/v3/phase22-render.mjs';
import { inspectManagedNote } from '../../../scripts/v3/phase22-managed-markdown.mjs';
import { fingerprintV3Json as hash } from '../../../scripts/v3/semantic-package-validator.mjs';

import { readPhase22SourceAsset, resolvePhase22ImmutableRange } from '../../../scripts/v3/phase22-input.mjs';
const presentationFormula = 'IE = 2';
const presentationCode = 'const IE = `IE`;\nconsole.log(IE);\nconst image = "![plot](chart.png)";';
function qualifiedPresentation(sci) {
 const b=sci.scientific_details.source_blocks[0],evidence_ids=[sci.core.evidence[0].evidence_id];
 return {assets:[{asset_id:'figure-qualified',artifact_id:'source-qualified-image',media_type:'image/png',source_document_id:b.source_document_id,source_hash:b.source_hash,
  source_block_ids:[b.source_block_id],evidence_ids,origin:'registered_source_asset',qualification_reason:'Owned synthetic source figure; not language execution evidence.',
  bytes:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=','base64')}],
  immutable_ranges:[['formula',presentationFormula],['code',presentationCode]].map(([kind,text])=>({classification_id:'render-qualified-'+kind,kind,source_block_id:b.source_block_id,
   start:b.text.indexOf(text),end:b.text.indexOf(text)+text.length,text_sha256:digest(Buffer.from(text)),evidence_ids,qualification_reason:'Integrator exact source-range classification, original science role unchanged.'}))};
}
function addQualifiedSpans(view,language,f) {
 const assets=f.basis.source_presentation.assets.map((a,index)=>({span_id:'qualified-asset-'+language+(index ? '-'+index : ''),kind:'asset',text:a.target_path,explain_only:false,semantic_refs:[],claim_refs:[],evidence_refs:a.evidence_ids,
  quantity_refs:[],term_refs:[],applicability_refs:[],boundary_refs:['asset:'+a.asset_id],quantity_bindings:[],core_quantity_bindings:[],asset_refs:[a.asset_id],
  immutable_ref:{authority:'source_asset',id:a.asset_id,start:0,end:a.target_path.length}}));
 const immutable=f.basis.source_presentation.immutable_ranges.map(entry=>({span_id:'qualified-'+entry.kind+'-'+language,kind:entry.kind,
  text:resolvePhase22ImmutableRange(f.basis,entry.classification_id).text,explain_only:true,semantic_refs:[],claim_refs:[],evidence_refs:entry.evidence_ids,
  quantity_refs:[],term_refs:[],applicability_refs:[],boundary_refs:[],quantity_bindings:[],core_quantity_bindings:[],
  immutable_ref:{authority:'source_block',id:entry.source_block_id,start:entry.start,end:entry.end,classification_id:entry.classification_id}}));
 // Deliberately reverse within-block source order before actual acceptance/parity.
 for(const span of [...immutable.reverse(),...assets])view.sections[5].paragraphs.push({paragraph_id:span.span_id,spans:[span]});
}
function qualifiedOptions() {
 return {fixtureOptions:{contextOptions:{presentation:qualifiedPresentation,mutateScientificInput:sci=>{sci.scientific_details.source_blocks[0].text+='\n'+presentationFormula+'\n'+presentationCode;}}},mutateView:addQualifiedSpans};
}

import { buildBilingualIndex } from '../../../scripts/v3/phase22-search.mjs';
import { assertActiveGeneration, assertIndexGeneration } from '../../../scripts/v3/phase22-active-version.mjs';
import { mergeManagedNote } from '../../../scripts/v3/phase22-managed-markdown.mjs';

// G22-06-ACTIVE: real 01–05 producers; no synthetic index/active replacement.
// Synthetic content is only input to the actual controlled broker/role APIs.
async function integratedCandidates(t, options = {}) {
  const qualified = qualifiedOptions();
  if (options.fixtureProfile) qualified.fixtureOptions.contextOptions.fixtureProfile = options.fixtureProfile;
  if (options.presentation) qualified.fixtureOptions.contextOptions.presentation = options.presentation;
  const originalViewMutation = qualified.mutateView;
  qualified.mutateView = async (view, language, fixture) => {
    originalViewMutation(view, language, fixture);
    await options.mutateView?.(view, language, fixture);
  };
  if(options.revisionSeeds)qualified.fixtureOptions.revisionSeeds=true;
  const originalMutation = qualified.fixtureOptions.contextOptions.mutateScientificInput;
  qualified.fixtureOptions.contextOptions.mutateScientificInput = sci => {
    originalMutation(sci);
    options.mutateScientificInput?.(sci);
  };
  if (options.existingSupport) {
    const committedSnapshot = await readCommittedGeneration({ vaultRoot: options.existingSupport.vaultRoot });
    assert.equal(committedSnapshot.ok, true, JSON.stringify(committedSnapshot));
    qualified.fixtureOptions.contextOptions.committedSnapshot = committedSnapshot;
    qualified.fixtureOptions.contextOptions.mutate = async ({ entities, data }) => {
      const prior = options.existingSupport;
      entities[0].existing_support = { vault_root: prior.vaultRoot, target_path: prior.path,
        byte_sha256: digest(await readFile(join(prior.vaultRoot, prior.path))), existing_entity_id: entities[0].entity_id,
        definition_text: data.scientific_details.explanations[0].meaning_plain,
        compatibility_reason: 'Actual prior producer bytes and frozen definition are compatible; readonly reuse.' };
    };
  }
  const f = await parityFixture(t, qualified);
  const parity = await adjudicate(f);
  assert.equal(parity.ok, true, JSON.stringify(parity));
  const rendered = renderBilingualNotes({ ...f, parity });
  const existingBytes = async path => {
    if (!options.vaultRoot) return null;
    try { return await readFile(join(options.vaultRoot, path)); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const notes = {};
  for (const language of ['en', 'zh-CN']) {
    const existing = await existingBytes(f.context.paper_targets[language]);
    notes[language] = mergeManagedNote({ existingBytes: existing,
      rendered: language === 'en' ? rendered.en : rendered.zhCN,
      expectedManagedHash: existing === null ? undefined : inspectManagedNote(existing).managedHash }).bytes;
  }
  const generationId = options.generationId ?? 'integration-generation-1';
  const documents = ['en', 'zh-CN'].map(language => ({
    paper_id: f.basis.identity.paper_id, language, target_path: f.context.paper_targets[language],
    view_fingerprint: f.accepted[language].view_fingerprint,
    managed_hash: inspectManagedNote(notes[language]).managedHash,
  }));
  const support = rendered.supportNotes;
  assert.equal(support.length, 1);
  assert.equal(support[0].disposition, options.existingSupport ? 'reuse' : 'create');
  assert.equal(rendered.assets.length, options.assetCount ?? 1, 'must include the actual admitted source assets');
  const files = [];
  for (const item of [...support, ...rendered.assets]) {
    files.push({ path: item.target_path, bytes: item.bytes ?? await readFile(join(options.existingSupport.vaultRoot, item.target_path)) });
  }
  const paper = { ...f.basis.identity, pipeline_version: '3.0', core_hash: hash(f.data.core),
    basis_fingerprint: f.basis.basis_fingerprint, context_fingerprint: f.context.context_fingerprint,
    view_fingerprints: Object.fromEntries(documents.map(doc => [doc.language, doc.view_fingerprint])), paths: f.context.paper_targets };
  const objects = [
    ...documents.map(doc => ({ path: doc.target_path, kind: 'v3-note', sha256: doc.managed_hash })),
    ...support.map(item => ({ path: item.target_path, kind: 'support', sha256: item.byte_sha256 })),
    ...rendered.assets.map(item => ({ path: item.target_path, kind: 'asset', sha256: digest(item.bytes) })),
  ];
  const others = options.otherPapers ?? [];
  const objectMap = new Map(others.flatMap(other => other.built.generation.objects).map(row => [row.path, row]));
  for (const row of objects) objectMap.set(row.path, row);
  const fileMap = new Map(others.flatMap(other => other.files).map(row => [row.path, row]));
  for (const row of files) fileMap.set(row.path, row);
  const shared = new Map(others.flatMap(other => other.built.generation.shared_nodes).map(row => [row.path, row]));
  for (const item of support) shared.set(item.target_path, { entity_id: item.entity_id, path: item.target_path });
  const generation = {
    schema_version: 'phase22/active-index-1.0', kind: 'active', generation_id: generationId, evidence_mode: 'synthetic',
    papers: [...others.flatMap(other => other.built.generation.papers), paper],
    objects: [...objectMap.values()], shared_nodes: [...shared.values()],
  };
  const input = { ...f, parity, notes };
  const built = buildBilingualIndex({ validatedInputs: { papers: [...others.map(other => other.input), input], v2: [], files: [...fileMap.values()] }, generation });
  assertActiveGeneration(built.generation);
  assertIndexGeneration(built.index, built.generation);
  assert.ok(built.generation.index_manifest.length > 24);
  assert.equal(built.index.active_fingerprint, hash(built.generation));
  const activeBytes = Buffer.from(JSON.stringify(built.generation) + '\n');
  const activeSnapshot = {
    generation: generationId, previous_generation: options.previousGeneration ?? null,
    candidateIndex: { bytes: built.bytes, byte_sha256: built.sha256 },
    candidateActive: { bytes: activeBytes, byte_sha256: digest(activeBytes) },
  };
  const base = '.apa-v3/phase22/generations/' + generationId;
  const existingTargets = [];
  for (const path of [...Object.values(f.context.paper_targets), ...files.map(file => file.path),
    base + '/manifest.json', base + '/active.json', base + '/index.json']) {
    const bytes = await existingBytes(path);
    existingTargets.push({ path, bytes, ...(bytes !== null && Object.values(f.context.paper_targets).includes(path)
      ? { managedHash: inspectManagedNote(bytes).managedHash } : {}) });
  }
  return { ...f, parity, rendered, built, documents, activeBytes, files, input,
    args: { basis: f.basis, context: f.context, views: f.views, parity, rendered, existingTargets, activeSnapshot } };
}


async function publicationFixture(t, options = {}) {
  const f = await integratedCandidates(t, options);
  const review = buildBilingualReview(f.args);
  const vaultRoot = options.vaultRoot ?? join(f.artifactRoot, 'publication-vault');
  await mkdir(vaultRoot, { recursive: true });
  return { ...f, review, vaultRoot, run: f.basis.identity.run_id };
}
import { dryRunBilingualPublication, registerBilingualPublication } from '../../../scripts/v3/phase22-publication.mjs';
import { readCommittedGeneration } from '../../../scripts/v3/phase22-active-version.mjs';

/** Actual producer chain, synthetic content only; no model dispatch or publication. */
export async function createRegisteredHistoricalFixture(t, options = {}) {
  const f = await publicationFixture(t, options);
  const dry = await dryRunBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, review: f.review });
  assert.equal(dry.ok, true, JSON.stringify(dry));
  const registered = await registerBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, plan: dry.plan,
    sourceInputs: { basis: f.basis, context: f.context, views: f.views, parity: f.parity,
      currentControl: f.currentControl, integratorReceipt: f.integratorReceipt,
      languageRunControl: f.runControl, languageController: f.created.controller } });
  return { ...f, registered, args: { registration: { vaultRoot: f.vaultRoot, run: f.run,
    bundle_sha256: registered.bundle_sha256 }, trustAnchor: registered.trust_anchor, sourceRoots: [f.artifactRoot] } };
}
