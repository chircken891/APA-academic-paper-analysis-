import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DEFAULT_CONFIGURED_INSTRUCTION_PROFILE, buildConfiguredReadingInstructions, deriveConfiguredMaxCalls } from '../../scripts/v3/configured-reading.mjs';
import { evaluateReadingPreflight } from '../../scripts/lib/reading-preflight.mjs';

test('2.2 default freezes new prompt and derives bounded budget', () => {
  assert.equal(DEFAULT_CONFIGURED_INSTRUCTION_PROFILE, 'configured-reading-2.2');
  const pack = buildConfiguredReadingInstructions();
  assert.equal(pack.instruction_profile, 'configured-reading-2.2');
  assert.equal(pack.frozen_support.science_index.metadata.profile, 'science-index-1.0');
  assert.equal(pack.frozen_support.role_reply.metadata.profile, 'role-reply-1.0');
  assert.match(pack.frozen_support.role_reply.content, /\S/);
  for (const item of Object.values(pack.frozen_support)) {
    assert.equal(item.metadata.sha256, 'sha256:' + createHash('sha256').update(item.content).digest('hex'));
    assert.equal(item.metadata.byte_length, Buffer.byteLength(item.content));
  }
  assert.equal(buildConfiguredReadingInstructions({}, {instructionProfile:'configured-reading-2.1'}).frozen_support, undefined);
  assert.equal(deriveConfiguredMaxCalls({ maxTotalCalls: 14, presentationMode: 'reading-editor' }), 8);
  assert.equal(deriveConfiguredMaxCalls({ maxTotalCalls: 11, presentationMode: 'reading-editor' }), 5);
  assert.equal(deriveConfiguredMaxCalls({ maxTotalCalls: 20, presentationMode: 'writer' }), 6);
  assert.throws(() => deriveConfiguredMaxCalls({ maxTotalCalls: 9, presentationMode: 'reading-editor' }), /BUDGET/);
});

test('2.2 requires referenced Results tool capabilities', () => {
  const base = { inspection: {validation:{complete:true},dependencies:[{key:'parser.python',path:process.execPath,status:'available'}]}, instructionProfile:'configured-reading-2.2' };
  let checks = evaluateReadingPreflight(base).checks;
  assert.equal(checks.find(x => x.id === 'results_python').status, 'unknown');
  const evidence = { results_tools: { python:{status:'pass',path:process.execPath,source:'observed',reference:'probe',method:'probe execution',observation:'available'}, libraries:{status:'pass',names:['fitz'],source:'tool-declaration',reference:'tool',method:'inspect declaration',observation:'fitz declared'}, visual_read:{status:'pass',source:'observed',reference:'probe',method:'probe execution',observation:'available'}, file_read:{status:'pass',source:'observed',reference:'probe',method:'probe execution',observation:'available'} } };
  checks = evaluateReadingPreflight({...base,evidence}).checks;
  for (const id of ['results_python','results_libraries','results_visual_read','results_file_read']) assert.equal(checks.find(x => x.id === id).status, 'pass');
  evidence.results_tools.file_read.method = '';
  assert.equal(evaluateReadingPreflight({...base,evidence}).checks.find(x => x.id === 'results_file_read').status, 'unknown');
  evidence.results_tools.file_read.method = 'probe execution';
  evidence.results_tools.visual_read.observation = '';
  assert.equal(evaluateReadingPreflight({...base,evidence}).checks.find(x => x.id === 'results_visual_read').status, 'unknown');
  evidence.results_tools.visual_read.observation = 'available';
  assert.match(evaluateReadingPreflight({...base,evidence}).checks.find(x => x.id === 'results_libraries').reason, /tool-declaration/);
  assert.equal(evaluateReadingPreflight({...base,evidence: {}}).checks.find(x => x.id === 'results_python').route, 'setup');
  assert.equal(evaluateReadingPreflight({...base,evidence: {}}).checks.find(x => x.id === 'host').route, 'setup');
  assert.equal(evaluateReadingPreflight({...base,evidence: {}}).checks.find(x => x.id === 'control_write').route, 'engineering');
  evidence.results_tools.libraries.names = ['Pillow'];
  assert.equal(evaluateReadingPreflight({...base,evidence}).checks.find(x => x.id === 'results_libraries').status, 'unknown');
  evidence.results_tools.libraries.names = ['fitz'];
  evidence.results_tools.python.path = process.execPath + '.missing';
  assert.equal(evaluateReadingPreflight({...base,evidence}).checks.find(x => x.id === 'results_python').status, 'unknown');
  evidence.results_tools.python.path = process.execPath;
  evidence.results_tools.python.reference = '';
  assert.equal(evaluateReadingPreflight({...base,evidence}).checks.find(x => x.id === 'results_python').status, 'unknown');
  assert.equal(evaluateReadingPreflight({...base,instructionProfile:'configured-reading-2.1'}).checks.some(x=>x.id==='results_python'), false);
});


test('public export includes 2.2 execution and verification inputs', () => {
  const spec = JSON.parse(readFileSync(new URL('../../config/apa-public-files.json', import.meta.url)));
  const files = ['scripts/lib/reading-resource-tool.py', 'scripts/v3/reading-controller-audit.mjs', 'scripts/v3/reading-host-evidence.mjs', 'scripts/v3/reading-resources.mjs', 'scripts/v3/reading-runtime-binding.mjs', 'scripts/v3/reading-session-cli.mjs', 'prompts/v3/science-configured-2.2.md', 'prompts/v3/reading-configured-2.2.md'];
  for (const file of files) assert.ok(spec.files.includes(file), file);
  for (const file of ['test/v3/configured-reading-22.test.mjs','test/v3/reading-resources.test.mjs','test/v3/reading-runtime-binding.test.mjs','test/v3/reading-session-22.test.mjs','test/v3/reading-session-cli-audit.test.mjs']) {
    assert.ok(spec.files.includes(file), file); assert.ok(spec.tests.includes(file), file);
  }
});


test('2.2 assigns scientific merging to Integrator and continues translation', () => {
  const pack = buildConfiguredReadingInstructions();
  const translation = pack.sections.Translation;
  assert.match(translation, /Continue processing all remaining segments in the same execution/);
  assert.doesNotMatch(translation, /completion in one call is not guaranteed/);
  assert.match(pack.sections['Scientific Enrichment'], /Integrator merges accepted explanations/);
  assert.doesNotMatch(pack.sections['Scientific Enrichment'], /Integrator\/Controller merges/);
  assert.match(pack.science_sections['Results/Visuals Specialist'], /Controller schedules and passes owned artifacts only/);
  assert.match(pack.science_sections['Results/Visuals Specialist'], /resource_manifest/);
  assert.match(pack.science_sections.Integrator, /visual_handoff\.resource_manifest/);
});
