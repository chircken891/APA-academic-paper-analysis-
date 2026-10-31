import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { exportPublicApa } from '../../scripts/setup/export-public-apa.mjs';
import { inspectApaConfig } from '../../scripts/lib/apa-config.mjs';
import { prepareConfiguredReading,createConfiguredScienceRequest, getConfiguredReadingDispatchArguments, materializeConfiguredReadingCandidate, createConfiguredMineruPort, configuredMineruConfiguration } from '../../scripts/v3/configured-reading.mjs';
import { reviewedReadingFirstFixture } from './helpers/reading-first-publication-source-fixtures.mjs';
import { commitOwnedArtifact } from '../../scripts/v3/owned-artifact-store.mjs';
import { ingestObservedRunStep } from '../../scripts/v3/phase21-runner.mjs';
import { createReadingFirstRevisionRequests, createReadingFirstPresentationRequest, createReadingFirstReviewRequest, renderReadingFirstNotes, fingerprintReadingFirst, restoreReadingFirstRuntime, snapshotReadingFirstRuntime, getReadingFirstState, createReadingFirstRequests, getReadingFirstRunControlRef } from '../../scripts/v3/reading-first-runtime.mjs';
import { readingFirstPublicationFixture, applyReadingFirstFixture } from './helpers/reading-first-publication-fixtures.mjs';
import { readingFirstIndexFixture } from './helpers/reading-first-index-fixtures.mjs';
import { readCommittedReadingFirstKnowledgeRegistry } from '../../scripts/v3/reading-first-knowledge-registry.mjs';
import { validateConfiguredReadingDispatch } from '../../scripts/v3/configured-reading.mjs';
import { applyBilingualPublication, loadBilingualPublication } from '../../scripts/v3/phase22-publication.mjs';
import { readCommittedGeneration } from '../../scripts/v3/phase22-active-version.mjs';
import { queryBilingualIndex } from '../../scripts/v3/phase22-search.mjs';

// Inspect historical/synthetic packets without authorizing another host call.
const inspectDispatchArguments = options => {
  validateConfiguredReadingDispatch(options);
  return structuredClone(options.request.emittedStep.arguments);
};

async function configuredRepo(t, enabled = false) {
  const root = await mkdtemp(join(tmpdir(), 'apa-configured-reading-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'config'));
  const guide = join(root, 'humanizer.md');
  await writeFile(guide, 'ENGLISH_OPTIONAL_GUIDANCE: explain concrete actions.');
  const choice = { mode: 'explicit', model: 'gpt-6.1-sol', reasoning_effort: 'low' };
  const config = { schema_version: 'apa-local-config-1.0', models: { science: choice, overrides: { results: { ...choice, reasoning_effort: 'high' } },
    roles: Object.fromEntries(['english-writer','chinese-writer','translation','reading-editor','independent-verifier'].map(role => [role, choice])) },
    paths: { runs: '.tmp/runs', parse: '.tmp/parse', candidates: '.tmp/candidates' }, parser: { runtime_home: join(root, 'mineru') },
    reading: { source_language: 'zh-CN', presentation_mode: 'reading-editor' },
    writing_skills: Object.fromEntries(['nature-writing','nature-polishing','nature-shared','humanizer','humanizer-zh','stss'].map(key => [key, { enabled: enabled && key === 'humanizer', ...(enabled && key === 'humanizer' ? { path: guide } : {}) }])) };
  await writeFile(join(root, 'config/apa.local.json'), JSON.stringify(config));
  const bin = join(root, 'mineru', 'venv', process.platform === 'win32' ? 'Scripts' : 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, process.platform === 'win32' ? 'python.exe' : 'python'), 'synthetic executable presence only');
  await writeFile(join(root, 'mineru', 'config.yaml'), 'synthetic config presence only');
  return { root, config };
}

test('new configured runs require a Controller decision while legacy bindings keep their dispatch contract', async t => {
  const { root } = await configuredRepo(t);
  let prepared;
  const runId = 'run_' + 'c'.repeat(32);
  const fixture = await reviewedReadingFirstFixture(t, { artifactRoot: join(root, '.tmp/runs', runId), runId,
    createRunControl: options => { prepared = prepareConfiguredReading({ ...options, repoRoot: root }); return prepared.runControl; } });
  const request = createConfiguredScienceRequest({ prepared, role: 'methods', dispatchContext: fixture.broker.dispatchContext,
    task: { task_name: 'unmanaged_methods', native_path: 'native/unmanaged-methods.json' } });
  assert.throws(() => getConfiguredReadingDispatchArguments({ prepared, request }), /APA_COMPACTION_CONTROLLER_REQUIRED/);
  assert.equal(prepared.runControl.reading_first_binding.compaction_policy.profile, 'boundary-reminders-1.2');
  assert.equal(prepared.compactionControlBindings.length, 4);
  const legacy = structuredClone(prepared);
  delete legacy.runControl.reading_first_binding.compaction_policy;
  assert.deepEqual(getConfiguredReadingDispatchArguments({ prepared: legacy, request }), request.emittedStep.arguments);
});

async function configuredCommittedReuseFixture(t) {
  const { root } = await configuredRepo(t);
  const prior = await readingFirstIndexFixture(t, { vaultRoot: root, policy: 'committed-shared-nodes-1.0' });
  await prior.save(await prior.build());
  const runId = 'run_' + 'b'.repeat(32), paperId = 'pap_' + 'b'.repeat(32);
  const modules = ['abstract', 'design', 'methods', 'findings', 'discussion', 'limitations', 'conclusion'];
  const presentation = {
    schema_version: 'reading-first-obsidian-1.0', layout: 'writer-modules-1.0', knowledge_layout: 'shared-bilingual-1.0',
    bibliography: { title: { en: 'Another synthetic study', 'zh-CN': '另一项合成研究' }, first_author: 'Tester', year: 2026 },
    modules: modules.map(id => ({ id, label: { en: id, 'zh-CN': id } })), source_pdf: 'Raw/' + paperId + '.pdf',
    visuals: [{ id: 'fig-one', kind: 'figure', label: { en: 'Figure', 'zh-CN': '图' }, caption: { en: 'Caption.', 'zh-CN': '图注。' }, path: 'Figures/' + paperId + '/figure.png', page: 1 }],
    knowledge: [{ id: 'method', canonical_key: 'synthetic-rate', kind: 'method', source_kind: 'method-background',
      title: { en: 'Synthetic rate', 'zh-CN': '合成率' }, paragraphs: { en: ['A new application.'], 'zh-CN': ['新的论文应用。'] } }],
    map: { steps: [{ id: 'design-step', section_id: 'design', label: { en: 'Design', 'zh-CN': '设计' } }], findings: [{ id: 'main-finding', section_id: 'findings', label: { en: 'Finding', 'zh-CN': '发现' } }], relations: [{ step_id: 'design-step', finding_id: 'main-finding' }] },
  };
  let prepared;
  const fixture = await reviewedReadingFirstFixture(t, { artifactRoot: join(root, '.tmp/runs', runId), runId, paperId, presentation,
    createRunControl: options => { prepared = prepareConfiguredReading({ ...options, repoRoot: root }); return prepared.runControl; } });
  const resources = fixture.resources;
  return { root, prior, fixture, prepared, resources };
}

test('new configured materialization freezes and loads committed knowledge, refusing an injected registry', async t => {
  const { root, prior, fixture, prepared, resources } = await configuredCommittedReuseFixture(t);
  assert.deepEqual(prepared.runControl.reading_first_binding.configured_setup.knowledge_registry,
    { policy: 'current-shared-nodes-1.0', vault_root: root });
  const args = { prepared, controller: fixture.controller, handoff: fixture.handoff, resources };
  await assert.rejects(materializeConfiguredReadingCandidate({ ...args, knowledgeRegistry: [{ id: 'orphan', path: 'Wiki/methods/orphan.md', content: 'uncommitted' }] }), /APA_CONFIGURED_KNOWLEDGE_REGISTRY_MISMATCH/);
  const trusted = await readCommittedReadingFirstKnowledgeRegistry({ vaultRoot: root, policy: 'current-shared-nodes-1.0' });
  await assert.rejects(materializeConfiguredReadingCandidate({ ...args, knowledgeRegistry: [{ ...trusted[0], content: trusted[0].content + '\nChanged content.' }] }), /APA_CONFIGURED_KNOWLEDGE_REGISTRY_MISMATCH/);
  await assert.rejects(materializeConfiguredReadingCandidate({ ...args, knowledgeRegistry: [{ ...trusted[0], canonical_key: 'different-identity' }] }), /APA_CONFIGURED_KNOWLEDGE_REGISTRY_MISMATCH/);
  const saved = await materializeConfiguredReadingCandidate(args);
  assert.equal(saved.candidate.supportNotes[0].path, prior.rendered.supportNotes[0].path);
  assert.match(saved.candidate.supportNotes[0].content, /Only sharedknowledgeneedle is explained here/);
  assert.match(saved.candidate.supportNotes[0].content, /这里专门解释共享知识检索词/);
  assert.equal(saved.exported.supportNotes[0].content, saved.candidate.supportNotes[0].content);
});

test('configured materialization accepts exact committed registry entries', async t => {
  const { root, prior, fixture, prepared, resources } = await configuredCommittedReuseFixture(t);
  const trusted = await readCommittedReadingFirstKnowledgeRegistry({ vaultRoot: root, policy: 'current-shared-nodes-1.0' });
  const saved = await materializeConfiguredReadingCandidate({ prepared, controller: fixture.controller, handoff: fixture.handoff, resources, knowledgeRegistry: trusted });
  assert.equal(saved.candidate.supportNotes[0].path, prior.rendered.supportNotes[0].path);
  assert.equal(saved.exported.supportNotes[0].content, saved.candidate.supportNotes[0].content);
});

test('configured low-level rendering rejects a forged or modified registry and accepts a current empty vault', async t => {
  const { root } = await configuredRepo(t);
  const runId = 'run_' + 'd'.repeat(32);
  const fixture = await reviewedReadingFirstFixture(t, { artifactRoot: join(root, '.tmp/runs', runId), runId,
    createRunControl: options => prepareConfiguredReading({ ...options, repoRoot: root }).runControl });
  assert.throws(() => renderReadingFirstNotes({ controller: fixture.controller,
    knowledgeRegistry: [{ id: 'orphan', path: 'Wiki/methods/orphan.md', content: 'uncommitted' }] }), /RF_KNOWLEDGE_REGISTRY_NOT_TRUSTED/);
  const empty = await readCommittedReadingFirstKnowledgeRegistry({ vaultRoot: root, policy: 'current-shared-nodes-1.0' });
  assert.doesNotThrow(() => renderReadingFirstNotes({ controller: fixture.controller, knowledgeRegistry: empty }));
  empty.push({ id: 'orphan', path: 'Wiki/methods/orphan.md', content: 'uncommitted' });
  assert.throws(() => renderReadingFirstNotes({ controller: fixture.controller, knowledgeRegistry: empty }), /RF_KNOWLEDGE_REGISTRY_NOT_TRUSTED/);
});

test('configured low-level rendering rejects stale committed data and a trusted registry from a different root', async t => {
  const { root, prior, fixture } = await configuredCommittedReuseFixture(t);
  const trusted = await readCommittedReadingFirstKnowledgeRegistry({ vaultRoot: root, policy: 'current-shared-nodes-1.0' });
  assert.doesNotThrow(() => renderReadingFirstNotes({ controller: fixture.controller, knowledgeRegistry: trusted }));
  const { root: otherRoot } = await configuredRepo(t);
  const other = await readCommittedReadingFirstKnowledgeRegistry({ vaultRoot: otherRoot, policy: 'current-shared-nodes-1.0' });
  assert.throws(() => renderReadingFirstNotes({ controller: fixture.controller, knowledgeRegistry: other }), /RF_KNOWLEDGE_REGISTRY_NOT_TRUSTED/);
  const path = join(root, prior.manifest.targets.support[0].path);
  await writeFile(path, (await readFile(path, 'utf8')) + '\ntampered\n');
  assert.throws(() => renderReadingFirstNotes({ controller: fixture.controller, knowledgeRegistry: trusted }), /P23_CURRENT_CHANGED/);
});

test('configured materialization preserves current edited knowledge and records its fingerprint', async t => {
  const { root, prior, fixture, prepared, resources } = await configuredCommittedReuseFixture(t);
  const path = join(root, prior.manifest.targets.support[0].path);
  await writeFile(path, (await readFile(path, 'utf8')) + '\ntampered\n');
  const edited = await readFile(path, 'utf8');
  const saved = await materializeConfiguredReadingCandidate({ prepared, controller: fixture.controller, handoff: fixture.handoff, resources });
  assert.match(saved.candidate.supportNotes[0].content, /tampered/);
  assert.match(saved.candidate.supportNotes[0].content, /A new application\./);
  assert.match(saved.candidate.supportNotes[0].content, /新的论文应用/);
  assert.equal(await readFile(path, 'utf8'), edited);
  assert.deepEqual(saved.exported.manifest.knowledge_dependencies, [{ path: prior.manifest.targets.support[0].path,
    sha256: 'sha256:' + createHash('sha256').update(edited).digest('hex') }]);
});

test('a changed reused node is refreshed once before candidate becomes visible', async t => {
  const { root, prior, fixture, prepared, resources } = await configuredCommittedReuseFixture(t);
  const path = join(root, prior.manifest.targets.support[0].path);
  let observations = 0;
  const saved = await materializeConfiguredReadingCandidate({ prepared, controller: fixture.controller, handoff: fixture.handoff, resources,
    onDependencyBoundary: async ({ attempt, phase }) => {
      if (phase !== 'before-finalize') return;
      observations++;
      if (attempt === 1) await writeFile(path, (await readFile(path, 'utf8')) + '\nChanged during export.\n');
    } });
  assert.equal(observations, 2);
  assert.match(saved.candidate.supportNotes[0].content, /Changed during export/);
  assert.equal(saved.exported.outputRoot, prepared.paths.candidateRoot);
  assert.equal(saved.exported.manifest.knowledge_dependencies[0].sha256,
    'sha256:' + createHash('sha256').update(await readFile(path)).digest('hex'));
});

test('repeated changes to a reused node stop before publishing a candidate directory', async t => {
  const { root, prior, fixture, prepared, resources } = await configuredCommittedReuseFixture(t);
  const path = join(root, prior.manifest.targets.support[0].path);
  let observations = 0;
  await assert.rejects(materializeConfiguredReadingCandidate({ prepared, controller: fixture.controller, handoff: fixture.handoff, resources,
    onDependencyBoundary: async ({ phase }) => { if (phase === 'before-finalize') { observations++; await writeFile(path, (await readFile(path, 'utf8')) + '\nRepeated edit.\n'); } } }), /P23_CURRENT_CHANGED/);
  assert.equal(observations, 2);
  await assert.rejects(readFile(join(prepared.paths.candidateRoot, '.apa-v3/presentation.json')), { code: 'ENOENT' });
});

test('a dependency edit during final copy reports the owned candidate and staging paths', async t => {
  const { root, prior, fixture, prepared, resources } = await configuredCommittedReuseFixture(t);
  const path = join(root, prior.manifest.targets.support[0].path);
  await assert.rejects(materializeConfiguredReadingCandidate({ prepared, controller: fixture.controller, handoff: fixture.handoff, resources,
    onDependencyBoundary: async ({ phase }) => { if (phase === 'after-finalize') await writeFile(path, (await readFile(path, 'utf8')) + '\nFinalization edit.\n'); } }),
  error => error.code === 'P23_CURRENT_CHANGED' && error.details.owned_output_path === prepared.paths.candidateRoot
    && error.details.staging_root.includes('reading-first-candidates'));
  assert.ok(await readFile(join(prepared.paths.candidateRoot, '.apa-v3/presentation.json')));
});

test('new configured candidates tolerate old paper body edits while complete committed reads still reject them', async t => {
  const { root, prior, fixture, prepared } = await configuredCommittedReuseFixture(t);
  const path = join(root, prior.paper.paths.en);
  const before = await readFile(path, 'utf8');
  await writeFile(path, before.replace('Only sharedknowledgeneedle', 'Edited sharedknowledgeneedle').replace('## ', '## Edited '));
  assert.equal((await readCommittedGeneration({ vaultRoot: root })).ok, false);
  const saved = await materializeConfiguredReadingCandidate({ prepared, controller: fixture.controller, handoff: fixture.handoff, resources: fixture.resources });
  assert.equal(saved.exported.validation.status, 'passed');
  assert.equal(prepared.runControl.reading_first_binding.presentation_profile, 'reading-editor-1.3');
  const instructions = prepared.runControl.reading_first_binding.configured_setup.sections['Reading Editor'];
  assert.match(instructions, /reading-editor-1\.3/);
  assert.doesNotMatch(instructions, /roughly twelve nodes/);
  assert.ok(saved.exported.manifest.files.some(row => row.kind === 'historical-navigation'));
  assert.equal(await readFile(path, 'utf8'), before.replace('Only sharedknowledgeneedle', 'Edited sharedknowledgeneedle').replace('## ', '## Edited '));
});

test('legacy configured bindings retain their supplied registry behavior', async t => {
  const { root } = await configuredRepo(t);
  const runId = 'run_' + 'e'.repeat(32);
  let prepared;
  const fixture = await reviewedReadingFirstFixture(t, { artifactRoot: join(root, '.tmp/runs', runId), runId,
    createRunControl: options => {
      const next = prepareConfiguredReading({ ...options, repoRoot: root });
      const runControl = structuredClone(next.runControl);
      delete runControl.reading_first_binding.configured_setup.knowledge_registry;
      prepared = { ...next, runControl };
      return runControl;
    } });
  const knowledgeRegistry = [{ id: 'unrelated-legacy', path: 'Wiki/methods/unrelated.md', content: 'legacy data' }];
  const saved = await materializeConfiguredReadingCandidate({ prepared, controller: fixture.controller, handoff: fixture.handoff, resources: fixture.resources, knowledgeRegistry });
  assert.equal(saved.exported.validation.status, 'passed');
});

test('isolated reply resource drift blocks new bindings at creation, dispatch, continuation and restore while legacy bindings remain usable', async t => {
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  const scratchParent = join(repoRoot, '.tmp', 'apa-controller-context-budget');
  await mkdir(scratchParent, { recursive: true });
  const scratch = await mkdtemp(join(scratchParent, 'v4-drift-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const exported = join(scratch, 'public');
  await exportPublicApa({ sourceRoot: repoRoot, outputRoot: exported });
  const load = path => import(pathToFileURL(join(exported, path)).href);
  const runtime = await load('scripts/v3/reading-first-runtime.mjs');
  const configured = await load('scripts/v3/configured-reading.mjs');
  const store = await load('scripts/v3/owned-artifact-store.mjs');
  const { reviewedReadingFirstFixture: fixture } = await load('test/v3/helpers/reading-first-publication-source-fixtures.mjs');
  const contractPath = join(exported, 'prompts/v3/role-reply-1.0.md');
  const contractBytes = await readFile(contractPath);
  const originals = await Promise.all(['phase21-scientific-contracts.md', 'reading-first-contracts.md'].map(name => readFile(join(exported, 'prompts/v3', name))));
  const make = async enabled => {
    const { root } = await configuredRepo(t);
    let prepared, creationOptions;
    const runId = 'run_' + (enabled ? '5' : '6').repeat(32);
    const s = await fixture(t, { artifactRoot: join(root, '.tmp/runs', runId), runId, completeReview: false,
      controlOptions: { maxCalls: 8 }, createRunControl: options => {
        creationOptions = options;
        prepared = configured.prepareConfiguredReading({ ...options, repoRoot: root, instructionProfile: 'configured-reading-1.0' });
        if (!enabled) {
          const runControl = structuredClone(prepared.runControl);
          delete runControl.reading_first_binding.role_reply_contract;
          prepared = { ...prepared, runControl };
        }
        return prepared.runControl;
      } });
    const scienceArgs = { prepared, role: 'evidence', dispatchContext: s.broker.dispatchContext,
      task: { task_name: 'drift_evidence', native_path: 'native/drift-evidence.json' } };
    const science = configured.createConfiguredScienceRequest(scienceArgs);
    const snapshot = runtime.snapshotReadingFirstRuntime(s.controller);
    const receipt = await store.commitOwnedArtifact({ artifactRoot: s.root, dispatchContext: s.broker.dispatchContext,
      capability: s.broker.issueCapability({ runId, actorId: 'controller', role: 'control', artifactPath: 'checkpoint.json', revision: '1' }),
      artifact: { artifact_id: 'checkpoint', content: JSON.stringify(snapshot) }, expectedRevision: '1' });
    return { ...s, prepared, creationOptions, scienceArgs, science, snapshot, receipt };
  };
  const modern = await make(true), legacy = await make(false);
  for (const missing of [false, true]) {
    if (missing) await rm(contractPath);
    else await writeFile(contractPath, Buffer.concat([contractBytes, Buffer.from('\nChanged in isolated test only.\n')]));
    assert.throws(() => runtime.createReadingFirstRunControl({ ...modern.creationOptions,
      roleReplyContract: modern.binding.role_reply_contract }), /APA_ROLE_REPLY_CONTRACT_CHANGED/);
    assert.throws(() => configured.createConfiguredScienceRequest(modern.scienceArgs), /APA_ROLE_REPLY_CONTRACT_CHANGED/);
    for (const request of [modern.science, modern.reviewRequest]) {
      assert.throws(() => configured.getConfiguredReadingDispatchArguments({ prepared: modern.prepared, request }), /APA_ROLE_REPLY_CONTRACT_CHANGED/);
    }
    assert.throws(() => runtime.snapshotReadingFirstRuntime(modern.controller), /APA_ROLE_REPLY_CONTRACT_CHANGED/);
    const failed = await runtime.restoreReadingFirstRuntime({ handoff: modern.handoff, runControl: modern.runControl, checkpointReceipt: modern.receipt });
    assert.deepEqual(failed, { ok: false, errors: [{ code: 'APA_ROLE_REPLY_CONTRACT_CHANGED' }] });
    assert.deepEqual(runtime.snapshotReadingFirstRuntime(legacy.controller), legacy.snapshot);
    assert.equal(runtime.createReadingFirstRunControl(legacy.creationOptions).reading_first_binding.role_reply_contract, undefined);
    const oldScience = configured.createConfiguredScienceRequest(legacy.scienceArgs);
    assert.deepEqual(oldScience.emittedStep.arguments, legacy.science.emittedStep.arguments);
    assert.deepEqual(configured.getConfiguredReadingDispatchArguments({ prepared: legacy.prepared, request: legacy.reviewRequest }), legacy.reviewRequest.emittedStep.arguments);
    const recovered = await runtime.restoreReadingFirstRuntime({ handoff: legacy.handoff, runControl: legacy.runControl, checkpointReceipt: legacy.receipt });
    assert.equal(recovered.ok, true, JSON.stringify(recovered.errors));
    assert.deepEqual(recovered.requests, [legacy.reviewRequest]);
    const [request] = recovered.requests, step = request.emittedStep;
    await writeFile(join(legacy.root, request.task.native_path), JSON.stringify({ ...legacy.review,
      issues: [{ severity: 'material', kind: 'content', repair_owner: 'writer', detail: 'Clarify the account.', affected_languages: ['en'] }] }));
    await runtime.acceptReadingFirstResult({ controller: recovered.controller, request, observation: {
      action_id: step.action_id, run_id: legacy.runId, input_fingerprint: step.input_fingerprint, port: 'current-collaboration',
      tool_call: { name: step.action, arguments: step.arguments }, raw_result_text: JSON.stringify({ agent_id: 'synthetic-legacy' }),
    }, capability: legacy.broker.issueCapability({ runId: legacy.runId, actorId: request.task.owner_actor_id,
      role: request.task.role, artifactPath: request.task.artifact_path, revision: request.task.revision }) });
    const [revision] = runtime.createReadingFirstRevisionRequests({ controller: recovered.controller });
    assert.equal(revision.packet.backend.configuration.role_reply_contract, undefined);
    assert.equal(revision.emittedStep.arguments.prompt?.includes(contractBytes.toString()) ?? revision.emittedStep.arguments.message.includes(contractBytes.toString()), false);
    // Run the second resource condition against a fresh legacy owned store.
    if (!missing) {
      await writeFile(contractPath, contractBytes);
      Object.assign(legacy, await make(false));
    }
  }
  await writeFile(contractPath, contractBytes);
  const recovered = await runtime.restoreReadingFirstRuntime({ handoff: modern.handoff, runControl: modern.runControl, checkpointReceipt: modern.receipt });
  assert.equal(recovered.ok, true, JSON.stringify(recovered.errors));
  assert.deepEqual(runtime.snapshotReadingFirstRuntime(recovered.controller), modern.snapshot);
  for (const [index, name] of ['phase21-scientific-contracts.md', 'reading-first-contracts.md'].entries()) {
    assert.deepEqual(await readFile(join(exported, 'prompts/v3', name)), originals[index]);
  }
});

for (const host of ['codex', 'claude-code']) for (const instructionFiles of [false, true]) {
  test(`role reply contract reaches science, reading and repair requests on ${host} with ${instructionFiles ? 'file' : 'inline'} instructions`, async t => {
    const { root, config } = await configuredRepo(t);
    if (host === 'claude-code') {
      config.host = { name: host, dispatch: { tool: 'Agent', model_argument: 'model', effort_argument: 'effort', instruction_argument: 'prompt', task_name_argument: 'description', fresh_context: null } };
      await writeFile(join(root, 'config/apa.local.json'), JSON.stringify(config));
    }
    const originalConfig = await readFile(join(root, 'config/apa.local.json'));
    const runId = 'run_' + '4'.repeat(32);
    let prepared;
    const fixture = await reviewedReadingFirstFixture(t, { artifactRoot: join(root, '.tmp/runs', runId), runId, instructionFiles,
      controlOptions: { maxCalls: 8 },
      createRunControl: options => { prepared = prepareConfiguredReading({ ...options, repoRoot: root, instructionProfile: 'configured-reading-1.0' }); return prepared.runControl; },
      review: { overall: { complete: true, coherent: true, bilingual_consistent: true },
        key_nodes: [{ kind: 'main_conclusion', location: 'findings', finding: 'Supported.' }],
        issues: [{ severity: 'material', kind: 'content', repair_owner: 'writer', affected_languages: ['en', 'zh-CN'], detail: 'Clarify both accounts.' }], scope: 'Synthetic repair.' },
    });
    const contract = prepared.runControl.reading_first_binding.role_reply_contract;
    assert.equal(contract?.profile, 'role-reply-1.0', 'new configured runs must freeze the reply contract');
    const bytes = await readFile(new URL('../../prompts/v3/role-reply-1.0.md', import.meta.url));
    assert.deepEqual(contract, { profile: 'role-reply-1.0', sha256: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), byte_length: bytes.length });
    assert.equal(Object.isFrozen(contract), true);
    const repairedViews = structuredClone(fixture.views);
    for (const view of repairedViews) view.sections[0].paragraphs.push('Clarified synthetic condition.');
    for (let index = 0; index < 2; index++) {
      const [request] = createReadingFirstRevisionRequests({ controller: fixture.controller });
      await fixture.complete(request, repairedViews.find(view => view.language === request.language));
    }
    await fixture.complete(createReadingFirstPresentationRequest({ controller: fixture.controller }), {
      ...fixture.editor, views_fingerprint: fingerprintReadingFirst(repairedViews),
    });
    const candidate = renderReadingFirstNotes({ controller: fixture.controller, ...fixture.renderOptions });
    createReadingFirstReviewRequest({ controller: fixture.controller, presentation: candidate });
    const entries = snapshotReadingFirstRuntime(fixture.controller).state.request_entries;
    assert.equal(entries.length, 8);
    const science = ['evidence', 'methods', 'results', 'interpretation', 'scientific-reading', 'integration'].map(role =>
      createConfiguredScienceRequest({ prepared, role, dispatchContext: fixture.broker.dispatchContext,
        task: { task_name: 'reply_' + role.replaceAll('-', '_'), native_path: 'native/reply-' + role + '.json',
          ...(instructionFiles ? { instruction_path: 'instructions/reply-' + role + '.txt' } : {}) },
        payload: { full_content: 'Complete scientific source data must remain available.' } }));
    const argument = host === 'codex' ? 'message' : 'prompt';
    for (const request of [...science, ...entries.map(entry => entry.request)]) {
      const instruction = request.instruction_file ? await readFile(request.instruction_file.path, 'utf8') : request.emittedStep.arguments[argument];
      assert.equal(instruction.split(bytes.toString('utf8')).length, 2, request.task?.task_id ?? request.packet.host_action_scope.role);
      assert.deepEqual(request.packet.backend.configuration.role_reply_contract, contract);
      assert.deepEqual(inspectDispatchArguments({ prepared, request }), request.emittedStep.arguments);
      assert.equal(request.packet.host_action_scope.action, host === 'codex' ? 'collaboration.spawn_agent' : 'Agent');
    }
    assert.deepEqual(await readFile(join(root, 'config/apa.local.json')), originalConfig);
  });
}

test('session context supplies the main pair and rejects a conflicting explicit mainSession', async t => {
  const { root } = await configuredRepo(t);
  let options;
  const runId = 'run_' + '1'.repeat(32);
  await reviewedReadingFirstFixture(t, { artifactRoot: join(root, '.tmp/runs', runId), runId,
    createRunControl: input => { options = input; return prepareConfiguredReading({ ...input, repoRoot: root }).runControl; } });
  const sessionContext = { model: 'gpt-6-astra', effort: 'xhigh' };
  assert.throws(() => prepareConfiguredReading({ ...options, repoRoot: root, sessionContext }), /APA_CONFIGURED_MAIN_SESSION_MISMATCH/);
  const prepared = prepareConfiguredReading({ ...options, repoRoot: root, mainSession: undefined, sessionContext });
  assert.deepEqual(prepared.runControl.reading_first_binding.role_model_policy.main_session, { model: 'gpt-6-astra', reasoning_effort: 'xhigh' });
  assert.deepEqual(prepareConfiguredReading({ ...options, repoRoot: root, mainSession: undefined,
    sessionContext: { model: 'gpt-6-astra', reasoning_effort: 'xhigh' } }).runControl.reading_first_binding.role_model_policy.main_session,
  { model: 'gpt-6-astra', reasoning_effort: 'xhigh' });
  assert.deepEqual(prepareConfiguredReading({ ...options, repoRoot: root, sessionContext,
    mainSession: { model: 'gpt-6-astra', reasoning_effort: 'xhigh' } }).runControl.reading_first_binding.role_model_policy.main_session,
  { model: 'gpt-6-astra', reasoning_effort: 'xhigh' });
  assert.throws(() => prepareConfiguredReading({ ...options, repoRoot: root, mainSession: undefined,
    sessionContext: { ...sessionContext, reasoning_effort: 'medium' } }), /APA_CONFIGURED_SESSION_CONTEXT_INVALID/);
});

test('configured preparation rejects non-text context before any science call', async t => {
  const { root } = await configuredRepo(t);
  const runId = 'run_' + '3'.repeat(32);
  let options;
  await reviewedReadingFirstFixture(t, { artifactRoot: join(root, '.tmp/runs', runId), runId,
    createRunControl: input => { options = input; return prepareConfiguredReading({ ...input, repoRoot: root }).runControl; } });
  for (const context of [{ source_scope: 'object context' }, ['list'], '  ', undefined]) {
    assert.throws(() => prepareConfiguredReading({ ...options, repoRoot: root, scientificInput: { ...options.scientificInput, context } }), /READING_FIRST_CONTEXT_TEXT_REQUIRED/);
  }
});

test('reading requests name the prepared proposal shape and accept the derived run control handle', async t => {
  const { root } = await configuredRepo(t);
  const runId = 'run_' + '4'.repeat(32);
  let prepared;
  const fixture = await reviewedReadingFirstFixture(t, { artifactRoot: join(root, '.tmp/runs', runId), runId,
    createRunControl: input => { prepared = prepareConfiguredReading({ ...input, repoRoot: root }); return prepared.runControl; } });
  const rejected = createReadingFirstRequests({ handoff: fixture.handoff, runControl: prepared.runControl });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.errors[0].code, 'READING_FIRST_RUN_CONTROL_REF_REQUIRED');
  assert.equal(createReadingFirstRequests({ handoff: fixture.handoff, runControl: prepared }).errors[0].code, 'READING_FIRST_RUN_CONTROL_REF_REQUIRED');
  const ref = getReadingFirstRunControlRef({ prepared, broker: fixture.broker });
  assert.deepEqual(ref, { runId, artifactRoot: prepared.paths.runRoot, dispatchContext: fixture.broker.dispatchContext });
  assert.deepEqual(getReadingFirstRunControlRef({ prepared, dispatchContext: fixture.broker.dispatchContext }), ref);
  // The fixture already initialized this run, so the handle passes the control check and reaches the next guard.
  assert.equal(createReadingFirstRequests({ handoff: fixture.handoff, runControl: ref }).errors[0].code, 'READING_FIRST_RUNTIME_ALREADY_INITIALIZED');
  assert.throws(() => getReadingFirstRunControlRef({ prepared }), /READING_FIRST_CONTROL_REQUIRED/);
});

test('a registry read from the configured binding uses its frozen policy and passes rendering', async t => {
  const { root, fixture, prepared } = await configuredCommittedReuseFixture(t);
  const fromBinding = await readCommittedReadingFirstKnowledgeRegistry({ binding: prepared.runControl.reading_first_binding });
  assert.doesNotThrow(() => renderReadingFirstNotes({ controller: fixture.controller, knowledgeRegistry: fromBinding }));
  for (const binding of [prepared, prepared.runControl]) {
    const registry = await readCommittedReadingFirstKnowledgeRegistry({ vaultRoot: root, binding });
    assert.doesNotThrow(() => renderReadingFirstNotes({ controller: fixture.controller, knowledgeRegistry: registry }));
  }
  await assert.rejects(readCommittedReadingFirstKnowledgeRegistry({ binding: prepared, policy: 'committed-generation-1.0' }), /RF_KNOWLEDGE_REGISTRY_POLICY_MISMATCH/);
  const { root: otherRoot } = await configuredRepo(t);
  await assert.rejects(readCommittedReadingFirstKnowledgeRegistry({ binding: prepared, vaultRoot: otherRoot }), /RF_KNOWLEDGE_REGISTRY_ROOT_MISMATCH/);
  await assert.rejects(readCommittedReadingFirstKnowledgeRegistry({ vaultRoot: root, binding: {} }), /RF_KNOWLEDGE_REGISTRY_BINDING_POLICY_REQUIRED/);
  // Without a binding the historical default is unchanged, and this configured run still rejects it.
  const legacyDefault = await readCommittedReadingFirstKnowledgeRegistry({ vaultRoot: root });
  assert.throws(() => renderReadingFirstNotes({ controller: fixture.controller, knowledgeRegistry: legacyDefault }), /RF_KNOWLEDGE_REGISTRY_NOT_TRUSTED/);
});

test('configured parser packets record no requested model', async t => {
  const { root } = await configuredRepo(t);
  const runId = 'run_' + '5'.repeat(32);
  let prepared;
  await reviewedReadingFirstFixture(t, { artifactRoot: join(root, '.tmp/runs', runId), runId,
    createRunControl: input => { prepared = prepareConfiguredReading({ ...input, repoRoot: root }); return prepared.runControl; } });
  const source = prepared.scientificInput.sources[0];
  const configuration = configuredMineruConfiguration(prepared);
  const packet = { run_id: runId, user_approval_id: prepared.runControl.reading_first_binding.authorization_id, intended_evidence_tier: 'local_dispatch',
    source: { path: source.path, sha256: source.sha256, byte_length: source.byte_length }, instruction_fingerprint: 'sha256:' + 'a'.repeat(64),
    configuration_fingerprint: fingerprintReadingFirst(configuration), allowed_output_root: prepared.paths.parseRoot,
    backend: { identity: 'current-mineru', version: 'simulated-1.0', runtime_configuration_version: 'synthetic', configuration },
    endpoint: { value: null, egress: 'denied', retention: 'local_only' }, host_action_scope: { action: 'run_current_mineru', permitted_result_fields: ['parser_version', 'output_inventory'] },
    expected_resource_fields: ['elapsed_ms'], requested_model: null, observed_model: 'unknown', estimate: { value: 1, unit: 'runs' }, approved_budget_cap: { value: 1, unit: 'runs' }, retry_allowance: 0 };
  const port = createConfiguredMineruPort({ prepared, repoRoot: root, dependencies: {
    checkMineruRuntime: async () => ({ ok: true, version: 'simulated-1.0', configVersion: 'synthetic' }),
    runMineru: async ({ outputPath }) => { await mkdir(outputPath, { recursive: true }); await writeFile(join(outputPath, 'markdown.md'), 'parsed'); return 'simulated-1.0'; } } });
  const result = await port.run(packet);
  assert.equal(result.parser_version, 'simulated-1.0');
  assert.equal(result.output_inventory[0].path, 'markdown.md');
});

test('configured runs freeze the science index handoff profile', async t => {
  const { root } = await configuredRepo(t);
  const runId = 'run_' + '2'.repeat(32);
  let options;
  await reviewedReadingFirstFixture(t, { artifactRoot: join(root, '.tmp/runs', runId), runId,
    createRunControl: input => { options = input; return prepareConfiguredReading({ ...input, repoRoot: root }).runControl; } });
  assert.equal(prepareConfiguredReading({ ...options, repoRoot: root }).runControl.reading_first_binding.handoff_profile, 'science-index-1.0');
});

test('science instruction retry reuses identical bytes and rejects conflicting content without overwriting', async t => {
  const { root } = await configuredRepo(t);
  let prepared;
  const runId = 'run_' + '2'.repeat(32);
  const fixture = await reviewedReadingFirstFixture(t, { artifactRoot: join(root, '.tmp/runs', runId), runId, instructionFiles: true,
    createRunControl: options => { prepared = prepareConfiguredReading({ ...options, repoRoot: root, instructionProfile: 'configured-reading-1.0' }); return prepared.runControl; } });
  const args = { prepared, role: 'evidence', dispatchContext: fixture.broker.dispatchContext,
    task: { task_name: 'configured_evidence', native_path: 'native/evidence-new.json', instruction_path: 'instructions/evidence-new.txt' }, payload: { content: 'same' } };
  const first = createConfiguredScienceRequest(args);
  const bytes = await readFile(first.instruction_file.path);
  const guidance = prepared.runControl.reading_first_binding.configured_setup;
  const frozenBytes = await readFile(new URL('../../prompts/v3/flow-corrections-1.0.md', import.meta.url));
  assert.equal(guidance.flow_corrections.sha256, 'sha256:' + createHash('sha256').update(frozenBytes).digest('hex'));
  assert.equal(guidance.flow_corrections.byte_length, frozenBytes.length);
  assert.equal(guidance.flow_corrections.schema_version, 'flow-corrections-1.0');
  assert.ok(bytes.toString('utf8').includes(guidance.science_guidance));
  assert.match(guidance.sections['Overall Verifier'], /repair_owner/);
  assert.match(guidance.sections['Overall Verifier'], /affected_paths/);
  assert.ok((await readFile(fixture.reviewRequest.instruction_file.path, 'utf8')).includes(guidance.sections['Overall Verifier']));
  const second = createConfiguredScienceRequest(args);
  assert.deepEqual(second.instruction_file, first.instruction_file);
  assert.deepEqual(await readFile(first.instruction_file.path), bytes);
  assert.throws(() => createConfiguredScienceRequest({ ...args, payload: { content: 'different' } }), /APA_CONFIGURED_INSTRUCTION_CONFLICT/);
  assert.deepEqual(await readFile(first.instruction_file.path), bytes);
});

test('dispatch arguments preserve emitted model and task and reject packet or step drift', async t => {
  const { root, config } = await configuredRepo(t);
  config.models.science.reasoning_effort = 'medium';
  config.models.overrides = {};
  for (const role of Object.keys(config.models.roles)) config.models.roles[role] = { mode: 'follow-main' };
  await writeFile(join(root, 'config/apa.local.json'), JSON.stringify(config));
  let prepared;
  const runId = 'run_' + '3'.repeat(32);
  const fixture = await reviewedReadingFirstFixture(t, { artifactRoot: join(root, '.tmp/runs', runId), runId, instructionFiles: true,
    createRunControl: options => { prepared = prepareConfiguredReading({ ...options, mainSession: { model: 'gpt-6-astra', reasoning_effort: 'xhigh' }, repoRoot: root,
      sessionContext: { model: 'gpt-6-astra', effort: 'xhigh' } }); return prepared.runControl; } });
  const science = createConfiguredScienceRequest({ prepared, role: 'evidence', dispatchContext: fixture.broker.dispatchContext,
    task: { task_name: 'configured_evidence', native_path: 'native/evidence-new.json', instruction_path: 'instructions/science-new.txt' } });
  const entries = snapshotReadingFirstRuntime(fixture.controller).state.request_entries;
  const requests = [science, ...entries.map(entry => entry.request)];
  assert.deepEqual(new Set(entries.map(entry => entry.request.packet.host_action_scope.role)), new Set(['english-writer', 'translation', 'reading-editor', 'independent-verifier']));
  for (const request of requests) {
    const actual = inspectDispatchArguments({ prepared, request });
    assert.deepEqual(actual, request.emittedStep.arguments);
    assert.notEqual(actual, request.emittedStep.arguments);
    assert.equal(actual.fork_turns, 'none');
    assert.equal(actual.reasoning_effort, request === science ? 'medium' : 'xhigh');
    assert.equal(actual.model, request === science ? 'gpt-6.1-sol' : 'gpt-6-astra');
    const altered = structuredClone(request);
    altered.emittedStep.arguments.fork_turns = 'all';
    assert.throws(() => getConfiguredReadingDispatchArguments({ prepared, request: altered }), /APA_CONFIGURED_DISPATCH_MISMATCH/);
    altered.emittedStep.arguments.fork_turns = 'none';
    altered.emittedStep.arguments.reasoning_effort = 'low';
    assert.throws(() => getConfiguredReadingDispatchArguments({ prepared, request: altered }), /APA_CONFIGURED_DISPATCH_MISMATCH/);
    const wrongRun = structuredClone(request);
    wrongRun.packet.run_id = 'another_run';
    assert.throws(() => getConfiguredReadingDispatchArguments({ prepared, request: wrongRun }), /APA_CONFIGURED_DISPATCH_MISMATCH/);
    const wrongPolicy = structuredClone(request);
    wrongPolicy.packet.role_model_policy.main_session.reasoning_effort = 'low';
    assert.throws(() => getConfiguredReadingDispatchArguments({ prepared, request: wrongPolicy }), /APA_CONFIGURED_DISPATCH_MISMATCH/);
  }
  await writeFile(science.instruction_file.path, 'changed bytes');
  assert.throws(() => getConfiguredReadingDispatchArguments({ prepared, request: science }), /APA_CONFIGURED_DISPATCH_MISMATCH/);
});

test('new configured reading requires complete current local configuration', async t => {
  const { root } = await configuredRepo(t);
  await writeFile(join(root, 'config/apa.local.json'), '{}');
  assert.throws(() => prepareConfiguredReading({ repoRoot: root }), /CONFIG/);
});

test('new configured reading stops before science when selected runtime or parser config is unavailable', async t => {
  const { root, config } = await configuredRepo(t);
  config.parser.config_path = join(root, 'mineru/config.unavailable.yaml');
  await writeFile(join(root, 'config/apa.local.json'), JSON.stringify(config));
  assert.throws(() => prepareConfiguredReading({ repoRoot: root }), /APA_CONFIG_DEPENDENCIES_UNAVAILABLE.*parser.config_path/);
});

test('new configured reading requires the actual paper language instead of inferring it from writing preferences', async t => {
  const { root } = await configuredRepo(t);
  for (const sourceLanguage of [undefined, null, '', 'fr']) {
    assert.throws(() => prepareConfiguredReading({ repoRoot: root, runId: 'source_language_required',
      mainSession: { model: 'gpt-6-astra', reasoning_effort: 'high' }, sourceLanguage }), /APA_CONFIGURED_SOURCE_LANGUAGE_REQUIRED/);
  }
});

test('configured runs use the paper source language and the translation model', async t => {
  const { root, config } = await configuredRepo(t);
  config.models.roles.translation = { mode: 'explicit', model: 'gpt-6.1-sol', reasoning_effort: 'high' };
  await writeFile(join(root, 'config/apa.local.json'), JSON.stringify(config));
  let prepared;
  const runId = 'run_' + '5'.repeat(32);
  const fixture = await reviewedReadingFirstFixture(t, { artifactRoot: join(root, '.tmp/runs', runId), runId,
    createRunControl: options => { prepared = prepareConfiguredReading({ ...options, repoRoot: root, sourceLanguage: 'en' }); return prepared.runControl; } });
  const binding = prepared.runControl.reading_first_binding;
  assert.equal(binding.writing_mode, 'source-translation');
  assert.equal(binding.translation_profile, 'translation-1.0');
  assert.equal(binding.first_writing_language, 'en');
  assert.equal(fixture.created.requests[0].language, 'en');
  assert.equal(fixture.created.requests[0].packet.host_action_scope.role, 'english-writer');
  const translation = snapshotReadingFirstRuntime(fixture.controller).state.request_entries.find(entry => entry.key === 'zh-CN').request;
  assert.equal(translation.packet.host_action_scope.role, 'translation');
  assert.equal(translation.packet.requested_model, 'gpt-6.1-sol');
  assert.equal(translation.emittedStep.arguments.reasoning_effort, 'high');
});

test('translation task keys must declare the translation role or leave it absent', async t => {
  const { root } = await configuredRepo(t);
  const runId = 'run_' + 'b'.repeat(32);
  let seen;
  const withRoles = (taskBindings, keys, role) => Object.fromEntries(Object.entries(taskBindings).map(([key, task]) => {
    if (!keys.includes(key)) return [key, task];
    const { role: _dropped, ...rest } = task;
    return [key, role === undefined ? rest : { ...rest, role }];
  }));
  const fixture = await reviewedReadingFirstFixture(t, { artifactRoot: join(root, '.tmp/runs', runId), runId,
    createRunControl: options => {
      // A conflicting role on a translation key fails before any run control is created.
      for (const [keys, conflict] of [[['zh-CN'], 'chinese-writer'], [['zh-CN-r2'], 'english-writer']]) {
        assert.throws(() => prepareConfiguredReading({ ...options, repoRoot: root, taskBindings: withRoles(options.taskBindings, keys, conflict) }), /READING_FIRST_TRANSLATION_ROLE_REQUIRED/);
      }
      // An absent role is filled with translation.
      seen = prepareConfiguredReading({ ...options, repoRoot: root, taskBindings: withRoles(options.taskBindings, ['zh-CN', 'zh-CN-r2'], undefined) }).runControl;
      return prepareConfiguredReading({ ...options, repoRoot: root }).runControl;
    } });
  assert.equal(seen.reading_first_binding.task_bindings['zh-CN'].role, 'translation');
  assert.equal(seen.reading_first_binding.task_bindings['zh-CN-r2'].role, 'translation');
  assert.equal(fixture.binding.task_bindings['zh-CN'].role, 'translation');
});

test('configs without reading.source_language are complete', async t => {
  const { root, config } = await configuredRepo(t);
  delete config.reading.source_language;
  await writeFile(join(root, 'config/apa.local.json'), JSON.stringify(config));
  const loaded = inspectApaConfig({ repoRoot: root });
  assert.equal(loaded.validation.complete, true, JSON.stringify(loaded.validation));
  assert.deepEqual(loaded.validation.missing, []);
  const runId = 'run_' + '6'.repeat(32);
  const fixture = await reviewedReadingFirstFixture(t, { artifactRoot: join(root, '.tmp/runs', runId), runId, sourceLanguage: 'zh-CN',
    createRunControl: options => prepareConfiguredReading({ ...options, repoRoot: root, sourceLanguage: 'zh-CN' }).runControl });
  assert.equal(fixture.binding.first_writing_language, 'zh-CN');
  assert.equal(fixture.created.requests[0].language, 'zh-CN');
});

for (const [sourceLanguage, translationLanguage, digit] of [['en', 'zh-CN', '7'], ['zh-CN', 'en', '8']]) {
  test(`${sourceLanguage} original is written first, then translated into ${translationLanguage}, with source-note routing`, async t => {
    const { root, config } = await configuredRepo(t);
    config.reading.source_language = translationLanguage;
    await writeFile(join(root, 'config/apa.local.json'), JSON.stringify(config));
    let prepared;
    const runId = 'run_' + digit.repeat(32);
    const fixture = await reviewedReadingFirstFixture(t, { artifactRoot: join(root, '.tmp/runs', runId), runId, sourceLanguage,
      createRunControl: options => {
        prepared = prepareConfiguredReading({ ...options, repoRoot: root, sourceLanguage });
        return prepared.runControl;
      } });
    assert.equal(fixture.created.requests[0].language, sourceLanguage);
    const checkpoint = snapshotReadingFirstRuntime(fixture.controller);
    const counterpart = checkpoint.state.request_entries.find(entry => ['en', 'zh-CN'].includes(entry.key) && entry.key !== sourceLanguage);
    assert.equal(counterpart.request.packet.host_action_scope.role, 'translation');
    assert.equal(counterpart.payload.source_view.language, sourceLanguage);
    for (const note of fixture.candidate.notes) {
      assert.ok(note.path.startsWith(note.language === sourceLanguage ? 'Wiki/sources/' : 'Wiki/translations/'), note.path);
    }
    const saved = await materializeConfiguredReadingCandidate({ prepared, controller: fixture.controller, handoff: fixture.handoff,
      resources: fixture.resources, targetRegistry: undefined });
    assert.deepEqual(saved.exported.notes.map(note => note.path), fixture.candidate.notes.map(note => note.path));
    assert.equal(saved.exported.validation.status, 'passed');
  });
}

for (const [sourceLanguage, translationLanguage, digit] of [['en', 'zh-CN', 'a'], ['zh-CN', 'en', 'c']]) {
  test(`configured ${sourceLanguage} Writer, ${translationLanguage} Translation and Editor receive consistent figure and role instructions`, async t => {
    const { root } = await configuredRepo(t, true);
    let prepared;
    const runId = 'run_' + digit.repeat(32);
    const fixture = await reviewedReadingFirstFixture(t, { artifactRoot: join(root, '.tmp/runs', runId), runId, sourceLanguage,
      createRunControl: options => {
        prepared = prepareConfiguredReading({ ...options, repoRoot: root, sourceLanguage });
        return prepared.runControl;
      } });
    const checkpoint = snapshotReadingFirstRuntime(fixture.controller);
    const entries = checkpoint.state.request_entries;
    const requestFor = key => entries.find(entry => entry.key === key).request;
    const writer = requestFor(sourceLanguage), translation = requestFor(translationLanguage), editor = requestFor('presentation');
    assert.equal(writer.packet.host_action_scope.role, sourceLanguage === 'en' ? 'english-writer' : 'chinese-writer');
    assert.equal(translation.packet.host_action_scope.role, 'translation');
    assert.equal(editor.packet.host_action_scope.role, 'reading-editor');
    for (const request of [writer, translation, editor]) {
      const instruction = request.emittedStep.arguments.message;
      assert.match(instruction, /source-language Writer and Translation/);
      assert.match(instruction, /without a label such as "Reading note"/);
      assert.doesNotMatch(instruction, /both accepted Writer outputs|both real Writer outputs/);
      assert.doesNotMatch(instruction, /separate paragraph labelled \*\*Reading note\*\*|另写为 \*\*阅读说明\*\*/);
    }
    const writerInstruction = writer.emittedStep.arguments.message;
    assert.match(writerInstruction, sourceLanguage === 'en' ? /complete source caption.*original wording/ : /完整原图注.*原文/);
    assert.doesNotMatch(writerInstruction, /original English wording|忠实翻译完整原文及注释/);
    assert.equal(writerInstruction.includes('ENGLISH_OPTIONAL_GUIDANCE'), sourceLanguage === 'en');
    assert.equal(translation.emittedStep.arguments.message.includes('ENGLISH_OPTIONAL_GUIDANCE'), translationLanguage === 'en');
    assert.doesNotMatch(editor.emittedStep.arguments.message, /ENGLISH_OPTIONAL_GUIDANCE/);
    assert.equal(JSON.parse(translation.emittedStep.arguments.message.split('\n\n').at(-1)).source_view.language, sourceLanguage);
    for (const role of ['evidence', 'methods', 'results', 'integration']) {
      const request = createConfiguredScienceRequest({ prepared, role, dispatchContext: fixture.broker.dispatchContext,
        task: { task_name: 'current_' + role, native_path: 'native/current-' + role + '.json' } });
      const instruction = request.emittedStep.arguments.message;
      assert.match(instruction, /source-language Writer.*Translation/);
      assert.doesNotMatch(instruction, /Both Writers receive|both real Writer outputs|both Writers|both writers/);
      assert.doesNotMatch(instruction, /English uses the original wording and Chinese a faithful translation/);
      if (role === 'results') assert.match(instruction, /source language.*faithful translation/i);
    }
  });
}

test('a previously frozen configured contract is reused byte for byte after restore', async t => {
  const { root, config } = await configuredRepo(t);
  const contractPath = fileURLToPath(new URL('../../prompts/v3/reading-first-contracts.md', import.meta.url));
  const prompt = await readFile(contractPath, 'utf8');
  const originalSections = Object.fromEntries([...prompt.matchAll(/^## (.+)\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)].map(match => [match[1], match[2].trim()]));
  const oldSections = {
    common: originalSections['Common data contract'],
    english: originalSections['English Writer'].split(/\r?\n\r?\n/).filter(paragraph => !/Nature Skills|Apply Humanizer|Apply stss|采用 Humanizer-zh|用 stss/.test(paragraph)).join('\n\n'),
  };
  const runId = 'run_' + 'd'.repeat(32), artifactRoot = join(root, '.tmp/runs', runId);
  let oldPrepared;
  const fixture = await reviewedReadingFirstFixture(t, { artifactRoot, runId,
    createRunControl: options => {
      const prepared = prepareConfiguredReading({ ...options, repoRoot: root });
      const control = structuredClone(prepared.runControl);
      control.reading_first_binding.configured_setup.sections['Common data contract'] = oldSections.common;
      control.reading_first_binding.configured_setup.sections['English Writer'] = oldSections.english;
      delete control.reading_first_binding.configured_setup.science_sections;
      oldPrepared = { ...prepared, runControl: control };
      return control;
    } });
  const checkpoint = snapshotReadingFirstRuntime(fixture.controller);
  const writer = checkpoint.state.request_entries.find(entry => entry.key === 'en').request.emittedStep.arguments.message;
  assert.ok(writer.includes(oldSections.common));
  assert.ok(writer.includes(oldSections.english));
  const legacyScience = createConfiguredScienceRequest({ prepared: oldPrepared, role: 'evidence', dispatchContext: fixture.broker.dispatchContext,
    task: { task_name: 'legacy_evidence', native_path: 'native/legacy-evidence.json' } });
  assert.match(legacyScience.emittedStep.arguments.message, /reconciles their identities and content for the Writers/);
  const receipt = await commitOwnedArtifact({ artifactRoot, dispatchContext: fixture.broker.dispatchContext,
    capability: fixture.broker.issueCapability({ runId, actorId: 'controller', role: 'control', artifactPath: 'checkpoint.json', revision: '1' }),
    artifact: { artifact_id: 'checkpoint', content: JSON.stringify(checkpoint) }, expectedRevision: '1' });
  config.reading.presentation_mode = 'writer';
  await writeFile(join(root, 'config/apa.local.json'), JSON.stringify(config));
  const restored = await restoreReadingFirstRuntime({ handoff: fixture.handoff, runControl: fixture.runControl, checkpointReceipt: receipt });
  assert.equal(restored.ok, true, JSON.stringify(restored.errors));
  const restoredWriter = snapshotReadingFirstRuntime(restored.controller).state.request_entries.find(entry => entry.key === 'en').request.emittedStep.arguments.message;
  assert.equal(restoredWriter, writer);
  assert.equal(await readFile(contractPath, 'utf8'), prompt);
});

test('local repair revises the source draft first and then retranslates it, while a translation-only issue skips the source', async t => {
  const { root, config } = await configuredRepo(t);
  config.reading.presentation_mode = 'writer';
  await writeFile(join(root, 'config/apa.local.json'), JSON.stringify(config));
  const review = affected => ({ overall: { complete: true, coherent: true, bilingual_consistent: true }, key_nodes: [
    { kind: 'main_conclusion', location: 'findings', finding: 'A supported finding.' },
    { kind: 'key_design', location: 'design', finding: 'A supported design.' },
  ], issues: [{ severity: 'material', kind: 'content', repair_owner: 'writer', affected_languages: affected, detail: 'Clarify the method.' }], scope: 'Synthetic local repair routing.' });
  const build = (digit, affected) => reviewedReadingFirstFixture(t, { artifactRoot: join(root, '.tmp/runs', 'run_' + digit.repeat(32)), runId: 'run_' + digit.repeat(32),
    createRunControl: options => prepareConfiguredReading({ ...options, repoRoot: root, instructionProfile: 'configured-reading-1.0', sourceLanguage: 'en', maxCalls: 6,
      taskBindings: Object.fromEntries(Object.entries(options.taskBindings).filter(([key]) => !key.startsWith('presentation'))) }).runControl,
    review: review(affected) });
  const sourceIssue = await build('9', ['en']);
  const first = createReadingFirstRevisionRequests({ controller: sourceIssue.controller });
  assert.deepEqual(first.map(request => request.language), ['en']);
  assert.throws(() => createReadingFirstRevisionRequests({ controller: sourceIssue.controller }), /READING_FIRST_SOURCE_DRAFT_PENDING/);
  await sourceIssue.complete(first[0], sourceIssue.views.find(view => view.language === 'en'));
  const counterpart = createReadingFirstRevisionRequests({ controller: sourceIssue.controller });
  assert.deepEqual(counterpart.map(request => request.language), ['zh-CN']);
  assert.equal(counterpart[0].packet.host_action_scope.role, 'translation');
  assert.equal(JSON.parse(counterpart[0].emittedStep.arguments.message.split('\n\n').at(-1)).source_view.language, 'en');
  const translationIssue = await build('a', ['zh-CN']);
  const only = createReadingFirstRevisionRequests({ controller: translationIssue.controller });
  assert.deepEqual(only.map(request => request.language), ['zh-CN']);
  assert.equal(only[0].packet.host_action_scope.role, 'translation');
});

test('a configured material review must name its owner before commit or a repair can be requested', async t => {
  const { root } = await configuredRepo(t);
  const runId = 'run_' + '4'.repeat(32);
  const fixture = await reviewedReadingFirstFixture(t, { artifactRoot: join(root, '.tmp/runs', runId), runId, completeReview: false,
    createRunControl: options => prepareConfiguredReading({ ...options, repoRoot: root, instructionProfile: 'configured-reading-1.0' }).runControl });
  assert.equal(fixture.binding.repair_routing, 'owner-routed-1.0');
  assert.equal(fixture.binding.configured_setup.flow_corrections.schema_version, 'flow-corrections-1.0');
  const review = { overall: { complete: false, coherent: true, bilingual_consistent: true }, key_nodes: [],
    issues: [{ severity: 'material', kind: 'content', detail: 'The missing owner must not trigger a Writer revision.', affected_languages: ['zh-CN'] }], scope: 'Synthetic configured review.' };
  const before = getReadingFirstState(fixture.controller).calls_used;
  await assert.rejects(() => fixture.complete(fixture.reviewRequest, review), /READING_FIRST_REVIEW_INVALID/);
  await assert.rejects(() => readFile(join(fixture.root, fixture.reviewRequest.task.artifact_path)), /ENOENT/);
  assert.equal(getReadingFirstState(fixture.controller).calls_used, before);
  assert.throws(() => createReadingFirstRevisionRequests({ controller: fixture.controller }), /READING_FIRST_REVISION_UNAVAILABLE/);
  assert.equal(snapshotReadingFirstRuntime(fixture.controller).state.request_entries.find(entry => entry.key === 'review').consumed, false);
  review.issues[0].repair_owner = 'writer';
  await fixture.complete(fixture.reviewRequest, review);
  assert.equal(getReadingFirstState(fixture.controller).status, 'revision_required');
});

test('configured source Writer, Translation, Editor and science requests consume resolved settings, then owned restore ignores changed local answers', async t => {
  const { root, config } = await configuredRepo(t);
  let prepared;
  const runId = 'run_' + 'b'.repeat(32);
  const artifactRoot = join(root, '.tmp/runs', runId);
  const fixture = await reviewedReadingFirstFixture(t, { artifactRoot, runId, instructionFiles: true,
    createRunControl: options => { prepared = prepareConfiguredReading({ ...options, repoRoot: root }); return prepared.runControl; } });
  assert.equal(prepared.paths.runRoot, artifactRoot);
  assert.equal(prepared.paths.parseRoot, join(root, '.tmp/parse', runId));
  assert.equal(prepared.paths.candidateRoot, join(root, '.tmp/candidates', runId));
  const saved = await materializeConfiguredReadingCandidate({ prepared, controller: fixture.controller, handoff: fixture.handoff, resources: fixture.resources });
  assert.equal(saved.exported.outputRoot, prepared.paths.candidateRoot);
  assert.equal(saved.exported.validation.status, 'passed');
  assert.equal(await readFile(join(prepared.paths.candidateRoot, fixture.candidate.notes[0].path), 'utf8'), fixture.candidate.notes[0].content);
  assert.equal(fixture.created.requests[0].language, 'en');
  assert.equal(fixture.created.requests[0].emittedStep.arguments.reasoning_effort, 'low');
  const writerInstruction = await readFile(fixture.created.requests[0].instruction_file.path, 'utf8');
  assert.doesNotMatch(writerInstruction, /Nature Skills|Humanizer|stss|自我辩护|Nature \+/);
  assert.match(writerInstruction, /Obsidian/);
  const checkpoint = snapshotReadingFirstRuntime(fixture.controller);
  const editor = checkpoint.state.request_entries.find(entry => entry.key === 'presentation').request;
  assert.equal(editor.emittedStep.arguments.reasoning_effort, 'low');
  assert.doesNotMatch(await readFile(editor.instruction_file.path, 'utf8'), /Nature|Humanizer/);
  const science = createConfiguredScienceRequest({ prepared, role: 'results', dispatchContext: fixture.broker.dispatchContext,
    task: { task_name: 'configured_results', native_path: 'native/new-results.json' }, payload: { upstream: 'synthetic' } });
  assert.equal(science.emittedStep.arguments.reasoning_effort, 'high');
  assert.match(science.emittedStep.arguments.message, /Common|source|Source/);
  const receipt = await commitOwnedArtifact({ artifactRoot, dispatchContext: fixture.broker.dispatchContext,
    capability: fixture.broker.issueCapability({ runId, actorId: 'controller', role: 'control', artifactPath: 'checkpoint.json', revision: '1' }),
    artifact: { artifact_id: 'checkpoint', content: JSON.stringify(checkpoint) }, expectedRevision: '1' });
  config.models.science.reasoning_effort = 'ultra';
  config.reading.source_language = 'zh-CN';
  await writeFile(join(root, 'config/apa.local.json'), JSON.stringify(config));
  const restored = await restoreReadingFirstRuntime({ handoff: fixture.handoff, runControl: fixture.runControl, checkpointReceipt: receipt });
  assert.equal(restored.ok, true, JSON.stringify(restored.errors));
  assert.equal(getReadingFirstState(restored.controller).status, 'reading_complete');
  assert.equal(prepared.runControl.reading_first_binding.source_language, 'en');
  assert.equal(prepared.runControl.reading_first_binding.first_writing_language, 'en');
  assert.equal(snapshotReadingFirstRuntime(restored.controller).control_fingerprint, checkpoint.control_fingerprint);
});

test('selected English guidance enters only the actual English Writer instruction', async t => {
  const { root } = await configuredRepo(t, true);
  const runId = 'run_' + 'c'.repeat(32);
  const fixture = await reviewedReadingFirstFixture(t, { artifactRoot: join(root, '.tmp/runs', runId), runId, instructionFiles: true,
    createRunControl: options => prepareConfiguredReading({ ...options, repoRoot: root }).runControl });
  const checkpoint = snapshotReadingFirstRuntime(fixture.controller);
  for (const entry of checkpoint.state.request_entries.filter(entry => ['en','zh-CN'].includes(entry.key))) {
    const message = await readFile(entry.request.instruction_file.path, 'utf8');
    assert.equal(message.includes('ENGLISH_OPTIONAL_GUIDANCE'), entry.key === 'en');
    assert.doesNotMatch(message, /Nature Skills|Apply stss|用 stss|Humanizer-zh/);
  }
});

test('configured non-GPT main and explicit role models survive the binding and emitted host requests', async t => {
  const { root, config } = await configuredRepo(t);
  const mainSession = { model: 'synthetic-provider/main-model', reasoning_effort: 'high' };
  config.models.science = { mode: 'explicit', model: 'synthetic-provider/science-model', reasoning_effort: 'low' };
  config.models.overrides = {};
  config.models.roles['english-writer'] = { mode: 'follow-main' };
  await writeFile(join(root, 'config/apa.local.json'), JSON.stringify(config));
  let prepared;
  const runId = 'run_' + 'f'.repeat(32);
  const fixture = await reviewedReadingFirstFixture(t, { artifactRoot: join(root, '.tmp/runs', runId), runId,
    createRunControl: options => {
      prepared = prepareConfiguredReading({ ...options, repoRoot: root, mainSession,
        supportedModelPairs: [mainSession, { model: 'synthetic-provider/science-model', reasoning_effort: 'low' }, { model: 'gpt-6.1-sol', reasoning_effort: 'low' }] });
      return prepared.runControl;
    } });
  const policy = prepared.runControl.reading_first_binding.role_model_policy;
  assert.deepEqual(policy.main_session, mainSession);
  const writer = snapshotReadingFirstRuntime(fixture.controller).state.request_entries.find(entry => entry.key === 'en').request;
  assert.equal(writer.emittedStep.arguments.model, 'synthetic-provider/main-model');
  assert.equal(writer.emittedStep.arguments.reasoning_effort, 'high');
  const science = createConfiguredScienceRequest({ prepared, role: 'evidence', dispatchContext: fixture.broker.dispatchContext,
    task: { task_name: 'configured_generic_evidence', native_path: 'native/generic-evidence.json' } });
  assert.equal(science.emittedStep.arguments.model, 'synthetic-provider/science-model');
  assert.equal(science.emittedStep.arguments.reasoning_effort, 'low');
  assert.equal(science.emittedStep.arguments.fork_turns, 'none');
  assert.throws(() => prepareConfiguredReading({ repoRoot: root, mainSession, supportedModelPairs: [], runId }), /APA_MODEL_UNSUPPORTED/);
});

test('configured writer-only presentation omits the Editor call and follows the main session only for selected roles', async t => {
  const { root, config } = await configuredRepo(t);
  config.reading = { source_language: 'en', presentation_mode: 'writer' };
  config.models.roles['english-writer'] = { mode: 'follow-main' };
  await writeFile(join(root, 'config/apa.local.json'), JSON.stringify(config));
  const runId = 'run_' + 'd'.repeat(32);
  const fixture = await reviewedReadingFirstFixture(t, { artifactRoot: join(root, '.tmp/runs', runId), runId,
    createRunControl: options => prepareConfiguredReading({ ...options, repoRoot: root, maxCalls: 6,
      taskBindings: Object.fromEntries(Object.entries(options.taskBindings).filter(([key]) => !key.startsWith('presentation'))) }).runControl });
  assert.equal(fixture.created.requests[0].language, 'en');
  assert.equal(fixture.created.requests[0].emittedStep.arguments.model, 'gpt-6-astra');
  assert.equal(fixture.created.requests[0].emittedStep.arguments.reasoning_effort, 'high');
  const checkpoint = snapshotReadingFirstRuntime(fixture.controller);
  assert.equal(checkpoint.state.request_entries.some(entry => entry.request.role === 'reading-editor'), false);
  assert.equal(checkpoint.state.request_entries.length, 3);
  assert.equal(fixture.candidate.review_status, 'pending');
});

test('one configured reading proceeds through its controlled synthetic publication and committed bilingual index', async t => {
  const { root } = await configuredRepo(t);
  const runId = 'run_' + 'e'.repeat(32);
  let prepared;
  const fixture = await readingFirstPublicationFixture(t, { artifactRoot: join(root, '.tmp/runs', runId), runId, instructionFiles: true,
    createRunControl: options => { prepared = prepareConfiguredReading({ ...options, repoRoot: root }); return prepared.runControl; } });
  for (const role of ['evidence', 'methods', 'results', 'interpretation', 'scientific-reading', 'integration']) {
    const science = createConfiguredScienceRequest({ prepared, role, dispatchContext: fixture.broker.dispatchContext,
      task: { task_name: 'configured_' + role.replaceAll('-', '_'), native_path: 'native/configured-' + role + '.json' } });
    assert.equal(science.emittedStep.arguments.model, 'gpt-6.1-sol');
    assert.equal(science.emittedStep.arguments.reasoning_effort, role === 'results' ? 'high' : 'low');
  }
  const saved = await materializeConfiguredReadingCandidate({ prepared, controller: fixture.controller, handoff: fixture.handoff, resources: fixture.resources });
  assert.equal(saved.exported.outputRoot, prepared.paths.candidateRoot);
  assert.equal(saved.exported.validation.status, 'passed');
  const before = await loadBilingualPublication({ vaultRoot: fixture.vaultRoot, run: fixture.run, trustAnchor: fixture.registration.trust_anchor });
  assert.equal(before.reviewManifest.profile, 'reading-first-obsidian-1.0');
  assert.deepEqual(before.plan.hashes, fixture.plan.hashes);
  const applied = await applyBilingualPublication(applyReadingFirstFixture(fixture));
  assert.equal(applied.status, 'committed');
  const snapshot = await readCommittedGeneration({ vaultRoot: fixture.vaultRoot });
  assert.equal(snapshot.ok, true, JSON.stringify(snapshot.errors));
  assert.equal(snapshot.generation.evidence_mode, 'synthetic');
  for (const note of fixture.candidate.notes) {
    assert.equal(await readFile(join(fixture.vaultRoot, note.path), 'utf8'), note.content);
    assert.equal(await readFile(join(prepared.paths.candidateRoot, note.path), 'utf8'), note.content);
  }
  for (const query of ['supported', '研究结果', 'supportonlytoken', '仅知识页词']) {
    const found = queryBilingualIndex({ index: snapshot.index, activeSnapshot: snapshot, query });
    assert.ok(found.results.length, query);
    if (query === 'supportonlytoken') assert.ok(found.results.some(row => row.hits.some(hit => hit.path.startsWith('Wiki/methods/'))));
  }
  const after = await loadBilingualPublication({ vaultRoot: fixture.vaultRoot, run: fixture.run, trustAnchor: fixture.registration.trust_anchor });
  assert.deepEqual(after.plan.hashes, fixture.plan.hashes);
});

test('a saved host dispatch shapes every configured role call and the run still reaches reading_complete', async t => {
  const { buildHostDispatchArguments } = await import('../../scripts/apa-model-policy.mjs');
  const { root, config } = await configuredRepo(t);
  const dispatch = { tool: 'Agent', model_argument: 'model', effort_argument: 'effort', instruction_argument: 'prompt', task_name_argument: 'description', fresh_context: null };
  config.host = { name: 'claude-code', dispatch };
  config.models.science = { mode: 'explicit', model: 'opus', reasoning_effort: 'high' };
  config.models.overrides = {};
  for (const role of Object.keys(config.models.roles)) config.models.roles[role] = { mode: 'follow-main' };
  await writeFile(join(root, 'config/apa.local.json'), JSON.stringify(config));
  let prepared;
  const runId = 'run_' + '9'.repeat(32);
  const fixture = await reviewedReadingFirstFixture(t, { artifactRoot: join(root, '.tmp/runs', runId), runId,
    createRunControl: options => { prepared = prepareConfiguredReading({ ...options, mainSession: undefined, sessionContext: { model: 'sonnet' }, repoRoot: root }); return prepared.runControl; } });
  const binding = prepared.runControl.reading_first_binding;
  assert.deepEqual(binding.host, config.host);
  assert.deepEqual(binding.role_model_policy.main_session, { model: 'sonnet' });
  assert.equal(getReadingFirstState(fixture.controller).status, 'reading_complete');
  const entries = snapshotReadingFirstRuntime(fixture.controller).state.request_entries;
  assert.ok(entries.length >= 4);
  for (const { request } of entries) {
    assert.equal(request.packet.host_action_scope.action, 'Agent');
    assert.deepEqual(Object.keys(request.emittedStep.arguments), ['description', 'prompt', 'model']);
    assert.equal(request.emittedStep.arguments.model, 'sonnet');
    assert.deepEqual(inspectDispatchArguments({ prepared, request }), request.emittedStep.arguments);
    const withEffort = structuredClone(request);
    withEffort.emittedStep.arguments.effort = 'high';
    assert.throws(() => getConfiguredReadingDispatchArguments({ prepared, request: withEffort }), /APA_CONFIGURED_DISPATCH_MISMATCH/);
    const codexShaped = structuredClone(request);
    delete codexShaped.packet.host_action_scope.dispatch;
    assert.throws(() => getConfiguredReadingDispatchArguments({ prepared, request: codexShaped }), /APA_CONFIGURED_DISPATCH_MISMATCH/);
  }
  const science = createConfiguredScienceRequest({ prepared, role: 'evidence', dispatchContext: fixture.broker.dispatchContext,
    task: { task_name: 'host_evidence', native_path: 'native/host-evidence.json' } });
  assert.deepEqual(Object.keys(science.emittedStep.arguments), ['description', 'prompt', 'model', 'effort']);
  assert.deepEqual([science.emittedStep.arguments.description, science.emittedStep.arguments.model, science.emittedStep.arguments.effort], ['host_evidence', 'opus', 'high']);
  assert.deepEqual(inspectDispatchArguments({ prepared, request: science }), science.emittedStep.arguments);
  assert.throws(() => buildHostDispatchArguments({ ...dispatch, effort_argument: null }, { taskName: 'x', message: 'm', model: { model: 'opus', reasoning_effort: 'high' } }), /APA_HOST_EFFORT_UNSUPPORTED/);
  assert.throws(() => buildHostDispatchArguments({ ...dispatch, effort_argument: 'model' }, { taskName: 'x', message: 'm', model: { model: 'opus' } }), /APA_HOST_DISPATCH_INVALID/);
});

test('a saved host dispatch with instruction files keeps each request current under its own instruction argument', async t => {
  const { root, config } = await configuredRepo(t);
  config.host = { name: 'claude-code', dispatch: { tool: 'Agent', model_argument: 'model', effort_argument: 'effort', instruction_argument: 'prompt', task_name_argument: 'description', fresh_context: null } };
  await writeFile(join(root, 'config/apa.local.json'), JSON.stringify(config));
  const runId = 'run_' + '8'.repeat(32);
  const fixture = await reviewedReadingFirstFixture(t, { artifactRoot: join(root, '.tmp/runs', runId), runId, instructionFiles: true,
    createRunControl: options => prepareConfiguredReading({ ...options, repoRoot: root }).runControl });
  assert.equal(getReadingFirstState(fixture.controller).status, 'reading_complete');
  for (const { request } of snapshotReadingFirstRuntime(fixture.controller).state.request_entries) {
    assert.equal(request.emittedStep.arguments.message, undefined);
    assert.match(request.emittedStep.arguments.prompt, /^Read the complete instruction file: /);
  }
});

test('a host without model selection sends neither model nor effort and blocks explicit role choices', async t => {
  const { root, config } = await configuredRepo(t);
  config.host = { name: 'deepseek-harness', dispatch: { tool: 'subagent', model_argument: null, effort_argument: null, instruction_argument: 'prompt', task_name_argument: 'description', fresh_context: null } };
  config.models.science = { mode: 'follow-main' };
  config.models.overrides = {};
  for (const role of Object.keys(config.models.roles)) config.models.roles[role] = { mode: 'follow-main' };
  await writeFile(join(root, 'config/apa.local.json'), JSON.stringify(config));
  let prepared, options;
  const runId = 'run_' + '8'.repeat(32);
  const sessionContext = { model: 'deepseek-flash', effort: 'high' };
  const fixture = await reviewedReadingFirstFixture(t, { artifactRoot: join(root, '.tmp/runs', runId), runId,
    createRunControl: input => { options = input; prepared = prepareConfiguredReading({ ...input, mainSession: undefined, sessionContext, repoRoot: root }); return prepared.runControl; } });
  assert.equal(getReadingFirstState(fixture.controller).status, 'reading_complete');
  for (const { request } of snapshotReadingFirstRuntime(fixture.controller).state.request_entries) {
    assert.equal(request.packet.host_action_scope.action, 'subagent');
    assert.deepEqual(Object.keys(request.emittedStep.arguments), ['description', 'prompt']);
    assert.equal(request.packet.requested_model, 'deepseek-flash');
    const withModel = structuredClone(request);
    withModel.emittedStep.arguments.model = 'deepseek-flash';
    assert.throws(() => getConfiguredReadingDispatchArguments({ prepared, request: withModel }), /APA_CONFIGURED_DISPATCH_MISMATCH/);
  }
  const science = createConfiguredScienceRequest({ prepared, role: 'methods', dispatchContext: fixture.broker.dispatchContext,
    task: { task_name: 'inherit_methods', native_path: 'native/inherit-methods.json' } });
  assert.deepEqual(Object.keys(science.emittedStep.arguments), ['description', 'prompt']);
  config.models.science = { mode: 'explicit', model: 'deepseek-flash', reasoning_effort: 'high' };
  await writeFile(join(root, 'config/apa.local.json'), JSON.stringify(config));
  assert.throws(() => prepareConfiguredReading({ ...options, mainSession: undefined, sessionContext, repoRoot: root }), /APA_CONFIG_INCOMPLETE.*models\.science requires follow-main/);
});

const claudeResultHandle = { source: 'text', pattern: 'agentId:\\s*([A-Za-z0-9_-]+)' };
async function hostHandleRun(t, host) {
  const { root, config } = await configuredRepo(t);
  if (host) config.host = { name: host.name, dispatch: { tool: 'Agent', model_argument: 'model', effort_argument: 'effort', instruction_argument: 'prompt', task_name_argument: 'description', fresh_context: null, ...host.extra } };
  await writeFile(join(root, 'config/apa.local.json'), JSON.stringify(config));
  let prepared;
  const runId = 'run_' + '6'.repeat(32);
  const fixture = await reviewedReadingFirstFixture(t, { artifactRoot: join(root, '.tmp/runs', runId), runId,
    createRunControl: options => { prepared = prepareConfiguredReading({ ...options, repoRoot: root }); return prepared.runControl; } });
  // Observed steps carry only path, hash and length of the source, so the science request uses the same three fields.
  const sources = prepared.scientificInput.sources.map(({ path, sha256, byte_length }) => ({ path, sha256, byte_length }));
  const science = createConfiguredScienceRequest({ prepared: { ...prepared, scientificInput: { ...prepared.scientificInput, sources } }, role: 'evidence', dispatchContext: fixture.broker.dispatchContext,
    task: { task_name: 'handle_evidence', native_path: 'native/handle-evidence.json' } });
  const step = science.emittedStep;
  const observe = raw => ingestObservedRunStep({ packet: science.packet, emittedStep: step, run: { run_id: science.packet.run_id },
    observation: { action_id: step.action_id, run_id: science.packet.run_id, input_fingerprint: step.input_fingerprint, port: 'current-collaboration',
      tool_call: { name: step.action, arguments: step.arguments }, raw_result_text: raw } });
  return { prepared, fixture, science, observe };
}

test('claude-code dispatch records the agentId from result text', async t => {
  const { extractHostTaskHandle } = await import('../../scripts/apa-model-policy.mjs');
  const { prepared, fixture, science, observe } = await hostHandleRun(t, { name: 'claude-code', extra: { result_handle: claudeResultHandle } });
  const dispatch = prepared.runControl.reading_first_binding.host.dispatch;
  assert.deepEqual(dispatch.result_handle, claudeResultHandle);
  assert.deepEqual(science.packet.host_action_scope.result_bindings.agent_id, claudeResultHandle);
  assert.equal(getReadingFirstState(fixture.controller).status, 'reading_complete');
  for (const { request } of snapshotReadingFirstRuntime(fixture.controller).state.request_entries) assert.deepEqual(request.packet.host_action_scope.result_bindings.agent_id, claudeResultHandle);
  const raw = 'Evidence map written.\nagentId: a1b2c3 (use SendMessage with to: a1b2c3 to continue this agent)';
  assert.equal(extractHostTaskHandle(raw, dispatch), 'a1b2c3');
  const observed = observe(raw);
  assert.equal(observed.status, 'observed');
  assert.equal(observed.agent_id, 'a1b2c3');
  assert.equal(observed.host_task_handle_status, 'extracted');
  assert.equal(observed.raw_result_text, raw);
  const unbound = structuredClone(science);
  unbound.packet.host_action_scope.result_bindings.agent_id = null;
  assert.throws(() => getConfiguredReadingDispatchArguments({ prepared, request: unbound }), /APA_CONFIGURED_DISPATCH_MISMATCH/);
});

test('missing agentId stays null and is reported', async t => {
  const { extractHostTaskHandle } = await import('../../scripts/apa-model-policy.mjs');
  const { prepared, observe } = await hostHandleRun(t, { name: 'claude-code', extra: { result_handle: claudeResultHandle } });
  const raw = 'Evidence map written; no handle line.';
  assert.equal(extractHostTaskHandle(raw, prepared.runControl.reading_first_binding.host.dispatch), null);
  const observed = observe(raw);
  assert.equal(observed.status, 'observed');
  assert.equal(observed.blocked_reason, null);
  assert.equal(observed.agent_id, null);
  assert.equal(observed.host_task_handle_status, 'not_found_in_result_text');
  assert.equal(observed.raw_result_text, raw);
  const { result_handle: _ignored, ...withoutHandle } = prepared.runControl.reading_first_binding.host.dispatch;
  assert.equal(extractHostTaskHandle('agentId: a1b2c3', withoutHandle), null);
});

test('codex dispatch keeps its structured agent_id path', async t => {
  const codex = await hostHandleRun(t);
  assert.deepEqual(codex.science.packet.host_action_scope.result_bindings.agent_id, ['agent_id']);
  const observed = codex.observe(JSON.stringify({ agent_id: 'codex-77', note: 'agentId: other' }));
  assert.equal(observed.agent_id, 'codex-77');
  assert.equal(Object.hasOwn(observed, 'host_task_handle_status'), false);
  const saved = await hostHandleRun(t, { name: 'claude-code', extra: {} });
  assert.equal(saved.science.packet.host_action_scope.result_bindings.agent_id, null);
  const legacy = saved.observe('agentId: not-declared');
  assert.equal(legacy.agent_id, saved.science.emittedStep.action_id);
  assert.equal(Object.hasOwn(legacy, 'host_task_handle_status'), false);
});
