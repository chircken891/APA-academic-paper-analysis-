import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readingFirstPublicationFixture, applyReadingFirstFixture } from './helpers/reading-first-publication-fixtures.mjs';
import { applyBilingualPublication } from '../../scripts/v3/phase22-publication.mjs';
import { readCommittedGeneration, readCommittedReadingFirstPresentations } from '../../scripts/v3/phase22-active-version.mjs';
import { executeLibraryQuery } from '../../scripts/v3/library-query.mjs';

const api = () => import('../../scripts/v3/topic-library.mjs');
async function fixture(t) {
  const f = await readingFirstPublicationFixture(t);
  await applyBilingualPublication(applyReadingFirstFixture(f));
  const snapshot = await readCommittedGeneration({ vaultRoot: f.vaultRoot });
  const { paper, presentation } = readCommittedReadingFirstPresentations(snapshot)[0];
  const source = presentation.citation.sources[0];
  const adopted = { paper_id: paper.paper_id, analysis_revision: paper.analysis_revision,
    adopted_generation_id: snapshot.generation_id, source_id: source.source_id, source_sha256: source.sha256,
    source_version: source.source_version, locators: source.locators, adopted_for: ['answer paragraph 1'] };
  await mkdir(join(f.vaultRoot, 'config'), { recursive: true });
  await writeFile(join(f.vaultRoot, 'config/apa.local.json'), JSON.stringify({ schema_version: 'apa-local-config-1.0', paths: { candidates: '.candidates' } }));
  return { ...f, inputs: { repoRoot: f.vaultRoot, operationId: 'save-test', question: 'What is supported?', language: 'en',
    title: 'Supported findings', answer: 'The supported finding is bounded by the study conditions.', adoptedSources: [adopted],
    queryTerms: ['supported'], expectedGenerationId: snapshot.generation_id, saveIntent: 'save' } };
}

test('explicit save creates a single-language candidate from only the adopted registered source', async t => {
  const f = await fixture(t), { prepareTopicSave } = await api();
  const commit = join(f.vaultRoot, '.apa-v3/phase22/COMMITTED.json'), before = await readFile(commit);
  const saved = await prepareTopicSave(f.inputs);
  assert.equal(saved.ok, true);
  assert.equal(saved.topic.revision, 1);
  assert.equal(saved.topic.language, 'en');
  assert.deepEqual(saved.topic.dependencies, f.inputs.adoptedSources);
  assert.equal(saved.topic.paper_id, undefined);
  const note = await readFile(saved.candidate.note_path, 'utf8');
  assert.ok(note.includes(f.inputs.answer));
  assert.ok(note.includes('## Personal Notes'));
  assert.ok(saved.candidate.note_path.startsWith(join(f.vaultRoot, '.candidates', 'topics')));
  assert.deepEqual(await readFile(commit), before);
});

test('save requires explicit intent, adopted claims, and exact registered source identity', async t => {
  const f = await fixture(t), { prepareTopicSave } = await api();
  for (const [patch, code] of [
    [{ saveIntent: undefined }, 'P24_SAVE_INTENT_REQUIRED'],
    [{ adoptedSources: [] }, 'P24_ADOPTED_SOURCES_REQUIRED'],
    [{ adoptedSources: [{ ...f.inputs.adoptedSources[0], source_sha256: 'sha256:' + '0'.repeat(64) }] }, 'P24_ADOPTED_SOURCE_MISMATCH'],
  ]) await assert.rejects(prepareTopicSave({ ...f.inputs, ...patch }), { code });
});

test('Chinese save keeps the original answer and saving alone requires a safe configured candidate root', async t => {
  const f = await fixture(t), { prepareTopicSave } = await api();
  const config = join(f.vaultRoot, 'config/apa.local.json');
  const missing = { schema_version: 'apa-local-config-1.0' };
  await writeFile(config, JSON.stringify(missing));
  await assert.rejects(prepareTopicSave(f.inputs), { code: 'P24_CANDIDATES_REQUIRED' });
  await writeFile(config, JSON.stringify({ ...missing, paths: { candidates: 'Wiki/topics' } }));
  await assert.rejects(prepareTopicSave(f.inputs), { code: 'P24_CANDIDATE_PATH_INVALID' });
  await writeFile(config, JSON.stringify({ ...missing, paths: { candidates: '.candidates' } }));
  const answer = '研究中的效应限于所报告的人群和研究条件。';
  const saved = await prepareTopicSave({ ...f.inputs, operationId: 'save-zh', language: 'zh-CN', question: '结果意味着什么？', title: '结果的解释', answer });
  assert.equal(saved.topic.language, 'zh-CN');
  assert.ok((await readFile(saved.candidate.note_path, 'utf8')).includes(answer));
});

test('topic-save CLI stdin and file share the explicit save contract and never apply', async t => {
  const f = await fixture(t);
  const cli = fileURLToPath(new URL('../../scripts/apa-query.mjs', import.meta.url));
  const { repoRoot, ...payload } = f.inputs;
  const invoke = (input, path = '-') => spawnSync(process.execPath, [cli, 'topic-save', '--input', path, '--vault-root', repoRoot], { input, encoding: 'utf8', windowsHide: true });
  const first = invoke(JSON.stringify(payload));
  assert.equal(first.status, 0, first.stderr || first.stdout);
  assert.equal(JSON.parse(first.stdout).status, 'candidate');
  const input = join(f.root, 'topic-input.json');
  await writeFile(input, JSON.stringify({ ...payload, operationId: 'save-file' }));
  const second = invoke(undefined, input);
  assert.equal(second.status, 0, second.stderr || second.stdout);
  const invalid = invoke(JSON.stringify({ ...payload, apply: true }));
  assert.equal(invalid.status, 2);
});

test('a read-only answer retains only explicit adopted declarations from its actual evidence', async t => {
  const f = await fixture(t);
  const inputs = { repoRoot: f.vaultRoot, question: 'supported', mainSession: { model: 'query-host-model', reasoning_effort: 'high' },
    hostCapabilities: { currentSession: true } };
  let calls = 0;
  const answered = await executeLibraryQuery({ ...inputs, executeHost: async () => {
    calls++;
    return { answer: f.inputs.answer, adopted_sources: f.inputs.adoptedSources };
  } });
  assert.equal(calls, 1);
  assert.deepEqual(answered.adopted_sources, f.inputs.adoptedSources);
  await assert.rejects(executeLibraryQuery({ ...inputs, executeHost: async () => ({ answer: 'Claim',
    adopted_sources: [{ ...f.inputs.adoptedSources[0], paper_id: 'pap_unretrieved' }] }) }), { code: 'P24_ADOPTED_SOURCE_MISMATCH' });
});
