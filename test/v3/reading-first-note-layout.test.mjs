import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { registerReaderTargets, validateReaderTargetPath } from '../../scripts/v3/phase221-targets.mjs';
import { createReadingFirstRunControl, renderReadingFirstNotes, snapshotReadingFirstRuntime, restoreReadingFirstRuntime, captureReadingFirstPublicationSource, inspectReadingFirstPublicationSource, restoreReadingFirstPublicationSource } from '../../scripts/v3/reading-first-runtime.mjs';
import { renderReadingFirstObsidian } from '../../scripts/v3/reading-first-obsidian.mjs';
import { commitOwnedArtifact } from '../../scripts/v3/owned-artifact-store.mjs';
import { reviewedReadingFirstFixture } from './helpers/reading-first-publication-source-fixtures.mjs';

const identity = { paper_id: 'pap_' + 'a'.repeat(32), run_id: 'run_' + 'b'.repeat(32) };
const registeredBibliography = { first_author: 'Smith', year: 2024, title: 'A study' };
const register = args => registerReaderTargets({ identity, registeredBibliography, ...args });
function input() {
  return { identity, views: ['en', 'zh-CN'].map(language => ({ language, sections: [{ heading: 'Methods', paragraphs: ['Study methods.'] }] })), presentation: {
    schema_version: 'reading-first-obsidian-1.0', bibliography: registeredBibliography, source_pdf: 'Raw/paper.pdf',
    sections: [{ id: 'methods', indices: { en: 0, 'zh-CN': 0 } }], knowledge_layout: 'shared-bilingual-1.0',
    knowledge: [{ id: 'method', kind: 'method', canonical_key: 'method', title: { en: 'Method', 'zh-CN': '方法' }, paragraphs: { en: ['Background.'], 'zh-CN': ['背景。'] }, placements: [{ section_id: 'methods' }], source_kind: 'method-background' }],
  } };
}

test('new controls freeze source-language note layout and source language', () => {
  for (const sourceLanguage of ['en', 'zh-CN']) {
    const control = createReadingFirstRunControl({ runId: identity.run_id, scientificInput: { identity }, sourceLanguage,
      mainSession: { model: 'gpt-6-astra', reasoning_effort: 'high' }, authorizationId: 'approved', deadline: '2099-01-01', taskBindings: {} });
    assert.equal(control.reading_first_binding.note_layout, 'source-language-1.0');
    assert.equal(control.reading_first_binding.source_language, sourceLanguage);
  }
});

for (const sourceLanguage of ['en', 'zh-CN']) test(`${sourceLanguage} original stays in sources and alternate moves to translations with valid links`, () => {
  const data = { ...input(), noteLayout: 'source-language-1.0', sourceLanguage };
  const rendered = renderReadingFirstObsidian(data);
  const flat = renderReadingFirstObsidian(input());
  for (const note of rendered.notes) {
    const folder = note.language === sourceLanguage ? 'sources' : 'translations';
    assert.ok(note.path.startsWith(`Wiki/${folder}/`));
    assert.equal(path.posix.basename(note.path), path.posix.basename(flat.notes.find(row => row.language === note.language).path));
    const alternate = rendered.notes.find(row => row.language !== note.language);
    assert.ok(note.content.includes(`alternate_language_path: ${alternate.path}`));
    const destinations = [...note.content.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)].map(match => path.posix.normalize(path.posix.join(path.posix.dirname(note.path), decodeURIComponent(match[1]))));
    assert.ok(destinations.includes(alternate.path));
    assert.ok(destinations.includes(rendered.supportNotes[0].path));
  }
  const support = rendered.supportNotes[0];
  const backlinks = [...support.content.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)].map(match => path.posix.normalize(path.posix.join(path.posix.dirname(support.path), decodeURIComponent(match[1]))));
  for (const note of rendered.notes) assert.ok(backlinks.includes(note.path));
  assert.equal(rendered.targetRegistry.note_layout, 'source-language-1.0');
  assert.equal(rendered.targetRegistry.source_language, sourceLanguage);
});

test('missing frozen selection keeps flat targets and reuse never rebinds a registry', () => {
  const historical = register();
  assert.equal(historical.note_layout, undefined);
  for (const target of Object.values(historical.paper_targets)) assert.ok(target.startsWith('Wiki/sources/'));
  assert.deepEqual(register({ existingRegistry: historical, noteLayout: 'source-language-1.0', sourceLanguage: 'zh-CN' }), historical);
  const split = register({ noteLayout: 'source-language-1.0', sourceLanguage: 'en' });
  assert.deepEqual(register({ existingRegistry: split, noteLayout: 'source-language-1.0', sourceLanguage: 'zh-CN' }), split);
  assert.deepEqual(register({ existingRegistry: split }), split);
  const result = renderReadingFirstObsidian({ ...input(), targetRegistry: historical, noteLayout: 'source-language-1.0', sourceLanguage: 'en' });
  assert.deepEqual(result.targetRegistry, historical);
});

test('layout requires a supported source language and rejects unsafe translation paths', () => {
  assert.throws(() => register({ noteLayout: 'source-language-1.0' }), { code: 'P221_TARGET_LAYOUT_INVALID' });
  assert.throws(() => register({ noteLayout: 'unknown', sourceLanguage: 'en' }), { code: 'P221_TARGET_LAYOUT_INVALID' });
  assert.doesNotThrow(() => validateReaderTargetPath('Wiki/translations/paper.zh-CN.md'));
  for (const target of ['Wiki/translations/../paper.en.md', 'Wiki/translations/CON.en.md', 'Wiki/translation/paper.en.md']) {
    assert.throws(() => validateReaderTargetPath(target), { code: 'P221_TARGET_PATH_INVALID' });
  }
});

for (const sourceLanguage of ['en', 'zh-CN', 'legacy']) test(`${sourceLanguage} frozen layout survives runtime checkpoint and publication recipe reload`, async t => {
  const fixture = await reviewedReadingFirstFixture(t, {
    controlOptions: { sourceLanguage: sourceLanguage === 'legacy' ? 'en' : sourceLanguage },
    ...(sourceLanguage === 'legacy' ? { translationLanguage: null, createRunControl: args => {
      const control = structuredClone(createReadingFirstRunControl(args));
      delete control.reading_first_binding.note_layout;
      return control;
    } } : {}),
  });
  const expected = fixture.candidate.notes.map(note => note.path);
  fixture.candidate.notes.forEach(note => assert.ok(note.path.startsWith(`Wiki/${sourceLanguage === 'legacy' || note.language === sourceLanguage ? 'sources' : 'translations'}/`)));
  const checkpoint = snapshotReadingFirstRuntime(fixture.controller);
  const receipt = await commitOwnedArtifact({ artifactRoot: fixture.root, dispatchContext: fixture.broker.dispatchContext,
    capability: fixture.broker.issueCapability({ runId: fixture.runId, actorId: 'controller', role: 'control', artifactPath: 'checkpoint.json', revision: '1' }),
    artifact: { artifact_id: 'checkpoint', content: JSON.stringify(checkpoint) }, expectedRevision: '1' });
  const restored = await restoreReadingFirstRuntime({ handoff: fixture.handoff, runControl: fixture.runControl, checkpointReceipt: receipt });
  assert.equal(restored.ok, true, JSON.stringify(restored.errors));
  assert.deepEqual(renderReadingFirstNotes({ controller: restored.controller }).notes.map(note => note.path), expected);
  const captured = await captureReadingFirstPublicationSource({ controller: fixture.controller, presentation: fixture.candidate });
  const source = await inspectReadingFirstPublicationSource(captured);
  const registered = await restoreReadingFirstPublicationSource(JSON.parse(JSON.stringify(source.recipe)));
  assert.deepEqual((await inspectReadingFirstPublicationSource(registered)).candidate.notes.map(note => note.path), expected);
});
