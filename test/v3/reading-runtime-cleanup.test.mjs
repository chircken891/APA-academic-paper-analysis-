import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
