---
name: Program 创作规范
icon: "⚙️"
hidden: true
description: |
  Use this skill when creating or modifying program.yaml files. Enforces
  reliability constraints via rules/: correct metric commands, mandatory
  on_fail: escalate, guardian configuration, and verify standards.
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
- rules/constraints.md        ← **必须先读**，所有规则以此为准

## Common Tasks

| 用户意图 | 读取 |
|---------|------|
| 创建新 program.yaml | rules/constraints.md → workflows/generate.md |
| 修改已有程序（edit-program 模式） | rules/constraints.md → workflows/edit.md → references/edit-examples.md |
| 排查生成错误 | references/antipatterns.md |

## Known Gotchas

1. `top -bn1` 跨发行版输出格式不一 → 用 `/proc/stat` 或 `awk '/proc/meminfo'`
2. `on_fail: stop` = 静默死亡 = 永远不得出现在生产程序
3. `guardian.enabled` 字段引擎**未实现** → 不要写
4. `verify` 只写 `exit_code: 0` = 没有验证 → 必须加 `stdout_match`
5. 写完不要把 `enabled` 改成 `true`，让用户在 UI 里按实例启用