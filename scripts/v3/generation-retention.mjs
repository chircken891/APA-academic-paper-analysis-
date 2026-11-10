import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertActiveIndexContract, PHASE22_COMMIT_PATH } from './phase22-active-version.mjs';

const CONTROL = '.apa-v3/phase22';
const GENERATIONS = CONTROL + '/generations';
const TRANSACTIONS = CONTROL + '/transactions';
const GENERATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const TERMINAL = new Set(['committed', 'rolled_back']);
const KNOWLEDGE_MERGE_PROFILE = 'phase22-knowledge-merge-1.0';

const sha256 = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function protectedByOpenTransactions(root) {
  const keep = new Set();
  let entries = [];
  try { entries = await readdir(join(root, TRANSACTIONS), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return keep; throw error; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let journal;
    try { journal = await readJson(join(root, TRANSACTIONS, entry.name, 'journal.json')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (TERMINAL.has(journal.state)) continue;
    for (const id of [journal.generation, journal.previous_generation]) if (typeof id === 'string') keep.add(id);
  }
  return keep;
}

// Merge compensation reads the merge generation's manifest and active files and
// the pre-merge active file, so those small files survive pruning.
async function mergeCompensationFiles(root, names) {
  const keep = new Set();
  for (const name of names) {
    let manifest;
    try { manifest = await readJson(join(root, GENERATIONS, name, 'manifest.json')); }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) continue; throw error; }
    if (manifest.profile !== KNOWLEDGE_MERGE_PROFILE || manifest.maintenance?.operation !== 'merge') continue;
    keep.add(GENERATIONS + '/' + name + '/manifest.json').add(GENERATIONS + '/' + name + '/active.json');
    if (typeof manifest.previous_generation === 'string') keep.add(GENERATIONS + '/' + manifest.previous_generation + '/active.json');
  }
  return keep;
}

/**
 * Keep the committed generation and the one it replaced; remove older generation
 * directories. Generations named by unfinished transactions stay for recovery.
 * Call only while holding the publication lock, after the commit is verified.
 */
export async function pruneSupersededGenerations({ vaultRoot, transactionId, previousGeneration } = {}) {
  const commit = assertActiveIndexContract(await readJson(join(vaultRoot, PHASE22_COMMIT_PATH)), 'commit');
  const current = commit.generation_id;
  let previous = previousGeneration ?? null;
  if (previous === null) {
    try { previous = (await readJson(join(vaultRoot, GENERATIONS, current, 'manifest.json'))).previous_generation ?? null; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const keep = new Set([current, previous, ...await protectedByOpenTransactions(vaultRoot)].filter(Boolean));
  const entries = await readdir(join(vaultRoot, GENERATIONS), { withFileTypes: true });
  const retainedFiles = await mergeCompensationFiles(vaultRoot, entries.filter(entry => entry.isDirectory() && GENERATION_ID.test(entry.name)).map(entry => entry.name));
  const removed = [], skipped = [];
  for (const entry of entries) {
    if (keep.has(entry.name)) continue;
    const dir = GENERATIONS + '/' + entry.name;
    if (!entry.isDirectory() || !GENERATION_ID.test(entry.name)) { skipped.push({ path: dir, reason: 'not_generation_directory' }); continue; }
    const children = await readdir(join(vaultRoot, dir), { withFileTypes: true });
    if (children.some(child => !child.isFile())) { skipped.push({ path: dir, reason: 'non_regular_entry' }); continue; }
    const files = [];
    for (const child of children) {
      const path = dir + '/' + child.name;
      if (retainedFiles.has(path)) continue;
      const stat = await lstat(join(vaultRoot, path));
      if (!stat.isFile() || stat.nlink !== 1) { files.length = 0; skipped.push({ path: dir, reason: 'linked_file' }); break; }
      files.push({ path, sha256: sha256(await readFile(join(vaultRoot, path))), byte_length: stat.size });
    }
    if (skipped.at(-1)?.path === dir) continue;
    for (const file of files) await unlink(join(vaultRoot, file.path));
    const partial = children.some(child => retainedFiles.has(dir + '/' + child.name));
    if (!partial) await rmdir(join(vaultRoot, dir));
    if (files.length || !partial) removed.push({ generation: entry.name, files, ...(partial ? { retained_for: 'merge_compensation' } : {}) });
  }
  const record = { schema_version: 'phase22/generation-retention-1.0', policy: 'keep_current_and_previous',
    current, previous, kept: [...keep].sort(), removed, skipped, recorded_at: new Date().toISOString() };
  let recordPath = null;
  if (removed.length && transactionId) {
    recordPath = TRANSACTIONS + '/' + transactionId + '/generation-retention.' + Date.now() + '.json';
    await writeFile(join(vaultRoot, recordPath), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  }
  return { ok: true, current, previous, removed: removed.map(row => row.generation), skipped, record_path: recordPath };
}
