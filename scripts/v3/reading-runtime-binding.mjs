import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PROFILE = 'reading-runtime-binding-1.0';
const DEFAULT_ENTRIES = ['scripts/v3/reading-session.mjs', 'scripts/v3/configured-reading.mjs', 'scripts/v3/reading-runtime-binding.mjs', 'scripts/v3/reading-session-cli.mjs', 'scripts/lib/reading-resource-tool.py', 'scripts/lib/mineru-parse.py', 'scripts/v3/office-source-evidence-reader.py'];
const DEFAULT_SCHEMAS = ['Schema/config', 'Schema/contracts', 'Schema/phase21', 'Schema/phase22'];
const DEFAULT_PROMPTS = ['prompts/v3/science-configured-2.2.md', 'prompts/v3/reading-configured-2.2.md', 'prompts/v3/reading-editor-1.3.md', 'prompts/v3/phase21-scientific-contracts.md', 'prompts/v3/science-index-1.0.md', 'prompts/v3/translation-1.0.md', 'prompts/v3/role-reply-1.0.md'];
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value);
const sort = list => [...new Set(list)].sort();
function local(root, path) {
  if (typeof path !== 'string' || !path || path.includes('\0')) throw new Error('RUNTIME_PATH_INVALID');
  const target = resolve(root, path), rel = relative(root, target).split(sep).join('/');
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel) || /^(?:Wiki|Raw|node_modules|\.tmp|\.apa-v3)(?:\/|$)/i.test(rel)) throw new Error('RUNTIME_PATH_INVALID');
  return rel;
}
function read(root, path, missing) {
  const full = resolve(root, path);
  try {
    const real = realpathSync(full), rel = relative(realpathSync(root), real);
    if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('RUNTIME_PATH_INVALID');
    return readFileSync(full);
  } catch (error) { if (missing && error.code === 'ENOENT') return null; throw error; }
}
function collect({ repoRoot = DEFAULT_ROOT, entryPaths = DEFAULT_ENTRIES, schemaPaths = DEFAULT_SCHEMAS, promptFiles = DEFAULT_PROMPTS, missing = false }) {
  const root = resolve(repoRoot);
  const entries = sort(entryPaths.map(p => local(root, p)));
  const schemas = sort(schemaPaths.map(p => local(root, p)));
  const prompts = sort(promptFiles.map(p => local(root, typeof p === 'string' ? p : p.path)));
  const files = new Map();
  function add(path, traverse = false) {
    if (files.has(path)) return;
    const bytes = read(root, path, missing);
    if (!bytes) return;
    files.set(path, { path, sha256: hash(bytes), byte_length: bytes.length });
    if (traverse && /\.[cm]?js$/.test(path)) {
      const source = bytes.toString('utf8');
      const pattern = /\b(?:import\s*(?:[^'";]*?\sfrom\s*)?|export\s+[^'";]*?\sfrom\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
      for (const match of source.matchAll(pattern)) add(local(root, resolve(root, dirname(path), match[1])), true);
      for (const match of source.matchAll(/\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) add(local(root, resolve(root, dirname(path), match[1])), true);
    }
  }
  function schema(path) {
    let stat;
    try { stat = statSync(resolve(root, path)); } catch (error) { if (missing && error.code === 'ENOENT') return; throw error; }
    if (!stat.isDirectory()) { add(path); return; }
    for (const item of readdirSync(resolve(root, path), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const next = local(root, path + '/' + item.name);
      if (item.isDirectory()) schema(next); else if (item.isFile() && item.name.endsWith('.json')) add(next);
    }
  }
  entries.forEach(p => add(p, true)); schemas.forEach(schema); prompts.forEach(p => add(p));
  const body = { profile: PROFILE, repo_root: root, entry_paths: entries, schema_paths: schemas, prompt_files: prompts, files: [...files.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
  return { ...body, fingerprint: hash(canonical(body)) };
}
export function captureReadingRuntime(options = {}) { return collect(options); }
function validateManifest(manifest, root) {
  if (!manifest || manifest.profile !== PROFILE || typeof manifest.repo_root !== 'string' || resolve(manifest.repo_root) !== resolve(root) || !Array.isArray(manifest.files) || !Array.isArray(manifest.entry_paths) || !Array.isArray(manifest.schema_paths) || !Array.isArray(manifest.prompt_files)) throw new Error('RUNTIME_MANIFEST_INVALID');
  const { fingerprint, ...body } = manifest;
  if (fingerprint !== hash(canonical(body))) throw new Error('RUNTIME_MANIFEST_INVALID');
  for (const paths of [manifest.entry_paths, manifest.schema_paths, manifest.prompt_files]) {
    if (paths.some(path => local(root, path) !== path) || canonical(paths) !== canonical(sort(paths))) throw new Error('RUNTIME_MANIFEST_INVALID');
  }
  const seen = new Set();
  for (const row of manifest.files) {
    if (!row || local(root, row.path) !== row.path || seen.has(row.path) || !/^sha256:[a-f0-9]{64}$/.test(row.sha256) || !Number.isSafeInteger(row.byte_length) || row.byte_length < 0) throw new Error('RUNTIME_MANIFEST_INVALID');
    seen.add(row.path);
  }
}
function differences(previous, current) {
  const a = new Map(previous.files.map(x => [x.path, x.sha256])), b = new Map(current.files.map(x => [x.path, x.sha256]));
  return sort([...a.keys(), ...b.keys()]).filter(p => a.get(p) !== b.get(p)).map(path => ({ path, old_sha256: a.get(path) ?? null, new_sha256: b.get(path) ?? null }));
}
export function inspectReadingRuntime({ manifest, repoRoot = manifest?.repo_root ?? DEFAULT_ROOT }) {
  const root = resolve(repoRoot); validateManifest(manifest, root);
  const current = collect({ repoRoot: root, entryPaths: manifest.entry_paths, schemaPaths: manifest.schema_paths, promptFiles: manifest.prompt_files, missing: true });
  const changed_files = differences(manifest, current);
  return { status: changed_files.length ? 'drift' : 'current', previous: manifest, current, changed_files };
}
function validateApproval({ approval, runId, checkpointFingerprint, previous, current, repoRoot = previous?.repo_root ?? DEFAULT_ROOT }, verifyCurrent) {
  const errors = [];
  try {
    validateManifest(previous, resolve(repoRoot)); validateManifest(current, resolve(repoRoot));
    const actual = verifyCurrent ? inspectReadingRuntime({ manifest: previous, repoRoot }) : null;
    const changes = differences(previous, current);
    if (!approval || typeof approval !== 'object' || Array.isArray(approval)) return { valid: false, errors: ['APPROVAL_REQUIRED'], changed_files: changes };
    const keys = ['authorization_id', 'run_id', 'checkpoint_fingerprint', 'previous_runtime_fingerprint', 'current_runtime_fingerprint', 'changed_files', 'test_evidence'];
    if (canonical(Object.keys(approval).sort()) !== canonical(keys.sort())) errors.push('APPROVAL_FIELDS_INVALID');
    if (typeof approval.authorization_id !== 'string' || !approval.authorization_id.trim()) errors.push('AUTHORIZATION_REQUIRED');
    if (!runId || approval.run_id !== runId || !checkpointFingerprint || approval.checkpoint_fingerprint !== checkpointFingerprint) errors.push('APPROVAL_SCOPE_INVALID');
    if (!changes.length || approval.previous_runtime_fingerprint !== previous.fingerprint || approval.current_runtime_fingerprint !== current.fingerprint || verifyCurrent && actual.current.fingerprint !== current.fingerprint || canonical(approval.changed_files) !== canonical(changes)) errors.push('RUNTIME_SCOPE_INVALID');
    if (!Array.isArray(approval.test_evidence) || !approval.test_evidence.length) errors.push('TEST_EVIDENCE_REQUIRED');
    else for (const row of approval.test_evidence) {
      try {
        if (!row || canonical(Object.keys(row).sort()) !== canonical(['byte_length', 'path', 'sha256'])) throw new Error();
        const bytes = readFileSync(resolve(repoRoot, row.path));
        if (hash(bytes) !== row.sha256 || bytes.length !== row.byte_length) throw new Error();
      } catch { errors.push('TEST_EVIDENCE_INVALID'); }
    }
    return { valid: errors.length === 0, errors, changed_files: changes };
  } catch { return { valid: false, errors: ['RUNTIME_MANIFEST_INVALID'], changed_files: [] }; }
}

export function validateRuntimeRepairApproval(options) { return validateApproval(options, true); }
export function validateHistoricalRuntimeRepairApproval(options) { return validateApproval(options, false); }
