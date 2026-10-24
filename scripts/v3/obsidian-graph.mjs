import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCommittedGeneration } from './phase22-active-version.mjs';
import { buildGraphProposal } from './phase22-graph.mjs';

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
export async function inspectV3Graph({ vaultRoot = defaultVaultRoot, checkConfiguration = true } = {}) {
  const activeSnapshot = await readCommittedIndex(vaultRoot);
  // Generation objects are admitted by the observer; never scan Wiki for candidates.
  const proposal = buildGraphProposal({ activeSnapshot,
    entityInventory: activeSnapshot.generation.objects.filter(row => row.path.endsWith('.md')).map(({ path }) => ({ path })) });
  if (!checkConfiguration) return { ok: true, status: 'proposal', proposal };
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
    if (!['check', 'proposal'].includes(command)) throw Object.assign(new Error('P22_DEFAULT_COMMAND_INVALID'), { code: 'P22_DEFAULT_COMMAND_INVALID', exitCode: 2 });
    const result = await inspectV3Graph({ vaultRoot: parseVaultRoot(tokens), checkConfiguration: command === 'check' });
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) { reportFailure(error); }
}
