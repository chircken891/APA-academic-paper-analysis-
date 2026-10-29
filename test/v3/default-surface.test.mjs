import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fingerprintV3Json as hash } from '../../scripts/v3/semantic-package-validator.mjs';
import { phase22GenerationPaths } from '../../scripts/v3/phase22-active-version.mjs';
import { checkCommittedIndex } from '../../scripts/check-bm25-index.mjs';
import { PHASE22_REGIONS } from '../../scripts/v3/phase22-render-context.mjs';
import { getIndexManagedBinding } from '../../scripts/v3/phase22-active-version.mjs';
import { inspectV3Graph } from '../../scripts/v3/obsidian-graph.mjs';

const root = process.cwd();

test('default commands expose V3 only and shared setup', async () => {
  const { scripts } = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(scripts.apa, 'node scripts/v3/bilingual.mjs');
  assert.equal(scripts['obsidian:graph:check'], 'node scripts/v3/obsidian-graph.mjs check');
  assert.equal(scripts['obsidian:graph:sync'], 'node scripts/v3/obsidian-graph.mjs sync');
  assert.equal(scripts['setup:mineru'], 'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup/setup-mineru.ps1');
  assert.ok(scripts.test);
  assert.equal(scripts['index:check'], 'node scripts/check-bm25-index.mjs');
  assert.equal(scripts['build-bm25-index'], undefined);
  assert.ok(Object.entries(scripts).every(([key, value]) => !key.includes('v2') && !value.includes('scripts/v2/') && !value.includes('test/v2/')));
});

test('a committed empty generation remains not ready instead of falling back to Wiki', async t => {
  const vaultRoot = await mkdtemp(join(tmpdir(), 'apa-default-empty-'));
  t.after(() => rm(vaultRoot, { recursive: true, force: true }));
  const generation = { schema_version: 'phase22/active-index-1.0', kind: 'active', generation_id: 'empty-g1',
    evidence_mode: 'synthetic', papers: [], objects: [], shared_nodes: [], index_manifest: [] };
  const index = { schema_version: generation.schema_version, kind: 'index', generation_id: generation.generation_id,
    evidence_mode: 'synthetic', active_fingerprint: hash(generation), documents: [] };
  const paths = phase22GenerationPaths(generation.generation_id);
  const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
  const activeBytes = JSON.stringify(generation), indexBytes = JSON.stringify(index);
  const marker = { schema_version: generation.schema_version, kind: 'commit', status: 'COMMITTED', generation_id: generation.generation_id,
    evidence_mode: 'synthetic', active: { path: paths.active, sha256: digest(activeBytes) },
    index: { path: paths.index, sha256: digest(indexBytes) },
    approval: { review_hash: hash({}), output_inventory_hash: hash({}), evidence_mode: 'synthetic' } };
  await mkdir(join(vaultRoot, '.apa-v3/phase22/generations/empty-g1'), { recursive: true });
  await writeFile(join(vaultRoot, paths.active), activeBytes);
  await writeFile(join(vaultRoot, paths.index), indexBytes);
  await writeFile(join(vaultRoot, '.apa-v3/phase22/COMMITTED.json'), JSON.stringify(marker));
  await assert.rejects(checkCommittedIndex(vaultRoot), { code: 'P22_DEFAULT_COMMITTED_EMPTY' });
});

test('default index and graph never admit an uncommitted Wiki note or create a cache', async t => {
  const vaultRoot = await mkdtemp(join(tmpdir(), 'apa-default-surface-'));
  t.after(() => rm(vaultRoot, { recursive: true, force: true }));
  await mkdir(join(vaultRoot, 'Wiki', 'sources'), { recursive: true });
  await writeFile(join(vaultRoot, 'Wiki', 'sources', 'old.md'), '---\ntype: paper\npipeline_version: 2.5\ngraph_scope: v2-canonical\n---\nOld scientific text');
  for (const [script, args] of [
    ['scripts/check-bm25-index.mjs', []],
    ['scripts/v3/obsidian-graph.mjs', ['check']],
    ['scripts/v3/obsidian-graph.mjs', ['proposal']],
    ['scripts/v3/obsidian-graph.mjs', ['sync']],
  ]) {
    const result = spawnSync(process.execPath, [join(root, script), ...args, '--vault-root', vaultRoot], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.status, 'not_ready');
    assert.equal(report.error.code, 'P22_DEFAULT_COMMITTED_REQUIRED');
    assert.deepEqual(await readdir(vaultRoot), ['Wiki']);
  }
});

test('registered index check accepts edited notes and rejects a changed historical index', async t => {
  const vaultRoot = await mkdtemp(join(tmpdir(), 'apa-default-current-'));
  t.after(() => rm(vaultRoot, { recursive: true, force: true }));
  const h = hash({ synthetic: true }), paths = { en: 'Wiki/sources/current.en.md', 'zh-CN': 'Wiki/sources/current.zh-CN.md' };
  const paper = { paper_id: 'current', run_id: 'current-run', analysis_revision: 'r1', core_hash: h, pipeline_version: '3.0',
    basis_fingerprint: h, context_fingerprint: h, view_fingerprints: { en: h, 'zh-CN': h }, paths };
  const generation = { schema_version: 'phase22/active-index-1.0', kind: 'active', generation_id: 'current-g1',
    evidence_mode: 'synthetic', papers: [paper], objects: [], shared_nodes: [] };
  const documents = [];
  await mkdir(join(vaultRoot, 'Wiki/sources'), { recursive: true });
  for (const language of ['en', 'zh-CN']) {
    const note = Buffer.from('---\n' + Object.entries({ type: 'paper', pipeline_version: '3.0', rendering_profile: 'phase22-managed-note-1.0',
      paper_id: paper.paper_id, run_id: paper.run_id, analysis_revision: paper.analysis_revision, language, core_fingerprint: h,
      basis_fingerprint: h, context_fingerprint: h, view_fingerprint: h, evidence_mode: 'synthetic', review_ready: false,
      alternate_language_path: paths[language === 'en' ? 'zh-CN' : 'en'] }).map(([key, value]) => `${key}: ${typeof value === 'string' ? JSON.stringify(value) : value}`).join('\n') + '\n---\n'
      + PHASE22_REGIONS.map(id => `<!-- AUTO:START ${id} -->\nSynthetic committed text ${id}\n<!-- AUTO:END ${id} -->`).join('\n\n') + '\n\n## Personal Notes\n');
    const binding = getIndexManagedBinding(note);
    generation.objects.push({ path: paths[language], kind: 'v3-note', sha256: binding.managedHash });
    for (const region of binding.regions) documents.push({ id: hash({ language, region: region.id }), paper_id: paper.paper_id,
      run_id: paper.run_id, analysis_revision: paper.analysis_revision, core_hash: h, pipeline_version: '3.0', language,
      path: paths[language], section_id: region.id, span_id: 'section:' + region.id, unit_ids: [], anchor: null,
      content: region.content, aliases: '', title: '' });
    await writeFile(join(vaultRoot, paths[language]), note);
  }
  generation.index_manifest = documents.map(document => ({ id: document.id, sha256: hash(document) }));
  const index = { schema_version: generation.schema_version, kind: 'index', generation_id: generation.generation_id,
    evidence_mode: 'synthetic', active_fingerprint: hash(generation), documents };
  const generationPaths = phase22GenerationPaths(generation.generation_id);
  const activeBytes = JSON.stringify(generation), indexBytes = JSON.stringify(index);
  const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
  await mkdir(join(vaultRoot, '.apa-v3/phase22/generations/current-g1'), { recursive: true });
  await writeFile(join(vaultRoot, generationPaths.active), activeBytes);
  await writeFile(join(vaultRoot, generationPaths.index), indexBytes);
  await writeFile(join(vaultRoot, '.apa-v3/phase22/COMMITTED.json'), JSON.stringify({ schema_version: generation.schema_version,
    kind: 'commit', status: 'COMMITTED', generation_id: generation.generation_id, evidence_mode: 'synthetic',
    active: { path: generationPaths.active, sha256: digest(activeBytes) }, index: { path: generationPaths.index, sha256: digest(indexBytes) },
    approval: { review_hash: h, output_inventory_hash: h, evidence_mode: 'synthetic' } }));
  await writeFile(join(vaultRoot, 'Wiki/sources/uncommitted.md'), 'uncommitted text');
  const checked = await checkCommittedIndex(vaultRoot);
  assert.equal(checked.document_count, documents.length);
  const { proposal } = await inspectV3Graph({ vaultRoot, checkConfiguration: false });
  assert.deepEqual(proposal.expectedNodes, [paths['zh-CN']]);
  await mkdir(join(vaultRoot, '.obsidian'));
  await writeFile(join(vaultRoot, '.obsidian/graph.json'), JSON.stringify({ search: proposal.filter, hideUnresolved: true, showOrphans: true, userSetting: 17 }));
  assert.equal((await inspectV3Graph({ vaultRoot })).ok, true);
  await writeFile(join(vaultRoot, paths.en), 'changed published bytes');
  const afterEdit = await checkCommittedIndex(vaultRoot);
  assert.equal(afterEdit.operation, 'validate-registered-index');
  assert.equal(afterEdit.status, 'registered_index_valid');
  await writeFile(join(vaultRoot, generationPaths.index), 'corrupted index');
  await assert.rejects(checkCommittedIndex(vaultRoot), { code: 'P22_DEFAULT_COMMITTED_REQUIRED' });
});
