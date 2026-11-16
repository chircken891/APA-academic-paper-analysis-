import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegisteredCommit } from './phase22-active-version.mjs';
import { buildRegisteredGraphProposal } from './phase22-graph.mjs';

const defaultVaultRoot = fileURLToPath(new URL('../../', import.meta.url));
export const MANAGED_GRAPH_PATH = '.apa-v3/phase22/graph/MANAGED.json';
export const MANAGED_GRAPH_SCHEMA = 'phase22-managed-graph-1.0';
export const OFFICIAL_GRAPH_SCOPE_PATH = '.apa-v3/phase22/graph/SCOPE.json';
export const OFFICIAL_GRAPH_SCOPE_PROVIDER = 'apa-official-graph';
const fields = ['search', 'hideUnresolved', 'showOrphans'];
const fail = (code, details) => { throw Object.assign(new Error(code), { code, details }); };
const samePolicy = (left, right) => fields.every(field => left?.[field] === right?.[field]);
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');

export function buildOfficialGraphScope(proposal) {
  return {
    schema_version: 'apa-official-graph-scope-1.0', generation_id: proposal.generation_id,
    expected_nodes: proposal.expectedNodes,
    logical_paper_count: proposal.logicalPaperCount, logical_topic_count: proposal.logicalTopicCount,
  };
}

async function readOptional(path) {
  try { return await readFile(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function replaceIfUnchanged(path, original, bytes) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    const current = await readOptional(path);
    if (original === null ? current !== null : current === null || !original.equals(current)) fail('P22_GRAPH_CONCURRENT_CHANGE', { path });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function syncCommittedGraph({ vaultRoot = defaultVaultRoot, enableAutoSync = false, scopeProvider } = {}) {
  const root = resolve(vaultRoot), statePath = join(root, MANAGED_GRAPH_PATH);
  const originalState = await readOptional(statePath);
  const state = originalState === null ? null : JSON.parse(originalState.toString('utf8'));
  if (!enableAutoSync && !state?.enabled) return { ok: true, status: 'disabled' };
  if (!enableAutoSync && (state.schema_version !== MANAGED_GRAPH_SCHEMA || !state.policy)) fail('P22_GRAPH_STATE_INVALID');
  const provider = scopeProvider === undefined ? state?.scope_provider : scopeProvider;
  if (provider !== undefined && provider !== OFFICIAL_GRAPH_SCOPE_PROVIDER) fail('P22_GRAPH_SCOPE_PROVIDER_INVALID', { provider });

  const snapshot = await readRegisteredCommit({ vaultRoot: root });
  if (!snapshot.ok) fail('P22_DEFAULT_COMMITTED_REQUIRED', snapshot);
  const proposal = buildRegisteredGraphProposal({ activeSnapshot: snapshot,
    entityInventory: snapshot.generation.objects.filter(row => row.path.endsWith('.md')).map(({ path }) => ({ path })) });
  const policy = { search: proposal.filter, hideUnresolved: proposal.hideUnresolved, showOrphans: proposal.showOrphans };
  const nextState = { schema_version: MANAGED_GRAPH_SCHEMA, enabled: true, generation_id: snapshot.generation_id, policy,
    ...(provider ? { scope_provider: provider } : {}) };
  const stateCurrent = state?.schema_version === nextState.schema_version && state.enabled === true &&
    state.generation_id === nextState.generation_id && state.scope_provider === provider && samePolicy(state.policy, policy);
  const result = { ok: true, generation_id: snapshot.generation_id, nativeNodeCount: proposal.nativeNodeCount, auto_sync: true };

  if (provider === OFFICIAL_GRAPH_SCOPE_PROVIDER) {
    const scopePath = join(root, OFFICIAL_GRAPH_SCOPE_PATH);
    const originalScope = await readOptional(scopePath);
    const scopeBytes = jsonBytes(buildOfficialGraphScope(proposal));
    const scopeCurrent = originalScope?.equals(scopeBytes) ?? false;
    if (!scopeCurrent) await replaceIfUnchanged(scopePath, originalScope, scopeBytes);
    if (!stateCurrent) await replaceIfUnchanged(statePath, originalState, jsonBytes(nextState));
    return { ...result, status: scopeCurrent && stateCurrent ? 'current' : 'synchronized', scope_provider: provider };
  }

  const graphPath = join(root, '.obsidian/graph.json'), original = await readOptional(graphPath);
  if (original === null) {
    if (enableAutoSync) fail('P22_GRAPH_CONFIG_MISSING', { path: graphPath });
    return { ok: false, status: 'graph_config_missing' };
  }
  const actual = JSON.parse(original.toString('utf8'));
  const isCurrent = samePolicy(actual, policy);
  if (!enableAutoSync && !samePolicy(actual, state.policy) && !isCurrent) {
    return { ok: false, status: 'custom_filter_preserved' };
  }
  let backupPath;
  if (!isCurrent) {
    const digest = createHash('sha256').update(original).digest('hex');
    backupPath = `.apa-v3/phase22/graph/backups/${digest}.json`;
    const backup = join(root, backupPath);
    await mkdir(dirname(backup), { recursive: true });
    try { await writeFile(backup, original, { flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!(await readFile(backup)).equals(original)) fail('P22_GRAPH_BACKUP_MISMATCH', { path: backup });
    }
    await replaceIfUnchanged(graphPath, original, jsonBytes({ ...actual, ...policy }));
  }
  if (!stateCurrent) await replaceIfUnchanged(statePath, originalState, jsonBytes(nextState));
  return { ...result, status: isCurrent ? 'current' : 'synchronized', ...(backupPath ? { backup_path: backupPath } : {}) };
}
