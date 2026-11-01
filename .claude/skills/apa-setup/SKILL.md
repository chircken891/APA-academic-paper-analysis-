---
name: apa-setup
description: Use for APA configuration requests such as 完善配置、为我配置、为某某 agent 配置, which require opening the local HTML for user selection, and for explicit inspection, export or removal, which do not require the page. Not for paper analysis or dependency installation.
---

# apa-setup（Claude Code 入口）

本技能的唯一来源是项目文件 `.agents/skills/apa-setup/SKILL.md`（与 Codex 共用）。先完整读取该文件并按其执行；其中的相对链接以 `.agents/skills/apa-setup/` 为基准解析。宿主差异见仓库根目录 `CLAUDE.md` 的“Claude Code 宿主适配”。

不要修改本入口来改变技能行为；只有源文件的 `name` 或 `description` 变化时才同步这里的 frontmatter。
