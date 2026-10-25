import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readingFirstIndexFixture } from './helpers/reading-first-index-fixtures.mjs';

const cli = fileURLToPath(new URL('../../scripts/apa-query.mjs', import.meta.url));
const payload = {
  question: 'finalresultneedle',
  mainSession: { model: 'query-host-model', reasoning_effort: 'high' },
  hostCapabilities: { currentSession: true, nativeDelegation: false },
};
const invoke = (args, input) => spawnSync(process.execPath, [cli, ...args], {
  cwd: tmpdir(), input, encoding: 'utf8', windowsHide: true,
});

test('request CLI passes presentation overrides into the frozen task and rejects unsupported preferences', async t => {
  const f = await readingFirstIndexFixture(t);
  await f.save(f.build());
  const preferences = { answer_language: 'zh-CN', detail: 'concise', audience: 'beginner' };
  const result = invoke(['request', '--input', '-', '--vault-root', f.vaultRoot], JSON.stringify({ ...payload, preferences }));
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout).task.evidence.preferences, preferences);
  const invalid = invoke(['request', '--input', '-', '--vault-root', f.vaultRoot], JSON.stringify({ ...payload, preferences: { detail: 'invalid' } }));
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stdout).error.code, 'APA_QUERY_PREFERENCES_INVALID');
});

test('request CLI consumes stdin or an input file without claiming that preparation answered the question', async t => {
  const f = await readingFirstIndexFixture(t);
  await f.save(f.build());
  const commitPath = join(f.vaultRoot, '.apa-v3/phase22/COMMITTED.json');
  const before = await readFile(commitPath);
  const stdinResult = invoke(['request', '--input', '-', '--vault-root', f.vaultRoot], JSON.stringify(payload));
  assert.equal(stdinResult.status, 0, stdinResult.stderr || stdinResult.stdout);
  const prepared = JSON.parse(stdinResult.stdout);
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.answer, undefined);
  assert.equal(prepared.task.execution, 'current-session');
  assert.equal(prepared.task.model, payload.mainSession.model);
  assert.equal(prepared.task.reasoning_effort, 'high');
  assert.equal(prepared.results.length, 1);
  const inputFile = join(f.vaultRoot, 'request-input.json');
  await writeFile(inputFile, JSON.stringify(payload));
  const fileResult = invoke(['request', '--input', inputFile, '--vault-root', f.vaultRoot]);
  assert.equal(fileResult.status, 0, fileResult.stderr || fileResult.stdout);
  assert.deepEqual(JSON.parse(fileResult.stdout), prepared);
  assert.deepEqual(await readFile(commitPath), before);
  await assert.rejects(readFile(join(f.vaultRoot, 'config/apa.local.json')), { code: 'ENOENT' });
});

test('request and source CLI reject malformed input and unsupported flags as usage errors', () => {
  for (const [args, input] of [
    [['request'], undefined],
    [['request', '--input', '-', '--input', '-'], '{}'],
    [['request', '--input', '-'], 'not JSON'],
    [['request', '--input', '-'], '[]'],
    [['request', '--input', '-'], JSON.stringify({ ...payload, execute: 'publish' })],
    [['request', '--input', '-'], JSON.stringify({ ...payload, question: ' ' })],
    [['source', '--paper-id', 'paper'], undefined],
    [['source', '--paper-id', 'paper', '--generation-id', 'one', '--path', 'Raw/unregistered.pdf'], undefined],
  ]) {
    const result = invoke(args, input);
    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).error.code, 'P23_QUERY_ARGUMENT_INVALID');
  }
});

test('request CLI accepts a short searchQuery while retaining the full natural-language question', async t => {
  const f = await readingFirstIndexFixture(t);
  await f.save(f.build());
  const question = 'Explain how finalresultneedle was established and which study conditions limit its clinical applicability.';
  const result = invoke(['request', '--input', '-', '--vault-root', f.vaultRoot], JSON.stringify({ ...payload, question, searchQuery: 'finalresultneedle' }));
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const prepared = JSON.parse(result.stdout);
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.question, question);
  assert.equal(prepared.retrieval_query, 'finalresultneedle');
  assert.equal(prepared.task.question, question);
  assert.equal(prepared.task.evidence.retrieval_query, 'finalresultneedle');
  assert.equal(prepared.task.execution, 'current-session');
  assert.equal(prepared.results.length, 1);
});

test('request CLI rejects empty or nonstring searchQuery as a usage error', () => {
  for (const searchQuery of ['', '  ', null, 5, {}, []]) {
    const result = invoke(['request', '--input', '-'], JSON.stringify({ ...payload, searchQuery }));
    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).error.code, 'P23_QUERY_ARGUMENT_INVALID');
  }
});

test('request CLI keeps no-match and uncommitted results without constructing a model task', async t => {
  const f = await readingFirstIndexFixture(t);
  await f.save(f.build());
  const missing = invoke(['request', '--input', '-', '--vault-root', f.vaultRoot], JSON.stringify({ question: 'unmatchedxyzabcdef' }));
  assert.equal(missing.status, 0, missing.stderr || missing.stdout);
  assert.equal(JSON.parse(missing.stdout).status, 'no_matches');
  assert.equal(JSON.parse(missing.stdout).task, undefined);
  const empty = await mkdtemp(join(tmpdir(), 'apa-query-request-empty-'));
  t.after(() => rm(empty, { recursive: true, force: true }));
  const uncommitted = invoke(['request', '--input', '-', '--vault-root', empty], JSON.stringify(payload));
  assert.equal(uncommitted.status, 1, uncommitted.stderr || uncommitted.stdout);
  assert.equal(JSON.parse(uncommitted.stdout).status, 'not_ready');
});

test('source CLI carries generation and source identifiers and preserves unavailable metadata', async t => {
  const f = await readingFirstIndexFixture(t);
  await f.save(f.build());
  const args = ['source', '--paper-id', f.identity.paper_id, '--source-id', 'missing-source', '--vault-root', f.vaultRoot];
  const source = invoke([...args, '--generation-id', f.generation.generation_id]);
  assert.equal(source.status, 1, source.stderr || source.stdout);
  const result = JSON.parse(source.stdout);
  assert.equal(result.status, 'source_unavailable');
  assert.equal(result.source_id, 'missing-source');
  assert.equal(result.claim_verification, 'not_performed');
  const stale = invoke([...args, '--generation-id', 'old-generation']);
  assert.equal(stale.status, 1, stale.stderr || stale.stdout);
  assert.equal(JSON.parse(stale.stdout).errors[0].code, 'P23_QUERY_GENERATION_CHANGED');
});
