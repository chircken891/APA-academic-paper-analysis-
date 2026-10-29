import Ajv2020 from 'ajv/dist/2020.js';
import YAML from 'yaml';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as same } from 'node:util';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { fingerprintV3Json as hash } from './semantic-package-validator.mjs';
import { freezePhase22Value } from './phase22-input.mjs';
import { PHASE22_REGIONS } from './phase22-render-context.mjs';
import { inspectManagedNote, machineFieldsForProfile } from './phase22-managed-markdown.mjs';
import { registerReaderTargets } from './phase221-targets.mjs';
import { createPhase22ContractValidator } from './phase22-contract-loader.mjs';
import { INDEX_READING_FIRST_PROFILE, READING_FIRST_INDEX_REGIONS, getReadingFirstManagedBinding,
  verifyReadingFirstPresentation, verifyReadingFirstPaperBytes, readingFirstIndexDocuments } from './reading-first-index.mjs';

export { INDEX_READING_FIRST_PROFILE, verifyReadingFirstPresentation, readingFirstIndexDocuments };

export const INDEX_READER_PROFILE = 'phase22-reader-note-1.0';
export const INDEX_TOPIC_PROFILE = 'phase24-topic-1.0';
const readerValidator = await createPhase22ContractValidator();

export const PHASE22_COMMIT_PATH = '.apa-v3/phase22/COMMITTED.json';
const schema = JSON.parse(readFileSync(new URL('../../Schema/phase22/active-index.schema.json', import.meta.url), 'utf8'));
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
const snapshots = new WeakMap();
const sharedSnapshots = new WeakMap();
const registeredCommits = new WeakMap();
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const fail = (code, details = {}) => { throw Object.assign(new Error(code), { code, details }); };

// Frozen Plan04 byte contract; no import of the parallel, unfinished merger.
export const INDEX_MACHINE_FIELDS = machineFieldsForProfile('phase22-managed-note-1.0');
export function assertActiveIndexContract(value, kind) {
  if (!validate(value) || (kind && value.kind !== kind)) {
    fail('P22_ACTIVE_INDEX_SCHEMA_INVALID', { errors: structuredClone(validate.errors ?? []), kind });
  }
  return value;
}

export function normalizeIndexPath(value) {
  if (typeof value !== 'string') fail('P22_INDEX_PATH_INVALID');
  const path = value.replaceAll('\\', '/');
  if (!path || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..'
    || /[\x00-\x1f<>:"|?*]/.test(part) || /[. ]$/.test(part)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('P22_INDEX_PATH_INVALID', { path: value });
  return path;
}

export function phase22GenerationPaths(generationId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(generationId)) fail('P22_GENERATION_ID_INVALID');
  const root = '.apa-v3/phase22/generations/' + generationId;
  return { active: root + '/active.json', index: root + '/index.json' };
}

/** Read-only interpretation of the frozen managed-hash contract, not a merger. */
export function getIndexManagedBinding(bytes, { pipelineVersion = '3.0', profile } = {}) {
  if (!(bytes instanceof Uint8Array)) fail('P22_NOTE_BYTES_REQUIRED');
  if (pipelineVersion !== '3.0') fail('P22_NOTE_PROFILE_INVALID');
  if (profile === INDEX_READING_FIRST_PROFILE) return getReadingFirstManagedBinding(bytes);
  if (profile === INDEX_READER_PROFILE || profile === INDEX_TOPIC_PROFILE) {
    const inspected = inspectManagedNote(bytes);
    if (inspected.frontmatter.rendering_profile !== profile || pipelineVersion !== '3.0') fail('P22_NOTE_PROFILE_INVALID');
    return { ...inspected, regions: inspected.regions.map(region => ({ ...region, text: region.bytes.toString('utf8'),
      content: region.bytes.toString('utf8').slice(('<!-- AUTO:START ' + region.id + ' -->').length, -('<!-- AUTO:END ' + region.id + ' -->').length) })) };
  }
  if (profile !== undefined && profile !== 'phase22-managed-note-1.0') fail('P22_NOTE_PROFILE_INVALID');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!fm) fail('P22_NOTE_FRONTMATTER_INVALID');
  const document = YAML.parseDocument(fm[1], { uniqueKeys: true });
  if (document.errors.length || !YAML.isMap(document.contents)) fail('P22_NOTE_FRONTMATTER_INVALID');
  const fields = INDEX_MACHINE_FIELDS;
  const owned = new Set(fields), anchors = new Map(), aliases = [];
  for (const pair of document.contents.items) {
    if (!YAML.isScalar(pair.key) || typeof pair.key.value !== 'string') fail('P22_NOTE_FRONTMATTER_INVALID');
    const key = pair.key.value;
    if (/^(?:p24[_-]|human[_-]enrichment|selection[_-](?:map|receipt|overlay)|evidence[_-]overlay)/i.test(key)) fail('P22_ENRICHMENT_UNRECOGNIZED');
    YAML.visit(pair.value, (_, node) => {
      if (node?.anchor) anchors.set(node.anchor, owned.has(key));
      if (YAML.isAlias(node)) aliases.push({ source: node.source, owner: owned.has(key) });
    });
  }
  if (aliases.some(alias => !anchors.has(alias.source) || anchors.get(alias.source) !== alias.owner)) fail('P22_ALIAS_OWNERSHIP');
  const frontmatter = document.toJS({ maxAliasCount: 100 });
  const body = text.slice(fm[0].length);
  const markers = [...body.matchAll(/<!--\s*AUTO[^\r\n]*(?:-->|$)/g)];
  if (markers.length !== PHASE22_REGIONS.length * 2
    || (body.match(/<!--\s*AUTO/g) ?? []).length !== markers.length) fail('P22_NOTE_TOPOLOGY_INVALID');
  const regions = PHASE22_REGIONS.map((id, i) => {
    const start = markers[i * 2], end = markers[i * 2 + 1];
    if (start[0] !== '<!-- AUTO:START ' + id + ' -->' || end[0] !== '<!-- AUTO:END ' + id + ' -->') fail('P22_NOTE_TOPOLOGY_INVALID');
    for (const marker of [start, end]) {
      if ((marker.index > 0 && body[marker.index - 1] !== '\n')
        || !/^(?:\r?\n|$)/.test(body.slice(marker.index + marker[0].length))) fail('P22_NOTE_TOPOLOGY_INVALID');
    }
    return { id, text: body.slice(start.index, end.index + end[0].length),
      content: body.slice(start.index + start[0].length, end.index) };
  });
  if (pipelineVersion === '3.0') {
    const notes = [...body.matchAll(/^## (?:Personal Notes|个人备注)(?:\r?\n|$)/gm)];
    const last = markers.at(-1);
    if (notes.length !== 1 || notes[0].index < last.index + last[0].length) fail('P22_PERSONAL_NOTES_TOPOLOGY');
  }
  if (pipelineVersion === '3.0' && (frontmatter.pipeline_version !== '3.0'
    || frontmatter.rendering_profile !== 'phase22-managed-note-1.0')) fail('P22_NOTE_PROFILE_INVALID');
  const machine = Object.fromEntries(fields.filter(key => Object.hasOwn(frontmatter, key)).map(key => [key, frontmatter[key]]));
  return { frontmatter, regions, managedHash: hash({ machine, regions: regions.map(({ id, text: value }) => ({ id, text: value })) }) };
}

/** Shared knowledge in an active V3 generation must itself declare V3 identity. */
export function assertV3SupportBytes(bytes, path) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  const document = front && YAML.parseDocument(front[1], { uniqueKeys: true });
  if (!document || document.errors.length || !YAML.isMap(document.contents)
    || document.toJS({ maxAliasCount: 100 }).pipeline_version !== '3.0') fail('P22_SUPPORT_VERSION_INVALID', { path });
  return bytes;
}

function unique(values, code) {
  if (new Set(values).size !== values.length) fail(code);
}

export function assertActiveGeneration(generation) {
  assertActiveIndexContract(generation, 'active');
  unique(generation.papers.map(p => p.paper_id), 'P22_ACTIVE_PAPER_DUPLICATE');
  unique((generation.topics ?? []).map(row => row.topic_id), 'P24_TOPIC_DUPLICATE');
  unique((generation.source_events ?? []).map(row => row.event_id), 'P24_SOURCE_EVENT_DUPLICATE');
  unique(generation.objects.map(o => normalizeIndexPath(o.path).normalize('NFC').toLowerCase()), 'P22_ACTIVE_PATH_COLLISION');
  unique(generation.shared_nodes.map(o => o.entity_id), 'P22_SHARED_ENTITY_DUPLICATE');
  unique(generation.shared_nodes.map(o => normalizeIndexPath(o.path)), 'P22_SHARED_PATH_DUPLICATE');
  const objects = new Map(generation.objects.map(o => [o.path, o]));
  const selected = [];
  for (const paper of generation.papers) {
    if ([INDEX_READER_PROFILE, INDEX_READING_FIRST_PROFILE].includes(paper.profile)) {
      const reference = paper.reader_presentation, object = objects.get(reference.path);
      if (object?.kind !== 'reader-presentation' || object.sha256 !== reference.sha256
        || generation.papers.filter(row => row.reader_presentation?.path === reference.path).length !== 1) fail('P221_READER_PRESENTATION_BINDING');
    }
    for (const path of Object.values(paper.paths)) {
      const notePath = paper.profile === INDEX_READING_FIRST_PROFILE
        ? /^Wiki\/(sources|translations)\/[^/]+\.md$/ : /^Wiki\/sources\/[^/]+\.md$/;
      if (!notePath.test(path) || normalizeIndexPath(path) !== path
        || objects.get(path)?.kind !== 'v3-note') fail('P22_ACTIVE_MEMBER_MISSING', { path });
      selected.push(path);
    }
  }
  unique(selected, 'P22_ACTIVE_PATH_COLLISION');
  for (const topic of generation.topics ?? []) {
    if (topic.path !== 'Wiki/topics/' + topic.topic_id + '.md' || objects.get(topic.path)?.kind !== 'topic'
      || objects.get(topic.path).sha256 !== topic.managed_hash
      || (topic.revision === 1 ? topic.previous_revision !== null : topic.previous_revision !== topic.revision - 1)) fail('P24_TOPIC_BINDING_INVALID');
    const ids = topic.resolved_event_ids ?? [], resolutions = topic.event_resolutions ?? [];
    if (new Set(ids).size !== ids.length || !same([...ids].sort(), resolutions.map(r => r.event_id).sort())
      || resolutions.some(r => !(generation.source_events ?? []).some(e => e.event_id === r.event_id))) fail('P24_EVENT_RESOLUTION_INVALID');
  }
  for (const node of generation.shared_nodes) {
    if (!/^Wiki\/(methods|concepts)\/[^/]+\.md$/.test(node.path) || objects.get(node.path)?.kind !== 'support') fail('P22_SHARED_MEMBER_INVALID', { path: node.path });
  }
  for (const item of generation.objects) {
    const allowed = item.kind === 'reader-presentation' ? /^\.apa-v3\/(phase221|reading-first)\/presentation\/[^/]+\.json$/.test(item.path)
      : item.kind === 'reading-review' ? /^\.apa-v3\/(phase221|reading-first)\/(reading-review|reviews)\/[^/]+\.json$/.test(item.path)
        : item.kind === 'reader-record' ? /^Reading Records\/[^/]+\.md$/.test(item.path)
          : item.kind === 'reader-style' ? item.path === 'Templates/apa-v3/apa-readable.css'
            : item.kind === 'asset' ? /^(Raw|Figures)\//.test(item.path) : /^(Wiki|Figures)\//.test(item.path);
    if (normalizeIndexPath(item.path) !== item.path || !allowed) fail('P22_INDEX_PATH_INVALID', { path: item.path });
    if (item.kind === 'reader-presentation' && !generation.papers.some(p => p.reader_presentation?.path === item.path)) fail('P221_READER_PRESENTATION_BINDING');
    if (item.kind === 'topic' && !(generation.topics ?? []).some(topic => topic.path === item.path)) fail('P24_TOPIC_BINDING_INVALID');
    if (item.kind === 'v3-note' && !selected.includes(item.path)) fail('P22_UNSELECTED_NOTE', { path: item.path });
    if (item.kind === 'support' && !generation.shared_nodes.some(n => n.path === item.path)) fail('P22_SHARED_MEMBER_INVALID', { path: item.path });
  }
  return generation;
}

function checkPaperBytes(paper, language, bytes, generation, presentation) {
  if (paper.profile === INDEX_READING_FIRST_PROFILE) return verifyReadingFirstPaperBytes(paper, language, bytes, generation, presentation);
  const path = paper.paths[language];
  const binding = getIndexManagedBinding(bytes, { pipelineVersion: paper.pipeline_version, profile: paper.profile });
  if (paper.profile === INDEX_READER_PROFILE) {
    const expected = { type: 'paper', pipeline_version: '3.0', rendering_profile: INDEX_READER_PROFILE, language, graph_scope: 'v3-candidate' };
    if (machineFieldsForProfile(paper.profile).some(key => binding.frontmatter[key] !== expected[key])) fail('P22_ACTIVE_NOTE_IDENTITY_MISMATCH', { path });
    const target = presentation?.targets.notes[language];
    if (!target || target.path !== path || target.managed_hash !== binding.managedHash || target.byte_sha256 !== sha(bytes)) fail('P221_READER_FINAL_BYTES_MISMATCH', { path });
  } else if (paper.pipeline_version === '3.0') {
    const fm = binding.frontmatter;
    const expected = { type: 'paper', pipeline_version: '3.0', paper_id: paper.paper_id, run_id: paper.run_id,
      analysis_revision: paper.analysis_revision, language, core_fingerprint: paper.core_hash,
      basis_fingerprint: paper.basis_fingerprint, context_fingerprint: paper.context_fingerprint,
      view_fingerprint: paper.view_fingerprints[language], evidence_mode: generation.evidence_mode,
      review_ready: generation.evidence_mode === 'actual', alternate_language_path: paper.paths[language === 'en' ? 'zh-CN' : 'en'] };
    if (Object.keys(expected).some(key => fm[key] !== expected[key])) fail('P22_ACTIVE_NOTE_IDENTITY_MISMATCH', { path });
  }
  if (binding.managedHash !== generation.objects.find(o => o.path === path)?.sha256) fail('P22_MANAGED_HASH_MISMATCH', { path });
  return binding;
}
export { checkPaperBytes as verifyIndexPaperBytes };

/** Disk authority comes from the outer inventory, never from note YAML or a sibling guess. */
export function verifyReaderPresentation(paper, bytes, generation) {
  const object = generation.objects.find(row => row.path === paper.reader_presentation?.path);
  if (!(bytes instanceof Uint8Array) || object?.kind !== 'reader-presentation'
    || object.sha256 !== paper.reader_presentation.sha256 || sha(bytes) !== object.sha256) fail('P221_READER_PRESENTATION_BINDING');
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  readerValidator.assert('phase22/reader-presentation-1.0', manifest);
  if (manifest.profile !== paper.profile || ['paper_id', 'run_id', 'analysis_revision'].some(key => manifest.identity[key] !== paper[key])
    || hash(manifest.dependencies) !== hash(paper.dependencies) || manifest.targets.presentation !== object.path
    || manifest.qualification.evidence_mode !== generation.evidence_mode) fail('P221_READER_IDENTITY_MISMATCH');
  registerReaderTargets({ identity: manifest.identity, existingRegistry: manifest.target_registry });
  if (manifest.dependencies.targets !== manifest.target_registry.registry_fingerprint
    || hash(paper.paths) !== hash(manifest.target_registry.paper_targets)
    || ['en', 'zh-CN'].some(language => paper.paths[language] !== manifest.targets.notes[language].path)) fail('P221_READER_TARGET_MISMATCH');
  if (paper.terminology && hash(paper.terminology) !== manifest.dependencies.terms) fail('P221_READER_TERMS_MISMATCH');
  const objects = new Map(generation.objects.map(row => [row.path, row]));
  for (const [paths, kind] of [[manifest.targets.support, 'support'], [manifest.targets.assets, 'asset']]) {
    if (paths.some(path => objects.get(path)?.kind !== kind)) fail('P221_READER_RESOURCE_MISSING');
  }
  for (const record of Object.values(manifest.targets.reading_records ?? {})) {
    if (objects.get(record.path)?.kind !== 'reader-record' || objects.get(record.path)?.sha256 !== record.byte_sha256) fail('P221_READER_RESOURCE_MISSING');
  }
  return manifest;
}

function readerDocument(paper, language, sectionId, spanId, content, anchor, unitIds = [], aliases = '', title = '') {
  return { id: hash({ paper_id: paper.paper_id, run_id: paper.run_id, revision: paper.analysis_revision, language, sectionId, spanId }),
    paper_id: paper.paper_id, run_id: paper.run_id, analysis_revision: paper.analysis_revision, core_hash: paper.core_hash,
    profile: INDEX_READER_PROFILE, anchor_type: spanId.startsWith('section:') ? 'heading' : 'block',
    pipeline_version: paper.pipeline_version, language, path: paper.paths[language], section_id: sectionId, span_id: spanId,
    unit_ids: [...new Set(unitIds)], anchor, content, aliases, title };
}

/** Deterministic final-byte projection, used both before registration and on every disk read. */
export function readerIndexDocuments({ paper, presentation, notes, generation, readingRecords = [] }) {
  const documents = [];
  for (const language of ['en', 'zh-CN']) {
    const bytes = notes[language], binding = checkPaperBytes(paper, language, bytes, generation, presentation);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    let recordText;
    if (presentation.audit_display === 'compact') {
      const expected = presentation.targets.reading_records?.[language];
      const matches = readingRecords.filter(row => (row.target_path ?? row.path) === expected?.path);
      const object = generation.objects.find(row => row.path === expected?.path);
      if (!expected || matches.length !== 1 || !matches[0].bytes || object?.kind !== 'reader-record'
        || object.sha256 !== expected.byte_sha256 || sha(matches[0].bytes) !== expected.byte_sha256) fail('P221_READER_RECORD_BINDING');
      recordText = new TextDecoder('utf-8', { fatal: true }).decode(matches[0].bytes);
    }
    const title = /^# (.+)$/m.exec(binding.regions[0].content)?.[1] ?? '';
    const anchors = [...text.matchAll(/(?:^|\n)[^\n]*?\^([A-Za-z0-9-]+)(?=\r?$)/gm)].map(match => match[1]);
    unique(anchors, 'P221_READER_ANCHOR_DUPLICATE');
    const anchored = anchor => { if (!anchors.includes(anchor)) fail('P221_READER_ANCHOR_MISSING', { language, anchor }); };
    const validateRange = range => {
      const region = binding.regions.find(row => row.id === range.section_id);
      if (!region || !Number.isInteger(range.from) || !Number.isInteger(range.to) || range.to <= range.from
        || range.from < region.from || range.to > region.to || sha(bytes.subarray(range.from, range.to)) !== range.sha256) fail('P221_READER_RANGE_MISMATCH');
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(range.from, range.to));
      anchored(range.anchor);
      // Anchors are bound to the range, not merely present elsewhere on the page.
      const tail = bytes.subarray(range.to, region.to).toString('utf8');
      if (!content.includes('^' + range.anchor) && !/^[\r\n ]*\^[A-Za-z0-9-]+(?=\s|$)/.exec(tail)?.[0].trim().endsWith('^' + range.anchor)) fail('P221_READER_RANGE_ANCHOR_MISMATCH');
      return content;
    };
    const ranges = presentation.ranges.filter(range => range.language === language);
    unique(ranges.map(range => range.span_id), 'P221_READER_RANGE_DUPLICATE');
    for (const range of ranges) {
      const content = validateRange(range);
      if (content !== range.text) fail('P221_READER_RANGE_MISMATCH');
      const terms = (paper.terminology?.terms ?? []).filter(term => term.definition_unit_refs.some(id => range.refs.includes(id))
        || range.display_transforms.some(transform => transform.proof.kind === 'term' && transform.proof.term_id === term.term_id));
      const aliases = terms.flatMap(term => [term.abbreviation, term.en_full_form, term.zh_full_form ?? '', ...term.aliases.en, ...term.aliases['zh-CN']]).join(' ');
      documents.push(readerDocument(paper, language, range.section_id, range.span_id, content, range.anchor, range.refs, aliases, title));
    }
    for (const record of presentation.records) for (const expression of record.expressions[language]) validateRange(expression);
    for (const navigation of presentation.navigation.filter(row => row.language === language)) {
      const [path, anchor] = navigation.target.split('#');
      const registered = [...Object.values(paper.paths), ...presentation.targets.support, ...presentation.targets.assets,
        ...Object.values(presentation.targets.reading_records ?? {}).map(row => row.path)];
      if (path && !registered.includes(path)) fail('P221_READER_NAVIGATION_MISMATCH');
      if (!path || path === paper.paths[language]) {
        if (anchor?.startsWith('^')) anchored(anchor.slice(1));
        else if (anchor && !text.includes('## ' + anchor)) fail('P221_READER_ANCHOR_MISSING');
      }
      if (navigation.kind === 'semantic') {
        const record = presentation.records.find(row => row.id === navigation.semantic_id);
        const relocated = presentation.audit_display === 'compact' && path === presentation.targets.reading_records[language].path;
        const lines = (relocated ? recordText : text).split(/\r?\n/).filter(row => row.endsWith('^' + anchor?.slice(1)));
        if ((!relocated && path !== paper.paths[language]) || !anchor?.startsWith('^') || !record || lines.length !== 1
          || !record.expressions[language].some(expression => lines[0].includes('[[' + (relocated ? paper.paths[language] : '') + '#^' + expression.anchor + '|'))) fail('P221_READER_NAVIGATION_MISMATCH');
      }
    }
    if (presentation.research_map) {
      const map = presentation.research_map;
      if (hash(map.map) !== map.bindings.map_fingerprint || hash(map.bindings.views) !== hash(presentation.dependencies.views)
        || hash(map.bindings.paper_targets) !== hash(paper.paths)) fail('P221_READER_MAP_BINDING');
      const range = map.ranges.filter(row => row.language === language);
      const region = binding.regions.find(row => row.id === 'study-design');
      if (range.length !== 1 || range[0].from < region.from || range[0].to > region.to || range[0].to <= range[0].from
        || sha(bytes.subarray(range[0].from, range[0].to)) !== range[0].sha256) fail('P221_READER_MAP_BINDING');
      for (const navigation of map.navigation.filter(row => row.language === language)) {
        const [path, anchor] = navigation.target.split('#');
        if (path !== paper.paths[language] || !anchor?.startsWith('^')) fail('P221_READER_NAVIGATION_MISMATCH');
        anchored(anchor.slice(1));
        if (!text.includes('[[' + navigation.target + '|')) fail('P221_READER_NAVIGATION_MISMATCH');
      }
    }
    for (const region of binding.regions) {
      const anchor = /^## (.+)\r?$/m.exec(region.content)?.[1]?.replace(/\r$/, '');
      const compactAudit = !anchor && presentation.audit_display === 'compact' && ['evidence', 'relations', 'coverage'].includes(region.id);
      if (!anchor && !compactAudit) fail('P221_READER_SECTION_ANCHOR_MISSING');
      if (compactAudit) {
        const block = 'audit-' + hash({ id: region.id }).slice(7, 31);
        anchored(block);
        if (!region.content.includes('^' + block)) fail('P221_READER_SECTION_ANCHOR_MISSING');
        documents.push({ ...readerDocument(paper, language, region.id, 'section:' + region.id, region.content, block, [], '', title), anchor_type: 'block' });
      } else documents.push(readerDocument(paper, language, region.id, 'section:' + region.id, region.content, anchor, [], '', title));
      // Folded evidence points to its visible locator immediately preceding the callout.
      for (const match of region.content.matchAll(/^([^\r\n]+) \^([A-Za-z0-9-]+)\r?\n\r?\n([^]*?)(?=^### |^<!-- AUTO:|$(?![^]))/gm)) {
        if (!match[3].includes('> [!quote]-')) continue;
        anchored(match[2]);
        documents.push(readerDocument(paper, language, region.id, 'folded:' + match[2], match[0], match[2], [], '', title));
      }
    }
  }
  return documents;
}

function readRegular(root, path) {
  path = normalizeIndexPath(path);
  const base = realpathSync(resolve(root));
  let cursor = base;
  const parts = path.split('/');
  for (let i = 0; i < parts.length; i++) {
    cursor = resolve(cursor, parts[i]);
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : (!stat.isFile() || stat.nlink !== 1))) fail('P22_INDEX_FILE_TYPE', { path });
  }
  const actual = realpathSync(cursor), rel = relative(base, actual);
  if (rel === '..' || rel.startsWith('..' + sep) || resolve(base, rel) !== actual) fail('P22_INDEX_PATH_ESCAPE', { path });
  return readFileSync(actual);
}

/** Derive searchable topic content solely from its managed byte regions. */
export function topicIndexDocuments({ topic, bytes, generation }) {
  const binding = getIndexManagedBinding(bytes, { profile: INDEX_TOPIC_PROFILE });
  const expected = { type: 'topic', pipeline_version: '3.0', rendering_profile: INDEX_TOPIC_PROFILE,
    topic_id: topic.topic_id, revision: topic.revision, language: topic.language, title: topic.title, graph_scope: 'v3-candidate' };
  if (Object.entries(expected).some(([key, value]) => binding.frontmatter[key] !== value)
    || !Array.isArray(binding.frontmatter.aliases) || binding.frontmatter.aliases.some(value => typeof value !== 'string')
    || binding.managedHash !== topic.managed_hash
    || generation.objects.find(row => row.path === topic.path)?.sha256 !== topic.managed_hash) fail('P24_TOPIC_MANAGED_BINDING_INVALID');
  return binding.regions.map(region => ({ id: hash({ topic_id: topic.topic_id, revision: topic.revision, section_id: region.id }),
    entity_type: 'topic', topic_id: topic.topic_id, revision: topic.revision, language: topic.language,
    path: topic.path, managed_hash: topic.managed_hash, section_id: region.id, span_id: 'section:' + region.id,
    anchor: null, unit_ids: [], content: region.content, aliases: binding.frontmatter.aliases.join(' '), title: topic.title }));
}

function verifyObjects(root, generation, index) {
  const readerPaths = new Set();
  for (const topic of generation.topics ?? []) {
    const expected = topicIndexDocuments({ topic, bytes: readRegular(root, topic.path), generation }).sort((a, b) => a.id.localeCompare(b.id));
    const actual = index.documents.filter(row => row.entity_type === 'topic' && row.topic_id === topic.topic_id).sort((a, b) => a.id.localeCompare(b.id));
    if (hash(expected) !== hash(actual)) fail('P24_TOPIC_INDEX_MAPPING_MISMATCH');
    readerPaths.add(topic.path);
  }
  for (const paper of generation.papers.filter(row => row.profile === INDEX_READING_FIRST_PROFILE)) {
    const presentation = verifyReadingFirstPresentation(paper, readRegular(root, paper.reader_presentation.path), generation);
    const notes = Object.fromEntries(Object.entries(paper.paths).map(([language, path]) => [language, readRegular(root, path)]));
    const files = presentation.targets.support.map(row => ({ path: row.path, bytes: readRegular(root, row.path) }));
    const expected = readingFirstIndexDocuments({ paper, presentation, notes, generation, files }).sort((a, b) => a.id.localeCompare(b.id));
    const actual = index.documents.filter(row => row.paper_id === paper.paper_id).sort((a, b) => a.id.localeCompare(b.id));
    if (hash(expected) !== hash(actual)) fail('RF_COMMITTED_INDEX_MAPPING_MISMATCH');
    Object.values(paper.paths).forEach(path => readerPaths.add(path));
  }
  for (const paper of generation.papers.filter(row => row.profile === INDEX_READER_PROFILE)) {
    const presentation = verifyReaderPresentation(paper, readRegular(root, paper.reader_presentation.path), generation);
    const notes = Object.fromEntries(Object.entries(paper.paths).map(([language, path]) => [language, readRegular(root, path)]));
    if (!paper.terminology) fail('P221_READER_TERMS_MISMATCH');
    const readingRecords = Object.values(presentation.targets.reading_records ?? {}).map(row => ({ path: row.path, bytes: readRegular(root, row.path) }));
    const expected = readerIndexDocuments({ paper, presentation, notes, generation, readingRecords }).sort((a, b) => a.id.localeCompare(b.id));
    const actual = index.documents.filter(row => row.paper_id === paper.paper_id).sort((a, b) => a.id.localeCompare(b.id));
    if (hash(expected) !== hash(actual)) fail('P221_READER_INDEX_MAPPING_MISMATCH');
    Object.values(paper.paths).forEach(path => readerPaths.add(path));
  }
  const papers = new Map(generation.papers.flatMap(p => Object.keys(p.paths).map(language => [p.paths[language], { p, language }])));
  for (const item of generation.objects) {
    if (readerPaths.has(item.path)) continue;
    const bytes = readRegular(root, item.path), record = papers.get(item.path);
    if (item.kind === 'support') assertV3SupportBytes(bytes, item.path);
    if (record) {
      const binding = checkPaperBytes(record.p, record.language, bytes, generation);
      for (const region of binding.regions) {
        const doc = index.documents.find(d => d.path === item.path && d.section_id === region.id && d.span_id === 'section:' + region.id);
        if (!doc || doc.content !== region.content) fail('P22_INDEX_MANAGED_CONTENT_MISMATCH', { path: item.path, section_id: region.id });
      }
    } else if (sha(bytes) !== item.sha256) fail('P22_OBJECT_HASH_MISMATCH', { path: item.path });
  }
}

export function assertIndexGeneration(index, generation) {
  assertActiveIndexContract(index, 'index');
  if (index.generation_id !== generation.generation_id || index.evidence_mode !== generation.evidence_mode
    || index.active_fingerprint !== hash(generation)) fail('P22_INDEX_STALE');
  unique(index.documents.map(d => d.id), 'P22_INDEX_DOCUMENT_DUPLICATE');
  if (!Array.isArray(generation.index_manifest)) fail('P22_INDEX_MANIFEST_MISSING');
  unique(generation.index_manifest.map(d => d.id), 'P22_INDEX_MANIFEST_DUPLICATE');
  const manifest = new Map(generation.index_manifest.map(d => [d.id, d.sha256]));
  if (manifest.size !== index.documents.length || index.documents.some(d => manifest.get(d.id) !== hash(d))) fail('P22_INDEX_MANIFEST_MISMATCH');
  const papers = new Map(generation.papers.map(p => [p.paper_id, p]));
  const represented = new Set();
  for (const doc of index.documents) {
    if (doc.entity_type === 'topic') {
      const topic = (generation.topics ?? []).find(row => row.topic_id === doc.topic_id);
      if (!topic || ['revision', 'language', 'path', 'managed_hash'].some(key => doc[key] !== topic[key])
        || doc.span_id !== 'section:' + doc.section_id) fail('P24_TOPIC_INDEX_STALE');
      represented.add(doc.path);
      continue;
    }
    const p = papers.get(doc.paper_id), language = doc.language;
    const readingFirst = p?.profile === INDEX_READING_FIRST_PROFILE;
    const support = readingFirst && doc.entity_id !== undefined;
    if (!p || (!support && p.paths[language] !== doc.path) || ['run_id', 'analysis_revision', 'pipeline_version', 'core_hash'].some(k => doc[k] !== p[k])
      || ([INDEX_READER_PROFILE, INDEX_READING_FIRST_PROFILE].includes(p.profile) ? doc.profile !== p.profile : doc.profile !== undefined)
      || (support ? doc.section_id !== 'knowledge' || !generation.shared_nodes.some(row => row.entity_id === doc.entity_id && row.path === doc.path)
        : !(readingFirst ? READING_FIRST_INDEX_REGIONS : PHASE22_REGIONS).includes(doc.section_id))) fail('P22_INDEX_DOCUMENT_STALE');
    represented.add(doc.path);
  }
  if (generation.papers.some(p => Object.values(p.paths).some(path => !represented.has(path)
    || (p.profile === INDEX_READING_FIRST_PROFILE ? READING_FIRST_INDEX_REGIONS : PHASE22_REGIONS).some(id => !index.documents.some(d => d.path === path && d.section_id === id && d.span_id === 'section:' + id))))) fail('P22_INDEX_INCOMPLETE');
  if ((generation.topics ?? []).some(topic => ['topic', 'sources'].some(id => !index.documents.some(doc => doc.entity_type === 'topic' && doc.topic_id === topic.topic_id && doc.section_id === id)))) fail('P24_TOPIC_INDEX_INCOMPLETE');
  return index;
}

function parsePair(root, markerBytes) {
  const marker = assertActiveIndexContract(JSON.parse(markerBytes), 'commit');
  const paths = phase22GenerationPaths(marker.generation_id);
  if (marker.active.path !== paths.active || marker.index.path !== paths.index || marker.approval.evidence_mode !== marker.evidence_mode) fail('P22_COMMIT_PAIR_INVALID');
  const activeBytes = readRegular(root, marker.active.path), indexBytes = readRegular(root, marker.index.path);
  if (sha(activeBytes) !== marker.active.sha256 || sha(indexBytes) !== marker.index.sha256) fail('P22_COMMIT_PAIR_HASH_MISMATCH');
  const generation = assertActiveGeneration(JSON.parse(activeBytes));
  if (generation.generation_id !== marker.generation_id || generation.evidence_mode !== marker.evidence_mode) fail('P22_COMMIT_PAIR_INVALID');
  const index = assertIndexGeneration(JSON.parse(indexBytes), generation);
  return { marker, generation, index };
}

/** Observe the committed metadata pair without imposing historical hashes on editable notes. */
export async function readRegisteredCommit({ vaultRoot, maxAttempts = 2, onReadBoundary } = {}) {
  if (typeof vaultRoot !== 'string' || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) fail('P22_READER_ARGUMENT_INVALID');
  let last;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const before = readRegular(vaultRoot, PHASE22_COMMIT_PATH);
      await onReadBoundary?.('after-pointer', { attempt });
      const { marker, generation, index } = parsePair(vaultRoot, before);
      await onReadBoundary?.('after-pair', { attempt });
      parsePair(vaultRoot, before);
      if (!before.equals(readRegular(vaultRoot, PHASE22_COMMIT_PATH))) fail('P22_GENERATION_CHANGED');
      const snapshot = freezePhase22Value({ ok: true, status: 'current', committed: true, generation_id: generation.generation_id,
        generation, index, evidence_mode: marker.evidence_mode, approval: marker.approval });
      registeredCommits.set(snapshot, { root: resolve(vaultRoot), markerHash: sha(before), indexHash: hash(index) });
      return snapshot;
    } catch (error) { last = { code: error.code ?? 'P22_GENERATION_UNREADABLE', details: error.details ?? {} }; }
  }
  return { ok: false, status: 'not_current', errors: [last], attempts: maxAttempts };
}

export function assertRegisteredCommit(snapshot) {
  const record = registeredCommits.get(snapshot);
  if (!record) fail('P22_REGISTERED_COMMIT_REQUIRED');
  const before = readRegular(record.root, PHASE22_COMMIT_PATH);
  if (sha(before) !== record.markerHash) fail('P22_GENERATION_CHANGED');
  parsePair(record.root, before);
  if (!before.equals(readRegular(record.root, PHASE22_COMMIT_PATH))) fail('P22_GENERATION_CHANGED');
  return record;
}

/** Read a registered immutable object under a pair-only capability. */
export function readRegisteredObject(snapshot, path) {
  const record = assertRegisteredCommit(snapshot);
  const object = snapshot.generation.objects.find(row => row.path === path);
  if (!object || path.startsWith('Wiki/')) fail('P22_REGISTERED_OBJECT_MISSING', { path });
  const bytes = readRegular(record.root, path);
  if (sha(bytes) !== object.sha256) fail('P22_OBJECT_HASH_MISMATCH', { path });
  assertRegisteredCommit(snapshot);
  return { bytes, sha256: object.sha256 };
}

function verifySharedObjects(root, generation) {
  const objects = new Map(generation.objects.map(row => [row.path, row]));
  for (const node of generation.shared_nodes) {
    const item = objects.get(node.path);
    if (item?.kind !== 'support') fail('P22_SHARED_MEMBER_INVALID', { path: node.path });
    let bytes;
    try { bytes = readRegular(root, node.path); }
    catch (cause) { fail('P22_SHARED_OBJECT_UNREADABLE', { path: node.path, cause: cause.code ?? cause.message }); }
    assertV3SupportBytes(bytes, node.path);
    if (sha(bytes) !== item.sha256) fail('P22_OBJECT_HASH_MISMATCH', { path: node.path });
  }
}

/** Restricted capability: verifies the committed pair and shared nodes, never paper bytes. */
export async function readCommittedSharedNodes({ vaultRoot, maxAttempts = 2, onReadBoundary } = {}) {
  if (typeof vaultRoot !== 'string' || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) fail('P22_READER_ARGUMENT_INVALID');
  let last;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const before = readRegular(vaultRoot, PHASE22_COMMIT_PATH);
      await onReadBoundary?.('after-pointer', { attempt });
      const { marker, generation } = parsePair(vaultRoot, before);
      verifySharedObjects(vaultRoot, generation);
      await onReadBoundary?.('after-objects', { attempt });
      const current = parsePair(vaultRoot, before);
      verifySharedObjects(vaultRoot, current.generation);
      if (!before.equals(readRegular(vaultRoot, PHASE22_COMMIT_PATH))) fail('P22_GENERATION_CHANGED');
      const snapshot = freezePhase22Value({ ok: true, generation_id: generation.generation_id, generation, evidence_mode: marker.evidence_mode });
      sharedSnapshots.set(snapshot, { root: resolve(vaultRoot), markerHash: sha(before) });
      return snapshot;
    } catch (error) { last = { code: error.code ?? 'P22_GENERATION_UNREADABLE', details: error.details ?? {} }; }
  }
  return { ok: false, status: 'not_current', errors: [last], attempts: maxAttempts };
}

export function assertCommittedSharedNodes(snapshot) {
  const record = sharedSnapshots.get(snapshot);
  if (!record) fail('P22_SHARED_SNAPSHOT_NOT_COMMITTED');
  try {
    const before = readRegular(record.root, PHASE22_COMMIT_PATH);
    if (sha(before) !== record.markerHash) fail('P22_GENERATION_CHANGED');
    const { generation } = parsePair(record.root, before);
    verifySharedObjects(record.root, generation);
    if (!before.equals(readRegular(record.root, PHASE22_COMMIT_PATH))) fail('P22_GENERATION_CHANGED');
  } catch (cause) { fail('P22_SHARED_SNAPSHOT_NOT_CURRENT', { cause: cause.code ?? cause.message, ...cause.details }); }
  return record;
}

/** Read only one registered asset, guarded by the same scoped capability. */
export function readCommittedSharedAsset(snapshot, path) {
  const record = assertCommittedSharedNodes(snapshot);
  const item = snapshot.generation.objects.find(row => row.kind === 'asset' && row.path === path);
  if (!item) fail('P22_SHARED_ASSET_UNREGISTERED', { path });
  const bytes = readRegular(record.root, path);
  if (sha(bytes) !== item.sha256) fail('P22_OBJECT_HASH_MISMATCH', { path });
  assertCommittedSharedNodes(snapshot);
  return { generation_id: snapshot.generation_id, path, bytes, sha256: item.sha256 };
}

export function readCommittedSharedNodeContents(snapshot) {
  const record = assertCommittedSharedNodes(snapshot);
  const objects = new Map(snapshot.generation.objects.map(row => [row.path, row]));
  const contents = new Map();
  for (const node of snapshot.generation.shared_nodes) {
    const item = objects.get(node.path);
    if (item?.kind !== 'support') fail('P22_SHARED_MEMBER_INVALID', { path: node.path });
    const bytes = readRegular(record.root, node.path);
    assertV3SupportBytes(bytes, node.path);
    if (sha(bytes) !== item.sha256) fail('P22_OBJECT_HASH_MISMATCH', { path: node.path });
    contents.set(node.path, bytes);
  }
  assertCommittedSharedNodes(snapshot);
  return contents;
}

/** Only this double-read observer can mint a public-query snapshot capability. */
export async function readCommittedGeneration({ vaultRoot, maxAttempts = 2, onReadBoundary } = {}) {
  if (typeof vaultRoot !== 'string' || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) fail('P22_READER_ARGUMENT_INVALID');
  let last;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const before = readRegular(vaultRoot, PHASE22_COMMIT_PATH);
      await onReadBoundary?.('after-pointer', { attempt });
      const { marker, generation, index } = parsePair(vaultRoot, before);
      verifyObjects(vaultRoot, generation, index);
      await onReadBoundary?.('after-objects', { attempt });
      // The asynchronous observation boundary may admit another writer. Recheck
      // both the paired metadata bytes and all managed objects before returning.
      const current = parsePair(vaultRoot, before);
      verifyObjects(vaultRoot, current.generation, current.index);
      const after = readRegular(vaultRoot, PHASE22_COMMIT_PATH);
      if (!before.equals(after)) fail('P22_GENERATION_CHANGED');
      const snapshot = freezePhase22Value({ ok: true, status: 'current', committed: true, generation_id: generation.generation_id,
        generation, index, evidence_mode: marker.evidence_mode, approval: marker.approval });
      snapshots.set(snapshot, { root: resolve(vaultRoot), markerHash: sha(before), indexHash: hash(index) });
      return snapshot;
    } catch (error) { last = { code: error.code ?? 'P22_GENERATION_UNREADABLE', details: error.details ?? {} }; }
  }
  return { ok: false, status: 'not_current', errors: [last], attempts: maxAttempts };
}

/** Cached capabilities are re-observed; a changed file or pointer cannot serve stale data. */
export function assertCommittedSnapshot(snapshot) {
  const record = snapshots.get(snapshot);
  if (!record) fail('P22_SNAPSHOT_NOT_COMMITTED');
  try {
    const before = readRegular(record.root, PHASE22_COMMIT_PATH);
    if (sha(before) !== record.markerHash) fail('P22_GENERATION_CHANGED');
    parsePair(record.root, before);
    verifyObjects(record.root, snapshot.generation, snapshot.index);
    if (!before.equals(readRegular(record.root, PHASE22_COMMIT_PATH))) fail('P22_GENERATION_CHANGED');
  } catch (cause) { fail('P22_SNAPSHOT_NOT_CURRENT', { cause: cause.code ?? cause.message }); }
  return record;
}

/** Read the already registered physical sidecars for proposal consumers; no glob or sibling inference. */
export function readCommittedReaderPresentations(snapshot) {
  const observed = assertCommittedSnapshot(snapshot);
  const rows = snapshot.generation.papers.filter(paper => paper.profile === INDEX_READER_PROFILE).map(paper => ({ paper,
    presentation: verifyReaderPresentation(paper, readRegular(observed.root, paper.reader_presentation.path), snapshot.generation) }));
  assertCommittedSnapshot(snapshot);
  return freezePhase22Value(rows);
}

/** Latest reading sidecars are consumed only through the verified committed generation. */
export function readCommittedReadingFirstPresentations(snapshot) {
  const observed = assertCommittedSnapshot(snapshot);
  const rows = snapshot.generation.papers.filter(paper => paper.profile === INDEX_READING_FIRST_PROFILE).map(paper => ({ paper,
    presentation: verifyReadingFirstPresentation(paper, readRegular(observed.root, paper.reader_presentation.path), snapshot.generation) }));
  assertCommittedSnapshot(snapshot);
  return freezePhase22Value(rows);
}

/** Resolve only the explicitly named archival snapshot, with its original committed pair and objects. */
export async function readRegisteredGeneration({ vaultRoot, generationId, currentSnapshot } = {}) {
  phase22GenerationPaths(generationId);
  const current = currentSnapshot ?? await readCommittedGeneration({ vaultRoot });
  if (!current.ok) fail('P24_COMMITTED_REQUIRED');
  assertCommittedSnapshot(current);
  if (current.generation_id === generationId) return { snapshot: current, physical_root: resolve(vaultRoot), historical: false };
  const physicalRoot = resolve(vaultRoot, '.apa-v3/phase22/history', generationId, 'snapshot');
  const snapshot = await readCommittedGeneration({ vaultRoot: physicalRoot });
  if (!snapshot.ok || snapshot.generation_id !== generationId) fail('P24_REGISTERED_HISTORY_UNAVAILABLE', { generation_id: generationId, errors: snapshot.errors });
  assertCommittedSnapshot(current);
  return { snapshot, physical_root: physicalRoot, historical: true };
}

export function resolveActivePaper({ generation, paperId } = {}) {
  assertCommittedSnapshot(generation);
  return generation.generation.papers.find(p => p.paper_id === paperId) ?? null;
}

