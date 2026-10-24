import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { renderReadingFirstObsidian } from './reading-first-obsidian.mjs';

const fail = (code, details = {}) => { throw Object.assign(new Error(code), { code, details }); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const collisionKey = value => value.normalize('NFC').toLowerCase();
const manifestPath = '.apa-v3/presentation.json';
function localPath(value) {
  if (typeof value !== 'string' || !value || !value.isWellFormed() || /[\\\x00-\x1f\x7f<>:"|?*#%]/.test(value) || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('RF_PREVIEW_PATH_INVALID', { path: value });
  return value;
}
function decoded(value) {
  try { return decodeURIComponent(value); } catch { fail('RF_PREVIEW_LINK_INVALID', { target: value }); }
}
function anchors(content) {
  const blocks = new Set([...content.matchAll(/(?:^|\s)\^([\w-]+)[ \t]*$/gm)].map(match => match[1]));
  const headings = new Set();
  for (const match of content.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const heading = match[1].replace(/[*_`]/g, '').trim().toLowerCase();
    headings.add(heading); headings.add(heading.replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-'));
  }
  return { blocks, headings };
}
export function validateReadingFirstPreviewFiles(files) {
  const byPath = new Map(files.map(file => [file.path, file]));
  let links = 0;
  for (const file of files.filter(row => /\.md$/i.test(row.path))) {
    const content = file.bytes.toString('utf8').replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '');
    const references = [...content.matchAll(/!?\[[^\]\n]*\]\((<[^>\n]+>|[^)\n]+)\)/g)].map(match => ({ target: match[1].startsWith('<') ? match[1].slice(1, -1) : match[1].replace(/\s+["'][\s\S]*$/, ''), wiki: false }));
    references.push(...[...content.matchAll(/!?\[\[([^\]\n]+)\]\]/g)].map(match => ({ target: match[1].split('|')[0], wiki: true })));
    for (const reference of references) {
      if (/^(?:https?:|mailto:|doi:)/i.test(reference.target)) continue;
      const target = decoded(reference.target.trim());
      if (!target || target.startsWith('/') || /[\\\x00-\x1f]/.test(target) || /^[a-z][a-z0-9+.-]*:/i.test(target)) fail('RF_PREVIEW_LINK_INVALID', { source: file.path, target });
      const split = target.indexOf('#');
      const location = split < 0 ? target : target.slice(0, split), fragment = split < 0 ? '' : target.slice(split + 1);
      let targetPath = location ? path.posix.normalize(path.posix.join(path.posix.dirname(file.path), location)) : file.path;
      if (reference.wiki && location) {
        const options = [location, `${location}.md`, targetPath, `${targetPath}.md`].filter(value => byPath.has(value));
        if (!options.length && !location.includes('/')) options.push(...files.filter(row => row.path.endsWith('/' + location) || row.path.endsWith('/' + location + '.md')).map(row => row.path));
        const candidates = [...new Set(options)];
        if (candidates.length !== 1) fail('RF_PREVIEW_LINK_UNRESOLVED', { source: file.path, target });
        targetPath = candidates[0];
      }
      if (targetPath.startsWith('../') || !byPath.has(targetPath)) fail('RF_PREVIEW_LINK_UNRESOLVED', { source: file.path, target });
      if (fragment && /\.md$/i.test(targetPath)) {
        const index = anchors(byPath.get(targetPath).bytes.toString('utf8'));
        if (fragment.startsWith('^') ? !index.blocks.has(fragment.slice(1)) : !index.headings.has(fragment.toLowerCase())) fail('RF_PREVIEW_ANCHOR_UNRESOLVED', { source: file.path, target });
      }
      links++;
    }
  }
  return { status: 'passed', local_links: links, files: files.length, scientific_review: 'not_run', native_obsidian: 'not_run' };
}

/** Export a new self-contained candidate only after all resources and local links pass. */
export async function exportReadingFirstPreview({ outputRoot, identity, views, presentation, targetRegistry, knowledgeRegistry = [], resources = [], readingEditor } = {}) {
  if (typeof outputRoot !== 'string' || !path.isAbsolute(outputRoot) || !Array.isArray(resources)) fail('RF_PREVIEW_INPUT_INVALID');
  const root = path.resolve(outputRoot);
  try { await lstat(root); fail('RF_PREVIEW_OUTPUT_EXISTS', { outputRoot: root }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const rendered = renderReadingFirstObsidian({ identity, views, presentation, targetRegistry, knowledgeRegistry, readingEditor });
  const files = [], paths = new Set();
  function add(relative, bytes, kind) {
    localPath(relative);
    const key = collisionKey(relative);
    if ([collisionKey(manifestPath), ...paths].some(other => key === other || key.startsWith(other + '/') || other.startsWith(key + '/'))) fail('RF_PREVIEW_PATH_COLLISION', { path: relative });
    const resolved = path.resolve(root, ...relative.split('/'));
    if (!resolved.startsWith(root + path.sep)) fail('RF_PREVIEW_PATH_INVALID', { path: relative });
    paths.add(key); files.push({ path: relative, bytes, kind });
  }
  for (const note of rendered.notes) add(note.path, note.bytes, 'paper');
  for (const note of rendered.supportNotes) add(note.path, note.bytes, 'knowledge-candidate');
  for (const resource of resources) {
    let bytes;
    if (typeof resource?.content === 'string' && resource.source_path === undefined) bytes = Buffer.from(resource.content);
    else if (resource?.content === undefined && typeof resource?.source_path === 'string' && path.isAbsolute(resource.source_path) && /^(?:sha256:)?[a-f0-9]{64}$/i.test(resource.sha256) && Number.isSafeInteger(resource.byte_length) && resource.byte_length >= 0) {
      if (!(await lstat(resource.source_path)).isFile()) fail('RF_PREVIEW_RESOURCE_INVALID', { path: resource.path });
      bytes = await readFile(resource.source_path);
      if (bytes.length !== resource.byte_length || digest(bytes) !== resource.sha256.replace(/^sha256:/i, '').toLowerCase()) fail('RF_PREVIEW_RESOURCE_MISMATCH', { path: resource.path });
    } else fail('RF_PREVIEW_RESOURCE_INVALID', { path: resource?.path });
    add(resource.path, bytes, 'resource');
  }
  const validation = validateReadingFirstPreviewFiles(files);
  const manifest = { schema_version: 'reading-first-preview-1.0', paper_id: identity.paper_id, targetRegistry: rendered.targetRegistry, knowledgeProposals: rendered.knowledgeProposals,
    ...(rendered.visual_resources ? { visual_resources: rendered.visual_resources } : {}),
    review: { overall: 'pending', native_obsidian: 'not_run' }, validation,
    files: files.map(file => ({ path: file.path, kind: file.kind, sha256: digest(file.bytes), byte_length: file.bytes.length })) };
  // mkdir is deliberately non-recursive: a second invocation can never merge into an old candidate.
  try { await mkdir(root); } catch (error) { if (error.code === 'EEXIST') fail('RF_PREVIEW_OUTPUT_EXISTS', { outputRoot: root }); throw error; }
  for (const file of [...files, { path: manifestPath, bytes: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') }]) {
    const destination = path.join(root, ...file.path.split('/'));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.bytes, { flag: 'wx' });
  }
  return { outputRoot: root, files: [...files.map(file => file.path), manifestPath], notes: rendered.notes, supportNotes: rendered.supportNotes, knowledgeProposals: rendered.knowledgeProposals, ...(rendered.visual_resources ? { visual_resources: rendered.visual_resources } : {}), targetRegistry: rendered.targetRegistry, manifest, validation };
}
