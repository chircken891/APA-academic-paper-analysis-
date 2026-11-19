import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  findClippingsByHash, findRawSourceMatches, inspectClippingsSourceDrift, prepareReadingSources, readRegisteredSourceMatchMetadata,
} from '../../scripts/v3/reading-source-policy.mjs';
import * as sourcePolicy from '../../scripts/v3/reading-source-policy.mjs';
import { applyBilingualPublication } from '../../scripts/v3/phase22-publication.mjs';
import { applyReadingFirstFixture, readingFirstPublicationFixture } from './helpers/reading-first-publication-fixtures.mjs';

async function vaultFixture(t) {
  const parent = await realpath(tmpdir());
  const root = await mkdtemp(join(parent, 'apa-clippings-sources-'));
  t.after(async () => {
    assert.equal(await realpath(root), root);
    assert.equal(dirname(root), parent);
    await rm(root, { recursive: true });
  });
  const vaultRoot = join(root, 'vault');
  await mkdir(vaultRoot);
  async function add(path, text, id) {
    const absolute = join(root, path);
    const bytes = Buffer.from(text);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes);
    return { ...(id ? { id } : {}), path: absolute, sha256: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), byte_length: bytes.length };
  }
  return { vaultRoot, add };
}

test('preparing an existing Clippings original reuses its path and updates only a new input copy', async t => {
  const { vaultRoot, add } = await vaultFixture(t);
  const original = await add('vault/Clippings/主题/主文.pdf', 'main paper', 'paper');
  const supplement = await add('vault/Clippings/主题/补充.docx', 'supplement', 'supplement');
  const scientificInput = {
    sources: [original, supplement],
    presentation: {
      source_pdf: 'Raw/legacy.pdf',
      sources: [{ id: 'paper', path: 'Raw/legacy.pdf' }, { id: 'supplement', path: 'Raw/legacy.docx' }],
      visuals: [{ source_id: 'supplement', source_path: 'Raw/legacy.docx', path: 'Figures/run/figure.png' }],
    },
  };
  const before = JSON.stringify(scientificInput);
  const prepared = prepareReadingSources({ repoRoot: vaultRoot, scientificInput });
  assert.equal(JSON.stringify(scientificInput), before);
  assert.deepEqual(prepared.scientificInput.sources, scientificInput.sources);
  assert.deepEqual(prepared.source_locations.map(({ file_identity, ...location }) => location), [
    { source_id: 'paper', original_path: original.path, path: original.path, vault_path: 'Clippings/主题/主文.pdf', sha256: original.sha256, byte_length: original.byte_length },
    { source_id: 'supplement', original_path: supplement.path, path: supplement.path, vault_path: 'Clippings/主题/补充.docx', sha256: supplement.sha256, byte_length: supplement.byte_length },
  ]);
  for (const source of prepared.source_locations) {
    const actual = await stat(source.path, { bigint: true });
    assert.deepEqual(source.file_identity, { dev: String(actual.dev), ino: String(actual.ino), mtime_ns: String(actual.mtimeNs) });
  }
  assert.equal(prepared.scientificInput.presentation.source_pdf, 'Clippings/主题/主文.pdf');
  assert.equal(prepared.scientificInput.presentation.sources[1].path, 'Clippings/主题/补充.docx');
  assert.deepEqual(prepared.scientificInput.presentation.visuals[0],
    { source_id: 'supplement', source_path: 'Clippings/主题/补充.docx', path: 'Figures/run/figure.png' });
  assert.equal(await readFile(original.path, 'utf8'), 'main paper');
});

test('legacy preparation can still bind an external source under the frozen copying policy', async t => {
  const { vaultRoot, add } = await vaultFixture(t);
  const original = await add('input/study.pdf', 'main paper', 'paper');
  const supplement = await add('vault/elsewhere/supplement.docx', 'supplement', 'supplement');
  await add('vault/Raw/prior.pdf', 'main paper');
  const scientificInput = { sources: [original, supplement] };
  const prepared = prepareReadingSources({ repoRoot: vaultRoot, scientificInput, sourceAccess: null });
  const paths = ['study.pdf', 'supplement.docx'].map(name => join(vaultRoot, 'Clippings', name));
  assert.deepEqual(prepared.scientificInput.sources, [{ ...original, path: paths[0] }, { ...supplement, path: paths[1] }]);
  assert.equal(await readFile(paths[0], 'utf8'), 'main paper');
  assert.equal(await readFile(paths[1], 'utf8'), 'supplement');
  assert.equal(await readFile(original.path, 'utf8'), 'main paper');
  assert.deepEqual(prepared.raw_source_matches.exact_matches, [
    { raw_path: 'Raw/prior.pdf', clippings_path: 'Clippings/study.pdf', sha256: original.sha256, byte_length: original.byte_length, basis: 'sha256' },
  ]);
  assert.deepEqual(prepareReadingSources({ repoRoot: vaultRoot, scientificInput, sourceAccess: null }), prepared);
});

test('external input requires placement by the user when no matching original is present', async t => {
  const { vaultRoot, add } = await vaultFixture(t);
  const original = await add('input/论文 原件.pdf', 'main paper', 'paper');
  assert.throws(() => prepareReadingSources({ repoRoot: vaultRoot, scientificInput: { sources: [original] } }), error => {
    assert.equal(error.code, 'RF_CLIPPINGS_ORIGINAL_REQUIRED');
    assert.equal(error.details.source_path, original.path);
    assert.equal(error.details.target_path, join(vaultRoot, 'Clippings', '论文 原件.pdf'));
    return true;
  });
  await assert.rejects(stat(join(vaultRoot, 'Clippings')), { code: 'ENOENT' });
  await assert.rejects(stat(join(vaultRoot, '.tmp')), { code: 'ENOENT' });
  assert.equal(await readFile(original.path, 'utf8'), 'main paper');
});

test('external input reuses a verified registered original at a different Clippings path', async t => {
  const { vaultRoot, add } = await vaultFixture(t);
  const external = await add('input/外部.pdf', 'main paper', 'paper');
  const original = await add('vault/Clippings/论文/已登记 原件.pdf', 'main paper');
  const sourceMatchMetadata = { originals: [{ ...original, path: 'Clippings/论文/已登记 原件.pdf' }] };
  const prepared = prepareReadingSources({ repoRoot: vaultRoot, scientificInput: { sources: [external] }, sourceMatchMetadata });
  assert.deepEqual(prepared.scientificInput.sources, [{ ...external, path: original.path }]);
  assert.equal(prepared.source_locations[0].original_path, external.path);
  await assert.rejects(stat(join(vaultRoot, 'Clippings', '外部.pdf')), { code: 'ENOENT' });
});

test('preparing sources detects a same-name conflict without writing either original', async t => {
  const { vaultRoot, add } = await vaultFixture(t);
  const original = await add('input/study.pdf', 'main paper', 'paper');
  const supplement = await add('input/supplement.docx', 'supplement', 'supplement');
  const conflict = await add('vault/Clippings/supplement.docx', 'different data');
  assert.throws(() => prepareReadingSources({ repoRoot: vaultRoot, scientificInput: { sources: [supplement, original] } }), error => {
    assert.equal(error.code, 'RF_CLIPPINGS_SOURCE_NAME_CONFLICT');
    assert.equal(error.details.source_path, supplement.path);
    assert.equal(error.details.target_path, conflict.path);
    assert.equal(error.details.source_sha256, supplement.sha256);
    assert.equal(error.details.target_sha256, conflict.sha256);
    assert(error.message.includes(supplement.path) && error.message.includes(conflict.path));
    return true;
  });
  await assert.rejects(readFile(join(vaultRoot, 'Clippings', 'study.pdf')), { code: 'ENOENT' });
  assert.equal(await readFile(conflict.path, 'utf8'), 'different data');
});

test('read-only binding rejects source output aliases and same-byte edits after preparation', async t => {
  const { vaultRoot, add } = await vaultFixture(t);
  const original = await add('vault/Clippings/主文.pdf', 'main paper', 'paper');
  const supplemental = await add('vault/Clippings/补充 材料.pdf', 'supplement', 'supplement');
  const { source_locations: sources } = prepareReadingSources({ repoRoot: vaultRoot, scientificInput: { sources: [original, supplemental] } });
  const output = join(vaultRoot, 'output');
  await mkdir(output);
  const alias = join(output, 'replacement.md');
  await link(supplemental.path, alias);
  for (const target of [original.path, alias, output]) {
    assert.throws(() => sourcePolicy.assertReadingSourceOutputPath(target, sources, { tree: target === output, vaultRoot }),
      { code: 'RF_READ_ONLY_SOURCE_OUTPUT_CONFLICT' });
  }
  assert.throws(() => sourcePolicy.assertReadingSourceOutputPath(join(vaultRoot, 'Clippings', 'unrelated.pdf'), sources, { vaultRoot }),
    { code: 'RF_READ_ONLY_SOURCE_OUTPUT_CONFLICT' });
  assert.doesNotThrow(() => sourcePolicy.assertReadingSourceOutputPath(join(output, 'new.md'), sources, { vaultRoot }));
  assert.doesNotThrow(() => sourcePolicy.assertReadingSourceUnchanged(sources[1]));
  const prior = await stat(supplemental.path);
  await utimes(supplemental.path, prior.atime, new Date(prior.mtimeMs + 3000));
  assert.throws(() => sourcePolicy.assertReadingSourceUnchanged(sources[1]), { code: 'READING_FIRST_SOURCE_CHANGED' });
  assert.equal(await readFile(supplemental.path, 'utf8'), 'supplement');
});

test('preparation rejects a supplied source hash that differs from the selected bytes', async t => {
  const { vaultRoot, add } = await vaultFixture(t);
  const original = await add('input/study.pdf', 'main paper', 'paper');
  await writeFile(original.path, 'changed contents');
  assert.throws(() => prepareReadingSources({ repoRoot: vaultRoot, scientificInput: { sources: [original] } }),
    { code: 'READING_FIRST_SOURCE_CHANGED' });
  await assert.rejects(readFile(join(vaultRoot, 'Clippings', 'study.pdf')), { code: 'ENOENT' });
});

test('registered drift reports changed and missing sources with same-byte paths and migration entry', async t => {
  const { vaultRoot, add } = await vaultFixture(t);
  const moved = await add('vault/Clippings/before.pdf', 'registered original');
  const changed = await add('vault/Clippings/edited.docx', 'earlier bytes');
  await rename(moved.path, join(vaultRoot, 'Clippings', 'after.pdf'));
  await writeFile(changed.path, 'later bytes');
  const objects = [
    { kind: 'asset', path: 'Clippings/before.pdf', sha256: moved.sha256, byte_length: moved.byte_length },
    { kind: 'asset', path: 'Clippings/edited.docx', sha256: changed.sha256 },
    { kind: 'asset', path: 'Raw/legacy.pdf', sha256: moved.sha256 },
  ];
  const drift = inspectClippingsSourceDrift({ vaultRoot, objects });
  assert.deepEqual(drift.map(({ path, registered_sha256, status, same_byte_candidates }) => ({ path, registered_sha256, status, same_byte_candidates })), [
    { path: 'Clippings/before.pdf', registered_sha256: moved.sha256, status: 'missing', same_byte_candidates: ['Clippings/after.pdf'] },
    { path: 'Clippings/edited.docx', registered_sha256: changed.sha256, status: 'changed', same_byte_candidates: [] },
  ]);
  assert(drift.every(row => row.migration_entry.includes('scripts/v3/note-relocation.mjs')));
});

test('source matching separates same bytes from DOI, title and filename hints', async t => {
  const { vaultRoot, add } = await vaultFixture(t);
  const exact = await add('vault/Clippings/exact-paper.pdf', 'the same content');
  await add('vault/Raw/copied.pdf', 'the same content');
  const doi = await add('vault/Clippings/doi-study.pdf', 'revised publication');
  const rawDoi = await add('vault/Raw/old-publication.pdf', 'original publication');
  const title = await add('vault/Clippings/title-study.pdf', 'retitled publication');
  const rawTitle = await add('vault/Raw/old-title.pdf', 'earlier text');
  await add('vault/Clippings/Shared name.pdf', 'format B');
  await add('vault/Raw/shared-name.pdf', 'format A');
  const matches = findRawSourceMatches({
    vaultRoot,
    sources: [{ ...doi, doi: 'https://doi.org/10.1000/example' }, { ...title, title: 'A Study: With Punctuation' }],
    rawSources: [
      { ...rawDoi, doi: '10.1000/EXAMPLE' }, { ...rawTitle, title: { en: 'A study with punctuation' } },
      { path: 'Raw/pending.pdf', sha256: exact.sha256, byte_length: exact.byte_length },
    ],
  });
  assert.deepEqual(matches.exact_matches.map(row => [row.raw_path, row.clippings_path, row.basis]), [
    ['Raw/copied.pdf', 'Clippings/exact-paper.pdf', 'sha256'], ['Raw/pending.pdf', 'Clippings/exact-paper.pdf', 'sha256'],
  ]);
  assert.deepEqual(matches.possible_matches, [
    { raw_path: 'Raw/old-publication.pdf', clippings_path: 'Clippings/doi-study.pdf', basis: 'doi' },
    { raw_path: 'Raw/old-title.pdf', clippings_path: 'Clippings/title-study.pdf', basis: 'title' },
    { raw_path: 'Raw/shared-name.pdf', clippings_path: 'Clippings/Shared name.pdf', basis: 'filename' },
  ]);
  assert.deepEqual(findClippingsByHash({ vaultRoot, sha256: exact.sha256, byte_length: exact.byte_length }), ['Clippings/exact-paper.pdf']);
});

test('source preparation uses the registered Raw paper title for a differing-byte candidate', async t => {
  const prior = await readingFirstPublicationFixture(t);
  assert.equal((await applyBilingualPublication(applyReadingFirstFixture(prior))).status, 'committed');
  const metadata = await readRegisteredSourceMatchMetadata({ vaultRoot: prior.vaultRoot });
  const expectedTitle = prior.presentationCatalog.bibliography.title;
  assert.deepEqual(metadata.rawSources.map(row => ({ path: row.path, title: row.title })), [
    { path: prior.presentationCatalog.source_pdf, title: expectedTitle },
  ]);

  const original = join(prior.vaultRoot, 'Clippings', 'updated-edition.pdf'), bytes = Buffer.from('updated bytes');
  await mkdir(dirname(original), { recursive: true });
  await writeFile(original, bytes);
  const source = { id: 'paper', path: original, title: expectedTitle,
    sha256: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), byte_length: bytes.length };
  const prepared = prepareReadingSources({
    repoRoot: prior.vaultRoot, scientificInput: { sources: [source] }, sourceMatchMetadata: metadata,
  });
  assert.deepEqual(prepared.raw_source_matches, { exact_matches: [], possible_matches: [
    { raw_path: prior.presentationCatalog.source_pdf, clippings_path: 'Clippings/updated-edition.pdf', basis: 'title' },
  ] });
});
