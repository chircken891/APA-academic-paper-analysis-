import { randomUUID } from 'node:crypto';
import { constants, writeFileSync } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readdir, realpath, rename, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir, totalmem } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { loadApaConfig } from './apa-config.mjs';
import { runManagedProcess } from './managed-process.mjs';
import { mineruExecutableVersion, mineruPackageVersion } from './mineru-runtime.mjs';

const GiB = 2 ** 30;
const slotConflict = new Set(['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES']);
const ownerPattern = /^(\d+)-[a-f0-9-]{36}-(?:runner|child)\.json$/;

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

async function unlinkOwner(path) {
  try { await unlink(path); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function removeEmptySlot(slot) {
  try { await rmdir(slot); }
  catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
}

async function reclaimExitedSlot(slot) {
  let owners;
  try { owners = await readdir(slot); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  const pids = owners.map(owner => Number(ownerPattern.exec(owner)?.[1]));
  if (pids.some(pid => !Number.isSafeInteger(pid) || pid < 1)) {
    throw new Error(`Unexpected MinerU slot contents at ${slot}`);
  }
  if (pids.some(isAlive)) return true;
  // A contender can remove only the observed owner names; rmdir cannot remove a new owner.
  for (const owner of owners) await unlinkOwner(join(slot, owner));
  await removeEmptySlot(slot);
  return false;
}

function readConfiguredLimit(vaultRoot) {
  return loadApaConfig({ repoRoot: vaultRoot }).config.parser?.max_concurrent;
}

async function hasHigherOccupiedSlot(base, limit) {
  for (const name of await readdir(base)) {
    const index = Number(/^slot-(\d+)$/.exec(name)?.[1]);
    if (index > limit && await reclaimExitedSlot(join(base, name))) return true;
  }
  return false;
}

async function acquireMineruSlot(vaultRoot, signal) {
  const memoryLimit = Math.max(1, Math.floor((totalmem() - 8 * GiB) / (12 * GiB)));
  const base = join(vaultRoot, '.runtime', 'mineru-slots');
  await mkdir(base, { recursive: true });
  const id = randomUUID();
  const owner = `${process.pid}-${id}-runner.json`;
  const pending = await mkdtemp(join(base, 'pending-'));
  let ownerDirectory = pending;
  let savedRecord;
  let acquired = false;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const configuredLimit = readConfiguredLimit(vaultRoot);
      const limit = configuredLimit ?? memoryLimit;
      // Let a higher slot from the previous limit drain before admitting any new parser.
      if (!await hasHigherOccupiedSlot(base, limit)) {
        const record = JSON.stringify({ pid: process.pid, max_concurrent: limit,
          limit_source: configuredLimit === undefined ? 'memory' : 'configuration' });
        if (record !== savedRecord) {
          await writeFile(join(pending, owner), record, { flag: savedRecord === undefined ? 'wx' : 'w' });
          savedRecord = record;
        }
        for (let i = 1; i <= limit; i++) {
          const slot = join(base, `slot-${i}`);
          try { await rename(pending, slot); }
          catch (error) {
            if (!slotConflict.has(error.code)) throw error;
            await reclaimExitedSlot(slot);
            continue;
          }
          ownerDirectory = slot;
          if (readConfiguredLimit(vaultRoot) === configuredLimit && !await hasHigherOccupiedSlot(base, limit)) {
            acquired = true;
            return { slot, id, owner };
          }
          await rename(slot, pending);
          ownerDirectory = pending;
          break;
        }
      }
      await delay(250, undefined, { signal });
    }
  } finally {
    if (!acquired) {
      await unlinkOwner(join(ownerDirectory, owner));
      await removeEmptySlot(ownerDirectory);
    }
  }
}

async function withMineruSlot(vaultRoot, signal, operation) {
  const { slot, id, owner } = await acquireMineruSlot(vaultRoot, signal);
  const stop = new AbortController();
  let childRecord, childPid, recordError;
  try {
    await operation(signal ? AbortSignal.any([signal, stop.signal]) : stop.signal, child => {
      if (!child.pid) return; // Spawn failures have no child process to track.
      childPid = child.pid;
      childRecord = join(slot, `${childPid}-${id}-child.json`);
      try { writeFileSync(childRecord, JSON.stringify({ pid: childPid }), { flag: 'wx' }); }
      catch (error) { recordError = error; stop.abort(); }
    });
  } finally {
    // If teardown failed and the child still runs, leave its own marker for a later sweep.
    if (childRecord && !isAlive(childPid)) await unlinkOwner(childRecord);
    await unlinkOwner(join(slot, owner));
    await removeEmptySlot(slot);
    if (recordError) throw recordError;
  }
}

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
    // An explicit interpreter must not bypass the runtime's Unicode-safe alias.
    // Rebase only paths within this runtime; keep external selections unchanged.
    const relativePython = python ? relative(await realpath(runtimeRoot), resolve(python)) : null;
    const selectedPython = relativePython && relativePython !== '..'
      && !relativePython.startsWith(`..${sep}`) && !isAbsolute(relativePython)
      ? join(runtimeRoot, relativePython) : python;
    const command = selectedPython ? { executable: selectedPython, python: selectedPython } : await resolveCommand(runtimeRoot);
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
    await withShortMineruInput(sourcePath, async stagedSource => {
      const script = fileURLToPath(new URL('./mineru-parse.py', import.meta.url));
      const arguments_ = [script, stagedSource, outputPath, '--tier', 'standard', '--pages', 'all'];
      await withMineruSlot(vaultRoot, signal, (childSignal, onSpawn) => runChild(command.python, arguments_, {
        cwd: vaultRoot, signal: childSignal, env, onSpawn,
      }));
    });
    return parserVersion;
  }, runtimeHome);
}

