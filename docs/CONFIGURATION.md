# APA 本库配置

README 负责安装、使用和更新说明；`academic-paper-analysis` 负责论文阅读，独立的 [apa-query 技能](../.agents/skills/apa-query/SKILL.md)负责库内查询与专题操作，`apa-setup` 管理本库配置；独立公开导出生成无个人资料的工程目录。

## 用户选择与应用边界

首次获取项目，必须先由用户指定或明确确认项目文件夹的绝对路径，之后才可克隆、解压、安装或写入配置。当前会话目录及其子目录不能默认采用；建议用户将所选文件夹设为 agent 工作目录。已有工程也以用户明确选定的根目录为目标；同一会话已确认的目录无需重复询问。后续命令使用该目标，支持根目录参数时显式传入；下文 CLI 示例执行时须追加 `--repo-root "<用户确认的项目绝对路径>"`。

安装授权不等于配置选择授权。用户可以自行填写配置页，或通过会话辅助配置：依次确认宿主派发方式、模型与推理强度、输出目录、解析器位置、写作顺序与呈现方式、写作指导；查询偏好单独成组，可明确选择暂不配置。助手逐组展示具体选项及影响，等待回答后继续。“帮我配置”“你决定”“全部按推荐”不能代替分组选择。

检测报告、推荐值、历史默认、示例和唯一可用选项均不属于用户答案；即使宿主只能跟随主会话，也须解释限制，等待用户选择采用或暂缓。未回答项保持未配置或原值，不为达到 `ready` 自动补齐。已保存且无需改变的配置不重新选择；拟修改或不兼容的字段须取得新的选择。普通只读查询沿用既有运行时默认，不自动把默认值保存成个人配置。

会话辅助仅整理用户已选择的字段，展示项目绝对路径与前后差异，取得明确应用确认后才使用既有 CLI 保存并回读。用户自行提交完整操作并明确要求应用时，不重复询问已确定的目标及字段；未选择的字段仍不补入。禁止直接编辑个人答案绕过流程，或代操作页面制造用户选择。详细交互见 [apa-setup 技能](../.agents/skills/apa-setup/SKILL.md)。

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
| models.roles | english-writer、chinese-writer、reading-editor、independent-verifier 分别选择；暂不用 Editor 也保留设置 |
| paths.runs/parse/candidates | 本库内输出根目录，每次追加独立 run ID |
| parser.runtime_home | 已有 MinerU 环境 |
| parser.python/config_path | 可选显式路径；否则从运行目录派生 |
| reading.source_language | 保留的配置键名；en 或 zh-CN 指定先写哪种语言，另一语言消费已接受内容。它不表示论文原文语言 |
| reading.presentation_mode | reading-editor 或 writer |
| writing_skills | 六技能各自明确 enabled；启用时提供 SKILL.md 路径 |

新配置阅读调用必须按实际主论文向 `prepareConfiguredReading` 显式传入 `sourceLanguage`（`en` 或 `zh-CN`）；原文语言属于每篇文献的事实，不从个人偏好推定。运行将其冻结为 `binding.source_language`，决定 `Wiki/sources/` 与 `Wiki/translations/` 的归属；配置的 `reading.source_language` 则冻结为 `first_writing_language`，只决定顺序和另一语言消费的 `source_view`。旧绑定缺少后者时沿用其原有顺序，不修改旧记录。

宿主档案 `apa-host-profile-1.0`（结构见 `Schema/config/apa-config.schema.json` 的 `hostProfile`）由助手检测自身环境后写入 `.tmp/apa-setup/host-profile.json`，记录宿主名、当前会话、派发工具及参数名、派发工具可接受的模型与各自的推理强度档位，以及每项的来源。`inspect`/`page` 加 `--host-profile <file>` 时，检查结果增加 `host_check`（派发方式是否一致、模型或强度是否与本宿主不符），页面的模型与强度选项也来自档案。档案是助手的自我报告，不证明派发或模型实际可用。

档案的可选 `capabilities` 提供六项减负能力的证据：按需读取、子代理排查、阶段手动压缩、短回执、科学阶段恢复与阈值自动压缩。`inspect` 输出 `capability_check`，配置页展示同一报告中的方式、范围、依据、限制和下一步。`detected` 表示检测到方式，`conditional` 表示还存在待满足条件，`blocked`、`unsupported`、`unknown` 分别表示阻塞、不支持及未知；没有档案时不凭宿主名称补成可用。档案只用于检测，不进入 `config/apa.local.json`，能力报告不改变 `ready`；`ready` 也不能证明真实派发、模型遵守、压缩或续接成功。

阈值项须检查实际启用的后端、配置单位和范围、作用于当前会话、新会话或整个实例，以及用户候选阈值、模型上下文容量、输出预留、压缩余量、保留预算和 token 计量口径。未知项保留 `null`；某次试验提出的 200,000 token 不是默认值。Codex CLI、Claude Code 和独立 DeepSeek Harness 的具体方法须按现场版本及配置核实，不能将新启动参数视作已改变当前桌面会话，也不能把未命中实际后端的字段当作有效覆盖。科学阶段仅持久化控制器状态；当前配置了 `host` 的请求还有真实任务句柄提取适配缺口，报告为阻塞，不能用本地 `action_id` 假装可查询或等待宿主任务。检测与完整档案填写方法见 [apa-setup 技能](../.agents/skills/apa-setup/SKILL.md)；真实宿主试验与配置应用需另行授权。

显式模型对象为 `{mode:'explicit',model,reasoning_effort}`，所选模型在宿主上没有推理强度参数时省略 `reasoning_effort`；跟随主会话为 `{mode:'follow-main'}`。配置接受非空模型标识，不限定 GPT；实际派发须符合当前宿主支持的模型和参数组合。现有自动派发对接 Codex，其他宿主需要对应调用与回执适配。配置不是用量、来源或执行授权。

查询配置检查与 CLI 任务准备解析 `models.query` 和可选 `query` 回答偏好，不要求阅读角色、工作目录、MinerU 或写作指导，也不读取写作文件。`apa-query` 技能可按需要在同一回答任务中引用本库已启用且可读的写作指导，不增加模型调用；具体规则见[查询写作指导](../.agents/skills/apa-query/references/writing.md)。空答案仍可检索；未保存查询选择时按 follow-main 解析，不把默认值写入个人文件。显式查询组合必须由当前宿主提供 `supportedModelPairs` 确认；未知能力报 `APA_MODEL_AVAILABILITY_UNKNOWN`，不支持报 `APA_MODEL_UNSUPPORTED`，均不自动更换模型。follow-main 要求有效的当前会话组合；提供宿主能力列表时同样检查支持情况。配置结构错误仍会拒绝。新论文阅读继续要求原有完整配置和依赖，旧冻结绑定不变。

回答偏好的优先级为当次明确要求、已保存默认、内置默认。代理可在 `request` 的输入中传可选 `preferences:{answer_language,detail,audience}`，只覆盖本次任务；解析结果进入任务证据数据和输入指纹，不写回个人配置。`question` 的明确语言、详略和讲解对象要求仍优先。`adaptive` 表示依据问题需要判断，`beginner` 增加背景和缩写解释，`researcher` 保留必要专业细节；简明模式不删除会改变结论的条件或限制。专题更新只使用详略和讲解对象偏好，保持原专题语言；单纯保存已接受答案不自动翻译或改写。详见[查询配置](../.agents/skills/apa-query/references/configuration.md)。

明确保存专题时才读取并检查现有 `paths.candidates`，在该根目录的 `topics/<topic_id>/<operationId>/` 中准备候选。无需新增一套路径配置，也不要求 MinerU、科学角色模型或完整阅读依赖。路径缺失或不可用只阻断保存，普通只读查询仍沿原能力检查。保存已有答案不强制模型调用，不写回个人配置。

正式专题路径为 `Wiki/topics/<topic_id>.md`，只能经既有精确批准与受控事务写入；它不属于阅读双语的 `sources/translations` 规则。专题人工备注和原版本保留，公开工程导出只带实现、测试和空目录，不带个人专题或候选。

专题增量更新复用 `models.query`、详略与讲解对象偏好和当前宿主能力，保持专题原有语言，不新增模型、路径或后台任务配置。相关提示不调用模型；用户选定来源后才准备一次更新任务。任务准备、宿主实际执行、差异候选与正式提交是不同状态；请求模型与可观察身份分别保存，身份不符时不重试或切换模型。

技能键为 nature-writing、nature-polishing、nature-shared、humanizer、humanizer-zh、stss。Nature Writing/Polishing 还要求 Shared。仅选中的指导注入对应语言 Writer；停用项不暗中保留。科学事实、证据和发布边界属于固定合同，不随文风技能关闭。

## 页面与操作

`npm run setup:check` 检查仓库默认 MinerU 环境等基础项，不证明其他自选解析环境可用。`apa-setup inspect` 检查个人配置所选路径和依赖文件，实际解析使用新运行冻结的配置；文件存在仍不等于实际解析验收。

`npm run apa:setup -- page` 生成 `.tmp/apa-setup/index.html`。首页提供完善配置、去除配置和导出配置三个独立入口。进入功能后只显示该功能的分页、预览及输出；返回首页可切换功能，填写内容保留，各功能的结果和下载文件名独立。页面内嵌脚本和样式，不启动后台服务，不向网络发送答案。

- **完善**：知识库查询与六类阅读配置分别分页填写或修改，可在本功能内导入备份；预览后生成局部操作。任一字段页都能预览手动选中的修改，导入变化单独预览，不混合去除或导出操作。
- **去除**：默认全部，也可选定字段；只移除答案，不删除笔记或卸载依赖。
- **导出**：自定义文件名，导出 apa-config-export-1.0 JSON。只包含页面读取时已保存的答案，不包含完善配置中尚未应用的修改。可能含个人路径，分享前审阅。
- **导入**：读取导出文件，展示差异再生成操作。未提供字段保留，模型模式整体替换。

下载操作 JSON 与复制同一 JSON 等价。将用户自行选择的文件、路径或粘贴内容交给助手并明确要求应用。会话辅助方式按上述分组选择、差异预览及应用确认流程生成操作。剪贴板受限时手动选择文本复制。助手应用后回读并报告缺项和依赖，不自行修正缺项。

操作格式为 apa-config-operation-1.0，包含 base_fingerprint 及 patch/remove/import 动作。指纹过期被拒绝；须重新读取配置并展示新差异，由用户确认后生成新操作，禁止改旧指纹绕过拒绝。`node scripts/apa-setup.mjs apply --file <操作文件>` 应用；无 --file 时读标准输入。`inspect` 只报告状态，需读取 ready、validation、dependencies，不能把正常退出视作就绪。

`node scripts/apa-setup.mjs inspect --capability query` 检查查询配置；`--capability reading` 或不传选项沿用阅读检查。两者的 `ready` 都只是对应配置/文件的就绪状态，`model_availability: 'not_checked'` 表示未检查当前宿主模型、未执行模型任务。页面分别展示查询和阅读状态，因此查询配置就绪与阅读依赖缺失可以同时成立。

`node scripts/apa-setup.mjs export --output <新文件>` 导出答案并拒绝覆盖现有文件。配置导出不包含代码或论文。完善、字段去除、导出及差异导入均处理 `models.query` 与 `query` 偏好；仅选择查询字段的操作保留科学角色、解析器和目录原值。

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

源码更新不刷新旧运行的工具指纹、批准或回执。旧发布登记在工具变化后拒绝重建是有效保护；当前库状态通过已提交索引及对象校验确认，不用重新执行提交前的 dry-run 计划代替发布后核验。图谱配置若落后于新代次，先生成并审阅 `obsidian:graph:proposal`，再按精确授权更新；发布命令不自动改写 `.obsidian`。
