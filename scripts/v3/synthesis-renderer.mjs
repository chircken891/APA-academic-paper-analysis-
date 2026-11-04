import { posix } from 'node:path';

const origins = { author: '论文作者', analyst: '分析者推导', 'cross-paper': '跨篇推断' };
const strengths = { tentative: '推测', observation: '观察', support: '支持', strong: '较强' };
const value = input => input === null || input === undefined ? '' : typeof input === 'object' ? JSON.stringify(input) : String(input);
const field = (label, input) => input === undefined ? '' : `**${label}：**${value(input)}\n\n`;
const sentence = input => /[。！？.!?]$/.test(value(input).trim()) ? value(input).trim() : value(input).trim() + '。';
const sourceLabel = row => {
  const name = posix.basename(value(row.path).replaceAll('\\', '/')).replace(/\.(?:en|zh-CN)\.md$|\.md$/u, '');
  const authorYear = /^(.+?)-(\d{4})(?:-|$)/u.exec(name);
  return authorYear ? `${authorYear[1]}（${authorYear[2]}）` : name || row.paper_id;
};
const citation = (row, outputPath) => {
  const notePath = outputPath ? posix.relative(posix.dirname(outputPath.replaceAll('\\', '/')), value(row.path).replaceAll('\\', '/')) : value(row.path);
  const target = notePath + (row.anchor ? '#' + encodeURIComponent(row.anchor) : '');
  return `[${sourceLabel(row)}](${target.replaceAll(' ', '%20')})（来源归属：${origins[row.claim_origin] || row.claim_origin || '未标注'}）`;
};

/** Deterministic presentation only; the structured response remains the validation input. */
export function renderSynthesisOutput({ mode, output, outputPath } = {}) {
  const answer = typeof output === 'string' ? output : output?.answer;
  if (typeof answer !== 'string') throw Object.assign(new Error('WQ_RENDER_ANSWER_REQUIRED'), { code: 'WQ_RENDER_ANSWER_REQUIRED' });
  if (mode === 'draft') {
    let rendered = answer;
    for (const row of output.statements ?? []) {
      if (typeof row.text !== 'string' || !row.text) continue;
      const index = rendered.indexOf(row.text);
      if (index < 0) continue;
      const end = index + row.text.length;
      const refs = rendered.slice(end).match(/^(?:\s*\[@[^\]]+\])*/)?.[0] ?? '';
      const label = `［强度：${strengths[row.strength] || row.strength || '未标注'}；归属：${row.attribution || '未标注'}］`;
      rendered = rendered.slice(0, end + refs.length) + label + rendered.slice(end + refs.length);
    }
    return rendered;
  }
  if (mode !== 'ideas') return answer;
  const paperLabels = new Map([...(output.candidates ?? []), ...(output.ideas ?? [])].flatMap(row => (row.citations ?? []).filter(ref => ref.paper_id).map(ref => [ref.paper_id, sourceLabel(ref)])));
  const candidates = (output.candidates ?? []).map(row => `- ${row.idea_id}：${sentence(row.statement)}透镜：${[].concat(row.lens ?? []).join('、')}。${(row.citations ?? []).map(row => citation(row, outputPath)).join('；')}`);
  const ideas = (output.ideas ?? []).map(row => {
    let text = `### ${row.idea_id} ${row.name || ''}\n\n${row.statement || ''}\n\n`;
    text += field('透镜', [].concat(row.lens ?? []).join('、')) + field('假设', row.hypothesis) + field('贡献类型', row.contribution_type) + field('最小验证', row.minimum_validation);
    for (const [key, label] of [['risk', '风险'], ['effort', '投入']]) {
      const item = row[key];
      text += typeof item === 'object' && item !== null ? field(label, item.level) + field(label + '来源', item.source) : field(label, item);
    }
    text += field('评分', row.scores ? `有趣性 ${row.scores.interest}/10；可行性 ${row.scores.feasibility}/10；新颖性 ${row.scores.novelty}/10` : undefined) + field('审稿质疑', row.reviewer_objection) + field('回应', row.response) + field('外部新颖性', row.external_novelty);
    text += '**依据：**' + (row.citations ?? []).map(row => citation(row, outputPath)).join('；') + '\n\n';
    text += (row.most_similar_papers ?? []).map(paper => `**近邻：${paperLabels.get(paper.paper_id) || paper.paper_id}**\n\n重叠：${paper.overlap}\n\n差异：${paper.difference}\n\n条件：${sentence(value(paper.conditions) || '未标注')}`).join('\n\n');
    return text;
  });
  const decisions = (rows, deferred) => rows.map(row => `- ${row.idea_id}：${sentence(row.reason)}判断维度：${row.criterion || '未标注'}。${deferred ? '恢复条件：' + sentence(row.trigger || '未标注') : ''}`).join('\n');
  return '# 研究构思\n\n## 发散依据\n\n' + candidates.join('\n') + '\n\n' + ideas.join('\n\n')
    + '\n\n### 客观淘汰\n\n' + (decisions(output.discarded ?? [], false) || '无。')
    + '\n\n### 暂缓\n\n' + (decisions(output.deferred ?? [], true) || '无。');
}
