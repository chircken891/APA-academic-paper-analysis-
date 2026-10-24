import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderApaSetupPage } from '../../scripts/setup/apa-setup-page.mjs';
import { configDifferences, copySetupPayload, createOperation, createSetupNavigator, describeChanges, describeValue, fieldValue, flattenConfig, serializePayload, setupPages } from '../../Templates/apa-setup/page.js';
import { loadApaConfig, applyApaConfigOperation } from '../../scripts/lib/apa-config.mjs';

const config = { schema_version: 'apa-local-config-1.0', paths: { runs: '.tmp/old', parse: '.tmp/parse' }, reading: { source_language: 'en' } };
const snapshot = { config, fingerprint: 'fingerprint', exists: true, path: 'config/apa.local.json' };

test('clipboard copy uses the same serialized payload and reports when fallback is needed', async () => {
  const payload = createOperation(snapshot, { set: { 'paths.runs': '.tmp/new' } }); let written;
  assert.equal(await copySetupPayload(payload, { writeText: async text => { written = text; } }), true);
  assert.equal(written, serializePayload(payload));
  assert.equal(await copySetupPayload(payload, {}), false);
  assert.equal(await copySetupPayload(payload, { writeText: async () => { throw new Error('denied'); } }), false);
});

test('wizard changes one visible page without replacing form state and previews can select result', () => {
  const control = () => ({ listeners: {}, attributes: {}, addEventListener(name, listener) { this.listeners[name] = listener; }, setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; } });
  const pages = setupPages.map(page => ({ ...page, element: { hidden: false, form: { value: '', checked: false } } }));
  const buttons = setupPages.map(control);
  const status = {}; const previous = control(); const next = control(); const observed = [];
  const navigator = createSetupNavigator({ pages, buttons, status, previous, next, onChange: page => observed.push(page.id) });
  const assertSingle = id => assert.deepEqual(pages.filter(page => !page.element.hidden).map(page => page.id), [id]);
  assert.equal(pages.length, 11); assertSingle('overview'); assert.equal(previous.disabled, true);
  next.listeners.click(); assertSingle('science');
  const scienceForm = pages[1].element.form; scienceForm.value = 'retained-model'; scienceForm.checked = true;
  buttons[3].listeners.click(); assertSingle('paths');
  navigator.show('science'); assertSingle('science'); assert.equal(pages[1].element.form, scienceForm); assert.equal(scienceForm.value, 'retained-model'); assert.equal(scienceForm.checked, true);
  navigator.show('result'); assertSingle('result'); assert.equal(next.disabled, true); assert.match(status.textContent, /第 11 \/ 11 页/);
  assert.equal(buttons.at(-1).attributes['aria-current'], 'step');
  previous.listeners.click(); assertSingle('export-section'); assert.equal(pages[1].element.form.value, 'retained-model');
  assert.throws(() => navigator.show('missing'), /未知/); assertSingle('export-section');
  assert.deepEqual(observed, ['overview', 'science', 'paths', 'science', 'result', 'export-section']);
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
