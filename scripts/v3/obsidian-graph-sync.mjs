import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegisteredCommit } from './phase22-active-version.mjs';
import { buildRegisteredGraphProposal } from './phase22-graph.mjs';

const defaultVaultRoot = fileURLToPath(new URL('../../', import.meta.url));
const fields = ['search', 'hideUnresolved', 'showOrphans'];
const fail = (code, details) => { throw Object.assign(new Error(code), { code, details }); };
const samePolicy = (left, right) => fields.every(field => left?.[field] === right?.[field]);

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

export async function syncCommittedGraph({ vaultRoot = defaultVaultRoot, enableAutoSync = false } = {}) {
  const root = resolve(vaultRoot), statePath = join(root, '.apa-v3/phase22/graph/MANAGED.json');
  const originalState = await readOptional(statePath);
  const state = originalState === null ? null : JSON.parse(originalState.toString('utf8'));
  if (!enableAutoSync && !state?.enabled) return { ok: true, status: 'disabled' };
  if (!enableAutoSync && (state.schema_version !== 'phase22-managed-graph-1.0' || !state.policy)) fail('P22_GRAPH_STATE_INVALID');

  const snapshot = await readRegisteredCommit({ vaultRoot: root });
  if (!snapshot.ok) fail('P22_DEFAULT_COMMITTED_REQUIRED', snapshot);
  const proposal = buildRegisteredGraphProposal({ activeSnapshot: snapshot,
    entityInventory: snapshot.generation.objects.filter(row => row.path.endsWith('.md')).map(({ path }) => ({ path })) });
  const policy = { search: proposal.filter, hideUnresolved: proposal.hideUnresolved, showOrphans: proposal.showOrphans };
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
    await replaceIfUnchanged(graphPath, original, Buffer.from(JSON.stringify({ ...actual, ...policy }, null, 2) + '\n'));
  }
  const nextState = { schema_version: 'phase22-managed-graph-1.0', enabled: true, generation_id: snapshot.generation_id, policy };
  if (!state || state.schema_version !== nextState.schema_version || state.enabled !== true ||
      state.generation_id !== nextState.generation_id || !samePolicy(state.policy, policy)) {
    await replaceIfUnchanged(statePath, originalState, Buffer.from(JSON.stringify(nextState, null, 2) + '\n'));
  }
  return { ok: true, status: isCurrent ? 'current' : 'synchronized', generation_id: snapshot.generation_id,
    nativeNodeCount: proposal.nativeNodeCount, ...(backupPath ? { backup_path: backupPath } : {}), auto_sync: true };
}
