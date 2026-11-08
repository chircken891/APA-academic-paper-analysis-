import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import {
  inspectReadingRuntime, validateHistoricalRuntimeRepairApproval, validateRuntimeRebindApproval, validateRuntimeRepairApproval,
} from '../../scripts/v3/reading-runtime-binding.mjs';
import {
  prepareReadingRuntimeSnapshot, previewReadingRuntimeSnapshot, registerReadingRuntimeSnapshotReference,
  releaseReadingRuntimeSnapshotReference, withReadingRuntimeSnapshotLock,
} from '../../scripts/v3/reading-runtime-snapshot.mjs';
import * as snapshots from '../../scripts/v3/reading-runtime-snapshot.mjs';

const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const fixtureFiles = {
  'scripts/runner.mjs': 'export const value = 1;\n',
  'Schema/contract.json': '{}\n',
  'prompts/role.md': 'A role\n',
  'docs/apa-v3/workflow.md': 'A workflow\n',
  'package.json': '{"type":"module"}\n',
};

function put(root, path, bytes) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return file;
}

function clean(root) {
  if (existsSync(root)) {
    chmodSync(root, 0o700);
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) clean(path);
      else chmodSync(path, 0o600);
    }
    rmSync(root, { recursive: true, force: true });
  }
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'apa-runtime-snapshot-'));
  t.after(() => clean(root));
  const codeRoot = join(root, 'checkout');
  const repoRoot = join(root, 'data');
  for (const [path, contents] of Object.entries(fixtureFiles)) put(codeRoot, path, contents);
  mkdirSync(repoRoot);
  const run = runId => ({ codeRoot, repoRoot, runId, runRoot: join(repoRoot, 'Eval/apa-v3/runs', runId) });
  return { codeRoot, repoRoot, run };
}

test('a full snapshot stays current across checkout edits and rejects changed or added bytes', t => {
  const { codeRoot, repoRoot, run } = fixture(t);
  put(repoRoot, 'Wiki/data.md', 'data stays in the vault');
  const options = run('one');
  const preview = previewReadingRuntimeSnapshot(options);
  assert.equal(existsSync(preview.code_root), false);
  assert.equal(existsSync(options.runRoot), false);
  const bound = prepareReadingRuntimeSnapshot(options);
  assert.deepEqual(bound, preview);
  assert.equal(bound.data_root, repoRoot);
  assert.equal(bound.code_root, join(repoRoot, '.runtime/apa-code', bound.snapshot_hash.slice(7)));
  assert.deepEqual(bound.files.map(file => file.path), Object.keys(fixtureFiles).sort());
  assert.equal(existsSync(join(bound.code_root, 'Wiki')), false);
  const file = join(bound.code_root, 'scripts/runner.mjs');
  assert.equal(statSync(file).mode & 0o222, 0);
  put(codeRoot, 'scripts/runner.mjs', 'export const value = 2;\n');
  assert.equal(inspectReadingRuntime({ manifest: bound, runRoot: options.runRoot }).status, 'current');
  assert.notEqual(previewReadingRuntimeSnapshot(options).snapshot_hash, bound.snapshot_hash);

  chmodSync(bound.code_root, 0o755);
  const added = put(bound.code_root, 'unlisted.mjs', '');
  assert.throws(() => inspectReadingRuntime({ manifest: bound }), { code: 'READING_RUNTIME_SNAPSHOT_INVALID' });
  rmSync(added);
  chmodSync(file, 0o644);
  writeFileSync(file, 'modified\n');
  assert.throws(() => inspectReadingRuntime({ manifest: bound }), { code: 'READING_RUNTIME_SNAPSHOT_INVALID' });
});

test('parallel processes reuse one complete snapshot and keep distinct run provenance', { timeout: 120_000 }, async t => {
  const { repoRoot, run } = fixture(t);
  const module = new URL('../../scripts/v3/reading-runtime-snapshot.mjs', import.meta.url).href;
  const entered = join(repoRoot, 'scan-entered');
  const release = join(repoRoot, 'scan-release');
  const child = `import fs from 'node:fs';
    import {join} from 'node:path';
    import {syncBuiltinESMExports} from 'node:module';
    import {setTimeout} from 'node:timers/promises';
    import {prepareReadingRuntimeSnapshot} from ${JSON.stringify(module)};
    const options = JSON.parse(process.argv[1]);
    const [entered, release] = process.argv.slice(2);
    const first = options.runId === 'one';
    let pausedMs;
    if (first) {
      const read = fs.readFileSync;
      const sleeper = new Int32Array(new SharedArrayBuffer(4));
      fs.readFileSync = function (path, ...args) {
        if (path === join(options.codeRoot, 'scripts', 'runner.mjs') && !fs.existsSync(entered)) {
          const start = performance.now();
          fs.writeFileSync(entered, '');
          Atomics.wait(sleeper, 0, 0, 5500);
          while (!fs.existsSync(release)) Atomics.wait(sleeper, 0, 0, 20);
          pausedMs = performance.now() - start;
        }
        return read(path, ...args);
      };
      syncBuiltinESMExports();
    } else {
      while (!fs.existsSync(entered)) await setTimeout(20);
      if (fs.existsSync(join(options.repoRoot, '.runtime', 'apa-code.lock'))) {
        throw new Error('first source scan holds the snapshot lock');
      }
    }
    const manifest = prepareReadingRuntimeSnapshot({ ...options, reference: {} });
    if (!first) fs.writeFileSync(release, '');
    process.stdout.write(JSON.stringify({ manifest, pausedMs }));`;
  const a = run('one');
  const b = run('two');
  const controller = new AbortController();
  const signal = AbortSignal.any([t.signal, controller.signal]);
  const jobs = [a, b].map(options => {
    const result = promisify(execFile)(process.execPath,
      ['--input-type=module', '--eval', child, JSON.stringify(options), entered, release], { signal });
    const closed = new Promise(resolve => result.child.once('close', resolve));
    return { result, closed };
  });
  let results;
  try {
    results = await Promise.all(jobs.map(job => job.result));
  } catch (error) {
    t.diagnostic(JSON.stringify({ scanEntered: existsSync(entered), secondRegistered: existsSync(release) }));
    throw error;
  } finally {
    controller.abort();
    await Promise.all(jobs.map(job => job.closed));
  }
  const [{ manifest: first, pausedMs }, { manifest: second }] = results.map(result => JSON.parse(result.stdout));
  assert.ok(pausedMs > 5000, 'first source scan paused for ' + pausedMs + ' ms');
  assert.deepEqual(second, first);
  assert.deepEqual(readdirSync(join(repoRoot, '.runtime/apa-code')), [first.snapshot_hash.slice(7)]);
  assert.deepEqual(readdirSync(join(repoRoot, '.runtime/apa-code-refs')).sort(), ['one.json', 'two.json']);
  for (const options of [a, b]) assert.equal(inspectReadingRuntime({ manifest: first, runRoot: options.runRoot }).status, 'current');
});

test('active runs can see planned names while a released run keeps its plan as evidence', async t => {
  const { repoRoot, run } = fixture(t);
  const plans = await import('../../scripts/v3/reading-first-knowledge-plans.mjs');
  const activate = runId => {
    const options = run(runId);
    const manifest = prepareReadingRuntimeSnapshot(options);
    registerReadingRuntimeSnapshotReference({ ...options, manifest });
    return manifest;
  };
  const manifest = activate('prior');
  activate('later');
  const node = { id: 'planned-method', canonical_key: 'method:example', kind: 'method', title: { 'zh-CN': '样本方法', en: 'Example Method' } };
  const planned = plans.recordPlannedReadingFirstKnowledge({ repoRoot, runId: 'prior', catalog: [node],
    supportNotes: [{ id: node.id, path: 'Wiki/methods/样本方法.md' }], registry: [] });
  const observed = await plans.readPlannedReadingFirstKnowledge({ repoRoot, excludeRunId: 'later', runIds: ['prior'] });
  assert.deepEqual(observed, [{ run_id: 'prior', ...node, path: 'Wiki/methods/样本方法.md' }]);
  assert.equal(plans.matchPlannedReadingFirstKnowledge([{ ...node, id: 'different-id', title: { 'zh-CN': '样本 方法', en: 'Other' } }], observed)[0].planned_run_id, 'prior');
  releaseReadingRuntimeSnapshotReference({ repoRoot, runId: 'prior', expectedFingerprint: manifest.fingerprint });
  assert.deepEqual(await plans.readPlannedReadingFirstKnowledge({ repoRoot, excludeRunId: 'later' }), []);
  assert.equal(existsSync(planned.path), true);
});

test('snapshot publication retries transient directory rename errors and surfaces other errors', t => {
  const { codeRoot, repoRoot, run } = fixture(t);
  const rename = fs.renameSync;
  let attempts = 0;
  let failures = ['EPERM', 'EBUSY'];
  const injected = t.mock.method(fs, 'renameSync', (from, to) => {
    if (basename(from).startsWith('.building-')) {
      attempts++;
      const code = failures.shift();
      if (code) throw Object.assign(new Error('synthetic rename failure'), { code });
    }
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    const first = prepareReadingRuntimeSnapshot(run('one'));
    assert.equal(attempts, 3);
    assert.equal(inspectReadingRuntime({ manifest: first }).status, 'current');
    put(codeRoot, 'scripts/runner.mjs', 'export const value = 2;\n');
    failures = ['EINVAL'];
    attempts = 0;
    const next = run('two');
    assert.throws(() => prepareReadingRuntimeSnapshot(next), { code: 'EINVAL' });
    assert.equal(attempts, 1);
    failures = Array(5).fill('EACCES');
    attempts = 0;
    assert.throws(() => prepareReadingRuntimeSnapshot(next), { code: 'EACCES' });
    assert.equal(attempts, 5);
    assert.deepEqual(readdirSync(join(repoRoot, '.runtime/apa-code')), [first.snapshot_hash.slice(7)]);
    assert.equal(existsSync(next.runRoot), false);
  } finally {
    injected.mock.restore();
    syncBuiltinESMExports();
  }
});

test('records a Git commit and recoverable patch for modified, deleted and untracked code', t => {
  const { codeRoot, run } = fixture(t);
  const git = (...args) => execFileSync('git', args, { cwd: codeRoot }).toString().trim();
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  git('add', '.');
  git('-c', 'user.name=Snapshot Test', '-c', 'user.email=snapshot@example.invalid', 'commit', '-qm', 'fixture baseline');
  const commit = git('rev-parse', 'HEAD');
  git('rm', '--cached', 'scripts/runner.mjs');
  put(codeRoot, 'scripts/runner.mjs', 'export const value = 2;\r\n');
  put(codeRoot, 'docs/apa-v3/new.md', 'New workflow\n');
  rmSync(join(codeRoot, 'prompts/role.md'));
  put(codeRoot, 'prompts/replacement.md', 'Replacement\n');
  put(codeRoot, 'outside.txt', 'data outside the patch\n');

  const options = run('git');
  const manifest = prepareReadingRuntimeSnapshot(options);
  assert.equal(manifest.git_commit, commit);
  const patch = readFileSync(join(options.runRoot, manifest.patch.path));
  assert.equal(manifest.patch.sha256, sha(patch));
  assert.equal(manifest.patch.byte_length, patch.length);
  assert.match(patch.toString(), /diff --git a\/scripts\/runner.mjs b\/scripts\/runner.mjs/);
  assert.match(patch.toString(), /diff --git a\/prompts\/role.md b\/prompts\/role.md/);
  assert.match(patch.toString(), /diff --git a\/docs\/apa-v3\/new.md b\/docs\/apa-v3\/new.md/);
  assert.doesNotMatch(patch.toString(), /outside.txt/);
  const recovery = join(dirname(codeRoot), 'recovery');
  git('-c', 'core.autocrlf=false', 'clone', '-q', codeRoot, recovery);
  execFileSync('git', ['-c', 'core.autocrlf=false', 'apply', '--whitespace=nowarn', join(options.runRoot, manifest.patch.path)], { cwd: recovery });
  for (const row of manifest.files) assert.equal(sha(readFileSync(join(recovery, row.path))), row.sha256, row.path);
  assert.equal(existsSync(join(recovery, 'prompts/role.md')), false);

  const patchPath = join(options.runRoot, manifest.patch.path);
  chmodSync(patchPath, 0o644);
  writeFileSync(patchPath, 'modified\n');
  assert.throws(() => inspectReadingRuntime({ manifest, runRoot: options.runRoot }), { code: 'READING_RUNTIME_SNAPSHOT_INVALID' });
});

test('a batch rebind approval binds both snapshots and each run checkpoint', t => {
  const { codeRoot, repoRoot, run } = fixture(t);
  const a = run('one');
  const b = run('two');
  const previous = prepareReadingRuntimeSnapshot(a);
  assert.deepEqual(prepareReadingRuntimeSnapshot(b), previous);
  const nextBytes = 'export const value = 2;\n';
  put(codeRoot, 'scripts/runner.mjs', nextBytes);
  const current = previewReadingRuntimeSnapshot(a);
  const evidence = Buffer.from('synthetic test passed\n');
  put(repoRoot, 'Eval/test.log', evidence);
  const checkpointA = sha('checkpoint one');
  const checkpointB = sha('checkpoint two');
  const approval = {
    authorization_id: 'snapshot-rebind-approved',
    run_ids: ['one', 'two'],
    checkpoint_fingerprints: { one: checkpointA, two: checkpointB },
    previous_runtime_fingerprint: previous.fingerprint,
    current_runtime_fingerprint: current.fingerprint,
    changed_files: [{ path: 'scripts/runner.mjs', old_sha256: sha(fixtureFiles['scripts/runner.mjs']), new_sha256: sha(nextBytes) }],
    test_evidence: [{ path: 'Eval/test.log', sha256: sha(evidence), byte_length: evidence.length }],
  };
  const options = { approval, previous, current, repoRoot, runRoot: a.runRoot, runId: 'one', checkpointFingerprint: checkpointA };
  assert.equal(validateRuntimeRebindApproval(options).valid, true);
  assert.equal(validateRuntimeRebindApproval({ ...options, runId: 'two', checkpointFingerprint: checkpointB }).valid, true);
  assert.equal(validateRuntimeRebindApproval({ ...options, runId: 'three' }).valid, false);
  assert.equal(validateRuntimeRebindApproval({ ...options, runId: 'two' }).valid, false);
  assert.equal(validateRuntimeRebindApproval({ ...options, approval: { ...approval, checkpoint_fingerprints: { one: checkpointA } } }).valid, false);
  assert.equal(validateRuntimeRepairApproval(options).valid, false);
  assert.deepEqual(prepareReadingRuntimeSnapshot(a), current);
  assert.equal(validateRuntimeRepairApproval(options).valid, true);
  assert.equal(validateHistoricalRuntimeRepairApproval(options).valid, true);
  clean(previous.code_root);
  assert.equal(validateRuntimeRepairApproval(options).valid, false);
  assert.equal(validateHistoricalRuntimeRepairApproval(options).valid, true);
});

test('snapshot reference replacement and release guard against a stale fingerprint', t => {
  const { codeRoot, repoRoot, run } = fixture(t);
  const options = run('one');
  const previous = prepareReadingRuntimeSnapshot(options);
  const refFile = join(repoRoot, '.runtime/apa-code-refs/one.json');
  registerReadingRuntimeSnapshotReference({ ...options, manifest: previous });
  assert.equal(JSON.parse(readFileSync(refFile)).fingerprint, previous.fingerprint);
  put(codeRoot, 'scripts/runner.mjs', 'export const value = 2;\n');
  const current = prepareReadingRuntimeSnapshot(options);
  const pendingCheckpoint = { artifact_id: 'session-state-1', sha256: sha('owned checkpoint'), byte_length: 16 };
  const rebind = { ...options, manifest: current, expectedFingerprint: previous.fingerprint, pending: true, pendingCheckpoint };
  registerReadingRuntimeSnapshotReference(rebind);
  const pending = JSON.parse(readFileSync(refFile));
  assert.equal(pending.fingerprint, previous.fingerprint);
  assert.equal(pending.pending_manifest.fingerprint, current.fingerprint);
  assert.deepEqual(pending.pending_checkpoint, pendingCheckpoint);
  assert.throws(() => registerReadingRuntimeSnapshotReference({
    ...rebind, pendingCheckpoint: { ...pendingCheckpoint, sha256: sha('changed owned checkpoint') },
  }), { code: 'READING_RUNTIME_REFERENCE_CONFLICT' });

  const abandon = snapshots.abandonReadingRuntimeSnapshotReference;
  assert.equal(typeof abandon, 'function');
  const cancellation = { ...options, expectedFingerprint: previous.fingerprint, pendingFingerprint: current.fingerprint };
  assert.throws(() => abandon({ ...cancellation, pendingFingerprint: previous.fingerprint }), { code: 'READING_RUNTIME_REFERENCE_CONFLICT' });
  assert.throws(() => abandon({ ...cancellation, runRoot: join(options.runRoot, 'other') }), { code: 'READING_RUNTIME_REFERENCE_CONFLICT' });
  const abandoned = abandon(cancellation);
  assert.equal(abandoned.fingerprint, previous.fingerprint);
  assert.equal(abandoned.pending_manifest, undefined);
  assert.equal(abandoned.pending_checkpoint, undefined);
  assert.deepEqual(abandoned.previous_manifests, [current]);
  assert.equal(existsSync(join(options.runRoot, current.patch.path)), true);

  registerReadingRuntimeSnapshotReference(rebind);
  registerReadingRuntimeSnapshotReference({ ...options, manifest: current, expectedFingerprint: previous.fingerprint });
  const active = JSON.parse(readFileSync(refFile));
  assert.equal(active.fingerprint, current.fingerprint);
  assert.equal(active.pending_manifest, undefined);
  assert.equal(active.pending_checkpoint, undefined);
  assert.deepEqual(active.previous_manifests, [previous]);
  assert.throws(() => releaseReadingRuntimeSnapshotReference({ ...options, expectedFingerprint: previous.fingerprint }), { code: 'READING_RUNTIME_REFERENCE_CONFLICT' });
  releaseReadingRuntimeSnapshotReference({ ...options, expectedFingerprint: current.fingerprint });
  assert.equal(existsSync(refFile), false);
  assert.equal(existsSync(current.code_root), true);
});

test('a terminated process does not block the next snapshot lock owner', t => {
  const { repoRoot } = fixture(t);
  const module = new URL('../../scripts/v3/reading-runtime-snapshot.mjs', import.meta.url).href;
  const child = `import {withReadingRuntimeSnapshotLock} from ${JSON.stringify(module)};
    withReadingRuntimeSnapshotLock({ repoRoot: process.argv[1] }, () => process.exit(0));`;
  execFileSync(process.execPath, ['--input-type=module', '--eval', child, repoRoot]);
  assert.equal(existsSync(join(repoRoot, '.runtime/apa-code.lock')), true);
  assert.equal(withReadingRuntimeSnapshotLock({ repoRoot }, () => 'recovered'), 'recovered');
  assert.equal(existsSync(join(repoRoot, '.runtime/apa-code.lock')), false);
});

test('a live snapshot lock owner is reported after the wait limit and reentry reports its caller', async t => {
  const { repoRoot } = fixture(t);
  const module = new URL('../../scripts/v3/reading-runtime-snapshot.mjs', import.meta.url).href;
  const child = `import {withReadingRuntimeSnapshotLock} from ${JSON.stringify(module)};
    withReadingRuntimeSnapshotLock({ repoRoot: process.argv[1] }, () => {
      process.stdout.write('locked');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
    });`;
  const processHandle = execFile(process.execPath, ['--input-type=module', '--eval', child, repoRoot], { windowsHide: true });
  const closed = new Promise(resolve => processHandle.once('close', resolve));
  try {
    await new Promise((resolve, reject) => {
      processHandle.stdout.once('data', resolve);
      processHandle.once('error', reject);
      processHandle.once('exit', code => reject(new Error('lock child exited with ' + code)));
    });
    assert.throws(() => withReadingRuntimeSnapshotLock({ repoRoot, maxWaitMs: 120 }, () => assert.fail('lock acquired')), error => {
      assert.equal(error.code, 'READING_RUNTIME_SNAPSHOT_BUSY');
      assert.equal(error.details.owner_pid, processHandle.pid);
      assert.ok(Number.isFinite(Date.parse(error.details.created_at)));
      assert.ok(error.details.waited_ms >= 120);
      return true;
    });
  } finally {
    processHandle.kill();
    await closed;
  }
  assert.throws(() => withReadingRuntimeSnapshotLock({ repoRoot }, () => withReadingRuntimeSnapshotLock({ repoRoot }, () => {})), error => {
    assert.equal(error.code, 'READING_RUNTIME_SNAPSHOT_LOCK_REENTRY');
    assert.match(error.stack, /reading-runtime-snapshot\.test\.mjs/);
    return true;
  });
});
