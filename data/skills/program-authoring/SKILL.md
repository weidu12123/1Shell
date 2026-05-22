---
name: Program 创作规范
icon: "⚙️"
hidden: true
description: |
  Use this skill when creating or modifying 1Shell Programs. A Program is a
  complete product artifact: data/programs/<id>/program.yaml plus ui/manifest.json,
  ui/App.jsx, ui/style.css, and ui/DESIGN.md. Enforces reliability constraints,
  L2/L3 boundaries, render output, UI artifact safety, and sandbox preview gates.
category: system
tags:
  - authoring
  - program

inputs:
  - name: task
    label: 你想创建什么程序？
    type: string
    required: true
    placeholder: 例如：每分钟采集 VPS 的 CPU / 内存 / 磁盘，超阈值告警

  - name: target_id
    label: 目标 Program ID（改进时填）
    type: string
    required: false
    placeholder: 例如：vps-metrics-collector
---

# Program 创作规范

## Always Read
- rules/constraints.md        ← **必须先读**，Program YAML 与 UI artifact 规则都以此为准

## Common Tasks

| 用户意图 | 读取 |
|---------|------|
| 创建新 Program | rules/constraints.md → workflows/generate.md |
| 修改已有程序（edit-program 模式） | rules/constraints.md → workflows/edit.md → references/edit-examples.md |
| 排查生成错误 | references/antipatterns.md |

## Known Gotchas

1. Program 不是单个 `program.yaml`；新建/重构必须同时交付 `ui/manifest.json`、`ui/App.jsx`、`ui/style.css`、`ui/DESIGN.md`
2. `top -bn1` 跨发行版输出格式不一 → 用 `/proc/stat` 或 `awk '/proc/meminfo'`
3. `on_fail: stop` = 静默死亡 = 永远不得出现在生产程序
4. `guardian.enabled` 字段引擎**未实现** → 不要写
5. `verify` 只写 `exit_code: 0` = 没有验证 → 必须加 `stdout_match`
6. 写完不要把 `enabled` 改成 `true`，让用户在 UI 里按实例启用
7. 多 action 程序仍要维护 `ui.instance_actions`，但主体验必须由 UI artifact 在 sandbox iframe 中渲染
8. `App.jsx` 只能通过 `window.$oneShell` bridge 调用能力，不能直接 `fetch('/api/...')` 或访问父窗口 DOM
9. `validate-program.js` 的 `ui_artifact_check` 与 `sandbox_preview_check` 失败时不得进入 done
