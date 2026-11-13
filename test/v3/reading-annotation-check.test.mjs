import assert from 'node:assert/strict';
import test from 'node:test';
import { captionPanels, chartTypePanels, checkReadingNote } from '../../scripts/v3/reading-annotation-check.mjs';

const zhNote = `## 3. 方法、概念与测量

> [!info] 克隆系统发育树
> **原理**：最大简约法。
>
> [索引](#3.1) · 本条目未挂链

> [!info] 单细胞RNA测序
> **原理**：条形码。
>
> [单细胞RNA测序](../methods/x.md)

## 4. 主要发现

### 4.1 克隆

两种方法检出相近的克隆数（[图 3B、C](#^rf-visual-fig3)）。扩展数据图 2a 也支持这一点。

**图 3 · 空间克隆图谱** · [原文第5页](a.pdf#page=5) ^rf-visual-fig3

**图型**：b,c: [拷贝数谱热图](../methods/a.md) · a, h: [空间图](../methods/b.md)

![图 3](f.png)

读图时先看 a，再对照[扩展数据图 2](#^rf-visual-edfig2)。

> [!quote] 原图注
> **图 3.** 图 3｜克隆定位。a，空间分布。b–d，拷贝数谱。h，UMAP。

**图 4 · 谱系** · [原文第6页](a.pdf#page=6) ^rf-visual-fig4

![图 4](g.png)

> [!quote] 原图注
> **图 4.** a，树。b，比较。c，分布。

**扩展数据图 2 · 注释** · [原文第9页](a.pdf#page=9) ^rf-visual-edfig2

**图型**：各面板：[UMAP](../methods/c.md)

![扩展数据图 2](h.png)

> [!quote] 原图注
> **扩展数据图 2.** a，注释。b，比例。c，质控。
`;

test('caption and chart-type panel parsing expands ranges', () => {
  assert.deepEqual([...captionPanels('A，曼哈顿图，纵轴为 −log10(P)。B，QQ 图，纵轴为 −log₁₀(P)。')].sort(), ['a', 'b']);
  assert.deepEqual([...captionPanels('图 3｜克隆定位。a，空间。b–d，拷贝数。h，UMAP。')].sort(), ['a', 'b', 'c', 'd', 'h']);
  assert.deepEqual([...captionPanels('Fig. 2 | Atlas. a, Cohort. b–c, Maps. (e) Scores.')].sort(), ['a', 'b', 'c', 'e']);
  assert.deepEqual([...captionPanels('图 2．VB2 缺乏。（A）水平（n = 3）。（C–F）活化后检测（C，n = 3）。')].sort(), ['a', 'c', 'd', 'e', 'f']);
  assert.deepEqual([...chartTypePanels('**图型**：a–c,e: [x](y) · g: [z](w)').panels].sort(), ['a', 'b', 'c', 'e', 'g']);
  assert.equal(chartTypePanels('**Chart type**: Each panel: [x](y)').all, true);
  assert.equal(chartTypePanels('**图型**：[x](y)').unpanelled, true);
  assert.deepEqual([...chartTypePanels('**图型**：a: 参数敏感性折线图 · b: [条形图](x)').panels], ['a', 'b']);
  assert.deepEqual([...chartTypePanels('**图型**：a: ').panels], []);
});

test('a rendered note reports chart-type, panel-citation and card-link gaps', () => {
  const report = checkReadingNote(zhNote, { language: 'zh-CN', nodes: [{ path: 'Wiki/methods/克隆系统发育树.md', names: ['克隆系统发育树', 'Clonal phylogenetic tree'] }] });
  assert.deepEqual(report.missing_chart_type.map(row => row.label), ['图 4']);
  assert.deepEqual(report.uncovered_panels.map(row => [row.label, row.missing]), [['图 3', ['d']]]);
  assert.deepEqual(report.findings_without_panel_citation.map(row => row.label), ['图 4']);
  assert.deepEqual(report.unlinked_cards.map(row => [row.title, row.candidates[0].match]), [['克隆系统发育树', 'exact']]);
});

test('English findings citations are matched by figure family', () => {
  const note = `## 4. Findings

Clones were similar (Extended Data Fig. 3b) and spread widely (Figure 3).

**Fig. 3 · Atlas** · [p. 5](a.pdf#page=5) ^rf-visual-fig3

**Chart type**: a–c: [Heatmap](../methods/a.md)

> [!quote] Original caption
> **Fig. 3.** a, Map. b, Profile. c, Tree.
`;
  const report = checkReadingNote(note, { language: 'en' });
  assert.deepEqual(report.findings_without_panel_citation.map(row => row.label), ['Fig. 3']);
  assert.equal(report.uncovered_panels.length, 0);
  assert.throws(() => checkReadingNote(note, { language: 'fr' }), /READING_ANNOTATION_LANGUAGE_INVALID/);
});

test('panel citations follow an explicit visual anchor across equivalent figure labels', () => {
  const note = `## 4. Key findings

The result appears in [Fig. S2b](#^rf-visual-supp2).

**Supplementary Figure 2** · [p. 5](a.pdf#page=5) ^rf-visual-supp2

**Chart type**: a–c: [Heatmap](../methods/a.md)

> [!quote] Original caption
> **Supplementary Figure 2.** a, Map. b, Profile. c, Tree.
`;
  assert.deepEqual(checkReadingNote(note, { language: 'en' }).findings_without_panel_citation, []);
  assert.equal(checkReadingNote(note.replace('Fig. S2b', 'Fig. S2'), { language: 'en' }).findings_without_panel_citation.length, 1);
  const translated = note.replace('Key findings', '主要发现').replace('Fig. S2b', '图 S2b');
  assert.deepEqual(checkReadingNote(translated, { language: 'zh-CN' }).findings_without_panel_citation, []);
});

test('editorial figure titles still require panel citations and bold prose retains them', () => {
  const note = `## 4. Findings

**Outcome.** The groups differ.

**Group comparison** · [p. 5](a.pdf#page=5) ^rf-visual-fig1

**Chart type**: a–c: [Heatmap](../methods/a.md)

> [!quote] Original caption
> **Fig. 1.** a, Map. b, Profile. c, Tree.
`;
  assert.equal(checkReadingNote(note, { language: 'en' }).findings_without_panel_citation.length, 1);
  const cited = note.replace('The groups differ.', '[Fig. 1b](#^rf-visual-fig1) shows the contrast.');
  assert.deepEqual(checkReadingNote(cited, { language: 'en' }).findings_without_panel_citation, []);
});

test('table footnote letters and a visual cropped to one panel are not read as uncovered panels', () => {
  const note = `## 4. 主要发现

易感位点见表 1。

**表 1 易感变异** · [原文第9页](a.pdf#page=9) ^rf-visual-table1

**图型**：[多层统计表](../methods/a.md)

> [!quote] 原图注
> **表 1.** 表 1｜易感变异。a，rsID。b，P 值。c，MTAG P 值。

**补充图4b QQ图** · [补充材料第5页](s.pdf#page=5) ^rf-visual-supp-fig-4b

**图型**：b: [分位数-分位数图](../methods/b.md)

> [!quote] 原图注
> **QQ图.** 补充图4。a，曼哈顿图。b，QQ图。
`;
  const report = checkReadingNote(note, { language: 'zh-CN' });
  assert.deepEqual(report.uncovered_panels, []);
  assert.deepEqual(report.findings_without_panel_citation, []);
});

test('the earlier layout finds the chart-type line under the visual heading', () => {
  const note = `## 4. Key findings

#### Figure 1 · Source p. 3

**Chart type**: Each panel: [Categorical choropleth map](../methods/a.md)

![Figure 1](f.png)

**Figure 1.** Global maps present (A) areas and (B) development tiers. ^rf-visual-fig1

#### Figure 2 · Source p. 5

![Figure 2](g.png)

**Figure 2.** Pie charts. ^rf-visual-fig2

**Equations 1–4** · [p. 9](a.pdf#page=9) ^rf-visual-eq1
`;
  assert.deepEqual(checkReadingNote(note, { language: 'en' }).missing_chart_type.map(row => row.id), ['fig2']);
});
