import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readingFirstPublicationFixture, applyReadingFirstFixture, readingFirstPublicationAuthority } from './helpers/reading-first-publication-fixtures.mjs';
import { buildNoteRelocationReview } from '../../scripts/v3/note-relocation.mjs';
import { dryRunBilingualPublication, applyBilingualPublication } from '../../scripts/v3/phase22-publication.mjs';
import { readCommittedGeneration } from '../../scripts/v3/phase22-active-version.mjs';

async function published(t) {
  const f = await readingFirstPublicationFixture(t, { controlOptions: { noteLayout: 'legacy-flat-1.0' } });
  assert.equal((await applyBilingualPublication(applyReadingFirstFixture(f))).status, 'committed');
  const before = await readCommittedGeneration({ vaultRoot: f.vaultRoot });
  assert.equal(before.ok, true);
  return { ...f, before };
}
async function relocation(f) {
  return buildNoteRelocationReview({ vaultRoot: f.vaultRoot, runId: f.runId, generation: 'relocated-notes',
    papers: [{ paperId: f.before.generation.papers[0].paper_id, sourceLanguage: 'en' }] });
}
test('path-only relocation uses the existing transaction and preserves scientific identity, links and index', async t => {
  const f = await published(t), previous = f.before.generation.papers[0];
  const original = await readFile(join(f.vaultRoot, previous.paths['zh-CN']), 'utf8');
  const review = await relocation(f);
  const { plan } = await dryRunBilingualPublication({ vaultRoot: f.vaultRoot, run: f.runId, review });
  const authority = await readingFirstPublicationAuthority(f, plan);
  assert.equal((await applyBilingualPublication({ vaultRoot: f.vaultRoot, run: f.runId, plan, ...authority })).status, 'committed');
  const current = await readCommittedGeneration({ vaultRoot: f.vaultRoot });
  assert.equal(current.ok, true, JSON.stringify(current.errors));
  const paper = current.generation.papers[0];
  assert.equal(paper.paths.en, previous.paths.en);
  assert.equal(paper.paths['zh-CN'], previous.paths['zh-CN'].replace('Wiki/sources/', 'Wiki/translations/'));
  assert.equal(paper.core_hash, previous.core_hash);
  assert.deepEqual(paper.dependencies, previous.dependencies);
  const en = await readFile(join(f.vaultRoot, paper.paths.en), 'utf8');
  const zh = await readFile(join(f.vaultRoot, paper.paths['zh-CN']), 'utf8');
  assert.ok(en.includes('../translations/'));
  assert.ok(zh.includes('../sources/'));
  assert.equal(await readFile(join(f.vaultRoot, previous.paths['zh-CN']), 'utf8'), original, 'Old note retained until separate exact retirement after commit');
  assert.ok(current.index.documents.some(row => row.path === paper.paths['zh-CN']));
  assert.ok(!current.index.documents.some(row => row.path === previous.paths['zh-CN']));
  const supports = current.generation.shared_nodes.map(row => row.path);
  assert.ok((await Promise.all(supports.map(path => readFile(join(f.vaultRoot, path), 'utf8')))).some(text => text.includes('../translations/')));
});
test('relocation refuses occupied target and stale committed source instead of overwriting', async t => {
  const f = await published(t), old = f.before.generation.papers[0].paths['zh-CN'];
  const target = old.replace('Wiki/sources/', 'Wiki/translations/');
  await mkdir(join(f.vaultRoot, 'Wiki/translations'));
  await writeFile(join(f.vaultRoot, target), 'human note');
  await assert.rejects(relocation(f), /P22_RELOCATION_TARGET_OCCUPIED/);
  assert.equal(await readFile(join(f.vaultRoot, target), 'utf8'), 'human note');
  await writeFile(join(f.vaultRoot, old), 'changed source');
  await assert.rejects(relocation(f), /P22_RELOCATION_COMMITTED_REQUIRED/);
});
test('relocation does not bypass the existing exact approval or rollback', async t => {
  const f = await published(t), original = new Map();
  for (const paper of f.before.generation.papers) for (const path of Object.values(paper.paths)) original.set(path, await readFile(join(f.vaultRoot, path)));
  const review = await relocation(f), { plan } = await dryRunBilingualPublication({ vaultRoot: f.vaultRoot, run: f.runId, review });
  await assert.rejects(applyBilingualPublication({ vaultRoot: f.vaultRoot, run: f.runId, plan }), /P22_PUBLICATION_CONTROL_REQUIRED/);
  const authority = await readingFirstPublicationAuthority(f, plan);
  await assert.rejects(applyBilingualPublication({ vaultRoot: f.vaultRoot, run: f.runId, plan, ...authority,
    onPromotionBoundary({ timing, kind }) { if (timing === 'after' && kind === 'paper') throw new Error('TEST_STOP'); } }), /TEST_STOP/);
  const current = await readCommittedGeneration({ vaultRoot: f.vaultRoot });
  assert.equal(current.ok, true, JSON.stringify(current.errors));
  assert.equal(current.generation_id, f.before.generation_id);
  for (const [path, bytes] of original) assert.deepEqual(await readFile(join(f.vaultRoot, path)), bytes);
});
