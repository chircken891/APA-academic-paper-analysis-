import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { renderSharedKnowledge } from '../../scripts/v3/reading-first-knowledge.mjs';

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

test('preserves a prior paper relocated visible target in the candidate and hidden state', () => {
  const { content, applications } = render(links);
  assert.equal(applications.find(row => row.paper_id === 'bray').targets['zh-CN'], 'Wiki/translations/Bray.zh-CN.md');
  assert.match(content, /\[Bray 2024 · 中文\]\(\.\.\/translations\/Bray\.zh-CN\.md\)/);
  assert.ok(content.startsWith(before));
  assert.ok(content.endsWith(after));
});

test('current paper targets override prior visible destinations', () => {
  const { content, applications } = render(links, { paperId: 'bray', targets: currentTargets });
  assert.deepEqual(applications[0].targets, currentTargets);
  assert.match(content, /\[New paper · 中文\]\(\.\.\/translations\/New\.zh-CN\.md\)/);
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
