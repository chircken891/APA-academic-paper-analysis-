import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readingFirstPublicationFixture, applyReadingFirstFixture } from './helpers/reading-first-publication-fixtures.mjs';
import { applyBilingualPublication } from '../../scripts/v3/phase22-publication.mjs';

const cli = fileURLToPath(new URL('../../scripts/apa-query.mjs', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const invoke = (args, cwd) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', windowsHide: true });

test('query CLI rejects missing, duplicate and unknown arguments with JSON usage errors', () => {
  for (const args of [[], ['request'], ['search'], ['search', '--query'], ['search', '--query', ' '],
    ['search', '--query', 'study', '--run', 'old-run'],
    ['search', '--query', 'one', '--query', 'two'],
    ['search', '--query', 'study', '--vault-root'],
    ['search', '--query', 'study', '--vault-root', 'a', '--vault-root', 'b']]) {
    const result = invoke(args);
    assert.equal(result.status, 2, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.error.code, 'P23_QUERY_ARGUMENT_INVALID');
    assert.match(report.error.usage, /search --query/);
  }
});

test('query CLI is read-only and reports uncommitted content as not ready without reading setup', async t => {
  const vaultRoot = await mkdtemp(join(tmpdir(), 'apa-query-cli-empty-'));
  t.after(() => rm(vaultRoot, { recursive: true, force: true }));
  await mkdir(join(vaultRoot, 'Wiki'));
  await writeFile(join(vaultRoot, 'Wiki', 'candidate.md'), 'candidate should not be searched');
  const result = invoke(['search', '--query', 'candidate', '--vault-root', vaultRoot], tmpdir());
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'not_ready');
  assert.deepEqual(report.results, []);
  assert.deepEqual(await readdir(vaultRoot), ['Wiki']);
  assert.equal(await readFile(join(vaultRoot, 'Wiki', 'candidate.md'), 'utf8'), 'candidate should not be searched');
});

test('query CLI finds committed synthetic papers from another cwd without run ID or configuration', async t => {
  const f = await readingFirstPublicationFixture(t);
  assert.equal((await applyBilingualPublication(applyReadingFirstFixture(f))).status, 'committed');
  const commitPath = join(f.vaultRoot, '.apa-v3', 'phase22', 'COMMITTED.json');
  const before = await readFile(commitPath);
  const result = invoke(['search', '--query', 'supported', '--vault-root', f.vaultRoot], tmpdir());
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'matches');
  assert.equal(report.evidence_mode, 'synthetic');
  assert.equal(report.scientific_approval, false);
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].paper_id, f.paperId);
  assert.equal(report.results[0].citation.claim_verification, 'not_performed');
  assert.ok(report.results[0].hits.length);
  const missed = invoke(['search', '--query', 'unmatchedxyzabcdef', '--vault-root', f.vaultRoot], tmpdir());
  assert.equal(missed.status, 0, missed.stderr || missed.stdout);
  assert.equal(JSON.parse(missed.stdout).status, 'no_matches');
  assert.deepEqual(await readFile(commitPath), before);
  await assert.rejects(readFile(join(f.vaultRoot, 'config', 'apa.local.json')), { code: 'ENOENT' });
});

test('query CLI default root comes from its module location, not the caller directory', async () => {
  const { parseQueryArguments } = await import('../../scripts/apa-query.mjs');
  assert.deepEqual(parseQueryArguments(['search', '--query', 'study']), { vaultRoot: repositoryRoot, query: 'study' });
});
