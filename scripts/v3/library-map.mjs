import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import MarkdownIt from 'markdown-it';
import { paperSourcePath } from '../lib/paper-note-path.mjs';
import { readCurrentVaultContent, getCurrentNote, readCurrentRegisteredBytes, assertCurrentVaultContent } from './current-vault-content.mjs';

const markdown = new MarkdownIt();
const hash = value => 'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sort = (a, b) => a.localeCompare(b, 'en');
const normal = value => String(value ?? '').normalize('NFKC').toLowerCase().trim();

/** Numbered modules retain every subsection; a missing section means not separately documented. */
export function extractPaperModules(note, path) {
  const modules = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [String(i + 1), { status: 'not_found', sections: [] }]));
  let active = null;
  for (const section of note.sections) {
    const number = /^(\d)(?:\.|[\s、])/u.exec(section.anchor ?? '')?.[1];
    if (number && modules[number]) active = number;
    else if (section.anchor && !/^\d\./.test(section.anchor)) active = null;
    if (!active) continue;
    modules[active].status = 'found';
    modules[active].sections.push({ path, anchor: section.anchor, text: section.content, sha256: note.sha256, module: Number(active) });
  }
  return modules;
}

export function linkedPaths(body, path) {
  const links = [];
  for (const token of markdown.parse(body, {})) for (const child of token.children ?? []) {
    if (child.type === 'link_open' || child.type === 'image') links.push(child.attrGet(child.type === 'image' ? 'src' : 'href'));
  }
  for (const match of body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) links.push(match[1]);
  return new Set(links.filter(Boolean).map(link => {
    let decoded;
    try { decoded = decodeURIComponent(link.split('#')[0]); } catch { return ''; }
    if (/^[a-z]+:/i.test(decoded) || !decoded) return '';
    const target = decoded.startsWith('Wiki/') ? decoded : posix.normalize(posix.join(posix.dirname(path), decoded));
    return target.replace(/\.md$/, '');
  }));
}
function sourcePath(paper) {
  return paperSourcePath(paper);
}
function finish(snapshot, payload, observed) {
  assertCurrentVaultContent(snapshot, { paths: [...observed] });
  const result = { ok: true, status: snapshot.diagnostics.length ? 'partial' : snapshot.generation.papers.length ? 'matches' : 'empty_library',
    generation_id: snapshot.generation_id, evidence_mode: snapshot.evidence_mode, diagnostics: snapshot.diagnostics, ...payload };
  return { ...result, content_hash: hash(result) };
}
async function material({ vaultRoot }) {
  const snapshot = await readCurrentVaultContent({ vaultRoot });
  if (!snapshot.ok) return { error: { ok: false, status: 'not_ready', generation_id: null, errors: snapshot.errors, content_hash: hash(snapshot.errors) } };
  const observed = new Set(), nodes = [], papers = [];
  for (const registered of snapshot.generation.shared_nodes) {
    try {
      const note = getCurrentNote(snapshot, registered.path);
      observed.add(registered.path);
      nodes.push({ entity_id: registered.entity_id, path: registered.path, sha256: note.sha256, type: note.fm.type,
        title: note.fm.title ?? note.sections.find(row => row.anchor)?.anchor ?? registered.entity_id,
        aliases: [...new Set([...(Array.isArray(note.fm.aliases) ? note.fm.aliases : []), note.fm.knowledge_id, note.fm.canonical_key].filter(Boolean))], source_kind: note.fm.source_kind ?? null, body: note.body });
    } catch { /* The snapshot diagnostic identifies each unreadable registered node. */ }
  }
  for (const paper of snapshot.generation.papers) {
    const path = sourcePath(paper);
    let note;
    try { note = getCurrentNote(snapshot, path); } catch { continue; }
    observed.add(path);
    let bibliography = null;
    if (paper.reader_presentation) {
      const bytes = readCurrentRegisteredBytes(snapshot, paper.reader_presentation.path).bytes;
      bibliography = JSON.parse(bytes).citation?.bibliography ?? null;
    }
    const links = new Set();
    for (const otherPath of Object.values(paper.paths)) {
      try {
        const other = getCurrentNote(snapshot, otherPath);
        observed.add(otherPath);
        for (const link of linkedPaths(other.body, otherPath)) links.add(link);
      } catch { /* Keep usable source prose and the snapshot's partial diagnostic. */ }
    }
    const modules = extractPaperModules(note, path);
    const designSections = modules['2'].sections.filter(section => /design|设计/i.test(section.anchor ?? '') && /^2\.\d/.test(section.anchor));
    const fallback = modules['2'].sections.filter(section => !/research map|导图|导航|navigation/i.test(section.anchor ?? ''));
    const design = designSections.length ? designSections : fallback;
    papers.push({ paper_id: paper.paper_id, path, paths: paper.paths, sha256: note.sha256, title: note.fm.title,
      bibliography, year: bibliography?.year ?? null, modules,
      research_design: { status: design.length ? 'found' : 'not_found', sections: design },
      overview: note.sections.filter(section => /reading overview|重点概览|阅读概览/i.test(section.anchor ?? '')).map(section => ({ path, anchor: section.anchor, text: section.content, sha256: note.sha256 })),
      limitations: modules['6'], shared_nodes: nodes.filter(node => links.has(node.path.replace(/\.md$/, ''))).map(node => node.entity_id),
      referenced_by: [...(snapshot.generation.topics ?? []), ...(snapshot.generation.writing_projects ?? [])]
        .filter(row => row.dependencies?.some(dep => dep.paper_id === paper.paper_id))
        .map(row => ({ topic_id: row.topic_id, project_id: row.project_id, path: row.path })) });
  }
  papers.sort((a, b) => sort(a.paper_id, b.paper_id));
  nodes.sort((a, b) => sort(a.entity_id, b.entity_id));
  return { snapshot, papers, nodes, observed };
}

export async function libraryInventory(inputs = {}) {
  const data = await material(inputs);
  if (data.error) return data.error;
  return finish(data.snapshot, { papers: data.papers, node_count: data.nodes.length }, data.observed);
}

function landscape(data, threshold) {
  const { papers, nodes } = data;
  const usage = nodes.map(node => ({ ...node, body: undefined, paper_ids: papers.filter(paper => paper.shared_nodes.includes(node.entity_id)).map(paper => paper.paper_id) }))
    .map(node => ({ ...node, paper_count: node.paper_ids.length, idf: Math.log((papers.length + 1) / (node.paper_ids.length + 1)) + 1 }));
  const byId = new Map(usage.map(node => [node.entity_id, node]));
  const similarities = [];
  for (let i = 0; i < papers.length; i++) for (let j = i + 1; j < papers.length; j++) {
    const a = new Set(papers[i].shared_nodes), b = new Set(papers[j].shared_nodes);
    const shared = [...a].filter(id => b.has(id));
    if (!shared.length) continue;
    const union = [...new Set([...a, ...b])];
    const weighted = ids => ids.reduce((sum, id) => sum + byId.get(id).idf, 0);
    similarities.push({ paper_ids: [papers[i].paper_id, papers[j].paper_id], shared_nodes: shared, shared_weight: weighted(shared), similarity: weighted(shared) / weighted(union) });
  }
  const groups = papers.map(paper => [paper.paper_id]);
  for (const pair of similarities.filter(pair => pair.similarity >= threshold)) {
    const a = groups.find(group => group.includes(pair.paper_ids[0])), b = groups.find(group => group.includes(pair.paper_ids[1]));
    if (a !== b) { a.push(...b); groups.splice(groups.indexOf(b), 1); }
  }
  const themes = groups.map(group => {
    group.sort(sort);
    const representative = usage.filter(node => node.paper_ids.filter(id => group.includes(id)).length >= 2)
      .sort((a, b) => b.paper_ids.filter(id => group.includes(id)).length - a.paper_ids.filter(id => group.includes(id)).length || sort(a.entity_id, b.entity_id))[0];
    return { theme_id: hash(group).slice(7, 19), name: representative?.title ?? papers.find(paper => paper.paper_id === group[0]).title,
      representative_node: representative?.entity_id ?? null, paper_ids: group };
  }).sort((a, b) => sort(a.paper_ids[0], b.paper_ids[0]));
  const bridges = similarities.filter(pair => !themes.some(theme => pair.paper_ids.every(id => theme.paper_ids.includes(id))))
    .map(pair => ({ ...pair, paths: pair.shared_nodes.map(id => [pair.paper_ids[0], id, pair.paper_ids[1]]) }));
  return { papers: papers.map(({ paper_id, title, path, sha256, shared_nodes }) => ({ paper_id, title, path, sha256, shared_nodes })),
    nodes: usage, shared_nodes: usage.filter(node => node.paper_count >= 2).sort((a, b) => b.paper_count - a.paper_count || sort(a.entity_id, b.entity_id)),
    similarities, themes, bridges, isolated_methods: usage.filter(node => node.type === 'method' && node.paper_count === 1),
    grouping: { algorithm: 'idf-weighted-jaccard-connected-components', threshold }, reference_bridging: { status: 'not_available', reason: 'registered_reference_lists_absent' } };
}
export async function libraryLandscape({ threshold = 0.1, canvas = false, ...inputs } = {}) {
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) throw Object.assign(new Error('P23_MAP_THRESHOLD_INVALID'), { code: 'P23_MAP_THRESHOLD_INVALID' });
  const data = await material(inputs);
  if (data.error) return data.error;
  const result = landscape(data, threshold);
  if (canvas) result.canvas = libraryMapCanvas(result);
  return finish(data.snapshot, result, data.observed);
}
function resolveNode(nodes, value) {
  const matches = nodes.filter(node => [node.entity_id, node.path, node.title, ...node.aliases].some(alias => normal(alias) === normal(value)));
  if (matches.length > 1) throw Object.assign(new Error('P23_MAP_NODE_AMBIGUOUS'), { code: 'P23_MAP_NODE_AMBIGUOUS' });
  return matches[0];
}
export async function libraryDossier({ node: selector, ...inputs } = {}) {
  if (typeof selector !== 'string' || !selector.trim()) throw Object.assign(new Error('P23_MAP_NODE_REQUIRED'), { code: 'P23_MAP_NODE_REQUIRED' });
  const data = await material(inputs);
  if (data.error) return data.error;
  const node = resolveNode(data.nodes, selector);
  if (!node) return finish(data.snapshot, { status: 'no_matches', node: null, papers: [] }, data.observed);
  const papers = data.papers.filter(paper => paper.shared_nodes.includes(node.entity_id)).map(paper => {
    const note = getCurrentNote(data.snapshot, paper.path);
    const sections = note.sections.flatMap(section => section.content.split(/\n\s*\n/)
      .filter(paragraph => linkedPaths(paragraph, paper.path).has(node.path.replace(/\.md$/, '')))
      .map(text => ({ anchor: section.anchor, content: text })));
    return { paper_id: paper.paper_id, year: paper.year, path: paper.path, sha256: paper.sha256,
      sections: sections.map(section => ({ path: paper.path, anchor: section.anchor, text: section.content, sha256: paper.sha256 })) };
  }).sort((a, b) => (a.year ?? Infinity) - (b.year ?? Infinity) || sort(a.paper_id, b.paper_id));
  return finish(data.snapshot, { node, papers }, data.observed);
}
export async function libraryClues({ from, canvas = false, ...inputs } = {}) {
  const value = typeof from === 'string' ? from : from?.value;
  if (typeof value !== 'string' || !value.trim()) throw Object.assign(new Error('P23_MAP_FROM_REQUIRED'), { code: 'P23_MAP_FROM_REQUIRED' });
  const data = await material(inputs);
  if (data.error) return data.error;
  const node = resolveNode(data.nodes, value), needle = normal(value);
  const terms = needle.split(/[^\p{L}\p{N}-]+/u).filter(term => term && !['a', 'an', 'the', 'in', 'of', 'to', 'and', 'or', 'with', 'for', 'is', 'are', 'how', 'what'].includes(term));
  const seeds = data.papers.filter(paper => paper.paper_id === value || paper.path === value || normal(paper.title) === needle);
  const matchingNodes = node ? [node] : data.nodes.filter(row => [row.title, ...row.aliases].some(alias => terms.some(term => normal(alias).includes(term))));
  if (!node && !seeds.length && (!from?.kind || from.kind === 'question')) {
    const { queryLibrary } = await import('./library-query.mjs');
    const recalled = await queryLibrary({ vaultRoot: inputs.vaultRoot, query: value, full: true });
    if (recalled.generation_id && recalled.generation_id !== data.snapshot.generation_id) throw Object.assign(new Error('P24_GENERATION_CHANGED'), { code: 'P24_GENERATION_CHANGED' });
    const ids = new Set((recalled.results ?? []).flatMap(row => row.underlying_papers ?? [row.paper_id]));
    seeds.push(...data.papers.filter(paper => ids.has(paper.paper_id)));
  }
  const seedIds = new Set(seeds.map(paper => paper.paper_id));
  const adjacent = new Set([...matchingNodes.map(row => row.entity_id), ...seeds.flatMap(paper => paper.shared_nodes)]);
  const relevant = data.papers.filter(paper => seedIds.has(paper.paper_id) || paper.shared_nodes.some(id => adjacent.has(id)));
  const map = landscape(data, 0.1);
  const result = { from, seed_papers: [...seedIds], adjacent_nodes: data.nodes.filter(row => adjacent.has(row.entity_id)).map(({ body, ...row }) => row),
    papers: relevant.map(paper => ({ paper_id: paper.paper_id, path: paper.path, title: paper.title, sha256: paper.sha256,
      modules: Object.fromEntries(['5', '6', '7'].map(id => [id, paper.modules[id]])) })),
    bridges: map.bridges.filter(bridge => bridge.paper_ids.some(id => relevant.some(paper => paper.paper_id === id))) };
  if (!relevant.length) result.status = 'no_matches';
  if (canvas) result.canvas = libraryMapCanvas({ papers: relevant, nodes: result.adjacent_nodes });
  return finish(data.snapshot, result, data.observed);
}

/** Pure JSON Canvas output; callers choose an authorized temporary or project destination. */
export function libraryMapCanvas({ papers = [], nodes = [] } = {}) {
  const canvasNodes = [...papers.map((paper, i) => ({ id: 'p-' + paper.paper_id, type: 'file', file: paper.path, x: 0, y: i * 180, width: 300, height: 140 })),
    ...nodes.map((node, i) => ({ id: 'n-' + node.entity_id, type: 'file', file: node.path, x: 500, y: i * 180, width: 300, height: 140 }))];
  const edges = papers.flatMap(paper => (paper.shared_nodes ?? []).filter(id => nodes.some(node => node.entity_id === id))
    .map(id => ({ id: hash([paper.paper_id, id]).slice(7, 23), fromNode: 'p-' + paper.paper_id, toNode: 'n-' + id, fromSide: 'right', toSide: 'left' })));
  return { nodes: canvasNodes, edges };
}
