import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveRebasedReadingFirstPublicationSource } from '../../scripts/v3/reading-first-runtime.mjs';
test('rebase rejects unregistered source tokens', async () => {
  await assert.rejects(deriveRebasedReadingFirstPublicationSource({source:{},vaultRoot:'.'}), /READING_FIRST_PUBLICATION_SOURCE_REQUIRED/);
});

import { reviewedReadingFirstFixture } from './helpers/reading-first-publication-source-fixtures.mjs';
import { captureReadingFirstPublicationSource, inspectReadingFirstPublicationSource, restoreReadingFirstPublicationSource } from '../../scripts/v3/reading-first-runtime.mjs';
import { readingFirstPublicationFixture, applyReadingFirstFixture } from './helpers/reading-first-publication-fixtures.mjs';
import { applyBilingualPublication } from '../../scripts/v3/phase22-publication.mjs';
import { mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fingerprintV3Json } from '../../scripts/v3/semantic-package-validator.mjs';

test('unchanged source does not create a rebase or consume execution budget', async t => {
  const f=await reviewedReadingFirstFixture(t);
  const vaultRoot=join(f.root,'empty-vault');await mkdir(vaultRoot);
  const source=await captureReadingFirstPublicationSource({controller:f.controller,presentation:f.candidate});
  const before=await inspectReadingFirstPublicationSource(source);
  assert.deepEqual(await deriveRebasedReadingFirstPublicationSource({source,vaultRoot}),{status:'not_needed'});
  const after=await inspectReadingFirstPublicationSource(source);
  assert.equal(after.calls_used,before.calls_used);
  assert.deepEqual(after.recipe.checkpoint.state.executionLedger,before.recipe.checkpoint.state.executionLedger);
  await assert.rejects(readdir(join(f.root,'publication')), {code:'ENOENT'});
});

test('live source rebases onto human edits and restores with deterministic record verification', async t => {
  const first=await readingFirstPublicationFixture(t);
  await applyBilingualPublication(applyReadingFirstFixture(first));
  const f=await reviewedReadingFirstFixture(t,{currentRegistryRoot:first.vaultRoot,runId:'run_'+'d'.repeat(32),paperId:'pap_'+'d'.repeat(32)});
  const source=await captureReadingFirstPublicationSource({controller:f.controller,presentation:f.candidate});
  const original=await inspectReadingFirstPublicationSource(source);
  const otherRoot=join(f.root,'wrong-root');await mkdir(otherRoot);
  await assert.rejects(deriveRebasedReadingFirstPublicationSource({source,vaultRoot:otherRoot}),/RF_KNOWLEDGE_REGISTRY_ROOT_MISMATCH/);
  const concurrent=await readingFirstPublicationFixture(t,{vaultRoot:first.vaultRoot,currentRegistryRoot:first.vaultRoot,
    generation:'concurrent-generation',runId:'run_'+'c'.repeat(32),paperId:'pap_'+'c'.repeat(32)});
  await applyBilingualPublication(applyReadingFirstFixture(concurrent));
  const target=original.candidate.supportNotes[0].path;
  const file=join(first.vaultRoot,target);
  await writeFile(file,(await readFile(file,'utf8'))+'\nHumanRebaseNeedle\n');
  const derived=await deriveRebasedReadingFirstPublicationSource({source,vaultRoot:first.vaultRoot});
  assert.equal(derived.status,'rebased');
  const data=await inspectReadingFirstPublicationSource(derived.source);
  assert.deepEqual(data.candidate.notes,original.candidate.notes);
  assert.equal(data.calls_used,original.calls_used);
  assert.deepEqual(data.recipe.checkpoint.state.executionLedger,original.recipe.checkpoint.state.executionLedger);
  assert.ok(data.candidate.supportNotes.find(row=>row.path===target).content.includes('HumanRebaseNeedle'));
  assert.deepEqual((await inspectReadingFirstPublicationSource(await restoreReadingFirstPublicationSource(data.recipe))).candidate,data.candidate);
  await assert.rejects(deriveRebasedReadingFirstPublicationSource({source:derived.source,vaultRoot:first.vaultRoot}),/RF_REBASE_ORIGINAL_SOURCE_REQUIRED/);
  const invalidOriginal=structuredClone(data.recipe);
  invalidOriginal.candidate.notes[0].content+='tampered';
  delete invalidOriginal.recipe_fingerprint;invalidOriginal.recipe_fingerprint=fingerprintV3Json(invalidOriginal);
  await assert.rejects(restoreReadingFirstPublicationSource(invalidOriginal),/READING_FIRST_PUBLICATION_CANDIDATE_CHANGED/);
  for (const mutate of [
    record=>{record.nodes[0].base_sha256='sha256:'+'0'.repeat(64);},
    record=>{record.nodes[0].dropped_paragraphs.push({language:'en',section:null,paragraph:'fabricated'});},
    record=>{record.original_presentation_fingerprint='sha256:'+'0'.repeat(64);},
    record=>{record.reading_review_fingerprint='sha256:'+'0'.repeat(64);},
    record=>{record.candidate.notes[0].content+='tampered';},
    record=>{record.rendering.knowledgeRegistry[0].content+='tampered';},
  ]) {
    const recipe=structuredClone(data.recipe);mutate(recipe.knowledge_rebase);
    delete recipe.knowledge_rebase.rebase_fingerprint;recipe.knowledge_rebase.rebase_fingerprint=fingerprintV3Json(recipe.knowledge_rebase);
    delete recipe.recipe_fingerprint;recipe.recipe_fingerprint=fingerprintV3Json(recipe);
    await assert.rejects(restoreReadingFirstPublicationSource(recipe),/RF_REBASE_RECORD_INVALID/);
  }

});


test('derive rejects a disappeared registered reuse target with its domain diagnostic', async t => {
  const first=await readingFirstPublicationFixture(t);
  await applyBilingualPublication(applyReadingFirstFixture(first));
  const f=await reviewedReadingFirstFixture(t,{currentRegistryRoot:first.vaultRoot,runId:'run_'+'b'.repeat(32),paperId:'pap_'+'b'.repeat(32)});
  const source=await captureReadingFirstPublicationSource({controller:f.controller,presentation:f.candidate});
  const target=join(first.vaultRoot,f.candidate.supportNotes[0].path);
  await rm(target);
  await assert.rejects(deriveRebasedReadingFirstPublicationSource({source,vaultRoot:first.vaultRoot}),/RF_REBASE_KNOWLEDGE_TARGET_MISSING/);
});

test('derive rejects changed paper links when another run creates the same identity at a different path', async t => {
  const f=await reviewedReadingFirstFixture(t);
  const source=await captureReadingFirstPublicationSource({controller:f.controller,presentation:f.candidate});
  const presentation=structuredClone(f.presentationCatalog);
  presentation.knowledge[0].title['zh-CN']='不同路径的合成方法';
  const first=await readingFirstPublicationFixture(t,{presentation,runId:'run_'+'a'.repeat(32),paperId:'pap_'+'a'.repeat(32)});
  await applyBilingualPublication(applyReadingFirstFixture(first));
  await assert.rejects(deriveRebasedReadingFirstPublicationSource({source,vaultRoot:first.vaultRoot}),/RF_REBASE_PAPER_NOTE_CHANGED/);
});
