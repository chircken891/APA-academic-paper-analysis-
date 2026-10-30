import { fingerprintV3Json } from './semantic-package-validator.mjs';

const languages = ['en', 'zh-CN'];
export const READING_EDITOR_SCHEMAS = Object.freeze(['reading-editor-1.0', 'reading-editor-1.1', 'reading-editor-1.2', 'reading-editor-1.3']);
const mapStages = {step:['design','measurement'], finding:['finding','limit']};
const text = value => typeof value === 'string' && !!value.trim();
const fail = (suffix, details) => { throw Object.assign(new Error('READING_FIRST_EDITOR_' + suffix), {code:'READING_FIRST_EDITOR_' + suffix, ...(details ? {details} : {})}); };
export function readingFirstViewsFingerprint(views) {
  return fingerprintV3Json(languages.map(language=>views.find(view=>view.language===language)));
}

/** Presentation metadata refers to accepted prose; it cannot replace that prose. */
export function validateReadingFirstEditor({editor, views, presentation} = {}) {
  if (!Array.isArray(views) || views.length !== 2 || languages.some(language=>!views.find(view=>view.language===language))) fail('VIEWS_INVALID');
  if (!READING_EDITOR_SCHEMAS.includes(editor?.schema_version) || editor.views_fingerprint !== readingFirstViewsFingerprint(views)) fail('FINGERPRINT_INVALID');
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
    if (['reading-editor-1.1', 'reading-editor-1.2', 'reading-editor-1.3'].includes(editor.schema_version)) {
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
  if (['reading-editor-1.1', 'reading-editor-1.2', 'reading-editor-1.3'].includes(editor.schema_version)) {
    // Map labels are shared across languages, so node selection, stages and emphasis are one bilingual choice.
    const map=presentation?.map ?? {steps:[],findings:[]}, kinds=new Map([...map.steps.map(node=>[node.id,'step']),...map.findings.map(node=>[node.id,'finding'])]);
    const nodes=editor.map?.nodes;
    if (!Array.isArray(nodes) || new Set(nodes.map(node=>node.id)).size !== nodes.length || nodes.some(node=>!kinds.has(node.id) || !mapStages[kinds.get(node.id)].includes(node.stage) || node.primary !== undefined && (typeof node.primary !== 'boolean' || kinds.get(node.id) !== 'finding'))) fail('MAP_INVALID');
    if (['reading-editor-1.2', 'reading-editor-1.3'].includes(editor.schema_version)) {
      const selected = new Set(nodes.map(node => node.id));
      const missing_steps = map.steps.filter(node => !selected.has(node.id)).map(node => node.id);
      if (missing_steps.length) fail('MAP_INVALID', { missing_steps });
    }
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
