import { fingerprintV3Json as hash } from './semantic-package-validator.mjs';

const languages = ['en', 'zh-CN'];
const fail = (reason, details = {}) => { throw Object.assign(new Error('P221_RESEARCH_MAP_' + reason), { code: 'P221_RESEARCH_MAP_' + reason, details }); };
const nonblank = value => typeof value === 'string' && !!value.trim() && value.isWellFormed();
const anchor = (kind, id) => kind + '-' + hash({ id }).slice(7, 31);
function keys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('CONTRACT_INVALID');
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
// Mermaid entities preserve label characters without exposing grammar or HTML.
function mermaidLabel(text) {
  return Array.from(text).map(char => ({ '"': '#quot;', '<': '#lt;', '>': '#gt;', '&': '#amp;' }[char]
    ?? (/^[\p{L}\p{N} ]$/u.test(char) || char.codePointAt(0) > 0xffff ? char : '#' + char.codePointAt(0) + ';'))).join('');
}
const markdownLabel = text => Array.from(text).map(char => /^[\p{L}\p{N} ]$/u.test(char) || char.codePointAt(0) > 0xffff ? char : '&#' + char.codePointAt(0) + ';').join('');
const wikiLink = (target, label) => '[[' + target + '|' + markdownLabel(label) + ']]';

/** Pure rendering of a finite staged DAG projection from existing accepted view analysis. */
export function buildReaderResearchMap({ researchMap, views, paperTargets }) {
  keys(researchMap, ['schema_version', 'layout', 'steps', 'lanes', 'edges']);
  if (researchMap.schema_version !== 'phase221-research-map-1.0' || !['staged', 'swimlane'].includes(researchMap.layout)
    || !Array.isArray(researchMap.steps) || !researchMap.steps.length || !Array.isArray(researchMap.edges)) fail('CONTRACT_INVALID');
  const indices = {};
  for (const language of languages) {
    const target = paperTargets?.[language];
    if (!nonblank(target) || /[\\:\[\]|#<>\x00-\x1f]/.test(target) || target.split('/').some(part => !part || part === '.' || part === '..')) fail('TARGET_INVALID');
    indices[language] = new Map();
    if (!Array.isArray(views?.[language]?.sections)) fail('VIEW_INVALID');
    for (const section of views[language].sections) for (const paragraph of section.paragraphs ?? []) for (const span of paragraph.spans ?? []) {
      if (!nonblank(span.span_id) || indices[language].has(span.span_id)) fail('SPAN_DUPLICATE');
      indices[language].set(span.span_id, { section: section.section_id, span });
    }
  }
  const bound = (language, id, section) => {
    const row = indices[language].get(id);
    if (!row || row.section !== section || row.span.kind !== 'analysis' || row.span.explain_only === true || !nonblank(row.span.text)) fail('SPAN_INVALID', { language, id, section });
    return row.span;
  };
  const labels = value => {
    keys(value, languages);
    return Object.fromEntries(languages.map(language => {
      const range = value[language]; keys(range, ['span_id', 'start', 'end']);
      const span = bound(language, range.span_id, 'study-design');
      if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end <= range.start || range.end > span.text.length) fail('RANGE_INVALID');
      const text = span.text.slice(range.start, range.end);
      if (!nonblank(text)) fail('RANGE_INVALID');
      return [language, text];
    }));
  };
  const refs = (value, section) => {
    keys(value, languages);
    for (const language of languages) {
      const ids = value[language];
      if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) fail('REFERENCES_INVALID');
      for (const id of ids) bound(language, id, section);
    }
  };
  const stepIds = new Map(), stepLabels = new Map();
  for (const [index, step] of researchMap.steps.entries()) {
    keys(step, ['step_id', 'lane_id', 'labels', 'design_span_ids', 'finding_span_ids']);
    if (!nonblank(step.step_id) || stepIds.has(step.step_id)) fail('STEP_INVALID');
    stepIds.set(step.step_id, index); stepLabels.set(step.step_id, labels(step.labels));
    refs(step.design_span_ids, 'study-design'); refs(step.finding_span_ids, 'key-findings');
    for (const language of languages) if (!step.design_span_ids[language].includes(step.labels[language].span_id)) fail('LABEL_DESIGN_MISMATCH');
  }
  const laneIds = new Set(), laneLabels = new Map();
  if (researchMap.layout === 'swimlane') {
    if (!Array.isArray(researchMap.lanes) || !researchMap.lanes.length) fail('LANES_REQUIRED');
    for (const lane of researchMap.lanes) {
      keys(lane, ['lane_id', 'labels']);
      if (!nonblank(lane.lane_id) || laneIds.has(lane.lane_id) || stepIds.has(lane.lane_id)) fail('LANE_INVALID');
      laneIds.add(lane.lane_id); laneLabels.set(lane.lane_id, labels(lane.labels));
      if (!researchMap.steps.some(step => step.lane_id === lane.lane_id)) fail('LANE_EMPTY');
    }
    if (researchMap.steps.some(step => !laneIds.has(step.lane_id))) fail('LANE_INVALID');
  } else if (researchMap.lanes !== undefined || researchMap.steps.some(step => step.lane_id !== undefined)) fail('LAYOUT_INVALID');
  const outgoing = new Map(researchMap.steps.map(step => [step.step_id, []])), edgeIds = new Set();
  for (const edge of researchMap.edges) {
    keys(edge, ['from_step_id', 'to_step_id', 'relation']);
    const id = JSON.stringify([edge.from_step_id, edge.to_step_id]);
    if (!stepIds.has(edge.from_step_id) || !stepIds.has(edge.to_step_id) || edgeIds.has(id)
      || !['sequence', 'parallel_branch', 'merge'].includes(edge.relation)) fail('EDGE_INVALID');
    edgeIds.add(id); outgoing.get(edge.from_step_id).push(edge.to_step_id);
  }
  const active = new Set(), complete = new Set();
  const visit = id => {
    if (active.has(id)) fail('CYCLE');
    if (complete.has(id)) return;
    active.add(id); outgoing.get(id).forEach(visit); active.delete(id); complete.add(id);
  };
  stepIds.forEach((index, id) => visit(id));
  const fragments = {}, backs = {}, navigation = [];
  for (const language of languages) {
    const lines = ['```mermaid', 'flowchart TB'];
    const node = step => 'S' + stepIds.get(step.step_id) + '["' + mermaidLabel(stepLabels.get(step.step_id)[language]) + '"]:::design';
    if (researchMap.layout === 'swimlane') researchMap.lanes.forEach((lane, index) => {
      lines.push('subgraph L' + index + '["' + mermaidLabel(laneLabels.get(lane.lane_id)[language]) + '"]', 'direction TB');
      lines.push(...researchMap.steps.filter(step => step.lane_id === lane.lane_id).map(node), 'end');
    });
    else lines.push(...researchMap.steps.map(node));
    for (const edge of researchMap.edges) lines.push('S' + stepIds.get(edge.from_step_id) + (edge.relation === 'parallel_branch' ? ' -.-> ' : ' --> ') + 'S' + stepIds.get(edge.to_step_id));
    lines.push('classDef design fill:#e8eef5,stroke:#72849a,color:#243448', '```', '');
    backs[language] = {};
    for (const step of researchMap.steps) {
      const label = stepLabels.get(step.step_id)[language], target = paperTargets[language] + '#^' + anchor('rm', step.step_id);
      const links = [];
      for (const [key, kind, section] of [['design_span_ids', 'research-map-design', 'study-design'], ['finding_span_ids', 'research-map-finding', 'key-findings']]) {
        for (const [index, id] of step[key][language].entries()) {
          const span = bound(language, id, section), destination = paperTargets[language] + '#^' + anchor('p', id);
          const linkLabel = key === 'design_span_ids'
            ? (language === 'en' ? 'Design details' : '设计说明') + (step[key][language].length > 1 ? ' ' + (index + 1) : '')
            : (language === 'en' ? 'Related finding ' : '对应发现 ') + (index + 1);
          links.push(wikiLink(destination, linkLabel)); navigation.push({ language, kind, step_id: step.step_id, span_id: id, target: destination, label: span.text });
          if (key === 'finding_span_ids') {
            (backs[language][id] ??= []).push({ step_id: step.step_id, target, label });
            navigation.push({ language, kind: 'finding-research-map', step_id: step.step_id, span_id: id, target, label });
          }
        }
      }
      lines.push(markdownLabel(label) + ' ^' + anchor('rm', step.step_id), '', links.join(' · '), '');
    }
    fragments[language] = lines.join('\n');
  }
  return freeze({ map: structuredClone(researchMap), fragments, backs, navigation, bindings: {
    map_fingerprint: hash(researchMap), views: Object.fromEntries(languages.map(language => [language, hash(views[language])])),
    paper_targets: structuredClone(paperTargets),
  } });
}
