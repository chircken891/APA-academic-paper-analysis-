# 安装与排障

当前安装脚本支持 Windows x64。版本基线见 [config/environment.json](config/environment.json)：Node.js 24、npm 11，MinerU 安装器使用 Python 3.12。模型通过 apa-setup 选择，不限定 GPT；现有自动派发对接 Codex，其他宿主需完成相应适配。命令从工程根目录运行。

## 先由用户选择项目文件夹

克隆、解压、安装和配置写入之前，必须由用户指定或明确确认项目文件夹的绝对路径；当前会话目录及其子目录均不能默认采用。已确认的同一目标不重复询问。获取工程的示例见 [README](README.md#1-用户选择项目文件夹再获取工程)。建议用户将所选项目文件夹设为 agent 工作目录；会话目录不同也不能改变已选目标。后文命令均在该项目根目录执行，支持根目录参数时显式传入用户确认的路径。

**安装授权不等于配置选择授权。** “帮我配置”“你决定”“全部按推荐”不能授权助手代选；配置必须由用户自行填写页面，或由助手在会话内分组展示选项和影响、等待用户回答。不得根据安装结果、历史默认或唯一可用选项自主完成配置。

## 基础环境

先按文末“安装前检测报告”执行只读检查。审阅报告并明确选择安装后，准备 Node.js/npm，再运行：

```powershell
npm ci
npm run setup:check
```

也可运行 `npm run setup:windows`，默认只安装锁定的 npm 依赖。检查区分核心、解析器和可选集成；核心通过不等于解析器或论文运行已验收。

## 配置当前库

先按本库 [apa-setup 技能](.agents/skills/apa-setup/SKILL.md) 检测宿主能力；检测报告只提供事实，不是用户答案。下面的 `$apaProjectRoot` 须事先设为用户已明确确认的项目绝对路径，不得从当前目录自动取值：

```powershell
npm run apa:setup -- inspect --repo-root "$apaProjectRoot"
npm run apa:setup -- page --repo-root "$apaProjectRoot"
```

用户可以自行打开返回的 HTML，在首页选择“完善配置”“去除配置”或“导出配置”。三个功能分别操作、预览和输出；只有完善配置包含字段分页及备份导入，不必经过另外两个功能。助手不得代操作页面制造用户选择。

也可以在会话内辅助配置：依次询问宿主派发方式、模型与推理强度、输出目录、解析器位置、写作顺序与呈现方式、写作指导；查询偏好单独成组，可由用户明确选择暂不配置。每组等待具体回答，未回答项保持未配置或原值，不为达到 `ready` 自主补齐。助手仅整理用户所选字段，展示目标目录及前后差异，等待明确应用确认后再保存。

页面方式下载完善或去除的操作 JSON 后，将路径交给助手并明确要求应用；也可复制该功能的同一 JSON 到对话。用户提交完整操作且明确要求应用时，不重复询问已确定的目标与字段。导出生成的是已保存答案的备份，用于以后导入。手动应用和回读：

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
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup/bootstrap-windows.ps1 -InstallMineru
```

专用入口 `npm.cmd run setup:mineru -- -BasePython "实际 Python 3.12 的 python.exe 完整路径"` 要求显式解释器路径；首次使用优先采用上面的 bootstrap 入口完成检测和安装。安装会创建本库 `.runtime/mineru/` 并可能下载模型；保存配置不触发安装。文件存在不等于真实解析成功，后者须在获批运行中验证。

## APA 配套写作技能

可分别选择 `nature-writing`、`nature-polishing`、`nature-shared`、`humanizer`、`humanizer-zh`、`stss`。启用项填写实际 SKILL.md 文件路径；未启用项无需存在。Nature Writing/Polishing 需要 Shared。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup/install-apa-companion-skills.ps1 -BasePython "实际 python.exe 完整路径" -Skills "humanizer,humanizer-zh"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup/bootstrap-windows.ps1 -CompanionSkills "nature-writing,humanizer-zh"
```

先给同一命令加 `-CheckOnly` 获取检测报告；直接技能检测模式允许省略 `-BasePython` 并报告缺项。审阅后才执行安装。选择 Nature 会补齐 Shared；不选择时不会默认安装全部。安装后回配置页选择路径。技能只指导既有 Writer 的表达，不增加独立润色角色或审核轮次。

此可选技能安装器当前复用 Codex 的 `skills/.system/skill-installer/scripts/install-skill-from-github.py`，这是该辅助工具的依赖，并非模型限制。请用直接技能安装命令的 `-CheckOnly` 检查其 `installer` 项；缺少时让助手检查该工具，或用 `-InstallerPath` 指定已有文件。也可通过所用宿主支持的方式准备技能，再在 apa-setup 填写路径。首次阅读不需要这些额外技能，可先在配置中逐项选“不使用”。

## 项目技能入口

工程自带 `academic-paper-analysis`、`apa-query` 和 `apa-setup` 三个项目技能。论文阅读与续接使用 `academic-paper-analysis`；已入库论文的查询、比较、专题保存和更新使用 [apa-query](.agents/skills/apa-query/SKILL.md)；配置检查和修改使用 `apa-setup`。它们读取同一个 `config/apa.local.json`。新论文阅读需要完整阅读配置；查询模型和回答偏好均可留空，分别默认跟随当前会话、问题语言和问题所需详略。明确保存专题时才需要共享候选目录，无需为查询再次完成整套阅读设置。

若宿主没有自动发现新技能，在本工程中新开会话，或直接让助手读取 `.agents/skills/apa-query/SKILL.md`。下面的可选全局安装器仍只管理全局 APA 副本与 MinerU 命令，不安装独立的全局 `apa-query` 副本。

## 可选全局集成

本库技能可直接使用。以下可选安装器针对 Codex 的全局 APA 副本与命令集成，需要时才执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup/bootstrap-windows.ps1 -InstallGlobalIntegration
```

已有不同内容的安装不会静默覆盖；检查具体差异后再明确选择修复参数。`-RepairGlobalIntegration` 必须同时带 `-InstallGlobalIntegration`。`npm run verify:apa-skill` 仅核对同步，不安装。

## Obsidian 与更新

将工程目录作为知识库打开。配置页不改已有 Obsidian 设置。`npm run setup:check:full` 增加 Obsidian 检查。默认检索和图谱只消费已提交 V3 代次；候选交付与正式发布分开。

更新保留本地答案与知识资料。重新检查依赖和配置即可；旧运行不自动重绑。

## 故障处理

| 状态 | 下一步 |
| --- | --- |
| 缺少答案 | 生成页面补全，再应用操作 JSON |
| 所选文件不存在 | 修正路径或明确安装，不自动换服务 |
| 页面过期 | 重新生成，在最新配置上重做操作 |
| 模型组合不可用 | 新运行派发前按当前宿主能力调整；旧运行保留原断点 |
| 网络或用量中断 | 保存绑定、已接受输出及剩余预算，从断点继续 |
| 全局技能不同步 | 使用本库技能，或另行批准全局同步 |

工程检查、合成测试、真实解析、科学阅读、原生显示和正式发布需分别报告。


配置字段与导入导出详见 [配置说明](docs/CONFIGURATION.md)。显式全局修复的技能恢复点在用户目录 `.agents/backups/skills/academic-paper-analysis/<UTC timestamp>`；启动器备份在原文件旁，后缀 `.backup-<timestamp>`。

## 安装前检测报告

任何安装前先运行只读检测，报告已满足项、缺失项、选中目标、目录与影响，再明确执行对应安装命令：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup/bootstrap-windows.ps1 -CheckOnly
```

检查可同时带计划使用的 `-InstallMineru`、`-InstallGlobalIntegration` 或 `-CompanionSkills`，仍不安装。读取 `checks` 中的 `status/required`、`prerequisites_ready` 和 `targets`；`-CheckOnly` 返回0只表示报告生成成功，不保证没有缺项。用户审阅报告并明确要求后才去掉 `-CheckOnly` 执行。基础依赖已经齐全时无需重复安装；配置页保存始终不安装。PowerShell 中如 `npm` 被执行策略阻止，可使用 `npm.cmd`，无需为此修改全局执行策略。
