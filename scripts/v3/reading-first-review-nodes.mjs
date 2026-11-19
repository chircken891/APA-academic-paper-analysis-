import { isMethodsFirstReadingProfile } from '../lib/reading-profiles.mjs';
import { validMethodSourceLocation } from './methods-first-handoff.mjs';

const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const uniqueIds = ids => Array.isArray(ids) && ids.every(nonempty) && new Set(ids).size === ids.length;
const invalid = () => { throw Object.assign(new Error('READING_FIRST_METHOD_REVIEW_INVALID'), { code: 'READING_FIRST_METHOD_REVIEW_INVALID' }); };

// Malformed evidence cannot be accepted. Missing or unavailable evidence leaves a bounded result.
export function checkCriticalReviewNodes(review, profile, context) {
  const nodes = review.key_nodes;
  const basic = ['main_conclusion', 'key_design'].every(kind => nodes.some(node => node.kind === kind))
    && nodes.every(node => node.status !== 'unavailable');
  if (!isMethodsFirstReadingProfile(profile)) return basic;
  const methods = nodes.filter(node => node.kind === 'method_application');
  if (!methods.length) return false;
  const steps = new Map((context.presentation?.map?.steps ?? []).map(step => [step.id, step.section_id]));
  const sections = context.views.map(view => new Set(view.sections.map(section => section.id)));
  for (const node of methods) {
    if (!['checked', 'material_issue', 'unavailable', 'not_applicable'].includes(node.status)
      || !nonempty(node.finding) || !nonempty(node.location)
      || !uniqueIds(node.section_ids) || !node.section_ids.length || sections.length !== 2
      || node.section_ids.some(id => sections.some(view => !view.has(id)))
      || !uniqueIds(node.step_ids) || node.step_ids.some(id => !steps.has(id) || !node.section_ids.includes(steps.get(id)))
      || !Array.isArray(node.source_refs) || !node.source_refs.length
      || node.source_refs.some(ref => !validMethodSourceLocation(ref, context.sources))) invalid();
    if (['checked', 'material_issue'].includes(node.status) && !node.step_ids.length) invalid();
    if (node.status === 'not_applicable' && (steps.size || node.step_ids.length || !nonempty(node.article_type) || !nonempty(node.rationale) || methods.length !== 1)) invalid();
    // The existing routing stage can recover an omitted owner or scope from the original Verifier.
    if (node.status === 'material_issue' && !review.issues.some(issue => issue.severity === 'material'
      && (issue.repair_scope?.status !== 'located' || issue.repair_scope.section_ids?.some(id => node.section_ids.includes(id))
        || issue.repair_scope.visual_ids?.length || issue.repair_scope.knowledge_ids?.length || issue.repair_scope.editor_fields?.length))) invalid();
  }
  return basic && methods.every(node => ['checked', 'not_applicable'].includes(node.status));
}
