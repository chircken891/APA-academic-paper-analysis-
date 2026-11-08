import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { lstat, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const BATCH_RUN_FILE = 'reading-batch-run.json';
const SUMMARY_FILE = 'reading-batch-checkpoint.json';
const PROFILE = 'reading-batch-checkpoint-1.0';
const LIMIT = 8192;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const text = value => typeof value === 'string' ? [...value].slice(0, 128).join('') : null;
export const batchRecordHash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

export async function readBatchJson(path, maxBytes) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || await realpath(path) !== path) fail('READING_BATCH_RECORD_PATH_INVALID');
    if (maxBytes === undefined) return JSON.parse(await readFile(path, 'utf8'));
    if (stat.size > maxBytes) fail('READING_BATCH_SUMMARY_SIZE_EXCEEDED');
    const file = await open(path, 'r');
    try {
      const bytes = Buffer.alloc(maxBytes + 1);
      const { bytesRead } = await file.read(bytes);
      if (bytesRead > maxBytes) fail('READING_BATCH_SUMMARY_SIZE_EXCEEDED');
      return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
    } finally { await file.close(); }
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function readBatchRun(runRoot, runId, expectedHash) {
  const path = join(runRoot, BATCH_RUN_FILE);
  let bytes;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path) fail('READING_BATCH_RECORD_PATH_INVALID');
    bytes = readFileSync(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (expectedHash) fail('READING_BATCH_RUN_RECORD_INVALID');
    return null;
  }
  if (!expectedHash || batchRecordHash(bytes) !== expectedHash) fail('READING_BATCH_RUN_RECORD_INVALID');
  const marker = JSON.parse(bytes);
  if (marker.schema_version !== 'reading-batch-run-1.0' || marker.run_root !== runRoot || marker.run_id !== runId) {
    fail('READING_BATCH_RUN_RECORD_INVALID');
  }
  return marker;
}

export function assertBatchRunOptions(marker, options, { manifest, configurationFingerprint }) {
  const sourceIdentity = sources => sources?.map(({ path, sha256, byte_length }) => ({ path, sha256, byte_length }));
  const session = options.sessionContext;
  const effort = session?.effort ?? session?.reasoning_effort;
  const received = { authorizationId: options.authorizationId, maxCalls: options.maxCalls,
    maxTotalCalls: options.maxTotalCalls, includeRepairs: options.includeRepairs === true,
    sessionContext: { model: session?.model, ...(effort === undefined ? {} : { reasoning_effort: effort }) },
    ...(options.enrichmentPolicy === undefined ? {} : { enrichmentPolicy: options.enrichmentPolicy }) };
  if (marker.vault_root !== options.repoRoot || marker.snapshot_fingerprint !== manifest?.fingerprint
    || marker.configuration_fingerprint !== configurationFingerprint || !isDeepStrictEqual(received, marker.options)
    || !isDeepStrictEqual(sourceIdentity(options.scientificInput?.sources), sourceIdentity(marker.sources))
    || marker.paper_id && marker.paper_id !== options.scientificInput?.identity?.paper_id) fail('READING_BATCH_RUN_OPTIONS_CHANGED');
}

export function projectBatchCheckpoint({ runId, stage, status, action, kind, code, task, budget, checkpoint } = {}) {
  return {
    schema_version: PROFILE, run_id: text(runId), stage: text(stage), status: text(status),
    next_action: text(action), task: text(task),
    pending_decision: ['await-user', 'provide-input', 'reconcile'].includes(action)
      ? { action, kind: text(kind), code: text(code) } : null,
    budget: {
      initial_dispatches: count(budget?.initial_dispatches), continuations: count(budget?.continuations),
      total_used: count(budget?.total_used), reserved: count(budget?.reserved), occupied: count(budget?.occupied),
      observed_calls: count(budget?.observed_calls), issued_unconfirmed: count(budget?.issued_unconfirmed),
      task_calls_used: count(budget?.task_calls_used), total_limit: count(budget?.total_limit),
      remaining_total: count(budget?.remaining_total),
    },
    checkpoint: text(checkpoint),
  };
}

export async function writeBatchCheckpoint(runRoot, values) {
  const row = projectBatchCheckpoint(values);
  const bytes = JSON.stringify(row);
  if (Buffer.byteLength(bytes, 'utf8') > LIMIT) fail('READING_BATCH_SUMMARY_SIZE_EXCEEDED');
  await replaceBatchJson(join(runRoot, SUMMARY_FILE), bytes);
}

export async function replaceBatchJson(path, bytes) {
  const temporary = path + '.writing-' + randomUUID();
  await writeFile(temporary, bytes, { flag: 'wx' });
  try { await rename(temporary, path); }
  catch (error) { await unlink(temporary); throw error; }
}

export async function readBatchCheckpoint(runRoot, runId) {
  const row = await readBatchJson(join(runRoot, SUMMARY_FILE), LIMIT);
  if (!row) return null;
  if (row.schema_version !== PROFILE || row.run_id !== runId) fail('READING_BATCH_SUMMARY_INVALID');
  return projectBatchCheckpoint({ runId, stage: row.stage, status: row.status, action: row.next_action,
    kind: row.pending_decision?.kind, code: row.pending_decision?.code, task: row.task,
    budget: row.budget, checkpoint: row.checkpoint });
}
