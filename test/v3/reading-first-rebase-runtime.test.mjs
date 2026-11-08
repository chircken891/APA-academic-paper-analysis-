import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveRebasedReadingFirstPublicationSource } from '../../scripts/v3/reading-first-runtime.mjs';
test('rebase rejects unregistered source tokens', async () => {
  await assert.rejects(deriveRebasedReadingFirstPublicationSource({source:{},vaultRoot:'.'}), /READING_FIRST_PUBLICATION_SOURCE_REQUIRED/);
});

import { reviewedReadingFirstFixture } from './helpers/reading-first-publication-source-fixtures.mjs';
import { captureReadingFirstPublicationSource, inspectReadingFirstKnowledgeMergeCandidates, inspectReadingFirstPublicationSource, previewReadingFirstPublicationRebase, restoreReadingFirstPublicationSource } from '../../scripts/v3/reading-first-runtime.mjs';
import { readCommittedReadingFirstKnowledgeRegistry } from '../../scripts/v3/reading-first-knowledge-registry.mjs';
import { prepareReadingFirstPublication } from '../../scripts/v3/reading-first-publication.mjs';
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
  assert.deepEqual(await deriveRebasedReadingFirstPublicationSource({source,vaultRoot}),{status:'not_needed',base_generation_id:null});
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

test('derive verifies link-only changes when another run creates the same identity at a different path', async t => {
  const f=await reviewedReadingFirstFixture(t);
  const source=await captureReadingFirstPublicationSource({controller:f.controller,presentation:f.candidate});
  const presentation=structuredClone(f.presentationCatalog);
  presentation.knowledge[0].title['zh-CN']='不同路径的合成方法';
  const first=await readingFirstPublicationFixture(t,{presentation,runId:'run_'+'a'.repeat(32),paperId:'pap_'+'a'.repeat(32)});
  await applyBilingualPublication(applyReadingFirstFixture(first));
  const original=await inspectReadingFirstPublicationSource(source);
  const derived=await deriveRebasedReadingFirstPublicationSource({source,vaultRoot:first.vaultRoot});
  assert.equal(derived.status,'rebased');
  const data=await inspectReadingFirstPublicationSource(derived.source);
  const mapping=derived.record.identity_mappings[0];
  assert.equal(mapping.from_path,original.candidate.supportNotes[0].path);
  assert.equal(mapping.to_path,data.candidate.supportNotes[0].path);
  assert.equal(derived.record.papers.length,2);
  const encode=path=>encodeURIComponent(path.split('/').at(-1));
  for (const before of original.candidate.notes) {
    const after=data.candidate.notes.find(note=>note.path===before.path);
    assert.equal(after.content,before.content.replaceAll(encode(mapping.from_path),encode(mapping.to_path)));
  }
  assert.equal(data.calls_used,original.calls_used);
  assert.deepEqual((await inspectReadingFirstPublicationSource(await restoreReadingFirstPublicationSource(data.recipe))).candidate,data.candidate);
});

test('an alias alone changes the projected identity with the registered base bytes unchanged', async t => {
  const first=await readingFirstPublicationFixture(t);
  await applyBilingualPublication(applyReadingFirstFixture(first));
  const presentation=structuredClone(first.presentationCatalog);
  const item=presentation.knowledge[0];
  item.canonical_key='other-method-key';
  item.title={en:'Independent name','zh-CN':'另一个名称'};
  item.aliases=[];
  const next=await reviewedReadingFirstFixture(t,{presentation,currentRegistryRoot:first.vaultRoot,runId:'run_'+'f'.repeat(32),paperId:'pap_'+'f'.repeat(32)});
  const source=await captureReadingFirstPublicationSource({controller:next.controller,presentation:next.candidate});
  const registry=await readCommittedReadingFirstKnowledgeRegistry({vaultRoot:first.vaultRoot});
  const args={source,vaultRoot:first.vaultRoot,generationId:'projected-alias'};
  const proposals=await inspectReadingFirstKnowledgeMergeCandidates(args);
  assert.ok(proposals.some(row=>row.registered_path===registry[0].path && row.registered_sha256===registry[0].content_sha256
    && row.candidate_path===next.candidate.supportNotes[0].path && row.candidate_sha256 && row.reasons.includes('definition-bm25')));
  assert.deepEqual(await previewReadingFirstPublicationRebase({...args,registry}),{status:'not_needed'});
  const draft=await previewReadingFirstPublicationRebase({...args,registry:registry.map(row=>({...row,registered_aliases:[item.canonical_key]}))});
  assert.equal(draft.status,'rebased');
  assert.equal(draft.source,undefined);
  assert.deepEqual(draft.record.identity_mappings,[{id:item.id,from_path:next.candidate.supportNotes[0].path,to_path:registry[0].path}]);
  assert.equal(draft.record.nodes[0].base_sha256,registry[0].content_sha256);
  const result=await deriveRebasedReadingFirstPublicationSource(args);
  assert.equal(result.status,'not_needed');
  assert.ok(result.base_generation_id);
});

test('a previously reused identity becoming ambiguous prepares a new target for exact reapproval', async t => {
  const first=await readingFirstPublicationFixture(t);
  await applyBilingualPublication(applyReadingFirstFixture(first));
  const next=await reviewedReadingFirstFixture(t,{currentRegistryRoot:first.vaultRoot,runId:'run_'+'1'.repeat(32),paperId:'pap_'+'1'.repeat(32)});
  const source=await captureReadingFirstPublicationSource({controller:next.controller,presentation:next.candidate});
  const registry=await readCommittedReadingFirstKnowledgeRegistry({vaultRoot:first.vaultRoot});
  const presentation=structuredClone(first.presentationCatalog);
  presentation.knowledge[0].title['zh-CN']='另一登记候选';
  const alternative=await readingFirstPublicationFixture(t,{presentation,vaultRoot:first.vaultRoot,generation:'ambiguity-generation',runId:'run_'+'2'.repeat(32),paperId:'pap_'+'2'.repeat(32)});
  await applyBilingualPublication(applyReadingFirstFixture(alternative));
  const derived=await deriveRebasedReadingFirstPublicationSource({source,vaultRoot:first.vaultRoot});
  assert.equal(derived.status,'rebased');
  assert.equal(derived.record.review_required,true);
  const [ambiguity]=derived.record.identity_ambiguities;
  assert.equal(ambiguity.from_path,registry[0].path);
  assert.notEqual(ambiguity.to_path,ambiguity.from_path);
  assert.deepEqual(new Set(ambiguity.draft_pairs.map(row=>row.registered_path)),new Set([registry[0].path,alternative.candidate.supportNotes[0].path]));
  assert.ok(ambiguity.draft_pairs.every(row=>row.candidate_definition.length && row.registered_definition.length && row.candidate_sha256 && row.registered_sha256));
  const prepared=await prepareReadingFirstPublication({source:derived.source,vaultRoot:first.vaultRoot,evidenceMode:'synthetic',resources:next.resources});
  assert.ok(prepared.plan.inventory.some(row=>row.path===ambiguity.to_path && row.kind==='support' && row.before_sha256===null));
  assert.ok(!prepared.plan.inventory.some(row=>ambiguity.ambiguous_paths.includes(row.path)));
  assert.equal(derived.record.papers.length,2);
  const target=join(first.vaultRoot,ambiguity.to_path);
  await assert.rejects(readFile(target), {code:'ENOENT'});
  await writeFile(target,'Unregistered personal content\n');
  await assert.rejects(deriveRebasedReadingFirstPublicationSource({source,vaultRoot:first.vaultRoot}), {code:'RF_REBASE_AMBIGUOUS_NEW_TARGET_OCCUPIED'});
  assert.equal(await readFile(target,'utf8'),'Unregistered personal content\n');
});
