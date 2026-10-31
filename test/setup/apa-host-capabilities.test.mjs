import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { inspectApaConfig, loadHostProfile } from '../../scripts/lib/apa-config.mjs';
import { resolveHostContinuation } from '../../scripts/lib/apa-host-capabilities.mjs';

const temporary = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apa-host-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};
const profile = () => ({
  schema_version: 'apa-host-profile-1.0', host: 'synthetic-host', detected_at: '2026-10-28T10:00:00Z',
  session: { model: null, reasoning_effort: null }, models: [],
  dispatch: { tool: 'Agent', model_argument: null, effort_argument: null, instruction_argument: 'prompt', task_name_argument: null, fresh_context: null },
  sources: { session: 'unavailable', models: 'unavailable', dispatch: 'tool-schema' },
});
const finding = () => ({ status: 'detected', method: 'launch --threshold <value>', scope: 'new-session', evidence: [{ source: 'host-docs', reference: 'synthetic installed help v1' }], limitations: [] });
const threshold = () => ({ candidate_tokens: 200000, unit: 'tokens', setting: '--threshold', formula: 'absolute', setting_min: 100000, setting_max: 1000000, effective_target_verified: true, context_window_tokens: 1000000, output_reserve_tokens: 32000, headroom_tokens: 64000, retained_tokens: 100000, measurement: 'total input tokens' });
const check = (repoRoot, hostProfile, id) => inspectApaConfig({ repoRoot, hostProfile }).capability_check.checks.find(row => row.id === id);

test('missing and legacy profiles retain unknown capabilities and do not write or change readiness', t => {
  const repoRoot = temporary(t);
  const inspection = inspectApaConfig({ repoRoot, capability: 'query' });
  assert.equal(inspection.ready, true);
  assert.equal(inspection.capability_check.checks.length, 7);
  assert.ok(inspection.capability_check.checks.every(row => row.status === 'unknown'));
  assert.equal(inspection.capability_check.runtime_validation, 'not_run');
  assert.equal(check(repoRoot, profile(), 'delegated_diagnostics').status, 'detected');
  assert.equal(check(repoRoot, profile(), 'threshold_compaction').status, 'unknown');
  assert.deepEqual(fs.readdirSync(repoRoot), []);
});

test('continuation requires evidence for the same live host and binds only the original handle', t => {
  const repoRoot = temporary(t);
  const report = profile();
  const options = { hostName: report.host, handle: 'real-handle', message: 'Continue the remaining sections.' };
  assert.equal(resolveHostContinuation(report, options).status, 'unknown');
  report.capabilities = { task_continuation: { ...finding(), scope: 'current-session',
    continuation: { tool: 'followup_task', handle_argument: 'target', instruction_argument: 'message', same_context: true, original_host_accessible: true } } };
  assert.deepEqual(resolveHostContinuation(report, options).arguments, { target: 'real-handle', message: options.message });
  assert.equal(resolveHostContinuation(report, options).host_action, 'followup_task');
  assert.equal(check(repoRoot, report, 'task_continuation').status, 'detected');
  assert.equal(resolveHostContinuation(report, { ...options, hostName: 'other-host' }).status, 'blocked');
  assert.equal(resolveHostContinuation(report, { ...options, handle: null }).status, 'blocked');
  report.capabilities.task_continuation.continuation.same_context = false;
  assert.equal(resolveHostContinuation(report, options).status, 'blocked');
  report.capabilities.task_continuation.continuation.same_context = true;
  report.capabilities.task_continuation.evidence = [];
  assert.equal(resolveHostContinuation(report, options).status, 'unknown');
  report.capabilities.task_continuation.status = 'unsupported';
  assert.equal(resolveHostContinuation(report, options).status, 'unsupported');
  assert.deepEqual(fs.readdirSync(repoRoot), []);
});

test('continuation capability is a validated optional host report, not a saved configuration choice', t => {
  const repoRoot = temporary(t), file = path.join(repoRoot, 'profile.json');
  const report = profile();
  report.capabilities = { task_continuation: { ...finding(), scope: 'current-session',
    continuation: { tool: 'followup_task', handle_argument: 'target', instruction_argument: 'message', same_context: true, original_host_accessible: true } } };
  fs.writeFileSync(file, JSON.stringify(report));
  assert.deepEqual(loadHostProfile(file), report);
  report.capabilities.task_continuation.continuation.same_context = 'yes';
  fs.writeFileSync(file, JSON.stringify(report));
  assert.throws(() => loadHostProfile(file), /APA_HOST_PROFILE_INVALID/);
});

test('CLI accepts evidence-backed optional capability reports without saving answers', t => {
  const repoRoot = temporary(t);
  const report = profile();
  report.capabilities = { threshold_compaction: { ...finding(), threshold: threshold() } };
  const file = path.join(repoRoot, 'profile.json');
  fs.writeFileSync(file, JSON.stringify(report));
  assert.deepEqual(loadHostProfile(file), report);
  const run = spawnSync(process.execPath, [path.resolve('scripts/apa-setup.mjs'), 'inspect', '--repo-root', repoRoot, '--host-profile', file], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout).capability_check;
  const row = result.checks.find(item => item.id === 'threshold_compaction');
  assert.equal(row.status, 'detected');
  assert.equal(row.scope, 'new-session');
  assert.equal(row.threshold.candidate_value, 200000);
  assert.equal(result.runtime_validation, 'not_run');
  assert.deepEqual(fs.readdirSync(repoRoot), ['profile.json']);
});

test('unsupported, blocked and evidence-free reports never become supported by host name', t => {
  const repoRoot = temporary(t);
  for (const host of ['codex-desktop', 'claude-code', 'deepseek-harness']) {
    const report = { ...profile(), host, capabilities: { threshold_compaction: { ...finding(), status: 'blocked', limitations: ['patch misses isolated preset'], threshold: threshold() } } };
    assert.equal(check(repoRoot, report, 'threshold_compaction').status, 'blocked');
    report.capabilities.threshold_compaction.status = 'unsupported';
    assert.equal(check(repoRoot, report, 'threshold_compaction').status, 'unsupported');
    report.capabilities.threshold_compaction = { ...finding(), evidence: [] };
    assert.equal(check(repoRoot, report, 'threshold_compaction').status, 'unknown');
  }
});

test('threshold checks distinguish missing effective target, capacity limits and ratio calculation', t => {
  const repoRoot = temporary(t);
  const report = profile();
  const cap = { ...finding(), threshold: threshold() };
  report.capabilities = { threshold_compaction: cap };
  cap.threshold.effective_target_verified = false;
  assert.equal(check(repoRoot, report, 'threshold_compaction').status, 'blocked');
  cap.threshold.effective_target_verified = true;
  cap.threshold.context_window_tokens = null;
  assert.equal(check(repoRoot, report, 'threshold_compaction').status, 'conditional');
  cap.threshold = { ...threshold(), unit: 'ratio', formula: 'window-ratio-bounded', setting_min: 0, setting_max: 1 };
  let row = check(repoRoot, report, 'threshold_compaction');
  assert.equal(row.threshold.candidate_value, 0.2);
  assert.equal(row.threshold.effective_trigger_tokens, 200000);
  cap.threshold.context_window_tokens = 250000;
  row = check(repoRoot, report, 'threshold_compaction');
  assert.equal(row.status, 'blocked');
  assert.equal(row.threshold.feasibility, 'incompatible');
  cap.threshold = { ...threshold(), retained_tokens: 200000 };
  assert.equal(check(repoRoot, report, 'threshold_compaction').status, 'blocked');
  cap.threshold = { ...threshold(), formula: 'unknown' };
  row = check(repoRoot, report, 'threshold_compaction');
  assert.equal(row.status, 'conditional');
  assert.equal(row.threshold.effective_trigger_tokens, null);
  cap.threshold = { ...threshold(), candidate_tokens: 90000, retained_tokens: 50000 };
  assert.equal(check(repoRoot, report, 'threshold_compaction').status, 'blocked');
  cap.threshold = { ...threshold(), unit: 'ratio' };
  assert.equal(check(repoRoot, report, 'threshold_compaction').status, 'blocked');
  cap.threshold = { ...threshold(), setting_max: null };
  assert.equal(check(repoRoot, report, 'threshold_compaction').status, 'conditional');
});

test('model-dependent behavior remains conditional and saved host recovery reports adapter gap', t => {
  const repoRoot = temporary(t);
  const report = profile();
  report.capabilities = Object.fromEntries(['on_demand_reading', 'concise_replies', 'science_recovery'].map(id => [id, { ...finding(), scope: 'current-session' }]));
  for (const id of ['on_demand_reading', 'concise_replies', 'science_recovery']) assert.equal(check(repoRoot, report, id).status, 'conditional');
  fs.mkdirSync(path.join(repoRoot, 'config'));
  const bytes = JSON.stringify({ schema_version: 'apa-local-config-1.0', host: { name: report.host, dispatch: report.dispatch } });
  fs.writeFileSync(path.join(repoRoot, 'config/apa.local.json'), bytes);
  const row = check(repoRoot, report, 'science_recovery');
  assert.equal(row.status, 'blocked');
  assert.ok(row.limitations.some(value => value.includes('action_id')));
  assert.equal(fs.readFileSync(path.join(repoRoot, 'config/apa.local.json'), 'utf8'), bytes);
});

test('capability schema rejects invented pass status, invalid units and negative limits', t => {
  const repoRoot = temporary(t);
  const file = path.join(repoRoot, 'profile.json');
  for (const cap of [{ ...finding(), status: 'passed' }, { ...finding(), threshold: { ...threshold(), unit: 'characters' } }, { ...finding(), threshold: { ...threshold(), candidate_tokens: -1 } }]) {
    fs.writeFileSync(file, JSON.stringify({ ...profile(), capabilities: { threshold_compaction: cap } }));
    assert.throws(() => loadHostProfile(file), /APA_HOST_PROFILE_INVALID/);
  }
});

const evidence = [{ source: 'host-docs', reference: 'installed help' }];
const step = (extra = {}) => ({ actor: 'user', instruction: '按宿主文档操作', command: null, scope: 'current-session', persistent: false, verify: '检查结果', evidence, ...extra });
const achievement = (extra = {}) => ({ state: 'achieved', summary: '已检测', steps: [step()], ...extra });
const resultHandle = { source: 'text', pattern: 'agentId:\\s*([A-Za-z0-9_-]+)' };
const saveHost = (root, report, dispatch = report.dispatch, name = report.host) => {
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config/apa.local.json'), JSON.stringify({ schema_version: 'apa-local-config-1.0', host: { name, dispatch } }));
};

test('unknown host declaration survives profile load and inspection without synthesized recipes', t => {
  const root = temporary(t);
  const report = profile();
  report.capabilities = { manual_compaction: { ...finding(), achievement: achievement() } };
  const file = path.join(root, 'profile.json');
  fs.writeFileSync(file, JSON.stringify(report));
  const loaded = loadHostProfile(file);
  const result = inspectApaConfig({ repoRoot: root, hostProfile: loaded, capability: 'query' });
  assert.deepEqual(result.capability_check.checks.find(row => row.id === 'manual_compaction').achievement, report.capabilities.manual_compaction.achievement);
  assert.equal(result.capability_check.checks.find(row => row.id === 'concise_replies').achievement.state, 'needs-user-action');
  assert.deepEqual(result.capability_check.adapters, []);
  assert.equal(result.ready, true);
  assert.equal(result.capability_check.runtime_validation, 'not_run');
});

test('claims require evidence and cannot contradict status or lack investigation', t => {
  const root = temporary(t);
  const report = profile();
  const cap = { ...finding(), achievement: achievement() };
  report.capabilities = { manual_compaction: cap };
  for (const status of ['blocked', 'unknown', 'unsupported']) {
    cap.status = status;
    assert.equal(check(root, report, 'manual_compaction').achievement.state, 'needs-user-action');
  }
  cap.status = 'detected';
  cap.method = null;
  assert.equal(check(root, report, 'manual_compaction').achievement.state, 'needs-user-action');
  cap.method = 'manual';
  cap.scope = 'unknown';
  assert.equal(check(root, report, 'manual_compaction').achievement.state, 'needs-user-action');
  cap.scope = 'current-session';
  cap.evidence = [];
  cap.achievement.steps[0].evidence = [];
  assert.equal(check(root, report, 'manual_compaction').achievement.state, 'needs-user-action');
  cap.achievement.state = 'not-found';
  assert.equal(check(root, report, 'manual_compaction').achievement.state, 'needs-user-action');
  cap.limitations = ['已检查安装版帮助'];
  assert.equal(check(root, report, 'manual_compaction').achievement.state, 'not-found');
});

test('achieved declarations require evidence for every step', t => {
  const root = temporary(t);
  const report = { ...profile(), capabilities: { manual_compaction: { ...finding(), achievement: achievement({ steps: [step(), step({ evidence: [] })] }) } } };
  const result = check(root, report, 'manual_compaction').achievement;
  assert.equal(result.state, 'needs-user-action');
  assert.match(result.summary, /步骤.*依据/);
  report.capabilities.manual_compaction.achievement.steps[1].evidence = evidence;
  assert.equal(check(root, report, 'manual_compaction').achievement.state, 'achieved');
});

test('placeholder command without an explicit range is blocked', t => {
  const root = temporary(t);
  const report = { ...profile(), capabilities: { threshold_compaction: { ...finding(), threshold: threshold(), achievement: achievement({ state: 'needs-setting', steps: [step({ command: 'tool --limit <N>' })] }) } } };
  const result = check(root, report, 'threshold_compaction').achievement;
  assert.equal(result.state, 'needs-user-action');
  assert.equal(result.steps[0].command, null);
  assert.match(result.summary, /范围/);
});

test('science recovery requires matching saved host, valid handle and complete lookup', t => {
  const root = temporary(t);
  const report = profile();
  report.dispatch.result_handle = resultHandle;
  const recovery = { task_handle_path: 'response.agentId', lookup_tool: 'lookup', lookup_argument: 'id', original_host_accessible: true };
  report.capabilities = { science_recovery: { ...finding(), recovery, achievement: achievement() } };
  assert.equal(check(root, report, 'science_recovery').achievement.state, 'needs-user-action');
  const { result_handle: ignored, ...withoutHandle } = report.dispatch;
  saveHost(root, report, withoutHandle);
  assert.equal(check(root, report, 'science_recovery').achievement.state, 'needs-user-action');
  saveHost(root, report, { ...report.dispatch, result_handle: { source: 'text', pattern: '(other)' } });
  assert.equal(check(root, report, 'science_recovery').achievement.state, 'needs-user-action');
  saveHost(root, report, report.dispatch, 'another-host');
  assert.equal(check(root, report, 'science_recovery').achievement.state, 'needs-user-action');
  saveHost(root, report);
  assert.equal(check(root, report, 'science_recovery').achievement.state, 'achieved');
  recovery.lookup_tool = null;
  assert.equal(check(root, report, 'science_recovery').achievement.state, 'needs-user-action');
  recovery.lookup_tool = 'lookup';
  report.dispatch.result_handle.pattern = 'agentId:[a-z]+';
  saveHost(root, report);
  assert.equal(check(root, report, 'science_recovery').achievement.state, 'needs-user-action');
  report.dispatch.result_handle.pattern = '(';
  saveHost(root, report);
  assert.equal(check(root, report, 'science_recovery').achievement.state, 'needs-user-action');
});

test('threshold range commands require templates and never substitute user selection', t => {
  const root = temporary(t);
  const cap = { ...finding(), threshold: threshold(), achievement: achievement({ state: 'needs-setting', steps: [step({ command: 'tool --limit 200000', range: { min: 0, max: 1000000, unit: 'tokens' } })] }) };
  const report = { ...profile(), capabilities: { threshold_compaction: cap } };
  let row = check(root, report, 'threshold_compaction');
  assert.equal(row.achievement.steps[0].command, null);
  assert.match(row.achievement.summary, /<N>/);
  cap.achievement.steps[0].command = 'tool-v2 --limit <N>';
  row = check(root, report, 'threshold_compaction');
  assert.equal(row.achievement.steps[0].command, 'tool-v2 --limit <N>');
  assert.equal(row.threshold.candidate_value, 200000);
});

test('threshold command without range and template is blocked', t => {
  const root = temporary(t);
  const cap = { ...finding(), threshold: { ...threshold(), candidate_tokens: null }, achievement: achievement({ state: 'needs-setting', steps: [step({ command: 'tool --limit 200000' })] }) };
  const result = check(root, { ...profile(), capabilities: { threshold_compaction: cap } }, 'threshold_compaction').achievement;
  assert.equal(result.state, 'needs-user-action');
  assert.equal(result.steps[0].command, null);
  assert.match(result.summary, /范围|<N>/);
});

test('threshold commands are blocked when the target backend is unverified', t => {
  const root = temporary(t);
  const cap = { ...finding(), threshold: { ...threshold(), effective_target_verified: false }, achievement: achievement({ state: 'needs-setting', steps: [step({ command: 'tool --limit <N>', range: { min: 100000, max: 1000000, unit: 'tokens' } }), step({ command: null })] }) };
  const result = check(root, { ...profile(), capabilities: { threshold_compaction: cap } }, 'threshold_compaction').achievement;
  assert.equal(result.state, 'needs-user-action');
  assert.ok(result.steps.every(item => item.command === null));
  assert.match(result.summary, /后端|目标/);
});

test('threshold command retains a valid token template with verified target', t => {
  const root = temporary(t);
  const cap = { ...finding(), threshold: threshold(), achievement: achievement({ state: 'needs-setting', steps: [step({ command: 'tool --limit <N>', range: { min: 100000, max: 1000000, unit: 'tokens' } })] }) };
  const result = check(root, { ...profile(), capabilities: { threshold_compaction: cap } }, 'threshold_compaction').achievement;
  assert.equal(result.state, 'needs-setting');
  assert.equal(result.steps[0].command, 'tool --limit <N>');
});

test('adapter declarations are checked read-only and block commands when unavailable', t => {
  const root = temporary(t);
  const folder = path.join(root, 'config/backups/example-owner/adapters/host-patch');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'entry.mjs'), 'do not execute');
  const adapter = { id: 'host-patch', owner: 'example-owner', host: 'synthetic-host', root: 'config/backups/example-owner/adapters/host-patch', entrypoints: ['entry.mjs'], evidence };
  const report = { ...profile(), adapters: [adapter], capabilities: { manual_compaction: { ...finding(), achievement: achievement({ steps: [step({ adapter_id: adapter.id, command: 'run entry' })] }) } } };
  const inspect = () => inspectApaConfig({ repoRoot: root, hostProfile: report, capability: 'query' }).capability_check;
  let result = inspect();
  assert.equal(result.adapters[0].status, 'available');
  assert.equal(result.checks.find(row => row.id === 'manual_compaction').achievement.steps[0].command, 'run entry');
  for (const change of [
    { root: 'config/backups/other-owner/adapters/host-patch' },
    { root: 'config/apa-adapters/example-owner/host-patch' },
    { entrypoints: ['missing.mjs'] },
    { entrypoints: ['../../outside.mjs'] },
    { entrypoints: ['..\\..\\outside.mjs'] },
    { host: 'other-host' },
  ]) {
    Object.assign(adapter, { root: 'config/backups/example-owner/adapters/host-patch', entrypoints: ['entry.mjs'], host: 'synthetic-host' }, change);
    result = inspect();
    assert.equal(result.adapters[0].status, 'blocked');
    assert.ok(result.adapters[0].issues.length);
    const item = result.checks.find(row => row.id === 'manual_compaction').achievement;
    assert.equal(item.state, 'needs-user-action');
    assert.equal(item.steps[0].command, null);
  }
  report.adapters = [];
  assert.equal(inspect().checks.find(row => row.id === 'manual_compaction').achievement.steps[0].command, null);
  assert.equal(fs.readFileSync(path.join(folder, 'entry.mjs'), 'utf8'), 'do not execute');
});

test('adapter realpath rejects a junction escaping its declared root', t => {
  const root = temporary(t);
  const folder = path.join(root, 'config/backups/example-owner/adapters/host-patch');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(folder, { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'entry.mjs'), 'unchanged');
  fs.symlinkSync(outside, path.join(folder, 'link'), 'junction');
  const report = { ...profile(), adapters: [{ id: 'host-patch', owner: 'example-owner', host: 'synthetic-host', root: 'config/backups/example-owner/adapters/host-patch', entrypoints: ['link/entry.mjs'], evidence }] };
  assert.equal(inspectApaConfig({ repoRoot: root, hostProfile: report }).capability_check.adapters[0].status, 'blocked');
});

test('schema rejects malformed declarations without affecting old profiles', t => {
  const root = temporary(t);
  const file = path.join(root, 'profile.json');
  const cap = { ...finding(), achievement: achievement() };
  const adapter = { id: 'host-patch', owner: 'example-owner', host: 'synthetic-host', root: 'config/backups/example-owner/adapters/host-patch', entrypoints: ['entry.mjs'], evidence };
  for (const report of [
    { ...profile(), capabilities: { manual_compaction: { ...cap, achievement: achievement({ state: 'done' }) } } },
    { ...profile(), capabilities: { manual_compaction: { ...cap, achievement: achievement({ steps: [step({ evidence: [{ source: 'unknown', reference: 'x' }] })] }) } } },
    { ...profile(), capabilities: { manual_compaction: { ...cap, achievement: achievement({ steps: [step({ range: { min: 0, max: 1, unit: 'characters' } })] }) } } },
    { ...profile(), adapters: [{ ...adapter, owner: 'Other Owner' }] },
    { ...profile(), adapters: [{ ...adapter, entrypoints: [] }] },
  ]) {
    fs.writeFileSync(file, JSON.stringify(report));
    assert.throws(() => loadHostProfile(file), /APA_HOST_PROFILE_INVALID/);
  }
});
