import { tokenizeQueryText } from '../lib/query-terms.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readCurrentVaultContent, getCurrentNote, assertCurrentVaultContent } from './current-vault-content.mjs';
import { loadApaConfig } from '../lib/apa-config.mjs';
import { paperSourcePath } from '../lib/paper-note-path.mjs';

const hash = value => 'sha256:' + createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const fail = (code, details = {}) => { throw Object.assign(new Error(code), { code, details }); };
export const SYNTHESIS_MODES = ['answer', 'themes', 'dossier', 'compare', 'clues', 'ideas', 'draft', 'review'];
export const MODE_SECTIONS = {
  themes: ['主题概览', '涉及论文、共识、分歧及条件对照、典型方法、证据强度', '有依据的结论', '需要更多证据', '可延伸的线索'],
  dossier: ['概念定义及各论文用法', '测量与操作化', '按年份排列的关键结果', '争议与未决问题', '写作可用表述及适用边界'],
  compare: ['比较矩阵：人群或样本、设计、测量、关键数值及条件、局限、锚点', '关键差异的连贯解释'],
  clues: ['连接路径', '值得注意的原因', '写作用途', '证据缺口'],
  ideas: ['8–12 个发散候选', '3–5 个入选想法', '淘汰清单及原因'],
  draft: ['提纲', '正文', '引用计划', '过度表述检查'],
  review: ['逐段批注', '过度表述检查'],
};
const strengths = { '推测': 0, tentative: 0, '观察': 1, observation: 1, '支持': 2, support: 2, '较强': 3, strong: 3 };
const attribution = ['单篇发现', '多篇一致', '相互冲突', '跨篇推断'];
export const IDEA_LENSES = ['矛盾与张力', '未检验假设', '方法迁移', '边界探查', '组合与拆分', '跨领域类比', '什么变了'];
export const CONTRIBUTION_TYPES = ['新发现', '新方法', '机制解释', '评估与诊断', '资源与数据'];
const convergenceCriteria = ['两句话能否说清', '问题是否真实', '是否过度复杂', '谁受益', '可行性'];
const validLens = value => (Array.isArray(value) ? value.length > 0 && value.every(item => IDEA_LENSES.includes(item)) : IDEA_LENSES.includes(value));
const evidenceTypes = ['直接证据', '背景知识', '方法支持'];
const text = value => typeof value === 'string' && value.trim();
const norm = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}]+/gu, '');

function observedNotes(snapshot) {
  return [...new Set([...snapshot.generation.papers.flatMap(row => Object.values(row.paths)),
    ...snapshot.generation.shared_nodes.map(row => row.path), ...(snapshot.generation.topics ?? []).map(row => row.path)])].map(path => {
    try { return { path, sha256: getCurrentNote(snapshot, path).sha256 }; }
    catch { return { path, unavailable: true }; }
  });
}

/** Keep navigation and relationships in the prompt; full prose stays at registered paths. */
export function compactKnowledge(knowledge, mode, { paperIds } = {}) {
  const omitted = {};
  // Rows touching the selected or seed papers fill the bounded slots first; the rest keep their stable order.
  const priority = new Set(paperIds?.length ? paperIds : mode === 'clues' ? knowledge.seed_papers ?? [] : []);
  const relevant = row => (row.paper_ids ?? []).some(id => priority.has(id));
  const take = (rows = [], count, key) => {
    if (rows.length > count) omitted[key] = rows.length - count;
    return (priority.size ? [...rows.filter(relevant), ...rows.filter(row => !relevant(row))] : rows).slice(0, count);
  };
  const node = row => ({ entity_id: row.entity_id, title: row.title, path: row.path, sha256: row.sha256, source_kind: row.source_kind, paper_ids: row.paper_ids });
  const sections = (rows = []) => [...new Map(rows.map(row => [row.anchor, { anchor: row.anchor, module: row.module }])).values()];
  const result = { status: knowledge.status, generation_id: knowledge.generation_id, content_hash: knowledge.content_hash,
    diagnostics: knowledge.diagnostics, retrieval: { command: mode === 'dossier' ? 'dossier --node <entity_id>' : mode === 'clues' ? 'clues --from <paper|node|question>' : 'landscape',
      entrypoint: 'node scripts/apa-query.mjs', full_text: 'Read registered path and anchor in this task before adopting a claim.' }, omitted_counts: omitted,
    ...(priority.size ? { prioritized_paper_ids: [...priority] } : {}) };
  if (mode === 'dossier') {
    result.node = knowledge.node ? node(knowledge.node) : null;
    result.papers = (knowledge.papers ?? []).map(row => ({ paper_id: row.paper_id, year: row.year, path: row.path, sha256: row.sha256, sections: sections(row.sections) }));
  } else if (mode === 'clues') {
    result.seed_papers = knowledge.seed_papers;
    result.nodes = take(knowledge.adjacent_nodes, 30, 'nodes').map(node);
    result.papers = (knowledge.papers ?? []).map(row => ({ paper_id: row.paper_id, path: row.path, sha256: row.sha256,
      modules: Object.fromEntries(Object.entries(row.modules ?? {}).map(([key, module]) => [key, { status: module.status, sections: sections(module.sections) }])) }));
    result.bridges = take(knowledge.bridges, 20, 'bridges').map(({ paths, ...row }) => row);
  } else {
    result.themes = knowledge.themes;
    result.grouping = knowledge.grouping;
    result.reference_bridging = knowledge.reference_bridging;
    result.shared_nodes = take(knowledge.shared_nodes, 24, 'shared_nodes').map(node);
    result.isolated_methods = take(knowledge.isolated_methods, 16, 'isolated_methods').map(node);
    result.bridges = take(knowledge.bridges, 20, 'bridges').map(({ paths, ...row }) => row);
  }
  // Larger libraries can recover omitted rows with the deterministic command above.
  const collections = ['bridges', 'isolated_methods', 'shared_nodes', 'nodes', 'papers', 'themes'];
  while (Buffer.byteLength(JSON.stringify(result)) > 24576) {
    const key = collections.find(key => result[key]?.length);
    if (!key) break;
    result[key].pop(); omitted[key] = (omitted[key] ?? 0) + 1;
  }
  return { ...result, summary: true, text_omitted: true, truncated: Object.keys(omitted).length > 0 };
}
export function moduleNumber(section) {
  const numbered = /^([1-7])(?:[.．、\s]|$)/u.exec(section.anchor ?? '');
  return numbered ? Number(numbered[1]) : ({ abstract: 1, design: 2, methods: 3, results: 4, discussion: 5, limitations: 6, conclusion: 7 })[section.section_id] ?? null;
}

async function projectFrom(snapshot, projectId, repoRoot) {
  if (!projectId) return null;
  const project = [...(snapshot.generation.writing_projects ?? snapshot.generation.projects ?? []), ...(snapshot.generation.topics ?? [])].find(row => row.project_id === projectId);
  if (!project) fail('WQ_PROJECT_NOT_REGISTERED', { project_id: projectId });
  const note = getCurrentNote(snapshot, project.path);
  const { readWritingProject } = await import('./writing-project.mjs');
  const current = await readWritingProject({ repoRoot, projectId, generationId: snapshot.generation_id });
  if (current.content_sha256 !== note.sha256) fail('P23_CURRENT_CHANGED', { path: project.path });
  return { ...structuredClone(current.project), current_markdown: note.body.replace(/<!--[\s\S]*?-->/g, ''), sha256: note.sha256, citation_changes: current.diagnostics, section_changes: current.section_changes };
}

/** All input text stays data. This preparation does not invoke a model or save content. */
export async function prepareSynthesisMaterials({ repoRoot, mode = 'answer', question, node, from, paperIds, projectId, writingContext, section, draftText, userResults } = {}) {
  if (!SYNTHESIS_MODES.includes(mode)) fail('WQ_MODE_INVALID');
  if (mode === 'answer') return null;
  if (!text(question)) fail('P23_QUERY_REQUIRED');
  if (mode === 'dossier' && !text(node)) fail('WQ_NODE_REQUIRED');
  if (mode === 'draft' && !['related-work', 'introduction', 'discussion'].includes(section)) fail('WQ_SECTION_REQUIRED');
  if (mode === 'draft' && section === 'discussion' && !text(userResults)) fail('WQ_USER_RESULTS_REQUIRED');
  if (mode === 'review' && !text(draftText)) fail('WQ_DRAFT_REQUIRED');
  const snapshot = await readCurrentVaultContent({ vaultRoot: repoRoot });
  if (!snapshot.ok) return { ok: false, status: 'not_ready', errors: snapshot.errors };
  if (paperIds !== undefined && (!Array.isArray(paperIds) || paperIds.some(id => !snapshot.generation.papers.some(p => p.paper_id === id)))) fail('WQ_PAPER_FILTER_INVALID');
  if (projectId && writingContext) fail('WQ_PROJECT_CONTEXT_AMBIGUOUS');
  let project = await projectFrom(snapshot, projectId, repoRoot);
  if (writingContext) {
    const { validateWritingProjectData } = await import('./writing-project.mjs');
    await validateWritingProjectData({ repoRoot, generationId: snapshot.generation_id, projectData: writingContext.projectData, adoptedSources: writingContext.adoptedSources });
    project = { ...structuredClone(writingContext.projectData), question, status: 'unsaved_context', ...(text(writingContext.current_markdown) ? { current_markdown: writingContext.current_markdown } : {}) };
  }
  if (['draft', 'review'].includes(mode) && !project) fail('WQ_PROJECT_CONTEXT_REQUIRED');
  const map = await import('./library-map.mjs');
  const options = { vaultRoot: repoRoot };
  const inventory = await map.libraryInventory(options);
  let knowledge;
  if (mode === 'dossier') knowledge = await map.libraryDossier({ ...options, node });
  else if (mode === 'clues') knowledge = await map.libraryClues({ ...options, from: from ?? question });
  else knowledge = await map.libraryLandscape(options);
  if (knowledge.generation_id && knowledge.generation_id !== snapshot.generation_id) fail('P24_GENERATION_CHANGED');
  const relevant = paperIds?.length ? new Set(paperIds) : null;
  const sourceNotes = [];
  for (const paper of snapshot.generation.papers.filter(paper => !relevant || relevant.has(paper.paper_id))) {
    const path = paperSourcePath(paper);
    let note;
    try { note = getCurrentNote(snapshot, path); } catch { continue; }
    const selected = note.sections.filter(row => mode === 'ideas' ? [5, 6, 7].includes(moduleNumber(row)) : moduleNumber(row));
    sourceNotes.push({ paper_id: paper.paper_id, path, sha256: note.sha256,
      sections: selected.map(row => ({ anchor: row.anchor, module: moduleNumber(row) })) });
  }
  const writingGuides = [];
  const registeredConflicts = [];
  if (mode === 'ideas') for (const topic of snapshot.generation.topics ?? []) {
    let note;
    try { note = getCurrentNote(snapshot, topic.path); } catch { continue; }
    for (const row of note.sections.filter(row => /相互冲突|分歧|contradict|conflict/i.test(row.content))) {
      registeredConflicts.push({ topic_id: topic.topic_id, project_id: topic.project_id, path: topic.path, anchor: row.anchor,
        sha256: note.sha256, excerpt: row.content.slice(0, 800), interpretation: 'requires_same_task_reading' });
    }
  }
  const config = loadApaConfig({ repoRoot }).config;
  const allowed = ['nature-writing', 'nature-polishing', 'nature-shared', 'humanizer', 'humanizer-zh', 'stss',
    ...(mode === 'ideas' ? ['brainstorming-research-ideas', 'creative-thinking-for-research'] : [])];
  for (const name of allowed) {
    const guide = config.writing_skills?.[name];
    if (!guide?.enabled) continue;
    const path = resolve(repoRoot, guide.path);
    try { writingGuides.push({ name, path, sha256: hash(readFileSync(path, 'utf8')) }); }
    catch { fail('APA_SKILL_UNAVAILABLE', { name, path }); }
  }
  const observed = observedNotes(snapshot);
  assertCurrentVaultContent(snapshot, { paths: observed.filter(row => !row.unavailable).map(row => row.path) });
  const inventorySummary = { status: inventory.status, generation_id: inventory.generation_id, content_hash: inventory.content_hash,
    papers: (inventory.papers ?? []).map(row => ({ paper_id: row.paper_id, title: row.title, year: row.bibliography?.year, first_author: row.bibliography?.first_author })) };
  const result = { ok: true, mode, generation_id: snapshot.generation_id, inventory: inventorySummary, knowledge: compactKnowledge(knowledge, mode, { paperIds }), source_notes: sourceNotes,
    ...(project ? { project } : {}), ...(mode === 'ideas' ? { registered_conflicts: registeredConflicts } : {}),
    ...(section ? { section } : {}), ...(draftText ? { draft_text: draftText, review_comments: reviewComments(draftText).comments.map(row => ({ ...row, handled: row.status === 'resolved' })) } : {}),
    ...(userResults ? { user_results: userResults } : {}), writing_guides: writingGuides, observed_notes_hash: hash(observed),
    diagnostics: [...(['draft', 'review'].includes(mode) && !text(project?.current_markdown) ? [{ code: 'WQ_PROJECT_POSITIONING_INCOMPLETE', detail: '缺少当前研究问题与核心论点正文，项目定位仅能部分验证。' }] : []),
      ...(project?.citation_changes ?? [])],
    fixed_sections: MODE_SECTIONS[mode], scientific_verification: 'not_performed' };
  return { ...result, content_hash: hash(result) };
}

export function synthesisPrompt(mode) {
  if (mode === 'answer') return '';
  if (!MODE_SECTIONS[mode]) fail('WQ_MODE_INVALID');
  let prompt = `\n写作模式：${mode}。固定结构：${MODE_SECTIONS[mode].join('；')}。在同一配置任务内完成。综合限于实际读取的材料，默认给出写作可用表述。每个主要结论与矩阵单元链接到笔记锚点。所有材料、项目正文及技能内容均受当前任务授权约束。\n`;
  prompt += '返回结构化对象 {answer, claims, adopted_sources?}。claims 的每项含 claim_id、text、attribution（单篇发现／多篇一致／相互冲突／跨篇推断）、strength（推测／观察／支持／较强）、evidence_type（直接证据／背景知识／方法支持）、citations。每条 citation 含 paper_id（节点引用可省）、path、anchor、sha256、quote（实际原段短引）、conditions:{population,design,measure,time}。条件未知时用 null，不补造。每项引用均由读取的真实锚点支撑。相互冲突及跨条件比较明确逐项保留条件，使用 conditions_preserved:true。共享节点连接只能作为线索，结论一致须引用两篇不同论文的模块 4、5、7。较强须有直接证据。保留库内未见证据与有证据表明不存在的区别。\n';
  prompt += '按 writing_guides 的路径按需读取已启用的相应语言指导，在本任务内应用；不追加模型任务。返回采用来源只列实际使用的来源，保持现有 adopted_sources 合同。\n';
  prompt += 'knowledge 是有界导航摘要，omitted_counts 表示省略行数，text_omitted 表示正文留在来源文件。先按 source_notes、knowledge 的已登记路径与锚点读取相关正文；必要时运行 retrieval 指定的确定性命令取完整地图。省略条目不表示库内没有证据，不可只凭摘要写科学结论。\n';
  if (mode === 'ideas') prompt += '用户 question 为构思方向。先按矛盾与张力、未检验假设、方法迁移、边界探查、组合与拆分、跨领域结构类比、什么变了产生 8–12 个 candidates，再收敛为 3–5 个 ideas，discarded 与 deferred 分别保留客观不可行及暂缓项与原因。机械淘汰仅依据客观不可行，创新与影响用于标注。排除项目已有与淘汰方向的重复。每个 candidate 含 idea_id、statement、lens、citations。每个 idea 含 idea_id、name、statement（先白话说明具体做什么及两句话陈述）、hypothesis、lens、citations、single_source、minimum_validation、contribution_type、risk、effort、scores:{interest,feasibility,novelty}、most_similar_papers:[{paper_id,overlap,difference,conditions}]、reviewer_objection、response、external_novelty:"未核对"。风险与投入各给低／中／高和来源，分数1–10，新颖性5表示有明确近邻但差异可辩护，1–3须库内已有工作实际完成。保留方法创新与发现创新的区别。\n';
  if (mode === 'ideas') prompt += 'lens 必须取矛盾与张力／未检验假设／方法迁移／边界探查／组合与拆分／跨领域类比／什么变了之一或这些值的数组。contribution_type 必须取新发现／新方法／机制解释／评估与诊断／资源与数据。risk、effort 各为 {level:低或中或高,source:具体来源}。每条候选及入选 citation 添加实际 quote 与 claim_origin:author／analyst／cross-paper；分析者推导不能归为作者提议。most_similar_papers 每项含 conditions 字符串，未知须说明。比较与核心贡献直接重叠的各篇近邻；组合来源中未列为近邻的论文说明其角色及未列理由，不要求所有背景来源均为近邻。discarded 仅收客观不可行项，含 objective_infeasibility:true、criterion:可行性、reason；deferred 收保留项，含 criterion（两句话能否说清／问题是否真实／是否过度复杂／谁受益／可行性）、reason、trigger。各未入选候选恰归一类。实际采用模块5／6、W2桥接／孤立方法时附真实锚点；material_usage.unused 记录未用种类及原因。7.2可作为原料，说明新增推导，不能将旧方向直接当新贡献。\n';
  if (mode === 'draft' || mode === 'review') prompt += '项目 evidence_records 提供 evidence_id、strength、allowed_statement、forbidden_statement。current_markdown（如有）是当前可见正文；研究问题和人工论点依当前正文理解，保留与登记元数据的具体差异。返回 statements:[{text,evidence_ids,strength,attribution}]、outline、citation_plan，草稿中的每处引用使用 [@evidence_id]，禁止使用未登记证据。每句科学表述与登记强度、允许和禁止表述对照，将问题放入 overstatements 数组，不加复核任务。正文与提纲相互对应，修改已有内容保持范围。收到 WQ_SECTION_OUTLINE_BODY_DIVERGED 时同步 pending_side；确实无需修改时在对应 section.sync_reason 说明理由，逐节说明本次改动。diagnostics 中的 WQ_PROJECT_CITATION_CHANGED 表示被引笔记在项目保存后被修改：采用该证据前重读当前锚点，当前正文不再支持登记表述时不使用该证据并在 answer 中说明。\n';
  if (mode === 'draft' || mode === 'review') prompt += '每个 statement 明确记录强度和归属，复合句拆成单一主张；草稿通过 render-result 将标注显示在正文，review 只在批注中说明问题并保留原文。逐项读取具体 allowed_statement、forbidden_statement、limitations；不同配体（如RSPO2结构与RSPO1变异）、物种、模型及实验条件不得直接外推。登记为通用措辞时说明审查覆盖不足。项目正文缺研究问题或核心论点时说明定位不完整。\n';
  if (mode === 'draft') prompt += 'related-work 按与本文相关度排序的主题组织，每段主题句、2–5篇代表工作、比较和过渡，以本文定位收尾。introduction 沿重要性→已知→缺口→贡献，每环指证据。discussion 仅比较用户提供的 user_results 与库内结果，解释一致、冲突、可能机制和局限。材料不足如实说明。\n';
  if (mode === 'review') prompt += '返回 draft_text 原字节及 comments:[{paragraph,comment,status:"open"}]，不改原文；answer 中新增批注使用 %% [open] 意见 %%，紧贴对应段落之后，paragraph 从1开始；comments 与新增批注按顺序逐条对应，无新意见时为空数组。保留所有旧批注及其位置和状态，review_comments 中 handled:true 的意见已处理，不重复提出；用户可改为 [resolved]。\n';
  return prompt;
}

function citationIndex(snapshot) {
  const result = new Map();
  const papers = new Map(snapshot.generation.papers.flatMap(p => Object.values(p.paths).map(path => [path, p.paper_id])));
  for (const row of [...snapshot.generation.papers.flatMap(p => Object.values(p.paths).map(path => ({ path }))), ...snapshot.generation.shared_nodes]) {
    let note;
    try { note = getCurrentNote(snapshot, row.path); } catch { continue; }
    for (const section of note.sections) result.set(row.path + '#' + (section.anchor ?? ''), { ...section, path: row.path, paper_id: papers.get(row.path),
      module: moduleNumber(section), sha256: note.sha256, source_kind: note.fm.source_kind,
      evidence_type: papers.has(row.path) ? '直接证据' : note.fm.source_kind === 'method-background' ? '背景知识' : '方法支持' });
  }
  return result;
}

export function checkStructuredClaims({ diagnostics = [], claims, evidence, paperIds = [] } = {}) {
  const issues = [];
  const report = (claim, code, details = {}) => issues.push({ claim_id: claim?.claim_id ?? claim?.idea_id ?? null, code, ...details });
  if (!Array.isArray(claims) || !claims.length) return [{ code: 'WQ_CLAIMS_REQUIRED', claim_id: null }];
  const index = evidence instanceof Map ? evidence : new Map((evidence ?? []).map(row => [row.path + '#' + (row.anchor ?? ''), row]));
  for (const claim of claims) {
    if (!claim || !text(claim.claim_id) || !text(claim.text) || !attribution.includes(claim.attribution)
      || !Object.hasOwn(strengths, claim.strength) || !evidenceTypes.includes(claim.evidence_type)) { report(claim, 'WQ_CLAIM_FIELDS'); continue; }
    const refs = [];
    if (!Array.isArray(claim.citations) || !claim.citations.length) report(claim, 'WQ_CITATIONS_REQUIRED');
    for (const citation of claim.citations ?? []) {
      const row = index.get(citation.path + '#' + (citation.anchor ?? ''));
      if (!row || citation.sha256 !== row.sha256 || (citation.paper_id && citation.paper_id !== row.paper_id)) { report(claim, 'WQ_CITATION_INVALID', { citation }); continue; }
      if (!text(citation.quote) || !norm(row.content).includes(norm(citation.quote))) report(claim, 'WQ_QUOTE_UNSUPPORTED', { path: citation.path, anchor: citation.anchor });
      for (const [key, value] of Object.entries(citation.conditions ?? {})) if (value && !norm(row.content).includes(norm(value))) report(claim, 'WQ_CONDITION_UNSUPPORTED', { key, value });
      refs.push({ ...row, citation });
    }
    const distinct = new Set(refs.filter(row => row.paper_id).map(row => row.paper_id));
    if (claim.attribution !== '单篇发现' && distinct.size < 2) report(claim, 'WQ_CROSS_PAPER_COUNT');
    if (['多篇一致', '相互冲突'].includes(claim.attribution)
      && new Set(refs.filter(row => row.paper_id && [4, 5, 7].includes(row.module)).map(row => row.paper_id)).size < 2) report(claim, 'WQ_FINDING_MODULE_REQUIRED');
    if (strengths[claim.strength] === 3 && !refs.some(row => row.evidence_type === '直接证据') ) report(claim, 'WQ_DIRECT_EVIDENCE_REQUIRED');
    if (claim.evidence_type === '直接证据' && refs.length && refs.every(row => row.evidence_type !== '直接证据')) report(claim, 'WQ_EVIDENCE_TYPE_MISMATCH');
    if (distinct.size >= 2 && ['多篇一致', '相互冲突'].includes(claim.attribution) && refs.every(row => !Object.values(row.citation.conditions ?? {}).some(value => text(value)))) diagnostics.push({ code: 'WQ_CONDITIONS_UNREPORTED', claim_id: claim.claim_id });
    const conditions = new Set(refs.map(row => JSON.stringify(row.citation.conditions ?? {})));
    if (distinct.size >= 2 && conditions.size > 1 && claim.conditions_preserved !== true) report(claim, 'WQ_CONDITIONS_MERGED');
    const speculative = /(?:\b(?:hypothes[ei][sz]|speculat|might|may|could)\b|推测|尚待验证|可能)/i;
    if (strengths[claim.strength] >= 2 && refs.length && refs.every(row => speculative.test(row.citation.quote ?? ''))) report(claim, 'WQ_SPECULATION_PROMOTED');
  }
  return issues;
}

export function checkIdeas({ output, evidence, paperIds = [], existingIdeas = [] } = {}) {
  const issues = [], add = (code, idea_id = null) => issues.push({ code, idea_id });
  const candidates = output?.candidates, ideas = output?.ideas;
  if (!Array.isArray(candidates) || candidates.length < 8 || candidates.length > 12) add('WQ_CANDIDATE_COUNT');
  if (!Array.isArray(ideas) || ideas.length < 3 || ideas.length > 5) add('WQ_IDEA_COUNT');
  const index = evidence instanceof Map ? evidence : new Map((evidence ?? []).map(row => [row.path + '#' + (row.anchor ?? ''), row]));
  const checkCitation = (citation, id) => {
    const row = index.get(citation.path + '#' + (citation.anchor ?? ''));
    if (!text(citation.quote) || !row || !norm(row.content).includes(norm(citation.quote))) add('WQ_IDEA_QUOTE_UNSUPPORTED', id);
    if (!['author', 'analyst', 'cross-paper'].includes(citation.claim_origin)) add('WQ_CLAIM_ORIGIN_REQUIRED', id);
    if (citation.claim_origin === 'author' && /analyst[- ]derived|分析者推导|分析者提出/i.test((row?.content ?? '').split(/\n\s*\n/).find(part => text(citation.quote) && norm(part).includes(norm(citation.quote))) ?? '')) add('WQ_CLAIM_ORIGIN_MISMATCH', id);
  };
  const seen = new Set(existingIdeas.map(row => norm(row.statement ?? row.name)));
  const ids = new Set();
  for (const item of candidates ?? []) {
    if (!text(item.idea_id) || ids.has(item.idea_id) || !text(item.statement) || !validLens(item.lens)) add('WQ_CANDIDATE_FIELDS', item.idea_id);
    if (!validLens(item.lens)) add('WQ_IDEA_LENS', item.idea_id);
    ids.add(item.idea_id);
    if (!Array.isArray(item.citations) || !item.citations.length) add('WQ_CANDIDATE_CITATIONS_REQUIRED', item.idea_id);
    for (const citation of item.citations ?? []) {
      checkCitation(citation, item.idea_id);
      const row = index.get(citation.path + '#' + (citation.anchor ?? ''));
      if (!row || row.sha256 !== citation.sha256 || (citation.paper_id && row.paper_id !== citation.paper_id)) add('WQ_IDEA_CITATION_INVALID', item.idea_id);
    }
    const key = norm(item.statement);
    if (seen.has(key)) add('WQ_IDEA_DUPLICATE', item.idea_id);
    seen.add(key);
  }
  for (const idea of ideas ?? []) {
    for (const key of ['idea_id', 'name', 'statement', 'hypothesis', 'lens', 'minimum_validation', 'contribution_type', 'risk', 'effort', 'reviewer_objection', 'response']) if (!text(idea[key]) && !(idea[key] && typeof idea[key] === 'object')) add('WQ_IDEA_FIELD_' + key, idea.idea_id);
    if (!validLens(idea.lens)) add('WQ_IDEA_LENS', idea.idea_id);
    if (!CONTRIBUTION_TYPES.includes(idea.contribution_type)) add('WQ_CONTRIBUTION_TYPE', idea.idea_id);
    for (const key of ['risk', 'effort']) if (!['低', '中', '高'].includes(idea[key]?.level) || !text(idea[key]?.source)) add('WQ_RISK_EFFORT', idea.idea_id);
    if (!ids.has(idea.idea_id)) add('WQ_IDEA_NOT_CANDIDATE', idea.idea_id);
    if (candidates?.find(row => row.idea_id === idea.idea_id)?.statement !== idea.statement) add('WQ_IDEA_CANDIDATE_MISMATCH', idea.idea_id);
    if (idea.external_novelty !== '未核对') add('WQ_EXTERNAL_NOVELTY_UNVERIFIED', idea.idea_id);
    if (['interest', 'feasibility', 'novelty'].some(key => !Number.isFinite(idea.scores?.[key]) || idea.scores[key] < 1 || idea.scores[key] > 10)) add('WQ_IDEA_SCORES', idea.idea_id);
    const cited = new Set();
    for (const citation of idea.citations ?? []) {
      checkCitation(citation, idea.idea_id);
      const row = index.get(citation.path + '#' + (citation.anchor ?? ''));
      if (!row || row.sha256 !== citation.sha256 || row.paper_id !== citation.paper_id) add('WQ_IDEA_CITATION_INVALID', idea.idea_id);
      else if (row.paper_id) cited.add(row.paper_id);
    }
    if (!cited.size) add('WQ_IDEA_EVIDENCE_REQUIRED', idea.idea_id);
    if (idea.single_source !== (cited.size === 1)) add('WQ_SINGLE_SOURCE_MISMATCH', idea.idea_id);
    if (!Array.isArray(idea.most_similar_papers) || !idea.most_similar_papers.length || idea.most_similar_papers.some(row => !paperIds.includes(row.paper_id) || !text(row.overlap) || !text(row.difference))) add('WQ_NEAREST_PAPER_INVALID', idea.idea_id);
    for (const nearest of idea.most_similar_papers ?? []) {
      if (!text(nearest.conditions)) add('WQ_NEAREST_CONDITIONS', idea.idea_id);
      if (/已提出|作者提出|authors? proposed/i.test(nearest.overlap ?? '') && !(idea.citations ?? []).some(c => c.paper_id === nearest.paper_id && c.claim_origin === 'author')) add('WQ_NEAREST_ORIGIN_MISMATCH', idea.idea_id);
    }
    if (idea.scores?.novelty <= 3 && !idea.most_similar_papers?.some(row => row.already_performed === true)) add('WQ_LOW_NOVELTY_REQUIRES_PRIOR_WORK', idea.idea_id);
  }
  const selected = new Set((ideas ?? []).map(row => row.idea_id)), discarded = output?.discarded ?? [];
  if (selected.size !== (ideas ?? []).length) add('WQ_SELECTED_IDEA_DUPLICATE');
  const deferred = output?.deferred ?? [];
  const dispositions = [...discarded, ...deferred];
  for (const row of dispositions) {
    if (!ids.has(row.idea_id) || selected.has(row.idea_id) || dispositions.filter(item => item.idea_id === row.idea_id).length !== 1) add('WQ_CONVERGENCE_PARTITION', row.idea_id);
    if (!text(row.reason) || !convergenceCriteria.includes(row.criterion) || (discarded.includes(row) ? row.objective_infeasibility !== true || row.criterion !== '可行性' : !text(row.trigger))) add('WQ_CONVERGENCE_REASON', row.idea_id);
  }
  for (const item of candidates ?? []) if (!selected.has(item.idea_id) && !dispositions.some(row => row.idea_id === item.idea_id)) add('WQ_DISCARD_REASON_REQUIRED', item.idea_id);
  return issues;
}

export function reviewComments(value = '') {
  let prose = '', previous = 0;
  const comments = [];
  for (const match of value.matchAll(/%%[\s\S]*?%%/g)) {
    prose += value.slice(previous, match.index);
    const parsed = /^%%\s*\[(open|resolved)\]\s*([\s\S]*?)\s*%%$/.exec(match[0]);
    comments.push({ raw: match[0], offset: prose.length, status: parsed?.[1] ?? 'legacy', comment: parsed?.[2] ?? match[0].slice(2, -2).trim() });
    previous = match.index + match[0].length;
  }
  return { prose: prose + value.slice(previous), comments };
}
function checkReview(output, originalDraft) {
  const issues = [], old = reviewComments(originalDraft), current = reviewComments(output?.answer ?? '');
  if (old.prose !== current.prose) issues.push({ code: 'WQ_REVIEW_CHANGED_ANSWER' });
  const remaining = [...current.comments];
  let lastOldIndex = -1;
  for (const comment of old.comments) {
    const index = remaining.findIndex(row => row.raw === comment.raw && row.offset === comment.offset);
    const currentIndex = current.comments.findIndex(row => row.raw === comment.raw && row.offset === comment.offset);
    if (index < 0 || currentIndex < lastOldIndex) issues.push({ code: 'WQ_REVIEW_OLD_COMMENT_CHANGED' });
    if (index >= 0) remaining.splice(index, 1);
    lastOldIndex = currentIndex;
  }
  if (!Array.isArray(output?.comments) || output.comments.length !== remaining.length) issues.push({ code: 'WQ_REVIEW_COMMENTS_MISMATCH' });
  const paragraphs = [...old.prose.matchAll(/\S[\s\S]*?(?=\r?\n[ \t]*\r?\n|$)/g)].map(row => ({ end: row.index + row[0].trimEnd().length }));
  for (const [i, comment] of remaining.entries()) {
    const row = output?.comments?.[i];
    if (!row || comment.status !== 'open' || row.status !== 'open' || row.comment !== comment.comment) issues.push({ code: 'WQ_REVIEW_COMMENTS_MISMATCH' });
    const end = paragraphs[row?.paragraph - 1]?.end;
    if (!Number.isInteger(row?.paragraph) || end === undefined || comment.offset < end || old.prose.slice(end, comment.offset).trim()) issues.push({ code: 'WQ_REVIEW_COMMENT_POSITION' });
  }
  return issues;
}

export function checkDraft({ output, evidenceRecords = [], originalDraft, review = false, diagnostics = [] } = {}) {
  const issues = [], records = new Map(evidenceRecords.map(row => [row.evidence_id, row]));
  const answer = typeof output?.answer === 'string' ? output.answer : '';
  if (!review && (!Array.isArray(output?.outline) || !output.outline.length || !Array.isArray(output?.citation_plan) || !output.citation_plan.length || !Array.isArray(output?.overstatements))) issues.push({ code: 'WQ_DRAFT_OUTPUT_FIELDS' });
  if (review && output?.draft_text !== originalDraft) issues.push({ code: 'WQ_REVIEW_CHANGED_PROSE' });
  if (review) issues.push(...checkReview(output, originalDraft));
  const inline = [...answer.matchAll(/\[@([^\]]+)\]/g)].map(match => match[1]);
  for (const id of inline) if (!records.has(id)) issues.push({ code: 'WQ_DRAFT_CITATION_UNREGISTERED', evidence_id: id });
  if (!Array.isArray(output?.statements) || !output.statements.length) issues.push({ code: 'WQ_DRAFT_STATEMENTS_REQUIRED' });
  const boundCitations = new Set();
  for (const statement of output?.statements ?? []) {
    if (!attribution.includes(statement.attribution)) issues.push({ code: 'WQ_DRAFT_ATTRIBUTION', text: statement.text });
    const refs = (statement.evidence_ids ?? []).map(id => records.get(id));
    if (!text(statement.text) || !answer.includes(statement.text) || !refs.length || refs.some(row => !row)) { issues.push({ code: 'WQ_DRAFT_EVIDENCE_REQUIRED', text: statement.text }); continue; }
    const following = answer.slice(answer.indexOf(statement.text) + statement.text.length).match(/^(?:\s*\[@[^\]]+\])*/)?.[0] ?? '';
    const actualIds = [...new Set([...(statement.text + following).matchAll(/\[@([^\]]+)\]/g)].map(match => match[1]))].sort();
    actualIds.forEach(id => boundCitations.add(id));
    if (JSON.stringify(actualIds) !== JSON.stringify([...new Set(statement.evidence_ids)].sort())) issues.push({ code: 'WQ_DRAFT_CITATION_MISMATCH', text: statement.text });
    const allowed = Math.max(...refs.map(row => strengths[row.strength] ?? -1));
    if (!Object.hasOwn(strengths, statement.strength) || strengths[statement.strength] > allowed) issues.push({ code: 'WQ_DRAFT_STRENGTH_EXCEEDED', text: statement.text });
    if (refs.every(row => strengths[row.strength] === 0) && /已[经有]?发现|证实|证明|\b(?:demonstrated|established|proved)\b/i.test(statement.text)) issues.push({ code: 'WQ_SPECULATION_AS_FINDING', text: statement.text });
    const papers = new Set(refs.flatMap(row => (row.citations ?? []).map(c => c.paper_id)).filter(Boolean));
    if (papers.size < 2 && (/领域共识|一致认为|\bconsensus\b/i.test(statement.text) || statement.attribution === '多篇一致')) issues.push({ code: 'WQ_SINGLE_PAPER_AS_CONSENSUS', text: statement.text });
    if (papers.size < 2 && ['多篇一致', '相互冲突', '跨篇推断'].includes(statement.attribution)) issues.push({ code: 'WQ_DRAFT_CROSS_PAPER_COUNT', text: statement.text, attribution: statement.attribution });
    for (const row of refs) if (text(row.forbidden_statement)) {
      if (norm(statement.text).includes(norm(row.forbidden_statement))) issues.push({ code: 'WQ_FORBIDDEN_STATEMENT', evidence_id: row.evidence_id });
      else {
        const right = new Set(tokenizeQueryText(row.forbidden_statement));
        // Named RSPO1 paraphrases overlap by 0.80/0.53; 0.5 retains both.
        // Scope limitation words to the compared clause. A negative forbidden statement
        // is itself the target; its negation must not suppress a matching paraphrase.
        const negative = value => /尚未|无法|仍需|不能|不会|不是|不影响|不支持|不足以|并不|并未|未见|未能|没有|无证据|\b(?:not(?!\s+only\b)|cannot|unproven)\b/i.test(value);
        const clauses = statement.text.split(/但(?:是)?|然而|[,，；;。!?！？]|\b(?:but|however)\b/i).filter(text);
        const eligible = clauses.filter(clause => negative(row.forbidden_statement) || !negative(clause));
        for (const clause of [...eligible, eligible.join(' ')]) {
          const left = new Set(tokenizeQueryText(clause));
          const overlap = [...right].filter(term => left.has(term)).length / Math.max(1, right.size);
          if (overlap > 0.5 && (negative(row.forbidden_statement) || !negative(clause))) {
            diagnostics.push({ code: 'WQ_FORBIDDEN_STATEMENT_SIMILAR', evidence_id: row.evidence_id, text: statement.text, overlap });
            break;
          }
        }
      }
    }
    for (const row of refs) if (/(可能|相关|关联|推测|\bmay\b|\bmight\b|associat|correlat)/i.test(row.allowed_statement ?? '')
      && /(导致|引起|确立|证明|证实|\bcauses?\b|\bproves?\b|\bestablished\b)/i.test(statement.text)) issues.push({ code: 'WQ_ALLOWED_WORDING_EXCEEDED', evidence_id: row.evidence_id, allowed_statement: row.allowed_statement });
  }
  for (const id of inline) if (!boundCitations.has(id)) issues.push({ code: 'WQ_DRAFT_CITATION_UNBOUND', evidence_id: id });
  return issues;
}

export async function validateSynthesisOutput({ repoRoot, generationId, mode, output, materials } = {}) {
  if (!materials && ['draft', 'review'].includes(mode)) fail('WQ_MATERIALS_REQUIRED');
  if (materials) {
    const { content_hash, ...body } = materials;
    if (content_hash !== hash(body)) fail('WQ_MATERIALS_CHANGED');
  }
  const snapshot = await readCurrentVaultContent({ vaultRoot: repoRoot });
  if (!snapshot.ok || snapshot.generation_id !== generationId) fail('P24_GENERATION_CHANGED');
  if (materials?.observed_notes_hash && hash(observedNotes(snapshot)) !== materials.observed_notes_hash) fail('P23_CURRENT_CHANGED');
  if (materials?.project?.path && getCurrentNote(snapshot, materials.project.path).sha256 !== materials.project.sha256) fail('P23_CURRENT_CHANGED', { path: materials.project.path });
  for (const row of [...(materials?.source_notes ?? []), ...(materials?.observed_notes ?? [])]) if (getCurrentNote(snapshot, row.path).sha256 !== row.sha256) fail('P23_CURRENT_CHANGED', { path: row.path });
  const evidence = citationIndex(snapshot), paperIds = snapshot.generation.papers.map(row => row.paper_id);
  const diagnostics = materials ? [...(materials.diagnostics ?? [])] : [{ code: 'WQ_MATERIALS_NOT_CHECKED' }];
  const issues = ['draft', 'review'].includes(mode) ? checkDraft({ output, diagnostics,
    evidenceRecords: materials?.project?.evidence_records ?? [], originalDraft: materials?.draft_text, review: mode === 'review' })
    : mode === 'ideas' ? checkIdeas({ output, evidence, paperIds, existingIdeas: [...(materials?.project?.ideas ?? []), ...(materials?.project?.discarded_ideas ?? [])] })
      : checkStructuredClaims({ claims: output?.claims, evidence, paperIds, diagnostics });
  assertCurrentVaultContent(snapshot, { paths: [...new Set([...evidence.values()].map(row => row.path))] });
  const coverage = mode === 'ideas' ? ideaCoverage(output, evidence, materials) : undefined;
  return { ...(coverage ? { coverage } : {}), diagnostics, status: issues.length ? 'issues' : 'passed', issues, checks: 'structure_registered_anchors_and_named_overstatement_patterns', scientific_verification: 'not_performed' };
}


/** Descriptive provenance coverage, never a scientific verdict. */
export function ideaCoverage(output, evidence, materials = {}) {
  const index = evidence instanceof Map ? evidence : new Map((evidence ?? []).map(row => [row.path + '#' + (row.anchor ?? ''), row]));
  const citations = (output?.candidates ?? []).flatMap(row => row.citations ?? []);
  const modules = {}, anchors = {};
  for (const citation of citations) {
    const row = index.get(citation.path + '#' + (citation.anchor ?? ''));
    const module = row?.module ?? 'unknown';
    modules[module] = (modules[module] ?? 0) + 1;
    const anchor = /^7[.．]2(?:\D|$)/u.test(citation.anchor ?? '') ? '7.2' : 'other';
    anchors[anchor] = (anchors[anchor] ?? 0) + 1;
  }
  const referencedPaths = new Set(citations.map(row => row.path));
  const isolated = (materials?.knowledge?.isolated_methods ?? []).filter(row => referencedPaths.has(row.path)).length;
  const bridges = (materials?.knowledge?.bridges ?? []).filter(row => (row.shared_nodes ?? []).some(id => (materials.knowledge.shared_nodes ?? []).some(node => node.entity_id === id && referencedPaths.has(node.path)))).length;
  return { candidate_citations: citations.length, modules, section_7_2_ratio: citations.length ? (anchors['7.2'] ?? 0) / citations.length : 0,
    isolated_method_paths_cited: isolated, bridge_nodes_cited: bridges, network_use_verification: 'path_overlap_only', unused: output?.material_usage?.unused ?? [],
    diagnostics: !modules[5] && !modules[6] && !isolated && !bridges ? [{ code: 'WQ_IDEAS_NARROW_MATERIAL_USE' }] : [] };
}
