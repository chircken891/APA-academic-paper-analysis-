import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareConfiguredReading, createConfiguredScienceRequest, getConfiguredReadingDispatchArguments, materializeConfiguredReadingCandidate } from '../../scripts/v3/configured-reading.mjs';
import { reviewedReadingFirstFixture } from './helpers/reading-first-publication-source-fixtures.mjs';
import { commitOwnedArtifact } from '../../scripts/v3/owned-artifact-store.mjs';
import { createReadingFirstRevisionRequests, restoreReadingFirstRuntime, snapshotReadingFirstRuntime, getReadingFirstState } from '../../scripts/v3/reading-first-runtime.mjs';
import { readingFirstPublicationFixture, applyReadingFirstFixture } from './helpers/reading-first-publication-fixtures.mjs';
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
    ], issues: [{ severity: 'material', kind: 'content', affected_languages: ['zh-CN'], detail: 'Clarify the method in the first-written account.' }], scope: 'Synthetic local repair routing.' },
  });
  const first = createReadingFirstRevisionRequests({ controller: fixture.controller });
  assert.deepEqual(first.map(request => request.language), ['zh-CN']);
  await fixture.complete(first[0], fixture.views.find(view => view.language === 'zh-CN'));
  const counterpart = createReadingFirstRevisionRequests({ controller: fixture.controller });
  assert.deepEqual(counterpart.map(request => request.language), ['en']);
  assert.equal(JSON.parse(counterpart[0].emittedStep.arguments.message.split('\n\n').at(-1)).source_view.language, 'zh-CN');
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
