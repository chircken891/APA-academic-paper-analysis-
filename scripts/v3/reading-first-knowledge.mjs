import path from 'node:path';
import MarkdownIt from 'markdown-it';
import YAML from 'yaml';

const languages = ['zh-CN', 'en'];
const normalized = value => typeof value === 'string' ? value.normalize('NFC').trim().toLowerCase() : '';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const text = value => typeof value === 'string' && value.trim();
const heading = value => value.replace(/[\r\n#]/g, ' ').trim();

export function applyReadingFirstKnowledgeContent({ presentation, views }) {
  if (presentation?.knowledge_layout !== 'shared-bilingual-1.0') return presentation;
  const result = structuredClone(presentation);
  for (const view of views ?? []) {
    if (view.knowledge_content === undefined) continue;
    if (!languages.includes(view.language) || !Array.isArray(view.knowledge_content)) fail('RF_OBSIDIAN_KNOWLEDGE_CONTENT_INVALID');
    const ids = new Set();
    for (const entry of view.knowledge_content) {
      const item = result.knowledge?.find(item => item.id === entry.id);
      if (!item || ids.has(entry.id) || Object.keys(entry).some(key => !['id', 'paragraphs', 'sections'].includes(key)) || !Array.isArray(entry.paragraphs) || !entry.paragraphs.length || entry.paragraphs.some(value => !text(value))) fail('RF_OBSIDIAN_KNOWLEDGE_CONTENT_INVALID');
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

const names = value => typeof value === 'string' ? [value] : Object.values(value ?? {});
const markdown = new MarkdownIt();
const applicationLabel = (application, language) => {
  const name = typeof application.title === 'string' ? application.title : application.title?.[language];
  return name ? `${name.replace(/[\[\]\r\n]/g, ' ')} · ${language === 'en' ? 'English' : '中文'}` : language === 'en' ? 'Paper application (English)' : '本文中的应用（中文）';
};

// Relocation can update visible links without rewriting the historical state.
function priorVisibleTargets(region, target, applications) {
  const tokens = markdown.parse(region, {});
  const headings = tokens.flatMap((token, index) => token.type === 'heading_open' && token.tag === 'h2' && tokens[index + 1]?.content === '论文应用 / Paper applications' ? [index] : []);
  if (headings.length !== 1) return applications;
  const links = [];
  for (let i = headings[0] + 3; i < tokens.length; i++) {
    if (tokens[i].type === 'heading_open' && ['h1', 'h2'].includes(tokens[i].tag)) break;
    const children = tokens[i].type === 'inline' ? tokens[i].children ?? [] : [];
    for (let j = 0; j < children.length; j++) {
      if (children[j].type !== 'link_open') continue;
      const close = children.findIndex((child, index) => index > j && child.type === 'link_close');
      if (close < 0) continue;
      const label = children.slice(j + 1, close).map(child => child.content).join('');
      const destination = children[j].attrGet('href');
      if (!destination || /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(destination) || /[?#]/.test(destination)) continue;
      let decoded;
      try { decoded = decodeURIComponent(destination); } catch { continue; }
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(target), decoded));
      if (/^Wiki\/(sources|translations)\/[^/]+\.md$/.test(resolved)) links.push({ label, target: resolved });
      j = close;
    }
  }
  return applications.map(application => {
    const targets = { ...application.targets };
    for (const language of languages) {
      const previous = application.targets?.[language];
      if (typeof previous !== 'string') continue;
      const label = applicationLabel(application, language);
      const matches = links.filter(link => link.label === label && path.posix.basename(link.target) === path.posix.basename(previous));
      const owners = applications.filter(row => applicationLabel(row, language) === label && path.posix.basename(row.targets?.[language] ?? '') === path.posix.basename(previous));
      if (matches.length === 1 && owners.length === 1) targets[language] = matches[0].target;
    }
    return { ...application, targets };
  });
}

/** Names discover candidates; only registry identity keys confirm a reusable path. */
export function matchReadingFirstKnowledgeIdentity({ item, knowledgeRegistry, vaultPath }) {
  const stableKeys = new Set([item.id, item.canonical_key].map(normalized).filter(Boolean));
  const nameKeys = new Set([...names(item.title), ...(item.aliases ?? [])].map(normalized).filter(Boolean));
  const stableMatches = knowledgeRegistry.filter(row => [row.id, row.canonical_key].some(value => stableKeys.has(normalized(value))));
  const matches = stableMatches.length ? stableMatches : knowledgeRegistry.filter(row => [...names(row.title), ...(row.aliases ?? [])].some(value => nameKeys.has(normalized(value))));
  const paths = [...new Set(matches.map(row => vaultPath(row.canonical_path ?? row.path)))];
  if (paths.length > 1) fail('RF_OBSIDIAN_KNOWLEDGE_AMBIGUOUS');
  if (matches.length && !stableMatches.length) fail('RF_OBSIDIAN_KNOWLEDGE_IDENTITY_UNRESOLVED');
  return { matches, paths };
}

// A confirmed existing node keeps its committed content; each paper contributes one
// replaceable addition, so a later paper cannot drop earlier text, examples or sources.
function composeKnowledgeAddition(existing, item, paperId, paperTitle) {
  const additions = (existing.paper_additions ?? []).filter(addition => addition.paper_id !== paperId);
  const sources = [...(existing.sources ?? [])];
  for (const source of item.sources ?? []) if (!sources.some(other => other.url === source.url)) sources.push(source);
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

/** One generic identity produces one bilingual candidate; formal registry bytes are never mutated. */
export function renderSharedKnowledge({ item, knowledgeRegistry, paperTargets, paperId, paperTitle, vaultPath, href, resolveReferences = value => value }) {
  const { matches, paths } = matchReadingFirstKnowledgeIdentity({ item, knowledgeRegistry, vaultPath });
  const directory = `Wiki/${item.kind === 'method' ? 'methods' : 'concepts'}/`;
  const filename = item.title['zh-CN'].normalize('NFC');
  if (!paths.length && (!text(filename) || /[\x00-\x1f\x7f<>:"/\\|?*#%\[\]^]/.test(filename) || /[. ]$/.test(filename))) fail('RF_OBSIDIAN_KNOWLEDGE_INVALID');
  const target = paths[0] ?? `${directory}${filename}.md`;
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
  const applications = [...new Map([...previousApplications, { paper_id: paperId, targets: paperTargets, title: paperTitle }].map(row => [row.paper_id, row])).values()];
  const node = prior ? composeKnowledgeAddition(prior.item, item, paperId, paperTitle) : item;
  let body = ['[中文](#%E4%B8%AD%E6%96%87)', '[English](#English)', ...(node.formulas?.length ? ['[公式 / Formulas](#%E5%85%AC%E5%BC%8F%20/%20Formulas)'] : []), ...(node.sources?.length ? ['[来源 / Sources](#%E6%9D%A5%E6%BA%90%20/%20Sources)'] : [])].join(' · ') + '\n\n';
  for (const language of languages) {
    const paragraphs = values => values.map(value => resolveReferences(value, language, target)).join('\n\n');
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
    if (!text(source.title) || !/^https?:\/\/[^\s<>]+$/.test(source.url ?? '')) fail('RF_OBSIDIAN_KNOWLEDGE_SOURCE_INVALID');
    body += `- [${source.title.replace(/[\[\]\r\n]/g, ' ')}](${source.url.replace(/\(/g, '%28').replace(/\)/g, '%29')})\n`;
  }
  body += '\n## 论文应用 / Paper applications\n\n' + applications.flatMap(application => languages.map(language => {
    return `- [${applicationLabel(application, language)}](${href(target, application.targets[language])})`;
  })).join('\n') + '\n';
  const state = Buffer.from(JSON.stringify({ item: node, applications })).toString('base64');
  const addition = `${start}\n<!-- KNOWLEDGE_STATE ${state} -->\n${body}${end}\n`;
  let content;
  if (original !== undefined) {
    content = from < 0 ? original + (original.endsWith('\n') ? '\n' : '\n\n') + addition : original.slice(0, from) + addition.trimEnd() + original.slice(to + end.length);
  } else {
    const aliases = [...new Set([...names(item.title), ...(item.aliases ?? [])])];
    const properties = { type: item.kind, pipeline_version: '3.0', status: 'candidate', graph_scope: 'v3-candidate', language: 'multilingual', knowledge_id: item.id, canonical_key: item.canonical_key ?? item.id, aliases, source_kind: item.source_kind };
    content = `---\n${YAML.stringify(properties).trimEnd()}\n---\n# ${heading(item.title['zh-CN'])} / ${heading(item.title.en)}\n\n${addition}`;
  }
  const entry = { id: item.id, languages, path: target, source_kind: item.source_kind, content, bytes: Buffer.from(content) };
  return { note: entry, proposal: paths.length ? { id: item.id, path: target, languages, action: 'proposed-addition', canonical_key: item.canonical_key ?? item.id } : undefined };
}
