import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readingFirstIndexFixture, saveReadingFirstPair, digest } from './helpers/reading-first-index-fixtures.mjs';
import { readCommittedGeneration, assertIndexGeneration } from '../../scripts/v3/phase22-active-version.mjs';
import { buildBilingualIndex, queryBilingualIndex } from '../../scripts/v3/phase22-search.mjs';
import { buildGraphProposal } from '../../scripts/v3/phase22-graph.mjs';
import { fingerprintV3Json as hash } from '../../scripts/v3/semantic-package-validator.mjs';
import { readerIndexFixture } from './helpers/phase221-index-fixtures.mjs';

test('reading-first committed consumers index bilingual paper and one shared knowledge note with real anchors', async t => {
  const f = await readingFirstIndexFixture(t), built = await f.build();
  await f.save(built);
  const snapshot = await readCommittedGeneration({ vaultRoot: f.vaultRoot });
  assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
  for (const term of ['finalresultneedle', '最终结果检索词', 'sharedknowledgeneedle', '共享知识检索词']) {
    const hits = queryBilingualIndex({ index: snapshot.index, activeSnapshot: snapshot, query: term }).results.flatMap(result => result.hits);
    assert.ok(hits.length, term);
    assert.ok(hits.every(hit => ['heading', 'block'].includes(hit.anchor_type) && hit.anchor), term);
    if (term.includes('sharedknowledge') || term.includes('共享')) assert.ok(hits.some(hit => hit.path === f.manifest.targets.support[0].path));
  }
  const graph = buildGraphProposal({ activeSnapshot: snapshot, entityInventory: built.generation.objects.map(({ path }) => ({ path })) });
  assert.ok(graph.expectedNodes.includes(f.paper.paths['zh-CN']));
  assert.equal(graph.expectedNodes.filter(path => path === f.manifest.targets.support[0].path).length, 1);
  assert.equal(graph.native_gui, 'not_run');
});

test('reading-first index excludes personal notes while allowing their post-commit edits', async t => {
  const f = await readingFirstIndexFixture(t), built = await f.build(); await f.save(built);
  const path = join(f.vaultRoot, f.paper.paths.en);
  await writeFile(path, Buffer.concat([await readFile(path), Buffer.from('\nprivatehumanneedle\n')]));
  const snapshot = await readCommittedGeneration({ vaultRoot: f.vaultRoot });
  assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
  assert.deepEqual(queryBilingualIndex({ index: snapshot.index, activeSnapshot: snapshot, query: 'privatehumanneedle' }).results, []);
});

test('reading-first shared knowledge indexing excludes preserved human text outside its managed region', async t => {
  const f = await readingFirstIndexFixture(t), file = f.files.find(row => row.kind === 'support');
  file.bytes = Buffer.concat([file.bytes, Buffer.from('\nHuman annotation: privateknowledgehumanneedle\n')]);
  f.generation.objects.find(row => row.path === file.path).sha256 = digest(file.bytes);
  const built = await f.build(); await f.save(built);
  const snapshot = await readCommittedGeneration({ vaultRoot: f.vaultRoot });
  assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
  assert.deepEqual(queryBilingualIndex({ index: snapshot.index, activeSnapshot: snapshot, query: 'privateknowledgehumanneedle' }).results, []);
  assert.match((await readFile(join(f.vaultRoot, file.path), 'utf8')), /privateknowledgehumanneedle/);
});

test('reading-first readback rejects a rehashed shared-content change when the committed index was not rebuilt', async t => {
  const f = await readingFirstIndexFixture(t), built = await f.build(); await f.save(built);
  const path = f.manifest.targets.support[0].path, bytes = Buffer.from((await readFile(join(f.vaultRoot, path), 'utf8')).replace('sharedknowledgeneedle', 'changedsharedneedle'));
  await writeFile(join(f.vaultRoot, path), bytes);
  const generation = structuredClone(built.generation), index = structuredClone(built.index);
  generation.objects.find(row => row.path === path).sha256 = digest(bytes); index.active_fingerprint = hash(generation);
  await saveReadingFirstPair(f.vaultRoot, generation, index);
  const snapshot = await readCommittedGeneration({ vaultRoot: f.vaultRoot });
  assert.equal(snapshot.ok, false);
  assert.match(snapshot.errors[0].code, /RF_.*INDEX|RF_.*CONTENT/);
});

test('reading-first next generation retains another committed paper and updates one shared node without duplicate identity', async t => {
  const first = await readingFirstIndexFixture(t), initial = await first.build(); await first.save(initial);
  const previousSnapshot = await readCommittedGeneration({ vaultRoot: first.vaultRoot });
  const priorSupport = first.rendered.supportNotes[0];
  const second = await readingFirstIndexFixture(t, { suffix: 'b', vaultRoot: first.vaultRoot,
    knowledgeRegistry: [{ canonical_key: 'synthetic-rate', path: priorSupport.path, content: priorSupport.content }] });
  const generation = structuredClone(second.generation);
  generation.papers.unshift(first.paper);
  const seen = new Set(generation.objects.map(row => row.path));
  generation.objects.push(...initial.generation.objects.filter(row => !seen.has(row.path)));
  const files = new Map(first.allFiles().map(file => [file.path, file]));
  for (const file of second.allFiles()) files.set(file.path, file);
  const built = await buildBilingualIndex({ generation, validatedInputs: { papers: second.validatedInputs.papers, files: [...files.values()], previousSnapshot } });
  assert.equal(built.generation.papers.length, 2);
  assert.equal(built.generation.shared_nodes.length, 1);
  assert.ok(built.index.documents.some(doc => doc.paper_id === first.paper.paper_id));
  assert.ok(built.index.documents.some(doc => doc.paper_id === second.paper.paper_id));
  assert.doesNotThrow(() => assertIndexGeneration(built.index, built.generation));
  const rebuilt = await buildBilingualIndex({ generation, validatedInputs: { papers: second.validatedInputs.papers, files: [...files.values()],
    previousPrepared: { generation: previousSnapshot.generation, index: previousSnapshot.index } } });
  assert.deepEqual(rebuilt.generation, built.generation);
  assert.deepEqual(rebuilt.index, built.index);
  await assert.rejects(async () => buildBilingualIndex({ generation, validatedInputs: { ...second.validatedInputs, previousSnapshot: structuredClone(previousSnapshot) } }), /P22_SNAPSHOT_NOT_COMMITTED/);
});

test('reading-first addition retains a committed Phase22 reader paper and its exact index projection', async t => {
  const old = await readerIndexFixture(t), initial = await old.build(); await old.save(initial);
  const previousSnapshot = await readCommittedGeneration({ vaultRoot: old.vaultRoot });
  assert.equal(previousSnapshot.ok, true, JSON.stringify(previousSnapshot));
  const next = await readingFirstIndexFixture(t, { vaultRoot: old.vaultRoot });
  const generation = structuredClone(next.generation);
  generation.papers.unshift(initial.generation.papers[0]);
  generation.objects.push(...initial.generation.objects);
  generation.shared_nodes.push(...initial.generation.shared_nodes);
  const files = [...old.files, ...Object.entries(old.notes).map(([language, bytes]) => ({ path: old.paper.paths[language], bytes })), ...next.allFiles()];
  const built = await buildBilingualIndex({ generation, validatedInputs: { papers: next.validatedInputs.papers, files, previousSnapshot } });
  assert.deepEqual(built.index.documents.filter(doc => doc.paper_id === old.paper.paper_id), initial.index.documents);
  await next.save(built);
  const snapshot = await readCommittedGeneration({ vaultRoot: old.vaultRoot });
  assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
  assert.ok(queryBilingualIndex({ index: snapshot.index, activeSnapshot: snapshot, query: 'finalreaderneedle' }).results.length);
});
