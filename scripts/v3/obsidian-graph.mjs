import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { readCommittedGeneration, readRegisteredCommit } from './phase22-active-version.mjs';
import { buildRegisteredGraphProposal } from './phase22-graph.mjs';
import { buildOfficialGraphScope, MANAGED_GRAPH_PATH, MANAGED_GRAPH_SCHEMA,
  OFFICIAL_GRAPH_SCOPE_PATH, OFFICIAL_GRAPH_SCOPE_PROVIDER, syncCommittedGraph } from './obsidian-graph-sync.mjs';

export const defaultVaultRoot = fileURLToPath(new URL('../../', import.meta.url));
export async function readCommittedIndex(vaultRoot = defaultVaultRoot) {
  const snapshot = await readCommittedGeneration({ vaultRoot });
  if (!snapshot.ok) throw Object.assign(new Error('P22_DEFAULT_COMMITTED_REQUIRED'), {
    code: 'P22_DEFAULT_COMMITTED_REQUIRED', details: snapshot,
  });
  if (!snapshot.generation.papers.length) throw Object.assign(new Error('P22_DEFAULT_COMMITTED_EMPTY'), {
    code: 'P22_DEFAULT_COMMITTED_EMPTY', details: { generation_id: snapshot.generation_id },
  });
  return snapshot;
}

async function readOptionalJson(vaultRoot, relativePath) {
  const path = resolve(vaultRoot, relativePath);
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw Object.assign(error, { code: 'P22_GRAPH_JSON_INVALID', details: { path } });
    throw error;
  }
}

async function inspectOfficialGraphScope(vaultRoot, state, proposal) {
  const provider = OFFICIAL_GRAPH_SCOPE_PROVIDER;
  const [scope, manifest, plugins] = await Promise.all([
    readOptionalJson(vaultRoot, OFFICIAL_GRAPH_SCOPE_PATH),
    readOptionalJson(vaultRoot, `.obsidian/plugins/${provider}/manifest.json`),
    readOptionalJson(vaultRoot, '.obsidian/community-plugins.json'),
  ]);
  const actual = { ...scope, managed_schema_version: state.schema_version, managed_enabled: state.enabled,
    managed_generation_id: state.generation_id, plugin_manifest_id: manifest?.id,
    plugin_enabled: Array.isArray(plugins) && plugins.includes(provider) };
  const expected = { ...buildOfficialGraphScope(proposal), managed_schema_version: MANAGED_GRAPH_SCHEMA,
    managed_enabled: true, managed_generation_id: proposal.generation_id, plugin_manifest_id: provider, plugin_enabled: true };
  const differences = Object.entries(expected).filter(([field, value]) => !isDeepStrictEqual(actual[field], value))
    .map(([field, value]) => ({ field, expected: value, actual: actual[field] ?? null }));
  return { ok: differences.length === 0, status: differences.length ? 'not_ready' : 'current',
    generation_id: proposal.generation_id, scope_provider: provider, differences, proposal, native_gui: 'not_run' };
}

export async function inspectV3Graph({ vaultRoot = defaultVaultRoot, checkConfiguration = true } = {}) {
  const activeSnapshot = await readRegisteredCommit({ vaultRoot });
  if (!activeSnapshot.ok) throw Object.assign(new Error('P22_DEFAULT_COMMITTED_REQUIRED'), { code: 'P22_DEFAULT_COMMITTED_REQUIRED', details: activeSnapshot });
  if (!activeSnapshot.generation.papers.length) throw Object.assign(new Error('P22_DEFAULT_COMMITTED_EMPTY'), { code: 'P22_DEFAULT_COMMITTED_EMPTY', details: { generation_id: activeSnapshot.generation_id } });
  // Generation objects are admitted by the observer; never scan Wiki for candidates.
  const proposal = buildRegisteredGraphProposal({ activeSnapshot,
    entityInventory: activeSnapshot.generation.objects.filter(row => row.path.endsWith('.md')).map(({ path }) => ({ path })) });
  if (!checkConfiguration) return { ok: true, status: 'proposal', proposal };
  const state = await readOptionalJson(vaultRoot, MANAGED_GRAPH_PATH);
  if (state?.scope_provider === OFFICIAL_GRAPH_SCOPE_PROVIDER) return inspectOfficialGraphScope(vaultRoot, state, proposal);
  const actual = JSON.parse(await readFile(resolve(vaultRoot, '.obsidian/graph.json'), 'utf8'));
  const expected = { search: proposal.filter, hideUnresolved: proposal.hideUnresolved, showOrphans: proposal.showOrphans };
  const differences = Object.entries(expected).filter(([field, value]) => actual[field] !== value)
    .map(([field, value]) => ({ field, expected: value, actual: actual[field] ?? null }));
  return { ok: differences.length === 0, status: differences.length ? 'not_ready' : 'current',
    generation_id: activeSnapshot.generation_id, actual: Object.fromEntries(Object.keys(expected).map(key => [key, actual[key] ?? null])),
    differences, proposal, native_gui: 'not_run' };
}
export function parseVaultRoot(tokens) {
  if (!tokens.length) return defaultVaultRoot;
  if (tokens.length !== 2 || tokens[0] !== '--vault-root' || !tokens[1] || tokens[1].startsWith('--')) {
    throw Object.assign(new Error('P22_DEFAULT_ARGUMENT_INVALID'), { code: 'P22_DEFAULT_ARGUMENT_INVALID', exitCode: 2 });
  }
  return resolve(tokens[1]);
}
export function reportFailure(error) {
  process.stdout.write(JSON.stringify({ ok: false, status: 'not_ready', error: {
    code: error.code ?? 'P22_DEFAULT_FAILURE', message: error.message,
    ...(error.details ? { details: error.details } : {}),
  } }) + '\n');
  process.exitCode = error.exitCode ?? 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...tokens] = process.argv.slice(2);
    if (!['check', 'proposal', 'sync', 'sync-plugin'].includes(command)) throw Object.assign(new Error('P22_DEFAULT_COMMAND_INVALID'), { code: 'P22_DEFAULT_COMMAND_INVALID', exitCode: 2 });
    const vaultRoot = parseVaultRoot(tokens);
    const result = command === 'sync' || command === 'sync-plugin' ? await syncCommittedGraph({ vaultRoot, enableAutoSync: true,
      scopeProvider: command === 'sync-plugin' ? OFFICIAL_GRAPH_SCOPE_PROVIDER : undefined })
      : await inspectV3Graph({ vaultRoot, checkConfiguration: command === 'check' });
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) { reportFailure(error); }
}
