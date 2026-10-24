import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportPublicApa, checkPublicApa } from '../../scripts/setup/export-public-apa.mjs';

async function fixture(t, files = { 'entry.mjs': 'export const ready = true;\n' }) {
  const root = await mkdtemp(join(tmpdir(), 'apa-public-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'source');
  await mkdir(sourceRoot);
  for (const [path, value] of Object.entries(files)) {
    await mkdir(join(sourceRoot, path, '..'), { recursive: true });
    await writeFile(join(sourceRoot, path), value);
  }
  const allowlist = { version: 1, files: Object.keys(files), directories: ['Raw', 'Wiki', 'Figures'], templates: [], tests: [] };
  return { root, sourceRoot, outputRoot: join(root, 'public'), allowlist };
}

test('clean explicit export excludes private roots, personal config and Git; manifest is portable', async t => {
  const f = await fixture(t);
  for (const path of ['Raw/paper.pdf', 'Wiki/human.md', 'Figures/real.png', 'Eval/private.json', '.planning/private.md', '.git/config', 'config/apa.local.json']) {
    await mkdir(join(f.sourceRoot, path, '..'), { recursive: true });
    await writeFile(join(f.sourceRoot, path), 'PRIVATE');
  }
  const result = await exportPublicApa(f);
  assert.equal(result.ok, true);
  const manifest = JSON.parse(await readFile(join(f.outputRoot, 'apa-public-manifest.json')));
  assert.deepEqual(manifest.files.map(row => row.path), ['entry.mjs', 'Figures/.gitkeep', 'Raw/.gitkeep', 'Wiki/.gitkeep']);
  assert.ok(manifest.files.every(row => /^[a-f0-9]{64}$/.test(row.sha256)));
  assert.equal(JSON.stringify(manifest).includes(f.sourceRoot), false);
  assert.equal((await checkPublicApa({ root: f.outputRoot })).ok, true);
  await writeFile(join(f.outputRoot, 'entry.mjs'), 'changed');
  assert.equal((await checkPublicApa({ root: f.outputRoot })).ok, false);
});

test('declared empty directories receive hashed Git placeholders without replacing declared files', async t => {
  const f = await fixture(t, { 'entry.mjs': 'export {};', 'assets/.gitkeep': 'declared marker\n' });
  f.allowlist.directories.push('Clippings', 'Wiki/methods', 'assets');
  await exportPublicApa(f);
  const manifest = JSON.parse(await readFile(join(f.outputRoot, 'apa-public-manifest.json')));
  for (const path of ['Raw/.gitkeep', 'Wiki/methods/.gitkeep', 'Figures/.gitkeep', 'Clippings/.gitkeep']) {
    assert.equal(await readFile(join(f.outputRoot, path), 'utf8'), '');
    assert.match(manifest.files.find(row => row.path === path)?.sha256 ?? '', /^[a-f0-9]{64}$/);
  }
  assert.equal(await readFile(join(f.outputRoot, 'assets/.gitkeep'), 'utf8'), 'declared marker\n');
  assert.equal((await checkPublicApa({ root: f.outputRoot })).ok, true);
  await writeFile(join(f.outputRoot, 'Raw', 'private.pdf'), 'private');
  assert.equal((await checkPublicApa({ root: f.outputRoot })).ok, false);
});

test('existing output and missing declared source fail before export writes', async t => {
  const f = await fixture(t);
  await mkdir(f.outputRoot);
  await assert.rejects(exportPublicApa(f), /OUTPUT_EXISTS/);
  const other = { ...f, outputRoot: join(f.root, 'other'), allowlist: { ...f.allowlist, files: ['missing.mjs'] } };
  await assert.rejects(exportPublicApa(other), /SOURCE_MISSING/);
  await assert.rejects(readFile(join(other.outputRoot, 'apa-public-manifest.json')), /ENOENT/);
});

test('relative imports, schema refs and required local Markdown links must close', async t => {
  for (const [name, contents] of [
    ['entry.mjs', "import './missing.mjs';"],
    ['README.md', '[guide](docs/missing.md)'],
    ['Views/graph/entry.md', '![[Views/indexes/missing]]'],
    ['Schema/test.schema.json', '{"$id":"test","$ref":"missing#/value"}'],
  ]) {
    const f = await fixture(t, { [name]: contents });
    await assert.rejects(exportPublicApa(f), /DEPENDENCY_MISSING/);
  }
});

test('unsafe allowlist paths and private source selections are refused', async t => {
  const f = await fixture(t);
  for (const path of ['../secret', '.git/config', 'config/apa.local.json', 'Raw/paper.pdf']) {
    await assert.rejects(exportPublicApa({ ...f, allowlist: { ...f.allowlist, files: [path] } }), /UNSAFE_PATH|PRIVATE_PATH/);
  }
});

test('export package runs only the declared synthetic suites and leaves source package unchanged', async t => {
  const original = JSON.stringify({ name: 'synthetic-export', scripts: { test: 'node --test test/**/*.test.mjs', 'test:v3': 'node --test test/v3/*.test.mjs', apa: 'node entry.mjs' } });
  const f = await fixture(t, { 'package.json': original, 'entry.mjs': 'export {};', 'test/v3/synthetic.test.mjs': 'export {};' });
  f.allowlist.tests = ['test/v3/synthetic.test.mjs'];
  await exportPublicApa(f);
  const projected = JSON.parse(await readFile(join(f.outputRoot, 'package.json')));
  assert.equal(projected.scripts.test, 'node --test test/v3/synthetic.test.mjs');
  assert.equal(projected.scripts.apa, 'node entry.mjs');
  assert.equal(await readFile(join(f.sourceRoot, 'package.json'), 'utf8'), original);
});
