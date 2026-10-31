import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { loadReadingEditorContract, readingEditorInstructions, assertReadingEditorContract } from '../../scripts/v3/reading-first-editor-contract.mjs';
import { buildConfiguredReadingInstructions } from '../../scripts/v3/configured-reading.mjs';

test('new instruction profile freezes complete prompts and editor contract', () => {
  const result = buildConfiguredReadingInstructions({}, { instructionProfile: 'configured-reading-2.0' });
  assert.equal(result.instruction_profile, 'configured-reading-2.0');
  assert.equal(result.prompt_files.length, 3);
  assert.ok(result.sections.Translation);
  assert.ok(result.sections['Reading Editor'].includes('reading-editor-1.3'));
  assert.ok(result.science_sections['Common scientific contract']);
  const metadata = loadReadingEditorContract('reading-editor-1.3').metadata;
  assertReadingEditorContract({ presentation_profile: 'reading-editor-1.3', presentation_contract: metadata });
  assert.equal(readingEditorInstructions('untouched', 'reading-editor-1.3'), loadReadingEditorContract('reading-editor-1.3').content);
  assert.throws(() => loadReadingEditorContract('unknown'));
});

test('new configured instruction profile is the default and old selection remains available', () => {
  assert.equal(buildConfiguredReadingInstructions().instruction_profile, 'configured-reading-2.2');
  assert.equal(buildConfiguredReadingInstructions({}, { instructionProfile: 'configured-reading-2.1' }).instruction_profile, 'configured-reading-2.1');
  assert.equal(buildConfiguredReadingInstructions({}, { instructionProfile: 'configured-reading-2.0' }).instruction_profile, 'configured-reading-2.0');
  const legacy = buildConfiguredReadingInstructions({}, { instructionProfile: 'configured-reading-1.0' });
  assert.equal(legacy.instruction_profile, undefined);
  assert.equal(legacy.flow_corrections.schema_version, 'flow-corrections-1.0');
  assert.match(legacy.sections['Reading Editor'], /reading-editor-1\.2/);
});
