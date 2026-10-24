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
