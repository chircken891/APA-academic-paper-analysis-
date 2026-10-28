export const scienceRoles = ['evidence', 'methods', 'results', 'interpretation', 'scientific-reading', 'integration'];
export const writingRoles = ['english-writer', 'chinese-writer', 'reading-editor', 'independent-verifier'];
export const writingSkills = ['nature-writing', 'nature-polishing', 'nature-shared', 'humanizer', 'humanizer-zh', 'stss'];
const roleNames = { evidence: '证据梳理', methods: '研究设计与方法', results: '结果与图表', interpretation: '解释与局限', 'scientific-reading': '科学阅读综合', integration: '内容整合', 'english-writer': '英文写作', 'chinese-writer': '中文写作', 'reading-editor': '阅读编辑', 'independent-verifier': '独立核验' };
const roleHelp = { evidence: '找出主结论对应的证据和关键缺口。', methods: '解释研究怎样设计、方法怎样运行。', results: '解释结果、数值关系和图表。', interpretation: '判断结论强度、替代解释和适用边界。', 'scientific-reading': '把分散材料组织成完整研究讲解。', integration: '合并各角色内容，处理分歧，交给写作角色。', 'english-writer': '写英文阅读笔记。先写英文时，它根据科学底稿完整成文；先写中文时，它对照已接受的中文稿写出模块、小节一一对应的英文版，按英文习惯表达，不逐字翻译，事实仍以科学底稿为准。', 'chinese-writer': '写中文阅读笔记。先写中文时，它根据科学底稿完整成文；先写英文时，它对照已接受的英文稿写出模块、小节一一对应的中文版，按中文习惯表达，不逐字翻译，事实仍以科学底稿为准。', 'reading-editor': '整理双语笔记的重点、层级和导航；不是再分析一遍论文。仅在“笔记呈现方式”中选择阅读编辑时调用，但这里仍需保存模型选择。', 'independent-verifier': '审查最终候选的关键内容、双语意义和呈现；独立核验指独立任务，不要求换成不同型号的模型。' };
const skillHelp = { 'nature-writing': '帮助组织科学论证和解释方法步骤。', 'nature-polishing': '帮助改善已有学术表达，保留事实和术语。', 'nature-shared': 'Nature 两项技能共同依赖的指导；启用其中任一项时也要启用它。', humanizer: '减少英文中的模板句、空泛表达与机械结构。', 'humanizer-zh': '减少中文翻译腔、套话与机械表达。', stss: '减少冗余的自我说明和防御性措辞，保留必要科学限定。' };
export const groups = [
  { id: 'host', title: '0. 运行宿主与子代理派发', help: '阅读时，各角色由当前宿主（如 Codex、Claude Code）派发子代理执行。这里保存的派发方式来自助手对自身环境的检测：用哪个工具、模型和推理强度参数叫什么、怎样保证子代理从全新上下文开始。换宿主后请让助手重新检测，再决定是否更新。' },
  { id: 'query', title: '知识库查询', help: '选择库内回答使用的模型、默认语言、详略和讲解对象。当次问题中的明确要求优先；未配置时跟随问题语言，按问题决定详略和讲解程度。查询只用一个回答任务，不要求配置论文阅读依赖。专题候选复用“工作文件目录”中的候选目录，表达规则复用“可选写作指导”；保存已有回答不会因这些默认偏好自动重写正文。' },
  { id: 'science', title: '1. 科学内容模型', help: '新论文阅读由前六个科学角色梳理证据、方法、结果、解释、阅读主线，再整合为共同科学底稿；它们可以共用同一个模型。' },
  { id: 'overrides', title: '按科学角色单独设置（可选）', help: '只有想让某个科学角色使用不同模型或推理强度时才填写。未设置的角色沿用上方共同模型；已有单独设置若不再需要，请在“去除配置”中移除该项，恢复继承。', collapsed: true },
  { id: 'writers', title: '2. 谁来写作、整理和核验', help: '科学底稿完成后，两个写作角色按先后顺序工作：先写的那个根据科学底稿写出完整笔记，后写的那个对照已接受的先写稿，写出另一种语言的对应版本，不重新组织科学内容。先写哪种语言在“双语顺序与笔记呈现”页设置。随后阅读编辑可整理版式，独立核验最后审查候选。每项都需选择模型；可以全部跟随主会话，也可以分别指定。跟随主会话会在新论文运行开始时固定下来，中途改会话设置不会改变该次运行。' },
  { id: 'paths', title: '3. 工作文件和阅读笔记存到哪里', help: '三个目录分别存放执行记录、解析资料和最终阅读候选，不需要自己为每篇论文建目录，系统会追加独立运行编号。填写相对于当前知识库的路径，例如 Eval/apa-v3/runs；也可用位于本库内的绝对路径。改路径只影响新运行，不会搬动已有文件。' },
  { id: 'parser', title: '4. 使用哪套 PDF 解析环境', help: 'MinerU 把 PDF 转为后续阅读所需的文字、表格和图片。这一块选择已安装的环境，不选择语言模型。运行目录是必填项，通常为 .runtime/mineru；若还没有安装，先让助手检测并报告缺项与安装目标，再决定安装。仅填写路径不会安装软件。' },
  { id: 'reading', title: '5. 双语写作顺序与笔记呈现', help: '两种语言都会生成。先写哪种语言决定写作顺序：先写的那个写作角色从科学底稿完整成文，另一个写作角色对照已接受的先写稿写出对应版本；每篇论文的实际原文语言在运行前按文献另行确定，用于原文笔记与译文的目录归属，不受这里的顺序影响。呈现方式决定是否在写作后增加阅读编辑整理。两种方式都沿用一次整体审查和既有发布规则。' },
  { id: 'skills', title: '6. 是否使用额外写作指导', help: '这些是给写作角色参考的表达规则，不是新的模型，也不会另开润色任务。每项都要明确选择“启用”或“不使用”；启用时必须填写该技能的 SKILL.md 文件路径。没有安装且暂时不需要的项目可以选“不使用”。关闭文风指导不会关闭科学事实、证据和双语质量要求。' }
];
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const optionNames = { '': '请选择…', explicit: '指定模型和推理强度', 'follow-main': '跟随当前主会话', true: '启用这项指导', false: '不使用这项指导', en: '先写英文，再写中文', 'zh-CN': '先写中文，再写英文', writer: '直接使用两语写作结果', 'reading-editor': '由阅读编辑整理重点、层级与导航', none: '不启用推理 · none', minimal: '最低 · minimal', low: '低 · low', medium: '中 · medium', high: '高 · high', xhigh: '更高 · xhigh', max: '最大 · max', ultra: '最高 · ultra' };
export const fields = [
  { key: 'host', label: '子代理派发方式', type: 'host', group: 'host', help: '只能采用本次检测结果或保持原值，不手工拼写工具参数。检测结果属于助手的自我报告，真实派发是否成功仍以实际运行为准。' },
  { key: 'models.query', label: '知识库查询模型（可选）', type: 'model', group: 'query', help: '未保存或移除此项时，查询跟随当前会话的模型与推理强度。指定组合须由当前宿主确认支持；不支持时停止并说明，不会自动换模型。查询不需要阅读目录、MinerU 或写作指导。' },
  { key: 'query.answer_language', label: '默认回答语言（可选）', type: 'select', group: 'query', help: '问题中没有明确语言要求时使用。未配置时跟随问题语言；更新已有专题时保留该专题的语言。', options: ['question', 'zh-CN', 'en'], optionNames: { question: '跟随问题语言', 'zh-CN': '中文', en: '英文' }, defaultValue: 'question' },
  { key: 'query.detail', label: '默认回答详略（可选）', type: 'select', group: 'query', help: '未配置时按问题决定详略。简明回答仍保留会改变结论的证据、研究条件和局限。', options: ['adaptive', 'concise', 'detailed'], optionNames: { adaptive: '按问题决定', concise: '简明回答', detailed: '详细讲解' }, defaultValue: 'adaptive' },
  { key: 'query.audience', label: '默认讲解对象（可选）', type: 'select', group: 'query', help: '未配置时按问题决定解释程度。面向初学者时补足必要术语与方法背景；面向研究者时保留专业表达。', options: ['adaptive', 'beginner', 'researcher'], optionNames: { adaptive: '按问题决定', beginner: '文献阅读初学者', researcher: '相关领域研究者' }, defaultValue: 'adaptive' },
  { key: 'models.science', label: '六个科学角色的共同模型', type: 'model', group: 'science', help: '没有单独设置的科学角色都使用这一项。已有选择合适时不用修改。' },
  ...scienceRoles.map(role => ({ key: `models.overrides.${role}`, label: `${roleNames[role]}的单独设置`, type: 'model', group: 'overrides', help: roleHelp[role] })),
  ...writingRoles.map(role => ({ key: `models.roles.${role}`, label: `${roleNames[role]}模型`, type: 'model', group: 'writers', help: roleHelp[role] })),
  { key: 'paths.runs', label: '执行记录目录', type: 'text', group: 'paths', help: '保存角色交接、执行记录和恢复检查点。例：Eval/apa-v3/runs。' },
  { key: 'paths.parse', label: 'PDF 解析结果目录', type: 'text', group: 'paths', help: '保存从 PDF 提取的文字、表格和图像资料。例：Eval/apa-v3/parse。' },
  { key: 'paths.candidates', label: '阅读候选目录', type: 'text', group: 'paths', help: '生成的双语笔记、图表和知识链接放在这里，可打开阅读。候选尚未正式发布到 Wiki。例：Eval/apa-v3/reading。' },
  { key: 'parser.runtime_home', label: 'MinerU 安装目录', type: 'text', group: 'parser', help: '填写环境文件夹，不是论文 PDF 或解析结果目录。例：.runtime/mineru。' },
  { key: 'parser.python', label: 'Python 程序路径（可选）', type: 'text', group: 'parser', help: '未配置时使用 MinerU 安装目录下的 venv/Scripts/python.exe。仅在实际位置不同或需明确指定时填写。' },
  { key: 'parser.config_path', label: 'MinerU 配置文件（可选）', type: 'text', group: 'parser', help: '未配置时使用 MinerU 安装目录下的 config.yaml。应填现有文件路径，不是文件内容。' },
  { key: 'reading.source_language', label: '首先写作的语言', type: 'select', group: 'reading', help: '选择你希望先形成的阅读稿语言，两种选择都会交付中英文。原文语言按每篇论文另行确定；这里的选择不改变原文与译文的目录归属。', options: ['en', 'zh-CN'] },
  { key: 'reading.presentation_mode', label: '笔记呈现方式', type: 'select', group: 'reading', help: '直接使用写作结果：省去编辑这一步。阅读编辑：额外整理重点、编号层级和目录，需要计入本次运行预算。', options: ['writer', 'reading-editor'] },
  ...writingSkills.map(key => ({ key: `writing_skills.${key}`, label: key, type: 'skill', group: 'skills', help: skillHelp[key] }))
];

export function fieldLabel(key) {
  return fields.find(field => key === field.key || key.startsWith(field.key + '.'))?.label || key;
}

export function describeValue(value, key) {
  if (key === 'models.query' && (value === undefined || value?.mode === 'follow-main')) return '跟随当前会话（在本次查询开始时确定）';
  const field = fields.find(field => field.key === key);
  if (value === undefined && field?.defaultValue) return `未配置；默认${field.optionNames[field.defaultValue]}`;
  if (value === undefined) return '尚未配置';
  if (value?.mode === 'follow-main') return '跟随主会话（在新运行开始时固定）';
  if (value?.mode === 'explicit') return value.reasoning_effort === undefined ? `${value.model}；无推理强度参数` : `${value.model}；推理强度：${optionNames[value.reasoning_effort] || value.reasoning_effort}`;
  if (key === 'host' && value?.dispatch) return describeDispatch(value.name, value.dispatch);
  if (value && typeof value === 'object' && 'enabled' in value) return value.enabled ? `启用；${value.path || '尚未填写 SKILL.md 路径'}` : '不使用';
  return field?.optionNames?.[value] || (key?.startsWith('reading.') ? optionNames[value] || String(value) : String(value));
}

export function describeChanges(snapshot, payload) {
  if (payload.schema_version === 'apa-config-export-1.0') return ['备份本页打开时已保存的配置，不包含尚未应用的表单修改。'];
  if (payload.action === 'remove') {
    const keys = payload.all ? Object.keys(flattenConfig(snapshot.config)) : payload.remove;
    return keys.map(key => `${fieldLabel(key)}：${describeValue(getValue(snapshot.config, key), key)} → 移除答案`);
  }
  return Object.entries(payload.set).map(([key, value]) => `${fieldLabel(key)}：${describeValue(getValue(snapshot.config, key), key)} → ${describeValue(value, key)}`);
}

export function describeDispatch(name, dispatch) {
  const effort = dispatch.effort_argument ? `推理强度参数 ${dispatch.effort_argument}` : '无推理强度参数';
  const fresh = dispatch.fresh_context ? `新上下文 ${dispatch.fresh_context.argument}=${JSON.stringify(dispatch.fresh_context.value)}` : '默认即新上下文';
  const model = dispatch.model_argument ? `模型参数 ${dispatch.model_argument}` : '不能选择模型（子代理沿用主会话）';
  return `${name}：${dispatch.tool}（${model}，${effort}，任务参数 ${dispatch.instruction_argument}，${fresh}）`;
}

// Effort choices for a model: null when no host profile lists it (manual entry keeps the full vocabulary).
export function effortOptionsFor(hostProfile, model) {
  const detected = hostProfile?.models?.find(item => item.model === model);
  return detected ? [...detected.reasoning_efforts] : null;
}

export function getValue(config, key) {
  return key.split('.').reduce((value, part) => value?.[part], config);
}

export function flattenConfig(config, prefix = '') {
  const result = {};
  for (const [key, value] of Object.entries(config || {})) {
    if (key === 'schema_version') continue;
    const name = prefix ? `${prefix}.${key}` : key;
    if (name !== 'host' && value && typeof value === 'object' && !Array.isArray(value) && !('mode' in value) && !('model' in value) && !('enabled' in value)) Object.assign(result, flattenConfig(value, name));
    else result[name] = value;
  }
  return result;
}

export function configDifferences(before, after) {
  const left = flattenConfig(before);
  const right = flattenConfig(after);
  return Object.keys(right).filter(key => JSON.stringify(left[key]) !== JSON.stringify(right[key])).map(key => ({ key, before: left[key], after: right[key] }));
}

export function createOperation(snapshot, { action = 'patch', set = {}, remove = [], all = false } = {}) {
  const base = { schema_version: 'apa-config-operation-1.0', base_fingerprint: snapshot.fingerprint, action };
  if (action === 'remove') return all ? { ...base, all: true } : { ...base, remove: [...new Set(remove)] };
  return { ...base, set, ...(remove.length ? { remove: [...new Set(remove)] } : {}) };
}

export function serializePayload(payload) {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export async function copySetupPayload(payload, clipboard = globalThis.navigator?.clipboard) {
  if (!clipboard?.writeText) return false;
  try { await clipboard.writeText(serializePayload(payload)); return true; } catch { return false; }
}

export const setupPages = [
  { id: 'overview', title: '开始前：用途与当前状态' },
  { id: 'host', title: '运行宿主与派发', flow: 'edit' },
  { id: 'query', title: '知识库查询', flow: 'edit' },
  { id: 'science', title: '科学内容模型', flow: 'edit' },
  { id: 'writers', title: '写作、编辑与核验模型', flow: 'edit' },
  { id: 'paths', title: '工作文件目录', flow: 'edit' },
  { id: 'parser', title: 'PDF 解析环境', flow: 'edit' },
  { id: 'reading', title: '双语顺序与笔记呈现', flow: 'edit' },
  { id: 'skills', title: '可选写作指导', flow: 'edit' },
  { id: 'import-section', title: '导入已有备份（可选）', flow: 'edit' },
  { id: 'edit-result', title: '完善配置结果', flow: 'edit' },
  { id: 'remove', title: '选择去除范围', flow: 'remove' },
  { id: 'remove-result', title: '去除配置结果', flow: 'remove' },
  { id: 'export-section', title: '导出已保存配置', flow: 'export' },
  { id: 'export-result', title: '配置备份结果', flow: 'export' }
];
const flowNames = { edit: '完善配置', remove: '去除配置', export: '导出配置' };

export function createSetupResults() {
  const results = {
    edit: { payload: null, filename: 'apa-config-operation.json' },
    remove: { payload: null, filename: 'apa-config-remove.json' },
    export: { payload: null, filename: 'apa-config-backup.json' }
  };
  return { get: flow => results[flow], set: (flow, payload) => { results[flow].payload = payload; }, clear: flow => { results[flow].payload = null; } };
}

// Navigation only changes visibility. Existing form nodes and generated payloads stay intact.
export function createSetupNavigator({ pages, buttons, status, previous, next, onChange = () => {} }) {
  let current = 0;
  let flow;
  const show = id => {
    const index = pages.findIndex(page => page.id === id);
    if (index < 0) throw new Error('未知的配置页面');
    if (pages[index].flow !== flow) throw new Error('请从首页进入该功能；当前功能不能跳转到其他功能。');
    current = index;
    const active = pages.filter(page => page.flow === flow);
    const position = active.findIndex(page => page.id === id);
    pages.forEach((page, position) => { page.element.hidden = position !== current; });
    buttons.forEach((button, position) => {
      button.hidden = !flow || pages[position].flow !== flow;
      if (position === current) button.setAttribute('aria-current', 'step');
      else button.removeAttribute('aria-current');
    });
    status.textContent = flow ? `${flowNames[flow]} · 第 ${position + 1} / ${active.length} 页 · ${pages[current].title}` : '选择配置功能';
    previous.disabled = position === 0;
    next.disabled = position === active.length - 1;
    onChange(pages[current]);
  };
  buttons.forEach((button, position) => button.addEventListener('click', () => show(pages[position].id)));
  const move = delta => {
    const active = pages.filter(page => page.flow === flow);
    const index = active.findIndex(page => page.id === pages[current].id);
    show(active[Math.max(0, Math.min(active.length - 1, index + delta))].id);
  };
  previous.addEventListener('click', () => move(-1));
  next.addEventListener('click', () => move(1));
  show(pages[0].id);
  return { show, enter: value => { if (!flowNames[value]) throw new Error('未知的配置功能'); flow = value; show(pages.find(page => page.flow === flow).id); }, home: () => { flow = undefined; show('overview'); }, current: () => pages[current].id };
}

export function fieldValue(field, values, hostProfile = null) {
  if (field.type === 'model') return values.mode === 'follow-main' ? { mode: 'follow-main' } : { mode: 'explicit', model: values.model.trim(), ...(values.effort ? { reasoning_effort: values.effort } : {}) };
  if (field.type === 'host') return { name: hostProfile.host, dispatch: hostProfile.dispatch };
  if (field.type === 'skill') return values.enabled === 'true' ? { enabled: true, ...(values.path.trim() ? { path: values.path.trim() } : {}) } : { enabled: false };
  return values.value.trim();
}

const hostIssueNames = { 'model-not-detected': '模型未在本宿主检测到', 'effort-missing': '缺少该模型需要的推理强度', 'effort-not-supported': '该模型在本宿主不支持此推理强度', 'dispatch-unavailable': '本宿主没有检测到可派发子代理的工具', 'model-selection-unavailable': '本宿主不能为子代理选择模型，需改为跟随主会话' };

export function readinessMessages(inspection, queryInspection, hostProfile = null) {
  const validation = inspection?.validation;
  const check = inspection?.host_check;
  const hostState = { match: '已保存的派发方式与本次检测一致。', differs: '已保存的派发方式与本次检测不同；如已换宿主，请在“运行宿主与派发”页采用新结果。', 'not-saved': '尚未保存派发方式，可在“运行宿主与派发”页采用本次检测结果。' };
  const host = !hostProfile ? '本页没有宿主检测结果：模型需要手动填写，派发方式无法设置。请让助手先检测自身环境再生成页面。'
    : `本页依据助手对 ${hostProfile.host} 的检测（${hostProfile.detected_at}）。${check ? hostState[check.host] : ''}${check?.issues?.length ? ` 需要处理：${check.issues.map(item => `${fieldLabel(item.key)}——${hostIssueNames[item.issue] || item.issue}${item.model ? `（${item.model}${item.reasoning_effort ? ` / ${item.reasoning_effort}` : ''}）` : ''}`).join('；')}。` : ''}`;
  return {
    host,
    reading: validation?.conflicts?.length ? `已保存的派发方式不能为子代理选择模型，以下项目需改为“跟随主会话”后才能开始新论文：${[...new Set(validation.conflicts.map(item => fieldLabel(item.split(' ')[0])))].join('、')}。`
      : inspection?.ready ? '阅读配置已齐全，所选依赖文件可找到。' : validation?.complete ?'阅读配置已填全，但部分依赖文件还不可用。请查看检查结果，修正路径或先安排安装检测。' : `阅读还需填写：${[...new Set((validation?.missing || ['模型、目录、解析器、阅读与写作技能选择']).map(fieldLabel))].join('、')}。可分次保存，全部必填项和所选依赖就绪后才能开始新论文。`,
    query: `${queryInspection?.ready ? '查询配置已就绪；未选查询模型时跟随当前会话。' : '查询配置尚未检查或存在结构错误。'} 此处未检查当前宿主的模型可用性，也未执行模型；实际查询时确认支持的模型与推理强度。`
  };
}

export function mountApaSetup(document, snapshot, inspection, queryInspection, hostProfile = null) {
  const byId = id => document.getElementById(id);
  const make = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const controls = [];
  const display = describeValue;
  const addInput = (parent, label, name, value = '', options, labels = optionNames) => {
    const wrapper = make('label', label);
    const input = make(options ? 'select' : 'input');
    input.name = name;
    if (options) for (const option of options) { const node = make('option', labels[option] || optionNames[option] || option); node.value = option; input.append(node); }
    else input.type = 'text';
    input.value = value;
    wrapper.append(input);
    parent.append(wrapper);
    return input;
  };
  byId('current').textContent = serializePayload(snapshot.config);
  byId('location').textContent = `${snapshot.exists ? '已读取' : '尚未保存'}：${snapshot.path || 'config/apa.local.json'}`;
  const readiness = readinessMessages(inspection, queryInspection, hostProfile);
  byId('host-readiness').textContent = readiness.host;
  byId('readiness').textContent = readiness.reading;
  byId('query-readiness').textContent = readiness.query;
  const dependencies = inspection?.dependencies || [];
  const dependencyStatus = { available: '文件或目录可找到', missing: '未找到，请检查路径或安装情况', 'wrong-type': '路径类型不符，请检查填的是文件还是目录', unavailable: '暂时无法读取' };
  byId('dependencies').textContent = dependencies.length ? dependencies.map(item => `${fieldLabel(item.key)}：${dependencyStatus[item.status] || item.status}\n${item.path || ''}`).join('\n\n') : '尚无可检查的依赖路径。填写解析器和已启用技能的位置后，由助手回读检查。';
  const containers = {};
  const groupElements = {};
  for (const group of groups) {
    const container = make(group.collapsed ? 'details' : 'div', undefined, 'field-group');
    container.append(make(group.collapsed ? 'summary' : 'h3', group.title));
    container.append(make('p', group.help, 'group-help'));
    const grid = make('div', undefined, 'fields'); container.append(grid);
    byId('fields').append(container); containers[group.id] = grid; groupElements[group.id] = container;
  }
  for (const field of fields) {
    const row = make('fieldset');
    const legend = make('legend');
    const toggleLabel = make('label', `${field.label} · 修改此项`);
    const selected = make('input'); selected.type = 'checkbox'; selected.setAttribute('aria-label', `修改 ${field.label}`);
    toggleLabel.prepend(selected); legend.append(toggleLabel); row.append(legend);
    const current = getValue(snapshot.config, field.key);
    row.append(make('p', field.help, 'field-help'));
    row.append(make('p', `当前：${current === undefined && field.group === 'overrides' ? '沿用六个科学角色的共同模型，无需单独填写' : display(current, field.key)}`, 'hint'));
    const inputs = {};
    let refreshEfforts = () => {};
    if (field.type === 'host') {
      if (hostProfile?.dispatch) {
        row.append(make('p', `本次检测：${describeDispatch(hostProfile.host, hostProfile.dispatch)}`, 'hint'));
        inputs.value = addInput(row, '派发方式', field.key, '', ['', 'detected'], { '': '请选择…', detected: '采用本次检测结果' });
      } else {
        row.append(make('p', hostProfile ? '本次检测没有找到可派发子代理的工具，无法设置此项。' : '没有宿主检测结果，无法设置此项。请让助手先检测自身环境，再重新生成页面。', 'hint'));
        selected.disabled = true;
      }
    } else if (field.type === 'model') {
      const inherits = hostProfile?.dispatch?.model_argument === null;
      if (inherits) row.append(make('p', `${hostProfile.host} 的派发工具不能为子代理选择模型，子代理沿用主会话的模型和推理强度，因此这里只能选“跟随主会话”。`, 'hint'));
      inputs.mode = addInput(row, '选择方式', `${field.key}-mode`, current?.mode || (current?.model ? 'explicit' : ''), inherits ? ['', 'follow-main'] : ['', 'explicit', 'follow-main']);
      if (hostProfile?.models?.length) {
        const detected = hostProfile.models.map(item => item.model);
        const extra = current?.model && !detected.includes(current.model) ? [current.model] : [];
        inputs.model = addInput(row, '模型（来自本宿主检测结果）', `${field.key}-model`, current?.model || '', ['', ...detected, ...extra], { '': '请选择…', ...Object.fromEntries(extra.map(model => [model, `${model}（当前值，本宿主未检测到）`])) });
      } else {
        inputs.model = addInput(row, '模型标识（填写当前宿主实际支持的名称）', `${field.key}-model`, current?.model || '');
        inputs.model.placeholder = '没有检测结果时手动填写；不限定 GPT';
      }
      inputs.effort = addInput(row, '推理强度', `${field.key}-effort`, current?.reasoning_effort || '', ['', ...EFFORTS]);
      refreshEfforts = () => {
        const options = effortOptionsFor(hostProfile, inputs.model.value.trim());
        const keep = inputs.effort.value;
        const list = options ?? EFFORTS;
        inputs.effort.replaceChildren(...['', ...list].map(option => { const node = make('option', optionNames[option] || option); node.value = option; return node; }));
        inputs.effort.value = list.includes(keep) ? keep : '';
        inputs.effort.parentElement.hidden = options !== null && options.length === 0;
      };
      inputs.model.addEventListener('change', refreshEfforts);
      inputs.model.addEventListener('input', refreshEfforts);
      refreshEfforts();
      if (inherits) { inputs.model.parentElement.hidden = true; inputs.effort.parentElement.hidden = true; }
    } else if (field.type === 'skill') {
      inputs.enabled = addInput(row, '是否使用', `${field.key}-enabled`, current?.enabled === undefined ? '' : String(current.enabled), ['', 'true', 'false']);
      inputs.path = addInput(row, 'SKILL.md 文件路径（启用时必填）', `${field.key}-path`, current?.path || '');
      inputs.path.placeholder = '填写实际 SKILL.md 文件，不是它所在的文件夹';
    } else inputs.value = addInput(row, field.label, field.key, current ?? '', field.options ? ['', ...field.options] : undefined, field.optionNames);
    const sync = () => {
      for (const [key, input] of Object.entries(inputs)) input.disabled = !selected.checked || (field.type === 'model' && key !== 'mode' && inputs.mode.value !== 'explicit') || (field.type === 'skill' && key === 'path' && inputs.enabled.value !== 'true');
    };
    selected.addEventListener('change', sync);
    for (const input of Object.values(inputs)) input.addEventListener('change', sync);
    sync(); containers[field.group].append(row); controls.push({ field, selected, inputs, refreshEfforts });
  }
  const main = document.querySelector('main');
  const edit = byId('edit');
  const navigation = document.querySelector('nav');
  const pageHost = make('div', undefined, 'wizard-pages');
  const overview = make('div'); overview.id = 'overview';
  overview.append(document.querySelector('header'), byId('function-menu'), byId('current-title').closest('section'), document.querySelector('aside'));
  pageHost.append(overview);
  for (const group of groups.filter(group => !group.collapsed)) {
    const page = make('section'); page.id = group.id; page.hidden = true;
    if (group.id === 'query') page.append(byId('start-title').closest('section'));
    if (group.id === 'science') page.append(edit.querySelector('.explanation'));
    page.append(groupElements[group.id]);
    page.append(make('p', '勾选“修改此项”后填写；未勾选项目保留原值。预览会合并各页已选修改，不会直接应用设置。', 'hint'));
    if (group.id === 'science') page.append(groupElements.overrides);
    if (group.id === 'paths') page.append(byId('suggestions').closest('details'));
    const previewButton = make('button', '预览全部已选修改'); previewButton.type = 'button'; previewButton.dataset.preview = 'patch'; page.append(previewButton);
    pageHost.append(page);
  }
  for (const id of ['import-section', 'remove', 'export-section', 'edit-result', 'remove-result', 'export-result']) { byId(id).hidden = true; pageHost.append(byId(id)); }
  edit.remove();
  navigation.replaceChildren();
  const buttons = setupPages.map(page => { const button = make('button', page.title, 'secondary'); button.type = 'button'; navigation.append(button); return button; });
  navigation.setAttribute('aria-label', '配置分页，可直接跳转');
  const pager = make('div', undefined, 'wizard-pager');
  const previous = make('button', '上一步', 'secondary'); previous.type = 'button';
  const status = make('h1'); status.id = 'page-status'; status.tabIndex = -1; status.setAttribute('aria-live', 'polite');
  const next = make('button', '下一步', 'secondary'); next.type = 'button';
  pager.append(previous, status, next);
  const homeButton = make('button', '返回首页，选择其他功能', 'secondary'); homeButton.type = 'button'; homeButton.id = 'return-home';
  main.prepend(homeButton, pager, navigation); main.append(pageHost);
  let autoPreview = () => {};
  const pageNavigator = createSetupNavigator({ pages: setupPages.map(page => ({ ...page, element: byId(page.id) })), buttons, status, previous, next,
    onChange: page => { pager.hidden = !page.flow; navigation.hidden = !page.flow; homeButton.hidden = !page.flow; if (page.flow) { pager.scrollIntoView({ block: 'start' }); status.focus({ preventScroll: true }); } autoPreview(page); } });
  homeButton.addEventListener('click', () => pageNavigator.home());
  for (const flow of Object.keys(flowNames)) byId(`enter-${flow}`).addEventListener('click', () => pageNavigator.enter(flow));
  const collect = () => {
    const set = {};
    for (const { field, selected, inputs } of controls) {
      if (!selected.checked) continue;
      const values = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value]));
      if ((field.type === 'model' && !values.mode) || (field.type === 'skill' && !values.enabled) || (field.type !== 'model' && field.type !== 'skill' && !values.value.trim())) throw new Error(`请填写已选择的 ${field.label}；需要清除时使用去除配置。`);
      const value = fieldValue(field, values, hostProfile);
      const efforts = field.type === 'model' ? effortOptionsFor(hostProfile, value.model) : null;
      if (field.type === 'model' && values.mode === 'explicit' && (!value.model || !value.reasoning_effort && (efforts === null || efforts.length))) throw new Error(`请填写 ${field.label} 的模型与推理强度。`);
      if (field.type === 'skill') {
        if (JSON.stringify(getValue(snapshot.config, field.key)) !== JSON.stringify(value)) set[field.key] = value;
      } else if (JSON.stringify(getValue(snapshot.config, field.key)) !== JSON.stringify(value)) set[field.key] = value;
    }
    return createOperation(snapshot, { set });
  };
  const results = createSetupResults();
  const resultElement = (flow, id) => byId(`${flow}-${id}`);
  const clearResult = flow => {
    results.clear(flow);
    resultElement(flow, 'payload').value = '';
    resultElement(flow, 'change-summary').replaceChildren();
    resultElement(flow, 'next-step').textContent = '';
    resultElement(flow, 'download').disabled = true; resultElement(flow, 'copy').disabled = true;
    resultElement(flow, 'message').textContent = '尚未生成当前选择的结果，请重新生成预览。';
  };
  const preview = (flow, value) => {
    results.set(flow, value);
    resultElement(flow, 'payload').value = serializePayload(value);
    const backup = value.schema_version === 'apa-config-export-1.0';
    const changes = describeChanges(snapshot, value);
    resultElement(flow, 'change-summary').replaceChildren(...changes.map(change => make('li', change)));
    resultElement(flow, 'message').textContent = backup ? '已生成配置备份，尚未下载。' : changes.length ? `已生成${value.action === 'remove' ? '去除' : '修改'}操作，共 ${changes.length} 项。配置尚未生效。` : '没有选中任何变化，当前配置将保持不变。';
    resultElement(flow, 'next-step').textContent = backup ? '下一步：取一个便于辨认的文件名并下载保存。备份用于以后导入，不需要让助手直接执行；也可以复制内容自行保存。' : '下一步：检查上述变化。下载文件后把完整路径交给助手，并说“请应用这份配置”；或复制下面的完整内容粘贴给助手，提出同一请求。助手应用并回读后，设置才生效。';
    resultElement(flow, 'download').disabled = false; resultElement(flow, 'copy').disabled = false;
    pageNavigator.show(`${flow}-result`);
    byId(`${flow}-result`).focus({ preventScroll: true });
  };
  const guard = (flow, fn) => async () => { try { await fn(); } catch (error) { clearResult(flow); resultElement(flow, 'message').textContent = error.message; pageNavigator.show(`${flow}-result`); } };
  for (const button of document.querySelectorAll('[data-preview="patch"]')) button.addEventListener('click', guard('edit', () => { clearResult('edit'); preview('edit', collect()); }));
  for (const { selected, inputs } of controls) for (const input of [selected, ...Object.values(inputs)]) {
    input.addEventListener('input', () => clearResult('edit'));
    input.addEventListener('change', () => clearResult('edit'));
  }
  const leaves = flattenConfig(snapshot.config);
  for (const [key, value] of Object.entries(leaves)) {
    const label = make('label', `${fieldLabel(key)}：${display(value, key)}`); const input = make('input'); input.type = 'checkbox'; input.value = key; input.name = 'remove-field'; label.prepend(input); byId('remove-fields').append(label);
  }
  const syncRemove = () => { byId('remove-fields').disabled = byId('remove-all').checked; };
  byId('remove-all').addEventListener('change', () => { syncRemove(); clearResult('remove'); }); syncRemove();
  byId('remove-fields').addEventListener('change', () => clearResult('remove'));
  byId('generate-remove').addEventListener('click', guard('remove', () => {
    clearResult('remove');
    const all = byId('remove-all').checked;
    const remove = [...document.querySelectorAll('[name="remove-field"]:checked')].map(input => input.value);
    byId('removal-preview').textContent = serializePayload(all ? leaves : Object.fromEntries(remove.map(key => [key, leaves[key]])));
    preview('remove', createOperation(snapshot, { action: 'remove', all, remove }));
  }));
  byId('export').addEventListener('click', guard('export', () => preview('export', { schema_version: 'apa-config-export-1.0', answers: snapshot.config })));
  // Jumping straight to a result page generates it from the current selections, once per visit, so failures do not retrigger.
  const generators = { edit: () => document.querySelector('[data-preview="patch"]').click(), remove: () => byId('generate-remove').click(), export: () => byId('export').click() };
  const attempted = new Set();
  autoPreview = page => {
    if (!page.id.endsWith('-result')) { attempted.clear(); return; }
    if (attempted.has(page.flow) || results.get(page.flow).payload) return;
    attempted.add(page.flow); generators[page.flow]();
  };
  for (const flow of Object.keys(flowNames)) {
    resultElement(flow, 'filename').addEventListener('input', () => { results.get(flow).filename = resultElement(flow, 'filename').value; });
    resultElement(flow, 'download').addEventListener('click', guard(flow, () => {
      const payload = results.get(flow).payload;
      if (!payload) throw new Error('请先生成并审阅操作或导出。');
      const name = results.get(flow).filename.trim(); if (!name || /[\\/:*?"<>|]/.test(name)) throw new Error('请填写不含路径符号的文件名。');
      const url = URL.createObjectURL(new Blob([serializePayload(payload)], { type: 'application/json' }));
      const link = make('a'); link.href = url; link.download = name.endsWith('.json') ? name : `${name}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }));
    resultElement(flow, 'copy').addEventListener('click', guard(flow, async () => {
      const payload = results.get(flow).payload;
      if (!payload) throw new Error('请先生成操作或导出。');
      if (await copySetupPayload(payload)) { resultElement(flow, 'message').textContent = '已复制完整 JSON。'; return; }
      resultElement(flow, 'payload-details').open = true; resultElement(flow, 'payload').focus(); resultElement(flow, 'payload').select(); resultElement(flow, 'message').textContent = '浏览器未允许剪贴板访问；完整 JSON 已选中，请按 Ctrl+C（macOS 为 Command+C）。';
    }));
  }
  byId('import-file').addEventListener('change', guard('edit', async () => {
    clearResult('edit'); byId('differences').replaceChildren();
    const file = byId('import-file').files[0]; if (!file) return;
    const imported = JSON.parse(await file.text());
    if (imported.schema_version !== 'apa-config-export-1.0' || imported.answers?.schema_version !== 'apa-local-config-1.0') throw new Error('请选择 APA 配置导出文件；操作文件不能作为导出导入。');
    const unknown = Object.keys(flattenConfig(imported.answers)).filter(key => !fields.some(field => key === field.key || (field.type === 'skill' && [field.key + '.enabled', field.key + '.path'].includes(key))));
    if (unknown.length) throw new Error(`导出含未知字段：${unknown.join('、')}`);
    byId('differences').replaceChildren();
    const differences = configDifferences(snapshot.config, imported.answers);
    if (!differences.length) byId('differences').append(make('p', '备份中的项目与当前设置一致，无需导入变化。'));
    for (const difference of differences) {
      const label = make('label', `${fieldLabel(difference.key)}：${display(difference.before, difference.key)} → ${display(difference.after, difference.key)}`);
      const checkbox = make('input'); checkbox.type = 'checkbox'; checkbox.name = 'import-change'; checkbox.dataset.key = difference.key; checkbox.dataset.value = JSON.stringify(difference.after); label.prepend(checkbox); byId('differences').append(label);
    }
    for (const { field, selected, inputs, refreshEfforts } of controls) {
      const value = getValue(imported.answers, field.key); if (value === undefined) continue;
      selected.checked = false;
      if (field.type === 'host') continue;
      if (field.type === 'model') { inputs.mode.value = value.mode || 'explicit'; inputs.model.value = value.model || ''; refreshEfforts(); inputs.effort.value = value.reasoning_effort || ''; }
      else if (field.type === 'skill') { inputs.enabled.value = String(value.enabled); inputs.path.value = value.path || ''; }
      else inputs.value.value = value;
      selected.dispatchEvent(new Event('change'));
    }
    resultElement('edit', 'message').textContent = '已填入导出值。请审阅前后差异，勾选要采用的变化，再生成导入补丁；未选变化保留原值。';
  }));
  byId('differences').addEventListener('change', () => clearResult('edit'));
  byId('generate-import').addEventListener('click', guard('edit', () => {
    clearResult('edit');
    const set = Object.fromEntries([...document.querySelectorAll('[name="import-change"]:checked')].map(input => [input.dataset.key, JSON.parse(input.dataset.value)]));
    preview('edit', createOperation(snapshot, { set }));
  }));
  byId('suggestions').addEventListener('click', () => {
    const suggestions = { 'paths.runs': '.tmp/apa-runs', 'paths.parse': '.tmp/apa-parse', 'paths.candidates': '.tmp/apa-candidates', 'reading.presentation_mode': 'reading-editor' };
    for (const { field, selected, inputs } of controls) if (field.key in suggestions) { selected.checked = true; inputs.value.value = suggestions[field.key]; selected.dispatchEvent(new Event('change')); }
    clearResult('edit'); resultElement('edit', 'message').textContent = '已选入通用目录与阅读编辑建议，可继续修改；尚未写入仓库。';
  });
  main.hidden = false;
}
