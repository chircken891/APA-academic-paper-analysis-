import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readRegisteredCommit } from '../../scripts/v3/phase22-active-version.mjs';
import { applyBilingualPublication, dryRunBilingualPublication, registerBilingualPublication } from '../../scripts/v3/phase22-publication.mjs';
import { prepareReadingFirstCitationCorrection, prepareReadingFirstPublication } from '../../scripts/v3/reading-first-publication.mjs';
import { publishReadingFirstCandidate } from '../../scripts/v3/reading-first-publish.mjs';
import { buildNoteRelocationReview } from '../../scripts/v3/note-relocation.mjs';
import { captureReadingFirstPublicationSource, createReadingFirstRunControl } from '../../scripts/v3/reading-first-runtime.mjs';
import { fingerprintV3Json } from '../../scripts/v3/semantic-package-validator.mjs';
import { applyReadingFirstFixture, readingFirstPublicationAuthority, readingFirstPublicationFixture } from './helpers/reading-first-publication-fixtures.mjs';
import { reviewedReadingFirstFixture } from './helpers/reading-first-publication-source-fixtures.mjs';

const policy = 'clippings-originals-1.0';
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value) + '\n');
async function fixture(t, { canonical = true, legacy = false, docx = false, display = false, existingVault, ...identity } = {}) {
  const vaultRoot = existingVault ?? await mkdtemp(join(tmpdir(), 'apa-clippings-publish-'));
  if (!existingVault) t.after(() => rm(vaultRoot, { recursive: true, force: true }));
  const displayTarget = 'Clippings/intake/display.pdf';
  const input = docx ? { manifestDocx: true } : display ? {
    visualProvenance: 'owned-registered-docx', omitPresentationAssets: true, unregisteredDisplay: true, displayTarget,
  } : {};
  let presentation;
  if (!docx && !display) {
    const template = await reviewedReadingFirstFixture(t);
    presentation = structuredClone(template.presentationCatalog);
    if (canonical) {
      presentation.source_pdf = 'Clippings/intake/source.pdf';
      presentation.sources = [{ id: template.source.id, path: presentation.source_pdf, kind: 'main' }];
    }
  }
  const f = await reviewedReadingFirstFixture(t, {
    ...input, ...identity, ...(!docx ? { currentRegistryRoot: vaultRoot } : {}), presentation, translationLanguage: null,
    ...(canonical ? { artifactRoot: join(vaultRoot, 'Clippings', 'intake') } : {}),
    ...(legacy ? {} : {
      createRunControl: args => createReadingFirstRunControl({ ...args, configuredSetup: {
        ...args.configuredSetup, source_policy: policy,
        source_locations: args.scientificInput.sources.map(source => ({ source_id: source.id, path: source.path,
          vault_path: canonical ? 'Clippings/intake/' + (source.id === 'supplement' ? 'supplement.docx' : 'source.pdf') : presentation.source_pdf,
          original_path: source.path, sha256: source.sha256, byte_length: source.byte_length })),
      } }),
    }),
  });
  const source = await captureReadingFirstPublicationSource({ controller: f.controller, presentation: f.candidate });
  return { ...f, vaultRoot, source, evidenceMode: 'synthetic', generation: 'clippings-publication' };
}

const publicationOptions = f => ({
  source: f.source, vaultRoot: f.vaultRoot, resources: f.resources, evidenceMode: f.evidenceMode, generation: f.generation,
  authorization: { authorization_id: 'clippings-publication-test', user_reply: '发布' }, onPrepared() {},
});

test('Clippings 原件只登记为读依赖，资产清单不复制文献', async t => {
  const f = await fixture(t);
  const prepared = await prepareReadingFirstPublication(publicationOptions(f));
  const path = 'Clippings/intake/source.pdf';
  assert.ok(prepared.plan.read_dependencies.some(row => row.path === path));
  assert.ok(!prepared.plan.inventory.some(row => row.path === path || row.path.startsWith('Raw/')));
  const published = await publishReadingFirstCandidate(publicationOptions(f));
  assert.equal(published.status, 'committed', JSON.stringify(published.error));
  const registered = await readRegisteredCommit({ vaultRoot: f.vaultRoot });
  assert.equal(registered.generation.objects.find(row => row.path === path)?.kind, 'asset');
  assert.equal(registered.generation.objects.find(row => row.path === path)?.sha256, f.resources[0].sha256);
});

test('Results 资源清单以 Clippings 补充 DOCX 为母文献，发布只登记原件', async t => {
  const f = await fixture(t, { docx: true });
  const path = 'Clippings/intake/supplement.docx';
  const prepared = await prepareReadingFirstPublication(publicationOptions(f));
  assert.ok(prepared.plan.read_dependencies.some(row => row.path === path));
  assert.ok(!prepared.plan.inventory.some(row => row.path === path));
  const sidecar = JSON.parse(prepared.plan.inventory.find(row => row.kind === 'reader-presentation').bytes);
  const supplement = sidecar.citation.sources.find(row => row.path === path);
  assert.equal(supplement.sha256, f.input.sources.find(row => row.id === 'supplement').sha256);
  assert.equal(supplement.locators[0].locator.kind, 'docx-figure');
});

test('Clippings 中已批准的展示 PDF 与 DOCX 母文献均只登记', async t => {
  const f = await fixture(t, { display: true });
  const path = 'Clippings/intake/display.pdf', parentPath = 'Clippings/intake/supplement.docx';
  const parent = f.input.sources.find(row => row.id === 'supplement');
  const scope = { run_id: f.runId, resource: f.resources.find(row => row.path === path),
    scientific_parent: { source_id: parent.id, path: parent.path, sha256: parent.sha256 } };
  const save = async (name, value) => {
    const path = join(f.root, name), bytes = json(value);
    await writeFile(path, bytes);
    return { path, sha256: sha(bytes), byte_length: bytes.length };
  };
  const approval = await save('display-approval.json', { schema_version: 'reading-first-presentation-asset-approval-1.0',
    authorization_id: 'clippings-display-approval', user_reply: '批准', ...scope, presentation_fingerprint: f.candidate.presentation_fingerprint,
    approved_candidate: await save('display-approval-candidate.json', scope) });
  const prepared = await prepareReadingFirstPublication({ ...publicationOptions(f), presentationAssetRegistrations: [approval] });
  for (const target of [path, parentPath]) {
    assert.ok(prepared.plan.read_dependencies.some(row => row.path === target));
    assert.ok(!prepared.plan.inventory.some(row => row.path === target));
  }
  const asset = prepared.review.reviewManifest.assets.find(row => row.path === path);
  assert.equal(asset.presentation_asset_registration.scientific_parent.source_id, parent.id);
  assert.equal(asset.presentation_asset_registration.approval_binding.sha256, approval.sha256);
});

test('新策略禁止主文落入 Raw，即使存在已审候选', async t => {
  const f = await fixture(t, { canonical: false });
  await assert.rejects(prepareReadingFirstPublication(publicationOptions(f)), /RF_PUBLICATION_RAW_WRITE_FORBIDDEN/);
});

test('历史已审本篇的同字节 Raw 资源在新发布中改指 Clippings', async t => {
  const f = await fixture(t, { canonical: false, legacy: true });
  const path = 'Clippings/original.pdf';
  await mkdir(join(f.vaultRoot, 'Clippings'));
  await copyFile(f.resources[0].source_path, join(f.vaultRoot, path));
  await mkdir(join(f.vaultRoot, 'Raw'));
  await copyFile(f.resources[0].source_path, join(f.vaultRoot, f.resources[0].path));
  const before = f.candidate.notes.map(note => note.content);
  const prepared = await prepareReadingFirstPublication(publicationOptions(f));
  assert.ok(!prepared.plan.inventory.some(row => row.path.startsWith('Raw/')));
  assert.ok(prepared.plan.read_dependencies.some(row => row.path === path));
  assert.ok(prepared.publication_sources.raw_cleanup_candidates.some(row => row.raw_path === f.resources[0].path));
  assert.deepEqual(f.candidate.notes.map(note => note.content), before);
  for (const note of prepared.plan.inventory.filter(row => row.kind === 'paper')) {
    assert.match(note.bytes.toString(), /\.\.\/\.\.\/Clippings\/original\.pdf/);
  }
  const authority = await readingFirstPublicationAuthority(f, prepared.plan);
  const registration = await registerBilingualPublication({ vaultRoot: f.vaultRoot, run: f.runId, plan: prepared.plan,
    sourceInputs: prepared.sourceInputs, ...authority });
  const module = new URL('../../scripts/v3/phase22-publication.mjs', import.meta.url).href;
  const code = 'import { loadBilingualPublication, applyBilingualPublication } from ' + JSON.stringify(module) + ';\n'
    + 'const [vaultRoot,run,anchor,approvalRecord,maintenanceWindowRecord] = process.argv.slice(1);\n'
    + 'const loaded = await loadBilingualPublication({vaultRoot,run,trustAnchor:JSON.parse(anchor),requireApproval:true});\n'
    + 'const result=await applyBilingualPublication({vaultRoot,run,plan:loaded.plan,control:loaded.control,approvalRecord,maintenanceWindowRecord,'
    + 'expectedReviewSha256:loaded.plan.hashes.review_hash,expectedOutputSha256:loaded.plan.hashes.output_inventory_hash});\n'
    + 'console.log(JSON.stringify(result));';
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, f.vaultRoot, f.runId,
    JSON.stringify(registration.trust_anchor), authority.approvalRecord, authority.maintenanceWindowRecord], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'committed');
  for (const note of prepared.plan.inventory.filter(row => row.kind === 'paper')) {
    assert.deepEqual(await readFile(join(f.vaultRoot, note.path)), note.bytes);
  }
  assert.deepEqual(await readFile(join(f.vaultRoot, f.resources[0].path)), await readFile(f.resources[0].source_path));
});

test('清单展示之后新出现同字节 Clippings 文件时，重新申请批准且不写入正式库', async t => {
  const f = await fixture(t, { canonical: false, legacy: true });
  const result = await publishReadingFirstCandidate({ ...publicationOptions(f), onPrepared: async () => {
    await mkdir(join(f.vaultRoot, 'Clippings'));
    await copyFile(f.resources[0].source_path, join(f.vaultRoot, 'Clippings', 'new-original.pdf'));
  } });
  assert.equal(result.status, 'awaiting_reapproval');
  assert.equal(result.error.code, 'RF_PUBLICATION_SOURCE_SELECTION_CHANGED');
  assert.equal(result.error.details.proposed.source_path_remaps[0].new_path, 'Clippings/new-original.pdf');
  assert.equal(result.business_writes, 0);
  await assert.rejects(readFile(join(f.vaultRoot, '.apa-v3', 'phase22', 'COMMITTED.json')), /ENOENT/);
});

test('发布报告提示旧来源迁移候选，迁移后新论文仍只登记 Clippings 原件', async t => {
  const prior = await fixture(t, { canonical: false, legacy: true });
  const published = await publishReadingFirstCandidate(publicationOptions(prior));
  assert.equal(published.status, 'committed', JSON.stringify(published.error));
  const rawPath = prior.resources[0].path, original = 'Clippings/prior-original.pdf';
  await mkdir(join(prior.vaultRoot, 'Clippings'));
  await copyFile(join(prior.vaultRoot, rawPath), join(prior.vaultRoot, original));
  const current = await fixture(t, { existingVault: prior.vaultRoot, runId: 'run_' + 'b'.repeat(32),
    paperId: 'pap_' + 'b'.repeat(32), sourceText: 'Distinct current scientific source', title: { en: 'Another paper', 'zh-CN': '另一篇论文' } });
  const prepared = await prepareReadingFirstPublication({ ...publicationOptions(current), generation: 'second-clippings-publication' });
  assert.ok(prepared.publication_sources.migration_candidates.some(row => row.raw_path === rawPath && row.clippings_path === original));
  assert.ok(!prepared.publication_sources.raw_cleanup_candidates.some(row => row.raw_path === rawPath));
  assert.deepEqual(prepared.publication_sources.source_path_remaps, []);
  assert.ok(prior.candidate.notes.every(note => !prepared.plan.inventory.some(row => row.path === note.path)));
  const { vaultRoot, runId } = prior, { sha256, byte_length } = prior.resources[0];
  const review = await buildNoteRelocationReview({ vaultRoot, runId, generation: 'migrated-prior-source',
    assetMappings: [{ old_path: rawPath, new_path: original, sha256, byte_length }] });
  const { plan } = await dryRunBilingualPublication({ vaultRoot, run: runId, review });
  const authority = await readingFirstPublicationAuthority(prior, plan);
  assert.equal((await applyBilingualPublication({ vaultRoot, run: runId, plan, ...authority })).status, 'committed');
  const next = await publishReadingFirstCandidate({ ...publicationOptions(current), generation: 'second-clippings-publication' });
  assert.equal(next.status, 'committed', JSON.stringify(next.error));
  const registered = await readRegisteredCommit({ vaultRoot });
  assert.ok(registered.generation.objects.some(row => row.path === original));
  assert.ok(registered.generation.objects.some(row => row.path === 'Clippings/intake/source.pdf'));
  assert.ok(!registered.generation.objects.some(row => row.path.startsWith('Raw/')));
});

test('已登记原件改名时发布和 CLI 恢复入口提前报告，库文件字节不变', async t => {
  const f = await fixture(t);
  const result = await publishReadingFirstCandidate(publicationOptions(f));
  assert.equal(result.status, 'committed', JSON.stringify(result.error));
  await rename(join(f.vaultRoot, 'Clippings', 'intake', 'source.pdf'), join(f.vaultRoot, 'Clippings', 'intake', 'renamed.pdf'));
  const resources = join(f.root, 'drift-cli-resources.json');
  await writeFile(resources, json(f.resources));
  const snapshot = async () => Object.fromEntries(await Promise.all((await readdir(f.vaultRoot, { recursive: true, withFileTypes: true }))
    .map(async entry => {
      const path = join(entry.parentPath, entry.name);
      return [relative(f.vaultRoot, path), entry.isFile() ? sha(await readFile(path)) : null];
    })));
  const before = await snapshot();
  const checkDrift = error => {
    assert.equal(error.code, 'RF_PUBLICATION_PREVIOUS_OBJECT_CHANGED');
    assert.equal(error.details.path, 'Clippings/intake/source.pdf');
    assert.equal(error.details.registered_sha256, f.resources[0].sha256);
    assert.equal(error.details.status, 'missing');
    assert.ok(error.details.same_byte_candidates.includes('Clippings/intake/renamed.pdf'));
    return true;
  };
  await assert.rejects(prepareReadingFirstPublication(publicationOptions(f)), checkDrift);
  await assert.rejects(publishReadingFirstCandidate({ ...publicationOptions(f), source: null,
    onPrepared: () => assert.fail('drift must precede candidate preparation') }), checkDrift);
  const cli = fileURLToPath(new URL('../../scripts/v3/bilingual.mjs', import.meta.url));
  const command = spawnSync(process.execPath, [cli, 'publish', '--vault-root', f.vaultRoot, '--run', f.runId,
    '--run-root', join(f.vaultRoot, 'missing-run'), '--generation', 'after-drift', '--resources', resources,
    '--authorization-id', 'drift-cli-test', '--user-reply', '发布'], { encoding: 'utf8' });
  assert.equal(command.status, 1, command.stderr);
  assert.equal(command.stderr, '');
  const output = JSON.parse(command.stdout);
  assert.equal(output.ok, false);
  checkDrift(output.error);
  assert.deepEqual(await snapshot(), before);
});

// Synthetic current metadata models a Task 6 asset migration; the frozen run catalog remains untouched.
async function migratedCitationFixture(t, alterMapping = rows => rows) {
  const f = await readingFirstPublicationFixture(t, { omitPresentationAssets: true, visualProvenance: 'owned-registered-docx' });
  await applyBilingualPublication(applyReadingFirstFixture(f));
  const root = f.vaultRoot, markerPath = join(root, '.apa-v3/phase22/COMMITTED.json');
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  const active = JSON.parse(await readFile(join(root, marker.active.path), 'utf8'));
  const index = JSON.parse(await readFile(join(root, marker.index.path), 'utf8'));
  const paper = active.papers[0], sidecarPath = join(root, paper.reader_presentation.path);
  const manifestBytes = await readFile(sidecarPath), sidecar = JSON.parse(manifestBytes);
  const original = sidecar.citation.sources;
  const oldPaths = new Set(original.map(row => row.path));
  await mkdir(join(root, 'Clippings'));
  const rows = [];
  for (const source of original) {
    const old_path = source.path, new_path = 'Clippings/' + old_path.split('/').at(-1);
    await rename(join(root, old_path), join(root, new_path));
    rows.push({ old_path, new_path, sha256: source.sha256, byte_length: source.byte_length, source_id: source.source_id });
    active.objects.find(row => row.path === old_path).path = new_path;
  }
  const byOld = new Map(rows.map(row => [row.old_path, row.new_path]));
  sidecar.targets.assets = sidecar.targets.assets.map(path => byOld.get(path) ?? path);
  sidecar.citation.sources = [{ ...original[0], path: byOld.get(original[0].path), locators: original.flatMap(row => row.locators) }];
  const image = active.objects.find(row => row.kind === 'asset' && row.path.startsWith('Figures/'));
  const imageMapping = { old_path: 'Figures/legacy-synthetic/figure.png', new_path: image.path,
    sha256: image.sha256, byte_length: (await readFile(join(root, image.path))).length };
  sidecar.path_migration = { previous_generation: active.generation_id, previous_presentation_sha256: sha(manifestBytes),
    path_mapping_fingerprint: fingerprintV3Json([...byOld, [imageMapping.old_path, imageMapping.new_path]]), assets: [...alterMapping(rows), imageMapping] };
  const sidecarBytes = json(sidecar);
  await writeFile(sidecarPath, sidecarBytes);
  paper.reader_presentation.sha256 = sha(sidecarBytes);
  active.objects.find(row => row.path === paper.reader_presentation.path).sha256 = sha(sidecarBytes);
  index.active_fingerprint = fingerprintV3Json(active);
  const activeBytes = json(active), indexBytes = json(index);
  await writeFile(join(root, marker.active.path), activeBytes);
  await writeFile(join(root, marker.index.path), indexBytes);
  marker.active.sha256 = sha(activeBytes); marker.index.sha256 = sha(indexBytes);
  await writeFile(markerPath, json(marker));
  const catalogPath = join(f.root, 'frozen-catalog.json');
  const frozen = json({ run_id: f.runId, presentation: f.presentationCatalog });
  await writeFile(catalogPath, frozen);
  const correct = () => prepareReadingFirstCitationCorrection({ vaultRoot: root, runId: f.runId, catalogPath,
    generation: 'migrated-citation-correction', evidenceMode: 'synthetic' });
  return { f, root, rows, oldPaths, catalogPath, frozen, correct };
}

test('引用修正从冻结 Raw 路径解析已登记 Clippings，旧副本缺失时仍通过', async t => {
  const s = await migratedCitationFixture(t), corrected = await s.correct();
  const output = JSON.parse(corrected.plan.inventory.find(row => row.kind === 'reader-presentation').bytes);
  assert.ok(output.citation.sources.every(row => row.path.startsWith('Clippings/')));
  assert.equal(output.citation.sources.find(row => row.source_id === 'supplement').locators.length, 1);
  assert.equal(output.path_migration.assets.find(row => row.new_path.startsWith('Figures/')).source_id, undefined);
  assert.deepEqual(await readFile(s.catalogPath), s.frozen);
  for (const path of s.oldPaths) await assert.rejects(readFile(join(s.root, path)), /ENOENT/);
});

test('引用修正拒绝迁移记录与当前位置文件哈希不符', async t => {
  const s = await migratedCitationFixture(t, ([first, ...rest]) => [{ ...first, sha256: 'sha256:' + '0'.repeat(64) }, ...rest]);
  await assert.rejects(s.correct(), /RF_PUBLICATION_CITATION_MIGRATION_INVALID/);
});

for (const sourceId of ['paper', 'supplement']) test(`引用修正拒绝缺少 ${sourceId} 身份的文献迁移`, async t => {
  const s = await migratedCitationFixture(t, rows => rows.map(row => {
    if (row.source_id !== sourceId) return row;
    const { source_id, ...missingIdentity } = row;
    return missingIdentity;
  }));
  await assert.rejects(s.correct(), /RF_PUBLICATION_CITATION_MIGRATION_INVALID/);
});
