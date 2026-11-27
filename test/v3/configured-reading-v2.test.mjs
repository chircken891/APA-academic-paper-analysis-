import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { basename } from 'node:path';
import { loadReadingEditorContract, readingEditorInstructions, assertReadingEditorContract } from '../../scripts/v3/reading-first-editor-contract.mjs';
import { buildConfiguredReadingInstructions, prepareConfiguredReading } from '../../scripts/v3/configured-reading.mjs';

test('configured instruction profile freezes complete prompts and editor contract', () => {
  const result = buildConfiguredReadingInstructions({}, { instructionProfile: 'configured-reading-2.2' });
  assert.equal(result.instruction_profile, 'configured-reading-2.2');
  assert.equal(result.prompt_files.length, 3);
  assert.ok(result.sections.Translation);
  assert.ok(result.sections['Reading Editor'].includes('reading-editor-1.4'));
  assert.ok(result.science_sections['Common scientific contract']);
  const metadata = loadReadingEditorContract('reading-editor-1.4').metadata;
  assertReadingEditorContract({ presentation_profile: 'reading-editor-1.4', presentation_contract: metadata });
  assert.equal(readingEditorInstructions('reading-editor-1.4'), result.sections['Reading Editor']);
  const editorFile = result.prompt_files.find(file => /reading-editor-1\.4\.md$/.test(file.path));
  assert.deepEqual({ sha256: editorFile.sha256, byte_length: editorFile.byte_length }, { sha256: metadata.sha256, byte_length: metadata.byte_length });
  for (const profile of ['reading-editor-1.3', 'reading-editor-1.2', 'unknown'])
    assert.throws(() => loadReadingEditorContract(profile), { code: 'READING_BINDING_RETIRED' });
});

test('configured-reading-2.4 freezes the new default prompts and advertises the current replacement for 2.2', () => {
  const instructions = buildConfiguredReadingInstructions();
  assert.equal(instructions.instruction_profile, 'configured-reading-2.4');
  assert.deepEqual(instructions.prompt_files.map(file => basename(file.path)),
    ['science-configured-2.4.md', 'reading-configured-2.4.md', 'reading-editor-1.5.md']);
  assert.equal(instructions.frozen_support.science_index.metadata.profile, 'science-index-1.1');
  const previous = buildConfiguredReadingInstructions({}, { instructionProfile: 'configured-reading-2.3' });
  assert.deepEqual(previous.prompt_files.map(file => basename(file.path)),
    ['science-configured-2.3.md', 'reading-configured-2.3.md', 'reading-editor-1.5.md']);
  assert.equal(previous.frozen_support.science_index.metadata.profile, 'science-index-1.0');
  assert.throws(() => prepareConfiguredReading({ instructionProfile: 'configured-reading-2.2' }), error =>
    error.code === 'READING_BINDING_RETIRED' && error.details?.replacement === 'configured-reading-2.4');
  for (const instructionProfile of ['configured-reading-2.1', 'configured-reading-2.0', 'configured-reading-1.0'])
    assert.throws(() => buildConfiguredReadingInstructions({}, { instructionProfile }), { code: 'READING_BINDING_RETIRED' });
});
