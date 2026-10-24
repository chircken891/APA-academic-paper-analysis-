import YAML from 'yaml';
import { assertCommittedSnapshot } from './phase22-active-version.mjs';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as same } from 'node:util';
import { fingerprintV3Json as hash } from './semantic-package-validator.mjs';
import { getRunControlForDispatch } from './owned-artifact-store.mjs';
import { getReadingBasisContent, freezePhase22Value } from './phase22-input.mjs';

export const PHASE22_REGIONS = Object.freeze(['source','abstract','study-design','key-findings','methods-concepts-measures','figures-tables','discussion','limitations','conclusion','evidence','relations','coverage']);
export const PHASE22_EXEMPT_KINDS = Object.freeze(['quotation','title','formula','code','id','url','link_target']);
const frozenContexts = new WeakSet();
const committedSupportContexts = new WeakMap();
const physicalHash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const fail = (code, path, details = {}) => { throw Object.assign(new Error(code), { code, path, details }); };
const nonblank = value => typeof value === 'string' && !!value.trim();
const key = (type,id) => type + '-' + hash({type,id}).slice(7,39);
const knownRefs = (refs, ids) => Array.isArray(refs) && refs.length > 0 && new Set(refs).size === refs.length && refs.every(id => ids.has(id));

/** Runtime capability check; serialized context must be re-frozen from controlled inputs. */
export function assertFrozenRenderContext(context, basis) {
  if (!frozenContexts.has(context) || context.basis_fingerprint !== basis.basis_fingerprint) fail('P22_CONTEXT_NOT_FROZEN', '/context');
  const snapshot = committedSupportContexts.get(context);
  if (snapshot) assertCommittedSnapshot(snapshot);
  return context;
}
function readIntegrator(integratorReceipt,basis,termCandidates,entityMappings) {
  const { artifactRoot, dispatchContext, runId, artifactId } = integratorReceipt ?? {};
  const binding = getRunControlForDispatch({dispatchContext,runId})?.phase22_context_binding;
  if (!binding || runId !== basis.identity.run_id || artifactId !== binding.artifact_id
    || binding.basis_fingerprint !== basis.basis_fingerprint || binding.role !== 'integration') fail('P22_INTEGRATOR_CONTROL_REQUIRED','/integratorReceipt');
  const root=realpathSync(artifactRoot);
  const receipt=JSON.parse(readFileSync(resolve(root,'.phase21-receipts',encodeURIComponent(artifactId)+'.json'),'utf8'));
  for(const field of ['artifact_id','owner_actor_id','role','path','revision']) if(receipt[field] !== binding[field]) fail('P22_INTEGRATOR_RECEIPT_MISMATCH','/integratorReceipt/'+field);
  if(receipt.run_id !== runId)fail('P22_INTEGRATOR_RECEIPT_MISMATCH','/integratorReceipt/run_id');
  const target=resolve(root,receipt.path),rel=relative(root,target),stat=lstatSync(target);
  if(!rel || rel==='..' || rel.startsWith('..'+sep) || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || realpathSync(target)!==target)fail('P22_INTEGRATOR_PATH_INVALID','/integratorReceipt/path');
  const bytes=readFileSync(target);
  if(physicalHash(bytes)!==receipt.sha256 || bytes.length!==receipt.byte_length || receipt.sha256!==binding.payload_sha256)fail('P22_INTEGRATOR_BYTES_CHANGED','/integratorReceipt');
  const payload=JSON.parse(bytes.toString('utf8'));
  if(payload.schema_version!=='phase22-integrator-context-input-1.0' || payload.basis_fingerprint!==basis.basis_fingerprint
    || !nonblank(payload.ledger_version) || !same(payload.term_candidates,termCandidates) || !same(payload.entity_mappings,entityMappings)) fail('P22_INTEGRATOR_INPUT_MISMATCH','/integratorReceipt/payload');
  return {receipt,payload};
}


/** Validate paths without normalizing the original scientific label or target bytes. */
export function validatePhase22TargetPath(target_path) {
  if (typeof target_path !== 'string' || !/^Wiki\/(methods|concepts)\/[^/]+\.md$/.test(target_path)
    || /[\x00-\x1f<>:"\\|?*#\[\]^]/.test(target_path)) fail('P22_TARGET_PATH_INVALID','/target_path');
  const name=target_path.split('/').at(-1),stem=name.slice(0,-3);
  if(stem.trim()!==stem || stem.endsWith('.') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))fail('P22_TARGET_PATH_INVALID','/target_path');
  return {target_path,collision_key:target_path.normalize('NFC').toLowerCase()};
}
export function assertPhase22TargetRegistry(entries) {
  const seen=new Map();
  for(const entry of entries){
    const {collision_key}=validatePhase22TargetPath(entry.target_path);
    if(seen.has(collision_key))fail('P22_TARGET_COLLISION','/entityMappings',{entity_ids:[seen.get(collision_key),entry.entity_id]});
    seen.set(collision_key,entry.entity_id);
  }
}
function compatibleSupport(entity,textByUnit,definitionFingerprint,committedSnapshot) {
  const old=entity.existing_support;
  validatePhase22TargetPath(old.target_path);
  if(!old.target_path.startsWith('Wiki/'+(entity.entity_type==='method'?'methods':'concepts')+'/'))fail('P22_EXISTING_SUPPORT_CONFLICT','/existing_support/target_path');
  if(!nonblank(old.compatibility_reason)||!nonblank(old.definition_text)||!nonblank(old.existing_entity_id))fail('P22_EXISTING_SUPPORT_CONFLICT','/existing_support');
  const definitions=entity.definition_unit_refs.flatMap(id=>{
    const row=textByUnit.get(id);return [row?.meaning_plain,row?.finding,row?.text,row?.allowed_conclusion].filter(nonblank);
  });

  const root=realpathSync(old.vault_root),target=resolve(root,old.target_path),rel=relative(root,target),stat=lstatSync(target);
  if(!rel||rel==='..'||rel.startsWith('..'+sep)||!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||realpathSync(target)!==target)fail('P22_EXISTING_SUPPORT_CONFLICT','/existing_support/target_path');
  const bytes=readFileSync(target);
  if(physicalHash(bytes)!==old.byte_sha256)fail('P22_EXISTING_SUPPORT_CHANGED','/existing_support/byte_sha256');
  const text=bytes.toString('utf8'),front=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if(!front)fail('P22_EXISTING_SUPPORT_CONFLICT','/existing_support/frontmatter');
  const doc=YAML.parseDocument(front[1]);
  if(doc.errors.length)fail('P22_EXISTING_SUPPORT_CONFLICT','/existing_support/frontmatter');
  const meta=doc.toJS(),identity=meta.entity_id??(entity.entity_type==='method'?meta.method_id:entity.entity_type==='measure'?meta.measure_id:meta.concept_id);
  const v3=/^3\./.test(String(meta.pipeline_version??''))&&meta.canonical_key===entity.canonical_key&&meta.definition_fingerprint===definitionFingerprint;
  const candidate=meta.status==='candidate'&&meta.pipeline_version==='3.0'&&meta.graph_scope==='v3-candidate'
    &&meta.rendering_profile==='phase22-support-note-1.0'&&meta.entity_type===entity.entity_type&&v3;
  if(meta.type!==(entity.entity_type==='method'?'method':'concept')||(!candidate&&(meta.status!=='canonical'||!v3))||identity!==old.existing_entity_id||identity!==entity.entity_id)fail('P22_EXISTING_SUPPORT_CONFLICT','/existing_support/identity');
  // Committed P22 definitions may contain multiple accepted English spans. Their
  // full source records are bound by v3's fingerprint; exact rendered text is checked below.
  // Preserve the legacy single-source-field rule for canonical V3 support.
  if(!candidate&&!definitions.includes(old.definition_text))fail('P22_EXISTING_SUPPORT_CONFLICT','/existing_support/definition_text');
  if(candidate){
    const record=assertCommittedSnapshot(committedSnapshot),generation=committedSnapshot.generation;
    if(realpathSync(record.root)!==root
      ||!generation.shared_nodes.some(node=>node.entity_id===entity.entity_id&&node.path===old.target_path)
      ||!generation.objects.some(item=>item.kind==='support'&&item.path===old.target_path&&item.sha256===old.byte_sha256))fail('P22_EXISTING_SUPPORT_NOT_COMMITTED','/existing_support');
    const section=heading=>{
      const marker='## '+heading+'\n\n',body=text.replaceAll('\r\n','\n'),start=body.indexOf(marker);
      return start<0?null:body.slice(start+marker.length).split(/\n#{1,2}[ \t]/,1)[0].trim();
    };
    if(meta.scope!==entity.scope||!same(meta.definition_unit_refs,entity.definition_unit_refs)||!same(meta.source_refs,entity.source_refs)
      ||section('Scope / 适用范围')!==entity.scope||section('Limitations / 局限')!==entity.limitations.map(x=>'- '+x).join('\n'))fail('P22_EXISTING_SUPPORT_CONFLICT','/existing_support/scope_limits');
  }
  const heading=/^## (?:Definition|Definition \(English\)|English definition)[ \t]*\r?\n/m.exec(text);
  const definition=heading?text.slice(heading.index+heading[0].length).split(/\r?\n#{1,2}[ \t]/,1)[0].trim():'';
  if(definition!==old.definition_text)fail('P22_EXISTING_SUPPORT_CONFLICT','/existing_support/definition');
  return {ref:{entity_id:entity.entity_id,target_path:old.target_path,byte_sha256:old.byte_sha256,definition_fingerprint:definitionFingerprint,disposition:'reuse'},candidate};
}

/** Sole Integrator-owned freeze, without any Wiki write. */
export function freezeRenderContext({basis,termCandidates,entityMappings,integratorReceipt,validator,committedSnapshot}={}) {
  try {
    const science=getReadingBasisContent(basis);
    const {receipt,payload}=readIntegrator(integratorReceipt,basis,termCandidates,entityMappings);
    if(!Array.isArray(termCandidates) || !Array.isArray(entityMappings))fail('P22_CONTEXT_INPUT_INVALID','/');
    const semanticIds=new Set(basis.required_semantic_units.map(x=>x.semantic_unit_id));
    const sourceIds=new Set(science.scientific_details.source_blocks.map(x=>x.source_block_id));
    const textByUnit=new Map();
    for(const [collection,id]of [['records','semantic_unit_id'],['explanations','explanation_id'],['claims','claim_id'],['statements','statement_id'],['quantities','quantity_id'],['research_candidates','candidate_id']]){
      for(const row of science.scientific_details[collection])textByUnit.set(row[id],row);
    }
    const nodes=new Map(), canonicalKeys=new Set(), existingSupportRefs=[];
    let usesCommittedSupport=false;
    const mapped=entityMappings.map((entity,i)=>{
      const path='/entityMappings/'+i;
      if(!nonblank(entity.entity_id) || nodes.has(entity.entity_id) || !['method','concept','measure'].includes(entity.entity_type)
        || !nonblank(entity.canonical_key) || !entity.canonical_key.startsWith(entity.entity_type+':'))fail('P22_ENTITY_IDENTITY_CONFLICT',path);
      if(!knownRefs(entity.definition_unit_refs,semanticIds) || !knownRefs(entity.source_refs,sourceIds) || !nonblank(entity.scope)
        || !Array.isArray(entity.limitations) || !entity.limitations.every(nonblank))fail('P22_ENTITY_DEFINITION_REQUIRED',path,{entity_id:entity.entity_id});
      const supportedSources=new Set(entity.definition_unit_refs.flatMap(id=>textByUnit.get(id)?.source_block_ids??[]));
      if(entity.source_refs.some(id=>!supportedSources.has(id)))fail('P22_ENTITY_DEFINITION_REQUIRED',path+'/source_refs');
      const canonicalCollision=entity.canonical_key.normalize('NFC').toLowerCase();
      if(canonicalKeys.has(canonicalCollision))fail('P22_ENTITY_IDENTITY_CONFLICT',path+'/canonical_key');
      canonicalKeys.add(canonicalCollision);
      const storage_key=key(entity.entity_type,entity.entity_id),target_path='Wiki/'+(entity.entity_type==='method'?'methods':'concepts')+'/'+storage_key+'.md';
      const output={...structuredClone(entity),storage_key,target_path,anchor:'e-'+hash({entity_id:entity.entity_id}).slice(7,31),disposition:'create',
        definition_fingerprint:hash({records:entity.definition_unit_refs.map(id=>textByUnit.get(id)),scope:entity.scope,limitations:entity.limitations})};
      if(entity.existing_support){
        const {ref:compatible,candidate}=compatibleSupport(entity,textByUnit,output.definition_fingerprint,committedSnapshot);
        usesCommittedSupport ||= candidate;
        output.target_path=compatible.target_path;output.disposition='reuse';existingSupportRefs.push(compatible);delete output.existing_support;
      }
      nodes.set(entity.entity_id,output);
      return output;
    });
    assertPhase22TargetRegistry(mapped);
    const termIds=new Set(),abbreviations=new Map();
    const ledger=termCandidates.map((term,i)=>{
      const path='/termCandidates/'+i;
      if(!nonblank(term.term_id)||termIds.has(term.term_id)||!nonblank(term.sense)||!nonblank(term.domain)||!nonblank(term.version))fail('P22_TERM_SENSE_AMBIGUOUS',path,{term_id:term.term_id});
      termIds.add(term.term_id);
      if(!nodes.has(term.canonical_node_id)||!nonblank(term.en_full_form)||!nonblank(term.abbreviation)
        ||!knownRefs(term.definition_unit_refs,semanticIds)||!knownRefs(term.source_refs,sourceIds))fail('P22_TERM_DEFINITION_MISSING',path,{term_id:term.term_id});
      if(term.definition_unit_refs.some(id=>!nodes.get(term.canonical_node_id).definition_unit_refs.includes(id)))fail('P22_TERM_DEFINITION_MISSING',path+'/canonical_node_id');
      const definitions=term.definition_unit_refs.map(id=>textByUnit.get(id));
      const supported=new Set(definitions.flatMap(row=>row?.source_block_ids??[]));
      const exactDefinition=definitions.some(row=>row?.full_term===term.en_full_form
        || row?.full_term===term.en_full_form+' ('+term.abbreviation+')'
        || [row?.meaning_plain,row?.finding,row?.text].some(text=>typeof text==='string' && text.toLowerCase().includes(term.en_full_form.toLowerCase())));
      if(!exactDefinition||term.source_refs.some(id=>!supported.has(id)))fail('P22_TERM_DEFINITION_MISSING',path+'/definition_unit_refs',{term_id:term.term_id});
      const translation=term.translation;
      if(!translation || !nonblank(translation.reason) || !knownRefs(translation.source_refs,supported)
        || term.zh_full_form===null && translation.status!=='no_stable_translation'
        || term.zh_full_form!==null && (!nonblank(term.zh_full_form)||translation.status!=='approved'))fail('P22_TERM_DEFINITION_MISSING',path+'/translation',{term_id:term.term_id});
      const abbr=term.abbreviation.normalize('NFC').toLowerCase(),priors=abbreviations.get(abbr)??[];
      for(const prior of priors)if(prior.canonical_node_id!==term.canonical_node_id && (!nonblank(prior.disambiguation_note)||!nonblank(term.disambiguation_note)||prior.sense===term.sense))fail('P22_TERM_SENSE_AMBIGUOUS',path,{term_id:term.term_id,conflicts_with:prior.term_id});
      abbreviations.set(abbr,[...priors,term]);
      return structuredClone(term);
    }).sort((a,b)=>a.term_id.localeCompare(b.term_id));
    const anchorIds=[...new Set([...basis.required_semantic_units.map(x=>x.semantic_unit_id),...science.core.units.map(x=>x.unit_id),...science.core.evidence.map(x=>x.evidence_id),...science.scientific_details.source_blocks.map(x=>x.source_block_id),...(basis.source_presentation?.assets??[]).map(x=>'asset:'+x.asset_id)])].sort();
    const paper_storage_key=key('paper',basis.identity.paper_id);
    const content={
      schema_version:'phase22/render-context-1.0',identity:basis.identity,basis_fingerprint:basis.basis_fingerprint,
      ledger_version:payload.ledger_version,terminology_ledger:ledger,terms_fingerprint:hash({version:payload.ledger_version,terms:ledger}),
      entityMappings:mapped.sort((a,b)=>a.entity_id.localeCompare(b.entity_id)),
      anchorMappings:anchorIds.map(semantic_id=>({semantic_id,anchor:'s-'+hash({semantic_id}).slice(7,31)})),
      paper_storage_key,paper_targets:{en:'Wiki/sources/'+paper_storage_key+'.en.md','zh-CN':'Wiki/sources/'+paper_storage_key+'.zh-CN.md'},
      section_scope:{region_ids:PHASE22_REGIONS,subheadings_share_scope:true,reset_each_region:true,exempt_kinds:PHASE22_EXEMPT_KINDS,
        expansion:{en:'Full Term (ABBR)','zh-CN':'中文全称（English Full Term，ABBR）',zh_without_stable_translation:'English Full Term（ABBR）'}},
      integrator_binding:{artifact_id:receipt.artifact_id,run_id:receipt.run_id,owner_actor_id:receipt.owner_actor_id,role:receipt.role,path:receipt.path,revision:receipt.revision,sha256:receipt.sha256},
      existingSupportRefs,
      invalidation_dependencies:{...basis.invalidation_dependencies,basis:basis.basis_fingerprint,integrator:receipt.sha256,
        ...(usesCommittedSupport?{committed_support:assertCommittedSnapshot(committedSnapshot).markerHash}:{})},
    };
    const context={...content,context_fingerprint:hash(content)};
    const checked=validator.validate('phase22/render-context-1.0',context);
    if(!checked.ok)fail('P22_CONTEXT_SCHEMA_INVALID','/',{errors:checked.errors});
    if(usesCommittedSupport){assertCommittedSnapshot(committedSnapshot);committedSupportContexts.set(context,committedSnapshot);}
    freezePhase22Value(context);frozenContexts.add(context);
    return {ok:true,context,errors:[]};
  } catch(error) {
    return {ok:false,errors:[{code:error.code??'P22_CONTEXT_INVALID',path:error.path??'/',details:error.details??{message:error.message},owner:'Integrator'}]};
  }
}

