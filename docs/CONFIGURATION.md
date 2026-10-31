# APA 本库配置

README 负责安装、使用和更新说明；`academic-paper-analysis` 负责论文阅读，独立的 [apa-query 技能](../.agents/skills/apa-query/SKILL.md)负责库内查询与专题操作，`apa-setup` 管理本库配置；独立公开导出生成无个人资料的工程目录。

## 用户选择与应用边界

首次获取项目，必须先由用户指定或明确确认项目文件夹的绝对路径，之后才可克隆、解压、安装或写入配置。当前会话目录及其子目录不能默认采用；建议用户将所选文件夹设为 agent 工作目录。用户同意后使用项目 `.agents/skills/` 中随仓库提供的三个 APA 技能，默认不安装全局技能，已有全局副本保留。若用户不采用该工作目录或不将技能迁入项目作用域，须说明技能发现和规则作用范围可能变化，保留全局加载方式可能影响日常其他任务。已有工程也以用户明确选定的根目录为目标；同一会话已确认的目录无需重复询问。后续命令使用该目标，支持根目录参数时显式传入；下文 CLI 示例执行时须追加 `--repo-root "<用户确认的项目绝对路径>"`。

安装授权不等于配置选择授权。用户提出“完善配置”“为我配置”“为某某 agent 配置”等配置请求时，助手必须生成并打开本地 HTML，由用户自行选择宿主派发方式、模型与推理强度、输出目录、解析器位置、呈现方式和写作指导；查询偏好可明确选择暂不配置。无法打开时提供页面路径并等待用户自行打开和选择，不以会话问答替代页面。导出配置及挖空或去除配置不强制打开页面，去除范围仍须明确。“你决定”“全部按推荐”不能代替用户选择。

检测报告、推荐值、历史默认、示例和唯一可用选项均不属于用户答案；即使宿主只能跟随主会话，也须解释限制，等待用户选择采用或暂缓。未回答项保持未配置或原值，不为达到 `ready` 自动补齐。已保存且无需改变的配置不重新选择；拟修改或不兼容的字段须取得新的选择。普通只读查询沿用既有运行时默认，不自动把默认值保存成个人配置。

助手核对用户所选字段、项目绝对路径与前后差异，取得明确应用确认后才使用既有 CLI 保存并回读。用户自行提交完整操作并明确要求应用时，不重复询问已确定的目标及字段；未选择的字段仍不补入。禁止直接编辑个人答案绕过流程，或代操作页面制造用户选择。详细交互见 [apa-setup 技能](../.agents/skills/apa-setup/SKILL.md)。

配置格式、CLI 接口及指纹合同保持不变；格式和指纹校验不能证明用户授权，不增设可由助手自行填写的“用户已同意”标记。分别报告工程已获取、依赖已安装、用户配置已保存与运行条件已就绪；实际模型调用、PDF 解析和论文验收继续单独报告。

## 保存与冻结

阅读和查询共用唯一答案文件 `config/apa.local.json`，版本 `apa-local-config-1.0`，由 Git 忽略。没有全局继承，公开模板不带个人答案。空配置只有 schema_version；允许分步保存，新论文入口 `prepareConfiguredReading` 要求完整且所选依赖可用。

新运行冻结配置指纹、模型/强度、路径、解析器选择及写作指导内容/哈希。“跟随主会话”取创建时设置，不在运行中动态切换。旧任务从原检查点恢复，不重读个人配置替换绑定。

Controller 的新运行入口使用当前宿主实际提供的 `sessionContext: {model, effort}`（也接受 `reasoning_effort`），由 `prepareConfiguredReading` 冻结主会话。若同时提供 `mainSession` 且两者不一致，入口拒绝；保留原显式 `mainSession` API 的兼容性。科学角色显式选择 medium 并不表示主会话也是 medium。例如主会话 xhigh、科学角色显式 medium、Writer follow-main 时，Writer 应解析为 xhigh。

派遣前使用 `getConfiguredReadingDispatchArguments({prepared,request})`，将返回参数原样传给 `host_action_scope.action` 指定的工具。配置含 `host` 段时，新运行冻结该段，派发工具和参数名按其生成（例如 Claude Code 的 `Agent` 用 `model`、`effort`、`prompt`、`description`）；没有 `host` 段时保持 Codex 的 `collaboration.spawn_agent`，参数为 model、reasoning_effort、`fork_turns:'none'` 和任务正文。任务未收到正文时，先保留失败并定位传输，不改成全上下文继承，也不通过省略参数使用宿主默认值。

## 字段

| 字段 | 含义 |
| --- | --- |
| models.query | 可选知识库查询模型；未保存或移除时 follow-main，每次查询确定当前会话模型与推理强度 |
| query.answer_language | 默认回答语言：question（跟随问题）、zh-CN（中文）、en（英文）；未配置为 question |
| query.detail | 默认详略：adaptive（按问题需要）、concise（简明）、detailed（详细）；未配置为 adaptive |
| query.audience | 默认讲解对象：adaptive（按问题需要）、beginner（初学者）、researcher（研究人员）；未配置为 adaptive |
| host | 子代理派发方式：`{name, dispatch:{tool, model_argument, effort_argument, instruction_argument, task_name_argument, fresh_context}}`。只能采用 apa-setup 宿主档案中的检测结果；新运行冻结此段并按它生成派发参数。`model_argument` 为 null 表示派发工具不能选模型、子代理沿用主会话（此时 `effort_argument` 也为 null），各角色须为 follow-main，否则 `validation.conflicts` 列出冲突并阻止新运行 |
| models.science | 六科学角色共同模型/强度或 follow-main |
| models.overrides | 可覆盖 evidence、methods、results、interpretation、scientific-reading、integration |
| models.roles | english-writer、chinese-writer、translation、reading-editor、independent-verifier 分别选择；translation 把已接受的原文语言稿译成另一种语言，新阅读运行必填；暂不用 Editor 也保留设置 |
| paths.runs/parse/candidates | 本库内输出根目录，每次追加独立 run ID |
| parser.runtime_home | 已有 MinerU 环境 |
| parser.python/config_path | 可选显式路径；否则从运行目录派生 |
| reading.source_language | 旧字段，新阅读运行忽略；可缺省，已有的 en 或 zh-CN 值保留且合法。写作顺序由每篇论文的实际原文语言决定 |
| reading.presentation_mode | reading-editor 或 writer |
| writing_skills | 六技能各自明确 enabled；启用时提供 SKILL.md 路径 |

新配置阅读调用必须按实际主论文向 `prepareConfiguredReading` 显式传入 `sourceLanguage`（`en` 或 `zh-CN`）；原文语言属于每篇文献的事实，不从个人偏好推定。运行将其冻结为 `binding.source_language`，决定 `Wiki/sources/` 与 `Wiki/translations/` 的归属；新运行以同一 `sourceLanguage` 冻结 `first_writing_language`：只有原文语言对应的 Writer 接收科学材料，另一语言由 Translation 角色（`models.roles.translation`）依据已接受的原文稿翻译。旧绑定保留其原有顺序和 `source-first` 模式，不修改旧记录。

新配置化阅读冻结 `current-shared-nodes-1.0` 知识登记策略；候选物化核对提交配对与登记身份，共享节点使用当前正文并记录实际复用的路径与内容指纹，无关笔记编辑不阻断候选。查询与图谱读取已登记笔记的当前内容，发布只核验实际依赖与写入目标；旧绑定保留 `committed-generation-1.0`、`committed-shared-nodes-1.0` 等原策略。新配置化运行冻结 `configured-reading-2.1` 提示与实际文件指纹；使用 Reading Editor 时冻结 `reading-editor-1.3`：全部步骤绘入研究导图，发现可精选，图后链接省略发现，目录、方法条目与图注直接展开；既有绑定保留原策略和呈现版本。配置化预览包含所引用历史知识的当前正文，旧论文只提供标明路径的导航页；历史参考资源不授发布权。

宿主档案 `apa-host-profile-1.0`（结构见 `Schema/config/apa-config.schema.json` 的 `hostProfile`）由助手检测自身环境后写入本次独立的 `.tmp/apa-setup/<owner>/<detection-id>/host-profile.json`，`owner` 和 `detection-id` 使用 kebab-case，目录须未被占用；旧档案仍可读取，不迁移或覆盖。档案记录宿主名、当前会话、派发工具及参数名、派发工具可接受的模型与各自的推理强度档位，以及每项的来源；派发工具可选记录 `dispatch.result_handle`（`{source:'text', pattern}`，从派发结果文本提取任务句柄的正则，捕获组 1 为句柄），缺省时 APA 不提取句柄。`inspect`/`page` 加 `--host-profile <file>` 时，检查结果增加 `host_check`（派发方式是否一致、模型或强度是否与本宿主不符），页面的模型与强度选项也来自档案。档案是助手的自我报告，不证明派发或模型实际可用。

档案的可选 `capabilities` 提供六项能力的证据：按需读取、子代理排查、阶段手动压缩、短回执、科学阶段恢复与阈值自动压缩。运行代理依据当前真实工具定义、本机版本和帮助、无凭据配置及必要的官方文档调查，并为各项写可选 `achievement`：`state` 为 `achieved`、`needs-setting`、`needs-user-action`、`needs-apa-change` 或 `not-found`，另有 `summary` 和 `steps`；未找到时写出查询位置和缺口。每步包含 `actor`（`apa`、`script`、`user`）、`instruction`、`command`（字符串或 `null`）、`scope`（`current-session`、`new-session`、`instance`、`project-settings`、`user-settings`、`unknown`）、`persistent`、`verify`、`evidence`（`source` 与 `reference`）；可选 `adapter_id` 和 `range`。旧档案缺少该字段时提示重检。`achieved` 表示静态条件具备，实际验证保持 `not_run`；能力报告不改变 `ready`，也不能证明真实派发、模型遵守、压缩或续接成功。

`threshold_compaction` 的非空 `step.command` 必须同时包含 `<N>` 并提供 `range`，否则屏蔽该命令；`effective_target_verified` 为 `false` 时屏蔽该能力的命令。只读调查命令写入 `instruction`、`verify` 或 `evidence`，`step.command` 可为 `null`。`range` 的 `min`、`max` 为数值或 `null`，`unit` 为 `tokens`、`ratio` 或 `percent`，表示命令参数单位。页面使用用户输入的 token 候选值及已核实的公式换算，未知条件保留未知。检查实际启用的后端、覆盖目标、作用范围、计量口径和阈值约束；设置由用户选择，具体目标文件、键和值经预览确认后才能应用。所需设置工具应支持预览、确认、备份及回读，宿主设置备份放在 `config/backups/<owner>/`，仅更改用户选中的设置。

科学阶段恢复沿用 `dispatch.result_handle` 的文本正则提取规则，由代理依据真实结果确定格式；静态达成还须核对本库已保存的派发声明与本次检测一致、提取配置与派发结果匹配，记录查询工具及参数并确认原宿主可访问。尚未保存时报告需要配置，由用户选择并确认后再保存。控制器持久化自身状态，不主动查询或等待宿主；真实续接仍需单独验证。

每项能力可选 `investigation.searched`，按 `tool-schema`、`system-context`、`host-config`、`runtime-log`、`installed-software`、`local-code`、`host-docs` 七类来源各记一条 `{source, location, result, note}`（`result` 为 `found`、`absent` 或 `not-applicable`；前两者须有非空 `location`）。`inspect` 据此输出 `setup_issues`，每项含 `id`（`<category>:<kind>:<key>`）、`category`、`subject`、`summary`，类别依次为 `investigate`、`page-choice`、`authorize`、`known-limit`；未查完七类来源而状态未知或未找到的可选能力、以及缺少达成方式的可选能力归为 `known-limit`，保留具体缺口。配置页面可以先打开，用户选择进一步调查或暂缓高级能力；待安装或待授权事项在页面展示，实际操作仍须单独授权。传入的台账 `profile_sha256` 与档案文件字节的 SHA-256 不符时仍报 `APA_ISSUE_LEDGER_STALE`，退出且不写 HTML。台账 `apa-setup-issue-ledger-1.0`（结构见 schema 的 `issueLedger`）每条含 `id`、`disposition`（`deferred`、`declined`、`resolved-elsewhere`）、非空 `note` 与 `decided_by:'user'`，只记录用户的实际决定；台账中已不存在的问题条目被忽略。页面在“自检遗留问题”中分组展示其余问题；阈值卡片总是提供候选 token 输入，没有可用命令模板时只提示把数值交给助手用 `scripts/setup/apa-host-settings.mjs` 预览。

档案可选 `adapters` 数组，包含 `id`、`owner`、`host`、`root`、`entrypoints`、`evidence`。新补丁只能放在 `config/backups/<owner>/adapters/<id>/`，`owner` 为 agent 归属标识，`owner` 与 `id` 均为 kebab-case，依据身份及归属证据确定 `owner`，不从所选模型推断；入口为该目录内非空相对路径数组，说明记录所属 agent、宿主、入口、用途、证据和验证方法。再次自检时，代理先只读检查当前 owner 的既有档案与适配说明，并结合当前证据核对；有效自有补丁可继续复用，仅对变化和缺口继续调查，需要新补丁时建立独立目录避免碰撞。其他 agent、归属不明以及已有适配和脚本只读保留。公共 `inspect` 只检查本次传入档案所声明的补丁的宿主一致、归属结构、入口存在和路径范围，显示 `available` 或 `blocked`；它不自动发现或合并旧成果，也不执行入口或证明身份和实际效果。既有适配无需迁移，个人档案不自动重写；公共接口缺失时报告 `needs-apa-change`，不修改公共核心以完成自适配。补丁源码准备和启用、宿主设置写入分别处理。完整流程见 [apa-setup 技能](../.agents/skills/apa-setup/SKILL.md)。

显式模型对象为 `{mode:'explicit',model,reasoning_effort}`，所选模型在宿主上没有推理强度参数时省略 `reasoning_effort`；跟随主会话为 `{mode:'follow-main'}`。配置接受非空模型标识，不限定 GPT；实际派发须符合当前宿主支持的模型和参数组合。派发与回执能力依当前宿主档案及其适配确认。配置不是用量、来源或执行授权。

查询配置检查与 CLI 任务准备解析 `models.query` 和可选 `query` 回答偏好，不要求阅读角色、工作目录、MinerU 或写作指导，也不读取写作文件。`apa-query` 技能可按需要在同一回答任务中引用本库已启用且可读的写作指导，不增加模型调用；具体规则见[查询写作指导](../.agents/skills/apa-query/references/writing.md)。空答案仍可检索；未保存查询选择时按 follow-main 解析，不把默认值写入个人文件。显式查询组合必须由当前宿主提供 `supportedModelPairs` 确认；未知能力报 `APA_MODEL_AVAILABILITY_UNKNOWN`，不支持报 `APA_MODEL_UNSUPPORTED`，均不自动更换模型。follow-main 要求有效的当前会话组合；提供宿主能力列表时同样检查支持情况。配置结构错误仍会拒绝。新论文阅读继续要求原有完整配置和依赖，旧冻结绑定不变。

回答偏好的优先级为当次明确要求、已保存默认、内置默认。代理可在 `request` 的输入中传可选 `preferences:{answer_language,detail,audience}`，只覆盖本次任务；解析结果进入任务证据数据和输入指纹，不写回个人配置。`question` 的明确语言、详略和讲解对象要求仍优先。`adaptive` 表示依据问题需要判断，`beginner` 增加背景和缩写解释，`researcher` 保留必要专业细节；简明模式不删除会改变结论的条件或限制。专题更新只使用详略和讲解对象偏好，保持原专题语言；单纯保存已接受答案不自动翻译或改写。详见[查询配置](../.agents/skills/apa-query/references/configuration.md)。

明确保存专题时才读取并检查现有 `paths.candidates`，在该根目录的 `topics/<topic_id>/<operationId>/` 中准备候选。无需新增一套路径配置，也不要求 MinerU、科学角色模型或完整阅读依赖。路径缺失或不可用只阻断保存，普通只读查询仍沿原能力检查。保存已有答案不强制模型调用，不写回个人配置。

正式专题路径为 `Wiki/topics/<topic_id>.md`，只能经既有精确批准与受控事务写入；它不属于阅读双语的 `sources/translations` 规则。专题人工备注和原版本保留，公开工程导出只带实现、测试和空目录，不带个人专题或候选。

专题增量更新复用 `models.query`、详略与讲解对象偏好和当前宿主能力，保持专题原有语言，不新增模型、路径或后台任务配置。相关提示不调用模型；用户选定来源后才准备一次更新任务。任务准备、宿主实际执行、差异候选与正式提交是不同状态；请求模型与可观察身份分别保存，身份不符时不重试或切换模型。

技能键为 nature-writing、nature-polishing、nature-shared、humanizer、humanizer-zh、stss。Nature Writing/Polishing 还要求 Shared。仅选中的指导注入对应语言的 Writer 或 Translation（新运行为原文语言 Writer 与译文语言 Translation）；停用项不暗中保留。科学事实、证据和发布边界属于固定合同，不随文风技能关闭。

## 页面与操作

`npm run setup:check` 检查仓库默认 MinerU 环境等基础项，不证明其他自选解析环境可用。`apa-setup inspect` 检查个人配置所选路径和依赖文件，实际解析使用新运行冻结的配置；文件存在仍不等于实际解析验收。

本次检测的页面通过 `--host-profile <本次档案实际路径> --output <本次检测目录的index.html>` 生成并使用返回的完整路径，避免覆盖其他预览。页面先要求用户确认所针对的项目文件夹（同页展示本项目自检和宿主能力自检），再核对工作目录与 MinerU 解析环境的存放位置并显示其实际位置，之后才提供完善配置、去除配置和导出配置三个独立入口。存放位置的修改并入完善配置的预览。进入功能后只显示该功能的分页、预览及输出；返回首页可切换功能，填写内容保留，各功能的结果和下载文件名独立。页面内嵌脚本和样式，不启动后台服务，不向网络发送答案。

- **完善**：宿主派发、知识库查询与阅读配置分别分页填写或修改，连同第二步勾选的位置修改，可在本功能内导入备份；预览后生成局部操作。任一字段页都能预览手动选中的修改，导入变化单独预览，不混合去除或导出操作。
- **去除**：默认全部，也可选定字段；只移除答案，不删除笔记或卸载依赖。
- **导出**：自定义文件名，导出 apa-config-export-1.0 JSON。只包含页面读取时已保存的答案，不包含完善配置中尚未应用的修改。可能含个人路径，分享前审阅。
- **导入**：读取导出文件，展示差异再生成操作。未提供字段保留，模型模式整体替换。

下载操作 JSON 与复制同一 JSON 等价。将用户自行选择的文件、路径或粘贴内容交给助手并明确要求应用。剪贴板受限时手动选择文本复制。单独导出或按明确范围挖空配置可使用相应 CLI，无须打开页面。助手应用后回读并报告缺项和依赖，不自行修正缺项。

操作格式为 apa-config-operation-1.0，包含 base_fingerprint 及 patch/remove/import 动作。页面生成的操作还带 repo_root（用户在第一步确认的项目绝对路径），apply 时与 `--repo-root` 不一致即以 APA_CONFIG_REPO_MISMATCH 拒绝；其他合法操作可不带此字段。页面阈值压缩卡片中填写的候选阈值，作为可选的 `host_settings: { threshold_compaction: { host, tokens } }` 随 patch 操作一起导出（页面提示推荐范围 250000–300000 token，不预填）。apply 只校验这一项，不写入个人配置，并在结果的 `pending_host_settings` 中返回，由助手预览后再按单独确认写入宿主设置。页面“自检遗留问题”中选择的处理方式，作为可选的 `issue_choices`（遗留问题 id → `investigate`、`prepare`、`accept-limit` 或 `defer`，按问题类别限定）随 patch 操作导出；apply 同样只校验、不写入个人配置，在 `pending_issue_choices` 中返回，由助手按所选处理。指纹过期被拒绝；须重新读取配置并展示新差异，由用户确认后生成新操作，禁止改旧指纹绕过拒绝。`node scripts/apa-setup.mjs apply --file <操作文件>` 应用；无 --file 时读标准输入。`inspect` 只报告状态，需读取 ready、validation、dependencies，不能把正常退出视作就绪。

`node scripts/apa-setup.mjs inspect --capability query` 检查查询配置；`--capability reading` 或不传选项沿用阅读检查。两者的 `ready` 都只是对应配置/文件的就绪状态，`model_availability: 'not_checked'` 表示未检查当前宿主模型、未执行模型任务。页面分别展示查询和阅读状态，因此查询配置就绪与阅读依赖缺失可以同时成立。

阅读运行另用 `evaluateReadingPreflight({inspection,hostProfile,evidence})` 计算 `reading_preflight.status`，值为 `pass`、`blocked` 或 `unknown`。必需条件包括配置与依赖、当前宿主与保存声明一致、实际派发工具及独立上下文、模型与推理强度，以及本次 `file_read`、`control_write`、`input` 的通过证据和引用。静态 `inspect` 不具备全部运行证据时保持未知；会话入口写入并回读控制产物后补入证据，派发前要求全部通过。六项可选高级能力不进入这一门槛。恢复仍核对当前运行条件，并沿用原冻结来源、模型和预算。详见[会话接口](apa-v3/reading-session.md)。

`node scripts/apa-setup.mjs export --output <新文件>` 导出答案，CLI 会创建目标父目录。目标已存在时以 `APA_SETUP_EXPORT_EXISTS: <路径>` 拒绝；助手报告该路径并询问用户，同意覆盖时追加 `--overwrite` 直接替换（结果中 `replaced: true`），不覆盖时由用户另行命名后重新导出。助手按技能规则确定完整目标，再传给 `--output`：用户指定路径或文件名时优先采用；仅指定文件名或未指定时使用 `config/backups/<owner>/`，默认文件名为 `apa-config-backup-YYYYMMDD-HHmmss-SSS.json`。`owner` 根据 agent 身份及归属证据确定，不从所选模型推断。CLI 未传 `--output` 时只输出 JSON，相对路径按当前命令目录解析。配置导出不包含代码或论文。完善、字段去除、导出及差异导入均处理 `models.query` 与 `query` 偏好；仅选择查询字段的操作保留科学角色、解析器和目录原值。

## 安装与固定规则

保存或去除配置不安装依赖、不改全局环境。缺少项目按 [SETUP](../SETUP.md) 单独安装。来源、每次运行预算、截止时间、补充材料范围及正式发布仍需逐次授权。

新阅读遵循 [当前合同](apa-v3/current-contracts.md)、[呈现接口](apa-v3/reading-first-obsidian.md) 与 [发布桥](apa-v3/reading-first-publication.md)。旧 V3 绑定保留原版本，不提供 V2 论文入口，不自动升级笔记。新方法在 Wiki/methods/，保护原始资料和人工内容。

## 独立公开工程

`npm run apa:public:export -- --output <尚不存在的目录>` 按 config/apa-public-files.json 精确白名单导出。`npm run apa:public:check -- --root <目录>` 核对哈希、相对导入、合同与文档链接。输出含空资料目录和合成测试，不含个人答案、现有知识、运行历史、环境、缓存、Obsidian 状态和 Git 历史。不清空原库；建立公开仓库、许可或上传另行决定。


## 环境合同

环境配置文件是安装器和环境检查共同读取的合同；修改环境支持时需同步相关检查。

| 字段 | 用途 |
| --- | --- |
| `platform.os` | 支持系统 |
| `platform.arch` | 处理器架构 |
| `node.major` | Node 主版本 |
| `node.channel` | Node 发行通道 |
| `npm.major` | npm 主版本 |
| `python.major` | Python 主版本 |
| `python.minor` | Python 次版本 |
| `mineru.update_policy` | 解析器更新策略 |
| `mineru.package` | 解析器包名 |
| `mineru.model_source` | 模型下载来源 |
| `disk.recommended_free_gib` | 新装 MinerU 的建议预留空间，低于时提示，不作为安装阻断条件 |
| `obsidian.plugins` | 可选 Obsidian 集成检查项 |

不得只修改文档声称支持新环境；真实适配与安装需另行实施和验证。

## 发布前命令

已完成候选审查后可准备精确清单；下列检查不替代发布批准：

```powershell
node scripts/v3/bilingual.mjs review --vault-root <vault-root> --run <run> --profile reading-first-obsidian-1.0
node scripts/v3/bilingual.mjs dry-run --vault-root <vault-root> --run <run> --profile reading-first-obsidian-1.0
```

显式全局修复时，技能恢复点在用户目录 `.agents/backups/skills/academic-paper-analysis/<UTC timestamp>`；命令启动器备份在原文件旁，后缀为 `.backup-<timestamp>`。本库配置保存不创建这些全局备份。

## Windows 运行错误的处理

- Python 能读文件但打印元数据时报 `UnicodeEncodeError: gbk` 时，只为该命令使用既有解释器的 `-X utf8`，不改 PDF 或全局编码。`EPERM realpath` / `WinError 5` 则先核对同一进程对具体输入、runtime 和输出的访问权限，不能按编码错误处理；保留既有 MinerU 路径映射。
- `codex exec` 的 `--sandbox workspace-write` 与 `--approve-for-me` 互斥；按已批准的模式选择一种。额外暂存目录使用明确的 `--add-dir`，不因此关闭沙箱或扩大真实论文的模型、来源和预算。
- 测试若在宿主 AppContainer Temp 下 `realpath` 失败，可仅对当前测试命令将 `TEMP` / `TMP` 指向已核对的 `.tmp/<任务>/test-temp/`。不改全局环境，不将临时根设为知识库根目录，不为权限错误放宽发布路径校验。
- PowerShell 中对文件类型使用 `rg -g '*.md' <pattern> <目录>` 等过滤方式，不将 `目录/*.md` 当 Windows 字面路径。区分无命中的退出码 1 与执行失败，避免用不匹配当前 shell 的尾随命令统一吞错。
- review-only Guard 不允许审查者写入文件；可由 Controller 保存完整审查返回。需要子进程落盘时，将精确暂存文件声明为 change 范围；hash 权限仅用于已需要的完整性核验。

源码更新不刷新旧运行的工具指纹、批准或回执。旧发布登记在工具变化后拒绝重建是有效保护；当前库状态通过已提交索引及对象校验确认，不用重新执行提交前的 dry-run 计划代替发布后核验。图谱默认保留只读 proposal/check；用户可执行 `npm run obsidian:graph:sync -- --vault-root "<vault-root>"` 为该库启用持续同步，之后每次提交成功及已提交恢复自动刷新已提交节点筛选。原配置保存备份，其他展示设置保留，自定义筛选变化不自动覆盖。已经打开的图谱标签页需要重开以读取新配置；详见[图谱自动同步](apa-v3/reading-first-publication.md#图谱自动同步)。
