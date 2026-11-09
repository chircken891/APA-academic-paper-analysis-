import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const api = 'https://api.github.com/repos/kotaindah55/better-embedded-canvas/releases';
const pluginId = 'better-embedded-canvas';
const files = {
  'manifest.json': JSON.stringify({ id: pluginId, version: '1.2.1' }),
  'main.js': 'module.exports = class {};\n',
  'styles.css': '.test { color: red; }\n',
};

async function fixture(t, { invalidDigest, failedAsset } = {}) {
  const repoRoot = await mkdtemp(join(tmpdir(), 'apa-canvas-plugin-'));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  const config = join(repoRoot, '.obsidian');
  const plugin = join(config, 'plugins', pluginId);
  const community = join(config, 'community-plugins.json');
  const graph = join(config, 'graph.json');
  const other = join(config, 'plugins', 'other', 'data.json');
  await mkdir(join(other, '..'), { recursive: true });
  await writeFile(community, '["other"]\r\n');
  await writeFile(graph, '{"search":"keep"}\r\n');
  await writeFile(other, '{"option":true}\n');
  const calls = [];
  const entries = Object.entries(files);
  const release = {
    tag_name: 'v1.2.1',
    assets: entries.map(([name, body], i) => ({
      name, id: i + 11,
      digest: 'sha256:' + createHash('sha256').update(name === invalidDigest ? 'different' : body).digest('hex'),
    })),
  };
  const fetchImpl = async (url, { headers }) => {
    calls.push([url, headers.Accept]);
    if (url === `${api}/latest`) return Response.json(release);
    const asset = release.assets.find(item => `${api}/assets/${item.id}` === url);
    assert.ok(asset, `unexpected API URL ${url}`);
    return asset.name === failedAsset ? new Response('', { status: 504 }) : new Response(files[asset.name]);
  };
  const assertOtherSettings = async () => {
    assert.equal(await readFile(graph, 'utf8'), '{"search":"keep"}\r\n');
    assert.equal(await readFile(other, 'utf8'), '{"option":true}\n');
  };
  return { repoRoot, plugin, community, fetchImpl, calls, assertOtherSettings };
}

test('downloads digest-bound API assets and enables the plugin in the selected temporary vault', async t => {
  const { installBetterEmbeddedCanvas } = await import('../../scripts/setup/install-better-embedded-canvas.mjs');
  const h = await fixture(t);
  const result = await installBetterEmbeddedCanvas(h);
  assert.equal(result.status, 'installed');
  assert.equal(h.calls[0][0], `${api}/latest`);
  assert.deepEqual(h.calls.slice(1).map(([url, accept]) => [url, accept]).sort(),
    [11, 12, 13].map(id => [`${api}/assets/${id}`, 'application/octet-stream']));
  for (const [file, body] of Object.entries(files)) assert.equal(await readFile(join(h.plugin, file), 'utf8'), body);
  assert.deepEqual(JSON.parse(await readFile(h.community, 'utf8')), ['other', pluginId]);
  await h.assertOtherSettings();
});

test('an invalid digest or a failed API asset leaves the plugin and enablement untouched', async t => {
  const { installBetterEmbeddedCanvas } = await import('../../scripts/setup/install-better-embedded-canvas.mjs');
  for (const [options, error] of [[{ invalidDigest: 'styles.css' }, /SHA-256.*styles\.css/i], [{ failedAsset: 'main.js' }, /API.*main\.js.*504/i]]) {
    const h = await fixture(t, options);
    await assert.rejects(installBetterEmbeddedCanvas(h), error);
    await assert.rejects(readFile(join(h.plugin, 'main.js')), { code: 'ENOENT' });
    assert.equal(await readFile(h.community, 'utf8'), '["other"]\r\n');
    await h.assertOtherSettings();
  }
});

test('same version reuses installed bytes and enables a disabled plugin without downloading assets', async t => {
  const { inspectBetterEmbeddedCanvas, installBetterEmbeddedCanvas } = await import('../../scripts/setup/install-better-embedded-canvas.mjs');
  const h = await fixture(t);
  assert.equal((await inspectBetterEmbeddedCanvas(h)).status, 'missing');
  await mkdir(h.plugin);
  for (const [file, body] of Object.entries(files)) await writeFile(join(h.plugin, file), file === 'styles.css' ? 'local CSS' : body);
  assert.equal((await inspectBetterEmbeddedCanvas(h)).status, 'installed-not-enabled');
  assert.equal((await installBetterEmbeddedCanvas(h)).status, 'already-installed');
  assert.equal((await inspectBetterEmbeddedCanvas(h)).status, 'installed-and-enabled');
  assert.deepEqual(h.calls.map(call => call[0]), [`${api}/latest`]);
  assert.deepEqual(JSON.parse(await readFile(h.community, 'utf8')), ['other', pluginId]);
  assert.equal(await readFile(join(h.plugin, 'styles.css'), 'utf8'), 'local CSS');
  await h.assertOtherSettings();
});

test('deselecting the plugin requires no release request or filesystem writes', async t => {
  const { installBetterEmbeddedCanvas } = await import('../../scripts/setup/install-better-embedded-canvas.mjs');
  const h = await fixture(t);
  assert.equal((await installBetterEmbeddedCanvas({ ...h, selected: false })).status, 'skipped');
  assert.deepEqual(h.calls, []);
  await assert.rejects(readFile(join(h.plugin, 'main.js')), { code: 'ENOENT' });
  assert.equal(await readFile(h.community, 'utf8'), '["other"]\r\n');
  await h.assertOtherSettings();
});
