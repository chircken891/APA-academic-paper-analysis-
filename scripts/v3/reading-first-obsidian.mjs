import path from 'node:path';
import YAML from 'yaml';
import { validateReadingFirstEditor } from './reading-first-editor.mjs';
import { fingerprintV3Json } from './semantic-package-validator.mjs';
import { registerReaderTargets } from './phase221-targets.mjs';
import { mergeManagedNote } from './phase22-managed-markdown.mjs';
import { applyReadingFirstKnowledgeContent, matchReadingFirstKnowledgeIdentity, renderSharedKnowledge } from './reading-first-knowledge.mjs';

const languages = ['en', 'zh-CN'];
export const READING_FIRST_OBSIDIAN_SCHEMA = 'reading-first-obsidian-1.0';
const fail = code => { throw Object.assign(new Error(code), { code }); };
// Editor 1.1 shows fixed module titles so every note shares one recognizable outline.
const FIXED_MODULE_LABELS = Object.freeze({
  abstract: { en: 'Abstract', 'zh-CN': '摘要' },
  design: { en: 'Research question and design', 'zh-CN': '研究问题与设计' },
  methods: { en: 'Methods, concepts and measurement', 'zh-CN': '方法、概念与测量' },
  findings: { en: 'Findings', 'zh-CN': '主要发现' },
  discussion: { en: 'Discussion', 'zh-CN': '讨论' },
  limitations: { en: 'Limitations', 'zh-CN': '局限' },
  conclusion: { en: 'Conclusions and implications', 'zh-CN': '结论与实践含义' },
});
const local = (value, language) => typeof value === 'string' ? value : value?.[language];
const label = value => String(value).replace(/[\[\]\r\n]/g, ' ');
const chinesePanelLabels = Object.freeze({ 'whole figure': '全图', 'whole table': '全表', 'upper row': '上排', 'lower row': '下排', 'bottom right': '右下' });
function panelLabel(type, language) {
  if (type.panel_label !== undefined) return local(type.panel_label, language);
  if (language !== 'zh-CN') return type.panel;
  const panel = type.panel;
  const split = typeof panel === 'string' && /^([a-z]) (upper|lower)$/i.exec(panel);
  return split ? `${split[1]} ${split[2].toLowerCase() === 'upper' ? '上部' : '下部'}` : chinesePanelLabels[typeof panel === 'string' ? panel.toLowerCase() : ''] ?? panel;
}
const key = value => typeof value === 'string' ? value.normalize('NFC').trim().toLowerCase() : '';
const filenameLabel = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f<>:"/\\|?*#\[\]^]/g, ' ').replace(/\.{2,}/g, ' ').replace(/[. ]+$/g, '').trim() : value;
function vaultPath(value) {
  if (typeof value !== 'string' || !value || /[\\\x00-\x1f:#?%]/.test(value) || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..') || /[<>"|*\[\]]/.test(value)) fail('RF_OBSIDIAN_PATH_INVALID');
  return value;
}
// Parentheses must be escaped in Markdown destinations, including heading fragments.
const encodeMarkdownComponent = value => encodeURIComponent(value).replace(/[()]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
function href(from, to) {
  return path.posix.relative(path.posix.dirname(from), vaultPath(to)).split('/').map(part => encodeMarkdownComponent(part)).join('/');
}
const md = (text, url) => `[${label(text)}](${url})`;
const anchor = id => `rf-${id}`;
function requireId(value) { if (typeof value !== 'string' || !/^[a-z][a-z0-9-]*$/.test(value)) fail('RF_OBSIDIAN_ID_INVALID'); return value; }
function localized(value) { for (const language of languages) if (typeof local(value, language) !== 'string' || !local(value, language).trim()) fail('RF_OBSIDIAN_TEXT_REQUIRED'); }
function document({ language, paperId, title, alternate, source, reading, resources }) {
  const frontmatter = { type: 'paper', pipeline_version: '3.0', status: 'candidate', rendering_profile: 'reading-first-obsidian-1.0', paper_id: paperId, language, title, graph_scope: 'v3-candidate', alternate_language_path: alternate, cssclasses: ['apa-readable'] };
  return ['---', YAML.stringify(frontmatter, { lineWidth: 0 }).trimEnd(), '---', ...[['source', source], ['reading', reading], ['resources', resources]].flatMap(([id, text]) => [`<!-- AUTO:START ${id} -->`, text, `<!-- AUTO:END ${id} -->`, '']), `## ${language === 'en' ? 'Personal Notes' : '个人笔记'}`, ''].join('\n');
}

/** Pure candidate rendering. Paths are vault relative; assets are copied by the caller. */
export function renderReadingFirstObsidian({ identity, views, presentation, targetRegistry, existingTargets = [], knowledgeRegistry = [], readingEditor, noteLayout, sourceLanguage } = {}) {
  if (!presentation || presentation.schema_version !== 'reading-first-obsidian-1.0' || !Array.isArray(views) || views.length !== 2 || languages.some(language => views.filter(view => view.language === language).length !== 1)) fail('RF_OBSIDIAN_INPUT_INVALID');
  const p = applyReadingFirstKnowledgeContent({ presentation, views });
  const sharedKnowledge = p.knowledge_layout === 'shared-bilingual-1.0';
  if (p.knowledge_layout && !sharedKnowledge) fail('RF_OBSIDIAN_KNOWLEDGE_LAYOUT_INVALID');
  const editor = readingEditor === undefined ? undefined : validateReadingFirstEditor({ editor: readingEditor, views, presentation });
  // Editor 1.1: three heading levels, folded catalogues/captions, figure notes beside figures and a staged map.
  const compact = ['reading-editor-1.1', 'reading-editor-1.2'].includes(editor?.schema_version);
  const writerLayout = p.layout === 'writer-modules-1.0';
  if (editor && !writerLayout) fail('RF_OBSIDIAN_EDITOR_LAYOUT_INVALID');
  if (p.layout && !writerLayout) fail('RF_OBSIDIAN_LAYOUT_INVALID');
  const modules = p.modules ?? [];
  if (writerLayout) {
    const required = ['abstract', 'design', 'methods', 'findings', 'discussion', 'limitations', 'conclusion'];
    if (modules.length !== required.length || modules.some((item, index) => item.id !== required[index])) fail('RF_OBSIDIAN_MODULE_INVALID');
    modules.forEach(item => localized(item.label));
    const structure = views.map(view => {
      if (!Array.isArray(view.sections)) fail('RF_OBSIDIAN_SECTION_INVALID');
      const order = view.sections.map(section => modules.findIndex(item => item.id === section.module_id));
      if (order.some((value, index) => value < 0 || (index && value < order[index - 1])) || required.some(id => !view.sections.some(section => section.module_id === id))) fail('RF_OBSIDIAN_MODULE_INVALID');
      return view.sections.map(section => ({ id: section.id, module_id: section.module_id }));
    });
    if (JSON.stringify(structure[0]) !== JSON.stringify(structure[1])) fail('RF_OBSIDIAN_BILINGUAL_STRUCTURE_INVALID');
  }
  localized(p.bibliography?.title);
  vaultPath(p.source_pdf);
  if (!/^Raw\/.+\.pdf$/i.test(p.source_pdf)) fail('RF_OBSIDIAN_PATH_INVALID');
  const registry = registerReaderTargets({ identity, registeredBibliography: { ...p.bibliography, first_author: filenameLabel(p.bibliography.first_author), title: filenameLabel(local(p.bibliography.title, 'en')) }, existingRegistry: targetRegistry ?? [], occupiedPaths: existingTargets.map(note => note.path), namingStyle: writerLayout ? 'bibliographic' : 'lowercase', noteLayout, sourceLanguage });
  const sectionSpecs = writerLayout ? views[0].sections.map(section => ({ id: section.id })) : p.sections;
  const sections = sectionSpecs?.map(section => ({ ...section, indices: Object.fromEntries(languages.map(language => {
    const matches = views.find(view => view.language === language).sections.map((row, index) => row.id === section.id ? index : -1).filter(index => index >= 0);
    if (matches.length > 1) fail('RF_OBSIDIAN_SECTION_INVALID');
    return [language, matches.length ? matches[0] : section.indices?.[language]];
  })) }));
  if (!Array.isArray(sections) || !sections.length || new Set(sections.map(section => section.id)).size !== sections.length) fail('RF_OBSIDIAN_SECTION_INVALID');
  const byId = new Map(sections.map(section => [requireId(section.id), section]));
  for (const language of languages) {
    const view = views.find(value => value.language === language);
    const indices = sections.map(section => section.indices?.[language]);
    if (!Array.isArray(view.sections) || indices.length !== view.sections.length || new Set(indices).size !== indices.length || indices.some(index => !Number.isInteger(index) || index < 0 || index >= view.sections.length)) fail('RF_OBSIDIAN_SECTION_INVALID');
    for (const section of view.sections) if (typeof section.heading !== 'string' || !Array.isArray(section.paragraphs) || !section.paragraphs.length || section.paragraphs.some(paragraph => typeof paragraph !== 'string' || !paragraph.trim())) fail('RF_OBSIDIAN_SECTION_INVALID');
  }
  function checkPlacement(item, language) {
    const section = byId.get(item.section_id);
    if (!section || (item.after_paragraph !== undefined && (!Number.isInteger(item.after_paragraph) || item.after_paragraph < 0 || (language ? [language] : languages).some(lang => item.after_paragraph >= views.find(view => view.language === lang).sections[section.indices[lang]].paragraphs.length)))) fail('RF_OBSIDIAN_PLACEMENT_INVALID');
  }
  const visuals = p.visuals ?? [], knowledge = p.knowledge ?? [];
  for (const rows of [visuals, knowledge]) if (new Set(rows.map(row => row.id)).size !== rows.length) fail('RF_OBSIDIAN_ID_INVALID');
  for (const visual of visuals) {
    requireId(visual.id); vaultPath(visual.path); localized(visual.label); localized(visual.caption); if (!writerLayout) checkPlacement(visual);
    if (!visual.path.startsWith('Figures/')) fail('RF_OBSIDIAN_PATH_INVALID');
    if (!['figure', 'table', ...(sharedKnowledge ? ['formula'] : [])].includes(visual.kind) || !Number.isInteger(visual.page) || visual.page < 1) fail('RF_OBSIDIAN_VISUAL_INVALID');
    if (visual.chart_types !== undefined && (!Array.isArray(visual.chart_types) || visual.chart_types.some(type => !knowledge.some(item => item.id === type.knowledge_id && item.source_kind === 'method-background')))) fail('RF_OBSIDIAN_VISUAL_INVALID');
    for (const type of visual.chart_types ?? []) {
      localized(type.label);
      if (type.panel_label !== undefined) localized(type.panel_label);
    }
  }
  const placementSets = new Map();
  const knowledgeUsed = (item, view) => {
    if (view.placements.knowledge.some(row => row.id === item.id)) return true;
    if (!sharedKnowledge || item.source_kind !== 'method-background') return false;
    const inventory = editor?.languages[view.language].methods ?? [];
    if (inventory.some(method => method.knowledge_id === item.id || method.knowledge_ids?.includes(item.id))) return true;
    if (visuals.some(visual => visual.chart_types?.some(type => type.knowledge_id === item.id))) return true;
    return view.sections.some(section => section.paragraphs.some(paragraph => paragraph.includes(`](apa-knowledge:${item.id})`)));
  };
  if (writerLayout) for (const view of views) {
    const placements = view.placements;
    if (!placements || !Array.isArray(placements.visuals) || !Array.isArray(placements.knowledge)) fail('RF_OBSIDIAN_PLACEMENT_INVALID');
    for (const [kind, catalog] of [['visuals', visuals], ['knowledge', knowledge]]) {
      const rows = placements[kind];
      if (rows.some(row => !catalog.some(item => item.id === row.id)) || (kind === 'visuals' && (rows.length !== catalog.length || new Set(rows.map(row => row.id)).size !== rows.length)) || (kind === 'knowledge' && catalog.some(item => !knowledgeUsed(item, view)))) fail('RF_OBSIDIAN_PLACEMENT_INVALID');
      rows.forEach(row => checkPlacement(row, view.language));
    }
    placementSets.set(view.language, placements);
  }
  const sources = new Map();
  if (writerLayout) for (const source of p.sources ?? []) {
    requireId(source.id); vaultPath(source.path);
    if (sources.has(source.id) || !/^Raw\/.+\.pdf$/i.test(source.path)) fail('RF_OBSIDIAN_SOURCE_INVALID');
    sources.set(source.id, source.path);
  }
  const visualSources = new Map();
  for (const visual of visuals) {
    const byId = visual.source_id === undefined ? undefined : sources.get(visual.source_id);
    if (visual.source_id !== undefined && !byId && !(sources.size === 0 && visual.source_path === p.source_pdf)) fail('RF_OBSIDIAN_SOURCE_INVALID');
    if (visual.source_path !== undefined && visual.source_path !== p.source_pdf && ![...sources.values()].includes(visual.source_path)) fail('RF_OBSIDIAN_SOURCE_INVALID');
    if (byId && visual.source_path !== undefined && byId !== visual.source_path) fail('RF_OBSIDIAN_SOURCE_INVALID');
    visualSources.set(visual.id, byId ?? visual.source_path ?? p.source_pdf);
  }
  function visualSourcePage(visual, language) {
    const sourcePath = visualSources.get(visual.id);
    const sourceRows = (p.sources ?? []).filter(source => source.path === sourcePath);
    const source = visual.source_id === undefined ? (sourceRows.length === 1 ? sourceRows[0] : undefined)
      : sourceRows.find(row => row.id === visual.source_id);
    const sourceKind = source?.kind ?? source?.source_kind ?? source?.id;
    const supplementary = sourcePath !== p.source_pdf && ['supplement', 'supplementary', 'supplementary-material'].includes(sourceKind);
    return supplementary ? (language === 'en' ? `Supplementary p. ${visual.page}` : `补充材料第${visual.page}页`)
      : (language === 'en' ? `Original p. ${visual.page}` : `原文第${visual.page}页`);
  }
  const map = p.map ?? { steps: [], findings: [], relations: [] };
  const nodes = [...map.steps, ...map.findings];
  if (new Set(nodes.map(node => node.id)).size !== nodes.length) fail('RF_OBSIDIAN_MAP_INVALID');
  for (const node of nodes) { requireId(node.id); localized(node.label); if (!byId.has(node.section_id)) fail('RF_OBSIDIAN_MAP_INVALID'); }
  for (const relation of map.relations) if (!map.steps.some(node => node.id === relation.step_id) || !map.findings.some(node => node.id === relation.finding_id)) fail('RF_OBSIDIAN_MAP_INVALID');
  const supportNotes = [], knowledgeProposals = [], destinations = new Map();
  for (const item of knowledge) {
    requireId(item.id); localized(item.title);
    if (!['method', 'concept'].includes(item.kind) || !['method-background', 'paper-fact'].includes(item.source_kind) || (!writerLayout && !Array.isArray(item.placements))) fail('RF_OBSIDIAN_KNOWLEDGE_INVALID');
    if (!writerLayout) item.placements.forEach(item => checkPlacement(item));
    if (sharedKnowledge) {
      for (const language of languages) if (!Array.isArray(item.paragraphs?.[language]) || !item.paragraphs[language].length || item.paragraphs[language].some(text => typeof text !== 'string' || !text.trim())) fail('RF_OBSIDIAN_KNOWLEDGE_INVALID');
      if (item.source_kind === 'paper-fact') continue;
      const result = renderSharedKnowledge({ item, knowledgeRegistry, paperTargets: registry.paper_targets, paperId: identity.paper_id, paperTitle: p.bibliography.title, vaultPath, href });
      supportNotes.push(result.note);
      if (result.proposal) knowledgeProposals.push(result.proposal);
      for (const language of languages) destinations.set(`${item.id}:${language}`, result.note.path);
      continue;
    }
    for (const language of languages) {
      const paragraphs = item.paragraphs?.[language];
      if (!Array.isArray(paragraphs) || !paragraphs.length || paragraphs.some(text => typeof text !== 'string' || !text.trim())) fail('RF_OBSIDIAN_KNOWLEDGE_INVALID');
      if (item.source_kind === 'paper-fact') continue;
      const { paths: uniquePaths } = matchReadingFirstKnowledgeIdentity({ item, knowledgeRegistry: knowledgeRegistry.filter(row => !row.language || row.language === language), vaultPath });
      const target = uniquePaths[0] ?? `Wiki/${item.kind === 'method' ? 'methods' : 'concepts'}/${item.id}--${fingerprintV3Json({ kind: item.kind, key: item.canonical_key ?? item.id }).slice(-12)}.${language}.md`;
      if (!new RegExp(`^Wiki/${item.kind === 'method' ? 'methods' : 'concepts'}/`).test(target)) fail('RF_OBSIDIAN_KNOWLEDGE_INVALID');
      destinations.set(`${item.id}:${language}`, target);
      const entry = { id: item.id, language, path: target, source_kind: item.source_kind, paragraphs };
      if (uniquePaths.length) knowledgeProposals.push({ ...entry, action: 'proposed-addition' });
      else {
        const body = ['---', YAML.stringify({ type: item.kind, pipeline_version: '3.0', status: 'candidate', graph_scope: 'v3-candidate', language, canonical_key: item.canonical_key ?? item.id, aliases: item.aliases ?? [], source_kind: item.source_kind }).trimEnd(), '---', `# ${local(item.title, language)}`, '', ...paragraphs.flatMap(text => [text, '']), md(language === 'en' ? 'Paper application' : '本文中的应用', href(target, registry.paper_targets[language])), ''].join('\n');
        supportNotes.push({ ...entry, content: body, bytes: Buffer.from(body) });
      }
    }
  }
  // Resolve shared-note references after every identity has a destination, including forward references.
  if (sharedKnowledge) for (let index = 0; index < supportNotes.length; index++) {
    const item = knowledge.find(item => item.id === supportNotes[index].id);
    const resolveReferences = (value, language, target) => value.replace(/\[([^\]\n]+)\]\((apa-[^)]+)\)/g, (_, text, reference) => {
      const concept = /^apa-knowledge:([a-z][a-z0-9-]*)$/.exec(reference);
      const committed = concept ? knowledgeRegistry.filter(entry => entry.id === concept[1]) : [];
      if (committed.length > 1) fail('RF_OBSIDIAN_REFERENCE_INVALID');
      const destination = concept && (destinations.get(`${concept[1]}:${language}`) ?? committed[0]?.path);
      if (!destination) fail('RF_OBSIDIAN_REFERENCE_INVALID');
      return md(text, href(target, destination) + '#' + encodeMarkdownComponent(language === 'en' ? 'English' : '中文'));
    });
    supportNotes[index] = renderSharedKnowledge({ item, knowledgeRegistry, paperTargets: registry.paper_targets, paperId: identity.paper_id, paperTitle: p.bibliography.title, vaultPath, href, resolveReferences }).note;
  }
  for (const note of sharedKnowledge ? [] : supportNotes) {
    const otherLanguage = languages.find(language => language !== note.language);
    note.content += '\n' + md(note.language === 'en' ? '中文' : 'English', href(note.path, destinations.get(`${note.id}:${otherLanguage}`))) + '\n';
    note.bytes = Buffer.from(note.content);
  }
  const allPaths = [...Object.values(registry.paper_targets), ...supportNotes.map(note => note.path)].map(key);
  if (new Set(allPaths).size !== allPaths.length) fail('RF_OBSIDIAN_TARGET_COLLISION');
  const notes = languages.map(language => {
    const en = language === 'en', target = registry.paper_targets[language], view = views.find(value => value.language === language), alternate = registry.paper_targets[languages.find(value => value !== language)];
    const edits = editor?.languages[language];
    const headingHref = heading => '#' + encodeMarkdownComponent(heading).replace(/%2F/g, '/');
    const knowledgeHref = id => href(target, destinations.get(`${id}:${language}`)) + (sharedKnowledge ? headingHref(en ? 'English' : '中文') : '');
    const moduleHeadings = new Map(modules.map((module, index) => [module.id, `${index + 1}. ${local(compact ? FIXED_MODULE_LABELS[module.id] : module.label, language)}`]));
    const mapHeading = en ? '2.1 Research map' : '2.1 研究导图';
    const inventoryHeading = en ? '3.1 Methods and concepts at a glance' : '3.1 方法与概念索引';
    const overviewHeading = en ? 'Reading overview' : '阅读提要';
    const sectionHeadings = new Map();
    for (const module of modules) {
      const offset = (module.id === 'design' && nodes.length && !compact || module.id === 'methods') ? 1 : 0;
      view.sections.filter(section => section.module_id === module.id).forEach((section, index) => sectionHeadings.set(section.id, `${modules.indexOf(module) + 1}.${index + 1 + offset} ${section.heading}`));
    }
    const methodHeading = (method, index) => `3.1.${index + 1} ${method.title}`;
    const subheadingTitle = (section, item, edit) => `${sectionHeadings.get(section.id).split(' ')[0]}.${edit.subheadings.filter(heading => heading.before_paragraph <= item.before_paragraph).length} ${item.heading}`;
    const visualHeadings = new Map(visuals.map(visual => [visual.id, `${local(visual.label, language)} · ${en ? 'Source p.' : '原文页'} ${visual.page}`]));
    const visualLink = id => editor && !compact ? headingHref(visualHeadings.get(id)) : '#^rf-visual-' + id;
    const sectionLink = (id, text) => md(text, editor ? headingHref(sectionHeadings.get(id)) : `#^${anchor(id)}`);
    const sectionLinks = ids => ids.map(id => sectionLink(id, view.sections.find(section => section.id === id).heading)).join(' · ');
    const callout = (kind, title, text, folded = false) => `> [!${kind}]${folded ? '-' : ''} ${title}\n` + text.split('\n').map(line => '> ' + line).join('\n') + '\n\n';
    const methodInventory = () => `### ${inventoryHeading}\n\n` + edits.methods.map((method, index) => {
      const ids = [...new Set([...(method.knowledge_ids ?? []), ...(method.knowledge_id ? [method.knowledge_id] : [])])];
      const shared = ids.map(id => {
        if (!destinations.has(`${id}:${language}`)) fail('RF_OBSIDIAN_REFERENCE_INVALID');
        return md(sharedKnowledge ? local(knowledge.find(item => item.id === id).title, language) : en ? 'Shared explanation' : '通用解释', knowledgeHref(id));
      });
      const body = `**${en ? 'Principle' : '原理'}**${en ? ': ' : '：'}${resolveReferences(method.explanation)}\n\n**${en ? 'Use in this study' : '本文中的作用'}**${en ? ': ' : '：'}${resolveReferences(method.application)}\n\n${sectionLinks(method.section_ids)}${shared.length ? ' · ' + shared.join(' · ') : ''}`;
      return compact ? callout('info', label(method.title), body, true) : `#### ${methodHeading(method, index)}\n\n${body}\n\n`;
    }).join('');
    const resolveReferences = text => text.replace(/\[([^\]\n]+)\]\((apa-[^)]+)\)/g, (_, text, reference) => {
      let destination;
      const source = /^apa-source:([a-z][a-z0-9-]*)#page=([1-9][0-9]*)$/.exec(reference);
      const visual = /^apa-visual:([a-z][a-z0-9-]*)$/.exec(reference);
      const concept = /^apa-knowledge:([a-z][a-z0-9-]*)$/.exec(reference);
      if (source && sources.has(source[1]) && Number.isSafeInteger(Number(source[2]))) destination = href(target, sources.get(source[1])) + '#page=' + source[2];
      else if (visual && visuals.some(item => item.id === visual[1])) destination = visualLink(visual[1]);
      else if (concept && knowledge.some(item => item.id === concept[1])) {
        const item = knowledge.find(item => item.id === concept[1]);
        destination = item.source_kind === 'paper-fact' ? (editor ? headingHref(sectionHeadings.get(placementSets.get(language).knowledge.find(row => row.id === item.id).section_id)) : '#^rf-' + placementSets.get(language).knowledge.find(row => row.id === item.id).section_id) : knowledgeHref(item.id);
      }
      if (!destination) fail('RF_OBSIDIAN_REFERENCE_INVALID');
      return md(text, destination);
    });
    const bibliography = p.bibliography;
    let source = `# ${local(bibliography.title, language)}\n\n${bibliography.citation ?? `${bibliography.first_author} (${bibliography.year})`}\n\n${md(en ? 'Original paper' : '原文', href(target, p.source_pdf))} · ${md(en ? '中文' : 'English', href(target, alternate))}\n\n`;
    if (bibliography.doi) source += `DOI: ${md(bibliography.doi, `https://doi.org/${encodeURI(bibliography.doi)}`)}\n\n`;
    let contents = writerLayout ? modules.flatMap(module => [`- ${md(local(module.label, language), '#' + encodeURIComponent(local(module.label, language)))}`, ...view.sections.filter(section => section.module_id === module.id).map(section => `  - ${sectionLink(section.id, section.heading)}`), ...(module.id === 'design' && nodes.length ? [`  - ${md(en ? 'Research map' : '研究导图', '#' + encodeURIComponent(en ? 'Research map' : '研究导图'))}`] : [])]) : view.sections.map((section, index) => `- ${sectionLink(sections.find(value => value.indices[language] === index).id, section.heading)}`);
    if (editor) {
      source += `## ${overviewHeading}\n\n` + callout('abstract', en ? 'Key findings and interpretation' : '核心发现与解读', edits.overview.map(item => `- ${resolveReferences(item.text)} ${sectionLinks(item.section_ids)}`).join('\n'));
      contents = [`- **${md(overviewHeading, headingHref(overviewHeading))}**`, ...modules.flatMap(module => [
        `- **${md(moduleHeadings.get(module.id), headingHref(moduleHeadings.get(module.id)))}**`,
        ...(module.id === 'design' && nodes.length && !compact ? [`  - ${md(mapHeading, headingHref(mapHeading))}`] : []),
        ...(module.id === 'methods' ? [`  - ${md(inventoryHeading, headingHref(inventoryHeading))}`] : []),
        ...view.sections.filter(section => section.module_id === module.id).map(section => `  - ${sectionLink(section.id, sectionHeadings.get(section.id))}`),
      ])];
    }
    if (writerLayout) for (const heading of [en ? 'Figures and tables' : '图表导航', en ? 'Personal Notes' : '个人笔记']) contents.push(`- ${md(heading, '#' + encodeURIComponent(heading))}`);
    source += compact ? callout('note', en ? 'Contents' : '目录', contents.join('\n'), true).trimEnd() + '\n' : `## ${en ? 'Contents' : '目录'}\n\n` + contents.join('\n') + '\n';
    let reading = '', researchMap = '';
    if (compact && nodes.length) {
      // Left-to-right stages keep wide maps readable; only editor-selected nodes and their own edges are drawn.
      const selected = editor.map.nodes, ids = new Set(selected.map(node => node.id)), drawn = new Set(), mermaidId = id => id.replaceAll('-', '_');
      const stages = [['design', en ? 'Study design' : '研究设计'], ['measurement', en ? 'Measurement and analysis' : '测量与分析'], ['finding', en ? 'Findings' : '主要发现'], ['limit', en ? 'Limits' : '限制']];
      researchMap += '```mermaid\nflowchart LR\n';
      for (const [stage, title] of stages) {
        const rows = selected.filter(node => node.stage === stage);
        if (!rows.length) continue;
        researchMap += `  subgraph stage_${stage}["${title}"]\n    direction TB\n`;
        for (const row of rows) {
          researchMap += `    ${mermaidId(row.id)}["${local(nodes.find(node => node.id === row.id).label, language).replace(/["\r\n<>]/g, ' ')}"]\n`;
          drawn.add(row.id);
        }
        researchMap += '  end\n';
      }
      for (const relation of map.relations) if (ids.has(relation.step_id) && ids.has(relation.finding_id)) researchMap += `  ${mermaidId(relation.step_id)} --> ${mermaidId(relation.finding_id)}\n`;
      researchMap += '  classDef primary fill:#1d4ed8,stroke:#1e3a8a,stroke-width:3px,color:#ffffff\n  classDef secondary fill:#f1f5f9,stroke:#94a3b8,color:#1e293b\n';
      for (const [kind, rows] of [['primary', selected.filter(node => node.primary)], ['secondary', selected.filter(node => !node.primary)]]) if (rows.length) researchMap += `  class ${rows.map(node => mermaidId(node.id)).join(',')} ${kind}\n`;
      researchMap += '```\n\n';
      if (editor.schema_version === 'reading-editor-1.2') {
        if (drawn.size !== ids.size || [...ids].some(id => !drawn.has(id))) fail('RF_RESEARCH_MAP_INCOMPLETE');
        const omitted = map.findings.filter(node => !ids.has(node.id));
        if (omitted.length) researchMap += `${en ? 'Findings not shown in the map: ' : '未画入导图的发现：'}`
          + omitted.map(node => sectionLink(node.section_id, local(node.label, language))).join(' · ') + '\n\n';
      }
    } else if (nodes.length) {
      researchMap += `${writerLayout ? '###' : '##'} ${editor ? mapHeading : en ? 'Research map' : '研究导图'}\n\n\`\`\`mermaid\nflowchart TD\n`;
      for (const node of nodes) researchMap += `  ${node.id.replaceAll('-', '_')}["${local(node.label, language).replace(/["\r\n<>]/g, ' ')}"]\n`;
      for (const relation of map.relations) researchMap += `  ${relation.step_id.replaceAll('-', '_')} --> ${relation.finding_id.replaceAll('-', '_')}\n`;
      researchMap += '```\n\n' + nodes.map(node => `- ${sectionLink(node.section_id, local(node.label, language))}`).join('\n') + '\n\n';
    }
    view.sections.forEach((section, index) => {
      const appendedFacts = new Set(section.paragraphs);
      const spec = sections.find(value => value.indices[language] === index);
      if (writerLayout && (index === 0 || view.sections[index - 1].module_id !== section.module_id)) {
        const module = modules.find(item => item.id === section.module_id);
        reading += `## ${editor ? moduleHeadings.get(module.id) : local(module.label, language)}\n\n`;
        if (editor && module.id === 'methods') reading += methodInventory();
        if (module.id === 'design' && !compact) reading += researchMap;
      }
      if (!writerLayout && spec.id === (map.steps[0]?.section_id ?? nodes[0]?.section_id)) reading += researchMap;
      reading += `${writerLayout ? '###' : '##'} ${editor ? sectionHeadings.get(section.id) : section.heading}\n\n`;
      const edit = edits?.sections.find(item => item.section_id === section.id);
      if (edit?.takeaway) reading += callout('summary', en ? 'Key point' : '要点', resolveReferences(edit.takeaway));
      const notes = new Map((compact ? edits.visuals : []).flatMap(item => (item.notes ?? []).filter(note => note.section_id === section.id).map(note => [note.paragraph_index, item.id])));
      const renderParagraph = (paragraph, paragraphIndex) => {
        let emphasized = paragraph;
        const spans = (edit?.emphasis ?? []).filter(item => item.paragraph_index === paragraphIndex);
        // Apply exact spans against original offsets so inserted Markdown never changes later matches.
        const preserved = [...paragraph.matchAll(/\*\*[^*]+\*\*|!?\[[^\]\n]*\]\([^\n)]*\)|!?\[\[[^\]\n]+\]\]/g)].map(match => ({ start: match.index, end: match.index + match[0].length }));
        const ranges = spans.map(item => ({ start: paragraph.indexOf(item.text), end: paragraph.indexOf(item.text) + item.text.length })).filter(range => !preserved.some(marked => range.start < marked.end && range.end > marked.start)).sort((a, b) => b.start - a.start);
        for (const range of ranges) emphasized = emphasized.slice(0, range.start) + '**' + emphasized.slice(range.start, range.end) + '**' + emphasized.slice(range.end);
        const renderedParagraph = writerLayout ? resolveReferences(emphasized) : emphasized;
        if (writerLayout && /apa-(?:source|visual|knowledge):/.test(renderedParagraph)) fail('RF_OBSIDIAN_REFERENCE_INVALID');
        return renderedParagraph;
      };
      section.paragraphs.forEach((paragraph, paragraphIndex) => {
        const subheading = edit?.subheadings.find(item => item.before_paragraph === paragraphIndex);
        let renderedParagraph = renderParagraph(paragraph, paragraphIndex);
        const structured = writerLayout && /(?:^|\n)(?:\s*>|\s*[-*+] |\s*\d+[.)] |\s*\||\s*```)/.test(renderedParagraph);
        // Compact layout keeps three heading levels: editor subheadings become bold lead-ins.
        if (subheading && compact) renderedParagraph = `**${subheading.heading.replace(/[.。:：;；!！?？]+$/u, '')}${en ? '.' : '。'}**${structured ? '\n\n' : en ? ' ' : ''}` + renderedParagraph;
        else if (subheading) reading += `#### ${subheadingTitle(section, subheading, edit)}\n\n`;
        if (!notes.has(paragraphIndex)) reading += renderedParagraph + (paragraphIndex === 0 ? `${structured ? '\n\n' : ' '}^${anchor(spec.id)}` : '') + '\n\n';
        const placed = value => value.section_id === spec.id && (value.after_paragraph ?? section.paragraphs.length - 1) === paragraphIndex;
        const placements = placementSets.get(language);
        for (const visual of visuals.filter(value => writerLayout ? placements.visuals.some(row => row.id === value.id && placed(row)) : placed(value))) {
          const types = visual.chart_types ?? [];
          const panels = [...new Set(types.map(type => type.panel))];
          const panelTypes = panels.map(panel => types.filter(type => type.panel === panel));
          const signature = rows => JSON.stringify(rows.map(type => [type.knowledge_id, local(type.label, language)]).sort());
          const samePanels = panels.length > 1 && panels.every(Boolean) && panelTypes.every(rows => signature(rows) === signature(panelTypes[0]));
          const chartTypes = samePanels
            ? (en ? 'Each panel: ' : '各面板：') + panelTypes[0].map(type => md(local(type.label, language), knowledgeHref(type.knowledge_id))).join(' · ')
            : types.map(type => `${type.panel ? label(panelLabel(type, language)) + ': ' : ''}${md(local(type.label, language), knowledgeHref(type.knowledge_id))}`).join(' · ');
          if (compact) {
            const entry = edits.visuals.find(item => item.id === visual.id), source = md(visualSourcePage(visual, language), href(target, visualSources.get(visual.id)) + '#page=' + visual.page);
            const notesText = (entry?.notes ?? []).map(note => renderParagraph(section.paragraphs[note.paragraph_index], note.paragraph_index) + '\n\n').join('');
            reading += `**${label(entry?.title ?? local(visual.label, language))}** · ${source} ^rf-visual-${visual.id}\n\n${chartTypes ? `**${en ? 'Chart type' : '图型'}**${en ? ': ' : '：'}${chartTypes}\n\n` : ''}![${label(local(visual.label, language))}](${href(target, visual.path)})\n\n${notesText}`
              + callout('quote', en ? 'Original caption' : '原图注', `**${local(visual.label, language)}.** ${local(visual.caption, language)}\n\n${md(en ? 'Open full-size image' : '查看大图', href(target, visual.path))}`, true);
            continue;
          }
          reading += `${editor ? '#### ' + visualHeadings.get(visual.id) + '\n\n' : ''}${chartTypes ? `**${en ? 'Chart type' : '图型'}**${en ? ': ' : '：'}${chartTypes}\n\n` : ''}![${label(local(visual.label, language))}](${href(target, visual.path)})\n\n**${local(visual.label, language)}.** ${local(visual.caption, language)} ${md(visualSourcePage(visual, language), href(target, visualSources.get(visual.id)) + '#page=' + visual.page)}${writerLayout ? ' · ' + md(en ? 'Open full-size image' : '查看大图', href(target, visual.path)) : ''} ^rf-visual-${visual.id}\n\n`;
        }
        for (const item of knowledge.filter(value => (writerLayout ? placements.knowledge.filter(row => row.id === value.id) : value.placements).some(placed))) {
          if (item.source_kind === 'paper-fact') {
            for (const text of item.paragraphs[language]) if (!appendedFacts.has(text)) { reading += text + '\n\n'; appendedFacts.add(text); }
            continue;
          }
          // Chart-type nodes are already linked from the figure's chart-type line.
          if (compact && visuals.some(visual => visual.chart_types?.some(type => type.knowledge_id === item.id))) continue;
          const provenance = item.source_kind === 'method-background' ? (en ? 'Method background' : '方法背景') : (en ? 'Study facts' : '本文事实');
          reading += `${provenance}: ${md(local(item.title, language), knowledgeHref(item.id))}\n\n`;
        }
      });
      if (compact && section.id === view.sections.find(row => row.module_id === 'design')?.id) reading += researchMap;
      const related = map.relations.flatMap(relation => {
        const step = map.steps.find(node => node.id === relation.step_id), finding = map.findings.find(node => node.id === relation.finding_id);
        return step.section_id === spec.id ? [finding] : finding.section_id === spec.id ? [step] : [];
      });
      if (related.length) reading += `${en ? 'Study links' : '研究关联'}: ` + [...new Map(related.map(node => [node.id, node])).values()].map(node => sectionLink(node.section_id, local(node.label, language))).join(' · ') + '\n\n';
    });
    const resources = `## ${en ? 'Figures and tables' : '图表导航'}\n\n` + visuals.map(visual => `- ${md(local(visual.label, language), visualLink(visual.id))}`).join('\n') + '\n';
    const bytes = Buffer.from(document({ language, paperId: identity.paper_id, title: local(bibliography.title, language), alternate, source, reading, resources }));
    const existing = existingTargets.find(note => note.path === target);
    if (existing?.bytes && !existing.managedHash) fail('RF_OBSIDIAN_PREIMAGE_HASH_REQUIRED');
    const merged = mergeManagedNote({ existingBytes: existing?.bytes, rendered: bytes, expectedManagedHash: existing?.managedHash });
    return { language, path: target, content: merged.bytes.toString('utf8'), bytes: merged.bytes, managedHash: merged.managedHash };
  });
  return { notes, supportNotes, knowledgeProposals, ...(sharedKnowledge ? { visual_resources: structuredClone(visuals) } : {}), assetPaths: [...new Set([p.source_pdf, ...sources.values(), ...visuals.map(visual => visual.path)])], targetRegistry: registry, review: { status: 'pending', reason: 'Rendered reading experience requires overall review and native Obsidian acceptance.' } };
}
