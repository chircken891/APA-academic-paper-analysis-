import assert from 'node:assert/strict';
import test from 'node:test';
import { readingFirstViewsFingerprint } from '../../scripts/v3/reading-first-editor.mjs';
import { validateReadingFirstPreviewFiles } from '../../scripts/v3/reading-first-preview.mjs';
import { renderReadingFirstObsidian } from '../../scripts/v3/reading-first-obsidian.mjs';
import { applyReadingFirstKnowledgeContent } from '../../scripts/v3/reading-first-knowledge.mjs';

function input() {
  return { identity: { paper_id: 'pap_' + 'a'.repeat(32) }, views: ['en', 'zh-CN'].map(language => ({ language, sections: [{ heading: 'Methods', paragraphs: ['Original abstract and methods.'] }, { heading: 'Results', paragraphs: ['The result.'] }] })), presentation: {
    schema_version: 'reading-first-obsidian-1.0', bibliography: { title: 'A study', first_author: 'Smith', year: 2024 }, source_pdf: 'Raw/paper.pdf', sections: [{ id: 'methods', indices: { en: 0, 'zh-CN': 0 } }, { id: 'results', indices: { en: 1, 'zh-CN': 1 } }],
    visuals: [{ id: 'fig-1', kind: 'figure', label: { en: 'Figure 1', 'zh-CN': '图1' }, caption: { en: 'Full caption.', 'zh-CN': '完整图注。' }, path: 'Figures/paper/fig1.png', page: 2, section_id: 'results', after_paragraph: 0 }],
    knowledge: [{ id: 'rate', kind: 'method', canonical_key: 'age-standardisation', title: { en: 'Age standardisation', 'zh-CN': '年龄标化' }, aliases: ['ASR'], paragraphs: { en: ['Background explanation.'], 'zh-CN': ['背景解释。'] }, placements: [{ section_id: 'methods', after_paragraph: 0 }], source_kind: 'method-background' }],
    map: { steps: [{ id: 'estimate', label: { en: 'Estimate', 'zh-CN': '估计' }, section_id: 'methods' }], findings: [{ id: 'burden', label: { en: 'Burden', 'zh-CN': '负担' }, section_id: 'results' }], relations: [{ step_id: 'estimate', finding_id: 'burden' }] },
  } };
}

test('shared bilingual knowledge uses one readable file with common formulas, sources and application links', () => {
  const data = input(); data.presentation.knowledge_layout = 'shared-bilingual-1.0';
  Object.assign(data.presentation.knowledge[0], { sections: { en: [{ heading: 'Limits', paragraphs: ['Not a count.'] }], 'zh-CN': [{ heading: '局限', paragraphs: ['不是人数。'] }] }, formulas: [{ id: 'weighted', latex: 'r = \\sum w_i r_i', description: { en: 'Weighted rate', 'zh-CN': '加权率' } }], sources: [{ id: 'who', title: 'WHO', url: 'https://www.who.int/' }] });
  const result = renderReadingFirstObsidian(data);
  assert.equal(result.supportNotes.length, 1);
  assert.equal(result.supportNotes[0].path, 'Wiki/methods/年龄标化.md');
  assert.match(result.supportNotes[0].content, /## 中文[\s\S]*## English/);
  assert.match(result.supportNotes[0].content, /\\sum w_i r_i/);
  assert.match(result.supportNotes[0].content, /https:\/\/www.who.int\//);
  assert.match(result.notes[0].content, /\.md#English/);
  assert.match(result.notes[1].content, /\.md#%E4%B8%AD%E6%96%87/);
  assert.equal((result.supportNotes[0].content.match(/\\sum/g) ?? []).length, 1);
  const sharedNav = [...result.supportNotes[0].content.matchAll(/\]\(#([^)]*)\)/g)].map(match => decodeURI(match[1]));
  assert.ok(sharedNav.includes('公式 / Formulas'));
  assert.ok(sharedNav.includes('来源 / Sources'));
});

test('shared knowledge cross-references resolve forward and backward to the matching language', () => {
  const data = input(); data.presentation.knowledge_layout = 'shared-bilingual-1.0';
  const other = structuredClone(data.presentation.knowledge[0]);
  Object.assign(other, { id: 'other', canonical_key: 'other', aliases: [], title: { en: 'Other rate', 'zh-CN': '另一种率' } });
  data.presentation.knowledge.push(other);
  data.presentation.knowledge[0].paragraphs.en = ['See [other](apa-knowledge:other).'];
  other.sections = { 'zh-CN': [{ heading: '比较', paragraphs: ['参阅[标化](apa-knowledge:rate)。'] }] };
  const original = '# Existing\nHuman text.\n';
  data.knowledgeRegistry = [{ canonical_key: 'age-standardisation', aliases: ['ASR'], path: 'Wiki/methods/asr.md', content: original }];
  const result = renderReadingFirstObsidian(data);
  assert.ok(result.supportNotes[0].content.startsWith(original));
  assert.match(decodeURIComponent(result.supportNotes[0].content), /\[other\]\(另一种率\.md#English\)/);
  assert.match(decodeURIComponent(result.supportNotes[1].content), /\[标化\]\(asr\.md#中文\)/);
  for (const note of result.supportNotes) assert.doesNotMatch(note.content, /\]\(apa-knowledge:/);
  other.sections['zh-CN'][0].paragraphs = ['[unknown](apa-knowledge:missing)'];
  assert.throws(() => renderReadingFirstObsidian(data), { code: 'RF_OBSIDIAN_REFERENCE_INVALID' });
});

test('shared bilingual confirmed identity reuse exports a merged candidate preserving original human bytes', () => {
  const data = input(); data.presentation.knowledge_layout = 'shared-bilingual-1.0';
  const original = '---\ncustom: keep\n---\n# Existing\nHuman text.\n';
  data.knowledgeRegistry = [{ canonical_key: 'age-standardisation', aliases: ['ASR'], path: 'Wiki/methods/asr.md', content: original }];
  const result = renderReadingFirstObsidian(data);
  assert.equal(result.supportNotes.length, 1); assert.equal(result.knowledgeProposals.length, 1);
  assert.ok(result.supportNotes[0].content.startsWith(original));
  assert.equal(result.supportNotes[0].path, 'Wiki/methods/asr.md');
});

test('shared bilingual later papers enrich one managed explanation without duplicating headings or losing applications', () => {
  const first = input(); first.presentation.knowledge_layout = 'shared-bilingual-1.0';
  const old = renderReadingFirstObsidian(first).supportNotes[0];
  const second = input(); second.presentation.knowledge_layout = 'shared-bilingual-1.0'; second.identity.paper_id = 'pap_' + 'b'.repeat(32);
  second.presentation.bibliography.title = 'Another study';
  second.presentation.knowledge[0].paragraphs.en.push('A new interpretation limit.');
  second.knowledgeRegistry = [{ canonical_key: 'age-standardisation', path: old.path, content: old.content + '\nMy own annotation.\n' }];
  const result = renderReadingFirstObsidian(second).supportNotes[0].content;
  assert.equal((result.match(/^## English$/gm) ?? []).length, 1);
  assert.equal((result.match(/Background explanation\./g) ?? []).length, 1);
  assert.match(result, /A new interpretation limit\./); assert.match(result, /My own annotation\./);
  assert.match(result, /another-study/i); assert.match(result, /a-study/i);
  assert.match(result, /\[A study · 中文\]/); assert.match(result, /\[Another study · English\]/);
});

test('shared bilingual Writer knowledge overlay stays isolated to its language and leaves scientific catalog immutable', () => {
  const data = input(); data.presentation.knowledge_layout = 'shared-bilingual-1.0';
  const frozen = structuredClone(data.presentation);
  data.views[0].knowledge_content = [{ id: 'rate', paragraphs: ['Writer English.'], sections: [{ heading: 'Limits', paragraphs: ['English limitation.'] }] }];
  const result = applyReadingFirstKnowledgeContent(data);
  assert.deepEqual(data.presentation, frozen);
  assert.deepEqual(result.knowledge[0].paragraphs.en, ['Writer English.']);
  assert.deepEqual(result.knowledge[0].paragraphs['zh-CN'], frozen.knowledge[0].paragraphs['zh-CN']);
  data.views[0].knowledge_content[0].id = 'unknown';
  assert.throws(() => applyReadingFirstKnowledgeContent(data), { code: 'RF_OBSIDIAN_KNOWLEDGE_CONTENT_INVALID' });
});

test('shared bilingual identity rejects ambiguous language paths and duplicate readable filenames', () => {
  const data = input(); data.presentation.knowledge_layout = 'shared-bilingual-1.0';
  data.knowledgeRegistry = ['en', 'zh-CN'].map(language => ({ canonical_key: 'age-standardisation', aliases: ['ASR'], language, path: `Wiki/methods/asr.${language}.md`, content: '# Old\n' }));
  assert.throws(() => renderReadingFirstObsidian(data), { code: 'RF_OBSIDIAN_KNOWLEDGE_AMBIGUOUS' });
  data.knowledgeRegistry = [];
  data.presentation.knowledge.push({ ...structuredClone(data.presentation.knowledge[0]), id: 'other', canonical_key: 'other', aliases: [] });
  assert.throws(() => renderReadingFirstObsidian(data), { code: 'RF_OBSIDIAN_TARGET_COLLISION' });
});

test('shared bilingual chart labels link to generic knowledge and formula images retain source links', () => {
  const data = input(); data.presentation.knowledge_layout = 'shared-bilingual-1.0';
  data.presentation.visuals[0].kind = 'formula';
  data.presentation.visuals[0].chart_types = [{ knowledge_id: 'rate', label: { en: 'Weighted chart', 'zh-CN': '加权图' }, panel: 'A' }];
  const result = renderReadingFirstObsidian(data);
  assert.match(result.notes[0].content, /A.*Weighted chart.*\.md#English/);
  assert.match(result.notes[1].content, /加权图.*\.md#%E4%B8%AD%E6%96%87/);
});
test('identical chart-type sets across panels collapse while mixed sets retain their associations', () => {
  const data = input(); data.presentation.knowledge_layout = 'shared-bilingual-1.0';
  const second = { ...structuredClone(data.presentation.knowledge[0]), id: 'other', canonical_key: 'other', aliases: [], title: { en: 'Other', 'zh-CN': '其他' } };
  data.presentation.knowledge.push(second);
  data.presentation.visuals[0].chart_types = ['Group A', 'Group B'].flatMap(panel => [
    { knowledge_id: 'rate', label: { en: 'Pie', 'zh-CN': '饼图' }, panel },
    { knowledge_id: 'other', label: { en: 'Bar', 'zh-CN': '条形图' }, panel },
  ]);
  const result = renderReadingFirstObsidian(data);
  const en = result.notes[0].content.split('\n').find(line => line.startsWith('**Chart type**'));
  const zh = result.notes[1].content.split('\n').find(line => line.startsWith('**图型**'));
  assert.match(en, /Each panel: \[Pie\].*\[Bar\]/); assert.doesNotMatch(en, /Group [AB]/);
  assert.match(zh, /各面板：\[饼图\].*\[条形图\]/); assert.doesNotMatch(zh, /Group [AB]/);
  data.presentation.visuals[0].chart_types.pop();
  assert.match(renderReadingFirstObsidian(data).notes[0].content, /Group A:.*Group B:/);
});

test('renders complete bilingual relative-linked reading pages and knowledge candidates', () => {
  const rendered = renderReadingFirstObsidian(input());
  assert.equal(rendered.notes.length, 2);
  assert.equal(rendered.supportNotes.length, 2);
  const note = rendered.notes[0].content;
  assert.match(note, /Original abstract and methods\./);
  assert.ok(note.indexOf('```mermaid') < note.indexOf('## Methods'));
  assert.match(note, /!\[Figure 1\]\(\.\.\/\.\.\/Figures\/paper\/fig1.png\)/);
  assert.match(note, /paper.pdf#page=2/);
  assert.match(note, /#\^rf-methods/);
  assert.match(note, /#\^rf-results/);
  assert.match(note, /Method background/);
  assert.doesNotMatch(note, /[A-Z]:\\/);
  assert.equal(rendered.review.status, 'pending');
});
test('updates managed body while preserving personal prose, free body and custom YAML', () => {
  const first = renderReadingFirstObsidian(input());
  const old = first.notes[0];
  const bytes = Buffer.from(old.content.replace('---\n<!--', 'custom: keep\n---\nFree preface.\n<!--').replace('## Personal Notes\n', '## Personal Notes\nMy annotation.\n'));
  const next = input(); next.targetRegistry = first.targetRegistry; next.existingTargets = [{ path: old.path, bytes, managedHash: old.managedHash }]; next.views[0].sections[1].paragraphs = ['New result.'];
  const updated = renderReadingFirstObsidian(next).notes[0].content;
  assert.match(updated, /custom: keep/); assert.match(updated, /Free preface\./); assert.match(updated, /My annotation\./); assert.match(updated, /New result\./);
});
test('matches confirmed canonical identity with aliases; proposes additions without overwriting existing nodes', () => {
  const data = input(); data.knowledgeRegistry = [{ id: 'existing', canonical_key: 'age-standardisation', aliases: ['ASR'], path: 'Wiki/methods/existing.en.md', language: 'en' }];
  const result = renderReadingFirstObsidian(data);
  assert.equal(result.supportNotes.length, 1);
  assert.equal(result.knowledgeProposals.length, 1);
  assert.match(result.notes[0].content, /existing.en.md/);
});
test('new Writer section IDs resolve independently of language order and placements default to end', () => {
  const data = input();
  data.presentation.sections.forEach(section => { delete section.indices; });
  data.views.forEach(view => { view.sections[0].id = 'methods'; view.sections[1].id = 'results'; });
  data.views[1].sections.reverse();
  delete data.presentation.visuals[0].after_paragraph;
  delete data.presentation.knowledge[0].placements[0].after_paragraph;
  const result = renderReadingFirstObsidian(data);
  assert.match(result.notes[1].content, /The result\.[\s\S]*!\[图1\]/);
  assert.ok(result.notes[1].content.indexOf('## Results') < result.notes[1].content.indexOf('## Methods'));
});
test('scientific titles retain punctuation in display while registry paths are safe', () => {
  const data = input(); data.presentation.bibliography.title = { en: 'Cancer: rates / populations', 'zh-CN': '癌症：率与人群' };
  const result = renderReadingFirstObsidian(data);
  assert.match(result.notes[0].content, /# Cancer: rates \/ populations/);
  assert.match(result.notes[1].content, /# 癌症：率与人群/);
  assert.doesNotMatch(result.notes[0].path, /:/);
});
test('an existing unilingual shared node serves both languages without duplicate creation', () => {
  const data = input(); data.knowledgeRegistry = [{ canonical_key: 'age-standardisation', path: 'Wiki/methods/asir.md' }];
  const result = renderReadingFirstObsidian(data);
  assert.equal(result.supportNotes.length, 0);
  assert.equal(result.knowledgeProposals.length, 2);
  result.notes.forEach(note => assert.match(note.content, /asir.md/));
});
test('existing registered paper targets remain stable after display title changes', () => {
  const data = input(); const first = renderReadingFirstObsidian(data);
  data.targetRegistry = first.targetRegistry; data.presentation.bibliography.title = 'Revised title';
  const next = renderReadingFirstObsidian(data);
  assert.equal(next.notes[0].path, first.notes[0].path);
  assert.match(next.notes[0].content, /# Revised title/);
});
test('map follows original abstract and stable anchors attach to real prose', () => {
  const data = input();
  data.views.forEach(view => view.sections.unshift({ id: 'abstract', heading: 'Abstract', paragraphs: ['Verbatim abstract.'] }));
  data.presentation.sections.unshift({ id: 'abstract', indices: { en: 0, 'zh-CN': 0 } });
  data.presentation.sections[1].indices = { en: 1, 'zh-CN': 1 }; data.presentation.sections[2].indices = { en: 2, 'zh-CN': 2 };
  const note = renderReadingFirstObsidian(data).notes[0].content;
  assert.ok(note.indexOf('Verbatim abstract.') < note.indexOf('```mermaid'));
  assert.match(note, /Original abstract and methods\. \^rf-methods/);
  assert.doesNotMatch(note, /\n\n\^rf-methods/);
});
test('study facts stay in the paper section and do not create shared candidates or proposals', () => {
  const data = input();
  data.presentation.knowledge[0].source_kind = 'paper-fact';
  data.presentation.knowledge[0].paragraphs = { en: ['Original abstract and methods.', 'A paper-specific setting.'], 'zh-CN': ['本文特定设置。'] };
  const result = renderReadingFirstObsidian(data);
  assert.equal(result.supportNotes.length, 0); assert.equal(result.knowledgeProposals.length, 0);
  assert.equal(result.notes[0].content.split('Original abstract and methods.').length - 1, 1);
  assert.match(result.notes[0].content, /A paper-specific setting\./);
  assert.match(result.notes[1].content, /本文特定设置。/);
});
test('requires both language display titles for localized bibliography', () => {
  const data = input(); data.presentation.bibliography.title = { en: 'A study' };
  assert.throws(() => renderReadingFirstObsidian(data), { code: 'RF_OBSIDIAN_TEXT_REQUIRED' });
});
for (const [label, mutate, error] of [
  ['unsafe asset', x => { x.presentation.visuals[0].path = '../escape.png'; }, 'RF_OBSIDIAN_PATH_INVALID'],
  ['asset outside Figures', x => { x.presentation.visuals[0].path = 'Wiki/image.png'; }, 'RF_OBSIDIAN_PATH_INVALID'],
  ['PDF outside Raw', x => { x.presentation.source_pdf = 'Wiki/source.pdf'; }, 'RF_OBSIDIAN_PATH_INVALID'],
  ['invalid placement', x => { x.presentation.visuals[0].after_paragraph = 2; }, 'RF_OBSIDIAN_PLACEMENT_INVALID'],
  ['duplicate section', x => { x.presentation.sections[1].id = 'methods'; }, 'RF_OBSIDIAN_SECTION_INVALID'],
  ['ambiguous existing identity', x => { x.knowledgeRegistry = [{ aliases: ['ASR'], path: 'Wiki/methods/a.en.md', language: 'en' }, { aliases: ['ASR'], path: 'Wiki/methods/b.en.md', language: 'en' }]; }, 'RF_OBSIDIAN_KNOWLEDGE_AMBIGUOUS'],
]) test(`rejects ${label}`, () => { const value = input(); mutate(value); assert.throws(() => renderReadingFirstObsidian(value), { code: error }); });

function writerInput() {
  const data = input();
  const ids = ['abstract', 'design', 'methods', 'findings', 'discussion', 'limitations', 'conclusion'];
  data.presentation.layout = 'writer-modules-1.0';
  data.presentation.modules = ids.map(id => ({ id, label: { en: id.toUpperCase(), 'zh-CN': id } }));
  data.presentation.sources = [{ id: 'paper', path: data.presentation.source_pdf }];
  data.presentation.bibliography.doi = '10.1234/example';
  data.presentation.map.steps[0].section_id = 'design';
  data.presentation.map.findings[0].section_id = 'findings';
  data.views.forEach(view => {
    view.sections = ids.map(id => ({ id, module_id: id, heading: id + ' details', paragraphs: ['**Key point.**\n\n> [!note]\n> A useful qualification.'] }));
    view.sections[2].paragraphs.push('[Source](apa-source:paper#page=2), [figure](apa-visual:fig-1), [method](apa-knowledge:rate).');
    view.placements = { visuals: [{ id: 'fig-1', section_id: 'findings', after_paragraph: 0 }], knowledge: [{ id: 'rate', section_id: 'methods', after_paragraph: 1 }] };
  });
  return data;
}

test('visual page links use registered main and supplement sources in both languages', () => {
  const data = writerInput();
  data.presentation.sources.push({ id: 'supplement', path: 'Raw/supplement.pdf' });
  const main = data.presentation.visuals[0];
  const byId = { ...structuredClone(main), id: 'fig-2', page: 4, source_id: 'supplement' };
  const byPath = { ...structuredClone(main), id: 'fig-3', page: 5, source_path: 'Raw/supplement.pdf' };
  const byBoth = { ...structuredClone(main), id: 'fig-4', page: 6, source_id: 'supplement', source_path: 'Raw/supplement.pdf' };
  data.presentation.visuals.push(byId, byPath, byBoth);
  data.views.forEach(view => view.placements.visuals.push(...[byId, byPath, byBoth].map(visual => ({ id: visual.id, section_id: 'findings', after_paragraph: 0 }))));
  const result = renderReadingFirstObsidian(data);
  for (const note of result.notes) {
    assert.ok(note.content.includes('Raw/paper.pdf#page=2'));
    for (const page of [4, 5, 6]) assert.ok(note.content.includes('Raw/supplement.pdf#page=' + page));
  }
});

for (const [name, source] of [
  ['unknown source id', { source_id: 'missing' }],
  ['unregistered source path', { source_path: 'Raw/unregistered.pdf' }],
  ['conflicting source id and path', { source_id: 'paper', source_path: 'Raw/supplement.pdf' }],
]) test('visual page link rejects ' + name, () => {
  const data = writerInput();
  data.presentation.sources.push({ id: 'supplement', path: 'Raw/supplement.pdf' });
  Object.assign(data.presentation.visuals[0], source);
  assert.throws(() => renderReadingFirstObsidian(data), { code: 'RF_OBSIDIAN_SOURCE_INVALID' });
});

test('visual provenance accepts the original scientific source id with an explicitly bound main PDF and no presentation source map', () => {
  const data = writerInput();
  delete data.presentation.sources;
  data.views.forEach(view => { view.sections[2].paragraphs[1] = 'Figure and method.'; });
  Object.assign(data.presentation.visuals[0], { source_id: 'scientific-source', source_path: 'Raw/paper.pdf', source_sha256: 'sha256:' + 'a'.repeat(64) });
  for (const note of renderReadingFirstObsidian(data).notes) assert.ok(note.content.includes('Raw/paper.pdf#page=2'));
  data.presentation.visuals[0].source_path = 'Raw/supplement.pdf';
  assert.throws(() => renderReadingFirstObsidian(data), { code: 'RF_OBSIDIAN_SOURCE_INVALID' });
});

test('Writer modules produce hierarchy, full DOI and resolved references while preserving Markdown', () => {
  const result = renderReadingFirstObsidian(writerInput());
  const note = result.notes[0].content;
  assert.match(result.notes[0].path, /\/Smith-2024-A-study--/);
  assert.match(note, /DOI: \[10\.1234\/example\]/);
  assert.match(note, /## METHODS\n\n### methods details/);
  assert.match(note, /- \[METHODS\]\(#METHODS\)/);
  assert.match(note, /- \[Figures and tables\]\(#Figures%20and%20tables\)/);
  assert.match(note, /- \[Personal Notes\]\(#Personal%20Notes\)/);
  assert.match(note, /\[Open full-size image\]\(\.\.\/\.\.\/Figures\/paper\/fig1.png\)/);
  assert.match(result.notes[1].content, /\[查看大图\]\(\.\.\/\.\.\/Figures\/paper\/fig1.png\)/);
  assert.match(note, /> A useful qualification\.\n\n\^rf-methods/);
  assert.match(note, /  - \[methods details\]\(#\^rf-methods\)/);
  assert.match(note, /\*\*Key point\.\*\*\n\n> \[!note\]\n> A useful qualification\./);
  assert.match(note, /\[Source\]\(\.\.\/\.\.\/Raw\/paper.pdf#page=2\)/);
  assert.match(note, /\[figure\]\(#\^rf-visual-fig-1\)/);
  assert.doesNotMatch(note, /apa-(source|visual|knowledge):/);
  assert.ok(note.indexOf('```mermaid') < note.indexOf('### design details'));
  assert.ok(note.indexOf('## ABSTRACT') < note.indexOf('```mermaid'));
});

for (const [name, mutate, code] of [
  ['missing module', value => value.views.forEach(view => view.sections.pop()), 'RF_OBSIDIAN_MODULE_INVALID'],
  ['different bilingual structure', value => { value.views[1].sections[0].id = 'other'; }, 'RF_OBSIDIAN_BILINGUAL_STRUCTURE_INVALID'],
  ['unplaced figure', value => { value.views[0].placements.visuals = []; }, 'RF_OBSIDIAN_PLACEMENT_INVALID'],
  ['unplaced background', value => { value.views[0].placements.knowledge = []; }, 'RF_OBSIDIAN_PLACEMENT_INVALID'],
  ['unknown figure placement', value => { value.views[0].placements.visuals[0].id = 'missing'; }, 'RF_OBSIDIAN_PLACEMENT_INVALID'],
  ['bad language-specific offset', value => { value.views[1].placements.knowledge[0].after_paragraph = 2; }, 'RF_OBSIDIAN_PLACEMENT_INVALID'],
  ['unknown source', value => { value.views[0].sections[0].paragraphs = ['[page](apa-source:missing#page=2)']; }, 'RF_OBSIDIAN_REFERENCE_INVALID'],
  ['invalid source page', value => { value.views[0].sections[0].paragraphs = ['[page](apa-source:paper#page=0)']; }, 'RF_OBSIDIAN_REFERENCE_INVALID'],
  ['unknown inline figure', value => { value.views[0].sections[0].paragraphs = ['[figure](apa-visual:missing)']; }, 'RF_OBSIDIAN_REFERENCE_INVALID'],
]) test(`Writer layout rejects ${name}`, () => {
  const value = writerInput(); mutate(value);
  assert.throws(() => renderReadingFirstObsidian(value), { code });
});

function editedInput() {
  const data = writerInput();
  data.views.forEach(view => {
    view.sections[3].paragraphs = ['The total burden increased, while the standardised rate was lower.', 'Rates and counts answer different questions.'];
    view.placements.visuals[0].after_paragraph = 1;
  });
  data.readingEditor = { schema_version: 'reading-editor-1.0', views_fingerprint: readingFirstViewsFingerprint(data.views), languages: Object.fromEntries(data.views.map(view => [view.language, {
    overview: [{ text: 'Counts and rates have different meanings.', section_ids: ['findings', 'methods'] }],
    sections: [{ section_id: 'findings', takeaway: 'The comparison depends on the measure.', emphasis: [{ paragraph_index: 0, text: 'total burden increased' }], subheadings: [{ before_paragraph: 1, heading: 'Population and rate' }] }],
    methods: [{ id: 'counts', title: 'Counts', explanation: 'Counts describe the total burden.', application: 'The study reports burden.', section_ids: ['findings'] }, { id: 'rate', title: 'Standardisation', explanation: 'Rates adjust age structure.', application: 'The study compares rates.', section_ids: ['methods', 'findings'], knowledge_id: 'rate' }],
  }])) };
  return data;
}

for (const coverage of ['inventory', 'chart', 'inline']) test(`shared knowledge ${coverage} covers a node without repetitive body placements`, () => {
  const data = coverage === 'inventory' ? editedInput() : writerInput();
  data.presentation.knowledge_layout = 'shared-bilingual-1.0';
  data.views.forEach(view => {
    view.placements.knowledge = [];
    if (coverage !== 'inline') view.sections[2].paragraphs[1] = 'The study estimates rates.';
  });
  if (coverage === 'inventory') {
    data.readingEditor.views_fingerprint = readingFirstViewsFingerprint(data.views);
    Object.values(data.readingEditor.languages).forEach(language => { language.methods = language.methods.filter(method => method.knowledge_id); });
  }
  if (coverage === 'chart') data.presentation.visuals[0].chart_types = [{ knowledge_id: 'rate', label: { en: 'Rate plot', 'zh-CN': '率图' } }];
  const result = renderReadingFirstObsidian(data);
  assert.equal(result.supportNotes.length, 1);
  assert.doesNotMatch(result.notes[0].content, /Method background:/);
});

test('shared knowledge rejects actual orphan nodes and requires explicit paper fact placement', () => {
  const data = writerInput(); data.presentation.knowledge_layout = 'shared-bilingual-1.0';
  data.views.forEach(view => { view.placements.knowledge = []; view.sections[2].paragraphs[1] = 'No generic links.'; });
  assert.throws(() => renderReadingFirstObsidian(data), { code: 'RF_OBSIDIAN_PLACEMENT_INVALID' });
  data.views.forEach(view => { view.sections[2].paragraphs[1] = '[fact](apa-knowledge:rate)'; });
  data.presentation.knowledge[0].source_kind = 'paper-fact';
  assert.throws(() => renderReadingFirstObsidian(data), { code: 'RF_OBSIDIAN_PLACEMENT_INVALID' });
});

test('shared visual resources expose immutable source/page/crop provenance for review', () => {
  const data = writerInput(); data.presentation.knowledge_layout = 'shared-bilingual-1.0';
  data.presentation.visuals[0].crop = { source_sha256: 'a'.repeat(64), page: 2, bbox: [10, 20, 500, 600], rotation: 90 };
  const result = renderReadingFirstObsidian(data);
  assert.deepEqual(result.visual_resources[0].crop, data.presentation.visuals[0].crop);
  assert.equal(result.visual_resources[0].path, data.presentation.visuals[0].path);
  result.visual_resources[0].crop.bbox[0] = 12;
  assert.equal(data.presentation.visuals[0].crop.bbox[0], 10);
});

test('editor adds numbered reading hierarchy, meaningful inventory, takeaway and selective emphasis without replacing prose', () => {
  const result = renderReadingFirstObsidian(editedInput());
  const note = result.notes[0].content;
  assert.match(note, /## 1\. ABSTRACT/);
  assert.match(note, /### 2\.1 Research map/);
  assert.match(note, /### 2\.2 design details/);
  assert.match(note, /### 3\.1 Methods and concepts at a glance/);
  assert.match(note, /#### 3\.1\.1 Counts/);
  assert.match(note, /#### 3\.1\.2 Standardisation/);
  assert.match(note, /Counts describe the total burden\./);
  assert.match(note, /\*\*Use in this study\*\*: The study reports burden\./);
  assert.match(note, /\[Shared explanation\]\(\.\.\/methods\//);
  assert.match(note, /### 3\.2 methods details/);
  assert.match(note, /### 4\.1 findings details/);
  assert.match(note, /#### 4\.1\.1 Population and rate/);
  assert.match(note, /> \[!summary\] Key point\n> The comparison depends on the measure\./);
  assert.match(note, /The \*\*total burden increased\*\*, while the standardised rate was lower\./);
  assert.match(note, /Rates and counts answer different questions\./);
  const contents = note.split('## Contents\n\n')[1].split('<!-- AUTO:END source -->')[0];
  assert.doesNotMatch(contents, /^ {4,}- /m);
  assert.doesNotMatch(contents, /3\.1\.1 Counts|3\.1\.2 Standardisation|4\.1\.1 Population and rate/);
  assert.match(contents, /3\.1 Methods and concepts at a glance/);
  assert.match(contents, /4\.1 findings details/);
  assert.match(note, /#### 3\.1\.1 Counts[\s\S]*Counts describe the total burden\./);
  assert.ok(note.indexOf('## Reading overview') < note.indexOf('## Contents'));
  assert.ok(note.indexOf('## Contents') < note.indexOf('## 1. ABSTRACT'));
  assert.match(note, /- \*\*\[4\. FINDINGS\]\(#4\.%20FINDINGS\)\*\*/);
  assert.match(note, /  - \[4\.1 findings details\]\(#4\.1%20findings%20details\)/);
  assert.match(note, /\[figure\]\(#Figure%201%20%C2%B7%20Source%20p\.%202\)/);
  assert.match(note, /\^rf-findings/);
  assert.match(note, /\^rf-visual-fig-1/);
  // Program validation establishes target existence, not native Obsidian click acceptance.
  const validation = validateReadingFirstPreviewFiles([...result.notes, ...result.supportNotes, ...result.assetPaths.map(path => ({ path, bytes: Buffer.from('resource') }))]);
  assert.equal(validation.status, 'passed');
  assert.equal(validation.native_obsidian, 'not_run');
});

test('editor metadata is optional and cannot silently apply to changed Writer prose', () => {
  const data = editedInput();
  data.views[0].sections[3].paragraphs[0] += ' Changed.';
  assert.throws(() => renderReadingFirstObsidian(data), { code: 'READING_FIRST_EDITOR_FINGERPRINT_INVALID' });
  delete data.readingEditor;
  assert.doesNotMatch(renderReadingFirstObsidian(data).notes[0].content, /## 1\. ABSTRACT/);
});


test('editor preserves existing strong emphasis without double-wrapping the selected span', () => {
  const data = editedInput();
  data.views.forEach(view => { view.sections[3].paragraphs[0] = 'The **total burden increased**, while the standardised rate was lower.'; });
  data.readingEditor.views_fingerprint = readingFirstViewsFingerprint(data.views);
  const note = renderReadingFirstObsidian(data).notes[0].content;
  assert.match(note, /The \*\*total burden increased\*\*, while/);
  assert.doesNotMatch(note, /\*{4}/);
});


test('editor encodes parentheses in visual headings and resource paths without changing displayed titles', () => {
  const data = editedInput();
  data.presentation.visuals[0].label = { en: 'Table 2 (1/2)', 'zh-CN': '表2（1/2）' };
  data.presentation.visuals[0].path = 'Figures/paper/table (1).png';
  data.presentation.source_pdf = 'Raw/paper (original).pdf';
  const result = renderReadingFirstObsidian(data);
  const note = result.notes[0].content;
  assert.match(note, /#### Table 2 \(1\/2\) · Source p\. 2/);
  const figureTarget = note.match(/\[figure\]\(#([^)]*)\)/)[1];
  assert.equal(decodeURI(figureTarget), 'Table 2 (1/2) · Source p. 2');
  assert.match(note, /Figures\/paper\/table%20%281%29\.png/);
  assert.match(note, /Raw\/paper%20%28original%29\.pdf/);
  const validation = validateReadingFirstPreviewFiles([...result.notes, ...result.supportNotes, ...result.assetPaths.map(path => ({ path, bytes: Buffer.from('resource') }))]);
  assert.equal(validation.status, 'passed');
});

for (const shared of [false, true]) {
  const setup = () => {
    const data = input();
    if (shared) data.presentation.knowledge_layout = 'shared-bilingual-1.0';
    return data;
  };
  test(`stable identity reuses differently worded paper knowledge (${shared ? 'shared' : 'legacy'})`, () => {
    const data = setup();
    data.knowledgeRegistry = [{ id: 'registered-rate', canonical_key: 'age-standardisation', title: 'Earlier wording', aliases: ['Old wording'], path: 'Wiki/methods/registered-rate.md', content: '# Human explanation\n' }];
    Object.assign(data.presentation.knowledge[0], { title: { en: 'Adjusted incidence: age / population', 'zh-CN': '调整发生率：年龄 / 人群' }, aliases: [] });
    const result = renderReadingFirstObsidian(data);
    assert.equal(result.knowledgeProposals[0].path, 'Wiki/methods/registered-rate.md');
    result.notes.forEach(note => assert.match(note.content, /registered-rate\.md/));
    if (shared) assert.ok(result.supportNotes[0].content.startsWith('# Human explanation\n'));
  });
  test(`name-only candidates require identity resolution (${shared ? 'shared' : 'legacy'})`, () => {
    for (const row of [{ id: 'different-id', canonical_key: 'other-key', title: 'Age standardisation' }, { aliases: ['ASR'] }, { id: 'ASR' }, { title: 'age-standardisation' }]) {
      const data = setup();
      data.knowledgeRegistry = [{ ...row, path: 'Wiki/methods/unrelated.md', content: '# Human\n' }];
      if (row.id === 'ASR' || row.title === 'age-standardisation') {
        // A name matching a stable key (or vice versa) is not a candidate.
        assert.equal(renderReadingFirstObsidian(data).knowledgeProposals.length, 0);
      } else assert.throws(() => renderReadingFirstObsidian(data), { code: 'RF_OBSIDIAN_KNOWLEDGE_IDENTITY_UNRESOLVED' });
    }
  });
  test(`stable identity wins incidental name collisions (${shared ? 'shared' : 'legacy'})`, () => {
    const data = setup();
    data.knowledgeRegistry = [
      { id: 'rate', title: 'Previous name', path: 'Wiki/methods/confirmed.md', content: '# Confirmed\n' },
      { id: 'unrelated', aliases: ['ASR'], path: 'Wiki/methods/unrelated.md', content: '# Unrelated\n' },
    ];
    assert.equal(renderReadingFirstObsidian(data).knowledgeProposals[0].path, 'Wiki/methods/confirmed.md');
    data.knowledgeRegistry.push({ canonical_key: 'age-standardisation', path: 'Wiki/methods/conflicting.md', content: '# Conflicting\n' });
    assert.throws(() => renderReadingFirstObsidian(data), { code: 'RF_OBSIDIAN_KNOWLEDGE_AMBIGUOUS' });
  });
  test(`unmatched concepts produce fresh candidates (${shared ? 'shared' : 'legacy'})`, () => {
    const data = setup();
    data.presentation.knowledge[0].kind = 'concept';
    const result = renderReadingFirstObsidian(data);
    assert.equal(result.knowledgeProposals.length, 0);
    assert.equal(result.supportNotes.length, shared ? 1 : 2);
    result.supportNotes.forEach(note => assert.ok(note.path.startsWith('Wiki/concepts/')));
  });
}

test('shared Reading Editor retains an explained unlinked method in both language inventories', () => {
  const data = editedInput();
  data.presentation.knowledge_layout = 'shared-bilingual-1.0';
  data.readingEditor.languages['zh-CN'].methods[0].knowledge_ids = [];
  const result = renderReadingFirstObsidian(data);
  result.notes.forEach(note => {
    const counts = note.content.split('#### 3.1.1 Counts')[1].split('#### 3.1.2')[0];
    assert.match(counts, /Counts describe the total burden\./);
    assert.match(counts, /The study reports burden\./);
    assert.doesNotMatch(counts, /Shared explanation|共享讲解/);
    assert.match(note.content, /年龄标化\.md|%E5%B9%B4%E9%BE%84%E6%A0%87%E5%8C%96\.md/);
  });
});

test('complete original captions and footnotes remain beside images before separate Writer reading notes', () => {
  const data = writerInput();
  const captions = { en: 'Original caption. Full denominators and conditions.\n\nFootnotes: a, weighted estimate; b, reference group.', 'zh-CN': '原始表注。完整分母与条件。\n\n脚注：a，加权估计；b，参照组。' };
  data.presentation.visuals[0].caption = captions;
  data.views.forEach(view => {
    view.sections[3].paragraphs = ['Result context.', view.language === 'en' ? '**Reading notes:** Counts and rates answer different questions.' : '**阅读说明：**人数与率回答不同问题。'];
    view.placements.visuals[0].after_paragraph = 0;
  });
  const result = renderReadingFirstObsidian(data);
  result.notes.forEach((note, index) => {
    const language = data.views[index].language;
    assert.ok(note.content.includes(captions[language]));
    assert.ok(note.content.indexOf('![') < note.content.indexOf(captions[language]));
    assert.ok(note.content.indexOf(captions[language]) < note.content.indexOf(language === 'en' ? '**Reading notes:**' : '**阅读说明：**'));
  });
});
