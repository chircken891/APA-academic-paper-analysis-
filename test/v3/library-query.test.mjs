import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewedReadingFirstFixture } from './helpers/reading-first-publication-source-fixtures.mjs';
import { readingFirstPublicationFixture, applyReadingFirstFixture } from './helpers/reading-first-publication-fixtures.mjs';
import { captureReadingFirstPublicationSource, inspectReadingFirstPublicationSource } from '../../scripts/v3/reading-first-runtime.mjs';
import { applyBilingualPublication } from '../../scripts/v3/phase22-publication.mjs';
import { readCommittedGeneration, assertCommittedSnapshot } from '../../scripts/v3/phase22-active-version.mjs';
import { buildBilingualIndex } from '../../scripts/v3/phase22-search.mjs';
import { readingFirstIndexFixture, saveReadingFirstPair, digest } from './helpers/reading-first-index-fixtures.mjs';

const library = () => import('../../scripts/v3/library-query.mjs');

test('accepted publication source exposes its registered bibliography and original locators', async t => {
  const f = await reviewedReadingFirstFixture(t);
  const source = await captureReadingFirstPublicationSource({ controller: f.controller, presentation: f.candidate });
  const description = await inspectReadingFirstPublicationSource(source);
  assert.deepEqual(description.presentation, f.presentationCatalog);
});

test('publication transaction binds bibliography and original source to library results without a run ID', async t => {
  const f = await readingFirstPublicationFixture(t);
  const { queryLibrary, readQuerySource } = await library();
  assert.equal((await queryLibrary({ vaultRoot: f.vaultRoot, query: 'supported' })).status, 'not_ready');
  await applyBilingualPublication(applyReadingFirstFixture(f));
  const found = await queryLibrary({ vaultRoot: f.vaultRoot, query: 'supported' });
  assert.equal(found.ok, true);
  assert.equal(found.status, 'matches', JSON.stringify(found.diagnostics));
  assert.equal(found.generation_id, 'reading-generation-1');
  assert.equal(found.evidence_mode, 'synthetic');
  assert.equal(found.scientific_approval, false);
  assert.equal(found.results.length, 1);
  const paper = found.results[0];
  assert.equal(paper.paper_id, f.paperId);
  assert.deepEqual(paper.citation.bibliography, f.presentationCatalog.bibliography);
  const source = paper.citation.sources[0];
  assert.equal(source.source_id, 'paper');
  assert.equal(source.path, f.resources[0].path);
  assert.equal(source.sha256, f.resources[0].sha256);
  assert.equal(source.status, 'identity_verified');
  assert.equal(source.source_version, null, 'No reported version is invented.');
  assert.deepEqual(source.locators.map(row => [row.kind, row.id, row.page]), [['figure', 'fig-one', 1]]);
  assert.equal(paper.citation.claim_verification, 'not_performed');
  assert.equal(JSON.stringify(found).includes(f.root), false, 'Search output does not expose original scratch paths.');
  const opened = await readQuerySource({ vaultRoot: f.vaultRoot, paperId: f.paperId, sourceId: 'paper', generationId: found.generation_id });
  assert.equal(opened.ok, true);
  assert.equal(opened.status, 'identity_verified');
  assert.equal(opened.absolute_path, join(f.vaultRoot, f.resources[0].path));
  assert.equal(opened.claim_verification, 'not_performed');
  assert.equal((await queryLibrary({ vaultRoot: f.vaultRoot, query: 'unmatchedqueryneedle' })).status, 'no_matches');
  const shared = await queryLibrary({ vaultRoot: f.vaultRoot, query: 'supportonlytoken' });
  assert.equal(shared.results.length, 1, 'Shared bilingual projections stay in the same paper group.');
  assert.ok(shared.results[0].hits.some(hit => hit.path.startsWith('Wiki/methods/')));
});

test('query validates arguments and ignores caller-supplied uncommitted snapshots', async t => {
  const vaultRoot = await mkdtemp(join(tmpdir(), 'apa-query-uncommitted-'));
  t.after(() => rm(vaultRoot, { recursive: true, force: true }));
  const { queryLibrary } = await library();
  await assert.rejects(queryLibrary({ vaultRoot }), /P23_QUERY_REQUIRED/);
  await assert.rejects(queryLibrary({ query: 'supported' }), /P23_VAULT_ROOT_REQUIRED/);
  const result = await queryLibrary({ vaultRoot, query: 'supported', activeSnapshot: { ok: true, committed: true, generation: {}, index: {} } });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'not_ready');
  assert.deepEqual(result.results, []);
});

test('a corrupted registered original is reported while available notes remain searchable', async t => {
  const f = await readingFirstPublicationFixture(t);
  await applyBilingualPublication(applyReadingFirstFixture(f));
  const { queryLibrary, readQuerySource } = await library();
  await writeFile(join(f.vaultRoot, f.resources[0].path), 'changed original bytes');
  const result = await queryLibrary({ vaultRoot: f.vaultRoot, query: 'supported' });
  assert.equal(result.status, 'partial');
  assert.equal(result.incomplete, true);
  assert.equal(result.results[0].citation.status, 'partial');
  assert.equal(result.results[0].citation.sources[0].status, 'unavailable');
  assert.equal(result.diagnostics[0].code, 'P23_CITATION_SOURCE_BINDING_INVALID');
  assert.equal((await readQuerySource({ vaultRoot: f.vaultRoot, paperId: f.paperId })).status, 'not_ready');
});

test('source access re-observes generation and refuses unknown paper or source IDs', async t => {
  const f = await readingFirstPublicationFixture(t);
  await applyBilingualPublication(applyReadingFirstFixture(f));
  const { queryLibrary, readQuerySource } = await library();
  const first = await queryLibrary({ vaultRoot: f.vaultRoot, query: 'supported' });
  assert.equal((await readQuerySource({ vaultRoot: f.vaultRoot, paperId: 'missing' })).status, 'source_unavailable');
  assert.equal((await readQuerySource({ vaultRoot: f.vaultRoot, paperId: f.paperId, sourceId: 'not-registered' })).status, 'source_unavailable');
  const snapshot = await readCommittedGeneration({ vaultRoot: f.vaultRoot });
  const g = await readingFirstPublicationFixture(t, { vaultRoot: f.vaultRoot, generation: 'reading-generation-next', runId: 'run_' + 'd'.repeat(32), paperId: 'pap_' + 'd'.repeat(32) });
  await applyBilingualPublication(applyReadingFirstFixture(g));
  assert.throws(() => assertCommittedSnapshot(snapshot), /P22_SNAPSHOT_NOT_CURRENT/);
  const stale = await readQuerySource({ vaultRoot: f.vaultRoot, paperId: f.paperId, generationId: first.generation_id });
  assert.equal(stale.status, 'not_ready');
  assert.equal(stale.errors[0].code, 'P23_QUERY_GENERATION_CHANGED');
});

test('legacy committed sidecars remain searchable without fabricated bibliography or original verification', async t => {
  const f = await readingFirstIndexFixture(t);
  await f.save(await f.build());
  const { queryLibrary, readQuerySource } = await library();
  const found = await queryLibrary({ vaultRoot: f.vaultRoot, query: 'finalresultneedle' });
  assert.equal(found.status, 'matches');
  assert.deepEqual(found.results[0].citation, { status: 'metadata_unavailable', bibliography: null, sources: [], claim_verification: 'not_performed' });
  assert.equal((await readQuerySource({ vaultRoot: f.vaultRoot, paperId: f.identity.paper_id })).status, 'source_unavailable');
});

async function citationConsumerFixture(t, mutate) {
  const f = await readingFirstIndexFixture(t);
  const path = f.manifest.targets.assets.find(path => path.startsWith('Raw/'));
  const original = f.files.find(row => row.path === path);
  f.manifest.citation = { bibliography: { title: { en: 'Synthetic citation consumer', 'zh-CN': '合成引用消费' } }, sources: [{
    source_id: 'paper', path, sha256: digest(original.bytes), byte_length: original.bytes.length, source_version: 'registered-version-1', locators: [],
  }] };
  mutate?.(f.manifest.citation);
  const file = f.files.find(row => row.kind === 'reader-presentation');
  file.bytes = Buffer.from(JSON.stringify(f.manifest));
  f.paper.reader_presentation.sha256 = digest(file.bytes);
  f.generation.objects.find(row => row.path === file.path).sha256 = digest(file.bytes);
  await f.save(await f.build());
  return f;
}

test('known source identity without reported locators preserves the version and reports locator unknown', async t => {
  const f = await citationConsumerFixture(t);
  const { queryLibrary, readQuerySource } = await library();
  const found = await queryLibrary({ vaultRoot: f.vaultRoot, query: 'finalresultneedle' });
  assert.equal(found.status, 'matches');
  const source = found.results[0].citation.sources[0];
  assert.equal(source.source_version, 'registered-version-1');
  assert.equal(source.locator_status, 'unknown');
  assert.deepEqual(source.locators, []);
  assert.equal(found.results[0].citation.bibliography.doi, undefined);
  assert.equal((await readQuerySource({ vaultRoot: f.vaultRoot, paperId: f.identity.paper_id })).status, 'identity_verified');
});

test('a citation cannot point at an asset with another registered identity', async t => {
  const f = await citationConsumerFixture(t, citation => { citation.sources[0].sha256 = digest(Buffer.from('other source')); });
  const { queryLibrary, readQuerySource } = await library();
  const found = await queryLibrary({ vaultRoot: f.vaultRoot, query: 'finalresultneedle' });
  assert.equal(found.status, 'partial');
  assert.equal(found.diagnostics[0].code, 'P23_CITATION_SOURCE_BINDING_INVALID');
  assert.equal((await readQuerySource({ vaultRoot: f.vaultRoot, paperId: f.identity.paper_id })).status, 'not_ready');
});

test('a damaged supplementary source does not invalidate the selected intact source', async t => {
  const f = await readingFirstIndexFixture(t);
  const originalPath = f.manifest.targets.assets.find(path => path.startsWith('Raw/'));
  const original = f.files.find(row => row.path === originalPath);
  const supplement = { path: 'Raw/supplement.pdf', kind: 'asset', bytes: Buffer.from('synthetic supplement') };
  f.files.push(supplement);
  f.generation.objects.push({ path: supplement.path, kind: 'asset', sha256: digest(supplement.bytes) });
  f.manifest.targets.assets.push(supplement.path);
  f.manifest.citation = { bibliography: { title: { en: 'Two source study' } }, sources: [
    { source_id: 'paper', path: originalPath, sha256: digest(original.bytes), byte_length: original.bytes.length, source_version: null, locators: [] },
    { source_id: 'supplement', path: supplement.path, sha256: digest(supplement.bytes), byte_length: supplement.bytes.length, source_version: null, locators: [] },
  ] };
  const sidecar = f.files.find(row => row.kind === 'reader-presentation');
  sidecar.bytes = Buffer.from(JSON.stringify(f.manifest));
  f.paper.reader_presentation.sha256 = digest(sidecar.bytes);
  f.generation.objects.find(row => row.path === sidecar.path).sha256 = digest(sidecar.bytes);
  await f.save(await f.build());
  await writeFile(join(f.vaultRoot, supplement.path), 'damaged supplement');
  const { queryLibrary, readQuerySource, executeLibraryQuery } = await library();
  const main = await readQuerySource({ vaultRoot: f.vaultRoot, paperId: f.identity.paper_id, sourceId: 'paper' });
  assert.equal(main.status, 'identity_verified');
  assert.equal((await readQuerySource({ vaultRoot: f.vaultRoot, paperId: f.identity.paper_id, sourceId: 'supplement' })).status, 'not_ready');
  const found = await queryLibrary({ vaultRoot: f.vaultRoot, query: 'finalresultneedle' });
  assert.equal(found.status, 'partial');
  assert.equal(found.results[0].citation.sources.find(row => row.source_id === 'paper').status, 'identity_verified');
  assert.equal(found.results[0].citation.sources.find(row => row.source_id === 'supplement').status, 'unavailable');
  assert.ok(found.diagnostics.some(row => row.path === supplement.path));
  const result = await executeLibraryQuery({ repoRoot: f.vaultRoot, question: 'finalresultneedle',
    mainSession: { model: 'synthetic-main', reasoning_effort: 'high' }, hostCapabilities: { currentSession: true },
    executeHost: async () => ({ answer: 'An answer based on the intact source.', adopted_sources: [{ paper_id: f.identity.paper_id,
      analysis_revision: f.identity.analysis_revision, adopted_generation_id: f.generation.generation_id, source_id: 'paper',
      source_sha256: digest(original.bytes), source_version: null, locators: [], adopted_for: ['answer'] }] }) });
  assert.equal(result.status, 'answered');
  assert.equal(result.adopted_sources[0].source_id, 'paper');
});

test('a valid committed empty generation differs from an absent generation or an unmatched query', async t => {
  const vaultRoot = await mkdtemp(join(tmpdir(), 'apa-query-empty-'));
  t.after(() => rm(vaultRoot, { recursive: true, force: true }));
  const generation = { schema_version: 'phase22/active-index-1.0', kind: 'active', generation_id: 'empty-consumer-fixture',
    evidence_mode: 'synthetic', papers: [], shared_nodes: [], objects: [] };
  const built = await buildBilingualIndex({ generation, validatedInputs: { papers: [], files: [] } });
  await saveReadingFirstPair(vaultRoot, built.generation, built.index);
  const { queryLibrary } = await library();
  const found = await queryLibrary({ vaultRoot, query: 'anything' });
  assert.equal(found.ok, true);
  assert.equal(found.status, 'empty_library');
  assert.deepEqual(found.results, []);
});

test('citation extension preserves the renderer supported uppercase PDF suffix and formula visual', async t => {
  const catalog = structuredClone((await reviewedReadingFirstFixture(t)).presentationCatalog);
  catalog.source_pdf = catalog.source_pdf.replace(/\.pdf$/, '.PDF');
  catalog.visuals[0].kind = 'formula';
  const f = await readingFirstPublicationFixture(t, { presentation: catalog });
  await applyBilingualPublication(applyReadingFirstFixture(f));
  const { queryLibrary } = await library();
  const found = await queryLibrary({ vaultRoot: f.vaultRoot, query: 'supported' });
  assert.equal(found.status, 'matches');
  assert.equal(found.results[0].citation.sources[0].locators[0].kind, 'formula');
});
