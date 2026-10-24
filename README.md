# APA：论文阅读与 Obsidian 知识库

APA 在 Codex 中组织有证据依据的论文阅读，输出可直接使用的中英文 Obsidian 笔记、图表、方法与概念链接。当前实现支持 Windows x64、Node.js 24、npm 11，以及已有的 MinerU 本地解析路线。

新论文由六个科学角色整合研究问题、设计、方法、结果与局限，再由双语 Writer 成稿。可选 Reading Editor 整理层级、重点和目录。完整候选经过一次整体审查，至多一次实质问题局部复核。正式入库需要对精确候选单独批准，只有已提交的 V3 代次进入默认图谱和检索。

## 安装与首次使用

1. 将公开工程放在独立目录，用 Codex 打开该目录。它也是将来的 Obsidian 知识库。
2. 先运行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup/bootstrap-windows.ps1 -CheckOnly` 查看安装前报告。报告列出已有环境、缺失项、目标目录及影响；明确选择安装后再运行相应命令。基础环境为 Node.js 24 和 npm 11；`npm run setup:windows` 默认只安装 npm 依赖，完成后用 `npm run setup:check` 检查。详细步骤见 [SETUP.md](SETUP.md)。
3. 对 Codex 说“使用 apa-setup 配置当前知识库”。也可运行 `npm run apa:setup -- page`，打开返回的 HTML 分页向导。每页处理一类设置，可用上一步、下一步或导航切换，填写内容会保留。
4. 填写模型、输出目录、已有 MinerU 路径、语言顺序、呈现方式和写作技能。下载操作 JSON 后，将文件路径交给 Codex，或复制同一 JSON 到对话，明确说“应用这份配置”。页面本身不写入知识库，也不安装依赖。
5. 按需安装缺少的 MinerU 或已启用写作技能，再检查配置。必填项或所选依赖缺失时，新论文不会开始；关闭可选技能不需要安装它。
6. 将论文放在 `Raw/` 或提供明确来源，对 Codex 说“用 APA 分析这篇论文”，确认这次运行的来源、预算与范围。阅读结果交付到配置的候选目录；正式入库另行批准具体清单。

工程自带 `.agents/skills/academic-paper-analysis/` 和 `.agents/skills/apa-setup/`，通常无需全局安装。如当前会话尚未发现项目技能，在工程中新开会话，或明确要求读取对应的 `SKILL.md`。

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
