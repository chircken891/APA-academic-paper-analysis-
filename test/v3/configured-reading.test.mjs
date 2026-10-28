import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { exportPublicApa } from '../../scripts/setup/export-public-apa.mjs';
import { prepareConfiguredReading, createConfiguredScienceRequest, getConfiguredReadingDispatchArguments, materializeConfiguredReadingCandidate } from '../../scripts/v3/configured-reading.mjs';
import { reviewedReadingFirstFixture } from './helpers/reading-first-publication-source-fixtures.mjs';
import { commitOwnedArtifact } from '../../scripts/v3/owned-artifact-store.mjs';
import { createReadingFirstRevisionRequests, createReadingFirstPresentationRequest, createReadingFirstReviewRequest, renderReadingFirstNotes, fingerprintReadingFirst, restoreReadingFirstRuntime, snapshotReadingFirstRuntime, getReadingFirstState } from '../../scripts/v3/reading-first-runtime.mjs';
import { readingFirstPublicationFixture, applyReadingFirstFixture } from './helpers/reading-first-publication-fixtures.mjs';
import { readingFirstIndexFixture } from './helpers/reading-first-index-fixtures.mjs';
import { readCommittedReadingFirstKnowledgeRegistry } from '../../scripts/v3/reading-first-knowledge-registry.mjs';
import { applyBilingualPublication, loadBilingualPublication } from '../../scripts/v3/phase22-publication.mjs';
import { readCommittedGeneration } from '../../scripts/v3/phase22-active-version.mjs';
import { queryBilingualIndex } from '../../scripts/v3/phase22-search.mjs';

async function configuredRepo(t, enabled = false) {
  const root = await mkdtemp(join(tmpdir(), 'apa-configured-reading-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'config'));
  const guide = join(root, 'humanizer.md');
  await writeFile(guide, 'ENGLISH_OPTIONAL_GUIDANCE: explain concrete actions.');
  const choice = { mode: 'explicit', model: 'gpt-6.1-sol', reasoning_effort: 'low' };
  const config = { schema_version: 'apa-local-config-1.0', models: { science: choice, overrides: { results: { ...choice, reasoning_effort: 'high' } },
    roles: Object.fromEntries(['english-writer','chinese-writer','reading-editor','independent-verifier'].map(role => [role, choice])) },
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

async function configuredCommittedReuseFixture(t) {
  const { root } = await configuredRepo(t);
  const prior = await readingFirstIndexFixture(t, { vaultRoot: root });
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
  const resources = [...fixture.resources, ...Object.values(prior.paper.paths).map(path => ({ path, content: '# Existing committed paper\n' }))];
  return { root, prior, fixture, prepared, resources };
}

test('new configured materialization freezes and loads committed knowledge, refusing an injected registry', async t => {
  const { root, prior, fixture, prepared, resources } = await configuredCommittedReuseFixture(t);
  assert.deepEqual(prepared.runControl.reading_first_binding.configured_setup.knowledge_registry,
    { policy: 'committed-generation-1.0', vault_root: root });
  const args = { prepared, controller: fixture.controller, handoff: fixture.handoff, resources };
  await assert.rejects(materializeConfiguredReadingCandidate({ ...args, knowledgeRegistry: [{ id: 'orphan', path: 'Wiki/methods/orphan.md', content: 'uncommitted' }] }), /APA_CONFIGURED_KNOWLEDGE_REGISTRY_MISMATCH/);
  const trusted = await readCommittedReadingFirstKnowledgeRegistry({ vaultRoot: root });
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
  const trusted = await readCommittedReadingFirstKnowledgeRegistry({ vaultRoot: root });
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
  const empty = await readCommittedReadingFirstKnowledgeRegistry({ vaultRoot: root });
  assert.doesNotThrow(() => renderReadingFirstNotes({ controller: fixture.controller, knowledgeRegistry: empty }));
  empty.push({ id: 'orphan', path: 'Wiki/methods/orphan.md', content: 'uncommitted' });
  assert.throws(() => renderReadingFirstNotes({ controller: fixture.controller, knowledgeRegistry: empty }), /RF_KNOWLEDGE_REGISTRY_NOT_TRUSTED/);
});

test('configured low-level rendering rejects stale committed data and a trusted registry from a different root', async t => {
  const { root, prior, fixture } = await configuredCommittedReuseFixture(t);
  const trusted = await readCommittedReadingFirstKnowledgeRegistry({ vaultRoot: root });
  assert.doesNotThrow(() => renderReadingFirstNotes({ controller: fixture.controller, knowledgeRegistry: trusted }));
  const { root: otherRoot } = await configuredRepo(t);
  const other = await readCommittedReadingFirstKnowledgeRegistry({ vaultRoot: otherRoot });
  assert.throws(() => renderReadingFirstNotes({ controller: fixture.controller, knowledgeRegistry: other }), /RF_KNOWLEDGE_REGISTRY_NOT_TRUSTED/);
  const path = join(root, prior.manifest.targets.support[0].path);
  await writeFile(path, (await readFile(path, 'utf8')) + '\ntampered\n');
  assert.throws(() => renderReadingFirstNotes({ controller: fixture.controller, knowledgeRegistry: trusted }), /P22_SNAPSHOT_NOT_CURRENT/);
});

test('configured materialization rejects changed committed knowledge before export', async t => {
  const { root, prior, fixture, prepared, resources } = await configuredCommittedReuseFixture(t);
  const path = join(root, prior.manifest.targets.support[0].path);
  await writeFile(path, (await readFile(path, 'utf8')) + '\ntampered\n');
  await assert.rejects(materializeConfiguredReadingCandidate({ prepared, controller: fixture.controller, handoff: fixture.handoff, resources }), /RF_KNOWLEDGE_REGISTRY_COMMITTED_INVALID/);
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
        prepared = configured.prepareConfiguredReading({ ...options, repoRoot: root });
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
      createRunControl: options => { prepared = prepareConfiguredReading({ ...options, repoRoot: root }); return prepared.runControl; },
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
      assert.deepEqual(getConfiguredReadingDispatchArguments({ prepared, request }), request.emittedStep.arguments);
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

test('science instruction retry reuses identical bytes and rejects conflicting content without overwriting', async t => {
  const { root } = await configuredRepo(t);
  let prepared;
  const runId = 'run_' + '2'.repeat(32);
  const fixture = await reviewedReadingFirstFixture(t, { artifactRoot: join(root, '.tmp/runs', runId), runId, instructionFiles: true,
    createRunControl: options => { prepared = prepareConfiguredReading({ ...options, repoRoot: root }); return prepared.runControl; } });
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
  assert.deepEqual(new Set(entries.map(entry => entry.request.packet.host_action_scope.role)), new Set(['english-writer', 'chinese-writer', 'reading-editor', 'independent-verifier']));
  for (const request of requests) {
    const actual = getConfiguredReadingDispatchArguments({ prepared, request });
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

for (const [sourceLanguage, firstWritingLanguage, digit] of [['en', 'zh-CN', '7'], ['zh-CN', 'en', '8']]) {
  test(`${sourceLanguage} original keeps source-note routing when ${firstWritingLanguage} is written first`, async t => {
    const { root, config } = await configuredRepo(t);
    config.reading.source_language = firstWritingLanguage;
    await writeFile(join(root, 'config/apa.local.json'), JSON.stringify(config));
    let prepared;
    const runId = 'run_' + digit.repeat(32);
    const fixture = await reviewedReadingFirstFixture(t, { artifactRoot: join(root, '.tmp/runs', runId), runId,
      createRunControl: options => {
        prepared = prepareConfiguredReading({ ...options, repoRoot: root, sourceLanguage });
        return prepared.runControl;
      } });
    assert.equal(fixture.created.requests[0].language, firstWritingLanguage);
    const checkpoint = snapshotReadingFirstRuntime(fixture.controller);
    const counterpart = checkpoint.state.request_entries.find(entry => ['en', 'zh-CN'].includes(entry.key) && entry.key !== firstWritingLanguage);
    assert.equal(counterpart.payload.source_view.language, firstWritingLanguage);
    for (const note of fixture.candidate.notes) {
      assert.ok(note.path.startsWith(note.language === sourceLanguage ? 'Wiki/sources/' : 'Wiki/translations/'), note.path);
    }
    const saved = await materializeConfiguredReadingCandidate({ prepared, controller: fixture.controller, handoff: fixture.handoff,
      resources: fixture.resources, targetRegistry: undefined });
    assert.deepEqual(saved.exported.notes.map(note => note.path), fixture.candidate.notes.map(note => note.path));
    assert.equal(saved.exported.validation.status, 'passed');
  });
}

test('local repair follows the first-written view even when the paper source language differs', async t => {
  const { root, config } = await configuredRepo(t);
  config.reading.presentation_mode = 'writer';
  await writeFile(join(root, 'config/apa.local.json'), JSON.stringify(config));
  const runId = 'run_' + '9'.repeat(32);
  const fixture = await reviewedReadingFirstFixture(t, { artifactRoot: join(root, '.tmp/runs', runId), runId,
    createRunControl: options => prepareConfiguredReading({ ...options, repoRoot: root, sourceLanguage: 'en', maxCalls: 6,
      taskBindings: Object.fromEntries(Object.entries(options.taskBindings).filter(([key]) => !key.startsWith('presentation'))) }).runControl,
    review: { overall: { complete: true, coherent: true, bilingual_consistent: true }, key_nodes: [
      { kind: 'main_conclusion', location: 'findings', finding: 'A supported finding.' },
      { kind: 'key_design', location: 'design', finding: 'A supported design.' },
    ], issues: [{ severity: 'material', kind: 'content', repair_owner: 'writer', affected_languages: ['zh-CN'], detail: 'Clarify the method in the first-written account.' }], scope: 'Synthetic local repair routing.' },
  });
  const first = createReadingFirstRevisionRequests({ controller: fixture.controller });
  assert.deepEqual(first.map(request => request.language), ['zh-CN']);
  await fixture.complete(first[0], fixture.views.find(view => view.language === 'zh-CN'));
  const counterpart = createReadingFirstRevisionRequests({ controller: fixture.controller });
  assert.deepEqual(counterpart.map(request => request.language), ['en']);
  assert.equal(JSON.parse(counterpart[0].emittedStep.arguments.message.split('\n\n').at(-1)).source_view.language, 'zh-CN');
});

test('a configured material review must name its owner before commit or a repair can be requested', async t => {
  const { root } = await configuredRepo(t);
  const runId = 'run_' + '4'.repeat(32);
  const fixture = await reviewedReadingFirstFixture(t, { artifactRoot: join(root, '.tmp/runs', runId), runId, completeReview: false,
    createRunControl: options => prepareConfiguredReading({ ...options, repoRoot: root }).runControl });
  assert.equal(fixture.binding.repair_routing, 'owner-routed-1.0');
  assert.equal(fixture.binding.configured_setup.flow_corrections.schema_version, 'flow-corrections-1.0');
  const review = { overall: { complete: false, coherent: true, bilingual_consistent: true }, key_nodes: [],
    issues: [{ severity: 'material', kind: 'content', detail: 'The missing owner must not trigger a Writer revision.', affected_languages: ['en'] }], scope: 'Synthetic configured review.' };
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

test('configured source-first Writer, Editor and science requests consume resolved settings, then owned restore ignores changed local answers', async t => {
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
  assert.equal(fixture.created.requests[0].language, 'zh-CN');
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
  config.reading.source_language = 'en';
  await writeFile(join(root, 'config/apa.local.json'), JSON.stringify(config));
  const restored = await restoreReadingFirstRuntime({ handoff: fixture.handoff, runControl: fixture.runControl, checkpointReceipt: receipt });
  assert.equal(restored.ok, true, JSON.stringify(restored.errors));
  assert.equal(getReadingFirstState(restored.controller).status, 'reading_complete');
  assert.equal(prepared.runControl.reading_first_binding.source_language, 'en');
  assert.equal(prepared.runControl.reading_first_binding.first_writing_language, 'zh-CN');
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
    assert.deepEqual(getConfiguredReadingDispatchArguments({ prepared, request }), request.emittedStep.arguments);
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
  assert.deepEqual(getConfiguredReadingDispatchArguments({ prepared, request: science }), science.emittedStep.arguments);
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
