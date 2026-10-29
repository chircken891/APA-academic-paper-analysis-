import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { checkReaderProposal, checkReaderAuthorization, inspectRegisteredReaderEvidence, readReaderTrustAnchor, checkReaderAcceptance, deriveReaderSourceOnlyInput, adoptReaderSourceOnlyDelta, assembleReaderSourceAdoption, verifyReaderDeliverables, verifyReaderCallLedger, verifyReaderPresentationBinding } from '../../scripts/v3/phase221-acceptance.mjs';
import { createOwnedArtifactBroker } from '../../scripts/v3/owned-artifact-store.mjs';
import { emitApprovedRunStep, ingestObservedRunStep } from '../../scripts/v3/phase21-runner.mjs';
import { fingerprintV3Json } from '../../scripts/v3/semantic-package-validator.mjs';
import { readerTransactionFixture } from './helpers/phase221-transaction-fixtures.mjs';
import { createPhase22Fixture } from './helpers/phase22-fixtures.mjs';
import { fingerprintScientificInput } from '../../scripts/v3/scientific-input-validator.mjs';
import { createPhase22ContractValidator } from '../../scripts/v3/phase22-contract-loader.mjs';
import { consumePhase21Handoff, getReadingBasisContent } from '../../scripts/v3/phase22-input.mjs';
import { createRegisteredHistoricalFixture } from './helpers/phase221-fixtures.mjs';
import { readHistoricalReaderInput } from '../../scripts/v3/phase221-historical-input.mjs';
import { readerAssetOptions } from './helpers/phase221-package-fixtures.mjs';
import { registerBilingualPublication, loadBilingualPublication } from '../../scripts/v3/phase22-publication.mjs';

const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

test('new presentation policy rejects missing, unowned and changed mapping while legacy remains valid', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p221-map-binding-')), requirements = { research_map: { required: true, allowed_layouts: ['staged', 'swimlane'] }, shared_explanations: { required: true, mode: 'create_candidate' }, audit_display: 'compact', mapping_source: 'owned_integration' };
  const task = { stage: 'quantity', task_id: 'quantity', owner_actor_id: 'integrator', request_path: 'request.json', external_evidence: { artifact_id: 'quantity', artifact_root: root } };
  const proposal = { presentation_requirements: requirements, roles: [task] }, context = { context_fingerprint: fingerprintV3Json('context') }, registry = { paper_targets: {} };
  const input = { presentation_requirements: requirements, context, target_registry: registry, dependencies: { context: context.context_fingerprint },
    presentation_dependencies: { context: fingerprintV3Json(context), target_registry: fingerprintV3Json(registry), requirements: fingerprintV3Json(requirements) } };
  const inputBytes = Buffer.from(JSON.stringify(input)); await writeFile(join(root, 'input.json'), inputBytes);
  await writeFile(join(root, 'request.json'), JSON.stringify({ input: { path: join(root, 'input.json'), sha256: sha(inputBytes) } }));
  const plan = { researchMap: { layout: 'staged' }, sharedExplanations: [], auditDisplay: 'compact' };
  const broker = createOwnedArtifactBroker({ control_actor_id: 'controller', artifact_root: root,
    authorized_bindings: [{ run_id: 'synthetic', actor_id: 'integrator', role: 'integration', artifact_path: 'owned.json', revision: 'r1' }] });
  const receipt = await broker.artifactStore.commitOwnedArtifact({ artifactRoot: root, dispatchContext: broker.dispatchContext,
    capability: broker.issueCapability({ runId: 'synthetic', actorId: 'integrator', role: 'integration', artifactPath: 'owned.json', revision: 'r1' }), expectedRevision: 'r1',
    artifact: { artifact_id: 'quantity', content: Buffer.from(JSON.stringify({ presentation_plan: plan, presentation_dependencies: input.presentation_dependencies })) } });
  const args = { proposal, renderer: { targetRegistry: registry, presentationOptions: plan }, presentationPlanProof: { artifactRoot: root, artifactId: 'quantity', sha256: receipt.sha256 }, externalRoles: [{ task_id: 'quantity' }] };
  assert.equal(await verifyReaderPresentationBinding(args), true);
  assert.equal(await verifyReaderPresentationBinding({ proposal: {} }), true);
  await assert.rejects(verifyReaderPresentationBinding({ ...args, presentationPlanProof: undefined }), { code: 'P221_PRESENTATION_OWNED_MAPPING_REQUIRED' });
  await assert.rejects(verifyReaderPresentationBinding({ ...args, externalRoles: [] }), { code: 'P221_PRESENTATION_OWNED_MAPPING_REQUIRED' });
  await assert.rejects(verifyReaderPresentationBinding({ ...args, presentationPlanProof: { ...args.presentationPlanProof, sha256: sha('fake') } }), { code: 'P221_PRESENTATION_OWNED_MAPPING_REQUIRED' });
  await assert.rejects(verifyReaderPresentationBinding({ ...args, renderer: { ...args.renderer, presentationOptions: { ...plan, auditDisplay: 'full' } } }), { code: 'P221_PRESENTATION_MAPPING_CHANGED' });
  await assert.rejects(verifyReaderPresentationBinding({ ...args, renderer: { ...args.renderer, targetRegistry: {} } }), { code: 'P221_PRESENTATION_MAPPING_DEPENDENCY_CHANGED' });
});

test('registered reader reconstructs actual owned presentation mapping and rejects changed plan bytes', async t => {
  const f = await readerTransactionFixture(t, { register: false, preparePresentationOptions: async ({ context, views }) => {
    const rows = language => views[language].sections.flatMap(section => section.paragraphs.flatMap(paragraph => paragraph.spans.map(span => ({ section: section.section_id, span }))));
    const selected = (language, section) => rows(language).find(row => row.section === section && row.span.kind === 'analysis' && !row.span.explain_only).span;
    const labels = Object.fromEntries(['en', 'zh-CN'].map(l => { const span = selected(l, 'study-design'); return [l, { span_id: span.span_id, start: 0, end: span.text.length }]; }));
    const sharedExplanations = context.entityMappings.flatMap(entity => ['en', 'zh-CN'].map(language => ({ entity_id: entity.entity_id, language,
      span_ids: rows(language).filter(({ span }) => span.kind === 'analysis' && entity.definition_unit_refs.some(id => span.semantic_refs.includes(id))).map(({ span }) => span.span_id), support_only_span_ids: [] })));
    return { presentationOptions: { auditDisplay: 'compact', sharedExplanations, researchMap: { schema_version: 'phase221-research-map-1.0', layout: 'staged', edges: [], steps: [{ step_id: 'study', labels,
      design_span_ids: Object.fromEntries(['en', 'zh-CN'].map(l => [l, [selected(l, 'study-design').span_id]])),
      finding_span_ids: Object.fromEntries(['en', 'zh-CN'].map(l => [l, [selected(l, 'key-findings').span_id]])) }] } } };
  } });
  const plan = (({ researchMap, sharedExplanations, auditDisplay }) => ({ researchMap, sharedExplanations, auditDisplay }))(f.sourceInputs.reader.renderer.presentationOptions);
  const broker = createOwnedArtifactBroker({ control_actor_id: 'map-controller', artifact_root: f.artifactRoot,
    authorized_bindings: [{ run_id: f.run, actor_id: 'map-integrator', role: 'integration', artifact_path: 'owned/map.json', revision: 'r1' }] });
  const raw = { presentation_plan: plan, dependencies: { context: f.context.context_fingerprint, views: Object.fromEntries(Object.entries(f.views).map(([l, v]) => [l, fingerprintV3Json(v)])) },
    presentation_dependencies: { context: fingerprintV3Json(f.context), target_registry: fingerprintV3Json(f.sourceInputs.reader.renderer.targetRegistry) } };
  await broker.artifactStore.commitOwnedArtifact({ artifactRoot: f.artifactRoot, dispatchContext: broker.dispatchContext,
    capability: broker.issueCapability({ runId: f.run, actorId: 'map-integrator', role: 'integration', artifactPath: 'owned/map.json', revision: 'r1' }), expectedRevision: 'r1', artifact: { artifact_id: 'map', content: Buffer.from(JSON.stringify(raw)) } });
  f.sourceInputs.reader.presentationPlanReceipt = { artifactRoot: f.artifactRoot, artifactId: 'map' };
  const registered = await registerBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, plan: f.plan, sourceInputs: f.sourceInputs, ...f.authority });
  const loaded = await loadBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, trustAnchor: registered.trust_anchor });
  assert.equal(loaded.reviewManifest.profile, 'phase22-reader-note-1.0');
  await writeFile(join(f.artifactRoot, 'owned/map.json'), JSON.stringify({ ...raw, presentation_plan: { ...plan, auditDisplay: 'full' } }));
  await assert.rejects(loadBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, trustAnchor: registered.trust_anchor }));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'p221-acceptance-'));
  const path = join(root, 'input.json'); await writeFile(path, '{}');
  const proposal = { schema_version: 'phase221-reader-proposal-1.0', package_id: 'synthetic',
    status: 'prepared_not_authorized', evidence_mode: 'synthetic', dispatch_authorized: false,
    prerequisite: { plan07: 'complete' }, bindings: [{ kind: 'source', path, sha256: sha('{}') }],
    current_tools: [{ kind: 'tool', path, sha256: sha('{}') }],
    prior_budget: { eligible_for_reuse: false, status: 'expired_by_recorded_deadline' },
    budget: { status: 'proposed_not_started', min_calls: 12, expected_calls: 12, max_calls: 22, repair_calls: 10,
      max_minutes: 300, started_at: null, deadline: null, deadline_rule: 'first_content_call_started_at + 300 minutes; shared by both papers; never reset' },
    roles: [{ task_id: 'synthetic-writer', model: 'gpt-6.1-sol', reasoning_effort: 'medium', fork_turns: 'none',
      role: 'english-writer', request_path: '05/request.json', native_path: '05/native.json', owned_path: '05/owned.json' }],
    owned_artifact_paths: ['05/request.json', '05/native.json', '05/owned.json'],
    papers: ['05', '01'].map(sample => ({ sample, repairs: Array.from({ length: 16 }, (_, i) => ({ id: 'SR-' + String(i + 1).padStart(2, '0'),
      owner: 'english-writer + chinese-writer', reason: 'Read full actual expression and evidence.', locations: { en: [], 'zh-CN': [] } })),
      visuals: [], abstract: { decision: 'analyst_summary', reason: 'Unstructured original source verified.' } })), blockers: [] };
  proposal.roles = ['05', '01'].flatMap(sample => [
    ['integration', false], ['en', false], ['zh_cn', false], ['parity', false], ['quantity', false], ['post_render', false],
    ['en', true], ['zh_cn', true], ['parity', true], ['quantity', true], ['post_render', true],
  ].map(([stage, optional]) => {
    const id = sample + '-' + stage + (optional ? '-r2' : '-r1');
    return { sample, stage, optional, task_id: id, role: ['integration', 'quantity'].includes(stage) ? 'integration' : stage === 'en' ? 'english-writer' : stage === 'zh_cn' ? 'chinese-writer' : 'bilingual-verifier',
      model: 'gpt-6.1-sol', reasoning_effort: 'medium', fork_turns: 'none',
      request_path: id + '/request.json', native_path: id + '/native.json', owned_path: id + '/owned.json' };
  }));
  proposal.owned_artifact_paths = proposal.roles.flatMap(row => [row.request_path, row.native_path, row.owned_path]);
  return { root, path, proposal };
}
test('preparation checks bytes and does not start or authorize calls', async () => {
  const f = await fixture(), before = await readFile(f.path);
  const result = await checkReaderProposal({ proposal: f.proposal });
  assert.equal(result.ready, true); assert.equal(result.dispatch_authorized, false);
  assert.deepEqual(await readFile(f.path), before); assert.equal(f.proposal.budget.started_at, null);
});

async function reuseFixture() {
  const f = await fixture(), p = f.proposal;
  p.schema_version = 'phase221-single-reader-reuse-proposal-1.0'; p.scope = { samples: ['07'] };
  p.status = 'prepared_for_authorized_continuation'; p.papers = [{ ...p.papers[0], sample: '07' }];
  p.reuse_policy = { mode: 'reuse_completed_analysis', source_first: false, source_reread: false, new_source_blocks: false, old_scientific_roles_rerun: false };
  p.source_inputs = { path: f.path, sha256: sha('{}') }; p.evidence_root = f.root; p.delivery_root = join(f.root, 'delivery');
  p.budget = { ...p.budget, status: 'active', min_calls: 5, expected_calls: 5, repair_calls: 16, prior_calls: 1,
    started_at: '2026-10-18T08:06:37.098Z', deadline: '2026-10-18T13:06:37.098Z',
    deadline_rule: 'first_content_call_started_at + 300 minutes; shared by the declared package; never reset' };
  const stages = ['en', 'zh_cn', 'parity', 'quantity', 'post_render'];
  p.roles = Array.from({ length: 21 }, (_, i) => {
    const task = structuredClone(p.roles[i % p.roles.length]), id = '07-reuse-' + i;
    return { ...task, sample: '07', stage: stages[i % 5], optional: i >= 5, task_id: id,
      request_path: id + '/request.json', native_path: id + '/native.json', owned_path: id + '/owned.json' };
  });
  p.owned_artifact_paths = p.roles.flatMap(row => [row.request_path, row.native_path, row.owned_path]);
  const priorBytes = Buffer.from(JSON.stringify({ package_id: 'discarded-prior-attempt', sample: '07', calls_used: 1,
    started_at: p.budget.started_at, deadline: p.budget.deadline, max_calls: 22, max_minutes: 300 }));
  const priorPath = join(f.root, 'prior-run.json'); await writeFile(priorPath, priorBytes);
  p.prior_consumption = { calls_used: 1, disposition: 'discarded_not_adopted', run: { path: priorPath, sha256: sha(priorBytes) } };
  const proposalSha256 = sha('reuse-proposal');
  const approval = { explicit_user_instruction: true, bound_proposal_sha256: proposalSha256, authorization_id: 'reuse-user-instruction',
    package_id: p.package_id, selected_sample: '07', source_inputs_sha256: p.source_inputs.sha256, requested_model: 'gpt-6.1-sol', requested_reasoning_effort: 'medium',
    evidence_root: p.evidence_root, delivery_root: p.delivery_root, max_calls: 22, max_minutes: 300 };
  const run = { bound_proposal_sha256: proposalSha256, package_id: p.package_id, sample: '07', authorization_id: approval.authorization_id,
    source_inputs_sha256: p.source_inputs.sha256, prior_consumption: p.prior_consumption, calls_used: 1,
    started_at: p.budget.started_at, deadline: p.budget.deadline, max_calls: 22, max_minutes: 300 };
  return { ...f, proposalSha256, approval, run, now: Date.parse(p.budget.started_at) + 60000 };
}

test('single07 reuse needs five reader stages and reuses the original budget without source-first', async () => {
  const f = await reuseFixture(), result = await checkReaderProposal({ proposal: f.proposal });
  assert.equal(result.ready, true, JSON.stringify(result)); assert.equal(result.actual_content_calls, 1);
  assert.equal(result.calls_evidence, 'prior_consumption_snapshot_only');
  assert.equal(checkReaderAuthorization(f).ok, true);
  f.proposal.roles[0].stage = 'source_first';
  assert.ok((await checkReaderProposal({ proposal: f.proposal })).errors.some(row => row.code === 'P221_REUSE_SCIENTIFIC_RERUN_FORBIDDEN'));
});

test('reuse authorization binds the current instruction, package, source, roots and original cutoff', async () => {
  const f = await reuseFixture();
  for (const change of [{ explicit_user_instruction: false }, { selected_sample: '05' }, { package_id: 'old-package' },
    { bound_proposal_sha256: sha('old-proposal') }, { source_inputs_sha256: sha('other-source') }, { delivery_root: 'elsewhere' }, { requested_model: 'fallback' }]) {
    assert.equal(checkReaderAuthorization({ ...f, approval: { ...f.approval, ...change } }).ok, false);
  }
  assert.equal(checkReaderAuthorization({ ...f, run: { ...f.run, started_at: new Date(f.now).toISOString() } }).ok, false);
  assert.equal(checkReaderAuthorization({ ...f, run: { ...f.run, calls_used: 23 } }).ok, false);
  const old = await fixture();
  assert.equal(checkReaderAuthorization({ ...f, proposal: old.proposal }).ok, false);
});

test('discarded prior call is bound budget consumption and cannot supply current reading evidence', async () => {
  const f = await reuseFixture();
  await writeFile(f.proposal.prior_consumption.run.path, '{}');
  assert.equal((await checkReaderProposal({ proposal: f.proposal })).ready, false);
  f.proposal.prior_consumption.disposition = 'reading_pass';
  assert.equal((await checkReaderProposal({ proposal: f.proposal })).ready, false);
  assert.equal(checkReaderAuthorization({ ...f, run: { ...f.run, prior_consumption: { calls_used: 0 } } }).ok, false);
});

async function newWindowFixture() {
  const f = await reuseFixture(), p = f.proposal;
  p.status = 'prepared_not_authorized';
  p.budget = { ...p.budget, status: 'proposed_not_started', min_calls: 5, expected_calls: 5, repair_calls: 5,
    max_calls: 10, max_minutes: 180, prior_calls: 0, started_at: null, deadline: null,
    deadline_rule: 'first_content_call_started_at + 180 minutes; shared by the declared package; never reset' };
  p.roles = p.roles.slice(0, 10); p.owned_artifact_paths = p.roles.flatMap(row => [row.request_path, row.native_path, row.owned_path]);
  const bytes = Buffer.from(JSON.stringify({ package_id: 'old-r2', sample: '07', calls_used: 2,
    started_at: '2026-10-18T08:06:37.098Z', deadline: '2026-10-18T13:06:37.098Z', max_calls: 22, max_minutes: 300 }));
  await writeFile(p.prior_consumption.run.path, bytes);
  p.prior_consumption = { disposition: 'historical_results_adopted_no_budget_credit', calls_used: 2,
    deadline: '2026-10-18T13:06:37.098Z', run: { path: p.prior_consumption.run.path, sha256: sha(bytes) } };
  f.approval = { ...f.approval, explicit_new_budget: true, max_calls: 10, max_minutes: 180 };
  f.run = { ...f.run, prior_consumption: p.prior_consumption, calls_used: 0, max_calls: 10, max_minutes: 180,
    started_at: '2026-10-20T08:00:00.000Z', deadline: '2026-10-20T11:00:00.000Z' };
  f.now = Date.parse(f.run.started_at) + 60000;
  return f;
}

test('new reuse window prepares with zero current calls and historical two calls retained separately', async () => {
  const f = await newWindowFixture(), result = await checkReaderProposal({ proposal: f.proposal });
  assert.equal(result.ready, true, JSON.stringify(result)); assert.equal(result.actual_content_calls, 0);
  assert.equal(result.historical_consumed_calls, 2); assert.equal(checkReaderAuthorization(f).ok, true);
});

async function sourceSupplementFixture() {
  const f = await newWindowFixture(), p = f.proposal;
  p.schema_version = 'phase221-single-reader-source-supplement-proposal-1.0';
  p.reuse_policy = { mode: 'reuse_completed_analysis_with_source_supplement', source_first: false, source_reread: false, new_source_blocks: true, old_scientific_roles_rerun: false };
  p.source_adoptions = [{ sample: '07' }]; p.source_adoption_assembly = [{ sample: '07' }];
  const prior = { package_id: 'old-r5', sample: '07', calls: [{ status: 'completed' }], calls_used: 10, max_calls: 10, max_minutes: 180,
    started_at: '2026-10-20T04:00:00.000Z', deadline: '2026-10-20T07:00:00.000Z' };
  const bytes = Buffer.from(JSON.stringify(prior)); await writeFile(p.prior_consumption.run.path, bytes);
  p.prior_consumption = { ...p.prior_consumption, calls_used: 10, deadline: prior.deadline, run: { path: p.prior_consumption.run.path, sha256: sha(bytes) } };
  f.run.prior_consumption = p.prior_consumption;
  return f;
}

test('source supplement prepares a separate five plus five window retaining ten historical calls', async () => {
  const f = await sourceSupplementFixture(), checked = await checkReaderProposal({ proposal: f.proposal });
  assert.equal(checked.ready, true, JSON.stringify(checked)); assert.equal(checked.actual_content_calls, 0);
  assert.equal(checked.historical_consumed_calls, 10); assert.equal(checkReaderAuthorization(f).ok, true);
  const missingAdoption = structuredClone(f.proposal); missingAdoption.source_adoptions = [];
  assert.equal(checkReaderAuthorization({ ...f, proposal: missingAdoption }).ok, false);
  assert.equal(checkReaderAuthorization({ ...f, run: { ...f.run, started_at: '2026-10-20T06:00:00.000Z', deadline: '2026-10-20T09:00:00.000Z' } }).ok, false);
  for (const mutate of [p => p.source_adoptions = [], p => p.source_adoption_assembly = [], p => p.source_adoptions[0].sample = '05',
    p => p.reuse_policy.source_reread = true, p => p.budget.max_minutes = 300, p => p.schema_version = 'unknown']) {
    const proposal = structuredClone(f.proposal); mutate(proposal); assert.equal((await checkReaderProposal({ proposal })).ready, false);
  }
  const legacy = structuredClone(f.proposal); legacy.schema_version = 'phase221-single-reader-reuse-proposal-1.0';
  assert.equal((await checkReaderProposal({ proposal: legacy })).ready, false);
});

test('source supplement rejects tampered, open, mismatched and impossible historical snapshots', async () => {
  const f = await sourceSupplementFixture(), p = f.proposal;
  const original = JSON.parse(await readFile(p.prior_consumption.run.path));
  for (const change of [{ calls_used: 11 }, { calls_used: 9 }, { calls_used: -1 }, { calls_used: 1.5 }, { calls: [{ status: 'running' }] },
    { sample: '05' }, { package_id: p.package_id }, { started_at: 'bad-date' }, { deadline: '2026-10-20T08:00:00.000Z' }, { max_calls: 9 }]) {
    const bytes = Buffer.from(JSON.stringify({ ...original, ...change })); await writeFile(p.prior_consumption.run.path, bytes);
    p.prior_consumption.run.sha256 = sha(bytes);
    assert.equal((await checkReaderProposal({ proposal: p })).ready, false, JSON.stringify(change));
  }
  await writeFile(p.prior_consumption.run.path, '{}');
  assert.equal((await checkReaderProposal({ proposal: p })).ready, false);
});

async function activeSelectiveRepairFixture() {
  const f=await newWindowFixture(),p=f.proposal;
  const priorRun={package_id:'failed-r4',sample:'07',status:'stopped_dispatch_argument_mismatch',calls_used:1,max_calls:10,max_minutes:180,started_at:f.run.started_at,deadline:f.run.deadline};
  const bytes=Buffer.from(JSON.stringify(priorRun)); await writeFile(p.prior_consumption.run.path,bytes);
  p.prior_consumption={disposition:'discarded_not_adopted',calls_used:1,run:{path:p.prior_consumption.run.path,sha256:sha(bytes)}};
  p.status='prepared_for_authorized_continuation';p.budget={...p.budget,status:'active',prior_calls:1,repair_calls:4,started_at:f.run.started_at,deadline:f.run.deadline};
  p.repair_selection={available_tasks:5,max_calls:4};
  f.run={...f.run,prior_consumption:p.prior_consumption,calls_used:1};
  return f;
}
test('active recovery retains one failed consumed call and offers five registered repairs with four-call selection cap',async()=>{
  const f=await activeSelectiveRepairFixture(),checked=await checkReaderProposal({proposal:f.proposal});
  assert.equal(checked.ready,true,JSON.stringify(checked));assert.equal(checked.actual_content_calls,1);
  assert.equal(checkReaderAuthorization(f).ok,true);
  for(const mutate of [p=>p.repair_selection.max_calls=5,p=>p.repair_selection.available_tasks=6,p=>p.repair_selection.extra=true,
    p=>p.budget.prior_calls=0,p=>p.budget.max_calls=11,p=>p.budget.deadline='2099-01-01T00:00:00Z',p=>p.roles[9].stage=p.roles[8].stage]){
    const p=structuredClone(f.proposal);mutate(p);assert.equal((await checkReaderProposal({proposal:p})).ready,false);
  }
  const noSelection=structuredClone(f.proposal);delete noSelection.repair_selection;
  assert.equal((await checkReaderProposal({proposal:noSelection})).ready,false);
  await writeFile(f.proposal.prior_consumption.run.path,'{}');
  assert.equal((await checkReaderProposal({proposal:f.proposal})).ready,false);
});

test('new reuse window rejects missing numeric approval, old approval and reset old deadline', async () => {
  const f = await newWindowFixture();
  for (const change of [{ explicit_new_budget: undefined }, { explicit_new_budget: false }, { max_calls: 22 },
    { bound_proposal_sha256: sha('old') }, { source_inputs_sha256: sha('other') }, { evidence_root: 'old' }, { requested_model: 'other' }]) {
    assert.equal(checkReaderAuthorization({ ...f, approval: { ...f.approval, ...change } }).ok, false);
  }
  assert.equal(checkReaderAuthorization({ ...f, run: { ...f.run, started_at: '2026-10-18T10:06:37.098Z', deadline: f.proposal.prior_consumption.deadline } }).ok, false);
  assert.equal(checkReaderAuthorization({ ...f, run: { ...f.run, deadline: '2026-10-20T13:00:00.000Z' } }).ok, false);
  f.proposal.roles[0].stage = 'mapping';
  assert.equal((await checkReaderProposal({ proposal: f.proposal })).ready, false);
});

test('new reuse window rejects changed historical RUN or historical consumption', async () => {
  const f = await newWindowFixture();
  f.proposal.prior_consumption.calls_used = 1;
  assert.equal((await checkReaderProposal({ proposal: f.proposal })).ready, false);
  f.proposal.prior_consumption.calls_used = 2;
  await writeFile(f.proposal.prior_consumption.run.path, '{}');
  assert.equal((await checkReaderProposal({ proposal: f.proposal })).ready, false);
});

async function rolePolicyFixture() {
  const f = await newWindowFixture();
  const policy = { version: 'apa-role-model-policy-1.0', main_session: { model: 'gpt-6-astra', reasoning_effort: 'high' } };
  f.proposal.approval = { role_model_policy: policy };
  f.approval = { ...f.approval, role_model_policy: structuredClone(policy), requested_model: 'gpt-6-astra', requested_reasoning_effort: 'high' };
  for (const task of f.proposal.roles) {
    task.role = stageRolesForTest(task.stage);
    if (task.stage !== 'quantity') Object.assign(task, { model: 'gpt-6-astra', reasoning_effort: 'high' });
  }
  return f;
}
const stageRolesForTest = stage => ({ en: 'english-writer', zh_cn: 'chinese-writer', parity: 'bilingual-verifier', post_render: 'bilingual-verifier', quantity: 'integration' })[stage];

test('role policy freezes main Writer and Verifier profiles while quantity retains the project default', async () => {
  const f = await rolePolicyFixture();
  assert.equal((await checkReaderProposal({ proposal: f.proposal })).ready, true);
  assert.equal(checkReaderAuthorization(f).ok, true);
  for (const stage of ['en', 'zh_cn', 'parity', 'post_render', 'quantity']) {
    for (const change of [{ model: 'gpt-6.1-sol', reasoning_effort: 'medium' }, { reasoning_effort: 'low' }, { role: 'evidence' }]) {
      if (stage === 'quantity' && change.model) change.model = 'gpt-6-astra';
      const proposal = structuredClone(f.proposal);
      Object.assign(proposal.roles.find(task => task.stage === stage), change);
      assert.ok((await checkReaderProposal({ proposal })).errors.some(row => row.code === 'P221_MODEL_INVALID'), stage + JSON.stringify(change));
    }
  }
});

test('role policy approval rejects changed frozen policy and stale requested Writer profile', async () => {
  const f = await rolePolicyFixture();
  for (const change of [{ role_model_policy: undefined }, { requested_model: 'gpt-6.1-sol' }, { requested_reasoning_effort: 'medium' },
    { role_model_policy: { ...f.approval.role_model_policy, main_session: { model: 'gpt-6-astra', reasoning_effort: 'medium' } } }]) {
    assert.equal(checkReaderAuthorization({ ...f, approval: { ...f.approval, ...change } }).ok, false);
  }
  f.proposal.approval.role_model_policy.version = 'unknown';
  assert.equal((await checkReaderProposal({ proposal: f.proposal })).ready, false);
  assert.equal(checkReaderAuthorization(f).ok, false);
});

test('role policy follows a different explicit main session without changing mapping or quantity', async () => {
  const f = await rolePolicyFixture(), main = { model: 'gpt-6-sol', reasoning_effort: 'xhigh' };
  f.proposal.approval.role_model_policy.main_session = main;
  f.approval = { ...f.approval, role_model_policy: structuredClone(f.proposal.approval.role_model_policy),
    requested_model: main.model, requested_reasoning_effort: main.reasoning_effort };
  for (const task of f.proposal.roles.filter(task => task.stage !== 'quantity')) Object.assign(task, main);
  assert.equal((await checkReaderProposal({ proposal: f.proposal })).ready, true);
  assert.equal(checkReaderAuthorization(f).ok, true);
  // Mapping is available only in an active legacy reuse window, with its original budget.
  const active = await reuseFixture();
  active.proposal.approval = structuredClone(f.proposal.approval);
  for (const task of active.proposal.roles) {
    task.role = stageRolesForTest(task.stage);
    if (task.stage !== 'quantity') Object.assign(task, main);
  }
  Object.assign(active.proposal.roles[5], { stage: 'mapping', role: 'integration', model: 'gpt-6.1-sol', reasoning_effort: 'medium' });
  assert.equal((await checkReaderProposal({ proposal: active.proposal })).ready, true);
  active.proposal.roles[5].model = main.model;
  assert.ok((await checkReaderProposal({ proposal: active.proposal })).errors.some(row => row.code === 'P221_MODEL_INVALID'));
});

test('runtime policy must match the proposal and approval Writer profile exactly', async () => {
  const { verifyReaderRuntimeBinding } = await import('../../scripts/v3/phase221-acceptance.mjs');
  const f = await rolePolicyFixture(), policy = f.approval.role_model_policy;
  const binding = { requested_model: 'gpt-6-astra', requested_reasoning: 'high', role_model_policy: structuredClone(policy),
    authorization_id: f.approval.authorization_id, deadline: f.run.deadline };
  const checkpoint = { authorization_id: f.approval.authorization_id, deadline: f.run.deadline, max_calls: 10, calls_used: 0 };
  const args = { proposal: f.proposal, authorization: f.approval, run: f.run, binding, checkpoint };
  assert.equal(verifyReaderRuntimeBinding(args), true);
  for (const change of [{ requested_model: 'gpt-6.1-sol' }, { requested_reasoning: 'medium' }, { role_model_policy: undefined },
    { role_model_policy: { ...policy, main_session: { model: 'gpt-6-astra', reasoning_effort: 'medium' } } }]) {
    assert.throws(() => verifyReaderRuntimeBinding({ ...args, binding: { ...binding, ...change } }), { code: 'P221_RUNTIME_AUTHORIZATION_MISMATCH' });
  }
  assert.throws(() => verifyReaderRuntimeBinding({ ...args, authorization: { ...f.approval, role_model_policy: undefined } }), { code: 'P221_RUNTIME_AUTHORIZATION_MISMATCH' });
});

async function externalLedgerFixture(newWindow = false, supplement = false) {
  const f = await (supplement ? sourceSupplementFixture() : newWindow ? newWindowFixture() : reuseFixture()), p = f.proposal, root = join(f.root, 'controller'); await mkdir(root);
  if (!newWindow) {
    p.roles[5] = { ...p.roles[5], optional: false, stage: 'mapping', role: 'integration' };
    p.budget.expected_calls = p.budget.min_calls = 6; p.budget.repair_calls = 15;
  }
  f.run.completed_at = new Date(f.now + 60000).toISOString();
  const externalRoles = [];
  for (const task of newWindow ? [p.roles[3]] : [p.roles[3], p.roles[5]]) {
    task.role = 'integration';
    const id = task.task_id, input = { path: join(root, id + '-input.json') };
    const spec = task.external_evidence = { artifact_root: root, artifact_id: id, owner_actor_id: id, control_actor_id: 'synthetic-controller',
      run_id: 'synthetic-run', revision: 'r2', input, input_artifact_id: id + '-input', scientific_input_fingerprint: sha('science') };
    for (const kind of ['request', 'packet', 'step', 'host', 'seal']) {
      spec[kind + '_artifact_id'] = id + '-' + kind;
      if (kind !== 'request') spec[kind + '_path'] = id + '-' + kind + '.json';
    }
    const inputBytes = Buffer.from('{}'), request = { package_id: p.package_id, sample: '07', identity: { run_id: spec.run_id }, task_id: id, task_name: id.replaceAll('-', '_'), artifact_id: id,
      owner_actor_id: id, role: 'integration', revision: 'r2', input: { ...input, sha256: sha(inputBytes) }, scientific_input_fingerprint: spec.scientific_input_fingerprint,
      authorization_id: f.approval.authorization_id, shared_started_at: f.run.started_at, deadline: f.run.deadline, max_calls: p.budget.max_calls, evidence_mode: 'actual',
      allowed_output: { native_path: task.native_path, owned_path: task.owned_path } };
    const requestBytes = Buffer.from(JSON.stringify(request)), args = { task_name: id.replaceAll('-', '_'), message: 'Synthetic bounded role.', model: task.model, reasoning_effort: task.reasoning_effort, fork_turns: task.fork_turns };
    const packet = { run_id: spec.run_id, user_approval_id: f.approval.authorization_id, intended_evidence_tier: 'host_observation',
      source: { ...request.input, byte_length: inputBytes.length }, instruction_fingerprint: sha(args.message), configuration_fingerprint: sha('configuration'), allowed_output_root: root,
      backend: { identity: 'current-collaboration', version: 'test', runtime_configuration_version: 'test', configuration: { request_sha256: sha(requestBytes), input_sha256: sha(inputBytes) } },
      endpoint: { value: 'current-session', egress: 'approved', retention: 'approved' },
      host_action_scope: { action: 'collaboration.spawn_agent', arguments: args, role: 'integration', output_path: join(root, task.native_path), result_bindings: { agent_id: ['task_name'] }, permitted_result_fields: ['agent_id', 'raw_result_text'] },
      expected_resource_fields: ['tool_calls'], requested_model: task.model, observed_model: 'unknown', estimate: { value: 1, unit: 'tool_calls' }, approved_budget_cap: { value: p.budget.max_calls, unit: 'tool_calls' }, retry_allowance: 0 };
    packet.configuration_fingerprint = fingerprintV3Json(packet.backend.configuration);
    const step = emitApprovedRunStep({ packet, run: { run_id: spec.run_id }, dispatchContext: {}, approvedBudget: packet.approved_budget_cap, retryPolicy: { max_retries: 0 } });
    const host = ingestObservedRunStep({ packet, emittedStep: step, observation: { action_id: step.action_id, run_id: spec.run_id, input_fingerprint: step.input_fingerprint,
      port: 'current-collaboration', tool_call: { name: step.action, arguments: args }, raw_result_text: JSON.stringify({ task_name: id + '-agent' }) },
      run: { run_id: spec.run_id }, now: new Date(f.now - 30000).toISOString() });
    assert.equal(host.status, 'observed');
    const raw = Buffer.from('{}'), completion = { agent_id: host.agent_id, task_id: id, call_id: id + '-call', return_id: id + '-return', completed_at: new Date(f.now).toISOString() };
    const seal = { schema_version: `phase221-reuse-${task.stage}-seal-1.0`, package_id: p.package_id, task_id: id,
      request_sha256: sha(requestBytes), input_sha256: sha(inputBytes), raw_return_sha256: sha(raw), completion, hostObservation: host };
    const records = [{ id: spec.input_artifact_id, path: id + '-input.json', bytes: inputBytes, role: 'control' },
      ...Object.entries({ request: requestBytes, packet: Buffer.from(JSON.stringify(packet)), step: Buffer.from(JSON.stringify(step)), host: Buffer.from(JSON.stringify(host)), seal: Buffer.from(JSON.stringify(seal)) })
        .map(([kind, bytes]) => ({ id: spec[kind + '_artifact_id'], path: kind === 'request' ? task.request_path : spec[kind + '_path'], bytes, role: 'control' })),
      { id, path: task.owned_path, bytes: raw, role: 'integration' }];
    const broker = createOwnedArtifactBroker({ control_actor_id: spec.control_actor_id, artifact_root: root,
      authorized_bindings: records.map(row => ({ run_id: spec.run_id, actor_id: row.role === 'control' ? spec.control_actor_id : id, role: row.role, artifact_path: row.path, revision: 'r2' })) });
    for (const row of records) await broker.artifactStore.commitOwnedArtifact({ artifactRoot: root, dispatchContext: broker.dispatchContext,
      capability: broker.issueCapability({ runId: spec.run_id, actorId: row.role === 'control' ? spec.control_actor_id : id, role: row.role, artifactPath: row.path, revision: 'r2' }), expectedRevision: 'r2', artifact: { artifact_id: row.id, content: row.bytes } });
    await mkdir(dirname(join(root, task.native_path)), { recursive: true }); await writeFile(join(root, task.native_path), raw);
    externalRoles.push({ task_id: id, ...Object.fromEntries(['request', 'packet', 'step', 'host', 'seal'].map(kind => {
      const row = records.find(item => item.id === spec[kind + '_artifact_id']); return [kind, { path: join(root, row.path), sha256: sha(row.bytes) }];
    })) });
  }
  const languageTasks = p.roles.filter(task => !task.optional && !task.external_evidence).map(task => ({ task_id: task.task_id, call_id: task.task_id + '-call', return_id: task.task_id + '-return' }));
  f.run.calls = [...languageTasks, ...externalRoles.map(row => ({ task_id: row.task_id, call_id: row.task_id + '-call', return_id: row.task_id + '-return' }))]; f.run.calls_used = p.budget.prior_calls + f.run.calls.length;
  return { proposal: p, externalRoles, languageTasks, authorization: f.approval, run: f.run };
}

test('new reuse window ledger counts only current language and owned quantity calls', async () => {
  const args = await externalLedgerFixture(true);
  assert.deepEqual(await verifyReaderCallLedger(args), { calls_used: 5, prior_calls: 0, current_calls: 5 });
  assert.equal(args.externalRoles.length, 1);
  await assert.rejects(verifyReaderCallLedger({ ...args, externalRoles: [] }), { code: 'P221_AGGREGATE_CALL_LEDGER_INVALID' });
  await assert.rejects(verifyReaderCallLedger({ ...args, run: { ...args.run, calls_used: 7 } }), { code: 'P221_AGGREGATE_CALL_LEDGER_INVALID' });
  await assert.rejects(verifyReaderCallLedger({ ...args, run: { ...args.run, calls: args.run.calls.slice(1) } }), { code: 'P221_AGGREGATE_CALL_LEDGER_INVALID' });
  const languageTasks = [...args.languageTasks, args.languageTasks[0]];
  await assert.rejects(verifyReaderCallLedger({ ...args, languageTasks }), { code: 'P221_AGGREGATE_CALL_LEDGER_INVALID' });
});

test('source supplement ledger retains ten historical calls outside the five current calls', async () => {
  const args = await externalLedgerFixture(true, true);
  assert.deepEqual(await verifyReaderCallLedger(args), { calls_used: 5, prior_calls: 0, current_calls: 5 });
  assert.equal(args.proposal.prior_consumption.calls_used, 10);
  await assert.rejects(verifyReaderCallLedger({ ...args, run: { ...args.run, calls_used: 15 } }), { code: 'P221_AGGREGATE_CALL_LEDGER_INVALID' });
});

test('external role ledger counts owned mapping and quantity alongside language calls', async () => {
  const args = await externalLedgerFixture();
  assert.deepEqual(await verifyReaderCallLedger(args), { calls_used: 7, prior_calls: 1, current_calls: 6 });
});

test('new presentation call ledger rejects an Integrator call that omitted canonical prompt binding', async () => {
  const args = await externalLedgerFixture(true);
  args.proposal.presentation_requirements = { mapping_source: 'owned_integration' };
  await assert.rejects(verifyReaderCallLedger(args), { code: 'P221_PRESENTATION_PROMPT_UNBOUND' });
});

test('external role ledger rejects missing, forged, duplicate or unowned calls', async () => {
  const args = await externalLedgerFixture();
  await assert.rejects(verifyReaderCallLedger({ ...args, externalRoles: args.externalRoles.slice(1) }), { code: 'P221_AGGREGATE_CALL_LEDGER_INVALID' });
  await assert.rejects(verifyReaderCallLedger({ ...args, run: { ...args.run, calls_used: 8 } }), { code: 'P221_AGGREGATE_CALL_LEDGER_INVALID' });
  await assert.rejects(verifyReaderCallLedger({ ...args, externalRoles: [...args.externalRoles, args.externalRoles[0]] }), { code: 'P221_AGGREGATE_CALL_LEDGER_INVALID' });
  const forged = structuredClone(args.externalRoles); forged[0].host = forged[1].host;
  await assert.rejects(verifyReaderCallLedger({ ...args, externalRoles: forged }), { code: 'P221_EXTERNAL_ROLE_UNBOUND' });
  const task = args.proposal.roles.find(row => row.task_id === args.externalRoles[0].task_id);
  await writeFile(join(task.external_evidence.artifact_root, task.native_path), '{"forged":true}');
  await assert.rejects(verifyReaderCallLedger(args), { code: 'P221_EXTERNAL_ROLE_OWNERSHIP_INVALID' });
});

test('stale source and tool fingerprints block preparation', async () => {
  const f = await fixture(); await writeFile(f.path, 'changed');
  const result = await checkReaderProposal({ proposal: f.proposal });
  assert.equal(result.ready, false); assert.ok(result.errors.some(row => row.code === 'P221_PROPOSAL_BYTES_CHANGED'));
});
for (const [label, mutate, code] of [
  ['unfinished07', p => p.prerequisite.plan07 = 'pending', 'P221_PLAN07_PENDING'],
  ['expired reuse', p => p.prior_budget.eligible_for_reuse = true, 'P221_OLD_BUDGET_NOT_REUSABLE'],
  ['unresolved budget', p => p.budget.max_calls = null, 'P221_BUDGET_INVALID'],
  ['missing paths', p => p.roles[0].native_path = null, 'P221_ROLE_PATH_INVALID'],
  ['model substitution', p => p.roles[0].model = 'fallback', 'P221_MODEL_INVALID'],
  ['missing required visual', p => p.papers[0].visuals.push({ required: true, readiness: 'not_inspected' }), 'P221_VISUAL_NOT_READY'],
  ['unknown abstract', p => p.papers[0].abstract.decision = 'unknown', 'P221_ABSTRACT_UNRESOLVED'],
  ['count-only obligations', p => p.papers[0].repairs[2].reason = '', 'P221_REPAIR_UNRESOLVED'],
  ['unbudgeted post-render', p => p.roles = p.roles.filter(row => row.stage !== 'post_render'), 'P221_ROLE_BUDGET_UNBOUND'],
  ['aliased owned paths', p => p.roles[1].owned_path = p.roles[0].owned_path, 'P221_ROLE_PATH_INVALID'],
]) test(label + ' cannot be marked ready', async () => {
  const f = await fixture(); mutate(f.proposal);
  const result = await checkReaderProposal({ proposal: f.proposal });
  assert.equal(result.ready, false); assert.ok(result.errors.some(row => row.code === code), JSON.stringify(result));
});
test('new approval is exact-hash bound and has one shared immutable cutoff', async () => {
  const f = await fixture(), now = Date.now(), proposalSha256 = sha('proposal');
  const approval = { proposal_sha256: proposalSha256, explicit_user_approval: true, max_calls: 22, max_minutes: 300 };
  const run = { proposal_sha256: proposalSha256, started_at: new Date(now - 1000).toISOString(), deadline: new Date(now - 1000 + 300 * 60000).toISOString(), calls_used: 1 };
  assert.equal(checkReaderAuthorization({ proposal: f.proposal, proposalSha256, approval, run, now }).ok, true);
  for (const change of [{ explicit_user_approval: false }, { proposal_sha256: sha('other') }]) {
    assert.equal(checkReaderAuthorization({ proposal: f.proposal, proposalSha256, approval: { ...approval, ...change }, run, now }).ok, false);
  }
  assert.equal(checkReaderAuthorization({ proposal: f.proposal, proposalSha256, approval, run, now: now + 301 * 60000 }).ok, false);
  assert.equal(checkReaderAuthorization({ proposal: f.proposal, proposalSha256, approval, run: { ...run, deadline: new Date(now + 301 * 60000).toISOString() }, now }).ok, false);
});

test('trusted array pointer binds decoded SPKI rather than a candidate offered key', async () => {
  const f = await fixture(), { publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' }), anchor = { public_key: der.toString('base64') };
  const bytes = Buffer.from(JSON.stringify([anchor])); await writeFile(f.path, bytes);
  const binding = { path: f.path, sha256: sha(bytes), array_index: 0, expected_key_fingerprint: sha(der) };
  assert.deepEqual(await readReaderTrustAnchor(binding), anchor);
  await assert.rejects(readReaderTrustAnchor({ ...binding, expected_key_fingerprint: sha('wrong') }), { code: 'P221_TRUST_ANCHOR_CHANGED' });
});

test('summary-only reading record cannot establish actual acceptance', async () => {
  const f = await fixture(); await writeFile(join(f.root, 'PROPOSAL.json'), JSON.stringify(f.proposal));
  const path = join(f.root, 'READING-ACCEPTANCE.json'); await writeFile(path, JSON.stringify({ ok: true, accepted: true, reading_gates: { completeness: 'pass', readability: 'pass' } }));
  const result = await checkReaderAcceptance({ recordPath: path, evidenceRoot: f.root });
  assert.equal(result.ok, false); assert.equal(result.content_reading_accepted, false);
});

test('fresh signed reader reconstruction consumes full owned review while preserving native not_run', async t => {
  const f = await readerTransactionFixture(t), path = join(f.artifactRoot, 'acceptance-anchor.json');
  const bytes = Buffer.from(JSON.stringify(f.registration.trust_anchor)); await writeFile(path, bytes);
  const trustAnchorBinding = { path, sha256: sha(bytes), expected_key_fingerprint: sha(Buffer.from(f.registration.trust_anchor.public_key, 'base64')) };
  const registration = { vaultRoot: f.vaultRoot, run: f.run };
  const pointer = JSON.parse(await readFile(join(f.vaultRoot, f.registration.registration_path)));
  const bundle = JSON.parse(await readFile(join(f.vaultRoot, pointer.bundle.path)));
  assert.equal(bundle.schema_version, 'phase22-registered-publication-2.0');
  assert.equal(bundle.reader_recipe, undefined);
  const loaded = await inspectRegisteredReaderEvidence({ registration, trustAnchorBinding });
  assert.deepEqual(loaded.runtimeBinding, bundle.reader_evidence.runtimeBinding);
  assert.deepEqual(loaded.renderer, bundle.reader_evidence.renderer);
  assert.deepEqual(loaded.presentationPlanProof, bundle.reader_evidence.presentationPlanProof);
  assert.deepEqual(loaded.reviewManifest.reading_gates, f.review.reviewManifest.reading_gates);
  assert.equal(loaded.reviewManifest.reading_gates.native_presentation, 'not_run');
  assert.equal(loaded.reviewManifest.reading_gates.completeness, 'block');
  assert.equal(loaded.reviewManifest.reading_accepted, false);
  assert.equal(loaded.reviewManifest.evidence_mode, 'synthetic');
  const owned = f.ownedReview.receipt;
  const receiptPath = join(owned.artifactRoot, '.phase21-receipts', encodeURIComponent(owned.artifactId) + '.json');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  const reviewPath = join(owned.artifactRoot, receipt.path), original = await readFile(reviewPath), review = JSON.parse(original);
  review.reviewed_ranges = review.reviewed_ranges.slice(0, -1);
  await writeFile(reviewPath, JSON.stringify(review));
  await assert.rejects(inspectRegisteredReaderEvidence({ registration, trustAnchorBinding }));
});

async function sourceDeltaFixture(scientificInput, root) {
  const path = join(root, 'existing-source-page.json'), text = 'Header\nExact synthetic abstract paragraph.\nKeywords';
  const bytes = Buffer.from(JSON.stringify([{ text }])); await writeFile(path, bytes);
  const doc = scientificInput.source_package.source_documents[0];
  const file = { path, sha256: sha(bytes) }, start = text.indexOf('Exact'), end = text.indexOf('\nKeywords');
  const proposal = { bindings: [file], source_adoptions: [{ sample: '05', original_input_fingerprint: scientificInput.input_fingerprint, file, pointer: '/0/text', start, end,
    text_sha256: sha(Buffer.from(text.slice(start, end))), source_document_id: doc.source_document_id, source_hash: doc.source_hash,
    source_block_id: 'srcblock_' + sha('p221-source-abstract').slice(7, 39), block_id: 'p221-abstract', page_index: 0, role: scientificInput.scientific_details.source_blocks[0].role }] };
  const proposalBytes = Buffer.from(JSON.stringify(proposal)), approval = { explicit_user_approval: true, authorization_id: 'synthetic-new-approval', proposal_sha256: sha(proposalBytes) };
  return { proposal, proposalBytes, approval, sample: '05', scientificInput, path };
}

test('exact source-only delta passes the actual controlled producer and handoff consumer', async t => {
  const root = await mkdtemp(join(tmpdir(), 'p221-source-delta-')); let original, derived;
  const f = await createPhase22Fixture({ t, mutateScientificInput: async input => {
    original = structuredClone(input);
    derived = await deriveReaderSourceOnlyInput(await sourceDeltaFixture(input, root)).catch(error => { error.message += ': ' + JSON.stringify(error.details); throw error; });
    Object.assign(input, derived.scientificInput);
  } });
  const admitted = await consumePhase21Handoff({ ...f, phase22Validator: await createPhase22ContractValidator() });
  assert.equal(admitted.ok, true, JSON.stringify(admitted.errors));
  const science = getReadingBasisContent(admitted.basis);
  assert.equal(science.scientific_details.source_blocks.at(-1).text, 'Exact synthetic abstract paragraph.');
  assert.deepEqual(science.scientific_details.required_semantic_units, original.scientific_details.required_semantic_units);
  assert.deepEqual(science.reading_card, original.reading_card);
  assert.deepEqual(science.core, original.core);
  assert.equal(derived.sourceDelta.new_role_execution, false);
  assert.equal(admitted.basis.publishable, false);
});

test('source delta refuses changed files, drifted ranges and non-source scientific changes', async t => {
  const f = await createPhase22Fixture({ t }), args = await sourceDeltaFixture(f.scientificInput, f.artifactRoot);
  const derived = await deriveReaderSourceOnlyInput(args).catch(error => { error.message += ': ' + JSON.stringify(error.details); throw error; });
  const originalArtifact = { scientific_input_fingerprint: f.scientificInput.input_fingerprint, content: { finding: 'Unchanged synthetic finding.' }, qualification: { status: 'partial' }, source_seal: 'retained' };
  const sourceBinding = { path: join(f.artifactRoot, 'prior-role.json'), sha256: sha(JSON.stringify(originalArtifact)) };
  await writeFile(sourceBinding.path, JSON.stringify(originalArtifact));
  const adopted = await adoptReaderSourceOnlyDelta({ original: f.scientificInput, derived: derived.scientificInput, artifact: originalArtifact, sourceBinding, sourceDelta: derived.sourceDelta });
  const { scientific_input_fingerprint, p221_source_only_delta_adoption, ...body } = adopted;
  const { scientific_input_fingerprint: oldFingerprint, ...originalBody } = originalArtifact;
  assert.deepEqual(body, originalBody); assert.equal(p221_source_only_delta_adoption.new_role_execution, false);
  await assert.rejects(adoptReaderSourceOnlyDelta({ original: f.scientificInput, derived: derived.scientificInput, artifact: originalArtifact, sourceBinding, sourceDelta: structuredClone(derived.sourceDelta) }), { code: 'P221_SOURCE_ADOPTION_BINDING_INVALID' });
  const changed = structuredClone(derived.scientificInput); changed.core.units[0].statement = 'Changed science'; changed.input_fingerprint = fingerprintScientificInput(changed);
  await assert.rejects(adoptReaderSourceOnlyDelta({ original: f.scientificInput, derived: changed, artifact: originalArtifact, sourceBinding, sourceDelta: derived.sourceDelta }), { code: 'P221_SOURCE_DELTA_CHANGED_SCIENCE' });
  await assert.rejects(adoptReaderSourceOnlyDelta({ original: f.scientificInput, derived: derived.scientificInput, artifact: { ...originalArtifact, source_seal: 'changed' }, sourceBinding, sourceDelta: derived.sourceDelta }), { code: 'P221_SOURCE_ADOPTION_ARTIFACT_CHANGED' });
  const altered = structuredClone(args.proposal); altered.source_adoptions[0].start++;
  const bytes = Buffer.from(JSON.stringify(altered));
  await assert.rejects(deriveReaderSourceOnlyInput({ ...args, proposalBytes: bytes, approval: { ...args.approval, proposal_sha256: sha(bytes) } }), { code: 'P221_SOURCE_RANGE_CHANGED' });
  await writeFile(args.path, '[]');
  await assert.rejects(deriveReaderSourceOnlyInput(args), { code: 'P221_PROPOSAL_BYTES_CHANGED' });
});

test('registered historical roles are adopted without changing their body and consumed through a fresh proof chain', async t => {
  const f = await createRegisteredHistoricalFixture(t);
  await readHistoricalReaderInput(f.args);
  const args = await sourceDeltaFixture(f.scientificInput, f.artifactRoot), root = join(f.artifactRoot, 'new-source-adoption');
  const artifacts = f.currentControl.run.chain.artifacts.map(row => ({ artifact_id: row.artifact_id, source_artifact_id: row.artifact_id,
    role: f.currentControl.registry[row.artifact_id].role, path: 'adopted/' + row.artifact_id + '.json', revision: 'p221-r1' }));
  artifacts.push({ artifact_id: 'p221-current-science', role: 'control', path: 'current/science.json', revision: 'p221-r1' },
    { artifact_id: 'p221-current-producer', role: 'control', path: 'current/handoff.json', revision: 'p221-r1' });
  args.proposal.source_adoption_assembly = [{ sample: '05', artifact_root: root, root_relative: 'new-source-adoption',
    controller_actor_id: 'synthetic-p221-adoption-controller', artifacts, scientific_input_artifact_id: 'p221-current-science',
    producer_artifact_id: 'p221-current-producer', source_check_artifact_id: 'source-check' }];
  args.proposal.owned_artifact_paths = artifacts.map(row => 'new-source-adoption/' + row.path);
  args.proposalBytes = Buffer.from(JSON.stringify(args.proposal)); args.approval.proposal_sha256 = sha(args.proposalBytes);
  const derived = await deriveReaderSourceOnlyInput(args);
  const assembled = await assembleReaderSourceAdoption({ prior: f, original: f.scientificInput, derived: derived.scientificInput,
    sourceDelta: derived.sourceDelta, proposalBytes: args.proposalBytes, approval: args.approval, sample: '05', phase22Validator: await createPhase22ContractValidator() })
    .catch(error => { error.message += ': ' + JSON.stringify(error.details); throw error; });
  assert.equal(assembled.ok, true); assert.equal(assembled.new_role_execution, false);
  assert.equal(assembled.run.chain.delivery_status, 'deliverable');
  const source = getReadingBasisContent(assembled.basis);
  assert.equal(source.scientific_details.source_blocks.at(-1).text, 'Exact synthetic abstract paragraph.');
  for (const row of artifacts.filter(row => ['evidence', 'methods', 'results', 'interpretation', 'scientific-reading', 'integration'].includes(row.role))) {
    const oldBytes = (await f.artifactResolver(row.artifact_id)).bytes;
    const current = (await assembled.artifactResolver(row.artifact_id)).bytes;
    const { scientific_input_fingerprint: oldFingerprint, ...oldBody } = JSON.parse(oldBytes);
    const { scientific_input_fingerprint: newFingerprint, p221_source_only_delta_adoption, ...newBody } = JSON.parse(current);
    assert.deepEqual(newBody, oldBody); assert.equal(p221_source_only_delta_adoption.new_role_execution, false);
    assert.notEqual(newFingerprint, oldFingerprint);
    assert.deepEqual((await f.artifactResolver(row.artifact_id)).bytes, oldBytes);
  }
});

test('source supplement assembles only appended same-source excerpts and preserves legacy rejection', async t => {
  const f = await createRegisteredHistoricalFixture(t), window = await sourceSupplementFixture();
  const delta = await sourceDeltaFixture(f.scientificInput, f.artifactRoot), p = window.proposal;
  p.bindings.push(...delta.proposal.bindings);
  p.source_adoptions = delta.proposal.source_adoptions.map(row => ({ ...row, sample: '07' }));
  const artifacts = f.currentControl.run.chain.artifacts.map(row => ({ artifact_id: row.artifact_id, source_artifact_id: row.artifact_id,
    role: f.currentControl.registry[row.artifact_id].role, path: 'adopted/' + row.artifact_id + '.json', revision: 'p221-r1' }));
  artifacts.push({ artifact_id: 'supplement-science', role: 'control', path: 'current/science.json', revision: 'p221-r1' },
    { artifact_id: 'supplement-producer', role: 'control', path: 'current/handoff.json', revision: 'p221-r1' });
  p.source_adoption_assembly = [{ sample: '07', artifact_root: join(f.artifactRoot, 'supplement'), root_relative: 'supplement',
    controller_actor_id: 'supplement-controller', artifacts, scientific_input_artifact_id: 'supplement-science',
    producer_artifact_id: 'supplement-producer', source_check_artifact_id: 'source-check' }];
  p.owned_artifact_paths.push(...artifacts.map(row => 'supplement/' + row.path));
  const proposalBytes = Buffer.from(JSON.stringify(p)), approval = { ...window.approval, bound_proposal_sha256: sha(proposalBytes) };
  const derived = await deriveReaderSourceOnlyInput({ scientificInput: f.scientificInput, proposalBytes, approval, sample: '07' });
  const args = { prior: f, original: f.scientificInput, derived: derived.scientificInput, sourceDelta: derived.sourceDelta,
    proposalBytes, approval, sample: '07', phase22Validator: await createPhase22ContractValidator() };
  const legacy = { ...p, schema_version: 'phase221-single-reader-reuse-proposal-1.0' }, legacyBytes = Buffer.from(JSON.stringify(legacy));
  await assert.rejects(assembleReaderSourceAdoption({ ...args, proposalBytes: legacyBytes, approval: { ...approval, bound_proposal_sha256: sha(legacyBytes) } }), { code: 'P221_REUSE_SOURCE_CHANGE_FORBIDDEN' });
  const changed = structuredClone(derived.scientificInput); changed.core.units[0].statement = 'Changed science'; changed.input_fingerprint = fingerprintScientificInput(changed);
  await assert.rejects(assembleReaderSourceAdoption({ ...args, derived: changed }), { code: 'P221_SOURCE_DELTA_CHANGED_SCIENCE' });
  const changedDoc = structuredClone(derived.scientificInput); changedDoc.source_package.source_documents[0].source_hash = sha('background'); changedDoc.input_fingerprint = fingerprintScientificInput(changedDoc);
  await assert.rejects(assembleReaderSourceAdoption({ ...args, derived: changedDoc }), { code: 'P221_SOURCE_DELTA_CHANGED_SCIENCE' });
  const assembled = await assembleReaderSourceAdoption(args);
  assert.equal(assembled.ok, true); assert.equal(assembled.new_role_execution, false);
  const science = getReadingBasisContent(assembled.basis);
  assert.deepEqual(science.core, f.scientificInput.core);
  assert.deepEqual(science.reading_card, f.scientificInput.reading_card);
  assert.equal(science.scientific_details.source_blocks.at(-1).text, 'Exact synthetic abstract paragraph.');
});

test('candidate readback requires every asset, support and index payload, excluding only transaction internals', async t => {
  const f = await readerTransactionFixture(t, readerAssetOptions()), evidenceRoot = join(f.artifactRoot, 'saved-candidate');
  await mkdir(evidenceRoot); const outputs = [], ownedPaths = [];
  for (const [index, row] of f.plan.inventory.entries()) {
    if (['history', 'commit'].includes(row.kind)) continue;
    const saved_path = 'payload-' + index + '.bin'; await writeFile(join(evidenceRoot, saved_path), row.bytes);
    outputs.push({ path: row.path, saved_path, sha256: row.byte_sha256 }); ownedPaths.push(saved_path);
  }
  const args = { plan: f.plan, outputs, ownedPaths, evidenceRoot };
  const result = await verifyReaderDeliverables(args); assert.equal(result.checked_files, outputs.length);
  const asset = f.plan.inventory.find(row => row.kind === 'asset'); assert.ok(asset);
  await assert.rejects(verifyReaderDeliverables({ ...args, outputs: outputs.filter(row => row.path !== asset.path) }), error => error.code === 'P221_COMPLETE_OUTPUT_REQUIRED' && error.details.kind === 'asset');
  const support = f.plan.inventory.find(row => row.kind === 'support'); assert.ok(support);
  await assert.rejects(verifyReaderDeliverables({ ...args, outputs: outputs.filter(row => row.path !== support.path) }), error => error.code === 'P221_COMPLETE_OUTPUT_REQUIRED' && error.details.kind === 'support');
  const index = f.plan.inventory.find(row => row.kind === 'index'); assert.ok(index);
  await assert.rejects(verifyReaderDeliverables({ ...args, outputs: outputs.filter(row => row.path !== index.path) }), error => error.code === 'P221_COMPLETE_OUTPUT_REQUIRED' && error.details.kind === 'index');
  const mirrorRoot = join(f.artifactRoot, 'fixed-display-root'), mirrored = [];
  for (const row of f.plan.inventory.filter(row => !['history', 'commit'].includes(row.kind))) {
    await mkdir(dirname(join(mirrorRoot, row.path)), { recursive: true }); await writeFile(join(mirrorRoot, row.path), row.bytes);
    mirrored.push({ path: row.path, sha256: row.byte_sha256 });
  }
  const mirrorArgs = { plan: f.plan, outputs: mirrored, outputRoot: mirrorRoot,
    fixedTargets: f.plan.inventory.filter(row => row.kind !== 'reading-review').map(row => row.path), contentAddressedTargets: [f.review.reviewManifest.reading_review.path] };
  assert.equal((await verifyReaderDeliverables(mirrorArgs)).checked_files, mirrored.length);
  await assert.rejects(verifyReaderDeliverables({ ...mirrorArgs, outputs: mirrored.map((row, index) => index ? row : { ...row, saved_path: '../elsewhere' }) }), { code: 'P221_OUTPUT_PATH_NOT_APPROVED' });
  await assert.rejects(verifyReaderDeliverables({ ...mirrorArgs, outputRoot: evidenceRoot }));
});

test('unchanged source-evidence input is copied as exact stored bytes and preserves partial/parser limits', async t => {
  const f = await createPhase22Fixture({ t, profile: 'source-evidence' });
  const artifacts = f.currentControl.run.chain.artifacts.map(row => ({ artifact_id: row.artifact_id, role: f.currentControl.registry[row.artifact_id].role,
    path: 'adopted/' + row.artifact_id + '.json', revision: f.currentControl.registry[row.artifact_id].revision }));
  artifacts.push({ artifact_id: 'new-science', role: 'control', path: 'current/science.json', revision: 'p221-r1' },
    { artifact_id: 'new-producer', role: 'control', path: 'current/handoff.json', revision: 'p221-r1' });
  const proposal = { owned_artifact_paths: artifacts.map(row => 'same-input/' + row.path), source_adoption_assembly: [{ sample: '01',
    artifact_root: join(f.artifactRoot, 'same-input'), root_relative: 'same-input', controller_actor_id: 'synthetic-unchanged-controller', artifacts,
    scientific_input_artifact_id: 'new-science', producer_artifact_id: 'new-producer', source_check_artifact_id: 'source-check' }] };
  const proposalBytes = Buffer.from(JSON.stringify(proposal)), approval = { explicit_user_approval: true, proposal_sha256: sha(proposalBytes), authorization_id: 'new-synthetic-source-reuse' };
  const result = await assembleReaderSourceAdoption({ prior: f, original: f.scientificInput, derived: f.scientificInput, proposalBytes, approval, sample: '01', phase22Validator: await createPhase22ContractValidator() })
    .catch(error => { error.message += ': ' + JSON.stringify(error.details); throw error; });
  assert.equal(result.ok, true); assert.equal(result.basis.scientific_completeness, 'partial');
  assert.equal(result.basis.parser_evaluation_disposition.requirement_satisfied, false);
  assert.deepEqual((await result.artifactResolver('new-science')).bytes, (await f.artifactResolver(f.currentControl.scientific_input_artifact_id)).bytes);
});
