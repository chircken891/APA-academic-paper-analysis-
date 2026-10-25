import YAML from 'yaml';
import { fingerprintV3Json } from './semantic-package-validator.mjs';

export const PHASE22_MACHINE_FIELDS = Object.freeze([
  'type', 'pipeline_version', 'rendering_profile', 'paper_id', 'run_id', 'analysis_revision',
  'language', 'title', 'aliases', 'basis_fingerprint', 'context_fingerprint', 'core_fingerprint',
  'view_fingerprint', 'parity_fingerprint', 'scientific_completeness', 'evidence_mode',
  'review_ready', 'graph_scope', 'alternate_language_path',
]);
export const PHASE221_MACHINE_FIELDS = Object.freeze(['type', 'pipeline_version', 'rendering_profile', 'language', 'graph_scope']);
export const READING_FIRST_MACHINE_FIELDS = Object.freeze([...PHASE221_MACHINE_FIELDS, 'paper_id', 'title', 'status', 'alternate_language_path']);
export const TOPIC_MACHINE_FIELDS = Object.freeze(['type', 'pipeline_version', 'rendering_profile', 'topic_id', 'revision', 'language', 'title', 'aliases', 'graph_scope']);
export function machineFieldsForProfile(profile) {
  if (profile === 'phase24-topic-1.0') return TOPIC_MACHINE_FIELDS;
  if (profile === 'reading-first-obsidian-1.0') return READING_FIRST_MACHINE_FIELDS;
  if (profile === 'phase22-reader-note-1.0') return PHASE221_MACHINE_FIELDS;
  if (profile === undefined || profile === 'phase22-managed-note-1.0') return PHASE22_MACHINE_FIELDS;
  fail('P221_PROFILE_UNKNOWN');
}
const regionIds = ['source', 'abstract', 'study-design', 'key-findings', 'methods-concepts-measures', 'figures-tables', 'discussion', 'limitations', 'conclusion', 'evidence', 'relations', 'coverage'];
function fail(code, position) { throw Object.assign(new Error(`${code}${position === undefined ? '' : ` at byte ${position}`}`), { code, position }); }
function asBytes(value) {
  if (!(value instanceof Uint8Array)) fail('P22_BYTES_REQUIRED');
  const bytes = Buffer.from(value);
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('P22_UTF8_INVALID'); }
  return bytes;
}
function parse(bytes) {
  const text = bytes.toString('utf8');
  const match = /^(---\r?\n)([\s\S]*?)(^---(?:\r?\n|$))/m.exec(text);
  if (!match || match.index !== 0) fail('P22_FRONTMATTER_REQUIRED', 0);
  const yamlStart = match[1].length;
  const yamlEnd = yamlStart + match[2].length;
  const doc = YAML.parseDocument(match[2], { keepSourceTokens: true, uniqueKeys: true });
  if (doc.errors.length || !YAML.isMap(doc.contents)) fail('P22_YAML_INVALID', Buffer.byteLength(text.slice(0, yamlStart)));
  const profile = doc.get('rendering_profile');
  const activeRegionIds = profile === 'phase24-topic-1.0' ? ['topic', 'sources'] : profile === 'reading-first-obsidian-1.0' ? ['source', 'reading', 'resources'] : regionIds;
  const machineFields = machineFieldsForProfile(profile);
  const fields = new Set(machineFields);
  const owners = new Map(); const anchors = new Map(); const aliases = [];
  for (const pair of doc.contents.items) {
    if (!YAML.isScalar(pair.key) || typeof pair.key.value !== 'string' || !pair.value?.range) fail('P22_YAML_RANGE_AMBIGUOUS');
    const key = pair.key.value;
    if (/^(?:p24[_-]|human[_-]enrichment|selection[_-](?:map|receipt|overlay)|evidence[_-]overlay)/i.test(key)) fail('P22_ENRICHMENT_UNRECOGNIZED');
    owners.set(key, pair);
    YAML.visit(pair.value, (_, node) => {
      if (node?.anchor) anchors.set(node, fields.has(key));
      if (YAML.isAlias(node)) aliases.push({ node, owner: fields.has(key) });
    });
  }
  for (const { node, owner } of aliases) {
    const target = node.resolve(doc);
    if (!anchors.has(target) || anchors.get(target) !== owner) fail('P22_ALIAS_OWNERSHIP');
  }
  let frontmatter;
  try { frontmatter = doc.toJS({ maxAliasCount: 100 }); } catch { fail('P22_YAML_INVALID'); }
  const byteOffset = index => Buffer.byteLength(text.slice(0, index));
  const bodyStart = match[0].length;
  const markers = [...text.slice(bodyStart).matchAll(/<!--\s*AUTO[^\r\n]*(?:-->|$)/g)];
  if ([...text.slice(bodyStart).matchAll(/<!--\s*AUTO/g)].length !== markers.length || markers.length !== activeRegionIds.length * 2) fail('P22_MARKER_TOPOLOGY', byteOffset(bodyStart));
  const regions = [];
  markers.forEach((marker, index) => {
    const id = activeRegionIds[Math.floor(index / 2)];
    const expected = `<!-- AUTO:${index % 2 ? 'END' : 'START'} ${id} -->`;
    const start = bodyStart + marker.index;
    const end = start + marker[0].length;
    if (marker[0] !== expected || (start > 0 && text[start - 1] !== '\n') || !/^(?:\r?\n|$)/.test(text.slice(end))) fail('P22_MARKER_TOPOLOGY', byteOffset(start));
    if (index % 2) {
      const region = regions.at(-1); region.to = byteOffset(end); region.bytes = bytes.subarray(region.from, region.to);
    } else regions.push({ id, from: byteOffset(start) });
  });
  const notes = [...text.slice(bodyStart).matchAll(/^## (?:Personal Notes|个人备注|个人笔记)(?:\r?\n|$)/gm)];
  if (notes.length !== 1 || byteOffset(bodyStart + notes[0].index) < regions.at(-1).to) fail('P22_PERSONAL_NOTES_TOPOLOGY');
  const machineRanges = [...owners].filter(([key]) => fields.has(key)).map(([, pair]) => ({ from: byteOffset(yamlStart + pair.key.range[0]), to: byteOffset(yamlStart + valueEnd(match[2], pair)) }));
  const owned = [...machineRanges, ...regions].sort((a, b) => a.from - b.from);
  const humanRanges = []; let cursor = 0;
  for (const range of owned) {
    if (range.from > cursor) humanRanges.push({ from: cursor, to: range.from, bytes: bytes.subarray(cursor, range.from) });
    cursor = range.to;
  }
  if (cursor < bytes.length) humanRanges.push({ from: cursor, to: bytes.length, bytes: bytes.subarray(cursor) });
  if (profile === 'phase24-topic-1.0' || profile === 'phase22-reader-note-1.0') {
    if (machineFields.some(key => !Object.hasOwn(frontmatter, key))) fail(profile === 'phase24-topic-1.0' ? 'P24_TOPIC_FIELDS_REQUIRED' : 'P221_READER_FIELDS_REQUIRED');
    const personalAt = byteOffset(bodyStart + notes[0].index);
    for (const range of humanRanges) {
      const from = Math.max(range.from, byteOffset(bodyStart)), to = Math.min(range.to, personalAt);
      if (to > from && bytes.subarray(from, to).toString('utf8').replace(/<!--[\s\S]*?-->/g, '').trim()) fail(profile === 'phase24-topic-1.0' ? 'P24_TOPIC_HUMAN_STRUCTURE' : 'P221_HUMAN_STRUCTURE', from);
    }
  }
  const machine = Object.fromEntries(machineFields.filter(key => Object.hasOwn(frontmatter, key)).map(key => [key, frontmatter[key]]));
  const managedHash = fingerprintV3Json({ machine, regions: regions.map(r => ({ id: r.id, text: r.bytes.toString('utf8') })) });
  return { frontmatter, managedHash, humanRanges, regions, owners, yamlStart, yamlEnd, byteOffset, text, profile, machineFields };
}
export function inspectManagedNote(input) {
  const { frontmatter, managedHash, humanRanges, regions } = parse(asBytes(input));
  return { frontmatter, managedHash, humanRanges, regions };
}
export function mergeManagedNote({ existingBytes, rendered, expectedManagedHash }) {
  const candidateBytes = asBytes(rendered);
  const candidate = parse(candidateBytes);
  if (existingBytes === null || existingBytes === undefined) {
    if (expectedManagedHash !== undefined && expectedManagedHash !== null) fail('P22_MANAGED_HASH_MISMATCH');
    return { bytes: candidateBytes, managedHash: candidate.managedHash, humanRanges: candidate.humanRanges };
  }
  const bytes = asBytes(existingBytes); const existing = parse(bytes);
  if (candidate.profile !== existing.profile && (candidate.profile === 'phase24-topic-1.0' || existing.profile === 'phase24-topic-1.0')) fail('P24_PROFILE_MISMATCH');
  if (candidate.profile !== existing.profile && (candidate.profile === 'reading-first-obsidian-1.0' || existing.profile === 'reading-first-obsidian-1.0')) fail('RF_OBSIDIAN_PROFILE_MISMATCH');
  if (candidate.profile !== existing.profile && (candidate.profile === 'phase22-reader-note-1.0' || existing.profile === 'phase22-reader-note-1.0')) fail('P221_PROFILE_MISMATCH');
  if (expectedManagedHash !== undefined && expectedManagedHash !== existing.managedHash) fail('P22_MANAGED_HASH_MISMATCH');
  const patches = existing.regions.map((region, index) => ({ from: region.from, to: region.to, bytes: candidate.regions[index].bytes }));
  const eol = existing.text.includes('\r\n') ? '\r\n' : '\n';
  const additions = [];
  for (const key of candidate.machineFields) {
    const oldPair = existing.owners.get(key); const newPair = candidate.owners.get(key);
    if (oldPair && newPair && !hasAliases(oldPair.value) && fingerprintV3Json(existing.frontmatter[key]) === fingerprintV3Json(candidate.frontmatter[key])) continue;
    if (oldPair) {
      const from = existing.byteOffset(existing.yamlStart + (newPair ? oldPair.value.range[0] : oldPair.key.range[0]));
      const to = existing.byteOffset(existing.yamlStart + valueEnd(existing.text.slice(existing.yamlStart, existing.yamlEnd), oldPair));
      // Inline comments lie outside range[1]; nested comments cannot be safely relocated.
      if (oldPair.value.commentBefore || hasInternalComments(oldPair.value)) fail('P22_YAML_COMMENT_RANGE_AMBIGUOUS', from);
      const replacement = newPair ? JSON.stringify(candidate.frontmatter[key]) : '';
      patches.push({ from, to, bytes: Buffer.from(replacement) });
    } else if (newPair) additions.push(YAML.stringify({ [key]: candidate.frontmatter[key] }, { lineWidth: 0 }).replaceAll('\n', eol));
  }
  if (additions.length) { const at = existing.byteOffset(existing.yamlEnd); patches.push({ from: at, to: at, bytes: Buffer.from(additions.join('')) }); }
  let output = bytes;
  for (const patch of patches.sort((a, b) => b.from - a.from)) output = Buffer.concat([output.subarray(0, patch.from), patch.bytes, output.subarray(patch.to)]);
  const inspected = inspectManagedNote(output);
  return { bytes: output, managedHash: inspected.managedHash, humanRanges: inspected.humanRanges };
}
function hasInternalComments(value) {
  let found = false;
  YAML.visit(value, (_, node) => { if (node !== value && (node?.comment || node?.commentBefore)) found = true; });
  return found;
}

function valueEnd(source, pair) {
  const end = pair.value.range[1];
  const trailing = /\r?\n$/.exec(source.slice(pair.value.range[0], end));
  return end - (trailing?.[0].length ?? 0);
}


function hasAliases(value) {
  let found = false;
  YAML.visit(value, (_, node) => { if (YAML.isAlias(node)) found = true; });
  return found;
}
