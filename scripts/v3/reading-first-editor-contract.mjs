import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const LEGACY_READING_EDITOR_PROFILE = 'reading-editor-1.4';
export const METHODS_READING_EDITOR_PROFILE = 'reading-editor-1.5';
export const READING_EDITOR_PROFILE = METHODS_READING_EDITOR_PROFILE;
export const SUPPORTED_READING_EDITOR_PROFILES = Object.freeze([LEGACY_READING_EDITOR_PROFILE, READING_EDITOR_PROFILE]);

export function loadReadingEditorContract(profile = READING_EDITOR_PROFILE) {
  if (!SUPPORTED_READING_EDITOR_PROFILES.includes(profile)) throw Object.assign(new Error('READING_BINDING_RETIRED'), { code: 'READING_BINDING_RETIRED' });
  const bytes = readFileSync(new URL(`../../prompts/v3/${profile}.md`, import.meta.url));
  return { content: bytes.toString('utf8').trim(), metadata: { profile,
    sha256: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), byte_length: bytes.length } };
}

export function readingEditorInstructions(profile) {
  return loadReadingEditorContract(profile).content;
}

export function assertReadingEditorContract(binding) {
  const expected = loadReadingEditorContract(binding.presentation_profile).metadata, actual = binding.presentation_contract;
  if (!actual || Object.keys(expected).some(key => actual[key] !== expected[key])) {
    throw Object.assign(new Error('READING_FIRST_EDITOR_CONTRACT_CHANGED'), { code: 'READING_FIRST_EDITOR_CONTRACT_CHANGED' });
  }
}
