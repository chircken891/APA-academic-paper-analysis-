import { readFileSync } from 'node:fs';

const templatePath = new URL('../../Templates/apa-v3/研究导图模板.canvas', import.meta.url);
const padding = 24;
const cardGap = 30;

function style() {
  const { nodes, edges } = JSON.parse(readFileSync(templatePath, 'utf8'));
  const cards = new Map(nodes.map(node => [node.id, node]));
  const columns = ['method-a', 'finding-a', 'judgment-a'].map((key, index) => ({
    x: cards.get(key).x - cards.get('method-a').x + index * 40,
    width: cards.get(key).width,
  }));
  return {
    cards,
    columns,
    stageWidth: columns.at(-1).x + columns.at(-1).width,
    laneGap: cards.get('group-c').x - cards.get('group-b').x - cards.get('group-b').width,
    colors: ['group-a', 'group-b', 'group-c'].map(id => cards.get(id).color),
    arrow: edges.find(edge => edge.id === 'method-a-to-finding-a').toEnd,
  };
}

function stageLayers(stages, transitions) {
  const incoming = new Map(stages.map(stage => [stage.id, []]));
  const outgoing = new Map(stages.map(stage => [stage.id, []]));
  for (const link of transitions) {
    incoming.get(link.to).push(link);
    outgoing.get(link.from).push(link);
  }
  const ranks = new Map();
  const layers = [];
  while (ranks.size < stages.length) {
    const ready = stages.filter(stage => !ranks.has(stage.id) && incoming.get(stage.id).every(link => ranks.has(link.from)));
    if (!ready.length) throw Object.assign(new Error('Stage transitions contain a cycle'), { code: 'RF_CANVAS_STAGE_CYCLE' });
    for (const stage of ready) ranks.set(stage.id, layers.length);
    layers.push(ready);
  }
  return { layers, ranks, incoming, outgoing };
}

function connected(starts, next) {
  const seen = new Set(starts);
  const stack = [...starts];
  while (stack.length) {
    for (const id of next.get(stack.pop()) ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(id);
    }
  }
  return seen;
}

/** Preserve real evidence edges, and use the stage frame as the entrance for independent items. */
function boundaryCards(cards, relationships) {
  const forward = new Map(cards.map(card => [card.id, []]));
  const reverse = new Map(cards.map(card => [card.id, []]));
  for (const { from, to } of relationships) {
    if (!forward.has(from.id) || !reverse.has(to.id)) continue;
    forward.get(from.id).push(to.id);
    reverse.get(to.id).push(from.id);
  }
  function boundary(inward, outward) {
    const ids = cards.filter(card => !inward.get(card.id).length).map(card => card.id);
    let reached = connected(ids, outward);
    // A recorded iterative sequence can have no separate root or terminal.
    for (const card of cards) {
      if (reached.has(card.id)) continue;
      ids.push(card.id);
      reached = reached.union(connected([card.id], outward));
    }
    return new Set(ids);
  }
  return { roots: boundary(reverse, forward), leaves: boundary(forward, reverse) };
}

function stageRows(stage, claims, evidence) {
  const assignment = new Map();
  for (const claim of claims) {
    for (const id of claim.finding_ids) if (!assignment.has(id)) assignment.set(id, claim.id);
  }
  const steps = new Map();
  for (const { stepId, findingId } of evidence) {
    const claimId = assignment.get(findingId);
    if (claimId !== undefined && !steps.has(stepId)) steps.set(stepId, claimId);
  }
  const tracks = claims.map(claim => [stage.step_ids.filter(id => steps.get(id) === claim.id), claim.finding_ids, [claim.id]]);
  const independent = stage.step_ids.filter(id => !steps.has(id));
  if (independent.length) tracks.unshift([independent, [], []]);
  return tracks;
}

const sides = {
  left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1],
};

function port(card, side) {
  return [card.x + (side[0] + 1) * card.width / 2, card.y + (side[1] + 1) * card.height / 2];
}

// Canvas chooses the actual curve. Approximate it here to favor ports with open space.
function preferClearPorts(edge, cards, byId) {
  const from = byId.get(edge.fromNode), to = byId.get(edge.toNode);
  const obstacles = cards.filter(node => node !== from && node !== to);
  function count(fromSide, toSide) {
    const v = sides[fromSide], w = sides[toSide], a = port(from, v), d = port(to, w);
    const bend = Math.min(220, Math.max(20, Math.hypot(a[0] - d[0], a[1] - d[1]) * 0.35));
    const b = a.map((word, i) => word + v[i] * bend);
    const c = d.map((word, i) => word + w[i] * bend);
    const hits = new Set();
    for (let i = 1; i < 20; i++) {
      const t = i / 20, s = 1 - t;
      const [x, y] = a.map((word, j) => s ** 3 * word + 3 * s * s * t * b[j] + 3 * s * t * t * c[j] + t ** 3 * d[j]);
      for (const box of obstacles) if (box.x < x && x < box.x + box.width && box.y < y && y < box.y + box.height) hits.add(box);
    }
    return hits.size;
  }
  let best = count(edge.fromSide, edge.toSide);
  if (!best) return;
  const order = ['bottom', 'top', 'left', 'right'];
  for (const fromSide of [edge.fromSide, ...order]) for (const toSide of [edge.toSide, ...order]) {
    const collisions = count(fromSide, toSide);
    if (collisions >= best) continue;
    edge.fromSide = fromSide;
    edge.toSide = toSide;
    best = collisions;
    if (!best) return;
  }
}

export function buildStageResearchMap({ map, argument, language, stepLinks, primaryFindingIds, id, sectionLink, cardHeight, words }) {
  const { stages, transitions, step_text: stepText, finding_text: findingText } = argument.stage_map;
  const { cards: models, columns, stageWidth, laneGap, colors, arrow } = style();
  const { layers, ranks, incoming, outgoing } = stageLayers(stages, transitions);
  const local = value => typeof value === 'string' ? value : value[language];
  const nodes = [], edges = [], groups = [], relationships = [];
  const indexed = { step: new Map(), finding: new Map(), claim: new Map() };
  const allSteps = new Map(map.steps.map(step => [step.id, step]));
  const allFindings = new Map(map.findings.map(finding => [finding.id, finding]));
  const allClaims = new Map(argument.claims.map(claim => [claim.id, claim]));
  const primary = new Set(primaryFindingIds);
  const stageEntries = new Map(), stageColors = new Map(), handoffs = new Map();
  const claimStage = new Map(stages.flatMap(stage => stage.claim_ids.map(claim => [claim, stage.id])));
  const studies = map.relations.map(relation => ({
    stepId: relation.step_id ?? relation.from,
    findingId: relation.finding_id ?? relation.to,
    id: relation.id,
  }));

  const titleAndText = (title, body, link) => [`**${title}**`, body, link].filter(Boolean).join('\n\n');
  function card(kind, key, x, y, width, text, color) {
    const node = { id: id('node', kind, key), type: 'text', x, y, width, height: cardHeight(text, width), text, ...(color ? { color } : {}) };
    nodes.push(node);
    return node;
  }
  function connect(key, from, to, color, fromSide = 'bottom', toSide = 'top', extra) {
    const prefix = from === question ? 'stage-map-' : '';
    edges.push({ id: prefix + id('edge', ...key), fromNode: from.id, fromSide, toNode: to.id, toSide, toEnd: arrow, color, ...extra });
  }
  function connectToward(from, to, color, key) {
    if (from.x === to.x) connect(key, from, to, color, 'right', 'right');
    else connect(key, from, to, color, from.x < to.x ? 'right' : 'left', from.x < to.x ? 'left' : 'right');
  }
  function paperCard(node, body) {
    return titleAndText(local(node.label), local(body), sectionLink(node.section_id));
  }

  const width = Math.max(1, ...layers.map(layer => layer.length)) * (stageWidth + laneGap + padding * 2) - laneGap - padding * 2;
  const centered = (size, frame = width) => Math.round((frame - size) / 2);
  const questionWidth = models.get('question').width;
  const question = card('frame', 'question', centered(questionWidth), 0, questionWidth,
    titleAndText(words.question, local(argument.question.text), sectionLink(argument.question.section_id)), models.get('question').color);
  const stageCards = new Map();
  let y = question.height + 132;

  for (const [rank, layer] of layers.entries()) {
    const layerWidth = layer.length * (stageWidth + laneGap + padding * 2) - laneGap - padding * 2;
    let layerBottom = y;
    for (const [index, stage] of layer.entries()) {
      const x = centered(layerWidth) + index * (stageWidth + laneGap + padding * 2);
      const parentLinks = incoming.get(stage.id);
      const color = layer.length > 1 ? colors[1 + index % (colors.length - 1)]
        : parentLinks.length === 1 ? stageColors.get(parentLinks[0].from) : colors[0];
      stageColors.set(stage.id, color);
      const stageClaims = stage.claim_ids.map(key => allClaims.get(key));
      const entry = card('stage', stage.id, x, y, models.get('stage-a').width,
        local(stage.entry), color);
      stageEntries.set(stage.id, entry);
      const content = [];
      let rowTop = y + entry.height + 54;
      for (const row of stageRows(stage, stageClaims, studies)) {
        const stacks = row.map((keys, column) => {
          const role = ['step', 'finding', 'claim'][column];
          return keys.map(key => {
            const claim = allClaims.get(key);
            const text = column === 0 ? paperCard(allSteps.get(key), stepText[key])
              : column === 1 ? paperCard(allFindings.get(key), findingText[key])
                : titleAndText(local(claim.title), [local(claim.evidence), local(claim.limit)].filter(Boolean).join('\n\n'), sectionLink(claim.section_id));
            const n = card(role, key, x + columns[column].x, 0, columns[column].width, text, primary.has(key) ? color : undefined);
            indexed[role].set(key, n);
            content.push(n);
            return n;
          });
        });
        const heights = stacks.map(stack => stack.reduce((height, node) => height + node.height + cardGap, -cardGap));
        const tallest = Math.max(...heights);
        for (const [i, stack] of stacks.entries()) {
          let position = rowTop + Math.floor((tallest - heights[i]) / 2);
          for (const n of stack) {
            n.y = position;
            position += n.height + cardGap;
          }
        }
        rowTop += tallest + cardGap;
      }
      groups.push({ id: id('group', 'stage', stage.id), type: 'group', x: x - padding, y: y - padding, width: stageWidth + 2 * padding,
        height: rowTop - y + padding, label: local(stage.title), color });
      stageCards.set(stage.id, content);
      layerBottom = Math.max(layerBottom, rowTop + padding);
    }
    const transfers = transitions.filter(link => ranks.get(link.from) === rank)
      .sort((a, b) => ranks.get(a.to) - ranks.get(b.to) || stages.findIndex(stage => stage.id === a.to) - stages.findIndex(stage => stage.id === b.to));
    y = layerBottom + 74;
    const handoffWidth = models.get('handoff-ab').width;
    for (const [index, link] of transfers.entries()) {
      const rowWidth = transfers.length * (handoffWidth + laneGap) - laneGap;
      const x = centered(rowWidth, Math.max(rowWidth, width)) + index * (handoffWidth + laneGap);
      const transfer = card('handoff', [link.from, link.to], x, y, handoffWidth, local(link.label), stageColors.get(link.from));
      handoffs.set(link, transfer);
    }
    y = Math.max(y, ...transfers.map(link => handoffs.get(link).y + handoffs.get(link).height)) + 140;
  }

  const conclusionWidth = models.get('conclusion').width;
  const conclusion = card('frame', 'conclusion', centered(conclusionWidth), y, conclusionWidth,
    titleAndText(words.conclusion, local(argument.conclusion.text), sectionLink(argument.conclusion.section_id)), models.get('conclusion').color);
  if (!stages.length) connect(['commentary'], question, conclusion, colors[0]);

  for (const [index, { stepId, findingId, id: relationId }] of studies.entries()) {
    const from = indexed.step.get(stepId), to = indexed.finding.get(findingId);
    relationships.push({ from, to });
    connectToward(from, to, colors[0], ['study', stepId, findingId, relationId ?? index]);
  }
  for (const claim of argument.claims) {
    const to = indexed.claim.get(claim.id);
    for (const findingId of claim.finding_ids) {
      const from = indexed.finding.get(findingId);
      relationships.push({ from, to });
      connectToward(from, to, colors[0], ['evidence', findingId, claim.id]);
    }
  }
  for (const { from_step_id: source, to_step_id: target, label } of stepLinks ?? []) {
    const from = indexed.step.get(source), to = indexed.step.get(target);
    const key = ['flow', source, target, label.en, label['zh-CN']];
    relationships.push({ from, to });
    connect(key, from, to, '#0e7490', 'left', 'left', { id: 'method-flow-' + id('edge', ...key), label: local(label) });
  }

  const terminalClaims = [];
  for (const { from, to } of argument.relations) {
    if (from === 'question') continue;
    if (to === 'conclusion') {
      terminalClaims.push(from);
      continue;
    }
    if (outgoing.get(claimStage.get(from)).some(link => link.to === claimStage.get(to))) continue;
    const source = indexed.claim.get(from), target = indexed.claim.get(to);
    relationships.push({ from: source, to: target });
    connectToward(source, target, stageColors.get(claimStage.get(from)), ['claim-relation', from, to]);
  }

  const remaining = [];
  for (const stage of stages) {
    const entry = stageEntries.get(stage.id), color = stageColors.get(stage.id);
    const content = stageCards.get(stage.id);
    const { roots, leaves } = boundaryCards(content, relationships);
    const first = [...content].sort((a, b) => a.y - b.y)[0];
    for (const node of content) {
      if (!roots.has(node.id)) continue;
      const behindCards = node.x === entry.x && node !== first;
      connect(['stage-entry', stage.id, node.id], entry, node, color, behindCards ? 'left' : 'bottom', behindCards ? 'left' : 'top');
    }
    remaining.push(...content.filter(node => leaves.has(node.id)).map(node => ({ node, color })));
    if (!incoming.get(stage.id).length) connect(['stage-start', stage.id], question, entry, color);
  }

  for (const link of transitions) {
    const sourceCards = new Set(stageCards.get(link.from).map(node => node.id));
    const targetCards = new Set(stageCards.get(link.to).map(node => node.id));
    const citedClaims = argument.relations.filter(row => claimStage.get(row.from) === link.from && claimStage.get(row.to) === link.to)
      .map(row => indexed.claim.get(row.from));
    const citedEvidence = relationships.filter(({ from, to }) => sourceCards.has(from.id) && targetCards.has(to.id)).map(({ from }) => from);
    const target = handoffs.get(link);
    for (const from of new Set(citedClaims.length ? citedClaims : citedEvidence)) {
      connect(['stage-exit', from.id, link.to], from, target, stageColors.get(link.from));
    }
    connect(['handoff', link.from, link.to], target, stageEntries.get(link.to), stageColors.get(link.to));
  }

  for (const key of terminalClaims) connect(['claim-conclusion', key], indexed.claim.get(key), conclusion, stageColors.get(claimStage.get(key)));
  const prior = new Map();
  for (const edge of edges) {
    if (!prior.has(edge.toNode)) prior.set(edge.toNode, []);
    prior.get(edge.toNode).push(edge.fromNode);
  }
  let ending = connected([conclusion.id], prior);
  for (const { node, color } of remaining) {
    if (ending.has(node.id)) continue;
    connect(['stage-conclusion', node.id], node, conclusion, color);
    ending = ending.union(connected([node.id], prior));
  }
  const cardById = new Map(nodes.map(node => [node.id, node]));
  for (const edge of edges) preferClearPorts(edge, nodes, cardById);
  return { nodes: [...groups, ...nodes], edges };
}
