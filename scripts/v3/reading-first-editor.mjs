import { fingerprintV3Json } from './semantic-package-validator.mjs';
import { METHODS_READING_EDITOR_PROFILE, SUPPORTED_READING_EDITOR_PROFILES } from './reading-first-editor-contract.mjs';
import { READING_ARGUMENT_RELATION_LABELS } from './research-map-canvas.mjs';

const languages = ['en', 'zh-CN'];
export const READING_EDITOR_SCHEMAS = SUPPORTED_READING_EDITOR_PROFILES;
export { READING_ARGUMENT_RELATION_LABELS };
const mapStages = {step:['design','measurement'], finding:['finding','limit']};
const text = value => typeof value === 'string' && !!value.trim();
const fail = (suffix, details) => { throw Object.assign(new Error('READING_FIRST_EDITOR_' + suffix), {code:'READING_FIRST_EDITOR_' + suffix, ...(details ? {details} : {})}); };
const argumentFail = (suffix, details) => fail('ARGUMENT_' + suffix, details);

function argumentText(value, enMax, zhMax, optional = false) {
  if (optional && value?.en === '' && value?.['zh-CN'] === '') return;
  for (const [language, max] of [['en', enMax], ['zh-CN', zhMax]]) {
    const line = value?.[language];
    if (!text(line) || [...line].length > max || /[\r\n]/u.test(line)) argumentFail('TEXT_INVALID');
  }
}

function walkArgumentMap(id, graph, visited, active = new Set()) {
  if (active.has(id)) argumentFail('CYCLE');
  if (visited.has(id)) return;
  active.add(id);
  for (const next of graph.get(id)) walkArgumentMap(next, graph, visited, active);
  active.delete(id);
  visited.add(id);
}

function argumentPathExists(graph, start, target) {
  const seen = new Set([start]);
  const pending = [start];
  while (pending.length) {
    for (const next of graph.get(pending.pop())) {
      if (next === target) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      pending.push(next);
    }
  }
  return false;
}

function validateResearchStages(stageMap, { map, argument, sections, findings }) {
  const { stages, transitions, step_text: stepText, finding_text: findingText } = stageMap ?? {};
  if (!Array.isArray(stages) || !Array.isArray(transitions)) argumentFail('INVALID');
  const steps = new Set((map?.steps ?? []).map(node => node.id));
  const claims = new Map(argument.claims.map(claim => [claim.id, claim]));
  for (const node of [...(map?.steps ?? []), ...(map?.findings ?? [])]) {
    if (!sections.has(node.section_id)) argumentFail('SECTION_INVALID', { node_id: node.id });
  }
  for (const [summaries, ids] of [[stepText, steps], [findingText, findings]]) {
    if (!summaries || typeof summaries !== 'object' || Array.isArray(summaries) || Object.keys(summaries).length !== ids.size) argumentFail('INVALID');
    for (const id of ids) {
      if (!Object.hasOwn(summaries, id)) argumentFail('INVALID', { node_id: id });
      argumentText(summaries[id], 240, 120);
    }
  }

  const forward = new Map(), stepStage = new Map(), claimStage = new Map(), findingStage = new Map();
  for (const stage of stages) {
    const { id, title, entry, step_ids: stepIds, claim_ids: claimIds } = stage ?? {};
    if (typeof id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(id) || forward.has(id)
      || id === 'question' || id === 'conclusion' || !Array.isArray(stepIds) || !Array.isArray(claimIds)
      || !stepIds.length && !claimIds.length) argumentFail('INVALID', { stage_id: id });
    argumentText(title, 96, 48);
    argumentText(entry, 240, 120);
    forward.set(id, new Set());
    for (const stepId of stepIds) {
      if (!steps.has(stepId) || stepStage.has(stepId)) argumentFail('INVALID', { stage_id: id, step_id: stepId });
      stepStage.set(stepId, id);
    }
    for (const claimId of claimIds) {
      if (!claims.has(claimId) || claimStage.has(claimId)) argumentFail('INVALID', { stage_id: id, claim_id: claimId });
      claimStage.set(claimId, id);
      for (const findingId of claims.get(claimId).finding_ids) findingStage.set(findingId, id);
    }
  }
  if (stepStage.size !== steps.size || claimStage.size !== claims.size) argumentFail('INVALID');

  const supported = new Set(), dependencies = [];
  const support = (from, to, stepLink) => {
    if (!from || !to || from === to) return;
    supported.add(`${from}>${to}`);
    dependencies.push({ from, to, stepLink });
  };
  const workflow = new Map([...steps].map(stepId => [stepId, new Set()]));
  for (const link of map?.step_links ?? []) {
    const { from_step_id: from, to_step_id: to } = link;
    if (!steps.has(from) || !steps.has(to)) argumentFail('RELATIONS_INVALID', { from_step_id: from, to_step_id: to });
    workflow.get(from).add(to);
    support(stepStage.get(from), stepStage.get(to), link);
  }
  for (const link of map?.relations ?? []) support(stepStage.get(link.step_id ?? link.from), findingStage.get(link.finding_id ?? link.to));
  for (const link of argument.relations) support(claimStage.get(link.from), claimStage.get(link.to));
  for (const transition of transitions) {
    const { from, to, label } = transition ?? {};
    if (!forward.has(from) || !forward.has(to) || forward.get(from).has(to) || !supported.has(`${from}>${to}`)) {
      argumentFail('RELATIONS_INVALID', { from_stage: from, to_stage: to });
    }
    argumentText(label, 240, 120);
    forward.get(from).add(to);
  }
  const visited = new Set();
  for (const stageId of forward.keys()) walkArgumentMap(stageId, forward, visited);
  for (const { from, to, stepLink } of dependencies) {
    if (argumentPathExists(forward, from, to)) continue;
    // An admitted iterative step return can run against the forward phase path.
    if (stepLink && argumentPathExists(forward, to, from)
      && argumentPathExists(workflow, stepLink.to_step_id, stepLink.from_step_id)) continue;
    argumentFail('RELATIONS_INVALID', { from_stage: from, to_stage: to });
  }
}

/** Validate the presentation structure against the admitted map and shared accepted sections. */
export function validateReadingArgument({ argument, primaryFindingIds, map, sectionIds, methodsFirst = false, stagedResearchMap = false } = {}) {
  const { question, claims, branches, relations, conclusion } = argument ?? {};
  const sections = new Set(sectionIds);
  const findings = new Set((map?.findings ?? []).map(node => node.id));
  if (!sections.has(question?.section_id) || !sections.has(conclusion?.section_id)) argumentFail('SECTION_INVALID');
  argumentText(question.text, 240, 120);
  argumentText(conclusion.text, 300, 150);

  if (!Array.isArray(claims) || !methodsFirst && claims.length < 4 || claims.length > 8) argumentFail('CLAIMS_INVALID');
  const nodes = new Set(['question', 'conclusion']);
  if (!Array.isArray(branches) || claims.length && !branches.length || branches.length > claims.length) argumentFail('BRANCHES_INVALID');
  const branchIds = new Set();
  for (const branch of branches) {
    if (!text(branch?.id) || branchIds.has(branch.id)) argumentFail('BRANCHES_INVALID');
    branchIds.add(branch.id);
    argumentText(branch.name, 64, 32);
  }

  const usedBranches = new Set(), assigned = new Set();
  for (const claim of claims) {
    if (!text(claim?.id) || nodes.has(claim.id)) argumentFail('CLAIMS_INVALID');
    nodes.add(claim.id);
    if (!sections.has(claim.section_id)) argumentFail('SECTION_INVALID');
    if (!branchIds.has(claim.branch_id)) argumentFail('BRANCHES_INVALID');
    usedBranches.add(claim.branch_id);
    argumentText(claim.title, 180, 90);
    argumentText(claim.evidence, 260, 130);
    argumentText(claim.limit, 220, 110, true);
    if (!Array.isArray(claim.finding_ids)) argumentFail('FINDINGS_INVALID');
    for (const id of claim.finding_ids) {
      if (!findings.has(id) || assigned.has(id)) argumentFail('FINDINGS_INVALID');
      assigned.add(id);
    }
  }
  if (usedBranches.size !== branchIds.size) argumentFail('BRANCHES_INVALID');
  if (assigned.size !== findings.size || !Array.isArray(primaryFindingIds) || new Set(primaryFindingIds).size !== primaryFindingIds.length
    || primaryFindingIds.some(id => !findings.has(id))) argumentFail('FINDINGS_INVALID');

  if (!Array.isArray(relations)) argumentFail('RELATIONS_INVALID');
  const forward = new Map([...nodes].map(id => [id, new Set()]));
  const backward = new Map([...nodes].map(id => [id, new Set()]));
  for (const relation of relations) {
    const { from, to, label } = relation ?? {};
    if (!nodes.has(from) || !nodes.has(to) || from === 'conclusion' || to === 'question'
      || typeof label !== 'string' || !Object.hasOwn(READING_ARGUMENT_RELATION_LABELS, label) || forward.get(from).has(to)) argumentFail('RELATIONS_INVALID');
    forward.get(from).add(to);
    backward.get(to).add(from);
  }
  const fromQuestion = new Set(), toConclusion = new Set();
  walkArgumentMap('question', forward, fromQuestion);
  walkArgumentMap('conclusion', backward, toConclusion);
  const checked = new Set(fromQuestion);
  for (const id of nodes) walkArgumentMap(id, forward, checked);
  if (fromQuestion.size !== nodes.size || toConclusion.size !== nodes.size) argumentFail('PATH_INVALID');
  if (Object.hasOwn(argument, 'stage_map') || stagedResearchMap) {
    if (!methodsFirst) argumentFail('INVALID');
    validateResearchStages(argument.stage_map, { map, argument, sections, findings });
  }
  return argument;
}

export function readingFirstViewsFingerprint(views) {
  return fingerprintV3Json(languages.map(language=>views.find(view=>view.language===language)));
}

/** Presentation metadata refers to accepted prose; it cannot replace that prose. */
export function validateReadingFirstEditor({editor, views, presentation, expandedMethodIndex = false, stagedResearchMap = false} = {}) {
  if (!Array.isArray(views) || views.length !== 2 || languages.some(language=>!views.find(view=>view.language===language))) fail('VIEWS_INVALID');
  // Historical 1.3 metadata remains readable. The run control separately retires its binding.
  if ((!READING_EDITOR_SCHEMAS.includes(editor?.schema_version) && editor?.schema_version !== 'reading-editor-1.3')
    || editor.views_fingerprint !== readingFirstViewsFingerprint(views)) fail('FINGERPRINT_INVALID');
  const knowledge = new Set((presentation?.knowledge ?? []).map(item=>item.id));
  const sharedKnowledge = presentation?.knowledge_layout === 'shared-bilingual-1.0';
  const methodsFirst = editor.schema_version === METHODS_READING_EDITOR_PROFILE;
  const requiredMethodFields = methodsFirst && !expandedMethodIndex ? ['id', 'title', 'application'] : ['id', 'title', 'explanation', 'application'];
  const requireMethods = !methodsFirst || Boolean(presentation?.map?.steps?.length);
  const knowledgeIds = item => [...new Set([...(item.knowledge_ids ?? []), ...(item.knowledge_id === undefined ? [] : [item.knowledge_id])])].sort();
  for (const language of languages) {
    const value=editor.languages?.[language], view=views.find(item=>item.language===language);
    const sections=new Map(view.sections.map(section=>[section.id,section]));
    const references=ids=>Array.isArray(ids) && ids.length>0 && new Set(ids).size===ids.length && ids.every(id=>sections.has(id));
    if (!value || !Array.isArray(value.overview) || !value.overview.length || value.overview.some(item=>!text(item.text)||!references(item.section_ids)) || !Array.isArray(value.sections) || !Array.isArray(value.methods) || requireMethods && !value.methods.length) fail('CONTENT_INVALID');
    if (methodsFirst && (value.overview.length !== 1 || /[\r\n]/u.test(value.overview[0].text))) fail('CONTENT_INVALID');
    const seen=new Set();
    for (const item of value.sections) {
      const section=sections.get(item.section_id);
      if (!section || section.module_id==='abstract' || section.id==='abstract' || seen.has(item.section_id)) fail('SECTION_INVALID');
      seen.add(item.section_id);
      if (item.takeaway !== undefined && !text(item.takeaway)) fail('CONTENT_INVALID');
      if (!Array.isArray(item.emphasis) || !Array.isArray(item.subheadings)) fail('CONTENT_INVALID');
      const spans=[];
      for (const emphasis of item.emphasis) {
        if (!Number.isInteger(emphasis.paragraph_index) || !text(emphasis.text) || /[\[\]`*_\r\n]/.test(emphasis.text) || !section.paragraphs[emphasis.paragraph_index]?.includes(emphasis.text)) fail('EMPHASIS_INVALID');
        const paragraph=section.paragraphs[emphasis.paragraph_index], start=paragraph.indexOf(emphasis.text), end=start+emphasis.text.length;
        if (spans.some(span=>span.paragraph===emphasis.paragraph_index && start<span.end && end>span.start)) fail('EMPHASIS_INVALID');
        spans.push({paragraph:emphasis.paragraph_index,start,end});
      }
      const positions=new Set();
      for (const heading of item.subheadings) {
        if (!Number.isInteger(heading.before_paragraph) || !section.paragraphs[heading.before_paragraph] || !text(heading.heading) || positions.has(heading.before_paragraph)) fail('SUBHEADING_INVALID');
        positions.add(heading.before_paragraph);
      }
    }
    {
      // Reading notes move beside their figure; paragraph 0 keeps the section anchor and stays in place.
      const catalog=new Set((presentation?.visuals ?? []).map(item=>item.id)), moved=new Set();
      if (!Array.isArray(value.visuals) || new Set(value.visuals.map(item=>item.id)).size !== value.visuals.length) fail('VISUAL_INVALID');
      for (const item of value.visuals) {
        if (!catalog.has(item.id) || item.title !== undefined && !text(item.title) || !Array.isArray(item.notes ?? [])) fail('VISUAL_INVALID');
        for (const note of item.notes ?? []) {
          const section=sections.get(note.section_id), key=note.section_id+':'+note.paragraph_index;
          const placed=view.placements?.visuals?.some(row=>row.id===item.id && row.section_id===note.section_id);
          const headed=value.sections.find(row=>row.section_id===note.section_id)?.subheadings.some(row=>row.before_paragraph===note.paragraph_index);
          if (!section || !placed || headed || !Number.isInteger(note.paragraph_index) || note.paragraph_index < 1 || !section.paragraphs[note.paragraph_index] || moved.has(key)) fail('VISUAL_INVALID');
          moved.add(key);
        }
      }
    }
    if (value.methods.some(item => !item) || new Set(value.methods.map(item=>item.id)).size !== value.methods.length || value.methods.some(item=>
      !requiredMethodFields.every(key=>text(item[key])) || !references(item.section_ids) ||
      item.knowledge_id !== undefined && !knowledge.has(item.knowledge_id) ||
      item.knowledge_ids !== undefined && (!Array.isArray(item.knowledge_ids) || new Set(item.knowledge_ids).size !== item.knowledge_ids.length || item.knowledge_ids.some(id=>!knowledge.has(id))))) fail('METHOD_INVALID');
    if (methodsFirst) {
      const expanded = value.methods.some(method => Object.hasOwn(method, 'explanation'));
      const ranked = view.sections.filter(section => expanded ? section.module_id !== 'abstract' : section.module_id === 'methods');
      const ranks = new Map(ranked.map((section, index) => [section.id, index]));
      let previous = -1;
      for (const method of value.methods) {
        const order = method.section_ids.map(id => ranks.get(id));
        if (!/^[a-z][a-z0-9-]*$/.test(method.id) || /[\r\n]/u.test(method.title + method.application)
          || Object.hasOwn(method, 'explanation') && (!text(method.explanation) || /[\r\n]/u.test(method.explanation))
          || Object.hasOwn(method, 'knowledge_id')
          || order[0] < previous || order.some((rank, index) => rank === undefined || index && rank < order[index - 1])) fail('METHOD_INVALID');
        previous = order[0];
      }
    }
  }
  if (READING_EDITOR_SCHEMAS.includes(editor.schema_version)) {
    if (Object.hasOwn(editor, 'map')) fail('ARGUMENT_INVALID');
    const enSections = new Set(views.find(view => view.language === 'en').sections.map(section => section.id));
    const sharedSections = views.find(view => view.language === 'zh-CN').sections.map(section => section.id).filter(id => enSections.has(id));
    validateReadingArgument({ argument: editor.argument, primaryFindingIds: editor.primary_finding_ids, map: presentation?.map, sectionIds: sharedSections, methodsFirst, stagedResearchMap });
  } else {
    // Map labels are shared across languages, so node selection, stages and emphasis are one bilingual choice.
    const map=presentation?.map ?? {steps:[],findings:[]}, kinds=new Map([...map.steps.map(node=>[node.id,'step']),...map.findings.map(node=>[node.id,'finding'])]);
    const nodes=editor.map?.nodes;
    if (!Array.isArray(nodes) || new Set(nodes.map(node=>node.id)).size !== nodes.length || nodes.some(node=>!kinds.has(node.id) || !mapStages[kinds.get(node.id)].includes(node.stage) || node.primary !== undefined && (typeof node.primary !== 'boolean' || kinds.get(node.id) !== 'finding'))) fail('MAP_INVALID');
    const selected = new Set(nodes.map(node => node.id));
    const missing_steps = map.steps.filter(node => !selected.has(node.id)).map(node => node.id);
    if (missing_steps.length) fail('MAP_INVALID', { missing_steps });
    if (kinds.size && !nodes.length) fail('MAP_INVALID');
  }
  if (methodsFirst) {
    const mappings = language => editor.languages[language].methods.map(item => [item.id, item.section_ids, knowledgeIds(item)]);
    if (fingerprintV3Json(mappings('en')) !== fingerprintV3Json(mappings('zh-CN'))) fail('BILINGUAL_METHODS_INVALID');
    const methods = languages.flatMap(language => editor.languages[language].methods);
    if (methods.some(item => text(item.explanation)) && !methods.every(item => text(item.explanation))) fail('BILINGUAL_METHODS_INVALID');
    return editor;
  }
  const ids=language=>editor.languages[language].methods.map(item=>item.id).sort();
  if (fingerprintV3Json(ids('en')) !== fingerprintV3Json(ids('zh-CN'))) fail('BILINGUAL_METHODS_INVALID');
  if (sharedKnowledge) {
    const mappings = language => editor.languages[language].methods.map(item=>[item.id,knowledgeIds(item)]).sort(([a],[b])=>a.localeCompare(b));
    if (fingerprintV3Json(mappings('en')) !== fingerprintV3Json(mappings('zh-CN'))) fail('BILINGUAL_METHODS_INVALID');
  }
  return editor;
}
