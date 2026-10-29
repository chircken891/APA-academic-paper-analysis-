import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readerIndexFixture } from './helpers/phase221-index-fixtures.mjs';
import { syncCommittedGraph } from '../../scripts/v3/obsidian-graph-sync.mjs';
import { inspectV3Graph } from '../../scripts/v3/obsidian-graph.mjs';

async function fixture(t) {
  const f = await readerIndexFixture(t), built = await f.build();
  await f.save(built);
  const graph = join(f.vaultRoot, '.obsidian/graph.json');
  await mkdir(join(f.vaultRoot, '.obsidian'), { recursive: true });
  const original = Buffer.from(JSON.stringify({ search: 'old filter', hideUnresolved: false, showOrphans: false, colorGroups: [{ query: 'tag:test', color: 1 }], zoom: 2 }));
  await writeFile(graph, original);
  return { ...f, graph, original, state: join(f.vaultRoot, '.apa-v3/phase22/graph/MANAGED.json') };
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
  assert.equal(recovered.generation_id, 'synthetic-reader-g1');
  assert.deepEqual(await readFile(f.graph), before);
  assert.equal(JSON.parse(await readFile(f.state, 'utf8')).generation_id, 'synthetic-reader-g1');
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
