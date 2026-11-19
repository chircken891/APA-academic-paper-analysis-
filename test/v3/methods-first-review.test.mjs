import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCriticalReviewNodes } from '../../scripts/v3/reading-first-review-nodes.mjs';

const profile = 'configured-reading-2.3';
const prior = [{ kind: 'main_conclusion' }, { kind: 'key_design' }];
const source = { id: 'paper', path: 'paper.pdf', page_count: 8 };
const context = {
  sources: [source],
  presentation: { map: { steps: [{ id: 'select', section_id: 'methods' }] } },
  views: ['en', 'zh-CN'].map(language => ({ language, sections: [{ id: 'methods' }] })),
};
const method = {
  kind: 'method_application', status: 'checked', location: '3.1',
  finding: 'The authors applied the cut point selected on training data to the held-out group.',
  step_ids: ['select'], section_ids: ['methods'],
  source_refs: [{ source_id: 'paper', locator: { kind: 'pdf-page', page: 4 } }],
};
const check = (node, issues = []) => checkCriticalReviewNodes({ key_nodes: [...prior, node], issues }, profile, context);

test('the legacy and methods-first reviews require their own critical evidence', () => {
  assert.equal(checkCriticalReviewNodes({ key_nodes: prior }, 'configured-reading-2.2'), true);
  assert.equal(checkCriticalReviewNodes({ key_nodes: prior }, profile, context), false);
  assert.equal(check(method), true);
  assert.equal(check({ ...method, status: 'unavailable', step_ids: [] }), false);
});

test('method review references resolve against the source, process and both manuscripts', () => {
  for (const fields of [{ status: 'unknown' }, { step_ids: ['other'] }, { section_ids: ['other'] },
    { source_refs: [] }, { source_refs: [{ ...method.source_refs[0], source_id: 'other' }] }]) {
    assert.throws(() => check({ ...method, ...fields }), /METHOD_REVIEW_INVALID/);
  }
  assert.throws(() => checkCriticalReviewNodes({ key_nodes: [...prior, method], issues: [] }, profile,
    { ...context, views: [context.views[0], { language: 'zh-CN', sections: [] }] }), /METHOD_REVIEW_INVALID/);
});

test('a substantive omission needs a repair, and genre exceptions need grounds', () => {
  const issue = { ...method, status: 'material_issue' };
  assert.throws(() => check(issue), /METHOD_REVIEW_INVALID/);
  assert.equal(check(issue, [{ severity: 'material', repair_scope: { section_ids: ['methods'] } }]), false);
  const exception = { ...method, status: 'not_applicable', step_ids: [] };
  assert.throws(() => check(exception), /METHOD_REVIEW_INVALID/);
  const editorial = { ...exception, article_type: 'Editorial introduction', rationale: 'The cited introduction presents the issue and contains no selection or analysis.' };
  assert.throws(() => check(editorial), /METHOD_REVIEW_INVALID/);
  assert.equal(checkCriticalReviewNodes({ key_nodes: [...prior, editorial], issues: [] }, profile,
    { ...context, presentation: { map: { steps: [] } } }), true);
});
