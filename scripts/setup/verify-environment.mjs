import { constants } from 'node:fs';
import { access, readFile, statfs } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { verifyApaSkillSync } from './verify-apa-skill-sync.mjs';

import { checkMineruRuntime } from '../lib/mineru-runtime.mjs';
import { inspectV3Graph } from '../v3/obsidian-graph.mjs';
import { evaluatePrerequisites, loadEnvironmentContract, validatePackageContract } from './environment.mjs';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = resolve(dirname(scriptPath), '../..');
const ok = (id, scope, expected, actual) => ({ id, scope, status: 'pass', expected, actual, next_action: null });
const failed = (id, scope, expected, actual, next_action) => ({ id, scope, status: 'fail', expected, actual, next_action });

export function mineruRuntimeCheck(runtime, contract) {
  const expected = 'installed MinerU with local models (version not pinned)';
  return runtime.ok && runtime.package === contract.mineru.package
      && runtime.modelSource === contract.mineru.model_source
    ? ok('mineru_runtime', 'parser', expected, { version: runtime.version, python: runtime.python, model_path: runtime.modelPath })
    : failed('mineru_runtime', 'parser', expected, runtime, 'Select bootstrap -InstallMineru or configure an existing parser through apa-setup before new reading.');
}

export function mineruVersionMatches(output, version) {
  return Boolean(version && String(output).match(/\b\d+\.\d+\.\d+(?:[a-zA-Z0-9.+-]*)?/g)?.includes(version));
}

export function summarizeReadiness(checks, requireObsidian) {
  const coreChecks = checks.filter(check => check.scope === 'core');
  const obsidianChecks = checks.filter(check => check.scope === 'obsidian');
  const core_ready = coreChecks.length > 0 && coreChecks.every(check => check.status === 'pass');
  const obsidian_ready = obsidianChecks.length > 0 && obsidianChecks.every(check => check.status === 'pass');
  const ready = core_ready && obsidian_ready;
  return {
    report: { core_ready, obsidian_ready, ready, checks },
    exitCode: requireObsidian ? (ready ? 0 : 1) : (core_ready ? 0 : 1),
  };
}

async function run(command, args, options = {}) {
  try {
    const isCmd = process.platform === 'win32' && /\.cmd$/i.test(command);
    const executable = isCmd ? (process.env.ComSpec ?? 'cmd.exe') : command;
    const commandArgs = isCmd
      ? ['/d', '/c', command, ...args]
      : args;
    const result = await execFileAsync(executable, commandArgs, { windowsHide: true, timeout: 60000, ...options });
    return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (cause) {
    return { ok: false, stdout: String(cause.stdout ?? '').trim(), stderr: String(cause.stderr ?? cause.message).trim() };
  }
}

export async function resolveGlobalBin({
  override = process.env.APA_GLOBAL_BIN,
  npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm',
  runCommand = run,
} = {}) {
  if (override) return resolve(override);
  const prefix = await runCommand(npmCommand, ['config', 'get', 'prefix']);
  if (!prefix.ok || !prefix.stdout) throw new Error(prefix.stderr || 'npm config get prefix returned no path');
  return resolve(prefix.stdout);
}

export async function pythonSnapshot(contract, {
  repoRoot = defaultRepoRoot,
  platform = process.platform,
  env = process.env,
  runCommand = run,
} = {}) {
  const code = 'import sys; print(sys.executable); print(".".join(map(str, sys.version_info[:3])))';
  const candidates = [];
  if (env.APA_BASE_PYTHON) candidates.push([env.APA_BASE_PYTHON, []]);
  if (platform === 'win32') candidates.push(['py.exe', [`-${contract.python.major}.${contract.python.minor}`]]);
  candidates.push([platform === 'win32' ? 'python.exe' : 'python3', []]);
  candidates.push([platform === 'win32'
    ? join(repoRoot, '.runtime', 'mineru', 'venv', 'Scripts', 'python.exe')
    : join(repoRoot, '.runtime', 'mineru', 'venv', 'bin', 'python'), []]);
  for (const [command, prefix] of candidates) {
    const result = await runCommand(command, [...prefix, '-c', code]);
    if (result.ok) {
      const lines = result.stdout.split(/\r?\n/);
      return { executable: lines.at(-2), version: lines.at(-1) };
    }
  }
  return { executable: null, version: null };
}

export async function obsidianGraphPolicyCheck(repoRoot) {
  const expected = 'current committed V3 generation graph proposal matches Obsidian managed fields';
  try {
    const result = await inspectV3Graph({ vaultRoot: repoRoot });
    return result.ok
      ? ok('obsidian_graph_policy', 'obsidian', expected, result)
      : failed('obsidian_graph_policy', 'obsidian', expected, result, 'Review npm run obsidian:graph:proposal and explicitly approve any Obsidian configuration change.');
  } catch (cause) {
    return failed('obsidian_graph_policy', 'obsidian', expected, { code: cause.code, message: cause.message, details: cause.details },
      'A valid committed V3 generation and matching graph configuration are required; no legacy fallback is used.');
  }
}

export async function canonicalNavigationBoundaryCheck(repoRoot) {
  const expected = 'V3 navigation reads the committed generation';
  const files = ['Views/indexes/apa-sources.md', 'Views/graph/apa-only.md'];
  const differences = [];
  for (const path of files) {
    try {
      const content = await readFile(join(repoRoot, ...path.split('/')), 'utf8');
      if (!content.includes('.apa-v3/phase22/COMMITTED.json') || !content.includes('generation') || content.includes('graph_scope:v2-canonical')) {
        differences.push({ path, reason: 'committed V3 navigation boundary missing' });
      }
    } catch (cause) { differences.push({ path, reason: cause.message }); }
  }
  return differences.length === 0
    ? ok('canonical_navigation_boundary', 'obsidian', expected, { files })
    : failed('canonical_navigation_boundary', 'obsidian', expected, differences, 'Restore the V3 committed-generation navigation views.');
}

export async function apaSkillCheck(repoRoot, globalSkill) {
  const expected = 'global APA skill matches the repository installation projection with resolvable repository references';
  try {
    const result = await verifyApaSkillSync({ repoRoot, deployedRoot: globalSkill });
    return ok('apa_skill', 'integration', expected, result);
  } catch (cause) {
    return failed('apa_skill', 'integration', expected, cause.message, 'Optional: select bootstrap -InstallGlobalIntegration; use -RepairGlobalIntegration after reviewing an existing global skill.');
  }
}

async function collectCoreChecks(repoRoot, contract) {
  const checks = [];
  let packageJson;
  try {
    packageJson = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
    const errors = validatePackageContract(packageJson, contract);
    checks.push(errors.length === 0
      ? ok('environment_contract', 'core', 'valid central contract and matching package metadata', 'valid')
      : failed('environment_contract', 'core', 'valid central contract and matching package metadata', errors, 'Update config/environment.json first, then synchronize package metadata.'));
  } catch (cause) {
    checks.push(failed('environment_contract', 'core', 'readable central contract and package metadata', cause.message, 'Restore config/environment.json and package.json from the repository.'));
  }

  const [git, npm, python, filesystem] = await Promise.all([
    run('git', ['--version']),
    run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version']),
    pythonSnapshot(contract, { repoRoot }),
    statfs(repoRoot),
  ]);
  const snapshot = {
    repositoryRootValid: Boolean(packageJson),
    platform: process.platform,
    arch: process.arch,
    gitVersion: git.ok ? git.stdout : null,
    nodeVersion: process.version,
    npmVersion: npm.ok ? npm.stdout : null,
    pythonVersion: python.version,
    freeBytes: Number(filesystem.bavail) * Number(filesystem.bsize),
  };
  checks.push(...evaluatePrerequisites(snapshot, contract).map(check => ({ ...check, scope: ['python', 'disk_space'].includes(check.id) ? 'parser' : 'core' })));

  const dependencies = await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ls', '--depth=0', '--ignore-scripts'], { cwd: repoRoot });
  checks.push(dependencies.ok
    ? ok('node_dependencies', 'core', 'package-lock dependency tree installed', 'ready')
    : failed('node_dependencies', 'core', 'package-lock dependency tree installed', dependencies.stderr, 'Run npm ci from the repository root.'));

  const runtime = await checkMineruRuntime({ vaultRoot: repoRoot });
  checks.push(mineruRuntimeCheck(runtime, contract));

  const globalSkill = resolve(process.env.APA_GLOBAL_SKILL ?? join(homedir(), '.agents', 'skills', 'academic-paper-analysis'));
  checks.push(await apaSkillCheck(repoRoot, globalSkill));

  let globalBin;
  try {
    globalBin = await resolveGlobalBin();
  } catch (cause) {
    checks.push(failed('global_mineru', 'integration', 'global mineru command matches the local runtime', cause.message, 'Optional: fix npm config get prefix, then select bootstrap -InstallGlobalIntegration.'));
  }
  if (globalBin) {
    const mineruCommand = process.platform === 'win32' ? join(globalBin, 'mineru.cmd') : join(globalBin, 'mineru');
    const mineruVersion = await run(mineruCommand, ['version', '--json']);
    checks.push(mineruVersion.ok && mineruVersionMatches(mineruVersion.stdout, runtime.version)
      ? ok('global_mineru', 'integration', `global mineru command reports ${runtime.version}`, mineruVersion.stdout)
      : failed('global_mineru', 'integration', 'global mineru command matches the local runtime', mineruVersion.stderr || mineruVersion.stdout, 'Optional: select bootstrap -InstallGlobalIntegration to install or repair the user npm launcher.'));
  }

  return checks;
}

async function collectObsidianChecks(repoRoot, contract) {
  const checks = [];
  const appCandidates = process.platform === 'win32' && process.env.LOCALAPPDATA
    ? [
      join(process.env.LOCALAPPDATA, 'Programs', 'Obsidian', 'Obsidian.exe'),
      join(process.env.LOCALAPPDATA, 'Obsidian', 'Obsidian.exe'),
      join(process.env.ProgramFiles ?? '', 'Obsidian', 'Obsidian.exe'),
    ]
    : [];
  let appReady = false;
  let appPath = appCandidates[0] ?? null;
  for (const candidate of appCandidates) {
    try {
      await access(candidate, constants.X_OK);
      appReady = true;
      appPath = candidate;
      break;
    } catch { /* Continue through known per-user and system locations. */ }
  }
  checks.push(appReady
    ? ok('obsidian_app', 'obsidian', 'Obsidian desktop installed', appPath)
    : failed('obsidian_app', 'obsidian', 'Obsidian desktop installed', appPath, 'Install Obsidian manually, then reopen this vault.'));

  let enabled = [];
  try {
    const parsed = JSON.parse(await readFile(join(repoRoot, '.obsidian', 'community-plugins.json'), 'utf8'));
    if (Array.isArray(parsed)) enabled = parsed;
  } catch { /* Each plugin reports not ready. */ }
  for (const plugin of contract.obsidian.plugins) {
    const pluginRoot = join(repoRoot, '.obsidian', 'plugins', plugin.id);
    let installed = false;
    try {
      await Promise.all([
        access(join(pluginRoot, 'manifest.json'), constants.R_OK),
        access(join(pluginRoot, 'main.js'), constants.R_OK),
      ]);
      installed = true;
    } catch { /* Report below. */ }
    const ready = installed && enabled.includes(plugin.id);
    checks.push(ready
      ? ok(`obsidian_plugin:${plugin.id}`, 'obsidian', `${plugin.name} installed and enabled`, pluginRoot)
      : failed(`obsidian_plugin:${plugin.id}`, 'obsidian', `${plugin.name} installed and enabled`, { installed, enabled: enabled.includes(plugin.id) }, `Install and enable ${plugin.name} in Obsidian Community plugins.`));
  }
  checks.push(await obsidianGraphPolicyCheck(repoRoot));
  checks.push(await canonicalNavigationBoundaryCheck(repoRoot));
  return checks;
}

export async function verifyEnvironment({ repoRoot = defaultRepoRoot, requireObsidian = false } = {}) {
  const contract = await loadEnvironmentContract({ repoRoot });
  const checks = [
    ...await collectCoreChecks(repoRoot, contract),
    ...await collectObsidianChecks(repoRoot, contract),
  ];
  return summarizeReadiness(checks, requireObsidian);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--require-obsidian') || args.filter(arg => arg === '--require-obsidian').length > 1) {
    const checks = [failed('arguments', 'core', 'optional --require-obsidian', args, 'Use npm run setup:check or npm run setup:check:full.')];
    const { report } = summarizeReadiness(checks, false);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    const { report, exitCode } = await verifyEnvironment({ requireObsidian: args.includes('--require-obsidian') });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = exitCode;
  } catch (cause) {
    const checks = [failed('environment_contract', 'core', 'readable environment contract', cause.message, 'Restore config/environment.json from the repository.')];
    const { report } = summarizeReadiness(checks, false);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) await main();
