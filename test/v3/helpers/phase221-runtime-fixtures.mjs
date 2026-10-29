import assert from 'node:assert/strict';

import { createHash } from 'node:crypto';
import { fingerprintV3Json } from '../../../scripts/v3/semantic-package-validator.mjs';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createPhase22Fixture } from './phase22-fixtures.mjs';
import { createPhase22ContractValidator } from '../../../scripts/v3/phase22-contract-loader.mjs';
import { consumePhase21Handoff, getReadingBasisContent } from '../../../scripts/v3/phase22-input.mjs';
import { createOwnedArtifactBroker } from '../../../scripts/v3/owned-artifact-store.mjs';
import { getReviewedSupportContent } from '../../../scripts/v3/phase221-reviewed-support.mjs';
import { freezeRenderContext, PHASE22_REGIONS } from '../../../scripts/v3/phase22-render-context.mjs';
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
async function contextFixture(t, options = {}) {
  const f = await createPhase22Fixture({ t, presentation:options.presentation, conflicts:options.conflicts??[], mutateScientificInput: sci => { sci.scientific_details.explanations[0].full_term = 'Independent evaluation'; options.mutateScientificInput?.(sci); } });
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
import { getPhase221ReaderContract, createReaderLanguageRequests, acceptReaderLanguageResult, getAcceptedReaderLanguageRecord, getAcceptedLanguageRecord, createReaderReviewRequest, verifyReaderReviewArtifact } from '../../../scripts/v3/phase22-language.mjs';
import { assessReaderBilingualParity, createReaderParityRequest, assertReaderBilingualParity, assertBilingualParity } from '../../../scripts/v3/phase22-parity.mjs';
const chineseDuties = [
 '该合成方法示例的研究定位有明确边界。','合成方法仅有其所陈述的有限结果。','合成研究问题比较一个组件与基线。',
 '合成背景说明受所给来源限制。','所述基线构成该合成示例的局限。','合成组件应与其实现组合区分。','合成方法连接输入、组件与输出。',
 '合成组件具有所述用途和比较对象。','材料未提供必要公式；应明确这一点，不编造公式。','合成比较检验所述主张。',
 '合成结果明确限定了不能作出的更强解释。','合成来源没有提出范围更广的局限结论。','此合成对照不能证明普遍优越性。',
 '合成洞见仍只是候选。','合成关联不等于外部验证。','合成后续研究仍只是可检验的假说。'
];
function consumptionFixture(f, context, binding, runId, options = {}) {
 const block=f.data.scientific_details.source_blocks[0],paperId=f.basis.identity.paper_id;
 const dispositions={rows:[{row_id:'synthetic-disposition',paper_id:paperId,term:'Independent evaluation',action:'source_bound_exposition',
  adopted_source_refs:['synthetic-source-span'],retained_unknowns:['External validity remains unknown.'],required_gaps:[],supported_presentation_scope:'Explain only the registered synthetic source.'},
  {row_id:'other-paper-disposition',paper_id:'another-paper',term:'Excluded foreign row',action:'preserve_name_or_wording',adopted_source_refs:[],retained_unknowns:[],required_gaps:[],supported_presentation_scope:'Another paper only.'}]};
 const spans={spans:[{span_id:'synthetic-source-span',paper_id:paperId,source_block_id:block.source_block_id,
  source_document_id:block.source_document_id,source_hash:block.source_hash,page_index:block.page_index,source_excerpt:block.text},
  {span_id:'other-paper-span',paper_id:'another-paper',source_excerpt:'Foreign source must never be delivered.'}]};
 const contract={schema_version:'phase22-consumption-contract-1.0',identity:structuredClone(f.basis.identity),
  basis_fingerprint:f.basis.basis_fingerprint,context_fingerprint:context.context_fingerprint};
 options.mutate?.({contract,dispositions,spans});
 const artifacts=[],receipts={};
 const register=(name,content)=>{
  const bytes=Buffer.from(JSON.stringify(content));
  const receipt={artifact_id:'consumption-'+name,path:'control/consumption-'+name+'.json',revision:'consumption-r1',role:'control',
   owner_actor_id:binding.controller_actor_id,sha256:digest(bytes),byte_length:bytes.length,run_id:runId};
  receipts[name]=receipt;artifacts.push({receipt,bytes});return {...receipt,origin_path:'synthetic-origin/'+name+'.json'};
 };
 contract.disposition_source=register('dispositions',dispositions);contract.span_source=register('spans',spans);
 const {origin_path,...receipt}=register('contract',contract);
 binding.consumption_contract_required=true;binding.consumption_contract=receipt;
 return {contract,dispositions,spans,receipts,artifacts};
}
function readOnlyData(request) {
 return JSON.parse(request.native_call.arguments.message.split('\nREAD_ONLY_DATA\n')[1].split('\nEND_READ_ONLY_DATA')[0]);
}
async function languageFixture(t,options={}) {
 const f=options.existingContextFixture??await contextFixture(t,options.contextOptions),cr=f.freeze();assert.equal(cr.ok,true,JSON.stringify(cr));
 const reviewed=options.prepareReviewedSupport?await options.prepareReviewedSupport(f):null;
 const reviewedSupport=reviewed?.capability??options.reviewedSupport;
 const context=cr.context,contracts=options.reader?getPhase221ReaderContract():getPhase22LanguageContract(),runId=f.basis.identity.run_id;
 const tasks=Object.fromEntries([['en','english-writer'],['zh-CN','chinese-writer'],['verifier','bilingual-verifier']].map(([language,role])=>[language,{
   task_id:'task-'+language,task_name:'p22_'+language.replace('-','_').toLowerCase(),owner_actor_id:role,role,revision:'view-r1',
   artifact_id:'artifact-'+language,artifact_path:'owned/'+language+'.json',native_path:'native/'+language+'.json',
   revision_artifact_id:'revision-'+language,revision_artifact_path:'owned/'+language+'-revision.json',revision_native_path:'native/'+language+'-revision.json'
 }]));
 if(options.namespace)for(const task of Object.values(tasks)){
  for(const key of ['task_id','task_name','artifact_id','revision_artifact_id'])task[key]=options.namespace+task[key];
  for(const key of ['artifact_path','native_path','revision_artifact_path','revision_native_path'])task[key]=task[key].replace('/', '/'+options.namespace);
 }
 const readerInput={...(options.readerInput??{abstract_source:{source_status:'missing',reason:'Synthetic source has no registered abstract.'},obligations:Array.from({length:16},(_,i)=>'SR-'+String(i+1).padStart(2,'0'))}),...(reviewed?{reviewed_support:reviewed.descriptor}:{})};
 const binding={...(options.reader?{mode:'reader',reader_input_fingerprint:fingerprintV3Json(readerInput)}:{}),controller_actor_id:'language-controller',evidence_mode:'synthetic',authorization_id:'synthetic-only-authorization',
  basis_fingerprint:f.basis.basis_fingerprint,context_fingerprint:context.context_fingerprint,requested_model:'gpt-6.1-sol',requested_reasoning:'medium',
  deadline:'2099-01-01T00:00:00.000Z',max_calls:3,configuration_fingerprint:'sha256:'+'a'.repeat(64),
  template_fingerprint:contracts.template_fingerprint,tool_fingerprint:contracts.tool_fingerprint,task_bindings:tasks,
  ...(reviewedSupport?{reviewed_support_fingerprint:getReviewedSupportContent(reviewedSupport).support_fingerprint}:{}),
  ...(options.binding??{})};
 const consumption=options.consumptionContract?consumptionFixture(f,context,binding,runId,options.consumptionContract===true?{}:options.consumptionContract):null;
 const allTasks=[...Object.values(binding.task_bindings),...(binding.revision_bindings??[]).map(x=>x.task)];
 const seeds=[];
 if(options.revisionSeeds)for(const language of ['en','zh-CN']){
  const view={schema_version:'phase22/language-view-1.0',identity:f.basis.identity,language,basis_fingerprint:f.basis.basis_fingerprint,context_fingerprint:context.context_fingerprint,request_id:'old-unaccepted-request',revision:'old-r1',sections:[],coverage:[]};
  options.mutateSeed?.(view,language);
  const bytes=Buffer.from(JSON.stringify(view)),receipt={artifact_id:'seed-'+language,run_id:runId,owner_actor_id:binding.controller_actor_id,role:'control',path:'control/seed-'+language+'.json',revision:'seed-r1',sha256:digest(bytes),byte_length:bytes.length};
  binding.revision_seeds??={};binding.revision_seeds[language]={receipt,requested_changes:[{semantic_ids:[f.basis.required_semantic_units[0].semantic_unit_id],reason:'Correct only reported mechanical errors and retain supported prose.'}]};
  seeds.push({receipt,bytes});
 }
 if(options.filePayload){binding.payload_transport='owned_file';for(const task of allTasks)task.payload={artifact_id:'payload-'+task.task_id,path:'control/payload-'+task.task_id+'.json',revision:task.revision};}
 const ownedBindings=allTasks.flatMap(x=>(x.role==='bilingual-verifier'?[x.artifact_path]:[x.artifact_path,x.revision_artifact_path]).map(artifact_path=>({run_id:runId,actor_id:x.owner_actor_id,role:x.role,artifact_path,revision:x.revision})));
 ownedBindings.push(...seeds.map(({receipt:r})=>({run_id:runId,actor_id:r.owner_actor_id,role:r.role,artifact_path:r.path,revision:r.revision})));
 if(options.filePayload)ownedBindings.push(...allTasks.map(task=>({run_id:runId,actor_id:binding.controller_actor_id,role:'control',artifact_path:task.payload.path,revision:task.payload.revision})));
 if(consumption)ownedBindings.push(...consumption.artifacts.map(({receipt:r})=>({run_id:runId,actor_id:r.owner_actor_id,role:r.role,artifact_path:r.path,revision:r.revision})));
 const broker=createOwnedArtifactBroker({control_actor_id:binding.controller_actor_id,artifact_root:f.artifactRoot,authorized_bindings:ownedBindings,
  run_controls:[{run_id:runId,phase22_language_binding:binding}]});
 for(const {receipt:r,bytes}of seeds)await broker.artifactStore.commitOwnedArtifact({artifactRoot:f.artifactRoot,dispatchContext:broker.dispatchContext,capability:broker.issueCapability({runId,actorId:r.owner_actor_id,role:r.role,artifactPath:r.path,revision:r.revision}),expectedRevision:r.revision,artifact:{artifact_id:r.artifact_id,content:bytes}});
 if(consumption)for(const {receipt:r,bytes} of consumption.artifacts)await broker.artifactStore.commitOwnedArtifact({artifactRoot:f.artifactRoot,dispatchContext:broker.dispatchContext,
  capability:broker.issueCapability({runId,actorId:r.owner_actor_id,role:r.role,artifactPath:r.path,revision:r.revision}),expectedRevision:r.revision,artifact:{artifact_id:r.artifact_id,content:bytes}});
 await options.beforeCreate?.({f,context,binding,broker,consumption});
 const runControl={artifactRoot:f.artifactRoot,inputArtifactRoot:f.artifactRoot,dispatchContext:broker.dispatchContext,runId,validator:f.validator,available_slots:options.slots??3,resources_available:options.resourcesAvailable??true,...(options.now?{now:options.now}:{})};
 const created=(options.reader?createReaderLanguageRequests:createLanguageRequests)({basis:f.basis,context,runControl,readerInput,reviewedSupport});if(options.assertCreated!==false)assert.equal(created.ok,true,JSON.stringify(created));
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
 const preparePayload=async request=>{const api=await import('../../../scripts/v3/phase22-language.mjs');assert.equal(typeof api.preparePhase22RequestPayload,'function');const task=allTasks.find(x=>x.task_id===request.task_id);const made=await api.preparePhase22RequestPayload({request,capability:broker.issueCapability({runId,actorId:binding.controller_actor_id,role:'control',artifactPath:task.payload.path,revision:task.payload.revision})});assert.equal(made.ok,true,JSON.stringify(made));return made.request;};
 const outgoing=options.filePayload&&options.autoPayload!==false?await Promise.all(created.requests.map(preparePayload)):created.requests;
 return {...f,reader:options.reader,readerInput,reviewedSupport,context,tasks,binding,broker,consumption,runControl,created,emit,start,commit,preparePayload,requests:outgoing,dependencies:created.dependencies};
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
 return (f.reader?acceptReaderLanguageResult:acceptLanguageResult)({request,result:view,receipt,currentDependencies:f.dependencies});
}

import { createParityRequest, assessBilingualParity, listParityTargets, listReaderParityTargets, PARITY_DIMENSIONS } from '../../../scripts/v3/phase22-parity.mjs';
import { collectLanguageSpans } from '../../../scripts/v3/phase22-language.mjs';
async function parityFixture(t,{mutateView,fixtureOptions={}}={}) {
 const f=await (fixtureOptions.prepareLanguageFixture??languageFixture)(t,fixtureOptions),views={...(f.created.views??{})},accepted=Object.fromEntries(Object.entries(f.created.views??{}).map(([language,view])=>[language,{view_fingerprint:getAcceptedReaderLanguageRecord(view).view_fingerprint}]));
 for(const request of f.requests) {
  const view=makeView(f,request);if(mutateView)await mutateView(view,request.language,f);
  const r=await acceptFixtureView(f,request,view);assert.equal(r.ok,true,JSON.stringify(r));
  views[request.language]=r.view;accepted[request.language]=r;
 }
 const made=(f.reader?createReaderParityRequest:createParityRequest)({basis:f.basis,context:f.context,views,controller:f.created.controller});assert.equal(made.ok,true,JSON.stringify(made));
 return {...f,views,accepted,verifierRequest:fixtureOptions.filePayload?await f.preparePayload(made.request):made.request,parityDependencies:made.dependencies};
}
const range=span=>({span_id:span.span_id,start:0,end:span.text.length,text:span.text});
function makeSemanticReview(f) {
 const targets=f.reader?listReaderParityTargets(f.basis,f.views):listParityTargets(f.basis),all=Object.fromEntries(['en','zh-CN'].map(language=>[language,collectLanguageSpans(f.views[language]).map(x=>x.span)]));
 const spansFor=(id,language)=> {
  const view=f.views[language],coverage=view.coverage.find(x=>x.semantic_id===id);
  if(coverage)return coverage.span_ids.map(spanId=>range(all[language].find(x=>x.span_id===spanId)));
  const matches=all[language].filter(x=>x.boundary_refs.includes(id)||x.support_refs?.includes(id));
  return matches.filter(x=>id.startsWith('unit_')?x.core_quantity_bindings.length:true).map(range);
 };
 const items=targets.flatMap(target=>PARITY_DIMENSIONS.map(dimension=>({semantic_id:target.semantic_id,basis_pointer:target.basis_pointer,basis_summary:target.summary,
  en_spans:spansFor(target.semantic_id,'en'),zh_spans:spansFor(target.semantic_id,'zh-CN'),dimension,verdict:'aligned',
  rationale:'Synthetic fixed-case adjudication: both exact spans preserve the frozen proposition, attribution and stated limits.',
  revision_owner:'none',recheck_scope:[target.semantic_id]})));
 const byId=new Map(targets.map(x=>[x.semantic_id,x.basis_pointer]));
 const reverse_grounding=Object.entries(all).flatMap(([language,spans])=>spans.map(span=>({language,span_id:span.span_id,checked_range:{start:0,end:span.text.length,text:span.text},
  propositions:[{proposition_id:'proposition-'+span.span_id,range:{start:0,end:span.text.length,text:span.text},
    semantic_refs:[...span.semantic_refs,...span.boundary_refs,...(span.support_refs??[])],basis_pointers:[...span.semantic_refs,...span.boundary_refs,...(span.support_refs??[])].map(id=>byId.get(id)).filter(Boolean),
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
 return (f.reader?assessReaderBilingualParity:assessBilingualParity)({basis:f.basis,context:f.context,views:f.views,semanticReview:review,receipts:{verifier:{request:f.verifierRequest,receipt}},
  currentDependencies:options.currentDependencies??f.parityDependencies});
}


import { restorePhase22Runtime, resumePhase22Runtime } from '../../../scripts/v3/phase22-language.mjs';
import { registerReaderTargets } from '../../../scripts/v3/phase221-targets.mjs';
import { renderReaderNotes } from '../../../scripts/v3/phase221-presentation.mjs';
import { prepareReaderReview, getPreparedReaderReviewPayload, assessReaderReview, assertReaderReviewCurrent } from '../../../scripts/v3/phase221-reading-review.mjs';
function makeReaderReview(payload,request) {
 const judgment=(id,language,locations)=>({id,language,verdict:'pass',reason:'Synthetic fixed transport adjudication only; no claim of actual reading acceptance.',revision_owner:'none',recheck_scope:[id],locations});
 return {schema_version:'phase22/reading-review-1.0',kind:'reader_semantic_review',request_id:request.request_id,prepared_fingerprint:payload.prepared_fingerprint,identity:payload.identity,
  reviewed_ranges:structuredClone(payload.pages.flatMap(page=>page.machine_ranges)),
  items:payload.targets.flatMap(target=>['en','zh-CN'].map(language=>{
   const locations=target.expressions[language].map(({text,...location})=>location),missing=!locations.length;
   return {...judgment(target.id,language,locations),verdict:missing?'block':'pass',revision_owner:missing?'Writer':'none',
    reason:missing?'The synthetic final manuscript has no mapped expression for this target.':'Synthetic exact-range transport review; semantic quality remains unaccepted.',
    expression_summary:target.expressions[language].map(row=>row.text).join(' ')||'No mapped expression in this final page.',
    applicability:target.applicability,source_basis:target.source_basis,affected_gaps:payload.gaps.filter(gap=>gap.id===target.id).map(gap=>gap.id),critical:false,visibility:missing?'absent':'visible'};
  })),
  rubric:payload.rubric_ids.flatMap(id=>payload.pages.map(page=>judgment(id,page.language,[page.machine_ranges[0]]))),
  criteria:payload.criteria_ids.flatMap(id=>payload.pages.map(page=>judgment(id,page.language,[page.machine_ranges[0]]))),
  limitations:['Synthetic transport, binding and rejection evidence only; not scientific or native acceptance.']};
}
async function readerReviewFixture(t,{filePayload=false,presentationOptions={},mergeHuman=false,fixtureOptions={},mutateView,existingTargets:suppliedTargets=[],historicalSourceInput,preparePresentationOptions}={}) {
 const task={task_id:'task-reader-review',task_name:'p221_post_render',owner_actor_id:'bilingual-verifier',role:'bilingual-verifier',revision:'review-r1',artifact_id:'reader-review',artifact_path:'owned/reader-review.json',native_path:'native/reader-review.json'};
 const f=await parityFixture(t,{mutateView,fixtureOptions:{...fixtureOptions,reader:true,filePayload,binding:{...fixtureOptions.binding,max_calls:fixtureOptions.binding?.max_calls??4,revision_bindings:[...(fixtureOptions.binding?.revision_bindings??[]),{binding_id:'post-render',language:'verifier',task}]}}});
 const parity=await adjudicate(f);assert.equal(parity.ok,true,JSON.stringify(parity));
 const rendererInput={basis:f.basis,context:f.context,views:f.views,parity,mode:'reader',...(historicalSourceInput?{historicalSourceInput}:{})};
 const extraOptions=preparePresentationOptions?await preparePresentationOptions({...f,rendererInput}):{};
 presentationOptions={...presentationOptions,...extraOptions.presentationOptions};
 const registry=registerReaderTargets({identity:f.basis.identity,registeredBibliography:{first_author:'Synthetic',year:2026,title:'Synthetic reader transport'}});
 let presentation=await renderReaderNotes({input:rendererInput,targetRegistry:registry,presentationOptions,existingTargets:suppliedTargets});
 let existingTargets=suppliedTargets;
 if(mergeHuman){
  const {inspectManagedNote}=await import('../../../scripts/v3/phase22-managed-markdown.mjs');
  existingTargets=[['en',presentation.en],['zh-CN',presentation.zhCN]].map(([language,bytes])=>{
   const text=bytes.toString('utf8').replace('graph_scope: v3-candidate\n','graph_scope: v3-candidate\ncustom_field: preserved\n')+'\nPersonal observation 保留我的笔记。\n';
   const existing=Buffer.from(text);return {path:registry.paper_targets[language],bytes:existing,managedHash:inspectManagedNote(existing).managedHash};
  });
  presentation=await renderReaderNotes({input:rendererInput,targetRegistry:registry,existingTargets,presentationOptions});
 }
 const prepared=await prepareReaderReview({presentation}),payload=getPreparedReaderReviewPayload(prepared);
 const made=await createReaderReviewRequest({controller:f.created.controller,prepared,views:f.views});assert.equal(made.ok,true,JSON.stringify(made));
 const request=filePayload?await f.preparePayload(made.request):made.request;
 return {...f,presentation,prepared,payload,reviewRequest:request,reviewDependencies:made.dependencies,rendererInput,registry,existingTargets,parity,
  effectivePresentationOptions:presentationOptions,quantityProofReceipt:extraOptions.quantityProofReceipt};
}

export { contextFixture, languageFixture, parityFixture, adjudicate, makeSemanticReview, makeView, readerReviewFixture, makeReaderReview };

