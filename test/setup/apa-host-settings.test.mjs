import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/setup/apa-host-settings.mjs');
const temporary = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apa-host-settings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, file: ext => path.join(root, `settings.${ext}`) };
};
const run = (args) => {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  const parse = text => { try { return JSON.parse(text); } catch { return null; } };
  return { status: result.status, out: parse(result.stdout), err: parse(result.stderr), stdout: result.stdout, stderr: result.stderr };
};
const claudeArgs = (command, dir, tokens = '200000', extra = []) => [command, '--host', 'claude-code', '--capability', 'threshold_compaction', '--scope', 'project', '--tokens', tokens, '--settings-file', dir.file('json'), ...extra];
const codexArgs = (command, dir, tokens = '200000', extra = []) => [command, '--host', 'codex', '--capability', 'threshold_compaction', '--scope', 'user', '--tokens', tokens, '--settings-file', dir.file('toml'), ...extra];
// The script keeps no backup: nothing but the settings file may appear beside it.
const backupFiles = dir => fs.readdirSync(dir.root).filter(name => !name.startsWith('settings.'));

test('plan previews without writing', t => {
  const dir = temporary(t);
  const original = '{\n  "model": "opus",\n  "autoCompactWindow": 150000,\n  "env": { "A": "1" }\n}\n';
  fs.writeFileSync(dir.file('json'), original);
  const result = run(claudeArgs('plan', dir));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.out.target, dir.file('json'));
  assert.equal(result.out.before.value, 150000);
  assert.equal(result.out.after.value, 200000);
  assert.equal('backup_path' in result.out, false);
  assert.deepEqual(result.out.alternatives, ['/autocompact 200000', 'claude --autocompact 200000']);
  assert.equal(fs.readFileSync(dir.file('json'), 'utf8'), original);
  assert.deepEqual(backupFiles(dir), []);
});

test('plan for a missing file creates only the key', t => {
  const dir = temporary(t);
  const result = run(claudeArgs('plan', dir));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.out.before.exists, false);
  assert.equal(fs.existsSync(dir.file('json')), false);
  const applied = run(claudeArgs('apply', dir, '200000', ['--confirm']));
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(fs.readFileSync(dir.file('json'), 'utf8'), '{\n  "autoCompactWindow": 200000\n}\n');
  assert.deepEqual(backupFiles(dir), []);
});

test('apply requires confirm and keeps no backup', t => {
  const dir = temporary(t);
  const original = '{\n  "model": "opus",\n  "env": { "A": "1" },\n  "hooks": {}\n}\n';
  fs.writeFileSync(dir.file('json'), original);
  const refused = run(claudeArgs('apply', dir));
  assert.equal(refused.status, 1);
  assert.equal(refused.err.error.code, 'APA_HOST_SETTINGS_CONFIRM_REQUIRED');
  assert.equal(fs.readFileSync(dir.file('json'), 'utf8'), original);
  assert.deepEqual(backupFiles(dir), []);

  const applied = run(claudeArgs('apply', dir, '200000', ['--confirm']));
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(applied.out.applied, true);
  assert.equal(applied.out.verified, true);
  assert.equal('backup_path' in applied.out, false);
  assert.deepEqual(backupFiles(dir), []);
  assert.equal(fs.readFileSync(dir.file('json'), 'utf8'), '{\n  "model": "opus",\n  "env": { "A": "1" },\n  "hooks": {},\n  "autoCompactWindow": 200000\n}\n');
});

test('update changes only the value: other bytes, indent, EOL and missing trailing newline stay', t => {
  const dir = temporary(t);
  fs.writeFileSync(dir.file('json'), '{\r\n\t"b": 1,\r\n\t"autoCompactWindow": 120000,\r\n\t"a": [1, 2]\r\n}');
  const applied = run(claudeArgs('apply', dir, '300000', ['--confirm']));
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(fs.readFileSync(dir.file('json'), 'utf8'), '{\r\n\t"b": 1,\r\n\t"autoCompactWindow": 300000,\r\n\t"a": [1, 2]\r\n}');
});

test('insert follows the file indent and EOL; empty and one-line objects are handled', t => {
  const cases = [
    ['{\r\n\t"b": 1\r\n}', '{\r\n\t"b": 1,\r\n\t"autoCompactWindow": 200000\r\n}'],
    ['{\n    "b": {"x": [1]}\n}\n', '{\n    "b": {"x": [1]},\n    "autoCompactWindow": 200000\n}\n'],
    ['{}', '{\n  "autoCompactWindow": 200000\n}'],
    ['﻿{ }\r\n', '﻿{\r\n  "autoCompactWindow": 200000\r\n}\r\n'],
    ['{"b":1}\n', '{"b":1, "autoCompactWindow": 200000}\n'],
  ];
  for (const [original, expected] of cases) {
    const dir = temporary(t);
    fs.writeFileSync(dir.file('json'), original);
    const applied = run(claudeArgs('apply', dir, '200000', ['--confirm']));
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(fs.readFileSync(dir.file('json'), 'utf8'), expected);
  }
});

test('an unchanged value writes nothing', t => {
  const dir = temporary(t);
  const original = '{"autoCompactWindow":200000}';
  fs.writeFileSync(dir.file('json'), original);
  const applied = run(claudeArgs('apply', dir, '200000', ['--confirm']));
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(applied.out.changed, false);
  assert.equal(fs.readFileSync(dir.file('json'), 'utf8'), original);
  assert.deepEqual(backupFiles(dir), []);
});

test('out-of-range and non-integer tokens are refused, never clamped', t => {
  const dir = temporary(t);
  for (const tokens of ['99999', '1000001', '0', '-5', '200000.5', '2e5', 'abc', '']) {
    for (const command of ['plan', 'apply']) {
      const result = run(claudeArgs(command, dir, tokens, ['--confirm']));
      assert.equal(result.status, 1, `${command} ${tokens}`);
      assert.match(result.err.error.code, /^APA_HOST_SETTINGS_TOKENS_(OUT_OF_RANGE|NOT_INTEGER)$/, `${command} ${tokens}`);
    }
  }
  assert.equal(run(claudeArgs('plan', dir, '99999')).err.error.code, 'APA_HOST_SETTINGS_TOKENS_OUT_OF_RANGE');
  assert.equal(run(claudeArgs('plan', dir, '200000.5')).err.error.code, 'APA_HOST_SETTINGS_TOKENS_NOT_INTEGER');
  assert.equal(run(claudeArgs('plan', dir, '100000')).status, 0);
  assert.equal(run(claudeArgs('plan', dir, '1000000')).status, 0);
  assert.equal(fs.existsSync(dir.file('json')), false);
});

test('a missing --tokens is an error and never defaults', t => {
  const dir = temporary(t);
  const args = claudeArgs('apply', dir, '200000', ['--confirm']);
  args.splice(args.indexOf('--tokens'), 2);
  const result = run(args);
  assert.equal(result.status, 1);
  assert.equal(result.err.error.code, 'APA_HOST_SETTINGS_TOKENS_REQUIRED');
  assert.equal(fs.existsSync(dir.file('json')), false);
});

test('unparseable settings files are reported by plan and never overwritten', t => {
  const cases = [
    ['empty', '', 'APA_HOST_SETTINGS_FILE_EMPTY'],
    ['blank', '  \n', 'APA_HOST_SETTINGS_FILE_EMPTY'],
    ['line comment', '{\n  // note\n  "a": 1\n}\n', 'APA_HOST_SETTINGS_HAS_COMMENTS'],
    ['block comment', '{ /* note */ "a": 1 }', 'APA_HOST_SETTINGS_HAS_COMMENTS'],
    ['invalid', '{ "a": 1,, }', 'APA_HOST_SETTINGS_INVALID_JSON'],
    ['not an object', '[1, 2]', 'APA_HOST_SETTINGS_NOT_OBJECT'],
  ];
  for (const [name, content, code] of cases) {
    const dir = temporary(t);
    fs.writeFileSync(dir.file('json'), content);
    const plan = run(claudeArgs('plan', dir));
    assert.equal(plan.status, 1, name);
    assert.equal(plan.out.problem.code, code, name);
    assert.equal(plan.out.after, null, name);
    const apply = run(claudeArgs('apply', dir, '200000', ['--confirm']));
    assert.equal(apply.status, 1, name);
    assert.equal(apply.err.error.code, code, name);
    assert.equal(fs.readFileSync(dir.file('json'), 'utf8'), content, name);
    assert.deepEqual(backupFiles(dir), [], name);
  }
});

test('a comment marker inside a string is not a comment', t => {
  const dir = temporary(t);
  fs.writeFileSync(dir.file('json'), '{\n  "url": "http://example.test/*x*/"\n}\n');
  const applied = run(claudeArgs('apply', dir, '200000', ['--confirm']));
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(fs.readFileSync(dir.file('json'), 'utf8'), '{\n  "url": "http://example.test/*x*/",\n  "autoCompactWindow": 200000\n}\n');
});

test('Codex: updates only the top-level line and keeps every other byte', t => {
  const dir = temporary(t);
  const original = '# top\r\nmodel = "gpt"\r\nmodel_auto_compact_token_limit = 150000 # keep\r\n\r\n[profiles.x]\r\nmodel_auto_compact_token_limit = 1\r\n';
  fs.writeFileSync(dir.file('toml'), original);
  const plan = run(codexArgs('plan', dir));
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(plan.out.before.value, 150000);
  assert.ok(plan.out.alternatives.includes('codex -c model_auto_compact_token_limit=200000'));
  assert.ok(plan.out.notes.some(note => note.includes('258400')));
  assert.equal(fs.readFileSync(dir.file('toml'), 'utf8'), original);
  const applied = run(codexArgs('apply', dir, '200000', ['--confirm']));
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(fs.readFileSync(dir.file('toml'), 'utf8'), original.replace('= 150000 # keep', '= 200000 # keep'));
  assert.deepEqual(backupFiles(dir), []);
});

test('Codex: inserts before the first table, after top-level content', t => {
  const dir = temporary(t);
  fs.writeFileSync(dir.file('toml'), 'model = "gpt"\n\n# about x\n[profiles.x]\nmodel = "y"\n');
  assert.equal(run(codexArgs('apply', dir, '200000', ['--confirm'])).status, 0);
  assert.equal(fs.readFileSync(dir.file('toml'), 'utf8'), 'model = "gpt"\nmodel_auto_compact_token_limit = 200000\n\n# about x\n[profiles.x]\nmodel = "y"\n');
  const only = temporary(t);
  fs.writeFileSync(only.file('toml'), '[a]\nx = 1\n');
  assert.equal(run(codexArgs('apply', only, '200000', ['--confirm'])).status, 0);
  assert.equal(fs.readFileSync(only.file('toml'), 'utf8'), 'model_auto_compact_token_limit = 200000\n\n[a]\nx = 1\n');
});

test('Codex: appends when there is no table and creates a missing file', t => {
  const dir = temporary(t);
  fs.writeFileSync(dir.file('toml'), 'model = "gpt"');
  assert.equal(run(codexArgs('apply', dir, '200000', ['--confirm'])).status, 0);
  assert.equal(fs.readFileSync(dir.file('toml'), 'utf8'), 'model = "gpt"\nmodel_auto_compact_token_limit = 200000');
  const fresh = temporary(t);
  assert.equal(run(codexArgs('apply', fresh, '200000', ['--confirm'])).status, 0);
  assert.equal(fs.readFileSync(fresh.file('toml'), 'utf8'), 'model_auto_compact_token_limit = 200000\n');
});

test('Codex: a table header inside a multi-line string is not a table', t => {
  const dir = temporary(t);
  fs.writeFileSync(dir.file('toml'), 'notes = """\n[not a table]\n"""\n[a]\nx = 1\n');
  assert.equal(run(codexArgs('apply', dir, '200000', ['--confirm'])).status, 0);
  assert.equal(fs.readFileSync(dir.file('toml'), 'utf8'), 'notes = """\n[not a table]\n"""\nmodel_auto_compact_token_limit = 200000\n[a]\nx = 1\n');
});

test('Codex: a bracket line inside a multi-line array is not a table', t => {
  const dir = temporary(t);
  fs.writeFileSync(dir.file('toml'), 'matrix = [\n  [1, 2],\n]\n[a]\nx = 1\n');
  assert.equal(run(codexArgs('apply', dir, '200000', ['--confirm'])).status, 0);
  assert.equal(fs.readFileSync(dir.file('toml'), 'utf8'), 'matrix = [\n  [1, 2],\n]\nmodel_auto_compact_token_limit = 200000\n[a]\nx = 1\n');
});

test('Codex: a BOM before the first-line key is kept and the key is updated, not duplicated', t => {
  const dir = temporary(t);
  const original = '﻿model_auto_compact_token_limit = 150000\r\nmodel = "gpt"\r\n';
  fs.writeFileSync(dir.file('toml'), original);
  assert.equal(run(codexArgs('apply', dir, '200000', ['--confirm'])).status, 0);
  assert.equal(fs.readFileSync(dir.file('toml'), 'utf8'), '﻿model_auto_compact_token_limit = 200000\r\nmodel = "gpt"\r\n');
  const insert = temporary(t);
  fs.writeFileSync(insert.file('toml'), '﻿model = "gpt"\n[a]\nx = 1\n');
  assert.equal(run(codexArgs('apply', insert, '200000', ['--confirm'])).status, 0);
  assert.equal(fs.readFileSync(insert.file('toml'), 'utf8'), '﻿model = "gpt"\nmodel_auto_compact_token_limit = 200000\n[a]\nx = 1\n');
});

test('Codex: a quoted key is updated in place, never duplicated', t => {
  for (const [original, expected] of [
    ['"model_auto_compact_token_limit" = 5\nmodel = "gpt"\n', '"model_auto_compact_token_limit" = 200000\nmodel = "gpt"\n'],
    ["model = \"gpt\"\n'model_auto_compact_token_limit'=5 # note\n", "model = \"gpt\"\n'model_auto_compact_token_limit'=200000 # note\n"],
  ]) {
    const dir = temporary(t);
    fs.writeFileSync(dir.file('toml'), original);
    assert.equal(run(codexArgs('apply', dir, '200000', ['--confirm'])).status, 0);
    assert.equal(fs.readFileSync(dir.file('toml'), 'utf8'), expected);
  }
});

test('Codex: duplicate or unrewritable key forms are refused and never appended beside', t => {
  const cases = [
    ['duplicate', 'model_auto_compact_token_limit = 1\n"model_auto_compact_token_limit" = 2\n', 'APA_HOST_SETTINGS_TOML_DUPLICATE_KEY'],
    ['dotted', 'model_auto_compact_token_limit.x = 1\n', 'APA_HOST_SETTINGS_TOML_UNSAFE_KEY'],
    ['inside a value', 'note = "model_auto_compact_token_limit"\n[a]\nx = 1\n', 'APA_HOST_SETTINGS_TOML_UNSAFE_KEY'],
  ];
  for (const [name, content, code] of cases) {
    const dir = temporary(t);
    fs.writeFileSync(dir.file('toml'), content);
    const plan = run(codexArgs('plan', dir));
    assert.equal(plan.status, 1, name);
    assert.equal(plan.out.problem.code, code, name);
    const apply = run(codexArgs('apply', dir, '200000', ['--confirm']));
    assert.equal(apply.err.error.code, code, name);
    assert.equal(fs.readFileSync(dir.file('toml'), 'utf8'), content, name);
    assert.deepEqual(backupFiles(dir), [], name);
  }
});

test('Codex: a commented-out key is ignored and a new line is inserted', t => {
  const dir = temporary(t);
  fs.writeFileSync(dir.file('toml'), '# model_auto_compact_token_limit = 1\nmodel = "gpt"\n[a]\nx = 1\n');
  const plan = run(codexArgs('plan', dir));
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(plan.out.change, 'add-key');
  assert.equal(run(codexArgs('apply', dir, '200000', ['--confirm'])).status, 0);
  assert.equal(fs.readFileSync(dir.file('toml'), 'utf8'), '# model_auto_compact_token_limit = 1\nmodel = "gpt"\nmodel_auto_compact_token_limit = 200000\n[a]\nx = 1\n');
});

test('Codex: requires a positive integer and only the user scope', t => {
  const dir = temporary(t);
  for (const tokens of ['0', '-1', '1.5', 'abc']) {
    assert.match(run(codexArgs('plan', dir, tokens)).err.error.code, /^APA_HOST_SETTINGS_TOKENS_(NOT_INTEGER|OUT_OF_RANGE)$/, tokens);
  }
  assert.equal(run(codexArgs('plan', dir, '50000')).status, 0);
  const project = codexArgs('plan', dir);
  project[project.indexOf('user')] = 'project';
  assert.equal(run(project).err.error.code, 'APA_HOST_SETTINGS_SCOPE_UNSUPPORTED');
});

test('rejects unknown host, capability and arguments', t => {
  const dir = temporary(t);
  const withHost = args => { const copy = [...args]; copy[copy.indexOf('--host') + 1] = 'deepseek'; return copy; };
  assert.equal(run(withHost(claudeArgs('plan', dir))).err.error.code, 'APA_HOST_SETTINGS_HOST_UNSUPPORTED');
  const withCapability = claudeArgs('plan', dir);
  withCapability[withCapability.indexOf('threshold_compaction')] = 'bogus_capability';
  assert.equal(run(withCapability).err.error.code, 'APA_HOST_SETTINGS_CAPABILITY_UNSUPPORTED');
  assert.equal(run([...claudeArgs('plan', dir), '--bogus', '1']).err.error.code, 'APA_HOST_SETTINGS_UNKNOWN_ARGUMENT');
  assert.equal(run(['frobnicate']).err.error.code, 'APA_HOST_SETTINGS_UNKNOWN_COMMAND');
  assert.equal(run(['restore', '--host', 'claude-code', '--confirm']).err.error.code, 'APA_HOST_SETTINGS_UNKNOWN_COMMAND');
  assert.equal(run([...claudeArgs('plan', dir), '--backup-dir', dir.root]).err.error.code, 'APA_HOST_SETTINGS_UNKNOWN_ARGUMENT');
});

test('default targets resolve without touching any file', async () => {
  const { resolveTarget } = await import('../../scripts/setup/apa-host-settings.mjs');
  assert.equal(resolveTarget({ host: 'claude-code', scope: 'project' }), path.resolve(path.dirname(script), '../..', '.claude', 'settings.json'));
  assert.equal(resolveTarget({ host: 'claude-code', scope: 'user' }), path.join(os.homedir(), '.claude', 'settings.json'));
  assert.equal(resolveTarget({ host: 'codex', scope: 'user' }), path.join(os.homedir(), '.codex', 'config.toml'));
});

// compact_hook: SessionStart/compact entry in the project settings.
const hookCommand = 'node "$CLAUDE_PROJECT_DIR/scripts/setup/apa-compact-context.mjs"';
const hookArgs = (command, dir, extra = []) => [command, '--host', 'claude-code', '--capability', 'compact_hook', '--scope', 'project', '--settings-file', dir.file('json'), ...extra];
// The entry as JSON.stringify(entry, null, unit) renders it, first line without indent, later lines at `indent`.
const compactEntry = { matcher: 'compact', hooks: [{ type: 'command', command: hookCommand, timeout: 10 }] };
const entryText = (indent, unit = '  ', eol = '\n') => JSON.stringify(compactEntry, null, unit).replaceAll('\n', eol + indent);
const sessionStartOf = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')).hooks.SessionStart;

test('compact_hook: plan previews, a missing file is created and apply needs --confirm', t => {
  const dir = temporary(t);
  const plan = run(hookArgs('plan', dir));
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(plan.out.capability, 'compact_hook');
  assert.equal(plan.out.key, 'hooks.SessionStart');
  assert.equal(plan.out.change, 'create-file');
  assert.deepEqual(plan.out.after.value, compactEntry);
  assert.ok(plan.out.notes.some(note => note.includes('$CLAUDE_PROJECT_DIR') && note.includes('Git Bash')));
  assert.equal(fs.existsSync(dir.file('json')), false);
  const refused = run(hookArgs('apply', dir));
  assert.equal(refused.err.error.code, 'APA_HOST_SETTINGS_CONFIRM_REQUIRED');
  assert.equal(fs.existsSync(dir.file('json')), false);
  const applied = run(hookArgs('apply', dir, ['--confirm']));
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(applied.out.verified, true);
  assert.deepEqual(sessionStartOf(dir.file('json')), [compactEntry]);
  assert.deepEqual(backupFiles(dir), []);
});

test('compact_hook: adds the entry once, keeps every other key and hook, and is idempotent', t => {
  const dir = temporary(t);
  const original = [
    '{',
    '  "model": "opus",',
    '  "hooks": {',
    '    "PreToolUse": [',
    '      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "echo pre" }] }',
    '    ],',
    '    "SessionStart": [',
    '      { "matcher": "startup", "hooks": [{ "type": "command", "command": "echo start" }] }',
    '    ]',
    '  },',
    '  "env": { "A": "1" }',
    '}',
    '',
  ].join('\n');
  fs.writeFileSync(dir.file('json'), original);
  const applied = run(hookArgs('apply', dir, ['--confirm']));
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(applied.out.changed, true);
  const updated = fs.readFileSync(dir.file('json'), 'utf8');
  const expected = original.replace('echo start" }] }\n    ]', `echo start" }] },\n      ${entryText('      ')}\n    ]`);
  assert.notEqual(expected, original);
  assert.equal(updated, expected);
  const parsed = JSON.parse(updated);
  assert.deepEqual(Object.keys(parsed), ['model', 'hooks', 'env']);
  assert.equal(parsed.hooks.PreToolUse.length, 1);
  assert.equal(parsed.hooks.SessionStart.length, 2);
  assert.deepEqual(parsed.hooks.SessionStart[1], compactEntry);

  const again = run(hookArgs('apply', dir, ['--confirm']));
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.out.applied, false);
  assert.equal(again.out.changed, false);
  assert.equal(again.out.change, 'unchanged');
  assert.equal(again.out.verified, true);
  assert.equal(fs.readFileSync(dir.file('json'), 'utf8'), updated);
  assert.deepEqual(backupFiles(dir), []);
  const plan = run(hookArgs('plan', dir));
  assert.equal(plan.out.change, 'unchanged');
});

test('compact_hook: an equal entry among other compact entries is found; a different compact entry is kept and ours added', t => {
  const dir = temporary(t);
  const other = { matcher: 'compact', hooks: [{ type: 'command', command: 'echo other' }] };
  fs.writeFileSync(dir.file('json'), JSON.stringify({ hooks: { SessionStart: [other, compactEntry] } }));
  assert.equal(run(hookArgs('plan', dir)).out.change, 'unchanged');
  fs.writeFileSync(dir.file('json'), JSON.stringify({ hooks: { SessionStart: [other] } }));
  const applied = run(hookArgs('apply', dir, ['--confirm']));
  assert.equal(applied.status, 0, applied.stderr);
  assert.deepEqual(sessionStartOf(dir.file('json')), [other, compactEntry]);
});

test('compact_hook: an old entry with the relative command or no timeout is not equal, so the current entry is added', t => {
  const dir = temporary(t);
  const old = { matcher: 'compact', hooks: [{ type: 'command', command: 'node scripts/setup/apa-compact-context.mjs' }] };
  const noTimeout = { matcher: 'compact', hooks: [{ type: 'command', command: hookCommand }] };
  fs.writeFileSync(dir.file('json'), JSON.stringify({ hooks: { SessionStart: [old, noTimeout] } }));
  assert.equal(run(hookArgs('plan', dir)).out.change, 'add-key');
  assert.equal(run(hookArgs('apply', dir, ['--confirm'])).status, 0);
  assert.deepEqual(sessionStartOf(dir.file('json')), [old, noTimeout, compactEntry]);
});

test('compact_hook: structural inserts follow the file layout', t => {
  const sessionBlock = `"SessionStart": [\n      ${entryText('      ')}\n    ]`;
  const cases = [
    ['hooks absent', '{\n  "model": "opus"\n}\n', `{\n  "model": "opus",\n  "hooks": {\n    ${sessionBlock}\n  }\n}\n`],
    ['hooks empty object', '{\n  "hooks": {},\n  "model": "opus"\n}\n', `{\n  "hooks": {\n    ${sessionBlock}\n  },\n  "model": "opus"\n}\n`],
    ['hooks without SessionStart', '{\n  "hooks": {\n    "Stop": []\n  }\n}\n', `{\n  "hooks": {\n    "Stop": [],\n    ${sessionBlock}\n  }\n}\n`],
    ['empty SessionStart array', '{\n  "hooks": {\n    "SessionStart": []\n  }\n}\n', `{\n  "hooks": {\n    ${sessionBlock}\n  }\n}\n`],
    ['empty object', '{}', `{\n  "hooks": {\n    ${sessionBlock}\n  }\n}`],
  ];
  for (const [name, original, expected] of cases) {
    const dir = temporary(t);
    fs.writeFileSync(dir.file('json'), original);
    const applied = run(hookArgs('apply', dir, ['--confirm']));
    assert.equal(applied.status, 0, `${name}: ${applied.stderr}`);
    assert.equal(fs.readFileSync(dir.file('json'), 'utf8'), expected, name);
    assert.deepEqual(sessionStartOf(dir.file('json')), [compactEntry], name);
  }
});

test('compact_hook: indent, CRLF, BOM and a one-line file are preserved', t => {
  const crlf = temporary(t);
  fs.writeFileSync(crlf.file('json'), '﻿{\r\n    "model": "opus"\r\n}');
  assert.equal(run(hookArgs('apply', crlf, ['--confirm'])).status, 0);
  const crlfText = fs.readFileSync(crlf.file('json'), 'utf8');
  assert.ok(crlfText.startsWith('﻿{\r\n    "model": "opus",\r\n    "hooks": {\r\n        "SessionStart": ['), crlfText);
  assert.ok(!/(?<!\r)\n/.test(crlfText), 'only CRLF line endings');
  assert.ok(crlfText.endsWith('\r\n    }\r\n}'));
  assert.deepEqual(sessionStartOf(crlf.file('json')), [compactEntry]);

  const tabs = temporary(t);
  fs.writeFileSync(tabs.file('json'), '{\n\t"model": "opus"\n}\n');
  assert.equal(run(hookArgs('apply', tabs, ['--confirm'])).status, 0);
  assert.ok(fs.readFileSync(tabs.file('json'), 'utf8').includes('\n\t"hooks": {\n\t\t"SessionStart": [\n\t\t\t{'));

  const inline = temporary(t);
  fs.writeFileSync(inline.file('json'), '{"model": "opus", "hooks": {"Stop": []}}');
  assert.equal(run(hookArgs('apply', inline, ['--confirm'])).status, 0);
  const inlineText = fs.readFileSync(inline.file('json'), 'utf8');
  assert.ok(inlineText.startsWith('{"model": "opus", "hooks": {"Stop": [], "SessionStart": [{'), inlineText);
  assert.ok(!inlineText.includes('\n'));
  assert.deepEqual(sessionStartOf(inline.file('json')), [compactEntry]);
});

test('compact_hook: unusable settings files are reported by plan and never overwritten', t => {
  const cases = [
    ['empty', '', 'APA_HOST_SETTINGS_FILE_EMPTY'],
    ['comment', '{\n  // note\n  "a": 1\n}\n', 'APA_HOST_SETTINGS_HAS_COMMENTS'],
    ['invalid', '{ "a": 1,, }', 'APA_HOST_SETTINGS_INVALID_JSON'],
    ['not an object', '[1]', 'APA_HOST_SETTINGS_NOT_OBJECT'],
    ['hooks not an object', '{ "hooks": [] }', 'APA_HOST_SETTINGS_HOOKS_SHAPE'],
    ['SessionStart not an array', '{ "hooks": { "SessionStart": {} } }', 'APA_HOST_SETTINGS_HOOKS_SHAPE'],
  ];
  for (const [name, content, code] of cases) {
    const dir = temporary(t);
    fs.writeFileSync(dir.file('json'), content);
    const plan = run(hookArgs('plan', dir));
    assert.equal(plan.status, 1, name);
    assert.equal(plan.out.problem.code, code, name);
    assert.equal(plan.out.after, null, name);
    const apply = run(hookArgs('apply', dir, ['--confirm']));
    assert.equal(apply.status, 1, name);
    assert.equal(apply.err.error.code, code, name);
    assert.equal(fs.readFileSync(dir.file('json'), 'utf8'), content, name);
    assert.deepEqual(backupFiles(dir), [], name);
  }
});

test('compact_hook: only Claude Code with the project scope, and it takes no --tokens', t => {
  const dir = temporary(t);
  const withValue = (args, flag, value) => { const copy = [...args]; copy[copy.indexOf(flag) + 1] = value; return copy; };
  assert.equal(run(withValue(hookArgs('plan', dir), '--host', 'codex')).err.error.code, 'APA_HOST_SETTINGS_CAPABILITY_HOST_UNSUPPORTED');
  assert.equal(run(withValue(hookArgs('plan', dir), '--scope', 'user')).err.error.code, 'APA_HOST_SETTINGS_SCOPE_UNSUPPORTED');
  const noScope = hookArgs('plan', dir);
  noScope.splice(noScope.indexOf('--scope'), 2);
  assert.equal(run(noScope).err.error.code, 'APA_HOST_SETTINGS_SCOPE_UNSUPPORTED');
  assert.equal(run([...hookArgs('plan', dir), '--tokens', '200000']).err.error.code, 'APA_HOST_SETTINGS_TOKENS_UNEXPECTED');
  assert.equal(fs.existsSync(dir.file('json')), false);
});
