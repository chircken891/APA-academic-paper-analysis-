import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { applyReadingFirstKnowledgeContent, assertSharedKnowledgeApplicationMirror, bindPublishedKnowledgeReferences, collectSharedKnowledgeApplications, draftReadingFirstKnowledgeComparisons, matchReadingFirstKnowledgeIdentity,
  registeredKnowledgeReference, renderSharedKnowledge } from '../../scripts/v3/reading-first-knowledge.mjs';
import { reviewedReadingFirstFixture } from './helpers/reading-first-publication-source-fixtures.mjs';

const item = { id: 'pie', kind: 'method', canonical_key: 'method:pie', title: { 'zh-CN': '饼图', en: 'Pie chart' }, source_kind: 'method-background', paragraphs: { 'zh-CN': ['中文'], en: ['English'] } };
const prior = { paper_id: 'bray', title: 'Bray 2024', targets: { 'zh-CN': 'Wiki/sources/Bray.zh-CN.md', en: 'Wiki/sources/Bray.en.md' } };
const currentTargets = { 'zh-CN': 'Wiki/translations/New.zh-CN.md', en: 'Wiki/sources/New.en.md' };
const start = '<!-- AUTO:START shared-knowledge -->';
const end = '<!-- AUTO:END shared-knowledge -->';
const before = '# Human heading\n\nPersonal notes before.\n\n';
const after = '\n\nPersonal notes after.\n';
const href = (from, to) => path.posix.relative(path.posix.dirname(from), to).split('/').map(encodeURIComponent).join('/');
function render(links, options = {}) {
  const state = Buffer.from(JSON.stringify({ item, applications: options.prior ?? [prior] })).toString('base64');
  const original = `${before}${start}\n<!-- KNOWLEDGE_STATE ${state} -->\n## 论文应用 / Paper applications\n\n${links}\n${end}${after}`;
  const result = renderSharedKnowledge({ item, knowledgeRegistry: [{ id: item.id, path: 'Wiki/methods/饼图.md', content: original }], paperTargets: options.targets ?? currentTargets, paperId: options.paperId ?? 'new', paperTitle: 'New paper', vaultPath: value => value, href });
  const content = result.note.content;
  const applications = JSON.parse(Buffer.from(/<!-- KNOWLEDGE_STATE ([A-Za-z0-9+/=]+) -->/.exec(content)[1], 'base64')).applications;
  return { content, applications };
}
const links = '- [Bray 2024 · 中文](../translations/Bray.zh-CN.md)\n- [Bray 2024 · English](../sources/Bray.en.md)';

test('renders both languages of a shared knowledge source as one link', () => {
  const source = { label: { 'zh-CN': '原始研究', en: 'Original study' }, url: 'https://example.org/paper' };
  const { note } = renderSharedKnowledge({
    item: { ...item, sources: [source] }, knowledgeRegistry: [], paperTargets: currentTargets,
    paperId: 'new', paperTitle: 'New paper', vaultPath: value => value, href,
  });
  assert.ok(note.content.includes('[原始研究 / Original study](https://example.org/paper)'));
});

test('uniquely matches registered exact, normalized, English and alias identities', () => {
  const target = 'Wiki/methods/另一术语.md';
  for (const [expected, terms] of [
    ['exact', { title: '饼图' }],
    ['normalized', { title: '饼　图' }],
    ['english', { title: '另一术语', title_en: 'PIE–CHART' }],
    ['alias', { title: '另一术语', registered_aliases: ['method:pie'] }],
  ]) {
    const match = matchReadingFirstKnowledgeIdentity({ item, knowledgeRegistry: [{ id: 'prior', path: target, ...terms }], vaultPath: value => value });
    assert.equal(match.tier, expected);
    assert.deepEqual(match.paths, [target]);
  }
});

test('leaves ambiguous identities available as draft pairs and does not reuse a cross-kind match', () => {
  const match = matchReadingFirstKnowledgeIdentity({ item, vaultPath: value => value,
    knowledgeRegistry: [
      { title: '饼图', path: 'Wiki/methods/A.md' }, { title: '饼图', path: 'Wiki/methods/B.md' },
      { id: item.id, path: 'Wiki/concepts/C.md' },
    ] });
  assert.deepEqual(match.paths, []);
  assert.deepEqual(match.ambiguous_paths, ['Wiki/methods/A.md', 'Wiki/methods/B.md']);
});

test('definition BM25 adds an advisory pair without granting identity reuse', () => {
  const incoming = { ...item, paragraphs: { en: ['Wedges represent each category proportion in a circular display.'], 'zh-CN': ['扇区面积代表分类占比。'] } };
  const similar = { id: 'sector', title: '扇区面积比例图', path: 'Wiki/methods/扇区面积比例图.md', definitions: ['A circular display encodes category proportion by wedge area.'] };
  const unrelated = { id: 'prior', title: '其他统计量', path: 'Wiki/methods/其他统计量.md', definitions: ['Poisson regression estimates a count.'] };
  const knowledgeRegistry = [unrelated, similar];
  const match = matchReadingFirstKnowledgeIdentity({ item: incoming, knowledgeRegistry });
  assert.deepEqual(match.paths, []);
  const drafts = draftReadingFirstKnowledgeComparisons({ item: incoming, knowledgeRegistry, match, target: 'Wiki/methods/饼图.md' });
  assert.deepEqual(drafts.map(row => [row.status, row.registered_path, row.reasons]), [['draft', similar.path, ['definition-bm25']]]);
  assert.deepEqual(drafts[0].registered_definition, similar.definitions);
});

test('preserves a prior paper relocated visible target in the candidate and hidden state', () => {
  const { content, applications } = render(links);
  assert.equal(applications.find(row => row.paper_id === 'bray').targets['zh-CN'], 'Wiki/translations/Bray.zh-CN.md');
  assert.match(content, /\[Bray 2024 · 中文\]\(\.\.\/translations\/Bray\.zh-CN\.md\)/);
  assert.ok(content.startsWith(before));
  assert.ok(content.endsWith(after));
});

test('collects shared application sections from bilingual writer declarations and expanded editor inputs', () => {
  const presentation = { knowledge_layout: 'shared-bilingual-1.0', knowledge: [item],
    visuals: [{ id: 'figure', chart_types: [{ knowledge_id: item.id }] }] };
  const applications = ['practice', 'figure-result'];
  const views = Object.entries(item.paragraphs).map(([language, paragraphs]) => ({
    language,
    sections: [
      { id: 'practice', heading: language === 'en' ? 'Measure composition' : '测量组成', paragraphs: ['Example.'] },
      { id: 'figure-result', heading: language === 'en' ? 'Display composition' : '呈现组成', paragraphs: ['Figure description.'] },
      { id: 'other', heading: 'Unrelated', paragraphs: ['Unrelated discussion.'] },
    ],
    knowledge_content: [{ id: item.id, paragraphs, application_section_ids: applications.slice() }],
    placements: { knowledge: [{ id: item.id, section_id: 'practice' }], visuals: [{ id: 'figure', section_id: 'figure-result' }] },
  }));
  const expected = [
    { id: 'practice', headings: { 'zh-CN': '测量组成', en: 'Measure composition' } },
    { id: 'figure-result', headings: { 'zh-CN': '呈现组成', en: 'Display composition' } },
  ];
  const withKnowledge = applyReadingFirstKnowledgeContent({ presentation, views });
  assert.deepEqual(withKnowledge.knowledge[0], item);
  assert.doesNotThrow(() => assertSharedKnowledgeApplicationMirror(...views));
  assert.deepEqual(collectSharedKnowledgeApplications({ item, presentation, views }), expected);
  views[0].knowledge_content[0].application_section_ids.reverse();
  assert.throws(() => assertSharedKnowledgeApplicationMirror(...views), { code: 'RF_OBSIDIAN_KNOWLEDGE_APPLICATION_INVALID' });
  assert.throws(() => collectSharedKnowledgeApplications({ item, presentation, views }), { code: 'RF_OBSIDIAN_KNOWLEDGE_APPLICATION_INVALID' });
  for (const view of views) view.knowledge_content[0].application_section_ids = ['other'];
  assert.throws(() => applyReadingFirstKnowledgeContent({ presentation, views: views.slice(0, 1) }), { code: 'RF_OBSIDIAN_KNOWLEDGE_APPLICATION_INVALID' });
  assert.throws(() => collectSharedKnowledgeApplications({ item, presentation, views }), { code: 'RF_OBSIDIAN_KNOWLEDGE_APPLICATION_INVALID' });

  for (const view of views) delete view.knowledge_content[0].application_section_ids;
  assert.equal(collectSharedKnowledgeApplications({ item, presentation, views }), undefined);
  const editor = { languages: Object.fromEntries(views.map(({ language }) => [language, {
    methods: [{ knowledge_ids: [item.id], section_ids: ['practice'], explanation: 'Reusable explanation.' }],
  }])) };
  for (const view of views) view.placements.knowledge = [];
  assert.deepEqual(collectSharedKnowledgeApplications({ item, presentation, views, editor }), expected);
});

test('renders localized section links and preserves them across publication, relocation and later reuse', () => {
  const applicationSections = [
    { id: 'practice', headings: { 'zh-CN': '测量组成', en: 'Measure composition' } },
    { id: 'figure-result', headings: { 'zh-CN': '呈现组成', en: 'Display composition' } },
  ];
  const options = { item, knowledgeRegistry: [], paperTargets: prior.targets, paperId: prior.paper_id, paperTitle: prior.title,
    vaultPath: value => value, href };
  const content = renderSharedKnowledge({ ...options, applicationSections }).note.content;
  assert.match(content, /\[Bray 2024 · 中文 · 测量组成\]\(\.\.\/sources\/Bray\.zh-CN\.md#\^rf-practice\)/);
  assert.match(content, /\[Bray 2024 · English · Display composition\]\(\.\.\/sources\/Bray\.en\.md#\^rf-figure-result\)/);
  const published = bindPublishedKnowledgeReferences(content, { paperId: prior.paper_id, registeredPapers: new Set([prior.paper_id]) }).content;
  const relocated = published.replaceAll('../sources/Bray.zh-CN.md', '../translations/Bray.zh-CN.md');
  const knowledgeRegistry = [{ id: item.id, path: 'Wiki/methods/饼图.md', content: relocated + after, current_content: true }];
  const later = renderSharedKnowledge({ ...options, knowledgeRegistry, paperTargets: currentTargets, paperId: 'new', paperTitle: 'New paper',
    applicationSections }).note.content;
  assert.match(later, /\[Bray 2024 · 中文 · 测量组成\]\(\.\.\/translations\/Bray\.zh-CN\.md#\^rf-practice\)/);
  assert.match(later, /\[New paper · 中文 · 呈现组成\]\(\.\.\/translations\/New\.zh-CN\.md#\^rf-figure-result\)/);
  assert.ok(later.endsWith(after));
  const history = JSON.parse(Buffer.from(/<!-- KNOWLEDGE_STATE ([A-Za-z0-9+/=]+) -->/.exec(later)[1], 'base64')).applications[0];
  assert.deepEqual(history.sections, applicationSections);
  assert.equal(history.targets['zh-CN'], 'Wiki/translations/Bray.zh-CN.md');
});

test('2.3 Translation cannot invent application sections absent from the accepted Writer view', async t => {
  await assert.rejects(reviewedReadingFirstFixture(t, {
    methodsFirst: true,
    transformTranslation(view) {
      return { ...view, knowledge_content: [{ id: 'method', paragraphs: ['可复用的方法说明。'], application_section_ids: ['methods'] }] };
    },
  }), { code: 'RF_OBSIDIAN_KNOWLEDGE_APPLICATION_INVALID' });
});

test('resolves only appended references when preserving a current shared note', () => {
  const historical = {
    ...item,
    paper_additions: [{
      paper_id: 'bray', title: prior.title,
      paragraphs: { en: ['[Cox model](apa-knowledge:old-cox-id)'], 'zh-CN': ['[Cox 模型](apa-knowledge:old-cox-id)'] },
    }],
  };
  const state = Buffer.from(JSON.stringify({ item: historical, applications: [prior] })).toString('base64');
  const visible = '## English\n\nA preserved [Cox model](Cox.md#English).';
  const original = `${before}${start}\n<!-- KNOWLEDGE_STATE ${state} -->\n${visible}\n${end}${after}`;
  const resolveReferences = value => {
    if (value.includes('apa-knowledge:old-cox-id')) throw new Error('RF_OBSIDIAN_REFERENCE_INVALID');
    return value.replace('apa-knowledge:cox', 'Cox.md');
  };
  const options = {
    item: { ...item, paragraphs: { ...item.paragraphs, en: ['New [Cox method](apa-knowledge:cox).'] } },
    knowledgeRegistry: [{ id: item.id, path: 'Wiki/methods/饼图.md', content: original, current_content: true }],
    paperTargets: currentTargets, paperId: 'new', paperTitle: 'New paper',
    vaultPath: value => value, href, resolveReferences,
  };
  const content = renderSharedKnowledge(options).note.content;
  assert.ok(content.includes(visible));
  assert.ok(content.includes('New [Cox method](Cox.md).'));
  const saved = JSON.parse(Buffer.from(/<!-- KNOWLEDGE_STATE ([A-Za-z0-9+/=]+) -->/.exec(content)[1], 'base64'));
  assert.deepEqual(saved.item.paper_additions[0], historical.paper_additions[0]);
  assert.throws(() => renderSharedKnowledge({
    ...options, item: { ...item, paragraphs: { ...item.paragraphs, en: ['New [broken reference](apa-knowledge:old-cox-id).'] } },
  }), /RF_OBSIDIAN_REFERENCE_INVALID/);
});

test('current paper targets override prior visible destinations', () => {
  const { content, applications } = render(links, { paperId: 'bray', targets: currentTargets });
  assert.deepEqual(applications[0].targets, currentTargets);
  assert.match(content, /\[New paper · 中文\]\(\.\.\/translations\/New\.zh-CN\.md\)/);
});

test('publication binds current entity IDs and keeps unresolvable legacy links visible', () => {
  const visible = 'Uses [visible legacy context](retired.md).';
  const legacy = { ...item, paragraphs: { ...item.paragraphs,
    en: ['[Retired concept](apa-knowledge:retired) and [Moved concept](apa-entity:kept_id)'] } };
  const original = '<!-- KNOWLEDGE_STATE ' + Buffer.from(JSON.stringify({ item: legacy, applications: [prior] })).toString('base64')
    + ' -->\n' + visible;
  const registry = [{ path: 'Wiki/concepts/new-path.md', entity_id: 'kept_id', registered_aliases: ['retired_id'] }];
  const resolve = (id, kind) => registeredKnowledgeReference(registry, id, kind)?.entity_id;
  const bound = bindPublishedKnowledgeReferences(original, {
    reused: true, resolveHistorical: resolve, resolveCurrent: resolve, registeredPapers: new Set(),
  });
  assert.ok(bound.content.endsWith(visible));
  assert.deepEqual(bound.unresolved, ['knowledge:retired', 'paper:bray']);
  const state = JSON.parse(Buffer.from(/<!-- KNOWLEDGE_STATE ([A-Za-z0-9+/=]+) -->/.exec(bound.content)[1], 'base64'));
  assert.deepEqual(state.item.paragraphs.en, ['Retired concept and [Moved concept](apa-entity:kept_id)']);
  assert.deepEqual(state.applications, [{ paper_id: 'bray', title: 'Bray 2024' }]);
  assert.equal(registeredKnowledgeReference(registry, 'retired_id', 'entity').path, 'Wiki/concepts/new-path.md');
});

test('publication disambiguates a historical ID using only its registered link in the original paragraph', () => {
  const historical = { ...item, paper_additions: [{ paper_id: 'bray', title: prior.title,
    paragraphs: { en: ['The regional plot uses [LD](apa-knowledge:ld) to group variants.'] } }] };
  const encoded = Buffer.from(JSON.stringify({ item: historical, applications: [prior] })).toString('base64');
  const preferred = 'The regional plot uses [LD](../concepts/%E4%BF%A1%E5%8F%B7.md#English) to group variants.';
  const other = 'The regional plot uses [LD](../concepts/general.md#English) to group variants.';
  const registry = [
    { id: 'ld', path: 'Wiki/concepts/general.md', entity_id: 'general' },
    { id: 'ld', path: 'Wiki/concepts/信号.md', entity_id: 'signal' },
    { id: 'unrelated', path: 'Wiki/concepts/unrelated.md', entity_id: 'unrelated' },
  ];
  const makeNote = visible => `${start}\n<!-- KNOWLEDGE_STATE ${encoded} -->\n\n${visible}\n\n${end}`;
  const resolve = (id, kind, visiblePath) => registeredKnowledgeReference(registry, id, kind, visiblePath)?.entity_id;
  const publish = original => bindPublishedKnowledgeReferences(`${original}\n\n${preferred}`, {
    paperId: 'new', reused: true, resolveHistorical: resolve, resolveCurrent: resolve,
    historicalSource: { path: 'Wiki/methods/plot.md', content: original },
  });
  const original = makeNote(`Other material uses [LD](../concepts/general.md).\n\n${preferred}`);
  const bound = publish(original);
  assert.deepEqual(bound.unresolved, []);
  const hidden = /<!-- KNOWLEDGE_STATE ([A-Za-z0-9+/=]+) -->/;
  const saved = JSON.parse(Buffer.from(hidden.exec(bound.content)[1], 'base64'));
  assert.equal(saved.item.paper_additions[0].paragraphs.en[0], 'The regional plot uses [LD](apa-entity:signal) to group variants.');
  assert.equal(bound.content.replace(hidden, ''), `${original}\n\n${preferred}`.replace(hidden, ''));

  for (const visible of [
    `${preferred}\n\n${other}`,
    `\`\`\`md\n${preferred}\n\`\`\``,
    preferred.replace('../concepts/%E4%BF%A1%E5%8F%B7.md', 'https://example.com/Wiki/concepts/general.md'),
    preferred.replace('%E4%BF%A1%E5%8F%B7.md', 'unrelated.md'),
  ]) {
    assert.deepEqual(publish(makeNote(visible)).unresolved, ['knowledge:ld']);
  }
});

test('publication binds a retired historical knowledge ID using its original registered link', () => {
  const paragraph = 'Use [time-dependent AUC](apa-knowledge:time-dependent-auc) at a fixed horizon.';
  const visible = paragraph.replace('apa-knowledge:time-dependent-auc', '../concepts/ROC%20AUC.md#English');
  const candidateVisible = paragraph.replace('apa-knowledge:time-dependent-auc', '../concepts/other.md#English');
  const legacy = { ...item, paragraphs: { ...item.paragraphs, en: [paragraph] } };
  const encoded = Buffer.from(JSON.stringify({ item: legacy, applications: [] })).toString('base64');
  const note = text => `${start}\n<!-- KNOWLEDGE_STATE ${encoded} -->\n\n${text}\n\n${end}`;
  const registry = [
    { id: 'time-dependent-roc-auc', path: 'Wiki/concepts/ROC AUC.md', entity_id: 'auc' },
    { id: 'other', path: 'Wiki/concepts/other.md', entity_id: 'other_entity' },
  ];
  const resolve = (id, kind, visiblePath) => registeredKnowledgeReference(registry, id, kind, visiblePath)?.entity_id;
  const result = bindPublishedKnowledgeReferences(note(candidateVisible), {
    reused: true, resolveCurrent: resolve, resolveHistorical: resolve,
    historicalSource: { path: 'Wiki/methods/plot.md', content: note(visible) },
  });
  assert.deepEqual(result.unresolved, []);
  const hidden = /<!-- KNOWLEDGE_STATE ([A-Za-z0-9+/=]+) -->/;
  const saved = JSON.parse(Buffer.from(hidden.exec(result.content)[1], 'base64'));
  assert.equal(saved.item.paragraphs.en[0], 'Use [time-dependent AUC](apa-entity:auc) at a fixed horizon.');
  assert.equal(result.content.replace(hidden, ''), note(candidateVisible).replace(hidden, ''));
});

test('publication binds a newly included historical application using its corresponding candidate paragraph', () => {
  const paragraph = 'The tracing panel uses a [Sankey diagram](apa-knowledge:sankey-diagram) to show label flow.';
  const visible = paragraph.replace('apa-knowledge:sankey-diagram', 'Sankey%20diagram.md#English');
  const makeNote = (value, addition = true) => {
    const state = { item: { ...item, paper_additions: addition ? [{ paper_id: 'bray', paragraphs: { en: [paragraph] } }] : [] }, applications: [] };
    const encoded = Buffer.from(JSON.stringify(state)).toString('base64');
    return `${start}\n<!-- KNOWLEDGE_STATE ${encoded} -->\n\n${value}\n\n${end}`;
  };
  const registry = [{ id: 'chart-sankey-diagram', path: 'Wiki/methods/Sankey diagram.md', entity_id: 'sankey' }];
  const resolve = (id, kind, visiblePath) => registeredKnowledgeReference(registry, id, kind, visiblePath)?.entity_id;
  const publish = (candidate, original) => bindPublishedKnowledgeReferences(makeNote(candidate), {
    paperId: 'new', reused: true, resolveCurrent: resolve, resolveHistorical: resolve,
    historicalSource: { path: 'Wiki/methods/tracing.md', content: original },
  });
  const original = makeNote('Common tracing definition.', false);
  const result = publish(visible, original);
  assert.deepEqual(result.unresolved, []);
  const hidden = /<!-- KNOWLEDGE_STATE ([A-Za-z0-9+/=]+) -->/;
  const saved = JSON.parse(Buffer.from(hidden.exec(result.content)[1], 'base64'));
  assert.equal(saved.item.paper_additions[0].paragraphs.en[0], 'The tracing panel uses a [Sankey diagram](apa-entity:sankey) to show label flow.');
  assert.equal(result.content.replace(hidden, ''), makeNote(visible).replace(hidden, ''));

  assert.deepEqual(publish(`${visible}\n\n${visible}`, original).unresolved, ['knowledge:sankey-diagram']);
  assert.deepEqual(publish(visible.replace('Sankey%20diagram.md', '../../Raw/Sankey.md'), original).unresolved, ['knowledge:sankey-diagram']);
  assert.deepEqual(publish(visible, makeNote(visible.replace('Sankey%20diagram.md', 'unregistered.md'))).unresolved, ['knowledge:sankey-diagram']);
  assert.deepEqual(publish(visible, makeNote(`${visible}\n\n${visible}`)).unresolved, ['knowledge:sankey-diagram']);
});

test('does not infer a target from duplicate or external matching links', () => {
  const repeated = render(`${links}\n- [Bray 2024 · 中文](../translations/Bray.zh-CN.md)`);
  assert.equal(repeated.applications[0].targets['zh-CN'], 'Wiki/sources/Bray.zh-CN.md');
  const external = render('- [Bray 2024 · 中文](https://example.com/Bray.zh-CN.md)');
  assert.equal(external.applications[0].targets['zh-CN'], 'Wiki/sources/Bray.zh-CN.md');
});

test('ignores code, other sections, and different paper or language identities', () => {
  const visible = '```md\n- [Bray 2024 · 中文](../translations/Bray.zh-CN.md)\n```\n'
    + '- [Other paper · 中文](../translations/Bray.zh-CN.md)\n'
    + '- [Bray 2024 · English](../translations/Bray.zh-CN.md)\n'
    + '## Other section\n- [Bray 2024 · 中文](../translations/Bray.zh-CN.md)';
  assert.equal(render(visible).applications[0].targets['zh-CN'], 'Wiki/sources/Bray.zh-CN.md');
});

test('does not infer a target if two prior papers have the same visible identity', () => {
  const other = { ...prior, paper_id: 'another' };
  const { applications } = render(links, { prior: [prior, other] });
  assert.equal(applications[0].targets['zh-CN'], 'Wiki/sources/Bray.zh-CN.md');
  assert.equal(applications[1].targets['zh-CN'], 'Wiki/sources/Bray.zh-CN.md');
});
