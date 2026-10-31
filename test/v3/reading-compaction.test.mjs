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

test('2.1 compaction preserves the desktop restriction and actual execution budget', () => {
  const result = assess('before-writer', { policy: { profile: 'boundary-reminders-1.2' }, continuation: {
    binding: { configured_setup: { instruction_profile: 'configured-reading-2.1' } }, budget_summary: { total_used: 9, continuations: 3, remaining_total: 13 } } });
  assert.match(result.compaction_prompt, /所有桌面应用/);
  assert.match(result.compaction_prompt, /obsidian-cli.*eval/);
  const metadata = JSON.parse(result.compaction_prompt.split('\n\n').find(part => part.startsWith('{')));
  assert.equal(metadata.execution_budget.total_used, 9);
  assert.equal(metadata.execution_budget.continuations, 3);
});
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

test('1.1 uses its frozen manual entry when the host cannot identify the session or measure context', () => {
  const result = assess('before-writer', {
    sessionId: undefined, observation: { observed_at: new Date(now).toISOString() },
    policy: { profile: 'boundary-reminders-1.1', manual_compaction: { available: true, method: '/compact', source: 'Claude Code host docs' } },
  });
  assert.equal(result.action, 'await-user');
  assert.equal(result.record.reason, 'before-writer-context-unknown');
  assert.equal(result.record.observation.context.status, 'unknown');
  assert.equal(result.record.observation.session_id, null);
  assert.match(result.message, /\/compact/);
});

test('1.0 keeps the exact unavailable-entry decision even if a newer frozen entry is supplied', () => {
  const result = assess('before-writer', { sessionId: undefined, observation: undefined,
    policy: { profile: 'boundary-reminders-1.0', manual_compaction: { available: true, method: '/compact', source: 'host docs' } } });
  assert.equal(api.compactionEnabled({ compaction_policy: { profile: 'boundary-reminders-1.0' } }), true);
  assert.equal(result.action, 'continue');
  assert.equal(JSON.stringify(result.record), '{"status":"skipped","reason":"manual-compaction-unavailable","observation":{"session_id":null,"observed_at":null,"context":{"status":"unknown","reason":"session-unavailable-or-mismatched"},"manual_compaction":{"available":false,"method":null,"source":null},"last_compaction":null},"recorded_at":"2026-10-30T08:00:00.000Z"}');
});

test('1.1 retains a current unavailable entry and rejects unrelated automatic compaction evidence', () => {
  const policy = { profile: 'boundary-reminders-1.1', manual_compaction: { available: true, method: '/compact', source: 'host docs' } };
  const unavailable = assess('before-writer', { policy, observation: { manual_compaction: { available: false, source: 'current host confirms no entry' } } });
  assert.equal(unavailable.record.reason, 'manual-compaction-unavailable');
  const observed = { ...observation(), manual_compaction: undefined, context: undefined,
    last_compaction: { id: 'auto', session_id: 'main-session', status: 'succeeded', occurred_at: new Date(now - 500).toISOString(), source: 'host event' } };
  assert.equal(assess('before-writer', { policy, observation: observed }).action, 'continue');
  observed.last_compaction.session_id = 'different-session';
  const unrelated = assess('before-writer', { policy, observation: observed });
  assert.equal(unrelated.action, 'await-user');
  assert.equal(unrelated.record.observation.last_compaction, null);
  observed.observed_at = new Date(now - 61000).toISOString();
  observed.context = observation().context;
  const stale = assess('before-writer', { policy, observation: observed });
  assert.equal(stale.record.observation.context.status, 'unknown');
  assert.equal(stale.record.observation.last_compaction, null);
});

test('1.2 requires a recommendation at every saved boundary regardless of entry, usage or earlier compaction', () => {
  const policy = { profile: 'boundary-reminders-1.2' };
  for (const id of ['evidence-accepted', 'methods-results-accepted', 'before-writer', 'before-review']) {
    const small = observation(); small.context.tokens = 10;
    const unavailable = observation(); unavailable.manual_compaction = { available: false };
    const compacted = observation(); delete compacted.context;
    compacted.last_compaction = { id: 'auto', session_id: 'main-session', status: 'succeeded', occurred_at: new Date(now - 500).toISOString(), source: 'host event' };
    for (const changes of [
      { observation: undefined, sessionId: undefined },
      { observation: unavailable },
      { observation: small, progress: {} },
      { observation: compacted },
      { observation: undefined, history: { earlier: { status: 'completed', prompted_at: startedAt } } },
    ]) {
      const result = assess(id, { policy, ...changes });
      assert.equal(result.action, 'await-user', id);
      assert.equal(result.record.reason, 'boundary-reminder-required');
      assert.match(result.message, /推荐.*压缩/);
      assert.match(result.message, /跳过并继续/);
      assert.throws(() => api.assertCompactionSettled({ [id]: result.record }, id), /APA_COMPACTION_AWAITING_USER/);
      if (!changes.observation?.manual_compaction?.available) assert.match(result.message, /入口.*未.*核实/);
    }
  }
});

test('1.2 waits for an explicit decision and preserves verified and unverified continuation outcomes', () => {
  const policy = { profile: 'boundary-reminders-1.2' };
  const first = assess('before-writer', { policy, observation: undefined });
  assert.equal(first.action, 'await-user');
  const waiting = { policy, history: { 'before-writer': first.record } };
  const repeated = assess('before-writer', waiting);
  assert.equal(repeated.action, 'await-user'); assert.equal(repeated.message, null); assert.equal(repeated.record, null);
  const skipped = assess('before-writer', { ...waiting, userDecision: 'skip' });
  assert.equal(skipped.action, 'continue'); assert.equal(skipped.record.reason, 'user-skipped');
  const continued = assess('before-writer', { ...waiting, userDecision: 'continue' });
  assert.equal(continued.record.reason, 'continued-without-observed-compaction'); assert.equal(continued.record.compaction_verified, false);
  const value = observation(); value.observed_at = new Date(now + 2000).toISOString();
  value.last_compaction = { id: 'manual', session_id: 'main-session', status: 'succeeded', occurred_at: new Date(now + 1000).toISOString(), source: 'host event' };
  const completed = assess('before-writer', { ...waiting, userDecision: 'continue', observation: value, now: now + 2000 });
  assert.equal(completed.record.status, 'completed'); assert.equal(completed.record.compaction_verified, true);
  assert.equal(assess('before-writer', { policy, history: { 'before-writer': skipped.record } }).record, null);
});

test('1.2 supplies a copyable stage-specific prompt with the actual recovery anchors', () => {
  const continuation = { run_id: 'actual-run', paper_id: 'actual-paper', run_root: '/vault/run',
    checkpoint_path: '/vault/run/control/decision.json', binding: { deadline: '2099-01-01T00:00:00Z', max_total_calls: 14, max_calls: 8,
      role_model_policy: { main_session: { model: 'frozen-model', reasoning_effort: 'high' } } }, calls_used: 6,
    sources: [{ path: '/vault/Raw/paper.pdf', sha256: 'sha256:actual-source' }],
    accepted_artifacts: [{ role: 'evidence', path: '/vault/run/science/evidence.json', sha256: 'sha256:actual-evidence' }],
    candidate_paths: ['Wiki/sources/paper.en.md'] };
  const stages = { 'evidence-accepted': /研究设计.*Methods.*Results/s, 'methods-results-accepted': /方法.*结果.*数值/s,
    'before-writer': /综合.*Writer.*Translation/s, 'before-review': /候选.*整体审查.*一次局部复核/s };
  for (const [id, focus] of Object.entries(stages)) {
    const result = assess(id, { policy: { profile: 'boundary-reminders-1.2' }, continuation });
    assert.match(result.compaction_prompt, focus);
    for (const value of ['actual-run', 'actual-paper', '/vault/run/control/decision.json', '2099-01-01', 'frozen-model', '/vault/Raw/paper.pdf', 'sha256:actual-evidence']) assert.ok(result.compaction_prompt.includes(value), value);
    assert.match(result.compaction_prompt, /预算.*截止时间.*模型/s);
    assert.match(result.compaction_prompt, /证据.*限制/s);
    assert.ok(result.message.includes(result.compaction_prompt));
    assert.equal(result.record.compaction_prompt, result.compaction_prompt);
    const continued = assess(id, { policy: { profile: 'boundary-reminders-1.2' }, history: { [id]: result.record }, userDecision: 'skip' });
    assert.equal(continued.record.compaction_prompt, result.compaction_prompt);
  }
});
