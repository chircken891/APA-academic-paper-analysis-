import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { reviewedReadingFirstFixture } from './helpers/reading-first-publication-source-fixtures.mjs';
import { captureReadingFirstPublicationSource } from '../../scripts/v3/reading-first-runtime.mjs';
import { prepareReadingFirstPublication } from '../../scripts/v3/reading-first-publication.mjs';

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
