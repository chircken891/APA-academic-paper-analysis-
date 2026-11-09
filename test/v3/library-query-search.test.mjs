import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import YAML from 'yaml';
import { readingFirstIndexFixture, saveReadingFirstPair, digest } from './helpers/reading-first-index-fixtures.mjs';
import { createTopicFixture, publishTopicFixture } from './helpers/topic-fixtures.mjs';
import { queryLibrary } from '../../scripts/v3/library-query.mjs';
import { getTopicUpdateHints } from '../../scripts/v3/topic-library.mjs';
import { fingerprintV3Json as hash } from '../../scripts/v3/semantic-package-validator.mjs';
import { researchMapCanvasSection } from '../../scripts/v3/research-map-canvas.mjs';
import { normalizeQueryTerm, tokenizeQueryText, expandQueryGroups, definedAcronymNodes } from '../../scripts/lib/query-terms.mjs';
import { paperSourcePath } from '../../scripts/lib/paper-note-path.mjs';

async function fixture(t, { suffix, vaultRoot, locators = [] } = {}) {
  const f = await readingFirstIndexFixture(t, { suffix, vaultRoot });
  const original = f.files.find(row => row.path.startsWith('Raw/'));
  f.manifest.citation = { bibliography: { title: { en: 'Synthetic tumor study' }, first_author: 'Synthetic', year: 2026 }, sources: [{ source_id: 'paper', path: original.path, sha256: digest(original.bytes), byte_length: original.bytes.length, source_version: null, locators }] };
  const sidecar = f.files.find(row => row.kind === 'reader-presentation');
  sidecar.bytes = Buffer.from(JSON.stringify(f.manifest));
  f.paper.reader_presentation.sha256 = digest(sidecar.bytes);
  f.generation.objects.find(row => row.path === sidecar.path).sha256 = digest(sidecar.bytes);
  await f.save(await f.build());
  return f;
}
async function mergeFixtures(root, parts) {
  const generation = { ...parts[0].generation };
  const combine = (key, id) => [...new Map(parts.flatMap(part => part.generation[key].map(row => [row[id], row]))).values()];
  generation.papers = combine('papers', 'paper_id');
  generation.shared_nodes = combine('shared_nodes', 'entity_id');
  generation.objects = combine('objects', 'path');
  generation.index_manifest = combine('index_manifest', 'id');
  const index = { ...parts[0].index, active_fingerprint: hash(generation), documents: parts.flatMap(part => part.index.documents) };
  await saveReadingFirstPair(root, generation, index);
}
async function edit(f, path, fn) {
  const raw = await readFile(join(f.vaultRoot, path), 'utf8');
  const personal = raw.indexOf('## Personal Notes');
  await writeFile(join(f.vaultRoot, path), personal < 0 ? fn(raw) : fn(raw.slice(0, personal)) + '\n' + raw.slice(personal));
}

test('word segmentation retains Chinese words and indexes supplemental characters without splitting query concepts', () => {
  assert.ok(tokenizeQueryText('肥胖相关的米色脂肪产热').includes('肥胖'));
  assert.ok(!tokenizeQueryText('肥胖').includes('肥'));
  assert.ok(tokenizeQueryText('肥胖', { supplemental: true }).includes('肥'));
  assert.deepEqual(tokenizeQueryText('肥胖 obesity风险'), ['肥胖', 'obesity', '风险']);
});

test('American and British spelling, common plurals and inflections normalize identically', () => {
  for (const forms of [['tumour', 'tumor', 'tumours', 'tumors'], ['driver', 'drivers'], ['study', 'studies', 'studying', 'studied'],
    ['haematology', 'hematology'], ['oesophagus', 'esophagus'], ['normalisation', 'normalization'], ['signal', 'signaling', 'signalling'],
    ['analysis', 'analyses'], ['use', 'used', 'using'], ['analyse', 'analyze', 'analysed', 'analyzed', 'analysing', 'analyzing']]) {
    assert.equal(new Set(forms.map(normalizeQueryTerm)).size, 1, forms.join(' / '));
  }
});
test('source language wins when both historical language paths are in sources', () => {
  const paths = { en: 'Wiki/sources/p.en.md', 'zh-CN': 'Wiki/sources/p.zh.md' };
  assert.equal(paperSourcePath({ paths, source_language: 'zh-CN' }), paths['zh-CN']);
  assert.equal(paperSourcePath({ paths, source_language: 'en' }), paths.en);
  assert.equal(paperSourcePath({ paths }), paths['zh-CN']);
});

test('alias concepts are alternatives within groups and independent concepts remain separate', () => {
  const { groups, expandedTerms } = expandQueryGroups('肥胖 风险', [{ entity_id: 'obesity', aliases: ['肥胖', 'obesity', 'BMI'] }, { entity_id: 'risk', aliases: ['风险', 'risk'] }]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].terms, [['肥胖'], ['obesity'], ['bmi']]);
  assert.equal(expandedTerms.length, 2);
  assert.equal(expandQueryGroups('riskless', [{ entity_id: 'risk', aliases: ['risk', '风险'] }]).expandedTerms.length, 0);
});

test('search expands registered current aliases and requires a second concept with minResults one', async t => {
  const f = await fixture(t);
  const node = f.generation.shared_nodes[0];
  await edit(f, node.path, raw => raw.replace(/^---\r?\n([\s\S]*?)\r?\n---/, (_, fm) => '---\n' + YAML.stringify({ ...YAML.parse(fm), aliases: ['肥胖', 'obesity', 'BMI'] }) + '---'));
  await edit(f, f.paper.paths.en, raw => raw + '\n## 4. Observations\nObesity risk was observed.\n');
  const found = await queryLibrary({ vaultRoot: f.vaultRoot, query: '肥胖 risk', minResults: 1, full: true });
  assert.equal(found.match_mode, 'all');
  assert.equal(found.results.length, 1);
  assert.ok(found.results[0].hits.some(row => row.text.includes('Obesity risk')));
  assert.ok(found.expanded_terms.some(row => row.aliases.includes('obesity')));
  const missed = await queryLibrary({ vaultRoot: f.vaultRoot, query: '肥胖 completelymissing', minResults: 1 });
  assert.equal(missed.match_mode, 'any');
  assert.equal(missed.results.length, 1);
});

test('long-sentence fallback, spelling parity and source language path preserve current fingerprints', async t => {
  const f = await fixture(t);
  await edit(f, f.paper.paths.en, raw => raw + '\n## 4. Tumor drivers\nTumor drivers are studied.\n');
  const forms = await Promise.all(['tumour', 'tumor', 'tumours', 'tumors'].map(query => queryLibrary({ vaultRoot: f.vaultRoot, query })));
  assert.equal(new Set(forms.map(row => JSON.stringify(row.results.map(paper => paper.paper_id)))).size, 1);
  const sentence = await queryLibrary({ vaultRoot: f.vaultRoot, query: 'Explain the tumor drivers across unreported longitudinal populations' });
  assert.equal(sentence.match_mode, 'any');
  assert.equal(sentence.results.length, 1);
  assert.ok(sentence.results[0].path.startsWith('Wiki/sources/'));
  assert.equal(sentence.results[0].alternate_paths.length, 1);
  assert.ok(sentence.results[0].hits.every(row => row.sha256.startsWith('sha256:')));
});

test('entity, numbered module, year and paper filters use the registered inventory', async t => {
  const f = await fixture(t);
  await edit(f, f.paper.paths.en, raw => raw + '\n## 4. Findings\nfilteredneedle appears here.\n## 6. Limits\nfilteredneedle needs caution.\n');
  const base = { vaultRoot: f.vaultRoot, query: 'filteredneedle' };
  const found = await queryLibrary({ ...base, filters: { entityTypes: ['paper'], modules: [4], yearFrom: 2025, yearTo: 2027, paperIds: [f.identity.paper_id] } });
  assert.equal(found.results.length, 1);
  assert.ok(found.results[0].hits.every(row => row.anchor.startsWith('4.')));
  assert.equal((await queryLibrary({ ...base, filters: { yearTo: 2025 } })).results.length, 0);
  assert.equal((await queryLibrary({ ...base, filters: { paperIds: ['missing'] } })).results.length, 0);
  const nodes = await queryLibrary({ vaultRoot: f.vaultRoot, query: 'sharedknowledgeneedle', filters: { entityTypes: ['method'] } });
  assert.equal(nodes.results[0].entity_type, 'method');
  assert.equal(nodes.results[0].entity_id, f.generation.shared_nodes[0].entity_id);
  assert.equal((await queryLibrary({ vaultRoot: f.vaultRoot, query: 'sharedknowledgeneedle', filters: { entityTypes: ['concept'] } })).results.length, 0);
});

test('snippet, per-paper and complete JSON budget are bounded while full retains original text', async t => {
  const f = await fixture(t);
  await edit(f, f.paper.paths.en, raw => raw + Array.from({ length: 40 }, (_, i) => '\n## 4.' + i + ' Large hit\nbudgetneedle ' + '汉字内容'.repeat(1000)).join('\n'));
  const base = { vaultRoot: f.vaultRoot, query: 'budgetneedle' };
  const bounded = await queryLibrary({ ...base, limit: 1, hitsPerPaper: 2, snippetChars: 20 });
  assert.equal(bounded.results.length, 1);
  assert.equal(bounded.results[0].hits.length, 2);
  assert.ok(bounded.results[0].hits.every(hit => [...hit.text].length <= 20));
  assert.ok(Buffer.byteLength(JSON.stringify(bounded, null, 2)) <= 32768);
  assert.equal(bounded.truncated, true);
  const full = await queryLibrary({ ...base, full: true });
  assert.equal(full.results[0].hits.length, 40);
  assert.ok(full.results[0].hits[0].text.length > 400);
  const oversized = await queryLibrary({ ...base, limit: 100, hitsPerPaper: 100, snippetChars: 10000 });
  assert.ok(Buffer.byteLength(JSON.stringify(oversized, null, 2)) <= 32768);
});

test('default result budget compacts bilingual citation locators before shortening snippets or losing papers', async t => {
  const locators = Array.from({ length: 25 }, (_, page) => ({ kind: 'figure', id: `figure-${page + 1}`, page: page + 1,
    label: { en: 'Registered evidence figure', 'zh-CN': '已登记证据图' } }));
  const first = await fixture(t, { locators });
  const papers = [first];
  for (const suffix of 'bcdef0123') papers.push(await fixture(t, { suffix, vaultRoot: first.vaultRoot, locators }));
  await mergeFixtures(first.vaultRoot, await Promise.all(papers.map(paper => paper.build())));
  const found = await queryLibrary({ vaultRoot: first.vaultRoot, query: 'finalresultneedle' });
  assert.equal(found.total_results, 10);
  assert.equal(found.results.length, 10);
  assert.equal(found.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(found, null, 2)) <= 32768);
  for (const result of found.results) {
    const registered = papers.find(paper => paper.identity.paper_id === result.paper_id).manifest.citation.sources[0];
    const { locators, ...identity } = registered;
    assert.equal(result.citation.locators_omitted, true);
    assert.deepEqual(result.citation.sources[0], { ...identity, locator_count: locators.length, status: 'identity_verified', locator_status: 'available' });
    assert.equal(result.hits[0].text_truncated, false);
  }
});

test('topic hints include a changed paper whose own note falls below the default result limit', async t => {
  const topic = await createTopicFixture(t, { topicTitle: 'rankneedle', queryTerms: ['rankneedle'] });
  const original = await publishTopicFixture(topic);
  const parts = [original];
  for (const suffix of 'cdef012345') {
    const paper = await fixture(t, { suffix, vaultRoot: topic.vaultRoot });
    parts.push(await paper.build());
    await edit(paper, paper.paper.paths.en, raw => raw + '\n## rankneedle\n' + 'rankneedle '.repeat(15) + '\n');
  }
  const changed = topic.papers[1].paperId;
  await edit(topic, original.generation.papers.find(paper => paper.paper_id === changed).paths.en,
    raw => raw + '\n## Additional observations\n' + 'Context for the study. '.repeat(50) + 'rankneedle\n');
  await mergeFixtures(topic.vaultRoot, parts);
  const query = { vaultRoot: topic.vaultRoot, query: 'rankneedle' };
  const bounded = await queryLibrary(query);
  assert.ok(bounded.total_results > 10);
  assert.ok(!bounded.results.some(group => group.paper_id === changed));
  assert.ok((await queryLibrary({ ...query, full: true })).results.some(group => group.paper_id === changed));
  const hints = await getTopicUpdateHints({ vaultRoot: topic.vaultRoot, generationId: original.generation_id, changedPaperIds: [changed] });
  assert.ok(hints.hints.some(hint => hint.source?.paper_id === changed && hint.matched_terms.includes('rankneedle')));
});

test('topic hints require the whole term in the changed paper note, not its split query pieces', async t => {
  const topic = await createTopicFixture(t, { topicTitle: '年龄标化', queryTerms: ['年龄标化'] });
  const original = await publishTopicFixture(topic);
  const changed = topic.papers[1].paperId;
  const path = original.generation.papers.find(paper => paper.paper_id === changed).paths.en;
  const termHints = async () => (await getTopicUpdateHints({ vaultRoot: topic.vaultRoot, generationId: original.generation_id, changedPaperIds: [changed] }))
    .hints.filter(hint => hint.source?.paper_id === changed && hint.matched_terms.includes('年龄标化'));
  await edit(topic, path, raw => raw + '\n## Cohort description\n按年龄分组，再标记样本，比较变化。\n');
  assert.deepEqual(await termHints(), []);
  await edit(topic, path, raw => raw + '\n## Rates\n报告了年龄标化发病率。\n');
  assert.ok((await termHints()).length > 0);
});

test('year filters verify each applicable presentation once per query including failures', async t => {
  const valid = await fixture(t);
  const invalid = await fixture(t, { suffix: 'b', vaultRoot: valid.vaultRoot });
  await mergeFixtures(valid.vaultRoot, await Promise.all([valid.build(), invalid.build()]));
  await writeFile(join(valid.vaultRoot, invalid.paper.reader_presentation.path), 'invalid presentation bytes');
  const paths = [valid, invalid].map(paper => join(valid.vaultRoot, paper.paper.reader_presentation.path));
  const counts = new Map(paths.map(path => [path, 0]));
  const read = fs.readFileSync;
  let countVerification = false;
  t.mock.method(fs, 'readFileSync', (path, ...options) => {
    if (countVerification && counts.has(path)) counts.set(path, counts.get(path) + 1);
    return read(path, ...options);
  });
  syncBuiltinESMExports();
  try {
    const filtered = await queryLibrary({ vaultRoot: valid.vaultRoot, query: 'finalresultneedle', filters: { yearFrom: 2026, yearTo: 2026 },
      onReadBoundary: phase => { countVerification = phase === 'after-objects'; } });
    assert.deepEqual(filtered.results.map(result => result.paper_id), [valid.identity.paper_id]);
    assert.deepEqual([...counts.values()], [1, 1]);
    countVerification = false;
    const earlier = await queryLibrary({ vaultRoot: valid.vaultRoot, query: 'finalresultneedle', filters: { yearTo: 2025 },
      onReadBoundary: phase => { countVerification = phase === 'after-objects'; } });
    assert.equal(earlier.results.length, 0);
    assert.deepEqual([...counts.values()], [2, 2]);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('generated research map directions leave search while manual text in the same section stays searchable', async t => {
  const f = await fixture(t);
  const path = f.paper.paths.en;
  const canvasPath = `Figures/${f.identity.run_id}/research-map.en.canvas`;
  const generated = researchMapCanvasSection({ canvasPath, language: 'en' });
  await edit(f, path, raw => `${raw}\n### 2.1 Research map\n\n${generated}\n`);
  const query = { vaultRoot: f.vaultRoot, full: true };
  assert.equal((await queryLibrary({ ...query, query: 'research map canvas' })).status, 'no_matches');
  const file = join(f.vaultRoot, path);
  const raw = await readFile(file, 'utf8');
  await writeFile(file, raw.replace(generated, `${generated}\n\nManualmapneedle records why the selection matters.`));
  const hit = (await queryLibrary({ ...query, query: 'manualmapneedle' })).results[0].hits[0];
  assert.equal(hit.anchor, '2.1 Research map');
  assert.match(hit.text, /Manualmapneedle/);
  assert.ok(!hit.text.includes(generated));
  await writeFile(file, raw.replace(generated, generated.replace('640', '641')));
  const changed = await queryLibrary({ ...query, query: 'research map canvas' });
  assert.ok(changed.results[0].hits.some(row => row.text.includes('|641]]')));
});

test('invalid options and filter ranges fail explicitly', async () => {
  for (const settings of [{ limit: 0 }, { snippetChars: -1 }, { full: 'true' }, { filters: { modules: [8] } }, { filters: { entityTypes: ['unknown'] } }, { filters: { yearFrom: 2026, yearTo: 2025 } }]) {
    await assert.rejects(queryLibrary({ vaultRoot: '.', query: 'test', ...settings }), /P23_SEARCH_/);
  }
});

test('BMI finds an expanded long form from explicit definitions in registered current notes', async t => {
  const f = await fixture(t);
  await edit(f, f.paper.paths.en, raw => raw + '\n## 4. Architecture\nThe body mass index with HDL is correlated.\n');
  await edit(f, f.generation.shared_nodes[0].path, raw => raw.replace('Only sharedknowledgeneedle', 'Mean body mass index (BMI). Only sharedknowledgeneedle'));
  const found = await queryLibrary({ vaultRoot: f.vaultRoot, query: 'BMI', full: true });
  assert.ok(found.results[0].hits.some(hit => hit.path === f.paper.paths.en && hit.text.includes('body mass index')));
  assert.ok(found.expanded_terms.some(row => row.aliases.includes('body mass index')));
});

test('explicit acronym aliases exclude mismatched parentheses, single letters and ordinary short words', () => {
  const nodes = definedAcronymNodes([{content: 'body mass index (BMI). assay (A). concentration (high). randomized trial (BMI). body mass index (bmi).'}]);
  assert.deepEqual(nodes, [{entity_id: 'defined-acronym:BMI', aliases: ['BMI', 'body mass index']}]);
});

test('explicit acronyms require uppercase triggers and reject ambiguous long forms', () => {
  const nodes = definedAcronymNodes([{ content: 'odds ratio (OR). conditioned medium (CM). brown adipose tissue (BAT). body mass index (BMI). body mass indices (BMI). brown adipose tissues (BAT). computed tomography (CT). C-terminal (CT).' }]);
  for (const query of ['obesity or BMI', 'tumour size in cm', 'fruit bat']) {
    assert.ok(!expandQueryGroups(query, nodes).expandedTerms.some(row => ['defined-acronym:OR', 'defined-acronym:CM', 'defined-acronym:BAT'].includes(row.node_id)));
  }
  for (const query of ['BMI', 'body mass index', 'body mass indices', 'BAT']) assert.equal(expandQueryGroups(query, nodes).expandedTerms.length, 1);
  const ambiguous = expandQueryGroups('computed tomography', nodes);
  assert.equal(ambiguous.expandedTerms.length, 0);
  assert.ok(ambiguous.diagnostics.some(row => row.code === 'ambiguous_acronym' && row.full_forms.includes('c terminal')));
});


test('defined full forms compare normalized words in order including plural GWAS and PRS', () => {
  const nodes = definedAcronymNodes([{ content: 'genome wide association study (GWAS). genome wide association studies (GWAS). polygenic risk score (PRS). polygenic risk scores (PRS).' }]);
  for (const query of ['GWAS', 'PRS', 'genome wide association studies', 'polygenic risk scores']) assert.equal(expandQueryGroups(query, nodes).expandedTerms.length, 1);
  const single = definedAcronymNodes([{ content: 'body mass index (BMI).' }]);
  assert.equal(expandQueryGroups('body mass indices', single).expandedTerms.length, 1);
});
