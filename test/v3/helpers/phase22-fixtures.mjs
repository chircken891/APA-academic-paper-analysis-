import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { createOwnedArtifactBroker, readOwnedArtifact } from '../../../scripts/v3/owned-artifact-store.mjs';
import { createPhase21ContractValidator } from '../../../scripts/v3/phase21-contract-loader.mjs';
import { advanceRun } from '../../../scripts/v3/workflow-orchestrator.mjs';
import * as composer from '../../../scripts/v3/workflow-composer.mjs';
import { compareParserRuns } from '../../../scripts/v3/parser-comparison.mjs';
import { canonicalizeV3Json, fingerprintV3Json } from '../../../scripts/v3/semantic-package-validator.mjs';
import { fingerprintScientificInput, validateScientificInput } from '../../../scripts/v3/scientific-input-validator.mjs';
import * as adapter from '../../../scripts/v3/parser-adapter.mjs';
import { translateWorkbookPayload } from '../../../scripts/v3/parser-adapter.mjs';
import { translateWholePaperPayload } from '../../../scripts/v3/whole-paper-adapter.mjs';
import { validateScientificContent } from '../../../scripts/v3/scientific-quality-validator.mjs';
import { encodeWholePaperArtifact } from '../../../scripts/v3/whole-paper-storage.mjs';
import * as api from '../../../scripts/v3/source-evidence-bundle.mjs';
import { buildSourceEvidenceVisibleView } from '../../../scripts/v3/source-evidence-bundle.mjs';
import * as reuse from '../../../scripts/v3/source-evidence-reuse.mjs';
import { evaluateScientificEvidenceQualification } from '../../../scripts/v3/whole-paper-scientific-validator.mjs';

// Small synthetic constructors adapted from the P21 private test fixtures.
// No test module is imported; no real paper, parser, model or network is invoked.
const cases = JSON.parse(await readFile(new URL('../fixtures/phase21/composition-cases.json', import.meta.url), 'utf8'));
const completeScientificInput = JSON.parse(await readFile(new URL('../fixtures/scientific-reading/methods-control.json', import.meta.url), 'utf8'));
const template = completeScientificInput;
const proofSchema = JSON.parse(await readFile(new URL('../../../Schema/phase21/proof-chain.schema.json', import.meta.url), 'utf8'));
const sha = character => `sha256:${character.repeat(64)}`;
const byteSha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const canonicalSha = fingerprintV3Json;
const digest = fingerprintV3Json, hash = fingerprintV3Json, clone = value => structuredClone(value);
const sorted = values => [...values].sort((a, b) => a.document_id.localeCompare(b.document_id));
function scope(args) { args.approvalBinding.source_scope_fingerprint = hash({sources: sorted(args.sources), required_coverage: sorted(args.requiredCoverage)}); }
function needApi() { assert.equal(typeof api.buildSourceEvidenceBundle, 'function'); }
const fingerprints = character => ({ source: sha(character), parser_tool: sha(character), permission: sha(character), parent_revision: sha(character), policy: sha(character), authorization: sha(character) });
const roles = [
  ['evidence', 'evidence-map', 'evidence-map.json'], ['methods', 'methods-design', 'methods-design.json'], ['results', 'results-visuals', 'results-visuals.json'],
  ['interpretation', 'interpretation-appraisal', 'interpretation-appraisal.json'], ['scientific-reading', 'scientific-reading-card', 'scientific-reading-card.json'], ['integration', 'integration', 'integration.json'],
];
function comparisonInputsForCompleteInput(sourcePackage = completeScientificInput.boundary_package.source_package) {
  const sources = sourcePackage.source_documents.map((source, index) => ({
    document_id: source.source_document_id,
    role: index === 0 ? 'main' : 'attachment', critical: true, availability: 'available', source_sha256: source.source_hash,
  }));
  const locator = { document_id: sources[0].document_id, page_number: 1, page_status: 'known', source_block_id: 'b1' };
  const makeRun = (backend, backend_version) => ({
    schema_version: 'phase21-parser-run-1.0', parser_run_id: canonicalSha({ backend, backend_version, sources }), sources,
    backend, backend_version, normalization_version: 'phase21-composition-fixture-1', config_fingerprint: sha('a'), approval_fingerprint: sha('b'), approval_scope: 'synthetic-local-only',
    blocks: [{ id: `${backend}-main`, type: 'paragraph', text: 'Synthetic observed result.', locator, rotation_degrees: 0 }],
    page_coverage: sources.map(source => ({ document_id: source.document_id, known_pages: [1], unknown_item_count: 0 })), assets: [],
    normalization_audit: { mappings: [], raw_page_policy: 'preserve_unknown_before_v2_normalization' }, resource_observations: [{ kind: 'execution_time_ms', status: 'not_invoked' }],
    errors: [], candidate_eligibility: { eligible: true, blockers: [] }, metadata: { requirement_refs: ['APA3-03', 'APA3-04'] },
  });
  const source_document_map = [...sources].sort((left, right) => left.document_id.localeCompare(right.document_id));
  const gold = {
    schema_version: 'phase21-gold-manifest-1.0', gold_manifest_id: sha('c'), input_fingerprint: canonicalSha(source_document_map), source_document_map,
    independence: { authoring_method: 'manual_independent', parser_output_access: 'not_used', author_id: 'offline-fixture-reviewer', approval_id: 'offline-fixture-approval', approval_status: 'approved' },
    scope: 'complete', items: [{ evidence_id: 'fixture-main', document_id: locator.document_id, locator, category: 'text', centrality: 'noncentral', expected_semantic_unit: 'Synthetic observed result.', independent_input_fingerprint: canonicalSha(source_document_map), author_status: 'independently_authored', approval_status: 'approved' }],
    metadata: { requirement_refs: ['APA3-03', 'APA3-04'], evidence_tier: 'offline_fixture' },
  };
  const candidateDescriptor = {
    backend_kind: 'native_model', backend_version: 'fixture-native-1', authority_scope: 'nonlocal',
    egress: { data_transfer_decision: 'approved', scope: 'synthetic-only' }, retention: { disposition: 'no_retention', scope: 'synthetic-only' },
    run_authorization_ref: 'phase21-local-synthetic-fixture', observed_model_identity: { status: 'unknown', value: null, basis: 'not_observed' }, default_change: false,
    source_document_map: sources.map(source => ({ document_id: source.document_id, source_sha256: source.source_sha256 })),
  };
  const inputs = { baselineRun: makeRun('mineru', 'fixture-mineru-1'), candidateRun: makeRun('native-model', 'fixture-native-1'), goldManifest: gold, comparisonPolicy: { policy_version: 'phase21-composition-fixture-1', central_evidence_rule: 'reject', locator_maps: [] }, candidateDescriptor };
  return { inputs, result: compareParserRuns(inputs) };
}


function acceptedReferenceComparison(sourcePackage, change = () => {}) {
  const { inputs } = comparisonInputsForCompleteInput(sourcePackage);
  const original = inputs.goldManifest;
  delete inputs.goldManifest;
  inputs.referenceManifest = {
    schema_version: 'phase21-accepted-reference-1.0', reference_manifest_id: sha('c'),
    input_fingerprint: original.input_fingerprint, source_document_map: original.source_document_map,
    acceptance: { decision_ref: 'D-21-35', corpus_id: 'phase21-twelve-paper', paper_id: '01', record_ref: 'fixture:accepted-review', record_fingerprint: sha('d') },
    method: { preparation: 'assisted', verification: 'assisted', source_access: 'used', parser_output_access: 'unknown', independence: 'nonblind' },
    scope: { status: 'complete', category_dispositions: ['text', 'table', 'formula', 'citation', 'figure', 'attachment', 'locator'].map(category => ({
      category, disposition: category === 'text' ? 'covered' : 'inapplicable', reason: category === 'text' ? 'One registered synthetic text unit.' : 'No separate unit of this category in this synthetic fixture.',
    })), uncovered_items: [] },
    items: original.items.map(({ independent_input_fingerprint, author_status, approval_status, ...item }) => ({
      ...item, source_record_ref: 'fixture:accepted-review/item-1', source_record_revision: 'r1', source_record_fingerprint: sha('e'),
      preparation: 'assisted', verification: 'assisted', source_access: 'used', parser_output_access: 'unknown',
    })),
  };
  change(inputs.referenceManifest);
  inputs.comparisonPolicy.reference_basis = { kind: 'accepted_assisted', ...Object.fromEntries(['decision_ref', 'corpus_id', 'paper_id'].map(key => [key, inputs.referenceManifest.acceptance[key]])), reference_fingerprint: canonicalSha(inputs.referenceManifest) };
  return { inputs, result: compareParserRuns(inputs) };
}


function authorityFingerprints(controlConfig) {
  const authorized_bindings = [...controlConfig.authorized_bindings].sort((left, right) => canonicalizeV3Json(left).localeCompare(canonicalizeV3Json(right)));
  return {
    ...fingerprints('c'),
    permission: canonicalSha({ local_enforcement_scope: 'artifact_root_only', authorized_bindings }),
    authorization: canonicalSha({ control_actor_id: controlConfig.control_actor_id, authorized_bindings,
      run_controls: controlConfig.run_controls.map(({ approved_fingerprints, ...control }) => control) }),
  };
}


async function fixtureRun(t, { comparisonMode = 'actual', roleCompleteInputFingerprint = completeScientificInput.bindings.scientific_input_fingerprint, sourceArtifactOverrides = {}, currentFingerprintOverrides = {}, chainDefects = [], scientificInput, roleOverrides = {}, comparisonSourcePackage, comparisonFactory = comparisonInputsForCompleteInput,integrationStorage='legacy-json',integrationWireMutator, authorityBinding } = {}) {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'apa-phase21-compose-'));
  t.after(() => {const target=resolve(artifactRoot);assert.equal(dirname(target),resolve(tmpdir()));assert.ok(basename(target).startsWith('apa-phase21-compose-'));return rm(target,{recursive:true,force:true});});
  assert.ok(['legacy-json','whole-paper-json'].includes(integrationStorage));let storageAccounting=null;
  const runId = scientificInput?.identity.run_id ?? completeScientificInput.identity.run_id;
  const inputKey = scientificInput ? 'scientific_input_fingerprint' : 'complete_scientific_input_fingerprint';
  const sourceInputFingerprint = scientificInput?.input_fingerprint ?? completeScientificInput.bindings.scientific_input_fingerprint;
  const required = [
    { artifact_id: 'source-check', owner_actor_id: 'reviewer', path: 'roles/source-check.json' },
    ...roles.map(([role, id, path]) => ({ artifact_id: `${id}-r1`, owner_actor_id: `${role}-agent`, path: `roles/${path}` })),
  ];
  const prerequisites = { source_check_artifact_id: 'source-check', analysis_draft_artifact_id: 'evidence-map-r1', integration_artifact_id: 'integration-r1', approval_artifact_id: 'scientific-reading-card-r1' };
  const bindings = [
    { run_id: runId, actor_id: 'reviewer', role: 'source-check', artifact_path: 'roles/source-check.json', revision: 'r1' },
    ...roles.map(([role, , path]) => ({ run_id: runId, actor_id: `${role}-agent`, role, artifact_path: `roles/${path}`, revision: 'r1' })),
  ];
  const controlConfig = { control_actor_id: 'control-root', artifact_root: artifactRoot, authorized_bindings: [...bindings, ...(authorityBinding ? [{ run_id: runId, ...authorityBinding }] : [])], run_controls: [{ run_id: runId, approved_fingerprints: fingerprints('c'), required_artifacts: required, integration_prerequisites: prerequisites }] };
  const approvedFingerprints = authorityBinding ? authorityFingerprints(controlConfig) : fingerprints('c');
  controlConfig.run_controls[0].approved_fingerprints = approvedFingerprints;
  const broker = createOwnedArtifactBroker(controlConfig);
  const validator = await createPhase21ContractValidator({ schemas: [proofSchema] });
  let run = {
    run_id: runId, artifact_root: artifactRoot, phase21Validator: validator,
    declared_fingerprints: approvedFingerprints, current_fingerprints: { ...approvedFingerprints, ...currentFingerprintOverrides },
    chain: { schema_version: 'phase21-proof-chain-1.0', run_id: runId, artifacts: [], dependencies: [{ artifact_id: 'input', fingerprints: approvedFingerprints, status: 'current' }], required_artifacts: required, integration_prerequisites: prerequisites, delivery_status: 'pending_resolver', critical_defects: chainDefects, metadata: { requirement_refs: ['APA3-03', 'APA3-04'] }, p20_e12_status: 'unverified' },
  };
  const sourceFingerprint = cases.run.source_check_fingerprint;
  const comparison = await comparisonFactory(comparisonSourcePackage);
  assert.equal(comparison.result.status, 'compared', 'fixture must use the actual Plan 03 success shape');
  const comparisonFingerprint=canonicalSha(comparison.result);
  const write = async (type, actor_id, role, artifact_path, artifact_id, depends_on = []) => {
    const logical={
        [inputKey]: role === 'source-check' ? sourceInputFingerprint : scientificInput?.input_fingerprint ?? roleCompleteInputFingerprint,
        source_check_fingerprint: sourceFingerprint, fingerprint: sourceFingerprint,
        parser_comparison_result_fingerprint: comparisonFingerprint, source_text: cases.injection_text,
        ...(role === 'source-check' ? { received_upstream_analysis: false, independence: 'not_independent', initial_pass_status: 'completed', conclusion_status: 'pass', ...sourceArtifactOverrides } : {}),
        ...(role === 'integration' ? { p22_role_unit_map: [] } : {}),
        ...(role === 'integration' && comparisonMode === 'actual' ? { parser_comparison_inputs: comparison.inputs, parser_comparison_result: comparison.result } : {}),
        ...(role === 'integration' && comparisonMode === 'self_asserted' ? { parser_comparison: { status: 'accepted', result_fingerprint: sha('e') } } : {}),
        ...(role === 'integration' && ['rejected', 'not_comparable'].includes(comparisonMode) ? { parser_comparison_inputs: comparison.inputs, parser_comparison_result: { ...comparison.result, status: comparisonMode } } : {}),
        ...(role === 'source-check' ? {} : typeof roleOverrides === 'function' ? roleOverrides(role) : roleOverrides),
      };
    let content;
    if(role==='integration'&&integrationStorage==='whole-paper-json'){const packed=encodeWholePaperArtifact(logical,{kind:'integration_role'});content=packed.bytes;storageAccounting=packed.accounting;}else content=JSON.stringify(logical);
    if(role==='integration'&&integrationWireMutator)content=integrationWireMutator(content);
    run = await advanceRun({ run, dispatchContext: broker.dispatchContext, artifactStore: broker, action: {
      type, actor_id, role, artifact_path, revision: 'r1', depends_on,
      artifact: {artifact_id,content},
    } });
  };
  await write('seal_source_check', 'reviewer', 'source-check', 'roles/source-check.json', 'source-check');
  await write('write_artifact', 'evidence-agent', 'evidence', 'roles/evidence-map.json', 'evidence-map-r1');
  await write('write_artifact', 'methods-agent', 'methods', 'roles/methods-design.json', 'methods-design-r1', ['evidence-map-r1']);
  await write('write_artifact', 'results-agent', 'results', 'roles/results-visuals.json', 'results-visuals-r1', ['evidence-map-r1']);
  await write('write_artifact', 'interpretation-agent', 'interpretation', 'roles/interpretation-appraisal.json', 'interpretation-appraisal-r1', ['methods-design-r1', 'results-visuals-r1']);
  await write('write_artifact', 'scientific-reading-agent', 'scientific-reading', 'roles/scientific-reading-card.json', 'scientific-reading-card-r1', ['evidence-map-r1', 'methods-design-r1', 'results-visuals-r1', 'interpretation-appraisal-r1']);
  await write('write_artifact', 'integration-agent', 'integration', 'roles/integration.json', 'integration-r1', ['evidence-map-r1', 'methods-design-r1', 'results-visuals-r1', 'interpretation-appraisal-r1', 'scientific-reading-card-r1']);
  run = await advanceRun({ run, dispatchContext: broker.dispatchContext, artifactStore: broker, action: { type: 'freeze_analysis_draft', actor_id: 'control-root', role: 'control', artifact_path: 'roles/control.json', revision: 'r1' } });
  run.delivery_requested = true;
  run = await advanceRun({ run, dispatchContext: broker.dispatchContext, artifactStore: broker, action: { type: 'compare', actor_id: 'control-root', role: 'control', artifact_path: 'roles/control.json', revision: 'r1' } });
  const sourceReceipt = run.receipts.find(receipt => receipt.artifact_id === 'source-check');
  return { artifactRoot, broker, controlConfig, validator, run,storageAccounting,comparisonFingerprint, sourceCheck: { fingerprint: sourceFingerprint, [inputKey]: sourceInputFingerprint, received_upstream_analysis: false, independence: 'not_independent', initial_pass_status: 'completed', conclusion_status: 'pass', artifact_sha256: sourceReceipt.sha256 } };
}

function preparation() {
  const p = structuredClone(completeScientificInput);
  const input = { schema_version: 'phase21-scientific-input-1.0', identity: p.identity,
    source_package: p.boundary_package.source_package, core: p.boundary_package.core,
    reading_card: p.boundary_package.reading_card, scientific_details: p.scientific_details };
  input.input_fingerprint = fingerprintScientificInput(input);
  return input;
}

function preRenderArgs(state, scientificInput) {
  return { run: state.run, dispatchContext: state.broker.dispatchContext, artifactRoot: state.artifactRoot,
    phase21Validator: state.validator, scientificInput, sourceCheck: state.sourceCheck, proofChain: state.run.chain };
}


async function sourceEvidenceFixtureRun(t,{scientificInput,sourceCheckContent,roleOverrides={},controlOverrides={},initialOverrides={},finalOverrides={},frozenInput=scientificInput,revision='r1',storageContract=null,reuseRegistration=null,frozenReference=null}={}){
  const artifactRoot=await mkdtemp(join(tmpdir(),'apa-se-compose-'));
  t.after(()=>{const target=resolve(artifactRoot);assert.equal(dirname(target),resolve(tmpdir()));assert.ok(basename(target).startsWith('apa-se-compose-'));return rm(target,{recursive:true,force:true});});
  const runId=scientificInput.identity.run_id,bundle=scientificInput.source_evidence_bundle,inputFingerprint=scientificInput.input_fingerprint;
  const approved={...fingerprints('c'),source:bundle.provenance.approval_binding.source_scope_fingerprint,parser_tool:bundle.provenance.tool_binding.fingerprint,authorization:bundle.provenance.approval_binding.authorization_fingerprint,policy:bundle.provenance.approval_binding.policy_fingerprint,...controlOverrides};
  const entries=[['source-check-initial','reviewer','source-check','roles/source-check-initial.json'],['scientific-input-frozen','control-root','control','roles/scientific-input-frozen.json'],['source-check','reviewer','source-check','roles/source-check.json'],...roles.map(([role,id,file])=>[id+'-'+revision,role+'-agent',role,'roles/'+file])];
  const required=entries.map(([artifact_id,owner_actor_id,,path])=>({artifact_id,owner_actor_id,path}));
  const prerequisites={source_check_artifact_id:'source-check',analysis_draft_artifact_id:'scientific-input-frozen',integration_artifact_id:'integration-'+revision,approval_artifact_id:'scientific-reading-card-'+revision};
  const bindings=entries.map(([,actor_id,role,artifact_path])=>({run_id:runId,actor_id,role,artifact_path,revision}));
  const controlConfig={control_actor_id:'control-root',artifact_root:artifactRoot,authorized_bindings:bindings,run_controls:[{run_id:runId,approved_fingerprints:approved,required_artifacts:required,integration_prerequisites:prerequisites,...(reuseRegistration?{source_evidence_reuse:reuseRegistration}:{})}]};
  const broker=createOwnedArtifactBroker(controlConfig);
  const validator=await createPhase21ContractValidator({schemas:[proofSchema]});
  let run={run_id:runId,artifact_root:artifactRoot,phase21Validator:validator,declared_fingerprints:structuredClone(approved),current_fingerprints:structuredClone(approved),chain:{schema_version:'phase21-proof-chain-1.0',run_id:runId,artifacts:[],dependencies:[{artifact_id:'input',fingerprints:structuredClone(approved),status:'current'}],required_artifacts:required,integration_prerequisites:prerequisites,delivery_status:'pending_resolver',critical_defects:[],metadata:{requirement_refs:['APA3-03','APA3-04']},p20_e12_status:'unverified'}};
  const write=async(id,content,depends_on=[],type='write_artifact')=>{const entry=entries.find(e=>e[0]===id);run=await advanceRun({run,dispatchContext:broker.dispatchContext,artifactStore:broker,action:{type,actor_id:entry[1],role:entry[2],artifact_path:entry[3],revision,depends_on,parent_revision:depends_on.length?revision:null,artifact:{artifact_id:id,content:Buffer.isBuffer(content)?content:JSON.stringify(content)}}});assert.equal(run.status,'active',JSON.stringify(run.delivery_gate));return run.receipts.find(r=>r.artifact_id===id);};
  const receiptBinding=r=>({artifact_id:r.artifact_id,revision:r.revision,sha256:r.sha256});
  const sourceFingerprint=canonicalSha({scientific_input_fingerprint:inputFingerprint,source_bundle_fingerprint:bundle.bundle_fingerprint});
  const common={scientific_input_fingerprint:inputFingerprint,source_check_fingerprint:sourceFingerprint,fingerprint:sourceFingerprint};
  const initial={...common,received_upstream_analysis:false,independence:'not_independent',initial_pass_status:'completed',source_bundle_fingerprint:bundle.bundle_fingerprint,source_scope_fingerprint:approved.source,source_observations_fingerprint:canonicalSha({pdf_run:bundle.pdf_run,office_observations:bundle.office_observations}),...initialOverrides};
  const first=await write('source-check-initial',initial,[],'seal_source_check');
  const packed=frozenReference?{bytes:Buffer.from(JSON.stringify(frozenReference)),accounting:null}:encodeWholePaperArtifact(frozenInput,{kind:'source_evidence_scientific_input',...(storageContract?{storageContract}:{})}),storageAccounting=packed.accounting;
  const frozen=await write('scientific-input-frozen',packed.bytes,['source-check-initial']);
  run=await advanceRun({run,dispatchContext:broker.dispatchContext,artifactStore:broker,action:{type:'freeze_analysis_draft',actor_id:'control-root',role:'control',artifact_path:'roles/scientific-input-frozen.json',revision}});
  const final={...sourceCheckContent,...common,received_upstream_analysis:false,final_pass_received_upstream_analysis:true,independence:'not_independent',initial_pass_status:'completed',conclusion_status:'pass',initial_source_check_binding:receiptBinding(first),frozen_scientific_input_binding:receiptBinding(frozen),...finalOverrides};
  const receipt=await write('source-check',final,['scientific-input-frozen']);
  const qualification=evaluateScientificEvidenceQualification({scientificInput,sourceCheckContent:final,sourceCheckReceiptSha256:receipt.sha256});
  const d=scientificInput.parser_evaluation_disposition,dispositionSummary={requirement_status:d.requirement_status,comparison_status:d.comparison_status,source_scope_fingerprint:d.source_scope_fingerprint,reason:d.reason,evidence_records:d.evidence_records.map(({kind,record_ref,sha256})=>({kind,record_ref,sha256})),disposition_fingerprint:canonicalSha(d)};
  const parents={'evidence':['source-check'],'methods':['evidence-map-r1'],'results':['evidence-map-r1'],'interpretation':['methods-design-r1','results-visuals-r1'],'scientific-reading':['evidence-map-r1','methods-design-r1','results-visuals-r1','interpretation-appraisal-r1'],'integration':['evidence-map-r1','methods-design-r1','results-visuals-r1','interpretation-appraisal-r1','scientific-reading-card-r1']};
  for(const [role,id]of roles){const logical={...common,scientific_evidence_qualification_fingerprint:qualification.qualification_fingerprint??sha('f'),...(role==='integration'?{p22_role_unit_map:[],scientific_evidence_qualification:qualification.qualification,parser_evaluation_disposition:dispositionSummary}:{}),...(typeof roleOverrides==='function'?roleOverrides(role):roleOverrides)};await write(id+'-'+revision,logical,parents[role].map(id=>id.endsWith('-r1')?id.slice(0,-2)+revision:id));}
  // Orchestrator compare resolves delivery only; no parser comparison is called in this fixture.
  run.delivery_requested=true;run=await advanceRun({run,dispatchContext:broker.dispatchContext,artifactStore:broker,action:{type:'compare',actor_id:'control-root',role:'control',artifact_path:'roles/control.json',revision:'r1'}});
  assert.equal(run.chain.delivery_status,'deliverable',JSON.stringify(run.delivery_gate));
  return {artifactRoot,broker,controlConfig,validator,run,storageAccounting,qualification,sourceCheck:{fingerprint:sourceFingerprint,scientific_input_fingerprint:inputFingerprint,received_upstream_analysis:false,independence:'not_independent',initial_pass_status:'completed',conclusion_status:'pass',artifact_sha256:receipt.sha256}};
}


function storedZip(parts){
  const chunks=[],directory=[];let offset=0;
  const crc=b=>{let c=0xffffffff;for(const v of b){c^=v;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0)}return(c^0xffffffff)>>>0};
  for(const [name,xml] of Object.entries(parts)){const n=Buffer.from(name),b=Buffer.from(xml),l=Buffer.alloc(30),d=Buffer.alloc(46),sum=crc(b);l.writeUInt32LE(0x04034b50);l.writeUInt16LE(20,4);l.writeUInt32LE(sum,14);l.writeUInt32LE(b.length,18);l.writeUInt32LE(b.length,22);l.writeUInt16LE(n.length,26);d.writeUInt32LE(0x02014b50);d.writeUInt16LE(20,4);d.writeUInt16LE(20,6);d.writeUInt32LE(sum,16);d.writeUInt32LE(b.length,20);d.writeUInt32LE(b.length,24);d.writeUInt16LE(n.length,28);d.writeUInt32LE(offset,42);chunks.push(l,n,b);directory.push(d,n);offset+=30+n.length+b.length;}
  const cd=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(Object.keys(parts).length,8);end.writeUInt16LE(Object.keys(parts).length,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...chunks,cd,end]);
}

async function makeWholePaperScientificFixture({sharedFormula=false}={}){
  const input={schema_version:'phase21-scientific-input-whole-paper-1.0',identity:clone(template.identity),source_package:clone(template.boundary_package.source_package),core:clone(template.boundary_package.core),reading_card:clone(template.boundary_package.reading_card),scientific_details:clone(template.scientific_details),source_run:null,source_value_metadata:[],input_fingerprint:byteSha('initial')};
  input.source_package.schema_version='phase21-source-package-whole-paper-1.0';input.source_package.content_profile='apa-v3.0-whole-paper-1.0';
  input.scientific_details.scientific_schema_version='phase21/scientific-details@whole-paper-1.0';
  for(const d of input.source_package.source_documents){d.kind='pdf';d.purpose='content';for(const l of d.locators)l.kind='pdf';}
  for(const e of input.core.evidence)e.locator.kind='pdf';
  for(const [index,b] of input.scientific_details.source_blocks.entries()){
    const locator={kind:'pdf',source_document_id:b.source_document_id,source_hash:b.source_hash,page_index:b.page_index,block_id:b.block_id};
    if(!input.core.evidence.some(e=>digest(e.locator)===digest(locator)))input.core.evidence.push({evidence_id:'ev_'+'6'.repeat(31)+index,evidence_label:'Synthetic PDF boundary closure',attachment_id:input.source_package.attachments.find(a=>a.source_document_id===b.source_document_id).attachment_id,locator,extracted_text:b.text});
  }
  for(const record of input.scientific_details.records)for(const id of record.source_block_ids){const b=input.scientific_details.source_blocks.find(b=>b.source_block_id===id);for(const e of input.core.evidence.filter(e=>e.locator.source_document_id===b.source_document_id&&e.locator.page_index===b.page_index&&e.locator.block_id===b.block_id))if(!record.boundary_evidence_ids.includes(e.evidence_id))record.boundary_evidence_ids.push(e.evidence_id);}
  const sources=input.source_package.source_documents.map(d=>({document_id:d.source_document_id,source_sha256:d.source_hash,role:d.role==='main'?'main':'attachment',critical:input.source_package.attachments.some(a=>a.source_document_id===d.source_document_id&&a.critical),availability:'available',kind:'pdf',purpose:'content'}));
  const pdfRun={schema_version:'phase21-parser-run-1.0',parser_run_id:byteSha('synthetic-pdf-run'),sources:sources.map(({kind,purpose,...s})=>s),backend:'mineru',backend_version:'fixture-1',normalization_version:'fixture-1',config_fingerprint:byteSha('config'),approval_fingerprint:byteSha('approval'),approval_scope:'synthetic-only',blocks:input.scientific_details.source_blocks.map(b=>({id:b.block_id,type:'paragraph',text:b.text,locator:{document_id:b.source_document_id,page_number:b.page_index+1,page_status:'known',source_block_id:b.block_id},rotation_degrees:0})),page_coverage:sources.map(s=>({document_id:s.document_id,known_pages:[...new Set(input.scientific_details.source_blocks.filter(b=>b.source_document_id===s.document_id).map(b=>b.page_index+1))],unknown_item_count:0})),assets:[],normalization_audit:{mappings:[],raw_page_policy:'preserve_unknown_before_v2_normalization'},resource_observations:[],errors:[],candidate_eligibility:{eligible:true,blockers:[]},metadata:{requirement_refs:['APA3-03','APA3-04']}};
  const required=sources.map(s=>({document_id:s.document_id,kind:'pdf',purpose:'content',scope_complete:true,required_pages:pdfRun.page_coverage.find(p=>p.document_id===s.document_id).known_pages}));
  const W='http://schemas.openxmlformats.org/wordprocessingml/2006/main',S='http://schemas.openxmlformats.org/spreadsheetml/2006/main',office=[];
  for(const [kind,id,text] of [['docx','7','Measured 7 cases.'],['workbook','8','7']]){
    const format=kind==='docx'?'docx':'xlsx',part=kind==='docx'?'word/document.xml':'xl/worksheets/sheet1.xml';
    const xml=kind==='docx'?`<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`:`<worksheet xmlns="${S}"><sheetData><row r="1"><c r="A1">${sharedFormula?'<f t="shared" ref="A1:B1" si="0">SUM(A2:A3)</f>':''}<v>7</v></c>${sharedFormula?'<c r="B1"><f t="shared" si="0"/><v>9</v></c>':''}</row></sheetData></worksheet>`;
    const parts=kind==='docx'?{[part]:xml}:{'xl/workbook.xml':`<workbook xmlns="${S}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="r1"/></sheets></workbook>`,'xl/_rels/workbook.xml.rels':'<Relationships><Relationship Id="r1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',[part]:xml};
    const raw=storedZip(parts),source={document_id:'src_'+id.repeat(32),source_sha256:byteSha(raw),role:'attachment',critical:true,availability:'available',kind,format,purpose:'content',container:{document_id:'src_'+'f'.repeat(32),source_sha256:byteSha('synthetic-archive')},member_path:`table-${id}.${format}`};sources.push(source);
    const xmlPath=kind==='docx'?'/document[1]/body[1]/p[1]':'/worksheet[1]/sheetData[1]/row[1]/c[1]';
    const rec={id:part+'#'+xmlPath,kind:kind==='docx'?'paragraph':'workbook_cell',locator:{part,part_sha256:byteSha(xml),xml_path:xmlPath},physical_page:null,evidence_origin:'source_only',text,...(kind==='docx'?{ancestry:[],attributes:{}}:{sheet:{index:0,name:'Data',sheet_id:'1',visibility:'visible'},address:'A1',row:1,column:1,state:'value',xml_type:'n',raw_value:'7',serialized:true,merges:[],formula:{present:false,text:null,attributes:{}},cache:{element_present:true,raw_value:'7'},unresolved:false,style_index:null})};
    const ev={format,source:{sha256:byteSha(raw),byte_length:raw.length},scope:{profile:'whole-paper-source-1.0',format,parts:Object.keys(parts)},parts:Object.entries(parts).map(([path,xml])=>({path,sha256:byteSha(xml),byte_length:Buffer.byteLength(xml)})),records:[rec],coverage:{complete_selected_parts:true,sheets:kind==='workbook'?[{index:0,name:'Data',range:'A1',serialized_cells:1,merged_ranges:[],unserialized_not_assumed_blank:true}]:[],uninterpreted_parts:[]}};
    if(kind==='workbook'&&sharedFormula){
      rec.state='formula_cached';rec.unresolved=true;rec.formula={present:true,text:'SUM(A2:A3)',attributes:{t:'shared',ref:'A1:B1',si:'0'}};
      const follower=clone(rec);follower.id=follower.id.replace('/c[1]','/c[2]');follower.locator.xml_path=follower.locator.xml_path.replace('/c[1]','/c[2]');follower.address='B1';follower.column=2;follower.text=follower.raw_value=follower.cache.raw_value='9';follower.formula={present:true,text:null,attributes:{t:'shared',si:'0'}};ev.records.push(follower);
      ev.coverage.sheets[0].range='A1:B1';ev.coverage.sheets[0].serialized_cells=2;
    }
    const content=kind==='docx'?[{type:'text',text}]:[{type:'table',table_body:'<table><tr><td><p>7</p></td>'+(sharedFormula?'<td><p>9</p></td>':'')+'</tr></table>'}],pb=Buffer.from(JSON.stringify(content));
    office.push({document_id:source.document_id,source_bytes:raw,source_evidence:ev,parser_output_bytes:pb,parser_binding:{sha256:byteSha(pb),run_id:'synthetic-'+kind,backend:'mineru',backend_version:'fixture-1'}});
    required.push({document_id:source.document_id,kind,purpose:'content',scope_complete:true,...(kind==='docx'?{parts:Object.keys(parts),record_ids:[rec.id]}:{sheets:[{index:0,name:'Data',range:{start_row:1,start_column:1,end_row:1,end_column:sharedFormula?2:1}}]})});
  }
  const args={sources,pdfRun,officePayloads:office,parserConfig:{version:'fixture-1'},approval:{fingerprint:byteSha('approval'),scope:'synthetic-only'},requiredCoverage:required};
  const base=await translateWholePaperPayload({...args,side:'baseline'}),candidate=await translateWholePaperPayload({...args,side:'candidate'});assert.equal(base.ok,true,JSON.stringify(base.errors));assert.equal(candidate.ok,true,JSON.stringify(candidate.errors));input.source_run=candidate.run;
  const verification={status:'verified',method:'assisted',source_access:'used',parser_output_access:'used',record_ref:'synthetic-review',record_fingerprint:byteSha('review')};
  const legacyItems=pdfRun.blocks.map((b,n)=>({evidence_id:'pdf-'+n,document_id:b.locator.document_id,locator:clone(b.locator),category:'text',centrality:'central',expected_semantic_unit:b.text,verification:clone(verification)}));
  const items=legacyItems.map(i=>({evidence_id:i.evidence_id,document_id:i.document_id,category:i.category,centrality:i.centrality,locator:{kind:'pdf',...i.locator},verification:clone(verification),legacy_item:clone(i)}));
  for(const [kind,id] of [['docx','7'],['workbook','8']]){
    const source=sources.find(s=>s.kind===kind),obs=candidate.run.office_observations.find(o=>o.document_id===source.document_id&&o.origin==='source_read'),rec=obs.record;
    const loc={kind,source_document_id:source.document_id,source_hash:source.source_sha256,block_id:obs.id,member_path:source.member_path,...(kind==='docx'?{part:rec.locator.part,part_sha256:rec.locator.part_sha256,xml_path:rec.locator.xml_path}:{sheet:{index:0,name:'Data'},range:clone(obs.locator.range)})};
    const metadata={kind,source_document_id:source.document_id,locator:clone(loc),original_type:kind==='docx'?'docx:text':'xlsx:n',raw_lexical_value:kind==='docx'?rec.text:rec.raw_value,record_fingerprint:digest(rec)};input.source_value_metadata.push(metadata);
    const blockId='blk_'+id.repeat(32),evId='ev_'+id.repeat(32),attId='att_'+id.repeat(32);
    input.source_package.source_documents.push({source_document_id:source.document_id,source_label:'Synthetic '+kind,source_hash:source.source_sha256,role:'supplement',media_type:kind==='docx'?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',support_status:'supported',included:true,kind,purpose:'content',format:source.format,container:clone(source.container),member_path:source.member_path,locators:[clone(loc)]});
    input.source_package.attachments.push({attachment_id:attId,attachment_label:'Synthetic '+kind,source_document_id:source.document_id,critical:true,included:true});
    input.core.evidence.push({evidence_id:evId,evidence_label:'Observed '+kind,attachment_id:attId,locator:clone(loc),extracted_text:rec.text});
    input.scientific_details.source_blocks.push({source_block_id:blockId,source_document_id:source.document_id,source_hash:source.source_sha256,block_id:loc.block_id,role:'result',text:rec.text,native_locator:clone(loc),observation_fingerprint:digest({record:rec,metadata})});
    const q={quantity_id:'qty_'+id.repeat(32),record_id:input.scientific_details.records[0].semantic_unit_id,source_block_id:blockId,metric_definition:'Synthetic '+kind+' direct count',raw_value:'7',raw_precision:'lexical:7',unit:'cases',denominator:'Synthetic eligible cases',groups:['Synthetic group'],timepoint:'Synthetic time',analysis_set:'Synthetic analysis set',uncertainty_type:'not reported',uncertainty_value:'not reported'};
    const {quantity_id,record_id,source_block_id,...values}=q;q.source_occurrences=[{source_block_id,source_hash:source.source_sha256,block_id:loc.block_id,native_locator:clone(loc),raw_excerpt:'7',...values,...(kind==='docx'?{value_span:{start:9,end:10},record_fingerprint:digest(rec)}:{value_cell:{row:rec.row,column:rec.column},cell_fingerprint:digest({record:rec,metadata})})}];
    input.scientific_details.quantities.push(q);const record=input.scientific_details.records[0];record.source_block_ids.push(blockId);record.boundary_evidence_ids.push(evId);record.quantity_ids.push(q.quantity_id);
    items.push({evidence_id:kind+'-value',document_id:source.document_id,category:'table',centrality:'central',locator:kind==='workbook'&&sharedFormula?{...clone(obs.locator),range:required.find(r=>r.document_id===source.document_id).sheets[0].range}:clone(obs.locator),verification:clone(verification),...(kind==='docx'?{expected_records:[clone(rec)]}:{expected_cells:sharedFormula?clone(office.find(p=>p.document_id===source.document_id).source_evidence.records):[clone(rec)],expected_merged_ranges:[],context_bindings:Object.fromEntries(['headers','row_labels','units','footnotes'].map(k=>[k,{applicability:'inapplicable',locators:[],reason:'Synthetic direct scalar'}]))})});
  }
  const parent={items:legacyItems,scope:{uncovered_items:[{evidence_id:'r03-gap-zip-content'}]}},reference={schema_version:'phase21-accepted-reference-whole-paper-1.0',reference_manifest_id:byteSha('reference'),source_document_map:clone(sources),required_coverage:clone(required),method:{preparation:'assisted',verification:'assisted',source_access:'used',parser_output_access:'used',independence:'nonblind'},acceptance:{decision_ref:'D-21-35',corpus_id:'phase21-twelve-paper',paper_id:'03',record_ref:'synthetic-approval',record_fingerprint:byteSha('approval')},scope:{status:'complete',category_dispositions:['text','table','formula','citation','figure','attachment','locator'].map(category=>({category,disposition:items.some(i=>i.category===category)?'covered':'inapplicable',reason:'Synthetic scope'}))},items,parent_reference_binding:{sha256:digest(parent),manifest:parent},gap_dispositions:[{evidence_id:'r03-gap-zip-content',status:'resolved',supporting_evidence_ids:['docx-value','workbook-value'],member_document_ids:sources.filter(s=>s.member_path).map(s=>s.document_id),reason:'Synthetic complete members'}]};
  const inputs={baselineRun:base.run,candidateRun:candidate.run,referenceManifest:reference,comparisonPolicy:{location_contract:'phase21-whole-paper-1.0',central_evidence_rule:'reject',locator_maps:[],reference_basis:{kind:'accepted_assisted',decision_ref:'D-21-35',corpus_id:'phase21-twelve-paper',paper_id:'03',reference_fingerprint:digest(reference)}},candidateDescriptor:{backend_kind:'hybrid',independent_backend:false,default_change:false,source_document_map:clone(sources)}};
  input.scientific_details.required_semantic_units=validateScientificContent(input.scientific_details,input,()=>{},'phase21-whole-paper-1.0');input.input_fingerprint=fingerprintScientificInput(input);
  const result=compareParserRuns(inputs);assert.equal(result.status,sharedFormula?'not_comparable':'compared',JSON.stringify(result.errors));
  return {input,comparison:{inputs,result}};
}


async function makeSourceEvidenceFixture(){
  needApi();
  const {input:scientificTemplate}=await makeWholePaperScientificFixture();
  const old=scientificTemplate.source_run;
  const args={sources:clone(old.sources),requiredCoverage:clone(old.required_coverage),pdfRun:clone(old.pdf_run),pdfSources:[],officeSources:old.provenance.office_payloads.map(p=>({document_id:p.document_id,source_bytes:Buffer.from(p.source_bytes_base64,'base64'),source_evidence:clone(p.source_evidence)})),approvalBinding:{authorization_fingerprint:byteSha('synthetic-authorization'),source_scope_fingerprint:byteSha('pending'),policy_fingerprint:byteSha('synthetic-policy')},toolBinding:{fingerprint:byteSha('pending'),components:[{path:'synthetic-source-reader',sha256:byteSha('reader')}]}};
  const replacements=new Map();
  for(const source of args.sources.filter(s=>s.kind==='pdf')){
    const source_bytes=Buffer.from('%PDF-1.4 synthetic source '+source.document_id+'\n%%EOF');
    const original=source.source_sha256;source.source_sha256=byteSha(source_bytes);replacements.set(original,source.source_sha256);
    args.pdfSources.push({document_id:source.document_id,source_bytes});
    args.pdfRun.sources.find(s=>s.document_id===source.document_id).source_sha256=source.source_sha256;
  }
  const remap=value=>{if(value&&typeof value==='object')for(const [k,v]of Object.entries(value)){if(typeof v==='string'&&replacements.has(v))value[k]=replacements.get(v);else remap(v);}};
  remap(scientificTemplate);
  const runBytes=Buffer.from(JSON.stringify(args.pdfRun));
  args.pdfRunBinding={record_ref:'synthetic/pdf-run.json',bytes:runBytes,sha256:byteSha(runBytes)};
  args.toolBinding.fingerprint=hash(args.toolBinding.components);scope(args);
  const result=api.buildSourceEvidenceBundle(args);assert.equal(result.ok,true,JSON.stringify(result.errors));
  return {bundleArgs:args,bundle:result.bundle,scientificTemplate};
}


async function makeSourceEvidenceScientificFixture({sourceFixture=null,workbookAddress=null}={}){
  const {bundle,scientificTemplate}=sourceFixture??await makeSourceEvidenceFixture();
  const {source_run,...input}=scientificTemplate;
  input.schema_version='phase21-scientific-input-source-evidence-1.0';input.source_evidence_bundle=bundle;
  // Rebind native fixture identities to actual source observations.
  for(const s of bundle.sources.filter(s=>s.kind!=='pdf')){
    const address=workbookAddress;
    const obs=bundle.office_observations.find(o=>o.document_id===s.document_id&&(s.kind==='docx'||!address||o.record.address===address));
    const old=input.source_value_metadata.find(m=>m.source_document_id===s.document_id),oldBlockId=old.locator.block_id;
    const update=value=>{if(value&&typeof value==='object'){for(const[k,v]of Object.entries(value)){if(k==='block_id'&&v===oldBlockId)value[k]=obs.id;else update(v);}if(value.source_document_id===s.document_id&&Object.hasOwn(value,'source_hash'))value.source_hash=s.source_sha256;if(value.kind===s.kind&&value.source_document_id===s.document_id&&value.block_id===obs.id){if(s.kind==='workbook'){value.sheet=clone(obs.locator.sheet);value.range=clone(obs.locator.range);}else{value.part=obs.locator.part;value.part_sha256=obs.locator.part_sha256;value.xml_path=obs.locator.xml_path;}}}};
    update(input);
    old.record_fingerprint=hash(obs.record);old.raw_lexical_value=s.kind==='docx'?obs.record.text:obs.record.raw_value;
    const block=input.scientific_details.source_blocks.find(b=>b.source_document_id===s.document_id);block.text=obs.text;block.observation_fingerprint=hash({record:obs.record,metadata:old});
    for(const q of input.scientific_details.quantities)for(const o of q.source_occurrences.filter(o=>o.source_block_id===block.source_block_id)){
      o.source_hash=s.source_sha256;
      if(s.kind==='workbook'){o.value_cell={row:obs.record.row,column:obs.record.column};o.cell_fingerprint=hash({record:obs.record,metadata:old});}else o.record_fingerprint=hash(obs.record);
    }
  }
  const affected=input.scientific_details.records[0].semantic_unit_id;
  input.scientific_details.source_status={coverage:'source_limited',completeness:'partial',affected_ids:[affected]};
  input.scientific_details.inventory[0].status='missing';input.scientific_details.inventory[0].affected_ids=[affected];
  input.scientific_details.required_semantic_units=validateScientificContent(input.scientific_details,input,()=>{},'phase21-whole-paper-1.0');
  const admission={comparison_status:'not_run',source_scope_fingerprint:bundle.provenance.approval_binding.source_scope_fingerprint,reason:'Synthetic admission only; no parser comparison executed'};
  const recordBytes=Buffer.from(JSON.stringify(admission));
  input.parser_evaluation_disposition={requirement_status:'unmet',comparison_status:'not_run',source_scope_fingerprint:admission.source_scope_fingerprint,reason:admission.reason,evidence_records:[{kind:'admission',record_ref:'synthetic/admission.json',sha256:byteSha(recordBytes),bytes_base64:recordBytes.toString('base64')}]};
  input.input_fingerprint=fingerprintScientificInput(input);
  const details=input.scientific_details;
  const review={schema_version:'phase21-scientific-evidence-review-1.0',scientific_input_fingerprint:input.input_fingerprint,source_bundle_fingerprint:bundle.bundle_fingerprint,obligation_reviews:details.records.map(r=>({semantic_unit_id:r.semantic_unit_id,verdict:r.semantic_unit_id===affected?'bounded':'supported',source_block_ids:clone(r.source_block_ids),reason:'Synthetic fixture source supports the stated bounded finding, not real review'})),claim_reviews:details.claims.map(c=>({...clone(c),verdict:'bounded',reason:'Only the frozen allowed conclusion is supported'})),quantity_reviews:details.quantities.map(q=>({quantity_id:q.quantity_id,source_occurrences_fingerprint:hash(q.source_occurrences),verdict:'supported',reason:'Synthetic direct value and eight explicit context checks',context_checks:Object.fromEntries(['metric_definition','unit','denominator','groups','timepoint','analysis_set','raw_precision','uncertainty'].map(k=>[k,true]))})),gap_dispositions:[...bundle.source_limits.map(l=>({gap_id:l.limit_id,origin:'source_limit',record_ids:[],claim_ids:[],quantity_ids:[],disposition:'bounded_limit',reason:'Not used as a scientific direct value in this synthetic fixture'})),...details.inventory.filter(i=>i.status==='missing').map(i=>({gap_id:i.inventory_id,origin:'inventory',record_ids:clone(i.affected_ids),claim_ids:[],quantity_ids:[],disposition:'bounded_limit',reason:'Synthetic table coverage remains missing; claims limited to cited observed content'}))]};
  return {input,review,sourceCheckContent:{scientific_evidence_review:review}};
}


const nativeVersion='phase21-scientific-input-workbook-1.0';
const bookId='src_'+ '7'.repeat(32), bookBlockId='blk_'+ '7'.repeat(32), bookEvidenceId='ev_'+ '7'.repeat(32);
const rectangle=(r,c,er=r,ec=c)=>({start_row:r,start_column:c,end_row:er,end_column:ec});
const nativeSheet={index:0,name:'Synthetic Results'};
const noContext=()=>Object.fromEntries(['headers','row_labels','units','footnotes'].map(k=>[k,{applicability:'inapplicable',locators:[],reason:'Synthetic isolated context'}]));
const nativeLocate=r=>({kind:'workbook',document_id:bookId,member_path:'supplement/synthetic-results.xlsx',sheet:structuredClone(nativeSheet),range:r,source_block_id:`sheet:0:R${r.start_row}C${r.start_column}:R${r.end_row}C${r.end_column}`});
const nativeCell=(r,c,value)=>({row:r,column:c,state:value===null?'blank':'value',value,formula:null,cached_value_status:'not_formula'});
const scientificLocator=(loc,hash)=>loc.kind==='pdf'?{kind:'pdf',source_document_id:loc.document_id,source_hash:hash,page_index:loc.page_number-1,block_id:loc.source_block_id}:{kind:'workbook',source_document_id:loc.document_id,source_hash:hash,block_id:loc.source_block_id,member_path:loc.member_path,sheet:structuredClone(loc.sheet),range:structuredClone(loc.range)};
function observationProjection(input,block) {
  const metadata=b=>input.native_cell_metadata.filter(m=>m.source_document_id===b.locator.document_id&&canonicalizeV3Json(m.sheet)===canonicalizeV3Json(b.locator.sheet)&&b.cells.some(c=>c.row===m.row&&c.column===m.column));
  return {block,metadata:metadata(block),context:Object.entries(block.context_bindings).map(([kind,binding])=>({kind,binding,observations:binding.locators.map(l=>{const b=input.native_source_run.blocks.find(b=>canonicalizeV3Json(b.locator)===canonicalizeV3Json(l));return {block:b,metadata:b?metadata(b):[]};})}))};
}
function rebindNative(input) {
  const run=input.native_source_run;
  run.required_coverage_fingerprint=canonicalSha(run.required_coverage);
  run.observation_fingerprint=canonicalSha({blocks:run.blocks,source_coverage:run.source_coverage,capabilities:run.capabilities});
  run.parser_run_id=adapter.deriveWorkbookParserRunIdentity(run);
  for(const b of input.scientific_details.source_blocks.filter(b=>b.native_locator)){
    const block=run.blocks.find(x=>x.locator.source_block_id===b.block_id&&x.locator.document_id===b.source_document_id);
    if(block){const projection=observationProjection(input,block);b.text=canonicalizeV3Json(projection);b.observation_fingerprint=canonicalSha(projection);}
  }
  for(const q of input.scientific_details.quantities)for(const o of q.source_occurrences.filter(o=>o.native_locator)){
    const block=run.blocks.find(b=>b.locator.source_block_id===o.block_id&&b.locator.document_id===o.native_locator.source_document_id);
    const cell=block?.cells.find(c=>c.row===o.value_cell?.row&&c.column===o.value_cell?.column);
    const metadata=input.native_cell_metadata.find(m=>m.source_document_id===o.native_locator.source_document_id&&canonicalizeV3Json(m.sheet)===canonicalizeV3Json(o.native_locator.sheet)&&m.row===o.value_cell?.row&&m.column===o.value_cell?.column);
    if(cell&&metadata)o.cell_fingerprint=canonicalSha({cell,metadata});
  }
  input.input_fingerprint=fingerprintScientificInput(input);return input;
}
function manifest(input){input.scientific_details.required_semantic_units=validateScientificContent(input.scientific_details,input,()=>{});return rebindNative(input);}
async function factoryNativeScientificTrace() {
  const input=preparation();input.schema_version=nativeVersion;
  const pdfSources=input.source_package.source_documents.map(d=>({document_id:d.source_document_id,role:d.role==='main'?'main':'attachment',critical:true,bytes:Buffer.from('synthetic PDF bytes '+d.source_document_id)}));
  const pdfRun=await adapter.translateMineruPayload({sources:pdfSources,rawPayloads:pdfSources.map(s=>({document_id:s.document_id,content:input.scientific_details.source_blocks.filter(b=>b.source_document_id===s.document_id).map(b=>({block_id:b.block_id,page_idx:b.page_index,text:b.text}))})),parserConfig:{backend:'mineru',backend_version:'synthetic-1',normalization_version:'synthetic-1'},approval:{scope:'synthetic-only'}});
  const context=noContext(), entries=[['headers',rectangle(1,2),'Synthetic measure'],['row_labels',rectangle(2,1),'Synthetic group A'],['units',rectangle(1,3),'Synthetic unit'],['footnotes',rectangle(4,1),'Synthetic condition at T1']];
  for(const [k,r] of entries)context[k]={applicability:'required',locators:[nativeLocate(r)],reason:'Synthetic exact association'};
  const ranges=[{scope_id:'data',range:rectangle(2,2),status:'read',cells:[nativeCell(2,2,1.5)],context_bindings:context,merged_ranges:[]},...entries.map(([k,r,value])=>({scope_id:k,range:r,status:'read',cells:[nativeCell(r.start_row,r.start_column,value)],context_bindings:noContext(),merged_ranges:[]}))];
  const requiredCoverage=[...pdfRun.page_coverage.map(p=>({document_id:p.document_id,kind:'pdf',required_pages:p.known_pages})),{document_id:bookId,kind:'workbook',sheets:[{...nativeSheet,disposition:'required',reason:'Synthetic approved range',ranges:ranges.map(r=>({scope_id:r.scope_id,range:r.range,purpose:r.scope_id,context_bindings:r.context_bindings}))}]}];
  const run=await translateWorkbookPayload({sources:[...pdfSources,{document_id:bookId,kind:'workbook',format:'xlsx',role:'attachment',critical:true,bytes:Buffer.from('synthetic workbook bytes'),container:{kind:'archive',document_id:'synthetic-archive',bytes:Buffer.from('synthetic archive bytes')},member_path:'supplement/synthetic-results.xlsx'}],pdfRun,workbookPayloads:[{document_id:bookId,status:'read',capability:{status:'supported',reader:{name:'synthetic-reader',version:'1'},observation_ref:'synthetic-only'},sheets:[{...nativeSheet,visibility:'visible',status:'read',empty_check:{status:'not_performed',observation_ref:'synthetic-only'},ranges}]}],parserConfig:{backend:'hybrid',backend_version:'synthetic-1',normalization_version:'native-1'},approval:{scope:'synthetic-only'},requiredCoverage});
  input.native_source_run=run;
  for(const d of input.source_package.source_documents){const source=run.sources.find(s=>s.document_id===d.source_document_id);d.source_hash=source.source_sha256;d.kind='pdf';for(const l of d.locators){l.source_hash=d.source_hash;l.kind='pdf';}}
  for(const e of input.core.evidence){e.locator.source_hash=run.sources.find(s=>s.document_id===e.locator.source_document_id).source_sha256;e.locator.kind='pdf';}
  for(const b of input.scientific_details.source_blocks)b.source_hash=run.sources.find(s=>s.document_id===b.source_document_id).source_sha256;
  for(const [index,b]of input.scientific_details.source_blocks.entries()){
    const loc={kind:'pdf',source_document_id:b.source_document_id,source_hash:b.source_hash,page_index:b.page_index,block_id:b.block_id};
    if(!input.core.evidence.some(e=>canonicalizeV3Json(e.locator)===canonicalizeV3Json(loc)))input.core.evidence.push({evidence_id:'ev_'+ '6'.repeat(31)+index,evidence_label:'Synthetic PDF closure',attachment_id:input.source_package.attachments.find(a=>a.source_document_id===b.source_document_id).attachment_id,locator:loc,extracted_text:b.text});
  }
  for(const r of input.scientific_details.records)r.boundary_evidence_ids=[...new Set(r.source_block_ids.flatMap(id=>{const b=input.scientific_details.source_blocks.find(b=>b.source_block_id===id);return input.core.evidence.filter(e=>e.locator.source_document_id===b.source_document_id&&e.locator.page_index===b.page_index&&e.locator.block_id===b.block_id).map(e=>e.evidence_id);}))];
  for(const q of input.scientific_details.quantities)for(const o of q.source_occurrences)o.source_hash=input.scientific_details.source_blocks.find(b=>b.source_block_id===o.source_block_id).source_hash;
  const source=run.sources.find(s=>s.document_id===bookId), block=run.blocks.find(b=>b.locator.kind==='workbook'), loc=scientificLocator(block.locator,source.source_sha256);
  input.source_package.schema_version='phase21-source-package-workbook-1.0';input.source_package.content_profile='apa-v3.0-native-workbook-1.0';
  input.source_package.source_documents.push({source_document_id:bookId,source_label:'Synthetic workbook',source_hash:source.source_sha256,role:'supplement',media_type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',support_status:'supported',included:true,kind:'workbook',format:'xlsx',container:source.container,member_path:source.member_path,locators:[loc]});
  input.source_package.attachments.push({attachment_id:'att_'+ '7'.repeat(32),attachment_label:'Synthetic workbook',source_document_id:bookId,critical:true,included:true});
  input.core.evidence.push({evidence_id:bookEvidenceId,evidence_label:'Synthetic workbook observation',attachment_id:'att_'+ '7'.repeat(32),locator:structuredClone(loc),extracted_text:'Synthetic direct value'});
  input.scientific_details.scientific_schema_version='phase21/scientific-details@native-workbook-1.0';
  input.native_cell_metadata=run.blocks.filter(b=>b.locator.kind==='workbook').flatMap(b=>b.cells.map(c=>({source_document_id:bookId,sheet:structuredClone(b.locator.sheet),row:c.row,column:c.column,original_type:typeof c.value==='number'?'xlsx:n':'xlsx:inlineStr',raw_lexical_value:typeof c.value==='number'?'1.50':c.value})));
  input.scientific_details.source_blocks.push({source_block_id:bookBlockId,source_document_id:bookId,source_hash:source.source_sha256,block_id:loc.block_id,role:'result',native_locator:structuredClone(loc),observation_fingerprint:sha('a'),text:'synthetic'});
  const q={quantity_id:'qty_'+ '7'.repeat(32),record_id:input.scientific_details.records[0].semantic_unit_id,source_block_id:bookBlockId,metric_definition:'synthetic direct measurement',raw_value:'1.50',raw_precision:'lexical:1.50',unit:'Synthetic unit',denominator:'Synthetic denominator',groups:['Synthetic group A'],timepoint:'Synthetic T1',analysis_set:'Synthetic set',uncertainty_type:'not reported in synthetic source',uncertainty_value:'not reported in synthetic source'};
  const {quantity_id,record_id,source_block_id,...values}=q;q.source_occurrences=[{source_block_id,source_hash:source.source_sha256,block_id:loc.block_id,native_locator:structuredClone(loc),value_cell:{row:2,column:2},cell_fingerprint:sha('a'),raw_excerpt:'1.50',...values}];
  input.scientific_details.quantities.push(q);input.scientific_details.records[0].source_block_ids.push(bookBlockId);input.scientific_details.records[0].boundary_evidence_ids.push(bookEvidenceId);input.scientific_details.records[0].quantity_ids.push(q.quantity_id);
  manifest(input);
  const oldReference=acceptedReferenceComparison().inputs.referenceManifest;
  const common=oldReference.items[0];const referenceManifest={...oldReference,schema_version:'phase21-accepted-reference-workbook-1.0',source_document_map:structuredClone(run.sources),input_fingerprint:canonicalSha([...run.sources].sort((a,b)=>a.document_id<b.document_id?-1:1)),required_coverage:structuredClone(requiredCoverage),items:[...run.blocks.filter(b=>b.locator.kind==='pdf').map((b,i)=>({...common,evidence_id:'pdf-'+i,document_id:b.locator.document_id,locator:structuredClone(b.locator),expected_semantic_unit:b.text})),{...common,evidence_id:'synthetic-value',document_id:bookId,locator:structuredClone(block.locator),category:'table',centrality:'central',expected_semantic_unit:'Synthetic direct cell',expected_cells:structuredClone(block.cells),context_bindings:structuredClone(block.context_bindings)}]};
  for(const d of referenceManifest.scope.category_dispositions)d.disposition=['text','table'].includes(d.category)?'covered':'inapplicable';
  const comparisonInputs={baselineRun:structuredClone(run),candidateRun:structuredClone(run),referenceManifest,comparisonPolicy:{location_contract:'phase21-native-workbook-1.0',policy_version:'synthetic-1',central_evidence_rule:'reject',locator_maps:[],reference_basis:{...acceptedReferenceComparison().inputs.comparisonPolicy.reference_basis,reference_fingerprint:canonicalSha(referenceManifest)}},candidateDescriptor:{backend_kind:'hybrid',backend_version:'synthetic-1',authority_scope:'local',retention:{disposition:'local_only'},egress:{data_transfer_decision:'not_applicable'},run_authorization_ref:'synthetic-only',default_change:false,source_document_map:structuredClone(run.sources),capabilities:structuredClone(run.capabilities)}};
  const comparison={inputs:comparisonInputs,result:compareParserRuns(comparisonInputs)};
  assert.equal(comparison.result.status,'compared',JSON.stringify(comparison.result.errors));
  return {input,comparison};
}



const wire = value => Buffer.from(JSON.stringify(value));
async function makeReuseFixture(){
  const f=await makeSourceEvidenceScientificFixture(),bundle=f.input.source_evidence_bundle;
  const built=buildSourceEvidenceVisibleView({bundle});assert.equal(built.ok,true,JSON.stringify(built.errors));
  const bundlePacked=encodeWholePaperArtifact(bundle,{kind:'source_evidence_bundle',storageContract:'phase21-whole-paper-storage-2.0'});
  const viewPacked=encodeWholePaperArtifact(built.view,{kind:'source_evidence_visible_view',storageContract:'phase21-whole-paper-storage-2.0'});
  const summary={status:'rejected',comparison_identity:byteSha('synthetic comparison'),full_result_fingerprint:byteSha('synthetic full result')};
  const build={input:{sha256:byteSha('synthetic comparison input bytes'),logical_fingerprint:byteSha('synthetic input logical')},baseline_identity:byteSha('baseline'),candidate_identity:byteSha('candidate'),reference_fingerprint:byteSha('reference')};
  const results={...summary,scientific_eligible:false},summaryBytes=wire(summary),buildBytes=wire(build),resultsBytes=wire(results);
  f.input.parser_evaluation_disposition={requirement_status:'unmet',comparison_status:'rejected',source_scope_fingerprint:bundle.provenance.approval_binding.source_scope_fingerprint,
    reason:'Synthetic rejected comparison; not a real paper result',evidence_records:[{kind:'comparison',record_ref:'synthetic/comparison.json',sha256:byteSha(summaryBytes),bytes_base64:summaryBytes.toString('base64')}]};
  f.input.input_fingerprint=fingerprintScientificInput(f.input);f.review.scientific_input_fingerprint=f.input.input_fingerprint;
  const sourceRef=(artifact_id,expected_kind,packed)=>({artifact_id,expected_kind,physical_sha256:byteSha(packed.bytes),logical_fingerprint:packed.logical_fingerprint});
  const sourceArtifacts={bundleBytes:bundlePacked.bytes,viewBytes:viewPacked.bytes,buildBytes,resultsBytes};
  const registration={binding_version:'source-evidence-reuse-1',identity:clone(f.input.identity),source_scope_fingerprint:bundle.provenance.approval_binding.source_scope_fingerprint,
    acquisition:{authorization_fingerprint:bundle.provenance.approval_binding.authorization_fingerprint,policy_fingerprint:bundle.provenance.approval_binding.policy_fingerprint,tool_fingerprint:bundle.provenance.tool_binding.fingerprint},
    execution_binding:{approval_ref:{artifact_id:'fresh-approval',physical_sha256:byteSha('synthetic human approval record')},authorization_fingerprint:byteSha('new content authorization'),allowed_steps:['scientific_input','source_check','roles','handoff'],model:'gpt-6.1-sol',reasoning_effort:'medium'},
    bundle_ref:sourceRef('old-bundle','source_evidence_bundle',bundlePacked),view_ref:sourceRef('old-view','source_evidence_visible_view',viewPacked),
    negative_parser_binding:{summary_ref:{artifact_id:'comparison-summary',physical_sha256:byteSha(summaryBytes)},comparison_identity:summary.comparison_identity,full_result_fingerprint:summary.full_result_fingerprint,
      build_ref:{artifact_id:'comparison-build',physical_sha256:byteSha(buildBytes)},results_ref:{artifact_id:'comparison-results',physical_sha256:byteSha(resultsBytes)},input:{physical_sha256:build.input.sha256,logical_fingerprint:build.input.logical_fingerprint},
      baseline_identity:build.baseline_identity,candidate_identity:build.candidate_identity,reference_fingerprint:build.reference_fingerprint,
      source_scope_fingerprint:bundle.provenance.approval_binding.source_scope_fingerprint,source_document_map:clone(bundle.sources),required_coverage:clone(bundle.required_coverage)}};
  const reference=reuse.createSourceEvidenceScientificInputReference({scientificInput:f.input,bundleRef:registration.bundle_ref,viewRef:registration.view_ref});
  const controls={source:registration.source_scope_fingerprint,parser_tool:byteSha('current tool'),permission:byteSha('current permission'),parent_revision:byteSha('current revision'),policy:byteSha('current policy'),authorization:registration.execution_binding.authorization_fingerprint};
  return {...f,reference,sourceArtifacts,registration,run:{current_fingerprints:controls}};
}

/** Creates only synthetic data in a temporary owned-artifact root. */
export async function createPhase22Fixture(options = {}) {
  const profile = options.profile ?? 'traditional';
  assert.ok(['traditional', 'workbook', 'whole-paper', 'source-evidence', 'complete-token'].includes(profile));
  const disposers = [];
  const lifecycle = { after: fn => disposers.push(fn) };
  const cleanup = async () => { for (const fn of disposers.splice(0)) await fn(); };
  options.t?.after(cleanup);
  try {
    let scientificInput, fixture, state, completeCandidate;
    if (profile === 'whole-paper') fixture = await makeWholePaperScientificFixture();
    if (profile === 'workbook') fixture = await factoryNativeScientificTrace();
    if (profile === 'source-evidence') fixture = options.reference ? await makeReuseFixture() : await makeSourceEvidenceScientificFixture();
    scientificInput = fixture?.input ?? (profile === 'complete-token' ? clone(completeScientificInput) : preparation());
    if (options.mutateScientificInput) {
      await options.mutateScientificInput(scientificInput);
      if (profile !== 'complete-token') scientificInput.input_fingerprint = fingerprintScientificInput(scientificInput);
    }
    const roleOverrides = role => ({
      ...(typeof options.roleOverrides === 'function' ? options.roleOverrides(role) : options.roleOverrides ?? {}),
      ...(role === 'integration' && options.roleUnitMap !== undefined ? {p22_role_unit_map: options.roleUnitMap} : {}),
    });
    if (profile === 'source-evidence') {
      state = await sourceEvidenceFixtureRun(lifecycle, {scientificInput, sourceCheckContent: fixture.sourceCheckContent, roleOverrides,
        ...(options.reference ? {controlOverrides: fixture.run.current_fingerprints, reuseRegistration: fixture.registration, frozenReference: fixture.reference} : {})});
    } else {
      state = await fixtureRun(lifecycle, {
        ...(profile === 'complete-token' ? {} : {scientificInput}),
        roleOverrides,
        comparisonFactory: fixture?.comparison ? () => fixture.comparison : comparisonInputsForCompleteInput,
        integrationStorage: profile === 'whole-paper' ? 'whole-paper-json' : 'legacy-json',
      });
    }
    const args = { ...preRenderArgs(state, scientificInput), conflicts: options.conflicts ?? [] };
    let handoff;
    if (profile === 'complete-token') {
      completeCandidate = await composer.buildCompleteCandidate({...args, completeScientificInput: scientificInput});
      handoff = composer.buildPhase22Handoff(completeCandidate);
    } else if (profile === 'source-evidence') {
      handoff = await composer.buildSourceEvidencePreRenderHandoff(options.reference
        ? {...args, scientificInput: undefined, scientificInputReference: fixture.reference, sourceArtifacts: fixture.sourceArtifacts}
        : args);
    } else {
      handoff = await composer.buildPreRenderHandoff(args);
    }
    // Additional controller artifacts are independently scheduled and actually
    // committed. The original dispatch remains bound to the proof-chain controls.
    const extraConfig = clone(state.controlConfig);
    const extras = [
      ['phase22-producer', 'control-root', 'control', 'phase22/producer.json', handoff],
      ['phase22-scientific-input', 'control-root', 'control', 'phase22/scientific-input.json', options.reference ? fixture.reference : scientificInput],
      ...(completeCandidate ? [['phase22-complete-candidate', 'control-root', 'control', 'phase22/complete-candidate.json', completeCandidate]] : []),
    ];
    const sourceEvidenceArtifactIds = {};
    if (options.reference) {
      for (const [key, artifactId] of Object.entries({bundleBytes: 'old-bundle', viewBytes: 'old-view', buildBytes: 'comparison-build', resultsBytes: 'comparison-results'})) {
        extras.push([artifactId, 'control-root', 'control', 'phase22/' + artifactId + '.json', fixture.sourceArtifacts[key]]);
        sourceEvidenceArtifactIds[key] = artifactId;
      }
      extras.push(['comparison-summary', 'control-root', 'control', 'phase22/comparison-summary.json', Buffer.from(scientificInput.parser_evaluation_disposition.evidence_records[0].bytes_base64, 'base64')]);
    }
    for (const [, actor_id, role, artifact_path] of extras) extraConfig.authorized_bindings.push({run_id: state.run.run_id, actor_id, role, artifact_path, revision: 'r1'});
    const extraBroker = createOwnedArtifactBroker(extraConfig);
    const registry = Object.fromEntries(state.run.receipts.map(receipt => [receipt.artifact_id, receipt]));
    for (const [artifact_id, actorId, role, artifactPath, value] of extras) {
      const receipt = await extraBroker.artifactStore.commitOwnedArtifact({
        artifactRoot: state.artifactRoot, dispatchContext: extraBroker.dispatchContext,
        capability: extraBroker.issueCapability({runId: state.run.run_id, actorId, role, artifactPath, revision: 'r1'}),
        expectedRevision: 'r1', artifact: {artifact_id, content: Buffer.isBuffer(value) ? value : JSON.stringify(value)},
      });
      registry[artifact_id] = receipt;
    }
    const artifactResolver = async artifactId => readOwnedArtifact({artifactRoot: state.artifactRoot, artifactId});
    const currentControl = {
      run: state.run, dispatchContext: state.broker.dispatchContext, proofChain: state.run.chain,
      artifactRoot: state.artifactRoot, producer_artifact_id: 'phase22-producer',
      scientific_input_artifact_id: 'phase22-scientific-input', registry,
      ...(options.reference ? {sourceArtifacts: fixture.sourceArtifacts, source_evidence_artifact_ids: sourceEvidenceArtifactIds} : {}),
      ...(completeCandidate ? {complete_candidate_artifact_id: 'phase22-complete-candidate'} : {}),
    };
    const result={profile, handoff, scientificInput, artifactResolver, currentControl, phase21Validator: state.validator,
      artifactRoot: state.artifactRoot, completeCandidate, broker: state.broker, controlConfig: state.controlConfig,
      run: state.run, sourceCheck: state.sourceCheck, fixture, cleanup};
    if(options.presentation)await registerPhase22PresentationFixture(result,typeof options.presentation==='function'?await options.presentation(scientificInput):options.presentation);
    return result;
  } catch (error) {
    await cleanup();
    throw error;
  }
}




/** Optional P22-only source presentation fixture; never changes the frozen SCI schema. */
export async function registerPhase22PresentationFixture(f,{assets=[],immutable_ranges=[],mutateManifest}={}) {
  const scientific_input_fingerprint=f.scientificInput.input_fingerprint??f.scientificInput.bindings.scientific_input_fingerprint;
  const manifest={schema_version:'phase22-source-presentation-1.0',identity:f.scientificInput.identity,scientific_input_fingerprint,
    assets:assets.map(({bytes,...entry})=>({...entry,byte_sha256:'sha256:'+createHash('sha256').update(bytes).digest('hex'),byte_length:bytes.length})),immutable_ranges};
  if(mutateManifest)mutateManifest(manifest);
  const content=Buffer.from(JSON.stringify(manifest)),manifestId='p22-source-presentation',manifestPath='phase22/presentation.json';
  const assetBindings=assets.map(entry=>({artifact_id:entry.artifact_id,owner_actor_id:'source-reader',role:'source-asset',path:'phase22/assets/'+entry.asset_id+'.bin',revision:'presentation-r1',
    sha256:'sha256:'+createHash('sha256').update(entry.bytes).digest('hex'),byte_length:entry.bytes.length}));
  const binding={manifest_artifact_id:manifestId,manifest_sha256:'sha256:'+createHash('sha256').update(content).digest('hex'),
    owner_actor_id:'presentation-integrator',revision:'presentation-r1',scientific_input_fingerprint,asset_bindings:assetBindings};
  const runId=f.run.run_id;
  const broker=createOwnedArtifactBroker({control_actor_id:'presentation-controller',artifact_root:f.artifactRoot,
    run_controls:[{run_id:runId,phase22_source_presentation_binding:binding}],
    authorized_bindings:[{run_id:runId,actor_id:binding.owner_actor_id,role:'integration',artifact_path:manifestPath,revision:binding.revision},
      ...assetBindings.map(x=>({run_id:runId,actor_id:x.owner_actor_id,role:x.role,artifact_path:x.path,revision:x.revision}))]});
  const commit=async(id,path,owner,role,bytes)=>{
    const receipt=await broker.artifactStore.commitOwnedArtifact({artifactRoot:f.artifactRoot,dispatchContext:broker.dispatchContext,
      capability:broker.issueCapability({runId,actorId:owner,role,artifactPath:path,revision:binding.revision}),expectedRevision:binding.revision,artifact:{artifact_id:id,content:bytes}});
    f.currentControl.registry[id]=receipt;
  };
  for(const [index,asset]of assets.entries())await commit(asset.artifact_id,assetBindings[index].path,'source-reader','source-asset',asset.bytes);
  await commit(manifestId,manifestPath,binding.owner_actor_id,'integration',content);
  f.currentControl.presentationControl={dispatchContext:broker.dispatchContext,runId,artifactId:manifestId};
  return {manifest,binding,broker};
}

