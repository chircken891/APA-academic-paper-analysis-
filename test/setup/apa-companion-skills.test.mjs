import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const script = join(process.cwd(), 'scripts', 'setup', 'install-apa-companion-skills.ps1');
const python = spawnSync('python', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', windowsHide: true }).stdout.trim();
const names = ['nature-writing', 'nature-polishing', 'nature-shared', 'humanizer', 'humanizer-zh', 'stss'];

async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), 'apa-companion-skills-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = join(root, 'skills with spaces');
  const installer = join(root, 'fake-installer.py');
  const log = join(root, 'calls.jsonl');
  await writeFile(installer, [
    'import argparse, json, os, pathlib, sys',
    'p = argparse.ArgumentParser()',
    'for key in ("repo", "path", "name", "dest"): p.add_argument("--" + key, required=True)',
    'args = p.parse_args()',
    'with open(os.environ["FAKE_LOG"], "a", encoding="utf-8") as f: f.write(json.dumps(vars(args)) + "\\n")',
    'if args.name == os.environ.get("FAKE_FAIL"): sys.exit(7)',
    'target = pathlib.Path(args.dest) / args.name',
    'target.mkdir(parents=True)',
    'if args.name != os.environ.get("FAKE_EMPTY"): (target / "SKILL.md").write_text("installed " + args.name, encoding="utf-8")',
    '(target / "references").mkdir()',
    '(target / "references" / "guide.md").write_text("full directory", encoding="utf-8")',
    '',
  ].join('\n'));
  const run = (env = {}, options = {}) => new Promise((resolve, reject) => {
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-BasePython', python];
    if (options.skills !== null) args.push('-Skills', (options.skills ?? names).join(','));
    if (options.checkOnly) args.push('-CheckOnly');
    if (!options.defaultRoot) args.push('-CompanionSkillRoot', destination);
    args.push('-InstallerPath', options.missingInstaller ? join(root, 'missing.py') : installer);
    const child = spawn(powershell, args, {
      env: { ...process.env, CODEX_HOME: root, FAKE_LOG: log, ...env }, windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, output }));
  });
  const calls = async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { root, destination, run, calls };
}

test('installs all six full companion directories using the official helper interface and preserves local edits on repeat', async t => {
  const h = await harness(t);
  const first = await h.run();
  assert.equal(first.code, 0, first.output);
  const calls = await h.calls();
  assert.deepEqual(calls.map(call => [call.repo, call.path, call.name]), [
    ['Yuan1z0825/nature-skills', 'skills/nature-writing', 'nature-writing'],
    ['Yuan1z0825/nature-skills', 'skills/nature-polishing', 'nature-polishing'],
    ['Yuan1z0825/nature-skills', 'skills/nature-shared', 'nature-shared'],
    ['blader/humanizer', '.', 'humanizer'],
    ['op7418/Humanizer-zh', '.', 'humanizer-zh'],
    ['lennney/stop-that-shit', 'skills/stss', 'stss'],
  ]);
  for (const name of names) {
    assert.equal(await readFile(join(h.destination, name, 'references', 'guide.md'), 'utf8'), 'full directory');
  }
  await writeFile(join(h.destination, 'humanizer', 'SKILL.md'), 'local customization');
  const repeated = await h.run({}, { missingInstaller: true });
  assert.equal(repeated.code, 0, repeated.output);
  assert.equal((await h.calls()).length, 6);
  assert.equal(await readFile(join(h.destination, 'humanizer', 'SKILL.md'), 'utf8'), 'local customization');
});

test('failed download reports its exit code and resumes without repeating completed skills', async t => {
  const h = await harness(t);
  const failed = await h.run({ FAKE_FAIL: 'nature-shared' });
  assert.notEqual(failed.code, 0);
  assert.match(failed.output, /nature-shared \(exit 7\)/);
  assert.deepEqual((await h.calls()).map(call => call.name), names.slice(0, 3));
  const resumed = await h.run();
  assert.equal(resumed.code, 0, resumed.output);
  assert.deepEqual((await h.calls()).slice(3).map(call => call.name), names.slice(2));
});

test('incomplete existing entry is reported before any downloads and retained', async t => {
  const h = await harness(t);
  await mkdir(join(h.destination, 'humanizer'), { recursive: true });
  await writeFile(join(h.destination, 'humanizer', 'notes.txt'), 'preserve');
  const failed = await h.run();
  assert.notEqual(failed.code, 0);
  assert.match(failed.output, /Existing companion skill is incomplete/);
  await assert.rejects(h.calls(), { code: 'ENOENT' });
  assert.equal(await readFile(join(h.destination, 'humanizer', 'notes.txt'), 'utf8'), 'preserve');
});

test('missing helper fails only when downloads are required', async t => {
  const h = await harness(t);
  const failed = await h.run({}, { missingInstaller: true });
  assert.notEqual(failed.code, 0);
  assert.match(failed.output, /Codex skill-installer helper is missing/);
  await assert.rejects(h.calls(), { code: 'ENOENT' });
});

test('success without SKILL.md fails and default destination follows CODEX_HOME', async t => {
  const h = await harness(t);
  const failed = await h.run({ FAKE_EMPTY: 'nature-writing' }, { defaultRoot: true });
  assert.notEqual(failed.code, 0);
  assert.match(failed.output, /success without SKILL.md for nature-writing/);
  assert.equal((await h.calls())[0].dest, join(h.root, 'skills'));
});

test('selection is required and only selected Nature skill plus shared is installed', async t => {
  const h = await harness(t);
  const missing = await h.run({}, { skills: null });
  assert.notEqual(missing.code, 0);
  await assert.rejects(h.calls(), { code: 'ENOENT' });
  const selected = await h.run({}, { skills: ['nature-polishing'] });
  assert.equal(selected.code, 0, selected.output);
  assert.deepEqual((await h.calls()).map(call => call.name), ['nature-polishing', 'nature-shared']);
});

test('companion CheckOnly reports selected targets and missing helper without downloads', async t => {
  const h = await harness(t);
  const result = await h.run({}, { skills: ['nature-writing'], checkOnly: true, missingInstaller: true });
  const report = JSON.parse(result.output.trim());
  assert.equal(report.check_only, true);
  assert.deepEqual(report.targets.map(item => item.name), ['nature-writing', 'nature-shared']);
  assert.equal(report.checks.find(item => item.id === 'installer').status, 'missing');
  await assert.rejects(h.calls(), { code: 'ENOENT' });
});
