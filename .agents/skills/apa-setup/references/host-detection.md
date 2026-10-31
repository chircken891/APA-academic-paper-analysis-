# 宿主检测与进阶能力参考

基础配置流程见[配置技能](../SKILL.md)。本页按需查阅；现有档案格式保持兼容。

## 1. 检测自身环境，写成宿主档案

你要报告的是“我此刻能用什么”，不是“APA 过去用什么”或“这个产品一般支持什么”。只写你能在当前会话里核实的内容，不要凭记忆补全。缺少证据时保留 `unavailable` 或 `unknown`。基础配置只调查所需的宿主派发和模型条件；进阶能力在用户选择使用时按需补查。

依次确定：

- **宿主**（`host`）：你运行的环境标识，依据系统提示或环境说明。
- **当前会话**（`session`）：主会话的模型标识和推理强度。系统上下文或宿主配置里写明了才填，否则填 `null`。
- **派发工具**（`dispatch`）：在你自己的工具列表里找能启动独立子代理的工具。工具定义需要先加载时，先加载再读。记录工具的确切名称，以及以下参数的确切名称。参数名只能取自本会话实际暴露的工具定义；工具源码、文档或其他配置里存在、但本会话的定义中没有的参数，一律视为不存在，只在 `notes` 里说明。宿主收到未知参数时常常静默丢弃，填进去的参数看似有效，实际不起作用。
  - `model_argument`：选择模型的参数。工具定义里没有这个参数、子代理只能沿用主会话时，填 `null`。
  - `effort_argument`：选择推理强度的参数；工具没有这个参数时填 `null`。`model_argument` 为 `null` 时它也必须为 `null`，因为子代理连推理强度也一并沿用主会话。
  - `instruction_argument`：传递完整任务正文的参数。
  - `task_name_argument`：任务名或描述参数；没有则填 `null`。
  - `fresh_context`：怎样保证子代理不继承主会话历史。工具用某个参数控制继承时，填 `{argument, value}`，`value` 是“完全不继承”的取值；新调用本来就从空白上下文开始时填 `null`。不要把会复制主会话历史的分叉方式当作新上下文。

  找不到能独立派发的工具时，`dispatch` 填 `null`。
- **可用模型**（`models`）：只列派发工具实际能接受的模型。`model_argument` 为 `null` 时，派发工具不接受任何模型选择，`models` 填空数组，所有角色只能“跟随主会话”；主会话用的是什么模型，写在 `session` 里。来源按可靠程度依次为：工具定义里的枚举值（`tool-schema`）、用户为本宿主配置的文件（`host-config`，如宿主配置或模型目录文件；只读取，不复制密钥、令牌或认证内容）、宿主官方文档（`host-docs`）。每个模型写出派发工具对它可用的推理强度档位，不支持推理强度时写空数组。档位只能取 `none minimal low medium high xhigh max ultra` 中的值；宿主用别的叫法时，在 `notes` 里写明对应关系，对应不上的不填。无法列举时 `models` 填空数组，来源写 `unavailable`。

重复自检时，先读取当前项目已保存配置、归属明确的旧宿主档案，以及 `config/backups/<owner>/` 中的自有适配说明和入口；旧档案按其已知路径读取，不按时间最新一份直接认定归属。核对当前工具定义、宿主版本、实际生效设置与入口是否变化。有效的自有补丁继续复用，将仍有效的 `capabilities`、`achievement` 和 `adapters` 声明及来源纳入本次档案；仅针对变化、缺失或失效项补充调查，必要时新建独立补丁。不得因再次自检而丢弃已有成果、重复安装或从头重建全部适配。旧档案缺少达成方式时补充该项证据，不将其他有效项一并重做。

**自检和宿主设置只针对当前运行的宿主。** 归属以本次档案的 `host` 和 `owner` 为准。已保存配置的 `host` 段，以及 `config/backups/<其他 owner>/`、`.tmp/apa-setup/<其他 owner>/` 下的档案、备份和执行记录，都只说明那个宿主的历史。它们不能当作当前宿主的设置、检测结果或生效证据，也不能当作复用起点。用户问起某项设置是否生效时，只查当前宿主的有效配置：先从运行时环境确认它实际的家目录和数据目录（例如宿主声明的环境变量或运行时路径），不能凭记忆默认旧目录。查不到用户说的值时，如实报告“未找到”，先核对本次页面、操作 JSON（包括 `host_settings`）和应用记录有没有把它漏掉，再问用户是在哪里设置的。不得把数值相近或同名的其他宿主记录认定为用户的那次设置，也不得据此纠正用户的说法。必须引用其他宿主的记录时，写明所属宿主，并说明它对当前宿主不起作用。

检测只能读取，不能调用模型试探可用性，不能安装任何东西，也不能修改宿主设置。为每次检测选用未存在的 `.tmp/apa-setup/<owner>/<detection-id>/` 目录，`owner` 和 `detection-id` 使用 kebab-case，并确认不会碰撞已有目录；将结果写入该目录的 `host-profile.json`。检测完成后另存一份到 `config/backups/<owner>/host-profiles/<host>-<detection-id>.json`（不覆盖已有文件）；重复自检先读该目录同宿主的档案作为复用起点，只对变化项重查。旧档案仍可读取，不迁移或覆盖。本次报告说明复用项、变化项和仍未核实项；新报告目录不表示需要新建补丁。以下是档案格式：

```json
{
  "schema_version": "apa-host-profile-1.0",
  "host": "<host>",
  "detected_at": "2026-10-27T12:00:00Z",
  "session": { "model": "<session-model>", "reasoning_effort": null },
  "models": [
    { "model": "<model-1>", "reasoning_efforts": [] },
    { "model": "<model-2>", "reasoning_efforts": [] }
  ],
  "dispatch": {
    "tool": "<dispatch-tool>",
    "model_argument": "<model-argument>",
    "effort_argument": null,
    "instruction_argument": "<instruction-argument>",
    "task_name_argument": "<task-name-argument>",
    "fresh_context": null
  },
  "sources": { "session": "system-context", "models": "tool-schema", "dispatch": "tool-schema" },
  "notes": ["<检测限制>"]
}
```

示例只说明格式，不能照抄；每个值都要来自你自己的检测。档案结构见 `Schema/config/apa-config.schema.json` 的 `hostProfile`，CLI 读取档案时会校验，格式不符就停止。

### 检测并给出达成方式

在同一档案的可选 `capabilities` 中记录当前宿主按需进行的六项能力只读检查，供 `inspect` 和配置页显示。对每项写 `status`（`detected`、`blocked`、`unsupported` 或 `unknown`）、可操作的 `method`、作用范围 `scope`（`current-session`、`new-session`、`instance` 或 `unknown`）、带来源和具体位置的 `evidence`，以及 `limitations`。证据来源可为 `tool-schema`、`system-context`、`host-config`、`runtime-log`、`installed-software`、`local-code`、`host-docs`；不要仅因产品名称推断支持。

**调查来源。** 可在 `investigation.searched` 记录实际采用的来源，按需要选择以下七类来源中的条目 `{source, location, result, note}`，`result` 为 `found`、`absent` 或 `not-applicable`；`found`/`absent` 必须写出实际查过的 `location`，`not-applicable` 在 `note` 说明本宿主为何没有这类来源：

- `tool-schema`：本会话实际暴露的工具定义及参数。
- `system-context`：系统提示、环境说明中写明的宿主事实。
- `host-config`：宿主的用户级与项目级设置文件（只读，不复制凭据）。
- `runtime-log`：宿主本机的会话记录、事件日志或转录文件中的实际行为痕迹。
- `installed-software`：已安装宿主程序的版本、`--help` 输出、安装目录中的代码或说明。
- `local-code`：本仓库代码、`scripts/setup/` 中的现有工具。
- `host-docs`：宿主官方文档。

进阶能力未记录、缺少达成方式或仍为未知时，保留具体限制；这些情况不阻止基础配置页面。仅在用户选择使用该能力时核实必要前置条件。不能将静态调查写成真实模型、压缩或恢复验收。

对每项能力自行调查并记录可选 `achievement`：`state` 为 `achieved`、`needs-setting`、`needs-user-action`、`needs-apa-change` 或 `not-found`，另写一句 `summary` 和 `steps`。`not-found` 写明查过的位置和缺少的依据；公共接口确实缺失时使用 `needs-apa-change`，说明缺口。`achieved` 表示静态条件已具备，实际验证仍为 `not_run`。旧档案缺少 `achievement` 时提示重新检测，原有 `ready` 含义不变。

每个步骤必须记录 `actor`（`apa`、`script` 或 `user`）、`instruction`、`command`（字符串或 `null`）、`scope`（`current-session`、`new-session`、`instance`、`project-settings`、`user-settings` 或 `unknown`）、`persistent`、`verify` 和 `evidence`（每项含 `source` 与 `reference`）。可选 `adapter_id` 和 `range`；后者包含 `min`、`max`（数值或 `null`）及 `unit`（`tokens`、`ratio` 或 `percent`）。`threshold_compaction` 的非空 `step.command` 必须同时包含 `<N>` 并提供 `range`，否则屏蔽该命令；`effective_target_verified` 为 `false` 时屏蔽该能力的命令。只读调查命令写入 `instruction`、`verify` 或 `evidence`，`step.command` 可为 `null`。`range` 的单位是命令参数单位；页面根据用户输入的 token 候选值及已核实的公式换算，未知值保持未知，不填历史值。

先只读检查已有适配的归属及证据。可验证复用有效的自有补丁；需要新补丁时，只在 `config/backups/<owner>/adapters/<adapter-id>/` 新建独立目录，`owner` 为 agent 归属标识，`owner` 和 `adapter-id` 使用 kebab-case，避免与已有目录碰撞；依据 agent 身份及归属证据确定 `owner`，不从所选模型推断。说明须记录所属 agent、宿主、入口、用途、证据和验证方法。其他 agent、归属不明以及既有适配和脚本只读保留，不覆盖、改造、重命名或移动；自适配不修改公共核心。档案可选 `adapters` 数组，项含 `id`、`owner`、`host`、`root`、`entrypoints` 和 `evidence`；`root` 严格为上述归属目录，`entrypoints` 是该目录内非空相对路径数组，`evidence` 记录来源位置。`inspect` 只检查宿主一致、目录归属结构及入口存在与路径范围，显示 `available` 或 `blocked`，不执行入口，也不证明身份或实际效果。既有适配保留原路径，既存个人档案不自动重写。

补丁源码的准备与启用、写入宿主设置分开。宿主设置使用现有工具 `node scripts/setup/apa-host-settings.mjs plan|apply --host <host> --capability threshold_compaction|compact_hook ...`：`plan` 只读，展示目标文件、键和值；`apply` 须 `--confirm`，写入后回读；工具不保留宿主设置文件的备份，也不提供回滚命令，写入前须让用户核对 `plan` 展示的改动。工具已支持的宿主，阈值和压缩钩子的达成方式应写成调用该工具的步骤，不得因档案缺少命令模板就报“未找到”。只修改用户选定的设置，未选择的值保持占位。检测不修改宿主设置，也不启动模型试验。

根据实际使用范围检查并报告：

1. `on_demand_reading`：当前宿主能否读取项目技能及按范围读取文件；核对控制器的按需读取规则。规则存在不能证明模型在真实运行中遵守。
2. `delegated_diagnostics`：实际派发工具、任务参数、独立上下文和可用回执；当前工具定义缺失时不能借用其他宿主的参数。
3. `manual_compaction`：当前会话是否有手动压缩入口、作用范围以及是否持久修改设置。技能中的阶段提示不等于宿主已执行压缩。
4. `concise_replies`：核对角色请求是否携带 `role-reply-1.0`，短回执的实际遵守情况仍须真实观察。
5. `science_recovery`：核对本库已保存的派发声明与本次检测一致，并检查 `dispatch.result_handle` 是否与真实派发结果匹配、查询或等待工具与参数是否明确，以及原宿主是否仍可访问；上述条件均成立才可标记 `achieved`。尚未保存时报告需要配置，继续第 4、5 步由用户选择和确认，不自行保存。代理依据真实宿主格式编写文本正则，提取第一捕获组；查不到时记录 `not-found`。已配置 `host` 的新科学请求仅在已保存的 host 段声明 `dispatch.result_handle` 时从派发结果文本提取真实句柄，否则记为 `null`；本地 `action_id` 不是可查询的宿主句柄，缺少真实句柄时自检报告该续接为 `blocked`。控制器不主动查询或等待宿主，本地持久化只覆盖控制器退出后原宿主仍可访问的情况，不证明宿主重启恢复。
6. `threshold_compaction`：核对**实际启用的压缩后端**、覆盖方法与参数单位、作用于当前会话还是新会话或整个实例、计量口径及阈值约束。记录用户指定的候选 token 数、上下文窗口 W、输出预留 O、压缩余量 headroom、保留预算 retained 和参数允许的上下限；未知值填 `null`，不能当作 0。`formula` 按证据选择绝对 token 触发 `absolute`、比例并受上限约束 `window-ratio-bounded` 或 `unknown`；公式必须与单位相符。对比例阈值，仅在已确认宿主公式与各值时换算并检查参数范围及取整。

阈值检测按现场安装版本、实际生效的后端及作用域核实，确认候选值的换算依据后再展示操作；无法核实有效目标时报告阻塞，不更换模型或覆盖其他设置绕过。

以下仅为档案内的未知项格式片段，不是检测结果或可直接使用的完整档案；核实后再填写具体值。`recovery` 和 `threshold` 的字段均属于检测证据，不进入个人配置答案：

```json
{
  "capabilities": {
    "science_recovery": {
      "status": "unknown", "method": null, "scope": "unknown", "evidence": [], "limitations": [],
      "recovery": { "task_handle_path": null, "lookup_tool": null, "lookup_argument": null, "original_host_accessible": null }
    },
    "threshold_compaction": {
      "status": "unknown", "method": null, "scope": "unknown", "evidence": [], "limitations": [],
      "threshold": {
        "candidate_tokens": null, "unit": "unknown", "formula": "unknown", "setting": null,
        "setting_min": null, "setting_max": null, "effective_target_verified": null,
        "context_window_tokens": null, "output_reserve_tokens": null, "headroom_tokens": null,
        "retained_tokens": null, "measurement": null
      }
    }
  }
}
```

`effective_target_verified` 只表示是否已核实覆盖指向启用的后端，不表示实际压缩已发生。自检不修改宿主设置，也不启动宿主或模型；真实试验及应用阈值须另获明确授权，并保留压缩事件、计量口径和压缩后关键信息的验证结果。

