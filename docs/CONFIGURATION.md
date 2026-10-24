# APA 本库配置

README 负责安装、使用和更新说明；apa-setup 只管理交互配置；独立公开导出生成无个人资料的工程目录。

## 保存与冻结

唯一答案文件是 `config/apa.local.json`，版本 `apa-local-config-1.0`，由 Git 忽略。没有全局继承，公开模板不带个人答案。空配置只有 schema_version；允许分步保存，新论文入口 `prepareConfiguredReading` 要求完整且所选依赖可用。

新运行冻结配置指纹、模型/强度、路径、解析器选择及写作指导内容/哈希。“跟随主会话”取创建时设置，不在运行中动态切换。旧任务从原检查点恢复，不重读个人配置替换绑定。

## 字段

| 字段 | 含义 |
| --- | --- |
| models.science | 六科学角色共同模型/强度或 follow-main |
| models.overrides | 可覆盖 evidence、methods、results、interpretation、scientific-reading、integration |
| models.roles | english-writer、chinese-writer、reading-editor、independent-verifier 分别选择；暂不用 Editor 也保留设置 |
| paths.runs/parse/candidates | 本库内输出根目录，每次追加独立 run ID |
| parser.runtime_home | 已有 MinerU 环境 |
| parser.python/config_path | 可选显式路径；否则从运行目录派生 |
| reading.source_language | en 或 zh-CN，指定先写哪种语言，另一语言消费已接受内容 |
| reading.presentation_mode | reading-editor 或 writer |
| writing_skills | 六技能各自明确 enabled；启用时提供 SKILL.md 路径 |

显式模型对象为 `{mode:'explicit',model,reasoning_effort}`，跟随主会话为 `{mode:'follow-main'}`。实际派发需符合当前 Codex 支持的模型组合。配置不是用量、来源或执行授权。

技能键为 nature-writing、nature-polishing、nature-shared、humanizer、humanizer-zh、stss。Nature Writing/Polishing 还要求 Shared。仅选中的指导注入对应语言 Writer；停用项不暗中保留。科学事实、证据和发布边界属于固定合同，不随文风技能关闭。

## 页面与操作

`npm run apa:setup -- page` 生成 `.tmp/apa-setup/index.html`。向导分为概览、六类配置、导入、去除、备份和结果，共11页；每次只显示一页，支持顺序切换或直接跳转，切页保留已填内容。任一配置页都能预览全部选中的修改，生成后自动进入结果页。页面内嵌脚本和样式，不启动后台服务，不向网络发送答案。

- **完善**：填写或修改，预览后生成局部操作。
- **去除**：默认全部，也可选定字段；只移除答案，不删除笔记或卸载依赖。
- **导出**：自定义文件名，导出 apa-config-export-1.0 JSON。可能含个人路径，分享前审阅。
- **导入**：读取导出文件，展示差异再生成操作。未提供字段保留，模型模式整体替换。

下载操作 JSON 与复制同一 JSON 等价。将文件、路径或粘贴内容交给助手并明确要求应用。剪贴板受限时手动选择文本复制。助手应用后回读并报告缺项和依赖。

操作格式为 apa-config-operation-1.0，包含 base_fingerprint 及 patch/remove/import 动作。指纹过期被拒绝。`node scripts/apa-setup.mjs apply --file <操作文件>` 应用；无 --file 时读标准输入。`inspect` 只报告状态，需读取 ready、validation、dependencies，不能把正常退出视作就绪。

`node scripts/apa-setup.mjs export --output <新文件>` 导出答案并拒绝覆盖现有文件。配置导出不包含代码或论文。

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
| `disk.minimum_free_gib` | 安装磁盘要求 |
| `obsidian.plugins` | 可选 Obsidian 集成检查项 |

不得只修改文档声称支持新环境；真实适配与安装需另行实施和验证。

## 发布前命令

已完成候选审查后可准备精确清单；下列检查不替代发布批准：

```powershell
node scripts/v3/bilingual.mjs review --vault-root <vault-root> --run <run> --profile reading-first-obsidian-1.0
node scripts/v3/bilingual.mjs dry-run --vault-root <vault-root> --run <run> --profile reading-first-obsidian-1.0
```

显式全局修复时，技能恢复点在用户目录 `.agents/backups/skills/academic-paper-analysis/<UTC timestamp>`；命令启动器备份在原文件旁，后缀为 `.backup-<timestamp>`。本库配置保存不创建这些全局备份。
