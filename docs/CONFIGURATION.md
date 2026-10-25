# APA 本库配置

README 负责安装、使用和更新说明；`academic-paper-analysis` 负责论文阅读，独立的 [apa-query 技能](../.agents/skills/apa-query/SKILL.md)负责库内查询与专题操作，`apa-setup` 管理本库配置；独立公开导出生成无个人资料的工程目录。

## 保存与冻结

阅读和查询共用唯一答案文件 `config/apa.local.json`，版本 `apa-local-config-1.0`，由 Git 忽略。没有全局继承，公开模板不带个人答案。空配置只有 schema_version；允许分步保存，新论文入口 `prepareConfiguredReading` 要求完整且所选依赖可用。

新运行冻结配置指纹、模型/强度、路径、解析器选择及写作指导内容/哈希。“跟随主会话”取创建时设置，不在运行中动态切换。旧任务从原检查点恢复，不重读个人配置替换绑定。

## 字段

| 字段 | 含义 |
| --- | --- |
| models.query | 可选知识库查询模型；未保存或移除时 follow-main，每次查询确定当前会话模型与推理强度 |
| query.answer_language | 默认回答语言：question（跟随问题）、zh-CN（中文）、en（英文）；未配置为 question |
| query.detail | 默认详略：adaptive（按问题需要）、concise（简明）、detailed（详细）；未配置为 adaptive |
| query.audience | 默认讲解对象：adaptive（按问题需要）、beginner（初学者）、researcher（研究人员）；未配置为 adaptive |
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

显式模型对象为 `{mode:'explicit',model,reasoning_effort}`，跟随主会话为 `{mode:'follow-main'}`。配置接受非空模型标识，不限定 GPT；实际派发须符合当前宿主支持的模型和参数组合。现有自动派发对接 Codex，其他宿主需要对应调用与回执适配。配置不是用量、来源或执行授权。

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

下载操作 JSON 与复制同一 JSON 等价。将文件、路径或粘贴内容交给助手并明确要求应用。剪贴板受限时手动选择文本复制。助手应用后回读并报告缺项和依赖。

操作格式为 apa-config-operation-1.0，包含 base_fingerprint 及 patch/remove/import 动作。指纹过期被拒绝。`node scripts/apa-setup.mjs apply --file <操作文件>` 应用；无 --file 时读标准输入。`inspect` 只报告状态，需读取 ready、validation、dependencies，不能把正常退出视作就绪。

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
