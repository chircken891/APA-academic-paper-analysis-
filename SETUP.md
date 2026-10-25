# 安装与排障

当前安装脚本支持 Windows x64。版本基线见 [config/environment.json](config/environment.json)：Node.js 24、npm 11，MinerU 安装器使用 Python 3.12。模型通过 apa-setup 选择，不限定 GPT；现有自动派发对接 Codex，其他宿主需完成相应适配。命令从工程根目录运行。

## 基础环境

先按文末“安装前检测报告”执行只读检查。审阅报告并明确选择安装后，准备 Node.js/npm，再运行：

```powershell
npm ci
npm run setup:check
```

也可运行 `npm run setup:windows`，默认只安装锁定的 npm 依赖。检查区分核心、解析器和可选集成；核心通过不等于解析器或论文运行已验收。

## 配置当前库

```powershell
npm run apa:setup -- inspect
npm run apa:setup -- page
```

打开返回的 HTML，在首页选择“完善配置”“去除配置”或“导出配置”。三个功能分别操作、预览和输出；只有完善配置包含字段分页及备份导入，不必经过另外两个功能。下载完善或去除的操作 JSON 后，将路径交给助手并要求应用；也可复制该功能的同一 JSON 到对话。导出生成的是已保存答案的备份，用于以后导入。手动应用和回读：

```powershell
node scripts/apa-setup.mjs apply --file "$env:USERPROFILE\Downloads\apa-config-operation.json"
node scripts/apa-setup.mjs inspect
```

示例假定文件在用户 Downloads 且未改名，请替换为实际下载路径；网页不会自动把文件放到工程内。页面不直接写配置。`apply` 比较原配置指纹，只更新本库答案。遇 `APA_CONFIG_STALE` 应重新生成页面。可以保存未填完的配置，但不能开始新论文；回读时需检查 `validation.complete`、依赖状态及 `ready`，正常退出不等于就绪。

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
