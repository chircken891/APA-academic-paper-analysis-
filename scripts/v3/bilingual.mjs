import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { resolve, join, relative, sep } from 'node:path';
import * as publication from './phase22-publication.mjs';
import { readCommittedGeneration, readRegisteredCommit } from './phase22-active-version.mjs';
import { queryBilingualIndex } from './phase22-search.mjs';
import { buildRegisteredGraphProposal } from './phase22-graph.mjs';

const commands = new Set(['review', 'dry-run', 'apply', 'recover', 'query', 'graph-proposal', 'publish', 'maintenance-review', 'maintenance-apply']);
const commonFlags = ['vault-root', 'run'];
const profiles = new Set(['reading-first-obsidian-1.0', 'phase24-topic-1.0']);
const commandFlags = {
  review: ['profile'], 'dry-run': ['profile'],
  apply: ['review-sha256', 'output-sha256', 'approval-record', 'maintenance-window-record'],
  recover: ['transaction-id', 'approval-record', 'maintenance-window-record'],
  publish: ['run-root', 'generation', 'resources', 'authorization-id', 'user-reply', 'user-corrections'],
  'maintenance-review': ['mode', 'options'],
  'maintenance-apply': ['inventory-sha256', 'authorization-id', 'user-reply'],
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
  const requireAllFlags = ['apply', 'publish', 'maintenance-review', 'maintenance-apply'].includes(command);
  const required = [...commonFlags, ...(requireAllFlags ? commandFlags[command].filter(key => key !== 'user-corrections')
    : command === 'recover' ? ['transaction-id'] : command === 'query' ? ['query'] : [])];
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
  const snapshot = await readRegisteredCommit({ vaultRoot });
  if (!snapshot.ok) fail(snapshot.errors?.[0]?.code ?? 'P22_CLI_COMMITTED_REQUIRED', snapshot.errors?.[0]?.details ?? { status: snapshot.status });
  if (!snapshot.generation.papers.some(paper => paper.run_id === run)) fail('P22_CLI_RUN_NOT_CURRENT', { run });
  return snapshot;
}
async function main(argv) {
  const { command, flags, vaultRoot, run } = parse(argv);
  if (command === 'publish') {
    const { assertReadingFirstRegisteredSourcesCurrent } = await import('./reading-first-publication.mjs');
    await assertReadingFirstRegisteredSourcesCurrent({ vaultRoot });
    const { prepareReadingFirstPublicationQueue, approveAndDrainReadingFirstPublicationQueue } = await import('./reading-first-publication-queue.mjs');
    const resources = JSON.parse(await readFile(flags.resources, 'utf8'));
    const user_corrections = flags['user-corrections'] ? JSON.parse(await readFile(flags['user-corrections'], 'utf8')) : undefined;
    const emit = (event, value) => new Promise((done, reject) => process.stderr.write(JSON.stringify({ event, ...value }) + '\n',
      error => error ? reject(error) : done()));
    const onWait = owner => emit('publication-waiting', owner);
    const { proposal, proposal_sha256 } = await prepareReadingFirstPublicationQueue({ vaultRoot, onWait,
      entries: [{ run, runRoot: resolve(flags['run-root']), resources, generation: flags.generation, user_corrections }] });
    const initial = proposal.entries[0].original.summary;
    await emit('publication-inventory', initial);
    const result = await approveAndDrainReadingFirstPublicationQueue({ vaultRoot, proposal, expectedProposalSha256: proposal_sha256, onWait,
      authorization: { authorization_id: flags['authorization-id'], user_reply: flags['user-reply'] },
      onPrepared: summary => (summary.run_id !== run || summary.derived || summary.requires_reapproval)
        && emit('publication-inventory', summary) });
    return result.published.find(row => row.run_id === run) ?? result;
  }
  if (command === 'maintenance-review' || command === 'maintenance-apply') {
    const { prepareMaintenanceReview, applyMaintenanceReview } = await import('./maintenance-publication.mjs');
    return command === 'maintenance-review'
      ? prepareMaintenanceReview({ vaultRoot, run, mode: flags.mode, optionsFile: flags.options })
      : applyMaintenanceReview({ vaultRoot, run, inventorySha256: flags['inventory-sha256'],
        authorizationId: flags['authorization-id'], userReply: flags['user-reply'],
        onRegistered: intent => new Promise((done, reject) => process.stderr.write(JSON.stringify({ event: 'maintenance-registered', ...intent }) + '\n',
          error => error ? reject(error) : done())) });
  }
  if (command === 'recover') {
    const transaction = await publication.recoverBilingualPublication({ vaultRoot, run, transactionId: flags['transaction-id'],
      ...(flags['approval-record'] ? { approvalRecord: flags['approval-record'] } : {}),
      ...(flags['maintenance-window-record'] ? { maintenanceWindowRecord: flags['maintenance-window-record'] } : {}) });
    const { finishMaintenanceRecovery } = await import('./maintenance-publication.mjs');
    return finishMaintenanceRecovery({ vaultRoot, run, transaction });
  }
  if (command === 'query' || command === 'graph-proposal') {
    const activeSnapshot = await committed(vaultRoot, run);
    if (command === 'graph-proposal') return { ok: true, ...buildRegisteredGraphProposal({ activeSnapshot, entityInventory: await graphInventory(vaultRoot) }) };
    const historical = await readCommittedGeneration({ vaultRoot });
    if (historical.ok && historical.generation_id === activeSnapshot.generation_id) {
      return { ok: true, ...queryBilingualIndex({ index: historical.index, activeSnapshot: historical, query: flags.query }) };
    }
    const { queryLibrary } = await import('./library-query.mjs');
    return { ...await queryLibrary({ vaultRoot, query: flags.query }), scientific_approval: false };
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
    process.stdout.write(JSON.stringify(result.review_path ? result : { ok: false, error: typeof result.error === 'object' && result.error
      ? result.error : { code: result.code ?? 'P22_CLI_REFUSED', details: metadata(result) } }) + '\n');
    process.exitCode = 1;
  } else process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: { code: error.code ?? 'P22_CLI_FAILURE',
    ...(error.message && error.message !== error.code ? { message: error.message } : {}),
    ...(error.details !== undefined ? { details: error.details } : {}) } }) + '\n');
  process.exitCode = error.exitCode === 2 ? 2 : 1;
}
