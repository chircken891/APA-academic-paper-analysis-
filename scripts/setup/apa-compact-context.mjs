import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Claude Code SessionStart (matcher "compact") hook. Read-only: finds the APA run that is still in progress and prints
// its pointers (run id, run root, checkpoint path, accepted roles, next step, budget) as additionalContext.
// Never prints paper text, prompts, tokens or request bodies; only whitelisted fields are copied out of state files.
// Any failure prints {} and a short reason on stderr, with exit code 0, so session start is never blocked.
const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = resolve(dirname(scriptPath), '../..');
const MAX_CONTEXT = 4000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_RUN_DIRECTORIES = 20;
const MAX_SCAN_FILES = 400;
const SCIENCE_STATE_SCHEMA = 'science-controller-state-1.0';
// Mirrors scripts/v3/science-controller.mjs; kept local so the hook loads no workflow modules.
const scienceRoles = ['evidence', 'methods', 'results', 'interpretation', 'scientific-reading', 'integration'];
const scienceDependencies = { evidence: [], methods: ['evidence'], results: ['evidence'], interpretation: ['evidence', 'methods', 'results'], 'scientific-reading': ['evidence', 'methods', 'results', 'interpretation'], integration: ['evidence', 'methods', 'results', 'interpretation', 'scientific-reading'] };
const RESULT_FILES = ['RESULT.json', 'RESULT.md'];
// A recorded publication: PUBLICATION-RESULT.json (bridge result) or publication/APPLIED.json (applied transaction).
const PUBLICATION_FILES = ['PUBLICATION-RESULT.json', join('publication', 'APPLIED.json')];
const SKIPPED_DIRECTORIES = new Set(['.phase21-receipts', 'parser', 'assets', 'accepted', 'native', 'observations', 'requests', 'instructions', 'checkpoints', 'science']);
const RECOVERY_RULE = 'docs: .agents/skills/academic-paper-analysis/references/execution-and-recovery.md (Continue the same run after compaction)';

const clean = (value, limit = 240) => {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - 1);
  return `${/[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut}…`;
};

function readJson(file) {
  if (statSync(file).size > MAX_FILE_BYTES) throw Object.assign(new Error(`${file} is larger than ${MAX_FILE_BYTES} bytes`), { code: 'APA_FILE_TOO_LARGE', file });
  return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

function peek(file, bytes = 256) {
  const descriptor = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    return buffer.subarray(0, readSync(descriptor, buffer, 0, bytes, 0)).toString('utf8');
  } finally {
    closeSync(descriptor);
  }
}

function runsRootOf(repoRoot) {
  let configured = null;
  try {
    configured = readJson(join(repoRoot, 'config', 'apa.local.json'))?.paths?.runs;
  } catch { /* no usable configuration: use the default layout */ }
  const text = typeof configured === 'string' && configured.trim() ? configured : 'Eval/apa-v3/runs';
  return isAbsolute(text) ? resolve(text) : resolve(repoRoot, text);
}

function findScienceStateFile(runDirectory) {
  const found = [];
  let scanned = 0;
  const scan = (directory, depth) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (scanned >= MAX_SCAN_FILES) return;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth < 1 && !SKIPPED_DIRECTORIES.has(entry.name)) scan(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        scanned += 1;
        try {
          if (/^\s*\{\s*"schema_version"\s*:\s*"science-controller-state-1\.0"/.test(peek(full))) found.push({ file: full, mtime: statSync(full).mtimeMs });
        } catch { /* unreadable candidates are not state files */ }
      }
    }
  };
  scan(runDirectory, 0);
  found.sort((left, right) => right.mtime - left.mtime);
  return found[0]?.file ?? null;
}

function latestCheckpoint(runDirectory) {
  const directory = join(runDirectory, 'checkpoints');
  if (!existsSync(directory)) return null;
  let latest = null;
  for (const name of readdirSync(directory)) {
    const match = /^(\d+)\.json$/.exec(name);
    if (match && (latest === null || Number(match[1]) > latest.number)) latest = { number: Number(match[1]), file: join(directory, name) };
  }
  if (!latest) return null;
  const receiptDirectory = join(runDirectory, '.phase21-receipts');
  let receiptFile = null;
  if (existsSync(receiptDirectory)) {
    for (const name of readdirSync(receiptDirectory)) {
      if (!name.endsWith('.json')) continue;
      try {
        const receipt = readJson(join(receiptDirectory, name));
        if (receipt?.path === `checkpoints/${latest.number}.json` && receipt.role === 'control') { receiptFile = join(receiptDirectory, name); break; }
      } catch { /* a bad receipt only means no receipt path is reported */ }
    }
  }
  return { ...latest, receiptFile };
}

const acceptedFiles = runDirectory => {
  const directory = join(runDirectory, 'accepted');
  return existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith('.json')).sort().map(name => name.replace(/\.json$/, '')) : [];
};

function scienceSummary(data) {
  const entries = data.entries ?? {};
  const status = role => {
    const entry = entries[role] ?? {};
    return entry.receipt ? 'accepted' : entry.observation?.status === 'observed' ? 'observed' : entry.intent ? 'outcome_unknown' : entry.request ? 'prepared' : 'waiting';
  };
  const statuses = Object.fromEntries(scienceRoles.map(role => [role, status(role)]));
  const next = [];
  for (const role of scienceRoles) {
    const entry = entries[role] ?? {};
    if (entry.receipt) continue;
    if (entry.observation?.status === 'observed') next.push(`${role}: ${entry.content_base64 ? 'accept_result' : 'wait_or_query_host, then accept_result'}`);
    else if (entry.intent) next.push(`${role}: reconcile_host (dispatch intent recorded, never redispatch)`);
    else if (entry.request) next.push(`${role}: record_dispatch_intent`);
    else if (scienceDependencies[role].every(dep => entries[dep]?.receipt)) next.push(`${role}: prepare_request`);
  }
  const allAccepted = scienceRoles.every(role => entries[role]?.receipt);
  if (allAccepted) next.push(data.handoff?.status === 'transferred' ? 'continue_downstream' : data.handoff ? 'continue_handoff (same checkpoint binding)' : 'create_handoff');
  const binding = data.prepared?.runControl?.reading_first_binding ?? {};
  return {
    version: clean(data.version, 20),
    runId: data.prepared?.runControl?.run_id ?? null,
    runRoot: data.prepared?.paths?.runRoot ?? null,
    deadline: binding.deadline ?? null,
    maxTotalCalls: Number.isInteger(binding.max_total_calls) ? binding.max_total_calls : null,
    reservedCalls: scienceRoles.filter(role => entries[role]?.intent).length,
    statuses,
    accepted: scienceRoles.filter(role => statuses[role] === 'accepted'),
    next,
    transferred: data.handoff?.status === 'transferred',
    handoffStatus: typeof data.handoff?.status === 'string' ? clean(data.handoff.status, 60) : null,
  };
}

function checkpointSummary(checkpoint) {
  const state = checkpoint.state ?? {};
  const observed = (Array.isArray(state.observations) ? state.observations : []).filter(item => item?.host?.status === 'observed').map(item => item.task_id).filter(id => typeof id === 'string');
  return {
    status: typeof state.status === 'string' ? state.status : null,
    callsUsed: Number.isInteger(state.callsUsed) ? state.callsUsed : null,
    reviews: Number.isInteger(state.reviews) ? state.reviews : null,
    pendingRevisions: (Array.isArray(state.pending_revision_keys) ? state.pending_revision_keys : []).filter(key => typeof key === 'string').map(key => clean(key, 80)),
    requestsLogged: Array.isArray(state.requestLog) ? state.requestLog.length : null,
    observed,
  };
}

const downstreamNext = summary => {
  if (summary.pendingRevisions.length) return `revision requests pending (${summary.pendingRevisions.join(', ')}): consume the generated requests, do not recreate them`;
  const map = {
    drafting: 'continue drafting: reconcile dispatched Writer/Editor tasks and consume the original generated requests',
    revision_required: 'revision_required: continue the single bounded revision route from the generated requests',
  };
  return map[summary.status] ?? `status ${summary.status ?? 'unknown'}: reconcile process status, status files and accepted outputs, then continue the same Controller`;
};

// A run is listed unless it is closed: a final result record (RESULT.json/md), status completed_with_limits, or
// reading_complete with a recorded publication. reading_complete without either is still open (publication follows it).
// A run past its deadline is listed and marked expired, never hidden.
function inspectRun(runDirectory, now) {
  const name = runDirectory.split(/[\\/]/).pop();
  if (RESULT_FILES.some(file => existsSync(join(runDirectory, file)))) return null;
  const stateFile = findScienceStateFile(runDirectory);
  const checkpoint = latestCheckpoint(runDirectory);
  if (!stateFile && !checkpoint) return null;
  const oversize = [];
  // A state file above the read cap is not parsed; the run is still listed with a pointer to it.
  const bounded = read => {
    try { return read(); } catch (cause) {
      if (cause.code !== 'APA_FILE_TOO_LARGE') throw cause;
      oversize.push(cause.file);
      return null;
    }
  };
  const science = stateFile ? bounded(() => scienceSummary(readJson(stateFile).data ?? {})) : null;
  const downstream = checkpoint ? bounded(() => checkpointSummary(readJson(checkpoint.file))) : null;
  if (downstream?.status === 'completed_with_limits') return null;
  if (downstream?.status === 'reading_complete' && PUBLICATION_FILES.some(file => existsSync(join(runDirectory, file)))) return null;
  let runRecord = {};
  try { runRecord = readJson(join(runDirectory, 'RUN.json')); } catch { /* RUN.json is optional here */ }
  const deadline = science?.deadline ?? (typeof runRecord.deadline === 'string' ? runRecord.deadline : null);
  const expired = Boolean(deadline) && Number.isFinite(Date.parse(deadline)) && now >= Date.parse(deadline);
  const maxTotal = science?.maxTotalCalls ?? (Number.isInteger(runRecord.max_total_calls) ? runRecord.max_total_calls : null);
  return {
    runId: science?.runId ?? (typeof runRecord.run_id === 'string' ? runRecord.run_id : name),
    runRoot: runDirectory,
    runRecord: existsSync(join(runDirectory, 'RUN.json')) ? join(runDirectory, 'RUN.json') : null,
    stateFile, science, checkpoint, downstream, deadline, expired, maxTotal, oversize,
    accepted: acceptedFiles(runDirectory),
  };
}

function formatRun(run, omitted = 0) {
  const lines = [`APA run in progress: ${clean(run.runId, 120)}${run.expired ? ' [expired]' : ''}`];
  if (omitted) lines.push(`${omitted} older run director${omitted === 1 ? 'y was' : 'ies were'} not scanned (only the ${MAX_RUN_DIRECTORIES} most recently modified are).`);
  lines.push(`run root: ${run.runRoot}`);
  if (run.oversize.length) lines.push(`too large to summarize (over ${MAX_FILE_BYTES} bytes), read directly: ${run.oversize.join(', ')}`);
  if (run.runRecord) lines.push(`run binding: ${run.runRecord}`);
  if (run.stateFile) lines.push(`science Controller state: ${run.stateFile}${run.science ? ` (version ${run.science.version}, handoff ${run.science.handoffStatus ?? 'not started'})` : ''}`);
  if (run.checkpoint) {
    lines.push(`latest reading-first checkpoint: ${run.checkpoint.file}`);
    lines.push(`checkpoint receipt: ${run.checkpoint.receiptFile ?? 'not found'}`);
  } else lines.push('latest reading-first checkpoint: not established (science stage; preserve the science Controller state, receipts and request pointers instead)');
  if (run.science) {
    lines.push(`science roles: ${scienceRoles.map(role => `${role}=${run.science.statuses[role]}`).join(', ')}`);
    lines.push(`accepted science results: ${run.science.accepted.length ? run.science.accepted.join(', ') : 'none'}`);
  }
  if (run.accepted.length) lines.push(`accepted downstream outputs (accepted/): ${run.accepted.join(', ')}`);
  if (run.downstream) {
    lines.push(`downstream status: ${clean(run.downstream.status ?? 'unknown', 60)}; calls used ${run.downstream.callsUsed ?? 'unknown'}; reviews ${run.downstream.reviews ?? 'unknown'}`);
    if (run.downstream.observed.length) lines.push(`observed host tasks: ${run.downstream.observed.map(id => clean(id, 80)).join(', ')}`);
  }
  const detail = run.downstream && (!run.science || run.science.transferred) ? [downstreamNext(run.downstream)] : run.science?.next ?? [];
  const next = run.downstream?.status === 'reading_complete' ? ['等待发布或确认收尾']
    : run.expired ? ['expired: the deadline has passed and the runtime accepts no new calls; report this to the user, do not dispatch'] : detail;
  lines.push(`next step: ${next.length ? next.join('; ') : 'reconcile process status and status files, then continue the same Controller'}`);
  const budget = [];
  if (run.maxTotal !== null) {
    const used = run.downstream?.callsUsed ?? run.science?.reservedCalls ?? null;
    budget.push(`total call cap ${run.maxTotal}${used === null ? '' : `, used ${used}, remaining ${Math.max(0, run.maxTotal - used)}`}`);
  }
  if (run.deadline) budget.push(`deadline ${clean(run.deadline, 60)}${run.expired ? ' (expired)' : ''}`);
  if (budget.length) lines.push(`budget: ${budget.join('; ')}`);
  lines.push('Continue the existing Controller process; a compaction is not a restart. Never redispatch an already dispatched unfinished task.', RECOVERY_RULE);
  return lines;
}

function formatMany(runs, omitted = 0) {
  return [`Several APA runs look in progress (${runs.length}); none was chosen. Check each and decide which to continue:`,
    ...(omitted ? [`${omitted} older run director${omitted === 1 ? 'y was' : 'ies were'} not scanned (only the ${MAX_RUN_DIRECTORIES} most recently modified are).`] : []),
    ...runs.map(run => `- ${clean(run.runId, 120)}${run.expired ? ' [expired]' : ''}: ${run.runRoot}`), RECOVERY_RULE];
}

// Keeps whole lines and ends with a marker; the result is never longer than the cap.
export function fitContext(lines, limit = MAX_CONTEXT) {
  const joined = lines.join('\n');
  if (joined.length <= limit) return joined;
  const marker = '\n[truncated]';
  let kept = '';
  for (const line of lines) {
    const candidate = kept ? `${kept}\n${line}` : line;
    if (candidate.length + marker.length > limit) break;
    kept = candidate;
  }
  if (!kept) {
    const cut = joined.slice(0, limit - marker.length);
    kept = /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
  }
  return kept + marker;
}

export function buildHookOutput({ repoRoot = defaultRepoRoot, now = Date.now(), warn = () => {} } = {}) {
  const runsRoot = runsRootOf(repoRoot);
  if (!existsSync(runsRoot) || !statSync(runsRoot).isDirectory()) return {};
  const active = [];
  // Bounded scan: only the most recently modified run directories are inspected.
  const directories = readdirSync(runsRoot, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .flatMap(entry => {
      // One unreadable run directory is skipped rather than losing the whole output.
      try { return [{ name: entry.name, mtime: statSync(join(runsRoot, entry.name)).mtimeMs }]; } catch (cause) {
        warn(`skipped ${entry.name}: ${clean(cause.message, 160)}`);
        return [];
      }
    })
    .sort((left, right) => right.mtime - left.mtime || left.name.localeCompare(right.name));
  const omitted = Math.max(0, directories.length - MAX_RUN_DIRECTORIES);
  for (const { name } of directories.slice(0, MAX_RUN_DIRECTORIES).sort((left, right) => left.name.localeCompare(right.name))) {
    try {
      const run = inspectRun(join(runsRoot, name), now);
      if (run) active.push(run);
    } catch (cause) {
      warn(`skipped ${relative(repoRoot, join(runsRoot, name)) || name}: ${clean(cause.message, 160)}`);
    }
  }
  if (active.length === 0) {
    if (omitted) warn(`${omitted} older run directories were not scanned`);
    return {};
  }
  const lines = active.length === 1 ? formatRun(active[0], omitted) : formatMany(active, omitted);
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: fitContext(lines) } };
}

function parseRepoRoot(argv) {
  const index = argv.indexOf('--repo-root');
  if (index === -1) return defaultRepoRoot;
  if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('--repo-root needs a path');
  return resolve(argv[index + 1]);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  let output = {};
  try {
    output = buildHookOutput({ repoRoot: parseRepoRoot(process.argv.slice(2)), warn: message => console.error(`apa-compact-context: ${message}`) });
  } catch (cause) {
    console.error(`apa-compact-context: ${clean(cause?.message ?? cause, 200)}`);
    output = {};
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exitCode = 0;
}
