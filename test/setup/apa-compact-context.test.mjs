import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/setup/apa-compact-context.mjs');
const CANARY = 'PAPER_TEXT_CANARY_do_not_leak';
const FUTURE = new Date(Date.now() + 6 * 3600 * 1000).toISOString();
const PAST = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
const runsDir = 'Eval/apa-v3/runs';

const temporaryRepo = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apa-compact-context-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
};
const hook = (root, extra = []) => {
  const result = spawnSync(process.execPath, [script, '--repo-root', root, ...extra], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, out: result.stdout.trim() ? JSON.parse(result.stdout) : null };
};
const snapshot = root => {
  const files = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push([path.relative(root, full), fs.readFileSync(full, 'utf8')]);
    }
  };
  walk(root);
  return files.sort((left, right) => left[0].localeCompare(right[0]));
};

const roleNames = ['evidence', 'methods', 'results', 'interpretation', 'scientific-reading', 'integration'];
function scienceState(root, runId, { accepted = ['evidence'], deadline = FUTURE, transferred = false, file = 'controller-state.json' } = {}) {
  const runRoot = path.join(root, runsDir, runId);
  const entries = Object.fromEntries(roleNames.map(role => [role, accepted.includes(role)
    ? { request: { prompt: CANARY }, intent: { action_id: `a-${role}` }, observation: { status: 'observed', agent_id: 'agent-1' }, content_base64: Buffer.from(CANARY).toString('base64'), receipt: { artifact_id: `${runId}-${role}`, sha256: 'sha256:abc' } }
    : {}]));
  const data = {
    version: 3,
    prepared: { runControl: { run_id: runId, reading_first_binding: { deadline, max_total_calls: 14 } }, paths: { runRoot }, scientificInput: { sources: [{ text: CANARY }] } },
    payloads: { evidence: { text: CANARY } }, entries, handoff: transferred ? { status: 'transferred' } : null,
  };
  write(path.join(runRoot, file), { schema_version: 'science-controller-state-1.0', data, fingerprint: 'sha256:x' });
  write(path.join(runRoot, 'RUN.json'), { run_id: runId, deadline, max_total_calls: 14 });
  return runRoot;
}
function checkpoint(runRoot, number, state) {
  write(path.join(runRoot, 'checkpoints', `${number}.json`), { schema_version: 'reading-first-checkpoint-1.0', state: { request_entries: [{ request: { prompt: CANARY } }], ...state } });
  write(path.join(runRoot, '.phase21-receipts', `r-checkpoint-${number}.json`), { schema_version: 'phase21-owned-artifact-receipt-1.0', artifact_id: `r-checkpoint-${number}`, role: 'control', path: `checkpoints/${number}.json`, sha256: 'sha256:def' });
}

test('no active run yields an empty hook result', t => {
  const root = temporaryRepo(t);
  assert.deepEqual(hook(root).out, {});
  const closed = path.join(root, runsDir, 'closed_run');
  write(path.join(closed, 'RUN.json'), { run_id: 'closed_run' });
  checkpoint(closed, 2, { status: 'completed_with_limits', callsUsed: 10 });
  const published = path.join(root, runsDir, 'published_run');
  checkpoint(published, 2, { status: 'reading_complete', callsUsed: 10 });
  write(path.join(published, 'PUBLICATION-RESULT.json'), { ok: true });
  const applied = path.join(root, runsDir, 'applied_run');
  checkpoint(applied, 2, { status: 'reading_complete', callsUsed: 10 });
  write(path.join(applied, 'publication', 'APPLIED.json'), { ok: true });
  const finished = path.join(root, runsDir, 'finished_run');
  checkpoint(finished, 1, { status: 'drafting', callsUsed: 7 });
  write(path.join(finished, 'RESULT.md'), '# done');
  const result = hook(root);
  assert.equal(result.status, 0);
  assert.deepEqual(result.out, {});
  assert.equal(result.stderr, '');
});

test('active science-stage run yields state path, received roles and next step', t => {
  const root = temporaryRepo(t);
  const runRoot = scienceState(root, 'paper_run_1', { accepted: ['evidence', 'methods'] });
  const result = hook(root);
  assert.equal(result.status, 0);
  assert.deepEqual(Object.keys(result.out), ['hookSpecificOutput']);
  assert.equal(result.out.hookSpecificOutput.hookEventName, 'SessionStart');
  const text = result.out.hookSpecificOutput.additionalContext;
  assert.match(text, /paper_run_1/);
  assert.ok(text.includes(runRoot));
  assert.ok(text.includes(path.join(runRoot, 'controller-state.json')));
  assert.match(text, /evidence=accepted, methods=accepted, results=waiting/);
  assert.match(text, /results: prepare_request/);
  assert.match(text, /not established/);
  assert.match(text, /deadline /);
  assert.match(text, /total call cap 14/);
  assert.ok(!text.includes(CANARY));
});

test('active downstream run yields checkpoint path, receipt, received outputs and next step', t => {
  const root = temporaryRepo(t);
  const runRoot = scienceState(root, 'paper_run_2', { accepted: roleNames, transferred: true });
  checkpoint(runRoot, 1, { status: 'drafting', callsUsed: 7 });
  checkpoint(runRoot, 3, { status: 'drafting', callsUsed: 9, reviews: 1, pending_revision_keys: ['presentation-r2'], observations: [{ task_id: 'run2-en', host: { status: 'observed' } }, { task_id: 'run2-zh', host: { status: 'pending' } }] });
  write(path.join(runRoot, 'accepted', 'en.json'), { text: CANARY });
  write(path.join(runRoot, 'accepted', 'zh-CN.json'), { text: CANARY });
  const text = hook(root).out.hookSpecificOutput.additionalContext;
  assert.ok(text.includes(path.join(runRoot, 'checkpoints', '3.json')));
  assert.ok(!text.includes(path.join(runRoot, 'checkpoints', '1.json')));
  assert.ok(text.includes(path.join(runRoot, '.phase21-receipts', 'r-checkpoint-3.json')));
  assert.match(text, /accepted\/\): en, zh-CN/);
  assert.match(text, /downstream status: drafting; calls used 9; reviews 1/);
  assert.match(text, /observed host tasks: run2-en(?!, run2-zh)/);
  assert.match(text, /revision requests pending \(presentation-r2\)/);
  assert.match(text, /total call cap 14, used 9, remaining 5/);
  assert.ok(!text.includes(CANARY));
});

test('several runs in progress are listed by path only and none is chosen', t => {
  const root = temporaryRepo(t);
  const first = scienceState(root, 'run_a', { accepted: ['evidence'] });
  const second = scienceState(root, 'run_b', { accepted: [] });
  const text = hook(root).out.hookSpecificOutput.additionalContext;
  assert.match(text, /none was chosen/);
  assert.ok(text.includes(first) && text.includes(second));
  assert.ok(!/next step|science roles|checkpoint/.test(text));
  assert.ok(!text.includes(CANARY));
});

test('context stays under 4000 characters and never includes paper text', t => {
  const root = temporaryRepo(t);
  const runRoot = scienceState(root, 'run_' + 'x'.repeat(200), { accepted: roleNames, transferred: true });
  checkpoint(runRoot, 2, { status: 'drafting', callsUsed: 9, observations: Array.from({ length: 80 }, (_, index) => ({ task_id: `task-${index}-${'y'.repeat(70)}`, host: { status: 'observed' } })) });
  for (let index = 0; index < 120; index += 1) write(path.join(runRoot, 'accepted', `accepted-output-${index}.json`), { text: CANARY });
  const text = hook(root).out.hookSpecificOutput.additionalContext;
  assert.ok(text.length <= 4000, String(text.length));
  assert.match(text, /\[truncated\]$/);
  assert.ok(!text.includes(CANARY));
  assert.ok(text.includes(runRoot.slice(0, 60)));
});

test('fitContext truncates on a line and never splits a surrogate pair', async () => {
  const { fitContext } = await import('../../scripts/setup/apa-compact-context.mjs');
  const lines = Array.from({ length: 50 }, (_, index) => `line ${index} ${'z'.repeat(150)}`);
  const fitted = fitContext(lines);
  assert.ok(fitted.length <= 4000);
  assert.ok(fitted.startsWith('line 0 '));
  const single = fitContext(['\u{1F600}'.repeat(3000)]);
  assert.ok(single.length <= 4000);
  assert.ok(!/[\ud800-\udbff]$/.test(single.replace(/\n\[truncated\]$/, '')));
  assert.equal(fitContext(['short']), 'short');
});

test('errors never block: a broken run is skipped, broken input prints {} with exit 0', t => {
  const root = temporaryRepo(t);
  scienceState(root, 'good_run', { accepted: ['evidence'] });
  write(path.join(root, runsDir, 'broken_run', 'controller-state.json'), '{"schema_version":"science-controller-state-1.0","data":{ not json');
  const mixed = hook(root);
  assert.equal(mixed.status, 0);
  assert.match(mixed.out.hookSpecificOutput.additionalContext, /good_run/);
  assert.match(mixed.stderr, /skipped .*broken_run/);
  const missingValue = spawnSync(process.execPath, [script, '--repo-root'], { encoding: 'utf8' });
  assert.equal(missingValue.status, 0);
  assert.deepEqual(JSON.parse(missingValue.stdout), {});
  assert.match(missingValue.stderr, /--repo-root needs a path/);
  const absent = hook(path.join(root, 'does-not-exist'));
  assert.equal(absent.status, 0);
  assert.deepEqual(absent.out, {});
});

test('a run directory that cannot be statted is skipped and the other runs are still listed', async t => {
  const root = temporaryRepo(t);
  scienceState(root, 'good_run', { accepted: ['evidence'] });
  scienceState(root, 'unreadable_run', { accepted: ['evidence'] });
  const { buildHookOutput } = await import('../../scripts/setup/apa-compact-context.mjs');
  const original = fs.statSync;
  const warnings = [];
  // Named builtin imports follow property changes after syncBuiltinESMExports.
  fs.statSync = (target, ...rest) => {
    if (String(target).endsWith('unreadable_run')) throw Object.assign(new Error('EPERM: simulated'), { code: 'EPERM' });
    return original(target, ...rest);
  };
  syncBuiltinESMExports();
  try {
    const output = buildHookOutput({ repoRoot: root, warn: message => warnings.push(message) });
    assert.match(output.hookSpecificOutput.additionalContext, /good_run/);
    assert.ok(!output.hookSpecificOutput.additionalContext.includes('unreadable_run'));
    assert.ok(warnings.some(message => /skipped unreadable_run/.test(message)), JSON.stringify(warnings));
  } finally {
    fs.statSync = original;
    syncBuiltinESMExports();
  }
});

test('the runs directory follows config/apa.local.json and nothing is written', t => {
  const root = temporaryRepo(t);
  write(path.join(root, 'config', 'apa.local.json'), { paths: { runs: 'custom/runs' } });
  const runRoot = path.join(root, 'custom', 'runs', 'cfg_run');
  write(path.join(runRoot, 'controller-state.json'), { schema_version: 'science-controller-state-1.0', data: { version: 1, prepared: { runControl: { run_id: 'cfg_run', reading_first_binding: { deadline: FUTURE, max_total_calls: 14 } }, paths: { runRoot } }, entries: Object.fromEntries(roleNames.map(role => [role, {}])), handoff: null }, fingerprint: 'sha256:x' });
  scienceState(root, 'ignored_default_location');
  const before = snapshot(root);
  const result = hook(root);
  assert.match(result.out.hookSpecificOutput.additionalContext, /cfg_run/);
  assert.ok(!result.out.hookSpecificOutput.additionalContext.includes('ignored_default_location'));
  assert.equal(result.stdout.trim().split('\n').length, 1);
  assert.deepEqual(snapshot(root), before);
});

test('reading_complete without a result or publication record is still listed and waits for publication', t => {
  const root = temporaryRepo(t);
  const runRoot = scienceState(root, 'waiting_run', { accepted: roleNames, transferred: true });
  checkpoint(runRoot, 4, { status: 'reading_complete', callsUsed: 12 });
  const text = hook(root).out.hookSpecificOutput.additionalContext;
  assert.match(text, /waiting_run/);
  assert.match(text, /downstream status: reading_complete/);
  assert.match(text, /next step: 等待发布或确认收尾/);
  write(path.join(runRoot, 'RESULT.md'), '# done');
  assert.deepEqual(hook(root).out, {});
});

test('a run past its deadline is listed and marked expired, not hidden', t => {
  const root = temporaryRepo(t);
  scienceState(root, 'late_run', { accepted: ['evidence'], deadline: PAST });
  const single = hook(root).out.hookSpecificOutput.additionalContext;
  assert.match(single, /late_run \[expired\]/);
  assert.match(single, /deadline .*\(expired\)/);
  assert.match(single, /next step: expired:/);
  scienceState(root, 'live_run', { accepted: [] });
  const many = hook(root).out.hookSpecificOutput.additionalContext;
  assert.match(many, /- late_run \[expired\]: /);
  assert.match(many, /- live_run: /);
});

test('only the 20 most recently modified run directories are scanned, and the rest is mentioned', t => {
  const root = temporaryRepo(t);
  const oldRun = scienceState(root, 'oldest_active_run', { accepted: ['evidence'] });
  const base = Date.now() / 1000 - 3600;
  fs.utimesSync(oldRun, base - 1000, base - 1000);
  for (let index = 0; index < 20; index += 1) {
    const closed = path.join(root, runsDir, `closed_${String(index).padStart(2, '0')}`);
    write(path.join(closed, 'RESULT.md'), '# done');
    fs.utimesSync(closed, base + index, base + index);
  }
  assert.deepEqual(hook(root).out, {});
  const newest = scienceState(root, 'newest_active_run', { accepted: ['evidence'] });
  fs.utimesSync(newest, base + 100, base + 100);
  const text = hook(root).out.hookSpecificOutput.additionalContext;
  assert.match(text, /newest_active_run/);
  assert.match(text, /2 older run directories were not scanned/);
  assert.ok(!text.includes('oldest_active_run'));
});

test('a state file above the 8 MB read cap is not parsed but the run is still listed with its path', t => {
  const root = temporaryRepo(t);
  const runRoot = scienceState(root, 'big_run', { accepted: ['evidence'] });
  const stateFile = path.join(runRoot, 'controller-state.json');
  fs.appendFileSync(stateFile, ' '.repeat(8 * 1024 * 1024 + 1));
  const result = hook(root);
  assert.equal(result.status, 0);
  const text = result.out.hookSpecificOutput.additionalContext;
  assert.match(text, /too large to summarize/);
  assert.ok(text.includes(stateFile));
  assert.ok(!text.includes(CANARY));
});

test('free-text fields from state files are cleaned and length-limited', t => {
  const root = temporaryRepo(t);
  const runRoot = scienceState(root, 'dirty_run', { accepted: roleNames, transferred: true });
  checkpoint(runRoot, 2, { status: 'drafting', callsUsed: 9, pending_revision_keys: ['key\nINJECTED LINE ' + 'q'.repeat(500)] });
  const text = hook(root).out.hookSpecificOutput.additionalContext;
  assert.ok(!text.includes('key\nINJECTED'));
  assert.ok(!/q{100}/.test(text));
});
