# 写作项目与起草

本页说明已实现的 W6 工程接口：`project-save`、`project-update-request`、`project-update-candidate`、`draft`、`review` 和 `export-refs`。写作项目使用 `writing-project-1.0` profile；专题操作见 [topics.md](topics.md)。合成工程验证、真实模型执行与正式发布分别记录；未运行的验收保留 `not_run`。

## 项目与保存

项目具有稳定 project_id、revision 和实际来源依赖，默认单语，语言跟随创建请求。默认目标为 Wiki/writing/<project_id>.md，纳入登记和检索，默认不进入图谱。正式创建和更新沿用专题受控事务：先有明确保存意图，再准备精确候选及来源差异，获准后提交正文、依赖和索引到同一代次。候选保留旧 revision，Personal Notes 全程由人工维护。登记前材料保持候选状态。`project-save --input` 以 `saveIntent: "save"` 准备新项目；更新先通过 `project-update-request` 提供 `projectId`、`baseRevision`、`generationId` 与选定来源，再通过 `project-update-candidate` 准备候选。候选输入使用 `projectData` 和实际 `adoptedSources`，后续登记、批准与事务应用沿用专题接口，CLI 准备候选不直接正式写入。

| 区域 | 内容 |
| --- | --- |
| 研究问题与核心论点 | 用户的问题、假设和可选目标期刊 |
| 证据登记表 | 证据 ID、来源锚点、支持或反驳、主张强度、允许表述、禁止的更强表述、与项目关系；方法、数据、指标和局限在允许表述及关系中说明 |
| 创新点 | 入选想法、外部核对及范围、淘汰清单 |
| 论证提纲与正文 | 每节提纲在上，正文在下；改任一侧时同步另一侧 |
| 引用计划与待读线索 | 每处引用对应的证据 ID，外部论文作为待读线索 |
| Personal Notes | 人工备注 |

强度和证据类型沿用 [综合证据定义](synthesis.md)。每条写作主张指回证据登记。新论文入库后，相关提示说明可能受影响项目及证据条目或主题，用户选定来源后才准备更新。

## 按节起草与审稿意见

`draft` 与 `review` 通过 `--input` 接收 JSON，沿用 `request` 的问题、会话身份及宿主能力字段，CLI 只准备任务，实际执行沿用宿主接口。上下文二选一：已登记项目的 `projectId`，或临时 `writingContext: { projectData, adoptedSources }`。临时上下文经同样的证据结构校验，无需先正式保存；同时提供两者会被拒绝。`projectData` 包含五个数组：`evidence_records`、`ideas`、`discarded_ideas`、`sections`、`citation_plan`。证据来源包含 `paper_id`、`path`、`anchor`、`sha256`，须匹配当前登记来源及实际内容；创新点、章节与引用计划通过 `evidence_ids` 关联证据。

`draft --section` 支持 `related-work`、`introduction`、`discussion`，讨论另需 `userResults`；`review` 另需 `draftText`。每次用户请求的起草或审稿视角任务消费一个配置模型任务。原生派发、身份核对与不重试规则沿用 [query.md](query.md)，在同次任务采用已启用的 [写作指导](writing.md)。请求整节起草时，一次只处理一节。

| 节 | 组织要求 |
| --- | --- |
| 相关工作 | 按主题聚类并按与本文相关度排序；段落含主题句、2–5 篇代表工作、与本文比较和过渡，以本文定位收尾；材料不足时如实说明 |
| 引言 | 问题重要性、已知、缺口、本文贡献逐步相连，每一环关联证据登记 |
| 讨论 | 用户提供的本文结果与库内文献逐点对照，解释一致、冲突、可能原因和局限 |

修改已有段落时保持改动范围。审稿视角意见以 Obsidian 批注贴近对应段落，正文保持原字节，用户可标为已解决。过度表述检查在起草或审稿同次任务中逐句对照主张强度、允许表述和禁止的更强表述，列出原句与建议修改，不追加审查调用。

确定性核验包括草稿每处引用对应已登记证据，以及强度超限的可判定错误，命名回归包括“推测写成已有发现”和“单篇结论写成领域共识”。结构检查与科学语义核验分别报告；未核实的主张不得写作已通过。

临时项目可在 `writingContext.current_markdown` 提供研究问题、核心论点及研究阶段；该字段位于 projectData 之外，保持 `unsaved_context` 身份。缺少项目正文时返回定位不完整诊断，不能据此把项目定位验收记为通过。已有正式项目继续读取当前正文。研究计划可以没有实验结果，但应明确哪些贡献仍待检验。

证据登记的 allowed_statement、forbidden_statement 和 limitations 应具体到配体、物种、实验条件及推断边界。例如 RSPO2(FU)复合物不能直接证明RSPO1变异的结合构象，分段实验也不能单凭组合就宣称整条中介链已验证。通用的禁止夸大句无法充分测试这些能力。每个 statement 使用单一主张并记录 attribution；必要时拆分复合句，分别绑定证据。

`render-result --input` 接收 `{mode:'draft',output,outputPath?}`，在正文主张及紧邻引用后显示强度和归属；`executeLibraryQuery` 同样返回已呈现 answer，并在 output 中保留原始结构化返回供校验。review 维持原文及既有批注。呈现为零模型操作，不改变科学核验状态。当前会话直接作答时也应经过 validate-result 与 render-result，避免一次性脚本遗漏标注。

## 参考文献

export-refs 为零模型的确定性导出，按项目引用计划生成 BibTeX 与 RIS。字段取登记的标题、第一作者、年份、DOI 和完整引用串。作者列表不完整时在输出中注明，供用户在 Zotero 补全，缺失字段不补造。`export-refs --project-id <project_id> --format both` 默认返回两种格式，也可指定 `bibtex` 或 `ris`。CLI 向标准输出返回 JSON，其中包含参考文献正文、代次 ID、项目当前内容哈希和导出内容哈希；调用方再按用户指定位置保存。


保存为每节记录内部提纲与正文指纹。读取时，单侧变化返回 `WQ_SECTION_OUTLINE_BODY_DIVERGED` 与 `pending_side`；两侧变化记录 `both_manually_modified`，不据此证明语义一致。起草与项目更新应逐节同步待处理一侧并说明改动；无需修改时在对应节提供 `sync_reason`。未处理单侧变化的项目保存被拒绝。旧项目首次保存前没有基准，继续兼容读取。

写作项目更新提示的 `evidence_ids` 仅列相关条目，`evidence_matches` 逐条提供 `matched_terms` 或 `shared_nodes` 依据；无法判定时列表为空，保留主题名称。共享节点依据只取证据所引锚点所在节的实际链接，新论文侧读取整篇正文；两侧排除当前 `knowledge_id` 以 `chart-` 开头的图型节点。不可读笔记或缺失锚点不贡献共享节点，文字匹配保持原规则。提示保持只读。
