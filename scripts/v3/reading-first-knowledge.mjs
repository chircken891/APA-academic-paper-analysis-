import path from 'node:path';
import MarkdownIt from 'markdown-it';
import YAML from 'yaml';
import { createLibraryBm25 } from '../lib/query-terms.mjs';
import { fingerprintV3Json } from './semantic-package-validator.mjs';

const languages = ['zh-CN', 'en'];
const normalized = value => typeof value === 'string' ? value.normalize('NFC').trim().toLowerCase() : '';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const text = value => typeof value === 'string' && value.trim();
const heading = value => value.replace(/[\r\n#]/g, ' ').trim();
const knowledgeReference = /\[([^\]\r\n]+)\]\(apa-(knowledge|entity):([^)\s]+)\)/gu;

export const sharedKnowledgeKind = kind => kind === 'measure' ? 'concept' : kind;

export function registeredKnowledgeReference(registry, id, kind, visiblePath) {
  const unique = rows => rows.length === 1 ? rows[0] : undefined;
  const direct = registry.filter(row => !row.unavailable && row.entity_id === id);
  if (direct.length) return unique(direct);
  const aliases = registry.filter(row => !row.unavailable && row.registered_aliases?.includes(id));
  if (aliases.length) return unique(aliases);
  if (kind === 'knowledge') {
    const legacy = registry.filter(row => !row.unavailable && row.id === id);
    if (legacy.length > 1 && visiblePath) return unique(legacy.filter(row => (row.canonical_path ?? row.path) === visiblePath));
    if (legacy.length) return unique(legacy);
    if (visiblePath) return unique(registry.filter(row => !row.unavailable && (row.canonical_path ?? row.path) === visiblePath));
  }
}

/** Convert a published hidden state without rewriting any visible Markdown. */
export function bindPublishedKnowledgeReferences(content, { paperId, reused = false, resolveCurrent, resolveHistorical, registeredPapers, historicalSource }) {
  const unresolved = new Set();
  let originalParagraphs, candidateParagraphs;
  const next = content.replace(/<!-- KNOWLEDGE_STATE ([A-Za-z0-9+/=]+) -->/, (original, encoded) => {
    const state = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    const bind = (value, current, application) => value.replace(knowledgeReference, (match, label, kind, id) => {
      let target = (current ? resolveCurrent : resolveHistorical)(id, kind);
      if (!target && !current && kind === 'knowledge' && historicalSource) {
        originalParagraphs ??= sharedKnowledgeParagraphs(historicalSource.content);
        const additionalParagraphs = application ? () => candidateParagraphs ??= sharedKnowledgeParagraphs(content) : undefined;
        const visiblePath = historicalKnowledgePath(originalParagraphs, historicalSource.path, value, id, additionalParagraphs);
        if (visiblePath) target = resolveHistorical(id, kind, visiblePath);
      }
      if (target) return '[' + label + '](apa-entity:' + target + ')';
      unresolved.add(kind + ':' + id);
      return label;
    });
    const bindItem = (item, current, application = false) => {
      const pairs = (value, map) => Object.fromEntries(Object.entries(value).map(([language, rows]) => [language, rows.map(map)]));
      const bindParagraph = value => bind(value, current, application);
      const paragraphs = values => values.map(bindParagraph);
      if (item.paragraphs) item.paragraphs = pairs(item.paragraphs, bindParagraph);
      if (item.sections) item.sections = pairs(item.sections, section => ({ ...section, paragraphs: paragraphs(section.paragraphs) }));
      for (const formula of item.formulas ?? []) {
        for (const language of languages) if (typeof formula.description?.[language] === 'string') {
          formula.description[language] = bindParagraph(formula.description[language]);
        }
      }
    };
    bindItem(state.item, !reused);
    for (const addition of state.item.paper_additions ?? []) bindItem(addition, addition.paper_id === paperId, true);
    if (registeredPapers) state.applications = state.applications.map(({ targets, ...application }) => {
      if (!registeredPapers.has(application.paper_id)) unresolved.add('paper:' + application.paper_id);
      return application;
    });
    const output = Buffer.from(JSON.stringify(state)).toString('base64');
    return output === encoded ? original : '<!-- KNOWLEDGE_STATE ' + output + ' -->';
  });
  return { content: next, unresolved: [...unresolved].sort() };
}

export function applyReadingFirstKnowledgeContent({ presentation, views }) {
  if (presentation?.knowledge_layout !== 'shared-bilingual-1.0') return presentation;
  const result = structuredClone(presentation);
  for (const view of views ?? []) {
    if (view.knowledge_content === undefined) continue;
    if (!languages.includes(view.language) || !Array.isArray(view.knowledge_content)) fail('RF_OBSIDIAN_KNOWLEDGE_CONTENT_INVALID');
    const ids = new Set();
    for (const entry of view.knowledge_content) {
      const item = result.knowledge?.find(item => item.id === entry.id);
      if (!item || ids.has(entry.id) || Object.keys(entry).some(key => !['id', 'paragraphs', 'sections', 'application_section_ids'].includes(key)) || !Array.isArray(entry.paragraphs) || !entry.paragraphs.length || entry.paragraphs.some(value => !text(value))) fail('RF_OBSIDIAN_KNOWLEDGE_CONTENT_INVALID');
      if (entry.application_section_ids !== undefined) {
        if (item.source_kind !== 'method-background') fail('RF_OBSIDIAN_KNOWLEDGE_CONTENT_INVALID');
        assertApplicationSectionIds(item.id, entry.application_section_ids, view.sections.map(section => section.id),
          knowledgeUsedSections(item.id, view, presentation));
      }
      ids.add(entry.id);
      item.paragraphs[view.language] = structuredClone(entry.paragraphs);
      if (entry.sections !== undefined) {
        if (!Array.isArray(entry.sections) || entry.sections.some(section => !text(section.heading) || !Array.isArray(section.paragraphs) || !section.paragraphs.length || section.paragraphs.some(value => !text(value)))) fail('RF_OBSIDIAN_KNOWLEDGE_CONTENT_INVALID');
        item.sections ??= {}; item.sections[view.language] = structuredClone(entry.sections);
      }
    }
  }
  return result;
}

function knowledgeUsedSections(id, view, presentation, editor) {
  const visualIds = new Set((presentation.visuals ?? []).filter(visual => visual.chart_types?.some(type => type.knowledge_id === id)).map(visual => visual.id));
  return new Set([
    ...(editor?.languages[view.language].methods ?? []).filter(method => method.knowledge_id === id || method.knowledge_ids?.includes(id)).flatMap(method => method.section_ids),
    ...(view.placements?.knowledge ?? []).filter(placement => placement.id === id).map(placement => placement.section_id),
    ...(view.placements?.visuals ?? []).filter(placement => visualIds.has(placement.id)).map(placement => placement.section_id),
    ...view.sections.filter(section => section.paragraphs.some(paragraph => paragraph.includes(`](apa-knowledge:${id})`))).map(section => section.id),
  ]);
}

function failApplication(knowledgeId) {
  throw Object.assign(new Error('RF_OBSIDIAN_KNOWLEDGE_APPLICATION_INVALID'), {
    code: 'RF_OBSIDIAN_KNOWLEDGE_APPLICATION_INVALID',
    ...(knowledgeId ? { knowledge_id: knowledgeId } : {}),
  });
}

function assertApplicationSectionIds(knowledgeId, sections, sectionOrder, used) {
  if (!Array.isArray(sections) || !sections.length
    || sections.some((id, index) => !used.has(id) || !sectionOrder.includes(id)
      || index > 0 && sectionOrder.indexOf(id) <= sectionOrder.indexOf(sections[index - 1]))) failApplication(knowledgeId);
}

export function assertSharedKnowledgeApplicationMirror(source, translation) {
  const applications = view => (Array.isArray(view.knowledge_content) ? view.knowledge_content : [])
    .filter(item => item?.application_section_ids !== undefined)
    .map(item => [item.id, item.application_section_ids])
    .sort(([a], [b]) => String(a).localeCompare(String(b)));
  if (JSON.stringify(applications(source)) !== JSON.stringify(applications(translation))) failApplication();
}

/** Use accepted paper content to locate application details, without importing that content into a shared page. */
export function collectSharedKnowledgeApplications({ item, views, presentation, editor, expandedMethodIndex = false }) {
  const declarations = views.map(view => view.knowledge_content?.find(entry => entry.id === item.id)?.application_section_ids);
  const hasDeclaration = declarations.some(value => value !== undefined);
  const expandedEditor = views.some(view => editor?.languages[view.language].methods.some(method => text(method.explanation)));
  if (!expandedMethodIndex && !hasDeclaration && !expandedEditor) return undefined;
  const sectionOrder = views[0].sections.map(section => section.id);
  const usedSections = new Set(views.flatMap(view => [...knowledgeUsedSections(item.id, view, presentation, editor)]));
  const sections = hasDeclaration ? declarations[0] : sectionOrder.filter(id => usedSections.has(id));
  if (hasDeclaration && declarations.some(value => JSON.stringify(value) !== JSON.stringify(sections))) failApplication(item.id);
  assertApplicationSectionIds(item.id, sections, sectionOrder, usedSections);
  return sections.map(id => ({
    id,
    headings: Object.fromEntries(views.map(view => [view.language, view.sections.find(section => section.id === id).heading])),
  }));
}

const names = value => typeof value === 'string' ? [value] : Object.values(value ?? {});
const markdown = new MarkdownIt();

function knowledgeParagraph(inline) {
  const children = inline.children ?? [];
  return {
    structure: JSON.stringify(children.map(({ type, tag, markup, content }) => [type, tag, markup, content])),
    hrefs: children.filter(token => token.type === 'link_open').map(token => token.attrGet('href')),
  };
}

function sharedKnowledgeParagraphs(content) {
  const start = '<!-- AUTO:START shared-knowledge -->';
  const from = content.indexOf(start);
  const to = content.indexOf('<!-- AUTO:END shared-knowledge -->', from + start.length);
  if (from < 0 || to < 0) return [];
  const tokens = markdown.parse(content.slice(from + start.length, to), {});
  return tokens.flatMap((token, index) => token.type === 'inline' && tokens[index - 1]?.type === 'paragraph_open'
    ? [knowledgeParagraph(token)] : []);
}

function historicalKnowledgePath(paragraphs, notePath, value, id, additionalParagraphs) {
  // Match the complete paragraph and the link's position before using its registered destination.
  const hidden = knowledgeParagraph(markdown.parseInline(value, {})[0]);
  const matchesHidden = row => row.structure === hidden.structure;
  let matches = paragraphs.filter(matchesHidden);
  // A newly included application can supply its visible link when the original has no matching paragraph.
  if (!matches.length && additionalParagraphs) matches = additionalParagraphs().filter(matchesHidden);
  if (matches.length !== 1) return;
  const links = hidden.hrefs.flatMap((href, index) => href === `apa-knowledge:${id}` ? [matches[0].hrefs[index]] : []);
  if (!links.length || new Set(links).size !== 1) return;
  const file = links[0]?.split('#', 1)[0];
  if (!file || /^(?:[a-z][a-z0-9+.-]*:|\/)|[?\\]/i.test(file)) return;
  let decoded;
  try { decoded = decodeURIComponent(file); } catch { return; }
  if (/[\\?#]/.test(decoded)) return;
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(notePath), decoded));
  if (/^Wiki\/(methods|concepts)\/[^/]+\.md$/.test(target)) return target;
}

const applicationLabel = (application, language) => {
  const name = typeof application.title === 'string' ? application.title : application.title?.[language];
  return name ? `${name.replace(/[\[\]\r\n]/g, ' ')} · ${language === 'en' ? 'English' : '中文'}` : language === 'en' ? 'Paper application (English)' : '本文中的应用（中文）';
};

function applicationEntries(application, language) {
  const name = applicationLabel(application, language);
  if (!application.sections?.length) return [{ label: name, fragment: '' }];
  return application.sections.map(section => ({
    label: `${name} · ${section.headings[language].replace(/[\[\]\r\n]/g, ' ')}`,
    fragment: `#^rf-${section.id}`,
  }));
}

function renderApplicationLinks(application, target, href) {
  return languages.flatMap(language => applicationEntries(application, language).map(({ label, fragment }) => {
    const destination = application.targets?.[language];
    return destination ? `- [${label}](${href(target, destination)}${fragment})` : '- ' + label;
  }));
}

// Relocation can update visible links without rewriting the historical state.
function priorVisibleTargets(region, target, applications) {
  const tokens = markdown.parse(region, {});
  const names = ['论文应用 / Paper applications', '论文应用增补 / Additional paper applications'];
  const headings = tokens.flatMap((token, index) => token.type === 'heading_open' && token.tag === 'h2'
    && names.includes(tokens[index + 1]?.content) ? [index] : []);
  if (!headings.length) return applications;
  const links = [];
  for (const heading of headings) for (let i = heading + 3; i < tokens.length; i++) {
    if (tokens[i].type === 'heading_open' && ['h1', 'h2'].includes(tokens[i].tag)) break;
    const children = tokens[i].type === 'inline' ? tokens[i].children ?? [] : [];
    for (let j = 0; j < children.length; j++) {
      if (children[j].type !== 'link_open') continue;
      const close = children.findIndex((child, index) => index > j && child.type === 'link_close');
      if (close < 0) continue;
      const label = children.slice(j + 1, close).map(child => child.content).join('');
      const destination = children[j].attrGet('href');
      if (!destination || /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(destination) || /[?]/.test(destination)) continue;
      const [file, encodedBlock, extra] = destination.split('#');
      if (!file || extra !== undefined) continue;
      let decoded, block;
      try {
        decoded = decodeURIComponent(file);
        block = encodedBlock === undefined ? undefined : decodeURIComponent(encodedBlock);
      } catch { continue; }
      if (block !== undefined && !/^\^rf-[a-z][a-z0-9-]*$/.test(block)) continue;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(target), decoded));
      if (/^Wiki\/(sources|translations)\/[^/]+\.md$/.test(resolved)) links.push({ label, fragment: block ? '#' + block : '', target: resolved });
      j = close;
    }
  }
  return applications.map(application => {
    const targets = { ...application.targets };
    for (const language of languages) {
      const previous = application.targets?.[language];
      const inferred = applicationEntries(application, language).map(({ label, fragment }) => {
        const matches = links.filter(link => link.label === label && link.fragment === fragment
          && (!previous || path.posix.basename(link.target) === path.posix.basename(previous)));
        const owners = applications.filter(row => (!previous || path.posix.basename(row.targets?.[language] ?? '') === path.posix.basename(previous))
          && applicationEntries(row, language).some(entry => entry.label === label && entry.fragment === fragment));
        return matches.length === 1 && owners.length === 1 ? matches[0].target : undefined;
      });
      if (inferred[0] && inferred.every(path => path === inferred[0])) targets[language] = inferred[0];
    }
    return { ...application, targets };
  });
}

function matchLegacyIdentity({ item, knowledgeRegistry, vaultPath }) {
  const stableKeys = new Set([item.id, item.canonical_key].map(normalized).filter(Boolean));
  const nameKeys = new Set([...names(item.title), ...(item.aliases ?? [])].map(normalized).filter(Boolean));
  const stableMatches = knowledgeRegistry.filter(row => [row.id, row.canonical_key].some(value => stableKeys.has(normalized(value))));
  const matches = stableMatches.length ? stableMatches : knowledgeRegistry.filter(row => [...names(row.title), ...(row.aliases ?? [])].some(value => nameKeys.has(normalized(value))));
  const paths = [...new Set(matches.map(row => vaultPath(row.canonical_path ?? row.path)))];
  if (paths.length > 1) fail('RF_OBSIDIAN_KNOWLEDGE_AMBIGUOUS');
  if (matches.length && !stableMatches.length) {
    const code = 'RF_OBSIDIAN_KNOWLEDGE_IDENTITY_UNRESOLVED';
    throw Object.assign(new Error(code), { code, path: paths[0] });
  }
  return { matches, paths };
}

export const normalizeKnowledgeName = value => typeof value === 'string'
  ? value.normalize('NFKC').toLowerCase().replace(/[\p{White_Space}\p{P}]/gu, '') : '';
const knowledgeDirectory = item => `Wiki/${item.kind === 'method' ? 'methods' : 'concepts'}/`;
const eligibleRows = (item, registry) => registry.filter(row => (row.canonical_path ?? row.path)?.startsWith(knowledgeDirectory(item)));
const localNames = row => [row.title_zh, typeof row.title === 'string' ? row.title : row.title?.['zh-CN']];
const englishNames = row => [row.title_en, typeof row.title === 'string' && !/\p{Script=Han}/u.test(row.title) ? row.title : row.title?.en];

/** Stronger levels take precedence. A tie at the strongest matched level stays a draft. */
export function matchReadingFirstKnowledgeIdentity({ item, knowledgeRegistry, vaultPath = value => value, legacy = false }) {
  if (legacy) return matchLegacyIdentity({ item, knowledgeRegistry, vaultPath });
  const rows = eligibleRows(item, knowledgeRegistry);
  const exact = value => typeof value === 'string' ? value.normalize('NFC').trim() : '';
  const overlap = (left, right, normalize) => {
    const keys = new Set(left.map(normalize).filter(Boolean));
    return right.some(value => keys.has(normalize(value)));
  };
  const itemNames = [...names(item.title), ...(item.aliases ?? [])];
  const stableKeys = [item.id, item.canonical_key];
  const tiers = [
    ['stable', row => item.canonical_key && row.canonical_key
      ? normalized(item.canonical_key) === normalized(row.canonical_key)
      : overlap(stableKeys, [row.id, row.canonical_key], normalized)],
    ['exact', row => overlap(localNames(item), localNames(row), exact)],
    ['normalized', row => overlap(localNames(item), localNames(row), normalizeKnowledgeName)],
    ['english', row => overlap(englishNames(item), englishNames(row), normalizeKnowledgeName)],
    ['alias', row => overlap(itemNames, row.registered_aliases ?? [], normalizeKnowledgeName)
      || overlap([item.canonical_key ?? item.id], row.registered_aliases ?? [], normalized)],
  ];
  for (const [tier, compare] of tiers) {
    const matches = rows.filter(compare);
    const paths = [...new Set(matches.map(row => vaultPath(row.canonical_path ?? row.path)))].sort();
    if (paths.length > 1) return { tier, matches: [], paths: [], ambiguous_paths: paths };
    if (paths.length === 1) return { tier, matches, paths };
  }
  const candidates = rows.filter(row => overlap(itemNames, row.aliases ?? [], normalizeKnowledgeName)
    || overlap(item.aliases ?? [], names(row.title), normalizeKnowledgeName));
  return { matches: [], paths: [], candidate_paths: [...new Set(candidates.map(row => vaultPath(row.canonical_path ?? row.path)))].sort() };
}

const definitionsForItem = item => languages.map(language => item.paragraphs?.[language]?.[0]).filter(Boolean);
function definitionIndex(registry, item, indexes) {
  if (!indexes.has(item.kind)) {
    const rows = eligibleRows(item, registry).filter(row => !row.unavailable && Array.isArray(row.definitions) && row.definitions.length);
    const search = createLibraryBm25(rows.map(row => ({ id: row.path, content: row.definitions.join(' ') })));
    indexes.set(item.kind, search);
  }
  return indexes.get(item.kind);
}

/** Local BM25 over the registered definition paragraphs. Results only suggest comparisons. */
export function draftReadingFirstKnowledgeComparisons({ item, knowledgeRegistry, match, target, indexes = new Map() }) {
  if (match.paths.length) return [];
  const definition = definitionsForItem(item);
  const index = definitionIndex(knowledgeRegistry, item, indexes);
  const search = index.search(definition.join(' '), { combineWith: 'OR' });
  const pairs = new Map([
    ...(match.candidate_paths ?? []).map(path => [path, { reasons: ['display-alias'] }]),
    ...(match.ambiguous_paths ?? []).map(path => [path, { reasons: ['multiple-' + match.tier] }]),
  ]);
  for (const hit of search.filter(row => row.terms.filter(term => [...term].length > 1).length >= 2).slice(0, 3)) {
    const pair = pairs.get(hit.id) ?? { reasons: [] };
    pair.reasons.push('definition-bm25');
    pair.bm25_score = hit.score;
    pairs.set(hit.id, pair);
  }
  return [...pairs].map(([path, pair]) => {
    const row = knowledgeRegistry.find(row => (row.canonical_path ?? row.path) === path);
    return { status: 'draft', knowledge_id: item.id, candidate_path: target, registered_path: path,
      candidate_definition: definition, registered_definition: row?.definitions ?? [],
      ...(row?.content_sha256 ? { registered_sha256: row.content_sha256 } : {}), ...pair };
  });
}

// A confirmed existing node keeps its committed content; each paper contributes one
// replaceable addition, so a later paper cannot drop earlier text, examples or sources.
function composeKnowledgeAddition(existing, item, paperId, paperTitle) {
  const additions = (existing.paper_additions ?? []).filter(addition => addition.paper_id !== paperId);
  const sources = [...(existing.sources ?? [])];
  for (const source of item.sources ?? []) if (!sources.some(other => sameKnowledgeSource(other, source))) sources.push(source);
  const formulas = [...(existing.formulas ?? [])];
  for (const formula of item.formulas ?? []) if (!formulas.some(other => other.latex === formula.latex)) formulas.push(formula);
  const aliases = [...new Set([...(existing.aliases ?? []), ...(item.aliases ?? [])])];
  // Paragraphs a later paper merely restates from the committed text are not repeated.
  const known = Object.fromEntries(languages.map(language => [language, new Set([...(existing.paragraphs?.[language] ?? []),
    ...(existing.sections?.[language] ?? []).flatMap(section => section.paragraphs), ...additions.flatMap(addition => [...(addition.paragraphs?.[language] ?? []),
      ...(addition.sections?.[language] ?? []).flatMap(section => section.paragraphs)])].map(normalized))]));
  const fresh = (values, language) => (values ?? []).filter(value => !known[language].has(normalized(value)));
  const paragraphs = Object.fromEntries(languages.map(language => [language, fresh(item.paragraphs?.[language], language)]));
  const sections = Object.fromEntries(languages.map(language => [language, (item.sections?.[language] ?? [])
    .map(section => ({ heading: section.heading, paragraphs: fresh(section.paragraphs, language) })).filter(section => section.paragraphs.length)]));
  const added = languages.some(language => paragraphs[language].length || sections[language].length);
  return { ...existing, aliases, sources, ...(formulas.length ? { formulas } : {}),
    paper_additions: [...additions, ...(added ? [{ paper_id: paperId, title: paperTitle, paragraphs, sections }] : [])] };
}
function additionSections(addition, language) {
  const name = typeof addition.title === 'string' ? addition.title : addition.title?.[language] ?? addition.paper_id;
  const label = (language === 'en' ? 'Addition from ' : '论文增补：') + name;
  const own = addition.paragraphs?.[language] ?? [];
  return [...(own.length ? [{ heading: label, paragraphs: own }] : []),
    ...(addition.sections?.[language] ?? []).map(section => ({ heading: label + ' · ' + section.heading, paragraphs: section.paragraphs }))];
}

export function resolveSharedKnowledgeSources(item, sourcePaths) {
  if (!item.sources?.length || item.source_kind !== 'method-background') return item;
  const sources = item.sources.map(source => {
    if (source?.url !== undefined) return source;
    const sourcePath = sourcePaths.get(source?.source_id);
    const locator = source?.locator;
    if (!sourcePath || !/\.pdf$/i.test(sourcePath) || locator?.kind !== 'pdf-page'
      || !Number.isSafeInteger(locator.page) || locator.page < 1) fail('RF_OBSIDIAN_KNOWLEDGE_SOURCE_INVALID');
    // Source IDs are scoped to a paper. Shared state must retain the resolved path.
    const name = path.posix.basename(sourcePath, path.posix.extname(sourcePath));
    const title = source.title ?? source.label ?? `${name} · p. ${locator.page} / 第 ${locator.page} 页`;
    return { title, path: sourcePath, page: locator.page };
  });
  return { ...item, sources };
}

function sameKnowledgeSource(left, right) {
  return right.url !== undefined ? left.url === right.url
    : left.url === undefined && left.path === right.path && left.page === right.page;
}

function renderKnowledgeSource(source, target, href) {
  const sourceLabel = source.title ?? source.label;
  const localizedLabels = languages.map(language => sourceLabel?.[language]);
  const label = localizedLabels.every(text) ? localizedLabels.join(' / ') : sourceLabel;
  if (!text(label)) fail('RF_OBSIDIAN_KNOWLEDGE_SOURCE_INVALID');
  let destination;
  if (source.url === undefined && /\.pdf$/i.test(source.path ?? '') && Number.isSafeInteger(source.page) && source.page > 0) {
    destination = href(target, source.path) + '#page=' + source.page;
  } else {
    if (typeof source.url !== 'string' || !/^https?:\/\/[^\s<>]+$/.test(source.url)) fail('RF_OBSIDIAN_KNOWLEDGE_SOURCE_INVALID');
    destination = source.url.replace(/\(/g, '%28').replace(/\)/g, '%29');
  }
  return `- [${label.replace(/[\[\]\r\n]/g, ' ')}](${destination})`;
}

/** One generic identity produces one bilingual candidate; formal registry bytes are never mutated. */
export function renderSharedKnowledge({ item, knowledgeRegistry, paperTargets, paperId, paperTitle, vaultPath, href, resolveReferences = value => value, identityMatch, applicationSections }) {
  const match = identityMatch ?? matchReadingFirstKnowledgeIdentity({ item, knowledgeRegistry, vaultPath });
  const { matches, paths } = match;
  const directory = knowledgeDirectory(item);
  const filename = item.title['zh-CN'].normalize('NFC');
  if (!paths.length && (!text(filename) || /[\x00-\x1f\x7f<>:"/\\|?*#%\[\]^]/.test(filename) || /[. ]$/.test(filename))) fail('RF_OBSIDIAN_KNOWLEDGE_INVALID');
  const fallback = `${directory}${filename}.md`;
  const occupies = knowledgeRegistry.some(row => (row.canonical_path ?? row.path)?.normalize('NFC').toLowerCase() === fallback.toLowerCase());
  const suffix = fingerprintV3Json({ id: item.id, canonical_key: item.canonical_key ?? item.id }).slice(-12);
  const target = paths[0] ?? (occupies ? `${directory}${filename}--${suffix}.md` : fallback);
  if (!target.startsWith(directory)) fail('RF_OBSIDIAN_KNOWLEDGE_INVALID');
  const originals = [...new Set(matches.filter(row => (row.path === target || row.canonical_path === target) && row.content !== undefined).map(row => row.content))];
  if (originals.some(value => typeof value !== 'string') || originals.length > 1) fail('RF_OBSIDIAN_KNOWLEDGE_AMBIGUOUS');
  if (paths.length && !originals.length) fail('RF_OBSIDIAN_KNOWLEDGE_CONTENT_REQUIRED');
  const original = originals[0];
  const region = 'shared-knowledge';
  const start = `<!-- AUTO:START ${region} -->`, end = `<!-- AUTO:END ${region} -->`;
  const from = original?.indexOf(start) ?? -1, to = original?.indexOf(end) ?? -1;
  if ((from < 0) !== (to < 0) || (from >= 0 && (to < from || original.indexOf(start, from + start.length) >= 0 || original.indexOf(end, to + end.length) >= 0))) fail('RF_OBSIDIAN_KNOWLEDGE_REGION_INVALID');
  let prior;
  if (from >= 0) {
    const state = original.slice(from, to).match(/<!-- KNOWLEDGE_STATE ([A-Za-z0-9+/=]+) -->/);
    try { prior = JSON.parse(Buffer.from(state?.[1] ?? '', 'base64').toString('utf8')); } catch { fail('RF_OBSIDIAN_KNOWLEDGE_REGION_INVALID'); }
    if (!prior?.item || !Array.isArray(prior.applications)) fail('RF_OBSIDIAN_KNOWLEDGE_REGION_INVALID');
  }
  const previousApplications = prior ? priorVisibleTargets(original.slice(from, to), target, prior.applications) : [];
  const application = { paper_id: paperId, targets: paperTargets, title: paperTitle, ...(applicationSections ? { sections: applicationSections } : {}) };
  const applications = [...new Map([...previousApplications, application].map(row => [row.paper_id, row])).values()];
  const node = prior ? composeKnowledgeAddition(prior.item, item, paperId, paperTitle) : item;
  const preserveCurrent = from >= 0 && matches.some(row => row.current_content === true);
  let body = ['[中文](#%E4%B8%AD%E6%96%87)', '[English](#English)', ...(node.formulas?.length ? ['[公式 / Formulas](#%E5%85%AC%E5%BC%8F%20/%20Formulas)'] : []), ...(node.sources?.length ? ['[来源 / Sources](#%E6%9D%A5%E6%BA%90%20/%20Sources)'] : [])].join(' · ') + '\n\n';
  for (const language of languages) {
    // When preserving the current note, only the appended sections below need link resolution.
    const paragraphs = values => (preserveCurrent ? values : values.map(value => resolveReferences(value, language, target))).join('\n\n');
    body += `## ${language === 'en' ? 'English' : '中文'}\n\n` + paragraphs(node.paragraphs[language]) + '\n\n';
    const sections = [...(node.sections?.[language] ?? []), ...(node.paper_additions ?? []).flatMap(addition => additionSections(addition, language))];
    if (!Array.isArray(sections)) fail('RF_OBSIDIAN_KNOWLEDGE_INVALID');
    for (const section of sections) {
      if (!text(section.heading) || !Array.isArray(section.paragraphs) || !section.paragraphs.length || section.paragraphs.some(value => !text(value))) fail('RF_OBSIDIAN_KNOWLEDGE_INVALID');
      body += `### ${heading(section.heading)}\n\n${paragraphs(section.paragraphs)}\n\n`;
    }
  }
  if (node.formulas?.length) body += '## 公式 / Formulas\n\n';
  for (const formula of node.formulas ?? []) {
    if (!text(formula.latex) || !languages.every(language => text(formula.description?.[language]))) fail('RF_OBSIDIAN_KNOWLEDGE_INVALID');
    body += `$$\n${formula.latex}\n$$\n\n${formula.description['zh-CN']} / ${formula.description.en}\n\n`;
  }
  if (node.sources?.length) body += '## 来源 / Sources\n\n';
  for (const source of node.sources ?? []) {
    body += `${renderKnowledgeSource(source, target, href)}\n`;
  }
  body += '\n## 论文应用 / Paper applications\n\n' + applications.flatMap(row => renderApplicationLinks(row, target, href)).join('\n') + '\n';
  const state = Buffer.from(JSON.stringify({ item: node, applications })).toString('base64');
  const addition = `${start}\n<!-- KNOWLEDGE_STATE ${state} -->\n${body}${end}\n`;
  let content;
  if (preserveCurrent) {
    // Keep every visible byte from the current node, including edits inside the managed region.
    const oldRegion = original.slice(from, to);
    const newItem = node.paper_additions?.find(row => row.paper_id === paperId);
    let appended = '';
    if (newItem) for (const language of languages) for (const section of additionSections(newItem, language)) {
      appended += `\n### ${heading(section.heading)}\n\n${section.paragraphs.map(value => resolveReferences(value, language, target)).join('\n\n')}\n`;
    }
    for (const formula of node.formulas ?? []) if (!(prior.item.formulas ?? []).some(old => old.latex === formula.latex)) {
      appended += `\n$$\n${formula.latex}\n$$\n\n${formula.description['zh-CN']} / ${formula.description.en}\n`;
    }
    for (const source of node.sources ?? []) if (!(prior.item.sources ?? []).some(old => sameKnowledgeSource(old, source))) {
      appended += `\n${renderKnowledgeSource(source, target, href)}\n`;
    }
    if (!previousApplications.some(row => row.paper_id === paperId)) {
      appended += '\n## 论文应用增补 / Additional paper applications\n\n' + renderApplicationLinks(application, target, href).join('\n') + '\n';
    }
    const updatedRegion = oldRegion.replace(/<!-- KNOWLEDGE_STATE [A-Za-z0-9+/=]+ -->/, `<!-- KNOWLEDGE_STATE ${state} -->`);
    content = original.slice(0, from) + updatedRegion + appended + original.slice(to);
  } else if (original !== undefined) {
    content = from < 0 ? original + (original.endsWith('\n') ? '\n' : '\n\n') + addition : original.slice(0, from) + addition.trimEnd() + original.slice(to + end.length);
  } else {
    const aliases = [...new Set([...names(item.title), ...(item.aliases ?? [])])];
    const properties = { type: item.kind, pipeline_version: '3.0', status: 'candidate', graph_scope: 'v3-candidate', language: 'multilingual', knowledge_id: item.id, canonical_key: item.canonical_key ?? item.id, aliases, source_kind: item.source_kind };
    content = `---\n${YAML.stringify(properties).trimEnd()}\n---\n# ${heading(item.title['zh-CN'])} / ${heading(item.title.en)}\n\n${addition}`;
  }
  const entry = { id: item.id, languages, path: target, source_kind: item.source_kind, content, bytes: Buffer.from(content) };
  return { note: entry, proposal: paths.length ? { id: item.id, path: target, languages, action: 'proposed-addition', canonical_key: item.canonical_key ?? item.id } : undefined };
}

/** Extract state rather than rendered links; the registry determines creation mode. */
export function extractOwnKnowledge({ content, paperId, item, mode }) {
  let node;
  try {
    const encoded = content.match(/<!-- KNOWLEDGE_STATE ([A-Za-z0-9+/=]+) -->/)?.[1];
    node = JSON.parse(Buffer.from(encoded ?? '', 'base64').toString('utf8')).item;
  } catch { fail('RF_OBSIDIAN_KNOWLEDGE_REGION_INVALID'); }
  if (!node || !['created', 'reused'].includes(mode)) fail('RF_OBSIDIAN_KNOWLEDGE_REGION_INVALID');
  if (mode === 'created' && (node.id !== item.id || (node.paper_additions ?? []).some(row => row.paper_id !== paperId))) fail('RF_OBSIDIAN_KNOWLEDGE_REGION_INVALID');
  const own = mode === 'created' ? node : node.paper_additions?.find(row => row.paper_id === paperId) ?? {};
  const metadata = mode === 'created' ? node : item;
  return {
    mode,
    paragraphs: Object.fromEntries(languages.map(language => [language, structuredClone(own.paragraphs?.[language] ?? [])])),
    sections: Object.fromEntries(languages.map(language => [language, structuredClone(own.sections?.[language] ?? [])])),
    formulas: structuredClone(metadata.formulas ?? []),
    sources: structuredClone(metadata.sources ?? []),
    aliases: structuredClone(metadata.aliases ?? []),
    node: structuredClone(node)
  };
}

/** A rebase may drop paragraphs already in the new base or restore old-base duplicates on a new page. */
export function compareOwnKnowledge({ original, rebased, existing, originalExisting, path }) {
  const missing = [];
  const dropped = [];
  const base = existing?.node ?? existing?.item ?? existing ?? {};
  const node = rebased.node;
  for (const language of languages) {
    const knownParagraphs = value => new Set([...(value.paragraphs?.[language] ?? []),
      ...(value.sections?.[language] ?? []).flatMap(section => section.paragraphs),
      ...(value.paper_additions ?? []).flatMap(addition => [...(addition.paragraphs?.[language] ?? []),
        ...(addition.sections?.[language] ?? []).flatMap(section => section.paragraphs)])].map(normalized));
    const known = knownParagraphs(base), prior = knownParagraphs(originalExisting?.node ?? {});
    const groups = value => [{ heading: null, paragraphs: value.paragraphs?.[language] ?? [] }, ...(value.sections?.[language] ?? [])];
    const before = groups(original), after = groups(rebased);
    for (const group of before) for (const paragraph of group.paragraphs) {
      if (after.some(other => other.heading === group.heading && other.paragraphs.some(value => normalized(value) === normalized(paragraph)))) continue;
      if (known.has(normalized(paragraph))) dropped.push({ language, section: group.heading, paragraph });
      else missing.push({ kind: group.heading === null ? 'paragraph' : 'section', language, section: group.heading, paragraph });
    }
    for (const group of after) for (const paragraph of group.paragraphs) {
      if (!prior.has(normalized(paragraph)) && !before.some(other => other.heading === group.heading && other.paragraphs.some(value => normalized(value) === normalized(paragraph)))) missing.push({ kind: 'unexpected_paragraph', language, section: group.heading, paragraph });
    }
  }
  for (const formula of original.formulas) {
    const found = node.formulas?.find(value => value.latex === formula.latex);
    if (!found || languages.some(language => found.description?.[language] !== formula.description?.[language])) missing.push({ kind: 'formula', latex: formula.latex });
  }
  for (const source of original.sources) {
    if (node.sources?.some(value => sameKnowledgeSource(value, source))) continue;
    missing.push({ kind: 'source', ...(source.url === undefined ? { path: source.path, page: source.page } : { url: source.url }) });
  }
  for (const alias of original.aliases) if (!node.aliases?.includes(alias)) missing.push({ kind: 'alias', alias });
  if (missing.length) throw Object.assign(new Error('RF_REBASE_OWN_KNOWLEDGE_CHANGED'), { code: 'RF_REBASE_OWN_KNOWLEDGE_CHANGED', details: { path, mode_before: original.mode, mode_after: rebased.mode, missing } });
  return { dropped_paragraphs: dropped };
}
