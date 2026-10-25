import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fail = (id, expected, actual, next_action) => ({ id, status: 'fail', expected, actual, next_action });
const pass = (id, expected, actual) => ({ id, status: 'pass', expected, actual, next_action: null });
const major = version => Number.parseInt(String(version ?? '').replace(/^v/, '').split('.')[0], 10);
const majorMinor = version => String(version ?? '').replace(/^Python\s+/i, '').replace(/^v/, '').split('.').slice(0, 2).map(Number);

function validateContract(contract) {
  const pluginIds = contract?.obsidian?.plugins?.map(plugin => plugin.id);
  const valid = contract?.schema_version === 1
    && contract?.platform?.os === 'windows'
    && contract?.platform?.arch === 'x64'
    && Number.isInteger(contract?.node?.major)
    && contract?.node?.channel === 'LTS'
    && Number.isInteger(contract?.npm?.major)
    && Number.isInteger(contract?.python?.major)
    && Number.isInteger(contract?.python?.minor)
    && contract?.mineru?.update_policy === 'latest-stable'
    && contract?.mineru?.version === undefined
    && contract?.mineru?.package === 'mineru'
    && contract?.mineru?.model_source === 'modelscope'
    && Number.isInteger(contract?.disk?.recommended_free_gib)
    && contract.disk.recommended_free_gib > 0
    && Array.isArray(pluginIds)
    && pluginIds.length === 4
    && new Set(pluginIds).size === pluginIds.length;
  if (!valid) throw new Error('config/environment.json does not satisfy the v2.2 environment contract.');
  return contract;
}

export async function loadEnvironmentContract({ repoRoot = defaultRepoRoot } = {}) {
  const path = join(resolve(repoRoot), 'config', 'environment.json');
  return validateContract(JSON.parse(await readFile(path, 'utf8')));
}

export function validatePackageContract(packageJson, contract) {
  const errors = [];
  const expectedNode = `>=${contract.node.major} <${contract.node.major + 1}`;
  const expectedPackageManager = `npm@${contract.npm.major}`;
  if (packageJson?.engines?.node !== expectedNode) errors.push(`package.json engines.node must be ${expectedNode}`);
  if (packageJson?.packageManager !== expectedPackageManager) errors.push(`package.json packageManager must be ${expectedPackageManager}`);
  if (packageJson?.scripts?.['setup:windows'] !== 'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup/bootstrap-windows.ps1') {
    errors.push('package.json setup:windows must invoke the canonical bootstrap entry.');
  }
  if (packageJson?.scripts?.['setup:check'] !== 'node scripts/setup/verify-environment.mjs') {
    errors.push('package.json setup:check must invoke the core verifier.');
  }
  if (packageJson?.scripts?.['setup:check:full'] !== 'node scripts/setup/verify-environment.mjs --require-obsidian') {
    errors.push('package.json setup:check:full must invoke the full verifier.');
  }
  return errors;
}

export function evaluatePrerequisites(snapshot, contract) {
  const diskReserve = contract.disk.recommended_free_gib * 1024 ** 3;
  const [pythonMajor, pythonMinor] = majorMinor(snapshot.pythonVersion);
  return [
    snapshot.repositoryRootValid
      ? pass('repository_root', 'repository root containing package.json and config/environment.json', true)
      : fail('repository_root', 'repository root containing package.json and config/environment.json', false, 'Run bootstrap-windows.ps1 from a complete repository clone.'),
    snapshot.platform === 'win32' && snapshot.arch === contract.platform.arch
      ? pass('platform', 'Windows x64', `${snapshot.platform}/${snapshot.arch}`)
      : fail('platform', 'Windows x64', `${snapshot.platform}/${snapshot.arch}`, 'Use a Windows x64 host; WSL2 and other platforms are not supported by this environment contract.'),
    snapshot.gitVersion
      ? pass('git', 'Git available', snapshot.gitVersion)
      : fail('git', 'Git available', null, 'Install Git for Windows and reopen the terminal.'),
    major(snapshot.nodeVersion) === contract.node.major
      ? pass('node', `Node ${contract.node.major}.x ${contract.node.channel}`, snapshot.nodeVersion)
      : fail('node', `Node ${contract.node.major}.x ${contract.node.channel}`, snapshot.nodeVersion, 'Install the Node major declared in config/environment.json.'),
    major(snapshot.npmVersion) === contract.npm.major
      ? pass('npm', `npm ${contract.npm.major}.x`, snapshot.npmVersion)
      : fail('npm', `npm ${contract.npm.major}.x`, snapshot.npmVersion, 'Install the npm major declared in config/environment.json.'),
    pythonMajor === contract.python.major && pythonMinor === contract.python.minor
      ? pass('python', `Python ${contract.python.major}.${contract.python.minor}.x`, snapshot.pythonVersion)
      : fail('python', `Python ${contract.python.major}.${contract.python.minor}.x`, snapshot.pythonVersion, 'Install the Python major/minor declared in config/environment.json.'),
    Number.isFinite(snapshot.freeBytes) && snapshot.freeBytes >= diskReserve
      ? pass('disk_space', `${contract.disk.recommended_free_gib} GiB recommended reserve for a new MinerU installation`, snapshot.freeBytes)
      : { ...fail('disk_space', `${contract.disk.recommended_free_gib} GiB recommended reserve for a new MinerU installation`, snapshot.freeBytes,
        'Review space for the selected runtime, models, download caches and outputs; this reserve is not a minimum requirement or a measured installation size.'), status: 'warn' },
  ];
}
