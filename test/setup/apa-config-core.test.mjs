import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as api from '../../scripts/lib/apa-config.mjs';
import { spawnSync } from 'node:child_process';

const temporary = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apa-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};
const operation = (snapshot, fields) => ({ schema_version: 'apa-config-operation-1.0', base_fingerprint: snapshot.fingerprint, ...fields });

test('query preferences patch export import and removal preserve unrelated answers', t => {
  const repoRoot = temporary(t);
  const initial = api.loadApaConfig({ repoRoot });
  const saved = api.applyApaConfigOperation({ repoRoot, operation: operation(initial, { action: 'patch', set: {
    'query.answer_language': 'zh-CN', 'query.detail': 'detailed', 'query.audience': 'beginner', 'paths.candidates': 'chosen-candidates',
  } }) });
  const exported = api.exportApaConfig(saved.config);
  const importedRoot = temporary(t);
  const imported = api.applyApaConfigOperation({ repoRoot: importedRoot, operation: operation(api.loadApaConfig({ repoRoot: importedRoot }), { action: 'import', answers: exported.answers }) });
  assert.deepEqual(imported.config, saved.config);
  const removed = api.applyApaConfigOperation({ repoRoot, operation: operation(saved, { action: 'remove', remove: ['query.detail'] }) });
  assert.deepEqual(api.resolveQueryPreferences(removed.config.query), { answer_language: 'zh-CN', detail: 'adaptive', audience: 'beginner' });
  assert.equal(removed.config.paths.candidates, 'chosen-candidates');
  for (const query of [{ detail: 'unlimited' }, { audience: true }, { answer_language: 'auto' }, { external_search: true }, null, []]) {
    assert.equal(api.validateApaConfig({ schema_version: api.APA_CONFIG_VERSION, query }, { repoRoot }).valid, false);
    assert.throws(() => api.resolveQueryPreferences({}, query), /APA_QUERY_PREFERENCES_INVALID/);
  }
});
test('query needs no reading answers or dependency files and never persists defaults', t => {
  const repoRoot = temporary(t);
  const config = api.loadApaConfig({ repoRoot }).config;
  const mainSession = { model: 'main-model', reasoning_effort: 'high' };
  assert.equal(api.validateApaConfig(config, { repoRoot, capability: 'query', complete: true }).valid, true);
  assert.deepEqual(api.resolveApaConfig({ config, repoRoot, capability: 'query', mainSession }), { query: mainSession, queryMode: 'follow-main', queryPreferences: api.APA_QUERY_DEFAULTS });
  assert.throws(() => api.resolveApaConfig({ config, repoRoot, capability: 'query' }), /APA_MAIN_SESSION_INVALID/);
  assert.throws(() => api.resolveApaConfig({ config, repoRoot, capability: 'query', mainSession, supportedModelPairs: [] }), /APA_MODEL_UNSUPPORTED/);
  const inspected = api.inspectApaConfig({ repoRoot, capability: 'query' });
  assert.equal(inspected.ready, true);
  assert.equal(inspected.model_availability, 'not_checked');
  assert.deepEqual(inspected.dependencies, []);
  assert.equal(api.inspectApaConfig({ repoRoot }).ready, false);
  assert.deepEqual(fs.readdirSync(repoRoot), []);
});
test('explicit query requires host confirmation and never substitutes unsupported models', t => {
  const repoRoot = temporary(t);
  const pair = { model: 'query-model', reasoning_effort: 'medium' };
  const config = { schema_version: 'apa-local-config-1.0', models: { query: { mode: 'explicit', ...pair } }, parser: { runtime_home: 'missing' }, writing_skills: { humanizer: { enabled: true, path: 'missing.md' } } };
  assert.throws(() => api.resolveApaConfig({ config, repoRoot, capability: 'query' }), /APA_MODEL_AVAILABILITY_UNKNOWN/);
  assert.throws(() => api.resolveApaConfig({ config, repoRoot, capability: 'query', supportedModelPairs: [] }), /APA_MODEL_UNSUPPORTED/);
  assert.deepEqual(api.resolveApaConfig({ config, repoRoot, capability: 'query', supportedModelPairs: [pair] }), { query: pair, queryMode: 'explicit', queryPreferences: api.APA_QUERY_DEFAULTS });
  fs.mkdirSync(path.join(repoRoot, 'config'));
  fs.writeFileSync(path.join(repoRoot, 'config/apa.local.json'), JSON.stringify(config));
  assert.deepEqual(api.inspectApaConfig({ repoRoot, capability: 'query' }).dependencies, []);
  assert.equal(api.inspectApaConfig({ repoRoot, capability: 'query' }).ready, true);
  assert.equal(api.inspectApaConfig({ repoRoot }).ready, false);
  assert.throws(() => api.resolveApaConfig({ config: { schema_version: 'apa-local-config-1.0' }, repoRoot, capability: 'query', mainSession: { model: ' ', reasoning_effort: 'high' } }), /APA_MAIN_SESSION_INVALID/);
  // A host without a reasoning parameter saves the model alone; an unknown effort word is still rejected.
  assert.equal(api.validateApaConfig({ ...config, models: { query: { mode: 'explicit', model: 'q' } } }, { repoRoot, capability: 'query' }).valid, true);
  assert.equal(api.validateApaConfig({ ...config, models: { query: { mode: 'explicit', model: 'q', reasoning_effort: 'deep' } } }, { repoRoot, capability: 'query' }).valid, false);
});
test('CLI query inspection distinguishes configuration from live model availability', t => {
  const repoRoot = temporary(t);
  const cli = path.resolve('scripts/apa-setup.mjs');
  const run = capability => spawnSync(process.execPath, [cli, 'inspect', '--repo-root', repoRoot, '--capability', capability], { encoding: 'utf8' });
  const result = run('query');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ready, true);
  assert.equal(JSON.parse(result.stdout).model_availability, 'not_checked');
  assert.equal(JSON.parse(run('reading').stdout).ready, false);
  assert.notEqual(run('unknown').status, 0);
});
test('blank snapshot is incomplete and inspect does not write', t => {
  const repoRoot = temporary(t);
  const snapshot = api.loadApaConfig({ repoRoot });
  assert.equal(snapshot.exists, false);
  assert.equal(api.validateApaConfig(snapshot.config, { repoRoot }).complete, false);
  assert.deepEqual(fs.readdirSync(repoRoot), []);
});
test('save, partial edit, stale operation, selected removal and all removal preserve boundaries', t => {
  const repoRoot = temporary(t);
  const blank = api.loadApaConfig({ repoRoot });
  const saved = api.applyApaConfigOperation({ repoRoot, operation: operation(blank, { action: 'patch', set: { 'paths.runs': '.tmp/runs', 'reading.source_language': 'en' } }) });
  const changed = api.applyApaConfigOperation({ repoRoot, operation: operation(saved, { action: 'patch', set: { 'reading.presentation_mode': 'writer' } }) });
  assert.equal(changed.config.paths.runs, '.tmp/runs');
  assert.throws(() => api.applyApaConfigOperation({ repoRoot, operation: operation(saved, { action: 'remove', all: true }) }), /STALE/);
  assert.equal(api.loadApaConfig({ repoRoot }).fingerprint, changed.fingerprint);
  const removed = api.applyApaConfigOperation({ repoRoot, operation: operation(changed, { action: 'remove', remove: ['reading.source_language'] }) });
  assert.equal(removed.config.reading.presentation_mode, 'writer');
  const cleared = api.applyApaConfigOperation({ repoRoot, operation: operation(removed, { action: 'remove', all: true }) });
  assert.deepEqual(cleared.config, { schema_version: 'apa-local-config-1.0' });
  assert.deepEqual(fs.readdirSync(path.join(repoRoot, 'config')), ['apa.local.json']);
});
test('export and explicit import roundtrip only answers', t => {
  const repoRoot = temporary(t);
  const exported = api.exportApaConfig({ schema_version: 'apa-local-config-1.0', reading: { source_language: 'zh-CN' } });
  assert.deepEqual(Object.keys(exported), ['schema_version', 'answers']);
  const snapshot = api.loadApaConfig({ repoRoot });
  const imported = api.applyApaConfigOperation({ repoRoot, operation: operation(snapshot, { action: 'import', answers: exported.answers }) });
  assert.deepEqual(imported.config, exported.answers);
});
test('invalid types, unknown fields and repository escape paths cannot be saved', t => {
  const repoRoot = temporary(t);
  for (const set of [{ 'paths.runs': '../outside' }, { 'reading.source_language': true }, { 'parser.token': 'secret' }, { 'models.science': { mode: 'follow-main', model: 'hidden' } }]) {
    const snapshot = api.loadApaConfig({ repoRoot });
    assert.throws(() => api.applyApaConfigOperation({ repoRoot, operation: operation(snapshot, { action: 'patch', set }) }), /INVALID/);
    assert.equal(api.loadApaConfig({ repoRoot }).exists, false);
  }
});
test('resolver uses only explicit answers and enabled skill files', t => {
  const repoRoot = temporary(t);
  const skill = path.join(repoRoot, 'guide.md');
  fs.writeFileSync(skill, 'chosen guidance');
  const config = { schema_version: 'apa-local-config-1.0', models: { science: { mode: 'explicit', model: 'science-model', reasoning_effort: 'medium' }, roles: Object.fromEntries(api.APA_CONFIG_ROLES.map(role => [role, { mode: 'follow-main' }])) }, paths: { runs: 'runs', parse: 'parse', candidates: 'candidates' }, parser: { runtime_home: repoRoot }, reading: { source_language: 'en', presentation_mode: 'writer' }, writing_skills: Object.fromEntries(api.APA_WRITING_SKILLS.map(key => [key, { enabled: key === 'humanizer', path: key === 'humanizer' ? skill : 'nonexistent' }])) };
  const resolved = api.resolveApaConfig({ config, repoRoot, mainSession: { model: 'main-model', reasoning_effort: 'high' } });
  assert.equal(resolved.roles.evidence.model, 'science-model');
  assert.equal(resolved.roles['english-writer'].model, 'main-model');
  assert.deepEqual(Object.keys(resolved.writingSkills), ['humanizer']);
  assert.equal(resolved.writingSkills.humanizer.content, 'chosen guidance');
  assert.equal(resolved.paths.runs, path.join(repoRoot, 'runs'));
  assert.throws(() => api.resolveApaConfig({ config, repoRoot, mainSession: { model: 'main-model', reasoning_effort: 'high' }, supportedModelPairs: [] }), /UNSUPPORTED/);
  config.writing_skills['nature-writing'] = { enabled: true, path: skill };
  assert.throws(() => api.resolveApaConfig({ config, repoRoot }), /INCOMPLETE/);
});
test('translation model is required for new reading configs and resolves like other roles', t => {
  const repoRoot = temporary(t);
  const choice = { mode: 'explicit', model: 'sonnet', reasoning_effort: 'high' };
  const roles = Object.fromEntries(api.APA_CONFIG_ROLES.filter(role => role !== 'translation').map(role => [role, { mode: 'follow-main' }]));
  const config = { schema_version: 'apa-local-config-1.0', models: { science: { mode: 'follow-main' }, roles }, paths: { runs: 'runs', parse: 'parse', candidates: 'candidates' }, parser: { runtime_home: repoRoot }, reading: { source_language: 'en', presentation_mode: 'writer' }, writing_skills: Object.fromEntries(api.APA_WRITING_SKILLS.map(key => [key, { enabled: false }])) };
  const validation = api.validateApaConfig(config, { repoRoot });
  assert.equal(validation.valid, true);
  assert.equal(validation.complete, false);
  assert.deepEqual(validation.missing, ['models.roles.translation']);
  config.models.roles.translation = choice;
  assert.equal(api.validateApaConfig(config, { repoRoot }).complete, true);
  const resolved = api.resolveApaConfig({ config, repoRoot, mainSession: { model: 'main-model', reasoning_effort: 'high' } });
  assert.deepEqual(resolved.roles.translation, { model: 'sonnet', reasoning_effort: 'high' });
});
test('CLI inspect/apply/export and malformed input keep installation separate', t => {
  const repoRoot = temporary(t);
  const cli = path.resolve('scripts/apa-setup.mjs');
  const run = (args, input) => spawnSync(process.execPath, [cli, ...args, '--repo-root', repoRoot], { encoding: 'utf8', input });
  const inspected = run(['inspect']);
  assert.equal(inspected.status, 0, inspected.stderr);
  const snapshot = JSON.parse(inspected.stdout);
  const applied = run(['apply'], JSON.stringify(operation(snapshot, { action: 'patch', set: { 'reading.source_language': 'en' } })));
  assert.equal(applied.status, 0, applied.stderr);
  const before = fs.readFileSync(path.join(repoRoot, 'config/apa.local.json'), 'utf8');
  assert.notEqual(run(['apply'], '{broken').status, 0);
  assert.equal(fs.readFileSync(path.join(repoRoot, 'config/apa.local.json'), 'utf8'), before);
  const exported = run(['export']);
  assert.equal(JSON.parse(exported.stdout).answers.reading.source_language, 'en');
  assert.deepEqual(fs.readdirSync(repoRoot), ['config']);
  const escaped = run(['page', '--output', path.join(repoRoot, 'outside.html')]);
  assert.notEqual(escaped.status, 0);
  assert.equal(fs.existsSync(path.join(repoRoot, 'outside.html')), false);
  const page = run(['page']);
  assert.equal(page.status, 0, page.stderr);
  const pagePath = JSON.parse(page.stdout).output;
  assert.equal(pagePath, path.join(repoRoot, '.tmp/apa-setup/index.html'));
  assert.match(fs.readFileSync(pagePath, 'utf8'), /apa-setup-data/);
});
test('CLI export creates owner parent and refuses to replace an existing export', t => {
  const repoRoot = temporary(t);
  const output = path.join(repoRoot, 'config/backups/example-owner/export.json');
  const cli = path.resolve('scripts/apa-setup.mjs');
  const run = () => spawnSync(process.execPath, [cli, 'export', '--repo-root', repoRoot, '--output', output], { encoding: 'utf8' });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).output, output);
  const bytes = fs.readFileSync(output);
  assert.equal(JSON.parse(bytes).schema_version, 'apa-config-export-1.0');
  assert.notEqual(run().status, 0);
  assert.deepEqual(fs.readFileSync(output), bytes);
});

test('inspection reports missing existing runtime dependencies without probing network or installing', t => {
  const repoRoot = temporary(t);
  const snapshot = api.loadApaConfig({ repoRoot });
  api.applyApaConfigOperation({ repoRoot, operation: operation(snapshot, { action: 'patch', set: { 'parser.runtime_home': 'runtime' } }) });
  const result = api.inspectApaConfig({ repoRoot });
  assert.deepEqual(result.dependencies.map(item => item.key), ['parser.runtime_home', 'parser.python', 'parser.config_path']);
  assert.ok(result.dependencies.every(item => item.status === 'missing'));
  assert.equal(result.ready, false);
  assert.deepEqual(fs.readdirSync(repoRoot), ['config']);
});
test('import replaces a model choice while preserving other personal answers', t => {
  const repoRoot = temporary(t);
  let snapshot = api.loadApaConfig({ repoRoot });
  snapshot = api.applyApaConfigOperation({ repoRoot, operation: operation(snapshot, { action: 'patch', set: { 'models.science': { mode: 'explicit', model: 'selected-model', reasoning_effort: 'medium' }, 'reading.source_language': 'en' } }) });
  const imported = api.applyApaConfigOperation({ repoRoot, operation: operation(snapshot, { action: 'import', answers: { schema_version: 'apa-local-config-1.0', models: { science: { mode: 'follow-main' } } } }) });
  assert.deepEqual(imported.config.models.science, { mode: 'follow-main' });
  assert.equal(imported.config.reading.source_language, 'en');
});
