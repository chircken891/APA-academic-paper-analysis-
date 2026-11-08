import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { normalizeIndexPath, readRegisteredCommit } from './phase22-active-version.mjs';
import { projectReadingFirstPublicationQueue } from './reading-first-publication.mjs';
import { inspectReadingFirstQueueCandidate, publishReadingFirstCandidate, recoverRegisteredReadingFirstPublication } from './reading-first-publish.mjs';
import { withReadingRuntimeConsumer } from './reading-runtime-cleanup.mjs';
import { captureCompletedReadingSessionPublicationSource } from './reading-session.mjs';
import { readReadingSessionExecution } from './reading-session-cli.mjs';

const PROFILE = 'reading-first-publication-queue-1.0';
const PROPOSAL = 'reading-first-publication-queue-proposal-1.0';
const FILE = 'publication-queue.json';
const kinds = new Set(['paper', 'support', 'asset', 'reader-presentation', 'active', 'index', 'manifest', 'commit']);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value);
const digest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const sha = value => 'sha256:' + createHash('sha256').update(json(value)).digest('hex');
const fail = (code, details) => { throw Object.assign(new Error(code), { code, details }); };

async function rootFor(vaultRoot, evidenceMode) {
  if (!isAbsolute(vaultRoot ?? '') || !['actual', 'synthetic'].includes(evidenceMode)) fail('RF_QUEUE_SCOPE_INVALID');
  const root = await realpath(vaultRoot);
  if (resolve(vaultRoot) !== root || !(await lstat(root)).isDirectory()) fail('RF_QUEUE_SCOPE_INVALID');
  if (evidenceMode === 'synthetic') {
    const path = relative(await realpath(tmpdir()), root);
    if (!path || path === '..' || path.startsWith('..' + sep) || isAbsolute(path)) fail('P22_SYNTHETIC_PUBLICATION_SCOPE');
  }
  return root;
}

async function queueLocation(root, { create = false } = {}) {
  let directory = root;
  for (const name of ['.runtime', 'apa-publication-queue']) {
    directory = join(directory, name);
    if (create) {
      try { await mkdir(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    try {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory) fail('RF_QUEUE_PATH_INVALID');
    } catch (error) {
      if (!create && error.code === 'ENOENT') return null;
      throw error;
    }
  }
  return directory;
}

function entryInput(row) {
  const { run, runRoot, generation, resources, presentationAssetRegistrations } = row ?? {};
  if (!identifier(run) || !isAbsolute(runRoot ?? '') || resolve(runRoot) !== runRoot
    || generation !== undefined && !identifier(generation) || !Array.isArray(resources)
    || presentationAssetRegistrations !== undefined && !Array.isArray(presentationAssetRegistrations)) fail('RF_QUEUE_ENTRY_INVALID', { run });
  return { run, runRoot, resources, ...(generation === undefined ? {} : { generation }),
    ...(presentationAssetRegistrations === undefined ? {} : { presentationAssetRegistrations }) };
}

function validateProposal(proposal, root) {
  if (proposal?.schema_version !== PROPOSAL || proposal.vault_root !== root
    || !['actual', 'synthetic'].includes(proposal.evidence_mode) || !Array.isArray(proposal.entries) || !proposal.entries.length) {
    fail('RF_QUEUE_PROPOSAL_INVALID');
  }
  const runs = new Set(), papers = new Set(), generations = new Set();
  for (const { input, original } of proposal.entries) {
    const { run } = entryInput(input);
    const { summary, original_source: source } = original ?? {};
    const paths = new Set();
    if (runs.has(run) || typeof original?.paper_id !== 'string' || papers.has(original.paper_id)
      || summary?.run_id !== run || !identifier(summary.generation) || generations.has(summary.generation)
      || !digest(summary.hashes?.review_hash) || !digest(summary.hashes?.output_inventory_hash)
      || !digest(source?.recipe_fingerprint) || !digest(source?.candidate_fingerprint) || !digest(source?.reading_review_fingerprint)
      || !Array.isArray(summary.files) || !summary.files.length || summary.files.some(row => {
        const key = normalizeIndexPath(row.path).normalize('NFC').toLowerCase();
        const invalid = paths.has(key) || !kinds.has(row.kind) || !digest(row.byte_sha256)
          || row.before_sha256 !== null && !digest(row.before_sha256)
          || !Number.isSafeInteger(row.byte_length) || row.byte_length < 0;
        paths.add(key);
        return invalid;
      })) fail('RF_QUEUE_PROPOSAL_INVALID', { run });
    runs.add(run);
    papers.add(original.paper_id);
    generations.add(summary.generation);
  }
  return proposal;
}

function validateAuthorization(authorization, count) {
  const reply = authorization?.user_reply;
  if (typeof authorization?.authorization_id !== 'string' || !authorization.authorization_id.trim()
    || typeof reply !== 'string' || !(count === 1 ? /^(?:请|确认|同意)?(?:全部)?发布[。！!]?$/u
      : /^(?:请|确认|同意)?全部发布[。！!]?$/u).test(reply.trim())) fail('RF_QUEUE_APPROVAL_REQUIRED');
}

function verifyApproval(record, root) {
  if (!record || record.proposal_sha256 !== sha(record.proposal)
    || !Number.isFinite(Date.parse(record.approved_at))) fail('RF_QUEUE_APPROVAL_CHANGED');
  validateProposal(record.proposal, root);
  validateAuthorization(record.authorization, record.proposal.entries.length);
  return record;
}

async function readState(root, directory) {
  const empty = { schema_version: PROFILE, vault_root: root, approvals: [], entries: [] };
  if (!directory) return empty;
  const path = join(directory, FILE);
  let bytes;
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || await realpath(path) !== path) fail('RF_QUEUE_PATH_INVALID');
    bytes = await readFile(path);
  } catch (error) { if (error.code === 'ENOENT') return empty; throw error; }
  const state = JSON.parse(bytes);
  if (state.schema_version !== PROFILE || state.vault_root !== root
    || !Array.isArray(state.entries) || !Array.isArray(state.approvals)) fail('RF_QUEUE_STATE_INVALID');
  const latest = new Map(), ids = new Set();
  for (const approval of state.approvals) {
    verifyApproval(approval, root);
    const id = approval.authorization.authorization_id;
    if (ids.has(id)) fail('RF_QUEUE_APPROVAL_CHANGED', { id });
    ids.add(id);
    for (const { input: { run } } of approval.proposal.entries) latest.set(run, { id, approval_sha256: sha(approval) });
  }
  if (!same(state.entries.map(row => row.run), [...latest.keys()])) fail('RF_QUEUE_APPROVED_ORDER_CHANGED');
  let pending = false;
  for (const row of state.entries) {
    const approval = latest.get(row.run);
    if (row.authorization_id !== approval.id || row.approval_sha256 !== approval.approval_sha256
      || !['queued', 'applying', 'awaiting_reapproval', 'published'].includes(row.status)
      || row.status === 'applying' && !row.attempt
      || row.status === 'published' && (pending || row.result?.status !== 'committed')) {
      fail('RF_QUEUE_STATE_INVALID', { run: row.run });
    }
    pending ||= row.status !== 'published';
  }
  return state;
}

async function writeState(directory, state) {
  const temporary = join(directory, FILE + '.' + randomUUID() + '.tmp');
  try {
    const handle = await open(temporary, 'wx');
    try { await handle.writeFile(json(state)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, join(directory, FILE));
  } finally {
    try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

async function lockedQueue(root, callback) {
  const directory = await queueLocation(root, { create: true });
  return withReadingRuntimeConsumer({ repoRoot: root, runId: 'publication-queue', runRoot: directory }, async () => {
    const state = await readState(root, directory);
    return callback(state, () => writeState(directory, state));
  });
}

function captureFor(evidenceMode, captureSource) {
  if (captureSource !== undefined && (evidenceMode !== 'synthetic' || typeof captureSource !== 'function')) fail('RF_QUEUE_SCOPE_INVALID');
  return captureSource ?? captureCompletedReadingSessionPublicationSource;
}

/** Prepare exact inventories against current committed bytes and advisory inventories against preceding projected writes. */
export async function prepareReadingFirstPublicationQueue({ vaultRoot, entries, evidenceMode = 'actual', captureSource } = {}) {
  const root = await rootFor(vaultRoot, evidenceMode), capture = captureFor(evidenceMode, captureSource);
  if (!Array.isArray(entries) || !entries.length) fail('RF_QUEUE_PROPOSAL_INVALID');
  const rows = [], requests = [];
  for (const input of entries.map(entryInput)) {
    const { run, runRoot, ...request } = input;
    const source = await capture({ run, runRoot, vaultRoot: root });
    const original = await inspectReadingFirstQueueCandidate({ source, vaultRoot: root, evidenceMode, ...request });
    if (original.summary.run_id !== run) fail('RF_ONE_STEP_RUN_MISMATCH');
    rows.push({ input, original });
    requests.push({ source, ...request });
  }
  if (rows.length > 1) {
    const projected = await projectReadingFirstPublicationQueue({ vaultRoot: root, requests, evidenceMode });
    const current = projected[0].summary.previous_generation;
    if (rows.some(row => row.original.summary.previous_generation !== current)) fail('RF_QUEUE_PREPARATION_BASE_CHANGED');
    rows.forEach((row, index) => { row.projected = projected[index]; });
  }
  const proposal = validateProposal({ schema_version: PROPOSAL, vault_root: root, evidence_mode: evidenceMode, entries: rows }, root);
  return { ok: true, status: 'awaiting_approval', proposal, proposal_sha256: sha(proposal), business_writes: 0, model_calls: 0 };
}

/** Append the approved order, or replace only the waiting head with a newly approved exact proposal. */
export async function approveReadingFirstPublicationQueue({ vaultRoot, proposal, expectedProposalSha256, authorization } = {}) {
  const root = await rootFor(vaultRoot, proposal?.evidence_mode);
  if (!digest(expectedProposalSha256) || sha(proposal) !== expectedProposalSha256) fail('RF_QUEUE_PROPOSAL_CHANGED');
  validateProposal(proposal, root);
  validateAuthorization(authorization, proposal.entries.length);
  return lockedQueue(root, async (state, save) => {
    if (state.approvals.some(row => row.authorization.authorization_id === authorization.authorization_id)) fail('RF_QUEUE_AUTHORIZATION_REUSED');
    const head = state.entries.find(row => row.status !== 'published');
    const replaced = proposal.entries.length === 1 && head?.status === 'awaiting_reapproval' && head.run === proposal.entries[0].input.run;
    if (!replaced && proposal.entries.some(({ input }) => state.entries.some(row => row.run === input.run))) fail('RF_QUEUE_RUN_ALREADY_ENQUEUED');
    const record = { proposal: structuredClone(proposal), proposal_sha256: expectedProposalSha256,
      authorization: { authorization_id: authorization.authorization_id, user_reply: authorization.user_reply },
      approved_at: new Date().toISOString() };
    state.approvals.push(record);
    const approvalSha256 = sha(record);
    for (const { input: { run } } of proposal.entries) {
      const row = { run, status: 'queued', authorization_id: authorization.authorization_id, approval_sha256: approvalSha256 };
      if (replaced) state.entries[state.entries.indexOf(head)] = row;
      else state.entries.push(row);
    }
    await save();
    return { ok: true, status: 'queued', proposal_sha256: expectedProposalSha256, runs: proposal.entries.map(row => row.input.run) };
  });
}

/** Read the queue without reconstructing a candidate, modifying a lock or opening any paper body. */
export async function readReadingFirstPublicationQueue({ vaultRoot } = {}) {
  const root = await rootFor(vaultRoot, 'actual');
  const directory = await queueLocation(root);
  return { ...await readState(root, directory), queue_path: directory ? join(directory, FILE) : null };
}

function stop(row, status, error, published) {
  return { ok: false, status, run_id: row.run, error: { code: error?.code ?? error?.message, ...(error?.details ? { details: error.details } : {}) }, published };
}

/** Run the durable head through the one-step publisher. The next row starts only after the current result is stored. */
export async function drainReadingFirstPublicationQueue({ vaultRoot, evidenceMode = 'actual', captureSource,
  onPrepared = () => {}, onPublished = () => {} } = {}) {
  const root = await rootFor(vaultRoot, evidenceMode), capture = captureFor(evidenceMode, captureSource);
  return lockedQueue(root, async (state, save) => {
    const published = [];
    const report = async (row, result) => {
      row.status = 'published';
      row.result = result;
      delete row.error;
      await save();
      const item = { run_id: row.run, ...result };
      published.push(item);
      await onPublished(structuredClone(item));
    };
    for (const row of state.entries) {
      if (row.status === 'published') continue;
      if (row.status === 'awaiting_reapproval') return stop(row, row.status, row.error, published);
      const approval = state.approvals.find(item => item.authorization.authorization_id === row.authorization_id);
      if (approval.proposal.evidence_mode !== evidenceMode) fail('RF_QUEUE_SCOPE_INVALID');
      const { input, original } = approval.proposal.entries.find(item => item.input.run === row.run);
      const { run, runRoot, ...request } = input;
      if (row.attempt) {
        let recovery;
        try {
          recovery = await recoverRegisteredReadingFirstPublication({ vaultRoot: root, run, attempt: row.attempt,
            readExecution: async () => {
              if (captureSource) return undefined;
              return readReadingSessionExecution(runRoot);
            } });
        } catch (error) { return stop(row, 'recovery_required', error, published); }
        if (recovery.status === 'committed') { await report(row, recovery); continue; }
        if (recovery.status !== 'rolled_back') return stop(row, 'recovery_required', { code: recovery.status, details: recovery }, published);
        (row.recovered_attempts ??= []).push({ ...row.attempt, recovery });
        delete row.attempt;
        row.status = 'queued';
        row.retry_generation = 'rf-queue-' + randomUUID();
        await save();
      }
      const current = await readRegisteredCommit({ vaultRoot: root });
      if (current.ok && current.generation.papers.some(paper => paper.run_id === run)) {
        return stop(row, 'recovery_required', { code: 'RF_QUEUE_RUN_ALREADY_PUBLISHED' }, published);
      }
      let result;
      try {
        const source = await capture({ run, runRoot, vaultRoot: root });
        const binding = { queue_proposal_sha256: approval.proposal_sha256, queue_approval_sha256: row.approval_sha256,
          approved_position: approval.proposal.entries.findIndex(item => item.input.run === run) + 1 };
        result = await publishReadingFirstCandidate({ ...request, generation: row.retry_generation ?? original.summary.generation,
          source, vaultRoot: root, run, evidenceMode, authorization: approval.authorization, queuedApproval: { original, binding },
          onPrepared, onRegistered: async attempt => {
            row.status = 'applying';
            row.attempt = attempt;
            await save();
          } });
      } catch (error) {
        if (row.attempt) return stop(row, 'recovery_required', error, published);
        result = { status: 'awaiting_reapproval', error: { code: error.code ?? error.message, details: error.details } };
      }
      if (result.status === 'committed') { await report(row, result); continue; }
      row.error = result.error;
      if (!row.attempt) row.status = 'awaiting_reapproval';
      await save();
      return { ...stop(row, row.attempt ? 'recovery_required' : row.status, row.error, published), result };
    }
    return { ok: true, status: 'complete', published };
  });
}
