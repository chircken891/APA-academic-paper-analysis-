import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { normalizeKnowledgeName } from './reading-first-knowledge.mjs';
import { listReadingRuntimeSnapshotReferences, readReadingRuntimeSnapshotReference } from './reading-runtime-snapshot.mjs';

const profile = 'reading-first-knowledge-plan-1.0';
const filename = 'knowledge-plan.json';
const fail = path => { throw Object.assign(new Error('RF_KNOWLEDGE_PLAN_INVALID'), { code: 'RF_KNOWLEDGE_PLAN_INVALID', path }); };
const stat = path => { try { return lstatSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; } };
const text = value => typeof value === 'string' && value.trim();
const validNode = row => row && text(row.id) && text(row.canonical_key) && text(row.title?.['zh-CN']) && text(row.title?.en)
  && ['method', 'concept'].includes(row.kind) && (row.kind === 'method' ? /^Wiki\/methods\/[^/\\]+\.md$/ : /^Wiki\/concepts\/[^/\\]+\.md$/).test(row.path);
function rootFor(reference) {
  const root = resolve(reference.run_root), observed = stat(root);
  if (!observed?.isDirectory() || observed.isSymbolicLink() || realpathSync(root) !== root) fail(root);
  return root;
}

/** Publish an advisory name list from this run's rendered, still-unregistered nodes. */
export function recordPlannedReadingFirstKnowledge({ repoRoot, runId, catalog, supportNotes, registry, matches = [] }) {
  const reference = readReadingRuntimeSnapshotReference({ repoRoot, runId });
  if (!reference) return { status: 'inactive' };
  const root = rootFor(reference), path = join(root, filename);
  if (stat(join(root, 'runtime-terminal.json'))) return { status: 'inactive' };
  const registered = new Set(registry.map(row => row.path));
  const planned = supportNotes.filter(note => !registered.has(note.path)).map(note => {
    const item = catalog.find(row => row.id === note.id);
    const row = { id: note.id, canonical_key: item?.canonical_key ?? note.id, kind: item?.kind, title: item?.title, path: note.path };
    if (!validNode(row)) fail(path);
    return row;
  });
  const bytes = JSON.stringify({ schema_version: profile, run_id: runId, nodes: planned, ...(matches.length ? { matches } : {}) }, null, 2) + '\n';
  const observed = stat(path);
  if (observed && (!observed.isFile() || observed.isSymbolicLink() || observed.nlink !== 1)) fail(path);
  if (observed && readFileSync(path, 'utf8') === bytes) return { status: 'recorded', path, count: planned.length };
  const temporary = join(root, '.knowledge-plan-' + randomUUID());
  try {
    writeFileSync(temporary, bytes, { flag: 'wx' });
    renameSync(temporary, path);
  } finally { if (stat(temporary)) unlinkSync(temporary); }
  return { status: 'recorded', path, count: planned.length };
}

/** Only active runs may supply advisory names. A batch may pass its own run list. */
export function readPlannedReadingFirstKnowledge({ repoRoot, excludeRunId, runIds } = {}) {
  const filter = runIds === undefined ? undefined : new Set(runIds);
  const references = listReadingRuntimeSnapshotReferences({ repoRoot });
  return references.filter(row => row.run_id !== excludeRunId && (!filter || filter.has(row.run_id))).flatMap(reference => {
    // A concurrent prepare may have registered its runtime before materializing the run root.
    if (!stat(reference.run_root)) return [];
    const root = rootFor(reference), path = join(root, filename), observed = stat(path);
    if (!observed || stat(join(root, 'runtime-terminal.json'))) return [];
    if (!observed.isFile() || observed.isSymbolicLink() || observed.nlink !== 1) fail(path);
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (data?.schema_version !== profile || data.run_id !== reference.run_id || !Array.isArray(data.nodes) || !data.nodes.every(validNode)) fail(path);
    return data.nodes.map(node => ({ run_id: reference.run_id, ...node }));
  });
}

export function matchPlannedReadingFirstKnowledge(catalog, planned) {
  return catalog.filter(item => item.source_kind !== 'paper-fact').flatMap(item => {
    const names = new Set(Object.values(item.title ?? {}).map(normalizeKnowledgeName).filter(Boolean));
    return planned.filter(row => row.kind === item.kind && (row.canonical_key === (item.canonical_key ?? item.id)
      || Object.values(row.title).some(value => names.has(normalizeKnowledgeName(value))))).map(row => ({
      knowledge_id: item.id, planned_run_id: row.run_id, planned_path: row.path, planned_title: row.title,
    }));
  });
}
