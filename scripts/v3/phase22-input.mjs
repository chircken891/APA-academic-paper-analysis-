import { createHash } from 'node:crypto';
import { readFileSync, lstatSync, realpathSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { fingerprintV3Json as hash, validateV3Package } from './semantic-package-validator.mjs';
import { validateScientificInput } from './scientific-input-validator.mjs';
import { validateScientificPackage, validateScientificContent } from './scientific-quality-validator.mjs';
import { getRunControlForDispatch, readOwnedArtifact } from './owned-artifact-store.mjs';
import { validateProofChain } from './proof-chain-validator.mjs';
import { validatePreRenderHandoff, validateSourceEvidencePreRenderHandoff, validatePhase22Handoff } from './workflow-composer.mjs';
import { compareParserRuns } from './parser-comparison.mjs';
import { decodeWholePaperArtifact } from './whole-paper-storage.mjs';
import { readSourceEvidenceScientificInputReference, resolveSourceEvidenceScientificInputReference, fingerprintSourceEvidenceRunControl } from './source-evidence-reuse.mjs';
import { evaluateScientificEvidenceQualification } from './whole-paper-scientific-validator.mjs';

const profiles = new Map([
  ['phase21-pre-render-handoff-1.0', 'phase21-scientific-input-1.0'],
  ['phase21-pre-render-handoff-workbook-1.0', 'phase21-scientific-input-workbook-1.0'],
  ['phase21-pre-render-handoff-whole-paper-1.0', 'phase21-scientific-input-whole-paper-1.0'],
  ['phase21-pre-render-handoff-source-evidence-1.0', 'phase21-scientific-input-source-evidence-1.0'],
  ['phase21-phase22-handoff-1.0', 'complete'],
]);
const roles = ['evidence', 'methods', 'results', 'interpretation', 'scientific-reading', 'integration'];
const controlKeys = ['source','parser_tool','permission','parent_revision','policy','authorization'];
const receiptKeys = ['artifact_id','run_id','owner_actor_id','role','path','revision','sha256','byte_length'];
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const fail = (code, path = '/', details = {}) => { throw Object.assign(new Error(code), { code, path, details }); };
const bases = new WeakMap(), basisControls = new WeakMap();
export function freezePhase22Value(value, seen = new WeakSet()) {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value)) freezePhase22Value(child, seen);
    Object.freeze(value);
  }
  return value;
}
/** A runtime read capability; deserialized JSON alone cannot recreate admission. */
export function getReadingBasisContent(basis) {
  const value = bases.get(basis);
  if (!value) fail('P22_BASIS_NOT_ADMITTED');
  return value;
}

/** Physical source descriptors come only from the original observed admission reads. */
export function getReadingBasisSourceBindings(basis) {
  assertReadingBasisCurrent(basis);
  const binding = basisControls.get(basis);
  return Object.freeze(binding.receipts.map(receipt => Object.freeze({
    artifact_id: receipt.artifact_id, path: resolve(binding.root, receipt.path), sha256: receipt.sha256,
  })));
}

/** Re-observe the original controlled receipts and bytes without copying or decoding a large SCI again. */
export function assertReadingBasisCurrent(basis,{artifactRoot}={}) {
  const binding=basisControls.get(basis);
  if(!binding)fail('P22_BASIS_NOT_ADMITTED');
  try{
    requireControl(binding.control,binding.validator);
    const presentation=presentationBinding(binding.control);
    if((presentation?hash(presentation):null)!==binding.presentation_fingerprint)fail('P22_PRESENTATION_INVALIDATED');
    if(realpathSync(binding.control.artifactRoot)!==binding.root || artifactRoot&&realpathSync(artifactRoot)!==binding.root
      ||fingerprintSourceEvidenceRunControl({run:binding.control.run,dispatchContext:binding.control.dispatchContext})!==binding.control_fingerprint)fail('P22_BASIS_CONTROL_INVALIDATED');
    for(const expected of binding.receipts){
      const receipt=JSON.parse(readFileSync(resolve(binding.root,'.phase21-receipts',encodeURIComponent(expected.artifact_id)+'.json'),'utf8'));
      if(!same(receipt,expected)||!same(binding.control.registry[expected.artifact_id],expected))fail('P22_BASIS_RECEIPT_INVALIDATED','/registry/'+expected.artifact_id);
      const target=resolve(binding.root,expected.path),rel=relative(binding.root,target),stat=lstatSync(target);
      if(!rel||rel==='..'||rel.startsWith('..'+sep)||!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||realpathSync(target)!==target)fail('P22_BASIS_PATH_INVALIDATED');
      if(stat.size!==expected.byte_length)fail('P22_BASIS_BYTES_INVALIDATED','/artifacts/'+expected.artifact_id);
      const fd=openSync(target,'r');
      try{
        const before=fstatSync(fd,{bigint:true}),digest=createHash('sha256'),buffer=Buffer.allocUnsafe(Math.min(1024*1024,Math.max(1,expected.byte_length)));let size=0,count;
        while((count=readSync(fd,buffer,0,buffer.length,null))>0){digest.update(buffer.subarray(0,count));size+=count;}
        const after=fstatSync(fd,{bigint:true});
        if('sha256:'+digest.digest('hex')!==expected.sha256||size!==expected.byte_length||before.ino!==after.ino||before.dev!==after.dev
          ||before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs||realpathSync(target)!==target)fail('P22_BASIS_BYTES_INVALIDATED','/artifacts/'+expected.artifact_id);
      }finally{closeSync(fd);}
    }
    return true;
  }catch(error){
    if(error.code?.startsWith('P22_'))throw error;
    fail('P22_BASIS_READ_FAILED','/currentDependencies',{message:error.message});
  }
}


const presentationBinding = control => {
  const c=control.presentationControl;
  if(!c)return null;
  const binding=getRunControlForDispatch({dispatchContext:c.dispatchContext,runId:c.runId})?.phase22_source_presentation_binding;
  if(!binding||c.runId!==control.run.run_id||c.artifactId!==binding.manifest_artifact_id)fail('P22_PRESENTATION_CONTROL_REQUIRED');
  return binding;
};
const exactKeys=(value,keys,code)=>{
  if(!value||!same(Object.keys(value).sort(),[...keys].sort()))fail(code);
};
function sourceEvidenceFor(boundary,blocks,ids,blockIds) {
  if(!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length)fail('P22_PRESENTATION_SOURCE_BINDING_INVALID');
  const locations=blockIds.map(id=>blocks.get(id)).filter(Boolean);
  if(locations.length!==blockIds.length||!locations.length)fail('P22_PRESENTATION_SOURCE_BINDING_INVALID');
  for(const id of ids){
    const e=boundary.core.evidence.find(x=>x.evidence_id===id);
    if(!e||!locations.some(block=>same(e.locator,block.native_locator??{source_document_id:block.source_document_id,source_hash:block.source_hash,page_index:block.page_index,block_id:block.block_id})
      ||!block.native_locator&&same(e.locator,{kind:'pdf',source_document_id:block.source_document_id,source_hash:block.source_hash,page_index:block.page_index,block_id:block.block_id})))fail('P22_PRESENTATION_SOURCE_BINDING_INVALID');
  }
  return locations;
}
async function consumeSourcePresentation({control,read,sci,boundary,inputHash}) {
  const binding=presentationBinding(control);if(!binding)return {presentation:null,binding_fingerprint:null};
  const observed=await read(binding.manifest_artifact_id),receipt=observed.receipt;
  if(receipt.role!=='integration'||receipt.owner_actor_id!==binding.owner_actor_id||receipt.revision!==binding.revision||receipt.sha256!==binding.manifest_sha256
    ||binding.scientific_input_fingerprint!==inputHash)fail('P22_PRESENTATION_RECEIPT_INVALID');
  const manifest=readJson(observed.bytes);
  exactKeys(manifest,['schema_version','identity','scientific_input_fingerprint','assets','immutable_ranges'],'P22_PRESENTATION_MANIFEST_INVALID');
  if(manifest.schema_version!=='phase22-source-presentation-1.0'||!same(manifest.identity,sci.identity)||manifest.scientific_input_fingerprint!==inputHash
    ||!Array.isArray(manifest.assets)||!Array.isArray(manifest.immutable_ranges)||!Array.isArray(binding.asset_bindings))fail('P22_PRESENTATION_MANIFEST_INVALID');
  const blocks=new Map(sci.scientific_details.source_blocks.map(x=>[x.source_block_id,x])),assetIds=new Set(),artifactIds=new Set(),classIds=new Set();
  const assets=[];
  for(const asset of manifest.assets){
    exactKeys(asset,['asset_id','artifact_id','media_type','source_document_id','source_hash','source_block_ids','evidence_ids','qualification_reason','origin','byte_sha256','byte_length'],'P22_SOURCE_ASSET_INVALID');
    if(typeof asset.asset_id!=='string'||!asset.asset_id.trim()||assetIds.has(asset.asset_id)||artifactIds.has(asset.artifact_id)||asset.origin!=='registered_source_asset'
      ||typeof asset.qualification_reason!=='string'||!asset.qualification_reason.trim()||!Array.isArray(asset.source_block_ids)||new Set(asset.source_block_ids).size!==asset.source_block_ids.length)fail('P22_SOURCE_ASSET_INVALID');
    assetIds.add(asset.asset_id);artifactIds.add(asset.artifact_id);
    const bound=binding.asset_bindings.find(x=>x.artifact_id===asset.artifact_id),actual=await read(asset.artifact_id);
    if(!bound||actual.receipt.role!=='source-asset'||['artifact_id','owner_actor_id','role','path','revision','sha256','byte_length'].some(k=>actual.receipt[k]!==bound[k])
      ||actual.receipt.sha256!==asset.byte_sha256||actual.receipt.byte_length!==asset.byte_length)fail('P22_SOURCE_ASSET_RECEIPT_INVALID');
    const locations=sourceEvidenceFor(boundary,blocks,asset.evidence_ids,asset.source_block_ids);
    if(locations.some(b=>b.source_document_id!==asset.source_document_id||b.source_hash!==asset.source_hash))fail('P22_PRESENTATION_SOURCE_BINDING_INVALID');
    const ext=({'image/png':'png','image/jpeg':'jpg','image/webp':'webp'})[asset.media_type],bytes=actual.bytes;
    const magic=asset.media_type==='image/png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      :asset.media_type==='image/jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255
      :asset.media_type==='image/webp'?bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP':false;
    if(!ext||!magic)fail('P22_SOURCE_ASSET_MEDIA_INVALID');
    assets.push({...asset,target_path:'Figures/apa-v3/phase22/'+sci.identity.paper_id+'/asset-'+hash({asset_id:asset.asset_id}).slice(7,39)+'.'+ext,
      source_order:Math.min(...locations.map(b=>sci.scientific_details.source_blocks.indexOf(b))),content_role_evidence:false});
  }
  if(binding.asset_bindings.length!==artifactIds.size||binding.asset_bindings.some(x=>!artifactIds.has(x.artifact_id)))fail('P22_SOURCE_ASSET_REGISTRY_MISMATCH');
  const immutable_ranges=manifest.immutable_ranges.map(entry=>{
    exactKeys(entry,['classification_id','kind','source_block_id','start','end','text_sha256','evidence_ids','qualification_reason'],'P22_IMMUTABLE_CLASSIFICATION_INVALID');
    const block=blocks.get(entry.source_block_id);
    if(!block||!['formula','code'].includes(entry.kind)||typeof entry.classification_id!=='string'||!entry.classification_id.trim()||classIds.has(entry.classification_id)
      ||!Number.isInteger(entry.start)||!Number.isInteger(entry.end)||entry.start<0||entry.end<=entry.start||entry.end>block.text.length
      ||typeof entry.qualification_reason!=='string'||!entry.qualification_reason.trim())fail('P22_IMMUTABLE_CLASSIFICATION_INVALID');
    classIds.add(entry.classification_id);sourceEvidenceFor(boundary,blocks,entry.evidence_ids,[entry.source_block_id]);
    const text=block.text.slice(entry.start,entry.end),bytes=Buffer.from(text,'utf8');
    if(bytes.toString('utf8')!==text||sha(bytes)!==entry.text_sha256)fail('P22_IMMUTABLE_SOURCE_BYTES_MISMATCH');
    return {...entry,source_document_id:block.source_document_id,source_hash:block.source_hash,source_order:sci.scientific_details.source_blocks.indexOf(block)};
  });
  return {presentation:{...manifest,manifest_ref:ref(observed,manifest,'json'),assets,immutable_ranges},binding_fingerprint:hash(binding)};
}
/** Source-owned media only. A fresh buffer is returned; no path supplied by the caller is opened. */
export function readPhase22SourceAsset(basis,assetId) {
  assertReadingBasisCurrent(basis);
  const asset=basis.source_presentation?.assets.find(x=>x.asset_id===assetId);
  if(!asset)fail('P22_SOURCE_ASSET_NOT_REGISTERED');
  const binding=basisControls.get(basis),receipt=binding.receipts.find(x=>x.artifact_id===asset.artifact_id);
  const source_path=resolve(binding.root,receipt.path),bytes=readFileSync(source_path);
  if(sha(bytes)!==asset.byte_sha256||bytes.length!==asset.byte_length)fail('P22_SOURCE_ASSET_BYTES_INVALIDATED');
  return Object.freeze({...asset,bytes,source_path,source_ref:Object.freeze({scientific_input_ref:basis.scientific_input_ref,source_document_id:asset.source_document_id,
    source_hash:asset.source_hash,source_block_ids:asset.source_block_ids,evidence_ids:asset.evidence_ids,
    locators:basis.typed_source_locations.filter(x=>asset.source_block_ids.includes(x.source_block_id))})});
}
export function resolvePhase22ImmutableRange(basis,classificationId) {
  assertReadingBasisCurrent(basis);
  const entry=basis.source_presentation?.immutable_ranges.find(x=>x.classification_id===classificationId);
  if(!entry)fail('P22_IMMUTABLE_CLASSIFICATION_REQUIRED');
  const block=getReadingBasisContent(basis).scientific_details.source_blocks.find(x=>x.source_block_id===entry.source_block_id);
  const text=block.text.slice(entry.start,entry.end);
  if(sha(Buffer.from(text,'utf8'))!==entry.text_sha256)fail('P22_IMMUTABLE_SOURCE_BYTES_MISMATCH');
  return Object.freeze({...entry,text});
}

function readJson(bytes) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('P22_ARTIFACT_JSON_INVALID'); }
}
function decode(bytes, kind) {
  const wire = readJson(bytes);
  return Object.hasOwn(wire, 'storage_contract')
    ? { value: decodeWholePaperArtifact(bytes, { expectedKind: kind }).value, codec: wire.storage_contract }
    : { value: wire, codec: 'json' };
}
async function controlledRead(id, control, resolver) {
  const expected = control.registry?.[id];
  if (!expected || expected.artifact_id !== id) fail('P22_ARTIFACT_UNREGISTERED', '/registry', { artifact_id: id });
  const root = await realpath(control.artifactRoot);
  const target = resolve(root, expected.path);
  const rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || resolve(root, rel) !== target) fail('P22_ARTIFACT_PATH_INVALID');
  const stat = await lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || await realpath(target) !== target) fail('P22_ARTIFACT_TYPE_INVALID');
  const observed = await readOwnedArtifact({ artifactRoot: root, artifactId: id });
  if (!observed || receiptKeys.some(k => observed.receipt[k] !== expected[k]) || expected.run_id !== control.run.run_id) {
    fail('P22_RECEIPT_BINDING_MISMATCH', '/registry/' + id);
  }
  const resolved = await resolver(id);
  if (!resolved || !same(resolved.receipt, observed.receipt) || sha(resolved.bytes) !== observed.receipt.sha256) fail('P22_RESOLVER_BINDING_MISMATCH');
  return observed;
}
function requireControl(control, validator) {
  const { run, dispatchContext, proofChain } = control ?? {};
  const actual = getRunControlForDispatch({ dispatchContext, runId: run?.run_id });
  if (!actual || run.chain !== proofChain || run.run_id !== proofChain.run_id) fail('P22_CURRENT_CONTROL_REQUIRED');
  if (controlKeys.some(k => !actual.approved_fingerprints?.[k] || actual.approved_fingerprints[k] !== run.current_fingerprints?.[k]
    || actual.approved_fingerprints[k] !== run.declared_fingerprints?.[k])) fail('P22_CONTROL_DEPENDENCY_INVALIDATED');
  if (proofChain.dependencies.some(d => d.status !== 'current' || controlKeys.some(k => d.fingerprints[k] !== run.current_fingerprints[k]))) fail('P22_CONTROL_DEPENDENCY_INVALIDATED');
  const proof = validateProofChain({ chain: proofChain, dispatchContext, phase21Validator: validator });
  if (!proof.ok || proofChain.delivery_status !== 'deliverable' || proofChain.critical_defects.some(d => ['critical','major'].includes(d.severity) && d.status !== 'resolved')) {
    fail('P22_PROOF_CHAIN_NOT_DELIVERABLE', '/proofChain', { errors: proof.errors });
  }
  return actual;
}
function ref(observed, value, codec, json_pointer = '') {
  return { artifact_id: observed.receipt.artifact_id, physical_sha256: observed.receipt.sha256, logical_sha256: hash(value), codec, json_pointer };
}
function roleMappings(contents, manifest, errors, revisions) {
  const valid = new Set(manifest.map(unit => unit.semantic_unit_id));
  const maps = contents.integration.p22_role_unit_map ?? [];
  const output = [], used = new Set();
  for (const role of roles) {
    const findings = contents[role].content?.findings ?? contents[role].findings ?? [];
    if (!Array.isArray(findings)) fail('P22_ROLE_FINDINGS_INVALID', '/roles/' + role + '/findings');
    findings.forEach((finding, i) => {
      const id = typeof finding === 'object' ? finding.finding_id ?? finding.id : undefined;
      const pointer = '/roles/' + role + (contents[role].content ? '/content' : '') + '/findings/' + i;
      const entry = maps.find(m => m.role === role && m.finding_id === id);
      const key = role + ':' + id;
      if (!id || used.has(key) || !entry || !Array.isArray(entry.semantic_unit_ids)
        || entry.semantic_unit_ids.some(x => !valid.has(x)) || typeof entry.reason !== 'string' || !entry.reason.trim()
        || !['mapped','non_semantic'].includes(entry.disposition)
        || entry.disposition === 'mapped' && entry.semantic_unit_ids.length === 0
        || entry.disposition === 'non_semantic' && entry.semantic_unit_ids.length !== 0) {
        const issue = { code: 'P22_SCIENTIFIC_BASIS_INCOMPLETE', path: pointer, details: { role, finding_id: id ?? 'missing-id' } };
        errors.push(issue);
        revisions.push({ ...issue, owner: 'Integrator', action: 'Map the owned finding to existing scientific units, or give an owned non_semantic reason.' });
      } else {
        used.add(key);
        output.push({ role, finding_id: id, semantic_unit_ids: entry.semantic_unit_ids, disposition: entry.disposition, reason: entry.reason, json_pointer: pointer });
      }
    });
  }
  if (maps.some(m => !used.has(m.role + ':' + m.finding_id))) {
    errors.push({ code:'P22_ROLE_MAPPING_ORPHAN', path:'/roles/integration/p22_role_unit_map' });
  }
  return output;
}

/** Read-only consumer. Never rebuilds/re-signs an old handoff and never invokes a content model. */
export async function consumePhase21Handoff({ handoff, artifactResolver, currentControl, phase21Validator, phase22Validator } = {}) {
  const errors = [], revision_requests = [];
  const rejected = () => ({ ok: false, errors, revision_requests });
  try {
    const profile = profiles.get(handoff?.schema_version);
    if (!profile) fail('P22_INPUT_PROFILE_UNSUPPORTED', '/schema_version');
    if (typeof artifactResolver !== 'function' || !phase22Validator || !phase21Validator) fail('P22_CONTROL_INTERFACES_REQUIRED');
    requireControl(currentControl, phase21Validator);
    const control = currentControl, observedReads = new Map();
    const read = async id => {
      const observed = await controlledRead(id, control, artifactResolver);
      if (observedReads.has(id) && !same(observedReads.get(id), observed.receipt)) fail('P22_RECEIPT_CHANGED_DURING_READ');
      observedReads.set(id, observed.receipt);
      return observed;
    };
    const producer = await read(control.producer_artifact_id);
    if (!same(readJson(producer.bytes), handoff)) fail('P22_PRODUCER_BYTES_MISMATCH');
    if (producer.receipt.role !== 'control') fail('P22_PRODUCER_OWNER_INVALID');
    let candidate = handoff, candidateRead = producer;
    if (profile === 'complete') {
      const stored = await read(control.complete_candidate_artifact_id);
      candidate = readJson(stored.bytes); candidateRead = stored;
      if (stored.receipt.role !== 'control' || candidate.schema_version !== 'phase21-complete-candidate-1.0' || candidate.status !== 'local_contract_complete') fail('P22_COMPLETE_CANDIDATE_REQUIRED');
    }
    const storedInput = await read(control.scientific_input_artifact_id);
    if (storedInput.receipt.role !== 'control') fail('P22_SCI_OWNER_INVALID');
    const wire = readJson(storedInput.bytes);
    let sci, codec = 'json';
    if (wire.schema_version === 'phase21-source-evidence-scientific-input-ref-1.0') {
      if (profile !== 'phase21-scientific-input-source-evidence-1.0') fail('P22_SCI_PROFILE_MISMATCH');
      const reference = readSourceEvidenceScientificInputReference(storedInput.bytes), sourceArtifacts = {};
      for (const name of ['bundleBytes','viewBytes','buildBytes','resultsBytes']) {
        sourceArtifacts[name] = (await read(control.source_evidence_artifact_ids?.[name])).bytes;
      }
      sci = resolveSourceEvidenceScientificInputReference({ scientificInputReference: reference, sourceArtifacts, run: control.run, dispatchContext: control.dispatchContext }).scientificInput;
      codec = wire.schema_version;
    } else {
      ({ value: sci, codec } = decode(storedInput.bytes, profile === 'phase21-scientific-input-source-evidence-1.0' ? 'source_evidence_scientific_input' : 'scientific_input'));
    }
    const boundary = profile === 'complete' ? sci.boundary_package : sci;
    // Missing critical sources are checked against actual evidence references, never a blanket partial ban.
    const absentCritical = new Set((boundary?.source_package?.attachments ?? []).filter(x => x.critical
      && !(boundary.source_package.source_documents ?? []).some(d => d.source_document_id === x.source_document_id && d.included && d.support_status === 'supported')).map(x => x.source_document_id));
    for (const unit of boundary?.core?.units ?? []) {
      const cited = (unit.evidence_ids ?? []).map(id => boundary.core.evidence.find(e => e.evidence_id === id)).filter(Boolean);
      if (cited.some(e => absentCritical.has(e.locator?.source_document_id))) fail('P22_CRITICAL_SOURCE_GAP', '/core/units', { unit_id: unit.unit_id });
    }
    const checked = profile === 'complete' ? validateScientificPackage(sci) : validateScientificInput(sci);
    if (!checked.ok) {
      const declared = new Set((sci.scientific_details?.required_semantic_units ?? []).map(x => x.semantic_unit_id));
      const missing_semantic_ids = ['records','claims','quantities','statements','explanations','research_candidates'].flatMap(collection =>
        (sci.scientific_details?.[collection] ?? []).map((row,index) => ({ id: row.semantic_unit_id ?? row.claim_id ?? row.quantity_id ?? row.statement_id ?? row.explanation_id ?? row.candidate_id,
          path:'/scientific_details/' + collection + '/' + index })).filter(x => x.id && !declared.has(x.id)));
      fail('P22_SCIENTIFIC_BASIS_INCOMPLETE', '/scientific_details', { errors: checked.errors, missing_semantic_ids });
    }
    if (profile === 'complete' && !validateV3Package(boundary).ok || profile !== 'complete' && sci.schema_version !== profile) fail('P22_SCI_PROFILE_MISMATCH');
    const identity = sci.identity;
    if (identity.run_id !== control.run.run_id || profile !== 'complete' && !same(handoff.identity, identity)) fail('P22_IDENTITY_MISMATCH');
    const locationContract = handoff.location_contract;
    const manifest = validateScientificContent(sci.scientific_details, boundary, (code, path) => errors.push({ code, path }), locationContract);
    if (errors.length) return rejected();
    const inputHash = profile === 'complete' ? sci.bindings.scientific_input_fingerprint : sci.input_fingerprint;
    const manifestHash = hash(manifest);
    const presentationRead=await consumeSourcePresentation({control,read,sci,boundary,inputHash});
    const sourcePresentation=presentationRead.presentation;
    const contents = {}, receipts = {};
    for (const artifact of control.proofChain.artifacts) {
      const observed = await read(artifact.artifact_id), receipt = observed.receipt;
      const expected = control.run.receipts.find(r => r.artifact_id === artifact.artifact_id);
      if (!expected || receiptKeys.some(k => receipt[k] !== expected[k])
        || ['sha256','revision','owner_actor_id','path'].some(k => receipt[k] !== artifact[k])
        || receipt.sha256 !== artifact.receipt_sha256) fail('P22_RECEIPT_CHAIN_MISMATCH', '/proofChain/artifacts');
      receipts[artifact.artifact_id] = observed;
    }
    const inputField = profile === 'complete' ? 'complete_scientific_input_fingerprint' : 'scientific_input_fingerprint';
    for (const role of roles) {
      const binding = candidate.role_artifacts?.[role], observed = receipts[binding?.artifact_id];
      if (!observed || observed.receipt.role !== role || binding.sha256 !== observed.receipt.sha256 || binding.revision !== observed.receipt.revision) fail('P22_ROLE_RECEIPT_MISMATCH', '/role_artifacts/' + role);
      const content = decode(observed.bytes, 'integration_role').value;
      if (content[inputField] !== inputHash || content.source_check_fingerprint !== candidate.source_check.fingerprint) fail('P22_ROLE_INPUT_MISMATCH', '/roles/' + role);
      contents[role] = content;
    }
    const byId = new Map(control.proofChain.artifacts.map(a => [a.artifact_id,a]));
    const requires = { interpretation:['methods','results'], 'scientific-reading':['evidence','methods','results','interpretation'], integration:['evidence','methods','results','interpretation','scientific-reading'] };
    for (const [role,parents] of Object.entries(requires)) if (parents.some(parent => !byId.get(candidate.role_artifacts[role].artifact_id)?.depends_on?.includes(candidate.role_artifacts[parent].artifact_id))) fail('P22_ROLE_DEPENDENCY_MISSING','/roles/'+role);
    const sourceRead = receipts['source-check'], source = readJson(sourceRead.bytes);
    if (sourceRead.receipt.role !== 'source-check' || source[inputField] !== inputHash
      || source.fingerprint !== candidate.source_check.fingerprint || sourceRead.receipt.sha256 !== candidate.source_check.artifact_sha256
      || source.initial_pass_status !== 'completed' || source.conclusion_status !== 'pass' || source.received_upstream_analysis !== false) fail('P22_SOURCE_CHECK_INVALID');
    const dependencies = {
      [profile === 'complete' ? 'complete_scientific_input' : 'scientific_input']: inputHash,
      required_semantic_unit_manifest: manifestHash,
      ...(profile === 'complete' ? {} : { run_control: fingerprintSourceEvidenceRunControl({ run: control.run, dispatchContext: control.dispatchContext }) }),
      source_check: source.fingerprint, source_check_receipt: sourceRead.receipt.sha256,
      ...Object.fromEntries(roles.map(role => ['role:' + role, receipts[candidate.role_artifacts[role].artifact_id].receipt.sha256])),
    };
    if (profile === 'phase21-scientific-input-source-evidence-1.0') {
      const qualified = evaluateScientificEvidenceQualification({ scientificInput: sci, sourceCheckContent: source, sourceCheckReceiptSha256: sourceRead.receipt.sha256 });
      if (!qualified.ok || !same(qualified.qualification, candidate.scientific_evidence_qualification)
        || !same(contents.integration.scientific_evidence_qualification, qualified.qualification)) fail('P22_SCIENTIFIC_EVIDENCE_NOT_QUALIFIED');
      dependencies.scientific_evidence_qualification = qualified.qualification_fingerprint;
      for (const role of roles) {
        if (contents[role].scientific_evidence_qualification_fingerprint !== qualified.qualification_fingerprint
          || Object.hasOwn(contents[role], 'parser_comparison_inputs')) fail('P22_SOURCE_EVIDENCE_ROLE_MISMATCH');
      }
      const initial = receipts['source-check-initial'], frozen = receipts['scientific-input-frozen'];
      if (!initial || !frozen || !same(candidate.source_check.initial_source_check_binding, source.initial_source_check_binding)
        || source.initial_source_check_binding.sha256 !== initial.receipt.sha256
        || source.frozen_scientific_input_binding.sha256 !== frozen.receipt.sha256) fail('P22_SOURCE_EVIDENCE_STAGE_MISMATCH');
    } else {
      const integration = contents.integration, inputs = integration.parser_comparison_inputs;
      const compared = compareParserRuns(inputs);
      if (compared.status !== 'compared' || !same(compared, integration.parser_comparison_result)
        || compared.scientific_eligible === false || compared.reference_kind === 'accepted_assisted_source_representation') fail('P22_PARSER_COMPARISON_NOT_ACCEPTED');
      const native = profile === 'phase21-scientific-input-workbook-1.0', whole = profile === 'phase21-scientific-input-whole-paper-1.0';
      const sourceMap = boundary.source_package.source_documents.map(d => ({ document_id:d.source_document_id,role:d.role === 'main' ? 'main' : 'attachment',
        critical:boundary.source_package.attachments.some(a=>a.source_document_id===d.source_document_id && a.critical === true),
        availability:d.included && d.support_status === 'supported' ? 'available' : 'missing',source_sha256:d.source_hash,
        ...(whole ? {kind:d.kind,purpose:d.purpose,...Object.fromEntries(['format','container','member_path'].filter(k=>Object.hasOwn(d,k)).map(k=>[k,d[k]]))}
          : native ? {kind:d.kind,...(d.kind === 'workbook' ? {format:d.format,container:d.container,member_path:d.member_path} : {})} : {})
      })).sort((a,b)=>a.document_id.localeCompare(b.document_id));
      const sortedSources = run => [...(run?.sources ?? [])].sort((a,b)=>a.document_id.localeCompare(b.document_id));
      if (!same(sortedSources(inputs.baselineRun),sourceMap) || !same(sortedSources(inputs.candidateRun),sourceMap)
        || compared.source_document_map && !same(compared.source_document_map,sourceMap)) fail('P22_PARSER_SOURCE_MISMATCH');
      dependencies.parser_comparison = hash(compared);
      for (const role of roles) if (contents[role].parser_comparison_result_fingerprint !== dependencies.parser_comparison) fail('P22_ROLE_COMPARISON_MISMATCH');
      if (candidate.parser_comparison.result !== dependencies.parser_comparison) fail('P22_PARSER_COMPARISON_NOT_ACCEPTED');
      if (sci.source_run && hash(sci.source_run) !== compared.candidate_run_fingerprint
        || sci.native_source_run && hash(sci.native_source_run) !== compared.candidate_run_fingerprint) fail('P22_PARSER_SCI_MISMATCH');
    }
    const validate = profile === 'complete' ? validatePhase22Handoff
      : profile === 'phase21-scientific-input-source-evidence-1.0' ? validateSourceEvidencePreRenderHandoff : validatePreRenderHandoff;
    const checkedHandoff = validate({ handoff, currentDependencies: dependencies });
    if (!checkedHandoff.ok) fail(checkedHandoff.reason, '/invalidation_dependencies', { stale: checkedHandoff.stale_dependencies ?? [] });
    if (profile === 'complete' && (!same(candidate.phase22_dependencies, dependencies)
      || handoff.complete_scientific_input_fingerprint !== inputHash
      || handoff.required_semantic_unit_manifest_fingerprint !== manifestHash
      || handoff.accepted_core_fingerprint !== dependencies['role:integration']
      || handoff.accepted_scientific_card_fingerprint !== dependencies['role:scientific-reading'])) fail('P22_COMPLETE_TOKEN_MISMATCH');
    const role_unit_map = roleMappings(contents, manifest, errors, revision_requests);
    // A critical unavailable attachment cannot support an affirmative core claim.
    const missing = new Set(boundary.source_package.attachments.filter(x => x.critical
      && !boundary.source_package.source_documents.some(d => d.source_document_id === x.source_document_id && d.included && d.support_status === 'supported')).map(x => x.source_document_id));
    for (const unit of boundary.core.units) {
      const cited = (unit.evidence_ids ?? unit.evidence_refs ?? []).map(id => boundary.core.evidence.find(e => e.evidence_id === id)).filter(Boolean);
      if (cited.some(e => missing.has(e.source_document_id ?? e.locator?.source_document_id))) fail('P22_CRITICAL_SOURCE_GAP', '/core/units', { unit_id: unit.unit_id });
    }
    if (errors.length) return rejected();
    const sciRef = ref(storedInput, sci, codec), prefix = profile === 'complete' ? '/boundary_package' : '';
    const producerRef = { ...ref(producer, handoff, 'json'), schema_version: handoff.schema_version };
    const content = {
      schema_version: 'phase22/reading-basis-1.0', identity, producer_ref: producerRef,
      scientific_input_ref: { ...sciRef, schema_version: sci.schema_version ?? sci.contract_version },
      core_ref: { ...sciRef, json_pointer: prefix + '/core' }, reading_card_ref: { ...sciRef, json_pointer: prefix + '/reading_card' },
      scientific_details_ref: { ...sciRef, json_pointer: '/scientific_details' },
      required_semantic_units: manifest, role_unit_map,
      typed_source_locations: sci.scientific_details.source_blocks.map(block => ({ source_block_id: block.source_block_id,
        locator: block.native_locator ?? { source_document_id: block.source_document_id, source_hash: block.source_hash, page_index: block.page_index, block_id: block.block_id } })),
      scientific_completeness: sci.scientific_details.source_status.completeness, source_status: sci.scientific_details.source_status,
      important_disagreements: candidate.important_disagreements,
      parser_evaluation_disposition: { requirement_satisfied: profile !== 'phase21-scientific-input-source-evidence-1.0',
        comparison_status: sci.parser_evaluation_disposition?.comparison_status ?? 'compared',
        details_ref: { ...ref(candidateRead, candidate, 'json'), json_pointer: profile === 'phase21-scientific-input-source-evidence-1.0' ? '/parser_evaluation_disposition' : '/parser_comparison' } },
      provenance_limits: { host_independence: candidate.host_independence, actual_observable_identity: 'unknown',
        p20_e12_disposition: 'unverified', delivery_evidence: candidate.delivery_evidence },
      invalidation_dependencies: { ...dependencies, producer_bytes: producer.receipt.sha256, scientific_input_bytes: storedInput.receipt.sha256, complete_candidate_bytes: candidateRead.receipt.sha256 },
      publishable: false,
      ...(sourcePresentation?{source_presentation:sourcePresentation}:{}),
    };
    if(sourcePresentation)content.invalidation_dependencies.source_presentation=hash(sourcePresentation);
    delete content.parser_evaluation_disposition.details_ref.schema_version;
    const basis = { ...content, basis_fingerprint: hash(content) };
    const shape = phase22Validator.validate('phase22/reading-basis-1.0', basis);
    if (!shape.ok) fail('P22_BASIS_SCHEMA_INVALID', '/', { errors: shape.errors });
    requireControl(control, phase21Validator);
    // Re-observe every registered dependency after asynchronous reads before exposing a capability.
    for (const id of [...observedReads.keys()]) await read(id);
    const observedRoot=await realpath(control.artifactRoot),currentPresentation=presentationBinding(control);
    if((currentPresentation?hash(currentPresentation):null)!==presentationRead.binding_fingerprint)fail('P22_PRESENTATION_INVALIDATED');
    freezePhase22Value(sci); freezePhase22Value(basis);
    bases.set(basis, Object.freeze({ core: boundary.core, reading_card: boundary.reading_card, scientific_details: sci.scientific_details,
      source_package: boundary.source_package, role_contents: freezePhase22Value(contents) }));
    basisControls.set(basis,{control,validator:phase21Validator,root:observedRoot,receipts:[...observedReads.values()],control_fingerprint:fingerprintSourceEvidenceRunControl({run:control.run,dispatchContext:control.dispatchContext}),presentation_fingerprint:presentationRead.binding_fingerprint});
    return { ok: true, basis, errors: [], revision_requests: [] };
  } catch (error) {
    const issue = { code: error.code ?? 'P22_INPUT_INVALID', path: error.path ?? '/', details: error.details ?? { message: error.message } };
    errors.push(issue);
    if (issue.code === 'P22_SCIENTIFIC_BASIS_INCOMPLETE') revision_requests.push({ ...issue, owner: 'Integrator', action: 'Revise the named scientific input locations; Writers cannot supply missing facts.' });
    return rejected();
  }
}

