import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TREES = ['scripts', 'Schema', 'prompts', 'docs/apa-v3'];
const PATHS = [...TREES, 'package.json'];
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const RUN_ID = /^[a-zA-Z0-9_-]+$/;
export const READING_RUNTIME_SNAPSHOT_PROFILE = 'reading-runtime-snapshot-1.0';

const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value);
const receipt = (path, bytes) => ({ path, sha256: sha(bytes), byte_length: bytes.length });
const snapshotPath = (root, hash) => join(root, '.runtime', 'apa-code', hash.slice(7));
const referenceRoot = root => join(root, '.runtime', 'apa-code-refs');
const TRANSIENT_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES']);
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const wait = ms => Atomics.wait(sleeper, 0, 0, ms);

function fail(code, detail) {
  throw Object.assign(new Error(detail ? code + ': ' + detail : code), { code });
}

function stat(path, options) {
  try { return lstatSync(path, options); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

function directory(path, { create = false } = {}) {
  if (create) {
    try { mkdirSync(path); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  if (!stat(path)?.isDirectory()) fail('READING_RUNTIME_SNAPSHOT_INVALID', path);
  return path;
}

function readFile(path) {
  if (!stat(path)?.isFile()) fail('READING_RUNTIME_SNAPSHOT_INVALID', path);
  return readFileSync(path);
}

function scan(root, snapshot = false) {
  directory(root);
  const files = new Map();
  const add = path => files.set(path, readFile(join(root, path)));
  function walk(path) {
    for (const item of readdirSync(directory(join(root, path)), { withFileTypes: true })) {
      const child = path ? path + '/' + item.name : item.name;
      if (item.isDirectory()) walk(child);
      else add(child);
    }
  }
  if (snapshot) walk('');
  else {
    directory(join(root, 'docs'));
    TREES.forEach(walk);
    add('package.json');
  }
  return new Map([...files.keys()].sort().map(path => [path, files.get(path)]));
}

const describe = files => [...files].map(([path, bytes]) => receipt(path, bytes));

function git(root, args, { allowed = [0], environment, input } = {}) {
  const result = spawnSync('git', args, {
    cwd: root, maxBuffer: 32 * 1024 * 1024, windowsHide: true,
    ...(environment ? { env: { ...process.env, ...environment } } : {}), input,
  });
  if (result.error) throw result.error;
  if (!allowed.includes(result.status)) fail('READING_RUNTIME_GIT_PROVENANCE_FAILED', result.stderr.toString().trim());
  return result;
}

function gitProvenance(root, files) {
  const hasGit = !!stat(join(root, '.git'));
  const revision = hasGit ? git(root, ['rev-parse', '--verify', 'HEAD'], { allowed: [0, 128] }) : null;
  const commit = revision?.status === 0 ? revision.stdout.toString().trim() : null;
  if (hasGit && !commit && git(root, ['symbolic-ref', '-q', 'HEAD'], { allowed: [0, 1] }).status !== 0) {
    fail('READING_RUNTIME_GIT_PROVENANCE_FAILED', 'HEAD');
  }
  const diff = ['diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/'];
  if (!commit) {
    const pieces = [...files.keys()].map(path => git(root, [...diff, '--no-index', '--', '/dev/null', path], { allowed: [1] }).stdout);
    return { commit, bytes: Buffer.concat(pieces) };
  }
  // Compare exact bytes against Git blobs, independent of the user's index, line endings and clean filters.
  const baseline = new Map(git(root, ['ls-tree', '-r', '-z', commit, '--', ...PATHS]).stdout.toString().split('\0').filter(Boolean)
    .map(row => {
      const tab = row.indexOf('\t');
      const [mode, , oid] = row.slice(0, tab).split(' ');
      return [row.slice(tab + 1), { mode, oid }];
    }));
  const algorithm = commit.length === 64 ? 'sha256' : 'sha1';
  const changes = [];
  for (const [path, bytes] of files) {
    const oid = createHash(algorithm).update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
    const original = baseline.get(path);
    if (oid !== original?.oid) changes.push({ path, oid, mode: original?.mode === '100755' ? '100755' : '100644' });
  }
  const removed = [...baseline.keys()].filter(path => !files.has(path));
  if (!changes.length && !removed.length) return { commit, bytes: Buffer.alloc(0) };

  const temporary = mkdtempSync(join(tmpdir(), 'apa-runtime-git-'));
  try {
    const objects = join(temporary, 'objects');
    mkdirSync(objects);
    const environment = {
      GIT_INDEX_FILE: join(temporary, 'index'),
      GIT_OBJECT_DIRECTORY: objects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'objects']).stdout.toString().trim(),
    };
    const options = { environment };
    git(root, ['read-tree', commit], options);
    if (changes.length) {
      const actual = git(root, ['hash-object', '-w', '--no-filters', '--', ...changes.map(row => row.path)], options).stdout.toString().trim().split(/\r?\n/);
      if (json(actual) !== json(changes.map(row => row.oid))) fail('READING_RUNTIME_SOURCE_CHANGED', root);
    }
    const rows = [...removed.map(path => '0 ' + '0'.repeat(commit.length) + '\t' + path + '\0'),
      ...changes.map(({ mode, oid, path }) => mode + ' ' + oid + '\t' + path + '\0')];
    git(root, ['update-index', '-z', '--index-info'], { ...options, input: rows.join('') });
    return { commit, bytes: git(root, [...diff, '--cached', commit, '--', ...PATHS], options).stdout };
  } finally { rmSync(temporary, { recursive: true }); }
}

function collect({ repoRoot, codeRoot = DEFAULT_ROOT }) {
  const dataRoot = resolve(repoRoot);
  const sourceRoot = resolve(codeRoot);
  const content = scan(sourceRoot);
  const files = describe(content);
  const git = gitProvenance(sourceRoot, content);
  if (json(describe(scan(sourceRoot))) !== json(files)) fail('READING_RUNTIME_SOURCE_CHANGED', sourceRoot);
  const snapshotHash = sha(json(files));
  const snapshot = snapshotPath(dataRoot, snapshotHash);
  const patch = receipt('runtime-code-' + sha(git.bytes).slice(7) + '.patch', git.bytes);
  const body = {
    profile: READING_RUNTIME_SNAPSHOT_PROFILE,
    data_root: dataRoot, source_code_root: sourceRoot, code_root: snapshot, repo_root: snapshot,
    snapshot_hash: snapshotHash, files, git_commit: git.commit, patch,
  };
  return { manifest: { ...body, fingerprint: sha(json(body)) }, content, patchBytes: git.bytes };
}

export function previewReadingRuntimeSnapshot(options) {
  return collect(options).manifest;
}

function validFilePath(path) {
  return typeof path === 'string' && !path.includes('\\') && !path.includes('\0')
    && path.split('/').every(part => part && part !== '.' && part !== '..' && !part.includes(':'))
    && (path === 'package.json' || TREES.some(tree => path.startsWith(tree + '/')));
}

function validReceipt(row) {
  return row && Object.keys(row).length === 3 && SHA256.test(row.sha256)
    && Number.isSafeInteger(row.byte_length) && row.byte_length >= 0;
}

export function validateReadingRuntimeSnapshotManifest({ manifest, repoRoot = manifest?.data_root }) {
  if (!manifest || manifest.profile !== READING_RUNTIME_SNAPSHOT_PROFILE
    || typeof repoRoot !== 'string' || manifest.data_root !== resolve(repoRoot)
    || typeof manifest.source_code_root !== 'string' || !isAbsolute(manifest.source_code_root)
    || !SHA256.test(manifest.snapshot_hash) || manifest.code_root !== snapshotPath(manifest.data_root, manifest.snapshot_hash)
    || manifest.repo_root !== manifest.code_root || !Array.isArray(manifest.files)
    || manifest.git_commit !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(manifest.git_commit)
    || !validReceipt(manifest.patch) || manifest.patch.path !== 'runtime-code-' + manifest.patch.sha256.slice(7) + '.patch') {
    fail('READING_RUNTIME_SNAPSHOT_INVALID', 'manifest');
  }
  const { fingerprint, ...body } = manifest;
  if (fingerprint !== sha(json(body)) || sha(json(manifest.files)) !== manifest.snapshot_hash
    || manifest.files.some((row, index) => !validReceipt(row) || !validFilePath(row.path)
      || index > 0 && manifest.files[index - 1].path >= row.path)
    || !manifest.files.some(row => row.path === 'package.json')) {
    fail('READING_RUNTIME_SNAPSHOT_INVALID', 'manifest fingerprint');
  }
}

function verifyPatch(manifest, runRoot) {
  const bytes = readFile(join(directory(runRoot), manifest.patch.path));
  if (sha(bytes) !== manifest.patch.sha256 || bytes.length !== manifest.patch.byte_length) {
    fail('READING_RUNTIME_SNAPSHOT_INVALID', manifest.patch.path);
  }
  return bytes;
}

function verifyTree(path, manifest) {
  if (json(describe(scan(path, true))) !== json(manifest.files)) fail('READING_RUNTIME_SNAPSHOT_INVALID', path);
}

export function verifyReadingRuntimeSnapshot({ manifest, repoRoot = manifest?.data_root, runRoot }) {
  validateReadingRuntimeSnapshotManifest({ manifest, repoRoot });
  directory(join(repoRoot, '.runtime'));
  directory(join(repoRoot, '.runtime', 'apa-code'));
  verifyTree(manifest.code_root, manifest);
  if (runRoot !== undefined) verifyPatch(manifest, runRoot);
  return manifest;
}

function setDirectoriesReadOnly(root) {
  for (const item of readdirSync(root, { withFileTypes: true })) {
    if (item.isDirectory()) setDirectoriesReadOnly(join(root, item.name));
  }
  chmodSync(root, 0o555);
}

function clearStaging(root) {
  chmodSync(root, 0o700);
  for (const item of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, item.name);
    if (item.isDirectory()) clearStaging(path);
    else chmodSync(path, 0o600);
  }
  rmSync(root, { recursive: true });
}

function snapshotIdentity(path) {
  const state = stat(path, { bigint: true });
  if (!state) return null;
  if (!state.isDirectory()) fail('READING_RUNTIME_SNAPSHOT_INVALID', path);
  return `${state.dev}:${state.ino}:${state.birthtimeNs}:${state.ctimeNs}:${state.mtimeNs}`;
}

function stageSnapshot(base, manifest, content) {
  const staging = mkdtempSync(join(base, '.building-'));
  try {
    for (const [path, bytes] of content) {
      const target = join(staging, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes, { flag: 'wx' });
      chmodSync(target, 0o444);
    }
    verifyTree(staging, manifest);
    setDirectoriesReadOnly(staging);
    return staging;
  } catch (error) {
    clearStaging(staging);
    throw error;
  }
}

/** A different process can replace the canonical directory while its contents are being read. */
function useVerifiedSnapshot(manifest, content, operation) {
  const repoRoot = manifest.data_root;
  const runtime = directory(join(repoRoot, '.runtime'), { create: !!content });
  const base = directory(join(runtime, 'apa-code'), { create: !!content });
  const destination = manifest.code_root;
  const waits = [20, 60, 120, 240];
  let staging, renameAttempts = 0;
  try {
    while (true) {
      const before = snapshotIdentity(destination);
      if (before) {
        try { verifyTree(destination, manifest); }
        catch (error) {
          if (snapshotIdentity(destination) === before) throw error;
          continue;
        }
      } else if (content) staging ??= stageSnapshot(base, manifest, content);
      else fail('READING_RUNTIME_SNAPSHOT_INVALID', destination);

      const outcome = withReadingRuntimeSnapshotLock({ repoRoot }, () => {
        if (snapshotIdentity(destination) !== before) return null;
        if (!before) {
          try { renameSync(staging, destination); }
          catch (error) {
            if (TRANSIENT_RENAME.has(error.code)) return { renameError: error };
            throw error;
          }
        }
        return { value: operation() };
      });
      if (!outcome) continue;
      if (!outcome.renameError) return outcome.value;
      if (renameAttempts === waits.length) throw outcome.renameError;
      wait(waits[renameAttempts++]);
    }
  } finally {
    if (staging && stat(staging)) clearStaging(staging);
  }
}

function persistPatch(runRoot, manifest, bytes) {
  mkdirSync(runRoot, { recursive: true });
  const target = join(directory(runRoot), manifest.patch.path);
  if (stat(target)) return;
  const temporary = join(runRoot, '.runtime-patch-' + randomUUID());
  writeFileSync(temporary, bytes, { flag: 'wx' });
  try {
    try { linkSync(temporary, target); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  } finally { unlinkSync(temporary); }
}

export function prepareReadingRuntimeSnapshot({ repoRoot, codeRoot, runRoot, runId, reference }) {
  if (!RUN_ID.test(runId ?? '') || !isAbsolute(runRoot ?? '')) fail('READING_RUNTIME_REFERENCE_INVALID');
  const { manifest, content, patchBytes } = collect({ repoRoot, codeRoot });
  if (reference !== undefined) {
    const options = typeof reference === 'function' ? reference(manifest) : reference;
    persistPatch(runRoot, manifest, patchBytes);
    verifyPatch(manifest, runRoot);
    useVerifiedSnapshot(manifest, content, () => writeSnapshotReference({ ...options, repoRoot: manifest.data_root, runId, runRoot, manifest }));
  } else {
    useVerifiedSnapshot(manifest, content, () => {});
    persistPatch(runRoot, manifest, patchBytes);
    verifyPatch(manifest, runRoot);
  }
  return manifest;
}

/** Give another run the same captured code and its own verified recovery patch. */
export function copyReadingRuntimeSnapshotBinding({ manifest, fromRunRoot, runRoot, runId, reference }) {
  validateReadingRuntimeSnapshotManifest({ manifest });
  persistPatch(runRoot, manifest, verifyPatch(manifest, fromRunRoot));
  if (reference === undefined) verifyReadingRuntimeSnapshot({ manifest, runRoot });
  else {
    const options = typeof reference === 'function' ? reference(manifest) : reference;
    registerReadingRuntimeSnapshotReference({ ...options, repoRoot: manifest.data_root, runId, runRoot, manifest });
  }
  return manifest;
}

export function withReadingRuntimeSnapshotLock({ repoRoot, maxWaitMs = 10 * 60 * 1000 }, callback) {
  if (callback.constructor?.name === 'AsyncFunction') fail('READING_RUNTIME_SNAPSHOT_LOCK_ASYNC');
  const root = directory(join(repoRoot, '.runtime'), { create: true });
  const lock = join(root, 'apa-code.lock');
  const owner = process.pid + '-' + randomUUID();
  const temporary = mkdtempSync(join(root, '.apa-code-lock-'));
  writeFileSync(join(temporary, owner), '', { flag: 'wx' });
  const start = performance.now();
  try {
    while (true) {
      try { renameSync(temporary, lock); break; }
      catch (error) {
        if (!TRANSIENT_RENAME.has(error.code) && !['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      }
      let owners = [], createdAt = null;
      try {
        const existing = stat(lock);
        if (existing) {
          if (!existing.isDirectory()) fail('READING_RUNTIME_SNAPSHOT_INVALID', lock);
          createdAt = existing.birthtime.toISOString();
          owners = readdirSync(lock);
        }
      } catch (error) { if (error.code !== 'ENOENT' && !TRANSIENT_RENAME.has(error.code)) throw error; }
      if (owners.length > 1 || owners.some(name => !/^\d+-[a-f0-9-]{36}$/.test(name))) {
        fail('READING_RUNTIME_SNAPSHOT_INVALID', lock);
      }
      const active = owners[0];
      const pid = active ? Number(active.split('-')[0]) : null;
      let empty = !active;
      if (active) {
        if (pid === process.pid) fail('READING_RUNTIME_SNAPSHOT_LOCK_REENTRY', lock);
        try { process.kill(pid, 0); }
        catch (error) {
          if (error.code !== 'EPERM' && error.code !== 'ESRCH') throw error;
          if (error.code === 'ESRCH') {
            try { unlinkSync(join(lock, active)); }
            catch (unlinkError) { if (unlinkError.code !== 'ENOENT') throw unlinkError; }
            empty = true;
          }
        }
      }
      // Only an empty lock can be removed, including one whose owner just exited.
      if (empty) removeEmptyLock(lock);
      const elapsed = performance.now() - start;
      if (elapsed >= maxWaitMs) {
        const details = { path: lock, owner_pid: pid, created_at: createdAt, waited_ms: Math.floor(elapsed) };
        throw Object.assign(new Error('READING_RUNTIME_SNAPSHOT_BUSY: ' + json(details)), { code: 'READING_RUNTIME_SNAPSHOT_BUSY', details });
      }
      wait(Math.min(20, maxWaitMs - elapsed));
    }
  } finally {
    if (stat(temporary)) rmSync(temporary, { recursive: true });
  }
  try {
    const result = callback();
    if (result && typeof result.then === 'function') fail('READING_RUNTIME_SNAPSHOT_LOCK_ASYNC');
    return result;
  } finally {
    unlinkSync(join(lock, owner));
    removeEmptyLock(lock);
  }
}

function removeEmptyLock(path) {
  try { rmdirSync(path); }
  catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code) && !TRANSIENT_RENAME.has(error.code)) throw error;
  }
}

function referencePath(repoRoot, runId) {
  if (!RUN_ID.test(runId ?? '')) fail('READING_RUNTIME_REFERENCE_INVALID');
  return join(referenceRoot(repoRoot), runId + '.json');
}

function validPendingCheckpoint(checkpoint) {
  return validReceipt(checkpoint) && typeof checkpoint.artifact_id === 'string'
    && /^session-state-\d+$/.test(checkpoint.artifact_id);
}

export function readReadingRuntimeSnapshotReference({ repoRoot, runId }) {
  const path = referencePath(repoRoot, runId);
  if (!stat(join(repoRoot, '.runtime'))) return null;
  directory(join(repoRoot, '.runtime'));
  if (!stat(referenceRoot(repoRoot))) return null;
  directory(referenceRoot(repoRoot));
  if (!stat(path)) return null;
  const reference = JSON.parse(readFile(path));
  if (!reference || reference.run_id !== runId || !isAbsolute(reference.run_root ?? '')
    || reference.snapshot_hash !== reference.manifest?.snapshot_hash
    || reference.fingerprint !== reference.manifest?.fingerprint
    || reference.batch_run_sha256 !== undefined && !SHA256.test(reference.batch_run_sha256)
    || reference.previous_manifests !== undefined && !Array.isArray(reference.previous_manifests)) {
    fail('READING_RUNTIME_REFERENCE_INVALID', runId);
  }
  validateReadingRuntimeSnapshotManifest({ manifest: reference.manifest, repoRoot });
  const known = new Set([reference.fingerprint]);
  for (const manifest of reference.previous_manifests ?? []) {
    validateReadingRuntimeSnapshotManifest({ manifest, repoRoot });
    if (known.has(manifest.fingerprint)) fail('READING_RUNTIME_REFERENCE_INVALID', runId);
    known.add(manifest.fingerprint);
  }
  if (reference.pending_manifest !== undefined) {
    validateReadingRuntimeSnapshotManifest({ manifest: reference.pending_manifest, repoRoot });
    if (reference.pending_manifest.fingerprint === reference.fingerprint) fail('READING_RUNTIME_REFERENCE_INVALID', runId);
  }
  if (reference.pending_checkpoint !== undefined
    && (!reference.pending_manifest || !validPendingCheckpoint(reference.pending_checkpoint))) {
    fail('READING_RUNTIME_REFERENCE_INVALID', runId);
  }
  return reference;
}

export function listReadingRuntimeSnapshotReferences({ repoRoot }) {
  if (!stat(join(repoRoot, '.runtime'))) return [];
  directory(join(repoRoot, '.runtime'));
  const base = referenceRoot(repoRoot);
  if (!stat(base)) return [];
  return readdirSync(directory(base)).filter(name => name.endsWith('.json')).sort()
    .map(name => readReadingRuntimeSnapshotReference({ repoRoot, runId: name.slice(0, -5) })).filter(Boolean);
}

function writeReference(repoRoot, runId, reference) {
  const path = referencePath(repoRoot, runId);
  const base = directory(referenceRoot(repoRoot), { create: true });
  const temporary = join(base, '.writing-' + randomUUID());
  try {
    writeFileSync(temporary, json(reference) + '\n', { flag: 'wx' });
    renameSync(temporary, path);
  } finally { if (stat(temporary)) unlinkSync(temporary); }
  return reference;
}

export function registerReadingRuntimeSnapshotReference({ repoRoot, runRoot, manifest, ...options }) {
  validateReadingRuntimeSnapshotManifest({ manifest, repoRoot });
  verifyPatch(manifest, runRoot);
  return useVerifiedSnapshot(manifest, null, () => writeSnapshotReference({ repoRoot, runRoot, manifest, ...options }));
}

function writeSnapshotReference({
  repoRoot, runId, runRoot, manifest, expectedFingerprint, pending = false, pendingCheckpoint, batchRunSha256,
}) {
  const previous = readReadingRuntimeSnapshotReference({ repoRoot, runId });
  if (!isAbsolute(runRoot ?? '') || previous && previous.run_root !== runRoot) fail('READING_RUNTIME_REFERENCE_INVALID', runId);
  if (batchRunSha256 !== undefined && (!SHA256.test(batchRunSha256) || previous && previous.batch_run_sha256 !== batchRunSha256)) {
    fail('READING_RUNTIME_REFERENCE_CONFLICT', runId);
  }
  if (pendingCheckpoint !== undefined && (!pending || !validPendingCheckpoint(pendingCheckpoint))) {
    fail('READING_RUNTIME_REFERENCE_INVALID', runId);
  }
  if (!pending && previous?.fingerprint === manifest.fingerprint) return previous;
  if (previous?.fingerprint !== (expectedFingerprint ?? undefined)) fail('READING_RUNTIME_REFERENCE_CONFLICT', runId);
  if (pending && (!previous || previous.fingerprint === manifest.fingerprint)
    || previous?.pending_manifest && previous.pending_manifest.fingerprint !== manifest.fingerprint) {
    fail('READING_RUNTIME_REFERENCE_CONFLICT', runId);
  }
  const history = previous
    ? [...(previous.previous_manifests ?? []), previous.manifest].filter(item => item.fingerprint !== manifest.fingerprint)
    : [];
  const storedCheckpoint = previous?.pending_checkpoint;
  if (pending && storedCheckpoint && pendingCheckpoint && ['artifact_id', 'sha256', 'byte_length']
    .some(field => storedCheckpoint[field] !== pendingCheckpoint[field])) {
    fail('READING_RUNTIME_REFERENCE_CONFLICT', runId);
  }
  const reference = pending ? {
    ...previous, pending_manifest: manifest,
    ...(pendingCheckpoint ? { pending_checkpoint: pendingCheckpoint } : {}),
  } : {
    run_id: runId, run_root: runRoot, snapshot_hash: manifest.snapshot_hash, fingerprint: manifest.fingerprint, manifest,
    ...(batchRunSha256 || previous?.batch_run_sha256 ? { batch_run_sha256: batchRunSha256 ?? previous.batch_run_sha256 } : {}),
    ...(history.length ? { previous_manifests: history } : {}),
  };
  return writeReference(repoRoot, runId, reference);
}

export function abandonReadingRuntimeSnapshotReference({
  repoRoot, runId, runRoot, expectedFingerprint, pendingFingerprint, lockHeld = false,
}) {
  const operation = () => {
    const reference = readReadingRuntimeSnapshotReference({ repoRoot, runId });
    if (!reference || reference.run_root !== runRoot || reference.fingerprint !== expectedFingerprint
      || !reference.pending_manifest || reference.pending_manifest.fingerprint !== pendingFingerprint) {
      fail('READING_RUNTIME_REFERENCE_CONFLICT', runId);
    }
    const { pending_manifest, pending_checkpoint, previous_manifests = [], ...active } = reference;
    const history = previous_manifests.some(manifest => manifest.fingerprint === pendingFingerprint)
      ? previous_manifests : [...previous_manifests, pending_manifest];
    return writeReference(repoRoot, runId, { ...active, previous_manifests: history });
  };
  return lockHeld ? operation() : withReadingRuntimeSnapshotLock({ repoRoot }, operation);
}

export function releaseReadingRuntimeSnapshotReference({ repoRoot, runId, expectedFingerprint, lockHeld = false }) {
  const operation = () => {
    const reference = readReadingRuntimeSnapshotReference({ repoRoot, runId });
    if (!reference) return null;
    if (reference.fingerprint !== expectedFingerprint) fail('READING_RUNTIME_REFERENCE_CONFLICT', runId);
    unlinkSync(referencePath(repoRoot, runId));
    return reference;
  };
  return lockHeld ? operation() : withReadingRuntimeSnapshotLock({ repoRoot }, operation);
}
