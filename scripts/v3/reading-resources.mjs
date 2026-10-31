import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

const fail = () => { throw Object.assign(new Error('RF_RESOURCE_INVALID'), { code: 'RF_RESOURCE_INVALID' }); };
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
function checkedFile(path, expected, owned = false) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== realpathSync(path)) fail();
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || owned && stat.nlink !== 1) fail();
  const bytes = readFileSync(path);
  if (sha(bytes) !== expected.sha256 || bytes.length !== expected.byte_length) fail();
}

export function validateReadingResources({ manifest, resourcesRoot, sources } = {}) {
  if (manifest?.version !== 'reading-resources-1.0' || !Array.isArray(manifest.resources)
    || !Array.isArray(sources) || typeof resourcesRoot !== 'string' || !isAbsolute(resourcesRoot)
    || resolve(resourcesRoot) !== realpathSync(resourcesRoot) || !lstatSync(resourcesRoot).isDirectory()) fail();
  const ids = new Set(), paths = new Set();
  for (const row of manifest.resources) {
    if (!row || typeof row.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(row.id) || ids.has(row.id)
      || typeof row.path !== 'string' || !/^Figures\//.test(row.path)
      || /[\\\x00-\x1f<>:"|?*]/.test(row.path) || row.path.split('/').some(part => !part || part === '.' || part === '..')
      || paths.has(row.path)) fail();
    ids.add(row.id); paths.add(row.path);
    const source = sources.find(item => item.id === row.source_id);
    if (!source || sources.filter(item => item.id === row.source_id).length !== 1 || !row.parent
      || row.parent.path !== source.path || row.parent.sha256 !== source.sha256 || row.parent.byte_length !== source.byte_length) fail();
    const locator = row.locator;
    if (!locator || !((locator.kind === 'pdf-page' && Number.isSafeInteger(locator.page) && locator.page > 0)
      || (locator.kind === 'docx-figure' && typeof locator.figure === 'string' && locator.figure.trim()
        && Number.isSafeInteger(locator.paragraph) && locator.paragraph >= 0))) fail();
    if (extname(source.path).toLowerCase() !== (locator.kind === 'pdf-page' ? '.pdf' : '.docx')) fail();
    if (typeof row.source_path !== 'string' || !isAbsolute(row.source_path)) fail();
    const rel = relative(resourcesRoot, row.source_path);
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) fail();
    checkedFile(row.source_path, row, true); checkedFile(source.path, source);
  }
  return structuredClone(manifest.resources);
}
