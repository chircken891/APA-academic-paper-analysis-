import { readCurrentVaultContent, readCurrentRegisteredBytes, getCurrentNote } from './current-vault-content.mjs';
import { prepareTopicSave, prepareTopicUpdate, executeTopicUpdate } from './topic-library.mjs';
import { inspectManagedNote } from './phase22-managed-markdown.mjs';
import { createHash } from 'node:crypto';
import { verifyReadingFirstPresentation } from './reading-first-index.mjs';

const fail = (code, details = {}) => { throw Object.assign(new Error(code), { code, details }); };
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const fields = ['evidence_records', 'ideas', 'discarded_ideas', 'sections', 'citation_plan'];
const optionalEvidence = ['method', 'data', 'metrics', 'limitations'];
const strengths = ['推测', 'tentative', '观察', 'observation', '支持', 'support', '较强', 'strong'];
const polarities = ['支持', 'support', '反驳', 'refute', 'contradict', '中性', 'neutral', '混合', 'mixed'];
const tableStart = '<!-- APA_EVIDENCE_TABLE -->';
const tableEnd = '<!-- APA_EVIDENCE_TABLE_END -->';
const cell = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '&#124;').replace(/\r?\n/g, '<br>');
const uncell = value => value.trim().replace(/<br\s*\/?>/gi, '\n').replace(/&#124;/g, '|').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

function readProjectBody(managed, registered) {
  managed = managed.replace(/\r\n/g, '\n');
  const metadata = [...managed.matchAll(/<!-- APA_WRITING_PROJECT ([A-Za-z0-9+/=]+) -->/g)];
  if (metadata.length !== 1) fail('WQ_PROJECT_CURRENT_DATA_INVALID');
  let data;
  try { data = JSON.parse(Buffer.from(metadata[0][1], 'base64').toString('utf8')); }
  catch { fail('WQ_PROJECT_CURRENT_DATA_INVALID'); }
  if (!data || typeof data !== 'object' || Object.keys(data).some(key => ![...fields.slice(1), 'source_identities', 'visible_fields_version'].includes(key))
    || !Array.isArray(data.source_identities)) fail('WQ_PROJECT_CURRENT_DATA_INVALID');
  const visibleVersion = data.visible_fields_version;
  delete data.visible_fields_version;
  const table = managed.split(tableStart);
  if (table.length !== 2 || table[1].split(tableEnd).length !== 2) fail('WQ_PROJECT_CURRENT_DATA_INVALID', { field: 'evidence_records' });
  const lines = table[1].split(tableEnd)[0].trim().split(/\r?\n/);
  const columnCount = lines[1]?.split('|').length - 2;
  if (lines.length < 3 || ![7, 11].includes(columnCount) || !new RegExp('^\\|(?:\\s*:?-+:?\\s*\\|){' + columnCount + '}$').test(lines[1])) fail('WQ_PROJECT_CURRENT_DATA_INVALID', { field: 'evidence_records' });
  data.evidence_records = lines.slice(2).map(line => {
    const columns = line.split('|');
    if (columns.length !== columnCount + 2 || columns[0].trim() || columns.at(-1).trim()) fail('WQ_PROJECT_CURRENT_DATA_INVALID', { field: 'evidence_records' });
    const [evidenceId, sourceCell, polarity, strength, allowed, forbidden, relationship, ...optional] = columns.slice(1, -1).map(uncell);
    const sources = [...sourceCell.matchAll(/\[([^\]]+)\]\(<([^>]+)>\)/g)];
    const original = data.source_identities?.find(row => row.evidence_id === evidenceId);
    if (!original || !sources.length) fail('WQ_PROJECT_CITATION_INVALID');
    const citations = sources.map(([, paperId, target]) => {
      let decoded;
      try { decoded = decodeURI(target); } catch { fail('WQ_PROJECT_CITATION_INVALID'); }
      const at = decoded.lastIndexOf('#'), path = decoded.slice(0, at), anchor = decoded.slice(at + 1);
      const identity = original.citations.find(row => row.paper_id === paperId && row.path === path);
      if (at < 0 || !identity) fail('WQ_PROJECT_CITATION_INVALID');
      return { ...identity, anchor };
    });
    return { evidence_id: evidenceId, citations, polarity, strength, allowed_statement: allowed, forbidden_statement: forbidden, relationship, ...Object.fromEntries(optionalEvidence.flatMap((key, index) => optional[index] ? [[key, optional[index]]] : [])) };
  });
  if (visibleVersion === 1) {
    const matches = [...managed.matchAll(/<!-- APA_FIELD ([A-Za-z0-9_-]+) -->\n([\s\S]*?)\n<!-- APA_FIELD_END \1 -->/g)];
    const seen = new Set();
    for (const match of matches) {
      const path = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
      if (!Array.isArray(path) || !fields.slice(1).includes(path[0]) || path.some(key => ['__proto__', 'constructor', 'prototype'].includes(key)) || seen.has(match[1])) fail('WQ_PROJECT_CURRENT_DATA_INVALID');
      seen.add(match[1]);
      let target = data;
      for (const key of path.slice(0, -1)) {
        if (!target || !Object.hasOwn(target, key)) fail('WQ_PROJECT_CURRENT_DATA_INVALID');
        target = target[key];
      }
      const key = path.at(-1);
      if (!Object.hasOwn(target, key)) fail('WQ_PROJECT_CURRENT_DATA_INVALID');
      const value = match[2];
      target[key] = typeof target[key] === 'string' ? value : JSON.parse(value);
    }
    const expected = [];
    const visit = (value, path) => {
      if (value && typeof value === 'object') Object.entries(value).forEach(([key, item]) => visit(item, [...path, key]));
      else expected.push(Buffer.from(JSON.stringify(path)).toString('base64url'));
    };
    fields.slice(1).forEach(field => visit(data[field], [field]));
    if (expected.length !== seen.size || expected.some(key => !seen.has(key)) || (managed.match(/<!-- APA_FIELD /g) ?? []).length !== seen.size || (managed.match(/<!-- APA_FIELD_END /g) ?? []).length !== seen.size) fail('WQ_PROJECT_CURRENT_DATA_INVALID');
  }
  delete data.source_identities;
  return { ...structuredClone(registered), ...data };
}

export function sectionBaselines(sections) {
  return sections.map(row => ({ section_id: row.section_id, outline: sha(JSON.stringify(row.outline ?? null)), body: sha(JSON.stringify(row.body ?? row.draft ?? null)) }));
}
export function sectionChanges(project) {
  const diagnostics = [], section_changes = [];
  for (const row of project.sections) {
    const baseline = row.sync_baseline ?? project.section_baselines?.find(item => item.section_id === row.section_id);
    if (!baseline) continue;
    const current = sectionBaselines([row])[0];
    const outline = baseline.outline !== current.outline, body = baseline.body !== current.body;
    if (outline && body) section_changes.push({ section_id: row.section_id, status: 'both_manually_modified', note: '两侧均为人工修改' });
    else if (outline || body) diagnostics.push({ code: 'WQ_SECTION_OUTLINE_BODY_DIVERGED', section_id: row.section_id, pending_side: outline ? 'body' : 'outline' });
  }
  return { diagnostics, section_changes };
}
export function validateSectionSync(previous, next) {
  for (const change of sectionChanges(previous).diagnostics) {
    const old = previous.sections.find(row => row.section_id === change.section_id);
    const row = next.sections.find(row => row.section_id === change.section_id);
    const value = item => change.pending_side === 'body' ? item.body ?? item.draft : item.outline;
    if (!row || (JSON.stringify(value(row)) === JSON.stringify(value(old)) && !(typeof row.sync_reason === 'string' && row.sync_reason.trim() && row.sync_reason !== old.sync_reason))) fail('WQ_SECTION_SYNC_REQUIRED', change);
  }
}

export async function readWritingProject({ repoRoot, projectId, generationId } = {}) {
  const snapshot = await readCurrentVaultContent({ vaultRoot: repoRoot });
  if (!snapshot.ok) fail('WQ_PROJECT_COMMITTED_REQUIRED', { errors: snapshot.errors });
  if (generationId && generationId !== snapshot.generation_id) fail('P24_GENERATION_CHANGED');
  const registered = (snapshot.generation.topics ?? []).find(row => row.project_id === projectId && row.schema_version === 'writing-project-1.0');
  if (!registered) fail('WQ_PROJECT_UNAVAILABLE');
  const bytes = readCurrentRegisteredBytes(snapshot, registered.path).bytes;
  const managed = inspectManagedNote(bytes).regions.find(row => row.id === 'topic').bytes.toString('utf8');
  const project = readProjectBody(managed, registered);
  for (const row of project.sections) {
    const baseline = registered.sections.find(item => item.section_id === row.section_id)?.sync_baseline;
    if (baseline) row.sync_baseline = baseline;
  }
  // Saved citations may predate human edits to the cited notes; report them so an update can rebind.
  const { diagnostics } = await validateWritingProjectData({ repoRoot, generationId: snapshot.generation_id, projectData: Object.fromEntries(fields.map(field => [field, project[field]])),
    adoptedSources: project.dependencies, citationChanges: 'report' });
  const changes = sectionChanges(project);
  diagnostics.push(...changes.diagnostics);
  return { ok: true, project, diagnostics, section_changes: changes.section_changes, generation_id: snapshot.generation_id, content_sha256: sha(bytes),
    managed_hash: inspectManagedNote(bytes).managedHash, markdown: bytes.toString('utf8'), snapshot };
}

export async function validateWritingProjectData({ repoRoot, generationId, projectData, adoptedSources, citationChanges = 'reject' } = {}) {
  if (!projectData || Object.keys(projectData).some(key => !fields.includes(key)) || fields.some(key => !Array.isArray(projectData[key]))) fail('WQ_PROJECT_DATA_INVALID');
  if (/<!--\s*(?:AUTO|APA_FIELD)|## Personal Notes/.test(JSON.stringify(projectData))) fail('WQ_PROJECT_DATA_INVALID');
  const snapshot = await readCurrentVaultContent({ vaultRoot: repoRoot });
  if (!snapshot.ok || snapshot.generation_id !== generationId) fail('P24_GENERATION_CHANGED');
  const ids = new Set(), diagnostics = [];
  if (!projectData.evidence_records.length) fail('WQ_PROJECT_EVIDENCE_REQUIRED');
  for (const evidence of projectData.evidence_records) {
    const expected = ['evidence_id', 'citations', 'polarity', 'strength', 'allowed_statement', 'forbidden_statement', 'relationship'];
    if (!evidence || Object.keys(evidence).some(key => ![...expected, ...optionalEvidence].includes(key)) || expected.some(key => key !== 'citations' && (typeof evidence[key] !== 'string' || !evidence[key].trim()))
      || !Array.isArray(evidence.citations) || !evidence.citations.length || ids.has(evidence.evidence_id)) fail('WQ_PROJECT_EVIDENCE_INVALID');
    if (!strengths.includes(evidence.strength) || !polarities.includes(evidence.polarity) || optionalEvidence.some(key => evidence[key] !== undefined && typeof evidence[key] !== 'string')) fail('WQ_PROJECT_EVIDENCE_INVALID');
    ids.add(evidence.evidence_id);
    for (const citation of evidence.citations) {
      if (!citation || Object.keys(citation).sort().join(',') !== 'anchor,paper_id,path,sha256') fail('WQ_PROJECT_CITATION_INVALID');
      const paper = snapshot.generation.papers.find(row => row.paper_id === citation.paper_id);
      if (!paper || !adoptedSources?.some(row => row.paper_id === paper.paper_id) || !Object.values(paper.paths).includes(citation.path)) fail('WQ_PROJECT_CITATION_INVALID');
      const current = sha(readCurrentRegisteredBytes(snapshot, citation.path).bytes);
      const docs = getCurrentNote(snapshot, citation.path).sections;
      const anchored = Boolean(citation.anchor) && docs.some(row => row.anchor === citation.anchor || row.span_id === citation.anchor || row.section_id === citation.anchor);
      if (current === citation.sha256 && anchored) continue;
      const details = { evidence_id: evidence.evidence_id, paper_id: citation.paper_id, path: citation.path, anchor: citation.anchor,
        recorded_sha256: citation.sha256, current_sha256: current, reason: current === citation.sha256 ? 'anchor_missing' : anchored ? 'note_changed' : 'note_changed_anchor_missing' };
      if (citationChanges !== 'report') fail('WQ_PROJECT_CITATION_INVALID', details);
      diagnostics.push({ code: 'WQ_PROJECT_CITATION_CHANGED', ...details });
    }
  }
  if (fields.some(field => projectData[field].some(row => !row || typeof row !== 'object' || Array.isArray(row)))) fail('WQ_PROJECT_DATA_INVALID');
  for (const row of [...projectData.ideas, ...projectData.sections, ...projectData.citation_plan]) {
    if (!Array.isArray(row.evidence_ids) || !row.evidence_ids.length || row.evidence_ids.some(id => !ids.has(id))) fail('WQ_PROJECT_EVIDENCE_LINK_INVALID');
  }
  return { ok: true, status: 'structure_verified', diagnostics, scientific_verification: 'not_performed' };
}

export function renderWritingProjectData(data, language) {
  data = structuredClone(data);
  for (const row of data.sections) delete row.sync_baseline;
  const labels = language === 'en' ? ['Evidence register', 'Ideas', 'Discarded ideas', 'Outline and draft', 'Citation plan'] : ['证据登记表', '创新点', '淘汰想法', '论证提纲与正文', '引用计划'];
  const headers = language === 'en' ? ['Evidence ID', 'Sources', 'Polarity', 'Strength', 'Allowed statement', 'Forbidden stronger statement', 'Project relationship']
    : ['证据 ID', '来源锚点', '支持／反驳', '强度', '允许表述', '禁止的更强表述', '与项目关系'];
  headers.push(...(language === 'en' ? ['Method', 'Data', 'Metrics', 'Limitations'] : ['方法', '数据', '指标', '局限']));
  const evidence = '| ' + headers.join(' | ') + ' |\n| ' + headers.map(() => '---').join(' | ') + ' |\n' + data.evidence_records.map(row => '| ' + [cell(row.evidence_id),
    row.citations.map(c => `[${c.paper_id}](<${encodeURI(c.path + '#' + c.anchor)}>)`).join('<br>'), cell(row.polarity), cell(row.strength),
    cell(row.allowed_statement), cell(row.forbidden_statement), cell(row.relationship), ...optionalEvidence.map(key => cell(row[key]))].join(' | ') + ' |').join('\n');
  const metadata = { ...data, visible_fields_version: 1, source_identities: data.evidence_records.map(row => ({ evidence_id: row.evidence_id, citations: row.citations })) };
  delete metadata.evidence_records;
  const marked = (value, path) => {
    if (value && typeof value === 'object') return Object.entries(value).map(([key, item]) => marked(item, [...path, key])).join('\n\n');
    const id = Buffer.from(JSON.stringify(path)).toString('base64url');
    return '<!-- APA_FIELD ' + id + ' -->\n' + (typeof value === 'string' ? value : JSON.stringify(value)) + '\n<!-- APA_FIELD_END ' + id + ' -->';
  };
  const rest = fields.slice(1).map((field, index) => '\n\n## ' + labels[index + 1] + '\n\n' + (data[field].length ? data[field].map((row, rowIndex) => {
    const keys = Object.keys(row).sort((a, b) => {
      const rank = key => ['title', 'section_id', 'idea_id'].includes(key) ? 0 : key === 'outline' ? 1 : ['body', 'draft'].includes(key) ? 3 : 2;
      return rank(a) - rank(b);
    });
    return keys.map(key => {
      const label = { outline: language === 'en' ? 'Outline' : '提纲', evidence_ids: language === 'en' ? 'Evidence' : '证据' }[key] ?? key;
      return (['body', 'draft'].includes(key) ? '' : '**' + label + '**\n\n') + marked(row[key], [field, String(rowIndex), key]);
    }).join('\n\n');
  }).join('\n\n') : (language === 'en' ? 'None recorded.' : '暂无记录。'))).join('');
  return '\n\n<!-- APA_WRITING_PROJECT ' + Buffer.from(JSON.stringify(metadata)).toString('base64') + ' -->\n\n## ' + labels[0]
    + '\n\n' + tableStart + '\n' + evidence + '\n' + tableEnd + rest;
}

export async function exportWritingProjectReferences({ repoRoot, projectId, generationId, format = 'bibtex' } = {}) {
  if (!['bibtex', 'ris'].includes(format)) fail('WQ_REFERENCE_FORMAT_INVALID');
  const { project, snapshot, content_sha256, diagnostics: projectDiagnostics } = await readWritingProject({ repoRoot, projectId, generationId });
  const evidenceIds = new Set(project.citation_plan.flatMap(row => row.evidence_ids));
  const paperIds = new Set(project.evidence_records.filter(row => evidenceIds.has(row.evidence_id)).flatMap(row => row.citations.map(c => c.paper_id)));
  const papers = [...paperIds].map(paperId => {
    const paper = snapshot.generation.papers.find(row => row.paper_id === paperId);
    const bibliography = paper?.reader_presentation ? verifyReadingFirstPresentation(paper,
      readCurrentRegisteredBytes(snapshot, paper.reader_presentation.path).bytes, snapshot.generation).citation?.bibliography : undefined;
    return { paper_id: paperId, bibliography };
  });
  const { content, diagnostics } = exportBibliographyRecords({ papers, language: project.language, format });
  return { ok: true, format, content, generation_id: snapshot.generation_id, project_id: projectId, project_content_sha256: content_sha256, content_sha256: sha(Buffer.from(content)),
    diagnostics: [...projectDiagnostics, ...diagnostics], model_calls: 0 };
}

export function exportBibliographyRecords({ papers, language, format = 'bibtex' } = {}) {
  if (!['bibtex', 'ris'].includes(format)) fail('WQ_REFERENCE_FORMAT_INVALID');
  const records = [], diagnostics = [];
  const clean = value => String(value ?? '').replace(/[\r\n{}\\]/g, ' ');
  for (const { paper_id: paperId, bibliography } of papers) {
    if (!bibliography) { diagnostics.push({ paper_id: paperId, code: 'bibliography_unavailable' }); continue; }
    const title = typeof bibliography.title === 'string' ? bibliography.title : bibliography.title?.[language] ?? bibliography.title?.en ?? bibliography.title?.['zh-CN'];
    const author = bibliography.first_author, year = bibliography.year, doi = bibliography.doi;
    diagnostics.push({ paper_id: paperId, code: 'author_list_incomplete' });
    const citation = bibliography.full_citation ?? bibliography.citation;
    const citationText = typeof citation === 'string' ? citation : citation?.[language] ?? citation?.en ?? citation?.['zh-CN'];
    const values = { title, author, year, doi, note: [citationText, 'Author list incomplete; complete in Zotero.'].filter(Boolean).join(' ') };
    if (format === 'bibtex') records.push('@article{' + clean(paperId) + ',\n' + Object.entries(values).filter(([, v]) => v !== undefined && v !== null).map(([key, value]) => `  ${key} = {${clean(value)}}`).join(',\n') + '\n}');
    else records.push('TY  - JOUR\nID  - ' + clean(paperId) + '\n' + [['TI', title], ['AU', author], ['PY', year], ['DO', doi], ['N1', values.note]].filter(([, v]) => v !== undefined && v !== null).map(([key, value]) => `${key}  - ${clean(value)}`).join('\n') + '\nER  -');
  }
  return { format, content: records.join('\n\n') + '\n', diagnostics };
}

export async function prepareWritingProjectSave({ projectId, projectData, ...inputs } = {}) {
  await validateWritingProjectData({ repoRoot: inputs.repoRoot, generationId: inputs.expectedGenerationId, projectData, adoptedSources: inputs.adoptedSources });
  if (inputs.saveIntent === 'update') {
    const { project } = await readWritingProject({ repoRoot: inputs.repoRoot, projectId, generationId: inputs.expectedGenerationId });
    validateSectionSync(project, projectData);
    if (project.language !== inputs.language) fail('WQ_PROJECT_LANGUAGE_CHANGED');
  }
  const saved = await prepareTopicSave({ ...inputs, ...(projectId ? { topicId: projectId } : {}), projectData });
  return { ...saved, project: saved.topic };
}

export async function prepareWritingProjectUpdate({ projectId, ...inputs } = {}) {
  await readWritingProject({ repoRoot: inputs.repoRoot, projectId, generationId: inputs.generationId });
  return prepareTopicUpdate({ ...inputs, topicId: projectId });
}

export async function executeWritingProjectUpdate({ projectId, ...inputs } = {}) {
  await readWritingProject({ repoRoot: inputs.repoRoot, projectId, generationId: inputs.generationId });
  return executeTopicUpdate({ ...inputs, topicId: projectId });
}

