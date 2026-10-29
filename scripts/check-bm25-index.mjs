#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseVaultRoot, reportFailure } from './v3/obsidian-graph.mjs';
import { readRegisteredCommit } from './v3/phase22-active-version.mjs';

// The publication transaction builds the index atomically with its generation.
// This command validates the committed index without rewriting it.
export async function checkCommittedIndex(vaultRoot) {
  const snapshot = await readRegisteredCommit({ vaultRoot });
  if (!snapshot.ok) throw Object.assign(new Error('P22_DEFAULT_COMMITTED_REQUIRED'), { code: 'P22_DEFAULT_COMMITTED_REQUIRED', details: snapshot });
  if (!snapshot.generation.papers.length) throw Object.assign(new Error('P22_DEFAULT_COMMITTED_EMPTY'), { code: 'P22_DEFAULT_COMMITTED_EMPTY', details: { generation_id: snapshot.generation_id } });
  return { ok: true, status: 'registered_index_valid', operation: 'validate-registered-index',
    message: 'Validated the historical registered index and commit pair. Queries build their current-content index at request time.',
    generation_id: snapshot.generation_id, evidence_mode: snapshot.evidence_mode,
    document_count: snapshot.index.documents.length, paper_count: snapshot.generation.papers.length };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(JSON.stringify(await checkCommittedIndex(parseVaultRoot(process.argv.slice(2)))) + '\n');
  } catch (error) { reportFailure(error); }
}
