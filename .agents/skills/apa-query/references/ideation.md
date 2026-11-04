# 创新点与外部新颖性

ideas 模式和 novelty 接口已接入工程实现，模型与网络的真实验收另行记录。执行和模型身份沿用 [query.md](query.md)，证据强度定义见 [synthesis.md](synthesis.md)。

## 库内构思

方向为必填项，可附写作项目。准备阶段收集相关论文模块 5、6、7、已登记冲突、知识网络桥接和孤立方法，以及项目已有想法与淘汰清单。已有方向用于去重，取得的段落保留代次、路径、锚点和哈希。

同一任务先产生 8–12 个候选，再收敛到 3–5 个。透镜包括矛盾与张力、未检验假设、方法迁移、边界探查、组合与拆分、跨领域结构类比及新数据或技术带来的变化。每个候选标出透镜和依据。机械淘汰只依据客观不可行；新颖性和影响用于标注。收敛考虑两句话能否说清、问题是否真实、复杂程度、受益者和可行性，保留淘汰原因。

每个入选想法包含：名称及两句话陈述、可证伪假设、依据锚点、最小验证设计、贡献类型、风险及投入、有趣性／可行性／新颖性 1–10 分、库内最接近论文及重叠和差异、最可能的审稿质疑及回应、外部新颖性状态。先用白话说明具体做什么；仅一篇依据时显式标注。贡献类型为新发现、新方法、机制解释、评估与诊断、资源与数据。新颖性 5 分表示有明确近邻但差异可辩护；1–3 分须有库内已实际做过的论文。方法不新但发现新时明确说明。外部新颖性默认“未核对”。

确定性验证目标包括依据锚点存在、“只有一处依据”与实际论文数一致、最接近工作确已登记、候选与既有想法去重及字段完整。想法质量由用户评价，候选作为后续研究方向。

输出合同中的 `lens` 使用矛盾与张力、未检验假设、方法迁移、边界探查、组合与拆分、跨领域类比、什么变了之一；组合时使用这些值的数组。`contribution_type` 使用上述五类。`risk` 与 `effort` 各为 `{level,source}`，level 为低／中／高，source 说明具体风险或投入依据。

每条候选及入选引用提供实际短引 `quote` 和 `claim_origin`（author／analyst／cross-paper）。代码核对短引位置，并对已明确标记为分析者推导的段落检查归属。该检查只覆盖命名模式；作者归属仍需同任务阅读来源。每个 `most_similar_papers` 条目保留 overlap、difference、conditions；条件未知时说明。比较与核心贡献直接重叠的工作，组合来源中未列为近邻的论文说明其角色及原因。

`discarded` 仅收客观不可行项，包含 idea_id、reason、criterion:'可行性'、objective_infeasibility:true。保留方向进入 `deferred`，包含 idea_id、reason、criterion、trigger；criterion 取两句话能否说清、问题是否真实、是否过度复杂、谁受益、可行性之一，trigger 为重新考虑条件。未入选候选恰归一类。

准备材料与实际采用材料分别记录。7.2 保留为合法原料，引用已有方向时说明新增推导。未用材料及理由可写入 `material_usage.unused:[{kind,reason}]`。`validation.coverage` 提供候选引用的模块统计、7.2比例、桥接及孤立方法路径覆盖；路径重叠仅作诊断，不证明知识网络已促成科学推理。材料全部集中于旧方向时，真实验收应继续标明覆盖不足。

可见稿使用 `render-result --input`，输入 `{mode:'ideas',output,outputPath?}`。output 为原始结构化对象，outputPath 为仓库相对的目标 Markdown 路径，用于生成正确的相对引用。呈现包含全部近邻、来源归属、风险与投入各自标签，以及客观淘汰／暂缓理由；原始返回另行保留。

brainstorming-research-ideas 和 creative-thinking-for-research 作为可选 writing_skills，默认不启用。经 apa-setup 配置页由用户选择并明确应用后，在同一任务按需读取；保存配置不证明模型执行，不新增调用。

## 显式外部核对

仅在用户明确要求为一个具体想法查外部文献时运行，请求须记录来源、检索轮次和调用预算。默认来源方案为 PubMed 为主、OpenAlex 为辅，来源和网络额度须先确认。结果限于本次来源、检索式和日期。

提取 3–5 条核心主张，每条至少使用 3 种检索式，读取疑似重叠论文摘要。最接近工作表记录论文、年份、期刊、重叠与关键差异；DOI 或 PMID 经接口回查，无法确认的保留并标记 [UNVERIFIED]。离线录制响应的工程测试与真实网络执行分别报告。

| 结论 | 判定要求 |
| --- | --- |
| PROCEED | 完成规定检索，未发现已完成核心贡献的论文，表示本次范围内可继续探索 |
| PROCEED WITH CAUTION | 点名具体薄弱点，例如已有论文覆盖某核心主张或差异仅限应用场景 |
| ABANDON | 点名一篇已发表论文，说明其完成的核心主张及摘要句或已回查段落的位置 |
| 核对未完成 | 接口失败、检索不足、疑似完全重叠论文摘要无法回查等步骤未完成，逐项列出缺口 |

完成检索而未发现近邻时判 PROCEED；无法指出具体薄弱点时也判 PROCEED。给出建议定位表述。外部论文仅作为写作项目的待读线索，保存须遵循项目受控候选流程；不自动下载 PDF 或入库。深入阅读由用户提供 PDF 路径后走 APA 阅读。

## 外部核对接线

`novelty --input <JSON文件或->` 默认仅准备。输入含 intent:'check-external-novelty'、idea:{id,statement}、sources:['pubmed','openalex']、budget:{max_calls,search_rounds}、claims:[{id,text,queries}]。claims 为 3–5 项，每项至少 3 条不同检索式且不超过 search_rounds。明确网络授权后传 network_authorized:true 才执行请求；每个 search／lookup 计入 max_calls，不自动重试。

执行返回来源、日期、检索式、摘要、标识回查、剩余比较步骤及内容哈希。由当前任务读摘要完成 assessments:[{paper,claim_id,overlap,difference,evidence_quote,weakness?}]，paper 使用 closest_work.identity，overlap 为 related／partial／complete。随后以 {phase:'assess',record,assessments,positioning?} 调用同一命令，消费完整原 record 并生成最终判定；该步骤复用已取得摘要，新增网络调用为 0。具体主张的科学重叠判断由这次任务完成，代码检查声明及摘要位置。

## 摘要筛选与离线解析

assessExternalNovelty 可以接收 exclusions:[{paper,reason,evidence_quote}]。排除项必须引用原题名或摘要中的实际文字，并说明与具体核心主张的关系；它们保留在 excluded_work 审计中。近邻表与待读线索仅保留入选项。搜索阶段的失败和保留候选的回查缺步继续阻止完成结论。一次原始响应可在修正解析器后离线重解析，不产生新请求，也不覆盖原记录。

PubMed 发表年份优先读取 JournalIssue/PubDate，随后读取 ArticleDate；索引完成时间不作为发表年份。网络适配每个搜索或回查消耗一次额度，默认每个检索式读取前10条；回查以 DOI 或 PMID 确认。保留真实HTTP次数与摘要比较任务数，不能把合成返回计为真实联网。
