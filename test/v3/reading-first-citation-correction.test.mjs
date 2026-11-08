import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { createHash } from 'node:crypto';
import { readingFirstPublicationFixture, applyReadingFirstFixture, readingFirstPublicationAuthority } from './helpers/reading-first-publication-fixtures.mjs';
import { applyBilingualPublication, dryRunBilingualPublication, registerBilingualPublication } from '../../scripts/v3/phase22-publication.mjs';
import { readRegisteredCommit } from '../../scripts/v3/phase22-active-version.mjs';
import { prepareReadingFirstCitationCorrection } from '../../scripts/v3/reading-first-publication.mjs';
import { readQuerySource } from '../../scripts/v3/library-query.mjs';
import { fingerprintV3Json } from '../../scripts/v3/semantic-package-validator.mjs';
import { buildNoteRelocationReview } from '../../scripts/v3/note-relocation.mjs';

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

test('citation correction reads frozen sources after real synthetic migration and old copies are removed', async t => {
  const s = await misattributedVault(t), { f, before } = s, root = f.vaultRoot;
  const frozen = await readFile(s.catalogPath);
  const docx = f.resources.find(row => row.path.endsWith('.docx'));
  const assetRetirements = [{ path: docx.path, sha256: docx.sha256, byte_length: docx.byte_length }];
  const assetMappings = f.resources.filter(row => row.path.endsWith('.pdf')).map(row => ({ old_path: row.path,
    new_path: 'Clippings/' + posix.basename(row.path), sha256: row.sha256, byte_length: row.byte_length,
    ...(row.path === 'Raw/supplement-display.pdf' ? { source_id: 'supplement' } : {}) }));
  for (const row of assetMappings) {
    await mkdir(dirname(join(root, row.new_path)), { recursive: true });
    await writeFile(join(root, row.new_path), await readFile(join(root, row.old_path)));
  }
  const migrate = async options => {
    const review = await buildNoteRelocationReview({ vaultRoot: root, runId: f.runId, ...options });
    const { plan } = await dryRunBilingualPublication({ vaultRoot: root, run: f.runId, review });
    const authority = await readingFirstPublicationAuthority(f, plan);
    return applyBilingualPublication({ vaultRoot: root, run: f.runId, plan, ...authority });
  };
  const notePath = join(root, before.generation.papers[0].paths.en);
  const original = await readFile(notePath);
  await writeFile(notePath, Buffer.concat([original, Buffer.from('\n[Old original](../../Raw/supplement.docx)\n')]));
  await assert.rejects(buildNoteRelocationReview({ vaultRoot: root, runId: f.runId, generation: 'blocked-retirement', assetRetirements }),
    /P22_RELOCATION_ASSET_STILL_REFERENCED/);
  await writeFile(notePath, original);
  assert.equal((await migrate({ generation: 'migrated-before-correction', assetMappings, assetRetirements })).status, 'committed');
  for (const row of assetMappings) await unlink(join(root, row.old_path));
  const migrated = await readRegisteredCommit({ vaultRoot: root });
  assert.ok(!migrated.generation.objects.some(row => row.path === docx.path));
  const paper = migrated.generation.papers[0];
  const manifest = JSON.parse(await readFile(join(root, paper.reader_presentation.path)));
  assert.ok(!manifest.targets.assets.includes(docx.path));
  assert.equal(manifest.path_migration.retired_assets[0].path, docx.path);
  assert.equal(sha(await readFile(join(root, docx.path))), docx.sha256);
  assert.deepEqual(await readFile(join(root, before.sidecarPath)), before.sidecarBytes);
  assert.equal((await applyCorrection(s, await correct(s))).status, 'committed');
  const corrected = await readQuerySource({ vaultRoot: root, paperId: paper.paper_id, sourceId: 'supplement' });
  assert.equal(corrected.path, 'Clippings/supplement-display.pdf');
  assert.deepEqual(await readFile(s.catalogPath), frozen);
  const compensation = await migrate({ generation: 'restored-docx-registration', restoreAssetRetirements: [docx.path] });
  assert.equal(compensation.status, 'committed');
  const restored = await readRegisteredCommit({ vaultRoot: root });
  assert.equal(restored.generation.objects.find(row => row.path === docx.path)?.sha256, docx.sha256);
  const restoredManifest = JSON.parse(await readFile(join(root, restored.generation.papers[0].reader_presentation.path)));
  assert.equal(restoredManifest.targets.assets.indexOf(docx.path), JSON.parse(before.sidecarBytes).targets.assets.indexOf(docx.path));
  assert.deepEqual(restoredManifest.citation.sources.map(row => row.path), [manifest.citation.sources[0].path, corrected.path]);
});
