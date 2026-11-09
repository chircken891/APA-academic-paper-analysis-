import { fingerprintV3Json } from './semantic-package-validator.mjs';
import { READING_EDITOR_PROFILE } from './reading-first-editor-contract.mjs';
import { READING_ARGUMENT_RELATION_LABELS } from './research-map-canvas.mjs';

const languages = ['en', 'zh-CN'];
export const READING_EDITOR_SCHEMAS = Object.freeze([READING_EDITOR_PROFILE]);
export { READING_ARGUMENT_RELATION_LABELS };
const mapStages = {step:['design','measurement'], finding:['finding','limit']};
const text = value => typeof value === 'string' && !!value.trim();
const fail = (suffix, details) => { throw Object.assign(new Error('READING_FIRST_EDITOR_' + suffix), {code:'READING_FIRST_EDITOR_' + suffix, ...(details ? {details} : {})}); };
const argumentFail = suffix => fail('ARGUMENT_' + suffix);

function argumentText(value, enMax, zhMax, optional = false) {
  if (optional && value?.en === '' && value?.['zh-CN'] === '') return;
  for (const [language, max] of [['en', enMax], ['zh-CN', zhMax]]) {
    const line = value?.[language];
    if (!text(line) || [...line].length > max || /[\r\n]/u.test(line)) argumentFail('TEXT_INVALID');
  }
}

/** Validate the presentation structure against the admitted map and shared accepted sections. */
export function validateReadingArgument({ argument, primaryFindingIds, map, sectionIds } = {}) {
  const { question, claims, branches, relations, conclusion } = argument ?? {};
  const sections = new Set(sectionIds);
  const findings = new Set((map?.findings ?? []).map(node => node.id));
  if (!sections.has(question?.section_id) || !sections.has(conclusion?.section_id)) argumentFail('SECTION_INVALID');
  argumentText(question.text, 240, 120);
  argumentText(conclusion.text, 300, 150);

  if (!Array.isArray(claims) || claims.length < 4 || claims.length > 8) argumentFail('CLAIMS_INVALID');
  const nodes = new Set(['question', 'conclusion']);
  if (!Array.isArray(branches) || !branches.length || branches.length > claims.length) argumentFail('BRANCHES_INVALID');
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
  function walk(id, graph, visited, active = new Set()) {
    if (active.has(id)) argumentFail('CYCLE');
    if (visited.has(id)) return;
    active.add(id);
    for (const next of graph.get(id)) walk(next, graph, visited, active);
    active.delete(id);
    visited.add(id);
  }
  const fromQuestion = new Set(), toConclusion = new Set();
  walk('question', forward, fromQuestion);
  walk('conclusion', backward, toConclusion);
  const checked = new Set(fromQuestion);
  for (const id of nodes) walk(id, forward, checked);
  if (fromQuestion.size !== nodes.size || toConclusion.size !== nodes.size) argumentFail('PATH_INVALID');
  return argument;
}

export function readingFirstViewsFingerprint(views) {
  return fingerprintV3Json(languages.map(language=>views.find(view=>view.language===language)));
}

/** Presentation metadata refers to accepted prose; it cannot replace that prose. */
export function validateReadingFirstEditor({editor, views, presentation} = {}) {
  if (!Array.isArray(views) || views.length !== 2 || languages.some(language=>!views.find(view=>view.language===language))) fail('VIEWS_INVALID');
  // Historical 1.3 metadata remains readable. The run control separately retires its binding.
  if ((!READING_EDITOR_SCHEMAS.includes(editor?.schema_version) && editor?.schema_version !== 'reading-editor-1.3')
    || editor.views_fingerprint !== readingFirstViewsFingerprint(views)) fail('FINGERPRINT_INVALID');
  const knowledge = new Set((presentation?.knowledge ?? []).map(item=>item.id));
  const sharedKnowledge = presentation?.knowledge_layout === 'shared-bilingual-1.0';
  const knowledgeIds = item => [...new Set([...(item.knowledge_ids ?? []), ...(item.knowledge_id === undefined ? [] : [item.knowledge_id])])].sort();
  for (const language of languages) {
    const value=editor.languages?.[language], view=views.find(item=>item.language===language);
    const sections=new Map(view.sections.map(section=>[section.id,section]));
    const references=ids=>Array.isArray(ids) && ids.length>0 && new Set(ids).size===ids.length && ids.every(id=>sections.has(id));
    if (!value || !Array.isArray(value.overview) || !value.overview.length || value.overview.some(item=>!text(item.text)||!references(item.section_ids)) || !Array.isArray(value.sections) || (!Array.isArray(value.methods) || !value.methods.length)) fail('CONTENT_INVALID');
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
    if (new Set(value.methods.map(item=>item.id)).size !== value.methods.length || value.methods.some(item=>
      !['id','title','explanation','application'].every(key=>text(item[key])) || !references(item.section_ids) ||
      item.knowledge_id !== undefined && !knowledge.has(item.knowledge_id) ||
      item.knowledge_ids !== undefined && (!Array.isArray(item.knowledge_ids) || new Set(item.knowledge_ids).size !== item.knowledge_ids.length || item.knowledge_ids.some(id=>!knowledge.has(id))))) fail('METHOD_INVALID');
  }
  if (editor.schema_version === READING_EDITOR_PROFILE) {
    if (Object.hasOwn(editor, 'map')) fail('ARGUMENT_INVALID');
    const enSections = new Set(views.find(view => view.language === 'en').sections.map(section => section.id));
    const sharedSections = views.find(view => view.language === 'zh-CN').sections.map(section => section.id).filter(id => enSections.has(id));
    validateReadingArgument({ argument: editor.argument, primaryFindingIds: editor.primary_finding_ids, map: presentation?.map, sectionIds: sharedSections });
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
  const ids=language=>editor.languages[language].methods.map(item=>item.id).sort();
  if (fingerprintV3Json(ids('en')) !== fingerprintV3Json(ids('zh-CN'))) fail('BILINGUAL_METHODS_INVALID');
  if (sharedKnowledge) {
    const mappings = language => editor.languages[language].methods.map(item=>[item.id,knowledgeIds(item)]).sort(([a],[b])=>a.localeCompare(b));
    if (fingerprintV3Json(mappings('en')) !== fingerprintV3Json(mappings('zh-CN'))) fail('BILINGUAL_METHODS_INVALID');
  }
  return editor;
}
