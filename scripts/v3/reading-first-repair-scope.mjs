import { fingerprintV3Json } from './semantic-package-validator.mjs';

const fail = code => { throw Object.assign(new Error(code), {code}); };
const keys = ['section_ids','knowledge_ids','visual_ids','editor_fields'];

export function validateRepairScopes(review, views, presentation) {
  const catalogs = {
    section_ids:new Set(views.flatMap(view => view.sections.map(section => section.id))),
    knowledge_ids:new Set((presentation?.knowledge ?? []).map(item => item.id)),
    visual_ids:new Set((presentation?.visuals ?? []).map(item => item.id)),
    editor_fields:new Set(['map']),
  };
  for (const issue of review.issues.filter(issue => issue.severity === 'material')) {
    const scope=issue.repair_scope;
    if (!scope || Object.keys(scope).sort().join() !== ['status',...keys].sort().join()
      || !['located','unresolved'].includes(scope.status)
      || keys.some(key => !Array.isArray(scope[key]) || new Set(scope[key]).size !== scope[key].length || scope[key].some(id => typeof id !== 'string' || !catalogs[key].has(id)))) fail('READING_FIRST_REPAIR_SCOPE_INVALID');
    if (scope.status === 'unresolved') fail('READING_FIRST_REPAIR_SCOPE_UNRESOLVED');
    if (!keys.some(key => scope[key].length)) fail('READING_FIRST_REPAIR_SCOPE_INVALID');
  }
}

export function assertEditorRepairScope(base, revised, review) {
  const scopes=review.issues.filter(issue=>issue.severity==='material').map(issue=>issue.repair_scope);
  const ids=key=>new Set(scopes.flatMap(scope=>scope[key]));
  const sections=ids('section_ids'), knowledge=ids('knowledge_ids'), visuals=ids('visual_ids');
  const inScope=(item, kind) => kind==='sections' ? sections.has(item.section_id)
    : kind==='visuals' ? visuals.has(item.id) || (item.notes ?? []).some(note=>sections.has(note.section_id))
    : (item.section_ids ?? []).some(id=>sections.has(id)) || knowledge.has(item.knowledge_id) || (item.knowledge_ids ?? []).some(id=>knowledge.has(id));
  const left=structuredClone(base), right=structuredClone(revised);
  delete left.views_fingerprint; delete right.views_fingerprint;
  if (ids('editor_fields').has('map')) { delete left.map; delete right.map; }
  for (const language of ['en','zh-CN']) for (const kind of ['overview','sections','methods','visuals']) {
    const before=left.languages?.[language]?.[kind], after=right.languages?.[language]?.[kind];
    if (before === undefined && after === undefined) continue;
    if (!Array.isArray(before) || !Array.isArray(after) || before.length!==after.length) fail('READING_FIRST_REPAIR_SCOPE_EXCEEDED');
    for (let i=0;i<before.length;i++) {
      const a=before[i], b=after[i], identity=kind==='sections'?'section_id':kind==='methods'||kind==='visuals'?'id':null;
      if (identity && a[identity]!==b[identity]) fail('READING_FIRST_REPAIR_SCOPE_EXCEEDED');
      if (!inScope(a,kind)) continue;
      for (const key of ['section_ids','knowledge_id','knowledge_ids']) if (JSON.stringify(a[key])!==JSON.stringify(b[key])) fail('READING_FIRST_REPAIR_SCOPE_EXCEEDED');
      if (kind==='visuals') {
        const outside=rows=>(rows ?? []).filter(row=>!sections.has(row.section_id));
        if (JSON.stringify(outside(a.notes))!==JSON.stringify(outside(b.notes))) fail('READING_FIRST_REPAIR_SCOPE_EXCEEDED');
      }
      before[i]=null; after[i]=null;
    }
  }
  if (fingerprintV3Json(left)!==fingerprintV3Json(right)) fail('READING_FIRST_REPAIR_SCOPE_EXCEEDED');
}
