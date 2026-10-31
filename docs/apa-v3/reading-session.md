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

新 `configured-reading-2.2` 保留六科学角色、单原文语言 Writer、Translation、可选 Editor、一次整体审查和最多一次局部复核；模型、用户选定的写作指导及压缩边界沿原冻结合同。旧绑定保持原版本。 未提供 `maxCalls` 时按 `min(8, maxTotalCalls - 6)`（启用 Editor）或 `min(6, maxTotalCalls - 6)`（普通模式）推导并冻结；低于编辑模式 4 或普通模式 3 时拒绝。

`maxCalls` 限制任务数量，补缺任务不计入阅读任务数量；`maxTotalCalls` 计入全部首次派发与原句柄续接的实际执行，并预留后续步骤所需额度。`host_update`、查询和等待不计入执行次数。`prior_calls=6` 保留科学任务基线，科学续接次数另账传递；旧绑定的实际剩余额度无法确定时记录 `unknown`。

主 Controller 按动作消费字段白名单短摘要，最多 8192 UTF-8 字节和 8 个引用；更多信息沿完整状态文件按需查阅。常态不整读正文、角色包或规则源码，具体错误按定位读取。新翻译通过文件引用按需读取，进度清单锁定完成片段，续接只处理剩余 ID；清单不能代替完整性验收，既有镜像校验仍须执行。

所有桌面应用的电脑控制均须用户明确授权，包括启动、点击、截图及 Obsidian CLI `screenshot`、`eval` 等原生观察；文件工具可检查原 PDF 图。原生展示 `not_run` 不阻断交付或发布准备。实际启动、截图和点击与验收状态分开记录，信息不足标记 `unknown`。工作规则不构成宿主硬性拒绝，宿主权限配置另需授权。

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

2.1 的原任务续接先登记唯一 `execution_id`。`hostProfile.capabilities.task_continuation` 必须提供当前宿主、原上下文可用性、续接工具及参数的实际依据；能力未知或原句柄缺失时返回具体缺失项。以下事件保存意图和额度，随后由 `nextReadingAction` 返回一次续接动作：

```js
await recordReadingEvent(session, {
  kind: 'continuation-intent', action_id: originalActionId,
  execution_id: executionId, message: boundedContinuationInstruction,
});
const continuation = await nextReadingAction(session);
// 仅在返回 dispatch 时调用其 host_action 和 arguments。
await recordReadingEvent(session, {
  kind: 'continuation-receipt', execution_id: continuation.execution_id,
  observation: {
    execution_id: continuation.execution_id, action_id: continuation.action_id,
    agent_id: continuation.host_handle, status: 'observed',
    tool_call: { name: continuation.host_action, arguments: continuation.arguments },
    raw_result_text: actualRawResultText,
  },
});
```

结果无法确认时记录 `status:'outcome_unknown'`，额度继续占用，后续动作要求核对原执行。重复意图或回执保持幂等，冲突内容拒绝。任务最终完成仍使用原 `action_id` 与原派发观察提交 `result`。Translation 的续接会核对该任务进度清单，将剩余章节和知识节点 ID 加入请求，并保留已完成片段的指纹；最终稿继续通过完整结构与双语镜像校验。

`computer-control-observation` 单独记录操作事实，`observation` 包含唯一 `event_id`、`coverage`（`complete`、`partial` 或 `unknown`）、`source_reference` 和 `operations`。每项操作记录 `operation`、`application`、`occurred_at`、原始 `tool_call` 与 `raw_result_text`。确认没有操作时可以依据完整记录提交空数组；缺少记录时保持未知。结束动作的 `computer_control` 返回这些事实，与 `native_presentation.status` 分开，不授予操作权限。

新配置化运行冻结 `boundary-reminders-1.2` 和本宿主有依据的手动压缩入口；既有 1.0 和 1.1 绑定沿用原合同。1.2 在四个安全边界保存状态后均返回 `await-user`，向用户推荐压缩，等待用户明确选择后继续。入口未知或不可用、用量低或未知、此前已压缩或提示均不自动跳过；入口未知时说明未知。四个压缩边界缺少临时观测时，`nextReadingAction` 返回 `provide-input`、`kind:'compaction-observation'` 和 `boundary_id`。调用方从当前宿主及可信运行记录收集一次观测，以 `recordReadingEvent(session, {kind:'compaction', input:{observation, sessionId, progress}})` 回传，并立即调用 `nextReadingAction`；观测和用量测量须在 60 秒内，无法取得的字段保持未知。缺少临时入口观测时使用绑定中本宿主已有证据的入口，不能跨宿主套用。

返回 `await-user` 时展示消息与可复制的阶段压缩提示词并结束当前回复；用户决定后重新记录 `compaction` 并继续，检查点和原额度保持不变。提示词包含可用的运行和论文身份、原预算与期限、来源及产物引用、检查点和绑定路径等续接元数据，并要求压缩时保留已完成阶段、下一步、关键科学结论及证据、限制、待决事项和真实任务句柄；完整角色模型策略按需从绑定路径回读。未知字段标明未知，原文及角色全文不写入提示词。Evidence 后突出设计和证据，Methods/Results 后突出关键方法、结果、数值与限制，Writer 前突出综合主线、分歧及写作、翻译、呈现下一步，整体审查前突出候选路径、呈现版本、审查范围及最多一次局部复核。生成提示词不增加模型调用。边界若记录 `skipped`，从已保存的 science-state `data.compaction_reminders` 或 owned 阅读检查点 `state.compaction_reminders` 读取原因并向用户简短说明。自动压缩事件只有关联当前主会话且有实际成功证据时才能记录；无成功事件时保留未核实状态。

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

初始补缺按既有科学输出中的重要缺口分组，全部接收后才进入原文 Writer、Translation、可选 Editor 和整体审查。设本批尚未准备的补缺角色数为 N，Editor 启用时 E=1，否则 E=0，2.1 派发前以执行账本占用加上尚未准备的补缺及后续步骤核对 `maxTotalCalls`，并满足语言阶段 `maxCalls`；已登记预留不重复计入。这里的后续步骤为 Writer、Translation、可选 Editor 和一次审查，不预留 r2。旧绑定沿用 `callsUsed + N + 3 + E <= maxTotalCalls`。不足时返回 `reconcile` 和 `READING_FIRST_CALL_BUDGET_EXHAUSTED`。

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

**明确批准的 Editor 拒收后恢复**

默认拒收仍以 `completed_with_limits` 结束。若用户另行批准恢复，且拒收原因为 `READING_FIRST_REPAIR_SCOPE_EXCEEDED`，可提交 `recover-rejected-editor` 事件，重新验证已有 `presentation-r2` 的原始 native／owned 字节、宿主观察、首次审查范围和完整 Editor 合同。该接口只支持 `reading-editor-1.3`、一次整体审查后且尚未派发局部复核的状态。

```js
await recordReadingEvent(session, {
  kind: 'recover-rejected-editor',
  authorization: {
    authorization_id, reason,
    checkpoint_fingerprint, rejection_fingerprint,
    max_additional_calls: 1,
  },
});
```

两个指纹必须对应当前已保存的终态检查点及其 `state.rejection`。2.1 直接核对持久化执行账本，禁止传入 `host_calls_used`，并须在原总预算内为局部复核留有额度；旧绑定继续要求授权对象中的 `host_calls_used` 报告原句柄续接等实际执行轮次。事件需要本次用户明确批准，配置或剩余额度不能代替授权。恢复不会调用模型；它在新 owned 检查点的 `state.repairRecoveries` 追加批准、原检查点、原拒收及新的验证结果。原终态、请求事件、拒收回执和调用计数保留。同一批准重复提交保持幂等，发生冲突或字节变化时拒绝。

范围校验允许插入审查 `visual_ids` 明确批准的新图旁条目；新增条目的 notes 仅可引用该审查的 `section_ids`，既有条目和相对顺序继续按原规则校验。其余列表和范围外内容保持。恢复成功后重新物化第二版候选，再使用既有的一次局部复核；原模型、来源、截止时间、额度和发布权限保持原合同。

补缺任务在 `source_root` 写入快照后、结果接收前中断，恢复返回 `reconcile`，调用方核对原任务并沿原事件接收。尚未登记的快照不会被视为已登记来源漂移，也不会自动取得来源身份。已接收结果及其来源沿原检查点和指纹恢复，不重新派发。

本入口的自动化测试使用合成宿主及合成论文产物。真实宿主派发、科学阅读、原生 Obsidian 展示和正式发布分别需要对应的实际证据与授权。

## 已派发Editor的明确续接授权

`configured-reading-2.1` 的 `presentation-r2` 已派发、尚未接收且局部复核尚未派发时，用户可对具体恢复另行批准有限执行额度。通过 `authorize-repair-continuation` 事件提交 `authorization_id`、`reason`、当前owned检查点的 `checkpoint_fingerprint`、原 `action_id`、`max_additional_calls` 和与原绑定完全一致的 `deadline`。接口核验原检查点与待续接请求，将新批准、原额度和原账本前缀单独保存到 `state.repairContinuation`，保留原binding及历史请求。配置、角色自行要求和剩余额度均不构成此授权。

获准的原页图型更正可附 `chart_type_corrections:[{visual_id,chart_types}]`，图必须在首次审查已定位的science原页问题范围内，知识身份须已登记，图片和其他图表字段保持。更正随渲染、恢复及发布来源捕获消费。待续接角色通过原句柄接收原审查范围的补充说明，原指令文件不覆写。后续执行仍使用 `continuation-intent` 和真实 `continuation-receipt`；局部复核次数保持原上限。

预算摘要分别报告 `original_total_limit`、`additional_limit`、`additional_used`，总执行账本连续保留。原额度优先消费，超出原上限的部分计入新增授权；不能重置已用次数、延长原截止时间或增加阅读任务数量。派发与Editor范围验收共同采用原审查的实质问题范围，原页补缺没有图注更正时仍须传递相关science范围。


## 命令行会话与回执

`npm run apa:session -- create --input <JSON文件> --export-dir <目录>` 创建会话；`next`、`resume` 和 `event` 使用 `--run-root <运行目录>` 恢复，`event` 用 `--input <JSON文件>` 读取事件。`--input -` 可从标准输入读取。返回派发动作时需要 `--export-dir`，完整动作按身份写入该目录；已有同名内容冲突会报错。

记录真实宿主返回时，`event --raw-result <文件> --export-dir <目录>` 保存原始字节并形成宿主回执；`--raw-result -` 从标准输入读取原始返回，此时事件须从文件提供。对于转录证据可使用 `--source <文件>`，记录其路径与指纹，不能同时使用 `--raw-result`。缺失或未观测的容量信息保持未知。`npm run apa:controller:audit -- <日志路径> <线程ID>` 按线程检查 Controller 工具调用，并返回覆盖程度与可识别事件；审计输出不能代替宿主回执。


## Results 资源交接

2.2 为 Results 预登记 `resources/results` 输出目录及 `science/results-resources.json` 受控资源清单。Results 使用已选择的 Python 调用 `scripts/lib/reading-resource-tool.py`，通过标准输入指定来源、输出目录和项目；PDF 使用物理页及可选点坐标裁剪，DOCX 指定原始 media、图号和段落位置。按来源分别生成后，Results 合并返回的 `reading-resources-1.0` 项并写入指定 native 清单。每项保留源文件与生成文件的路径、指纹、长度和定位；图像判读与裁剪结果检查由 Results 负责。Results 的科学输出包含 `resource_manifest`，其中 `path` 使用派发提供的 `owned_manifest_path`，并附 `resources_root`、清单原始字节的 `sha256` 和 `byte_length`。Integrator 将该对象原样写入 `visual_handoff.resource_manifest`，`presentation.visuals` 的 `id`、`path`、`source_id`、`locator` 须与清单一致。Controller 接收清单并验证身份、来源和产物，再交接后续步骤。


## 运行时漂移与修复批准

2.2 绑定冻结运行时文件、Schema 和提示的指纹。`inspectReadingRuntime({manifest})` 对照当前文件并列出变化路径及前后 SHA-256；运行时变化须先审阅具体差异和相关测试结果。`validateRuntimeRepairApproval` 校验批准对象：`authorization_id`、`run_id`、`checkpoint_fingerprint`、`previous_runtime_fingerprint`、`current_runtime_fingerprint`、`changed_files` 和 `test_evidence`，其中 `changed_files` 按路径排序，逐项包含 `path`、`old_sha256`、`new_sha256`，增删一侧为 `null`；`test_evidence` 为非空数组，逐项包含 `path`、`sha256` 和 `byte_length`。批准对象只接受列出的字段，测试证据路径可相对于冻结仓库根目录或使用绝对路径。校验会回读文件及证据，确认批准范围仍对应当前运行与检查点。批准不会改写原绑定或扩大原任务预算。 `nextReadingAction` 发现变化时返回 `kind:runtime-drift`、差异清单和当前 `checkpoint_fingerprint`。用户审阅精确变更及测试证据并明确批准后，使用 `recordReadingEvent(session, {kind:'runtime-repair-approval', approval})` 记录；成功返回 `recorded` 与新运行时指纹。会话将批准链写入独立受控检查点，恢复时读取批准链；未通过校验返回 `READING_SESSION_APPROVAL_INVALID`。

批准涉及 JavaScript 执行文件时，返回 `READING_SESSION_RUNTIME_RESTART_REQUIRED`，须在新进程恢复后继续，确保使用获批代码。2.2 的 `sections`、`science_sections` 和 `frozen_support` 保存原始指令内容；`frozen_support` 包括科学索引说明和角色回执规则。批准磁盘提示文件变化后，同一运行继续使用这些已冻结内容，原请求和原绑定保持。

Results 清单接收前会保存原宿主观察、科学输出和清单的精确字节。若清单已写入、回执尚未写入时中断，恢复将依据持久记录重新核验来源、图片和清单字节，再补齐受控回执；文件变化会阻断接收。
