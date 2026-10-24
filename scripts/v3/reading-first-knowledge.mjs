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
  const applications = [...new Map([...(prior?.applications ?? []), { paper_id: paperId, targets: paperTargets, title: paperTitle }].map(row => [row.paper_id, row])).values()];
  let body = ['[中文](#%E4%B8%AD%E6%96%87)', '[English](#English)', ...(item.formulas?.length ? ['[公式 / Formulas](#%E5%85%AC%E5%BC%8F%20/%20Formulas)'] : []), ...(item.sources?.length ? ['[来源 / Sources](#%E6%9D%A5%E6%BA%90%20/%20Sources)'] : [])].join(' · ') + '\n\n';
  for (const language of languages) {
    const paragraphs = values => values.map(value => resolveReferences(value, language, target)).join('\n\n');
    body += `## ${language === 'en' ? 'English' : '中文'}\n\n` + paragraphs(item.paragraphs[language]) + '\n\n';
    const sections = item.sections?.[language] ?? [];
    if (!Array.isArray(sections)) fail('RF_OBSIDIAN_KNOWLEDGE_INVALID');
    for (const section of sections) {
      if (!text(section.heading) || !Array.isArray(section.paragraphs) || !section.paragraphs.length || section.paragraphs.some(value => !text(value))) fail('RF_OBSIDIAN_KNOWLEDGE_INVALID');
      body += `### ${heading(section.heading)}\n\n${paragraphs(section.paragraphs)}\n\n`;
    }
  }
  if (item.formulas?.length) body += '## 公式 / Formulas\n\n';
  for (const formula of item.formulas ?? []) {
    if (!text(formula.latex) || !languages.every(language => text(formula.description?.[language]))) fail('RF_OBSIDIAN_KNOWLEDGE_INVALID');
    body += `$$\n${formula.latex}\n$$\n\n${formula.description['zh-CN']} / ${formula.description.en}\n\n`;
  }
  if (item.sources?.length) body += '## 来源 / Sources\n\n';
  for (const source of item.sources ?? []) {
    if (!text(source.title) || !/^https?:\/\/[^\s<>]+$/.test(source.url ?? '')) fail('RF_OBSIDIAN_KNOWLEDGE_SOURCE_INVALID');
    body += `- [${source.title.replace(/[\[\]\r\n]/g, ' ')}](${source.url.replace(/\(/g, '%28').replace(/\)/g, '%29')})\n`;
  }
  body += '\n## 论文应用 / Paper applications\n\n' + applications.flatMap(application => languages.map(language => {
    const name = typeof application.title === 'string' ? application.title : application.title?.[language];
    const label = name ? `${name.replace(/[\[\]\r\n]/g, ' ')} · ${language === 'en' ? 'English' : '中文'}` : language === 'en' ? 'Paper application (English)' : '本文中的应用（中文）';
    return `- [${label}](${href(target, application.targets[language])})`;
  })).join('\n') + '\n';
  const state = Buffer.from(JSON.stringify({ item, applications })).toString('base64');
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
