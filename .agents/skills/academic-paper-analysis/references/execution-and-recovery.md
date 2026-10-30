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

保留原来源、模型、服务、请求、截止时间和调用计数。有限控制槽耗尽前返回 `CONTROL_CHECKPOINT_CAPACITY`，这表示本地控制记录需要处理，不改变模型预算。旧运行仍使用原绑定的恢复方式；只有明确授权的续接才能建立新合同。

## 修复

新 Verifier 实质问题通过 repair_owner 和 repair_scope 定位。Editor 修订从首次整体审查的不可变基线出发，仅修改关联章节、知识、图或明确指定的导图；其余内容、顺序、身份保留。原文修复经 Translation 同步，所有责任环节完成后才使用原有一次局部复核。

新补缺会话的 science 问题先完成已授权补缺，再修原文稿及译稿；仅译稿的 writer 问题保持单语修订。后期补缺与完整修订链在派发前共同检查原总预算，缺少额度或后期任务时保存 `completed_with_limits`。已写入但未接收的补缺快照在恢复时返回 `reconcile`，核对原任务后沿原事件接收，不自动登记或重派。

越界修订、无效范围或未定位实质问题保存为 `completed_with_limits`，保留实际回传和拒绝原因，已用调用照计，不自动重派，也不发出未执行的 review-r2。缺少已保存终态时只能报告待恢复，不能宣称终态已经持久化。

## Controller context budget

只读取当前步骤需要的合同、错误片段及索引文件。版本化角色请求提供完整规则；主代理不默认内联整篇来源或所有角色输出。科学交接继续按 science-index 的索引读取方式消费证据。

### Compaction boundary decisions

四个边界继续使用已绑定的压缩规则：Evidence 完成、Methods/Results 完成、Writer 前、整体审查前。收到 await-user 时结束本轮；恢复后核对原进程、真实任务和检查点。等待期间原预算与截止时间不变，压缩或跳过不增加调用。未知或不可用能力按原合同记录限制。

## 底层接口和历史绑定

单独调试角色、低层 owned 产物、旧 P22/P22.1 及历史收据采用[底层 Controller 参考](controller-apis.md)。新功能使用会话入口，实际协议以版本化绑定及源码接口为准。
