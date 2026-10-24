import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createRegisteredHistoricalFixture } from './phase221-fixtures.mjs';
import { readHistoricalReaderInput } from '../../../scripts/v3/phase221-historical-input.mjs';
import { renderReaderNotes } from '../../../scripts/v3/phase221-presentation.mjs';
import { registerReaderTargets } from '../../../scripts/v3/phase221-targets.mjs';
import { fingerprintV3Json as hash } from '../../../scripts/v3/semantic-package-validator.mjs';
import { buildBilingualIndex } from '../../../scripts/v3/phase22-search.mjs';
import { PHASE22_COMMIT_PATH, phase22GenerationPaths } from '../../../scripts/v3/phase22-active-version.mjs';
import { inspectManagedNote } from '../../../scripts/v3/phase22-managed-markdown.mjs';

const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const profile = 'phase22-reader-note-1.0';
export async function readerIndexFixture(t, options = {}) {
  const f = await createRegisteredHistoricalFixture(t, { ...options, mutateView(view, language, fixture) {
    view.sections.at(-1).paragraphs.at(-1).spans.at(-1).text += view.language === 'en' ? ' finalreaderneedle.' : ' 后半最终读者检索词。';
    options.mutateView?.(view, language, fixture);
  } });
  const input = await readHistoricalReaderInput(f.args);
  const registry = registerReaderTargets({ identity: f.basis.identity, registeredBibliography: { first_author: 'Synthetic', year: 2026, title: 'Reader index' } });
  let presentation = await renderReaderNotes({ input, targetRegistry: registry });
  if (options.mergeHuman) {
    const existingTargets = ['en', 'zh-CN'].map(language => {
      const initial = presentation[language === 'en' ? 'en' : 'zhCN'];
      const bytes = Buffer.from(initial.toString().replace('<!-- AUTO:START source -->', '<!-- preserved human prefix 😀 -->\n<!-- AUTO:START source -->') + '\nprivatehumanneedle\n');
      return { path: registry.paper_targets[language], bytes, managedHash: inspectManagedNote(bytes).managedHash };
    });
    presentation = await renderReaderNotes({ input, targetRegistry: registry, existingTargets });
  }
  const manifest = presentation.manifest;
  const notes = { en: presentation.en, 'zh-CN': presentation.zhCN };
  const files = [{ path: manifest.targets.presentation, bytes: presentation.presentationBytes, kind: 'reader-presentation' },
    ...presentation.readingRecords.map(row => ({ path: row.target_path, bytes: row.bytes, kind: 'reader-record' })),
    ...presentation.supportNotes.map(row => ({ path: row.target_path ?? row.path, bytes: row.bytes, kind: 'support' })),
    ...presentation.assets.map(row => ({ path: row.target_path, bytes: row.bytes, kind: 'asset' }))];
  const paper = { ...manifest.identity, pipeline_version: '3.0', profile, core_hash: hash(f.data.core),
    dependencies: manifest.dependencies, paths: registry.paper_targets,
    reader_presentation: { path: manifest.targets.presentation, sha256: sha(presentation.presentationBytes) } };
  const generation = { schema_version: 'phase22/active-index-1.0', kind: 'active', generation_id: 'synthetic-reader-g1', evidence_mode: 'synthetic', papers: [paper],
    objects: [...Object.entries(notes).map(([language]) => ({ path: paper.paths[language], kind: 'v3-note', sha256: manifest.targets.notes[language].managed_hash })),
      ...files.map(({ path, bytes, kind }) => ({ path, kind, sha256: sha(bytes) }))],
    shared_nodes: files.filter(row => row.kind === 'support').map(row => ({ entity_id: f.context.entityMappings.find(entity => entity.target_path === row.path).entity_id, path: row.path })) };
  const validatedInputs = { papers: [{ presentation, notes }], v2: [], files };
  const vaultRoot = join(f.artifactRoot, 'reader-consumer-vault');
  const build = () => buildBilingualIndex({ validatedInputs, generation });
  const save = async built => {
    for (const { path, bytes } of [...files, ...Object.entries(notes).map(([language, bytes]) => ({ path: paper.paths[language], bytes }))]) {
      await mkdir(dirname(join(vaultRoot, path)), { recursive: true }); await writeFile(join(vaultRoot, path), bytes);
    }
    await savePair(vaultRoot, built.generation, built.index);
  };
  return { ...f, input, registry, presentation, manifest, notes, files, paper, generation, validatedInputs, vaultRoot, build, save };
}
export async function savePair(vaultRoot, generation, index) {
  const paths = phase22GenerationPaths(generation.generation_id), active = Buffer.from(JSON.stringify(generation)), bytes = Buffer.from(JSON.stringify(index));
  await mkdir(dirname(join(vaultRoot, paths.active)), { recursive: true });
  await writeFile(join(vaultRoot, paths.active), active); await writeFile(join(vaultRoot, paths.index), bytes);
  await writeFile(join(vaultRoot, PHASE22_COMMIT_PATH), JSON.stringify({ schema_version: 'phase22/active-index-1.0', kind: 'commit', status: 'COMMITTED',
    generation_id: generation.generation_id, evidence_mode: 'synthetic', active: { path: paths.active, sha256: sha(active) }, index: { path: paths.index, sha256: sha(bytes) },
    approval: { review_hash: hash({ isolated: 'synthetic consumer fixture only' }), output_inventory_hash: hash(generation.objects), evidence_mode: 'synthetic' } }));
}
