# reading-first Obsidian 呈现

## 使用入口

新运行的 `createReadingFirstRunControl` 默认 `presentationRequired: true`。Integrator 在原有 owned 输出中提供 `presentation`，`buildReadingFirstHandoff` 随科学交接冻结它；原文语言 Writer 接收科学材料和资源目录，直接编排最终阅读稿，Translation 依据该稿译出另一语言；渲染器落实结构与引用，不代编全文。没有呈现信息时不能把纯文字结果当成完整交付。`presentationRequired: false` 仅供明确的历史合同兼容与合成旧路径测试。

`renderReadingFirstNotes({controller,targetRegistry,existingTargets,knowledgeRegistry})`（`scripts/v3/reading-first-runtime.mjs`）从运行状态渲染完整呈现。`knowledgeRegistry` 提供只读知识节点身份/别名匹配，不能授权写正式节点。完成整体审查后，按[最新阅读结果的 V3 发布](reading-first-publication.md)准备完整文件清单，经精确哈希批准后复用既有事务；正式索引与图谱读取已提交代次。

纯渲染入口 `renderReadingFirstObsidian({identity,views,presentation,targetRegistry,existingTargets,knowledgeRegistry})` 不写文件。它返回双语 `notes`、`supportNotes`、已有知识的 `knowledgeProposals`、资源路径及登记表，不产生科学或原生验收结论。

## Writer 与呈现接口

### 阅读呈现编辑

新功能性交付建议在新控制绑定中显式设 `presentationMode:'reading-editor'`。顺序为科学整合 → 原文语言 Writer → Translation → 一次双语 Reading Editor → 渲染 → 原有一次整体审查（旧 source-first 绑定为首先写作语言的 Writer → 另一语言 Writer）。Writer 保留完整讲解和资源落点；Reading Editor 为这些真实 accepted views 添加呈现信息，不改写科学段落，不增加科学核对或润色调用。

原文稿与译稿接收后调用 `createReadingFirstPresentationRequest({controller})`。请求包含 `views`、原 `view_receipts`、登记的 `presentation`、`output_schema`（`reading-editor-1.3`）；局部修订附 `issues`。按既有真实 host/native/owned 流程接收编辑输出后再渲染。编辑角色使用本次冻结的角色模型及推理强度，配置为follow-main时才采用冻结主会话设置。新模式控制器允许后续调用上限4–8次，并不自动授予这些调用：原文Writer、Translation、Editor、整体审查共4次；原文稿与译稿修正、Editor更新和一次局部复核还需4次。若授权包含完整修复链，须在冻结前预留8次，并把先行科学调用计入独立总上限。具体授权可更小，复用已接收原文稿与译稿的窗口无需重跑Writer与Translation。恢复不重置额度。

编辑输出绑定 `readingFirstViewsFingerprint(views)`，格式及校验见 [编辑接口](../../scripts/v3/reading-first-editor.mjs) 和 [Reading Editor 合同](../../prompts/v3/reading-first-contracts.md#reading-editor)：

- `languages[language].overview`：重点及实际 `section_ids`，让读者先看到研究主线和关键限制。
- `sections`：按稳定 `section_id` 添加可选 `takeaway`、原段落精确引文 `emphasis` 和按 `before_paragraph` 放置的 `subheadings`。强调仅落在未加粗的纯文本，不进入公式、链接或代码，不交叠。渲染器负责编号和锚点。
- `methods`：独立逐项列出方法、测量与必要概念，包含 `id,title,explanation,application,section_ids` 和登记过的 `knowledge_ids` 数组；兼容旧 `knowledge_id`。没有已确立通用知识身份的条目可省略关联或使用空 `knowledge_ids`；非空关联须属于登记目录，两语每项的知识身份集合（含空集合）一致。原理与本文应用分别充分说明，不只提一嘴。

reading-editor 1.3 在上述字段外还要求：

- `languages[language].visuals:[{id,title?,notes?:[{section_id,paragraph_index}]}]`：图表的简短显示标题（含原编号）以及读图说明段落。说明段落须是该图放置小节中的非首段且没有小标题，渲染时移到图片之后，不改写文字。
- 顶层 `map.nodes:[{id,stage,primary?}]`：步骤分为 `design`/`measurement`，发现分为 `finding`/`limit`，主要发现标 `primary`。两种语言共用一套选择；未列出的节点不画，只画已登记关系中两端都保留的连线。

渲染：模块大标题固定为“摘要 / 研究问题与设计 / 方法、概念与测量 / 主要发现 / 讨论 / 局限 / 结论与实践含义”（英文 Abstract / Research question and design / Methods, concepts and measurement / Findings / Discussion / Limitations / Conclusions and implications），不显示 Integrator 按论文拟定的模块标签，论文特定措辞只出现在小节标题；正文只用模块和小节两级编号标题（含文档标题共三级），编辑小标题渲染为段首加粗短语；目录和原图注放进默认收起的 callout；方法目录每条是一个收起的 callout，读图条目不进目录；图表以“标题 · 原文页”行承载 `^rf-visual-<id>` 锚点，其后依次为图型、图片、读图说明和原图注，已在图型行链接的图型节点不再重复显示“方法背景”行；研究导图改为分阶段的从左到右流程图，主要发现深色粗框显示，嵌在 Writer 写的研究设计概览小节之后，不再单设导图小节和链接列表。

导图要求 `map.steps` 全部进入导图，发现可精选，未画入的发现由渲染器在图后逐项链接到对应小节。漏选步骤返回 `READING_FIRST_EDITOR_MAP_INVALID` 并列出缺失 ID；图中应画与实际绘制的集合不一致返回 `RF_RESEARCH_MAP_INCOMPLETE`。关系仍使用已登记的步骤到发现。

当前编辑器版本为 `reading-editor-1.3`，完整合同见 [1.3 提示](../../prompts/v3/reading-editor-1.3.md)。它保留全部步骤及省略发现导航，同时直接展开目录、方法条目和原图注。Editor 请求从两语视图移除已单独提供的知识正文，每份已提供知识正文只传一次。首次整体审查的 Editor 输出及收据作为修订基线；新 Verifier 的 `repair_scope` 指定章节、知识、图表或导图字段，后续修订保留范围外内容与身份。无法定位或越界的修订保存真实拒绝结果并结束为 `completed_with_limits`，不自动重派或启动局部复核。

Nature/Humanizer 用于专业、自然的表达，不限制有效的重点加粗、编号、分层目录、简表、列表或 callout。读者可先浏览重点再读连续解释，不能只把原文按顺序复述。重要条件、结果与局限保持直接可见。

`presentation.schema_version` 保持 `reading-first-obsidian-1.0`。新布局指定 `layout:'writer-modules-1.0'`，与没有 layout 的历史呈现合同区分。

- `modules:[{id,label:{en,"zh-CN"}}]`：按 abstract、design、methods、findings、discussion、limitations、conclusion 排序，对应原始摘要、研究问题与设计、方法概念与测量、主要发现、讨论、局限、结论与实践含义。Writer 在模块内组织子节；渲染器生成模块及子节两级目录，研究导图放在详细设计之前。
- `bibliography`：题名、首位作者、年份，可选 citation/doi；title 可为两语对象。完整 DOI 编号作为可点击文本显示。新论文文件名保留规范大小写、首字母和缩写；既有登记路径保持稳定，明确获准的候选改名须同步登记与引用。
- `source_pdf`：新运行使用 `Clippings/` 内的相对 PDF 路径；`sources:[{id,path}]` 登记正文、补充材料和获准方法背景的可链接来源。主文及补充材料绑定其 `Clippings/` 原件；只有实际接受的 AI 补缺来源可登记到 `Raw/`。历史冻结记录的 `Raw/` 路径继续按原合同读取，不扩大原来源许可。
- `sections`：已有资源或研究导图引用的稳定 `id`。Writer 沿用这些标识，并可组织其他必要子节。`indices:{en:0,"zh-CN":0}` 只供历史样例适配，不能替代新 Writer 输出。
- `visuals`：`id,kind,label,caption,path,page`；kind 为 figure/table/formula，新运行的 path 必须位于冻结的 `Figures/<run_id>/`，且目录下只有一层文件名。未冻结 `figures_dir` 的旧绑定沿用原路径校验。page 是从1起的 PDF 物理页。图型用 `chart_types:[{knowledge_id,label:{en,'zh-CN'},panel?}]` 关联共享方法节点，复合图按子图标注。多页表分别登记并保留表头、续表及脚注；历史字段 section_id/after_paragraph 维持旧合同，新布局由 Writer 返回落点。
- `knowledge`：`id,kind,canonical_key,title,aliases,paragraphs,source_kind`；kind 为 method/concept，source_kind 为 method-background/paper-fact。标题和段落分语言提供。只有通用 method-background 形成共享候选或既有节点增补；本文应用、实际参数和限制留在论文。新布局由 Writer 返回落点，历史 placements 保持兼容。
- `map`：steps/findings 各含 `id,label,section_id`，relations 为 `{step_id,finding_id}`。使用有科学依据的实际关系，不按序号强配；正文提供设计与发现的双向链接。Integrator 验收时校验该导图：节点 id 唯一、含标签、`section_id` 在目录中，relations 为连接 step 与 finding 端点的 `{step_id,finding_id}`（旧 `{from,to}` 作别名接受）；不通过为 `SCIENCE_CONTENT_INVALID`，退回 Integrator，而非到最终渲染才失败。采纳模式的 `scientificInput.presentation` 同样校验。

Writer 输出：

```js
{
  language: 'en', // or 'zh-CN'
  sections: [{ id, module_id, heading, paragraphs: ['Markdown paragraph'] }],
  placements: {
    visuals: [{ id, section_id, after_paragraph: 0 }],
    knowledge: [{ id, section_id, after_paragraph: 0 }],
  },
}
```

`module_id` 引用已声明模块；章节标识在双语和局部修订间保持一致，after_paragraph 从0起。paragraphs 支持原生 Markdown，包括适度加粗、分段、必要步骤、简表和少量 callout。格式服务于内容，连续解释仍是主体，重要结果和限制不默认折叠。原始摘要及忠实译文保留，不作风格改写。

正文可使用 `[方法页](apa-source:paper#page=2)`、`[图1](apa-visual:fig1)`、`[年龄标化](apa-knowledge:age-standardization)`。渲染器根据目录转换为库内相对链接；源页为物理页，印刷页标签使用已确认映射。Writer 选择引用位置和可读标签，不编造路径或页码。文献信息、资源导航和独立个人笔记由渲染器生成。

新配置阅读使用 `writingMode:'source-translation'` 与 `translation_profile:'translation-1.0'`：调用者按实际主论文显式传入 `sourceLanguage`，控制绑定的 `source_language` 同时决定原文笔记和译文目录归属以及 Writer 与 Translation 的方向；本库 `reading.source_language` 不再询问，新运行忽略。只运行原文语言对应的 Writer（英文论文用 English Writer，中文论文用 Chinese Writer），再把其已接收 `source_view` 交 Translation。Translation 不接收科学交接，输入只有原文稿与回执、Integrator 的 `terminology` 以及 `presentation` 中的双语标签和 ID；输出与 Writer 视图同一结构，由 `validateLayoutView` 校验，以自然目标语言保持结构、科学含义及资源关系；始终忠实翻译、不改动事实；原文稿看似矛盾或有误时照原文翻译，并在回复文字中指出该段，由整体审查经原文 Writer 修订处理。例如英文论文由 English Writer 成稿，英文笔记在 sources，中文译稿在 translations；中文论文相反。

`scientificInput.presentation_assets` 可登记导出的来源资源 `{path,sha256,byte_length}`，随输入指纹冻结并在运行/恢复时检查。它不授权新增论文来源；原页派生与外部方法背景沿用既有来源许可。

已获授权的历史科学材料复用通过 `scientificInput.adopted_science: [{artifact_root,artifact_id,receipt}]` 接入，不能与非空 `role_artifacts` 混用。接口读取原 owned 文件并验证原回执，保持原 run、所有者和来源根；运行中继续检查原字节。仅该复用路径允许 `scientificInput.presentation` 作为单独绑定的版式与资源适配，不冒充新的 Integrator 科学输出。新窗口独立限定调用次数，不复活旧额度。工厂默认 `independent` 兼容旧调用者，新流程须显式传入 `writingMode:'source-translation'`。

新的配置化运行冻结 `handoff_profile:'science-index-1.0'`，下游请求不再内联六个科学角色的全部输出。Writer 及其修订请求只内联 Integrator 输出；`handoff.presentation` 存在时，Integrator 内嵌的 `presentation` 不再重复。其余角色登记在 `handoff.science_index:[{role,path,sha256,byte_length}]`，路径来自各自回执所在的 artifact 根，Writer 仅在核对页码、原值或上游措辞时按需读取，指纹不符即为输入错误。整体审查请求携带同一精简交接，并把 `presentation.supportNotes` 写成 `review-inputs/<review|review-r2>/` 下的文件，列入 `support_note_files:[{path,note_path,sha256,byte_length}]`，主笔记仍内联；字节相同的已有文件可复用，字节不同则报冲突。局部复核 `review-r2` 不带科学交接，只同样外置支持笔记。读取规则写在 `prompts/v3/science-index-1.0.md`，仅对新绑定注入，其指纹随状态冻结，改动后请求以 `READING_FIRST_SCIENCE_INDEX_NOTE_CHANGED` 失败。

图注文字应来自已保存材料。裁去外部图题或说明时，现有按语言提供的 `caption` 中须完整保留对应原题、说明、缩写、符号、排除条件及脚注，并在图片旁标明原注和来源页；英文保留原文，中文忠实翻译。尚未可靠转录时保留图片内原注。分析者解读、单位澄清或疑似纠错使用 Writer 的独立“Reading note / 阅读说明”段落，不混入原注，不增加图注字段。原注有矛盾也不静默改正；跨页表按顺序保留注释归属。年龄标化等教学公式与作者实际模型继续区分。

## 候选导出与知识复用

### 同一知识节点的双语内容与持续增补

新绑定显式使用 `presentation.knowledge_layout:'shared-bilingual-1.0'`。每项独立方法、指标、概念或图型只生成一个双语 Markdown 文件；新文件默认使用中文规范名称（如 `Wiki/methods/直接年龄标化.md`），不带论文标识、哈希或语言后缀。两语论文链接同一文件的相应语言章节。标题及别名保存两语名称、缩写，稳定身份与语言无关；既有登记路径保持不变。历史布局不自动转换。

知识内容可用 `sections:{en:[{heading,paragraphs}], 'zh-CN':[{heading,paragraphs}]}` 组织，原 `paragraphs` 保持兼容。按知识需要讲清定义、原理、公式及符号、教学示例、适用条件、局限和常见混淆；不要求每项机械套齐全部栏目。教学示例必须明确标识。公式、来源和论文应用链接在同一文件中共用，论文的实际设置、结果和局限不得成为通用定义。公共资料只解释方法，不能证明本文实际使用的参数。

Writer 可通过其正常 view 的 `knowledge_content:[{id,paragraphs,sections?}]` 提交自己语言的节点内容；新共享布局请求要求覆盖所有已登记知识 ID。ID 不得重复或新建，段落非空；只覆盖自身语言，公用来源、公式和身份保持原目录。接收前校验，阅读呈现编辑请求及最终渲染消费合并后的目录。旧布局不消费该扩展。

中断后的显式获批续接可通过 `adopted_views` 复用已接受的原文语言 Writer 回执，并可同时带上另一语言的 Translation 回执（`role:'translation'`；旧 source-first 绑定为另一语言 Writer 回执）。Translation 回执只能与原文语言 Writer 视图一同采纳，并对照原文稿校验（译文镜像与完整性）。只有原文语言稿时仅触发缺失的 Translation；两份齐备时直接进入呈现编辑；Reading Editor 的结果不可采纳。原运行和失败调用保留，新窗口单独绑定；不能把复用视为新写作，也不能通过恢复重置额度。

若同一新任务窗口已经实际执行科学调用，控制绑定用 `priorCalls` 计入已用量，`maxCalls` 限制后续 Writer/Editor/Verifier 调用，`maxTotalCalls` 独立限制总调用。`priorCalls` 为非负整数且须有足够总上限，非零值冻结为 `prior_calls`；恢复时已用量等于此前实际调用加本窗口请求数，第06篇本轮使用3次先行科学调用、后续最多7次、总计最多10次；该授权不是其他运行的默认预算。

Methods 提供通用知识，Results 识别图型、子图和裁切区域，Integrator 合并身份并组织本文应用，原文语言 Writer 与 Translation 在既有任务内提供相应语言内容及受影响论文段落，Reading Editor 负责呈现。遇到缺口按原定向补缺接口交回内容所有者，不由编辑补造。允许的权威方法资料检索仍受本次来源范围和预算约束。

先由名称和别名发现候选，Methods 与 Integrator 比较定义、方法实质、适用条件和边界，确认稳定身份后再形成同一节点的增补候选；保留人工内容、原来源及不同论文的应用链接，避免重复定义。已有共享节点的 `KNOWLEDGE_STATE.item` 保留原 paragraphs/sections/sources/formulas，新论文内容存为按 paper_id 区分的 `paper_additions`；同一论文后续增补替换自己的增补段，来源按 URL 合并。该接口不授权改写基干定义、撤销旧来源或覆盖人工区；这类冲突须单独处理，不能伪装成增补。来源说明只限定其实际支持的新内容，不因本次未重复检索而否定旧来源。本轮预览只生成已有节点的合并候选，不写正式库；历史双语候选保留，新入口不再指向重复节点。图型节点沿用 `Wiki/methods/`，其他概念沿用既有分类，不建立平行目录。

节点登记表由 `readCommittedReadingFirstKnowledgeRegistry({vaultRoot,policy})` 读取登记的 `shared_nodes`（传入 `binding` 时策略与库根取自该绑定的冻结值），不扫描未登记的 Wiki 文件。新配置化绑定使用 `current-shared-nodes-1.0`：校验提交配对及登记身份，消费共享节点当前正文，实际复用路径与内容指纹进入候选依赖。用户编辑的正文保留，本篇增补接在当前内容上；无关节点编辑不阻塞候选。实际依赖在生成期间变化时，用已接受的原稿刷新受影响候选，不重新派发科学角色。查询和图谱读取当前登记内容，历史严格校验仍服务于原交付证据。

图表来源页显示从已登记 source 身份判断：`sources[].kind:'supplementary'` 或 source id 为 `supplementary`/`supplement` 时显示“补充材料第 N 页 / Supplementary p. N”；未知身份保留原标签，不猜文件名。`chart_types[].panel` 保留面板身份；可用 `panel_label:{en,'zh-CN'}` 提供显示名称，常见面板字符串按语言显示，字母编号保留。

图片从原 PDF 派生裁切，必要时旋转与提高渲染清晰度，不重绘科学内容；记录原物理页、裁切区域、旋转和来源指纹。去掉无关正文、页眉页脚，保留坐标、图例、单位、面板标记、必要表头及脚注。标题、说明及原文定位在图片旁完整呈现。多图同页分别提取，跨页表保持连续；不能可靠裁切时保留较完整区域。原始 PDF 与原页图不变。

可复用的区域渲染入口为 `python scripts/v3/render-pdf-regions.py <manifest.json>`，使用既有 PyMuPDF 环境，不调用 MinerU。输入包含 `source_pdf`、`output_root` 和 `regions:[{id,page,bbox,path,rotation?,dpi?}]`；页码从1开始，bbox使用PDF页面坐标，rotation为顺时针角度。输出逐图来源、裁切范围、像素尺寸和指纹；拒绝越界区域及覆盖已有图片。Results先确认区域内容，Controller登记派生资源，不能用程序成功代替裁切视觉检查。

验证两语指向同一文件、页内语言定位、已有节点复用、跨论文增补和人工区域保护，并检查图型关联及裁切完整性。程序链接检查与实际 Obsidian 阅读验收分别记录，仍仅一次整体审查、最多一次局部复核。

`exportReadingFirstPreview({outputRoot,identity,views,presentation,targetRegistry,knowledgeRegistry,resources})` 导出新候选目录，拒绝覆盖已有目录。资源可为 `{path,source_path,sha256,byte_length}` 或本次候选文本 `{path,content}`；所有输出 path 为库内相对路径。先检查来源字节、输出冲突、图片/链接和块锚点，再写出。`.apa-v3/presentation.json` 保留清单、建议增补和明确的未验收状态。

新策略的配置化预览从已校验登记表复制实际引用的历史知识正文，递归补齐历史知识依赖及所需已登记资源，并校验本地链接和锚点；旧论文入口使用标明正文未打包及正式库路径的导航页。清单记录历史资源的代次、路径与哈希并标记不可发布；这些内容供预览参考，不作为论文发布资源。未登记或校验失败的依赖明确报错。

`knowledgeRegistry` 每项含已有 `path` 以及可用的 id/canonical_key/title/aliases/language；兼容旧节点时 Controller 将 measure_id 等已有身份映射到 canonical_key。渲染优先匹配稳定身份，再按精确名称、去空格和统一标点大小写后的名称、英文名及已登记别名分层比对。唯一确定性命中复用已提交路径并增补；发布时匹配目标变化经现有变基入口重新渲染，保存身份映射与对应链接变化证明。当前登记中的别名才参与正式复用，未提交别名草稿与批内计划新建名称只提供提示。

近似或多目标命中与本地 BM25 结果合并为候选对。主会话读取两页定义，记录“合并／保留并互相链接／保留”的建议及理由，不另派模型任务。未确认建议保留为草稿，本篇按可用的新建路径发布；文件路径冲突仍需具体处理，不能覆盖另一节点。存量合并通过精确批准的维护事务更新正文、入链、别名和登记；被合并页的删除另行批准。自包含样例需提供目标的候选快照或节选，保持链接可解析。

新阅读冻结 `note_layout:'source-language-1.0'`，按实际 `sourceLanguage` 将原文同语言稿放 `Wiki/sources/`，另一语言稿放 `Wiki/translations/`。例如英文原文的英文稿留在 sources、中文稿进入 translations；中文原文则相反。文件名、论文身份、互链与知识反链沿用。方法与概念保持 `Wiki/methods/`、`Wiki/concepts/`。profile 为 `reading-first-obsidian-1.0`，管理 source/reading/resources 三个区域以保持完整段落顺序；沿用原 managed merge，保留其他正文、属性和个人笔记。旧12区段 profile 不自动转换。

## 第06篇及验收

第06篇复用已完成科学产物、r2 讲解和登记来源，在新有限执行窗口内由两位 Writer 修订阅读呈现，再交现有 Verifier。新输出单独绑定版本；原 run、原科学记录和已关闭的预算不变。原机械适配样例只是历史呈现产物，不作为这次 Writer 交付的替代。最终入口仍在该任务 `obsidian-preview/阅读入口.md`，内部记录不另交纯文字稿。
以上为 r3 历史路线。用户实际阅读后指出层级、编号、跳转、方法目录和重点呈现不足；r3 文字审查不能替代原生验收。后续独立获批窗口复用已接收两语稿，只运行阅读呈现编辑和最终页面审查，保持原科学输出和旧窗口关闭状态。该次最多4次（当时另设的60分钟期限现已不再执行）的授权仅属于第06篇该窗口，不成为所有运行的默认预算。
未来新运行仍在完整页面生成后做一次整体审查，必要时最多一次局部复核。缺少必要模块、重要表格不可读或必要导航不可达属于实质性交付问题；一般文风偏好不触发反复审查。候选导出的链接检查不能代替阅读或科学审查；未经实际 Obsidian 观察，native 状态仍为 not_run。仅修改呈现不重跑六个科学角色。新发现的实质缺口按既有定向补缺规则交回对应角色。

全局目录保留模块与章节两级，细分主题及完整方法条目留在对应模块，避免重复展开拖长阅读入口。首轮已报告的轻微布局或导航问题，如果确需在当前授权内修正，可用 `createReadingFirstReviewRequest({controller,presentation,renderRepair:true})` 对变化后的页面申请原有一次局部复核；要求 editor 模式、首轮已完成、新页面指纹不同，沿用原 Writer/Editor 输出和预算，不重跑呈现编辑、不改变问题严重度。未修订的科学内容采用首轮记录。
