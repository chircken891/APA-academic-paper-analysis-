import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderApaSetupPage } from '../../scripts/setup/apa-setup-page.mjs';
import { configDifferences, copySetupPayload, createOperation, createSetupNavigator, createSetupResults, describeChanges, describeValue, fieldValue, flattenConfig, serializePayload, setupPages } from '../../Templates/apa-setup/page.js';
import { loadApaConfig, applyApaConfigOperation, exportApaConfig, inspectApaConfig } from '../../scripts/lib/apa-config.mjs';
import { fields, readinessMessages } from '../../Templates/apa-setup/page.js';

const config = { schema_version: 'apa-local-config-1.0', paths: { runs: '.tmp/old', parse: '.tmp/parse' }, reading: { source_language: 'en' } };
const snapshot = { config, fingerprint: 'fingerprint', exists: true, path: 'config/apa.local.json' };
test('query selection uses existing patch, export, import difference and removal boundaries', t => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apa-page-query-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  assert.equal(fields.find(field => field.key === 'models.query').type, 'model');
  const initial = applyApaConfigOperation({ repoRoot, operation: createOperation(loadApaConfig({ repoRoot }), { set: { 'paths.runs': '.tmp/runs', 'models.science': { mode: 'follow-main' } } }) });
  const choice = fieldValue({ type: 'model' }, { mode: 'explicit', model: 'query-model', effort: 'high' });
  const payload = createOperation(initial, { set: { 'models.query': choice } });
  const saved = applyApaConfigOperation({ repoRoot, operation: JSON.parse(serializePayload(payload)) });
  assert.deepEqual(saved.config, { ...initial.config, models: { ...initial.config.models, query: choice } });
  assert.throws(() => applyApaConfigOperation({ repoRoot, operation: payload }), /STALE/);
  const backup = exportApaConfig(saved.config);
  assert.deepEqual(backup.answers.models.query, choice);
  assert.deepEqual(configDifferences(initial.config, backup.answers), [{ key: 'models.query', before: undefined, after: choice }]);
  const imported = applyApaConfigOperation({ repoRoot, operation: createOperation(saved, { set: { 'models.query': { mode: 'follow-main' } } }) });
  assert.deepEqual(imported.config.models.query, { mode: 'follow-main' });
  const removed = applyApaConfigOperation({ repoRoot, operation: createOperation(imported, { action: 'remove', remove: ['models.query'] }) });
  assert.deepEqual(removed.config, initial.config);
  const messages = readinessMessages(inspectApaConfig({ repoRoot }), inspectApaConfig({ repoRoot, capability: 'query' }));
  assert.match(messages.query, /查询配置已就绪/);
  assert.match(messages.query, /未检查.*模型/);
  assert.match(messages.reading, /还需填写/);
  const html = renderApaSetupPage({ snapshot: saved, inspection: inspectApaConfig({ repoRoot }), queryInspection: inspectApaConfig({ repoRoot, capability: 'query' }), repoRoot });
  assert.match(html, /id="query-readiness"/);
  const data = JSON.parse(html.match(/<script id="apa-setup-data" type="application\/json">(.*?)<\/script>/s)[1]);
  assert.equal(data.queryInspection.ready, true);
  assert.equal(data.inspection.ready, false);
  assert.match(html, /data\.snapshot, data\.inspection, data\.queryInspection/);
});

test('clipboard copy uses the same serialized payload and reports when fallback is needed', async () => {
  const payload = createOperation(snapshot, { set: { 'paths.runs': '.tmp/new' } }); let written;
  assert.equal(await copySetupPayload(payload, { writeText: async text => { written = text; } }), true);
  assert.equal(written, serializePayload(payload));
  assert.equal(await copySetupPayload(payload, {}), false);
  assert.equal(await copySetupPayload(payload, { writeText: async () => { throw new Error('denied'); } }), false);
});

test('query preferences roundtrip through selected patches, backup differences and removal without changing reading', t => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apa-page-query-preferences-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const initial = applyApaConfigOperation({ repoRoot, operation: createOperation(loadApaConfig({ repoRoot }), { set: { 'reading.source_language': 'en', 'paths.candidates': '.tmp/candidates', 'writing_skills.humanizer': { enabled: false } } }) });
  const preferences = { 'query.answer_language': 'zh-CN', 'query.detail': 'detailed', 'query.audience': 'beginner' };
  const set = Object.fromEntries(Object.entries(preferences).map(([key, value]) => [key, fieldValue(fields.find(field => field.key === key), { value })]));
  const saved = applyApaConfigOperation({ repoRoot, operation: createOperation(initial, { set }) });
  const backup = exportApaConfig(saved.config);
  assert.deepEqual(backup.answers.query, { answer_language: 'zh-CN', detail: 'detailed', audience: 'beginner' });
  assert.deepEqual(configDifferences(initial.config, backup.answers), Object.entries(preferences).map(([key, after]) => ({ key, before: undefined, after })));
  const changed = applyApaConfigOperation({ repoRoot, operation: createOperation(saved, { set: { 'query.detail': 'concise' } }) });
  const changes = configDifferences(changed.config, backup.answers);
  assert.deepEqual(changes, [{ key: 'query.detail', before: 'concise', after: 'detailed' }]);
  const imported = applyApaConfigOperation({ repoRoot, operation: createOperation(changed, { set: Object.fromEntries(changes.map(item => [item.key, item.after])) }) });
  assert.deepEqual(imported.config.query, saved.config.query);
  const removed = applyApaConfigOperation({ repoRoot, operation: createOperation(imported, { action: 'remove', remove: Object.keys(preferences) }) });
  assert.deepEqual(removed.config.query, {});
  for (const key of ['reading', 'paths', 'writing_skills']) assert.deepEqual(removed.config[key], initial.config[key]);
});

test('query defaults are described without replacing reading language labels or selecting unsaved values', () => {
  assert.equal(fields.find(field => field.key === 'models.query').group, 'query');
  assert.equal(setupPages.find(page => page.id === 'query').flow, 'edit');
  assert.equal(describeValue(undefined, 'query.answer_language'), '未配置；默认跟随问题语言');
  assert.equal(describeValue(undefined, 'query.detail'), '未配置；默认按问题决定');
  assert.equal(describeValue(undefined, 'query.audience'), '未配置；默认按问题决定');
  assert.equal(describeValue('en', 'query.answer_language'), '英文');
  assert.equal(describeValue('zh-CN', 'query.answer_language'), '中文');
  assert.equal(describeValue('en', 'reading.source_language'), '先写英文，再写中文');
  assert.deepEqual(createOperation(snapshot).set, {});
  assert.deepEqual(fields.filter(field => field.group === 'query').map(field => field.key), ['models.query', 'query.answer_language', 'query.detail', 'query.audience']);
});

test('each function has its own navigation and returning home preserves form nodes', () => {
  const control = () => ({ listeners: {}, attributes: {}, addEventListener(name, listener) { this.listeners[name] = listener; }, setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; } });
  const pages = setupPages.map(page => ({ ...page, element: { hidden: false, form: { value: '', checked: false } } }));
  const buttons = setupPages.map(control);
  const status = {}; const previous = control(); const next = control(); const observed = [];
  const navigator = createSetupNavigator({ pages, buttons, status, previous, next, onChange: page => observed.push(page.id) });
  const assertSingle = id => assert.deepEqual(pages.filter(page => !page.element.hidden).map(page => page.id), [id]);
  assertSingle('overview'); assert.equal(previous.disabled, true); assert.equal(next.disabled, true);
  navigator.enter('edit'); assertSingle('query');
  const queryForm = pages[1].element.form; queryForm.value = 'retained-model'; queryForm.checked = true;
  buttons[setupPages.findIndex(page => page.id === 'paths')].listeners.click(); assertSingle('paths');
  navigator.show('query'); assertSingle('query'); assert.equal(pages[1].element.form, queryForm); assert.equal(queryForm.value, 'retained-model'); assert.equal(queryForm.checked, true);
  navigator.show('edit-result'); assertSingle('edit-result'); assert.equal(next.disabled, true); assert.match(status.textContent, /完善配置.*第 9 \/ 9 页/);
  assert.throws(() => navigator.show('remove'), /当前功能/); assertSingle('edit-result');
  navigator.home(); assertSingle('overview');
  navigator.enter('remove'); assertSingle('remove'); next.listeners.click(); assertSingle('remove-result'); assert.equal(next.disabled, true);
  previous.listeners.click(); assertSingle('remove');
  navigator.home(); navigator.enter('export'); assertSingle('export-section'); next.listeners.click(); assertSingle('export-result'); assert.equal(next.disabled, true);
  navigator.home(); navigator.enter('edit'); assertSingle('query'); assert.equal(pages[1].element.form.value, 'retained-model');
  assert.throws(() => navigator.show('missing'), /未知/);
  assert.ok(observed.includes('remove-result')); assert.ok(observed.includes('export-result'));
});

test('function results keep payloads and filenames separate and clear failed regeneration', () => {
  const results = createSetupResults();
  const patch = createOperation(snapshot, { set: { 'paths.runs': '.tmp/new' } });
  const removal = createOperation(snapshot, { action: 'remove', all: true });
  const backup = { schema_version: 'apa-config-export-1.0', answers: config };
  results.set('edit', patch); results.get('edit').filename = 'my-change.json';
  assert.equal(results.get('remove').payload, null); assert.equal(results.get('export').payload, null);
  results.set('remove', removal); results.set('export', backup);
  assert.equal(results.get('edit').payload, patch); assert.equal(results.get('edit').filename, 'my-change.json');
  assert.equal(results.get('remove').payload, removal); assert.equal(results.get('remove').filename, 'apa-config-remove.json');
  assert.equal(results.get('export').payload, backup); assert.equal(results.get('export').filename, 'apa-config-backup.json');
  results.clear('edit'); assert.equal(results.get('edit').payload, null);
  assert.equal(results.get('remove').payload, removal); assert.equal(results.get('export').payload, backup);
});

test('self-contained HTML safely embeds personal strings as data without executing markup', () => {
  const hostile = '</script><img src=x onerror="alert(1)"><script>';
  const html = renderApaSetupPage({ snapshot: { ...snapshot, config: { ...config, parser: { runtime_home: hostile } } } });
  assert.ok(!html.includes(hostile));
  const encoded = html.match(/<script id="apa-setup-data" type="application\/json">(.*?)<\/script>/s)[1];
  assert.equal(JSON.parse(encoded).snapshot.config.parser.runtime_home, hostile);
  assert.ok(!/<script[^>]+src=|<link[^>]+stylesheet|https?:\/\//i.test(html));
  assert.ok(!html.includes('localStorage'));
});

test('import differences preserve absent values and model choice is treated atomically', () => {
  const next = { schema_version: 'apa-local-config-1.0', paths: { runs: '.tmp/new' }, models: { science: { mode: 'follow-main' } } };
  assert.deepEqual(configDifferences(config, next), [
    { key: 'paths.runs', before: '.tmp/old', after: '.tmp/new' },
    { key: 'models.science', before: undefined, after: { mode: 'follow-main' } }
  ]);
});

test('follow-main and disabled skill controls emit no stale hidden answers', () => {
  assert.deepEqual(fieldValue({ type: 'model' }, { mode: 'follow-main', model: 'stale-model', effort: 'high' }), { mode: 'follow-main' });
  assert.deepEqual(fieldValue({ type: 'skill' }, { enabled: 'false', path: '/stale/path' }), { enabled: false });
  assert.deepEqual(fieldValue({ type: 'model' }, { mode: 'explicit', model: ' model ', effort: 'medium' }), { mode: 'explicit', model: 'model', reasoning_effort: 'medium' });
});

test('all and selected removal operations use the same snapshot fingerprint and deduplicate selection', () => {
  assert.deepEqual(createOperation(snapshot, { action: 'remove', all: true }), { schema_version: 'apa-config-operation-1.0', base_fingerprint: 'fingerprint', action: 'remove', all: true });
  assert.deepEqual(createOperation(snapshot, { action: 'remove', remove: ['paths.runs', 'paths.runs'] }).remove, ['paths.runs']);
});

test('reader-facing preview distinguishes actual patches, removal and saved-answer backup', () => {
  const operation = createOperation(snapshot, { set: { 'paths.runs': '.tmp/new' } });
  assert.deepEqual(describeChanges(snapshot, operation), ['执行记录目录：.tmp/old → .tmp/new']);
  assert.deepEqual(describeChanges(snapshot, createOperation(snapshot, { action: 'remove', remove: ['reading.source_language'] })), ['首先写作的语言：先写英文，再写中文 → 移除答案']);
  assert.deepEqual(describeChanges(snapshot, createOperation(snapshot)), []);
  assert.match(describeChanges(snapshot, { schema_version: 'apa-config-export-1.0', answers: config })[0], /不包含尚未应用/);
  assert.match(describeValue({ mode: 'follow-main' }), /新运行开始时固定/);
  assert.equal(describeValue({ enabled: false, path: 'old-file.md' }), '不使用');
  assert.equal(describeValue('en', 'paths.runs'), 'en');
  assert.deepEqual(operation.set, { 'paths.runs': '.tmp/new' });
});

test('generated payload roundtrips through actual apply while preserving unselected fields', t => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apa-page-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const initial = applyApaConfigOperation({ repoRoot, operation: createOperation(loadApaConfig({ repoRoot }), { set: { 'paths.runs': '.tmp/runs', 'reading.source_language': 'en', 'writing_skills.humanizer': { enabled: true, path: 'writing.md' } } }) });
  const operation = createOperation(initial, { set: { 'reading.source_language': 'zh-CN', 'writing_skills.humanizer': fieldValue({ type: 'skill' }, { enabled: 'false', path: 'writing.md' }) } });
  const download = serializePayload(operation);
  const clipboard = serializePayload(operation);
  assert.equal(download, clipboard);
  const saved = applyApaConfigOperation({ repoRoot, operation: JSON.parse(download) });
  assert.equal(saved.config.paths.runs, '.tmp/runs');
  assert.equal(saved.config.reading.source_language, 'zh-CN');
  assert.deepEqual(saved.config.writing_skills.humanizer, { enabled: false });
  assert.throws(() => applyApaConfigOperation({ repoRoot, operation: JSON.parse(clipboard) }), /STALE/);
  assert.deepEqual(flattenConfig(saved.config)['writing_skills.humanizer'], { enabled: false });
  const removed = applyApaConfigOperation({ repoRoot, operation: createOperation(saved, { action: 'remove', remove: ['writing_skills.humanizer'] }) });
  assert.equal(removed.config.writing_skills.humanizer, undefined);
  assert.equal(removed.config.paths.runs, '.tmp/runs');
});
