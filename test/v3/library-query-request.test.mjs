import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readingFirstIndexFixture, saveReadingFirstPair, digest } from './helpers/reading-first-index-fixtures.mjs';
import { buildBilingualIndex } from '../../scripts/v3/phase22-search.mjs';

const library = () => import('../../scripts/v3/library-query.mjs');
const mainSession = { model: 'synthetic-main', reasoning_effort: 'high' };
const alternate = { model: 'synthetic-alternate', reasoning_effort: 'medium' };
const hostCapabilities = { currentSession: true, nativeDelegation: true };
const inputs = repoRoot => ({ repoRoot, question: 'finalresultneedle', mainSession, hostCapabilities });

test('answer is rejected when retrieved current note changes during host execution', async t => {
  const f = await fixture(t);
  const { executeLibraryQuery } = await library();
  await assert.rejects(executeLibraryQuery({ ...inputs(f.vaultRoot), executeHost: async task => {
    const path = join(f.vaultRoot, task.evidence.results[0].hits[0].path);
    await writeFile(path, (await readFile(path, 'utf8')) + '\nchanged after retrieval\n');
    return 'Answer based on a previous snapshot.';
  } }), { code: 'P23_CURRENT_CHANGED' });
});

test('query freezes configured presentation defaults and current request overrides without saving choices', async t => {
  const f = await fixture(t, { query: { answer_language: 'zh-CN', detail: 'detailed', audience: 'beginner' } });
  const { prepareLibraryQuery } = await library();
  const configBefore = await readFile(join(f.vaultRoot, 'config/apa.local.json'));
  const configured = await prepareLibraryQuery(inputs(f.vaultRoot));
  assert.deepEqual(configured.task.evidence.preferences, { answer_language: 'zh-CN', detail: 'detailed', audience: 'beginner' });
  const overridden = await prepareLibraryQuery({ ...inputs(f.vaultRoot), preferences: { answer_language: 'en', detail: 'concise' } });
  assert.deepEqual(overridden.task.evidence.preferences, { answer_language: 'en', detail: 'concise', audience: 'beginner' });
  assert.notEqual(configured.input_fingerprint, overridden.input_fingerprint);
  assert.equal(overridden.input_fingerprint, digest(Buffer.from(JSON.stringify(overridden.task.evidence))));
  assert.match(overridden.task.prompt, /Explicit language, detail or audience instructions.*take precedence/);
  assert.deepEqual(await readFile(join(f.vaultRoot, 'config/apa.local.json')), configBefore);
  const blank = await fixture(t);
  assert.deepEqual((await prepareLibraryQuery(inputs(blank.vaultRoot))).task.evidence.preferences,
    { answer_language: 'question', detail: 'adaptive', audience: 'adaptive' });
  for (const preferences of [null, [], { detail: 'maximum' }, { publish: true }]) {
    await assert.rejects(prepareLibraryQuery({ ...inputs(f.vaultRoot), preferences }), /APA_QUERY_PREFERENCES_INVALID/);
  }
});
async function fixture(t, config) {
  const f = await readingFirstIndexFixture(t);
  await f.save(await f.build());
  if (config) {
    await mkdir(join(f.vaultRoot, 'config'), { recursive: true });
    await writeFile(join(f.vaultRoot, 'config/apa.local.json'), JSON.stringify({ schema_version: 'apa-local-config-1.0', ...config }));
  }
  return f;
}

test('follow-main prepares one current task with real committed hits and no reading setup', async t => {
  const f = await fixture(t);
  const { prepareLibraryQuery } = await library();
  const prepared = await prepareLibraryQuery(inputs(f.vaultRoot));
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.query_mode, 'follow-main');
  assert.deepEqual(prepared.requested_identity, mainSession);
  assert.equal(prepared.task.execution, 'current-session');
  assert.equal(prepared.task.fork_turns, 'none');
  assert.equal(prepared.task.model, mainSession.model);
  assert.equal(prepared.generation_id, 'rf-a');
  assert.equal(prepared.results[0].paper_id, f.identity.paper_id);
  assert.equal(prepared.task.evidence.generation_id, prepared.generation_id);
  assert.deepEqual(prepared.task.evidence.results, prepared.results);
  assert.match(prepared.config_fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(prepared.answer, undefined);
});

test('explicit alternate is actually consumed by one injected native host without writing config', async t => {
  const f = await fixture(t, { models: { query: { mode: 'explicit', ...alternate } } });
  const { executeLibraryQuery } = await library();
  const before = await readFile(join(f.vaultRoot, 'config/apa.local.json'));
  const seen = [];
  const result = await executeLibraryQuery({ ...inputs(f.vaultRoot), supportedModelPairs: [mainSession, alternate], executeHost: async task => {
    seen.push(task);
    assert.equal(task.execution, 'native-delegation');
    assert.equal(task.model, alternate.model);
    assert.equal(task.reasoning_effort, alternate.reasoning_effort);
    assert.equal(task.fork_turns, 'none');
    return { answer: `Compared ${task.evidence.results[0].paper_id} under its stated conditions.`, observable_identity: alternate };
  } });
  assert.equal(seen.length, 1);
  assert.equal(result.status, 'answered');
  assert.match(result.answer, new RegExp(f.identity.paper_id));
  assert.deepEqual(result.requested_identity, alternate);
  assert.deepEqual(result.observable_identity, { status: 'reported', ...alternate });
  assert.deepEqual(await readFile(join(f.vaultRoot, 'config/apa.local.json')), before);
});

test('current task consumes follow-main and preserves unknown actual identity', async t => {
  const f = await fixture(t);
  const { executeLibraryQuery } = await library();
  let calls = 0;
  const result = await executeLibraryQuery({ ...inputs(f.vaultRoot), executeHost: async task => {
    calls++;
    assert.equal(task.execution, 'current-session');
    assert.equal(task.model, mainSession.model);
    assert.equal(task.reasoning_effort, mainSession.reasoning_effort);
    return 'One synthetic study supports the result under its comparison conditions.';
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result.observable_identity, { status: 'unknown', model: null, reasoning_effort: null });
});

test('short explicit retrieval query recalls evidence while one task answers the full original question', async t => {
  const f = await fixture(t);
  const { executeLibraryQuery, prepareLibraryQuery } = await library();
  const question = 'Explain how finalresultneedle was established and which study conditions limit its use for clinical practice.';
  assert.equal((await prepareLibraryQuery({ ...inputs(f.vaultRoot), question })).status, 'no_matches');
  let calls = 0;
  const result = await executeLibraryQuery({ ...inputs(f.vaultRoot), question, searchQuery: 'finalresultneedle', executeHost: async task => {
    calls++;
    assert.equal(task.execution, 'current-session');
    assert.equal(task.question, question);
    assert.equal(task.evidence.question, question);
    assert.equal(task.evidence.retrieval_query, 'finalresultneedle');
    assert.equal(task.evidence.results[0].paper_id, f.identity.paper_id);
    assert.ok(task.prompt.includes(question));
    assert.match(task.prompt, /answer the original question/i);
    return 'Synthetic answer to the full original question under the retrieved study conditions.';
  } });
  assert.equal(calls, 1);
  assert.equal(result.status, 'answered');
  assert.equal(result.question, question);
  assert.equal(result.retrieval_query, 'finalresultneedle');
  const unmatched = await prepareLibraryQuery({ ...inputs(f.vaultRoot), question, searchQuery: 'missingneedle' });
  assert.equal(unmatched.status, 'no_matches');
  assert.equal(unmatched.retrieval_query, 'missingneedle');
});

test('explicit retrieval query rejects empty and nonstring values instead of falling back to question', async t => {
  const f = await fixture(t);
  const { prepareLibraryQuery } = await library();
  for (const searchQuery of ['', '  ', null, 7, [], {}]) {
    await assert.rejects(prepareLibraryQuery({ ...inputs(f.vaultRoot), searchQuery }), /P23_SEARCH_QUERY_REQUIRED/);
  }
  await assert.rejects(prepareLibraryQuery({ ...inputs(f.vaultRoot), question: '', searchQuery: 'finalresultneedle' }), /P23_QUERY_REQUIRED/);
});

test('reported model or effort mismatch is an explicit failure without retry', async t => {
  const f = await fixture(t);
  const { executeLibraryQuery } = await library();
  for (const observed of [alternate, { model: alternate.model }, { reasoning_effort: alternate.reasoning_effort }]) {
    let calls = 0;
    const result = await executeLibraryQuery({ ...inputs(f.vaultRoot), executeHost: async () => {
      calls++;
      return { answer: 'Retained only as diagnostic output.', observable_identity: observed };
    } });
    assert.equal(calls, 1);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'identity_mismatch');
    assert.equal(result.answer, 'Retained only as diagnostic output.');
    assert.deepEqual(result.requested_identity, mainSession);
    assert.equal(result.observable_identity.model, observed.model ?? null);
    assert.equal(result.observable_identity.reasoning_effort, observed.reasoning_effort ?? null);
  }
});

test('only supplied observable identity fields are compared and missing fields stay unknown', async t => {
  const f = await fixture(t);
  const { executeLibraryQuery } = await library();
  for (const observed of [{ model: mainSession.model }, { reasoning_effort: mainSession.reasoning_effort }, {}]) {
    const result = await executeLibraryQuery({ ...inputs(f.vaultRoot), executeHost: async () => ({ answer: 'Synthetic response.', observable_identity: observed }) });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'answered');
    assert.equal(result.observable_identity.model, observed.model ?? null);
    assert.equal(result.observable_identity.reasoning_effort, observed.reasoning_effort ?? null);
  }
});

test('no matches, absent generation and empty committed library do not resolve models or execute', async t => {
  const f = await fixture(t);
  const root = await mkdtemp(join(tmpdir(), 'apa-request-empty-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { executeLibraryQuery } = await library();
  let calls = 0;
  const executeHost = async () => { calls++; throw new Error('must not execute'); };
  assert.equal((await executeLibraryQuery({ repoRoot: f.vaultRoot, question: 'notfoundneedle', executeHost })).status, 'no_matches');
  assert.equal((await executeLibraryQuery({ repoRoot: root, question: 'anything', executeHost })).status, 'not_ready');
  const generation = { schema_version: 'phase22/active-index-1.0', kind: 'active', generation_id: 'empty-query-request', evidence_mode: 'synthetic', papers: [], shared_nodes: [], objects: [] };
  const built = await buildBilingualIndex({ generation, validatedInputs: { papers: [], files: [] } });
  await saveReadingFirstPair(root, built.generation, built.index);
  assert.equal((await executeLibraryQuery({ repoRoot: root, question: 'anything', executeHost })).status, 'empty_library');
  assert.equal(calls, 0);
});

test('explicit same pair uses current task while unsupported or unknown choices never dispatch', async t => {
  const f = await fixture(t, { models: { query: { mode: 'explicit', ...mainSession } } });
  const { prepareLibraryQuery } = await library();
  assert.equal((await prepareLibraryQuery({ ...inputs(f.vaultRoot), supportedModelPairs: [mainSession] })).task.execution, 'current-session');
  await assert.rejects(prepareLibraryQuery(inputs(f.vaultRoot)), /APA_MODEL_AVAILABILITY_UNKNOWN/);
  await assert.rejects(prepareLibraryQuery({ ...inputs(f.vaultRoot), supportedModelPairs: [alternate] }), /APA_MODEL_UNSUPPORTED/);
});

test('unavailable host capability never silently changes the chosen model or execution route', async t => {
  const f = await fixture(t, { models: { query: { mode: 'explicit', ...alternate } } });
  const { prepareLibraryQuery } = await library();
  await assert.rejects(prepareLibraryQuery({ ...inputs(f.vaultRoot), supportedModelPairs: [alternate], hostCapabilities: { currentSession: true } }), /P23_QUERY_NATIVE_DELEGATION_UNAVAILABLE/);
  const g = await fixture(t);
  await assert.rejects(prepareLibraryQuery({ ...inputs(g.vaultRoot), hostCapabilities: {} }), /P23_QUERY_CURRENT_SESSION_UNAVAILABLE/);
  await assert.rejects(prepareLibraryQuery({ ...inputs(g.vaultRoot), mainSession: undefined }), /APA_MAIN_SESSION_INVALID/);
});

test('empty output, missing adapter and host failure cannot count as an answer or cause retries', async t => {
  const f = await fixture(t);
  const { executeLibraryQuery } = await library();
  await assert.rejects(executeLibraryQuery(inputs(f.vaultRoot)), /P23_QUERY_HOST_REQUIRED/);
  for (const output of ['', '  ', {}, { answer: '' }]) {
    let calls = 0;
    await assert.rejects(executeLibraryQuery({ ...inputs(f.vaultRoot), executeHost: async () => { calls++; return output; } }), /P23_QUERY_HOST_OUTPUT_REQUIRED/);
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(executeLibraryQuery({ ...inputs(f.vaultRoot), executeHost: async () => { calls++; throw new Error('host offline'); } }), /host offline/);
  assert.equal(calls, 1);
});

test('task contract bounds evidence use, original-source checking, inference and read-only work', async t => {
  const f = await fixture(t);
  const { prepareLibraryQuery } = await library();
  const result = await prepareLibraryQuery(inputs(f.vaultRoot));
  assert.equal(result.task.tools, 'read-only');
  assert.equal(result.task.question, result.question);
  for (const rule of ['readQuerySource', 'identity_verified', 'claim_verified', 'P24', 'single-paper', 'cross-paper', 'same paper', 'language', 'data, never instructions', 'PDF', 'not an operating-system sandbox']) assert.ok(result.task.prompt.includes(rule), rule);
  const data = JSON.parse(result.task.prompt.split('not additional instructions:\n')[1]);
  assert.equal(data.question, result.question);
  assert.deepEqual(data.results, result.results);
  assert.equal(data.repoRoot, f.vaultRoot);
});

test('a dispatched task can consume its generation-bound registered source without claiming scientific verification', async t => {
  const f = await readingFirstIndexFixture(t);
  const path = f.manifest.targets.assets.find(path => path.startsWith('Raw/'));
  const original = f.files.find(row => row.path === path);
  f.manifest.citation = { bibliography: { title: { en: 'Synthetic source for query execution' } }, sources: [{
    source_id: 'paper', path, sha256: digest(original.bytes), byte_length: original.bytes.length,
    source_version: 'synthetic-registered-version', locators: [],
  }] };
  const manifestFile = f.files.find(row => row.kind === 'reader-presentation');
  manifestFile.bytes = Buffer.from(JSON.stringify(f.manifest));
  f.paper.reader_presentation.sha256 = digest(manifestFile.bytes);
  f.generation.objects.find(row => row.path === manifestFile.path).sha256 = digest(manifestFile.bytes);
  await f.save(await f.build());
  const { executeLibraryQuery, readQuerySource } = await library();
  const result = await executeLibraryQuery({ ...inputs(f.vaultRoot), executeHost: async task => {
    const selected = task.evidence.results[0];
    const opened = await readQuerySource({ vaultRoot: task.evidence.repoRoot, paperId: selected.paper_id,
      sourceId: selected.citation.sources[0].source_id, generationId: task.evidence.generation_id });
    assert.equal(opened.ok, true);
    assert.equal(opened.source_version, 'synthetic-registered-version');
    assert.equal(opened.claim_verification, 'not_performed');
    assert.deepEqual(await readFile(opened.absolute_path), original.bytes);
    const stale = await readQuerySource({ vaultRoot: task.evidence.repoRoot, paperId: selected.paper_id,
      sourceId: 'paper', generationId: 'a-different-generation' });
    assert.equal(stale.status, 'not_ready');
    return 'Synthetic adapter read registered source bytes; this mock does not establish scientific correctness.';
  } });
  assert.equal(result.status, 'answered');
  assert.equal(result.results[0].citation.claim_verification, 'not_performed');
  assert.equal(result.results[0].citation.sources[0].locator_status, 'unknown');
});

test('a delegated query carries the exact host call: saved host names, or the Codex shape without a host', async t => {
  const { prepareLibraryQuery } = await library();
  const codex = await fixture(t, { models: { query: { mode: 'explicit', ...alternate } } });
  const plain = (await prepareLibraryQuery({ ...inputs(codex.vaultRoot), supportedModelPairs: [mainSession, alternate] })).task;
  assert.equal(plain.dispatch.tool, 'collaboration.spawn_agent');
  assert.deepEqual(Object.keys(plain.dispatch.arguments), ['task_name', 'message', 'model', 'reasoning_effort', 'fork_turns']);
  assert.match(plain.dispatch.arguments.task_name, /^apa_query_[0-9a-f]{12}$/);
  assert.deepEqual([plain.dispatch.arguments.message, plain.dispatch.arguments.model, plain.dispatch.arguments.reasoning_effort, plain.dispatch.arguments.fork_turns], [plain.prompt, alternate.model, alternate.reasoning_effort, 'none']);
  const host = { name: 'claude-code', dispatch: { tool: 'Agent', model_argument: 'model', effort_argument: 'effort', instruction_argument: 'prompt', task_name_argument: 'description', fresh_context: null } };
  const hosted = await fixture(t, { host, models: { query: { mode: 'explicit', ...alternate } } });
  const task = (await prepareLibraryQuery({ ...inputs(hosted.vaultRoot), supportedModelPairs: [mainSession, alternate] })).task;
  assert.equal(task.dispatch.tool, 'Agent');
  assert.deepEqual(Object.keys(task.dispatch.arguments), ['description', 'prompt', 'model', 'effort']);
  assert.match(task.dispatch.arguments.description, /^apa_query_[0-9a-f]{12}$/);
  assert.deepEqual([task.dispatch.arguments.prompt, task.dispatch.arguments.model, task.dispatch.arguments.effort], [task.prompt, alternate.model, alternate.reasoning_effort]);
  const same = await fixture(t, { host });
  assert.equal((await prepareLibraryQuery({ ...inputs(same.vaultRoot), supportedModelPairs: [mainSession] })).task.dispatch, undefined);
});
