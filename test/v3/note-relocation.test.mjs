import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { readingFirstPublicationFixture, applyReadingFirstFixture, readingFirstPublicationAuthority } from './helpers/reading-first-publication-fixtures.mjs';
import { buildNoteRelocationReview, relocateNoteLinks, relocateCanvasLinks } from '../../scripts/v3/note-relocation.mjs';
import { dryRunBilingualPublication, applyBilingualPublication } from '../../scripts/v3/phase22-publication.mjs';
import { readCommittedGeneration, readRegisteredCommit } from '../../scripts/v3/phase22-active-version.mjs';
import { buildRegisteredGraphProposal } from '../../scripts/v3/phase22-graph.mjs';
import { createTopicFixture, publishTopicFixture } from './helpers/topic-fixtures.mjs';
import { validateReadingFirstPreviewFiles } from '../../scripts/v3/reading-first-preview.mjs';

const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

test('Canvas relocation preserves fragments, aliases and card layout across explicit path mappings', () => {
  const note = 'Wiki/sources/Study.en.md', renamed = 'Wiki/translations/Renamed study.en.md';
  const canvas = 'Figures/run/nested/research-map.en.canvas', target = 'Figures/run/research-map.en.canvas';
  const nodes = [
    { type: 'text', id: 'wiki', x: 30, text: '[[Wiki/sources/Study.en#2.1 Design|Design]] [[Study.en#2.1 Design]]' },
    { type: 'text', id: 'legacy', text: '[Design](../../../Wiki/sources/Study.en.md#2.1%20Design) ![Figure](../figure.png)' },
    { type: 'file', id: 'file', file: note, subpath: '#2.1 Design' },
    { type: 'text', id: 'outside', text: '[[Eval/old/Study.en#2.1 Design|Copy]] [External](https://example.org/#design)' },
  ];
  const edges = [{ id: 'edge', fromNode: 'wiki', toNode: 'file' }];
  const input = Buffer.from(JSON.stringify({ nodes, edges }));
  const updated = JSON.parse(relocateCanvasLinks(input, canvas, target, new Map([[note, renamed]]), [note]));
  assert.deepEqual(updated, { edges, nodes: [
    { ...nodes[0], text: '[[Wiki/translations/Renamed study.en#2.1 Design|Design]] [[Wiki/translations/Renamed study.en#2.1 Design]]' },
    { ...nodes[1], text: '[Design](../../Wiki/translations/Renamed%20study.en.md#2.1%20Design) ![Figure](figure.png)' },
    { ...nodes[2], file: renamed },
    nodes[3],
  ] });
  assert.deepEqual(relocateCanvasLinks(input, canvas, canvas, new Map(), [note]), input);
});

async function published(t) {
  const f = await readingFirstPublicationFixture(t, { controlOptions: { noteLayout: 'legacy-flat-1.0' } });
  const result = await applyBilingualPublication(applyReadingFirstFixture(f));
  assert.equal(result.status, 'committed');
  assert.equal(result.hint_status, 'available');
  const before = await readCommittedGeneration({ vaultRoot: f.vaultRoot });
  assert.equal(before.ok, true);
  return { ...f, before };
}
async function relocation(f) {
  return buildNoteRelocationReview({ vaultRoot: f.vaultRoot, runId: f.runId, generation: 'relocated-notes',
    papers: [{ paperId: f.before.generation.papers[0].paper_id, sourceLanguage: 'en' }] });
}
test('path-only relocation uses the existing transaction and preserves scientific identity, links and index', async t => {
  const f = await published(t), previous = f.before.generation.papers[0];
  const original = await readFile(join(f.vaultRoot, previous.paths['zh-CN']), 'utf8');
  const oldPresentation = JSON.parse(await readFile(join(f.vaultRoot, previous.reader_presentation.path)));
  const oldCanvas = oldPresentation.presentation_assets.find(row => row.language === 'zh-CN');
  const candidateCopy = 'Eval/old-candidate/' + posix.basename(previous.paths['zh-CN']);
  await mkdir(dirname(join(f.vaultRoot, candidateCopy)), { recursive: true });
  await writeFile(join(f.vaultRoot, candidateCopy), '## Archived copy\n');
  const review = await relocation(f);
  const { plan } = await dryRunBilingualPublication({ vaultRoot: f.vaultRoot, run: f.runId, review });
  const plannedCanvas = plan.inventory.find(row => row.path === oldCanvas.path);
  assert.equal(plannedCanvas?.kind, 'asset', 'The translated Canvas must be an approved transaction output');
  assert.equal(plannedCanvas.before_sha256, oldCanvas.sha256);
  assert.equal(plannedCanvas.before_byte_length, oldCanvas.byte_length);
  const authority = await readingFirstPublicationAuthority(f, plan);
  const result = await applyBilingualPublication({ vaultRoot: f.vaultRoot, run: f.runId, plan, ...authority });
  assert.equal(result.status, 'committed');
  assert.equal(result.hint_status, undefined);
  assert.equal(result.relevance_hints, undefined);
  assert.equal(result.graph_sync.ok, true);
  const current = await readCommittedGeneration({ vaultRoot: f.vaultRoot });
  assert.equal(current.ok, true, JSON.stringify(current.errors));
  const paper = current.generation.papers[0];
  assert.equal(paper.paths.en, previous.paths.en);
  assert.equal(paper.paths['zh-CN'], previous.paths['zh-CN'].replace('Wiki/sources/', 'Wiki/translations/'));
  assert.equal(paper.core_hash, previous.core_hash);
  assert.deepEqual(paper.dependencies, previous.dependencies);
  const en = await readFile(join(f.vaultRoot, paper.paths.en), 'utf8');
  const zh = await readFile(join(f.vaultRoot, paper.paths['zh-CN']), 'utf8');
  assert.ok(en.includes('../translations/'));
  assert.ok(zh.includes('../sources/'));
  assert.equal(await readFile(join(f.vaultRoot, previous.paths['zh-CN']), 'utf8'), original, 'Old note retained until separate exact retirement after commit');
  assert.ok(current.index.documents.some(row => row.path === paper.paths['zh-CN']));
  assert.ok(!current.index.documents.some(row => row.path === previous.paths['zh-CN']));
  const supports = current.generation.shared_nodes.map(row => row.path);
  assert.ok((await Promise.all(supports.map(path => readFile(join(f.vaultRoot, path), 'utf8')))).some(text => text.includes('../translations/')));
  const canvases = current.generation.objects.filter(row => row.path.endsWith('.canvas'));
  assert.equal(canvases.length, 2);
  const nextPresentation = JSON.parse(await readFile(join(f.vaultRoot, paper.reader_presentation.path)));
  const canvasFiles = await Promise.all(canvases.map(async row => {
    const bytes = await readFile(join(f.vaultRoot, row.path));
    const prior = oldPresentation.presentation_assets.find(old => old.path === row.path);
    assert.deepEqual(nextPresentation.presentation_assets.find(asset => asset.path === row.path),
      { ...prior, sha256: sha(bytes), byte_length: bytes.length });
    assert.equal(row.sha256, sha(bytes));
    if (prior.language === 'zh-CN') {
      const localTargets = JSON.parse(bytes).nodes.flatMap(node => [...(node.text ?? '').matchAll(/\[\[([^#|]+)#/g)].map(match => match[1]));
      assert.ok(localTargets.length > 0);
      assert.deepEqual([...new Set(localTargets)], [paper.paths['zh-CN'].slice(0, -3)]);
      assert.equal(row.sha256, plannedCanvas.byte_sha256);
    } else assert.equal(sha(bytes), prior.sha256);
    return { path: row.path, bytes };
  }));
  const destinations = Object.values(paper.paths).map(path => ({ path,
    bytes: Buffer.from((path === paper.paths.en ? en : zh).split('\n').filter(line => /^#{1,6} /.test(line)).join('\n')) }));
  const retainedNote = { path: previous.paths['zh-CN'],
    bytes: Buffer.from('## Retained old copy\n') };
  const navigation = validateReadingFirstPreviewFiles([...canvasFiles, ...destinations, retainedNote,
    { path: candidateCopy, bytes: await readFile(join(f.vaultRoot, candidateCopy)) }]);
  assert.equal(navigation.status, 'passed');
  assert.ok(navigation.local_links > 0);
});
test('relocation refuses occupied target and stale committed source instead of overwriting', async t => {
  const f = await published(t), old = f.before.generation.papers[0].paths['zh-CN'];
  const target = old.replace('Wiki/sources/', 'Wiki/translations/');
  await mkdir(join(f.vaultRoot, 'Wiki/translations'));
  await writeFile(join(f.vaultRoot, target), 'human note');
  await assert.rejects(relocation(f), /P22_RELOCATION_TARGET_OCCUPIED/);
  assert.equal(await readFile(join(f.vaultRoot, target), 'utf8'), 'human note');
  await writeFile(join(f.vaultRoot, old), 'changed source');
  await assert.rejects(relocation(f), /P22_RELOCATION_COMMITTED_REQUIRED/);
});
test('relocation does not bypass the existing exact approval or rollback', async t => {
  const f = await published(t), original = new Map();
  for (const { path } of f.before.generation.objects.filter(row => row.kind === 'v3-note' || row.path.endsWith('.canvas'))) {
    original.set(path, await readFile(join(f.vaultRoot, path)));
  }
  const review = await relocation(f), { plan } = await dryRunBilingualPublication({ vaultRoot: f.vaultRoot, run: f.runId, review });
  await assert.rejects(applyBilingualPublication({ vaultRoot: f.vaultRoot, run: f.runId, plan }), /P22_PUBLICATION_CONTROL_REQUIRED/);
  const authority = await readingFirstPublicationAuthority(f, plan);
  await assert.rejects(applyBilingualPublication({ vaultRoot: f.vaultRoot, run: f.runId, plan, ...authority,
    onPromotionBoundary({ timing, path }) { if (timing === 'after' && path.endsWith('.zh-CN.canvas')) throw new Error('TEST_STOP'); } }), /TEST_STOP/);
  const current = await readCommittedGeneration({ vaultRoot: f.vaultRoot });
  assert.equal(current.ok, true, JSON.stringify(current.errors));
  assert.equal(current.generation_id, f.before.generation_id);
  for (const [path, bytes] of original) assert.deepEqual(await readFile(join(f.vaultRoot, path)), bytes);
});

test('asset relocation moves images and references existing originals, preserves current edited notes and reverses the paths', async t => {
  const f = await published(t), root = f.vaultRoot, prior = f.before.generation.papers[0];
  const priorSidecar = await readFile(join(root, prior.reader_presentation.path));
  const notePath = prior.paths.en;
  const manual = (await readFile(join(root, notePath), 'utf8'))
    .replace('<!-- AUTO:END reading -->', '\nLocally edited explanation with value 14.7.\n<!-- AUTO:END reading -->') + '\nMy private note and anchor ^keep-this\n';
  await writeFile(join(root, notePath), manual);
  const originalNotes = Object.fromEntries(await Promise.all(Object.values(prior.paths).map(async path => [path, await readFile(join(root, path), 'utf8')])));
  const assetMappings = f.resources.map(row => ({ old_path: row.path, sha256: row.sha256, byte_length: row.byte_length,
    new_path: row.path.startsWith('Raw/') ? 'Clippings/' + posix.basename(row.path) : `Figures/${f.runId}/${posix.basename(row.path)}` }));
  const figure = assetMappings.find(row => row.new_path.startsWith('Figures/'));
  const clipping = assetMappings.find(row => row.new_path.startsWith('Clippings/'));
  await mkdir(dirname(join(root, clipping.new_path)), { recursive: true });
  await writeFile(join(root, clipping.new_path), await readFile(join(root, clipping.old_path)));
  const apply = async (assetMappings, generation) => {
    const review = await buildNoteRelocationReview({ vaultRoot: root, runId: f.runId, generation, assetMappings });
    const { plan } = await dryRunBilingualPublication({ vaultRoot: root, run: f.runId, review });
    const authority = await readingFirstPublicationAuthority(f, plan);
    const result = await applyBilingualPublication({ vaultRoot: root, run: f.runId, plan, ...authority });
    assert.equal(result.status, 'committed', JSON.stringify(result));
    assert.deepEqual(result.cleanup_warnings ?? [], []);
    return { plan, result };
  };
  const { plan, result } = await apply(assetMappings, 'relocated-assets');
  assert.ok(!plan.inventory.some(row => row.path === clipping.new_path));
  assert.ok(plan.read_dependencies.some(row => row.path === clipping.new_path));
  assert.equal(sha(await readFile(join(root, figure.new_path))), figure.sha256);
  assert.equal(sha(await readFile(join(root, figure.old_path))), figure.sha256);
  const current = await readCommittedGeneration({ vaultRoot: root });
  assert.equal(current.ok, true, JSON.stringify(current.errors));
  const graph = buildRegisteredGraphProposal({ activeSnapshot: await readRegisteredCommit({ vaultRoot: root }),
    entityInventory: current.generation.objects.filter(row => row.path.startsWith('Wiki/')) });
  assert.ok(graph);
  const migrated = current.generation.papers[0];
  const sidecar = JSON.parse(await readFile(join(root, migrated.reader_presentation.path)));
  assert.ok(sidecar.targets.assets.includes(figure.new_path));
  assert.equal(sidecar.citation.sources[0].path, clipping.new_path);
  assert.equal(sidecar.path_migration.assets.find(row => row.old_path === clipping.old_path).source_id, sidecar.citation.sources[0].source_id);
  assert.deepEqual(await readFile(join(root, prior.reader_presentation.path)), priorSidecar);
  const map = new Map(assetMappings.map(row => [row.old_path, row.new_path]));
  for (const [path, text] of Object.entries(originalNotes)) assert.equal(await readFile(join(root, path), 'utf8'), relocateNoteLinks(text, path, path, map));
  await assert.rejects(buildNoteRelocationReview({ vaultRoot: root, runId: f.runId, generation: 'invalid-asset-compensation',
    assetMappings: [{ ...figure, old_path: figure.new_path, new_path: 'Figures/other/' + posix.basename(figure.old_path) }] }),
  /P22_RELOCATION_FIGURE_TARGET_INVALID/);
  for (const row of assetMappings) await unlink(join(root, row.old_path));
  const reversed = await apply(assetMappings.map(({ old_path, new_path, ...row }) => ({ ...row, old_path: new_path, new_path: old_path })), 'relocated-assets-reversed');
  assert.notEqual(reversed.result.transaction_id, result.transaction_id);
  const restored = await readCommittedGeneration({ vaultRoot: root });
  assert.equal(restored.ok, true, JSON.stringify(restored.errors));
  assert.notEqual(restored.generation_id, f.before.generation_id);
  for (const [path, text] of Object.entries(originalNotes)) assert.equal(await readFile(join(root, path), 'utf8'), text);
  for (const row of assetMappings) assert.equal(sha(await readFile(join(root, row.old_path))), row.sha256);
  const restoredPaper = restored.generation.papers[0];
  const restoredSidecar = JSON.parse(await readFile(join(root, restoredPaper.reader_presentation.path)));
  assert.deepEqual(restoredSidecar.targets.assets, JSON.parse(priorSidecar).targets.assets);
  assert.deepEqual(restoredSidecar.citation, JSON.parse(priorSidecar).citation);
});

test('asset relocation rejects wrong figure directories and conflicting declared source identities', async t => {
  const f = await published(t), root = f.vaultRoot;
  const figure = f.resources.find(row => row.path.startsWith('Figures/'));
  const raw = f.resources.find(row => row.path.startsWith('Raw/'));
  const target = 'Clippings/source.pdf';
  await mkdir(join(root, 'Clippings'));
  await writeFile(join(root, target), await readFile(join(root, raw.path)));
  const mapping = (row, new_path) => ({ old_path: row.path, new_path, sha256: row.sha256, byte_length: row.byte_length });
  const requests = [mapping(figure, 'Figures/other/' + posix.basename(figure.path)),
    mapping(figure, 'Figures/' + f.runId + '/nested/' + posix.basename(figure.path)), { ...mapping(raw, target), source_id: 'another-source' }];
  const observed = await Promise.allSettled(requests.map((row, index) => buildNoteRelocationReview({ vaultRoot: root,
    runId: f.runId, generation: 'invalid-asset-move-' + index, assetMappings: [row] })));
  assert.deepEqual(observed.map(row => row.status === 'rejected' ? row.reason.code : row.status),
    ['P22_RELOCATION_FIGURE_TARGET_INVALID', 'P22_RELOCATION_FIGURE_TARGET_INVALID', 'P22_RELOCATION_SOURCE_ID_CONFLICT']);
});

test('asset migration preserves topic identity and repairs an already renamed Clippings source', async t => {
  const f = await createTopicFixture(t), root = f.vaultRoot;
  const before = await publishTopicFixture(f);
  const topic = before.generation.topics[0], topicPath = join(root, topic.path);
  const raw = f.papers[0].resources.find(row => row.path.startsWith('Raw/'));
  const topicBytes = (await readFile(topicPath, 'utf8')).replace('<!-- AUTO:END sources -->',
    '\n[Direct evidence](../../' + raw.path + '#page=1)\n<!-- AUTO:END sources -->') + '\nMy topic note ^topic-private\n';
  await writeFile(topicPath, topicBytes);
  const original = await readFile(join(root, raw.path));
  const first = 'Clippings/registered.pdf', second = 'Clippings/renamed (copy).pdf';
  await mkdir(join(root, 'Clippings'));
  await writeFile(join(root, first), original);
  const args = { vaultRoot: root, runId: 'repair-topic-source' };
  const row = { sha256: raw.sha256, byte_length: raw.byte_length };
  const apply = async (old_path, new_path, generation) => {
    const review = await buildNoteRelocationReview({ ...args, generation, assetMappings: [{ ...row, old_path, new_path }] });
    const { plan } = await dryRunBilingualPublication({ vaultRoot: root, run: args.runId, review });
    const authority = await readingFirstPublicationAuthority({ ...f, runId: args.runId }, plan);
    const result = await applyBilingualPublication({ vaultRoot: root, run: args.runId, plan, ...authority });
    assert.equal(result.status, 'committed');
    assert.deepEqual(result.cleanup_warnings ?? [], []);
    return plan;
  };
  await apply(raw.path, first, 'topic-clippings-migration');
  await rename(join(root, first), join(root, second));
  await writeFile(join(root, second), 'Changed bytes');
  await assert.rejects(buildNoteRelocationReview({ ...args, generation: 'invalid-recovery', assetMappings: [{ ...row, old_path: first, new_path: second }] }),
    /P22_RELOCATION_COMMITTED_REQUIRED/);
  await writeFile(join(root, second), original);
  const repaired = await apply(first, second, 'topic-clippings-recovery');
  assert.ok(!repaired.read_dependencies.some(entry => entry.path === first));
  assert.ok(repaired.read_dependencies.some(entry => entry.path === second));
  assert.ok(!repaired.inventory.some(entry => entry.path === second));
  const current = await readCommittedGeneration({ vaultRoot: root });
  assert.equal(current.ok, true, JSON.stringify(current.errors));
  const nextTopic = current.generation.topics[0];
  assert.notEqual(nextTopic.managed_hash, topic.managed_hash);
  assert.deepEqual({ ...nextTopic, managed_hash: topic.managed_hash }, topic);
  const edited = await readFile(topicPath, 'utf8');
  assert.ok(edited.includes('../../Clippings/renamed%20%28copy%29.pdf'));
  assert.equal(edited, relocateNoteLinks(topicBytes, topic.path, topic.path, [[raw.path, second]]));
  const touched = current.generation.papers.find(paper => paper.paper_id === f.papers[0].paperId);
  const unrelated = current.generation.papers.find(paper => paper.paper_id === f.papers[1].paperId);
  const sidecar = JSON.parse(await readFile(join(root, touched.reader_presentation.path)));
  assert.equal(sidecar.citation.sources[0].path, second);
  for (const old of [raw.path, first]) assert.equal(sidecar.path_migration.assets.find(entry => entry.old_path === old).new_path, second);
  assert.deepEqual(unrelated.reader_presentation, before.generation.papers.find(paper => paper.paper_id === unrelated.paper_id).reader_presentation);
});
