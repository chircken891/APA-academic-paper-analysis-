/** Fixed snapshot binding only. Human approval and live run budgets belong to the calling controller. */
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual as same} from 'node:util';
import Ajv2020 from 'ajv/dist/2020.js';
import {canonicalizeV3Json,fingerprintV3Json as hash} from './semantic-package-validator.mjs';
import {getRunControlForDispatch} from './owned-artifact-store.mjs';
import {decodeWholePaperArtifact} from './whole-paper-storage.mjs';
import {validateSourceEvidenceVisibleView} from './source-evidence-bundle.mjs';
import {validateScientificInput} from './scientific-input-validator.mjs';

export const SOURCE_EVIDENCE_REFERENCE_VERSION='phase21-source-evidence-scientific-input-ref-1.0';
const VERSION='source-evidence-reuse-1';
const CONTROL_KEYS=['source','parser_tool','permission','parent_revision','policy','authorization'];
const SHA=/^sha256:[a-f0-9]{64}$/;
const CAPS={bytes:2*1024*1024*1024,nodes:4000000,visits:128000000,depth:128};
const WIRE_CAP=256*1024*1024;
const fail=(code,details={})=>{throw Object.assign(new Error(code),{code,details});};
const sha=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
// Only a project-owned schema is read at initialization; no input-driven I/O.
const schema=JSON.parse(await readFile(new URL('../../Schema/phase21/source-evidence-reuse.schema.json',import.meta.url),'utf8'));
const ajv=new Ajv2020({strict:false,allErrors:false});ajv.addSchema(schema);
const registrationShape=ajv.compile({$ref:'phase21/source-evidence-reuse#/$defs/registration'});
const referenceShape=ajv.compile({$ref:'phase21/source-evidence-reuse#/$defs/reference'});

/** Exact expanded sizes/visits/depth; identity-unique nodes conservatively bound codec structural deduplication. */
export function inspectSourceEvidenceReuseResources(value){
  const memo=new WeakMap(),active=new Set(),scalars=new Set();let nodes=0;
  const check=(key,n)=>{if(!Number.isSafeInteger(n)||n<0||n>CAPS[key])fail('SOURCE_EVIDENCE_REUSE_RESOURCE_LIMIT',{counter:key});return n;};
  const scalar=value=>{let text;try{text=canonicalizeV3Json(value);}catch{fail('SOURCE_EVIDENCE_REUSE_JSON_INVALID');}return text;};
  const visit=(value,depth=1)=>{
    check('depth',depth);
    if(value===null||typeof value!=='object'){
      const text=scalar(value);if(!scalars.has(text)){scalars.add(text);check('nodes',++nodes);}
      return {bytes:check('bytes',Buffer.byteLength(text)),visits:1,depth:1};
    }
    if(active.has(value))fail('SOURCE_EVIDENCE_REUSE_JSON_INVALID');
    if(memo.has(value)){const result=memo.get(value);check('depth',depth+result.depth-1);return result;}
    const array=Array.isArray(value),descriptors=Object.getOwnPropertyDescriptors(value),keys=Object.keys(value);
    if(!array&&![Object.prototype,null].includes(Object.getPrototypeOf(value))||Object.getOwnPropertySymbols(value).length
      ||Object.values(descriptors).some(d=>!Object.hasOwn(d,'value'))
      ||array&&(keys.length!==value.length||keys.some((k,i)=>k!==String(i)))
      ||!array&&Object.values(descriptors).some(d=>!d.enumerable))fail('SOURCE_EVIDENCE_REUSE_JSON_INVALID');
    check('nodes',++nodes);active.add(value);
    let bytes=2,visits=1,maxDepth=1;
    for(let i=0;i<keys.length;i++){
      const key=keys[i],child=visit(descriptors[key].value,depth+1);
      bytes=check('bytes',bytes+(i?1:0)+(array?0:Buffer.byteLength(scalar(key))+1)+child.bytes);
      visits=check('visits',visits+child.visits);maxDepth=Math.max(maxDepth,child.depth+1);
    }
    active.delete(value);const result={bytes,visits,depth:check('depth',maxDepth)};memo.set(value,result);return result;
  };
  const result=visit(value);return Object.freeze({...result,unique_nodes_upper_bound:nodes});
}

function boundedJson(value){const accounting=inspectSourceEvidenceReuseResources(value);if(accounting.bytes>WIRE_CAP)fail('SOURCE_EVIDENCE_REUSE_WIRE_LIMIT');return accounting;}
function frozenCopy(value){
  const result=structuredClone(value),seen=new WeakSet();
  const freeze=v=>{if(v&&typeof v==='object'&&!seen.has(v)){seen.add(v);for(const child of Object.values(v))freeze(child);Object.freeze(v);}};
  freeze(result);return result;
}
function requireRegistration(registration){
  boundedJson(registration);if(!registrationShape(registration))fail('SOURCE_EVIDENCE_REUSE_REGISTRATION_INVALID');
  const negative=registration.negative_parser_binding;
  const ids=[registration.bundle_ref.artifact_id,registration.view_ref.artifact_id,negative.summary_ref.artifact_id,negative.build_ref.artifact_id,negative.results_ref.artifact_id];
  if(new Set(ids).size!==ids.length)fail('SOURCE_EVIDENCE_REUSE_REGISTRATION_INVALID');
}

/** Current control fingerprint. A digest is a consistency binding, never an approval or live-budget certificate. */
export function fingerprintSourceEvidenceRunControl({run,dispatchContext}={}){
  const control=getRunControlForDispatch({dispatchContext,runId:run?.run_id});
  if(!control)fail('RUN_CONTROL_CONTEXT_REQUIRED');
  for(const key of CONTROL_KEYS)if(!SHA.test(control.approved_fingerprints?.[key])
    ||control.approved_fingerprints[key]!==run.declared_fingerprints?.[key]
    ||control.approved_fingerprints[key]!==run.current_fingerprints?.[key])fail('RUN_CONTROL_FINGERPRINT_MISMATCH',{name:key});
  const registration=control.source_evidence_reuse;
  if(registration===undefined)return hash(run.current_fingerprints);
  requireRegistration(registration);
  const execution=registration.execution_binding;
  if(registration.identity.run_id!==run.run_id||registration.source_scope_fingerprint!==run.current_fingerprints.source
    ||execution.authorization_fingerprint!==run.current_fingerprints.authorization
    ||!execution.allowed_steps.includes('scientific_input'))fail('SOURCE_EVIDENCE_REUSE_AUTHORIZATION_MISMATCH');
  return hash({binding_version:VERSION,current_six_fingerprints:run.current_fingerprints,source_evidence_reuse_registration:registration});
}

/** A small persisted envelope; it does not validate science or authorize any operation. */
export function createSourceEvidenceScientificInputReference({scientificInput,bundleRef,viewRef}={}){
  if(!scientificInput||typeof scientificInput!=='object')fail('SOURCE_EVIDENCE_REUSE_REFERENCE_INVALID');
  const descriptors=Object.getOwnPropertyDescriptors(scientificInput);
  if(![Object.prototype,null].includes(Object.getPrototypeOf(scientificInput))||Object.values(descriptors).some(d=>!d.enumerable||!Object.hasOwn(d,'value'))||Object.getOwnPropertySymbols(scientificInput).length)fail('SOURCE_EVIDENCE_REUSE_JSON_INVALID');
  const {source_evidence_bundle,...scientific_input_fields}=scientificInput;
  if(!source_evidence_bundle||Object.getOwnPropertyDescriptor(source_evidence_bundle,'schema_version')?.value!=='phase21-source-evidence-bundle-1.0')fail('SOURCE_EVIDENCE_REUSE_REFERENCE_INVALID');
  const content={schema_version:SOURCE_EVIDENCE_REFERENCE_VERSION,scientific_input_fields,bundle_ref:bundleRef,view_ref:viewRef};
  boundedJson(content);const reference={...content,reference_fingerprint:hash(content)};
  if(!referenceShape(reference))fail('SOURCE_EVIDENCE_REUSE_REFERENCE_INVALID');
  boundedJson(reference);return frozenCopy(reference);
}

function suppliedBytes(value,expectedSha){
  if(!(value instanceof Uint8Array)||value.buffer instanceof SharedArrayBuffer)fail('SOURCE_EVIDENCE_REUSE_BYTES_REQUIRED');
  if(value.byteLength>WIRE_CAP)fail('SOURCE_EVIDENCE_REUSE_WIRE_LIMIT');
  const bytes=Buffer.from(value.buffer,value.byteOffset,value.byteLength);
  if(sha(bytes)!==expectedSha)fail('SOURCE_EVIDENCE_REUSE_PHYSICAL_MISMATCH');return bytes;
}
function suppliedJson(value,expectedSha){
  const bytes=suppliedBytes(value,expectedSha);let result;
  try{result=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes));}catch{fail('SOURCE_EVIDENCE_REUSE_JSON_INVALID');}
  boundedJson(result);return result;
}

/** Receipt bytes are bounded and checked before their fields are used. No source resolution happens here. */
export function readSourceEvidenceScientificInputReference(bytes){
  if(!(bytes instanceof Uint8Array)||bytes.byteLength>WIRE_CAP)fail('SOURCE_EVIDENCE_REUSE_WIRE_LIMIT');
  let reference;try{reference=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes));}catch{fail('SOURCE_EVIDENCE_REUSE_JSON_INVALID');}
  boundedJson(reference);if(!referenceShape(reference))fail('SOURCE_EVIDENCE_REUSE_REFERENCE_INVALID');
  const {reference_fingerprint,...content}=reference;if(hash(content)!==reference_fingerprint)fail('SOURCE_EVIDENCE_REUSE_REFERENCE_MISMATCH');
  return frozenCopy(reference);
}

/** Recheck supplied byte identities after asynchronous receipt reads without materializing another full source graph. */
export function verifySourceEvidenceReuseArtifacts({sourceArtifacts,run,dispatchContext,requiredSteps=['scientific_input']}={}){
  const runControlFingerprint=fingerprintSourceEvidenceRunControl({run,dispatchContext});
  const registration=getRunControlForDispatch({dispatchContext,runId:run.run_id}).source_evidence_reuse;
  if(!registration)fail('SOURCE_EVIDENCE_REUSE_REGISTRATION_REQUIRED');
  if(requiredSteps.some(step=>!registration.execution_binding.allowed_steps.includes(step)))fail('SOURCE_EVIDENCE_REUSE_AUTHORIZATION_MISMATCH');
  const descriptors=sourceArtifacts&&Object.getOwnPropertyDescriptors(sourceArtifacts);
  if(!descriptors||Object.getOwnPropertySymbols(sourceArtifacts).length||![Object.prototype,null].includes(Object.getPrototypeOf(sourceArtifacts))
    ||!same(Object.keys(descriptors).sort(),['buildBytes','bundleBytes','resultsBytes','viewBytes'])
    ||Object.values(descriptors).some(d=>!d.enumerable||!Object.hasOwn(d,'value')))fail('SOURCE_EVIDENCE_REUSE_ARTIFACTS_INVALID');
  const negative=registration.negative_parser_binding;
  for(const [key,ref]of [['bundleBytes',registration.bundle_ref],['viewBytes',registration.view_ref],['buildBytes',negative.build_ref],['resultsBytes',negative.results_ref]])suppliedBytes(sourceArtifacts[key],ref.physical_sha256);
  return runControlFingerprint;
}
const sorted=items=>[...items].sort((a,b)=>a.document_id.localeCompare(b.document_id));
function requireNegative({input,bundle,registration,sourceArtifacts}){
  const binding=registration.negative_parser_binding,d=input.parser_evaluation_disposition;
  const records=d?.evidence_records;
  if(d?.comparison_status!=='rejected'||d.requirement_status!=='unmet'||!Array.isArray(records)||records.length!==1
    ||records[0].kind!=='comparison'||records[0].sha256!==binding.summary_ref.physical_sha256)fail('SOURCE_EVIDENCE_REUSE_NEGATIVE_MISMATCH');
  const record=records[0];
  if(typeof record.bytes_base64!=='string'||record.bytes_base64.length>Math.ceil(WIRE_CAP/3)*4)fail('SOURCE_EVIDENCE_REUSE_NEGATIVE_MISMATCH');
  const summaryBytes=Buffer.from(record.bytes_base64,'base64');if(summaryBytes.toString('base64')!==record.bytes_base64)fail('SOURCE_EVIDENCE_REUSE_NEGATIVE_MISMATCH');
  const summary=suppliedJson(summaryBytes,binding.summary_ref.physical_sha256);
  const build=suppliedJson(sourceArtifacts.buildBytes,binding.build_ref.physical_sha256),results=suppliedJson(sourceArtifacts.resultsBytes,binding.results_ref.physical_sha256);
  if([summary,results].some(r=>r.status!=='rejected'||r.comparison_identity!==binding.comparison_identity||r.full_result_fingerprint!==binding.full_result_fingerprint)
    ||build.input?.sha256!==binding.input.physical_sha256||build.input?.logical_fingerprint!==binding.input.logical_fingerprint
    ||['baseline_identity','candidate_identity','reference_fingerprint'].some(key=>build[key]!==binding[key])
    ||binding.source_scope_fingerprint!==registration.source_scope_fingerprint||d.source_scope_fingerprint!==binding.source_scope_fingerprint
    ||!same(sorted(binding.source_document_map),sorted(bundle.sources))||!same(sorted(binding.required_coverage),sorted(bundle.required_coverage)))fail('SOURCE_EVIDENCE_REUSE_NEGATIVE_MISMATCH');
}

/** Supplied bytes only. Replays original sources and restores the existing SCI, never a new scientific standard. */
export function resolveSourceEvidenceScientificInputReference({scientificInputReference,sourceArtifacts,run,dispatchContext}={}){
  const runControlFingerprint=verifySourceEvidenceReuseArtifacts({sourceArtifacts,run,dispatchContext});
  const registration=getRunControlForDispatch({dispatchContext,runId:run.run_id}).source_evidence_reuse;
  if(!registration)fail('SOURCE_EVIDENCE_REUSE_REGISTRATION_REQUIRED');
  boundedJson(scientificInputReference);
  if(!referenceShape(scientificInputReference))fail('SOURCE_EVIDENCE_REUSE_REFERENCE_INVALID');
  const {reference_fingerprint,...content}=scientificInputReference;
  if(hash(content)!==reference_fingerprint)fail('SOURCE_EVIDENCE_REUSE_REFERENCE_MISMATCH');
  if(!same(content.bundle_ref,registration.bundle_ref)||!same(content.view_ref,registration.view_ref)
    ||!same(content.scientific_input_fields.identity,registration.identity))fail('SOURCE_EVIDENCE_REUSE_IDENTITY_MISMATCH');
  const unpack=(value,ref)=>{const decoded=decodeWholePaperArtifact(suppliedBytes(value,ref.physical_sha256),{expectedKind:ref.expected_kind});if(decoded.logical_fingerprint!==ref.logical_fingerprint)fail('SOURCE_EVIDENCE_REUSE_LOGICAL_MISMATCH');return decoded.value;};
  const bundle=unpack(sourceArtifacts.bundleBytes,registration.bundle_ref),view=unpack(sourceArtifacts.viewBytes,registration.view_ref);
  const acquisition=registration.acquisition,approval=bundle.provenance.approval_binding;
  if(approval.source_scope_fingerprint!==registration.source_scope_fingerprint||approval.authorization_fingerprint!==acquisition.authorization_fingerprint
    ||approval.policy_fingerprint!==acquisition.policy_fingerprint||bundle.provenance.tool_binding.fingerprint!==acquisition.tool_fingerprint)fail('SOURCE_EVIDENCE_REUSE_ACQUISITION_MISMATCH');
  const input=Object.freeze({...frozenCopy(content.scientific_input_fields),source_evidence_bundle:bundle});
  const accounting=inspectSourceEvidenceReuseResources(input);
  requireNegative({input,bundle,registration,sourceArtifacts});
  const paired=validateSourceEvidenceVisibleView({bundle,view});if(!paired.ok)fail('SOURCE_EVIDENCE_REUSE_VIEW_MISMATCH',{errors:paired.errors});
  const checked=validateScientificInput(input);if(!checked.ok)fail('PRE_RENDER_SCIENTIFIC_INPUT_INVALID',{errors:checked.errors});
  return Object.freeze({scientificInput:input,reference:frozenCopy(scientificInputReference),view,accounting,runControlFingerprint});
}
