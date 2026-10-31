import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REQUIRED_SEARCH_SOURCES, checkPageGate, deriveSetupIssues, investigationGaps } from '../../scripts/lib/apa-setup-issues.mjs';
import { inspectApaConfig, loadHostProfile, loadIssueLedger } from '../../scripts/lib/apa-config.mjs';

const temporary = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apa-setup-issues-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};
const profile = capabilities => ({
  schema_version: 'apa-host-profile-1.0', host: 'synthetic-host', detected_at: '2026-10-29T10:00:00Z',
  session: { model: null, reasoning_effort: null }, models: [],
  dispatch: { tool: 'Agent', model_argument: null, effort_argument: null, instruction_argument: 'prompt', task_name_argument: null, fresh_context: null },
  sources: { session: 'unavailable', models: 'unavailable', dispatch: 'tool-schema' },
  ...(capabilities ? { capabilities } : {}),
});
const evidence = [{ source: 'local-code', reference: 'synthetic.mjs:1' }];
const fullSearch = () => ({ searched: REQUIRED_SEARCH_SOURCES.map((source, index) => index < 2
  ? { source, location: null, result: 'not-applicable', note: 'synthetic host has none' }
  : { source, location: `synthetic/${source}`, result: 'absent', note: 'nothing found' }) });
const capability = (overrides = {}) => ({
  status: 'detected', method: 'synthetic', scope: 'current-session', evidence, limitations: [],
  achievement: { state: 'achieved', summary: 'ok', steps: [] }, investigation: fullSearch(), ...overrides,
});
const allCapabilities = overrides => Object.fromEntries(['on_demand_reading', 'delegated_diagnostics', 'manual_compaction', 'concise_replies', 'science_recovery', 'threshold_compaction'].map(id => [id, overrides[id] ?? capability()]));
const issuesFor = (t, hostProfile) => inspectApaConfig({ repoRoot: temporary(t), capability: 'query', hostProfile }).setup_issues;
const ids = issues => issues.map(item => item.id);

test('unknown capability without search is a known limit', t => {
  const unknown = capability({ status: 'unknown', achievement: { state: 'not-found', summary: 'none', steps: [] } });
  delete unknown.investigation;
  const issue = issuesFor(t, profile(allCapabilities({ threshold_compaction: unknown }))).find(item => item.id === 'known-limit:capability:threshold_compaction');
  assert.ok(issue);
  assert.equal(issue.category, 'known-limit');
  assert.deepEqual(issue.detail, REQUIRED_SEARCH_SOURCES);
});

test('full search turns unknown into known-limit', t => {
  const unknown = capability({ status: 'unknown', achievement: { state: 'not-found', summary: 'none', steps: [] } });
  const issues = ids(issuesFor(t, profile(allCapabilities({ threshold_compaction: unknown }))));
  assert.ok(!issues.includes('investigate:capability:threshold_compaction'));
  assert.ok(issues.includes('known-limit:capability:threshold_compaction'));
});

test('empty location does not count', () => {
  const input = capability({ investigation: { searched: [{ source: 'runtime-log', location: null, result: 'absent', note: 'not checked' }] } });
  assert.ok(investigationGaps(input).includes('runtime-log'));
  assert.equal(investigationGaps(capability()).length, 0);
});

test('host differs and missing fields are page-choice', () => {
  const inspection = { validation: { missing: ['models.science'], conflicts: [] }, dependencies: [], host_check: { host: 'differs', issues: [] }, capability_check: { checks: [] } };
  const issues = ids(deriveSetupIssues(inspection, profile(allCapabilities({}))));
  assert.ok(issues.includes('page-choice:host:differs'));
  assert.ok(issues.includes('page-choice:missing:models.science'));
});

test('unavailable dependency and persistent apa step are authorize', () => {
  const step = { actor: 'apa', instruction: 'patch host', command: null, scope: 'user-settings', persistent: true, verify: 'read back', evidence };
  const achievement = { state: 'needs-setting', summary: 'needs patch', steps: [step] };
  const inspection = {
    validation: { missing: [], conflicts: [] }, dependencies: [{ key: 'parser.python', path: '/x', status: 'missing' }], host_check: { host: 'match', issues: [] },
    capability_check: { checks: [{ id: 'manual_compaction', status: 'detected', achievement }] },
  };
  const issues = ids(deriveSetupIssues(inspection, profile(allCapabilities({ manual_compaction: capability({ achievement }) }))));
  assert.ok(issues.includes('authorize:dependency:parser.python'));
  assert.ok(issues.includes('authorize:capability:manual_compaction'));
});

test('a user step routes the capability to the page', () => {
  const steps = [
    { actor: 'user', instruction: 'enter N', command: null, scope: 'user-settings', persistent: false, verify: 'preview', evidence },
    { actor: 'apa', instruction: 'apply after approval', command: null, scope: 'user-settings', persistent: true, verify: 'read back', evidence },
  ];
  const achievement = { state: 'needs-user-action', summary: 'choose', steps };
  const inspection = { validation: { missing: [], conflicts: [] }, dependencies: [], host_check: { host: 'match', issues: [] }, capability_check: { checks: [{ id: 'threshold_compaction', status: 'detected', achievement }] } };
  const issues = ids(deriveSetupIssues(inspection, profile(allCapabilities({ threshold_compaction: capability({ achievement }) }))));
  assert.ok(issues.includes('page-choice:capability:threshold_compaction'));
  assert.ok(!issues.includes('authorize:capability:threshold_compaction'));
});

test('order is stable', t => {
  const hostProfile = profile(allCapabilities({ science_recovery: capability({ status: 'blocked' }) }));
  const repoRoot = temporary(t);
  const first = inspectApaConfig({ repoRoot, hostProfile }).setup_issues;
  assert.deepEqual(inspectApaConfig({ repoRoot, hostProfile }).setup_issues, first);
  const order = ['investigate', 'page-choice', 'authorize', 'known-limit'];
  assert.deepEqual(first.map(item => order.indexOf(item.category)), first.map(item => order.indexOf(item.category)).sort((a, b) => a - b));
});

test('missing profile yields a single host investigate item', t => {
  const issues = issuesFor(t, undefined);
  assert.deepEqual(issues.filter(item => item.category === 'investigate').map(item => item.id), ['investigate:host:no-profile']);
});

test('legacy profile still loads', t => {
  const root = temporary(t);
  const legacy = path.join(root, 'legacy.json');
  fs.writeFileSync(legacy, JSON.stringify(profile({ threshold_compaction: { status: 'unknown', method: null, scope: 'unknown', evidence: [], limitations: [] } })));
  assert.doesNotThrow(() => loadHostProfile(legacy));
  const modern = path.join(root, 'modern.json');
  fs.writeFileSync(modern, JSON.stringify(profile(allCapabilities({ manual_compaction: capability({ evidence: [{ source: 'runtime-log', reference: 'session.jsonl:1' }, { source: 'installed-software', reference: 'host --help' }] }) }))));
  assert.doesNotThrow(() => loadHostProfile(modern));
  const legacyIssues = ids(issuesFor(t, loadHostProfile(legacy)));
  assert.deepEqual(legacyIssues.filter(id => id.startsWith('known-limit:capability:')).sort(), [
    'concise_replies', 'delegated_diagnostics', 'manual_compaction', 'on_demand_reading',
    'science_recovery', 'task_continuation', 'threshold_compaction',
  ].map(id => 'known-limit:capability:' + id));
});

const sha = 'a'.repeat(64);
const ledger = (entries, profileSha256 = sha) => ({ schema_version: 'apa-setup-issue-ledger-1.0', profile_sha256: profileSha256, entries });
const decision = id => ({ id, disposition: 'deferred', note: '用户稍后处理', decided_by: 'user' });
const authorize = { id: 'authorize:dependency:parser.python', category: 'authorize' };

test('gate allows unresolved investigation for basic page', () => {
  const issues = [{ id: 'investigate:host:no-profile', category: 'investigate' }, { id: 'investigate:capability:x', category: 'investigate' }];
  assert.deepEqual(checkPageGate(issues, {}), { ok: true, pending: [] });
});

test('gate allows pending dependency decisions for basic page', () => {
  assert.deepEqual(checkPageGate([authorize], {}), { ok: true, pending: [] });
  assert.deepEqual(checkPageGate([authorize, { id: 'page-choice:missing:x', category: 'page-choice' }], { ledger: ledger([decision(authorize.id)]), profileSha256: sha }), { ok: true, pending: [] });
});

test('ledger bound to another profile is rejected', () => {
  assert.equal(checkPageGate([authorize], { ledger: ledger([decision(authorize.id)], 'b'.repeat(64)), profileSha256: sha }).code, 'APA_ISSUE_LEDGER_STALE');
});

test('stale ledger entries are ignored', () => {
  assert.equal(checkPageGate([], { ledger: ledger([decision('authorize:dependency:gone')]), profileSha256: sha }).ok, true);
});

test('ledger with agent decision is invalid', t => {
  const file = path.join(temporary(t), 'issue-ledger.json');
  fs.writeFileSync(file, JSON.stringify(ledger([{ ...decision(authorize.id), decided_by: 'agent' }])));
  assert.throws(() => loadIssueLedger(file), { code: 'APA_ISSUE_LEDGER_INVALID' });
  fs.writeFileSync(file, JSON.stringify(ledger([decision(authorize.id)])));
  assert.equal(loadIssueLedger(file).entries.length, 1);
});

test('not-found without evidence rewritten by the checker still needs investigation', t => {
  const bare = capability({ status: 'blocked', evidence: [], limitations: [], achievement: { state: 'not-found', summary: 'none', steps: [] } });
  delete bare.investigation;
  const issues = ids(issuesFor(t, profile(allCapabilities({ manual_compaction: bare }))));
  assert.ok(issues.includes('known-limit:capability:manual_compaction'), issues.join());
});

test('achieved without method is sent back to investigation', t => {
  const weak = capability({ method: null });
  const issues = ids(issuesFor(t, profile(allCapabilities({ manual_compaction: weak }))));
  assert.ok(issues.includes('known-limit:capability:manual_compaction'), issues.join());
});

test('unsupported without full search is investigate, not known-limit', t => {
  const lazy = capability({ status: 'unsupported', achievement: { state: 'not-found', summary: 'none', steps: [] } });
  delete lazy.investigation;
  const issues = ids(issuesFor(t, profile(allCapabilities({ manual_compaction: lazy }))));
  assert.ok(issues.includes('known-limit:capability:manual_compaction'));
});
