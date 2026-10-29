import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readingFirstViewsFingerprint } from '../../scripts/v3/reading-first-editor.mjs';
import { exportReadingFirstPreview } from '../../scripts/v3/reading-first-preview.mjs';
import { readingFirstIndexFixture } from './helpers/reading-first-index-fixtures.mjs';
import { readCommittedReadingFirstKnowledgeRegistry } from '../../scripts/v3/reading-first-knowledge-registry.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reading-first-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pdf = Buffer.from('%PDF synthetic source');
  const source = path.join(root, 'source.pdf'); await writeFile(source, pdf);
  return { outputRoot: path.join(root, 'preview'), identity: { paper_id: 'pap_' + 'a'.repeat(32) },
    views: ['en', 'zh-CN'].map(language => ({ language, sections: [{ id: 'methods', heading: 'Methods', paragraphs: ['A complete explanation.'] }] })),
    presentation: { schema_version: 'reading-first-obsidian-1.0', bibliography: { title: 'A study', first_author: 'Smith', year: 2024 }, source_pdf: 'Raw/paper.pdf', sections: [{ id: 'methods' }],
      visuals: [{ id: 'figure', kind: 'figure', label: { en: 'Figure 1', 'zh-CN': '图1' }, caption: { en: 'Caption.', 'zh-CN': '图注。' }, path: 'Figures/figure.png', page: 1, section_id: 'methods' }],
      knowledge: [{ id: 'rate', kind: 'method', title: { en: 'Rate', 'zh-CN': '率' }, source_kind: 'method-background', paragraphs: { en: ['Background.'], 'zh-CN': ['背景。'] }, placements: [{ section_id: 'methods' }] }] },
    resources: [{ path: 'Raw/paper.pdf', source_path: source, sha256: digest(pdf), byte_length: pdf.length }, { path: 'Figures/figure.png', content: 'synthetic image' }] };
}

test('exports a self-contained bilingual package with source bytes, shared notes and pending acceptance', async t => {
  const input = await fixture(t);
  const result = await exportReadingFirstPreview(input);
  assert.equal(result.notes.length, 2); assert.equal(result.supportNotes.length, 2);
  assert.equal(result.validation.status, 'passed');
  assert.equal(result.manifest.review.overall, 'pending');
  assert.equal(result.manifest.review.native_obsidian, 'not_run');
  for (const file of result.manifest.files) {
    const bytes = await readFile(path.join(input.outputRoot, file.path));
    assert.equal(digest(bytes), file.sha256); assert.equal(bytes.length, file.byte_length);
  }
  const recorded = JSON.parse(await readFile(path.join(input.outputRoot, '.apa-v3/presentation.json'), 'utf8'));
  assert.deepEqual(recorded.targetRegistry, result.targetRegistry);
  await assert.rejects(exportReadingFirstPreview(input), { code: 'RF_PREVIEW_OUTPUT_EXISTS' });
});

test('exports one unified bilingual knowledge file with valid language, chart and common-source anchors', async t => {
  const data = await fixture(t);
  data.presentation.knowledge_layout = 'shared-bilingual-1.0';
  data.presentation.knowledge[0].sources = [{ id: 'who', title: 'WHO', url: 'https://www.who.int/' }];
  data.presentation.visuals[0].chart_types = [{ knowledge_id: 'rate', panel: 'A', label: { en: 'Rate plot', 'zh-CN': '率图' } }];
  data.presentation.visuals[0].crop = { source_sha256: 'b'.repeat(64), page: 1, bbox: [5, 10, 100, 200] };
  const result = await exportReadingFirstPreview(data);
  assert.equal(result.supportNotes.length, 1);
  assert.equal(result.supportNotes[0].path, 'Wiki/methods/率.md');
  assert.equal(result.validation.status, 'passed');
  assert.deepEqual(result.manifest.visual_resources[0].crop, data.presentation.visuals[0].crop);
  assert.match(result.notes[0].content, /\.md#English/);
  assert.match(result.notes[1].content, /\.md#%E4%B8%AD%E6%96%87/);
});

for (const [name, mutate, code] of [
  ['missing asset', input => { input.resources.pop(); }, 'RF_PREVIEW_LINK_UNRESOLVED'],
  ['corrupt asset digest', input => { input.resources[0].sha256 = '0'.repeat(64); }, 'RF_PREVIEW_RESOURCE_MISMATCH'],
  ['corrupt asset length', input => { input.resources[0].byte_length++; }, 'RF_PREVIEW_RESOURCE_MISMATCH'],
  ['escaping path', input => { input.resources[1].path = '../outside.png'; }, 'RF_PREVIEW_PATH_INVALID'],
  ['case collision', input => { input.resources.push({ path: 'figures/FIGURE.png', content: 'different' }); }, 'RF_PREVIEW_PATH_COLLISION'],
  ['manifest directory collision', input => { input.resources.push({ path: '.apa-v3', content: 'blocked' }); }, 'RF_PREVIEW_PATH_COLLISION'],
  ['missing block target', input => { input.views[0].sections[0].paragraphs.push('[Missing](#^missing)'); }, 'RF_PREVIEW_ANCHOR_UNRESOLVED'],
  ['absolute local link', input => { input.views[0].sections[0].paragraphs.push('[Bad](C:/private.pdf)'); }, 'RF_PREVIEW_LINK_INVALID'],
]) test(`preflights ${name} before creating output`, async t => {
  const input = await fixture(t); mutate(input);
  await assert.rejects(exportReadingFirstPreview(input), { code });
  await assert.rejects(access(input.outputRoot), { code: 'ENOENT' });
});

test('validates supplied wiki links and resolves existing knowledge snapshots without overwriting them', async t => {
  const input = await fixture(t);
  input.knowledgeRegistry = [{ id: 'rate', path: 'Wiki/methods/existing.md' }];
  input.resources.push({ path: 'Wiki/methods/existing.md', content: '# Existing\n\nExisting note. ^definition\n' });
  input.views[0].sections[0].paragraphs.push('[[Wiki/methods/existing#^definition|Rate]]');
  const result = await exportReadingFirstPreview(input);
  assert.equal(result.supportNotes.length, 0); assert.equal(result.knowledgeProposals.length, 2);
  assert.equal(await readFile(path.join(input.outputRoot, 'Wiki/methods/existing.md'), 'utf8'), '# Existing\n\nExisting note. ^definition\n');
});

test('trusted historical preview includes referenced knowledge and marks paper navigation as preview-only', async t => {
  const prior = await readingFirstIndexFixture(t), built = await prior.build();
  await prior.save(built);
  const registry = await readCommittedReadingFirstKnowledgeRegistry({ vaultRoot: prior.vaultRoot, policy: 'committed-shared-nodes-1.0' });
  const input = await fixture(t);
  input.views[0].sections[0].paragraphs.push(`[[${registry[0].path}#English|History]]`);
  input.knowledgeRegistry = registry;
  input.historicalKnowledge = { vaultRoot: prior.vaultRoot };
  const result = await exportReadingFirstPreview(input);
  const historical = result.manifest.files.find(row => row.path === registry[0].path);
  assert.equal(historical.kind, 'historical-reference');
  assert.equal(historical.publishable, false);
  assert.equal(historical.generation_id, prior.generation.generation_id);
  assert.equal(await readFile(path.join(input.outputRoot, registry[0].path), 'utf8'), registry[0].content);
  const nav = result.manifest.files.filter(row => row.kind === 'historical-navigation');
  assert.ok(nav.length > 0);
  assert.ok(nav.every(row => row.publishable === false));
  assert.match(await readFile(path.join(input.outputRoot, nav[0].path), 'utf8'), /未包含正文|not included/i);
  assert.ok(!result.supportNotes.some(row => row.path === registry[0].path));
});

test('historical preview rejects caller-created registry', async t => {
  const input = await fixture(t);
  input.historicalKnowledge = { vaultRoot: path.dirname(input.outputRoot) };
  await assert.rejects(exportReadingFirstPreview(input), { code: 'RF_KNOWLEDGE_REGISTRY_NOT_TRUSTED' });
  await assert.rejects(access(input.outputRoot), { code: 'ENOENT' });
});

test('historical knowledge self-links terminate and registered assets are verified', async t => {
  const prior = await readingFirstIndexFixture(t);
  const support = prior.files.find(row => row.kind === 'support');
  const asset = prior.files.find(row => row.kind === 'asset');
  support.bytes = Buffer.concat([support.bytes, Buffer.from(`\n[Self](./${path.posix.basename(support.path)}#English)\n\n![[${asset.path}]]\n`)]);
  prior.generation.objects.find(row => row.path === support.path).sha256 = 'sha256:' + digest(support.bytes);
  await prior.save(await prior.build());
  const registry = await readCommittedReadingFirstKnowledgeRegistry({ vaultRoot: prior.vaultRoot, policy: 'committed-shared-nodes-1.0' });
  const input = await fixture(t);
  input.views[0].sections[0].paragraphs.push(`[[${support.path}#English|History]]`);
  input.knowledgeRegistry = registry;
  input.historicalKnowledge = { vaultRoot: prior.vaultRoot };
  const result = await exportReadingFirstPreview(input);
  assert.equal(result.manifest.files.filter(row => row.path === support.path).length, 1);
  const copied = result.manifest.files.find(row => row.path === asset.path);
  assert.equal(copied.kind, 'historical-asset');
  assert.equal(copied.publishable, false);
  assert.deepEqual(await readFile(path.join(input.outputRoot, asset.path)), asset.bytes);
  await writeFile(path.join(prior.vaultRoot, asset.path), 'changed');
  input.outputRoot += '-invalid';
  await assert.rejects(exportReadingFirstPreview(input), error => error.code === 'RF_PREVIEW_HISTORICAL_RESOURCE_UNAVAILABLE'
    && error.details.path === asset.path && error.details.source === support.path);
  await assert.rejects(access(input.outputRoot), { code: 'ENOENT' });
});

test('a merged candidate takes precedence over a historical reference to the same node', async t => {
  const prior = await readingFirstIndexFixture(t);
  await prior.save(await prior.build());
  const registry = await readCommittedReadingFirstKnowledgeRegistry({ vaultRoot: prior.vaultRoot, policy: 'committed-shared-nodes-1.0' });
  const input = await fixture(t);
  input.presentation.knowledge_layout = 'shared-bilingual-1.0';
  input.presentation.knowledge[0].canonical_key = registry[0].canonical_key;
  input.knowledgeRegistry = registry;
  input.historicalKnowledge = { vaultRoot: prior.vaultRoot };
  const result = await exportReadingFirstPreview(input);
  const row = result.manifest.files.find(file => file.path === registry[0].path);
  assert.equal(row.kind, 'knowledge-candidate');
  assert.equal(result.supportNotes.filter(note => note.path === registry[0].path).length, 1);
  assert.match(await readFile(path.join(input.outputRoot, row.path), 'utf8'), /Only sharedknowledgeneedle/);
});

test('exports the fingerprint-bound editor layout and validates its numbered heading links', async t => {
  const input = await fixture(t);
  const ids = ['abstract', 'design', 'methods', 'findings', 'discussion', 'limitations', 'conclusion'];
  input.presentation.layout = 'writer-modules-1.0';
  input.presentation.modules = ids.map(id => ({ id, label: id }));
  input.views.forEach(view => {
    view.sections = ids.map(id => ({ id, module_id: id, heading: id + ' explanation', paragraphs: ['A complete explanation.'] }));
    view.placements = { visuals: [{ id: 'figure', section_id: 'findings', after_paragraph: 0 }], knowledge: [{ id: 'rate', section_id: 'methods', after_paragraph: 0 }] };
  });
  input.readingEditor = { schema_version: 'reading-editor-1.0', views_fingerprint: readingFirstViewsFingerprint(input.views), languages: Object.fromEntries(input.views.map(view => [view.language, {
    overview: [{ text: 'A useful reading overview.', section_ids: ['findings'] }],
    sections: [{ section_id: 'findings', takeaway: 'A meaningful finding.', emphasis: [{ paragraph_index: 0, text: 'complete explanation' }], subheadings: [] }],
    methods: [{ id: 'rate', title: 'Rate', explanation: 'A general measure.', application: 'The paper compares this measure.', section_ids: ['methods'], knowledge_id: 'rate' }],
  }])) };
  const result = await exportReadingFirstPreview(input);
  const content = await readFile(path.join(input.outputRoot, result.notes[0].path), 'utf8');
  assert.match(content, /## Reading overview/);
  assert.match(content, /### 3\.1 Methods and concepts at a glance/);
  assert.match(content, /A \*\*complete explanation\*\*\./);
  assert.equal(result.validation.status, 'passed');
  assert.equal(result.validation.native_obsidian, 'not_run');
});
