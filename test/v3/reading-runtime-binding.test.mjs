import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { captureReadingRuntime, inspectReadingRuntime, validateRuntimeRepairApproval } from '../../scripts/v3/reading-runtime-binding.mjs';

const sha = b => 'sha256:' + createHash('sha256').update(b).digest('hex');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'runtime-binding-'));
  const put = (p, b) => { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), b); };
  put('scripts/main.mjs', "import './dep.mjs';\n"); put('scripts/dep.mjs', 'export const x = 1;');
  put('Schema/test/a.schema.json', '{}'); put('prompts/p.md', 'prompt'); put('evidence/test.txt', 'passed');
  const options = { repoRoot: root, entryPaths: ['scripts/main.mjs'], schemaPaths: ['Schema/test'], promptFiles: ['prompts/p.md'] };
  return { root, put, options };
}
test('tracks transitive source and schema directory changes', () => {
  const { root, put, options } = fixture(); const previous = captureReadingRuntime(options);
  assert.equal(inspectReadingRuntime({ manifest: previous, repoRoot: root }).status, 'current');
  put('scripts/dep.mjs', 'export const x = 2;'); put('Schema/test/new.schema.json', '{}');
  const result = inspectReadingRuntime({ manifest: previous, repoRoot: root });
  assert.equal(result.status, 'drift');
  assert.deepEqual(result.changed_files.map(x => x.path), ['Schema/test/new.schema.json', 'scripts/dep.mjs']);
});
test('requires exact authorization, checkpoint, changed hashes and unchanged evidence', () => {
  const { root, put, options } = fixture(); const previous = captureReadingRuntime(options);
  put('Schema/test/a.schema.json', '{"changed":true}');
  const { current, changed_files } = inspectReadingRuntime({ manifest: previous, repoRoot: root });
  const approval = { authorization_id: 'approval-1', run_id: 'run-1', checkpoint_fingerprint: 'checkpoint-1', previous_runtime_fingerprint: previous.fingerprint, current_runtime_fingerprint: current.fingerprint, changed_files, test_evidence: [{ path: 'evidence/test.txt', sha256: sha('passed'), byte_length: 6 }] };
  const args = { runId: 'run-1', checkpointFingerprint: 'checkpoint-1', previous, current, repoRoot: root };
  assert.equal(validateRuntimeRepairApproval(args).valid, false);
  assert.equal(validateRuntimeRepairApproval({ ...args, approval }).valid, true);
  assert.equal(validateRuntimeRepairApproval({ ...args, approval: { ...approval, checkpoint_fingerprint: 'wrong' } }).valid, false);
  assert.equal(validateRuntimeRepairApproval({ ...args, approval: { ...approval, changed_files: [{ ...changed_files[0], new_sha256: sha('wrong') }] } }).valid, false);
  assert.equal(validateRuntimeRepairApproval({ ...args, approval: { ...approval, deadline: 'later' } }).valid, false);
  put('evidence/test.txt', 'failed');
  assert.equal(validateRuntimeRepairApproval({ ...args, approval }).valid, false);
  put('Schema/test/a.schema.json', 'again');
  assert.equal(validateRuntimeRepairApproval({ ...args, approval }).valid, false);
});

test('reports removed dependencies and enforces the exact removed-file approval', () => {
  const { root, put, options } = fixture(); const previous = captureReadingRuntime(options);
  put('scripts/main.mjs', 'export const replacement = true;');
  const { current, changed_files } = inspectReadingRuntime({ manifest: previous, repoRoot: root });
  assert.equal(changed_files.find(row => row.path === 'scripts/dep.mjs').new_sha256, null);
  const approval = { authorization_id: 'repair-2', run_id: 'run-2', checkpoint_fingerprint: 'checkpoint-2', previous_runtime_fingerprint: previous.fingerprint, current_runtime_fingerprint: current.fingerprint, changed_files: changed_files.filter(row => row.path !== 'scripts/dep.mjs'), test_evidence: [{ path: 'evidence/test.txt', sha256: sha('passed'), byte_length: 6 }] };
  assert.equal(validateRuntimeRepairApproval({ approval, runId: 'run-2', checkpointFingerprint: 'checkpoint-2', previous, current, repoRoot: root }).valid, false);
});

test('tracks literal dynamic module imports', () => {
  const { root, put, options } = fixture();
  put('scripts/main.mjs', "export async function go() { return " + "import('./dynamic.mjs'); }");
  put('scripts/dynamic.mjs', 'export const value = 1;');
  const previous = captureReadingRuntime(options);
  put('scripts/dynamic.mjs', 'export const value = 2;');
  assert.deepEqual(inspectReadingRuntime({ manifest: previous, repoRoot: root }).changed_files.map(row => row.path), ['scripts/dynamic.mjs']);
});
