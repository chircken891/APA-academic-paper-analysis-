import { constants } from 'node:fs';
import { access, copyFile, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runManagedProcess } from './managed-process.mjs';
import { mineruExecutableVersion, mineruPackageVersion } from './mineru-runtime.mjs';

async function mineruCommand(runtimeRoot) {
  const pythonName = process.platform === 'win32' ? join('Scripts', 'python.exe') : join('bin', 'python');
  const candidates = [
    { executable: join(runtimeRoot, 'venv', pythonName), python: join(runtimeRoot, 'venv', pythonName) },
    process.env.MINERU_PYTHON ? { executable: process.env.MINERU_PYTHON, python: process.env.MINERU_PYTHON } : undefined,
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate.executable, constants.X_OK);
      return candidate;
    } catch {
      // Try the next explicit local candidate.
    }
  }
  throw new Error('Local MinerU command is unavailable; run the repository MinerU setup first.');
}

export async function withShortMineruInput(sourcePath, operation) {
  const inputRoot = await mkdtemp(join(tmpdir(), 'apa-mineru-'));
  const stagedSource = join(inputRoot, 'input.pdf');
  try {
    await copyFile(sourcePath, stagedSource, constants.COPYFILE_EXCL);
    return await operation(stagedSource);
  } finally {
    await rm(inputRoot, { recursive: true, force: true });
  }
}

export async function withShortMineruRuntime(vaultRoot, operation, runtimeHome) {
  const runtimeRoot = await realpath(resolve(runtimeHome ?? process.env.MINERU_HOME ?? join(vaultRoot, '.runtime', 'mineru')));
  const stageRoot = await mkdtemp(join(tmpdir(), 'apa-runtime-'));
  const stagedRuntime = join(stageRoot, 'runtime');
  try {
    await symlink(runtimeRoot, stagedRuntime, process.platform === 'win32' ? 'junction' : 'dir');
    return await operation(stagedRuntime);
  } finally {
    await rm(stageRoot, { recursive: true, force: true });
  }
}

export async function runMineru({ vaultRoot, sourcePath, outputPath, signal, runtimeHome, python, configPath, resolveCommand = mineruCommand, runChild = runManagedProcess, readVersion = mineruPackageVersion, readExecutableVersion = mineruExecutableVersion } = {}) {
  return withShortMineruRuntime(vaultRoot, async runtimeRoot => {
    const command = python ? { executable: python, python } : await resolveCommand(runtimeRoot);
    const parserVersion = command.python
      ? await readVersion({ python: command.python })
      : await readExecutableVersion({ executable: command.executable });
    if (!command.python) throw new Error('A Python runtime is required for the MinerU result bridge.');
    const env = { ...process.env };
    delete env.MINERU_TOOLS_CONFIG_JSON;
    delete env.MINERU_FORMULA_ENABLE;
    delete env.MINERU_TABLE_ENABLE;
    env.MINERU_HOME = runtimeRoot;
    env.MINERU_CONFIG = configPath ?? process.env.MINERU_CONFIG ?? join(runtimeRoot, 'config.yaml');
    await withShortMineruInput(sourcePath, stagedSource => runChild(
      command.python,
      [fileURLToPath(new URL('./mineru-parse.py', import.meta.url)), stagedSource, outputPath, '--tier', 'standard', '--pages', 'all'],
      {
        cwd: vaultRoot,
        signal,
        env,
      },
    ));
    return parserVersion;
  }, runtimeHome);
}

