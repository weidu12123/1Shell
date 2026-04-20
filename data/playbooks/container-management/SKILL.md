---
name: 容器管理
icon: "\U0001F433"
hidden: true
description: This skill should be used when the user wants to list, inspect, start, stop, restart, remove Docker containers, or view container logs on a remote host.
category: docker
tags:
  - Docker
  - 容器
  - Container
inputs:
  - name: action
    label: 操作
    type: select
    required: true
    default: list
    options:
      - value: list
        label: 列出所有容器
      - value: status
        label: 查看容器详情
      - value: start
        label: 启动容器
      - value: stop
        label: 停止容器
      - value: restart
        label: 重启容器
      - value: logs
        label: 查看容器日志
      - value: remove
        label: 删除容器
  - name: container
    label: 容器名称或 ID
    type: string
    required: false
    placeholder: 留空则对所有容器操作
    visibleWhen:
      field: action
      value:
        - status
        - start
        - stop
        - restart
        - logs
        - remove
  - name: tail_lines
    label: 日志行数
    type: string
    required: false
    default: "100"
    placeholder: "100"
    visibleWhen:
      field: action
      value: logs
---

# 容器管理 Skill

## Always Read
- rules/constraints.md

## Common Tasks

| 用户意图 | 读取 |
|---------|------|
| 列出容器 | workflows/list.md |
| 查看容器详情 / 资源占用 | workflows/inspect.md |
| 启动 / 停止 / 重启容器 | workflows/lifecycle.md |
| 查看容器日志 | workflows/logs.md |
| 删除容器 | workflows/remove.md |
| Docker 未安装或无法连接 | references/gotchas.md |
| 其他/未列出任务 | references/gotchas.md 然后自行判断 |

## Known Gotchas
1. **Docker 未安装或 daemon 未运行** → 先检测，给修复建议，详见 references/gotchas.md
2. **权限问题**：用户不在 docker 组 → 需要 sudo，详见 references/gotchas.md
3. **保护容器**：不得操作名称含 "1shell" 的容器

## 工具使用模式
- 执行命令 → `execute_command`
- 展示结构化成果 → `render_result`（用户只能看到 render_result 渲染的内容）
- 需要用户选择/确认 → `ask_user`