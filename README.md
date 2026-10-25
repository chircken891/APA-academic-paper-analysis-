# APA：论文阅读与 Obsidian 知识库

APA 是一套可配置的论文阅读与 Obsidian 知识库工作流，输出可直接使用的中英文笔记、图表、方法与概念链接。通过 apa-setup 选择角色模型和推理强度，或让角色跟随当前会话；模型名称不限定 GPT。当前安装脚本的环境基线是 Windows x64、Node.js 24、npm 11，以及 MinerU 本地解析路线。

新论文由六个科学角色整合研究问题、设计、方法、结果与局限，再由双语 Writer 成稿。可选 Reading Editor 整理层级、重点和目录。完整候选经过一次整体审查，至多一次实质问题局部复核。正式入库需要对精确候选单独批准，只有已提交的 V3 代次进入默认图谱和检索。

## 安装与首次使用

配置页面和本地命令可独立使用。当前自动角色派发对接 Codex 的协作接口，其他 AI 助手宿主需要相应的调用与回执适配；填写模型名不会安装模型或接入服务商。以下操作中的“助手”须具备相应的本地工具和模型调用能力，配置成功不等于任意宿主均已兼容。

### 1. 获取工程，确认命令运行位置

准备一个独立文件夹，在 Windows PowerShell 中操作。已有 Git 时可运行：

```powershell
git clone https://github.com/chircken891/APA.git
cd APA
```

没有 Git 时，可在本仓库页面选择 **Code → Download ZIP**，解压后进入包含 `package.json` 和 `scripts` 的文件夹；不要在 ZIP 内直接运行。后面的命令都从这个工程根目录执行。让所用 AI 助手以同一个文件夹为工作目录，确认模型调用和本地工具可用。

工程自带 `.agents/skills/academic-paper-analysis/` 和 `.agents/skills/apa-setup/`，首次使用不需要安装全局 APA。若会话未发现技能，在工程中新开会话，或直接告诉助手：“请读取 `.agents/skills/apa-setup/SKILL.md`，配置当前工程。”支持 `$` 技能调用语法的宿主也可使用 `$academic-paper-analysis` 调用阅读技能。

### 2. 先检测，再安装基础依赖

即使还没有 Node.js，也可以先运行以下只读检测；它不会安装、下载或写入配置：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup\bootstrap-windows.ps1 -CheckOnly
```

报告是 JSON，可直接交给助手解释。重点看：

| 报告字段 | 怎样判断和处理 |
| --- | --- |
| `checks` 中 `required: true` 且 `status: missing` | 本次安装缺少必要前置；先按该项说明解决 |
| `disk_space` 中 `status: warning` | 低于建议预留空间；结合所选依赖、模型和缓存评估，不作为统一最低空间门槛 |
| `prerequisites_ready` | `true` 表示安装前置已满足，不代表依赖已经装好 |
| `targets` | 将操作哪些目录、哪些项目已存在，以及可能的影响 |
| `next_commands` | 根据所选项目生成的后续命令；审阅后再决定执行，不会自动执行 |

**检测命令正常退出不等于全部就绪。** 基础安装需要 Windows x64、Git、Node.js **24.x**、npm **11.x**。缺少这些软件时，根据报告从 [Git for Windows](https://git-scm.com/downloads/win) 和 [Node.js 官方下载页](https://nodejs.org/en/download) 获取对应版本，安装后重新打开 PowerShell 并回到工程目录，再检测一次。不要直接把“最新版”当作受支持版本。脚本不会替你安装 Git 或 Node.js。

确认报告中的目标并决定安装后，再运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup/bootstrap-windows.ps1
npm.cmd run setup:check
```

默认只恢复本工程的 npm 依赖，不安装 MinerU、全局集成或写作技能。`setup:check` 的基础通过标准是 `core_ready: true`；`parser`、`integration` 和 `obsidian` 的失败项须分别阅读，不能当作基础依赖失败，也不能当作已经完成论文运行。顶层 `ready` 还包含 Obsidian 检查，可能仍为 `false`。本说明使用 `npm.cmd`，避免 PowerShell 将 `npm` 解析为被执行策略阻止的 `npm.ps1`。

### 3. 准备 PDF 解析环境

新论文目前需要可用的 MinerU 环境。**已有环境**可以直接在下一步配置其目录；**需要新安装**时，先检测所选安装的完整前置：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup/bootstrap-windows.ps1 -CheckOnly -InstallMineru
```

本工程安装器采用 Python **3.12.x** 作为验证基线，可从 [Python 官方 Windows 下载页](https://www.python.org/downloads/windows/) 获取。[MinerU 官方安装说明](https://opendatalab.github.io/MinerU/quick_start/) 当前给出的包范围为 `>=3.10,<3.15`，具体引擎另有约束；这不等于其他 Python 版本已通过本工程验证。

**20 GiB 是新安装的建议预留值，不是 APA 或 MinerU 的统一最低占用。** 当前脚本选择 Standard、ONNX 小模型和 llama.cpp，[官方模型说明](https://github.com/opendatalab/MinerU#model-engines-with-extras) 列出的模型下载量约 **2 GB**，还需另计 Python 环境、依赖、下载缓存和解析输出，实际大小随版本和组件变化。低于 20 GiB 时预检给出提示，不因此阻止安装；基础安装或复用已有解析环境也不要求额外预留 20 GiB。

按报告处理必要缺项、审阅空间提示并确认所选安装后，再执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup/bootstrap-windows.ps1 -InstallMineru
```

默认生成 `.runtime/mineru/`，包括 `venv/Scripts/python.exe` 和 `config.yaml`，并下载所需包和模型。多套 Python 并存或自动检测失败时，可在检测与安装两条命令中都加 `-BasePython "实际 Python 3.12 的 python.exe 完整路径"`。遇网络或下载错误，按报错处理后续接，保留已完成内容；安装成功仍不等于真实 PDF 解析验收。

写作技能和全局集成均为可选。首次使用可以将六项额外写作技能明确设为“不使用”，以后再按 [SETUP](SETUP.md#apa-配套写作技能) 逐项检测和安装，无需为了生成配置页先装齐它们。

### 4. 生成分页向导，填写本库设置

向助手说“使用 apa-setup 配置当前知识库”，或手动运行：

```powershell
npm.cmd run apa:setup -- inspect
npm.cmd run apa:setup -- page
```

首次 `inspect` 显示 `exists: false`、`ready: false` 是正常的：公开工程没有任何人的配置答案。`page` 返回 HTML 的完整路径；用浏览器打开 `.tmp/apa-setup/index.html`。首页有“完善配置”“去除配置”“导出配置”三个独立入口，各自拥有分页、预览和输出，可返回首页切换。

首次使用选择“完善配置”：六组设置可顺序切换或直接跳转，切页保留填写内容；导入已有备份也在这个功能内。先勾选“修改此项”才能填写，未勾选项目保留原值。“去除配置”单独生成清除操作；“导出配置”单独保存已生效设置，不包含其他功能中尚未应用的填写。

首次至少完成以下选择：

- **模型**：填写六科学角色的共同选择，以及中文写作、英文写作、阅读编辑、独立核验四项选择。可以使用“跟随主会话”；指定模型时填写当前宿主实际支持的模型标识与推理强度，不要求名称带有 `gpt-` 前缀。单个科学角色的覆盖可不填，暂不使用阅读编辑时也仍需保存其模型选择。
- **三个输出目录**：分别存执行记录、解析资料和阅读候选，必须在本库内。例如 `Eval/apa-v3/runs`、`Eval/apa-v3/parse`、`Eval/apa-v3/reading`；每次运行自动追加独立编号，不必提前创建每篇论文的子目录。
- **MinerU 位置**：使用上一步安装结果时，运行目录填 `.runtime/mineru`；Python 和配置文件可留作未配置，由运行目录派生。已有环境则填写其实际位置。
- **阅读设置**：选择首先写作的语言和是否使用阅读编辑；两种语言都会生成。
- **六项写作指导**：每项都明确选“启用”或“不使用”。启用时填写实际 `SKILL.md` 文件路径；启用 Nature Writing/Polishing 还须启用 Nature Shared。

这些示例不会自动写入配置。点击“预览全部已选修改”，确认中文的修改前后说明后，再进入下一步。

### 5. 应用操作，回读确认

下载的是**操作文件**，不是已经生效的配置。将下载文件的实际路径交给助手，并说“请应用这份配置并回读检查”；也可以复制完整 JSON 到对话并提出同一请求。不要把“导出配置备份”生成的文件当作操作文件直接应用。

需要手动应用时，以下示例假定浏览器保存到了用户 Downloads，文件名仍是 `apa-config-operation.json`；请按实际下载位置或改名结果替换：

```powershell
node scripts/apa-setup.mjs apply --file "$env:USERPROFILE\Downloads\apa-config-operation.json"
node scripts/apa-setup.mjs inspect
```

应用后的新论文配置门槛是：`validation.complete: true`、所选 `dependencies` 均为 `available`、顶层 `ready: true`。若不满足，按缺项修正路径或另行安排安装检测，不能跳过检查启动论文。`ready` 只证明答案完整和文件可找到，不证明真实模型或解析已运行。出现 `APA_CONFIG_STALE` 时重新生成页面，不要改 JSON 指纹；需要继续编辑时也应重新生成页面，避免读到旧快照。

### 6. 开始第一篇论文，找到输出

把自己的 PDF 放入 `Raw/`，在以当前工程为工作目录的助手会话中提出明确任务，例如：

> 用本库 APA 分析 `Raw/论文.pdf`，交付中英文 Obsidian 笔记。先检查配置和已有解析资料，再提出这次的来源范围、调用预算及截止时间，等我批准后执行；需要补充材料时先说明原因。

把示例文件名换成实际文件名。首次任务由助手通过已接入的宿主适配器按项目技能组织执行，`npm run apa` 是底层工具入口，不是输入一个 PDF 就自动完成阅读的命令。配置通过也不代替这次运行的授权。

完成后，助手应给出**候选目录下中英文 Markdown 的实际路径**，以及本次完成情况和限制。以配置的候选目录为准；不要在空的 `Wiki/` 中寻找尚未正式发布的笔记。可在 Obsidian 中把此工程作为知识库打开，查看双语笔记、图表和知识链接。若中断，提供运行目录或检查点继续，不要重复重跑已完成内容。要进入正式 Wiki、默认检索和图谱，另行审阅并批准精确发布清单。

## 配置什么

| 配置 | 作用 |
| --- | --- |
| 科学角色默认模型及单角色覆盖 | 控制六个科学角色的实际模型与推理强度 |
| Writer、Editor、Verifier 模型 | 分别指定参数，或在新运行创建时跟随主会话并冻结 |
| 运行、解析、候选目录 | 当前库内的三个输出根目录，每次使用独立 run ID 子目录 |
| MinerU | 选择已有运行环境、Python 和配置文件 |
| 首先写作的语言、呈现方式 | 先接受一种语言再写另一种；选择 Writer 直接呈现或增加 Reading Editor |
| Nature、Humanizer、stss | 分别启用已有技能，填写其 SKILL.md 路径；仅在既有 Writer 内使用 |

答案保存在本库忽略提交的 `config/apa.local.json`，无跨库全局层。公开包不含个人答案；已有运行继续使用原冻结绑定。详见 [配置说明](docs/CONFIGURATION.md)。

## 日常使用

- **分析论文**：“用 APA 分析 Raw/论文.pdf”。先核对已有材料，批准有限范围后执行。
- **继续任务**：“继续这次 APA 运行”，提供保存的运行目录或检查点。不会自动重做已完成内容或升级旧绑定。
- **调整设置**：“用 apa-setup 修改当前库配置”。支持完善、全部或选择去除、命名导出，以及导入前差异预览。去除答案不删除笔记或卸载依赖。
- **正式发布**：先审阅精确发布清单，再批准 V3 受控事务。候选完成不等于已发布。见 [发布接口](docs/apa-v3/reading-first-publication.md)。

## 更新与检查

更新前保留本地配置、论文、笔记和运行资料，检查工程文件的本地修改。按维护者提供的更新取得代码，依赖锁文件变化后运行 `npm ci`，再运行 `npm run setup:check` 和 `npm run apa:setup -- inspect`。工程更新不会自动安装可选依赖、同步全局技能或迁移旧运行。

`npm test` 运行工程附带测试；`npm run index:check` 检查现有提交索引，`npm run obsidian:graph:check` 检查图谱政策。空库没有已发表论文是正常状态。合成测试不能替代真实 PDF 解析、实际模型执行或 Obsidian 原生观察。

配置页过期时重新生成；缺文件时修正路径或按需安装；模型不可用时在派发前选择宿主支持的组合。全局 APA 与工程不同步时可直接使用本库技能。排障见 [SETUP](SETUP.md)，科学要求见 [当前合同](docs/apa-v3/current-contracts.md)。

## 导出独立公开工程

配置导出与公开工程导出是两个独立操作。维护者运行：

```powershell
npm run apa:public:export -- --output .tmp/apa-public-setup/public
npm run apa:public:check -- --root .tmp/apa-public-setup/public
```

目标必须尚不存在。导出采用精确白名单，包含代码、合同、说明、合成测试、空知识库目录及相对路径/SHA-256 清单。它排除个人答案、论文、已有笔记/知识/图片、运行记录、缓存、本地环境、Obsidian 状态和 Git 历史，不清空本库。

检查后可独立审阅并决定新建公开仓库。导出不初始化 Git、不上传、不发布，也不决定软件许可。
