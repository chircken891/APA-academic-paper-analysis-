import { createHash } from 'node:crypto';

export const READING_ARGUMENT_RELATION_LABELS = Object.freeze({
  提出问题: 'Question framing',
  机制推进: 'Mechanistic progression',
  体内检验: 'In vivo test',
  干预检验: 'Intervention test',
  人体旁证: 'Supporting human evidence',
  设计推导: 'Design rationale',
  证据补充: 'Additional evidence',
  结果对照: 'Comparison of results',
  范围限定: 'Scope limitation',
  结果整合: 'Synthesis of results',
});

const STEP = { x: 0, width: 300 };
const FINDING = { x: 400, width: 340 };
const CLAIM = { x: 860, width: 400 };
const ROW_GAP = 16;
const CLAIM_GAP = 70;
const BRANCH_COLORS = ['5', '2', '4', '#64748b', '6', '3', '1', '#0f766e'];
const labels = {
  en: {
    steps: 'Research steps', findings: 'Findings', question: 'Research question', conclusion: 'Conclusion',
    legend: 'How to read the map', evidence: 'Evidence', limit: 'Limitation', section: 'Read the section',
    title: 'Research map', open: 'Open the full research map in Canvas',
    guide: 'Read from research steps on the left through findings in the middle to claims on the right. The conclusion is at the bottom.',
    controls: 'Drag to pan and hold Ctrl while scrolling to zoom.',
    branches: 'Each color marks a branch. Colored cards in the middle column are key findings.',
  },
  'zh-CN': {
    steps: '研究步骤', findings: '发现', question: '研究问题', conclusion: '结论',
    legend: '读图', evidence: '证据', limit: '限制', section: '阅读正文',
    title: '研究导图', open: '在 Canvas 中打开完整研究导图',
    guide: '左列为研究步骤，中列为发现，右列为发现支撑的论点，最下方汇入结论。',
    controls: '拖动画布可平移，按住 Ctrl 滚动可缩放。',
    branches: '颜色对应不同分支，中列着色卡片是重点发现。',
  },
};

const local = (value, language) => typeof value === 'string' ? value : value[language];
const fail = (code, value) => { throw Object.assign(new Error(`${code}: ${value}`), { code }); };
const encodeWikilinkTarget = value => value.replace(/[%[\]|]/g, encodeURIComponent);

function cardHeight(text, width) {
  const unitsPerLine = Math.floor((width - 40) / 15);
  const visible = text.replace(/\[\[[^\]|\r\n]+\|([^\]\r\n]*)\]\]/g, '$1')
    .replace(/\[([^\]\r\n]*)\]\([^)]+\)/g, '$1').replaceAll('**', '');
  let height = 32;
  for (const line of visible.split('\n')) {
    if (!line) {
      height += 12;
      continue;
    }
    const units = [...line].reduce((sum, character) => sum + (/[\x00-\x7f]/.test(character) ? 0.55 : 1), 0);
    height += Math.max(1, Math.ceil(units / unitsPerLine)) * 26;
  }
  return Math.ceil(height / 10) * 10;
}

/** Builds a JSON Canvas 1.0 object from registered map data and validated argument data. */
export function buildResearchMapCanvas({ paperId, map, argument, primaryFindingIds, language, notePath, sectionTitles }) {
  const words = labels[language];
  if (!words) fail('RF_CANVAS_LANGUAGE_INVALID', language);
  const punctuation = language === 'en' ? ': ' : '：';
  const id = (...identity) => createHash('sha256').update(JSON.stringify([paperId, language, ...identity])).digest('hex').slice(0, 16);
  const note = encodeWikilinkTarget(notePath.replace(/\.md$/i, ''));
  const nodes = [];
  const groups = [];
  const edges = [];
  const steps = new Map();
  const findings = new Map();
  const claims = new Map();
  const firstSteps = new Map();
  const primary = new Set(primaryFindingIds);
  const stepsById = new Map(map.steps.map(step => [step.id, step]));
  const findingsById = new Map(map.findings.map(finding => [finding.id, finding]));
  const relations = map.relations.map(relation => ({
    id: relation.id,
    stepId: relation.step_id ?? relation.from,
    findingId: relation.finding_id ?? relation.to,
  }));
  for (const { stepId, findingId } of relations) {
    if (!stepsById.has(stepId) || !findingsById.has(findingId)) fail('RF_CANVAS_MAP_RELATION_INVALID', `${stepId} → ${findingId}`);
    if (!firstSteps.has(findingId)) firstSteps.set(findingId, new Set());
    firstSteps.get(findingId).add(stepId);
  }

  function heading(sectionId) {
    const title = sectionTitles instanceof Map ? sectionTitles.get(sectionId) : Object.hasOwn(sectionTitles, sectionId) ? sectionTitles[sectionId] : undefined;
    if (typeof title !== 'string' || !title.trim()) fail('RF_CANVAS_SECTION_TITLE_MISSING', sectionId);
    return title;
  }

  function sectionLink(sectionId, text) {
    const alias = text.replace(/[\[\]\\\r\n]/g, ' ');
    return `[[${note}#${encodeWikilinkTarget(heading(sectionId))}|${alias}]]`;
  }

  function mapCardText(node) {
    const number = heading(node.section_id).match(/^\d+(?:\.\d+)*(?=\s)/)?.[0];
    return `${number ? `${number}  ` : ''}${sectionLink(node.section_id, local(node.label, language))}`;
  }

  function card(kind, key, column, y, text, color) {
    const node = { id: id('node', kind, key), type: 'text', ...column, y, height: cardHeight(text, column.width), text, ...(color ? { color } : {}) };
    nodes.push(node);
    return node;
  }

  function frame(kind, key, column, top, bottom, label, color, padding = 20) {
    groups.push({
      id: id('group', kind, key), type: 'group', x: column.x - padding, y: top, width: column.width + 2 * padding,
      height: bottom - top, label, ...(color ? { color } : {}),
    });
  }

  function connect(key, from, fromSide, to, toSide, extra = {}) {
    edges.push({ id: id('edge', ...key), fromNode: from.id, fromSide, toNode: to.id, toSide, toEnd: 'arrow', ...extra });
  }

  let y = 0;
  const claimOrder = [];
  for (const [index, branch] of argument.branches.entries()) {
    const color = BRANCH_COLORS[index];
    const branchCards = [];
    for (const claim of argument.claims.filter(item => item.branch_id === branch.id)) {
      const rowTop = y;
      for (const findingId of claim.finding_ids) {
        const finding = findingsById.get(findingId);
        if (!finding || findings.has(findingId)) fail('RF_CANVAS_FINDING_INVALID', findingId);
        const result = card('finding', finding.id, FINDING, y, mapCardText(finding), primary.has(findingId) ? color : undefined);
        findings.set(findingId, result);
        let stepY = y;
        for (const stepId of firstSteps.get(findingId) ?? []) {
          if (steps.has(stepId)) continue;
          const step = stepsById.get(stepId);
          const node = card('step', step.id, STEP, stepY, mapCardText(step));
          steps.set(stepId, node);
          stepY += node.height + ROW_GAP;
        }
        y = Math.max(y + result.height + ROW_GAP, stepY);
      }
      const limit = local(claim.limit, language);
      const text = [
        `**${local(claim.title, language)}**`,
        `${words.evidence}${punctuation}${local(claim.evidence, language)}`,
        ...(limit ? [`${words.limit}${punctuation}${limit}`] : []),
        sectionLink(claim.section_id, words.section),
      ].join('\n\n');
      const claimHeight = cardHeight(text, CLAIM.width);
      const claimTop = rowTop + Math.max(0, Math.floor((y - ROW_GAP - rowTop - claimHeight) / 2));
      const claimCard = card('claim', claim.id, CLAIM, claimTop, text, color);
      claims.set(claim.id, claimCard);
      claimOrder.push(claim);
      branchCards.push(claimCard);
      y = Math.max(y - ROW_GAP, claimTop + claimHeight) + CLAIM_GAP;
    }
    if (branchCards.length) {
      const top = branchCards[0].y - 44;
      const last = branchCards.at(-1);
      frame('branch', branch.id, CLAIM, top, last.y + last.height + 20, local(branch.name, language), color);
    }
  }
  if (findings.size !== map.findings.length) fail('RF_CANVAS_FINDINGS_UNASSIGNED', map.findings.filter(node => !findings.has(node.id)).map(node => node.id).join(', '));
  if (claims.size !== argument.claims.length) fail('RF_CANVAS_CLAIMS_UNASSIGNED', argument.claims.filter(claim => !claims.has(claim.id)).map(claim => claim.id).join(', '));

  // A registered step can have no finding; it still belongs in the left column.
  let bottom = y - CLAIM_GAP;
  for (const step of map.steps) {
    if (steps.has(step.id)) continue;
    const node = card('step', step.id, STEP, bottom + ROW_GAP, mapCardText(step));
    steps.set(step.id, node);
    bottom = node.y + node.height;
  }
  frame('column', 'steps', STEP, -60, bottom + 24, words.steps, undefined, 24);
  frame('column', 'findings', FINDING, -60, bottom + 24, words.findings, undefined, 24);

  const questionColumn = { x: STEP.x, width: FINDING.x + FINDING.width };
  const questionText = `**${words.question}**\n\n${local(argument.question.text, language)}\n\n${sectionLink(argument.question.section_id, words.section)}`;
  const question = card('frame', 'question', questionColumn, -cardHeight(questionText, questionColumn.width) - 90, questionText, '6');
  const legend = `**${words.legend}**\n\n${words.guide}\n\n${words.branches}`;
  card('frame', 'legend', CLAIM, -cardHeight(legend, CLAIM.width) - 90, legend);
  const conclusionText = `**${words.conclusion}**\n\n${local(argument.conclusion.text, language)}\n\n${sectionLink(argument.conclusion.section_id, words.section)}`;
  const conclusion = card('frame', 'conclusion', CLAIM, bottom + 90, conclusionText, '6');

  for (const [index, { id: relationId, stepId, findingId }] of relations.entries()) {
    connect(['study', stepId, findingId, relationId ?? index], steps.get(stepId), 'right', findings.get(findingId), 'left');
  }
  for (const claim of claimOrder) {
    const target = claims.get(claim.id);
    for (const findingId of claim.finding_ids) connect(['evidence', findingId, claim.id], findings.get(findingId), 'right', target, 'left', { color: target.color });
  }

  const position = new Map(claimOrder.map((claim, index) => [claim.id, index]));
  const arcRoutes = [];
  for (const relation of argument.relations) {
    const from = relation.from === 'question' ? question : claims.get(relation.from);
    const to = relation.to === 'conclusion' ? conclusion : claims.get(relation.to);
    const key = ['argument', relation.from, relation.to, relation.label];
    const label = language === 'en' ? READING_ARGUMENT_RELATION_LABELS[relation.label] : relation.label;
    const index = position.get(relation.from);
    const next = claimOrder[index + 1];
    const sameBranchNext = next?.id === relation.to && next.branch_id === claimOrder[index].branch_id;
    const lastToConclusion = relation.to === 'conclusion' && index === claimOrder.length - 1;
    if (!from || !to) fail('RF_CANVAS_ARGUMENT_RELATION_INVALID', `${relation.from} → ${relation.to}`);
    if (relation.from === 'question') connect(key, from, 'right', to, 'top', { label });
    else if (sameBranchNext || lastToConclusion) connect(key, from, 'bottom', to, 'top', { label });
    else {
      const start = from.y + Math.floor(from.height / 2), end = to.y + Math.floor(to.height / 2);
      arcRoutes.push({ from, to, key, label, start, end, low: Math.min(start, end), high: Math.max(start, end) });
    }
  }

  // Include the text card's side padding so a four-character label stays on one line.
  const relationSize = language === 'en' ? { width: 260, height: 36 } : { width: 104, height: 28 };
  const overlaps = (a, b) => a.low <= b.high + 2 && b.low <= a.high + 2;
  const tracks = [];
  for (const arc of arcRoutes) {
    const { from, to, key, label, start, end } = arc;
    if (!arcRoutes.some(other => other !== arc && overlaps(arc, other))) {
      connect(key, from, 'right', to, 'right', { label });
      continue;
    }
    let track = tracks.findIndex(intervals => intervals.every(interval => !overlaps(arc, interval)));
    if (track === -1) track = tracks.push([]) - 1;
    tracks[track].push(arc);
    const x = CLAIM.x + CLAIM.width + 150 + track * (relationSize.width + 40);
    const y = Math.floor((start + end - relationSize.height) / 2);
    const relationCard = { id: id('node', ...key), type: 'text', x, y, ...relationSize, text: label };
    nodes.push(relationCard);
    const downward = start < end;
    connect(key, from, 'right', relationCard, downward ? 'top' : 'bottom');
    connect([...key, 'exit'], relationCard, downward ? 'bottom' : 'top', to, 'right');
  }

  return { nodes: [...groups, ...nodes], edges };
}

export function serializeResearchMapCanvas(canvas) {
  return JSON.stringify(canvas, null, 2) + '\n';
}

export function researchMapCanvasSection({ canvasPath, language }) {
  const words = labels[language];
  if (!words) fail('RF_CANVAS_LANGUAGE_INVALID', language);
  const space = language === 'en' ? ' ' : '';
  return `${words.guide}${space}${words.controls}\n\n![[${canvasPath}|${words.title}|640]]\n\n[[${canvasPath}|${words.open}]]`;
}
