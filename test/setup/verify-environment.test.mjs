import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  canonicalNavigationBoundaryCheck,
  obsidianGraphPolicyCheck,
  pythonSnapshot,
  resolveGlobalBin,
  summarizeReadiness,
  mineruRuntimeCheck,
  mineruVersionMatches,
} from '../../scripts/setup/verify-environment.mjs';
const committedBoundary = '.apa-v3/phase22/COMMITTED.json generation';

const roots = [];

test('MinerU readiness accepts installed upgrades and retains runtime failures', () => {
  const contract = { mineru: { package: 'mineru', model_source: 'modelscope' } };
  const runtime = { ok: true, version: '4.1.0', package: 'mineru', modelSource: 'modelscope', python: 'python', modelPath: 'models' };
  assert.equal(mineruRuntimeCheck(runtime, contract).status, 'pass');
  assert.equal(mineruRuntimeCheck({ ...runtime, ok: false }, contract).status, 'fail');
  assert.equal(mineruRuntimeCheck({ ...runtime, modelSource: 'huggingface' }, contract).status, 'fail');
  assert.equal(mineruVersionMatches('mineru, version 4.1.0', '4.1.0'), true);
  assert.equal(mineruVersionMatches('mineru, version 4.1.01', '4.1.0'), false);
  assert.equal(mineruVersionMatches('mineru, version 4.0.12', '4.1.0'), false);
});

test.afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function graphVault(graph) {
  const root = await mkdtemp(join(tmpdir(), 'verify-environment-graph-'));
  roots.push(root);
  await mkdir(join(root, '.obsidian'));
  await writeFile(join(root, '.obsidian', 'graph.json'), `${JSON.stringify(graph, null, 2)}\n`, 'utf8');
  return root;
}

async function navigationVault(where = committedBoundary) {
  const root = await mkdtemp(join(tmpdir(), 'verify-environment-navigation-'));
  roots.push(root);
  await mkdir(join(root, 'Views', 'indexes'), { recursive: true });
  await mkdir(join(root, 'Views', 'graph'), { recursive: true });
  await writeFile(join(root, 'Views', 'indexes', 'apa-sources.md'), where);
  await writeFile(join(root, 'Views', 'graph', 'apa-only.md'), where);
  await writeFile(join(root, '欢迎.md'), `${where}\n${where}\n`);
  return root;
}

test('readiness separates core command-line state from full Obsidian state', () => {
  const checks = [
    { id: 'environment_contract', scope: 'core', status: 'pass' },
    { id: 'mineru_runtime', scope: 'core', status: 'pass' },
    { id: 'obsidian_app', scope: 'obsidian', status: 'fail' },
  ];

  assert.deepEqual(summarizeReadiness(checks, false), {
    report: { core_ready: true, obsidian_ready: false, ready: false, checks },
    exitCode: 0,
  });
  assert.equal(summarizeReadiness(checks, true).exitCode, 1);
});

test('readiness never reports a subsystem ready when none of its checks ran', () => {
  const result = summarizeReadiness([
    { id: 'environment_contract', scope: 'core', status: 'fail' },
  ], false);

  assert.equal(result.report.core_ready, false);
  assert.equal(result.report.obsidian_ready, false);
  assert.equal(result.report.ready, false);
});

test('missing parser and optional global integration remain failures without blocking core', () => {
  const contract = { mineru: { package: 'mineru', model_source: 'modelscope' } };
  const parser = mineruRuntimeCheck({ ok: false }, contract);
  assert.equal(parser.scope, 'parser');
  assert.equal(parser.status, 'fail');
  const result = summarizeReadiness([{ id: 'base', scope: 'core', status: 'pass' }, parser, { id: 'global', scope: 'integration', status: 'fail' }], false);
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.core_ready, true);
});

test('global npm bin uses npm config when no explicit override is supplied', async () => {
  const customPrefix = join(process.cwd(), '临时 profile', 'npm prefix');
  const resolved = await resolveGlobalBin({
    override: '',
    npmCommand: 'npm.cmd',
    runCommand: async (command, args) => {
      assert.equal(command, 'npm.cmd');
      assert.deepEqual(args, ['config', 'get', 'prefix']);
      return { ok: true, stdout: customPrefix, stderr: '' };
    },
  });

  assert.equal(resolved, customPrefix);
});

test('Obsidian graph policy never accepts a legacy configuration without a committed generation', async () => {
  const root = await graphVault({ search: 'path:Wiki [graph_scope:v2-canonical]', hideUnresolved: true, showOrphans: true });
  const result = await obsidianGraphPolicyCheck(root);
  assert.equal(result.status, 'fail');
  assert.equal(result.actual.code, 'P22_DEFAULT_COMMITTED_REQUIRED');
});

test('canonical navigation check rejects a Dataview boundary that drifts from the graph contract', async () => {
  const compliant = await navigationVault();
  const stale = await navigationVault('WHERE type = "paper" AND startswith(string(pipeline_version), "2.")');

  assert.equal((await canonicalNavigationBoundaryCheck(compliant)).status, 'pass');
  const result = await canonicalNavigationBoundaryCheck(stale);
  assert.equal(result.id, 'canonical_navigation_boundary');
  assert.equal(result.scope, 'obsidian');
  assert.equal(result.status, 'fail');
  assert.deepEqual(result.actual.map(item => item.path), [
    'Views/indexes/apa-sources.md',
    'Views/graph/apa-only.md',
  ]);
});

test('Python detection falls back to the repository-local MinerU runtime', async () => {
  const repoRoot = join(process.cwd(), 'C盘 新知识库');
  const localPython = join(repoRoot, '.runtime', 'mineru', 'venv', 'Scripts', 'python.exe');
  const attempted = [];
  const snapshot = await pythonSnapshot({ python: { major: 3, minor: 12 } }, {
    repoRoot,
    platform: 'win32',
    env: {},
    runCommand: async command => {
      attempted.push(command);
      return command === localPython
        ? { ok: true, stdout: `${localPython}\n3.12.13`, stderr: '' }
        : { ok: false, stdout: '', stderr: 'missing' };
    },
  });

  assert.equal(attempted.at(-1), localPython);
  assert.deepEqual(snapshot, { executable: localPython, version: '3.12.13' });
});

test('verifier CLI emits only stable JSON even when setup is incomplete', async () => {
  const script = join(process.cwd(), 'scripts', 'setup', 'verify-environment.mjs');
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
  const report = JSON.parse(result.stdout);

  assert.equal(result.stderr, '');
  assert.deepEqual(Object.keys(report), ['core_ready', 'obsidian_ready', 'ready', 'checks']);
  assert.equal(Array.isArray(report.checks), true);
  assert(report.checks.every(check => ['pass', 'fail'].includes(check.status)));
  for (const id of ['python', 'disk_space']) assert.equal(report.checks.find(check => check.id === id).scope, 'parser');
  assert.equal(result.code, report.core_ready ? 0 : 1);
});
