import assert from 'node:assert/strict';
import test from 'node:test';
import { COMPACTION_POLICY, COMPACTION_BOUNDARIES, compactionEnabled, compactionReminder, createCompactionPolicy } from '../../scripts/v3/reading-compaction.mjs';

test('the policy freezes only its profile', () => {
  assert.deepEqual(createCompactionPolicy(), { profile: COMPACTION_POLICY });
  assert.equal(compactionEnabled({ compaction_policy: createCompactionPolicy() }), true);
  assert.equal(compactionEnabled({}), false);
});

test('every stage boundary gets a reminder with a copyable stage prompt', () => {
  assert.deepEqual([...COMPACTION_BOUNDARIES], ['evidence-accepted', 'methods-results-accepted', 'before-writer', 'before-review']);
  for (const id of COMPACTION_BOUNDARIES) {
    const reminder = compactionReminder(id, { run_id: 'run-1' });
    assert.equal(reminder.boundary_id, id);
    assert.match(reminder.message, /请压缩上下文/);
    assert.ok(reminder.message.includes(reminder.compaction_prompt));
    assert.match(reminder.compaction_prompt, new RegExp(`（${id}）`));
  }
  assert.throws(() => compactionReminder('after-review'), /APA_COMPACTION_BOUNDARY_INVALID/);
});

test('the stage prompt keeps the desktop restriction and actual execution budget', () => {
  const { compaction_prompt: prompt } = compactionReminder('before-writer', {
    run_id: 'run-1', binding: { max_total_calls: 22 }, budget_summary: { total_used: 9, continuations: 3, remaining_total: 13 },
    sources: [{ path: 'Clippings/a.pdf', sha256: 'sha256:x', byte_length: 3 }] });
  assert.match(prompt, /所有桌面应用/);
  assert.match(prompt, /obsidian-cli.*eval/);
  const metadata = JSON.parse(prompt.split('\n\n').find(part => part.startsWith('{')));
  assert.equal(metadata.run_id, 'run-1');
  assert.equal(metadata.max_total_calls, 22);
  assert.deepEqual(metadata.execution_budget, { total_used: 9, continuations: 3, remaining_total: 13 });
  assert.deepEqual(metadata.sources, [{ path: 'Clippings/a.pdf', sha256: 'sha256:x' }]);
  assert.equal(metadata.checkpoint_path, null);
});
