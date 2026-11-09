import assert from 'node:assert/strict';
import test from 'node:test';
import { validateReadingFirstPreviewFiles } from '../../scripts/v3/reading-first-preview.mjs';

const bilingual = (en, zh) => ({ en, 'zh-CN': zh });
const stepLabels = [
  bilingual('Perturb transporter expression', '改变转运蛋白表达'),
  bilingual('Measure substrate uptake', '测量底物摄取'),
  bilingual('Measure growth in vivo', '测量体内生长'),
  bilingual('Check the assay controls', '核对实验对照'),
];
const findings = [
  bilingual('Uptake fell after perturbation', '扰动后底物摄取下降'),
  bilingual('Replacement restored uptake', '回补恢复底物摄取'),
  bilingual('Growth declined in vivo', '体内生长下降'),
  bilingual('Response differed by model', '响应随模型而异'),
  bilingual('Controls remained stable', '对照保持稳定'),
];
const claims = [
  bilingual('Transporter activity contributes to uptake', '转运蛋白活性有助于底物摄取'),
  bilingual('Replacement recovered assay response', '回补恢复实验响应'),
  bilingual('The in vivo model showed slower growth', '体内模型中生长减慢'),
  bilingual('The response depends on model context', '响应受模型条件影响'),
];
const sectionTitles = {
  en: { design: '2.2 Design', findings: '4.1 Main findings', conclusion: '7.1 Conclusion' },
  'zh-CN': { design: '2.2 研究设计', findings: '4.1 主要发现', conclusion: '7.1 结论' },
};

function inputs(language = 'en') {
  return {
    paperId: 'paper-study',
    language,
    notePath: language === 'en' ? 'Wiki/sources/Study.en.md' : 'Wiki/translations/Study.zh-CN.md',
    sectionTitles: sectionTitles[language],
    primaryFindingIds: ['finding-2'],
    map: {
      steps: stepLabels.map((label, i) => ({ id: `step-${i + 1}`, label, section_id: 'design' })),
      findings: findings.map((label, i) => ({ id: `finding-${i + 1}`, label, section_id: 'findings' })),
      relations: [
        { id: 'rel-a', from: 'step-1', to: 'finding-1' },
        { id: 'rel-b', step_id: 'step-1', finding_id: 'finding-3' },
        { id: 'rel-c', step_id: 'step-2', finding_id: 'finding-1' },
        { id: 'rel-d', step_id: 'step-3', finding_id: 'finding-3' },
      ],
    },
    argument: {
      question: { text: bilingual('Does the transporter affect the model?', '转运蛋白是否影响模型表现？'), section_id: 'design' },
      claims: claims.map((title, i) => ({
        id: `claim-${i + 1}`, title,
        evidence: bilingual('Comparison with matched controls.', '与匹配的对照比较。'),
        limit: i === 3 ? bilingual('Model-specific response.', '响应限于所测模型。') : bilingual('', ''),
        finding_ids: i === 3 ? ['finding-4', 'finding-5'] : [`finding-${i + 1}`],
        branch_id: ['assay', 'assay', 'in-vivo', 'scope'][i], section_id: 'findings',
      })),
      branches: [
        { id: 'assay', name: bilingual('Uptake mechanism', '摄取机制') },
        { id: 'in-vivo', name: bilingual('In vivo test', '体内检验') },
        { id: 'scope', name: bilingual('Model context', '模型条件') },
      ],
      relations: [
        { from: 'question', to: 'claim-1', label: '提出问题' },
        { from: 'claim-1', to: 'claim-2', label: '机制推进' },
        { from: 'claim-1', to: 'claim-3', label: '体内检验' },
        { from: 'claim-2', to: 'claim-4', label: '范围限定' },
        { from: 'claim-3', to: 'conclusion', label: '证据补充' },
        { from: 'claim-4', to: 'conclusion', label: '结果整合' },
      ],
      conclusion: { text: bilingual('Transporter dependence varies across models.', '转运蛋白依赖性因模型而异。'), section_id: 'conclusion' },
    },
  };
}

const implementation = () => import('../../scripts/v3/research-map-canvas.mjs');
const card = (nodes, text) => {
  const matches = nodes.filter(node => node.type === 'text' && node.text.includes(text));
  assert.equal(matches.length, 1, text);
  return matches[0];
};

test('repeated builds yield identical JSON bytes and separate paper and language IDs', async () => {
  const { buildResearchMapCanvas, serializeResearchMapCanvas } = await implementation();
  const input = inputs();
  const before = structuredClone(input);
  const first = buildResearchMapCanvas(input);
  const bytes = serializeResearchMapCanvas(first);
  assert.equal(bytes, serializeResearchMapCanvas(buildResearchMapCanvas(structuredClone(input))));
  assert.deepEqual(JSON.parse(bytes), first);
  assert.deepEqual(input, before);
  const ids = canvas => new Set([...canvas.nodes, ...canvas.edges].map(item => item.id));
  assert.equal(ids(first).size, first.nodes.length + first.edges.length);
  assert.equal(ids(first).intersection(ids(buildResearchMapCanvas(inputs('zh-CN')))).size, 0);
  assert.equal(ids(first).intersection(ids(buildResearchMapCanvas({ ...input, paperId: 'other-paper' }))).size, 0);
});

for (const language of ['en', 'zh-CN']) {
  test(`renders every study step, finding and relation with language-local links (${language})`, async () => {
    const { buildResearchMapCanvas } = await implementation();
    const input = inputs(language);
    const { nodes, edges } = buildResearchMapCanvas(input);
    const steps = stepLabels.map(label => card(nodes, label[language]));
    const results = findings.map(label => card(nodes, label[language]));
    const argumentsShown = claims.map(label => card(nodes, label[language]));
    const question = card(nodes, input.argument.question.text[language]);
    const conclusion = card(nodes, input.argument.conclusion.text[language]);

    const noteTarget = input.notePath.replace(/\.md$/, '');
    const readSection = language === 'en' ? 'Read the section' : '阅读正文';
    const links = [
      [question, 'design', readSection], [conclusion, 'conclusion', readSection],
      ...steps.map((node, i) => [node, 'design', stepLabels[i][language]]),
      ...results.map((node, i) => [node, 'findings', findings[i][language]]),
      ...argumentsShown.map(node => [node, 'findings', readSection]),
    ];
    const canvas = Buffer.from(JSON.stringify({ nodes, edges }));
    const note = Buffer.from(Object.values(input.sectionTitles).map(title => `### ${title}`).join('\n\n'));
    const previewCopy = { path: `Eval/saved-preview/${input.notePath}`, bytes: note };
    for (const canvasPath of [`Figures/run/map.${language}.canvas`, `Moved/map.${language}.canvas`]) {
      const mapFile = { path: canvasPath, bytes: canvas };
      assert.equal(validateReadingFirstPreviewFiles([mapFile, { path: input.notePath, bytes: note }, previewCopy]).local_links, links.length);
      assert.throws(() => validateReadingFirstPreviewFiles([mapFile, previewCopy]), { code: 'RF_PREVIEW_LINK_UNRESOLVED' });
    }
    for (const [node, section, label] of links) {
      assert.ok(node.text.includes(`[[${noteTarget}#${input.sectionTitles[section]}|${label}]]`), node.text);
    }
    assert.ok(steps.every(node => node.width === 300));
    assert.ok(results.every(node => node.width === 340));
    assert.ok(argumentsShown.every(node => node.width === 400));
    assert.equal(steps[0].y, results[0].y);
    assert.ok(steps[1].y < results[1].y, 'second step for a finding is placed within that finding row');
    assert.ok(question.y + question.height < results[0].y);
    assert.ok(conclusion.y > argumentsShown.at(-1).y + argumentsShown.at(-1).height);

    const directEdge = (from, to) => {
      const matches = edges.filter(edge => edge.fromNode === from.id && edge.toNode === to.id);
      assert.equal(matches.length, 1);
      return matches[0];
    };
    directEdge(steps[0], results[0]);
    directEdge(steps[0], results[2]);
    directEdge(steps[1], results[0]);
    directEdge(steps[2], results[2]);
    assert.equal(directEdge(results[1], argumentsShown[1]).color, argumentsShown[1].color);
    assert.equal(results[1].color, argumentsShown[1].color);
    assert.equal(results[0].color, undefined);

    const progression = directEdge(argumentsShown[0], argumentsShown[1]);
    assert.equal(progression.fromSide, 'bottom');
    assert.equal(progression.toSide, 'top');
    assert.ok(progression.label);
    assert.equal(progression.label === '机制推进', language === 'zh-CN');
    const nodeIds = new Set(nodes.map(node => node.id));
    assert.ok(edges.every(edge => nodeIds.has(edge.fromNode) && nodeIds.has(edge.toNode)));
  });
}

for (const language of ['en', 'zh-CN']) {
  test(`routes overlapping right-side relations through separated label cards (${language})`, async () => {
    const { buildResearchMapCanvas, READING_ARGUMENT_RELATION_LABELS } = await implementation();
    const input = inputs(language);
    // Exercise a long English label and an arc that goes upward in the layout.
    input.argument.relations[2].label = '人体旁证';
    input.argument.relations.push({ from: 'claim-4', to: 'claim-3', label: '结果对照' });
    const { nodes, edges } = buildResearchMapCanvas(input);
    const cards = new Map(claims.map((label, i) => [`claim-${i + 1}`, card(nodes, label[language])]));
    cards.set('question', card(nodes, input.argument.question.text[language]));
    cards.set('conclusion', card(nodes, input.argument.conclusion.text[language]));
    const relationLabel = label => language === 'en' ? READING_ARGUMENT_RELATION_LABELS[label] : label;
    assert.ok(nodes.every(node => node.type !== 'text' || node.text.trim()), 'no blank text nodes');
    const labelNodes = new Map(nodes.filter(node => node.type === 'text' && input.argument.relations.some(relation => relationLabel(relation.label) === node.text)).map(node => [node.text, node]));
    const labelsByRelation = input.argument.relations.map(({ from, to, label }) => {
      const text = relationLabel(label);
      const node = labelNodes.get(text);
      if (!node) {
        const direct = edges.filter(edge => edge.fromNode === cards.get(from).id && edge.toNode === cards.get(to).id && edge.label === text);
        assert.equal(direct.length, 1, `${from} → ${to}`);
        assert.equal(direct[0].toEnd, 'arrow');
        return;
      }
      const incoming = edges.filter(edge => edge.toNode === node.id);
      const outgoing = edges.filter(edge => edge.fromNode === node.id);
      assert.equal(incoming.length, 1, text);
      assert.equal(outgoing.length, 1, text);
      assert.equal(incoming[0].fromNode, cards.get(from).id);
      assert.equal(outgoing[0].toNode, cards.get(to).id);
      assert.equal(incoming[0].fromSide, 'right');
      assert.equal(outgoing[0].toSide, 'right');
      assert.equal(incoming[0].toSide, cards.get(from).y < cards.get(to).y ? 'top' : 'bottom');
      assert.equal(outgoing[0].fromSide, cards.get(from).y < cards.get(to).y ? 'bottom' : 'top');
      assert.equal(incoming[0].toEnd, 'arrow');
      assert.equal(outgoing[0].toEnd, 'arrow');
      assert.equal(edges.some(edge => edge.label === text), false, text);
      assert.ok(node.x > cards.get(from).x + cards.get(from).width);
      return node;
    });
    const firstTrack = labelsByRelation[2];
    const secondTrack = labelsByRelation[3];
    assert.ok(firstTrack && secondTrack && labelsByRelation.at(-1), 'competing arcs need labels');
    assert.notEqual(firstTrack.x, secondTrack.x, 'overlapping arcs use different tracks');
    if (language === 'en') assert.ok(firstTrack.width > 200);
    else assert.ok(firstTrack.width >= 96 && firstTrack.height >= 28);

    const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    for (const type of ['text', 'group']) {
      const boxes = nodes.filter(node => node.type === type);
      for (const [i, box] of boxes.entries()) {
        assert.ok(boxes.slice(i + 1).every(other => !overlap(box, other)));
      }
    }
    for (const { name: { [language]: name } } of input.argument.branches) {
      assert.equal(nodes.filter(node => node.type === 'group' && node.label === name).length, 1);
    }
  });
}

test('fails rather than creating a dead link for a section without a title', async () => {
  const { buildResearchMapCanvas } = await implementation();
  const input = inputs();
  input.sectionTitles = { design: '2.2 Design', conclusion: '7.1 Conclusion' };
  assert.throws(() => buildResearchMapCanvas(input), /RF_CANVAS_SECTION_TITLE_MISSING/);
});

test('Canvas links preserve punctuation in note names and escape reserved link characters in actual headings', async () => {
  const { buildResearchMapCanvas } = await implementation();
  const input = inputs();
  input.notePath = 'Wiki/sources/Study (trial).en.md';
  input.sectionTitles = { ...input.sectionTitles, findings: '4.1 Effect at 95% in [Arm A] (*Marker_A*)' };
  input.map.findings[0].label = { ...input.map.findings[0].label, en: 'Uptake fell after perturbation | Arm A' };
  const { nodes } = buildResearchMapCanvas(input);
  const finding = card(nodes, 'Uptake fell after perturbation');
  assert.ok(finding.text.includes(
    '[[Wiki/sources/Study (trial).en#4.1 Effect at 95%25 in %5BArm A%5D (*Marker_A*)|Uptake fell after perturbation | Arm A]]',
  ), finding.text);
});

test('the note fragment embeds and opens the same language Canvas', async () => {
  const { researchMapCanvasSection } = await implementation();
  assert.match(researchMapCanvasSection({ language: 'en', canvasPath: 'Figures/run/research-map.en.canvas' }),
    /!\[\[Figures\/run\/research-map\.en\.canvas\|Research map\|640\]\]\n\n\[\[Figures\/run\/research-map\.en\.canvas\|Open the full research map in Canvas\]\]/);
  assert.match(researchMapCanvasSection({ language: 'zh-CN', canvasPath: 'Figures/run/research-map.zh-CN.canvas' }),
    /!\[\[Figures\/run\/research-map\.zh-CN\.canvas\|研究导图\|640\]\]\n\n\[\[Figures\/run\/research-map\.zh-CN\.canvas\|在 Canvas 中打开完整研究导图\]\]/);
});
