import { createHash, randomUUID } from 'node:crypto';
import { linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { chmod, link, lstat, mkdir, readFile, readdir, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { listReadingRuntimeSnapshotReferences, readReadingRuntimeSnapshotReference,
  releaseReadingRuntimeSnapshotReference, validateReadingRuntimeSnapshotManifest,
  verifyReadingRuntimeSnapshot, withReadingRuntimeSnapshotLock } from './reading-runtime-snapshot.mjs';

const PROFILE = 'reading-runtime-cleanup-1.0';
const SNAPSHOT = 'reading-runtime-snapshot-1.0';
const TERMINAL_FILE = 'runtime-terminal.json';
const OWNERSHIP = 'runtime-cleanup-owned';
const PLAN_FILE = 'runtime-cleanup-plan.json';
const CLAIM_FILE = 'runtime-cleanup-claim.json';
const RETIRED_FILE = 'runtime-cleanup-retired.json';
const RESULT_FILE = 'runtime-cleanup.json';
const scriptPath = fileURLToPath(import.meta.url);
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const identifier = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,95}$/i.test(value);
const nonempty = value => typeof value === 'string' && !!value.trim();
const hashValue = value => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const fail = (code, details) => { throw Object.assign(new Error(code), { code, details }); };

function inside(root, path) {
  const part = relative(root, path);
  return !!part && part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part);
}

function display(root, path) {
  return inside(root, path) ? relative(root, path).replaceAll(sep, '/') : path;
}

async function inspectPath(root, path, kind, { create = false } = {}) {
  if (!inside(root, path)) fail('READING_RUNTIME_CLEANUP_PATH', { path });
  const pieces = relative(root, path).split(sep);
  let cursor = root;
  for (let i = 0; i < pieces.length; i++) {
    cursor = join(cursor, pieces[i]);
    const directory = i < pieces.length - 1 || kind === 'directory';
    if (create && directory) {
      try { await mkdir(cursor); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    let state;
    try { state = await lstat(cursor); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    if (state.isSymbolicLink() || !(directory ? state.isDirectory() : state.isFile())) {
      fail('READING_RUNTIME_CLEANUP_PATH', { path: cursor });
    }
  }
  return true;
}

// Compare file identity after expensive reads. Timestamps also detect in-place edits before claiming.
function pathState(root, path, kind) {
  if (!inside(root, path)) fail('READING_RUNTIME_CLEANUP_PATH', { path });
  const pieces = relative(root, path).split(sep);
  let cursor = root, state;
  for (let i = 0; i < pieces.length; i++) {
    cursor = join(cursor, pieces[i]);
    const directory = i < pieces.length - 1 || kind === 'directory';
    try { state = lstatSync(cursor, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!(directory ? state.isDirectory() : state.isFile())) fail('READING_RUNTIME_CLEANUP_PATH', { path: cursor });
  }
  const identity = `${state.dev}:${state.ino}:${state.birthtimeNs}`;
  return { identity, version: `${identity}:${state.size}:${state.ctimeNs}:${state.mtimeNs}` };
}

function readRecordSync(root, path) {
  return pathState(root, path, 'file') ? JSON.parse(readFileSync(path)) : null;
}

function writeImmutableSync(root, path, bytes) {
  const staging = path + '.' + randomUUID() + '.tmp';
  writeFileSync(staging, bytes, { flag: 'wx' });
  try {
    try { linkSync(staging, path); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!pathState(root, path, 'file') || !readFileSync(path).equals(bytes)) {
        fail('READING_RUNTIME_CLEANUP_RECORD_CONFLICT', { path });
      }
    }
  } finally { unlinkSync(staging); }
}

async function bindRun({ repoRoot, runId, runRoot }) {
  if (!identifier(runId) || !isAbsolute(repoRoot ?? '') || !isAbsolute(runRoot ?? '')) fail('READING_RUNTIME_CLEANUP_RUN');
  const root = await realpath(repoRoot);
  if (resolve(runRoot) !== await realpath(runRoot) || root === runRoot) fail('READING_RUNTIME_CLEANUP_RUN');
  return { repoRoot: root, runId, runRoot: resolve(runRoot), evidenceRoot: join(root, 'Eval', 'apa-v3', 'runs', runId) };
}

async function readRecord(root, path) {
  return await inspectPath(root, path, 'file') ? JSON.parse(await readFile(path)) : null;
}

async function writeImmutable(path, bytes) {
  const staging = path + '.' + randomUUID() + '.tmp';
  try { await writeFile(staging, bytes, { flag: 'wx' });
    try { await link(staging, path); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await lstat(path);
      if (!existing.isFile() || existing.isSymbolicLink() || !(await readFile(path)).equals(bytes)) {
        fail('READING_RUNTIME_CLEANUP_RECORD_CONFLICT', { path });
      }
    }
  } finally {
    try { await unlink(staging); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export async function withReadingRuntimeConsumer(options, callback) {
  const { runRoot } = await bindRun(options);
  const lock = join(runRoot, 'runtime-consumer.lock');
  const owner = `${process.pid}-${randomUUID()}`;
  const staging = join(runRoot, '.runtime-consumer-' + owner);
  await mkdir(staging);
  try {
    await writeFile(join(staging, owner), '', { flag: 'wx' });
    for (let attempt = 0; ; attempt++) {
      try { await rename(staging, lock); break; } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
        if (attempt >= 3) fail('READING_RUNTIME_CONSUMER_ACTIVE', { path: lock });
        if (!await inspectPath(runRoot, lock, 'directory')) continue;
        const owners = await readdir(lock);
        if (owners.length > 1 || owners.some(name => !/^\d+-[a-f0-9-]{36}$/.test(name))) {
          fail('READING_RUNTIME_CONSUMER_ACTIVE', { path: lock });
        }
        if (owners.length) {
          const pid = Number(owners[0].split('-')[0]);
          try { process.kill(pid, 0); } catch (probe) {
            if (probe.code === 'EPERM') fail('READING_RUNTIME_CONSUMER_ACTIVE', { path: lock });
            if (probe.code !== 'ESRCH') throw probe;
            try { await unlink(join(lock, owners[0])); } catch (unlinkError) { if (unlinkError.code !== 'ENOENT') throw unlinkError; }
            continue;
          }
          fail('READING_RUNTIME_CONSUMER_ACTIVE', { path: lock });
        }
        try { await rmdir(lock); } catch (removeError) {
          if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(removeError.code)) throw removeError;
        }
      }
    }
  } finally {
    if (await inspectPath(runRoot, staging, 'directory')) {
      try { await unlink(join(staging, owner)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await rmdir(staging);
    }
  }
  try { return await callback(); } finally {
    await unlink(join(lock, owner));
    try { await rmdir(lock); } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
  }
}

export async function readReadingRuntimeTerminal(options) {
  const { runId, runRoot } = await bindRun(options);
  return validateTerminal(await readRecord(runRoot, join(runRoot, TERMINAL_FILE)), runId);
}

function validateTerminal(record, runId) {
  if (record && (record.profile !== PROFILE || record.run_id !== runId || !hashValue(record.runtime_fingerprint)
    || !Number.isFinite(Date.parse(record.recorded_at)) || !['published', 'completed_with_limits', 'terminated'].includes(record.status)
    || record.status !== 'published' && (!nonempty(record.authorization_id) || !nonempty(record.user_reply)))) {
    fail('READING_RUNTIME_TERMINAL_INVALID');
  }
  return record;
}

function sourceBoundary(ctx, path, kind) {
  if (inside(join(ctx.repoRoot, '.tmp'), path) && !inside(ctx.runRoot, path)) return ctx.repoRoot;
  if (kind === 'host' && inside(ctx.runRoot, path)) return ctx.runRoot;
  return null;
}

/** Register outputs at the point their producer creates them. Directories confer no ownership on unlisted files. */
export async function registerReadingRuntimeCleanupFiles({ files = [], directories = [], ...options } = {}) {
  const ctx = await bindRun(options);
  const ref = readReadingRuntimeSnapshotReference(ctx);
  if (!ref || ref.run_root !== ctx.runRoot) return { status: 'unregistered-runtime' };
  if (await readReadingRuntimeTerminal(ctx)) fail('READING_RUNTIME_TERMINAL_ALREADY_RECORDED');
  const records = [];
  for (const row of [...files, ...directories.map(path => ({ path, kind: 'directory' }))]) {
    if (!isAbsolute(row.path ?? '') || !['host', 'historical', 'temporary', 'directory'].includes(row.kind)) {
      fail('READING_RUNTIME_CLEANUP_REGISTRATION', { path: row.path });
    }
    const path = resolve(row.path), boundary = sourceBoundary(ctx, path, row.kind);
    if (!boundary) continue;
    const type = row.kind === 'directory' ? 'directory' : 'file';
    const observed = pathState(boundary, path, type);
    if (!observed) fail('READING_RUNTIME_CLEANUP_REGISTRATION', { path });
    const bytes = type === 'directory' ? null : await readFile(path);
    const record = { path, kind: row.kind, ...(bytes ? { sha256: sha(bytes), byte_length: bytes.length } : {}) };
    if (row.sha256 !== undefined && row.sha256 !== record.sha256
      || row.byte_length !== undefined && row.byte_length !== record.byte_length) fail('READING_RUNTIME_CLEANUP_BYTES_CHANGED', { path });
    records.push({ record, boundary, type, observed });
  }
  return withReadingRuntimeSnapshotLock(ctx, () => {
    const current = readReadingRuntimeSnapshotReference(ctx);
    if (!current || current.run_root !== ctx.runRoot) return { status: 'unregistered-runtime' };
    if (validateTerminal(readRecordSync(ctx.runRoot, join(ctx.runRoot, TERMINAL_FILE)), ctx.runId)) {
      fail('READING_RUNTIME_TERMINAL_ALREADY_RECORDED');
    }
    if (current.fingerprint !== ref.fingerprint) fail('READING_RUNTIME_SNAPSHOT_REFERENCE_MISMATCH');
    for (const { record: { path }, boundary, type, observed } of records) {
      const field = type === 'directory' ? 'identity' : 'version';
      if (pathState(boundary, path, type)?.[field] !== observed[field]) fail('READING_RUNTIME_CLEANUP_BYTES_CHANGED', { path });
    }
    const base = join(ctx.runRoot, OWNERSHIP);
    try { mkdirSync(base); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    pathState(ctx.runRoot, base, 'directory');
    for (const { record } of records) {
      writeImmutableSync(ctx.runRoot, join(base, sha(record.path).slice(7) + '.json'), json(record));
    }
    return { status: 'registered' };
  });
}

async function ownedRows(ctx) {
  const base = join(ctx.runRoot, OWNERSHIP);
  if (!await inspectPath(ctx.runRoot, base, 'directory')) return [];
  const rows = [];
  for (const name of await readdir(base)) {
    if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
    const row = await readRecord(ctx.runRoot, join(base, name));
    if (!row || !isAbsolute(row.path ?? '') || resolve(row.path) !== row.path || sha(row.path).slice(7) + '.json' !== name
      || !['host', 'historical', 'temporary', 'directory'].includes(row.kind) || !sourceBoundary(ctx, row.path, row.kind)
      || row.kind !== 'directory' && (!hashValue(row.sha256) || !Number.isSafeInteger(row.byte_length) || row.byte_length < 0)) {
      fail('READING_RUNTIME_CLEANUP_REGISTRATION', { path: join(base, name) });
    }
    rows.push(row);
  }
  return rows;
}

async function publicationEvidence(ctx, { transaction_id, generation } = {}) {
  if (!identifier(transaction_id) || !identifier(generation)) fail('READING_RUNTIME_PUBLICATION_EVIDENCE_REQUIRED');
  const folder = join(ctx.evidenceRoot, 'publication');
  const verification = await readRecord(ctx.repoRoot, join(folder, 'VERIFICATION.json'));
  const result = join(folder, 'RESULT.md');
  const journalPath = '.apa-v3/phase22/transactions/' + transaction_id + '/journal.json';
  const journal = await readRecord(ctx.repoRoot, join(ctx.repoRoot, journalPath));
  if (verification?.status !== 'passed' || verification.transaction_id !== transaction_id || verification.generation !== generation
    || verification.journal_path !== journalPath || !verification.verified_files?.length
    || journal?.state !== 'committed' || journal.run_id !== ctx.runId || journal.vault_root !== ctx.repoRoot
    || journal.transaction_id !== transaction_id || journal.generation !== generation
    || !await inspectPath(ctx.repoRoot, result, 'file')
    || !(await readFile(result, 'utf8')).includes('已提交代次 ' + generation + '，事务 ' + transaction_id + '。')) {
    fail('READING_RUNTIME_PUBLICATION_EVIDENCE_REQUIRED', { transaction_id, generation });
  }
  return { transaction_id, generation };
}

async function terminalRecord(ctx, manifest, requested) {
  const existing = await readReadingRuntimeTerminal(ctx);
  if (!requested && !existing) fail('READING_RUNTIME_TERMINAL_REQUIRED');
  if (requested?.status === 'published') {
    requested = { status: 'published', publication: await publicationEvidence(ctx, requested.publication) };
  } else if (requested && (!['completed_with_limits', 'terminated'].includes(requested.status)
    || !nonempty(requested.authorization_id) || !nonempty(requested.user_reply))) fail('READING_RUNTIME_TERMINAL_INVALID');
  if (existing) {
    if (existing.runtime_fingerprint !== manifest.fingerprint || requested && Object.entries(requested).some(([key, value]) =>
      JSON.stringify(existing[key]) !== JSON.stringify(value))) fail('READING_RUNTIME_TERMINAL_CONFLICT');
    if (existing.status === 'published' && !requested) await publicationEvidence(ctx, existing.publication);
    return existing;
  }
  const record = { ...requested, profile: PROFILE, run_id: ctx.runId, runtime_fingerprint: manifest.fingerprint,
    recorded_at: new Date().toISOString() };
  withReadingRuntimeSnapshotLock(ctx, () => writeImmutableSync(ctx.runRoot, join(ctx.runRoot, TERMINAL_FILE), json(record)));
  return record;
}

function verifiedBytes(bytes, row) {
  return bytes.length === row.byte_length && sha(bytes) === row.sha256;
}

async function archive(ctx, path, bytes, kind) {
  const compressed = kind === 'historical';
  const body = compressed ? gzipSync(bytes) : bytes;
  const directory = join(ctx.evidenceRoot, 'host', 'runtime-cleanup');
  await inspectPath(ctx.repoRoot, directory, 'directory', { create: true });
  const stored = join(directory, sha(bytes).slice(7) + (compressed ? '.gz' : '.bin'));
  await writeImmutable(stored, body);
  const observed = await readFile(stored);
  if (!observed.equals(body) || compressed && !gunzipSync(observed).equals(bytes)) fail('READING_RUNTIME_ARCHIVE_CHANGED', { path: stored });
  return { original_path: display(ctx.repoRoot, path), archive_path: display(ctx.repoRoot, stored),
    kind, encoding: compressed ? 'gzip' : 'raw', sha256: sha(bytes), byte_length: bytes.length, archive_sha256: sha(body) };
}

async function currentPaths(ctx) {
  if (!await inspectPath(ctx.repoRoot, join(ctx.repoRoot, '.apa-v3/phase22/COMMITTED.json'), 'file')) return [];
  const { readRegisteredCommit } = await import('./phase22-active-version.mjs');
  const current = await readRegisteredCommit({ vaultRoot: ctx.repoRoot });
  if (!current.ok) fail('READING_RUNTIME_CURRENT_REGISTRY_REQUIRED', { errors: current.errors });
  const paths = [];
  const temporary = join(ctx.repoRoot, '.tmp'), snapshots = join(ctx.repoRoot, '.runtime', 'apa-code');
  const visit = value => {
    if (typeof value === 'string') {
      const path = resolve(ctx.repoRoot, value);
      if (inside(temporary, path) || inside(snapshots, path)) paths.push(path);
    } else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(current.generation);
  visit(current.index);
  return paths;
}

async function ownedTree(ctx, directory, filePaths, directories, retained) {
  if (!await inspectPath(ctx.repoRoot, directory, 'directory')) return;
  directories.add(directory);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && filePaths.some(file => inside(path, file))) {
      await ownedTree(ctx, path, filePaths, directories, retained);
    } else if (!filePaths.includes(path)) retained.push({ path: display(ctx.repoRoot, path), reason: 'unregistered' });
  }
}

async function archiveControllerEvidence(ctx) {
  const statePath = join(ctx.runRoot, 'control', 'science-state.json');
  if (!await inspectPath(ctx.runRoot, statePath, 'file')) return [];
  const { fingerprintV3Json } = await import('./semantic-package-validator.mjs');
  const bytes = await readFile(statePath);
  const { schema_version, data, fingerprint } = JSON.parse(bytes);
  const control = data?.prepared?.runControl;
  const actor = control?.reading_first_binding?.controller_actor_id;
  if (schema_version !== 'science-controller-state-1.0' || fingerprintV3Json(data) !== fingerprint
    || control?.run_id !== ctx.runId || data.prepared.paths?.runRoot !== ctx.runRoot || !nonempty(actor)) {
    fail('READING_RUNTIME_HOST_RECORD_INVALID', { path: statePath });
  }
  const archives = [await archive(ctx, statePath, bytes, 'science-host-record')];
  const checkpoints = data.brokerConfig.authorized_bindings.filter(row => row.run_id === ctx.runId && row.actor_id === actor
    && row.role === 'control' && /^\d+$/.test(row.revision) && row.artifact_path === `control/reading-checkpoint-${row.revision}.json`)
    .sort((a, b) => Number(b.revision) - Number(a.revision));
  for (const task of checkpoints) {
    const artifactId = 'reading-checkpoint-' + task.revision;
    const receiptPath = join(ctx.runRoot, '.phase21-receipts', artifactId + '.json');
    if (!await inspectPath(ctx.runRoot, receiptPath, 'file')) continue;
    const receiptBytes = await readFile(receiptPath), receipt = JSON.parse(receiptBytes);
    const path = join(ctx.runRoot, task.artifact_path);
    if (receipt.run_id !== ctx.runId || receipt.owner_actor_id !== actor || receipt.role !== 'control'
      || receipt.artifact_id !== artifactId || receipt.path !== task.artifact_path || receipt.revision !== task.revision
      || !await inspectPath(ctx.runRoot, path, 'file')) fail('READING_RUNTIME_HOST_RECORD_INVALID', { path });
    const checkpoint = await readFile(path);
    if (!verifiedBytes(checkpoint, receipt)) fail('READING_RUNTIME_HOST_RECORD_INVALID', { path });
    archives.push(await archive(ctx, path, checkpoint, 'reading-host-record'),
      await archive(ctx, receiptPath, receiptBytes, 'reading-host-receipt'));
    break;
  }
  return archives;
}

async function planFiles(ctx, manifests) {
  const archives = await archiveControllerEvidence(ctx);
  const retained = [], files = [], directories = new Set();
  const rows = await ownedRows(ctx);
  const known = rows.filter(row => row.kind !== 'directory').map(row => row.path);
  const patches = new Map(manifests.map(({ patch }) => [patch.path, patch]));
  for (const [path, receipt] of patches) {
    const patch = join(ctx.runRoot, path);
    if (!await inspectPath(ctx.runRoot, patch, 'file')) fail('READING_RUNTIME_PATCH_REQUIRED', { path: patch });
    const bytes = await readFile(patch);
    if (!verifiedBytes(bytes, receipt)) fail('READING_RUNTIME_CLEANUP_BYTES_CHANGED', { path: patch });
    archives.push(await archive(ctx, patch, bytes, 'runtime-patch'));
  }
  for (const row of rows) {
    if (row.kind === 'directory') {
      await ownedTree(ctx, row.path, known, directories, retained);
      continue;
    }
    const boundary = sourceBoundary(ctx, row.path, row.kind);
    if (!await inspectPath(boundary, row.path, 'file')) {
      if (row.kind !== 'temporary') fail('READING_RUNTIME_ARCHIVE_SOURCE_MISSING', { path: row.path });
      retained.push({ path: display(ctx.repoRoot, row.path), reason: 'missing' });
      continue;
    }
    const original = await readFile(row.path);
    if (!verifiedBytes(original, row)) {
      if (row.kind !== 'temporary') fail('READING_RUNTIME_CLEANUP_BYTES_CHANGED', { path: row.path });
      retained.push({ path: display(ctx.repoRoot, row.path), reason: 'bytes-changed' });
      continue;
    }
    if (row.kind !== 'temporary') archives.push(await archive(ctx, row.path, original, row.kind));
    if (boundary !== ctx.runRoot) files.push(row);
  }
  return { archives, retained, files, directories: [...directories].sort((a, b) => b.length - a.length) };
}

async function removeSnapshotTree(root, directory, known) {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const row = known.get(path);
    if (entry.isDirectory() && [...known.keys()].some(file => inside(path, file))) await removeSnapshotTree(root, path, known);
    else if (inside(root, path) && entry.isFile() && row && verifiedBytes(await readFile(path), row)) {
      await chmod(path, 0o600);
      await unlink(path);
    }
    else fail('READING_RUNTIME_CLEANUP_PATH', { path });
  }
  await rmdir(directory);
}

function referenceManifests(ref) {
  return [ref.manifest, ...(ref.previous_manifests ?? []), ...(ref.pending_manifest ? [ref.pending_manifest] : [])];
}

function recordVersions(root, directory, include) {
  if (!pathState(root, directory, 'directory')) return [];
  return readdirSync(directory).filter(name => include.test(name)).sort()
    .map(name => [name, pathState(root, join(directory, name), 'file')?.version ?? null]);
}

const COMMIT_FILE = '.apa-v3/phase22/COMMITTED.json';
const REF_RECORD = /^[a-zA-Z0-9_-]+\.json$/;
const OWNED_RECORD = /^[a-f0-9]{64}\.json$/;
const referenceVersions = ctx => json(recordVersions(ctx.repoRoot, join(ctx.repoRoot, '.runtime', 'apa-code-refs'), REF_RECORD));
const ownershipVersions = runRoot => json(recordVersions(runRoot, join(runRoot, OWNERSHIP), OWNED_RECORD));
const commitVersion = ctx => pathState(ctx.repoRoot, join(ctx.repoRoot, COMMIT_FILE), 'file')?.version;
const protects = (paths, path) => paths.some(consumer => consumer === path || inside(consumer, path));
async function captureProtection(ctx) {
  const refVersion = referenceVersions(ctx), committed = commitVersion(ctx);
  const refs = listReadingRuntimeSnapshotReferences(ctx);
  const others = refs.filter(row => row.run_id !== ctx.runId);
  const ownedVersions = others.map(row => [row.run_root, ownershipVersions(row.run_root)]);
  const commitCurrent = () => committed === commitVersion(ctx);
  let paths;
  try { paths = await currentPaths(ctx); }
  catch (error) {
    if (!commitCurrent()) return null;
    throw error;
  }
  for (const other of others) paths.push(...(await ownedRows({ ...ctx, runRoot: other.run_root })).map(row => row.path));
  return {
    refs, paths, commitCurrent,
    hashes: new Set(others.flatMap(other => referenceManifests(other).map(row => row.snapshot_hash))),
    current: () => refVersion.equals(referenceVersions(ctx))
      && ownedVersions.every(([root, version]) => version.equals(ownershipVersions(root))) && commitCurrent(),
  };
}

function retirementTargets(ctx, plan) {
  const targets = [];
  const base = join(ctx.repoRoot, '.runtime', 'apa-code', '.retired-files-' + ctx.runId);
  for (const row of plan.files) targets.push({ path: row.path, retired: join(base, sha(row.path).slice(7)), type: 'file', row });
  for (const path of plan.directories) targets.push({ path, retired: join(base, sha(path).slice(7)), type: 'directory' });
  const snapshots = new Map();
  for (const manifest of plan.manifests) {
    if (snapshots.has(manifest.snapshot_hash)) continue;
    snapshots.set(manifest.snapshot_hash, manifest);
    targets.push({ path: manifest.code_root, retired: join(dirname(manifest.code_root), '.retired-' + manifest.snapshot_hash.slice(7) + '-' + ctx.runId),
      type: 'snapshot', manifest });
  }
  return { base, targets };
}

async function observeRetirement(ctx, targets, ref) {
  const observations = [];
  for (const { type, path, retired, row, manifest } of targets) {
    const target = { path, retired_path: retired };
    const kind = type === 'file' ? 'file' : 'directory';
    const existing = pathState(ctx.repoRoot, retired, kind);
    // Old cleanup plans may have left a retired snapshot behind, even after releasing the reference.
    if (existing && type !== 'snapshot') fail('READING_RUNTIME_CLEANUP_RECORD_CONFLICT', { path: retired });
    if (existing) {
      observations.push({ ...target, ...existing, legacy_retired: true });
      continue;
    }
    const current = pathState(ctx.repoRoot, path, kind);
    if (!current || !ref) {
      observations.push({ ...target, status: current ? 'unowned' : 'missing' });
      continue;
    }
    if (type === 'snapshot') verifyReadingRuntimeSnapshot({ manifest, repoRoot: ctx.repoRoot, runRoot: ctx.runRoot });
    if (type === 'file' && !verifiedBytes(await readFile(path), row)) {
      observations.push({ ...target, status: 'bytes-changed' });
      continue;
    }
    observations.push({ ...target, ...current });
  }
  return observations;
}

function checkRetirementRecord(ctx, record, targets, file) {
  const { observations, outcomes } = record;
  if (record.profile !== PROFILE || record.run_id !== ctx.runId
    || !Array.isArray(observations) || observations.length !== targets.length
    || file === RETIRED_FILE && (!Array.isArray(outcomes) || outcomes.length !== targets.length)) {
    fail('READING_RUNTIME_CLEANUP_RECORD_CONFLICT', { path: join(ctx.runRoot, file) });
  }
  for (const [index, target] of targets.entries()) {
    const item = observations[index];
    if (item?.path !== target.path || item.retired_path !== target.retired || item.legacy_retired && target.type !== 'snapshot'
      || (item.status ? !['missing', 'unowned', 'bytes-changed'].includes(item.status) : !nonempty(item.identity) || !nonempty(item.version))
      || file === RETIRED_FILE && (!['moved', 'live-reference', 'missing', 'bytes-changed', 'not-empty', 'unowned'].includes(outcomes[index])
        || outcomes[index] === 'moved' && item.status)) {
      fail('READING_RUNTIME_CLEANUP_RECORD_CONFLICT', { path: target.path });
    }
  }
}

function retireTarget(ctx, protection, target, observed) {
  const { type, path, retired, manifest } = target;
  const kind = type === 'file' ? 'file' : 'directory';
  const previous = pathState(ctx.repoRoot, retired, kind);
  if (previous) {
    if (previous.identity !== observed.identity) fail('READING_RUNTIME_CLEANUP_RECORD_CONFLICT', { path: retired });
    return 'moved';
  }
  if (type === 'snapshot' && protection.hashes.has(manifest.snapshot_hash) || protects(protection.paths, path)
    || type === 'directory' && protection.paths.some(consumer => inside(path, consumer))) return 'live-reference';
  if (observed.status) return observed.status;
  if (observed.legacy_retired) return 'missing';
  const current = pathState(ctx.repoRoot, path, kind);
  if (!current) return 'missing';
  if (type === 'directory') {
    // Child claims change the parent timestamps. Only move the same, empty directory.
    if (current.identity !== observed.identity) return 'bytes-changed';
    if (readdirSync(path).length) return 'not-empty';
  } else if (current.version !== observed.version) return 'bytes-changed';
  if (!protection.commitCurrent()) return null;
  try { renameSync(path, retired); }
  catch (error) {
    if (['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) error.retirementRetryable = true;
    throw error;
  }
  if (pathState(ctx.repoRoot, retired, kind)?.identity !== observed.identity) {
    fail('READING_RUNTIME_CLEANUP_RECORD_CONFLICT', { path: retired });
  }
  return 'moved';
}

function finishRetirementClaim(ctx, manifest, plan, observed, { base, targets }, protection) {
  return withReadingRuntimeSnapshotLock(ctx, () => {
    if (!protection.current()) return null;
    const ref = protection.refs.find(row => row.run_id === ctx.runId);
    if (ref?.pending_manifest) fail('READING_RUNTIME_SNAPSHOT_REBIND_PENDING');
    if (ref && (ref.run_root !== ctx.runRoot || ref.fingerprint !== manifest.fingerprint
      || json(referenceManifests(ref)).compare(json(plan.manifests)) !== 0)) {
      fail('READING_RUNTIME_SNAPSHOT_REFERENCE_MISMATCH');
    }
    const completedPath = join(ctx.runRoot, RETIRED_FILE);
    const completed = readRecordSync(ctx.runRoot, completedPath);
    if (completed) {
      checkRetirementRecord(ctx, completed, targets, RETIRED_FILE);
      if (ref) releaseReadingRuntimeSnapshotReference({ ...ctx, expectedFingerprint: manifest.fingerprint, lockHeld: true });
      return completed;
    }
    const claimPath = join(ctx.runRoot, CLAIM_FILE);
    let claim = readRecordSync(ctx.runRoot, claimPath);
    if (claim) checkRetirementRecord(ctx, claim, targets, CLAIM_FILE);
    else {
      claim = { profile: PROFILE, run_id: ctx.runId, observations: observed };
      writeImmutableSync(ctx.runRoot, claimPath, json(claim));
    }
    if (targets.some(target => target.type !== 'snapshot')) {
      try { mkdirSync(base); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      pathState(ctx.repoRoot, base, 'directory');
    }
    const outcomes = [];
    for (const [index, target] of targets.entries()) {
      const outcome = retireTarget(ctx, protection, target, claim.observations[index]);
      if (outcome === null) return null;
      outcomes.push(outcome);
    }
    const retired = { ...claim, outcomes };
    writeImmutableSync(ctx.runRoot, completedPath, json(retired));
    if (ref) releaseReadingRuntimeSnapshotReference({ ...ctx, expectedFingerprint: manifest.fingerprint, lockHeld: true });
    return retired;
  });
}

async function deleteRetired(ctx, plan, { base, targets }, claim) {
  const retained = [...plan.retained], removed = [], snapshots = [];
  for (const [index, target] of targets.entries()) {
    const { path, retired, type, row, manifest } = target;
    const outcome = claim.outcomes[index];
    if (outcome === 'moved') {
      const kind = type === 'file' ? 'file' : 'directory';
      const current = pathState(ctx.repoRoot, retired, kind);
      if (current) {
        if (current.identity !== claim.observations[index].identity) fail('READING_RUNTIME_CLEANUP_RECORD_CONFLICT', { path: retired });
        if (type === 'snapshot') {
          const known = new Map(manifest.files.map(row => [join(retired, row.path), row]));
          await removeSnapshotTree(retired, retired, known);
        } else if (type === 'directory') await rmdir(retired);
        else {
          if (!verifiedBytes(await readFile(retired), row)) fail('READING_RUNTIME_CLEANUP_BYTES_CHANGED', { path: retired });
          await unlink(retired);
        }
      }
    }
    if (type === 'snapshot') {
      const hash = manifest.snapshot_hash;
      const currentlyReferenced = outcome === 'live-reference' || listReadingRuntimeSnapshotReferences(ctx)
        .some(ref => referenceManifests(ref).some(item => item.snapshot_hash === hash));
      const status = currentlyReferenced ? 'referenced' : ['moved', 'missing'].includes(outcome) ? 'removed' : 'retained';
      const patch = display(ctx.repoRoot, join(ctx.runRoot, manifest.patch.path));
      snapshots.push({ snapshot_hash: hash, status, original_path: display(ctx.repoRoot, path), git_commit: manifest.git_commit,
        patch_archive_path: plan.archives.find(row => row.kind === 'runtime-patch' && row.original_path === patch)?.archive_path });
    } else if (type === 'file' && (outcome === 'moved' || outcome === 'missing')) removed.push(display(ctx.repoRoot, path));
    else if (type === 'file') retained.push({ path: display(ctx.repoRoot, path), reason: outcome });
  }
  if (await inspectPath(ctx.repoRoot, base, 'directory')) {
    try { await rmdir(base); } catch (error) { if (error.code !== 'ENOTEMPTY') throw error; }
  }
  return { retained, removed, snapshots };
}

async function finishCleanup(ctx, manifest, terminal, ref) {
  const resultPath = join(ctx.runRoot, RESULT_FILE), planPath = join(ctx.runRoot, PLAN_FILE);
  const previous = await readRecord(ctx.runRoot, resultPath);
  if (previous) return previous;
  let plan = await readRecord(ctx.runRoot, planPath);
  if (!plan) {
    if (!ref) fail('READING_RUNTIME_SNAPSHOT_REFERENCE_REQUIRED');
    const manifests = referenceManifests(ref);
    for (const item of manifests) verifyReadingRuntimeSnapshot({ manifest: item, repoRoot: ctx.repoRoot, runRoot: ctx.runRoot });
    plan = { profile: PROFILE, run_id: ctx.runId, manifests, ...await planFiles(ctx, manifests) };
    await writeImmutable(planPath, json(plan));
  } else if (plan.profile !== PROFILE || plan.run_id !== ctx.runId || plan.manifests?.[0]?.fingerprint !== manifest.fingerprint) {
    fail('READING_RUNTIME_CLEANUP_RECORD_CONFLICT', { path: planPath });
  }
  for (const item of plan.manifests) validateReadingRuntimeSnapshotManifest({ manifest: item, repoRoot: ctx.repoRoot });
  const owned = new Map((await ownedRows(ctx)).map(row => [row.path, row]));
  for (const row of plan.archives) {
    const path = join(ctx.repoRoot, row.archive_path);
    if (!await inspectPath(ctx.evidenceRoot, path, 'file') || sha(await readFile(path)) !== row.archive_sha256) {
      fail('READING_RUNTIME_ARCHIVE_CHANGED', { path });
    }
  }
  for (const row of plan.files) {
    const registered = owned.get(row.path);
    if (!registered || registered.kind !== row.kind || registered.sha256 !== row.sha256 || registered.byte_length !== row.byte_length
      || sourceBoundary(ctx, row.path, row.kind) !== ctx.repoRoot) fail('READING_RUNTIME_CLEANUP_PATH', { path: row.path });
  }
  const ownedDirs = [...owned.values()].filter(row => row.kind === 'directory').map(row => row.path);
  for (const path of plan.directories) {
    if (sourceBoundary(ctx, path, 'directory') !== ctx.repoRoot || !ownedDirs.some(directory => path === directory || inside(directory, path))) {
      fail('READING_RUNTIME_CLEANUP_PATH', { path });
    }
  }
  const retirement = retirementTargets(ctx, plan);
  const priorClaim = await readRecord(ctx.runRoot, join(ctx.runRoot, CLAIM_FILE));
  const observed = priorClaim ? null : await observeRetirement(ctx, retirement.targets, ref);
  let claim = !ref && await readRecord(ctx.runRoot, join(ctx.runRoot, RETIRED_FILE));
  const waits = [20, 60, 120, 240];
  let renameAttempts = 0;
  while (!claim) {
    const protection = await captureProtection(ctx);
    if (!protection) continue;
    try { claim = finishRetirementClaim(ctx, manifest, plan, observed, retirement, protection); }
    catch (error) {
      if (!error.retirementRetryable || renameAttempts === waits.length) throw error;
      await setTimeout(waits[renameAttempts++]);
    }
  }
  checkRetirementRecord(ctx, claim, retirement.targets, RETIRED_FILE);
  const { retained, removed, snapshots } = await deleteRetired(ctx, plan, retirement, claim);
  const result = { profile: PROFILE, status: 'complete', run_id: ctx.runId, terminal: terminal.status,
    snapshot_hash: manifest.snapshot_hash, snapshot_status: snapshots[0].status, snapshots, removed, retained, archives: plan.archives };
  await writeImmutable(resultPath, json(result));
  return result;
}

/** Finish only after the caller that was executing snapshot code has exited. */
export async function cleanupReadingRuntimeRun({ manifest, publication, consumerHeld = false, ...options } = {}) {
  return operateCleanup({ options, manifest, consumerHeld, requested: publication && { status: 'published', publication } });
}

export async function closeReadingRuntimeRun({ manifest, terminal, consumerHeld = false, deferCleanup = false, ...options } = {}) {
  if (!['completed_with_limits', 'terminated'].includes(terminal?.status)) fail('READING_RUNTIME_TERMINAL_INVALID');
  const { status, authorization_id, user_reply } = terminal;
  return operateCleanup({ options, manifest, consumerHeld, deferCleanup, requested: { status, authorization_id, user_reply } });
}

async function operateCleanup({ options, manifest, consumerHeld, deferCleanup, requested }) {
  const ctx = await bindRun(options);
  const operation = async () => {
    const ref = readReadingRuntimeSnapshotReference(ctx);
    const plan = ref ? null : await readRecord(ctx.runRoot, join(ctx.runRoot, PLAN_FILE));
    manifest ??= ref?.manifest ?? plan?.manifests?.[0];
    if (manifest?.profile !== SNAPSHOT || !hashValue(manifest.snapshot_hash) || !hashValue(manifest.fingerprint)) {
      return { status: 'unregistered-runtime' };
    }
    validateReadingRuntimeSnapshotManifest({ manifest, repoRoot: ctx.repoRoot });
    if (!ref && !plan) fail('READING_RUNTIME_SNAPSHOT_REFERENCE_REQUIRED');
    if (ref && (ref.run_root !== ctx.runRoot || ref.fingerprint !== manifest.fingerprint)) {
      fail('READING_RUNTIME_SNAPSHOT_REFERENCE_MISMATCH');
    }
    if (ref?.pending_manifest) fail('READING_RUNTIME_SNAPSHOT_REBIND_PENDING');
    const terminal = await terminalRecord(ctx, manifest, requested);
    const active = ref ? referenceManifests(ref) : plan.manifests;
    if (deferCleanup || active.some(item => inside(item.code_root, scriptPath))) return { terminal, cleanup_pending: true };
    return finishCleanup(ctx, manifest, terminal, ref);
  };
  return consumerHeld ? operation() : withReadingRuntimeConsumer(ctx, operation);
}

export async function withReadingRuntimePublicationConsumer(options, callback) {
  const { manifest } = options;
  if (manifest?.profile !== SNAPSHOT) return callback();
  return withReadingRuntimeConsumer(options, async () => {
    const ref = readReadingRuntimeSnapshotReference(options);
    if (ref?.run_root !== options.runRoot || ref.fingerprint !== manifest.fingerprint || ref.pending_manifest
      || await readReadingRuntimeTerminal(options)) fail('READING_RUNTIME_SNAPSHOT_REFERENCE_MISMATCH');
    return callback();
  });
}

export async function cleanupPublishedReadingRuntime({ repoRoot, runId, runRoot, manifest, publication, consumerHeld }) {
  if (manifest?.profile !== SNAPSHOT) return { status: 'unregistered-runtime' };
  return cleanupReadingRuntimeRun({ repoRoot, runId, runRoot, manifest, publication, consumerHeld });
}
