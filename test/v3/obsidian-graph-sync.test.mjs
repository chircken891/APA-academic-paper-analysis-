import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readingFirstIndexFixture } from './helpers/reading-first-index-fixtures.mjs';
import { syncCommittedGraph } from '../../scripts/v3/obsidian-graph-sync.mjs';
import { inspectV3Graph } from '../../scripts/v3/obsidian-graph.mjs';

const pluginId = 'apa-official-graph';
const cliPath = fileURLToPath(new URL('../../scripts/v3/obsidian-graph.mjs', import.meta.url));
const runGraphCli = promisify(execFile);
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const enablePluginScope = vaultRoot => syncCommittedGraph({ vaultRoot, enableAutoSync: true, scopeProvider: pluginId });

async function fixture(t) {
  const f = await readingFirstIndexFixture(t), built = await f.build();
  await f.save(built);
  const graph = join(f.vaultRoot, '.obsidian/graph.json');
  await mkdir(join(f.vaultRoot, '.obsidian'), { recursive: true });
  const original = Buffer.from(JSON.stringify({ search: 'old filter', hideUnresolved: false, showOrphans: false, colorGroups: [{ query: 'tag:test', color: 1 }], zoom: 2 }));
  await writeFile(graph, original);
  return { ...f, graph, original, state: join(f.vaultRoot, '.apa-v3/phase22/graph/MANAGED.json'),
    scope: join(f.vaultRoot, '.apa-v3/phase22/graph/SCOPE.json') };
}

test('automatic synchronization stays disabled without a managed state', async t => {
  const f = await fixture(t);
  assert.deepEqual(await syncCommittedGraph({ vaultRoot: f.vaultRoot }), { ok: true, status: 'disabled' });
  assert.deepEqual(await readFile(f.graph), f.original);
  await mkdir(join(f.vaultRoot, '.apa-v3/phase22/graph'), { recursive: true });
  await writeFile(f.state, JSON.stringify({ enabled: false }));
  assert.deepEqual(await syncCommittedGraph({ vaultRoot: f.vaultRoot }), { ok: true, status: 'disabled' });
  assert.deepEqual(await readFile(f.graph), f.original);
});

test('graph proposal and synchronization retain registered nodes after current note editing', async t => {
  const f = await fixture(t);
  const note = join(f.vaultRoot, f.paper.paths.en);
  const edited = Buffer.concat([await readFile(note), Buffer.from('\nUser graph edit.\n')]);
  await writeFile(note, edited);
  const result = await inspectV3Graph({ vaultRoot: f.vaultRoot, checkConfiguration: false });
  assert.ok(result.proposal.expectedNodes.includes(f.paper.paths['zh-CN']));
  assert.equal((await syncCommittedGraph({ vaultRoot: f.vaultRoot, enableAutoSync: true })).ok, true);
  assert.deepEqual(await readFile(note), edited);
});

test('explicit enablement preserves other settings and backs up the original bytes', async t => {
  const f = await fixture(t);
  const result = await syncCommittedGraph({ vaultRoot: f.vaultRoot, enableAutoSync: true });
  assert.equal(result.status, 'synchronized'); assert.equal(result.auto_sync, true);
  const config = JSON.parse(await readFile(f.graph, 'utf8'));
  assert.deepEqual(config.colorGroups, [{ query: 'tag:test', color: 1 }]); assert.equal(config.zoom, 2);
  assert.equal(config.hideUnresolved, true); assert.equal(config.showOrphans, true);
  const filter = new RegExp(config.search.slice('path:/'.length, -1));
  assert.ok(filter.test(f.paper.paths['zh-CN'])); assert.ok(!filter.test(f.paper.paths.en));
  const digest = createHash('sha256').update(f.original).digest('hex');
  assert.deepEqual(await readFile(join(f.vaultRoot, '.apa-v3/phase22/graph/backups', digest + '.json')), f.original);
  const state = JSON.parse(await readFile(f.state, 'utf8'));
  assert.equal(state.schema_version, 'phase22-managed-graph-1.0'); assert.equal(state.enabled, true);
  assert.deepEqual(state.policy, { search: config.search, hideUnresolved: true, showOrphans: true });
});

test('a current configuration is not rewritten and stale state can be recovered', async t => {
  const f = await fixture(t); await syncCommittedGraph({ vaultRoot: f.vaultRoot, enableAutoSync: true });
  const before = await readFile(f.graph), state = JSON.parse(await readFile(f.state, 'utf8'));
  assert.equal((await syncCommittedGraph({ vaultRoot: f.vaultRoot })).status, 'current');
  state.generation_id = 'older'; await writeFile(f.state, JSON.stringify(state));
  const recovered = await syncCommittedGraph({ vaultRoot: f.vaultRoot });
  assert.equal(recovered.generation_id, 'rf-a');
  assert.deepEqual(await readFile(f.graph), before);
  assert.equal(JSON.parse(await readFile(f.state, 'utf8')).generation_id, 'rf-a');
});

test('automatic synchronization preserves user policy changes and explicit sync can reclaim them', async t => {
  const f = await fixture(t); await syncCommittedGraph({ vaultRoot: f.vaultRoot, enableAutoSync: true });
  const config = JSON.parse(await readFile(f.graph, 'utf8')); config.search = 'user filter';
  const custom = Buffer.from(JSON.stringify(config)); await writeFile(f.graph, custom);
  const state = await readFile(f.state);
  const result = await syncCommittedGraph({ vaultRoot: f.vaultRoot });
  assert.equal(result.ok, false); assert.equal(result.status, 'custom_filter_preserved');
  assert.deepEqual(await readFile(f.graph), custom); assert.deepEqual(await readFile(f.state), state);
  assert.equal((await syncCommittedGraph({ vaultRoot: f.vaultRoot, enableAutoSync: true })).status, 'synchronized');
});

test('an invalid committed generation cannot modify configuration or state', async t => {
  const f = await fixture(t); await syncCommittedGraph({ vaultRoot: f.vaultRoot, enableAutoSync: true });
  const config = await readFile(f.graph), state = await readFile(f.state);
  await writeFile(join(f.vaultRoot, '.apa-v3/phase22/COMMITTED.json'), '{}');
  await assert.rejects(syncCommittedGraph({ vaultRoot: f.vaultRoot }));
  assert.deepEqual(await readFile(f.graph), config); assert.deepEqual(await readFile(f.state), state);
});

test('explicit CLI plugin sync and later CLI sync preserve the user graph configuration', async t => {
  const f = await fixture(t);
  const enabled = await runGraphCli(process.execPath, [cliPath, 'sync-plugin', '--vault-root', f.vaultRoot]);
  assert.equal(JSON.parse(enabled.stdout).status, 'synchronized');
  assert.deepEqual(await readFile(f.graph), f.original);
  const state = await readJson(f.state);
  assert.equal(state.schema_version, 'phase22-managed-graph-1.0');
  assert.equal(state.scope_provider, pluginId);

  const userConfig = Buffer.from(JSON.stringify({ ...JSON.parse(f.original), search: 'tag:chosen' }));
  await writeFile(f.graph, userConfig);
  const unchanged = new Date('2020-01-01T00:00:00Z');
  await utimes(f.scope, unchanged, unchanged);
  const before = (await stat(f.scope)).mtimeMs;
  const synced = await runGraphCli(process.execPath, [cliPath, 'sync', '--vault-root', f.vaultRoot]);
  assert.equal(JSON.parse(synced.stdout).status, 'current');
  assert.equal((await stat(f.scope)).mtimeMs, before);
  assert.deepEqual(await readFile(f.graph), userConfig);
});

test('automatic plugin sync updates the official nodes when a new generation is registered', async t => {
  const f = await fixture(t);
  await enablePluginScope(f.vaultRoot);
  const oldScope = await readJson(f.scope);
  assert.equal(oldScope.generation_id, 'rf-a');
  assert.ok(oldScope.expected_nodes.includes(f.paper.paths['zh-CN']));

  const next = await readingFirstIndexFixture(t, { suffix: 'b', vaultRoot: f.vaultRoot });
  await next.save(await next.build());
  const result = await syncCommittedGraph({ vaultRoot: f.vaultRoot });
  assert.equal(result.status, 'synchronized');
  const scope = await readJson(f.scope);
  assert.deepEqual(scope, {
    schema_version: 'apa-official-graph-scope-1.0', generation_id: 'rf-b',
    expected_nodes: [next.paper.paths['zh-CN'], next.manifest.targets.support[0].path].sort(),
    logical_paper_count: 1, logical_topic_count: 0,
  });
  assert.equal((await readJson(f.state)).generation_id, 'rf-b');
  assert.deepEqual(await readFile(f.graph), f.original);
});

test('an invalid registered commit preserves the last valid plugin scope and managed state', async t => {
  const f = await fixture(t);
  await enablePluginScope(f.vaultRoot);
  const scope = await readFile(f.scope), state = await readFile(f.state);
  await writeFile(join(f.vaultRoot, '.apa-v3/phase22/COMMITTED.json'), '{}');
  await assert.rejects(syncCommittedGraph({ vaultRoot: f.vaultRoot }), { code: 'P22_DEFAULT_COMMITTED_REQUIRED' });
  assert.deepEqual(await readFile(f.scope), scope);
  assert.deepEqual(await readFile(f.state), state);
  assert.deepEqual(await readFile(f.graph), f.original);
});

test('plugin graph check validates the official scope, managed generation and plugin enablement', async t => {
  const f = await fixture(t);
  await enablePluginScope(f.vaultRoot);
  const manifestPath = join(f.vaultRoot, '.obsidian/plugins', pluginId, 'manifest.json');
  const enabledPath = join(f.vaultRoot, '.obsidian/community-plugins.json');
  await mkdir(join(f.vaultRoot, '.obsidian/plugins', pluginId), { recursive: true });
  await writeFile(manifestPath, JSON.stringify({ id: pluginId }));
  await writeFile(enabledPath, JSON.stringify([pluginId]));
  const check = () => inspectV3Graph({ vaultRoot: f.vaultRoot });
  const current = await check();
  assert.equal(current.status, 'current');
  assert.equal(current.scope_provider, pluginId);
  assert.equal(current.native_gui, 'not_run');
  assert.deepEqual(await readFile(f.graph), f.original);

  const cases = [
    [f.scope, { ...await readJson(f.scope), expected_nodes: [f.paper.paths.en] }, 'expected_nodes'],
    [f.state, { ...await readJson(f.state), generation_id: 'older' }, 'managed_generation_id'],
    [manifestPath, { id: 'some-other-plugin' }, 'plugin_manifest_id'],
    [enabledPath, [], 'plugin_enabled'],
  ];
  for (const [path, replacement, field] of cases) {
    const original = await readFile(path);
    const bytes = Buffer.from(JSON.stringify(replacement));
    await writeFile(path, bytes);
    const result = await check();
    assert.equal(result.status, 'not_ready');
    assert.equal(result.native_gui, 'not_run');
    assert.deepEqual(result.differences.map(row => row.field), [field]);
    assert.deepEqual(await readFile(path), bytes);
    await writeFile(path, original);
  }
});
