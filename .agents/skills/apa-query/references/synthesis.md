# 知识地图与综合

W2、W3 接口已接入确定性准备与合成验证。真实模型验收单独记录。当前可执行接口见 [contracts-and-tools.md](contracts-and-tools.md)，单任务消费见 [query.md](query.md)。

## 确定性原料

知识地图仅读取校验通过的当前登记清单与已登记笔记的当前 Markdown。每份输出保留代次 ID、实际路径、锚点与内容哈希；两语按稳定论文身份去重，保留未就绪、空库、无命中及局部不可用的区别。

| 目标接口 | 原料与输出 |
| --- | --- |
| inventory | 作者、年份、标题、研究设计、Reading overview 关键发现、局限小节标题、共享节点，以及引用它的专题和写作项目 |
| landscape | 论文与共享节点二部图；共用节点按论文数排序；罕见节点 IDF 加权相似度；固定阈值的稳定主题分组；跨主题桥接；只被一篇使用的方法 |
| dossier，按节点 ID 或 alias | 节点当前正文与引用它的各篇论文段落；附路径、锚点、哈希和年份，按年份排列 |
| clues，从论文、节点或问题出发 | 相邻节点、一跳论文、桥接路径及相关论文模块 5、6、7 的锚点 |

编号模块作为定位依据，小节标题只作提示。研究设计取模块 2 中标题含 design 或“设计”的小节；没有时跳过“2.1 研究导图”或“2.1 Research map”中的 Canvas 嵌入与导航，取模块 2 的研究设计正文。局限取整个模块 6；讨论和启示取整个模块 5、7，由同一综合任务解释竞争性解释与下一步。缺段返回 not_found，表示笔记未单列该内容。

landscape 和 clues 的可选 JSON Canvas 写入任务临时目录或写作项目目录，默认不纳入正式图谱。参考文献引用桥接须先核实登记数据；缺少参考文献列表时登记后续阅读增补需求，本轮使用已有共享节点连接。

## 综合任务

request 的目标 mode 为 answer（默认）、themes、dossier、compare、clues。准备阶段消费对应确定性原料及相关检索命中。保留完整问题和实际 retrieval_query；材料过长时沿路径、锚点读取。综合与写作在一次配置任务中完成，模型和身份核对沿用 [query.md](query.md)。

| mode | 固定章节 |
| --- | --- |
| themes | 主题概览；逐主题的涉及论文、共识、分歧及条件对照、典型方法、证据强度；有依据的结论；需要更多证据；可延伸的线索 |
| dossier | 定义与各论文用法；测量与操作化；按年份排列的关键结果；争议与未决问题；写作可用表述及适用边界 |
| compare | 人群或样本、设计、测量、关键数值及条件、局限、锚点的比较矩阵；随后连贯解释关键差异 |
| clues | 每条线索的连接路径、值得注意的原因、写作用途和证据缺口 |

每个矩阵单元和主要结论链接到实际笔记锚点。综合限于材料中的发现，知识网络的连接只提供检索和构思线索。

## 证据标注与核验

主要结论标注归属（单篇发现、多篇一致、相互冲突、跨篇推断）、强度和证据类型。冲突并列人群、设计、测量和时间条件。

| 强度 | 使用条件 |
| --- | --- |
| 推测 | 可检验假设或解释，尚缺直接验证 |
| 观察 | 报告实际观察的关联或现象，保留设计和条件 |
| 支持 | 指定研究条件下的结果支持该主张，表述与设计的推断能力一致 |
| 较强 | 具有直接证据，并有足够的研究设计与一致结果支撑更高确定程度；不能由论文数量自动推出 |

证据类型为直接证据、背景知识、方法支持。节点 source_kind 为 method-background 时默认归为背景知识，相邻领域发现不充当目标领域的直接验证。区分作者发现与跨篇推断、隐含假设与无依据主张、库内未见证据与有证据表明不存在。

目标确定性检查逐条返回不一致结论，沿用同次结果，不追加模型任务。多篇一致和相互冲突至少引用两篇不同论文，且依据锚点来自模块 4、5、7；共享方法或概念本身不算结论一致。跨篇结论至少两篇；较强须有直接证据。研究条件不一致、推测被提升为已支持的情况应明确报告；仅字段或锚点检查通过不证明科学含义已核验。

综合默认提供写作可用表述。如需保存，按 [专题保存](topics.md) 或 [写作项目](writing-project.md) 准备候选，正式写入须对精确候选批准。

## 接口与结果消费

确定性命令示例：

```powershell
node scripts/apa-query.mjs inventory
node scripts/apa-query.mjs landscape --threshold 0.1 --canvas
node scripts/apa-query.mjs dossier --node "节点 ID 或 alias"
node scripts/apa-query.mjs clues --from "论文 ID、节点或问题"
node scripts/apa-query.mjs search --query "tumour" --limit 10 --hits-per-paper 3 --snippet-chars 400
```

search 支持 --full、--entity-type（paper、topic、concept、method、writing-project）、--module（1–7，逗号分隔）、--year-from、--year-to、--paper-id（逗号分隔）。默认完整 JSON 预算为 32768 字节，truncated、total_results 和 total_hits 表示省略；用返回路径和锚点读取完整上下文。--full 不应用预算和数量限制。Canvas 作为 JSON 结果的 canvas 字段返回，用户要求保存时提取该字段写入任务临时目录或项目目录。

`citation.locators_omitted` 为 `true` 时，引文保留来源身份及 `locator_count`，具体定位元组已按预算省略。声明 `adopted_sources` 前，用 `readQuerySource` 或 `node scripts/apa-query.mjs source --paper-id <paperId> --source-id <sourceId> --generation-id <generationId>` 取回完整登记元组，再选用实际采用的定位。回答任务的 `total_results`、`returned_results` 和 `truncated` 用于区分检索范围与返回范围。

request 的 JSON 在原有 question、宿主与偏好字段外接收 mode、node、from、paperIds、projectId 和 searchOptions。dossier 必须给 node；clues 可给 from，省略时使用原问题。searchOptions 与 queryLibrary 的预算／过滤参数同形。固定章节见上表。

任务返回 answer 与 claims。每项 claim 包含 claim_id、text、attribution、strength、evidence_type、citations；引用包含 paper_id、path、anchor、sha256、quote 和 conditions（population、design、measure、time）。跨条件比较需保持条件并标 conditions_preserved:true。实际完整合同随任务提示返回。

使用 executeLibraryQuery 宿主适配时，模型仅执行一次，返回的 validation 逐项报告不一致。当前会话直接消费 request 时，完成后将 {generationId,mode,output,materials} 传入 `validate-result --input <JSON文件或->`；materials 沿用准备任务中的原对象。该命令不调用模型。passed 仅表示已实现的结构、锚点和命名表述规则通过，scientific_verification 仍单独记录。存在 issues 时向用户展示，不自动再次派发。

## 材料体积与当前正文

模型准备包中的 knowledge 为有界导航摘要，保留路径、锚点、关系和完整地图命令；omitted_counts 与 text_omitted 明确标记省略。采用科学主张前在同次任务内沿已登记路径读取正文。source_notes 提供原文语言笔记的锚点目录，observed_notes_hash 校验地图依赖的当前内容。registered writing project 的 current_markdown 保留当前可见正文，去除内部注释及既有个人区边界之外的内容。摘要省略不能用于判断库内没有证据。

审稿新增批注使用 `%% [open] 意见 %%`，`comments` 按出现顺序逐条列出 `paragraph`（从1开始）、`comment` 和 `status:"open"`。用户可将正文批注改为 `[resolved]`；再次准备时 `review_comments.handled` 标记已处理项，保留旧批注的内容、状态与位置。结果校验必须携带未经改动的准备材料及其 `content_hash`。禁止表述词项相似度与多篇主张条件缺失仅作为提示性诊断。
