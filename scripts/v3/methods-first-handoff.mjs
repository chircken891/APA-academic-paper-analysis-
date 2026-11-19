import { extname } from 'node:path';
import { normalizeReadingFirstMap } from './reading-first-obsidian.mjs';

const text = value => typeof value === 'string' && value.trim().length > 0;
const proseFields = ['purpose', 'input', 'operation', 'output', 'next_use'];

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
