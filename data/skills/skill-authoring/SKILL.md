---
name: 创作台
icon: "✍️"
hidden: true
description: |
  Use when the user wants to create or refine a 1Shell artifact:
  Program (scheduled/manual L1 automation), AI Tool/Skill (interactive operation),
  or Bundle (Program + companion L2 Skill). Classifies intent, then routes to the correct generator.
category: system
tags:
  - authoring
  - program
  - skill
  - bundle

inputs:
  - name: task
    label: 你想做什么？
    type: string
    required: true
    placeholder: 例如：每 5 分钟监控证书过期；自动备份数据库；检测异常进程…

  - name: mode
    label: 产物类型
    type: select
    required: true
    default: classify
    options:
      - value: classify
        label: 让 AI 先推荐（默认）
      - value: create-program
        label: Program · 长驻守护程序
      - value: create-skill
        label: AI 工具 · 用户主动触发的交互操作
      - value: create-bundle
        label: Bundle · Program + companion L2 Skill 组合
      - value: refine
        label: 改进已有产物
      - value: explain
        label: 解释某个产物的结构

  - name: target_id
    label: 目标 ID
    type: string
    required: false
    placeholder: 例如：vps-health
    visibleWhen:
      field: mode
      value: [refine, explain]
---

# 创作台

## Always Read
- rules/constraints.md
- rules/task-closure.md
- references/tool-api.md

## Common Tasks

| `mode` | 读取 workflow |
|--------|--------------|
| `classify` | `workflows/classify.md` |
| `create-program` | `workflows/generate-program.md` |
| `create-skill` | `workflows/generate-skill.md` |
| `create-bundle` | `workflows/generate-bundle.md` |
| `refine` | `workflows/refine.md` |
| `explain` | `workflows/explain.md` |

## Known Gotchas

1. **AI 工具 vs companion L2 Skill**：AI 工具是用户主动触发的交互操作；companion L2 Skill 只约束 Program 失败后的维护边界
2. `data/skills/` 下绝对禁止 `playbook.yaml`；确定性步骤归入 Program L1/action
3. ID 一律 `kebab-case`，字母开头
4. 写入前先 `execute_command ls data/<type>/<id>/` 确认无同名
5. 所有 generate workflow 最后必须 `ask_user type=input` 等追问
