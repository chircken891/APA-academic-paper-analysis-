import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export function loadReadingEditorContract(profile = 'reading-editor-1.2') {
  if (['reading-editor-1.0', 'reading-editor-1.1'].includes(profile)) return undefined;
  if (!['reading-editor-1.2', 'reading-editor-1.3'].includes(profile)) throw new Error('READING_FIRST_EDITOR_PROFILE_INVALID');
  const bytes = readFileSync(new URL(`../../prompts/v3/${profile}.md`, import.meta.url));
  return { content: bytes.toString('utf8').trim(), metadata: { profile,
    sha256: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), byte_length: bytes.length } };
}

export function readingEditorInstructions(section, profile = 'reading-editor-1.2') {
  const contract = loadReadingEditorContract(profile);
  if (!contract) return section;
  if (profile === 'reading-editor-1.3') return contract.content;
  return section.replaceAll('reading-editor-1.1', 'reading-editor-1.2')
    .replace(/^`map` is one bilingual choice[^\r\n]*/m, contract.content);
}

export function assertReadingEditorContract(binding) {
  const profile = binding.presentation_profile ?? 'reading-editor-1.0';
  const contract = loadReadingEditorContract(profile);
  if (!contract) return;
  const expected = contract.metadata, actual = binding.presentation_contract;
  if (!actual || Object.keys(expected).some(key => actual[key] !== expected[key])) {
    throw Object.assign(new Error('READING_FIRST_EDITOR_CONTRACT_CHANGED'), { code: 'READING_FIRST_EDITOR_CONTRACT_CHANGED' });
  }
}
