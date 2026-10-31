import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
test('resource registry validates source and image fingerprints and unique targets', async () => {
  const module = await import('../../scripts/v3/reading-resources.mjs').catch(() => ({}));
  assert.equal(typeof module.validateReadingResources, 'function');
  const root = mkdtempSync(join(tmpdir(), 'apa-resources-'));
  const output = join(root, 'output'); mkdirSync(output);
  const parent = join(root, 'source.docx'), image = join(output, 'figure.png');
  writeFileSync(parent, 'source'); writeFileSync(image, 'image');
  const source = { id: 'supplement', path: parent, sha256: hash('source'), byte_length: 6 };
  const row = { id: 'fig-s4', source_id: source.id, locator: { kind: 'docx-figure', figure: 'S4', paragraph: 4 }, source_path: image, path: 'Figures/paper/fig-s4.png', sha256: hash('image'), byte_length: 5, parent: { path: parent, sha256: source.sha256, byte_length: 6 } };
  const args = { manifest: { version: 'reading-resources-1.0', resources: [row] }, resourcesRoot: output, sources: [source] };
  assert.equal(module.validateReadingResources(args).length, 1);
  assert.throws(() => module.validateReadingResources({ ...args, manifest: { ...args.manifest, resources: [row, { ...row, id: 'fig-s5' }] } }));
  assert.throws(() => module.validateReadingResources({ ...args, manifest: { ...args.manifest, resources: [{ ...row, source_path: parent }] } }));
  assert.throws(() => module.validateReadingResources({ ...args, manifest: { ...args.manifest, resources: [{ ...row, locator:{kind:'pdf-page',page:1} }] } }));
  const external = join(root,'external.png'); writeFileSync(external,'image');
  const linked = join(output,'hardlink.png'); linkSync(external,linked);
  assert.throws(() => module.validateReadingResources({ ...args, manifest: { ...args.manifest, resources: [{ ...row, source_path:linked }] } }));
  const link = join(output, 'link');
  try {
    symlinkSync(root, link, 'junction');
    assert.throws(() => module.validateReadingResources({ ...args, manifest: { ...args.manifest, resources: [{ ...row, source_path: join(link, 'source.docx'), sha256: source.sha256, byte_length: 6 }] } }));
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
  }
  writeFileSync(parent, 'drift');
  assert.throws(() => module.validateReadingResources(args));
});

test('resource tool crops arbitrary PDF pages and rejects out-of-bounds crop', () => {
  const root = mkdtempSync(join(tmpdir(), 'apa-pdf-'));
  const source = join(root, 'source.pdf'), output = join(root, 'out'); mkdirSync(output);
  const create = spawnSync('python', ['-c', 'import fitz,sys; d=fitz.open(); d.new_page(width=100,height=100); d.new_page(width=100,height=100); d.save(sys.argv[1])', source], { encoding: 'utf8' });
  assert.equal(create.status, 0, create.stderr);
  const request = { source_id: 'paper', source_path: source, resources_root: output, items: [{ id: 'fig-2', locator: { kind: 'pdf-page', page: 2 }, rect: [0, 0, 50, 50], filename: 'fig-2.png', path: 'Figures/paper/fig-2.png' }] };
  const run = () => spawnSync('python', ['scripts/lib/reading-resource-tool.py'], { input: JSON.stringify(request), encoding: 'utf8' });
  const result = run(); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).resources[0].locator.page, 2);
  request.items[0].filename = 'bad.png'; request.items[0].rect = [0, 0, 101, 50];
  assert.notEqual(run().status, 0);
});

test('resource tool extracts requested DOCX media into a recorded output', () => {
  const root = mkdtempSync(join(tmpdir(), 'apa-docx-'));
  const source = join(root, 'source.docx'), output = join(root, 'out'); mkdirSync(output);
  const create = spawnSync('python', ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"w"); z.writestr("word/media/image1.png",b"image"); z.writestr("word/media/image2.png",b"second"); z.close()', source]);
  assert.equal(create.status, 0);
  const request = { source_id: 'supplement', source_path: source, resources_root: output, items: [{ id: 'fig-s4', locator: { kind: 'docx-figure', figure: 'S4', paragraph: 4 }, media: 'word/media/image1.png', filename: 'fig-s4.png', path: 'Figures/paper/fig-s4.png' }] };
  request.items.push({ id: 'fig-s5', locator: { kind: 'docx-figure', figure: 'S5', paragraph: 5 }, media: 'word/media/image2.png', filename: 'fig-s5.png', path: 'Figures/paper/fig-s5.png' });
  const run = spawnSync('python', ['scripts/lib/reading-resource-tool.py'], { input: JSON.stringify(request), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const manifest = JSON.parse(run.stdout);
  assert.equal(manifest.resources.length, 2);
  assert.equal(manifest.resources[0].sha256, hash('image'));
});
