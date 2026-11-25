import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { chmod, cp, link, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';

async function fixture(t) {
  const repoRoot = await mkdtemp(join(tmpdir(), 'apa-runtime-cleanup-'));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  const put = async (path, bytes) => {
    const target = join(repoRoot, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    return target;
  };
  await put('scripts/fixture.mjs', 'export const fixture = true;\n');
  await put('Schema/fixture.json', '{}\n');
  await put('prompts/fixture.md', 'Fixture\n');
  await put('docs/apa-v3/fixture.md', 'Fixture\n');
  await put('package.json', '{"type":"module"}\n');
  for (const args of [['init', '-q'], ['config', 'core.autocrlf', 'false'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']]) {
    execFileSync('git', args, { cwd: repoRoot });
  }
  const core = await import('../../scripts/v3/reading-runtime-snapshot.mjs');
  const run = async runId => {
    const runRoot = join(repoRoot, 'Eval', 'apa-v3', 'runs', runId);
    await mkdir(runRoot, { recursive: true });
    const manifest = core.prepareReadingRuntimeSnapshot({ repoRoot, codeRoot: repoRoot, runRoot, runId });
    core.registerReadingRuntimeSnapshotReference({ repoRoot, runId, runRoot, manifest });
    return { repoRoot, runId, runRoot, manifest };
  };
  return { put, run };
}

const terminal = { status: 'terminated', authorization_id: 'fixture-approval', user_reply: '终止阅读' };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function configureReadOnlyCleanup(put, current, originalPath) {
  const { fingerprintV3Json } = await import('../../scripts/v3/semantic-package-validator.mjs');
  const original = await stat(originalPath, { bigint: true });
  const location = { path: originalPath, sha256: 'sha256:' + sha256(await readFile(originalPath)),
    file_identity: { dev: String(original.dev), ino: String(original.ino), mtime_ns: String(original.mtimeNs) } };
  const data = { prepared: { paths: { runRoot: current.runRoot }, runControl: { run_id: current.runId,
    reading_first_binding: { controller_actor_id: 'controller', configured_setup: {
      source_access: 'read-only-original-1.0', source_locations: [location],
    } } } }, brokerConfig: { authorized_bindings: [] } };
  await put('Eval/apa-v3/runs/' + current.runId + '/control/science-state.json', JSON.stringify({
    schema_version: 'science-controller-state-1.0', data, fingerprint: fingerprintV3Json(data),
  }));
}

async function crossRunCleanupFixture(t, { currentClaimsPdf = false } = {}) {
  const { closeReadingRuntimeRun, registerReadingRuntimeCleanupFiles } = await import('../../scripts/v3/reading-runtime-cleanup.mjs');
  const { readReadingRuntimeSnapshotReference } = await import('../../scripts/v3/reading-runtime-snapshot.mjs');
  const { put, run } = await fixture(t);
  const legacy = await run('run-legacy'), current = await run('run-current');
  assert.equal(legacy.manifest.snapshot_hash, current.manifest.snapshot_hash);
  const pdfBytes = Buffer.from('%PDF-1.7\nlegacy source');
  const original = await put('Clippings/original.pdf', pdfBytes);
  const pdf = await put('.tmp/legacy/staged-copy.pdf', pdfBytes);
  const shared = await put('.tmp/shared/preview.md', 'shared');
  const ownBytes = Buffer.from([0, 13, 10, 255]);
  const own = await put('.tmp/current/role-output.bin', ownBytes);
  const sharedRow = { path: shared, kind: 'temporary' };
  const pdfRow = { path: pdf, kind: 'historical' };
  await registerReadingRuntimeCleanupFiles({ ...legacy, files: [pdfRow, sharedRow] });
  await registerReadingRuntimeCleanupFiles({ ...current,
    files: [sharedRow, { path: own, kind: 'historical' }, ...(currentClaimsPdf ? [pdfRow] : [])] });
  await configureReadOnlyCleanup(put, current, original);
  await closeReadingRuntimeRun({ ...current, terminal, deferCleanup: true });
  const legacyPdfRecord = join(legacy.runRoot, 'runtime-cleanup-owned', sha256(pdf) + '.json');
  const snapshotFile = join(current.manifest.code_root, 'scripts', 'fixture.mjs');
  const protectedHashes = new Map();
  for (const path of [pdf, original, shared, snapshotFile]) protectedHashes.set(path, sha256(await readFile(path)));
  const currentRef = readReadingRuntimeSnapshotReference(current);
  const legacyRef = readReadingRuntimeSnapshotReference(legacy);
  const assertProtected = async ({ currentReleased = false } = {}) => {
    for (const [path, hash] of protectedHashes) assert.equal(sha256(await readFile(path)), hash, path);
    assert.deepEqual(readReadingRuntimeSnapshotReference(legacy), legacyRef);
    assert.deepEqual(readReadingRuntimeSnapshotReference(current), currentReleased ? null : currentRef);
  };
  const assertUnclaimed = async () => {
    await assertProtected();
    assert.deepEqual(await readFile(own), ownBytes);
    await assert.rejects(readFile(join(current.runRoot, 'runtime-cleanup-claim.json')), { code: 'ENOENT' });
  };
  return { current, pdf, shared, own, ownBytes, legacyPdfRecord, assertProtected, assertUnclaimed };
}

test('terminal cleanup archives raw bytes and removes only registered temporary files and the last snapshot', async t => {
  const { closeReadingRuntimeRun, registerReadingRuntimeCleanupFiles } = await import('../../scripts/v3/reading-runtime-cleanup.mjs');
  const { put, run } = await fixture(t);
  const current = await run('run-a');
  const raw = Buffer.from([0, 13, 10, 255]);
  const host = await put('.tmp/run-a/raw', raw);
  const extra = await put('.tmp/run-a/unknown', 'untouched');
  const candidate = await put('.tmp/reading-first-candidates/stage-a/preview.md', 'preview');
  await registerReadingRuntimeCleanupFiles({ ...current, files: [{ path: host, kind: 'host' }, { path: candidate, kind: 'historical' }],
    directories: [dirname(host), dirname(candidate)] });
  const result = await closeReadingRuntimeRun({ ...current, terminal });
  assert.equal(result.snapshot_status, 'removed');
  await assert.rejects(readFile(join(current.manifest.code_root, 'scripts', 'fixture.mjs')), { code: 'ENOENT' });
  await assert.rejects(readFile(host), { code: 'ENOENT' });
  await assert.rejects(readFile(candidate), { code: 'ENOENT' });
  assert.equal(await readFile(extra, 'utf8'), 'untouched');
  assert.ok(result.retained.some(row => row.path === '.tmp/run-a/unknown' && row.reason === 'unregistered'));
  const archived = result.archives.find(row => row.original_path === '.tmp/run-a/raw');
  assert.deepEqual(await readFile(join(current.repoRoot, archived.archive_path)), raw);
  const preview = result.archives.find(row => row.original_path === '.tmp/reading-first-candidates/stage-a/preview.md');
  assert.equal(gunzipSync(await readFile(join(current.repoRoot, preview.archive_path))).toString('utf8'), 'preview');
  assert.ok(result.archives.some(row => row.kind === 'runtime-patch'));
  assert.deepEqual(await closeReadingRuntimeRun({ ...current, terminal }), result);
});

test('another live run keeps its shared snapshot and shared temporary file', async t => {
  const { closeReadingRuntimeRun, registerReadingRuntimeCleanupFiles } = await import('../../scripts/v3/reading-runtime-cleanup.mjs');
  const { put, run } = await fixture(t);
  const first = await run('run-first'), second = await run('run-second');
  assert.equal(first.manifest.snapshot_hash, second.manifest.snapshot_hash);
  const shared = await put('.tmp/shared/preview.md', 'shared');
  for (const entry of [first, second]) await registerReadingRuntimeCleanupFiles({ ...entry, files: [{ path: shared, kind: 'temporary' }] });
  const result = await closeReadingRuntimeRun({ ...first, terminal });
  assert.equal(result.snapshot_status, 'referenced');
  assert.equal(await readFile(shared, 'utf8'), 'shared');
  assert.match(await readFile(join(first.manifest.code_root, 'scripts', 'fixture.mjs'), 'utf8'), /fixture/);
  const final = await closeReadingRuntimeRun({ ...second, terminal });
  assert.equal(final.snapshot_status, 'removed');
  await assert.rejects(readFile(shared), { code: 'ENOENT' });
});

async function testEvidenceCleanupFixture(t, { pending = false, upperCaseOwnerPath = false } = {}) {
  const { registerReadingRuntimeCleanupFiles } = await import('../../scripts/v3/reading-runtime-cleanup.mjs');
  const core = await import('../../scripts/v3/reading-runtime-snapshot.mjs');
  const { put, run } = await fixture(t);
  const owner = await run('evidence-owner'), consumer = await run('evidence-consumer');
  const evidenceBytes = Buffer.from('approved test transcript\n');
  const evidencePath = '.tmp/evidence-owner/verification.log';
  const evidence = await put(evidencePath, evidenceBytes);
  const ownedPath = upperCaseOwnerPath ? join(dirname(evidence), 'verification.LOG') : evidence;
  await registerReadingRuntimeCleanupFiles({ ...owner, files: [{ path: ownedPath, kind: 'temporary' }] });
  await put('scripts/fixture.mjs', 'export const fixture = false;\n');
  const manifest = core.prepareReadingRuntimeSnapshot({ ...consumer, codeRoot: consumer.repoRoot });
  const rebound = { ...consumer, manifest, expectedFingerprint: consumer.manifest.fingerprint };
  const receipt = { path: evidence, sha256: 'sha256:' + sha256(evidenceBytes), byte_length: evidenceBytes.length };
  core.registerReadingRuntimeSnapshotReference({ ...rebound, pending: true, testEvidence: [receipt],
    pendingCheckpoint: { artifact_id: 'session-state-1', sha256: 'sha256:' + 'a'.repeat(64), byte_length: 17 } });
  if (!pending) core.registerReadingRuntimeSnapshotReference(rebound);
  return { owner, consumer: pending ? consumer : { ...consumer, manifest }, evidence, evidencePath, evidenceBytes };
}

for (const pending of [false, true]) {
  test(`cleanup protects test evidence of another run’s ${pending ? 'pending' : 'active'} runtime reference without transferring ownership`, async t => {
    const { closeReadingRuntimeRun } = await import('../../scripts/v3/reading-runtime-cleanup.mjs');
    const { readReadingRuntimeSnapshotReference } = await import('../../scripts/v3/reading-runtime-snapshot.mjs');
    const { owner, consumer, evidence, evidencePath, evidenceBytes } = await testEvidenceCleanupFixture(t, { pending });
    const consumerRef = readReadingRuntimeSnapshotReference(consumer);
    const result = await closeReadingRuntimeRun({ ...owner, terminal });
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.retained, [{ path: evidencePath, reason: 'live-reference' }]);
    assert.deepEqual(await readFile(evidence), evidenceBytes);
    assert.equal(readReadingRuntimeSnapshotReference(owner), null);
    assert.deepEqual(readReadingRuntimeSnapshotReference(consumer), consumerRef);
    if (!pending) {
      const final = await closeReadingRuntimeRun({ ...consumer, terminal });
      assert.deepEqual(final.removed, []);
      assert.ok(!final.archives.some(row => row.original_path === evidencePath));
      assert.equal(readReadingRuntimeSnapshotReference(consumer), null);
      assert.deepEqual(await readFile(evidence), evidenceBytes);
    }
  });
}

test('an owner reclaims test evidence once the other runtime releases its dependency', async t => {
  const { closeReadingRuntimeRun } = await import('../../scripts/v3/reading-runtime-cleanup.mjs');
  const { readReadingRuntimeSnapshotReference } = await import('../../scripts/v3/reading-runtime-snapshot.mjs');
  const { owner, consumer, evidence, evidencePath, evidenceBytes } = await testEvidenceCleanupFixture(t);
  const consumerResult = await closeReadingRuntimeRun({ ...consumer, terminal });
  assert.deepEqual(consumerResult.removed, []);
  assert.equal(readReadingRuntimeSnapshotReference(consumer), null);
  assert.deepEqual(await readFile(evidence), evidenceBytes);
  const result = await closeReadingRuntimeRun({ ...owner, terminal });
  assert.deepEqual(result.removed, [evidencePath]);
  await assert.rejects(readFile(evidence), { code: 'ENOENT' });
  assert.equal(readReadingRuntimeSnapshotReference(owner), null);
});

test('Windows cleanup protects a test evidence path from an ownership record with different casing',
  { skip: process.platform !== 'win32' }, async t => {
    const { closeReadingRuntimeRun } = await import('../../scripts/v3/reading-runtime-cleanup.mjs');
    const { readReadingRuntimeSnapshotReference } = await import('../../scripts/v3/reading-runtime-snapshot.mjs');
    const { owner, consumer, evidence, evidenceBytes } = await testEvidenceCleanupFixture(t, { upperCaseOwnerPath: true });
    const consumerRef = readReadingRuntimeSnapshotReference(consumer);
    const result = await closeReadingRuntimeRun({ ...owner, terminal });
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.retained, [{ path: '.tmp/evidence-owner/verification.LOG', reason: 'live-reference' }]);
    assert.deepEqual(await readFile(evidence), evidenceBytes);
    assert.equal(readReadingRuntimeSnapshotReference(owner), null);
    assert.deepEqual(readReadingRuntimeSnapshotReference(consumer), consumerRef);
  });

test('cleanup rejects a malformed test evidence dependency before moving files or releasing the owner reference', async t => {
  const { closeReadingRuntimeRun } = await import('../../scripts/v3/reading-runtime-cleanup.mjs');
  const { readReadingRuntimeSnapshotReference } = await import('../../scripts/v3/reading-runtime-snapshot.mjs');
  const { owner, consumer, evidence, evidencePath, evidenceBytes } = await testEvidenceCleanupFixture(t);
  const ownerRef = readReadingRuntimeSnapshotReference(owner);
  const refPath = join(consumer.repoRoot, '.runtime', 'apa-code-refs', consumer.runId + '.json');
  const corrupted = Buffer.from(JSON.stringify({ ...readReadingRuntimeSnapshotReference(consumer), test_evidence_paths: [evidencePath] }));
  await writeFile(refPath, corrupted);
  await assert.rejects(closeReadingRuntimeRun({ ...owner, terminal }), {
    code: 'READING_RUNTIME_REFERENCE_INVALID', details: { path: refPath },
  });
  assert.deepEqual(await readFile(evidence), evidenceBytes);
  assert.deepEqual(readReadingRuntimeSnapshotReference(owner), ownerRef);
  assert.deepEqual(await readFile(refPath), corrupted);
  await assert.rejects(readFile(join(owner.runRoot, 'runtime-cleanup-claim.json')), { code: 'ENOENT' });
});

test('cleanup stops before moving files when a legacy runtime has unreadable test evidence history', async t => {
  const { closeReadingRuntimeRun } = await import('../../scripts/v3/reading-runtime-cleanup.mjs');
  const { readReadingRuntimeSnapshotReference } = await import('../../scripts/v3/reading-runtime-snapshot.mjs');
  const { owner, consumer, evidence, evidenceBytes } = await testEvidenceCleanupFixture(t);
  const ownerRef = readReadingRuntimeSnapshotReference(owner);
  const consumerRef = readReadingRuntimeSnapshotReference(consumer);
  delete consumerRef.test_evidence_paths;
  const refPath = join(consumer.repoRoot, '.runtime', 'apa-code-refs', consumer.runId + '.json');
  await writeFile(refPath, JSON.stringify(consumerRef));
  const statePath = join(consumer.runRoot, 'control', 'science-state.json');
  await mkdir(dirname(statePath));
  await writeFile(statePath, '{}');
  await assert.rejects(closeReadingRuntimeRun({ ...owner, terminal }), {
    code: 'READING_SESSION_STATE_INVALID', details: { path: statePath },
  });
  assert.deepEqual(await readFile(evidence), evidenceBytes);
  assert.deepEqual(readReadingRuntimeSnapshotReference(owner), ownerRef);
  assert.deepEqual(readReadingRuntimeSnapshotReference(consumer), consumerRef);
  await assert.rejects(readFile(join(owner.runRoot, 'runtime-cleanup-claim.json')), { code: 'ENOENT' });
});

for (const [marker, relativePath] of [
  ['session checkpoint file', 'control/session-state-1.json'],
  ['session checkpoint receipt', '.phase21-receipts/session-state-1.json'],
  ['pending checkpoint reference', null],
]) {
  test(`cleanup stops when legacy science state is missing but a ${marker} survives`, async t => {
    const { closeReadingRuntimeRun } = await import('../../scripts/v3/reading-runtime-cleanup.mjs');
    const { readReadingRuntimeSnapshotReference } = await import('../../scripts/v3/reading-runtime-snapshot.mjs');
    const { owner, consumer, evidence, evidenceBytes } = await testEvidenceCleanupFixture(t, { pending: !relativePath });
    const ownerRef = readReadingRuntimeSnapshotReference(owner);
    const consumerRef = readReadingRuntimeSnapshotReference(consumer);
    delete consumerRef.test_evidence_paths;
    delete consumerRef.pending_test_evidence_paths;
    const refPath = join(consumer.repoRoot, '.runtime', 'apa-code-refs', consumer.runId + '.json');
    await writeFile(refPath, JSON.stringify(consumerRef));
    if (relativePath) {
      const markerPath = join(consumer.runRoot, relativePath);
      await mkdir(dirname(markerPath));
      await writeFile(markerPath, '{}');
    }
    const statePath = join(consumer.runRoot, 'control', 'science-state.json');
    await assert.rejects(closeReadingRuntimeRun({ ...owner, terminal }), {
      code: 'READING_SESSION_STATE_INVALID', details: { path: statePath },
    });
    assert.deepEqual(await readFile(evidence), evidenceBytes);
    assert.deepEqual(readReadingRuntimeSnapshotReference(owner), ownerRef);
    assert.deepEqual(readReadingRuntimeSnapshotReference(consumer), consumerRef);
    await assert.rejects(readFile(join(owner.runRoot, 'runtime-cleanup-claim.json')), { code: 'ENOENT' });
  });
}

for (const retry of [false, true]) {
  test(`read-only cleanup ${retry ? 'resumes a durable plan' : 'finishes on the first call'} with a legacy PDF owner`, async t => {
    const { cleanupReadingRuntimeRun } = await import('../../scripts/v3/reading-runtime-cleanup.mjs');
    const { current, own, ownBytes, legacyPdfRecord, assertProtected, assertUnclaimed } = await crossRunCleanupFixture(t);
    const planPath = join(current.runRoot, 'runtime-cleanup-plan.json');
    await writeFile(legacyPdfRecord + '.4eed67a6-5103-435e-8944-c4f4a36f9d56.tmp', '{');
    let savedPlan;
    if (retry) {
      const read = fs.readFile;
      const interception = t.mock.method(fs, 'readFile', async (path, ...args) => {
        if (path === legacyPdfRecord) throw Object.assign(new Error('interrupted while reading ownership'), { code: 'EIO' });
        return read(path, ...args);
      });
      syncBuiltinESMExports();
      try {
        await assert.rejects(cleanupReadingRuntimeRun(current), { code: 'EIO' });
      } finally {
        interception.mock.restore();
        syncBuiltinESMExports();
      }
      savedPlan = await readFile(planPath);
      await assertUnclaimed();
    }
    const result = await cleanupReadingRuntimeRun(current);
    assert.deepEqual(result.removed, ['.tmp/current/role-output.bin']);
    assert.deepEqual(result.retained, [{ path: '.tmp/shared/preview.md', reason: 'live-reference' }]);
    assert.equal(result.snapshot_status, 'referenced');
    await assert.rejects(readFile(own), { code: 'ENOENT' });
    await assertProtected({ currentReleased: true });
    if (savedPlan) assert.deepEqual(await readFile(planPath), savedPlan);
    const archived = result.archives.find(row => row.original_path === '.tmp/current/role-output.bin');
    assert.equal(archived.sha256, 'sha256:' + sha256(ownBytes));
    const archiveBytes = await readFile(join(current.repoRoot, archived.archive_path));
    assert.equal(archived.archive_sha256, 'sha256:' + sha256(archiveBytes));
    assert.deepEqual(gunzipSync(archiveBytes), ownBytes);
  });
}

test('read-only cleanup rejects its own protected PDF output before moving files or releasing its reference', async t => {
  const { cleanupReadingRuntimeRun } = await import('../../scripts/v3/reading-runtime-cleanup.mjs');
  const { current, pdf, assertUnclaimed } = await crossRunCleanupFixture(t, { currentClaimsPdf: true });
  await assert.rejects(cleanupReadingRuntimeRun(current), { code: 'RF_READ_ONLY_SOURCE_OUTPUT_CONFLICT', details: { path: pdf } });
  await assertUnclaimed();
});

for (const [corruption, corrupt] of [
  ['mismatched filename', (row, shared) => JSON.stringify({ ...row, path: shared })],
  ['invalid JSON', () => '{'],
  ['non-string path', row => JSON.stringify({ ...row, path: 17 })],
]) {
  test(`cleanup rejects another run’s ownership row with ${corruption} before moving files or releasing its reference`, async t => {
    const { cleanupReadingRuntimeRun } = await import('../../scripts/v3/reading-runtime-cleanup.mjs');
    const { current, shared, legacyPdfRecord, assertUnclaimed } = await crossRunCleanupFixture(t);
    const row = JSON.parse(await readFile(legacyPdfRecord));
    await writeFile(legacyPdfRecord, corrupt(row, shared));
    await assert.rejects(cleanupReadingRuntimeRun(current), error => {
      assert.equal(error.code, 'READING_RUNTIME_CLEANUP_REGISTRATION');
      assert.equal(error.details.path, legacyPdfRecord);
      return true;
    });
    await assertUnclaimed();
  });
}

test('cleanup refuses a renamed ownership JSON that would otherwise leave a shared file unprotected', async t => {
  const { cleanupReadingRuntimeRun } = await import('../../scripts/v3/reading-runtime-cleanup.mjs');
  const { current, shared, legacyPdfRecord, assertUnclaimed } = await crossRunCleanupFixture(t);
  const directory = dirname(legacyPdfRecord);
  const badPath = join(directory, 'bad.json');
  await rename(join(directory, sha256(shared) + '.json'), badPath);
  await assert.rejects(cleanupReadingRuntimeRun(current), {
    code: 'READING_RUNTIME_CLEANUP_REGISTRATION', details: { path: badPath, reason: 'invalid-filename' },
  });
  await assertUnclaimed();
});

test('cleanup rechecks newly added noncanonical ownership JSON before claiming files', async t => {
  const { cleanupReadingRuntimeRun } = await import('../../scripts/v3/reading-runtime-cleanup.mjs');
  const { current, legacyPdfRecord, assertUnclaimed } = await crossRunCleanupFixture(t);
  const directory = dirname(legacyPdfRecord);
  const badPath = join(directory, 'bad.json');
  const bytes = await readFile(legacyPdfRecord);
  const readdir = fs.readdir;
  let added = false;
  const interception = t.mock.method(fs, 'readdir', async (path, ...args) => {
    const names = await readdir(path, ...args);
    if (path === directory && !added) {
      added = true;
      await writeFile(badPath, bytes);
    }
    return names;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(cleanupReadingRuntimeRun(current), {
      code: 'READING_RUNTIME_CLEANUP_REGISTRATION', details: { path: badPath, reason: 'invalid-filename' },
    });
  } finally {
    interception.mock.restore();
    syncBuiltinESMExports();
  }
  await assertUnclaimed();
});

test('read-only cleanup refuses PDF copies and aliases while reclaiming generated preview files', async t => {
  const { closeReadingRuntimeRun, registerReadingRuntimeCleanupFiles } = await import('../../scripts/v3/reading-runtime-cleanup.mjs');
  const { put, run } = await fixture(t);
  const current = await run('read-only-run');
  const originalPath = await put('Clippings/只读 原件.pdf', '%PDF-1.7\nsynthetic');
  const alias = join(current.runRoot, 'looks-like-host.json');
  await link(originalPath, alias);
  const copy = await put('.tmp/read-only/staged-copy.pdf', await readFile(originalPath));
  const original = await stat(originalPath, { bigint: true });
  await configureReadOnlyCleanup(put, current, originalPath);
  for (const row of [{ path: alias, kind: 'host' }, { path: copy, kind: 'historical' }]) {
    await assert.rejects(registerReadingRuntimeCleanupFiles({ ...current, files: [row] }), { code: 'RF_READ_ONLY_SOURCE_OUTPUT_CONFLICT' });
  }
  const preview = await put('.tmp/read-only/preview.md', 'preview');
  await registerReadingRuntimeCleanupFiles({ ...current, files: [{ path: preview, kind: 'historical' }], directories: [dirname(preview)] });
  const result = await closeReadingRuntimeRun({ ...current, terminal });
  assert.deepEqual(result.removed, ['.tmp/read-only/preview.md']);
  assert.ok(!result.archives.some(row => row.original_path === '.tmp/read-only/staged-copy.pdf'));
  assert.deepEqual(await readFile(originalPath), await readFile(copy));
  const final = await stat(originalPath, { bigint: true });
  assert.deepEqual([final.dev, final.ino, final.size, final.mtimeNs], [original.dev, original.ino, original.size, original.mtimeNs]);
});

test('cleanup waits for an active consumer and requires a durable terminal decision', async t => {
  const { cleanupReadingRuntimeRun, closeReadingRuntimeRun, withReadingRuntimeConsumer } = await import('../../scripts/v3/reading-runtime-cleanup.mjs');
  const { run } = await fixture(t);
  const current = await run('run-b');
  await assert.rejects(cleanupReadingRuntimeRun(current), { code: 'READING_RUNTIME_TERMINAL_REQUIRED' });
  await withReadingRuntimeConsumer(current, async () => {
    await assert.rejects(closeReadingRuntimeRun({ ...current, terminal }), { code: 'READING_RUNTIME_CONSUMER_ACTIVE' });
    const closed = await closeReadingRuntimeRun({ ...current, terminal, consumerHeld: true, deferCleanup: true });
    assert.equal(closed.cleanup_pending, true);
    assert.match(await readFile(join(current.manifest.code_root, 'scripts', 'fixture.mjs'), 'utf8'), /fixture/);
  });
  assert.equal((await cleanupReadingRuntimeRun(current)).snapshot_status, 'removed');
});

test('publication cleanup requires both successful publication records for the same committed transaction', async t => {
  const { cleanupReadingRuntimeRun } = await import('../../scripts/v3/reading-runtime-cleanup.mjs');
  const { put, run } = await fixture(t);
  const current = await run('run-c');
  const publication = { transaction_id: 'transaction-c', generation: 'generation-c' };
  const folder = 'Eval/apa-v3/runs/run-c/publication/';
  await put(folder + 'RESULT.md', '**发布结果**\n已提交代次 generation-c，事务 transaction-c。\n');
  await assert.rejects(cleanupReadingRuntimeRun({ ...current, publication }), { code: 'READING_RUNTIME_PUBLICATION_EVIDENCE_REQUIRED' });
  const journalPath = '.apa-v3/phase22/transactions/transaction-c/journal.json';
  await put(journalPath, JSON.stringify({ ...publication, run_id: current.runId, state: 'committed', vault_root: current.repoRoot }));
  await put(folder + 'VERIFICATION.json', JSON.stringify({ ...publication, status: 'passed', journal_path: journalPath,
    verified_files: [{ path: 'Wiki/example.md' }] }));
  assert.equal((await cleanupReadingRuntimeRun({ ...current, publication })).snapshot_status, 'removed');
});

test('rebound snapshot remains protected until the rebound run closes and archives both patches', async t => {
  const core = await import('../../scripts/v3/reading-runtime-snapshot.mjs');
  const { closeReadingRuntimeRun } = await import('../../scripts/v3/reading-runtime-cleanup.mjs');
  const { put, run } = await fixture(t);
  const previous = await run('run-old'), rebound = await run('run-rebound');
  await put('scripts/fixture.mjs', 'export const fixture = false;\n');
  const manifest = core.prepareReadingRuntimeSnapshot({ ...rebound, codeRoot: rebound.repoRoot });
  core.registerReadingRuntimeSnapshotReference({ ...rebound, manifest, expectedFingerprint: rebound.manifest.fingerprint });
  assert.equal((await closeReadingRuntimeRun({ ...previous, terminal })).snapshot_status, 'referenced');
  assert.match(await readFile(join(previous.manifest.code_root, 'scripts', 'fixture.mjs'), 'utf8'), /true/);
  const final = await closeReadingRuntimeRun({ ...rebound, manifest, terminal });
  assert.equal(final.snapshot_status, 'removed');
  assert.ok(final.snapshots.some(row => row.snapshot_hash === previous.manifest.snapshot_hash && row.status === 'removed'));
  assert.equal(final.archives.filter(row => row.kind === 'runtime-patch').length, 2);
  await assert.rejects(readFile(join(previous.manifest.code_root, 'scripts', 'fixture.mjs')), { code: 'ENOENT' });
});

test('cleanup preserves the snapshot reference and temporary evidence when the frozen patch has changed', async t => {
  const { closeReadingRuntimeRun, registerReadingRuntimeCleanupFiles } = await import('../../scripts/v3/reading-runtime-cleanup.mjs');
  const { readReadingRuntimeSnapshotReference } = await import('../../scripts/v3/reading-runtime-snapshot.mjs');
  const { put, run } = await fixture(t);
  const current = await run('run-d');
  const host = await put('.tmp/run-d/raw', 'original');
  await registerReadingRuntimeCleanupFiles({ ...current, files: [{ path: host, kind: 'host' }] });
  const patch = join(current.runRoot, current.manifest.patch.path);
  const bytes = await readFile(patch);
  await writeFile(patch, 'changed patch');
  await assert.rejects(closeReadingRuntimeRun({ ...current, terminal }), { code: 'READING_RUNTIME_SNAPSHOT_INVALID' });
  assert.equal(readReadingRuntimeSnapshotReference(current).fingerprint, current.manifest.fingerprint);
  assert.equal(await readFile(host, 'utf8'), 'original');
  await writeFile(patch, bytes);
  assert.equal((await closeReadingRuntimeRun({ ...current, terminal })).snapshot_status, 'removed');
});

test('publication holds the run consumer through commit and cleanup and refuses stale execution identity', async t => {
  const { cleanupReadingRuntimeRun, closeReadingRuntimeRun, withReadingRuntimePublicationConsumer } = await import('../../scripts/v3/reading-runtime-cleanup.mjs');
  const { put, run } = await fixture(t);
  const current = await run('run-publish');
  const stale = { ...current.manifest, fingerprint: 'sha256:' + '0'.repeat(64) };
  await assert.rejects(withReadingRuntimePublicationConsumer({ ...current, manifest: stale }, async () => assert.fail('stale publication executed')),
    { code: 'READING_RUNTIME_SNAPSHOT_REFERENCE_MISMATCH' });
  const publication = { transaction_id: 'transaction-publish', generation: 'generation-publish' };
  const folder = 'Eval/apa-v3/runs/run-publish/publication/';
  const journalPath = '.apa-v3/phase22/transactions/transaction-publish/journal.json';
  await withReadingRuntimePublicationConsumer(current, async () => {
    await assert.rejects(closeReadingRuntimeRun({ ...current, terminal }), { code: 'READING_RUNTIME_CONSUMER_ACTIVE' });
    await put(folder + 'RESULT.md', '**发布结果**\n已提交代次 generation-publish，事务 transaction-publish。\n');
    await put(journalPath, JSON.stringify({ ...publication, run_id: current.runId, state: 'committed', vault_root: current.repoRoot }));
    await put(folder + 'VERIFICATION.json', JSON.stringify({ ...publication, status: 'passed', journal_path: journalPath,
      verified_files: [{ path: 'Wiki/example.md' }] }));
    const result = await cleanupReadingRuntimeRun({ ...current, publication, consumerHeld: true });
    assert.equal(result.snapshot_status, 'removed');
  });
});

test('cleanup retry removes its retired copy while a later run protects the canonical snapshot', async t => {
  const { closeReadingRuntimeRun } = await import('../../scripts/v3/reading-runtime-cleanup.mjs');
  const { run } = await fixture(t);
  const first = await run('run-retry');
  const retired = join(dirname(first.manifest.code_root), '.retired-' + first.manifest.snapshot_hash.slice(7) + '-' + first.runId);
  await cp(first.manifest.code_root, retired, { recursive: true });
  await chmod(retired, 0o700);
  const unexpected = join(retired, 'unexpected.txt');
  await writeFile(unexpected, 'preserved');
  await assert.rejects(closeReadingRuntimeRun({ ...first, terminal }), { code: 'READING_RUNTIME_CLEANUP_PATH' });
  assert.equal(await readFile(unexpected, 'utf8'), 'preserved');
  await rm(unexpected);
  const second = await run('run-after-interruption');
  assert.equal((await closeReadingRuntimeRun({ ...first, terminal })).snapshot_status, 'referenced');
  await assert.rejects(readFile(retired), { code: 'ENOENT' });
  assert.match(await readFile(join(second.manifest.code_root, 'scripts', 'fixture.mjs'), 'utf8'), /fixture/);
  assert.equal((await closeReadingRuntimeRun({ ...second, terminal })).snapshot_status, 'removed');
});

test('single session preparation finishes while cleanup is reading historical bytes', async t => {
  const { closeReadingRuntimeRun, registerReadingRuntimeCleanupFiles } = await import('../../scripts/v3/reading-runtime-cleanup.mjs');
  const { put, run } = await fixture(t);
  const first = await run('slow-archive');
  const historical = await put('.tmp/slow-archive/history', Buffer.alloc(1024 * 1024, 'a'));
  await registerReadingRuntimeCleanupFiles({ ...first, files: [{ path: historical, kind: 'historical' }] });
  const model = { mode: 'explicit', model: 'fixture', reasoning_effort: 'high' };
  await put('config/apa.local.json', JSON.stringify({
    schema_version: 'apa-local-config-1.0', models: { science: model, overrides: {}, roles: Object.fromEntries(
      ['english-writer', 'chinese-writer', 'translation', 'reading-editor', 'independent-verifier'].map(role => [role, model])) },
    paths: { runs: 'runs', parse: 'parse', candidates: 'candidates' },
    parser: { runtime_home: 'parser' }, reading: { source_language: 'en', presentation_mode: 'reading-editor' },
    writing_skills: Object.fromEntries(['nature-writing', 'nature-polishing', 'nature-shared', 'humanizer', 'humanizer-zh', 'stss'].map(key => [key, { enabled: false }])),
  }));
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const original = fs.readFile;
  let delayed = false, finished = false;
  const mock = t.mock.method(fs, 'readFile', async (path, ...args) => {
    if (path === historical && !delayed) {
      delayed = true;
      entered.resolve();
      await Promise.all([setTimeout(7500), release.promise]);
    }
    return original(path, ...args);
  });
  syncBuiltinESMExports();
  const cleanup = closeReadingRuntimeRun({ ...first, terminal }).finally(() => { finished = true; });
  const cli = new URL('../../scripts/v3/reading-session-cli.mjs', import.meta.url).href;
  const child = `import {prepareReadingSessionExecution} from ${JSON.stringify(cli)};
    const { manifest } = await prepareReadingSessionExecution({ repoRoot: process.argv[1], runId: 'incoming-run', authorizationId: 'synthetic',
      scientificInput: {}, sessionContext: { model: 'fixture', effort: 'high' }, maxTotalCalls: 14 });
    process.stdout.write(manifest.snapshot_hash);`;
  try {
    await Promise.race([entered.promise, cleanup.then(() => assert.fail('cleanup never opened the historical bytes'))]);
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', child, first.repoRoot], { timeout: 45000 });
    assert.match(stdout, /^sha256:[0-9a-f]{64}$/);
    assert.equal(finished, false);
  } finally {
    release.resolve();
    mock.mock.restore();
    syncBuiltinESMExports();
    await cleanup;
  }
  assert.equal((await cleanup).snapshot_status, 'removed');
});

for (const point of ['before retired deletion', 'after retired deletion']) {
  test(`cleanup retry after interruption ${point} leaves recreated canonical paths alone`, async t => {
    const core = await import('../../scripts/v3/reading-runtime-snapshot.mjs');
    const { closeReadingRuntimeRun, registerReadingRuntimeCleanupFiles } = await import('../../scripts/v3/reading-runtime-cleanup.mjs');
    const { put, run } = await fixture(t);
    const first = await run('interrupted');
    const scratch = await put('.tmp/interrupted/scratch', 'original');
    await registerReadingRuntimeCleanupFiles({ ...first, files: [{ path: scratch, kind: 'temporary' }] });
    const retired = join(dirname(first.manifest.code_root), '.retired-' + first.manifest.snapshot_hash.slice(7) + '-' + first.runId);
    const module = new URL('../../scripts/v3/reading-runtime-cleanup.mjs', import.meta.url).href;
    const child = `import { promises as fs } from 'node:fs';
      import { dirname } from 'node:path';
      import { syncBuiltinESMExports } from 'node:module';
      import { closeReadingRuntimeRun } from ${JSON.stringify(module)};
      const { options, retired, beforeDelete } = JSON.parse(process.argv[1]);
      const method = beforeDelete ? 'unlink' : 'rmdir';
      const original = fs[method];
      fs[method] = async (path, ...args) => {
        const trigger = beforeDelete ? dirname(path).endsWith('.retired-files-' + options.runId) : path === retired;
        if (!trigger) return original(path, ...args);
        if (!beforeDelete) await original(path, ...args);
        process.exit(47);
      };
      syncBuiltinESMExports();
      await closeReadingRuntimeRun(options);`;
    const args = { options: { ...first, terminal }, retired, beforeDelete: point === 'before retired deletion' };
    await assert.rejects(promisify(execFile)(process.execPath, ['--input-type=module', '--eval', child, JSON.stringify(args)], { timeout: 30000 }), { code: 47 });
    assert.equal(core.readReadingRuntimeSnapshotReference(first), null);
    const recovered = core.prepareReadingRuntimeSnapshot({ ...first, codeRoot: first.repoRoot, runId: 'later', runRoot: join(first.repoRoot, 'later') });
    assert.equal(recovered.code_root, first.manifest.code_root);
    await put('.tmp/interrupted/scratch', 'original');
    const result = await closeReadingRuntimeRun({ ...first, terminal });
    assert.equal(result.snapshot_status, 'removed');
    assert.match(await readFile(join(recovered.code_root, 'scripts/fixture.mjs'), 'utf8'), /fixture/);
    assert.equal(await readFile(scratch, 'utf8'), 'original');
  });
}
