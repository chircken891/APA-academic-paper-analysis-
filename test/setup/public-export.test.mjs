import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
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
  for (const path of ['../secret', '.git/config', 'config/apa.local.json', 'config/backups/example-owner/adapters/example-patch/entry.mjs', 'config/backups/claude/claude.json', 'Raw/paper.pdf']) {
    await assert.rejects(exportPublicApa({ ...f, allowlist: { ...f.allowlist, files: [path] } }), /UNSAFE_PATH|PRIVATE_PATH/);
  }
});

test('public export refuses private backup directory as a directory or template target', async t => {
  const f = await fixture(t);
  for (const allowlist of [
    { ...f.allowlist, directories: [...f.allowlist.directories, 'config/backups'] },
    { ...f.allowlist, templates: [{ path: 'config/backups/claude/snapshot.json', source: 'entry.mjs' }] },
  ]) await assert.rejects(exportPublicApa({ ...f, allowlist }), /PRIVATE_PATH/);
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

test('current public export includes query and topic entries with their regression suites without personal answers', async t => {
  const root = await mkdtemp(join(tmpdir(), 'apa-public-query-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
  const outputRoot = join(root, 'public');
  await exportPublicApa({ sourceRoot, outputRoot });
  const manifest = JSON.parse(await readFile(join(outputRoot, 'apa-public-manifest.json'), 'utf8'));
  const paths = new Set(manifest.files.map(row => row.path));
  for (const path of ['.gitattributes', 'Templates/apa-public/.gitattributes', '.agents/skills/apa-query/SKILL.md', '.agents/skills/apa-query/agents/openai.yaml',
    '.agents/skills/apa-query/references/query.md', '.agents/skills/apa-query/references/topics.md',
    '.agents/skills/apa-query/references/contracts-and-tools.md', '.agents/skills/apa-query/references/writing.md',
    '.agents/skills/apa-query/references/configuration.md',
    'scripts/apa-query.mjs', 'scripts/v3/library-query.mjs',
    'prompts/v3/role-reply-1.0.md', 'prompts/v3/science-index-1.0.md', 'prompts/v3/translation-1.0.md', 'scripts/v3/role-reply-contract.mjs',
    'scripts/v3/science-controller.mjs', 'test/v3/science-controller.test.mjs',
    'scripts/lib/apa-host-capabilities.mjs', 'scripts/lib/apa-host-achievement.mjs', 'test/setup/apa-host-capabilities.test.mjs',
    'test/v3/library-query.test.mjs', 'test/v3/library-query-cli.test.mjs',
    'test/v3/library-query-request.test.mjs', 'test/v3/library-query-request-cli.test.mjs',
    'scripts/v3/topic-library.mjs', 'scripts/v3/topic-publication.mjs', 'Schema/phase24/topic.schema.json',
    'test/v3/helpers/topic-fixtures.mjs', 'test/v3/topic-saving.test.mjs', 'test/v3/topic-publication.test.mjs',
    'test/v3/topic-update.test.mjs', 'test/v3/topic-cancellation.test.mjs']) {
    assert.ok(paths.has(path), 'Export is missing query dependency: ' + path);
  }
  const pkg = JSON.parse(await readFile(join(outputRoot, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.test, /test\/v3\/library-query\.test\.mjs/);
  assert.match(pkg.scripts.test, /test\/v3\/library-query-cli\.test\.mjs/);
  assert.match(pkg.scripts.test, /test\/v3\/library-query-request\.test\.mjs/);
  assert.match(pkg.scripts.test, /test\/v3\/library-query-request-cli\.test\.mjs/);
  assert.match(pkg.scripts.test, /test\/v3\/topic-saving\.test\.mjs/);
  assert.match(pkg.scripts.test, /test\/v3\/topic-publication\.test\.mjs/);
  assert.match(pkg.scripts.test, /test\/v3\/topic-update\.test\.mjs/);
  assert.match(pkg.scripts.test, /test\/v3\/topic-cancellation\.test\.mjs/);
  assert.match(pkg.scripts.test, /test\/v3\/science-controller\.test\.mjs/);
  assert.match(pkg.scripts.test, /test\/setup\/apa-host-capabilities\.test\.mjs/);
  assert.equal(paths.has('config/apa.local.json'), false);
  assert.equal([...paths].some(path => path.startsWith('config/backups/')), false);
  assert.equal([...paths].some(path => /^(?:Eval\/|\.planning\/|\.apa-v3\/)/.test(path)), false);
  for (const path of [...paths].filter(path => path.startsWith('Wiki/'))) {
    assert.match(path, /\/\.gitkeep$/);
    assert.equal((await readFile(join(outputRoot, path))).length, 0, 'Only empty directory placeholders may be exported from Wiki');
  }
  assert.equal((await checkPublicApa({ root: outputRoot })).ok, true);
});

test('public Git checkout preserves manifest-bound LF and CRLF bytes with autocrlf enabled', async t => {
  const f = await fixture(t, { 'README.md': 'Synthetic public guide.\n', 'config/environment.json': '{"version":1}\r\n' });
  const template = await readFile(new URL('../../Templates/apa-public/.gitattributes', import.meta.url));
  await writeFile(join(f.sourceRoot, 'attributes.template'), template);
  f.allowlist.templates.push({ source: 'attributes.template', path: '.gitattributes' });
  await exportPublicApa(f);
  const git = (...args) => execFileSync('git', ['-c', 'core.autocrlf=true', '-c', 'core.safecrlf=false', ...args], { cwd: f.outputRoot, stdio: 'pipe' });
  git('init', '--quiet');
  git('add', '--all');
  const checkoutRoot = join(f.root, 'checkout');
  await mkdir(checkoutRoot);
  git('checkout-index', '--all', '--prefix=' + checkoutRoot.replaceAll('\\', '/') + '/');
  for (const name of ['README.md', 'config/environment.json', 'apa-public-manifest.json']) {
    assert.deepEqual(await readFile(join(checkoutRoot, name)), await readFile(join(f.outputRoot, name)), name);
  }
  assert.equal((await checkPublicApa({ root: checkoutRoot })).ok, true);
});
