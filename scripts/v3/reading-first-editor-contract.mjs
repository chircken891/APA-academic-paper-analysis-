import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export function loadReadingEditorContract() {
  const bytes = readFileSync(new URL('../../prompts/v3/reading-editor-1.2.md', import.meta.url));
  return { content: bytes.toString('utf8').trim(), metadata: { profile: 'reading-editor-1.2',
    sha256: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), byte_length: bytes.length } };
}

export function readingEditorInstructions(section) {
  return section.replaceAll('reading-editor-1.1', 'reading-editor-1.2')
    .replace(/^`map` is one bilingual choice[^\r\n]*/m, loadReadingEditorContract().content);
}

export function assertReadingEditorContract(binding) {
  if (binding.presentation_profile !== 'reading-editor-1.2') return;
  const expected = loadReadingEditorContract().metadata, actual = binding.presentation_contract;
  if (!actual || Object.keys(expected).some(key => actual[key] !== expected[key])) {
    throw Object.assign(new Error('READING_FIRST_EDITOR_CONTRACT_CHANGED'), { code: 'READING_FIRST_EDITOR_CONTRACT_CHANGED' });
  }
}
