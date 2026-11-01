import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readingFirstPublicationFixture, applyReadingFirstFixture, readingFirstPublicationAuthority } from './helpers/reading-first-publication-fixtures.mjs';
import { reviewedReadingFirstFixture } from './helpers/reading-first-publication-source-fixtures.mjs';
import { captureReadingFirstPublicationSource, deriveRebasedReadingFirstPublicationSource, inspectReadingFirstPublicationSource } from '../../scripts/v3/reading-first-runtime.mjs';
import { prepareReadingFirstPublication, prepareExternalReviewedReadingFirstPublication } from '../../scripts/v3/reading-first-publication.mjs';
import { applyBilingualPublication, registerBilingualPublication } from '../../scripts/v3/phase22-publication.mjs';
import { readRegisteredCommit } from '../../scripts/v3/phase22-active-version.mjs';
import { checkCommittedIndex } from '../../scripts/check-bm25-index.mjs';
import { queryLibrary } from '../../scripts/v3/library-query.mjs';
import { buildRegisteredGraphProposal } from '../../scripts/v3/phase22-graph.mjs';

for (const [humanEdit, external] of [[false, false], [true, false], [false, true]]) test(`independent candidates register, restart and publish after rebase (manual edits: ${humanEdit}, external: ${external})`, async t => {
  const first = await readingFirstPublicationFixture(t);
  if (humanEdit) await applyBilingualPublication(applyReadingFirstFixture(first));
  const bPresentation = structuredClone(first.presentationCatalog);
  bPresentation.knowledge[0].paragraphs.en.push('Independent B knowledge needle.');
  bPresentation.knowledge[0].paragraphs['zh-CN'].push('独立 B 知识内容。');
  const second = await reviewedReadingFirstFixture(t, { currentRegistryRoot: first.vaultRoot, presentation: bPresentation,
    runId: 'run_' + 'b'.repeat(32), paperId: 'pap_' + 'b'.repeat(32),
    ...(external ? { omitPresentationAssets: true, visualProvenance: true } : {}),
    title: { en: 'Second independent paper', 'zh-CN': '第二篇独立论文' },
  });
  let originalSource = await captureReadingFirstPublicationSource({ controller: second.controller, presentation: second.candidate });
  if (external) {
    const data = await inspectReadingFirstPublicationSource(originalSource);
    const candidateRoot = join(second.root, 'external-candidate');
    for (const note of [...data.candidate.notes, ...data.candidate.supportNotes]) {
      await mkdir(dirname(join(candidateRoot, note.path)), { recursive: true });
      await writeFile(join(candidateRoot, note.path), note.content);
    }
    const preparedExternal = await prepareExternalReviewedReadingFirstPublication({ vaultRoot: first.vaultRoot,
      candidateRoot, runRoot: second.root, generation: 'external-before-rebase', evidenceMode: 'synthetic',
      scientificInput: second.input, candidate: data.candidate, presentation: data.presentation, review: data.review,
      reviewReceipt: data.review_receipt, viewReceipts: data.view_receipts, readingEditorReceipt: data.reading_editor_receipt,
      resources: second.resources, callsUsed: data.calls_used, readingFirstBinding: second.binding, rendering: second.renderOptions });
    originalSource = preparedExternal.sourceInputs.readingFirst.source;
  }
  if (!humanEdit) await applyBilingualPublication(applyReadingFirstFixture(first));
  const target = join(first.vaultRoot, first.candidate.supportNotes[0].path);
  if (humanEdit) {
    const text = await readFile(target, 'utf8');
    await writeFile(target, text.replace('<!-- AUTO:END shared-knowledge -->', 'ManualInsideNeedle\n<!-- AUTO:END shared-knowledge -->') + '\nManualOutsideNeedle\n');
    const aPresentation = structuredClone(first.presentationCatalog);
    aPresentation.knowledge[0].paragraphs.en.push('Independent A knowledge needle.');
    aPresentation.knowledge[0].paragraphs['zh-CN'].push('独立 A 知识内容。');
    const a = await readingFirstPublicationFixture(t, { vaultRoot: first.vaultRoot, currentRegistryRoot: first.vaultRoot,
      generation: 'manual-then-a', runId: 'run_' + 'c'.repeat(32), paperId: 'pap_' + 'c'.repeat(32),
      title: { en: 'Independent A paper', 'zh-CN': '独立 A 论文' }, presentation: aPresentation });
    await applyBilingualPublication(applyReadingFirstFixture(a));
  }
  const rebased = await deriveRebasedReadingFirstPublicationSource({ source: originalSource, vaultRoot: first.vaultRoot });
  assert.equal(rebased.status, 'rebased');
  const prepared = await prepareReadingFirstPublication({ source: rebased.source, vaultRoot: first.vaultRoot,
    generation: 'independent-second', evidenceMode: 'synthetic', resources: second.resources });
  const authority = await readingFirstPublicationAuthority({ ...second, vaultRoot: first.vaultRoot }, prepared.plan);
  const registration = await registerBilingualPublication({ vaultRoot: first.vaultRoot, run: second.runId,
    plan: prepared.plan, sourceInputs: prepared.sourceInputs, ...authority });
  const bundle = JSON.parse(await readFile(join(first.vaultRoot, registration.bundle_path), 'utf8'));
  assert.ok(bundle.reading_first_source?.knowledge_rebase);
  assert.equal(bundle.reading_first_recipe, undefined);
  assert.equal(bundle.plan.inventory.some(row => row.kind === 'history'), false);
  const url = new URL('../../scripts/v3/phase22-publication.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {loadBilingualPublication,applyBilingualPublication} from ${JSON.stringify(url)};
    const loaded=await loadBilingualPublication({vaultRoot:process.argv[1],run:process.argv[2],trustAnchor:JSON.parse(process.argv[3]),requireApproval:true});
    const result=await applyBilingualPublication({vaultRoot:process.argv[1],run:process.argv[2],plan:loaded.plan,control:loaded.control,approvalRecord:process.argv[4],maintenanceWindowRecord:process.argv[5],expectedReviewSha256:loaded.plan.hashes.review_hash,expectedOutputSha256:loaded.plan.hashes.output_inventory_hash});
    console.log(JSON.stringify({status:result.status}));`,
    first.vaultRoot, second.runId, JSON.stringify(registration.trust_anchor), authority.approvalRecord, authority.maintenanceWindowRecord],
  { encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).status, 'committed');
  for (const row of prepared.plan.inventory) assert.deepEqual(await readFile(join(first.vaultRoot, row.path)), row.bytes);
  for (const note of second.candidate.notes) assert.equal(await readFile(join(first.vaultRoot, note.path), 'utf8'), note.content);
  const shared = await readFile(target, 'utf8');
  assert.match(shared, /Independent B knowledge needle/);
  if (humanEdit) { assert.match(shared, /ManualInsideNeedle/); assert.match(shared, /ManualOutsideNeedle/); assert.match(shared, /Independent A knowledge needle/); }
  assert.equal((await checkCommittedIndex(first.vaultRoot)).paper_count, humanEdit ? 3 : 2);
  const query = await queryLibrary({ vaultRoot: first.vaultRoot, query: 'supported' });
  assert.equal(query.ok, true, JSON.stringify(query));
  assert.deepEqual(new Set(query.results.map(row => row.paper_id)), new Set([first.paperId, second.paperId, ...(humanEdit ? ['pap_' + 'c'.repeat(32)] : [])]));
  const snapshot = await readRegisteredCommit({ vaultRoot: first.vaultRoot });
  assert.equal(snapshot.ok, true, JSON.stringify(snapshot.errors));
  const graph = buildRegisteredGraphProposal({ activeSnapshot: snapshot, entityInventory: snapshot.generation.objects.filter(row => row.path.endsWith('.md')).map(row => ({ path: row.path })) });
  assert.equal(graph.logicalPaperCount, humanEdit ? 3 : 2);
});
