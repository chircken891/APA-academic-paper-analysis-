import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readCommittedReadingFirstKnowledgeRegistry, assertCommittedReadingFirstKnowledgeRegistry, inspectCommittedReadingFirstRegistry, readCommittedReadingFirstRegistryResource } from '../../scripts/v3/reading-first-knowledge-registry.mjs';
import { readingFirstIndexFixture } from './helpers/reading-first-index-fixtures.mjs';
import { saveReadingFirstPair } from './helpers/reading-first-index-fixtures.mjs';
import { readCommittedGeneration, assertCommittedSnapshot, readCommittedSharedNodes } from '../../scripts/v3/phase22-active-version.mjs';
import { fingerprintV3Json } from '../../scripts/v3/semantic-package-validator.mjs';
import { createHash } from 'node:crypto';

test('current registry consumes edited shared content and preserves it in a later candidate', async t => {
  const f = await readingFirstIndexFixture(t), built = await f.build();
  await f.save(built);
  const nodePath = f.manifest.targets.support[0].path;
  const nodeFile = join(f.vaultRoot, nodePath);
  const edited = (await readFile(nodeFile, 'utf8')).replace('Only sharedknowledgeneedle is explained here.', 'Human revised explanation remains.');
  await writeFile(nodeFile, edited);
  const registry = await readCommittedReadingFirstKnowledgeRegistry({ vaultRoot: f.vaultRoot, policy: 'current-shared-nodes-1.0' });
  assert.equal(registry[0].content, edited);
  assert.match(registry[0].content_sha256, /^sha256:[a-f0-9]{64}$/);
  const later = await readingFirstIndexFixture(t, { suffix: 'b', vaultRoot: f.vaultRoot, knowledgeRegistry: registry });
  assert.match(later.rendered.supportNotes[0].content, /Human revised explanation remains\./);
  assert.ok(!later.rendered.supportNotes[0].content.includes('Only sharedknowledgeneedle is explained here.'));
  assert.equal(await readFile(nodeFile, 'utf8'), edited);
});

test('editing an unrelated node after registry capture leaves the actual reused node usable', async t => {
  const f = await readingFirstIndexFixture(t), built = await f.build();
  await f.save(built);
  const first = f.manifest.targets.support[0].path, second = 'Wiki/methods/another.md';
  const bytes = Buffer.from((await readFile(join(f.vaultRoot, first), 'utf8'))
    .replace('knowledge_id: rate', 'knowledge_id: other').replace('canonical_key: synthetic-rate', 'canonical_key: other-key'));
  await writeFile(join(f.vaultRoot, second), bytes);
  const generation = structuredClone(built.generation);
  generation.shared_nodes.push({ entity_id: 'other', path: second });
  generation.objects.push({ kind: 'support', path: second, sha256: 'sha256:' + createHash('sha256').update(bytes).digest('hex') });
  const index = structuredClone(built.index); index.active_fingerprint = fingerprintV3Json(generation);
  await saveReadingFirstPair(f.vaultRoot, generation, index);
  const registry = await readCommittedReadingFirstKnowledgeRegistry({ vaultRoot: f.vaultRoot, policy: 'current-shared-nodes-1.0' });
  await writeFile(join(f.vaultRoot, second), Buffer.concat([bytes, Buffer.from('\nUnrelated user edit.\n')]));
  assert.doesNotThrow(() => assertCommittedReadingFirstKnowledgeRegistry({ vaultRoot: f.vaultRoot, registry, paths: [first] }));
  assert.throws(() => assertCommittedReadingFirstKnowledgeRegistry({ vaultRoot: f.vaultRoot, registry, paths: [second] }), /P23_CURRENT_CHANGED/);
  await writeFile(join(f.vaultRoot, second), 'invalid metadata');
  const partial = await readCommittedReadingFirstKnowledgeRegistry({ vaultRoot: f.vaultRoot, policy: 'current-shared-nodes-1.0' });
  assert.equal(partial.find(row => row.path === second).unavailable, true);
  assert.equal((await readingFirstIndexFixture(t, { suffix: 'b', vaultRoot: f.vaultRoot, knowledgeRegistry: partial })).rendered.supportNotes[0].path, first);
});

test('scoped registry tolerates paper drift but retains strict shared-node and pair checks', async t => {
  const f = await readingFirstIndexFixture(t), built = await f.build();
  await f.save(built);
  const paper = join(f.vaultRoot, f.paper.paths.en);
  await writeFile(paper, (await readFile(paper, 'utf8')).replace('Connected synthetic design.', 'Changed synthetic design.'));
  assert.equal((await readCommittedGeneration({ vaultRoot: f.vaultRoot })).ok, false);
  await assert.rejects(readCommittedReadingFirstKnowledgeRegistry({ vaultRoot: f.vaultRoot }), /RF_KNOWLEDGE_REGISTRY_COMMITTED_INVALID/);
  const registry = await readCommittedReadingFirstKnowledgeRegistry({ vaultRoot: f.vaultRoot, policy: 'committed-shared-nodes-1.0' });
  assert.equal(registry[0].canonical_key, 'synthetic-rate');
  assert.doesNotThrow(() => assertCommittedReadingFirstKnowledgeRegistry({ vaultRoot: f.vaultRoot, registry }));
  assert.throws(() => assertCommittedSnapshot(registry), /P22_SNAPSHOT_NOT_COMMITTED/);
  const shared = join(f.vaultRoot, f.manifest.targets.support[0].path);
  await writeFile(shared, (await readFile(shared, 'utf8')) + '\nchanged\n');
  assert.throws(() => assertCommittedReadingFirstKnowledgeRegistry({ vaultRoot: f.vaultRoot, registry }));
  await assert.rejects(readCommittedReadingFirstKnowledgeRegistry({ vaultRoot: f.vaultRoot, policy: 'committed-shared-nodes-1.0' }), error => error.details?.errors?.[0]?.details?.path === f.manifest.targets.support[0].path);
});

test('scoped metadata and resource access bind only current registered assets', async t => {
  const f = await readingFirstIndexFixture(t), built = await f.build();
  await f.save(built);
  const registry = await readCommittedReadingFirstKnowledgeRegistry({ vaultRoot: f.vaultRoot, policy: 'committed-shared-nodes-1.0' });
  const meta = inspectCommittedReadingFirstRegistry({ vaultRoot: f.vaultRoot, registry });
  assert.equal(meta.generation_id, f.generation.generation_id);
  assert.deepEqual(meta.paper_paths.sort(), Object.values(f.paper.paths).sort());
  const asset = f.files.find(row => row.kind === 'asset');
  assert.deepEqual(meta.asset_paths.sort(), f.files.filter(row => row.kind === 'asset').map(row => row.path).sort());
  assert.deepEqual(readCommittedReadingFirstRegistryResource({ vaultRoot: f.vaultRoot, registry, path: asset.path }).bytes, asset.bytes);
  assert.throws(() => readCommittedReadingFirstRegistryResource({ vaultRoot: f.vaultRoot, registry, path: f.paper.paths.en }), /P22_SHARED_ASSET_UNREGISTERED/);
  assert.throws(() => assertCommittedReadingFirstKnowledgeRegistry({ vaultRoot: f.vaultRoot, registry, policy: 'committed-generation-1.0' }), /RF_KNOWLEDGE_REGISTRY_NOT_TRUSTED/);
  await writeFile(join(f.vaultRoot, asset.path), 'changed');
  assert.throws(() => readCommittedReadingFirstRegistryResource({ vaultRoot: f.vaultRoot, registry, path: asset.path }), error => error.code === 'P22_OBJECT_HASH_MISMATCH' && error.details.path === asset.path);
});

test('scoped snapshot rejects pointer changes at observation boundary and stale pair bytes', async t => {
  const f = await readingFirstIndexFixture(t), built = await f.build();
  await f.save(built);
  const marker = join(f.vaultRoot, '.apa-v3/phase22/COMMITTED.json');
  const original = await readFile(marker);
  const result = await readCommittedSharedNodes({ vaultRoot: f.vaultRoot, maxAttempts: 1, onReadBoundary: async stage => {
    if (stage === 'after-objects') await writeFile(marker, Buffer.concat([original, Buffer.from(' ')]));
  } });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'P22_GENERATION_CHANGED');
  await writeFile(marker, original);
  const registry = await readCommittedReadingFirstKnowledgeRegistry({ vaultRoot: f.vaultRoot, policy: 'committed-shared-nodes-1.0' });
  const index = JSON.parse(original.toString()).index.path;
  await writeFile(join(f.vaultRoot, index), 'broken');
  assert.throws(() => inspectCommittedReadingFirstRegistry({ vaultRoot: f.vaultRoot, registry }), /P22_SHARED_SNAPSHOT_NOT_CURRENT/);
  await assert.rejects(readCommittedReadingFirstKnowledgeRegistry({ vaultRoot: f.vaultRoot, policy: 'committed-shared-nodes-1.0' }), /RF_KNOWLEDGE_REGISTRY_COMMITTED_INVALID/);
});

test('registry reads only verified committed shared nodes and is consumable by a later reading', async t => {
  const f = await readingFirstIndexFixture(t), built = await f.build();
  await f.save(built);
  const orphan = join(f.vaultRoot, 'Wiki/methods/orphan.md');
  await mkdir(dirname(orphan), { recursive: true });
  await writeFile(orphan, '---\nknowledge_id: orphan\npipeline_version: "3.0"\n---\n');

  const registry = await readCommittedReadingFirstKnowledgeRegistry({ vaultRoot: f.vaultRoot });
  assert.equal(registry.length, 1);
  const row = registry[0], old = f.rendered.supportNotes[0];
  assert.equal(row.path, old.path);
  assert.equal(row.id, 'rate');
  assert.equal(row.canonical_key, 'synthetic-rate');
  assert.equal(row.language, 'multilingual');
  assert.ok(row.aliases.includes('SyntheticRateAlias'));
  assert.equal(row.content, old.content);
  assert.ok(!registry.some(item => item.id === 'orphan'));

  const later = await readingFirstIndexFixture(t, { suffix: 'b', vaultRoot: f.vaultRoot, knowledgeRegistry: registry });
  assert.equal(later.rendered.supportNotes[0].path, old.path);
  assert.match(later.rendered.supportNotes[0].content, /Only sharedknowledgeneedle is explained here/);
  assert.match(later.rendered.supportNotes[0].content, /这里专门解释共享知识检索词/);
});

test('registry refuses changed committed node bytes', async t => {
  const f = await readingFirstIndexFixture(t), built = await f.build();
  await f.save(built);
  const path = join(f.vaultRoot, f.manifest.targets.support[0].path);
  await writeFile(path, (await readFile(path, 'utf8')) + '\ntampered\n');
  await assert.rejects(readCommittedReadingFirstKnowledgeRegistry({ vaultRoot: f.vaultRoot }), /RF_KNOWLEDGE_REGISTRY_COMMITTED_INVALID/);
});

test('registry distinguishes an uninitialized vault from a corrupt commit pointer', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rf-knowledge-empty-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const empty = await readCommittedReadingFirstKnowledgeRegistry({ vaultRoot: root });
  assert.deepEqual(empty, []);
  assert.doesNotThrow(() => assertCommittedReadingFirstKnowledgeRegistry({ vaultRoot: root, registry: empty }));
  assert.throws(() => assertCommittedReadingFirstKnowledgeRegistry({ vaultRoot: root, registry: structuredClone(empty) }), /RF_KNOWLEDGE_REGISTRY_NOT_TRUSTED/);
  const marker = join(root, '.apa-v3/phase22/COMMITTED.json');
  await mkdir(dirname(marker), { recursive: true });
  await writeFile(marker, '{broken');
  assert.throws(() => assertCommittedReadingFirstKnowledgeRegistry({ vaultRoot: root, registry: empty }), /RF_KNOWLEDGE_REGISTRY_NOT_TRUSTED/);
  await assert.rejects(readCommittedReadingFirstKnowledgeRegistry({ vaultRoot: root }), /RF_KNOWLEDGE_REGISTRY_COMMITTED_INVALID/);
});
