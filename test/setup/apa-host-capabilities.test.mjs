import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { inspectApaConfig, loadHostProfile } from '../../scripts/lib/apa-config.mjs';

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
  assert.equal(inspection.capability_check.checks.length, 6);
  assert.ok(inspection.capability_check.checks.every(row => row.status === 'unknown'));
  assert.equal(inspection.capability_check.runtime_validation, 'not_run');
  assert.equal(check(repoRoot, profile(), 'delegated_diagnostics').status, 'detected');
  assert.equal(check(repoRoot, profile(), 'threshold_compaction').status, 'unknown');
  assert.deepEqual(fs.readdirSync(repoRoot), []);
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
