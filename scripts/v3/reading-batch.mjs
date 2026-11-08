import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectApaConfig, resolveApaConfig } from '../lib/apa-config.mjs';
import { deriveConfiguredMaxCalls } from './configured-reading.mjs';
import { assertReadingFirstRegisteredSourcesCurrent } from './reading-first-publication.mjs';
import { readReadingFirstPublicationQueue } from './reading-first-publication-queue.mjs';
import { withReadingRuntimeConsumer } from './reading-runtime-cleanup.mjs';
import { copyReadingRuntimeSnapshotBinding, prepareReadingRuntimeSnapshot } from './reading-runtime-snapshot.mjs';
import { prepareReadingSources, readRegisteredSourceMatchMetadata } from './reading-source-policy.mjs';
import { BATCH_RUN_FILE, batchRecordHash, projectBatchCheckpoint, readBatchCheckpoint, readBatchJson, replaceBatchJson } from './reading-batch-summary.mjs';

const CODE_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const PROFILE = 'reading-batch-1.0';
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value);
const fail = (code, details) => { throw Object.assign(new Error(code), { code, details }); };
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const normalize = value => typeof value === 'string' ? value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') : '';
const doi = value => String(value ?? '').match(/10\.\d{4,9}\/\S+/i)?.[0].toLowerCase();
const titles = value => (value && typeof value === 'object' ? Object.values(value) : [value]).map(normalize).filter(Boolean);
const errorCode = error => typeof error.code === 'string' ? error.code : 'READING_BATCH_PREPARATION_FAILED';
const missing = error => error.code === 'ENOENT';
const batchRecord = value => JSON.stringify(value) + '\n';
const inside = (root, path) => {
  const suffix = relative(root, path);
  return !!suffix && !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..' + sep);
};

async function directory(path, create = false) {
  if (create) await mkdir(path).catch(error => { if (error.code !== 'EEXIST') throw error; });
  if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) fail('READING_BATCH_RECORD_PATH_INVALID', { path });
  return path;
}

async function vaultPath(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) fail('READING_BATCH_ROOT_REQUIRED');
  return directory(await realpath(value));
}

async function batchLocation(root, batchId, create = false) {
  if (!identifier(batchId)) fail('READING_BATCH_ID_INVALID');
  const runtime = await directory(join(root, '.runtime'), create);
  const base = await directory(join(runtime, 'apa-reading-batches'), create);
  return join(base, batchId + '.json');
}

function budgetOptions(paper, defaults, presentationMode) {
  const { authorizationId, maxTotalCalls, maxCalls, includeRepairs, sessionContext, enrichmentPolicy } = { ...defaults, ...paper };
  const cap = presentationMode === 'reading-editor' ? 8 : 6;
  const min = presentationMode === 'reading-editor' ? 4 : 3;
  const count = maxCalls ?? deriveConfiguredMaxCalls({ maxTotalCalls, presentationMode });
  if (typeof authorizationId !== 'string' || !authorizationId.trim() || !Number.isSafeInteger(maxTotalCalls)
    || !Number.isSafeInteger(count) || count < min || count > cap || maxTotalCalls < count + 6) fail('READING_BATCH_BUDGET_INVALID');
  const effort = sessionContext?.reasoning_effort ?? sessionContext?.effort;
  if (typeof sessionContext?.model !== 'string' || !sessionContext.model.trim()
    || sessionContext.reasoning_effort !== undefined && sessionContext.effort !== undefined && sessionContext.reasoning_effort !== sessionContext.effort) {
    fail('READING_BATCH_SESSION_CONTEXT_INVALID');
  }
  return { authorizationId, maxCalls: count, maxTotalCalls, includeRepairs: includeRepairs === true,
    sessionContext: { model: sessionContext.model, ...(effort === undefined ? {} : { reasoning_effort: effort }) },
    ...(enrichmentPolicy === undefined ? {} : { enrichmentPolicy }) };
}

async function identifySource(path, id, primary) {
  if (typeof path !== 'string' || !isAbsolute(path) || !(primary ? /\.pdf$/i : /\.(?:pdf|docx)$/i).test(path)) {
    fail('READING_BATCH_SOURCE_PATH_INVALID', { path });
  }
  const physical = await realpath(path);
  if (!(await lstat(physical)).isFile()) fail('READING_BATCH_SOURCE_PATH_INVALID', { path });
  const bytes = await readFile(physical);
  return { id, path: resolve(path), sha256: sha(bytes), byte_length: bytes.length };
}

function sameBibliography(a, b) {
  if (doi(a.doi) && doi(a.doi) === doi(b.doi)) return 'doi';
  if (titles(a.title).some(title => titles(b.title).includes(title))) return 'title';
  return null;
}

function rejectDuplicates(rows, registered, metadata) {
  const published = [...metadata.sources, ...metadata.rawSources];
  const objects = registered?.generation.objects.filter(row => row.kind === 'asset' && row.path.startsWith('Clippings/')) ?? [];
  for (const [index, row] of rows.entries()) {
    const { input, sources = [] } = row;
    for (const source of sources) {
      const match = [...objects, ...published].find(item => item.sha256 === source.sha256);
      if (match) fail('READING_BATCH_DUPLICATE_SOURCE', { source: source.path, existing: match.path, basis: 'sha256' });
    }
    const paper = registered?.generation.papers.find(item => item.paper_id === input.paperId);
    if (paper) fail('READING_BATCH_DUPLICATE_SOURCE', { source: input.pdf, existing: paper.paper_id, basis: 'paper_id' });
    for (const existing of published) {
      const basis = sameBibliography(input, existing);
      if (basis) fail('READING_BATCH_DUPLICATE_SOURCE', { source: input.pdf, existing: existing.path, basis });
    }
    for (const earlier of rows.slice(0, index)) {
      const basis = input.pdf === earlier.input.pdf ? 'path'
        : input.paperId && input.paperId === earlier.input.paperId ? 'paper_id'
        : sameBibliography(input, earlier.input);
      if (basis) fail('READING_BATCH_DUPLICATE_SOURCE', { source: input.pdf, existing: earlier.input.pdf, basis });
      for (const source of sources) {
        const duplicate = earlier.sources?.find(item => item.sha256 === source.sha256
          && (source.id === 'paper' || item.id === 'paper'));
        if (duplicate) fail('READING_BATCH_DUPLICATE_SOURCE', { source: source.path, existing: duplicate.path, basis: 'sha256' });
      }
    }
  }
}

function startupPrompt(marker, cli) {
  return [
    '请在独立会话继续此篇已批准的 APA 阅读。读取准备记录中的来源路径、SHA-256、预算和模型身份。',
    '按原单篇流程核对来源与本宿主能力，依据原文确定语言，再用已批准的来源准备解析证据和 scientificInput。',
    '如宿主限流，保留会话、原检查点及宿主回传，按宿主允许的时间从原动作恢复。未知派发结果先核对原调用。',
    '准备完成后调用冻结代码中的 reading-session CLI create，传入冻结参数、实际宿主证据和科学输入。',
    JSON.stringify({ run_id: marker.run_id, run_root: marker.run_root, run_record: join(marker.run_root, BATCH_RUN_FILE), cli }),
  ].join('\n');
}

/** Prepare approved source paths and independent run bindings without starting a host session. */
export async function prepareReadingBatch({ vaultRoot, batchId = 'batch-' + randomUUID(), papers, pdfPaths, defaults = {} } = {}) {
  const root = await vaultPath(vaultRoot);
  if (!identifier(batchId) || papers !== undefined && pdfPaths !== undefined
    || pdfPaths !== undefined && !Array.isArray(pdfPaths)) fail('READING_BATCH_INPUT_INVALID');
  const inputs = papers ?? pdfPaths?.map(pdf => ({ pdf }));
  if (!Array.isArray(inputs) || !inputs.length || inputs.some(row => !row || typeof row.pdf !== 'string'
    || row.supplements !== undefined && !Array.isArray(row.supplements)
    || row.paperId !== undefined && !/^pap_[a-f0-9]{32}$/.test(row.paperId))) fail('READING_BATCH_INPUT_INVALID');
  const registered = await assertReadingFirstRegisteredSourcesCurrent({ vaultRoot: root });
  const metadata = await readRegisteredSourceMatchMetadata({ vaultRoot: root, registered: registered ?? undefined });
  const inspection = inspectApaConfig({ repoRoot: root });
  if (!inspection.exists) fail('APA_LOCAL_CONFIG_REQUIRED');
  if (!inspection.validation.complete) fail('APA_CONFIG_INCOMPLETE');
  const rows = [];
  for (const [index, input] of inputs.entries()) {
    const runId = input.runId ?? 'batch-' + randomUUID();
    if (!identifier(runId) || rows.some(row => row.runId === runId)) fail('READING_BATCH_RUN_ID_INVALID', { run_id: runId });
    const row = { input, runId, runRoot: resolve(root, inspection.config.paths.runs, runId), sources: [] };
    rows.push(row);
    try {
      row.sources.push(await identifySource(input.pdf, 'paper', true));
      for (const [i, path] of (input.supplements ?? []).entries()) row.sources.push(await identifySource(path, 'supplement-' + (i + 1), false));
      row.options = budgetOptions(input, defaults, inspection.config.reading.presentation_mode);
      resolveApaConfig({ config: inspection.config, repoRoot: root, mainSession: row.options.sessionContext });
    } catch (error) {
      row.error = { code: errorCode(error), ...(error.details ? { details: error.details } : {}) };
    }
  }
  rejectDuplicates(rows, registered, metadata);
  const location = await batchLocation(root, batchId, true);
  let manifest, firstRunRoot;
  const runsRoot = resolve(root, inspection.config.paths.runs);
  const result = { schema_version: PROFILE, batch_id: batchId, vault_root: root, runs_root: runsRoot, snapshot_hash: null,
    papers: rows.map(row => ({ run_id: row.runId, run_root: row.runRoot, status: 'preparing' })) };
  try {
    await writeFile(location, batchRecord(result), { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') fail('READING_BATCH_ALREADY_EXISTS', { path: location });
    throw error;
  }
  for (const [index, row] of rows.entries()) {
    const { input, runId, runRoot, sources, options } = row;
    const item = result.papers[index];
    try {
      if (row.error) throw row.error;
      await mkdir(runsRoot, { recursive: true });
      await directory(runsRoot);
      await mkdir(runRoot);
      const prepared = prepareReadingSources({ repoRoot: root, scientificInput: { sources: sources.map(
        (source, index) => index === 0 ? { ...source, doi: input.doi, title: input.title } : source) }, sourceMatchMetadata: metadata });
      const marker = await withReadingRuntimeConsumer({ repoRoot: root, runId, runRoot }, () => {
        let marker;
        const reference = captured => {
          marker = { schema_version: 'reading-batch-run-1.0', vault_root: root, batch_id: batchId,
            run_id: runId, run_root: runRoot, snapshot_hash: captured.snapshot_hash, snapshot_fingerprint: captured.fingerprint,
            configuration_fingerprint: inspection.fingerprint, options,
            sources: prepared.scientificInput.sources, ...(input.paperId ? { paper_id: input.paperId } : {}) };
          const bytes = batchRecord(marker);
          writeFileSync(join(runRoot, BATCH_RUN_FILE), bytes, { flag: 'wx' });
          return { batchRunSha256: batchRecordHash(bytes) };
        };
        if (manifest) copyReadingRuntimeSnapshotBinding({ manifest, fromRunRoot: firstRunRoot, runRoot, runId, reference });
        else {
          manifest = prepareReadingRuntimeSnapshot({ repoRoot: root, codeRoot: CODE_ROOT, runRoot, runId, reference });
          firstRunRoot = runRoot;
          result.snapshot_hash = manifest.snapshot_hash;
        }
        item.snapshot_hash = manifest.snapshot_hash;
        return marker;
      });
      const cli = join(manifest.repo_root, 'scripts', 'v3', 'reading-session-cli.mjs');
      Object.assign(item, { status: 'prepared', budget: { max_calls: options.maxCalls, max_total_calls: options.maxTotalCalls },
        source_paths: marker.sources.map(source => source.path), raw_source_matches: prepared.raw_source_matches,
        startup_prompt: startupPrompt(marker, cli) });
    } catch (error) {
      item.status = 'preparation_failed';
      item.error = { code: errorCode(error), ...(error.details ? { details: error.details } : {}) };
    }
    await replaceBatchJson(location, batchRecord(result));
  }
  return result;
}

function rawRows(record) {
  return (record?.publication_sources?.raw_supplements ?? []).map(row => ({
    path: row.path, title: row.title, doi: row.doi ?? null, trace_reason: row.trace_reason, notes: row.notes,
  })).filter(row => typeof row.path === 'string' && row.path.startsWith('Raw/'));
}

async function paperStatus(root, row, queue) {
  const initial = projectBatchCheckpoint({ runId: row.run_id, stage: 'prepare', status: row.status, budget: {
    total_limit: row.budget?.max_total_calls, total_used: row.status === 'prepared' ? 0 : null,
    observed_calls: row.status === 'prepared' ? 0 : null, issued_unconfirmed: row.status === 'prepared' ? 0 : null,
    remaining_total: row.budget?.max_total_calls,
  } });
  let summary = initial, raw = [], publication = null;
  if (row.status === 'prepared') {
    try {
      if (!isAbsolute(row.run_root) || await realpath(row.run_root) !== row.run_root) fail('READING_BATCH_RUN_RECORD_INVALID');
      summary = await readBatchCheckpoint(row.run_root, row.run_id) ?? initial;
      const verified = await readBatchJson(join(root, 'Eval', 'apa-v3', 'runs', row.run_id, 'publication', 'VERIFICATION.json'));
      if (verified?.status === 'passed') {
        raw = rawRows(verified);
        publication = 'published';
      }
      const terminal = await readBatchJson(join(row.run_root, 'runtime-terminal.json'), 8192);
      if (terminal && terminal.run_id === row.run_id && ['published', 'terminated', 'completed_with_limits'].includes(terminal.status)) {
        summary = { ...summary, status: terminal.status, pending_decision: null, next_action: null };
      }
    } catch (error) {
      summary = { ...initial, status: 'status_unavailable', error: errorCode(error) };
    }
  }
  const queueIndex = queue.findIndex(item => item.run === row.run_id);
  const entry = queue[queueIndex];
  if (entry?.status === 'published') {
    raw = rawRows(entry.result);
    publication = 'published';
  }
  if (publication) summary = { ...summary, stage: 'publication', status: publication, pending_decision: null, next_action: null };
  const pending = entry?.status === 'awaiting_reapproval'
    ? { action: 'await-user', kind: 'publication-reapproval', code: null } : summary.pending_decision;
  const error = row.error?.code;
  return { ...summary, pending_decision: pending,
    ...(error ? { error } : {}),
    publication_queue: entry ? { status: entry.status, position: entry.status === 'published' ? null
      : queue.slice(0, queueIndex + 1).filter(item => item.status !== 'published').length } : null,
    raw_supplement_count: raw.length, raw,
  };
}

/** Aggregate only the run checkpoint projection and queue/publication metadata. */
export async function readReadingBatchStatus({ vaultRoot, batchId } = {}) {
  const root = await vaultPath(vaultRoot);
  const location = await batchLocation(root, batchId).catch(error => { if (missing(error)) return null; throw error; });
  const batch = location && await readBatchJson(location);
  if (batch?.schema_version !== PROFILE || batch.vault_root !== root || batch.batch_id !== batchId
    || !isAbsolute(batch.runs_root ?? '') || !inside(root, batch.runs_root) || !Array.isArray(batch.papers)
    || batch.papers.some(row => !identifier(row.run_id) || row.run_root !== join(batch.runs_root, row.run_id))) {
    fail('READING_BATCH_RECORD_INVALID', { batch_id: batchId });
  }
  const { entries } = await readReadingFirstPublicationQueue({ vaultRoot: root });
  const papers = await Promise.all(batch.papers.map(row => paperStatus(root, row, entries)));
  const raw_supplements = papers.flatMap(row => row.raw.map(item => ({ run_id: row.run_id, ...item })));
  const summaries = papers.map(({ raw, ...row }) => row);
  if (summaries.some(row => Buffer.byteLength(JSON.stringify(row), 'utf8') > 8192)) fail('READING_BATCH_SUMMARY_SIZE_EXCEEDED');
  return { schema_version: PROFILE, batch_id: batchId, snapshot_hash: batch.snapshot_hash,
    papers: summaries, raw_supplements };
}
