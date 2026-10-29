import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderApaSetupPage } from '../../scripts/setup/apa-setup-page.mjs';
import { collectModelSet, configDifferences, copySetupPayload, createOperation, createSetupNavigator, createSetupResults, describeChanges, describeValue, fieldValue, flattenConfig, groupCurrent, modelGroupSummary, modelGroups, mountApaSetup, serializePayload, setupPages, unknownConfigKeys } from '../../Templates/apa-setup/page.js';
import { loadApaConfig, applyApaConfigOperation, exportApaConfig, inspectApaConfig } from '../../scripts/lib/apa-config.mjs';
import { fields, readinessMessages } from '../../Templates/apa-setup/page.js';

const config = { schema_version: 'apa-local-config-1.0', paths: { runs: '.tmp/old', parse: '.tmp/parse' }, reading: { source_language: 'en' } };
const snapshot = { config, fingerprint: 'fingerprint', exists: true, path: 'config/apa.local.json' };
test('capability report shows host-specific methods, limits and evidence as text without changing setup answers', async () => {
  const { renderCapabilityCheck } = await import('../../Templates/apa-setup/page.js');
  const node = tag => ({ tag, textContent: '', children: [], append(...children) { this.children.push(...children); } });
  const document = { createElement: node };
  const missing = node('div');
  renderCapabilityCheck(document, missing, null);
  assert.match(missing.children[0].textContent, /未检测/);
  const hostile = '<img src=x onerror=alert(1)>';
  const checks = ['on_demand_reading', 'delegated_diagnostics', 'manual_compaction', 'concise_replies', 'science_recovery', 'threshold_compaction'].map((id, index) => ({
    id, label: `能力 ${index + 1}`, status: ['detected', 'conditional', 'blocked', 'unsupported', 'unknown', 'conditional'][index],
    method: index === 5 ? hostile : '按本宿主方式执行', scope: index === 5 ? 'new-session' : 'current-session',
    evidence: [{ source: 'tool-schema', reference: '当前工具定义' }], limitations: ['实际行为待验证'], next_check: '后续核验',
    ...(index === 5 ? { threshold: { target_tokens: 200000 } } : {})
  }));
  const report = { host: '示例宿主', detected_at: '2026-10-28T00:00:00Z', runtime_validation: 'not_run', checks };
  const container = node('div');
  renderCapabilityCheck(document, container, report);
  const flatten = root => [root.textContent, ...root.children.flatMap(flatten)].join('\n');
  const text = flatten(container);
  for (const phrase of ['示例宿主', '实际行为待验证', '后续核验', '当前工具定义', '新启动的会话', '200000', hostile, '未运行']) assert.ok(text.includes(phrase), phrase);
  assert.equal(container.children.filter(child => child.tag === 'article').length, 6);
  assert.deepEqual(createOperation(snapshot).set, {});
  const html = renderApaSetupPage({ snapshot, inspection: { capability_check: report } });
  assert.match(html, /id="capability-check"/);
  assert.ok(!html.includes(hostile));
});
// DOM stub with events, so cards that react to input can be driven without a browser.
const eventNode = tag => ({ tag, textContent: '', value: '', hidden: false, children: [], listeners: {}, append(...children) { this.children.push(...children); }, addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); } });
const flattenText = root => [root.hidden ? '' : root.textContent, ...(root.hidden ? [] : root.children.flatMap(flattenText))].join('\n');
const findAll = (root, predicate) => [root, ...root.children.flatMap(child => findAll(child, predicate))].filter(predicate);
async function renderCards(achievements, threshold, extras = {}) {
  const { renderCapabilityCheck } = await import('../../Templates/apa-setup/page.js');
  const checks = Object.entries(achievements).map(([id, achievement]) => ({ id, label: id, status: 'conditional', method: '方式', scope: 'new-session', evidence: [], limitations: [], next_check: '核验', achievement, ...(threshold && id === 'threshold_compaction' ? { threshold } : {}), ...extras.check }));
  const container = eventNode('div');
  renderCapabilityCheck({ createElement: eventNode }, container, { host: '任意宿主', detected_at: 't', runtime_validation: 'not_run', checks, adapters: extras.adapters || [] });
  return container;
}

const step = (command, range, extra = {}) => ({ actor: 'agent', instruction: '执行说明 <示例>', command, scope: 'new-session', persistent: false, verify: '核验结果', evidence: [{ source: 'local-code', reference: '<路径>' }], ...(range ? { range } : {}), ...extra });
const achievement = steps => ({ state: 'achieved', summary: '静态能力', steps });
const visibleCommands = container => findAll(container, node => node.tag === 'code' && node.textContent).map(node => node.textContent);
const enter = (input, value) => { input.value = value; for (const handler of input.listeners.input) handler({ target: input }); };

test('agent declarations, APA rules, step evidence and adapters are displayed as text', async () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const container = await renderCards({ arbitrary: achievement([step('inspect <run_id>', null, { adapter_id: 'patch-1' })]), absent: { state: 'not-found', summary: hostile, steps: [] } }, null, {
    check: { apa_support: ['规则 <A>'] },
    adapters: [{ id: 'patch-1', owner: hostile, host: 'example', root: 'local/root', entrypoints: ['local/entry'], evidence: [{ source: 'local-code', reference: 'proof' }], status: 'blocked', issues: ['问题 <B>'] }]
  });
  const text = flattenText(container);
  for (const phrase of ['已具备（静态依据）', '已调查但未找到', hostile, '规则 <A>', 'local-code：<路径>', 'patch-1', 'local/root', 'local/entry', 'blocked', '问题 <B>', 'proof']) assert.ok(text.includes(phrase), phrase);
  assert.deepEqual(visibleCommands(container), ['inspect <run_id>']);
  assert.equal(findAll(container, node => node.tag === 'img').length, 0);
  assert.deepEqual(createOperation(snapshot).set, {});
});

test('each token command uses its own range, all placeholders, and safe user input', async () => {
  const container = await renderCards({ threshold_compaction: achievement([
    step('first <N> middle <N> end', { min: 100, max: 300, unit: 'tokens' }),
    step('second <N>', { min: 200, max: 400, unit: 'tokens' }),
    step('open <N>', { min: null, max: null, unit: 'tokens' })
  ]) });
  const [input] = findAll(container, node => node.tag === 'input');
  assert.equal(input.value, '');
  assert.deepEqual(visibleCommands(container), []);
  assert.match(flattenText(container), /范围.*未知/);
  enter(input, '150'); assert.deepEqual(visibleCommands(container), ['first 150 middle 150 end', 'open 150']);
  enter(input, '250'); assert.deepEqual(visibleCommands(container), ['first 250 middle 250 end', 'second 250', 'open 250']);
  enter(input, '350'); assert.deepEqual(visibleCommands(container), ['second 350', 'open 350']);
  for (const value of ['0', '2e5', '9007199254740992', '']) { enter(input, value); assert.deepEqual(visibleCommands(container), []); }
});

test('ratio and percent commands require verified formula and recalculate capacity on each input', async () => {
  const threshold = { candidate_tokens: 500, formula: 'window-ratio-bounded', effective_target_verified: true, context_window_tokens: 1000, output_reserve_tokens: 100, headroom_tokens: 100, retained_tokens: 100, measurement: 'input', feasibility: 'incompatible' };
  const steps = [step('ratio <N> then <N>', { min: 0.4, max: 0.7, unit: 'ratio' }), step('percent <N>', { min: 20, max: 60, unit: 'percent' })];
  const container = await renderCards({ threshold_compaction: achievement(steps) }, threshold);
  const [input] = findAll(container, node => node.tag === 'input');
  assert.equal(input.value, '500');
  assert.deepEqual(visibleCommands(container), ['ratio 0.5 then 0.5', 'percent 50']);
  enter(input, '650'); assert.deepEqual(visibleCommands(container), ['ratio 0.65 then 0.65']);
  enter(input, '850'); assert.deepEqual(visibleCommands(container), []);
  enter(input, '100'); assert.deepEqual(visibleCommands(container), []);
  const unknown = await renderCards({ threshold_compaction: achievement(steps) }, { ...threshold, formula: 'unknown' });
  assert.deepEqual(visibleCommands(unknown), []);
  assert.match(flattenText(unknown), /公式.*未.*核实/);
  const missing = await renderCards({ threshold_compaction: achievement(steps) }, { ...threshold, measurement: null });
  assert.deepEqual(visibleCommands(missing), []);
});

test('recorded token input is rechecked against capacity and commands require placeholders', async () => {
  const threshold = { candidate_tokens: 900, context_window_tokens: 1000, output_reserve_tokens: 100, headroom_tokens: 100, retained_tokens: 100, measurement: 'input', feasibility: 'within-reported-limits' };
  const container = await renderCards({ threshold_compaction: achievement([
    step('valid <N>', { min: null, max: null, unit: 'tokens' }),
    step('stale 900', { min: null, max: null, unit: 'tokens' })
  ]) }, threshold);
  const [input] = findAll(container, node => node.tag === 'input');
  assert.deepEqual(visibleCommands(container), []);
  enter(input, '500');
  assert.deepEqual(visibleCommands(container), ['valid 500']);
  assert.match(flattenText(container), /缺少 <N> 模板/);
  enter(input, '100');
  assert.deepEqual(visibleCommands(container), []);
});

test('an explicitly unverified effective target hides token commands and scope names are readable', async () => {
  const steps = [step('token <N>', { min: 1, max: 1000, unit: 'tokens' }, { scope: 'instance' }), step(null, null, { scope: 'unknown' })];
  const blocked = await renderCards({ threshold_compaction: achievement(steps) }, { candidate_tokens: 500, effective_target_verified: false });
  assert.deepEqual(visibleCommands(blocked), []);
  assert.match(flattenText(blocked), /有效.*后端.*未.*核实/);
  assert.match(flattenText(blocked), /宿主实例/);
  assert.match(flattenText(blocked), /范围尚不明确/);
  for (const effective_target_verified of [null, undefined]) {
    const unknown = await renderCards({ threshold_compaction: achievement(steps) }, { candidate_tokens: 500, effective_target_verified });
    assert.deepEqual(visibleCommands(unknown), ['token 500']);
    assert.match(flattenText(unknown), /有效.*后端.*尚未核实/);
  }
});

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

test('the project folder and locations come before the three functions, and returning home preserves form nodes', () => {
  const control = () => ({ listeners: {}, attributes: {}, addEventListener(name, listener) { this.listeners[name] = listener; }, setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; } });
  const pages = setupPages.map(page => ({ ...page, element: { hidden: false, form: { value: '', checked: false } } }));
  const buttons = setupPages.map(control);
  const status = {}; const previous = control(); const next = control(); const observed = [];
  const navigator = createSetupNavigator({ pages, buttons, status, previous, next, onChange: page => observed.push(page.id) });
  const assertSingle = id => assert.deepEqual(pages.filter(page => !page.element.hidden).map(page => page.id), [id]);
  assertSingle('project'); assert.ok(buttons.every(button => button.hidden));
  assert.deepEqual(setupPages.filter(page => !page.flow).map(page => page.id), ['project', 'locations', 'functions']);
  assert.ok(!setupPages.some(page => ['paths', 'parser'].includes(page.id)));
  navigator.home('locations'); assertSingle('locations'); navigator.home(); assertSingle('functions');
  navigator.enter('edit'); assertSingle('host');
  navigator.show('query'); assertSingle('query');
  const queryPage = pages.find(page => page.id === 'query');
  const queryForm = queryPage.element.form; queryForm.value = 'retained-model'; queryForm.checked = true;
  buttons[setupPages.findIndex(page => page.id === 'reading')].listeners.click(); assertSingle('reading');
  navigator.show('query'); assertSingle('query'); assert.equal(queryPage.element.form, queryForm); assert.equal(queryForm.value, 'retained-model'); assert.equal(queryForm.checked, true);
  navigator.show('edit-result'); assertSingle('edit-result'); assert.equal(next.disabled, true); assert.match(status.textContent, /完善配置.*第 7 \/ 7 页/);
  assert.throws(() => navigator.show('remove'), /当前功能/); assertSingle('edit-result');
  navigator.home(); assertSingle('functions');
  navigator.enter('remove'); assertSingle('remove'); next.listeners.click(); assertSingle('remove-result'); assert.equal(next.disabled, true);
  previous.listeners.click(); assertSingle('remove');
  navigator.home(); navigator.enter('export'); assertSingle('export-section'); next.listeners.click(); assertSingle('export-result'); assert.equal(next.disabled, true);
  navigator.home(); navigator.enter('edit'); assertSingle('host'); assert.equal(queryPage.element.form.value, 'retained-model');
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
  assert.deepEqual(describeChanges(snapshot, createOperation(snapshot, { action: 'remove', remove: ['reading.source_language'] })), ['首先写作的语言（旧设置，新运行不再使用）：先写英文，再写中文 → 移除答案']);
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

const hostProfile = {
  schema_version: 'apa-host-profile-1.0', host: 'example-host', detected_at: '2026-10-27T12:00:00Z',
  session: { model: 'big-model', reasoning_effort: null },
  models: [{ model: 'big-model', reasoning_efforts: [] }, { model: 'think-model', reasoning_efforts: ['low', 'high'] }],
  dispatch: { tool: 'Agent', model_argument: 'model', effort_argument: null, instruction_argument: 'prompt', task_name_argument: 'description', fresh_context: null },
  sources: { session: 'system-context', models: 'tool-schema', dispatch: 'tool-schema' }
};

test('host profile drives effort choices, host answers and compatibility issues', async t => {
  const { checkHostProfile, loadHostProfile } = await import('../../scripts/lib/apa-config.mjs');
  const { effortOptionsFor, readinessMessages: messages } = await import('../../Templates/apa-setup/page.js');
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apa-page-host-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const file = path.join(repoRoot, 'host-profile.json');
  fs.writeFileSync(file, JSON.stringify(hostProfile));
  assert.deepEqual(loadHostProfile(file), hostProfile);
  fs.writeFileSync(path.join(repoRoot, 'bad.json'), JSON.stringify({ ...hostProfile, models: [{ model: 'x', reasoning_efforts: ['deep'] }] }));
  assert.throws(() => loadHostProfile(path.join(repoRoot, 'bad.json')), /APA_HOST_PROFILE_INVALID/);
  assert.deepEqual(effortOptionsFor(hostProfile, 'big-model'), []);
  assert.deepEqual(effortOptionsFor(hostProfile, 'think-model'), ['low', 'high']);
  assert.equal(effortOptionsFor(hostProfile, 'unlisted'), null);
  assert.equal(effortOptionsFor(null, 'big-model'), null);
  const modelField = { type: 'model' };
  assert.deepEqual(fieldValue(modelField, { mode: 'explicit', model: 'big-model', effort: '' }), { mode: 'explicit', model: 'big-model' });
  const hostField = fields.find(field => field.key === 'host');
  const host = fieldValue(hostField, { value: 'detected' }, hostProfile);
  assert.deepEqual(host, { name: 'example-host', dispatch: hostProfile.dispatch });
  const saved = applyApaConfigOperation({ repoRoot, operation: createOperation(loadApaConfig({ repoRoot }), { set: {
    host, 'models.science': { mode: 'explicit', model: 'think-model' }, 'models.roles.english-writer': { mode: 'explicit', model: 'big-model', reasoning_effort: 'high' },
    'models.roles.chinese-writer': { mode: 'explicit', model: 'gone-model', reasoning_effort: 'high' }, 'models.query': { mode: 'explicit', model: 'big-model' } } }) });
  assert.deepEqual(flattenConfig(saved.config).host, host);
  assert.match(describeValue(host, 'host'), /example-host：Agent.*无推理强度参数.*默认即新上下文/);
  assert.equal(describeValue({ mode: 'explicit', model: 'big-model' }, 'models.query'), 'big-model；无推理强度参数');
  const check = checkHostProfile(saved.config, hostProfile);
  assert.equal(check.host, 'match');
  assert.deepEqual(check.issues, [
    { key: 'models.science', issue: 'effort-missing', model: 'think-model' },
    { key: 'models.roles.english-writer', issue: 'effort-not-supported', model: 'big-model', reasoning_effort: 'high' },
    { key: 'models.roles.chinese-writer', issue: 'model-not-detected', model: 'gone-model' }
  ]);
  const reordered = { ...saved.config, host: { dispatch: Object.fromEntries(Object.entries(host.dispatch).reverse()), name: host.name } };
  assert.equal(checkHostProfile(reordered, hostProfile).host, 'match');
  assert.equal(checkHostProfile(saved.config, { ...hostProfile, host: 'other-host' }).host, 'differs');
  assert.equal(checkHostProfile({}, { ...hostProfile, dispatch: null }).issues.at(-1).issue, 'dispatch-unavailable');
  const inspection = inspectApaConfig({ repoRoot, hostProfile });
  assert.equal(inspection.host_check.issues.length, 3);
  assert.match(messages(inspection, null, hostProfile).host, /example-host.*一致.*需要处理.*六个科学角色的共同模型——缺少该模型需要的推理强度/);
  assert.match(messages(inspection, null, null).host, /没有宿主检测结果/);
  const html = renderApaSetupPage({ snapshot: saved, inspection, hostProfile, repoRoot });
  const data = JSON.parse(html.match(/<script id="apa-setup-data" type="application\/json">(.*?)<\/script>/s)[1]);
  assert.deepEqual(data.hostProfile, hostProfile);
  assert.match(html, /id="host-readiness"/);
  assert.match(html, /data\.queryInspection, data\.hostProfile/);
  const cli = spawnSync(process.execPath, [path.resolve('scripts/apa-setup.mjs'), 'inspect', '--repo-root', repoRoot, '--host-profile', file], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).host_check.host, 'match');
  const misuse = spawnSync(process.execPath, [path.resolve('scripts/apa-setup.mjs'), 'export', '--repo-root', repoRoot, '--host-profile', file], { encoding: 'utf8' });
  assert.notEqual(misuse.status, 0);
});

test('a host that cannot select the model accepts only follow-main and reports explicit choices as conflicts', async t => {
  const { checkHostProfile, loadHostProfile, validateApaConfig } = await import('../../scripts/lib/apa-config.mjs');
  const { describeDispatch, readinessMessages: messages } = await import('../../Templates/apa-setup/page.js');
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apa-page-inherit-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const dispatch = { tool: 'subagent', model_argument: null, effort_argument: null, instruction_argument: 'prompt', task_name_argument: 'description', fresh_context: null };
  const profile = { ...hostProfile, host: 'deepseek-harness', session: { model: 'deepseek-flash', reasoning_effort: 'high' }, models: [], dispatch };
  const file = path.join(repoRoot, 'profile.json');
  fs.writeFileSync(file, JSON.stringify(profile));
  assert.deepEqual(loadHostProfile(file), profile);
  fs.writeFileSync(file, JSON.stringify({ ...profile, dispatch: { ...dispatch, effort_argument: 'reasoning_effort' } }));
  assert.throws(() => loadHostProfile(file), /APA_HOST_PROFILE_INVALID/);
  assert.match(describeDispatch('deepseek-harness', dispatch), /不能选择模型（子代理沿用主会话）/);
  const host = { name: 'deepseek-harness', dispatch };
  const saved = applyApaConfigOperation({ repoRoot, operation: createOperation(loadApaConfig({ repoRoot }), { set: {
    host, 'models.science': { mode: 'explicit', model: 'deepseek-flash', reasoning_effort: 'high' }, 'models.roles.english-writer': { mode: 'follow-main' } } }) });
  const validation = validateApaConfig(saved.config, { repoRoot });
  assert.equal(validation.valid, true);
  assert.equal(validation.complete, false);
  assert.deepEqual(validation.conflicts, ['models.science requires follow-main: host deepseek-harness cannot select the model']);
  assert.deepEqual(checkHostProfile(saved.config, profile).issues, [{ key: 'models.science', issue: 'model-selection-unavailable', model: 'deepseek-flash' }]);
  const inspection = inspectApaConfig({ repoRoot, hostProfile: profile });
  assert.equal(inspection.ready, false);
  assert.match(messages(inspection, null, profile).reading, /不能为子代理选择模型.*六个科学角色的共同模型/);
  assert.match(messages(inspection, null, profile).host, /需改为跟随主会话/);
  const fixed = applyApaConfigOperation({ repoRoot, operation: createOperation(saved, { set: { 'models.science': { mode: 'follow-main' } } }) });
  assert.deepEqual(validateApaConfig(fixed.config, { repoRoot }).conflicts, []);
  assert.deepEqual(checkHostProfile(fixed.config, profile).issues, []);
});

test('remove, export and import treat the saved host dispatch as one answer', t => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apa-page-host-ops-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const host = { name: 'claude-code', dispatch: { tool: 'Agent', model_argument: 'model', effort_argument: 'effort', instruction_argument: 'prompt', task_name_argument: 'description', fresh_context: null } };
  const saved = applyApaConfigOperation({ repoRoot, operation: createOperation(loadApaConfig({ repoRoot }), { set: { host, 'paths.runs': '.tmp/runs' } }) });
  const backup = exportApaConfig(saved.config);
  assert.deepEqual(backup.answers.host, host);
  assert.deepEqual(configDifferences({ schema_version: 'apa-local-config-1.0' }, backup.answers).map(item => item.key).sort(), ['host', 'paths.runs']);
  const removal = createOperation(saved, { action: 'remove', remove: ['host'] });
  assert.match(describeChanges(saved, removal)[0], /^子代理派发方式：claude-code：Agent.*→ 移除答案$/);
  const removed = applyApaConfigOperation({ repoRoot, operation: removal });
  assert.equal(removed.config.host, undefined);
  assert.equal(removed.config.paths.runs, '.tmp/runs');
  const html = renderApaSetupPage({ snapshot: removed, repoRoot });
  assert.match(html, /清除子代理派发方式后，新论文和查询改按 Codex 的方式派发/);
  assert.match(html, /备份包含子代理派发方式/);
  assert.match(html, /备份里的子代理派发方式属于当时检测的宿主/);
});

test('page operations are bound to the confirmed project folder and refused elsewhere', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apa-setup-repo-'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'apa-setup-other-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(other, { recursive: true, force: true }); });
  const current = loadApaConfig({ repoRoot: root });
  const operation = createOperation({ ...current, repo_root: root }, { set: { 'paths.runs': '.tmp/runs' } });
  assert.equal(operation.repo_root, root);
  assert.throws(() => applyApaConfigOperation({ repoRoot: other, operation }), /APA_CONFIG_REPO_MISMATCH/);
  assert.throws(() => applyApaConfigOperation({ repoRoot: root, operation: { ...operation, repo_root: 'relative/path' } }), /APA_CONFIG_REPO_MISMATCH/);
  assert.equal(applyApaConfigOperation({ repoRoot: root, operation }).config.paths.runs, '.tmp/runs');
  assert.equal(createOperation(snapshot).repo_root, undefined);
  const html = renderApaSetupPage({ snapshot, repoRoot: root });
  assert.equal(JSON.parse(html.match(/<script id="apa-setup-data" type="application\/json">(.*?)<\/script>/s)[1]).repoRoot, path.resolve(root));
  assert.ok(html.indexOf('id="project-step"') < html.indexOf('id="locations-step"') && html.indexOf('id="locations-step"') < html.indexOf('id="function-menu"'));
});

test('location fields show the actual position inside the confirmed project', async () => {
  const { resolveInProject, groups } = await import('../../Templates/apa-setup/page.js');
  assert.deepEqual(groups.filter(group => group.location).map(group => group.id), ['paths', 'parser']);
  assert.equal(resolveInProject('D:\\vault', 'Eval/apa-v3/runs'), 'D:\\vault\\Eval\\apa-v3\\runs');
  assert.equal(resolveInProject('D:\\vault', './.runtime/mineru'), 'D:\\vault\\.runtime\\mineru');
  assert.equal(resolveInProject('/home/a/vault', '.runtime/mineru'), '/home/a/vault/.runtime/mineru');
  assert.equal(resolveInProject('D:\\vault', 'E:/other'), 'E:/other');
});

// Minimal DOM: enough for mountApaSetup to build and for the preview button to run the page's own collect().
function createFakeDocument() {
  const registry = [];
  class Node {
    constructor(tag, text) { this.tag = tag; this.children = []; this.parent = null; this.listeners = {}; this.attributes = {}; this.dataset = {}; this.hidden = false; this.disabled = false; this.checked = false; this.className = ''; this._text = text ?? ''; this._value = ''; registry.push(this); }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.children = []; }
    get value() { return this._value; }
    set value(value) { this._value = this.tag === 'select' && !this.children.some(option => option.value === value) ? '' : String(value); }
    append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
    prepend(...nodes) { for (const node of nodes) node.parent = this; this.children.unshift(...nodes); }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    remove() {}
    addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
    dispatchEvent(event) { for (const listener of this.listeners[event.type] || []) listener(event); }
    click() { this.dispatchEvent(new Event('click')); }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; }
    get parentElement() { return this.parent; }
    focus() {}
    scrollIntoView() {}
    select() {}
    closest(tag) { return this.parent ?? new Node(tag); }
    querySelectorAll(selector) { return registry.filter(node => node !== this && matches(node, selector)); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? new Node('div'); }
  }
  const matches = (node, selector) => {
    const [, tag, cls, attr, value, checked] = selector.match(/^([a-z]*)(?:\.([\w-]+))?(?:\[([\w-]+)="([^"]*)"\])?(:checked)?$/);
    if (tag && node.tag !== tag) return false;
    if (cls && node.className !== cls) return false;
    if (attr && (attr === 'name' ? node.name : node.dataset[attr.replace('data-', '')]) !== value) return false;
    return !checked || node.checked;
  };
  const byIdCache = new Map();
  return {
    registry,
    createElement: tag => new Node(tag),
    getElementById: id => { if (!byIdCache.has(id)) byIdCache.set(id, new Node('div')); return byIdCache.get(id); },
    querySelectorAll: selector => registry.filter(node => matches(node, selector)),
    querySelector: selector => registry.find(node => matches(node, selector)) ?? new Node(selector.replace(/[^a-z].*/, '') || 'div')
  };
}

function mountFake(config, profile = hostProfile) {
  const document = createFakeDocument();
  mountApaSetup(document, { config: { schema_version: 'apa-local-config-1.0', ...config }, fingerprint: 'fp', exists: true, path: 'config/apa.local.json' }, null, null, profile, 'D:\\vault');
  const named = name => document.registry.find(node => node.name === name);
  const text = () => document.registry.map(node => node.textContent);
  const fieldset = title => document.registry.find(node => node.tag === 'fieldset' && node.children[0]?.textContent.includes(title));
  const preview = async () => {
    document.getElementById('enter-edit').click();
    document.querySelector('[data-preview="patch"]').click();
    await new Promise(resolve => setImmediate(resolve));
    const payload = document.getElementById('edit-payload').value;
    return { message: document.getElementById('edit-message').textContent, set: payload ? JSON.parse(payload).set : null };
  };
  const choose = (prefix, { model, effort, mode = 'explicit' }) => {
    const select = named(`${prefix}-mode`);
    const toggle = select.parent.parent.children[0].children[0].children[0];
    toggle.checked = true; toggle.dispatchEvent(new Event('change'));
    select.value = mode; select.dispatchEvent(new Event('change'));
    if (model) { named(`${prefix}-model`).value = model; named(`${prefix}-model`).dispatchEvent(new Event('change')); }
    if (effort) { named(`${prefix}-effort`).value = effort; named(`${prefix}-effort`).dispatchEvent(new Event('change')); }
  };
  return { document, named, text, fieldset, preview, choose };
}

test('location suggestions require a click and preview only durable project paths', async () => {
  const config = { paths: { runs: 'existing/runs' }, models: { science: { mode: 'follow-main' } } };
  const original = structuredClone(config);
  const page = mountFake(config);
  assert.deepEqual((await page.preview()).set, {});
  page.document.getElementById('suggestions').click();
  assert.deepEqual((await page.preview()).set, {
    'paths.runs': 'Eval/apa-v3/runs',
    'paths.parse': 'Eval/apa-v3/parse',
    'paths.candidates': 'Eval/apa-v3/reading'
  });
  assert.deepEqual(config, original);
});

test('a group choice writes the same model to every key in the group', () => {
  const choice = { mode: 'explicit', model: 'think-model', effort: 'high' };
  const expected = { mode: 'explicit', model: 'think-model', reasoning_effort: 'high' };
  const keysOf = id => modelGroups.find(group => group.id === id).keys;
  const presentation = collectModelSet({ config: {}, groupSelections: { presentation: choice } });
  assert.deepEqual(Object.keys(presentation), ['models.roles.reading-editor', 'models.roles.translation']);
  assert.ok(Object.values(presentation).every(value => JSON.stringify(value) === JSON.stringify(expected)));
  assert.deepEqual(Object.keys(collectModelSet({ config: {}, groupSelections: { judgment: choice } })), keysOf('judgment'));
  assert.deepEqual(collectModelSet({ config: {}, groupSelections: { analysis: { mode: 'follow-main' } } }), { 'models.science': { mode: 'follow-main' } });
  assert.deepEqual(collectModelSet({ config: { models: { roles: { translation: expected } } }, groupSelections: { presentation: choice } }), { 'models.roles.reading-editor': expected });
  assert.throws(() => collectModelSet({ config: {}, groupSelections: { writing: { mode: 'explicit', model: 'think-model' } }, hostProfile }), /推理强度/);
  assert.throws(() => collectModelSet({ config: {}, groupSelections: { writing: { mode: '' } } }), /原文写作/);
});

test('group and individual selection of the same key is refused', () => {
  const choice = { mode: 'follow-main' };
  assert.throws(() => collectModelSet({ config: {}, groupSelections: { presentation: choice }, roleSelections: { 'models.roles.translation': choice } }), /翻译.*translation.*二选一/);
  assert.throws(() => collectModelSet({ config: {}, groupSelections: { judgment: choice }, roleSelections: { 'models.overrides.evidence': choice } }), /证据梳理.*evidence.*二选一/);
  assert.deepEqual(Object.keys(collectModelSet({ config: {}, groupSelections: { analysis: choice }, roleSelections: { 'models.overrides.methods': choice } })).sort(), ['models.overrides.methods', 'models.science']);
});

test('group current value reports mixed members per role', () => {
  const same = { mode: 'follow-main' };
  const presentation = modelGroups.find(group => group.id === 'presentation');
  assert.deepEqual(groupCurrent({ models: { roles: { 'reading-editor': same, translation: same } } }, presentation), { uniform: true, value: same });
  assert.deepEqual(groupCurrent({}, presentation), { uniform: true, value: undefined });
  const mixed = groupCurrent({ models: { roles: { 'reading-editor': same } } }, presentation);
  assert.equal(mixed.uniform, false);
  assert.deepEqual(mixed.perKey, [{ role: 'reading-editor', key: 'models.roles.reading-editor', value: same }, { role: 'translation', key: 'models.roles.translation', value: undefined }]);
  assert.equal(groupCurrent({ models: { science: same } }, modelGroups.find(group => group.id === 'analysis')).uniform, true);
});

test('model groups keep the agreed ids, roles and keys, each with a strength and reason that name no model', () => {
  assert.deepEqual(modelGroups.map(({ id, title, roles, keys }) => ({ id, title, roles, keys })), [
    { id: 'judgment', title: '关键判断', roles: ['evidence', 'integration', 'independent-verifier'], keys: ['models.overrides.evidence', 'models.overrides.integration', 'models.roles.independent-verifier'] },
    { id: 'writing', title: '原文写作', roles: ['english-writer', 'chinese-writer'], keys: ['models.roles.english-writer', 'models.roles.chinese-writer'] },
    { id: 'analysis', title: '专项分析', roles: ['methods', 'results', 'interpretation', 'scientific-reading'], keys: ['models.science'] },
    { id: 'presentation', title: '呈现与翻译', roles: ['reading-editor', 'translation'], keys: ['models.roles.reading-editor', 'models.roles.translation'] }
  ]);
  assert.deepEqual(modelGroups.map(group => group.strength), ['最高', '高', '中等', '较低']);
  assert.equal(modelGroupSummary, '关键判断 ≥ 原文写作 ＞ 专项分析 ≥ 呈现与翻译');
  const detected = hostProfile.models.map(item => item.model);
  for (const group of modelGroups) {
    assert.ok(group.help.length > 30, group.id);
    assert.ok(!detected.some(model => group.help.includes(model)), group.id);
    assert.ok(!/gpt|claude|sonnet|opus|haiku|推荐使用|建议使用/i.test(group.help), group.id);
  }
});

test('each group explains its relative strength on the page, the summary appears once, and no model is preselected', () => {
  const page = mountFake({});
  assert.equal(page.text().filter(item => item === modelGroupSummary).length, 1);
  const groupGrid = page.fieldset('关键判断').parentElement;
  assert.deepEqual(groupGrid.children.map(row => row.children[0].textContent), modelGroupSummary.split(/\s*[≥＞]\s*/).map(title => `${title} · 修改此组`));
  for (const group of modelGroups) {
    const fieldset = page.fieldset(group.title);
    assert.ok(fieldset, group.title);
    const content = fieldset.textContent;
    assert.ok(content.includes(`相对强度：${group.strength}`) && content.includes(group.help), group.title);
  }
  const selects = page.document.registry.filter(node => node.tag === 'select' && /-(mode|model|effort)$/.test(node.name));
  assert.ok(selects.length > 0 && selects.every(select => select.value === ''));
  const saved = { mode: 'explicit', model: 'think-model', reasoning_effort: 'low' };
  const withSaved = mountFake({ models: { science: saved, roles: { translation: saved } } });
  const models = withSaved.document.registry.filter(node => node.tag === 'select' && node.name.endsWith('-model'));
  assert.ok(models.every(select => select.value === '' || select.value === 'think-model'));
  assert.equal(withSaved.named('group-analysis-model').value, 'think-model');
  assert.equal(withSaved.named('group-presentation-model').value, '');
  assert.equal(withSaved.named('models.roles.translation-model').value, 'think-model');
});

test('the page lists all eleven roles in a collapsed individual section and marks a missing translation', () => {
  const page = mountFake({ models: { roles: { 'reading-editor': { mode: 'follow-main' } } } });
  const roles = page.document.registry.find(node => node.tag === 'details' && node.children[0]?.textContent === '按角色单独设置（可选）');
  assert.ok(roles);
  assert.equal(roles.children.filter(child => child.tag === 'div').flatMap(child => child.children).length, 11);
  const presentation = page.fieldset('呈现与翻译').textContent;
  assert.ok(presentation.includes('阅读编辑：跟随主会话') && presentation.includes('翻译：未配置'));
  assert.ok(page.fieldset('关键判断').textContent.includes('当前：未配置'));
});

test('first writing language is no longer asked and a legacy value stays labelled and importable', () => {
  assert.ok(!fields.some(field => field.key === 'reading.source_language'));
  assert.equal(setupPages.find(page => page.id === 'reading').title, '笔记呈现');
  assert.ok(!setupPages.some(page => ['science', 'writers'].includes(page.id)));
  assert.equal(setupPages.find(page => page.id === 'models').title, '角色模型');
  assert.deepEqual(unknownConfigKeys({ schema_version: 'apa-local-config-1.0', reading: { source_language: 'en', presentation_mode: 'writer' }, models: { roles: { translation: { mode: 'follow-main' } } } }), []);
  assert.deepEqual(unknownConfigKeys({ schema_version: 'apa-local-config-1.0', reading: { nope: 1 } }), ['reading.nope']);
});

test('importing an old backup without translation neither lists it nor clears an existing choice', () => {
  const translation = { mode: 'explicit', model: 'think-model', reasoning_effort: 'low' };
  const current = { schema_version: 'apa-local-config-1.0', models: { science: { mode: 'follow-main' }, roles: { translation } } };
  const oldBackup = { schema_version: 'apa-local-config-1.0', models: { science: { mode: 'explicit', model: 'big-model' } } };
  assert.deepEqual(configDifferences(current, oldBackup).map(item => item.key), ['models.science']);
  assert.equal(mountFake({ models: current.models }).named('models.roles.translation-model').value, 'think-model');
});

test('the page collects a group choice through its own preview and refuses a doubly chosen role', async () => {
  const page = mountFake({});
  page.choose('group-presentation', { model: 'think-model', effort: 'high' });
  const result = await page.preview();
  const expected = { mode: 'explicit', model: 'think-model', reasoning_effort: 'high' };
  assert.deepEqual(result.set, { 'models.roles.reading-editor': expected, 'models.roles.translation': expected });
  page.choose('models.roles.translation', { mode: 'follow-main' });
  const conflict = await page.preview();
  assert.equal(conflict.set, null);
  assert.match(conflict.message, /翻译.*二选一/);
});

test('page rejects legacy profile with investigation list', t => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apa-page-gate-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const file = path.join(repoRoot, 'host-profile.json');
  fs.writeFileSync(file, JSON.stringify(hostProfile));
  const output = path.join(repoRoot, '.tmp/apa-setup/index.html');
  const cli = spawnSync(process.execPath, [path.resolve('scripts/apa-setup.mjs'), 'page', '--repo-root', repoRoot, '--host-profile', file], { encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /^APA_SETUP_INVESTIGATION_INCOMPLETE: /);
  assert.equal(cli.stderr.match(/investigate:capability:/g).length, 6);
  assert.equal(fs.existsSync(output), false);
});

test('page without profile keeps manual fallback', t => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apa-page-gate-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const cli = spawnSync(process.execPath, [path.resolve('scripts/apa-setup.mjs'), 'page', '--repo-root', repoRoot], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.ok(fs.existsSync(path.join(repoRoot, '.tmp/apa-setup/index.html')));
});

test('threshold input renders without command template', async () => {
  const container = await renderCards({ threshold_compaction: { state: 'needs-user-action', summary: '用户决定阈值', steps: [step(null, null, { actor: 'user' })] } });
  const [input] = findAll(container, node => node.name === 'threshold-threshold_compaction');
  assert.ok(input);
  assert.equal(input.value, '');
  assert.ok(!flattenText(container).includes('候选阈值 123456 token'));
  enter(input, '123456');
  assert.ok(flattenText(container).includes('候选阈值 123456 token：请把这个数值告诉助手'));
  assert.ok(findAll(container, node => node.tag === 'code').every(node => !node.textContent.includes('apa-host-settings')));
});

test('setup issues render grouped', async () => {
  const { renderSetupIssues } = await import('../../Templates/apa-setup/page.js');
  const container = eventNode('div');
  renderSetupIssues({ createElement: eventNode }, container, [
    { id: 'page-choice:missing:models.science', category: 'page-choice', subject: 'models.science', summary: '配置项 models.science 尚未回答。' },
    { id: 'authorize:dependency:parser.python', category: 'authorize', subject: 'parser.python', summary: '依赖 parser.python 缺失' },
    { id: 'known-limit:capability:science_recovery', category: 'known-limit', subject: 'science_recovery', summary: '宿主不提供任务查询' },
  ]);
  const text = flattenText(container);
  const titles = ['需要在本页选择', '已与助手讨论的授权事项', '已知限制'].map(title => text.indexOf(title));
  assert.ok(titles.every(index => index >= 0));
  assert.deepEqual(titles, [...titles].sort((a, b) => a - b));
  for (const phrase of ['models.science 尚未回答', 'parser.python 缺失', '宿主不提供任务查询']) assert.ok(text.includes(phrase), phrase);
  const empty = eventNode('div');
  renderSetupIssues({ createElement: eventNode }, empty, []);
  assert.match(flattenText(empty), /没有遗留问题/);
});
