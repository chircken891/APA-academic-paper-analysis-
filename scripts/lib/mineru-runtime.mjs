import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const execFileAsync = promisify(execFile);
const VERSION_TOKEN = /\b\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?\b/g;

function observableVersion(output, source) {
  const versions = String(output ?? '').match(VERSION_TOKEN) ?? [];
  if (versions.length !== 1) throw new Error(`${source} version output is not uniquely observable.`);
  return versions[0];
}

export function mineruPythonCandidates(vaultRoot) {
  return process.platform === 'win32'
    ? [
      join(vaultRoot, '.runtime', 'mineru', 'venv', 'Scripts', 'python.exe'),
      join(vaultRoot, '.venv', 'Scripts', 'python.exe'),
      join(vaultRoot, 'venv', 'Scripts', 'python.exe'),
    ]
    : [
      join(vaultRoot, '.runtime', 'mineru', 'venv', 'bin', 'python'),
      join(vaultRoot, '.venv', 'bin', 'python'),
      join(vaultRoot, 'venv', 'bin', 'python'),
    ];
}

export function mineruModelRoot(configPath) {
  return resolve(dirname(configPath), 'models');
}

export async function mineruPackageVersion({ python, execute = execFileAsync } = {}) {
  if (typeof python !== 'string' || !python.trim()) {
    throw new Error('MinerU package version requires the selected Python runtime.');
  }
  try {
    const { stdout } = await execute(python, ['-c', 'import importlib.metadata; import mineru; print(importlib.metadata.version("mineru"))'], {
      windowsHide: true,
      timeout: 30000,
    });
    return observableVersion(stdout, 'MinerU package');
  } catch (cause) {
    throw new Error(`MinerU package version is unavailable from the selected Python runtime: ${String(cause.stderr ?? cause.message).trim()}`);
  }
}

export async function mineruExecutableVersion({ executable, execute = execFileAsync } = {}) {
  if (typeof executable !== 'string' || !executable.trim()) {
    throw new Error('MinerU executable version requires the selected executable.');
  }
  try {
    const { stdout } = await execute(executable, ['version', '--json'], {
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 4096,
    });
    const version = JSON.parse(stdout).mineru_version;
    if (typeof version !== 'string' || observableVersion(version, 'MinerU executable') !== version) {
      throw new Error('MinerU executable version output is not uniquely observable.');
    }
    return version;
  } catch (cause) {
    throw new Error(`MinerU executable version is unavailable from the selected executable: ${String(cause.stderr ?? cause.message).trim()}`);
  }
}

const EFFECTIVE_CONFIG_SCRIPT = [
  'import json',
  'from mineru.config import config, get_config_file_path, get_config_file_exists',
  'print(json.dumps({"config_path": get_config_file_path(), "exists": get_config_file_exists(), "model": config.model.model_dump(mode="json")}))',
].join('; ');

export async function checkMineruRuntime({ vaultRoot, python = process.env.MINERU_PYTHON, runtimeHome: selectedRuntimeHome, configPath: selectedConfigPath, execute = execFileAsync } = {}) {
  const root = resolve(vaultRoot);
  const candidates = python ? [resolve(python)] : selectedRuntimeHome
    ? [join(resolve(selectedRuntimeHome), 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')]
    : mineruPythonCandidates(root);
  let selected;
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      selected = candidate;
      break;
    } catch {
      // Continue through the explicit local candidates.
    }
  }
  if (!selected) return { ok: false, python: candidates[0], reason: 'python_missing' };
  const runtimeHome = resolve(selectedRuntimeHome ?? process.env.MINERU_HOME ?? join(root, '.runtime', 'mineru'));
  const configPath = resolve(selectedConfigPath ?? process.env.MINERU_CONFIG ?? join(runtimeHome, 'config.yaml'));
  const options = { windowsHide: true, timeout: 30000, env: { ...process.env, MINERU_HOME: runtimeHome, MINERU_CONFIG: configPath } };
  let version;
  let packageReady = false;
  try {
    version = await mineruPackageVersion({ python: selected, execute });
    const executable = join(dirname(selected), process.platform === 'win32' ? 'mineru.exe' : 'mineru');
    const kitExecutable = join(dirname(selected), process.platform === 'win32' ? 'mineru-kit.exe' : 'mineru-kit');
    await access(executable, constants.X_OK);
    await access(kitExecutable, constants.X_OK);
    if (await mineruExecutableVersion({ executable, execute }) !== version) {
      return { ok: false, python: selected, version, reason: 'executable_version_mismatch' };
    }
    await execute(selected, ['-m', 'pip', 'check'], options);
    packageReady = true;
    const result = await execute(selected, ['-c', EFFECTIVE_CONFIG_SCRIPT], options);
    const effective = JSON.parse(result.stdout);
    const modelPath = typeof effective.model?.base_dir === 'string' && effective.model.base_dir.trim()
      ? resolve(effective.model.base_dir)
      : undefined;
    if (!effective.exists || resolve(effective.config_path) !== configPath
      || effective.model?.source !== 'local' || !modelPath
      || effective.model?.small_backend !== 'onnx' || effective.model?.vlm?.engine !== 'llama-cpp'
      || effective.model?.vlm?.server_url) {
      return { ok: false, python: selected, version, reason: 'models_unavailable', detail: 'MinerU requires the configured local Standard ONNX and llama-cpp models.' };
    }
    await execute(kitExecutable, ['models', 'verify', '--tier', 'standard', '--small-backend', 'onnx', '--vlm-engine', 'llama-cpp'], {
      ...options,
      timeout: 120000,
    });
    // The download record is observational provenance, never a version or readiness lock.
    let modelSource;
    try {
      const record = JSON.parse(await readFile(join(runtimeHome, 'state', 'models-v4-complete.json'), 'utf8'));
      modelSource = record.model_source;
    } catch (cause) {
      if (cause.code !== 'ENOENT') throw cause;
    }
    const configVersion = 'sha256:' + createHash('sha256').update(JSON.stringify({ configPath, model: effective.model })).digest('hex');
    return { ok: true, python: selected, executable, version, package: 'mineru', modelSource, configPath, modelPath, runtimeHome, configVersion };
  } catch (cause) {
    return { ok: false, python: selected, version, reason: packageReady ? 'models_unavailable' : 'mineru_unavailable', detail: String(cause.stderr ?? cause.message).trim() };
  }
}
