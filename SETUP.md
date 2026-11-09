# 安装与排障

当前安装脚本支持 Windows x64。版本基线见 [config/environment.json](config/environment.json)：Node.js 24、npm 11，MinerU 安装器使用 Python 3.12。模型通过 apa-setup 选择，不限定 GPT；派发能力由当前宿主的检测与适配确定。命令从工程根目录运行。

## 先由用户选择项目文件夹

建议选择剩余容量充足的硬盘，为文献 PDF、解析图文、运行记录与笔记留出增长空间；仓库内安装的 MinerU 环境、模型和缓存也需计入容量。具体目录由用户选择，不固定盘符或仓库名称。

克隆、解压、安装和配置写入之前，必须由用户指定或明确确认项目文件夹的绝对路径；当前会话目录及其子目录均不能默认采用。已确认的同一目标不重复询问。获取工程的示例见 [README](README.md#1-用户选择项目文件夹再获取工程)。建议用户将所选项目文件夹设为 agent 工作目录；用户同意后使用项目 `.agents/skills/` 内随仓库提供的三个 APA 技能，默认不安装全局技能，已有全局副本保留。若用户不采用该工作目录或不将技能迁入项目作用域，须说明技能发现和规则作用范围可能变化，保留全局加载方式可能影响日常其他任务。会话目录不同也不能改变已选目标。后文命令均在该项目根目录执行，支持根目录参数时显式传入用户确认的路径。

**安装授权不等于配置选择授权。** “完善配置”“为我配置”“为某某 agent 配置”等请求均须由助手生成并打开本地 HTML，让用户自行填写；“你决定”“全部按推荐”不能授权助手代选。若无法打开，向用户提供页面路径，等待用户自行打开和选择；不得改用会话分组问答替代页面。导出配置及挖空或去除配置不强制打开页面，去除范围仍须明确。不得根据安装结果、历史默认或唯一可用选项自主完成配置。

## 基础环境

先按文末“安装前检测报告”执行只读检查。审阅报告并明确选择安装后，准备 Node.js/npm，再运行：

```powershell
npm ci
npm run setup:check
```

`npm run setup:windows` 默认选择 MinerU、全局 MinerU 启动器、Better Embedded Canvas 和五项配套写作指导，并恢复锁定的 npm 依赖。要只恢复基础依赖，可执行上面的 `npm ci`，也可在安装器中取消其余四组。检查分别报告核心、解析器、启动器和 Obsidian 状态。

## 配置当前库

先按本库 [apa-setup 技能](.agents/skills/apa-setup/SKILL.md) 检测六项宿主能力，由运行代理依据现场证据寻找达成方式；检测报告只提供事实，用户仍需自行选择配置。再次自检时先读取当前 owner 的既有档案和适配说明，结合当前证据核对；有效自有补丁可继续复用，仅对变化和缺口继续调查，需要新补丁时放在 `config/backups/<owner>/adapters/<id>/`，`owner` 按 agent 身份及归属证据确定，不从所选模型推断。设置变更须展示目标和差异，待用户确认后将备份保存到 `config/backups/<owner>/`，并应用、回读；真实能力验证单独报告。下面的 `$apaProjectRoot` 须事先设为用户已明确确认的项目绝对路径，不得从当前目录自动取值；`$apaDetectionDir` 填写本次检测已写入档案的实际目录，替换占位符；选择目录时须确认未被占用，两个名称均使用 kebab-case：

```powershell
$apaDetectionDir = ".tmp/apa-setup/<owner>/<detection-id>"
npm run apa:setup -- inspect --repo-root "$apaProjectRoot" --host-profile "$apaDetectionDir/host-profile.json"
npm run apa:setup -- page --repo-root "$apaProjectRoot" --host-profile "$apaDetectionDir/host-profile.json" --output "$apaDetectionDir/index.html"
```

配置请求须打开返回的 HTML，由用户先确认页面针对的项目文件夹并核对存放位置，再选择“完善配置”。页面也提供“去除配置”和“导出配置”，各功能分别操作、预览和输出；只有完善配置包含字段分页及备份导入。助手不得代操作页面制造用户选择。

用户在页面确认组件和配置项。安装组件默认选中，可在存放位置页取消，写作指导在完善配置中逐项选择。预览列出最终选择和前后差异。助手应用前核对目标，安装前另行报告已有项、缺项、目标和影响。其余未选择项保持未配置或原值。单独导出或按明确范围挖空配置时，可以使用相应 CLI 完成。

页面方式下载完善或去除的操作 JSON 后，将路径交给助手并明确要求应用；也可复制该功能的同一 JSON 到对话。用户提交完整操作且明确要求应用时，不重复询问已确定的目标与字段。导出生成的是已保存答案的备份，用于以后导入。助手导出默认使用 `config/backups/<owner>/apa-config-backup-YYYYMMDD-HHmmss-SSS.json`；用户指定路径或文件名时优先采用。手动应用和回读：

```powershell
node scripts/apa-setup.mjs apply --repo-root "$apaProjectRoot" --file "$env:USERPROFILE\Downloads\apa-config-operation.json"
node scripts/apa-setup.mjs inspect --repo-root "$apaProjectRoot"
```

示例假定文件在用户 Downloads 且未改名，请替换为实际下载路径；网页不会自动把文件放到工程内。页面不直接写配置。`apply` 比较原配置指纹，只更新本库答案，但指纹校验不能证明用户选择或授权。遇 `APA_CONFIG_STALE` 应重新读取并展示更新后的差异，由用户确认后生成新操作；页面方式重新生成页面，不改旧操作指纹。用户可明确选择先保存已选部分配置，但配置不完整时不能开始新论文；回读需检查 `validation.complete`、依赖状态及 `ready`，正常退出不等于就绪。

结束时分别报告工程已获取、依赖已安装、用户配置已保存、运行条件已就绪；不能因安装完成就自行保存配置，也不能把 `ready` 当成真实模型调用、PDF 解析或论文验收通过。

## MinerU

已有环境可在页面选择目录、Python 和配置文件。默认派生路径为运行目录下 `venv/Scripts/python.exe` 和 `config.yaml`。显式选择只传递给当前解析进程，不改全局环境变量。

Python 3.12 是本工程安装器的验证基线。[MinerU 官方](https://opendatalab.github.io/MinerU/quick_start/) 当前包支持 `>=3.10,<3.15`，具体引擎可能有更窄的范围。20 GiB 是新安装的建议预留值，低于时报告提示而不阻断安装。当前 Standard + ONNX + llama.cpp 的[官方模型下载参考](https://github.com/opendatalab/MinerU#model-engines-with-extras)约为 2 GB，不包含 Python 环境、依赖、下载缓存或输出文件，不能作为总安装大小。

需要新安装时，先用同选项加 `-CheckOnly` 检测并审阅报告，再明确执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup/bootstrap-windows.ps1 -SkipGlobalIntegration -SkipBetterEmbeddedCanvas -SkipCompanionSkills
```

专用入口 `npm.cmd run setup:mineru -- -BasePython "实际 Python 3.12 的 python.exe 完整路径"` 要求显式解释器路径；首次使用优先采用上面的 bootstrap 入口完成检测和安装。安装会创建本库 `.runtime/mineru/` 并可能下载模型；保存配置不触发安装。文件存在不等于真实解析成功，后者须在获批运行中验证。

## APA 配套写作技能

首次配置默认勾选 `nature-writing`、`nature-polishing`、`humanizer`、`humanizer-zh` 和 `stss`，可逐项取消或填写实际 SKILL.md 路径。选中任一 Nature 技能会自动附带内部支持包 `nature-shared`，最终预览会列出；两项都取消时也取消该支持包。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup/install-apa-companion-skills.ps1 -BasePython "实际 python.exe 完整路径" -Skills "humanizer,humanizer-zh"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup/bootstrap-windows.ps1 -SkipMineru -SkipGlobalIntegration -SkipBetterEmbeddedCanvas -CompanionSkills "nature-writing,humanizer-zh"
```

先给同一命令加 `-CheckOnly` 获取检测报告；直接技能检测模式允许省略 `-BasePython` 并报告缺项。审阅后才执行安装。选择 Nature 会补齐 Shared；不选择时不会默认安装全部。安装后回配置页选择路径。技能只指导既有 Writer 的表达，不增加独立润色角色或审核轮次。

技能安装器复用 Codex 的 `skills/.system/skill-installer/scripts/install-skill-from-github.py`。可用直接技能安装命令的 `-CheckOnly` 查看其 `installer` 项，或用 `-InstallerPath` 指定已有文件。也可通过所用宿主支持的方式准备技能，再在 apa-setup 填写路径。安装器中用 `-SkipCompanionSkills` 取消整组。

## 项目技能入口

论文输入须提供 PDF 文件路径；被分析文献及补充材料使用用户选定仓库的 `Clippings/` 原件。目录外输入提供完整路径，阅读准备阶段按原文件名复制到 `Clippings/`；同名不同内容时停止并询问。来源文献只保存在本机，发布时沿现有资产登记原位引用。`Raw/` 仅临时存放 AI 追溯的补充文献。已登记来源不得直接移动、改名或覆盖，位置调整须通过受控迁移事务更新登记与链接。若直接上传 PDF 本体调用 APA，agent 必须停止当前会话的分析，请用户新开会话提供路径，并说明这是为了节省用量；不得先解析附件或将附件落盘后继续分析。

工程自带 `academic-paper-analysis`、`apa-query` 和 `apa-setup` 三个项目技能，位于项目 `.agents/skills/`。用户同意将仓库设为工作目录后即可使用这些随仓库提供的技能。论文阅读与续接使用 `academic-paper-analysis`；已入库论文的查询、比较、专题保存和更新使用 [apa-query](.agents/skills/apa-query/SKILL.md)；配置检查和修改使用 `apa-setup`。它们读取同一个 `config/apa.local.json`。新论文阅读需要完整阅读配置；查询模型和回答偏好均可留空，分别默认跟随当前会话、问题语言和问题所需详略。明确保存专题时才需要共享候选目录，无需为查询再次完成整套阅读设置。

若宿主没有自动发现新技能，在本工程中新开会话，或直接让助手读取 `.agents/skills/apa-query/SKILL.md`。下面的可选全局安装器只管理 MinerU 命令，不安装任何 APA 技能副本。

## 可选全局集成

默认选择全局 MinerU 启动器（`mineru.cmd`、`mineru-local.ps1`），可用 `-SkipGlobalIntegration` 取消。只补装启动器时，可先预检再执行以下选择：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup/bootstrap-windows.ps1 -SkipMineru -SkipBetterEmbeddedCanvas -SkipCompanionSkills
```

启动器内容冲突时安装停止。核对差异并明确同意修复后，使用 `-RepairGlobalIntegration` 并保留该组件的选择。

## Obsidian 与更新

将工程目录作为知识库打开。Better Embedded Canvas 默认选中，可用 `-SkipBetterEmbeddedCanvas` 取消。安装器通过 GitHub 发布资产 API 获取三个文件，校验 SHA-256 后安装到 `.obsidian/plugins/better-embedded-canvas/`，并在 `community-plugins.json` 中启用。同版本复用已有插件文件。预检区分未安装、已安装未启用和已安装已启用。`npm run setup:check:full` 也检查 BRAT、Claudian、Dataview 和 Templater，这四个插件由用户自行管理。

Better Embedded Canvas 为笔记中的只读研究导图提供平移和缩放。笔记同时提供打开完整 Canvas 的链接。默认检索和图谱根据已提交 V3 代次读取登记笔记，画布作为发布资产保存。

更新保留本地答案与知识资料。重新检查依赖和配置即可；已提交的历史运行不再续接。在途阅读继续使用各自绑定的 `.runtime/apa-code/<哈希>/`，库内数据仍按显式库根目录读写。代码修复需核对新旧指纹、检查点和测试证据，经批准重绑后由新进程继续。详见 [阅读会话与恢复](docs/apa-v3/reading-session.md)。

运行发布、明确关闭有限完成或由用户终止后，会话核验宿主回传和恢复补丁的归档，再释放快照引用。自动回收只处理无在途引用的快照和无执行消费者的已登记临时文件。归档映射保存在运行根目录。

## 故障处理

| 状态 | 下一步 |
| --- | --- |
| 缺少答案 | 生成页面补全，再应用操作 JSON |
| 所选文件不存在 | 修正路径或明确安装，不自动换服务 |
| 页面过期 | 重新生成，在最新配置上重做操作 |
| 模型组合不可用 | 新运行派发前按当前宿主能力调整；进行中的运行保留原断点 |
| 网络或用量中断 | 保存绑定、已接受输出及剩余预算，从断点继续 |

工程检查、合成测试、真实解析、科学阅读、原生显示和正式发布需分别报告。


配置字段与导入导出详见 [配置说明](docs/CONFIGURATION.md)。显式全局修复时，启动器备份在原文件旁，后缀 `.backup-<timestamp>`。

## 安装前检测报告

任何安装前先运行只读检测，报告已满足项、缺失项、选中目标、目录与影响，再明确执行对应安装命令：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup/bootstrap-windows.ps1 -CheckOnly
```

检测命令可带 `-SkipMineru`、`-SkipGlobalIntegration`、`-SkipBetterEmbeddedCanvas`、`-SkipCompanionSkills` 或 `-CompanionSkills "名称,名称"`。读取 `checks` 中的 `status/required`、`prerequisites_ready` 和 `targets`。返回 0 表示报告生成成功，缺项以报告为准。用户审阅并明确选择后，按 `next_commands` 执行。配置页保存与安装分别处理。PowerShell 中如 `npm` 被执行策略阻止，可使用 `npm.cmd`。
