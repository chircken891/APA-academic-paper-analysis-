import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { reviewedReadingFirstFixture } from './helpers/reading-first-publication-source-fixtures.mjs';
import { readingFirstPublicationAuthority } from './helpers/reading-first-publication-fixtures.mjs';
import { captureReadingFirstPublicationSource } from '../../scripts/v3/reading-first-runtime.mjs';
import { prepareReadingFirstPublication } from '../../scripts/v3/reading-first-publication.mjs';
import { applyBilingualPublication, registerBilingualPublication } from '../../scripts/v3/phase22-publication.mjs';
import { readCommittedGeneration } from '../../scripts/v3/phase22-active-version.mjs';
import { queryBilingualIndex } from '../../scripts/v3/phase22-search.mjs';

const sha = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const path = 'Wiki/methods/existing-method.md';
const original = '---\ntype: method\npipeline_version: 2.0.0\ngraph_scope: v2-canonical\n---\n# Existing method\n\nmanuallegacyonlytoken Original explanation stays verbatim.\n';
const migrate = text => text.replace('pipeline_version: 2.0.0', 'pipeline_version: "3.0"').replace('graph_scope: v2-canonical', 'graph_scope: v3-candidate');
async function fixture(t) {
  const f = await reviewedReadingFirstFixture(t, { knowledgeRegistry: [{ id: 'method', canonical_key: 'synthetic-method', path, content: original }] });
  const vaultRoot = join(f.root, 'publication-vault');
  await mkdir(join(vaultRoot, 'Wiki/methods'), { recursive: true });
  await writeFile(join(vaultRoot, path), original);
  const source = await captureReadingFirstPublicationSource({ controller: f.controller, presentation: f.candidate });
  const support = f.candidate.supportNotes.find(row => row.path === path);
  const migration = { path, before_sha256: sha(original), candidate_sha256: sha(support.content), output_sha256: sha(migrate(support.content)) };
  return { ...f, run: f.runId, vaultRoot, source, support, migration,
    args: { source, vaultRoot, resources: f.resources, evidenceMode: 'synthetic' } };
}

test('explicit exact metadata migration preserves reviewed content, survives registration reload, and commits via the existing transaction', async t => {
  const f = await fixture(t), candidateBefore = JSON.stringify(f.candidate), reviewBefore = JSON.stringify(f.reviewReceipt);
  const prepared = await prepareReadingFirstPublication({ ...f.args, knowledgeMetadataMigrations: [f.migration] });
  const output = prepared.plan.inventory.find(row => row.path === path);
  assert.equal(output.bytes.toString(), migrate(f.support.content));
  assert.deepEqual(prepared.review.reviewManifest.support_notes.find(row => row.path === path).metadata_migration, f.migration);
  assert.equal(JSON.stringify(f.candidate), candidateBefore);
  assert.equal(JSON.stringify(f.reviewReceipt), reviewBefore);
  const authority = await readingFirstPublicationAuthority(f, prepared.plan);
  const registration = await registerBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, plan: prepared.plan, sourceInputs: prepared.sourceInputs, ...authority });
  const moduleUrl = new URL('../../scripts/v3/phase22-publication.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import{loadBilingualPublication}from ${JSON.stringify(moduleUrl)};const r=await loadBilingualPublication({vaultRoot:process.argv[1],run:process.argv[2],trustAnchor:JSON.parse(process.argv[3])});console.log(JSON.stringify(r.plan.hashes));`,
    f.vaultRoot, f.run, JSON.stringify(registration.trust_anchor)], { encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), prepared.plan.hashes);
  const applied = await applyBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, plan: prepared.plan, ...authority });
  assert.equal(applied.status, 'committed');
  assert.equal((await readFile(join(f.vaultRoot, path))).toString(), migrate(f.support.content));
  const snapshot = await readCommittedGeneration({ vaultRoot: f.vaultRoot });
  assert.equal(snapshot.ok, true, JSON.stringify(snapshot.errors));
  assert.ok(queryBilingualIndex({ index: snapshot.index, activeSnapshot: snapshot, query: 'supportonlytoken' }).results.length);
  assert.equal(queryBilingualIndex({ index: snapshot.index, activeSnapshot: snapshot, query: 'manuallegacyonlytoken' }).results.length, 0);
});

test('legacy nodes remain rejected without explicit migration and exact three byte bindings', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareReadingFirstPublication(f.args), /RF_PUBLICATION_SUPPORT_VERSION_INVALID/);
  for (const field of ['before_sha256', 'candidate_sha256', 'output_sha256']) {
    await assert.rejects(prepareReadingFirstPublication({ ...f.args, knowledgeMetadataMigrations: [{ ...f.migration, [field]: 'sha256:' + '0'.repeat(64) }] }), /RF_PUBLICATION_METADATA_MIGRATION_MISMATCH/);
  }
  await assert.rejects(prepareReadingFirstPublication({ ...f.args, knowledgeMetadataMigrations: [f.migration, f.migration] }), /RF_PUBLICATION_METADATA_MIGRATION_INVALID/);
  await assert.rejects(prepareReadingFirstPublication({ ...f.args, knowledgeMetadataMigrations: [{ ...f.migration, path: 'Wiki/methods/unreviewed.md' }] }), /RF_PUBLICATION_METADATA_MIGRATION_INVALID/);
  assert.equal((await readFile(join(f.vaultRoot, path))).toString(), original);
});

test('metadata migration cannot replace scientific prose with an approved arbitrary output hash', async t => {
  const f = await fixture(t);
  const edited = migrate(f.support.content).replace('Original explanation stays verbatim.', 'Invented new scientific conclusion.');
  await assert.rejects(prepareReadingFirstPublication({ ...f.args, knowledgeMetadataMigrations: [{ ...f.migration, output_sha256: sha(edited) }] }), /RF_PUBLICATION_METADATA_MIGRATION_MISMATCH/);
  assert.equal((await readFile(join(f.vaultRoot, path))).toString(), original);
});
