import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { renderReadingFirstObsidian } from './reading-first-obsidian.mjs';
import { inspectCommittedReadingFirstRegistry, readCommittedReadingFirstRegistryResource, assertCommittedReadingFirstKnowledgeRegistry } from './reading-first-knowledge-registry.mjs';

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
function referencesFor(file) {
  const content = file.bytes.toString('utf8').replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '');
  const references = [...content.matchAll(/!?\[[^\]\n]*\]\((<[^>\n]+>|[^)\n]+)\)/g)].map(match => ({ target: match[1].startsWith('<') ? match[1].slice(1, -1) : match[1].replace(/\s+["'][\s\S]*$/, ''), wiki: false }));
  references.push(...[...content.matchAll(/!?\[\[([^\]\n]+)\]\]/g)].map(match => ({ target: match[1].split('|')[0], wiki: true })));
  return references;
}
export function validateReadingFirstPreviewFiles(files) {
  const byPath = new Map(files.map(file => [file.path, file]));
  let links = 0;
  for (const file of files.filter(row => /\.md$/i.test(row.path))) {
    for (const reference of referencesFor(file)) {
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
export async function exportReadingFirstPreview({ outputRoot, identity, views, presentation, targetRegistry, existingTargets = [], knowledgeRegistry = [], resources = [], readingEditor, historicalKnowledge, noteLayout, sourceLanguage } = {}) {
  if (typeof outputRoot !== 'string' || !path.isAbsolute(outputRoot) || !Array.isArray(resources)) fail('RF_PREVIEW_INPUT_INVALID');
  const root = path.resolve(outputRoot);
  try { await lstat(root); fail('RF_PREVIEW_OUTPUT_EXISTS', { outputRoot: root }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const history = historicalKnowledge === undefined ? null : inspectCommittedReadingFirstRegistry({ vaultRoot: historicalKnowledge.vaultRoot, registry: knowledgeRegistry });
  const rendered = renderReadingFirstObsidian({ identity, views, presentation, targetRegistry, existingTargets, knowledgeRegistry, readingEditor, noteLayout, sourceLanguage });
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
    if (history && (knowledgeRegistry.some(row => row.path === resource.path) || history.paper_paths.includes(resource.path))) fail('RF_PREVIEW_HISTORICAL_RESOURCE_CONFLICT', { path: resource.path });
    let bytes;
    if (typeof resource?.content === 'string' && resource.source_path === undefined) bytes = Buffer.from(resource.content);
    else if (resource?.content === undefined && typeof resource?.source_path === 'string' && path.isAbsolute(resource.source_path) && /^(?:sha256:)?[a-f0-9]{64}$/i.test(resource.sha256) && Number.isSafeInteger(resource.byte_length) && resource.byte_length >= 0) {
      if (!(await lstat(resource.source_path)).isFile()) fail('RF_PREVIEW_RESOURCE_INVALID', { path: resource.path });
      bytes = await readFile(resource.source_path);
      if (bytes.length !== resource.byte_length || digest(bytes) !== resource.sha256.replace(/^sha256:/i, '').toLowerCase()) fail('RF_PREVIEW_RESOURCE_MISMATCH', { path: resource.path });
    } else fail('RF_PREVIEW_RESOURCE_INVALID', { path: resource?.path });
    add(resource.path, bytes, 'resource');
  }
  if (history) {
    const historical = new Map(knowledgeRegistry.map(row => [row.path, row]));
    const papers = new Set(history.paper_paths), nav = new Map();
    const catalog = () => [...new Set([...files.map(row => row.path), ...historical.keys(), ...papers, ...history.asset_paths])];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!/\.md$/i.test(file.path) || file.kind === 'historical-navigation') continue;
      for (const reference of referencesFor(file)) {
        if (/^(?:https?:|mailto:|doi:)/i.test(reference.target)) continue;
        const target = decoded(reference.target.trim()), split = target.indexOf('#');
        const location = split < 0 ? target : target.slice(0, split), fragment = split < 0 ? '' : target.slice(split + 1);
        if (!location) continue;
        let destination = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), location));
        if (reference.wiki) {
          const candidates = catalog();
          let options = [location, `${location}.md`, destination, `${destination}.md`].filter(value => candidates.includes(value));
          if (!options.length && !location.includes('/')) options = candidates.filter(value => value.endsWith('/' + location) || value.endsWith('/' + location + '.md'));
          options = [...new Set(options)];
          if (options.length !== 1) fail('RF_PREVIEW_LINK_UNRESOLVED', { source: file.path, target });
          destination = options[0];
        }
        if (nav.has(destination)) { if (fragment) nav.get(destination).add(fragment); continue; }
        const present = files.find(row => row.path === destination);
        if (present) {
          if (file.kind === 'historical-reference' && present.kind === 'resource') {
            try {
              const asset = readCommittedReadingFirstRegistryResource({ vaultRoot: historicalKnowledge.vaultRoot, registry: knowledgeRegistry, path: destination });
              if (!asset.bytes.equals(present.bytes)) fail('RF_PREVIEW_RESOURCE_MISMATCH', { path: destination });
            } catch (cause) { fail('RF_PREVIEW_HISTORICAL_RESOURCE_UNAVAILABLE', { source: file.path, target, path: destination, cause: cause.code ?? cause.message }); }
          }
          continue;
        }
        if (historical.has(destination)) {
          if (typeof historical.get(destination).content !== 'string') fail('RF_PREVIEW_HISTORICAL_RESOURCE_UNAVAILABLE', { source: file.path, target, path: destination });
          if (historical.get(destination).current_content) assertCommittedReadingFirstKnowledgeRegistry({ vaultRoot: historicalKnowledge.vaultRoot, registry: knowledgeRegistry, paths: [destination] });
          add(destination, Buffer.from(historical.get(destination).content), 'historical-reference');
        } else if (papers.has(destination)) {
          const fragments = new Set(fragment ? [fragment] : []); nav.set(destination, fragments);
          add(destination, Buffer.alloc(0), 'historical-navigation');
        } else {
          try {
            const asset = readCommittedReadingFirstRegistryResource({ vaultRoot: historicalKnowledge.vaultRoot, registry: knowledgeRegistry, path: destination });
            add(destination, asset.bytes, 'historical-asset');
          } catch (cause) { fail('RF_PREVIEW_HISTORICAL_RESOURCE_UNAVAILABLE', { source: file.path, target, path: destination, cause: cause.code ?? cause.message }); }
        }
      }
    }
    for (const [destination, fragments] of nav) {
      const labels = [...fragments].map(fragment => fragment.startsWith('^') ? `Navigation placeholder ${fragment}` : `## ${fragment}`);
      files.find(row => row.path === destination).bytes = Buffer.from(`# 历史论文导航 / Historical paper navigation\n\n正文未包含在此预览中。The paper content is not included in this preview.\n\n正式库路径 / Vault path: \`${destination}\`\n\n${labels.join('\n\n')}\n`);
    }
    inspectCommittedReadingFirstRegistry({ vaultRoot: historicalKnowledge.vaultRoot, registry: knowledgeRegistry });
  }
  const validation = validateReadingFirstPreviewFiles(files);
  const knowledgeDependencies = knowledgeRegistry.filter(row => row.current_content && row.content_sha256
    && files.some(file => file.path === row.path && ['knowledge-candidate', 'historical-reference'].includes(file.kind)))
    .map(row => ({ path: row.path, sha256: row.content_sha256 }));
  if (history && knowledgeDependencies.length) assertCommittedReadingFirstKnowledgeRegistry({ vaultRoot: historicalKnowledge.vaultRoot,
    registry: knowledgeRegistry, paths: knowledgeDependencies.map(row => row.path) });
  const manifest = { schema_version: 'reading-first-preview-1.0', paper_id: identity.paper_id, targetRegistry: rendered.targetRegistry, knowledgeProposals: rendered.knowledgeProposals,
    ...(knowledgeDependencies.length ? { knowledge_dependencies: knowledgeDependencies } : {}),
    ...(rendered.visual_resources ? { visual_resources: rendered.visual_resources } : {}),
    review: { overall: 'pending', native_obsidian: 'not_run' }, validation,
    files: files.map(file => ({ path: file.path, kind: file.kind, sha256: digest(file.bytes), byte_length: file.bytes.length,
      ...(file.kind.startsWith('historical-') ? { generation_id: history.generation_id, source_path: file.path, publishable: false } : {}) })) };
  // mkdir is deliberately non-recursive: a second invocation can never merge into an old candidate.
  try { await mkdir(root); } catch (error) { if (error.code === 'EEXIST') fail('RF_PREVIEW_OUTPUT_EXISTS', { outputRoot: root }); throw error; }
  for (const file of [...files, { path: manifestPath, bytes: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') }]) {
    const destination = path.join(root, ...file.path.split('/'));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.bytes, { flag: 'wx' });
  }
  return { outputRoot: root, files: [...files.map(file => file.path), manifestPath], notes: rendered.notes, supportNotes: rendered.supportNotes, knowledgeProposals: rendered.knowledgeProposals, ...(rendered.visual_resources ? { visual_resources: rendered.visual_resources } : {}), targetRegistry: rendered.targetRegistry, manifest, validation };
}
