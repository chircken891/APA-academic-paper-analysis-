import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { bindPublishedKnowledgeReferences, draftReadingFirstKnowledgeComparisons, matchReadingFirstKnowledgeIdentity,
  registeredKnowledgeReference, renderSharedKnowledge } from '../../scripts/v3/reading-first-knowledge.mjs';

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
