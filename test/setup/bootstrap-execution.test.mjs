import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const sourceBootstrap = join(process.cwd(), 'scripts', 'setup', 'bootstrap-windows.ps1');
const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

async function createHarness(t, { recommendedFreeGib = 0 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'apa-bootstrap-execution-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repoRoot = join(root, 'C盘 新知识库');
  const shimRoot = join(root, 'shims');
  const npmPrefix = join(root, '用户 profile', 'npm bin');
  await mkdir(join(repoRoot, 'scripts', 'setup'), { recursive: true });
  await mkdir(join(repoRoot, 'scripts', 'setup'), { recursive: true });
  await mkdir(join(repoRoot, 'config'), { recursive: true });
  await mkdir(shimRoot, { recursive: true });
  await mkdir(npmPrefix, { recursive: true });
  await copyFile(sourceBootstrap, join(repoRoot, 'scripts', 'setup', 'bootstrap-windows.ps1'));
  await writeFile(join(repoRoot, 'config', 'environment.json'), JSON.stringify({
    platform: { os: 'windows', arch: 'x64' },
    node: { major: 24, channel: 'LTS' },
    npm: { major: 11 },
    python: { major: 3, minor: 12 },
    mineru: { update_policy: 'latest-stable', package: 'mineru', model_source: 'modelscope' },
    disk: { recommended_free_gib: recommendedFreeGib },
  }), 'utf8');
  await writeFile(join(repoRoot, 'package.json'), '{"name":"bootstrap-harness","version":"1.0.0"}\n', 'utf8');
  await writeFile(join(repoRoot, 'package-lock.json'), '{"lockfileVersion":3}\n', 'utf8');

  await writeFile(join(shimRoot, 'node.cmd'), [
    '@echo off',
    'if "%1"=="-p" echo x64& exit /b 0',
    'if "%1"=="--version" echo %FAKE_NODE_VERSION%& exit /b 0',
    'exit /b 1',
    '',
  ].join('\r\n'), 'ascii');
  await writeFile(join(shimRoot, 'npm.cmd'), [
    '@echo off',
    'if "%1"=="--version" echo 11.0.0& exit /b 0',
    'if "%1"=="config" if "%2"=="get" if "%3"=="prefix" echo %FAKE_NPM_PREFIX%& exit /b 0',
    'if "%1"=="ci" goto ci',
    'if "%1"=="ls" exit /b 0',
    'if "%1"=="run" if "%2"=="setup:check" goto check',
    'exit /b 1',
    ':ci',
    'if not exist node_modules mkdir node_modules',
    'if not exist .runtime\\test mkdir .runtime\\test',
    'echo ci>>.runtime\\test\\npm-ci.log',
    'exit /b 0',
    ':check',
    'if "%FAKE_REQUIRE_MINERU%"=="1" if not exist .runtime\\mineru\\complete.marker exit /b 9',
    'exit /b 0',
    '',
  ].join('\r\n'), 'ascii');
  await writeFile(join(shimRoot, 'git.cmd'), '@echo off\r\necho git version 2.0.0\r\n', 'ascii');
  const python = join(shimRoot, 'python.cmd');
  await writeFile(python, '@echo off\r\necho 3.12.8\r\n', 'ascii');

  await writeFile(join(repoRoot, 'scripts', 'setup', 'setup-mineru.ps1'), [
    'param([string]$BasePython, [string]$VaultRoot, [string]$ModelSource)',
    "$runtimeRoot = Join-Path $VaultRoot '.runtime\\mineru'",
    'New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null',
    "$attemptLog = Join-Path $runtimeRoot 'model-attempt.log'",
    "$complete = Join-Path $runtimeRoot 'complete.marker'",
    'if (-not (Test-Path -LiteralPath $complete -PathType Leaf)) {',
    "  [System.IO.File]::AppendAllText($attemptLog, \"attempt`n\")",
    "  if ($env:FAKE_INTERRUPT_ONCE -eq '1' -and -not (Test-Path -LiteralPath (Join-Path $runtimeRoot 'interrupted.marker'))) {",
    "    [System.IO.File]::WriteAllText((Join-Path $runtimeRoot 'partial.cache'), 'retained')",
    "    [System.IO.File]::WriteAllText((Join-Path $runtimeRoot 'interrupted.marker'), '1')",
    "    throw 'simulated model network interruption'",
    '  }',
    "  [System.IO.File]::WriteAllText($complete, 'ready')",
    '}',
    '',
  ].join('\r\n'), 'utf8');
  await writeFile(join(repoRoot, 'scripts', 'setup', 'install-global-integrations.ps1'), [
    'param([string]$RepoRoot, [string]$GlobalSkillRoot, [string]$GlobalBinRoot, [switch]$RepairGlobalIntegration)',
    "New-Item -ItemType Directory -Path (Join-Path $RepoRoot '.runtime\\test') -Force | Out-Null",
    "[System.IO.File]::WriteAllText((Join-Path $RepoRoot '.runtime\\test\\global-bin.txt'), $GlobalBinRoot)",
    '',
  ].join('\r\n'), 'utf8');
  await writeFile(join(repoRoot, 'scripts', 'setup', 'install-apa-companion-skills.ps1'), [
    'param([string]$BasePython, [string]$CompanionSkillRoot, [string[]]$Skills)',
    "[System.IO.File]::WriteAllText((Join-Path $CompanionSkillRoot 'bootstrap-python.txt'), $BasePython)",
    '',
  ].join('\r\n'), 'utf8');
  return { root, repoRoot, shimRoot, npmPrefix, python };
}

function runBootstrap(harness, extraEnv = {}, selection = ['-InstallMineru', '-InstallGlobalIntegration', '-CompanionSkills', 'humanizer']) {
  const script = harness.wrapper ?? join(harness.repoRoot, 'scripts', 'setup', 'bootstrap-windows.ps1');
  return new Promise((resolve, reject) => {
    const child = spawn(powershell, [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-RepoRoot', harness.repoRoot,
      '-BasePython', harness.python,
      '-CompanionSkillRoot', harness.root,
      '-GlobalSkillRoot', join(harness.root, '用户 profile', '.agents', 'skills', 'academic-paper-analysis'),
      ...selection,
    ], {
      env: {
        ...process.env,
        PATH: harness.shimRoot,
        FAKE_NODE_VERSION: 'v24.0.0',
        FAKE_NPM_PREFIX: harness.npmPrefix,
        ...extraEnv,
      },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('bootstrap resumes an interrupted Unicode-path install and the third run is a no-op', async t => {
  const harness = await createHarness(t);
  const interrupted = await runBootstrap(harness, { FAKE_INTERRUPT_ONCE: '1' });
  assert.notEqual(interrupted.code, 0);
  assert.match(`${interrupted.stdout}\n${interrupted.stderr}`, /simulated model network interruption/i);
  assert.equal(await readFile(join(harness.repoRoot, '.runtime', 'mineru', 'partial.cache'), 'utf8'), 'retained');

  const resumed = await runBootstrap(harness, { FAKE_INTERRUPT_ONCE: '1' });
  assert.equal(resumed.code, 0, `${resumed.stdout}\n${resumed.stderr}`);
  assert.equal(await readFile(join(harness.repoRoot, '.runtime', 'test', 'global-bin.txt'), 'utf8'), harness.npmPrefix);
  assert.equal(await readFile(join(harness.root, 'bootstrap-python.txt'), 'utf8'), harness.python);

  const repeated = await runBootstrap(harness, { FAKE_INTERRUPT_ONCE: '1' });
  assert.equal(repeated.code, 0, `${repeated.stdout}\n${repeated.stderr}`);
  assert.match(repeated.stdout, /Node dependencies no-op/i);
  assert.equal((await readFile(join(harness.repoRoot, '.runtime', 'test', 'npm-ci.log'), 'utf8')).trim().split(/\r?\n/).length, 1);
  assert.equal((await readFile(join(harness.repoRoot, '.runtime', 'mineru', 'model-attempt.log'), 'utf8')).trim().split(/\r?\n/).length, 2);
});

test('bootstrap default installs only base dependencies without invoking optional installers', async t => {
  const harness = await createHarness(t);
  const result = await runBootstrap(harness, {}, []);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal((await readFile(join(harness.repoRoot, '.runtime', 'test', 'npm-ci.log'), 'utf8')).trim(), 'ci');
  for (const target of [join(harness.repoRoot, '.runtime', 'mineru', 'model-attempt.log'), join(harness.repoRoot, '.runtime', 'test', 'global-bin.txt'), join(harness.root, 'bootstrap-python.txt')]) await assert.rejects(readFile(target), { code: 'ENOENT' });
});

test('base-only setup reports optional Python and MinerU disk gaps without blocking Node dependency install', async t => {
  const harness = await createHarness(t, { recommendedFreeGib: 9_000_000 });
  harness.python = join(harness.root, 'missing-python.exe');
  const result = await runBootstrap(harness, {}, []);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout.trim().split(/\r?\n/)[0]);
  assert.equal(report.prerequisites_ready, true);
  for (const id of ['python', 'disk_space']) {
    assert.equal(report.checks.find(item => item.id === id).status, id === 'disk_space' ? 'warning' : 'missing');
    assert.equal(report.checks.find(item => item.id === id).required, false);
  }
  assert.deepEqual(report.prerequisite_actions, []);
  assert.equal((await readFile(join(harness.repoRoot, '.runtime/test/npm-ci.log'), 'utf8')).trim(), 'ci');
  await assert.rejects(readFile(join(harness.repoRoot, '.runtime/test/global-bin.txt')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(harness.root, 'bootstrap-python.txt')), { code: 'ENOENT' });
});

test('CheckOnly reports all prerequisites and selected targets without installation even when Node is missing', async t => {
  const harness = await createHarness(t);
  await unlink(join(harness.shimRoot, 'node.cmd'));
  const result = await runBootstrap(harness, {}, ['-CheckOnly', '-InstallMineru', '-InstallGlobalIntegration', '-CompanionSkills', 'nature-writing']);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.check_only, true);
  for (const id of ['platform', 'git', 'node', 'npm', 'python', 'disk_space', 'node_dependencies']) assert.ok(report.checks.some(item => item.id === id), id);
  assert.equal(report.checks.find(item => item.id === 'node').status, 'missing');
  assert.ok(report.targets.some(item => item.id === 'mineru' && item.selected));
  assert.ok(report.next_commands.length > 0);
  await assert.rejects(readFile(join(harness.repoRoot, '.runtime', 'test', 'npm-ci.log')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(harness.repoRoot, '.runtime', 'test', 'global-bin.txt')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(harness.root, 'bootstrap-python.txt')), { code: 'ENOENT' });
});

test('CheckOnly retains native Python launcher stderr and continues all remaining checks', async t => {
  const harness = await createHarness(t);
  const failedLauncher = join(harness.root, 'failed-python.cmd');
  await writeFile(failedLauncher, '@echo off\r\necho No installed Python found! 1>&2\r\nexit /b 103\r\n', 'ascii');
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  harness.wrapper = join(harness.root, 'probe-wrapper.ps1');
  await writeFile(harness.wrapper, `\uFEFFfunction global:py.exe { & ${quote(failedLauncher)} @args }\n& ${quote(join(harness.repoRoot, 'scripts/setup/bootstrap-windows.ps1'))} -RepoRoot ${quote(harness.repoRoot)} -CheckOnly\n`, 'utf8');
  const result = await runBootstrap(harness, {}, ['-CheckOnly']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^\s*\{/, result.stderr);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.checks.find(item => item.id === 'python').status, 'missing');
  assert.ok(report.checks.some(item => item.id === 'disk_space'));
  assert.match(JSON.stringify(report.diagnostics), /No installed Python found!/);
  await assert.rejects(readFile(join(harness.repoRoot, '.runtime/test/npm-ci.log')), { code: 'ENOENT' });
});

test('bootstrap prerequisite failure performs no dependency or runtime writes', async t => {
  const harness = await createHarness(t);
  const failed = await runBootstrap(harness, { FAKE_NODE_VERSION: 'v23.9.0' });
  assert.notEqual(failed.code, 0);
  assert.match(`${failed.stdout}\n${failed.stderr}`, /expected 24\.x/i);
  await assert.rejects(readFile(join(harness.repoRoot, '.runtime', 'test', 'npm-ci.log')));
  await assert.rejects(readFile(join(harness.repoRoot, '.runtime', 'mineru', 'partial.cache')));

  await unlink(join(harness.shimRoot, 'git.cmd'));
  const missingGit = await runBootstrap(harness);
  assert.notEqual(missingGit.code, 0);
  assert.match(`${missingGit.stdout}\n${missingGit.stderr}`, /install Git for Windows/i);
});

test('MinerU disk reserve is advisory and CheckOnly never installs when below it', async t => {
  const harness = await createHarness(t, { recommendedFreeGib: 9_000_000 });
  const checked = await runBootstrap(harness, {}, ['-CheckOnly', '-InstallMineru']);
  assert.equal(checked.code, 0, checked.stderr);
  const report = JSON.parse(checked.stdout.trim());
  const disk = report.checks.find(item => item.id === 'disk_space');
  assert.equal(disk.status, 'warning');
  assert.equal(disk.required, false);
  assert.equal(disk.recommended_free_gib, 9_000_000);
  assert.equal(report.prerequisites_ready, true);
  await assert.rejects(readFile(join(harness.repoRoot, '.runtime', 'test', 'npm-ci.log')));
  const installed = await runBootstrap(harness, {}, ['-InstallMineru']);
  assert.equal(installed.code, 0, installed.stderr);
  assert.equal((await readFile(join(harness.repoRoot, '.runtime', 'mineru', 'complete.marker'), 'utf8')), 'ready');
});
