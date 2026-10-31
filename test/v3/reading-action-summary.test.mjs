import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReadingActionSummary } from '../../scripts/v3/reading-action-summary.mjs';

test('maximum state path and long identifiers still produce a bounded summary', () => {
  const long = 'x'.repeat(512), statePath = '/'.padEnd(4096, 's');
  const summary = buildReadingActionSummary({ runId: long, stage: long, status: long, action: long, taskId: long,
    handle: long, blockCode: long, statePath, budget: { remaining_total: 2, total_limit: 20 } });
  assert.ok(Buffer.byteLength(JSON.stringify(summary), 'utf8') <= 8192);
  assert.equal(summary.truncated, true);
  assert.equal(summary.state_ref, statePath);
  assert.equal(summary.budget.remaining_total, 2);
  assert.equal(summary.authorization.desktop_control, 'explicit-user-authorization-required');
});

test('action summaries project only the allowed fields and retain unknown legacy execution budget', () => {
  const summary = buildReadingActionSummary({ runId: 'run', stage: 'reading', status: 'drafting', action: 'wait', taskId: 'zh-CN', handle: 'real-task',
    statePath: '/run/control/reading-checkpoint-7.json', budget: { task_calls_used: 8, total_limit: 22, full_role: 'private body' },
    source_view: 'private source', arguments: { prompt: 'private instructions' } });
  assert.deepEqual(Object.keys(summary).sort(), ['run_id', 'stage', 'status', 'next_action', 'task', 'budget', 'block_code', 'artifacts', 'authorization', 'truncated', 'state_ref'].sort());
  assert.equal(summary.budget.remaining_total, null);
  assert.equal(summary.budget.status, 'unknown');
  assert.equal(summary.budget.task_calls_used, 8);
  assert.doesNotMatch(JSON.stringify(summary), /private/);
  assert.equal(summary.authorization.desktop_control, 'explicit-user-authorization-required');
});

test('large Unicode paths obey the byte limit and reference cap without truncating budget or authority', () => {
  const budget = { status: 'known', task_calls_used: 14, initial_dispatches: 14, continuations: 7, total_used: 21, reserved: 0, occupied: 21, total_limit: 22, remaining_total: 1 };
  const summary = buildReadingActionSummary({ runId: 'run', stage: 'reading', status: 'revising', action: 'dispatch', taskId: 'review-r2',
    statePath: '/run/control/checkpoint.json', budget, artifacts: Array.from({ length: 40 }, (_, i) => ({ path: '/' + '文'.repeat(900) + i, sha256: 'sha256:' + 'a'.repeat(64), byte_length: 100, text: 'private' })) });
  assert.ok(Buffer.byteLength(JSON.stringify(summary), 'utf8') <= 8192);
  assert.ok(summary.artifacts.length <= 8);
  assert.equal(summary.truncated, true);
  assert.deepEqual(summary.budget, budget);
  assert.equal(summary.state_ref, '/run/control/checkpoint.json');
  assert.equal(summary.authorization.desktop_control, 'explicit-user-authorization-required');
});
