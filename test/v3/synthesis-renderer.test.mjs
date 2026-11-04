import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { renderSynthesisOutput } from '../../scripts/v3/synthesis-renderer.mjs';
import { parseQueryArguments } from '../../scripts/apa-query.mjs';
import { executeLibraryQuery } from '../../scripts/v3/library-query.mjs';
import { readingFirstIndexFixture } from './helpers/reading-first-index-fixtures.mjs';
import { readCurrentVaultContent, getCurrentNote } from '../../scripts/v3/current-vault-content.mjs';

test('draft rendering keeps prose and binds visible strength and attribution to each claim', () => {
  const answer = '## 正文\n\n可能存在连接。[@e1]\n\n## 引用计划\n\ne1';
  const rendered = renderSynthesisOutput({ mode: 'draft', output: { answer, statements: [{ text: '可能存在连接。', evidence_ids: ['e1'], strength: '推测', attribution: '跨篇推断' }] } });
  assert.ok(rendered.includes('可能存在连接。[@e1]'));
  assert.match(rendered, /可能存在连接。.*强度：推测；归属：跨篇推断/s);
  assert.ok(rendered.includes('可能存在连接。[@e1]［强度：推测；归属：跨篇推断］'));
  assert.ok(rendered.endsWith('## 引用计划\n\ne1'));
  assert.equal(renderSynthesisOutput({ mode: 'review', output: { answer } }), answer);
});

test('idea rendering preserves every nearest work, labeled risk, origin and convergence decisions', () => {
  const rendered = renderSynthesisOutput({ mode: 'ideas', output: { answer: '原构思', candidates: [], ideas: [{ idea_id: 'I1', name: '匹配', statement: '比较暴露。', lens: ['边界探查'], contribution_type: '机制解释', risk: { level: '中', source: '局部浓度未知' }, effort: { level: '高', source: '需蛋白平台' }, citations: [{ paper_id: 'p1', path: 'Wiki/a.md', anchor: '7.2', claim_origin: 'analyst' }], most_similar_papers: [{ paper_id: 'p1', overlap: '重叠一', difference: '差异一', conditions: '细胞' }, { paper_id: 'p2', overlap: '重叠二', difference: '差异二', conditions: '动物' }] }], discarded: [{ idea_id: 'I8', reason: '没有数据', criterion: '可行性' }], deferred: [{ idea_id: 'I4', reason: '投入较大', criterion: '是否过度复杂', trigger: '平台建立后' }] } });
  for (const text of ['**风险：**中', '局部浓度未知', '**投入：**高', '需蛋白平台', '重叠一', '重叠二', '条件：动物', '来源归属：分析者推导', '客观淘汰', '暂缓', '平台建立后']) assert.ok(rendered.includes(text), text);
});

test('idea links resolve from a nested output note and scores use readable labels', () => {
  const rendered = renderSynthesisOutput({ mode: 'ideas', outputPath: 'Eval/engineering/check/results.md', output: { answer: '构思', ideas: [{ idea_id: 'I1', statement: '比较', scores: { interest: 6, feasibility: 7, novelty: 5 }, citations: [{ paper_id: 'p1', path: 'Wiki/sources/A paper.md', anchor: '7.2 Future work', claim_origin: 'analyst' }] }] } });
  assert.ok(rendered.includes('../../../Wiki/sources/A%20paper.md#7.2%20Future%20work'));
  assert.ok(rendered.includes('有趣性 6/10；可行性 7/10；新颖性 5/10'));
  assert.ok(!rendered.includes('"interest"'));
});

test('render-result accepts a structured input without requiring a model', () => {
  assert.equal(parseQueryArguments(['render-result', '--input', '-']).input, '-');
});

test('render-result renders current-session output through the actual CLI', () => {
  const cli = fileURLToPath(new URL('../../scripts/apa-query.mjs', import.meta.url));
  const output = { answer: '可能有关。[@e1]', statements: [{ text: '可能有关。', evidence_ids: ['e1'], strength: '推测', attribution: '跨篇推断' }] };
  const child = spawnSync(process.execPath, [cli, 'render-result', '--input', '-'], { input: JSON.stringify({ mode: 'draft', output }), encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  assert.match(JSON.parse(child.stdout).answer, /\[@e1\]［强度：推测；归属：跨篇推断］/);
  assert.equal(output.answer, '可能有关。[@e1]');
});

test('query execution returns labeled prose and retains the raw validated response', async t => {
  const fixture = await readingFirstIndexFixture(t);
  await fixture.save(await fixture.build());
  const snapshot = await readCurrentVaultContent({ vaultRoot: fixture.vaultRoot });
  const path = fixture.paper.paths.en, note = getCurrentNote(snapshot, path);
  const section = note.sections.find(row => row.anchor);
  const output = { answer: '可能有关。[@e1]', statements: [{ text: '可能有关。', evidence_ids: ['e1'], strength: '推测', attribution: '单篇发现' }], outline: ['候选关联'], citation_plan: [{ evidence_ids: ['e1'] }], overstatements: [] };
  let calls = 0;
  const result = await executeLibraryQuery({ repoRoot: fixture.vaultRoot, mode: 'draft', section: 'related-work', question: 'finalresultneedle',
    mainSession: { model: 'synthetic-main', reasoning_effort: 'high' }, hostCapabilities: { currentSession: true },
    writingContext: { projectData: { evidence_records: [{ evidence_id: 'e1', citations: [{ paper_id: fixture.identity.paper_id, path, anchor: section.anchor, sha256: note.sha256 }], polarity: '支持', strength: '观察', allowed_statement: '在本体系中可能有关。', forbidden_statement: '普遍因果关系已证实。', relationship: '研究背景' }], ideas: [], discarded_ideas: [], sections: [], citation_plan: [] }, adoptedSources: [{ paper_id: fixture.identity.paper_id }] },
    executeHost: async () => { calls++; return output; } });
  assert.equal(calls, 1);
  assert.equal(result.output.answer, output.answer);
  assert.match(result.answer, /\[@e1\]［强度：推测；归属：单篇发现］/);
});
