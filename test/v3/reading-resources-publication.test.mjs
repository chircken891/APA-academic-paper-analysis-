import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { reviewedReadingFirstFixture } from './helpers/reading-first-publication-source-fixtures.mjs';
import { captureReadingFirstPublicationSource, verifyReadingFirstResourceManifest } from '../../scripts/v3/reading-first-runtime.mjs';
import { prepareReadingFirstPublication } from '../../scripts/v3/reading-first-publication.mjs';
import { loadBilingualPublication, registerBilingualPublication } from '../../scripts/v3/phase22-publication.mjs';

test('captured 2.2 DOCX resource enters publication review and drift blocks it', async t => {
  const f = await reviewedReadingFirstFixture(t, { manifestDocx: true });
  const note = f.candidate.notes.find(item => item.language === 'zh-CN') ?? f.candidate.notes[1];
  assert.match(note.content, /补充文件图S4/);
  assert.doesNotMatch(note.content, /supplement\.docx#page=/);
  const vaultRoot = join(f.root, 'publication-vault'); await mkdir(vaultRoot);
  const source = await captureReadingFirstPublicationSource({ controller: f.controller, presentation: f.candidate });
  const prepared = await prepareReadingFirstPublication({ source, vaultRoot, generation: 'resources-docx', evidenceMode: 'synthetic', resources: f.resources });
  assert.ok(prepared.plan.inventory.some(row => row.path === f.presentationCatalog.visuals[0].path));
  const presentation = JSON.parse(prepared.plan.inventory.find(row => row.path.startsWith('.apa-v3/reading-first/presentation/')).bytes);
  const citation = presentation.citation.sources.find(row => row.source_id === 'supplement');
  assert.equal(citation.path, 'Raw/supplement.docx');
  assert.deepEqual(citation.locators[0].locator, { kind: 'docx-figure', figure: 'S4', paragraph: 1 });
  await writeFile(f.figure.path, 'drift');
  await assert.rejects(() => prepareReadingFirstPublication({ source, vaultRoot, generation: 'resources-docx', evidenceMode: 'synthetic', resources: f.resources }));
});

test('captured DOCX source drift blocks publication preparation', async t => {
  const f = await reviewedReadingFirstFixture(t, { manifestDocx: true });
  const vaultRoot = join(f.root, 'publication-vault'); await mkdir(vaultRoot);
  const source = await captureReadingFirstPublicationSource({ controller: f.controller, presentation: f.candidate });
  await writeFile(f.resources.find(row => row.path === 'Raw/supplement.docx').source_path, 'drift');
  await assert.rejects(() => prepareReadingFirstPublication({ source, vaultRoot, generation: 'resources-docx', evidenceMode: 'synthetic', resources: f.resources }));
});

test('publication registers the original owned figure manifest for adopted science', async t => {
  const original = await reviewedReadingFirstFixture(t, { manifestDocx: true });
  const continuation = await reviewedReadingFirstFixture(t, { adoptedFrom: original, runId: 'run_' + 'b'.repeat(32) });
  const vaultRoot = join(continuation.root, 'publication-vault');
  await mkdir(vaultRoot);
  const source = await captureReadingFirstPublicationSource({ controller: continuation.controller, presentation: continuation.candidate });
  const options = { source, vaultRoot, generation: 'adopted-resources', evidenceMode: 'synthetic', resources: original.resources };
  const prepared = await prepareReadingFirstPublication(options);
  assert.equal(prepared.business_writes, 0);
  assert.equal(prepared.plan.inventory.find(row => row.path === original.presentationCatalog.visuals[0].path).byte_sha256, original.figure.sha256);
  const run = continuation.runId;
  const registration = await registerBilingualPublication({ vaultRoot, run, plan: prepared.plan, sourceInputs: prepared.sourceInputs });
  const loaded = await loadBilingualPublication({ vaultRoot, run, trustAnchor: registration.trust_anchor });
  assert.deepEqual(loaded.plan.hashes, prepared.plan.hashes);

  await writeFile(join(original.root, 'science/results-resources.json'), 'changed manifest');
  await assert.rejects(() => prepareReadingFirstPublication(options));
  await assert.rejects(() => loadBilingualPublication({ vaultRoot, run, trustAnchor: registration.trust_anchor }));
});

test('adoption detects original image drift before creating the new Writer request',async t=>{
  const original=await reviewedReadingFirstFixture(t,{manifestDocx:true});
  await writeFile(original.figure.path,'modified image bytes');
  await assert.rejects(()=>reviewedReadingFirstFixture(t,{adoptedFrom:original,runId:'run_'+ 'b'.repeat(32)}));
});

test('the shared resource verifier binds root and receipt run identity to the adopted Integrator',async t=>{
  const original=await reviewedReadingFirstFixture(t,{manifestDocx:true});
  const options={binding:original.binding,artifactRoot:original.root,handoff:structuredClone(original.handoff)};
  const integrator=options.handoff.science.find(row=>row.receipt.role==='integration');
  integrator.artifact_root=original.root;
  assert.ok(await verifyReadingFirstResourceManifest(options));
  const manifest=integrator.content.visual_handoff.resource_manifest;
  const root=manifest.resources_root;
  manifest.resources_root=join(root,'wrong');
  await assert.rejects(()=>verifyReadingFirstResourceManifest(options),/RESOURCE_MANIFEST_INVALID/);
  manifest.resources_root=root;
  integrator.receipt.run_id='different-run';
  await assert.rejects(()=>verifyReadingFirstResourceManifest(options),/RESOURCE_MANIFEST_INVALID/);
});
