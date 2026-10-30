**APA 阅读会话入口**

`scripts/v3/reading-session.mjs` 提供新配置化阅读的会话入口。它生成任务登记，保存科学阶段状态与阅读阶段 owned 检查点，并返回下一步。调用方负责提供当前宿主的实际能力证据、调用返回的宿主工具、记录真实回传和准备渲染资源。正式发布仍需要单独的精确批准及既有受控事务。

**创建和预检**

先完成来源和解析产物准备，并取得本次阅读的明确授权、截止时间和调用额度。`scientificInput` 包含 `reading-first-1.0`、论文和运行身份、实际来源的绝对路径及 SHA-256/字节长度、文本 `context`，以及依 Evidence、Methods、Results、Interpretation、scientific-reading、Integration 顺序给出的六个 `role_artifacts`。`sourceLanguage` 依据原文确定。当前主会话身份写入 `sessionContext`，本库配置中的模型选择在创建时冻结。

```js
import {
  createReadingSession, nextReadingAction, recordReadingEvent, resumeReadingSession,
} from './scripts/v3/reading-session.mjs';

const session = await createReadingSession({
  repoRoot, runId, scientificInput, sourceLanguage,
  authorizationId, deadline, maxCalls, maxTotalCalls,
  sessionContext: { model, effort },
  hostProfile, evidence,
  includeRepairs: true,
});
```

`includeRepairs` 仅在本次授权包含相应修订时设置。可使用 `taskOverrides` 和 `scienceTaskOverrides` 指定任务字段；角色、科学产物身份、路径唯一性和权限仍会校验。配置的写作与展示模式决定实际运行合同。创建不会调用模型或执行 PDF 解析。

本次授权包含科学补缺时，向创建入口传入现有 `enrichmentPolicy`；其来源及权限原样冻结。会话另在 `reading_first_binding.enrichment_session_profile` 保存 `reading-session-enrichment-1.0`，用于选择本次接入行为。省略策略时沿原流程运行，已有绑定不升级。具体来源边界见[补缺指南](active-gap-enrichment.md)。

`hostProfile` 为当前宿主检测结果。`evidence` 必须由当前宿主提供，包括 `current_host`、`dispatch`、`fresh_context`、`file_read` 和 `input` 的实际证据及引用。预检单独检查能力证据，配置的 `ready` 不代表调用可用。会话实际写入并回读控制产物后提供 `control_write` 证据；创建或恢复后可通过以下事件补充当前证据：

```js
await recordReadingEvent(session, {
  kind: 'runtime-evidence', hostProfile, evidence,
});
```

**执行与记录**

`await nextReadingAction(session)` 返回 `dispatch`、`wait`、`await-user`、`reconcile`、`provide-input` 或 `complete`。`dispatch` 包含冻结的 `host_action`、`arguments`、`action_id`、`run_id`、`input_fingerprint` 和 `port`。调用方在收到 `dispatch` 后按返回的原始工具名与参数调用宿主；会话已在返回前保存派发意图。再次询问下一步不会重发未知结果的动作。

将宿主真实回传封装为下例 `observation`，其中 `tool_call` 和 `raw_result_text` 来自实际调用。先记录 `host_observation`，完成时将同一原始派发观察用于 `result`；宿主按已登记任务写入 native 文件。阅读阶段完成事件会接收该文件、保存 owned 结果并更新检查点。科学阶段结果事件消费其已记录观察。

```js
const action = await nextReadingAction(session);
// 调用 action.host_action，并完整保留实际工具回传。
const observation = {
  action_id: action.action_id,
  run_id: action.run_id,
  input_fingerprint: action.input_fingerprint,
  port: action.port,
  tool_call: { name: action.host_action, arguments: action.arguments },
  raw_result_text: actualRawResultText,
};
await recordReadingEvent(session, {
  kind: 'host_observation', action_id: action.action_id, observation,
});
// 宿主任务完成并写入其登记的 native 路径后：
await recordReadingEvent(session, {
  kind: 'result', action_id: action.action_id, observation,
});
```

真实宿主进度可以通过 `host_update` 记录。提供宿主事件 ID 时放在事件的 `host_event_id`；缺少事件 ID 时使用观察内容指纹去重。进度观察需要原 action、可核对的宿主任务句柄、实际查询工具及原始回传。相同事件重复提交保持幂等，同一 ID 的不同内容会被拒绝。

在压缩边界，`compaction` 事件的 `input` 接受现有压缩处理器的 `observation`、`sessionId`、`progress` 和 `userDecision`。返回 `await-user` 时结束当前回复；用户决定后重新记录 `compaction` 并继续，检查点和原额度保持不变。

渲染前的 `provide-input` 会要求 `render-assets`。资源必须绑定实际来源文件及其 SHA-256、字节长度；按既有预览合同提供资源和可选渲染参数：

```js
await recordReadingEvent(session, {
  kind: 'render-assets', resources, renderOptions: {},
});
```

候选通过 `materializeConfiguredReadingCandidate` 生成。修订候选使用第二个预登记版本，整体审查和局部复核仍由原运行合同限制。`complete` 的 `publication_source` 可交给既有发布准备接口；它不授权写入正式库。

若审查将实质问题交给 renderer，会话返回 `provide-input` 和 `renderer-repair`。完成实际修复后，以 `renderer-repair` 事件提供更新的 `renderOptions` 或资源；会话核验受影响输出是否发生符合合同的变化，再准备原有的一次局部复核。

**科学补缺**

入口预登记 Evidence、Methods、Results 三个初始补缺任务，仅派发实际有缺口的角色。`includeRepairs:true` 时再登记三个后期补缺任务；未使用的登记不消耗调用，也不加入发布依赖。每项任务使用自身的 native、owned、指令路径和 `source_root`。

初始补缺按既有科学输出中的重要缺口分组，全部接收后才进入原文 Writer、Translation、可选 Editor 和整体审查。设本批补缺角色数为 N，Editor 启用时 E=1，否则 E=0，派发前要求 `callsUsed + N + 3 + E <= maxTotalCalls`，并满足语言阶段 `maxCalls`。这里的后续预留为 Writer、Translation、可选 Editor 和一次审查，不预留 r2。不足时返回 `reconcile` 和 `READING_FIRST_CALL_BUDGET_EXHAUSTED`。

新补缺会话中，首次审查的 science 问题会在预算判断前把两种语言加入修订范围。流程为科学补缺、原文 Writer 修订、Translation、可选 Editor、一次局部复核；仅译稿中的 writer 类问题仍只修译稿。后期补缺角色数与完整修订链均计入原总预算，语言修订另受原 `maxCalls` 约束；不足时在补缺派发前保存 `completed_with_limits`。`includeRepairs:false` 与补缺策略可以同时使用，此时审查后的科学缺口直接按有限完成处理。

补缺沿用原 `host_observation`、`host_update` 和 `result` 事件。Editor 仍按首次审查基线与 `repair_scope` 修改，混合责任问题全部处理完后才进入局部复核。

**中断恢复**

```js
const restored = await resumeReadingSession({ runRoot });
await recordReadingEvent(restored, { kind: 'runtime-evidence', hostProfile, evidence });
const next = await nextReadingAction(restored);
```

`runRoot` 为原运行的绝对目录。恢复使用科学状态、原登记和 owned 阅读检查点，并依据冻结的配置重新核对当前宿主及实际依赖；后续个人配置的修改不会改写本次绑定。创建时核对并保存主会话身份；宿主可显式选择冻结模型时，后续主会话变化不改变该绑定。宿主实际继承主会话模型时，还需核对当前身份与冻结身份一致。已存请求与结果会重新校验；有未知派发结果时返回 `reconcile`，让调用方核对原宿主任务。已完成审查的候选恢复需要重新提供相同的 `render-assets`，会话重新生成并核验已有候选和已审指纹后准备发布引用。

阅读控制槽在创建时有限预登记，默认数量为 `16 + 8 * maxTotalCalls`；可通过 `maxControlCheckpoints` 明确增加。它控制本地记录容量，不增加模型调用额度。槽容量不足时返回 `reconcile` 和 `CONTROL_CHECKPOINT_CAPACITY`，并保留最后一个有效检查点。损坏、冲突或缺少回执的控制产物需要核对，不能静默退回旧状态。

补缺任务在 `source_root` 写入快照后、结果接收前中断，恢复返回 `reconcile`，调用方核对原任务并沿原事件接收。尚未登记的快照不会被视为已登记来源漂移，也不会自动取得来源身份。已接收结果及其来源沿原检查点和指纹恢复，不重新派发。

本入口的自动化测试使用合成宿主及合成论文产物。真实宿主派发、科学阅读、原生 Obsidian 展示和正式发布分别需要对应的实际证据与授权。
