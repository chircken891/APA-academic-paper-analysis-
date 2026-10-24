import { lstat, readdir, realpath } from 'node:fs/promises';
import { resolve, join, relative, sep } from 'node:path';
import * as publication from './phase22-publication.mjs';
import { readCommittedGeneration } from './phase22-active-version.mjs';
import { queryBilingualIndex } from './phase22-search.mjs';
import { buildGraphProposal } from './phase22-graph.mjs';

const commands = new Set(['review', 'dry-run', 'apply', 'recover', 'query', 'graph-proposal']);
const commonFlags = ['vault-root', 'run'];
const profiles = new Set(['phase22-managed-note-1.0', 'phase22-reader-note-1.0', 'reading-first-obsidian-1.0']);
const commandFlags = {
  review: ['profile'], 'dry-run': ['profile'],
  apply: ['review-sha256', 'output-sha256', 'approval-record', 'maintenance-window-record'],
  recover: ['transaction-id', 'approval-record', 'maintenance-window-record'],
  query: ['query'], 'graph-proposal': [],
};
function fail(code, details, exitCode = 1) {
  throw Object.assign(new Error(code), { code, details, exitCode });
}
function parse(argv) {
  const [command, ...tokens] = argv;
  if (!commands.has(command)) fail('P22_CLI_COMMAND_INVALID', { commands: [...commands] }, 2);
  const allowed = new Set([...commonFlags, ...commandFlags[command]]), flags = {};
  for (let i = 0; i < tokens.length; i += 2) {
    const key = tokens[i].startsWith('--') ? tokens[i].slice(2) : '';
    const value = tokens[i + 1];
    if (!allowed.has(key) || Object.hasOwn(flags, key) || typeof value !== 'string' || !value.trim() || value.startsWith('--')) {
      fail('P22_CLI_ARGUMENT_INVALID', { flag: tokens[i] }, 2);
    }
    flags[key] = value;
  }
  const required = [...commonFlags, ...(command === 'apply' ? commandFlags.apply : command === 'recover' ? ['transaction-id'] : command === 'query' ? ['query'] : [])];
  const missing = required.filter(key => !flags[key]);
  if (missing.length) fail('P22_CLI_ARGUMENT_REQUIRED', { missing }, 2);
  if (flags.profile && !profiles.has(flags.profile)) fail('P221_CLI_PROFILE_UNKNOWN', { profile: flags.profile }, 2);
  return { command, flags, vaultRoot: resolve(flags['vault-root']), run: flags.run };
}
// Private owned plans contain bytes; public CLI review/dry-run expose metadata only.
function metadata(value) {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Uint8Array) return undefined;
  if (Array.isArray(value)) return value.map(metadata);
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'bytes')
    .map(([key, item]) => [key, metadata(item)]));
}
async function graphInventory(vaultRoot) {
  const rootStat = await lstat(vaultRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail('P22_CLI_GRAPH_PATH_TYPE', { path: '.' });
  const root = await realpath(vaultRoot), entries = [];
  async function walk(path) {
    const absolute = join(root, path), stat = await lstat(absolute);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) {
      fail('P22_CLI_GRAPH_PATH_TYPE', { path });
    }
    const actual = await realpath(absolute), rel = relative(root, actual);
    if (rel === '..' || rel.startsWith('..' + sep) || actual !== resolve(root, path)) fail('P22_CLI_GRAPH_PATH_ESCAPE', { path });
    if (stat.isDirectory()) {
      for (const name of (await readdir(absolute)).sort()) await walk(path + '/' + name);
    } else if (/\.md$/i.test(path)) entries.push({ path });
  }
  await walk('Wiki');
  return entries;
}
async function committed(vaultRoot, run) {
  const snapshot = await readCommittedGeneration({ vaultRoot });
  if (!snapshot.ok) fail(snapshot.error?.code ?? 'P22_CLI_COMMITTED_REQUIRED', snapshot.error?.details ?? { status: snapshot.status });
  if (!snapshot.generation.papers.some(paper => paper.run_id === run)) fail('P22_CLI_RUN_NOT_CURRENT', { run });
  return snapshot;
}
async function main(argv) {
  const { command, flags, vaultRoot, run } = parse(argv);
  if (command === 'recover') return publication.recoverBilingualPublication({ vaultRoot, run, transactionId: flags['transaction-id'],
    ...(flags['approval-record'] ? { approvalRecord: flags['approval-record'] } : {}),
    ...(flags['maintenance-window-record'] ? { maintenanceWindowRecord: flags['maintenance-window-record'] } : {}) });
  if (command === 'query' || command === 'graph-proposal') {
    const activeSnapshot = await committed(vaultRoot, run);
    return { ok: true, ...(command === 'query'
      ? queryBilingualIndex({ index: activeSnapshot.index, activeSnapshot, query: flags.query })
      : buildGraphProposal({ activeSnapshot, entityInventory: await graphInventory(vaultRoot) })) };
  }
  const loaded = await publication.loadBilingualPublication({ vaultRoot, run, requireApproval: command === 'apply' });
  if (flags.profile) {
    const observed = Object.hasOwn(loaded.reviewManifest, 'profile') ? loaded.reviewManifest.profile : 'phase22-managed-note-1.0';
    if (!profiles.has(observed)) fail('P221_CLI_PROFILE_UNKNOWN', { profile: observed });
    if (flags.profile !== observed) fail('P221_CLI_PROFILE_MISMATCH', { expected: flags.profile, observed });
  }
  if (command === 'review') return { ok: true, status: 'review', run,
    reviewManifest: metadata(loaded.reviewManifest), hashes: loaded.plan.hashes, inventory: metadata(loaded.plan.inventory),
    evidence_mode: loaded.plan.evidence_mode };
  if (command === 'dry-run') return metadata(await publication.dryRunBilingualPublication({ vaultRoot, run, plan: loaded.plan }));
  return publication.applyBilingualPublication({ vaultRoot, run, plan: loaded.plan, control: loaded.control,
    approvalRecord: flags['approval-record'], maintenanceWindowRecord: flags['maintenance-window-record'],
    expectedReviewSha256: flags['review-sha256'], expectedOutputSha256: flags['output-sha256'] });
}
try {
  const result = await main(process.argv.slice(2));
  if (result?.ok === false) {
    process.stdout.write(JSON.stringify({ ok: false, error: typeof result.error === 'object' && result.error
      ? result.error : { code: result.code ?? 'P22_CLI_REFUSED', details: metadata(result) } }) + '\n');
    process.exitCode = 1;
  } else process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: { code: error.code ?? 'P22_CLI_FAILURE',
    ...(error.message && error.message !== error.code ? { message: error.message } : {}),
    ...(error.details !== undefined ? { details: error.details } : {}) } }) + '\n');
  process.exitCode = error.exitCode === 2 ? 2 : 1;
}
