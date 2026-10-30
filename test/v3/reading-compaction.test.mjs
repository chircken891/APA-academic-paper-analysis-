import assert from 'node:assert/strict';
import test from 'node:test';

const api = await import('../../scripts/v3/reading-compaction.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const now = Date.parse('2026-10-30T08:00:00Z');
const startedAt = '2026-10-30T07:00:00Z';
const boundary = id => ({ id, reached: true, recovery: { saved: true }, running_count: 0, reminder: { status: 'pending' } });
const observation = () => ({
  session_id: 'main-session', observed_at: new Date(now).toISOString(),
  manual_compaction: { available: true, method: 'host compact action', source: 'current host tools' },
  context: { tokens: 180000, kind: 'last-request-input', measured_at: new Date(now - 1000).toISOString(), fresh: true, source: 'request usage 42' },
});
const progress = { remaining_work: { multiple_responses: true, reason: 'Writer, translation and review remain.' }, growth: { substantial: true, reason: 'Large tool responses since the last checkpoint.' } };
function assess(id, changes = {}) {
  assert.equal(typeof api.evaluateCompactionBoundary, 'function', 'the common boundary evaluator is required');
  return api.evaluateCompactionBoundary({ boundary: boundary(id), sessionId: 'main-session', startedAt, observation: observation(), progress, now, ...changes });
}

test('known context evaluates every boundary without depending on a host name', () => {
  for (const id of ['evidence-accepted', 'methods-results-accepted', 'before-writer', 'before-review']) {
    const result = assess(id);
    assert.equal(result.action, 'await-user');
    assert.equal(result.record.status, 'prompted');
    assert.match(result.message, /host compact action/);
    assert.match(result.message, /最近.*请求/);
  }
});

test('unknown usage prompts once before Writer and skips the other boundaries', () => {
  const unknown = observation(); delete unknown.context;
  for (const id of ['evidence-accepted', 'methods-results-accepted', 'before-review']) {
    const result = assess(id, { observation: unknown });
    assert.equal(result.action, 'continue');
    assert.equal(result.record.status, 'skipped');
  }
  const result = assess('before-writer', { observation: unknown });
  assert.equal(result.action, 'await-user');
  assert.match(result.message, /用量未知/);
  for (const status of ['prompted', 'skipped', 'completed']) {
    const history = { 'evidence-accepted': { status, prompted_at: '2026-10-30T07:40:00Z' } };
    assert.equal(assess('before-writer', { observation: unknown, history }).action, 'continue');
  }
});

test('stale, unrelated, cumulative and pre-compaction measurements become unknown', () => {
  const cases = [
    value => { value.session_id = 'child-session'; },
    value => { value.context.kind = 'cumulative-input'; },
    value => { value.context.fresh = false; },
    value => { value.observed_at = new Date(now - 120000).toISOString(); },
    value => { value.context.measured_at = new Date(now - 120000).toISOString(); },
    value => { value.last_compaction = { id: 'c1', session_id: 'main-session', status: 'succeeded', occurred_at: new Date(now - 500).toISOString(), source: 'host successful replacement' }; },
  ];
  for (const change of cases) {
    const value = observation(); change(value);
    const result = assess('evidence-accepted', { observation: value });
    assert.equal(result.action, 'continue');
    assert.equal(result.record.observation.context.status, 'unknown');
  }
});

test('insufficient remaining work, growth or context skips a known-usage reminder', () => {
  const small = observation(); small.context.tokens = 80000;
  assert.equal(assess('before-writer', { observation: small }).action, 'continue');
  assert.equal(assess('before-writer', { progress: { ...progress, remaining_work: { multiple_responses: false, reason: 'One short reply remains.' } } }).action, 'continue');
  assert.equal(assess('before-review', { progress: { ...progress, growth: { substantial: false, reason: 'Just compacted.' } } }).action, 'continue');
  assert.equal(assess('before-writer', { progress: {} }).action, 'continue');
});

test('unsupported manual compaction skips while unsafe boundaries require reconciliation', () => {
  const value = observation(); value.manual_compaction = { available: false, source: 'host capabilities' };
  assert.equal(assess('before-writer', { observation: value }).action, 'continue');
  for (const changed of [{ recovery: { saved: false } }, { running_count: 1 }, { running_count: null }]) {
    const result = assess('before-writer', { boundary: { ...boundary('before-writer'), ...changed } });
    assert.equal(result.action, 'reconcile');
    assert.equal(result.record, null);
  }
});

test('a successful automatic compaction suppresses the unknown-usage fallback', () => {
  const value = observation(); delete value.context;
  value.last_compaction = { id: 'auto-1', session_id: 'main-session', status: 'succeeded', occurred_at: '2026-10-30T07:59:00Z', source: 'host replacement event' };
  assert.equal(assess('before-writer', { observation: value }).action, 'continue');
  value.last_compaction.status = 'failed';
  assert.equal(assess('before-writer', { observation: value }).action, 'await-user');
  value.last_compaction.status = 'succeeded'; value.last_compaction.occurred_at = '2026-10-30T06:00:00Z';
  assert.equal(assess('before-writer', { observation: value }).action, 'await-user');
});

test('waiting requires a user decision and continuation never invents a successful compaction', () => {
  const first = assess('before-writer');
  const history = { 'before-writer': first.record };
  const waiting = { ...boundary('before-writer'), reminder: first.record };
  assert.equal(assess('before-writer', { boundary: waiting, history }).action, 'await-user');
  const continued = assess('before-writer', { boundary: waiting, history, userDecision: 'continue' });
  assert.equal(continued.action, 'continue');
  assert.equal(continued.record.status, 'skipped');
  assert.equal(continued.record.compaction_verified, false);
  const value = observation();
  value.last_compaction = { id: 'manual-1', session_id: 'main-session', status: 'succeeded', occurred_at: new Date(now + 1000).toISOString(), source: 'host successful replacement' };
  value.observed_at = new Date(now + 2000).toISOString();
  const completed = assess('before-writer', { boundary: waiting, history, observation: value, userDecision: 'continue', now: now + 2000 });
  assert.equal(completed.record.status, 'completed');
  const settled = { ...waiting, reminder: completed.record };
  assert.equal(assess('before-writer', { boundary: settled, history: { 'before-writer': completed.record } }).record, null);
});

test('a previously saved successful compaction invalidates an older usage reading', () => {
  const history = { 'evidence-accepted': { status: 'skipped', observation: { last_compaction: {
    id: 'saved-auto', session_id: 'main-session', status: 'succeeded', occurred_at: new Date(now - 500).toISOString(), source: 'saved host event',
  } } } };
  const result = assess('methods-results-accepted', { history });
  assert.equal(result.record.observation.context.status, 'unknown');
  assert.equal(result.record.observation.context.reason, 'measurement-precedes-compaction');
});
