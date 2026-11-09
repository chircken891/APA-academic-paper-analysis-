import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const READING_EDITOR_PROFILE = 'reading-editor-1.4';

export function loadReadingEditorContract(profile = READING_EDITOR_PROFILE) {
  if (profile !== READING_EDITOR_PROFILE) throw Object.assign(new Error('READING_BINDING_RETIRED'), { code: 'READING_BINDING_RETIRED' });
  const bytes = readFileSync(new URL(`../../prompts/v3/${profile}.md`, import.meta.url));
  return { content: bytes.toString('utf8').trim(), metadata: { profile,
    sha256: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), byte_length: bytes.length } };
}

export function readingEditorInstructions() {
  return loadReadingEditorContract().content;
}

export function assertReadingEditorContract(binding) {
  const expected = loadReadingEditorContract(binding.presentation_profile).metadata, actual = binding.presentation_contract;
  if (!actual || Object.keys(expected).some(key => actual[key] !== expected[key])) {
    throw Object.assign(new Error('READING_FIRST_EDITOR_CONTRACT_CHANGED'), { code: 'READING_FIRST_EDITOR_CONTRACT_CHANGED' });
  }
}
