import assert from 'node:assert/strict';
import test from 'node:test';
import { readingFirstViewsFingerprint } from '../../scripts/v3/reading-first-editor.mjs';
import { renderReadingFirstObsidian } from '../../scripts/v3/reading-first-obsidian.mjs';

function input({ compact = false } = {}) {
  const ids = ['abstract', 'design', 'methods', 'findings', 'discussion', 'limitations', 'conclusion'];
  const views = ['en', 'zh-CN'].map(language => ({ language,
    sections: ids.map(id => ({ id, module_id: id, heading: id, paragraphs: ['A reading paragraph.'] })),
    placements: { visuals: [{ id: 'fig-1', section_id: 'findings', after_paragraph: 0 }],
      knowledge: [{ id: 'rate', section_id: 'methods', after_paragraph: 0 }] },
  }));
  const presentation = { schema_version: 'reading-first-obsidian-1.0', layout: 'writer-modules-1.0',
    knowledge_layout: 'shared-bilingual-1.0',
    bibliography: { title: 'A study', first_author: 'Smith', year: 2024 }, source_pdf: 'Raw/paper.pdf',
    sources: [{ id: 'main', path: 'Raw/paper.pdf' }, { id: 'supplementary', path: 'Raw/supplement.pdf' }],
    modules: ids.map(id => ({ id, label: { en: id, 'zh-CN': id } })),
    visuals: [{ id: 'fig-1', kind: 'figure', label: { en: 'Figure 1', 'zh-CN': '图1' },
      caption: { en: 'Original caption.', 'zh-CN': '原始图注。' }, path: 'Figures/paper/fig1.png', page: 5,
      source_id: 'supplementary', chart_types: [{ knowledge_id: 'rate', panel: 'whole figure', label: { en: 'Rate plot', 'zh-CN': '率图' } }] }],
    knowledge: [{ id: 'rate', kind: 'method', canonical_key: 'rate', title: { en: 'Rate', 'zh-CN': '率' },
      aliases: [], paragraphs: { en: ['English background.'], 'zh-CN': ['中文背景。'] }, source_kind: 'method-background' }],
    map: { steps: [], findings: [], relations: [] },
  };
  const data = { identity: { paper_id: 'pap_' + 'a'.repeat(32) }, views, presentation };
  if (compact) data.readingEditor = { schema_version: 'reading-editor-1.1', views_fingerprint: readingFirstViewsFingerprint(views), map: { nodes: [] },
    languages: Object.fromEntries(views.map(view => [view.language, { overview: [{ text: 'Overview', section_ids: ['findings'] }],
      sections: [], methods: [{ id: 'rate', title: 'Rate', explanation: 'Rate background.', application: 'Rate in the study.', section_ids: ['methods'], knowledge_id: 'rate' }],
      visuals: [{ id: 'fig-1', title: 'Figure 1', notes: [] }] }])) };
  return data;
}

for (const compact of [false, true]) test(`supplement source page is labelled in both languages (${compact ? 'compact' : 'normal'} layout)`, () => {
  const data = input({ compact });
  let rendered = renderReadingFirstObsidian(data);
  assert.match(rendered.notes.find(note => note.language === 'en').content, /\[Supplementary p\. 5\]\([^)]+Raw\/supplement\.pdf#page=5\)/);
  assert.match(rendered.notes.find(note => note.language === 'zh-CN').content, /\[补充材料第5页\]\([^)]+Raw\/supplement\.pdf#page=5\)/);
  delete data.presentation.visuals[0].source_id;
  data.presentation.visuals[0].source_path = 'Raw/supplement.pdf';
  rendered = renderReadingFirstObsidian(data);
  assert.match(rendered.notes[0].content, /\[Supplementary p\. 5\]/);
  assert.match(rendered.notes[1].content, /\[补充材料第5页\]/);
});

test('unclassified source and old bindings retain their original page labels', () => {
  const data = input();
  data.presentation.sources[1] = { id: 'method-paper', path: 'Raw/supplement.pdf' };
  data.presentation.visuals[0].source_id = 'method-paper';
  assert.match(renderReadingFirstObsidian(data).notes[0].content, /\[Original p\. 5\]/);
  data.presentation.sources = [{ id: 'main', path: 'Raw/paper.pdf' }];
  delete data.presentation.visuals[0].source_id;
  assert.match(renderReadingFirstObsidian(data).notes[0].content, /\[Original p\. 5\]/);
});

test('explicit source kind is used without treating an arbitrary non-main PDF as a supplement', () => {
  const data = input();
  data.presentation.sources[1] = { id: 'extra', path: 'Raw/supplement.pdf', kind: 'supplementary' };
  data.presentation.visuals[0].source_id = 'extra';
  assert.match(renderReadingFirstObsidian(data).notes[0].content, /\[Supplementary p\. 5\]/);
  data.presentation.sources[1].kind = 'method-background';
  assert.match(renderReadingFirstObsidian(data).notes[0].content, /\[Original p\. 5\]/);
  data.presentation.sources[1].id = 'supplementary';
  data.presentation.visuals[0].source_id = 'supplementary';
  assert.match(renderReadingFirstObsidian(data).notes[0].content, /\[Original p\. 5\]/);
});

test('source path without an unambiguous registered identity keeps the legacy label', () => {
  const data = input();
  data.presentation.sources.push({ id: 'method-background', path: 'Raw/supplement.pdf' });
  delete data.presentation.visuals[0].source_id;
  data.presentation.visuals[0].source_path = 'Raw/supplement.pdf';
  assert.match(renderReadingFirstObsidian(data).notes[0].content, /\[Original p\. 5\]/);
});

for (const [panel, translated] of [
  ['whole figure', '全图'], ['whole table', '全表'], ['upper row', '上排'], ['lower row', '下排'],
  ['bottom right', '右下'], ['c upper', 'c 上部'], ['c lower', 'c 下部'], ['b,c', 'b,c'],
]) test(`Chinese panel label preserves association for ${panel}`, () => {
  const data = input();
  data.presentation.visuals[0].chart_types[0].panel = panel;
  const rendered = renderReadingFirstObsidian(data);
  assert.ok(rendered.notes[0].content.includes(panel + ': [Rate plot]'));
  assert.ok(rendered.notes[1].content.includes(translated + ': [率图]'));
});

test('explicit bilingual panel label preserves the panel identity', () => {
  const data = input();
  Object.assign(data.presentation.visuals[0].chart_types[0], { panel: 'left inset', panel_label: { en: 'left inset', 'zh-CN': '左侧插图' } });
  const rendered = renderReadingFirstObsidian(data);
  assert.match(rendered.notes[0].content, /left inset: \[Rate plot\]/);
  assert.match(rendered.notes[1].content, /左侧插图: \[率图\]/);
  assert.equal(data.presentation.visuals[0].chart_types[0].panel, 'left inset');
});

test('incomplete bilingual panel labels are rejected rather than rendered as undefined', () => {
  const data = input();
  data.presentation.visuals[0].chart_types[0].panel_label = { en: 'left inset' };
  assert.throws(() => renderReadingFirstObsidian(data), { code: 'RF_OBSIDIAN_TEXT_REQUIRED' });
});
