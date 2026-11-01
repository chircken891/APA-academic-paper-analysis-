import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readingFirstPublicationFixture, applyReadingFirstFixture, readingFirstPublicationAuthority } from './helpers/reading-first-publication-fixtures.mjs';
import { applyBilingualPublication, registerBilingualPublication } from '../../scripts/v3/phase22-publication.mjs';
import { readRegisteredCommit } from '../../scripts/v3/phase22-active-version.mjs';
import { prepareReadingFirstCitationCorrection } from '../../scripts/v3/reading-first-publication.mjs';
import { readQuerySource } from '../../scripts/v3/library-query.mjs';
import { fingerprintV3Json } from '../../scripts/v3/semantic-package-validator.mjs';

const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const jsonBytes = value => Buffer.from(JSON.stringify(value) + '\n');

// Rewrites the committed pair so the paper's sidecar carries the pre-fix citation (every locator under the main PDF).
async function misattributeCommittedCitation(vaultRoot) {
  const markerPath = join(vaultRoot, '.apa-v3/phase22/COMMITTED.json');
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  const active = JSON.parse(await readFile(join(vaultRoot, marker.active.path), 'utf8'));
  const index = JSON.parse(await readFile(join(vaultRoot, marker.index.path), 'utf8'));
  const paper = active.papers[0], sidecarPath = paper.reader_presentation.path;
  const sidecar = JSON.parse(await readFile(join(vaultRoot, sidecarPath), 'utf8'));
  const [main, ...others] = sidecar.citation.sources;
  sidecar.citation.sources = [{ ...main, locators: [...main.locators, ...others.flatMap(row => row.locators)] }];
  const sidecarBytes = jsonBytes(sidecar);
  await writeFile(join(vaultRoot, sidecarPath), sidecarBytes);
  paper.reader_presentation.sha256 = sha(sidecarBytes);
  active.objects.find(row => row.path === sidecarPath).sha256 = sha(sidecarBytes);
  index.active_fingerprint = fingerprintV3Json(active);
  const activeBytes = jsonBytes(active), indexBytes = jsonBytes(index);
  await writeFile(join(vaultRoot, marker.active.path), activeBytes);
  await writeFile(join(vaultRoot, marker.index.path), indexBytes);
  marker.active.sha256 = sha(activeBytes); marker.index.sha256 = sha(indexBytes);
  await writeFile(markerPath, jsonBytes(marker));
  return { sidecarPath, sidecarBytes, generation: active, index };
}

async function misattributedVault(t) {
  const f = await readingFirstPublicationFixture(t, { omitPresentationAssets: true, visualProvenance: 'owned-registered-docx' });
  await applyBilingualPublication(applyReadingFirstFixture(f));
  const before = await misattributeCommittedCitation(f.vaultRoot);
  assert.equal((await readRegisteredCommit({ vaultRoot: f.vaultRoot })).ok, true);
  const catalogPath = join(f.root, 'frozen-catalog.json');
  await writeFile(catalogPath, JSON.stringify({ run_id: f.runId, presentation: f.presentationCatalog }));
  return { f, before, catalogPath };
}

const correct = (s, overrides = {}) => prepareReadingFirstCitationCorrection({ vaultRoot: s.f.vaultRoot, runId: s.f.runId,
  catalogPath: s.catalogPath, generation: 'citation-correction-1', evidenceMode: 'synthetic', ...overrides });

async function applyCorrection(s, prepared) {
  const authority = await readingFirstPublicationAuthority({ ...s.f, vaultRoot: s.f.vaultRoot }, prepared.plan);
  await registerBilingualPublication({ vaultRoot: s.f.vaultRoot, run: s.f.runId, plan: prepared.plan, sourceInputs: prepared.sourceInputs, ...authority });
  return applyBilingualPublication({ vaultRoot: s.f.vaultRoot, run: s.f.runId, plan: prepared.plan, ...authority });
}

test('citation correction writes only the sidecar and the generation pair', async t => {
  const s = await misattributedVault(t), prepared = await correct(s);
  assert.equal(prepared.status, 'dry_run');
  assert.equal(prepared.business_writes, 0);
  assert.deepEqual([...new Set(prepared.plan.inventory.map(row => row.kind))].sort(), ['active', 'commit', 'index', 'manifest', 'reader-presentation']);
  const active = JSON.parse(prepared.plan.inventory.find(row => row.kind === 'active').bytes);
  const index = JSON.parse(prepared.plan.inventory.find(row => row.kind === 'index').bytes);
  const unchanged = rows => rows.filter(row => row.kind !== 'reader-presentation');
  assert.deepEqual(unchanged(active.objects), unchanged(s.before.generation.objects));
  assert.deepEqual(index.documents, s.before.index.documents);
});

test('corrected citation attaches supplement visuals to their registered source', async t => {
  const s = await misattributedVault(t), prepared = await correct(s);
  assert.equal((await applyCorrection(s, prepared)).status, 'committed');
  const commit = await readRegisteredCommit({ vaultRoot: s.f.vaultRoot });
  const paper = commit.generation.papers[0];
  const sidecar = JSON.parse(await readFile(join(s.f.vaultRoot, paper.reader_presentation.path), 'utf8'));
  const supplement = sidecar.citation.sources.find(row => row.source_id === 'supplement');
  assert.equal(supplement.path, 'Raw/supplement-display.pdf');
  assert.equal(supplement.sha256, commit.generation.objects.find(row => row.path === supplement.path).sha256);
  assert.deepEqual(supplement.locators.map(row => row.id), [s.f.presentationCatalog.visuals[0].id]);
  assert.equal(sidecar.citation.sources[0].locators.some(row => row.id === s.f.presentationCatalog.visuals[0].id), false);
  const source = await readQuerySource({ vaultRoot: s.f.vaultRoot, paperId: paper.paper_id, sourceId: 'supplement' });
  assert.equal(source.ok, true);
  assert.equal(source.path, 'Raw/supplement-display.pdf');
});

test('corrected sidecar is written to a new path and the old sidecar stays', async t => {
  const s = await misattributedVault(t), prepared = await correct(s);
  await applyCorrection(s, prepared);
  const paper = (await readRegisteredCommit({ vaultRoot: s.f.vaultRoot })).generation.papers[0];
  assert.notEqual(paper.reader_presentation.path, s.before.sidecarPath);
  assert.match(paper.reader_presentation.path, /-citation-[0-9a-f]{12}\.json$/);
  assert.deepEqual(await readFile(join(s.f.vaultRoot, s.before.sidecarPath)), s.before.sidecarBytes);
});

test('correction refuses a catalog that does not cover every committed locator', async t => {
  const s = await misattributedVault(t);
  await writeFile(s.catalogPath, JSON.stringify({ run_id: s.f.runId, presentation: { ...s.f.presentationCatalog, visuals: [] } }));
  await assert.rejects(correct(s), /RF_CITATION_CORRECTION_SCOPE/);
});

test('correction refuses a catalog record from another run', async t => {
  const s = await misattributedVault(t);
  await writeFile(s.catalogPath, JSON.stringify({ run_id: 'other-run', presentation: s.f.presentationCatalog }));
  await assert.rejects(correct(s), /RF_CITATION_CORRECTION_SCOPE/);
});

test('correction refuses a source that is not a registered asset of the paper', async t => {
  const s = await misattributedVault(t);
  const catalog = structuredClone(s.f.presentationCatalog);
  catalog.sources.find(row => row.id === 'supplement').path = 'Raw/unregistered-supplement.pdf';
  await writeFile(s.catalogPath, JSON.stringify({ run_id: s.f.runId, presentation: catalog }));
  await assert.rejects(correct(s), /RF_PUBLICATION_CITATION_SOURCE_UNREGISTERED/);
});

test('correction refuses when the committed citation is already correct', async t => {
  const s = await misattributedVault(t);
  await applyCorrection(s, await correct(s));
  await assert.rejects(correct(s, { generation: 'citation-correction-2' }), /RF_CITATION_CORRECTION_NOOP/);
});
