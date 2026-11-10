# 最新阅读结果的 V3 发布

最新 APA 阅读结果沿用 `reading-first-obsidian-1.0` 的笔记结构，接入既有 V3 发布事务。正文、Reading Editor 的布局、双语共享知识和登记资源一起进入发布审阅，不转换为另一套 Writer 或 reader-note 输出，也不追加科学角色或模型审查。

## 从阅读完成到发布审阅

Controller 保留已接受整体审查所对应的原 `presentation` 对象，以及真实原文语言 Writer、Translation、适用时的 Reading Editor 和 Verifier 的 owned 回执。`reading_complete` 表示可以准备发布审阅；阅读候选本身的 `publishable:false` 不授予写入正式库的权限。实质问题未解决、缺少关键审查或内容已改变的结果不能进入发布准备。

```js
import { captureReadingFirstPublicationSource } from '../../scripts/v3/reading-first-runtime.mjs';
import { prepareReadingFirstPublication } from '../../scripts/v3/reading-first-publication.mjs';
import { registerBilingualPublication } from '../../scripts/v3/phase22-publication.mjs';

// controller 与 presentation 来自本次已接受的真实阅读运行。
const source = await captureReadingFirstPublicationSource({ controller, presentation });
const prepared = await prepareReadingFirstPublication({
  source,
  vaultRoot,
  generation,
  evidenceMode: 'actual',
  resources,
});
const registration = await registerBilingualPublication({
  vaultRoot,
  run: prepared.plan.run_id,
  plan: prepared.plan,
  sourceInputs: prepared.sourceInputs,
});
```

这里的 `resources` 是 `{path, source_path, sha256, byte_length}` 数组：`path` 为笔记使用的库内相对路径，`source_path` 指向已登记源文件，哈希带 `sha256:` 前缀。新运行的主文和补充材料必须位于 `Clippings/`，绝对 `source_path` 对应这份原件；图片位于所指派的 `Figures/<run_id>/`，`Raw/` 只接收已接受补缺记录中实际采用的 AI 追溯文献。资源集合覆盖审阅候选的 `assetPaths`、图表的原始父资源及实际采用的补缺文献。Clippings 原件沿既有 `asset` 对象登记，目标已存在且同字节时不再写入。PDF、图片均须保留来源与指纹；资源缺失、字节变化或目标处存在不同的原始文件时，先修正具体绑定。目录扫描仅用于同文献与来源漂移提示，不授予未登记文件发布资格。合成测试使用 `evidenceMode:'synthetic'` 及系统临时库，不能写入生产知识库。

图表也可来自 Integrator 的真实 owned 输出：若其已审查 `visual_resources` 精确登记了图表路径、SHA-256、字节数以及父 PDF 的 `source_id`、`source_path`、`source_sha256`，发布接口会核对这些冻结字段与当前资源、登记 PDF 的对应关系。仅在临时目录找到图片或调用方另给一个哈希仍不足以入库；原候选和原审查不因此改写。

`reading-editor-1.4` 生成的两语研究导图是 `research-map-canvas` 展示资产，分别位于 `Figures/<run_id>/research-map.zh-CN.canvas` 和 `Figures/<run_id>/research-map.en.canvas`。发布入口使用已审视图、登记导图和编辑论证重算画布，要求与候选字节一致。两份文件按路径、字节数与 SHA-256 纳入精确清单、展示清单、对象登记和写后核验，沿渲染产物路径校验。默认图谱的筛选范围继续由已登记笔记决定。

既有 owned Integrator 使用 `resource_handoff.asset_mapping` 时，发布消费者也可直接读取该登记：`target_path` 对应图表目标，`source_path` 为源图片的绝对路径，`source_id`、`source_pdf_sha256` 对应原登记父 PDF，`sha256`、`byte_length` 对应图片字节。接口继续核对唯一匹配、实际源图片路径、父 PDF、候选图目录及字节；原 owned 产物、候选和审查保持原样。顶层 `visual_resources` 已存在时保留原消费路径。

owned Integrator 使用 `visual_handoff.registered_resources` 时，消费者读取 `path`、图片绝对 `source_path`、图片 `sha256` 和 `byte_length`。父资源可由 `source_pdf` 与 `source_sha256`，或 `source_docx` 与 `source_docx_sha256` 精确指定；父哈希支持带 `sha256:` 前缀或64位十六进制。父路径必须为绝对路径，并与本次科学输入中唯一已登记来源的路径和哈希一致；显式 `source_id` 也须一致，缺省时只从该唯一匹配解析。新策略的原始父资源必须在 `resources` 中唯一绑定到 `Clippings/` 原件，且当前字节仍与登记一致；旧冻结来源仍可按原路径读取。DOCX 补图的来源继续绑定原 DOCX，单独的展示 PDF 必须具有自己的有效来源登记；已有原图登记和临时展示文件均不会自动授予该 PDF 发布资格。

用户明确批准既有派生展示 PDF 的精确登记候选后，可向 `prepareReadingFirstPublication` 传入 `presentationAssetRegistrations`。每项为批准记录文件的 `{path, sha256, byte_length}`，路径为绝对路径。记录使用 `schema_version:'reading-first-presentation-asset-approval-1.0'`，包含实际 `authorization_id`、`user_reply`、`run_id`、已审 `presentation_fingerprint`、获批候选文件的 `approved_candidate:{path,sha256,byte_length}`、`resource:{path,source_path,sha256,byte_length}` 和 `scientific_parent:{source_id,path,sha256}`。获批候选须保存相同的 run_id、resource 和 scientific_parent。来源身份仍由原科学输入校验，PDF 必须是已审导航中的已登记目标；新策略使用 Clippings 原件，原始父文件也须在精确清单中。

接口读取并核对批准记录及候选原字节，将登记事实写入对应审阅资源的 `presentation_asset_registration` 和发布依赖哈希；两份记录文件纳入现有来源指纹及文件身份校验，并随 Controller 签名登记保留。记录变化会阻止后续注册或重载。该参数仅消费已有明确来源登记授权，不能代替用户决定；原科学输入、Writer、Editor、科学审查及其指纹保持。已审候选获发布指令后，正式发布使用本轮清单及两个精确哈希登记批准。未传此参数的旧调用保留原行为。

准备阶段校验原审查、文件与人工区域，列出本次批准的文件及目标，并生成必要登记与索引。新注册保存签名清单和本次输出的独立文件；这些文件用于直接完成或恢复本次复制，不包含上一代全库副本或整包重建配方。注册阶段不执行正式笔记写入。保留返回的 Controller trust anchor，跨进程读取时通过现有 `trustAnchor` 参数或 `APA_V3_PUBLICATION_TRUST_ANCHOR` 传递，不从待验证的注册文件自取信任锚。

已审查候选若复用了带 V2 元数据的既有共享节点，默认仍拒绝发布。用户明确批准这些具体节点的迁移后，可向准备接口传入 `knowledgeMetadataMigrations`，每项必须精确给出 `{path, before_sha256, candidate_sha256, output_sha256}`。适配仅把 YAML 头中的 `pipeline_version: 2.0.0` 改为字符串 `"3.0"`、`graph_scope: v2-canonical` 改为 `v3-candidate`；正文、原候选及科学审查指纹保持原样。原文件、已审查候选、转换输出三组字节都必须命中；转换记录进入发布写入清单和批准哈希，并在注册重载时重新验证。此参数本身不授予发布权限，也不允许迁移其他旧结果、改正文或跳过 V3 校验。

已完成阅读运行可以在模型调用窗口关闭后只读准备发布；这不续期模型预算。新注册重载校验 Controller 签名、批准清单、逐文件内容及实际依赖，直接使用已批准输出，不重新构建整套审查或渲染结果。旧格式登记继续沿原读取合同处理；任意手写 JSON 或修改后的 Markdown 不能自行取得发布资格。

会话入口的 `complete` 动作返回已审候选的 `publication_source`，可直接交给上述准备接口。恢复完成态时，先通过原资源重新渲染并核对已有候选与已审指纹。使用外部已审候选接口 `prepareExternalReviewedReadingFirstPublication` 时，Editor 1.4 产物须传入实际冻结的 `readingFirstBinding`。接口及恢复路径核对输入、Editor 版本和提示文件；历史版本按原合同读取。

## 并行阅读的共享节点变基

每篇论文使用独立会话及 `runId`。前一篇发布后，后一篇基于最新代次准备发布清单。如果共享节点在原候选渲染后变化，一次发布入口保留 `complete` 返回的原 `publication_source`，调用既有受控派生入口：

```js
import { deriveRebasedReadingFirstPublicationSource } from '../../scripts/v3/reading-first-publication.mjs';

const rebased = await deriveRebasedReadingFirstPublicationSource({ source, vaultRoot });
const effectiveSource = rebased.status === 'rebased' ? rebased.source : source;
const prepared = await prepareReadingFirstPublication({
  source: effectiveSource, vaultRoot, generation, evidenceMode: 'actual', resources,
});
```

入口使用当前已登记节点重新渲染，要求论文科学正文、未受影响节点不变，并保留受影响节点当前全部可见正文。确定性身份映射可改变共享页目标及其直接对应的论文链接目标；其他论文文本保持原字节。只允许替换内嵌知识状态及追加本篇已接受的内容；原候选新建与复用节点分别提取本篇段落、章节、公式、来源和别名进行确定性比较。重复段落的省略、身份映射及链接变化进入变基记录。该过程不派发模型、不增加审查轮次，也不改变调用账本。

外部宿主使用 `prepareExternalReviewedReadingFirstPublication` 时，可传入原候选的 `rendering:{targetRegistry,existingTargets,knowledgeRegistry}`；未传时按空登记渲染。接口从 owned 回执读取原 views 与 Editor，核对重算结果与原候选完全一致，再保存渲染输入。已有节点复用时须提供原登记内容，不能使用发布时的新正文代替原渲染底稿。

原来源、原候选、原审查和候选目录保持原样。变基来源在原配方上附加 `knowledge_rebase`，绑定新的渲染底稿、候选和变基指纹。一次发布入口将记录及差异保存到 `Eval/apa-v3/runs/<run>/publication/`。与原批准相比，只允许代次标识、保留当前正文的共享节点增补、确定性身份映射直接产生的目标及链接变化，以及必要的展示登记和索引变化，论文科学正文保持不变；规则通过后生成派生批准并直接写入，写入后报告受影响文件、新旧哈希及差异路径。其他变化先生成具体审阅，等待重新批准。后续目标再次变化时仍从同一冻结原来源重新派生，变基来源不叠加派生。

原来复用的目标缺失且无有效登记映射、论文出现身份映射范围以外的变化、本篇内容不满足保留规则或当前可见正文无法保留时，入口拒绝变基并给出具体错误。不要手改候选或配方绕过校验。

变基注册在现行逐文件签名清单中额外保存本篇原来源及变基段。跨进程加载先验证原来源，再使用记录中的底稿重算变基候选，并与签名输出核对。重算不依赖后来变化的正式节点；正式写入前仍校验实际目标。普通注册继续沿用现行输出加载方式。

**队列与批量批准**

发布队列保存批准顺序、每篇原候选身份和原始精确清单、实际授权原话、事务身份及完成核验。用户对整批已审候选回复“全部发布”后，队列逐篇调用一次发布入口；写入始终串行。排到某篇时重新读取最新代次，执行确定性身份匹配、必要变基和 dry-run，再按上述差异范围判断。允许变化形成关联原批准的派生记录，写入后逐篇报告；其他变化保持待批准状态。

单篇发布使用相同队列。批准请求先保存在各篇运行的 `publication/`，再等待队列消费锁；取得锁后入队，并由本会话消费已有未完成条目和新条目。前一个消费者结束后，后来的会话自行接手。存活进程持有全库发布锁时，条目保持 `queued`，每 5 至 10 秒检查一次，按分钟报告事务 ID、进程号和等待时长，不设总等待时限。占用不会写成 `awaiting_reapproval`，也不消耗批准。未知持有者仍停止并报告，已退出持有者沿既有失效锁流程处理。

每次尝试在最新代次上完成 dry-run 后生成新的 15 分钟维护窗口；排队等待不预先消耗窗口。竞争失败后的重试重新准备窗口，变基超出批准范围和实际 dry-run 错误仍保留具体诊断并等待重新批准。官方入口无法处理的输入须返回明确错误，主会话停止并报告，不编写临时发布驱动绕过。

后序候选的提前 dry-run 使用最新代次加前序候选的投影。投影只作提前检查，实际写入仍再次核对当前代次和目标。中断恢复从真实 owned 会话取得已审来源，并核对已保存事务和结果；已提交且核验完成的项目跳过，登记过但尚未完成的事务使用既有恢复入口。

恢复时始终核对真实事务日志、原签名、批准与库根，结果文件本身不构成提交证明。尚未提交事务的维护窗口到期后，只有原批准允许恢复时，才派生绑定原事务 ID 的 15 分钟恢复窗口；该窗口不能用于 apply。恢复回滚后重新读取候选及当前代次，继续沿原队列批准范围准备。已经提交的事务补齐核验及回收记录后记为完成，崩溃留下的活跃运行引用继续按任务 8 的限定范围回收。

队列保存在所选库的 `.runtime/apa-publication-queue/`。接口位于 `scripts/v3/reading-first-publication-queue.mjs`，命令入口为同目录的 `reading-first-publication-queue-cli.mjs`。`entries.json` 是按用户选定顺序排列的数组，每项包含 `run`、`runRoot`、`resources`，可指定 `generation`、已有的 `presentationAssetRegistrations` 和 `user_corrections`。`resources` 沿用单篇发布格式。准备返回原始清单、前序投影检查和完整 proposal 指纹，批准参数绑定该指纹。运行根可以是正式会话入口可恢复的派生运行；未支持的运行状态或缺失的真实产物仍以具体错误报告。

```powershell
node scripts/v3/reading-first-publication-queue-cli.mjs prepare --vault-root <vault-root> --entries <entries.json>
node scripts/v3/reading-first-publication-queue-cli.mjs approve --vault-root <vault-root> --proposal <prepare-output.json> --proposal-sha256 <proposal-sha256> --authorization-id <authorization-id> --user-reply "全部发布"
node scripts/v3/reading-first-publication-queue-cli.mjs drain --vault-root <vault-root>
node scripts/v3/reading-first-publication-queue-cli.mjs status --vault-root <vault-root>
```

`prepare` 准备精确清单，`approve` 先保存批准、等待锁后入队并消费，`drain` 用于恢复已有队列。用户已经明确要求“全部发布”时，助手在同一轮保存 prepare 的实际输出、展示摘要并绑定原话，不为相同范围追加确认。异常项目保留具体诊断；修订候选或超出允许差异后需要新的批准。

**用户指定的单点更正**

发布输入可带 `user_corrections` 数组，每项保存 `path`、`before`、`after`、`source_location` 和 `user_reply`。主会话先对照原文页码、图表或公式位置确认更正，再把每项替换展示在批准清单中。两语稿分别列出；`before` 必须在对应候选笔记中唯一匹配，可包含定位所需的短上下文。实际差异只允许一个数值、符号、系数、单位或方向词，段落论证、导图和导航结构的调整继续走 `user-revision`。

更正随同一次批准事务写入，并与原审查记录一同保存在运行的 `publication/`。原审查记录保持原字节，不增加模型调用或复核轮次。未解决实质问题的 `completed_with_limits` 运行仍先使用 `inspect-continuation`、`authorize-continuation` 续接，完成既定修订与获批局部复核后再发布。

**共享页合并维护**

发布前的唯一精确、规范化名称、英文名和已登记别名命中可确定性复用。近似或多目标匹配与本地 BM25 候选合并，发布入口在该运行的 publication 目录保存定义对照草稿。主会话在发布当轮读取两页定义，保存合并、互链或保留建议及理由，并将待决建议告知用户。建议草稿不授权修改已有页，未确认时保留待决项并继续正常发布。

已审候选原先唯一复用的目标后来变成多目标时，准备入口保留科学正文，生成带安全后缀的新建页精确清单、对应链接改写证明和待决定义对照，并标记 `review_required:true`。原批准不能自动覆盖这项变化；重新批准该精确清单后才写入，两个既有目标均保留。若新建路径又被占用，则报告冲突并保留当前文件。

存量共享页合并的精确清单涵盖留存页增补、已登记正文的链接改指、别名登记、受影响展示清单及代次和索引。维护入口读取被合并页当前已登记的可见正文，保留定义、限定、公式、来源和论文应用链接。锚点重名时，入口为复制的锚点追加可区分的名称，并同步改指链接。被合并页退出当前登记后仍保留磁盘原文件，含原有人工区；删除须另行批准精确清理计划。原事务前像可用于准备补偿事务，经精确批准提交为新代次。

**维护事务入口**

为每次路径迁移、共享页合并、合并补偿或研究导图更新选择独立的运行 ID，并显式传入目标库根目录。

```powershell
node scripts/v3/bilingual.mjs maintenance-review --vault-root <vault-root> --run <run-id> --mode <relocate|merge|compensate|map-refresh> --options <options.json>
node scripts/v3/bilingual.mjs maintenance-apply --vault-root <vault-root> --run <run-id> --inventory-sha256 <inventory-sha256> --authorization-id <authorization-id> --user-reply "批准"
```

`options.json` 可指定 `generation`，默认使用运行 ID。其余字段随模式变化：

| 模式 | 结构化选项 |
| --- | --- |
| `relocate` | `papers` 为 `{paperId, sourceLanguage}` 数组。`assetMappings` 为 `{old_path, new_path, sha256, byte_length, source_id?}` 数组。可用 `assetRetirements` 指定退出登记的 `{path, sha256, byte_length}`，或用 `restoreAssetRetirements` 列出恢复登记的路径。 |
| `merge` | `merges` 为 `{keep_path, remove_paths, aliases?, anchors?, expected_inputs?}` 数组。`anchors` 按被合并页路径给出旧锚点到留存页锚点的映射。`expected_inputs` 为 `{path, sha256, byte_length}` 数组，可固定所选页面版本。 |
| `compensate` | `transactionId` 为原合并事务 ID。原合并已被后续代次替代时，`trustAnchor` 使用原控制器提供并单独保存的公钥信任锚。路径迁移的反向操作沿用 `relocate` 及明确的反向映射。 |
| `map-refresh` | `papers` 为 `{paperId, map, argument, primaryFindingIds, sectionTitles, noteWordingEdits?}` 数组。`map` 来自已登记步骤、发现与关系；`argument` 按 1.4 合同依据已有双语正文整理；`sectionTitles` 按 `en`、`zh-CN` 提供小节 ID 到笔记实际标题的映射。可选的 `noteWordingEdits` 按语言给出 `{before, after}` 完整段落，只用于明确获批的导图展示措辞调整，逐段前后文本随清单核对。 |

导图维护在获批双语笔记的模块 2 开头放置“2.1 研究导图”或“2.1 Research map”，并在论文原 `run_id` 的 Figures 目录新增两份画布。旧稿的导图附在研究设计概览后时，设计小节顺延编号，同步本篇目录、局部链接和 Canvas 标题目标；已有独立导图小节的旧稿保留原编号。事务同时更新展示清单、托管区哈希、对象登记和索引，保留科学正文及人工区。写后核对当前代次和两份画布指纹，再检查索引与图谱。历史论文沿现有材料制作导图，无需续接阅读。

已有两语 Canvas 时，同一维护入口按登记路径和前像哈希更新画布，替换展示资产条目，保留其余资源及正文。展示措辞修改限定于导图及紧接的设计首节，必须匹配唯一完整段落；逐段对照确认研究步骤顺序、科学内容、数值和引用保持原样。无法剥离的措辞保留并报告。

Canvas 卡片以完整库内路径 `[[Wiki/translations/笔记名#小节标题|文字]]` 链接正文，目标包含实际语言目录，避免候选副本或旧页同名造成歧义。当前 `relocate` 入口按语言调整目录并保留文件名，同一事务同步重写已登记 Canvas 的链接和文件卡片，更新画布前像、展示资产的哈希与字节数、对象登记和索引；旧页继续保留。已有相对链接按画布所在目录重算，短名引用只在已登记目标可唯一确定时迁移。需要分轨的论点关系使用有文字的关系标签卡，每张连接一个起点与一个终点。

审阅命令在 `Eval/apa-v3/runs/<run-id>/publication/candidate/` 保存精确清单、审阅和用于重建的选项。检查 `INVENTORY.md` 中的新建、覆盖、删除数与路径，以及 `review_hash` 和 `output_inventory_hash`。用户对这份清单明确批准后，把 `INVENTORY.json` 的 SHA-256、批准 ID 和用户原话传给执行命令；原话以“批准”“确认”或“同意”开头即可，问句不作为批准。执行入口在同一进程重建审阅并试算，清单内容或哈希发生变化时停止。核对通过后，入口保存批准和固定 15 分钟维护窗口，登记、执行，并在 `publication/` 下保存 `RESULT.md` 和 `VERIFICATION.json`。

执行入口在写入事务前向 stderr 发出 `maintenance-registered` 事件，包含事务 ID 和公钥信任锚。把这两项与可信调用记录一并保存。中断时用原信任锚设置 `APA_V3_PUBLICATION_TRUST_ANCHOR`，并运行既有 `bilingual.mjs recover --vault-root <vault-root> --run <run-id> --transaction-id <transaction-id>`。恢复按现有事务状态核验已提交结果或回滚前像。需要再次执行时，先核对恢复结果，再用新运行 ID 准备清单及取得新批准。

## 审阅、批准与事务

新配置化运行冻结 `current-shared-nodes-1.0`。发布准备保留无关正式笔记的当前修改，仅对实际读取依赖及写入目标绑定指纹；共享节点增补保留当前正文。复用节点在候选渲染后发生变化时，由受控变基保留当前正文后重新 dry-run；批准后发生的允许差异沿派生批准写入并报告。只为实际覆盖的目标保存原文件；原文件的个人区继续保留，人工修改内容不会取得旧科学审查的含义。旧冻结记录及已有历史来源仍可沿原合同读取。

审阅返回的完整文件清单、`review_hash` 与 `output_inventory_hash`。共享知识的新建和增补、原始资源的新增，以及保留的人工内容都应能在这份清单中核对。已存在的知识节点沿用稳定身份和路径，两语论文共用同一节点。

用户对已审候选回复“发布”，即批准本轮由该候选生成的精确清单。`publishReadingFirstCandidate` 先准备并 dry-run，通过 `onPrepared` 展示新建、增补、覆盖的文件数、目标路径及两个哈希，然后在同一轮登记批准并执行受控事务。批准记录保留用户原话、`authorization_id`、`review_hash`、`output_inventory_hash` 和清单路径，维护窗口固定为 15 分钟。底层校验同时拒绝超过 60 分钟的窗口。

```js
import { publishReadingFirstCandidate } from '../../scripts/v3/reading-first-publish.mjs';

const result = await publishReadingFirstCandidate({
  source, vaultRoot, generation, resources, evidenceMode: 'actual',
  authorization: { authorization_id: authorizationId, user_reply: userReply },
  onPrepared: async summary => showPublicationSummary(summary),
});
```

允许本篇论文笔记、经当前正文与人工内容保留核验的共享页增补、新增资产，以及必要的展示清单和代次登记文件。本篇笔记被人工修改、出现额外覆盖或删除、变基不能保留当前正文、差异超出允许规则或 dry-run 失败时，入口只保留具体审阅和诊断，正式库零写入。

原批准、维护窗口、清单、派生批准、变基差异、`RESULT.md` 与 `VERIFICATION.json` 均写入 `Eval/apa-v3/runs/<run>/publication/`。已有成功清单后重建时，派生批准绑定原批准文件及原、新两组哈希和变基记录。若首次准备因共享页漂移而失败，尚不存在旧发布审阅哈希；入口先保存原来源、原候选及科学审查指纹，再对首个实际成功生成的清单登记批准。

实际写入继续调用 `registerBilingualPublication`、`applyBilingualPublication` 与 `recoverBilingualPublication`。原有两步 API 和 CLI 保持兼容；没有发布授权时，`review` 和 `dry-run` 可用于检查，`apply` 拒绝执行。发布命令只读取已完成的 owned 会话来取得真实已审来源，不派发论文角色，不接受任意 JSON 冒充已审 source。

```powershell
node scripts/v3/bilingual.mjs review --vault-root <vault-root> --run <run> --profile reading-first-obsidian-1.0
node scripts/v3/bilingual.mjs dry-run --vault-root <vault-root> --run <run> --profile reading-first-obsidian-1.0
node scripts/v3/bilingual.mjs publish --vault-root <vault-root> --run <run> --run-root <owned-run-root> --generation <generation> --resources <resources.json> --authorization-id <authorization-id> --user-reply "发布"
```

具体批准字段及恢复参数以[一次发布入口](../../scripts/v3/reading-first-publish.mjs)、[发布 API](../../scripts/v3/phase22-publication.mjs) 与 [CLI](../../scripts/v3/bilingual.mjs) 为准。`publish` 向 stderr 展示摘要，向 stdout 输出最终 JSON。更换来源或改动论文科学内容须重新批准；共享正文和代次变化按上述规则生成派生批准，原回执保持不变。

**来源位置与副本处理**

新配置冻结 `configured_setup.source_policy:'clippings-originals-1.0'`，科学来源保存 `Clippings/` 原件的绝对路径，笔记与清单使用库内相对路径。目录外输入在准备阶段复制到 `Clippings/`，保留原文件名；同名不同字节时停止并报告冲突。配置保存本身不复制文献。已有冻结记录保持原路径和指纹。

新运行准备和每次发布检查 `Raw/` 与 `Clippings/` 的同文献线索。同字节匹配可用于确定性改指本篇链接，并绑定路径、SHA-256 和字节数；原已审科学正文及回执保持原样。只有 DOI、题名或文件名相近而字节不同的结果保留为待确认提示。其他已提交论文的引用改指先准备独立迁移清单，经批准的事务执行；旧 Raw 副本单列清理候选，发布入口不删除文件。

已登记的 Clippings 来源是长期资产。缺失或字节变化时，发布提前报告登记路径、登记哈希、当前状态、同字节候选位置及迁移入口。恢复位置必须通过库路径迁移更新登记和链接，不能只改某篇笔记绕过资产校验。迁移后的 `path_migration.assets` 保存旧路径、新路径、SHA-256、字节数及来源身份，引用修正据此核对冻结图目录与当前位置；旧图目录、旧展示清单和运行记录保留原字节。

发布结果列出本次新存入 Raw 的已采用 AI 补充文献，包括路径、题名、DOI（未取得时为 null）、追溯原因及引用笔记。未被已接受补缺记录采用的来源不能获得 Raw 写入权限。

## 发布后的索引与图谱

事务成功后，`.apa-v3/phase22/COMMITTED.json` 选择新登记代次。默认检索读取登记笔记的当前 Markdown，在内存中刷新索引，命中链接落到当前标题或块并携带内容指纹；直接编辑正文后，下一次查询即可使用。原发布索引保留历史含义。默认图谱收录已登记论文唯一的 `Wiki/sources/` 原文语言入口及共享节点，排除 `Wiki/translations/` 译文；连接关系由 Obsidian 读取当前 Markdown。历史两语均在 sources 的布局保留中文入口。新增一篇论文或增补同一个知识节点时，其他已提交论文及人工修改继续保留。

新文件只放入 `Wiki/`、只改 `status` 或版本字段，均不建立登记身份。未提交候选不进入默认检索和图谱。已登记正文可直接编辑，个人笔记专用区保持原有检索排除范围；原文来源身份或实际写入目标出现冲突时报告具体对象。

阅读内容审查、发布事务与 Obsidian 原生显示检查分别记录。没有真实原生观察时仍为 `not_run`，发布不会将其改成通过；已接受的普通限制也不会因此消失。

### 图谱自动同步

在用户选定的库执行 `npm run obsidian:graph:sync -- --vault-root "<vault-root>"`，将图谱切换到当前已提交节点，并为该库启用后续自动同步。每次正式提交成功或已提交事务恢复后，发布器从重新校验的 COMMITTED 代次生成精确路径筛选，更新 `.obsidian/graph.json` 中的 `search`、`hideUnresolved` 和 `showOrphans`。原文语言入口、共享节点和专题纳入图谱，译文和未提交内容继续排除。

本库启用状态保存在 `.apa-v3/phase22/graph/MANAGED.json`，不进入公共导出；未启用的库保留原有行为。每次改写前，原配置按内容哈希保存在同目录的 `backups/` 中，颜色、布局、缩放等其余字段保留。若用户改过受管理的筛选字段，发布结果中的 `graph_sync.status` 为 `custom_filter_preserved`，自动同步保留该修改；再次显式执行 sync 可恢复自动管理。派生图谱同步失败时返回 `retryable` 等具体状态，已经提交的论文保持提交成功。

已打开的 Obsidian 图谱可能仍持有内存中的旧筛选；关闭并重新打开图谱标签页后会读取新配置。自动同步更新磁盘清单，发布结果和 `obsidian:graph:check` 不冒充原生界面检查。图谱已打开且用户要求展示时，应重开图谱并核对实际筛选。

## 已提交笔记的路径整理

新运行按原文语言分放：`Wiki/sources/` 保存原文同语言稿，`Wiki/translations/` 保存另一语言稿。

已提交 reading-first 笔记可在明确授权后使用 `buildNoteRelocationReview({vaultRoot, runId, generation, papers:[{paperId, sourceLanguage}]})`。该适配只接受当前有效提交，确定性改写链接目标、两语路径及相应清单/索引，不接受调用方正文或新的科学批准；`phase22-note-relocation-1.0` 审查与每篇manifest的 `path_migration` 明确记录其来源。科学依赖和原接受回执保留，不能把整理结果称为重新阅读或新的语言生产。

将此owned review交给既有 `dryRunBilingualPublication`，按具体清单与两个哈希形成批准及维护窗口，然后调用 `applyBilingualPublication`。本路径不重放旧语言运行、不使用旧注册重新签发阅读资格；它使用当前Controller的内存计划，执行前保存 `prepareBilingualPublicationTrustAnchor` 返回的公钥信任锚。中断时沿用 `recoverBilingualPublication` 的磁盘日志、精确批准与该信任锚。尚未开始或回滚后重新准备仍需核对同一明确授权范围。

新提交按批准清单逐文件写入，仅备份实际覆盖的目标；停止自动复制上一代次的完整知识库。旧可见路径仍须按迁移清单单独处理。只有确认新代次、原文及必要恢复文件有效后，才按精确旧路径/哈希清单将已退出当前代次的旧文件移到本次获批恢复目录。遇旧文件变化或目标占用时停止该项，不能覆盖人工修改。最后同步已获批图谱筛选并检查两语导航、知识反链与检索结果。普通查询和候选渲染均不执行迁移。

## 用户修订与候选一致性

通过会话的 `inspect-candidate` 核对已渲染版本的链接及逐文件指纹，任一检查失败都会阻断整体通过。用户修改经 `user-revision` 交给负责角色。涉及科学内容时，使用现有额度内或获批追加的局部复核绑定新候选；非科学修改使用原审查指纹、用户修订请求、角色回执及确定性检查记录，依次验证范围、对应文本的事实标记、链接、双语镜像和候选字节。链条缺失或指纹不连续时返回 `READING_FIRST_PUBLICATION_REVIEW_CHANGED`。准备、注册和正式发布继续使用现有的精确批准流程。

采用他运行的科学产物时，首次派发 Writer 前已校验原 Integrator 所属运行的资源清单。发布时仍核验清单回执与实际图片字节，保留旧的三种资源声明入口。
