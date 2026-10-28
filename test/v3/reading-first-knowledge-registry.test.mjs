import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readCommittedReadingFirstKnowledgeRegistry, assertCommittedReadingFirstKnowledgeRegistry } from '../../scripts/v3/reading-first-knowledge-registry.mjs';
import { readingFirstIndexFixture } from './helpers/reading-first-index-fixtures.mjs';

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
