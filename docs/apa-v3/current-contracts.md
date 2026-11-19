# 当前 APA 阅读合同

本文是独立工程的新论文说明，无需私有规划、评估记录或示例论文。实际字段以版本化合同和运行时为准。已有绑定保持原版本，新任务使用 reading-first-1.0。

## 入口与角色

Controller 使用 [reading-session](reading-session.md) 的 `createReadingSession`、`resumeReadingSession`、`nextReadingAction` 和 `recordReadingEvent` 推进新运行及恢复。入口调用 `prepareConfiguredReading` 冻结本库答案、来源、有限调用预算、模型/强度及原生/受控输出路径。必填项或所选依赖缺失时先设置，当前宿主及本次运行读写证据须另行通过 `reading_preflight`；发出请求不代表角色完成。

新建单篇和批量阅读统一冻结 `configured-reading-2.3` 提示，选用 Editor 时冻结 `reading-editor-1.5`。2.2／1.4 用于读取和恢复对应的已绑定记录。各角色完整提示与实际文件指纹在创建时绑定，只有明确启用的写作指导进入请求。历史绑定保留原提示字节和原恢复路径。

| 角色 | 责任 |
| --- | --- |
| Controller | 授权、绑定、派发、检查点、资源登记及受控交付 |
| Evidence/Coverage Mapper | 研究覆盖、证据定位、主结论和关键缺口 |
| Design/Methods Specialist | 设计、方法步骤、输入输出、测量和假设 |
| Results/Visuals Specialist | 关键结果、数量关系、图表来源和完整图注 |
| Interpretation/Appraisal Specialist | 结论强度、局限、替代解释与适用边界 |
| Scientific Reading Synthesizer | 组织完整研究讲解 |
| Integrator | 合并解释和分歧，确认资源与共享知识身份，交付 Writer |
| English Writer / Chinese Writer | 按实际论文原文语言选择其中一个，生成完整原文语言阅读稿 |
| Translation | 消费已接收的原文语言稿及译文所需上下文，生成另一语言稿 |
| Reading Editor（可选） | 消费真实原文稿与译稿，整理重点、层级和导航 |
| Independent Verifier | 完整候选一次整体审查，至多一次实质问题局部复核 |

模型选择按本库答案解析；实际请求使用冻结的宿主派发工具和参数，按该宿主支持的方式保证独立上下文。没有保存宿主声明时沿用 Codex 兼容派发路径，使用 `fork_turns:'none'`。请求身份、实际可观察身份与独立性分开记录，未知值不猜测。角色只写预登记输出，临时文件不进入阅读目录。

## 科学讲解

两版都把问题、设计理由、研究步骤、结果和结论限制连成可读主线。2.2 延续设计优先。2.3 用研究问题和设计理由引导全篇，重点展开研究步骤及本文如何实际使用方法，让关键结果紧随产生它的步骤。Evidence 定位关键操作，Methods 还原操作顺序，Results 说明直接产出及适用条件，Integrator 以稳定步骤 ID 合并，向原文语言 Writer 移交包含来源的完整做法。十六项主题是防漏指南，不是逐项签署或字数配额；详见 [科学阅读指南](../../.agents/skills/academic-paper-analysis/references/scientific-reading.md)。

方法区分通用原理、本文实施与未确认参数。区分作者报告、分析者解释、背景及缺失信息，背景不冒充本文结果。每个顶层模块首次出现缩写解释全称和中文含义。保留结论所需的条件、分母、单位、精度与公式关系，讲清如何得到结果，不止解释名词。

主线所需缺口先找回已登记正文、原页和图表，再按获批范围追溯直接引用方法或必要权威资料。新材料登记并沿用原预算，不递归扩展文献，不为普通细节立项。关键方法的实际做法讲不清时也触发 2.3 补缺。区分所读材料未报告某项设置与被引材料此次不可取得，说明已知做法、未知事项和受限的具体判断。

重点核对主结论、关键设计及会改变结论的数值、公式、表格关系。2.3 还在同一轮核对成稿中的核心方法应用，记录实际步骤、小节和已查看的来源位置。保留 rejected、partial、not_run 和未决问题；不放宽标准或制造证据。不新增解析核对角色或逐片段审计。

## 双语、图表与共享知识

Writer 在同一次写作中使用选中的 Nature/Humanizer/stss 指导，不新增润色角色。保留术语与必要限定，标题简洁具体，解释放正文；有效列表、表格、强调和层级正常使用。

最终入口为可用的中英文 Obsidian Markdown，不默认另交纯文字稿。交付包含已登记图片、完整图注、来源、知识链接与返回导航。复杂表格可用清晰原表截图，保留相关表头/脚注、页码及图片指纹；结论数字仍核对，不为展示默认重录整表。截图不替代解析验收。

复用概念采用稳定身份和一个双语文件。Methods 比较定义，Integrator 确认身份。2.3 的论文笔记详写本文操作、设置和结果。通用知识节点解释原理、操作、适用条件和局限，按需提供有标识的独立教学算例。节点的论文应用索引按篇链接实际讲解应用的小节。Editor 1.5 在第 3.1 节编号展开原理、本文中的作用及相关链接。受控增补保留既有知识内容与人工区域，新方法进入 `Wiki/methods/`。

## 审查、恢复与发布

完整候选先渲染，再一次整体审查，覆盖连贯性、关键双语意义、图表、知识与导航。普通风格偏好不追加调用。实质问题由责任角色局部修复，最多一次局部复核。新合同用 `repair_owner` 和 `repair_scope` 定位问题，首次审查的 Editor 输出作为不可变修订基线；范围外内容、顺序和身份须保留。无法定位或修订越界时保存 `completed_with_limits`，保留真实回传和已用调用，不自动重派或发出局部复核。未做原生 Obsidian 观察则如实记录，不能以字符串检查替代。

reading_complete 仍是 publishable:false。经 [受控发布桥](reading-first-publication.md) 登记原笔记、共享知识及资源；用户批准精确清单后才执行 V3 事务。只有已提交代次进入索引和图谱，解析、阅读、原生显示、阶段验收与发布不可互相替代。

中断保存原绑定、真实请求句柄、接受字节/回执、计数和待办，从断点继续，不重做已完成内容，不擅换模型、服务、来源或标准。已过期/关闭范围另获续接预算，修改本库设置不重绑旧任务。


2.2 和 2.3 都由 Results 读取原图、产出必要裁图及检查结论，Controller 负责派发和交接。DOCX 资源保留原图号和段落定位，来源单独成行，图注仅含原文或忠实翻译。Translation 在同一执行中连续处理分段；校验与进度保存后继续，无法完成时报告已完成进度、剩余 ID 和原因。角色自述与宿主容量证据分别记录。

## 阅读续接与候选修订记录

新续接授权由会话的 `inspect-continuation` 和 `authorize-continuation` 处理，并在 owned 阅读检查点追加 `continuationAuthorizations`。每份授权绑定原检查点、已用账本前缀、任务键、拥有者和新增额度。读取旧检查点时兼容 `repairContinuation` 与 `reviewExtension`。原有的整体审查与默认一次局部复核保留，额外局部复核须单独批准。

未定位的实质审查保留原字节并进入 `review_unroutable`。Controller 或原 Verifier 的补充范围以 `reviewScopeNotes` 单独登记。用户修改请求以 `user_revisions` 登记，与审查问题分开。渲染的逐文件清单以 `candidateInventories` 登记；非科学修改须追加指纹连续的 `userRevisionChecks` 才可进入发布准备。详见[会话操作](reading-session.md)。
