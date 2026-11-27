import { extname } from 'node:path';
import { normalizeReadingFirstMap } from './reading-first-obsidian.mjs';

const text = value => typeof value === 'string' && value.trim().length > 0;
const proseFields = ['purpose', 'input', 'operation', 'output', 'next_use'];
const resultAttributions = new Set(['author_report', 'author_background', 'author_interpretation', 'analyst_interpretation']);
const resultRoles = ['results', 'interpretation'];
const list = value => Array.isArray(value) && value.length > 0;

function fail(field, details = {}) {
  throw Object.assign(new Error('SCIENCE_CONTENT_INVALID'), { code: 'SCIENCE_CONTENT_INVALID', details: { field, ...details } });
}

export function validMethodSourceLocation(ref, sources) {
  if (!text(ref?.source_id) || !Array.isArray(sources)) return false;
  const matches = sources.filter(source => source?.id === ref.source_id);
  if (matches.length !== 1 || !text(matches[0].path)) return false;
  const { locator } = ref;
  const format = extname(matches[0].path).toLowerCase();
  if (format === '.pdf') return locator?.kind === 'pdf-page' && Number.isSafeInteger(locator.page) && locator.page > 0;
  if (format !== '.docx' || !Number.isSafeInteger(locator?.paragraph) || locator.paragraph < 0) return false;
  return locator.kind === 'docx-paragraph' || (locator.kind === 'docx-figure' && text(locator.figure));
}

export function assertMethodsFirstScience(value, sources) {
  const presentation = value?.presentation;
  if (!Array.isArray(presentation?.sections) || !presentation.map) fail('presentation.map');
  const sectionIds = new Set(presentation.sections.map(section => section?.id));
  if (sectionIds.size !== presentation.sections.length || ![...sectionIds].every(text)) fail('presentation.sections');
  let map;
  try { map = normalizeReadingFirstMap(presentation.map, sectionIds, { methodsFirst: true }); }
  catch (cause) { fail('presentation.map', { cause: cause.code ?? cause.message }); }
  const pending = new Set(map.steps.map(step => step.id));
  if (!Array.isArray(value.method_steps)) fail('method_steps');
  for (const step of value.method_steps) {
    if (!pending.delete(step?.step_id)
      || !proseFields.every(field => text(step[field]))
      || (step.limitation !== undefined && !text(step.limitation))
      || !Array.isArray(step.key_choices) || !step.key_choices.every(text)
      || !Array.isArray(step.sources) || !step.sources.length
      || !step.sources.every(ref => validMethodSourceLocation(ref, sources))) {
      fail('method_steps', { step_id: step?.step_id });
    }
  }
  if (pending.size) fail('method_steps', { missing_step_ids: [...pending] });
  return value;
}

function acceptedModuleIds(upstream, role) {
  const modules = upstream?.[role]?.result_modules;
  if (!list(modules)) fail('result_modules.upstream_refs', { upstream_role: role });
  return new Set(modules.map(module => module.id));
}

function assertResultModuleMapping(modules, sections, upstream) {
  if (!list(sections)) fail('result_modules.section_ids');
  const sectionIds = new Set(sections.map(section => section?.id));
  const accepted = new Map(resultRoles.map(role => [role, acceptedModuleIds(upstream, role)]));
  const covered = new Map(resultRoles.map(role => [role, new Set()]));
  for (const module of modules) {
    const details = { module_id: module.id };
    if (!list(module.section_ids) || module.section_ids.some(id => !text(id) || !sectionIds.has(id))
      || new Set(module.section_ids).size !== module.section_ids.length) fail('result_modules.section_ids', details);
    if (!list(module.upstream_refs)) fail('result_modules.upstream_refs', details);
    const linked = new Map(resultRoles.map(role => [role, new Set()]));
    for (const ref of module.upstream_refs) {
      const role = ref?.role, moduleId = ref?.module_id;
      if (!text(moduleId) || !accepted.get(role)?.has(moduleId) || linked.get(role).has(moduleId)) {
        fail('result_modules.upstream_refs', { ...details, upstream_role: role, upstream_module_id: moduleId });
      }
      linked.get(role).add(moduleId);
      covered.get(role).add(moduleId);
    }
    if (resultRoles.some(role => !linked.get(role).size)) fail('result_modules.upstream_refs', details);
  }
  for (const role of resultRoles) {
    const missing = [...accepted.get(role)].filter(id => !covered.get(role).has(id));
    if (missing.length) fail('result_modules.upstream_refs', { upstream_role: role, missing_module_ids: missing });
  }
}

export function assertResultModules(value, sources, { role, upstream, sections = value?.presentation?.sections } = {}) {
  const modules = value?.result_modules;
  if (!list(modules)) fail('result_modules', { role });
  const ids = new Set();
  const validSources = refs => list(refs) && refs.every(ref => validMethodSourceLocation(ref, sources));
  const attributed = item => text(item?.statement) && resultAttributions.has(item.attribution) && validSources(item.sources);
  for (const module of modules) {
    const details = { role, module_id: module?.id };
    if (!text(module?.id) || ids.has(module.id)) fail('result_modules.id', details);
    ids.add(module.id);
    if (!text(module.title) || !text(module.question)) fail('result_modules.title_question', details);
    if (!validSources(module.sources)) fail('result_modules.sources', details);
    if (!list(module.comparisons)) fail('result_modules.comparisons', details);
    for (const comparison of module.comparisons) {
      if (!list(comparison?.objects) || !comparison.objects.every(text)
        || !list(comparison.conditions) || !comparison.conditions.every(text)) fail('result_modules.comparisons', details);
      if (!list(comparison.observations) || comparison.observations.some(item => !attributed(item) || !text(item.direction))) {
        fail('result_modules.comparisons.observations', details);
      }
    }
    if (!Array.isArray(module.explanations) || !module.explanations.every(attributed)) fail('result_modules.explanations', details);
  }
  if (role === 'interpretation') {
    const accepted = acceptedModuleIds(upstream, 'results');
    const missing = [...accepted].filter(id => !ids.has(id));
    const unexpected = [...ids].filter(id => !accepted.has(id));
    if (missing.length || unexpected.length) fail('result_modules.id', { role, missing_module_ids: missing, unexpected_module_ids: unexpected });
  }
  if (role === 'integration') assertResultModuleMapping(modules, sections, upstream);
  return value;
}
