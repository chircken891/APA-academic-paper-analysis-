import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, lstat, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { reviewedReadingFirstFixture } from './helpers/reading-first-publication-source-fixtures.mjs';
import { readingFirstPublicationAuthority } from './helpers/reading-first-publication-fixtures.mjs';
import { captureReadingFirstPublicationSource, inspectReadingFirstPublicationSource, restoreReadingFirstPublicationSource } from '../../scripts/v3/reading-first-runtime.mjs';
import { prepareExternalReviewedReadingFirstPublication } from '../../scripts/v3/reading-first-publication.mjs';
import { fingerprintV3Json } from '../../scripts/v3/semantic-package-validator.mjs';
import { createReadingFirstRunControl } from '../../scripts/v3/reading-first-runtime.mjs';
import { buildConfiguredReadingInstructions } from '../../scripts/v3/configured-reading.mjs';
import { registerBilingualPublication, loadBilingualPublication, applyBilingualPublication } from '../../scripts/v3/phase22-publication.mjs';
import { readCommittedGeneration } from '../../scripts/v3/phase22-active-version.mjs';

async function externalFixture(t, modern = false) {
  const configured=modern === true ? buildConfiguredReadingInstructions({}, {instructionProfile:'configured-reading-2.0'}) : null;
  const f = await reviewedReadingFirstFixture(t, { omitPresentationAssets: true, visualProvenance: true,
    ...(modern ? {translationLanguage:null,controlOptions:{presentationProfile:'reading-editor-1.3'}} : {}),
    ...(configured ? {createRunControl:args=>createReadingFirstRunControl({...args,configuredSetup:{...configured,paths:{runRoot:dirname(args.scientificInput.sources[0].path)}}})} : {}) });
  const data = await inspectReadingFirstPublicationSource(await captureReadingFirstPublicationSource({ controller: f.controller, presentation: f.candidate }));
  const vaultRoot = join(f.root, 'external-vault'), candidateRoot = join(f.root, 'external-candidate');
  await mkdir(vaultRoot, { recursive: true });
  for (const note of [...data.candidate.notes, ...data.candidate.supportNotes]) {
    const path = join(candidateRoot, note.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, note.content);
  }
  const args = { vaultRoot, candidateRoot, runRoot: f.root, generation: 'external-generation', evidenceMode: 'synthetic',
    scientificInput: f.input, candidate: data.candidate, presentation: data.presentation, review: data.review,
    reviewReceipt: data.review_receipt, viewReceipts: data.view_receipts, readingEditorReceipt: data.reading_editor_receipt,
    resources: f.resources, callsUsed: data.calls_used };
  return { ...f, args, vaultRoot, candidateRoot };
}

test('modern external preparation retains its frozen prompt dependencies through restore', async t => {
  const f=await externalFixture(t,true);
  await assert.rejects(prepareExternalReviewedReadingFirstPublication(f.args),/RF_PUBLICATION_EXTERNAL_BINDING_REQUIRED/);
  const prepared=await prepareExternalReviewedReadingFirstPublication({...f.args,readingFirstBinding:f.binding});
  const recipe=prepared.external_source_recipe;
  assert.deepEqual(recipe.binding,f.binding);
  const paths=recipe.tool_bindings.map(row=>row.path);
  for (const prompt of f.binding.configured_setup.prompt_files) assert.ok(paths.includes(prompt.path));
  assert.ok(paths.some(path=>path.endsWith('reading-first-repair-scope.mjs')));
  assert.ok(!paths.some(path=>path.endsWith('reading-first-contracts.md') || path.endsWith('reading-editor-1.2.md')));
  const restored=await restoreReadingFirstPublicationSource(recipe);
  assert.equal((await inspectReadingFirstPublicationSource(restored)).native_presentation.status,'not_run');
  const missing=structuredClone(recipe); delete missing.binding; delete missing.recipe_fingerprint; missing.recipe_fingerprint=fingerprintV3Json(missing);
  await assert.rejects(restoreReadingFirstPublicationSource(missing),/READING_FIRST_EXTERNAL_PUBLICATION_RECIPE_INVALID/);
  const changed=structuredClone(f.binding);
  changed.configured_setup.prompt_files[0].sha256='sha256:'+'0'.repeat(64);
  await assert.rejects(prepareExternalReviewedReadingFirstPublication({...f.args,readingFirstBinding:changed}),/READING_FIRST_SOURCE_CHANGED|READING_FIRST_PROMPT_CHANGED/);
});

test('1.3 editor output rejects a mismatched external binding', async t => {
  const f=await externalFixture(t,true);
  const wrong=structuredClone(f.binding); wrong.presentation_profile='reading-editor-1.2';
  await assert.rejects(prepareExternalReviewedReadingFirstPublication({...f.args,readingFirstBinding:wrong}),/RF_PUBLICATION_EXTERNAL_BINDING_INVALID/);
});

test('1.3 with legacy instruction profile binds the 1.3 editor contract', async t => {
  const f=await externalFixture(t,'legacy13');
  const prepared=await prepareExternalReviewedReadingFirstPublication({...f.args,readingFirstBinding:f.binding});
  const paths=prepared.external_source_recipe.tool_bindings.map(row=>row.path);
  assert.ok(paths.some(path=>path.endsWith('reading-editor-1.3.md')));
  assert.ok(paths.some(path=>path.endsWith('reading-first-contracts.md')));
  assert.ok(!paths.some(path=>path.endsWith('reading-editor-1.2.md')));
  await restoreReadingFirstPublicationSource(prepared.external_source_recipe);
});

test('modern external restore rejects changed bound prompt bytes', async t => {
  const f=await externalFixture(t,true), binding=structuredClone(f.binding);
  const copyPath=join(f.root,'bound-prompt.md');
  await writeFile(copyPath,await readFile(binding.configured_setup.prompt_files[0].path));
  binding.configured_setup.prompt_files[0].path=copyPath;
  const prepared=await prepareExternalReviewedReadingFirstPublication({...f.args,readingFirstBinding:binding});
  await writeFile(copyPath,'changed prompt');
  await assert.rejects(restoreReadingFirstPublicationSource(prepared.external_source_recipe),/READING_FIRST_PUBLICATION_DEPENDENCY_CHANGED|READING_FIRST_SOURCE_CHANGED/);
});

test('external preparation rejects missing required parameters and receipts with a domain error', async t => {
  const f = await externalFixture(t);
  for (const field of ['candidateRoot', 'runRoot', 'scientificInput', 'candidate', 'presentation', 'review', 'reviewReceipt', 'viewReceipts', 'readingEditorReceipt']) {
    await assert.rejects(prepareExternalReviewedReadingFirstPublication({ ...f.args, [field]: undefined }), /RF_PUBLICATION_EXTERNAL_INPUT_INVALID/, field);
  }
  await assert.rejects(prepareExternalReviewedReadingFirstPublication({ ...f.args, viewReceipts: { en: f.args.viewReceipts.en } }), /RF_PUBLICATION_EXTERNAL_INPUT_INVALID/);
  await assert.rejects(prepareExternalReviewedReadingFirstPublication({ ...f.args, reviewReceipt: {} }), /RF_PUBLICATION_EXTERNAL_INPUT_INVALID/);
  await assert.rejects(prepareExternalReviewedReadingFirstPublication({ ...f.args, scientificInput: { identity: f.input.identity } }), /RF_PUBLICATION_EXTERNAL_INPUT_INVALID/);
});

test('external recipe missing a runtime tool binding rejects as tool drift', async t => {
  const f = await externalFixture(t);
  const prepared = await prepareExternalReviewedReadingFirstPublication(f.args);
  const recipe = structuredClone(prepared.external_source_recipe);
  recipe.tool_bindings = recipe.tool_bindings.filter(row => !row.path.endsWith('reading-first-runtime.mjs'));
  delete recipe.recipe_fingerprint;
  recipe.recipe_fingerprint = fingerprintV3Json(recipe);
  await assert.rejects(restoreReadingFirstPublicationSource(recipe), /READING_FIRST_PUBLICATION_TOOL_CHANGED/);
  const changed = structuredClone(prepared.external_source_recipe);
  changed.tool_bindings.find(row => row.path.endsWith('reading-first-runtime.mjs')).sha256 = 'sha256:' + '0'.repeat(64);
  delete changed.recipe_fingerprint;
  changed.recipe_fingerprint = fingerprintV3Json(changed);
  await assert.rejects(restoreReadingFirstPublicationSource(changed), /READING_FIRST_PUBLICATION_DEPENDENCY_CHANGED/);
});

test('external preparation registers, reloads and publishes only to a synthetic vault', async t => {
  const f = await externalFixture(t);
  const prepared = await prepareExternalReviewedReadingFirstPublication(f.args);
  const data = await inspectReadingFirstPublicationSource(prepared.sourceInputs.readingFirst.source);
  assert.equal(data.recipe.schema_version, 'external-reviewed-reading-first-publication-source-1.0');
  assert.equal(data.native_presentation.status, 'not_run');
  assert.equal(prepared.review.reviewManifest.evidence_mode, 'synthetic');
  await assert.rejects(applyBilingualPublication({ vaultRoot: f.vaultRoot, run: f.runId, plan: prepared.plan }), /P22_PUBLICATION_CONTROL_REQUIRED/);
  for (const note of f.args.candidate.notes) await assert.rejects(lstat(join(f.vaultRoot, note.path)), { code: 'ENOENT' });
  await assert.rejects(lstat(join(f.vaultRoot, '.apa-v3', 'phase22', 'COMMITTED.json')), { code: 'ENOENT' });
  const authority = await readingFirstPublicationAuthority(f, prepared.plan);
  const registration = await registerBilingualPublication({ vaultRoot: f.vaultRoot, run: f.runId,
    plan: prepared.plan, sourceInputs: prepared.sourceInputs, ...authority });
  const loaded = await loadBilingualPublication({ vaultRoot: f.vaultRoot, run: f.runId, trustAnchor: registration.trust_anchor });
  assert.deepEqual(loaded.plan.hashes, prepared.plan.hashes);
  const result = await applyBilingualPublication({ vaultRoot: f.vaultRoot, run: f.runId, plan: prepared.plan, ...authority });
  assert.equal(result.status, 'committed');
  assert.equal((await readCommittedGeneration({ vaultRoot: f.vaultRoot })).ok, true);
  for (const note of f.args.candidate.notes) assert.equal(await readFile(join(f.vaultRoot, note.path), 'utf8'), note.content);
});

test('external preparation and registration reject changed candidate bytes', async t => {
  const f = await externalFixture(t);
  const path = join(f.candidateRoot, f.args.candidate.notes[0].path);
  await writeFile(path, 'changed candidate');
  await assert.rejects(prepareExternalReviewedReadingFirstPublication(f.args), /RF_PUBLICATION_EXTERNAL_CANDIDATE_CHANGED/);
  await writeFile(path, f.args.candidate.notes[0].content);
  const prepared = await prepareExternalReviewedReadingFirstPublication(f.args);
  await writeFile(path, 'changed after review');
  await assert.rejects(registerBilingualPublication({ vaultRoot: f.vaultRoot, run: f.runId,
    plan: prepared.plan, sourceInputs: prepared.sourceInputs }), /READING_FIRST_PUBLICATION_DEPENDENCY_CHANGED|P22_REGISTERED_DEPENDENCY_CHANGED/);
  for (const note of f.args.candidate.notes) await assert.rejects(lstat(join(f.vaultRoot, note.path)), { code: 'ENOENT' });
});

test('external registration and reload reject changed receipt bytes', async t => {
  const f = await externalFixture(t);
  const prepared = await prepareExternalReviewedReadingFirstPublication(f.args);
  const authority = await readingFirstPublicationAuthority(f, prepared.plan);
  const registration = await registerBilingualPublication({ vaultRoot: f.vaultRoot, run: f.runId,
    plan: prepared.plan, sourceInputs: prepared.sourceInputs, ...authority });
  await writeFile(join(f.root, f.args.reviewReceipt.path), 'changed receipt artifact');
  await assert.rejects(loadBilingualPublication({ vaultRoot: f.vaultRoot, run: f.runId, trustAnchor: registration.trust_anchor }), /P22_REGISTERED_DEPENDENCY_CHANGED/);
  for (const note of f.args.candidate.notes) await assert.rejects(lstat(join(f.vaultRoot, note.path)), { code: 'ENOENT' });
});
