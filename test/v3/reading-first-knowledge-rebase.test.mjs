import test from 'node:test';
import assert from 'node:assert/strict';
import { extractOwnKnowledge, compareOwnKnowledge } from '../../scripts/v3/reading-first-knowledge.mjs';

const item = { id: 'm', paragraphs: { en: ['Own'], 'zh-CN': ['本篇'] }, sections: { en: [{ heading: 'Design', paragraphs: ['Detail'] }] }, formulas: [{ latex: 'x', description: { en: 'X', 'zh-CN': '值' } }], sources: [{ url: 'https://example.org', title: 'Source' }], aliases: ['Alias'] };
const content = node => `<!-- KNOWLEDGE_STATE ${Buffer.from(JSON.stringify({ item: node, applications: [] })).toString('base64')} -->`;
const extract = (node, mode) => extractOwnKnowledge({ content: content(node), paperId: 'paper-b', item, mode });
const reused = () => ({ ...item, paragraphs: { en: ['Prior'], 'zh-CN': [] }, sections: {}, paper_additions: [{ paper_id: 'paper-b', paragraphs: item.paragraphs, sections: item.sections }] });

test('explicit mode distinguishes an existing node with the same item identity', () => {
  const node = reused();
  assert.deepEqual(extract(node, 'reused').paragraphs.en, ['Own']);
  assert.deepEqual(extract(item, 'created').paragraphs.en, ['Own']);
  assert.deepEqual(extract(node, 'reused').node, node);
});

test('created and reused contributions compare in both successful mode combinations', () => {
  for (const original of [extract(item, 'created'), extract(reused(), 'reused')]) {
    for (const rebased of [extract(item, 'created'), extract(reused(), 'reused')]) {
      assert.deepEqual(compareOwnKnowledge({ original, rebased, existing: {}, path: 'Wiki/methods/M.md' }), { dropped_paragraphs: [] });
    }
  }
});

test('deduplicated paragraphs are recorded from existing node content', () => {
  const node = reused();
  node.paper_additions[0].paragraphs = { en: [], 'zh-CN': ['本篇'] };
  const result = compareOwnKnowledge({ original: extract(item, 'created'), rebased: extract(node, 'reused'), existing: { paragraphs: { en: ['Own'] } } });
  assert.deepEqual(result.dropped_paragraphs, [{ language: 'en', section: null, paragraph: 'Own' }]);
});

for (const field of ['paragraphs', 'sections', 'formulas', 'sources', 'aliases']) {
  test(`missing own ${field} is rejected with node diagnostics`, () => {
    const node = reused();
    if (field === 'paragraphs') node.paper_additions[0].paragraphs = {};
    else if (field === 'sections') node.paper_additions[0].sections = {};
    else node[field] = [];
    assert.throws(() => compareOwnKnowledge({ original: extract(item, 'created'), rebased: extract(node, 'reused'), existing: {}, path: 'Wiki/methods/M.md' }), error => error.code === 'RF_REBASE_OWN_KNOWLEDGE_CHANGED' && error.details.path === 'Wiki/methods/M.md');
  });
}

test('extra own paragraphs and changed formula descriptions are rejected', () => {
  const node = reused();
  node.paper_additions = structuredClone(node.paper_additions);
  node.paper_additions[0].paragraphs.en.push('Unexpected');
  assert.throws(() => compareOwnKnowledge({ original: extract(item, 'created'), rebased: extract(node, 'reused'), existing: {} }), { code: 'RF_REBASE_OWN_KNOWLEDGE_CHANGED' });
  node.paper_additions[0].paragraphs.en.pop();
  node.formulas = [{ latex: 'x', description: { en: 'Changed', 'zh-CN': '值' } }];
  assert.throws(() => compareOwnKnowledge({ original: extract(item, 'created'), rebased: extract(node, 'reused'), existing: {} }), { code: 'RF_REBASE_OWN_KNOWLEDGE_CHANGED' });
});
