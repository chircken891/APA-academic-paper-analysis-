import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { renderReadingFirstObsidian } from '../../../scripts/v3/reading-first-obsidian.mjs';
import { fingerprintV3Json as hash } from '../../../scripts/v3/semantic-package-validator.mjs';
import { buildBilingualIndex } from '../../../scripts/v3/phase22-search.mjs';
import { phase22GenerationPaths, PHASE22_COMMIT_PATH } from '../../../scripts/v3/phase22-active-version.mjs';

export const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
export async function readingFirstIndexFixture(t, { suffix = 'a', vaultRoot, knowledgeRegistry = [] } = {}) {
  const root = vaultRoot ?? await mkdtemp(join(tmpdir(), 'reading-first-index-'));
  if (!vaultRoot) t.after(() => rm(root, { recursive: true, force: true }));
  const identity = { paper_id: 'pap_' + suffix.repeat(32), run_id: 'run_' + suffix.repeat(32), analysis_revision: 'rev_' + suffix.repeat(32) };
  const scientific = hash({ synthetic: identity });
  const presentation = {
    schema_version: 'reading-first-obsidian-1.0', knowledge_layout: 'shared-bilingual-1.0',
    bibliography: { title: { en: 'A synthetic study ' + suffix, 'zh-CN': '合成研究' + suffix }, first_author: 'Synthetic', year: 2026 },
    source_pdf: 'Raw/synthetic-' + suffix + '.pdf',
    sections: [{ id: 'methods', indices: { en: 0, 'zh-CN': 0 } }, { id: 'results', indices: { en: 1, 'zh-CN': 1 } }],
    visuals: [{ id: 'figure', kind: 'figure', label: { en: 'Figure', 'zh-CN': '图' }, caption: { en: 'Synthetic caption.', 'zh-CN': '合成图注。' }, path: 'Figures/synthetic-' + suffix + '.png', page: 1, section_id: 'results' }],
    knowledge: [{ id: 'rate', canonical_key: 'synthetic-rate', kind: 'method', title: { en: 'Synthetic rate', 'zh-CN': '合成率' }, source_kind: 'method-background', aliases: ['SyntheticRateAlias'], paragraphs: { en: ['Only sharedknowledgeneedle is explained here.'], 'zh-CN': ['这里专门解释共享知识检索词。'] }, placements: [{ section_id: 'methods' }] }],
  };
  const views = ['en', 'zh-CN'].map(language => ({ language, sections: [
    { heading: language === 'en' ? 'Methods' : '方法', paragraphs: [language === 'en' ? 'Connected synthetic design.' : '连贯合成设计。'] },
    { heading: language === 'en' ? 'Findings' : '发现', paragraphs: [language === 'en' ? 'The finalresultneedle holds only in this synthetic comparison.' : '最终结果检索词仅适用于此合成比较。'] },
  ] }));
  const rendered = renderReadingFirstObsidian({ identity, presentation, views, knowledgeRegistry });
  const manifestPath = '.apa-v3/reading-first/presentation/' + identity.run_id + '.json';
  const notes = Object.fromEntries(rendered.notes.map(note => [note.language, note.bytes]));
  const manifest = {
    schema_version: 'reading-first-publication-1.0', profile: 'reading-first-obsidian-1.0', identity,
    presentation_fingerprint: hash(rendered.notes.map(note => note.content)), scientific_input_fingerprint: scientific,
    evidence_mode: 'synthetic', dependencies: { scientific_input: scientific },
    qualification: { reading_status: 'reading_complete', native_status: 'not_run' },
    targets: { presentation: manifestPath,
      notes: Object.fromEntries(rendered.notes.map(note => [note.language, { path: note.path, managed_hash: note.managedHash, byte_sha256: digest(note.bytes) }])),
      support: rendered.supportNotes.map(note => ({ entity_id: note.id, path: note.path })), assets: rendered.assetPaths }, navigation: [],
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest) + '\n');
  const files = [
    { path: manifestPath, kind: 'reader-presentation', bytes: manifestBytes },
    ...rendered.supportNotes.map(note => ({ path: note.path, kind: 'support', bytes: note.bytes })),
    ...rendered.assetPaths.map(path => ({ path, kind: 'asset', bytes: Buffer.from('Synthetic asset: ' + path) })),
  ];
  const paper = { ...identity, core_hash: scientific, pipeline_version: '3.0', profile: manifest.profile,
    dependencies: manifest.dependencies, paths: rendered.targetRegistry.paper_targets,
    reader_presentation: { path: manifestPath, sha256: digest(manifestBytes) } };
  const generation = { schema_version: 'phase22/active-index-1.0', kind: 'active', generation_id: 'rf-' + suffix,
    evidence_mode: 'synthetic', papers: [paper], shared_nodes: manifest.targets.support,
    objects: [...rendered.notes.map(note => ({ path: note.path, kind: 'v3-note', sha256: note.managedHash })),
      ...files.map(file => ({ path: file.path, kind: file.kind, sha256: digest(file.bytes) }))] };
  const validatedInputs = { papers: [{ readingFirst: manifest, notes }], files };
  const allFiles = () => [...files, ...Object.entries(notes).map(([language, bytes]) => ({ path: paper.paths[language], bytes, kind: 'v3-note' }))];
  const save = async built => {
    for (const { path, bytes } of allFiles()) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), bytes); }
    await saveReadingFirstPair(root, built.generation, built.index);
  };
  return { vaultRoot: root, identity, rendered, manifest, files, paper, generation, validatedInputs, notes, allFiles,
    build: () => buildBilingualIndex({ generation, validatedInputs }), save };
}

export async function saveReadingFirstPair(vaultRoot, generation, index) {
  const paths = phase22GenerationPaths(generation.generation_id), active = Buffer.from(JSON.stringify(generation)), bytes = Buffer.from(JSON.stringify(index));
  await mkdir(dirname(join(vaultRoot, paths.active)), { recursive: true });
  await writeFile(join(vaultRoot, paths.active), active); await writeFile(join(vaultRoot, paths.index), bytes);
  await writeFile(join(vaultRoot, PHASE22_COMMIT_PATH), JSON.stringify({ schema_version: 'phase22/active-index-1.0', kind: 'commit', status: 'COMMITTED',
    generation_id: generation.generation_id, evidence_mode: generation.evidence_mode, active: { path: paths.active, sha256: digest(active) }, index: { path: paths.index, sha256: digest(bytes) },
    approval: { review_hash: hash({ synthetic: 'index-consumer fixture only' }), output_inventory_hash: hash(generation.objects), evidence_mode: generation.evidence_mode } }));
}
