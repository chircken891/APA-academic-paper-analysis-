#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCommittedIndex, parseVaultRoot, reportFailure } from './v3/obsidian-graph.mjs';

// The publication transaction builds the index atomically with its generation.
// This command validates the committed index without rewriting it.
export async function checkCommittedIndex(vaultRoot) {
  const snapshot = await readCommittedIndex(vaultRoot);
  return { ok: true, status: 'current', operation: 'validate-committed-index',
    message: 'The publication transaction builds the index; this command only verifies committed generation consistency.',
    generation_id: snapshot.generation_id, evidence_mode: snapshot.evidence_mode,
    document_count: snapshot.index.documents.length, paper_count: snapshot.generation.papers.length };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(JSON.stringify(await checkCommittedIndex(parseVaultRoot(process.argv.slice(2)))) + '\n');
  } catch (error) { reportFailure(error); }
}
