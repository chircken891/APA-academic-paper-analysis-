# 会话执行与恢复

## 新运行

确认项目绝对目录、用户提供的来源路径、实际论文语言、解析产物、授权范围、当前会话模型/强度及有限预算。通过 [reading-session](../../../../scripts/v3/reading-session.mjs) 创建会话，消费该会话生成的绑定、任务和控制记录。配置中的 `ready` 只报告配置及依赖；运行所需当前宿主及读写证据须通过独立 `reading_preflight`。

`createReadingSession(options)` 创建；`nextReadingAction(session)` 返回下一动作；`recordReadingEvent(session,event)` 保存真实事件。入口封装已有科学 Controller 和阅读运行时，主代理仍通过当前宿主工具执行返回的冻结动作参数。逐项 API 和输入示例见[会话接口说明](../../../../docs/apa-v3/reading-session.md)。

| 动作 | 主代理操作 |
| --- | --- |
| dispatch | 先记录派发意图并确认保存，再原样调用动作指定的工具和参数。 |
| wait | 等待已经存在的真实宿主任务，保留原句柄。 |
| reconcile | 核对未知结果、冲突事件或控制记录容量，保留原状态，不自动重派。 |
| provide-input | 补齐明确缺少的已授权输入，不扩大论文来源。 |
| await-user | 保存状态后结束本轮，等待用户实际选择。 |
| complete | 按真实状态交付候选、限制和证据，发布单独处理。 |

科学阶段的 Evidence、Methods/Results、Interpretation、Synthesizer、Integrator 依次推进，Methods/Results 可并行。原文 Writer、Translation、可选 Editor 及整体审查由同一会话衔接。主代理不自行复制旧临时驱动或拼装另一套角色链。

本次明确授权补缺时，将原 `enrichmentPolicy` 传入会话入口。入口按缺口派发预登记的 Evidence/Methods/Results 初始任务，`includeRepairs:true` 才登记后期任务。新会话在绑定上独立冻结 `enrichment_session_profile`，策略原样保留。初始预留 Writer、Translation、可选 Editor 和一次审查，不预留 r2；额度不足返回 `reconcile` 和 `READING_FIRST_CALL_BUDGET_EXHAUSTED`。详见[补缺指南](../../../../docs/apa-v3/active-gap-enrichment.md)。

## 恢复

使用 `resumeReadingSession({runRoot})`；先核对原进程和真实任务，进程仍活着时沿原进程继续。科学阶段以持久科学状态为准，交接复用原 request_preparing/checkpoint_pending/transferred 过程，阅读阶段以通过 owned 收据校验的检查点为准。定位文件仅帮助查找。

重复事件复用原处理结果；冲突事件保留原证据并核对。意图已存而回传未知时不得重新派发。检查点提交成功、定位指针滞后时按预登记控制槽与有效收据恢复，不能按文件时间挑选或遇到损坏就静默回退。

保留原来源、模型、服务、请求、截止时间和调用计数。`max_calls` 是任务数量上限，补缺任务不计入阅读任务数量；`max_total_calls` 计入全部首次派发及原句柄续接的实际执行，并为后续步骤预留额度，`host_update`、查询和等待不计入。保留 `prior_calls=6` 科学任务基线，科学续接次数另账传递；旧绑定的实际剩余额度无法确定时记为 `unknown`。有限控制槽耗尽前返回 `CONTROL_CHECKPOINT_CAPACITY`，这表示本地控制记录需要处理，不改变模型预算。旧运行仍使用原绑定的恢复方式；只有明确授权的续接才能建立新合同。

## 修复

新 Verifier 实质问题通过 repair_owner 和 repair_scope 定位。Editor 修订从首次整体审查的不可变基线出发，仅修改关联章节、知识、图或明确指定的导图；其余内容、顺序、身份保留。原文修复经 Translation 同步，所有责任环节完成后才使用原有一次局部复核。

新补缺会话的 science 问题先完成已授权补缺，再修原文稿及译稿；仅译稿的 writer 问题保持单语修订。后期补缺与完整修订链在派发前共同检查原总预算，缺少额度或后期任务时保存 `completed_with_limits`。已写入但未接收的补缺快照在恢复时返回 `reconcile`，核对原任务后沿原事件接收，不自动登记或重派。

越界修订、无效范围或未定位实质问题保存为 `completed_with_limits`，保留实际回传和拒绝原因，已用调用照计，不自动重派，也不发出未执行的 review-r2。缺少已保存终态时只能报告待恢复，不能宣称终态已经持久化。

## Controller context budget

按动作读取字段白名单的短摘要，最多 8192 UTF-8 字节和 8 个引用；更多信息沿完整状态文件按需查阅。常态不整读正文、角色包或规则源码，具体错误按定位读取。版本化角色请求提供完整规则，科学交接继续按 science-index 的索引读取方式消费证据。新翻译通过文件引用按需读取，进度清单锁定完成片段，续接只处理剩余 ID；清单不能替代完整性验收，既有镜像校验仍须执行。

所有桌面应用的电脑控制均须用户明确授权，包括启动、点击、截图及 Obsidian CLI `screenshot`、`eval` 等原生观察；文件工具可检查原 PDF 图。原生展示 `not_run` 不阻断交付或发布准备。实际启动、截图和点击与验收状态分开记录，信息不足标记 `unknown`。工作规则不构成宿主硬性拒绝，宿主权限配置另需授权。

### Compaction boundary decisions

四个边界使用绑定的压缩规则：Evidence 完成、Methods/Results 完成、Writer 前、整体审查前。新配置化运行冻结 `boundary-reminders-1.2` 和当前宿主有证据的手动压缩入口；既有 1.0 和 1.1 绑定保持原规则和检查点字节。1.2 在四个安全边界保存状态后均返回 `await-user` 并推荐压缩，由用户明确选择继续或跳过，是否压缩由用户决定；入口不可用或未知、用量低或未知、之前已经压缩或提醒，都不自动跳过。

会话返回 `provide-input`、`kind:'compaction-observation'` 和 `boundary_id` 时，从当前宿主能力与可信运行记录收集一次实际观测，使用 `recordReadingEvent(session, {kind:'compaction', input:{observation, sessionId, progress}})` 回传后立即调用 `nextReadingAction`。观测及其用量时间的有效期为 60 秒；未知的会话 ID、用量和压缩事件保持未知，不以其他会话或累计用量代替。已冻结且有依据的手动入口可在没有临时入口观测时使用，Claude Code 的入口依据不能套用于 Codex。

返回 `await-user` 时展示实际消息及可复制的阶段压缩提示词并结束本轮；恢复后核对原进程、真实任务和检查点，记录用户选择再继续。提示词包含可用的运行与论文身份、原预算和截止时间、来源及产物引用、检查点和绑定路径等续接元数据，并要求压缩时保留已完成阶段、下一步、科学结论和证据、关键限制、待决事项及真实任务句柄；完整角色模型策略按需从绑定路径回读。未知字段标明未知，不塞入原文及角色全文。四阶段重点分别为：Evidence 后保留已提取设计和证据；Methods/Results 后保留关键方法、结果、数值和限制；Writer 前保留综合主线、分歧及 Writer、翻译、呈现的下一步；整体审查前保留候选路径、呈现版本、审查范围和最多一次局部复核。提示词由已有状态生成，不增加模型调用。每当边界记为 `skipped`，从已保存的 science-state `data.compaction_reminders` 或阅读 owned 检查点 `state.compaction_reminders` 读取对应原因，用一句话告知用户。等待期间原预算与截止时间不变，压缩或跳过不增加调用。成功压缩仅在实际事件能关联当前主会话时记录；无法核实时保留未核实状态。

## 底层接口和历史绑定

单独调试角色、低层 owned 产物、旧 P22/P22.1 及历史收据采用[底层 Controller 参考](controller-apis.md)。新功能使用会话入口，实际协议以版本化绑定及源码接口为准。
