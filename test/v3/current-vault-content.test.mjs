import test from 'node:test';
import assert from 'node:assert/strict';
import { link, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readingFirstIndexFixture, digest, saveReadingFirstPair } from './helpers/reading-first-index-fixtures.mjs';
import { queryLibrary } from '../../scripts/v3/library-query.mjs';
import { readCommittedGeneration } from '../../scripts/v3/phase22-active-version.mjs';
import { readCurrentVaultContent, readCurrentRegisteredBytes } from '../../scripts/v3/current-vault-content.mjs';

test('current registered notes are searchable after a human changes a heading and body', async t => {
  const f = await readingFirstIndexFixture(t);
  await f.save(await f.build());
  const path = f.paper.paths.en;
  const before = await readFile(join(f.vaultRoot, path), 'utf8');
  assert.equal((await readCommittedGeneration({ vaultRoot: f.vaultRoot })).ok, true);
  const snapshot = await readCurrentVaultContent({ vaultRoot: f.vaultRoot });
  assert.deepEqual(readCurrentRegisteredBytes(snapshot, path).bytes, Buffer.from(before));
  const edited = before.replace('## Findings', '## Newly Edited Findings').replace('finalresultneedle', 'manualeditneedle');
  assert.notEqual(edited, before);
  await writeFile(join(f.vaultRoot, path), edited);
  assert.throws(() => readCurrentRegisteredBytes(snapshot, path), { code: 'P23_CURRENT_CHANGED', details: { path } });
  assert.equal((await readCommittedGeneration({ vaultRoot: f.vaultRoot })).ok, false);
  const found = await queryLibrary({ vaultRoot: f.vaultRoot, query: 'manualeditneedle' });
  assert.equal(found.status, 'matches');
  const hit = found.results[0].hits.find(row => row.path === path);
  assert.ok(hit.text.includes('manualeditneedle'));
  assert.equal(hit.section_id, 'reading');
  assert.ok(hit.sha256.startsWith('sha256:'));
  assert.equal(hit.changed, true);
  assert.equal(await readFile(join(f.vaultRoot, path), 'utf8'), edited);
});

test('committed and current readers reject malformed registered paths', async t => {
  const f = await readingFirstIndexFixture(t);
  const built = await f.build();
  const path = 'Wiki/sources/../invalid.md';
  const generation = { ...built.generation, objects: built.generation.objects.map(row => row.path === f.paper.paths.en ? { ...row, path } : row) };
  await saveReadingFirstPair(f.vaultRoot, generation, built.index);
  for (const read of [readCommittedGeneration, readCurrentVaultContent]) {
    const result = await read({ vaultRoot: f.vaultRoot });
    assert.equal(result.ok, false);
    assert.deepEqual(result.errors, [{ code: 'P22_INDEX_PATH_INVALID', details: { path } }]);
  }
});

test('committed and current readers preserve their diagnostics for linked note paths', async t => {
  for (const kind of ['multiple hard links', 'directory link']) {
    await t.test(kind, async subtest => {
      const f = await readingFirstIndexFixture(subtest);
      await f.save(await f.build());
      const path = f.paper.paths.en;
      const note = join(f.vaultRoot, path);
      if (kind === 'multiple hard links') {
        await link(note, join(f.vaultRoot, 'second-link.md'));
      } else {
        const directory = dirname(note);
        const linkedDirectory = join(f.vaultRoot, 'linked-sources');
        await rename(directory, linkedDirectory);
        await symlink(linkedDirectory, directory, process.platform === 'win32' ? 'junction' : 'dir');
      }
      const committed = await readCommittedGeneration({ vaultRoot: f.vaultRoot });
      assert.equal(committed.ok, false);
      assert.deepEqual(committed.errors, [{ code: 'P22_INDEX_FILE_TYPE', details: { path } }]);
      const current = await readCurrentVaultContent({ vaultRoot: f.vaultRoot });
      assert.equal(current.ok, true);
      assert.equal(current.status, 'partial');
      assert.deepEqual(current.diagnostics.find(row => row.path === path), { code: 'P22_INDEX_FILE_TYPE', path, details: { path } });
    });
  }
});

test('current capture retries a note changing at its observation boundary', async t => {
  const f = await readingFirstIndexFixture(t);
  await f.save(await f.build());
  const { readCurrentVaultContent, readCurrentRegisteredBytes } = await import('../../scripts/v3/current-vault-content.mjs');
  const path = f.paper.paths.en;
  const snapshot = await readCurrentVaultContent({ vaultRoot: f.vaultRoot, onReadBoundary: async (phase, { attempt }) => {
    if (phase === 'after-objects' && attempt === 1) await writeFile(join(f.vaultRoot, path), (await readFile(join(f.vaultRoot, path), 'utf8')).replace('finalresultneedle', 'retriedcurrentneedle'));
  } });
  assert.equal(snapshot.ok, true);
  assert.match(readCurrentRegisteredBytes(snapshot, path).bytes.toString('utf8'), /retriedcurrentneedle/);
});

test('current search includes text before headings and excludes personal notes', async t => {
  const f = await readingFirstIndexFixture(t);
  await f.save(await f.build());
  const path = f.paper.paths.en;
  const before = await readFile(join(f.vaultRoot, path), 'utf8');
  const edited = before.replace(/^(---\r?\n[\s\S]*?\r?\n---\r?\n)/, '$1currentprefixneedle\n\n')
    .replace('## Personal Notes', '## Personal Notes\n\nprivatenoteneedle');
  assert.notEqual(edited, before);
  await writeFile(join(f.vaultRoot, path), edited);
  const found = await queryLibrary({ vaultRoot: f.vaultRoot, query: 'currentprefixneedle' });
  assert.equal(found.status, 'matches');
  assert.equal(found.results[0].hits[0].anchor, null);
  assert.equal((await queryLibrary({ vaultRoot: f.vaultRoot, query: 'privatenoteneedle' })).status, 'no_matches');
});

test('only changes after the published empty personal heading preserve historical review coverage', async t => {
  const f = await readingFirstIndexFixture(t);
  // Use the historical approval state in a synthetic vault to exercise the query flag.
  f.generation.evidence_mode = f.manifest.evidence_mode = 'actual';
  const zh = f.paper.paths['zh-CN'];
  const en = f.paper.paths.en;
  f.notes['zh-CN'] = Buffer.concat([f.notes['zh-CN'], Buffer.from('\nPublished personal content\n')]);
  f.manifest.targets.notes['zh-CN'].byte_sha256 = digest(f.notes['zh-CN']);
  const manifest = f.files.find(row => row.kind === 'reader-presentation');
  manifest.bytes = Buffer.from(JSON.stringify(f.manifest));
  f.paper.reader_presentation.sha256 = digest(manifest.bytes);
  f.generation.objects.find(row => row.path === manifest.path).sha256 = digest(manifest.bytes);
  await f.save(await f.build());

  const query = { vaultRoot: f.vaultRoot, query: 'finalresultneedle' };
  const before = await queryLibrary(query);
  assert.equal(before.scientific_approval, true);
  const personalEdit = Buffer.concat([f.notes.en, Buffer.from('\nOnly personal content changed.\n')]);
  await writeFile(join(f.vaultRoot, en), personalEdit);
  const found = await queryLibrary(query);
  const hit = found.results[0].hits.find(row => row.path === en);
  assert.equal(hit.changed, false);
  assert.equal(hit.sha256, digest(personalEdit));
  assert.equal(found.scientific_approval, true);

  const { readCurrentVaultContent, getCurrentNote } = await import('../../scripts/v3/current-vault-content.mjs');
  assert.equal(getCurrentNote(await readCurrentVaultContent({ vaultRoot: f.vaultRoot }), zh).changed, false);
  await writeFile(join(f.vaultRoot, zh), f.notes['zh-CN'].toString().replace('Published personal content', 'Updated personal content'));
  assert.equal(getCurrentNote(await readCurrentVaultContent({ vaultRoot: f.vaultRoot }), zh).changed, true);
  await writeFile(join(f.vaultRoot, en), personalEdit.toString().replace('holds only', 'applies only'));
  const changed = await queryLibrary(query);
  assert.equal(changed.results[0].hits.find(row => row.path === en).changed, true);
  assert.equal(changed.scientific_approval, false);
});

test('a modified shared knowledge identity is isolated from other searchable content', async t => {
  const f = await readingFirstIndexFixture(t);
  await f.save(await f.build());
  const path = f.manifest.targets.support[0].path;
  const before = await readFile(join(f.vaultRoot, path), 'utf8');
  const edited = before.replace(/knowledge_id: [^\r\n]+/, 'knowledge_id: unrelated-identity');
  assert.notEqual(edited, before);
  await writeFile(join(f.vaultRoot, path), edited);
  const found = await queryLibrary({ vaultRoot: f.vaultRoot, query: 'finalresultneedle' });
  assert.equal(found.status, 'partial');
  assert.ok(found.results.length);
  assert.ok(found.diagnostics.some(row => row.path === path && row.code === 'P23_CURRENT_IDENTITY_MISMATCH'));
});

test('a repeatedly changing note produces a bounded failure without a mixed snapshot', async t => {
  const f = await readingFirstIndexFixture(t);
  await f.save(await f.build());
  const { readCurrentVaultContent } = await import('../../scripts/v3/current-vault-content.mjs');
  const path = f.paper.paths.en;
  let observations = 0;
  const snapshot = await readCurrentVaultContent({ vaultRoot: f.vaultRoot, onReadBoundary: async phase => {
    if (phase === 'after-objects') {
      observations++;
      await writeFile(join(f.vaultRoot, path), (await readFile(join(f.vaultRoot, path), 'utf8')) + '\nedit' + observations);
    }
  } });
  assert.equal(snapshot.ok, false);
  assert.equal(snapshot.errors[0].code, 'P23_CURRENT_CHANGED');
  assert.equal(observations, 2);
});

test('deleting shared node identity or changing its type isolates that node', async t => {
  for (const mutate of [text => text.replace(/^knowledge_id:.*\r?\n/m, ''), text => text.replace(/^canonical_key:.*\r?\n/m, ''),
    text => text.replace(/^type: method\r?$/m, 'type: concept')]) {
    const f = await readingFirstIndexFixture(t);
    await f.save(await f.build());
    const path = f.manifest.targets.support[0].path;
    const before = await readFile(join(f.vaultRoot, path), 'utf8'), edited = mutate(before);
    assert.notEqual(edited, before);
    await writeFile(join(f.vaultRoot, path), edited);
    const found = await queryLibrary({ vaultRoot: f.vaultRoot, query: 'finalresultneedle' });
    assert.equal(found.status, 'partial');
    assert.ok(found.diagnostics.some(row => row.path === path && row.code === 'P23_CURRENT_IDENTITY_MISMATCH'));
  }
});

test('each paper has one hit for the same current path, heading and content', async t => {
  const f = await readingFirstIndexFixture(t);
  await f.save(await f.build());
  const found = await queryLibrary({ vaultRoot: f.vaultRoot, query: 'SyntheticRateAlias' });
  assert.equal(found.status, 'matches');
  for (const group of found.results) {
    const keys = group.hits.map(hit => JSON.stringify([hit.path, hit.anchor, hit.text]));
    assert.equal(new Set(keys).size, keys.length);
  }
});

test('changing registered paper identity isolates that note', async t => {
  const f = await readingFirstIndexFixture(t);
  await f.save(await f.build());
  const path = f.paper.paths.en;
  const before = await readFile(join(f.vaultRoot, path), 'utf8');
  const edited = before.replace(/^paper_id:.*\r?\n/m, '');
  assert.notEqual(edited, before);
  await writeFile(join(f.vaultRoot, path), edited);
  const { readCurrentVaultContent } = await import('../../scripts/v3/current-vault-content.mjs');
  const result = await readCurrentVaultContent({ vaultRoot: f.vaultRoot });
  assert.equal(result.status, 'partial');
  assert.ok(result.diagnostics.some(row => row.path === path && row.code === 'P23_CURRENT_IDENTITY_MISMATCH'));
});

test('personal notes remain excluded when their heading contains trailing spaces', async t => {
  const f = await readingFirstIndexFixture(t);
  await f.save(await f.build());
  const path = f.paper.paths.en;
  const before = await readFile(join(f.vaultRoot, path), 'utf8');
  const edited = before.replace('## Personal Notes', '## Personal Notes   \n\nprivatecontentneedle');
  assert.notEqual(edited, before);
  await writeFile(join(f.vaultRoot, path), edited);
  assert.equal((await queryLibrary({ vaultRoot: f.vaultRoot, query: 'privatecontentneedle' })).status, 'no_matches');
});

test('formatted personal notes heading is excluded and code fence contents do not start the personal area', async t => {
  const f = await readingFirstIndexFixture(t);
  await f.save(await f.build());
  const path = f.paper.paths.en;
  const before = await readFile(join(f.vaultRoot, path), 'utf8');
  const edited = before.replace('## Personal Notes\n', '## **Personal Notes**\n\nprivateformattedneedle\n')
    .replace('finalresultneedle', '\n\n```text\n## Personal Notes\ncodevisiblecontent\n```\n\n');
  assert.notEqual(edited, before);
  await writeFile(join(f.vaultRoot, path), edited);
  assert.equal((await queryLibrary({ vaultRoot: f.vaultRoot, query: 'codevisiblecontent' })).status, 'matches');
  assert.equal((await queryLibrary({ vaultRoot: f.vaultRoot, query: 'privateformattedneedle' })).status, 'no_matches');
});

test('heading-like lines inside fenced code use the actual outer heading anchor', async t => {
  const f = await readingFirstIndexFixture(t);
  await f.save(await f.build());
  const path = f.paper.paths.en;
  const before = await readFile(join(f.vaultRoot, path), 'utf8');
  const edited = before.replace('finalresultneedle', '\n\n~~~text\n## NotAHeading\ncodecontentneedle\n~~~\n\n');
  assert.notEqual(edited, before);
  await writeFile(join(f.vaultRoot, path), edited);
  const found = await queryLibrary({ vaultRoot: f.vaultRoot, query: 'codecontentneedle' });
  assert.equal(found.status, 'matches');
  const hit = found.results[0].hits.find(row => row.path === path);
  assert.ok(hit);
  assert.equal(hit.anchor, 'Findings');
});
