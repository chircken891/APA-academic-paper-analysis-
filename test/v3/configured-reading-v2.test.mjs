import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { loadReadingEditorContract, readingEditorInstructions, assertReadingEditorContract } from '../../scripts/v3/reading-first-editor-contract.mjs';
import { buildConfiguredReadingInstructions } from '../../scripts/v3/configured-reading.mjs';

test('configured instruction profile freezes complete prompts and editor contract', () => {
  const result = buildConfiguredReadingInstructions();
  assert.equal(result.instruction_profile, 'configured-reading-2.2');
  assert.equal(result.prompt_files.length, 3);
  assert.ok(result.sections.Translation);
  assert.ok(result.sections['Reading Editor'].includes('reading-editor-1.3'));
  assert.ok(result.science_sections['Common scientific contract']);
  const metadata = loadReadingEditorContract('reading-editor-1.3').metadata;
  assertReadingEditorContract({ presentation_profile: 'reading-editor-1.3', presentation_contract: metadata });
  assert.equal(readingEditorInstructions('untouched', 'reading-editor-1.3'), loadReadingEditorContract('reading-editor-1.3').content);
  assert.throws(() => loadReadingEditorContract('unknown'));
});

test('configured-reading-2.2 is the default and retired instruction profiles are rejected', () => {
  assert.equal(buildConfiguredReadingInstructions().instruction_profile, 'configured-reading-2.2');
  for (const instructionProfile of ['configured-reading-2.1', 'configured-reading-2.0', 'configured-reading-1.0'])
    assert.throws(() => buildConfiguredReadingInstructions({}, { instructionProfile }), { code: 'READING_BINDING_RETIRED' });
});
