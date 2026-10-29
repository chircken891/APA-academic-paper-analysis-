#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const manifestName = 'apa-public-manifest.json';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const privateRoots = new Set(['Raw', 'Wiki', 'Figures', 'Eval', 'Clippings', '.planning', '.git', '.obsidian', '.runtime', 'node_modules', '.tmp']);
const privateRootsLower = new Set([...privateRoots].map(path => path.toLowerCase()));

function safePath(path, { source = false } = {}) {
  if (typeof path !== 'string' || !path || path.includes('\\') || isAbsolute(path) || path.split('/').some(part => !part || part === '.' || part === '..') || /^[a-z]:/i.test(path)) {
    throw new Error(`UNSAFE_PATH: ${path}`);
  }
  if (path.split('/').some(part => ['.git', 'node_modules', '.obsidian', '.runtime'].includes(part.toLowerCase()))) throw new Error(`PRIVATE_PATH: ${path}`);
  if (path.toLowerCase() === 'config/backups' || path.toLowerCase().startsWith('config/backups/')) throw new Error(`PRIVATE_PATH: ${path}`);
  if (source && (privateRootsLower.has(path.split('/')[0].toLowerCase()) || path.toLowerCase() === 'config/apa.local.json')) throw new Error(`PRIVATE_PATH: ${path}`);
  return path;
}

async function sourceBytes(root, path, { allowSkeletonPlaceholder = false } = {}) {
  const placeholder = allowSkeletonPlaceholder && ['raw', 'wiki', 'figures', 'clippings'].includes(path.split('/')[0].toLowerCase()) && posix.basename(path) === '.gitkeep';
  safePath(path, { source: !placeholder });
  let cursor = root;
  for (const segment of path.split('/')) {
    cursor = resolve(cursor, segment);
    let stat;
    try { stat = await lstat(cursor); } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`SOURCE_MISSING: ${path}`);
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`UNSAFE_PATH: symbolic link ${path}`);
  }
  const bytes = await readFile(cursor);
  if (placeholder && bytes.length) throw new Error(`PRIVATE_PATH: nonempty skeleton placeholder ${path}`);
  return bytes;
}

function localTarget(path, target) {
  const clean = target.split('#')[0].split('?')[0];
  if (!clean || /^[a-z][a-z\d+.-]*:/i.test(clean) || clean.startsWith('//')) return null;
  const decoded = decodeURIComponent(clean);
  if (decoded.startsWith('/')) return null;
  const normalized = posix.normalize(posix.join(posix.dirname(path), decoded)).replace(/\/$/, '');
  if (normalized.startsWith('../')) throw new Error(`DEPENDENCY_MISSING: ${path} -> ${target} escapes public root`);
  return normalized;
}

function checkClosure(files) {
  const errors = [], historical = [];
  const requireTarget = (path, target) => {
    const resolved = localTarget(path, target);
    if (resolved && resolved !== '.' && !files.has(resolved) && ![...files.keys()].some(key => key.startsWith(resolved.replace(/\/$/, '') + '/'))) errors.push(`${path} -> ${target}`);
  };
  const schemaIds = new Set();
  for (const [path, bytes] of files) if (path.endsWith('.schema.json')) {
    const schema = JSON.parse(bytes.toString());
    if (schema.$id) schemaIds.add(schema.$id);
  }
  // These validators compile explicit aliases of the three frozen V3 schemas.
  for (const prefix of ['native', 'whole-paper']) {
    const module = files.get(`scripts/v3/${prefix}-scientific-validator.mjs`)?.toString() ?? '';
    for (const suffix of ['source', 'analysis', 'details']) {
      const id = `phase21/${prefix}-scientific-${suffix}`;
      if (module.includes(`'${id}'`) && ['v3/source-package', 'v3/analysis-package', 'v3/scientific-package'].every(id => schemaIds.has(id))) schemaIds.add(id);
    }
  }
  for (const [path, bytes] of files) {
    const text = bytes.toString();
    if (/\.[cm]?js$/.test(path)) {
      const imports = /(?<!['"`])(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/g;
      for (const match of text.matchAll(imports)) if (match[1].startsWith('.')) requireTarget(path, match[1]);
      for (const match of text.matchAll(/new URL\(\s*['"](\.[^'"]+)['"]\s*,\s*import\.meta\.url/g)) {
        // Literal resource references must be present; template/dynamic resources are checked at runtime.
        if (!match[1].includes('${')) requireTarget(path, match[1]);
      }
      if (/(?:Eval\/|\.planning\/)/.test(text)) historical.push(path);
    }
    if (path.endsWith('.md')) {
      const prose = text.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '').replace(/`[^`\n]+`/g, '');
      for (const match of prose.matchAll(/!?\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g)) requireTarget(path, match[1] ?? match[2]);
      for (const match of prose.matchAll(/!?\[\[([^\]\n]+)\]\]/g)) {
        const target = match[1].split('|')[0].split('#')[0];
        if (target.includes('/') && !files.has(target) && !files.has(target + '.md')) errors.push(`${path} -> wikilink ${target}`);
      }
    }
    if (path.endsWith('.schema.json')) {
      const schema = JSON.parse(text);
      const visit = value => {
        if (!value || typeof value !== 'object') return;
        if (typeof value.$ref === 'string' && !value.$ref.startsWith('#')) {
          const id = value.$ref.split('#')[0];
          const relativeId = posix.join(posix.dirname(schema.$id ?? ''), id);
          if (!schemaIds.has(id) && !schemaIds.has(relativeId) && !/^https?:/.test(id)) {
            if (id.startsWith('.') || id.endsWith('.json')) requireTarget(path, id);
            else errors.push(`${path} -> schema ${id}`);
          }
        }
        for (const child of Object.values(value)) visit(child);
      };
      visit(schema);
    }
  }
  return { errors: [...new Set(errors)], historical_code_references: historical };
}

function projectPackage(bytes, tests) {
  const pkg = JSON.parse(bytes.toString());
  const command = 'node --test ' + tests.join(' ');
  pkg.scripts.test = command;
  pkg.scripts['test:v3'] = 'node --test ' + tests.filter(path => path.startsWith('test/v3/')).join(' ');
  return Buffer.from(JSON.stringify(pkg, null, 2) + '\n');
}

export async function exportPublicApa({ sourceRoot = repositoryRoot, outputRoot = resolve(sourceRoot, '.tmp/apa-public-setup/public'), allowlist, manifestPath = resolve(sourceRoot, 'config/apa-public-files.json') } = {}) {
  sourceRoot = resolve(sourceRoot);
  outputRoot = resolve(outputRoot);
  if (outputRoot.replaceAll('\\', '/').split('/').some(part => part.toLowerCase() === '.git')) throw new Error('UNSAFE_PATH: output cannot be inside .git');
  try { await lstat(outputRoot); throw new Error(`OUTPUT_EXISTS: ${outputRoot}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const spec = allowlist ?? JSON.parse(await readFile(manifestPath, 'utf8'));
  if (spec.version !== 1 || !Array.isArray(spec.files) || !Array.isArray(spec.templates) || !Array.isArray(spec.directories)) throw new Error('INVALID_ALLOWLIST');
  const files = new Map();
  for (const path of spec.files) {
    if (files.has(path)) throw new Error(`DUPLICATE_PATH: ${path}`);
    files.set(path, await sourceBytes(sourceRoot, path));
  }
  for (const row of spec.templates) {
    safePath(row.path);
    if (privateRootsLower.has(row.path.split('/')[0].toLowerCase()) || row.path.toLowerCase() === 'config/apa.local.json' || files.has(row.path)) throw new Error(`PRIVATE_PATH: ${row.path}`);
    files.set(row.path, await sourceBytes(sourceRoot, row.source));
  }
  if (files.has('package.json')) files.set('package.json', projectPackage(files.get('package.json'), spec.tests));
  for (const path of spec.directories) safePath(path);
  for (const path of spec.directories) {
    if (![...files.keys(), ...spec.directories].some(entry => entry.startsWith(path + '/'))) files.set(path + '/.gitkeep', Buffer.alloc(0));
  }
  const closure = checkClosure(files);
  if (closure.errors.length) throw new Error('DEPENDENCY_MISSING:\n' + closure.errors.join('\n'));
  await mkdir(dirname(outputRoot), { recursive: true });
  await mkdir(outputRoot); // Exclusive directory creation; never merges with an existing tree.
  for (const path of spec.directories) await mkdir(resolve(outputRoot, path), { recursive: true });
  for (const [path, bytes] of files) {
    await mkdir(dirname(resolve(outputRoot, path)), { recursive: true });
    await writeFile(resolve(outputRoot, path), bytes, { flag: 'wx' });
  }
  const manifest = { version: 1, files: [...files].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([path, bytes]) => ({ path, sha256: digest(bytes) })) };
  await writeFile(resolve(outputRoot, manifestName), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return { ok: true, file_count: files.size, ...closure };
}

export async function checkPublicApa({ root }) {
  root = resolve(root);
  const manifest = JSON.parse(await readFile(resolve(root, manifestName), 'utf8'));
  const files = new Map(), errors = [];
  for (const row of manifest.files) {
    safePath(row.path);
    try {
      const bytes = await sourceBytes(root, row.path, { allowSkeletonPlaceholder: true });
      files.set(row.path, bytes);
      if (digest(bytes) !== row.sha256) errors.push(`HASH_MISMATCH: ${row.path}`);
    } catch (error) { errors.push(error.message); }
  }
  const walk = async (directory, prefix = '') => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (entry.isSymbolicLink()) errors.push(`UNSAFE_PATH: symbolic link ${path}`);
      else if (entry.isDirectory()) {
        if (['.git', '.obsidian', '.runtime', 'node_modules'].includes(entry.name.toLowerCase()) || ['.planning', 'eval', '.tmp'].includes(path.toLowerCase())) errors.push(`PRIVATE_PATH: ${path}`);
        else await walk(resolve(directory, entry.name), path + '/');
      } else if (path !== manifestName && !files.has(path)) errors.push(`UNDECLARED_FILE: ${path}`);
    }
  };
  await walk(root);
  const closure = checkClosure(files);
  return { ok: errors.length === 0 && closure.errors.length === 0, file_count: files.size, errors: [...errors, ...closure.errors], historical_code_references: closure.historical_code_references };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [operation, ...args] = process.argv.slice(2);
    const expectedFlag = operation === 'export' ? '--output' : '--root';
    if (!['export', 'check'].includes(operation) || args.length > 2 || args.length % 2 || (args.length && args[0] !== expectedFlag)) throw new Error('Usage: export-public-apa.mjs export [--output NEW_DIRECTORY] | check --root DIRECTORY');
    const options = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, index) => [args[index * 2], args[index * 2 + 1]]));
    if (operation === 'check' && !options['--root']) throw new Error('check requires --root');
    const result = operation === 'check' ? await checkPublicApa({ root: options['--root'] }) : await exportPublicApa({ outputRoot: options['--output'] });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (!result.ok) process.exitCode = 1;
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
