import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import YAML from 'yaml';
import MarkdownIt from 'markdown-it';
import { readRegisteredCommit, assertRegisteredCommit, normalizeIndexPath } from './phase22-active-version.mjs';
import { inspectManagedNote } from './phase22-managed-markdown.mjs';

const records = new WeakMap();
const markdown = new MarkdownIt();
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const fail = (code, details = {}) => { throw Object.assign(new Error(code), { code, details }); };

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

function parseNote(bytes, path, generation, index) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) fail('P23_CURRENT_FRONTMATTER_INVALID', { path });
  const doc = YAML.parseDocument(match[1], { uniqueKeys: true });
  if (doc.errors.length || !YAML.isMap(doc.contents)) fail('P23_CURRENT_FRONTMATTER_INVALID', { path });
  const fm = doc.toJS({ maxAliasCount: 100 });
  const paper = generation.papers.find(row => Object.values(row.paths).includes(path));
  const topic = (generation.topics ?? []).find(row => row.path === path);
  const node = generation.shared_nodes.find(row => row.path === path);
  if (paper) {
    const language = Object.entries(paper.paths).find(([, value]) => value === path)[0];
    const readerProfile = paper.profile === 'phase22-reader-note-1.0';
    const managedProfile = !paper.profile || paper.profile === 'phase22-managed-note-1.0';
    if (fm.type !== 'paper' || (!readerProfile && fm.paper_id !== paper.paper_id)
      || (readerProfile && fm.paper_id !== undefined && fm.paper_id !== paper.paper_id)
      || fm.language !== language || fm.pipeline_version !== '3.0'
      || fm.rendering_profile !== (paper.profile ?? 'phase22-managed-note-1.0')
      || (!readerProfile && fm.alternate_language_path !== paper.paths[language === 'en' ? 'zh-CN' : 'en'])
      || ((managedProfile || fm.run_id !== undefined) && fm.run_id !== paper.run_id)
      || ((managedProfile || fm.analysis_revision !== undefined) && fm.analysis_revision !== paper.analysis_revision)) fail('P23_CURRENT_IDENTITY_MISMATCH', { path });
  } else if (topic) {
    if (fm.type !== 'topic' || fm.pipeline_version !== '3.0' || fm.topic_id !== topic.topic_id || fm.revision !== topic.revision || fm.language !== topic.language
      || fm.rendering_profile !== topic.schema_version) fail('P23_CURRENT_IDENTITY_MISMATCH', { path });
  } else if (node) {
    const id = fm.knowledge_id ?? fm.measure_id ?? fm.concept_id;
    const canonical = index.documents.find(row => row.path === path && row.entity_id === node.entity_id)?.title;
    let embedded;
    const state = /<!-- KNOWLEDGE_STATE ([A-Za-z0-9+/=]+) -->/.exec(text);
    if (state) {
      try { embedded = JSON.parse(Buffer.from(state[1], 'base64').toString('utf8')).item; }
      catch { fail('P23_CURRENT_IDENTITY_MISMATCH', { path }); }
    }
    const expectedType = path.startsWith('Wiki/methods/') ? 'method' : path.startsWith('Wiki/concepts/') ? 'concept' : embedded?.kind;
    const validId = typeof id === 'string' && id.trim() && (!fm.knowledge_id || (typeof fm.canonical_key === 'string' && fm.canonical_key.trim()));
    const invalidRegisteredId = node.entity_id.startsWith('rf_')
      ? Boolean(canonical && canonical !== node.entity_id && fm.canonical_key !== canonical)
      : id !== node.entity_id;
    if (fm.pipeline_version !== '3.0' || !validId || (expectedType && fm.type !== expectedType)
      || (embedded?.kind && fm.type !== embedded.kind) || invalidRegisteredId
      || (embedded && fm.knowledge_id && fm.knowledge_id !== embedded.id)
      || (embedded && fm.canonical_key && fm.canonical_key !== embedded.canonical_key)
      || (embedded && (fm.measure_id || fm.concept_id) && (fm.measure_id ?? fm.concept_id) !== embedded.canonical_key)) fail('P23_CURRENT_IDENTITY_MISMATCH', { path });
  } else fail('P23_CURRENT_UNREGISTERED', { path });
  let managedHash = null;
  if (paper || topic) { try { managedHash = inspectManagedNote(bytes).managedHash; } catch { /* Editable layout can differ from historic managed markers. */ } }
  const fullBody = text.slice(match[0].length);
  const lineOffsets = [0];
  for (let index = 0; index < fullBody.length; index++) if (fullBody[index] === '\n') lineOffsets.push(index + 1);
  const tokens = markdown.parse(fullBody, {}), parsedHeadings = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type !== 'heading_open' || token.level !== 0 || !token.map) continue;
    const inline = tokens[index + 1];
    const name = (inline?.children ?? []).filter(child => ['text', 'code_inline', 'softbreak'].includes(child.type))
      .map(child => child.type === 'softbreak' ? ' ' : child.content).join('').trim();
    parsedHeadings.push({ index: lineOffsets[token.map[0]], level: Number(token.tag.slice(1)), name });
  }
  const personal = parsedHeadings.find(heading => heading.level === 2 && /^(?:Personal Notes|个人备注|个人笔记)$/.test(heading.name));
  const rawBody = fullBody.slice(0, personal?.index ?? fullBody.length);
  const clean = value => value.replace(/<!--[\s\S]*?-->/g, '').trim();
  const headings = parsedHeadings.filter(heading => heading.index < rawBody.length);
  const markers = [...rawBody.matchAll(/<!-- AUTO:(START|END) ([a-z0-9-]+) -->/g)];
  const sections = [];
  if (!headings.length || clean(rawBody.slice(0, headings[0].index))) {
    sections.push({ anchor: null, content: clean(rawBody.slice(0, headings[0]?.index ?? rawBody.length)), section_id: null, language: null });
  }
  let activeLanguage = null;
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i], name = heading.name;
    if (heading.level === 2) activeLanguage = name === 'English' ? 'en' : name === '中文' ? 'zh-CN' : null;
    let region = null;
    for (const marker of markers) {
      if (marker.index > heading.index) break;
      region = marker[1] === 'START' ? marker[2] : null;
    }
    sections.push({ anchor: name, content: clean(rawBody.slice(heading.index, headings[i + 1]?.index ?? rawBody.length)),
      section_id: region, language: node ? activeLanguage : null });
  }
  return { fm, body: clean(rawBody), sections, managedHash, paper };
}

/** Observe the registered inventory and a stable set of editable Markdown bytes. */
export async function readCurrentVaultContent({ vaultRoot, maxAttempts = 2, onReadBoundary } = {}) {
  if (typeof vaultRoot !== 'string' || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) fail('P22_READER_ARGUMENT_INVALID');
  let last;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const commit = await readRegisteredCommit({ vaultRoot, maxAttempts: 1 });
    if (!commit.ok) { last = commit.errors[0]; continue; }
    try {
      const objects = new Map(commit.generation.objects.map(row => [row.path, row]));
      const paths = new Set([...commit.generation.papers.flatMap(row => Object.values(row.paths)),
        ...(commit.generation.topics ?? []).map(row => row.path), ...commit.generation.shared_nodes.map(row => row.path)]);
      const contents = new Map(), diagnostics = [];
      for (const path of paths) {
        try {
          const object = objects.get(path);
          if (!object) fail('P23_CURRENT_UNREGISTERED', { path });
          const bytes = readRegular(vaultRoot, path), parsed = parseNote(bytes, path, commit.generation, commit.index);
          const currentSha = sha(bytes);
          let baseline = parsed.managedHash ?? currentSha;
          let expected = object.sha256;
          let completeBaseline = !parsed.paper && !(commit.generation.topics ?? []).some(row => row.path === path);
          if (parsed.paper?.reader_presentation) {
            try {
              const presentation = readRegular(vaultRoot, parsed.paper.reader_presentation.path);
              const sidecar = objects.get(parsed.paper.reader_presentation.path);
              if (sidecar && sha(presentation) === sidecar.sha256) {
                const language = Object.entries(parsed.paper.paths).find(([, value]) => value === path)[0];
                const published = JSON.parse(presentation).targets?.notes?.[language]?.byte_sha256;
                if (published) { baseline = currentSha; expected = published; completeBaseline = true; }
              }
            } catch { /* Managed binding remains the available baseline. */ }
          }
          const changed = baseline !== expected ? true : completeBaseline ? false : null;
          contents.set(path, { bytes, sha256: currentSha, changed, parsed });
        } catch (error) { diagnostics.push({ code: error.code ?? 'P23_CURRENT_UNREADABLE', path, details: error.details ?? {} }); }
      }
      await onReadBoundary?.('after-objects', { attempt });
      assertRegisteredCommit(commit);
      for (const [path, row] of contents) if (sha(readRegular(vaultRoot, path)) !== row.sha256) fail('P23_CURRENT_CHANGED', { path });
      const snapshot = Object.freeze({ ok: true, status: diagnostics.length ? 'partial' : 'current', committed: true,
        generation_id: commit.generation_id, generation: commit.generation, index: commit.index,
        evidence_mode: commit.evidence_mode, approval: commit.approval, diagnostics: Object.freeze(diagnostics) });
      records.set(snapshot, { root: resolve(vaultRoot), commit, objects, contents });
      return snapshot;
    } catch (error) { last = { code: error.code ?? 'P23_CURRENT_UNREADABLE', details: error.details ?? {} }; }
  }
  return { ok: false, status: 'not_current', errors: [last], attempts: maxAttempts };
}

export function assertCurrentVaultContent(snapshot, { paths = [] } = {}) {
  const record = records.get(snapshot);
  if (!record) fail('P23_CURRENT_SNAPSHOT_REQUIRED');
  assertRegisteredCommit(record.commit);
  for (const path of paths) {
    const row = record.contents.get(path);
    let current;
    try { current = readRegular(record.root, path); } catch { fail('P23_CURRENT_CHANGED', { path }); }
    if (!row || sha(current) !== row.sha256) fail('P23_CURRENT_CHANGED', { path });
  }
  return { root: record.root };
}

export function readCurrentRegisteredBytes(snapshot, path, { verify = true } = {}) {
  const record = records.get(snapshot);
  if (!record) fail('P23_CURRENT_SNAPSHOT_REQUIRED');
  const object = record.objects.get(path);
  if (!object) fail('P23_CURRENT_UNREGISTERED', { path });
  const row = record.contents.get(path);
  if (row) {
    assertCurrentVaultContent(snapshot, { paths: verify ? [path] : [] });
    return { bytes: Buffer.from(row.bytes), sha256: row.sha256, changed: row.changed };
  }
  if (path.startsWith('Wiki/')) fail('P23_CURRENT_UNREADABLE', { path });
  assertCurrentVaultContent(snapshot);
  const bytes = readRegular(record.root, path);
  if (sha(bytes) !== object.sha256) fail('P22_OBJECT_HASH_MISMATCH', { path });
  assertCurrentVaultContent(snapshot);
  return { bytes, sha256: object.sha256, changed: false };
}

/** Copy registered captured Markdown in one observation without validating unrelated edits. */
export function readCurrentRegisteredEntries(snapshot, paths) {
  const record = records.get(snapshot);
  if (!record || !Array.isArray(paths)) fail('P23_CURRENT_SNAPSHOT_REQUIRED');
  assertRegisteredCommit(record.commit);
  const entries = new Map();
  for (const path of paths) {
    const row = record.contents.get(path);
    if (row) entries.set(path, { bytes: Buffer.from(row.bytes), sha256: row.sha256, changed: row.changed });
  }
  assertRegisteredCommit(record.commit);
  return entries;
}

export function getCurrentNote(snapshot, path) {
  const record = records.get(snapshot), row = record?.contents.get(path);
  if (!row) fail('P23_CURRENT_UNREADABLE', { path });
  return { ...row.parsed, fm: structuredClone(row.parsed.fm), sha256: row.sha256, changed: row.changed };
}
