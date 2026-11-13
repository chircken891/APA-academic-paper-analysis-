import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Deterministic annotation coverage for rendered reading notes: chart-type lines and their panel coverage,
// panel-level citations in the findings module, and method/concept cards that name a registered node without linking it.
// Read-only. It reports candidates; deciding a chart type, a citation or a link stays a scientific/editorial judgment.

const LABEL = /^(扩展数据图|补充图|图|表|Extended Data Fig(?:ure)?\.?|Supplementary Fig(?:ure)?\.?|Figure|Fig\.?|Table)\s?(S?\d+)/u;
const FINDINGS_HEADING = { en: /^## \d+\. (?:Key findings|Findings)\s*$/u, 'zh-CN': /^## \d+\. 主要发现\s*$/u };
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

function expand(first, last) {
  const from = LETTERS.indexOf(first.toLowerCase()), to = LETTERS.indexOf((last ?? first).toLowerCase());
  return from < 0 || to < from || to - from > 20 ? [first.toLowerCase()] : [...LETTERS.slice(from, to + 1)];
}

/** Panel letters a caption names, e.g. "a, ...; b–d, ...", "(a) ..." or "（A）...". */
export function captionPanels(caption) {
  const found = new Set();
  const listed = /(?:^|[。；;.:|｜]\s*)([a-zA-Z])(?:\s*[–—-]\s*([a-zA-Z]))?\s*[，,、]/gu;
  const bracketed = /(?<![A-Za-z\p{N}_}])[(（]([a-zA-Z])(?:\s*[–—-]\s*([a-zA-Z]))?[)）]/gu;
  for (const pattern of [listed, bracketed]) for (const match of caption.matchAll(pattern)) for (const letter of expand(match[1], match[2])) found.add(letter);
  return found;
}

/** Panels named by a chart-type line; `all` when one entry applies to every panel, `unpanelled` when entries carry no panel. */
export function chartTypePanels(line) {
  const body = line.replace(/^\*\*(?:图型|Chart type)\*\*\s*[:：]\s*/u, '');
  if (/^(?:各面板|Each panel)\s*[:：]/u.test(body)) return { all: true, panels: new Set(), unpanelled: false };
  const panels = new Set();
  let unpanelled = false;
  for (const segment of body.split(' · ')) {
    const prefix = /^([^[\]]*?)\s*[:：]\s*\S/u.exec(segment)?.[1];
    if (!prefix) { unpanelled = true; continue; }
    for (const part of prefix.split(/[,，、\s]+/u).filter(Boolean)) {
      const range = /^\(?([a-zA-Z])\)?(?:\s*[–—-]\s*\(?([a-zA-Z])\)?)?$/u.exec(part);
      if (range) for (const letter of expand(range[1], range[2])) panels.add(letter);
    }
  }
  return { all: false, panels, unpanelled };
}

const normalize = value => value.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function panelReference(label) {
  const match = LABEL.exec(label);
  if (!match) return null;
  const [, kind, number] = match;
  const english = /^[A-Z]/u.test(kind);
  const base = english ? kind.replace(/ure\.?$|\.$/u, '') : kind;
  const head = english ? (base.startsWith('Extended') ? 'Extended Data Fig(?:ure)?\\.?' : base.startsWith('Supplementary') ? 'Supplementary Fig(?:ure)?\\.?' : base === 'Table' ? 'Table' : 'Fig(?:ure)?\\.?') : escape(kind);
  const guard = english ? (base.startsWith('Extended') || base.startsWith('Supplementary') ? '' : '(?<!Extended Data |Supplementary )') : (kind === '图' ? '(?<!扩展数据|补充)' : '');
  return new RegExp(`${guard}${head}\\s?${escape(number)}(?![0-9])\\s?[a-zA-Z](?![a-zA-Z])`, 'u');
}

function croppedPanel(label) {
  const match = LABEL.exec(label);
  return match ? /^([a-zA-Z])(?![a-zA-Z])/u.exec(label.slice(match[0].length))?.[1].toLowerCase() ?? null : null;
}

/** Parse one rendered note into visual blocks, the findings text and catalogue cards. */
export function parseReadingNote(markdown, language) {
  const lines = markdown.split(/\r?\n/u);
  const visuals = [], cards = [];
  let module = null, findings = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^## /u.test(line)) module = FINDINGS_HEADING[language].test(line) ? 'findings' : 'other';
    const anchor = /\^rf-visual-([A-Za-z0-9_-]+)\s*$/u.exec(line);
    if (anchor && line.startsWith('**')) {
      const label = /^\*\*(.+?)\*\*/u.exec(line)?.[1] ?? '';
      const short = label.split(' · ')[0].trim();
      const visual = { id: anchor[1], label: short, kind: /^(?:表|Table)/u.test(short) ? 'table' : /^(?:公式|Formula|Equation)/u.test(short) ? 'formula' : 'figure', title: label, module, line: index + 1, chart_type: null, caption: '' };
      for (let next = index + 1; next < lines.length && next <= index + 40; next++) {
        if (/^\*\*.*\^rf-visual-[A-Za-z0-9_-]+\s*$/u.test(lines[next]) || /^#{2,4} /u.test(lines[next])) break;
        if (/^\*\*(?:图型|Chart type)\*\*/u.test(lines[next])) visual.chart_type = lines[next];
        if (/^> \[!quote\]/u.test(lines[next])) visual.caption = lines[next + 1]?.replace(/^>\s?/u, '').replace(/^\*\*[^*]+\*\*\s*/u, '') ?? '';
      }
      // Earlier layouts put the anchor on the caption line below a "#### Figure N" heading and the chart-type line.
      let above = index - 1;
      while (above > 0 && !lines[above].trim()) above--;
      for (let previous = above; !visual.chart_type && /^!\[/u.test(lines[above] ?? '') && previous >= 0 && index - previous <= 12; previous--) {
        if (/\^rf-visual-|^>/u.test(lines[previous])) break;
        if (/^\*\*(?:图型|Chart type)\*\*/u.test(lines[previous])) visual.chart_type = lines[previous];
        if (/^#{2,4} /u.test(lines[previous])) break;
      }
      visuals.push(visual);
      continue;
    }
    const card = /^> \[!info\][-+]?\s+(.+)$/u.exec(line);
    if (card) {
      let linked = false;
      for (let next = index + 1; next < lines.length && lines[next].startsWith('>'); next++) if (/\]\(\.\.\/(?:methods|concepts)\//u.test(lines[next])) linked = true;
      cards.push({ title: card[1].trim(), line: index + 1, linked });
      continue;
    }
    if (module === 'findings' && !line.startsWith('>') && !/^\*\*(?:图型|Chart type)\*\*/u.test(line) && !line.startsWith('![')) findings.push(line);
  }
  return { visuals, cards, findings: findings.join('\n') };
}

/** Registered node names for reverse lookup: title, aliases and registered alias entries. */
export function loadRegisteredNodes({ vaultRoot, generation }) {
  const nodes = [];
  for (const { path } of generation.shared_nodes) {
    let text;
    try { text = readFileSync(join(vaultRoot, path), 'utf8'); } catch { continue; }
    const names = new Set();
    const title = /^# (.+)$/mu.exec(text)?.[1];
    if (title) for (const part of title.split(' / ')) names.add(part.trim());
    const front = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text)?.[1] ?? '';
    const aliases = /^aliases:\s*\r?\n((?:\s+-\s.*\r?\n?)+)/mu.exec(front)?.[1] ?? '';
    for (const alias of aliases.matchAll(/^\s+-\s+"?(.+?)"?\s*$/gmu)) names.add(alias[1]);
    nodes.push({ path, names: [...names].filter(Boolean) });
  }
  return nodes;
}

function nodeCandidates(title, nodes) {
  const key = normalize(title);
  if (!key) return [];
  const exact = nodes.filter(node => node.names.some(name => normalize(name) === key));
  if (exact.length) return exact.map(node => ({ path: node.path, match: 'exact' }));
  return nodes.filter(node => node.names.some(name => { const other = normalize(name); return other.length >= 4 && (key.includes(other) || other.includes(key) && key.length >= 4); }))
    .map(node => ({ path: node.path, match: 'contains' }));
}

/** Check one rendered note. `nodes` comes from loadRegisteredNodes or a candidate's knowledge catalogue. */
export function checkReadingNote(markdown, { language, nodes = [] } = {}) {
  if (!FINDINGS_HEADING[language]) throw Object.assign(new Error('READING_ANNOTATION_LANGUAGE_INVALID'), { code: 'READING_ANNOTATION_LANGUAGE_INVALID' });
  const { visuals, cards, findings } = parseReadingNote(markdown, language);
  const report = { missing_chart_type: [], uncovered_panels: [], findings_without_panel_citation: [], unlinked_cards: [] };
  const cited = new Set();
  for (const visual of visuals) {
    // Table captions letter their footnotes, so panel checks apply to figures; a visual cropped to one panel ("Figure 4b") covers only that panel.
    const cropped = croppedPanel(visual.label);
    const panels = visual.kind !== 'figure' ? new Set() : cropped ? new Set([cropped]) : captionPanels(visual.caption);
    const where = { id: visual.id, label: visual.label, kind: visual.kind, line: visual.line, caption_panels: [...panels].sort() };
    if (!visual.chart_type && visual.kind !== 'formula') report.missing_chart_type.push(where);
    else if (panels.size >= 2) {
      const named = chartTypePanels(visual.chart_type);
      const missing = named.all ? [] : [...panels].filter(letter => !named.panels.has(letter)).sort();
      if (missing.length) report.uncovered_panels.push({ ...where, missing, unpanelled: named.unpanelled && !named.panels.size });
    }
    if (visual.module === 'findings' && panels.size >= 3 && !cited.has(visual.label)) {
      const pattern = panelReference(visual.label);
      const anchoredPanel = new RegExp(`\\[([^\\]]+)\\]\\(#\\^rf-visual-${escape(visual.id)}\\)([a-zA-Z]?)`, 'gu');
      const hasAnchoredPanel = [...findings.matchAll(anchoredPanel)].some(match => /\d+\s?[a-zA-Z](?![a-zA-Z])/u.test(match[1] + match[2]));
      if ((!pattern || !pattern.test(findings)) && !hasAnchoredPanel) report.findings_without_panel_citation.push(where);
      cited.add(visual.label);
    }
  }
  for (const card of cards) {
    if (card.linked) continue;
    const candidates = nodeCandidates(card.title, nodes);
    if (candidates.length) report.unlinked_cards.push({ title: card.title, line: card.line, candidates });
  }
  return report;
}

/** Check every registered paper note in the committed generation. */
export async function checkRegisteredNotes({ vaultRoot }) {
  const { readRegisteredCommit } = await import('./phase22-active-version.mjs');
  const snapshot = await readRegisteredCommit({ vaultRoot });
  if (!snapshot.ok) throw Object.assign(new Error(snapshot.errors?.[0]?.code ?? 'P22_GENERATION_UNREADABLE'), { code: snapshot.errors?.[0]?.code });
  const nodes = loadRegisteredNodes({ vaultRoot, generation: snapshot.generation });
  const notes = [];
  for (const object of snapshot.generation.objects.filter(row => row.kind === 'v3-note')) {
    const language = /\.zh-CN\.md$/u.test(object.path) ? 'zh-CN' : 'en';
    const report = checkReadingNote(readFileSync(join(vaultRoot, object.path), 'utf8'), { language, nodes });
    notes.push({ path: object.path, language, ...report });
  }
  const count = key => notes.reduce((total, note) => total + note[key].length, 0);
  return { generation_id: snapshot.generation_id, summary: Object.fromEntries(['missing_chart_type', 'uncovered_panels', 'findings_without_panel_citation', 'unlinked_cards'].map(key => [key, count(key)])), notes };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--root');
  const vaultRoot = resolve(index > -1 ? process.argv[index + 1] : process.cwd());
  checkRegisteredNotes({ vaultRoot }).then(result => process.stdout.write(JSON.stringify(result, null, 2) + '\n'), error => { console.error(error.code ?? error.message); process.exitCode = 1; });
}
