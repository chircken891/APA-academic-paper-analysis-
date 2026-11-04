import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readingFirstIndexFixture, saveReadingFirstPair } from './helpers/reading-first-index-fixtures.mjs';
import { buildBilingualIndex } from '../../scripts/v3/phase22-search.mjs';
import { libraryInventory, libraryLandscape, libraryDossier, libraryClues, extractPaperModules, linkedPaths } from '../../scripts/v3/library-map.mjs';

async function fixture(t) {
  const f = await readingFirstIndexFixture(t);
  await f.save(await f.build());
  return f;
}
test('map deduplicates language views and exposes registered isolated methods and stable Canvas', async t => {
  const f = await fixture(t);
  const inventory = await libraryInventory(f);
  assert.equal(inventory.papers.length, 1);
  assert.equal(inventory.papers[0].shared_nodes.length, 1);
  assert.equal(inventory.papers[0].modules['6'].status, 'not_found');
  assert.match(inventory.papers[0].sha256, /^sha256:/);
  const map = await libraryLandscape({ ...f, canvas: true });
  assert.equal(map.isolated_methods.length, 1);
  assert.equal(map.isolated_methods[0].paper_count, 1);
  assert.equal(map.shared_nodes.length, 0);
  assert.equal(map.canvas.edges.length, 1);
  assert.deepEqual(map, await libraryLandscape({ ...f, canvas: true }));
});
test('dossier resolves aliases and clues keep linked paper modules', async t => {
  const f = await fixture(t);
  const dossier = await libraryDossier({ ...f, node: 'SyntheticRateAlias' });
  assert.equal(dossier.papers.length, 1);
  assert.ok(dossier.papers[0].sections.length);
  const clues = await libraryClues({ ...f, from: f.identity.paper_id, canvas: true });
  assert.equal(clues.adjacent_nodes.length, 1);
  assert.equal(clues.papers.length, 1);
  assert.equal(clues.canvas.edges.length, 1);
  const questionClues = await libraryClues({ ...f, from: { kind: 'question', value: 'finalresultneedle' } });
  assert.ok(questionClues.seed_papers.includes(f.identity.paper_id));
  assert.equal((await libraryDossier({ ...f, node: 'absent node' })).status, 'no_matches');
  assert.equal((await libraryClues({ ...f, from: 'unmatchedquestionneedle' })).status, 'no_matches');
});
test('module extraction uses numbered modules and retains design after research map', () => {
  const sections = [
    { anchor: '2. Research question and design', content: '## 2. Research question and design' },
    { anchor: '2.1 Research map', content: 'map' },
    { anchor: '2.2 Study design', content: 'design paragraph' },
    { anchor: '5. Discussion', content: 'discussion' },
    { anchor: '5.1 Alternative explanations', content: 'alternative' },
    { anchor: 'Figures and tables', content: 'figures' },
  ];
  const modules = extractPaperModules({ sections, sha256: 'sha256:example' }, 'Wiki/sources/example.md');
  assert.equal(modules['2'].sections.length, 3);
  assert.equal(modules['5'].sections.length, 2);
  assert.equal(modules['7'].status, 'not_found');
});
test('map distinguishes absent commit, empty library and unreadable current notes', async t => {
  const vaultRoot = await mkdtemp(join(tmpdir(), 'apa-map-'));
  t.after(() => rm(vaultRoot, { recursive: true, force: true }));
  assert.equal((await libraryInventory({ vaultRoot })).status, 'not_ready');
  const generation = { schema_version: 'phase22/active-index-1.0', kind: 'active', generation_id: 'empty-map', evidence_mode: 'synthetic', papers: [], shared_nodes: [], objects: [] };
  const built = await buildBilingualIndex({ generation, validatedInputs: { papers: [], files: [] } });
  await saveReadingFirstPair(vaultRoot, built.generation, built.index);
  assert.equal((await libraryLandscape({ vaultRoot })).status, 'empty_library');
  const f = await fixture(t);
  await writeFile(join(f.vaultRoot, f.paper.paths.en), 'unreadable frontmatter');
  const result = await libraryInventory(f);
  assert.equal(result.status, 'partial');
  assert.equal(result.papers.length, 1);
  assert.equal(result.papers[0].path, f.paper.paths['zh-CN']);
  assert.ok(result.diagnostics.length);
});
test('two registered studies share one node once and form one stable theme', async t => {
  const a = await readingFirstIndexFixture(t, { suffix: 'a' });
  const b = await readingFirstIndexFixture(t, { suffix: 'b', vaultRoot: a.vaultRoot });
  const unique = rows => [...new Map(rows.map(row => [row.path, row])).values()];
  const generation = { ...a.generation, generation_id: 'two-study-map', papers: [a.paper, b.paper],
    shared_nodes: unique([...a.generation.shared_nodes, ...b.generation.shared_nodes]),
    objects: unique([...a.generation.objects, ...b.generation.objects]) };
  const files = unique([...a.files, ...b.files]);
  const built = await buildBilingualIndex({ generation,
    validatedInputs: { papers: [...a.validatedInputs.papers, ...b.validatedInputs.papers], files } });
  await a.save(await a.build());
  await b.save(await b.build());
  await saveReadingFirstPair(a.vaultRoot, built.generation, built.index);
  const shared = await libraryLandscape({ vaultRoot: a.vaultRoot });
  assert.equal(shared.papers.length, 2);
  assert.equal(shared.shared_nodes.length, 1);
  assert.equal(shared.shared_nodes[0].paper_count, 2);
  assert.equal(shared.themes.length, 1);
  assert.equal(shared.similarities[0].similarity, 1);
  assert.equal(shared.isolated_methods.length, 0);
});


test('shared link paths resolve relative URL-encoded Markdown and vault wikilinks alike', () => {
  const target = 'Wiki/methods/共享方法';
  assert.deepEqual([...linkedPaths('[method](../methods/%E5%85%B1%E4%BA%AB%E6%96%B9%E6%B3%95.md#details)', 'Wiki/sources/paper.md')], [target]);
  assert.deepEqual([...linkedPaths('[[Wiki/methods/共享方法|method]]', 'Wiki/sources/paper.md')], [target]);
});
