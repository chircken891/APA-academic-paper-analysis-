**APA 阅读会话入口**

`scripts/v3/reading-session.mjs` 提供新配置化阅读的会话入口。它生成任务登记，保存科学阶段状态与阅读阶段 owned 检查点，并返回下一步。调用方负责提供当前宿主的实际能力证据、调用返回的宿主工具、记录真实回传和准备渲染资源。正式发布仍需要单独的精确批准及既有受控事务。

**创建和预检**

先完成来源和解析产物准备，并取得本次阅读的明确授权和调用额度。运行不设时间限制，只受调用次数限制（`maxCalls`、`maxTotalCalls` 与续接额度）；`createReadingSession` 不再要求 `deadline`，传入会被忽略，旧绑定中的 `deadline` 保留为历史记录且不再执行。等待用户或压缩不消耗调用，也不使额度失效；额度耗尽或运行完成、被明确关闭后才关闭，之后续接仍须另行批准新的调用额度（`adopted_science` / `adopted_views`）并保留原记录。`scientificInput` 包含 `reading-first-1.0`、论文和运行身份、实际来源的绝对路径及 SHA-256/字节长度、文本 `context`，以及依 Evidence、Methods、Results、Interpretation、scientific-reading、Integration 顺序给出的六个 `role_artifacts`。`sourceLanguage` 依据原文确定。当前主会话身份写入 `sessionContext`，本库配置中的模型选择在创建时冻结。

```js
import {
  createReadingSession, nextReadingAction, recordReadingEvent, resumeReadingSession,
} from './scripts/v3/reading-session.mjs';

const session = await createReadingSession({
  repoRoot, runId, scientificInput, sourceLanguage,
  authorizationId, maxCalls, maxTotalCalls,
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

新 `configured-reading-2.2` 保留六科学角色、单原文语言 Writer、Translation、可选 Editor、一次整体审查和最多一次局部复核；模型、用户选定的写作指导及压缩边界沿原冻结合同。未提供 `maxCalls` 时按 `min(8, maxTotalCalls - 6)`（启用 Editor）或 `min(6, maxTotalCalls - 6)`（普通模式）推导并冻结；低于编辑模式 4 或普通模式 3 时拒绝。

`maxCalls` 限制任务数量，补缺任务不计入阅读任务数量；`maxTotalCalls` 计入全部首次派发与原句柄续接的实际执行，并预留后续步骤所需额度。`host_update`、查询和等待不计入执行次数。`prior_calls=6` 保留科学任务基线，科学续接次数另账传递。

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

新配置化运行冻结 `boundary-reminders-2.0`。Evidence 完成、Methods/Results 完成、Writer 前和整体审查前四个边界各强制提醒一次：`nextReadingAction` 返回 `await-user`、`kind:'compaction-reminder'`、`boundary_id`、`message` 与 `compaction_prompt`。展示消息与可复制的阶段压缩提示词并结束当前回复；用户下一次回复后再次调用 `nextReadingAction` 即继续，检查点和原额度保持不变。同一会话进程内每个边界只提醒一次，恢复后的新进程若仍停在该边界会再提醒一次。自动压缩由宿主阈值设置负责。

提示词包含可用的运行和论文身份、原预算、来源及产物引用、检查点和绑定路径等续接元数据，并要求压缩时保留已完成阶段、下一步、关键科学结论及证据、限制、待决事项和真实任务句柄；完整角色模型策略按需从绑定路径回读。未知字段标明未知，原文及角色全文不写入提示词。Evidence 后突出设计和证据，Methods/Results 后突出关键方法、结果、数值与限制，Writer 前突出综合主线、分歧及写作、翻译、呈现下一步，整体审查前突出候选路径、呈现版本、审查范围及最多一次局部复核。生成提示词不增加模型调用。

渲染前的 `provide-input` 会要求 `render-assets`。会话从 Results 的受控清单读取来源文件、SHA-256 和字节长度，调用方提供可选渲染参数：

```js
await recordReadingEvent(session, {
  kind: 'render-assets', renderOptions: {},
});
```

候选通过 `materializeConfiguredReadingCandidate` 生成。修订候选使用第二个预登记版本，整体审查和局部复核仍由原运行合同限制。`complete` 的 `publication_source` 可交给既有发布准备接口；它不授权写入正式库。

若审查将实质问题交给 renderer，会话返回 `provide-input` 和 `renderer-repair`。完成实际修复后，以该事件提供更新的 `renderOptions`。图片裁切修复通过 `resourceRepair` 登记，图片写入原运行的 `resources/renderer-repair/`，清单项沿用 `reading-resources-1.0` 的资源字段：

```js
await recordReadingEvent(session, {
  kind: 'renderer-repair',
  resourceRepair: { resources_root: repairedResourcesRoot, resources: repairedRows },
});
```

修复限于首次整体审查已定位的 renderer 图号，并绑定同一来源、同一物理页或 DOCX 图号与段落位置。派生图片使用新的相对资源路径及指纹。原 Results 清单、图片、科学回执和首版候选继续作为基线，派生清单及原审查回执保存到 owned 检查点。恢复时重新核验这些绑定和实际图片字节，冲突重试被拒绝。两语候选与发布准备使用已核验的派生资源。会话核验受影响输出的变化后，准备原有的一次局部复核。

**科学补缺**

入口预登记 Evidence、Methods、Results 三个初始补缺任务，仅派发实际有缺口的角色。`includeRepairs:true` 时再登记三个后期补缺任务；未使用的登记不消耗调用，也不加入发布依赖。每项任务使用自身的 native、owned、指令路径和 `source_root`。

初始补缺按既有科学输出中的重要缺口分组，全部接收后才进入原文 Writer、Translation、可选 Editor 和整体审查。设本批尚未准备的补缺角色数为 N，Editor 启用时 E=1，否则 E=0，2.1 派发前以执行账本占用加上尚未准备的补缺及后续步骤核对 `maxTotalCalls`，并满足语言阶段 `maxCalls`；已登记预留不重复计入。这里的后续步骤为 Writer、Translation、可选 Editor 和一次审查，不预留 r2。不足时返回 `reconcile` 和 `READING_FIRST_CALL_BUDGET_EXHAUSTED`。

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

Codex 科学角色的首次派发若仅填错指令文件 SHA-256，可以在核实原任务收到更正、实际核验正确哈希并完成后，经明确授权恢复其已有结果。控制器对照冻结请求核查哈希所在行和其余参数，按真实派发回执提取句柄，并验证原任务的哈希核验、完成状态和原生产物。宿主证据由操作方从实际记录采集。

在原 `result` 事件中加入 `instruction_hash_recovery`，字段为 `authorization_id`、`native_sha256`、`verification` 和 `completion`。产物哈希带 `sha256:` 前缀。`verification` 提供原句柄和含已核验哈希的原始证据，`completion` 提供原动作 ID、原句柄及 `collaboration.list_agents` 的原始终态回执。两份证据均采用 `raw_result_text` 和可回读的 `raw` 证据。控制器保留首次派发的拒收记录，验证通过后接收原生产物并沿原账本推进。恢复过程不增加模型调用。

**明确批准的 Editor 拒收后恢复**

默认拒收仍以 `completed_with_limits` 结束。若用户另行批准恢复，且拒收原因为 `READING_FIRST_REPAIR_SCOPE_EXCEEDED`，可提交 `recover-rejected-editor` 事件，重新验证已有 `presentation-r2` 的原始 native／owned 字节、宿主观察、首次审查范围和完整 Editor 合同。该接口支持当前绑定的 Editor 版本，适用于一次整体审查后、尚未派发局部复核的状态。

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

两个指纹必须对应当前已保存的终态检查点及其 `state.rejection`。2.2 直接核对持久化执行账本，禁止传入 `host_calls_used`，并须在原总预算内为局部复核留有额度。事件需要本次用户明确批准，配置或剩余额度不能代替授权。恢复不会调用模型；它在新 owned 检查点的 `state.repairRecoveries` 追加批准、原检查点、原拒收及新的验证结果。原终态、请求事件、拒收回执和调用计数保留。同一批准重复提交保持幂等，发生冲突或字节变化时拒绝。

范围校验允许插入审查 `visual_ids` 明确批准的新图旁条目；新增条目的 notes 仅可引用该审查的 `section_ids`，既有条目和相对顺序继续按原规则校验。其余列表和范围外内容保持。恢复成功后重新物化第二版候选，再使用既有的一次局部复核；原模型、来源、额度和发布权限保持原合同。

补缺任务在 `source_root` 写入快照后、结果接收前中断，恢复返回 `reconcile`，调用方核对原任务并沿原事件接收。尚未登记的快照不会被视为已登记来源漂移，也不会自动取得来源身份。已接收结果及其来源沿原检查点和指纹恢复，不重新派发。

本入口的自动化测试使用合成宿主及合成论文产物。真实宿主派发、科学阅读、原生 Obsidian 展示和正式发布分别需要对应的实际证据与授权。

## 续接额度与候选修订

先执行 `npm run apa:session -- inspect-continuation --run-root <运行目录>`，也可向会话发送 `{kind:'inspect-continuation'}`。只读报告给出检查点指纹、问题 ID、待协调结果、剩余任务键、确定缺口、按已完成翻译任务的实际续接次数估计的余量和建议额度。已观测但未接收的 Editor 先走原 `result`；登记拒收后，可按符合条件的 `recover-rejected-editor` 恢复，或重新推算所需任务。账本中有未观测执行时先协调实际宿主结果。

用户批准后发送 `{kind:'authorize-continuation',authorization:{authorization_id,reason,checkpoint_fingerprint,max_additional_calls,max_additional_review_rounds,issue_ids}}`。新增执行上限可高于确定缺口。新增复核轮数仅可为 0 或 1，`includes_local_review` 单独报告本链是否要用复核。新增任务键和拥有者绑定随授权进入检查点。运行 ID 或论文 ID 已登记发布时拒绝续接，包括已被接替的运行；同一授权可重交，同号异内容报冲突。旧 `repairContinuation` 与 `reviewExtension` 用于读取历史检查点。会话终态和需追加额度的修订返回同一份推算报告。若原科学补缺任务未登记，报告给出科学范围未获授权的具体原因。余量按剩余翻译任务数乘本运行同一方向已完成任务的最大实测续接次数，已完成且无续接计为 0，没有可用历史时每任务计 1。原页图型更正仍可附 `chart_type_corrections`，其图、节点和来源须符合原范围校验。

`review_unroutable` 保留 Verifier 原回执，按问题 ID 报告缺字段、可用范围和描述中明确引用的 ID。Controller 可用 `annotate-review-scope` 补齐可定位范围。显式注记使用 `annotations:[{issue_id,fields}]`，仅可填报告中的缺失字段。反引号内或含连字符的 ID 唯一匹配时可省略 `annotations`，由 Controller 形成确定性范围注记。需要原 Verifier 澄清时，对同一 `action_id` 使用 `continuation-intent`、`continuation-receipt`，再用 `{kind:'accept-review-scope',execution_id}` 接收单独的原生范围文件。宿主续接计一次实际执行，余额不足先推算和授权。补齐后进入 `revision_required`，按责任方安排修订。新增方法目录条目可链接候选中已有方法身份，两个语言版本的链接一致。

`npm run apa:session -- inspect-candidate --run-root <运行目录>` 读取已登记的候选文件清单，`--revision <整数>` 可选定版本。报告分别给出 `consistency` 和 `links`；修改、缺失、多出文件均使整体失败。缺少原渲染清单时报告不可用。

用户要求改候选时，登记 `{kind:'user-revision',request:{revision_id,request,repair_owner,scientific,target_entries,repair_scope}}`，renderer 修订另带 `affected_paths`。内部 `request` 字段保留原话；Controller 定位条目、选择 Writer、Editor 或 renderer，并记录是否涉及科学内容。角色继续使用原有受控产物。涉及科学内容的修改需要一次局部复核；现有任务绑定、调用余额和复核轮次均够用时直接修订，缺少任一项才申请续接批准。标题、措辞及呈现修改还须保留对应文本中的数字、常用单位、引用目标和图表编号，通过范围、链接和双语镜像检查后使用原审查。若这类修改需新增额度，在同一批准请求中给出零调用选项：获准发布已审稿后，在正式 Wiki 中人工编辑。用户选择此方案且尚未新增调用时，用 `{kind:'retain-reviewed-candidate',revision_id}` 保存该选择并回到已审候选。

用户指定并经主会话对照原文确认的单点事实更正，可以使用发布入口的 `user_corrections` 零调用路径。每项记录候选路径、唯一匹配的 before／after、原文位置和用户原话，两语分别列出；在批准清单展示后随同一事务写入，原审查记录保持不变。该路径限于数值、符号、系数、单位或方向词；段落论证与导图、导航结构修改仍按上述责任角色修订和局部复核处理。受限完成状态本身不授予发布资格，仍使用正式追加额度和复核续接入口。

新建角色、修订和补缺任务冻结 `dispatch_message_profile:'instruction-path-1.0'`，派发消息仅为指令文件路径。观察时对消息去除首尾空白后与冻结路径完全比较，其他结构化参数逐项保持一致；控制器在观察和接收结果时各核验一次指令文件指纹。`configured-reading-2.2` 指令包版本继续沿用。没有该行为字段的旧绑定按原消息协议校验；原句柄续接没有新独立指令文件，仍使用既有冻结续接消息及进度合同。

## 命令行会话与回执

`npm run apa:session -- create --input <JSON文件> --export-dir <目录>` 创建会话；`next`、`resume` 和 `event` 使用 `--run-root <运行目录>` 恢复，`event` 用 `--input <JSON文件>` 读取事件。`--input -` 可从标准输入读取。`create`、`next` 和 `resume` 必须提供 `--export-dir`，在打开会话前检查；返回派发动作时，完整动作按身份写入该目录，已有同名内容冲突会报错。

记录真实宿主返回时，`event --raw-result <文件> --export-dir <目录>` 保存原始字节并形成宿主回执；`--raw-result -` 从标准输入读取原始返回，此时事件须从文件提供。对于转录证据可使用 `--source <文件>`，记录其路径与指纹，不能同时使用 `--raw-result`。缺失或未观测的容量信息保持未知。`npm run apa:controller:audit -- <日志路径> <线程ID>` 按线程检查 Controller 工具调用，并返回覆盖程度与可识别事件；审计输出不能代替宿主回执。


## Results 资源交接

2.2 为 Results 预登记 `resources/results` 输出目录及 `science/results-resources.json` 受控资源清单。Results 使用已选择的 Python 调用 `scripts/lib/reading-resource-tool.py`，通过标准输入指定来源、输出目录和项目；PDF 使用物理页及可选点坐标裁剪，DOCX 指定原始 media、图号和段落位置。按来源分别生成后，Results 合并返回的 `reading-resources-1.0` 项并写入指定 native 清单。每项保留源文件与生成文件的路径、指纹、长度和定位；图像判读与裁剪结果检查由 Results 负责。Results 的科学输出包含 `resource_manifest`，其中 `path` 使用派发提供的 `owned_manifest_path`，并附 `resources_root`、清单原始字节的 `sha256` 和 `byte_length`。Integrator 将该对象原样写入 `visual_handoff.resource_manifest`，`presentation.visuals` 的 `id`、`path`、`source_id`、`locator` 须与清单一致。Controller 接收清单并验证身份、来源和产物，再交接后续步骤。采用已有科学产物时，在首次派发 Writer 前按原 Integrator 的运行目录和运行 ID 核验资源路径、清单回执、源定位和图片字节。检查点恢复及发布准备会重新核验。


**多篇批次准备与状态**

批次准备接受用户提供的多个 PDF 路径或 JSON 清单，沿已保存配置检查来源位置与额度，检查已登记来源漂移和论文重复。每篇保留独立运行根及预算，全批共用首次捕获的代码快照。准备返回每篇的 `startup_prompt`；主会话按该提示为每篇安排独立宿主会话，核对实际原文语言、解析证据及宿主能力后启动既有阅读会话。准备本身不解析论文或调用模型。

```text
node scripts/v3/reading-batch-cli.mjs prepare --root <绝对库根> --manifest <清单JSON路径>
node scripts/v3/reading-batch-cli.mjs prepare --root <绝对库根> --batch <批次ID> --pdf <PDF绝对路径> --pdf <另一PDF绝对路径> --options <默认授权项JSON路径>
node scripts/v3/reading-batch-cli.mjs status --root <绝对库根> --batch <批次ID>
```

清单使用 `schema_version: 'reading-batch-request-1.0'`、可选 `batchId`、`defaults` 与 `papers`。`defaults` 保存实际批准的 `authorizationId`、`maxTotalCalls`、可选 `maxCalls`、`sessionContext: {model, effort}`、`includeRepairs` 与 `enrichmentPolicy`；每个 `papers` 条目含 `pdf`，可含 `supplements`、`doi`、`title`、`paperId`、`runId` 及各自的授权项覆盖。`--options` 文件直接保存 `defaults` 对象。额度和模型必须来自本次批准，文档和现有配置不代替执行授权。

批次登记位于 `.runtime/apa-reading-batches/`，每个运行根保存 `reading-batch-run.json` 和会话持续更新的 `reading-batch-checkpoint.json`。会话创建核对原快照、配置指纹、来源和批准参数，拒绝参数漂移。准备结果逐篇为 `prepared` 或 `preparation_failed`；查重命中或已登记来源漂移在整批写入前拒绝，其他单篇失败独立报告。

`status` 读取短检查点与发布元数据，输出阶段、实际调用计数、下一动作、待用户决定事项和队列位置；单篇摘要上限为 8192 UTF-8 字节，本批实际登记的 Raw 补充来源另行汇总。状态读取不打开论文、科学角色正文或完整科学状态。多篇不设并发上限，宿主限流时保留原调用及回传，按宿主允许的时间沿原动作恢复；未知执行结果先核对原句柄，不自动增加各篇额度。

**快照绑定与重绑**

新运行准备时对 `scripts/`、`Schema/`、`prompts/`、`docs/apa-v3/` 和 `package.json` 建立内容寻址快照，位置为 `.runtime/apa-code/<哈希>/`。同一代码树的运行共用一份只读快照；先复制、校验，再原子发布。运行绑定保存代码根、正式数据根、文件清单、Git 提交号及运行目录中的未提交补丁。CLI 根据运行绑定在快照进程中执行；配置、来源、解析、候选和运行记录始终使用显式正式库路径。快照沿祖先目录使用库根已有的 `node_modules`。

源码采集、Git 证据、私有快照复制和字节校验在全库锁之外进行。`.runtime/apa-code.lock` 内只执行短时同步操作，确认已核验目录或原子公布新目录，并登记运行引用。其他进程持锁时排队，最多等待 10 分钟。`READING_RUNTIME_SNAPSHOT_BUSY` 附锁所有者进程号、锁创建时间和已等待时长；死进程遗留锁可自动回收。同进程重入报告 `READING_RUNTIME_SNAPSHOT_LOCK_REENTRY`，调用栈给出重入位置。

`inspectReadingRuntime` 对照绑定的快照检查字节。库内代码变化不会改变在途运行，快照本身被改动则拒绝继续。需要应用修复时，先比较新旧快照及相关测试，再通过明确批准的 `rebind` 事件记录切换。批准沿用运行时修复的字段；单运行使用 `run_id` 和 `checkpoint_fingerprint`，批量范围使用 `run_ids` 和按运行 ID 索引的 `checkpoint_fingerprints`。每个运行独立核对自己的检查点和新旧指纹，重绑后通过新进程继续。原冻结提示、模型、预算和已接收回执保持。

使用 `recordReadingEvent(session, {kind:'inspect-runtime-rebind'})` 取得新旧指纹、变更文件及当前检查点。核对测试证据并取得批准后，发送 `{kind:'rebind', approval}`；成功返回 `READING_SESSION_RUNTIME_RESTART_REQUIRED`。随后用原 CLI 的 `resume` 或 `next` 启动新进程，入口按已保存的批准链选择新快照。批准范围变化或未列入批准的运行会被拒绝。

重绑写入前先核对会话检查点容量。若中途退出，恢复按受控回执决定完成切换或撤销待切换状态；仅对本次预登记且尚无回执的准确字节，核验后保留到原控制目录的 `.abandoned-<SHA-256>` 路径并记录映射。已有回执和其他字节不受该恢复分支处理，原运行的任务及预算继续保留。

**旧绑定的运行时漂移检查**

2.2 绑定冻结运行时文件、Schema 和提示的指纹。`inspectReadingRuntime({manifest})` 对照当前文件并列出变化路径及前后 SHA-256；运行时变化须先审阅具体差异和相关测试结果。`validateRuntimeRepairApproval` 校验批准对象：`authorization_id`、`run_id`、`checkpoint_fingerprint`、`previous_runtime_fingerprint`、`current_runtime_fingerprint`、`changed_files` 和 `test_evidence`，其中 `changed_files` 按路径排序，逐项包含 `path`、`old_sha256`、`new_sha256`，增删一侧为 `null`；`test_evidence` 为非空数组，逐项包含 `path`、`sha256` 和 `byte_length`。批准对象只接受列出的字段，测试证据路径可相对于冻结仓库根目录或使用绝对路径。校验会回读文件及证据，确认批准范围仍对应当前运行与检查点。批准不会改写原绑定或扩大原任务预算。 `nextReadingAction` 发现变化时返回 `kind:runtime-drift`、差异清单和当前 `checkpoint_fingerprint`。用户审阅精确变更及测试证据并明确批准后，使用 `recordReadingEvent(session, {kind:'runtime-repair-approval', approval})` 记录；成功返回 `recorded` 与新运行时指纹。会话将批准链写入独立受控检查点，恢复时读取批准链；未通过校验返回 `READING_SESSION_APPROVAL_INVALID`。

批准涉及 JavaScript 执行文件时，返回 `READING_SESSION_RUNTIME_RESTART_REQUIRED`，须在新进程恢复后继续，确保使用获批代码。2.2 的 `sections`、`science_sections` 和 `frozen_support` 保存原始指令内容；`frozen_support` 包括科学索引说明和角色回执规则。批准磁盘提示文件变化后，同一运行继续使用这些已冻结内容，原请求和原绑定保持。

Results 清单接收前会保存原宿主观察、科学输出和清单的精确字节。若清单已写入、回执尚未写入时中断，恢复将依据持久记录重新核验来源、图片和清单字节，再补齐受控回执；文件变化会阻断接收。

**终态与自动回收**

生产者登记自己生成的临时文件、字节指纹与运行归属。发布成功并写入 `publication/RESULT.md`、`publication/VERIFICATION.json` 后，或用户明确终止运行、决定不再续接 `completed_with_limits` 后，保存终态并执行回收。仅处于 `completed_with_limits` 状态仍保留续接能力，不自动删除。

用户终止使用 `{kind:'terminate', authorization_id, user_reply}`；明确关闭受限完成使用 `{kind:'close-with-limits', authorization_id, user_reply}`。保留实际用户原话与授权身份，并先核对尚在执行的宿主任务；未完成任务仍有执行消费者时保留其所需文件。

回收先把已登记的宿主句柄、原始回传和恢复补丁复制到运行的 `host/` 并核对字节，保留原路径到归档的映射及清单。确认快照文件清单、提交号和补丁已持久化后，释放该运行的快照引用；仍被其他在途运行引用的快照保留。只删除本流程登记的 `.tmp/` 内文件和无引用快照，未知文件、库外文件及仍有执行消费者的内容保留并报告。快照进程仍在执行时延后删除，退出后由入口完成回收。历史冻结记录不改写，旧运行不自动套用回收规则。

回收全程保留单篇 consumer。归档、压缩和字节校验完成后，全库锁只用于复核登记及提交指针、登记认领、原子移到退役路径并释放引用。随后在锁外删除已认领的退役路径。中断时沿同一认领记录恢复，即使其他运行已重建同哈希的规范快照路径，重试仍只处理原退役对象。
