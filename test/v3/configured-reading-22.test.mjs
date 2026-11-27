import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { exportPublicApa } from '../../scripts/setup/export-public-apa.mjs';
import { DEFAULT_CONFIGURED_INSTRUCTION_PROFILE, buildConfiguredReadingInstructions, deriveConfiguredMaxCalls } from '../../scripts/v3/configured-reading.mjs';
import { evaluateReadingPreflight } from '../../scripts/lib/reading-preflight.mjs';
import { CONTENT_COMPLETE_READING_PROFILE, METHODS_FIRST_READING_PROFILE } from '../../scripts/lib/reading-profiles.mjs';

test('2.4 default freezes new prompt and derives bounded budget', () => {
  assert.equal(DEFAULT_CONFIGURED_INSTRUCTION_PROFILE, CONTENT_COMPLETE_READING_PROFILE);
  const pack = buildConfiguredReadingInstructions();
  assert.equal(pack.instruction_profile, CONTENT_COMPLETE_READING_PROFILE);
  assert.equal(pack.frozen_support.science_index.metadata.profile, 'science-index-1.1');
  assert.equal(pack.frozen_support.role_reply.metadata.profile, 'role-reply-1.0');
  assert.match(pack.frozen_support.role_reply.content, /\S/);
  for (const item of Object.values(pack.frozen_support)) {
    assert.equal(item.metadata.sha256, 'sha256:' + createHash('sha256').update(item.content).digest('hex'));
    assert.equal(item.metadata.byte_length, Buffer.byteLength(item.content));
  }
  assert.throws(() => buildConfiguredReadingInstructions({}, {instructionProfile:'configured-reading-2.1'}), { code: 'READING_BINDING_RETIRED' });
  assert.equal(deriveConfiguredMaxCalls({ maxTotalCalls: 14, presentationMode: 'reading-editor' }), 8);
  assert.equal(deriveConfiguredMaxCalls({ maxTotalCalls: 11, presentationMode: 'reading-editor' }), 5);
  assert.equal(deriveConfiguredMaxCalls({ maxTotalCalls: 20, presentationMode: 'writer' }), 6);
  assert.throws(() => deriveConfiguredMaxCalls({ maxTotalCalls: 9, presentationMode: 'reading-editor' }), /BUDGET/);
});

test('2.3 freezes its own science, reading and Editor prompt bytes', async () => {
  const pack = buildConfiguredReadingInstructions({}, { instructionProfile: METHODS_FIRST_READING_PROFILE });
  assert.equal(pack.instruction_profile, METHODS_FIRST_READING_PROFILE);
  assert.deepEqual(pack.prompt_files.map(row => basename(row.path)), [
    'science-configured-2.3.md', 'reading-configured-2.3.md', 'reading-editor-1.5.md',
  ]);
  for (const row of pack.prompt_files) {
    const bytes = await readFile(row.path);
    assert.equal(row.byte_length, bytes.length);
    assert.equal(row.sha256, 'sha256:' + createHash('sha256').update(bytes).digest('hex'));
  }
  assert.ok(pack.science_sections.Integrator);
  assert.match(pack.science_sections['Common scientific contract'], /A shared node lists paper applications as links to the specific explanatory sections/);
  assert.match(pack.sections['Common data contract'], /include `application_section_ids` for every shared `method-background` entry even when Editor is disabled/);
  assert.match(pack.sections.Translation, /Copy `knowledge_content\[\]\.application_section_ids` unchanged/);
  assert.match(pack.sections['Overall Verifier'], /verify that 3\.1 shows the expanded numbered Methods and concepts index/);
  assert.match(pack.sections['Reading Editor'], /methods: \[\{id, title, explanation, application,/);
  assert.match(pack.sections['Reading Editor'], /first substantive use across the paper body/);
});

for (const instructionProfile of ['configured-reading-2.2', METHODS_FIRST_READING_PROFILE, 'configured-reading-2.4'])
test(instructionProfile + ' requires referenced Results tool capabilities', () => {
  const base = { inspection: {validation:{complete:true},dependencies:[{key:'parser.python',path:process.execPath,status:'available'}]}, instructionProfile };
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


test('public export includes both configured prompt packs and execution and verification inputs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'apa-public-reading-22-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputRoot = join(root, 'public');
  await exportPublicApa({ outputRoot });
  const manifest = JSON.parse(await readFile(join(outputRoot, 'apa-public-manifest.json'), 'utf8'));
  const exported = new Set(manifest.files.map(row => row.path));
  const packageJson = JSON.parse(await readFile(join(outputRoot, 'package.json'), 'utf8'));
  const tests = new Set(packageJson.scripts['test:v3'].split(' '));
  const files = ['scripts/lib/reading-resource-tool.py', 'scripts/lib/reading-profiles.mjs', 'scripts/v3/reading-controller-audit.mjs',
    'scripts/v3/reading-host-evidence.mjs', 'scripts/v3/reading-resources.mjs', 'scripts/v3/reading-runtime-binding.mjs',
    'scripts/v3/reading-session-cli.mjs', 'prompts/v3/science-configured-2.2.md', 'prompts/v3/reading-configured-2.2.md',
    'prompts/v3/science-configured-2.3.md', 'prompts/v3/reading-configured-2.3.md', 'prompts/v3/reading-editor-1.5.md'];
  for (const file of files) assert.ok(exported.has(file), file);
  for (const file of ['test/v3/configured-reading-22.test.mjs','test/v3/reading-resources.test.mjs','test/v3/reading-runtime-binding.test.mjs','test/v3/reading-session-22.test.mjs','test/v3/reading-session-cli-audit.test.mjs']) {
    assert.ok(exported.has(file), file);
    assert.ok(tests.has(file), file);
  }
});


test('2.2 assigns scientific merging to Integrator and continues translation', () => {
  const pack = buildConfiguredReadingInstructions({}, { instructionProfile: 'configured-reading-2.2' });
  const translation = pack.sections.Translation;
  assert.match(translation, /Continue processing all remaining segments in the same execution/);
  assert.doesNotMatch(translation, /completion in one call is not guaranteed/);
  assert.match(pack.sections['Scientific Enrichment'], /Integrator merges accepted explanations/);
  assert.doesNotMatch(pack.sections['Scientific Enrichment'], /Integrator\/Controller merges/);
  assert.match(pack.science_sections['Results/Visuals Specialist'], /Controller schedules and passes owned artifacts only/);
  assert.match(pack.science_sections['Results/Visuals Specialist'], /resource_manifest/);
  assert.match(pack.science_sections.Integrator, /visual_handoff\.resource_manifest/);
});
