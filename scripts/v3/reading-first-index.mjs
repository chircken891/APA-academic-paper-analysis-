import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import YAML from 'yaml';
import { fingerprintV3Json as hash } from './semantic-package-validator.mjs';
import { inspectManagedNote } from './phase22-managed-markdown.mjs';

export const INDEX_READING_FIRST_PROFILE = 'reading-first-obsidian-1.0';
export const READING_FIRST_INDEX_REGIONS = Object.freeze(['source', 'reading', 'resources']);
const languages = ['en', 'zh-CN'];
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const fail = (code, details = {}) => { throw Object.assign(new Error(code), { code, details }); };
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(JSON.parse(readFileSync(new URL('../../Schema/phase22/reading-first-publication.schema.json', import.meta.url), 'utf8')));

export function assertReadingFirstPublicationManifest(manifest) {
  if (!validate(manifest)) fail('RF_PUBLICATION_MANIFEST_INVALID', { errors: structuredClone(validate.errors ?? []) });
  const support = manifest.targets.support;
  if (new Set(support.map(row => row.entity_id)).size !== support.length || new Set(support.map(row => row.path)).size !== support.length
    || manifest.targets.notes.en.path === manifest.targets.notes['zh-CN'].path) fail('RF_PUBLICATION_TARGET_COLLISION');
  return manifest;
}

/** The active inventory binds the sidecar; note YAML cannot register a profile. */
export function verifyReadingFirstPresentation(paper, bytes, generation) {
  const object = generation.objects.find(row => row.path === paper.reader_presentation?.path);
  if (!(bytes instanceof Uint8Array) || object?.kind !== 'reader-presentation' || object.sha256 !== paper.reader_presentation.sha256
    || sha(bytes) !== object.sha256) fail('RF_PUBLICATION_PRESENTATION_BINDING');
  let manifest;
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('RF_PUBLICATION_MANIFEST_INVALID'); }
  assertReadingFirstPublicationManifest(manifest);
  if (paper.profile !== INDEX_READING_FIRST_PROFILE || manifest.profile !== paper.profile
    || ['paper_id', 'run_id', 'analysis_revision'].some(key => manifest.identity[key] !== paper[key])
    || hash(manifest.dependencies) !== hash(paper.dependencies) || manifest.scientific_input_fingerprint !== paper.core_hash
    || manifest.targets.presentation !== object.path || manifest.evidence_mode !== generation.evidence_mode
    || languages.some(language => manifest.targets.notes[language].path !== paper.paths[language])) fail('RF_PUBLICATION_IDENTITY_MISMATCH');
  const objects = new Map(generation.objects.map(row => [row.path, row]));
  for (const node of manifest.targets.support) {
    if (!generation.shared_nodes.some(row => row.entity_id === node.entity_id && row.path === node.path)
      || objects.get(node.path)?.kind !== 'support') fail('RF_PUBLICATION_RESOURCE_MISSING', { path: node.path });
  }
  if (manifest.targets.assets.some(path => objects.get(path)?.kind !== 'asset')) fail('RF_PUBLICATION_RESOURCE_MISSING');
  return manifest;
}

export function getReadingFirstManagedBinding(bytes) {
  const inspected = inspectManagedNote(bytes);
  if (inspected.frontmatter.rendering_profile !== INDEX_READING_FIRST_PROFILE) fail('RF_INDEX_NOTE_PROFILE_INVALID');
  return { ...inspected, regions: inspected.regions.map(region => ({ ...region, text: region.bytes.toString('utf8'),
    content: region.bytes.toString('utf8').slice(('<!-- AUTO:START ' + region.id + ' -->').length, -('<!-- AUTO:END ' + region.id + ' -->').length) })) };
}

/** Deliberately compare managed bytes only; Personal Notes remain user-owned. */
export function verifyReadingFirstPaperBytes(paper, language, bytes, generation, presentation) {
  const binding = getReadingFirstManagedBinding(bytes), fm = binding.frontmatter;
  const target = presentation?.targets.notes[language], expected = { type: 'paper', pipeline_version: '3.0',
    rendering_profile: INDEX_READING_FIRST_PROFILE, paper_id: paper.paper_id, language, graph_scope: 'v3-candidate',
    status: 'candidate', alternate_language_path: paper.paths[language === 'en' ? 'zh-CN' : 'en'] };
  if (Object.keys(expected).some(key => fm[key] !== expected[key]) || !target || target.path !== paper.paths[language]
    || binding.managedHash !== target.managed_hash || generation.objects.find(row => row.path === target.path)?.sha256 !== binding.managedHash) fail('RF_INDEX_NOTE_BINDING_INVALID');
  return binding;
}

function headingText(value) {
  return value.trim().replace(/[ \t]+#+[ \t]*$/, '').replace(/[ \t]+\^[A-Za-z0-9-]+$/, '').trim();
}
function visible(text) { return text.replace(/<!--[\s\S]*?-->/g, '').trim(); }
function firstAnchor(content) {
  const block = /(?:^|\n)[^\n]*?\^([A-Za-z0-9-]+)(?=\r?$)/m.exec(content);
  if (block) return { anchor: block[1], anchor_type: 'block' };
  const heading = /^#{1,6}[ \t]+([^\r\n]+)$/m.exec(content);
  const anchor = heading && headingText(heading[1]);
  if (!anchor || /[\r\n#]/.test(anchor)) fail('RF_INDEX_ANCHOR_MISSING');
  return { anchor, anchor_type: 'heading' };
}
function document(paper, language, path, sectionId, spanId, content, anchor, extra = {}) {
  return { id: hash({ paper_id: paper.paper_id, run_id: paper.run_id, revision: paper.analysis_revision, language, path, sectionId, spanId }),
    paper_id: paper.paper_id, run_id: paper.run_id, analysis_revision: paper.analysis_revision, core_hash: paper.core_hash,
    pipeline_version: '3.0', profile: INDEX_READING_FIRST_PROFILE, language, path, section_id: sectionId, span_id: spanId,
    unit_ids: [], ...anchor, content: visible(content), aliases: '', title: '', ...extra };
}
function fileAt(files, path) {
  const matches = files.filter(row => row.path === path);
  if (matches.length !== 1 || !(matches[0].bytes instanceof Uint8Array)) fail('RF_INDEX_RESOURCE_MISSING', { path });
  return Buffer.from(matches[0].bytes);
}
function supportContent(bytes, path) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes), front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  let metadata;
  try { metadata = front && YAML.parse(front[1]); } catch { fail('RF_INDEX_KNOWLEDGE_INVALID', { path }); }
  if (!metadata || metadata.pipeline_version !== '3.0') fail('RF_INDEX_KNOWLEDGE_INVALID', { path });
  const start = '<!-- AUTO:START shared-knowledge -->', end = '<!-- AUTO:END shared-knowledge -->';
  const from = text.indexOf(start), to = text.indexOf(end);
  if (from < 0 || to < from || text.indexOf(start, from + start.length) >= 0 || text.indexOf(end, to + end.length) >= 0) fail('RF_INDEX_KNOWLEDGE_REGION_REQUIRED', { path });
  return { metadata, body: text.slice(from + start.length, to) };
}

/** Deterministic final managed-content projection for preparation and every committed read. */
export function readingFirstIndexDocuments({ paper, presentation, notes, generation, files = [] }) {
  assertReadingFirstPublicationManifest(presentation);
  const documents = [];
  for (const language of languages) {
    if (!(notes?.[language] instanceof Uint8Array)) fail('RF_INDEX_NOTE_REQUIRED', { language });
    const binding = verifyReadingFirstPaperBytes(paper, language, notes[language], generation, presentation);
    for (const region of binding.regions) {
      const anchor = firstAnchor(region.content), title = binding.frontmatter.title ?? '';
      documents.push(document(paper, language, paper.paths[language], region.id, 'section:' + region.id, region.content, anchor, { title }));
      const headings = [...region.content.matchAll(/^#{1,6}[ \t]+([^\r\n]+)$/gm)];
      for (let index = 0; index < headings.length; index++) {
        const heading = headings[index], content = region.content.slice(heading.index, headings[index + 1]?.index ?? region.content.length);
        const name = headingText(heading[1]);
        if (!name || /[\r\n#]/.test(name)) continue;
        documents.push(document(paper, language, paper.paths[language], region.id, 'heading:' + region.id + ':' + index, content,
          { anchor: name, anchor_type: 'heading' }, { title }));
      }
    }
  }
  for (const node of presentation.targets.support) {
    const bytes = fileAt(files, node.path), object = generation.objects.find(row => row.path === node.path);
    if (!generation.shared_nodes.some(row => row.entity_id === node.entity_id && row.path === node.path)
      || object?.kind !== 'support' || sha(bytes) !== object.sha256) fail('RF_INDEX_RESOURCE_BINDING', { path: node.path });
    const { metadata, body } = supportContent(bytes, node.path);
    const headings = [...body.matchAll(/^##[ \t]+([^\r\n]+)$/gm)];
    const common = headings.filter(row => !['English', '中文'].includes(headingText(row[1])))
      .map(row => { const index = headings.indexOf(row); return body.slice(row.index, headings[index + 1]?.index ?? body.length); }).join('\n\n');
    for (const language of languages) {
      const name = language === 'en' ? 'English' : '中文', index = headings.findIndex(row => headingText(row[1]) === name);
      if (index < 0) fail('RF_INDEX_KNOWLEDGE_LANGUAGE_MISSING', { path: node.path, language });
      const content = body.slice(headings[index].index, headings[index + 1]?.index ?? body.length) + '\n\n' + common;
      documents.push(document(paper, language, node.path, 'knowledge', 'knowledge:' + node.entity_id + ':' + language, content,
        { anchor: name, anchor_type: 'heading' }, { entity_id: node.entity_id,
          aliases: Array.isArray(metadata.aliases) ? metadata.aliases.join(' ') : '', title: metadata.canonical_key ?? node.entity_id }));
    }
  }
  return documents;
}
