---
name: <!-- FILL: 中文名，例如：网站管理 -->
icon: "<!-- FILL: emoji，例如：🌐 -->"
hidden: false
description: |
  <!-- FILL: 触发条件（最重要）— 用一句话描述"用户说什么/做什么时会用到这个 Skill"
  错误写法："管理网站的 Skill，支持增删改查"（功能列表）
  正确写法："Use when user wants to add, delete, or inspect a website/domain on a VPS" -->
category: <!-- FILL: docker | web | database | system | custom -->
tags:
  - <!-- FILL: tag1 -->

inputs:
  <!-- FILL: 列出用户启动时需要填的参数。没有输入参数则删除整个 inputs 块 -->
  - name: <!-- FILL: snake_case 参数名 -->
    label: <!-- FILL: 中文标签 -->
    type: string <!-- FILL: string | select | boolean -->
    required: true
    placeholder: <!-- FILL: 示例值 -->
---

# <!-- FILL: Skill 名 -->

## Always Read
<!-- FILL: 列出每次执行都必须读的文件（通常是 rules/constraints.md） -->
- rules/constraints.md

## Common Tasks

<!-- FILL: 覆盖所有主要用户意图，每行一个场景 → workflow 映射 -->
| 用户意图 | 读取 workflow |
|---------|--------------|
| <!-- FILL: 场景描述，例如：添加新网站 --> | <!-- FILL: workflows/add.md --> |
| <!-- FILL: 场景描述 --> | <!-- FILL: workflows/delete.md --> |

## Known Gotchas

<!-- FILL: 2–5 条非显而易见的坑，一行一条，详细内容放 references/gotchas.md -->
1. <!-- FILL: 坑点简述 -->