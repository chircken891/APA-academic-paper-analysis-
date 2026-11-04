import test from 'node:test';
import assert from 'node:assert/strict';
import { validateApaConfig, APA_IDEATION_SKILLS } from '../../scripts/lib/apa-config.mjs';
import { writingSkills, fields } from '../../Templates/apa-setup/page.js';

test('optional ideation guides do not become missing reading choices or default enabled values', () => {
  const config = { schema_version: 'apa-local-config-1.0' };
  const result = validateApaConfig(config);
  for (const key of APA_IDEATION_SKILLS) {
    assert.ok(!result.missing.some(row => row.includes(key)));
    assert.ok(writingSkills.includes(key));
    assert.ok(fields.some(row => row.key === 'writing_skills.' + key));
  }
  assert.equal(config.writing_skills, undefined);
});
test('enabled ideation guides require a path while disabled guides and existing config remain valid', () => {
  const config = { schema_version: 'apa-local-config-1.0', writing_skills: { 'brainstorming-research-ideas': { enabled: true } } };
  assert.ok(validateApaConfig(config).missing.includes('writing_skills.brainstorming-research-ideas.path'));
  config.writing_skills['brainstorming-research-ideas'].path = 'guides/SKILL.md';
  config.writing_skills['creative-thinking-for-research'] = { enabled: false };
  assert.equal(validateApaConfig(config, { capability: 'query' }).valid, true);
});
