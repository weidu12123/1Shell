# 1Shell Skill 格式规范

## 目录结构

一个 Skill 是 `data/skills/<skill-id>/` 下的文件夹，最小结构：

```
data/skills/<skill-id>/
  SKILL.md              必须 — 元数据 + 任务路由表
  workflows/
    <task>.md           至少一个 — 具体任务的执行指令
  rules/
    constraints.md      推荐 — 安全约束与禁止操作
  references/           可选 — 领域知识、命令参考
```

---

## SKILL.md 完整格式

```yaml
---
name: 人类可读名称（中文）
icon: "🔧"            # 单个 emoji
hidden: false          # true = 不在 Skill 列表显示（内部工具用）
forceLocal: false      # true = 固定在本机（1Shell 宿主）执行，忽略用户选择的目标主机
description: |
  一句话描述这个 Skill 解决什么问题。
  用英文写，AI 会用它判断"当前任务是否适合用这个 Skill"。
category: system       # system | docker | web | database | custom
tags:
  - 关键词1
  - 关键词2

# 用户运行前填写的表单字段
inputs:
  - name: field_name       # 程序内部名，snake_case
    label: 显示标签         # 界面上显示给用户的名称
    type: string           # string | select | boolean
    required: true
    placeholder: 提示文字
    default: ""            # 可选默认值

  - name: mode
    type: select
    required: true
    default: list
    options:
      - value: list
        label: 列出
      - value: delete
        label: 删除

  - name: confirm
    type: boolean
    label: 我已确认操作
    required: false
    # visibleWhen 控制字段的显示条件
    visibleWhen:
      field: mode
      value: delete          # 也可以是数组: [delete, force-delete]
---

# Skill 名称

## Always Read
- rules/constraints.md     # 每次运行都要读的文件，列在这里

## Common Tasks

| 用户意图 | 读取 |
|---------|------|
| 查看/列出 | workflows/list.md |
| 创建/部署 | workflows/create.md |
| 删除/清理 | workflows/delete.md |
| 其他情况 | references/gotchas.md 然后自行判断 |

## Known Gotchas
1. 这里列出该领域最常见的坑，AI 会优先参考
```

---

## workflows/*.md 格式

workflow 文件是给 AI 的执行指令，用自然语言 + 伪代码写：

```markdown
# 任务名称

## 前置检查
- 先用 execute_command 检查 xxx 是否存在
- 如果 yyy 失败，说明 zzz，用 ask_user 告知用户

## 执行步骤
1. execute_command: `实际命令`
2. 解析输出，判断是否成功
3. 如果需要确认：ask_user type=confirm

## 结果展示
用 render_result 展示，format=table/keyvalue/message

## 错误处理
- 如果 exitCode !== 0：render_result level=error，说明原因
```

**关键原则**：
- workflow 描述"做什么"，不要写死具体命令（由 AI 根据实际环境生成）
- 需要用户选择时用 `ask_user`，不要静默执行破坏性操作
- 每个重要步骤都要 `render_result` 让用户知道进展

---

## rules/constraints.md 格式

```markdown
# 安全约束

## 禁止操作
- 禁止 rm -rf /
- 禁止操作名称含 "1shell" 的资源（系统保护）
- 禁止修改 /etc/passwd、/etc/shadow

## 必须确认再执行
- 删除操作：必须先 ask_user type=confirm danger=true
- 生产环境写操作：必须先说明影响范围

## 降级策略
- 命令失败时优先报告错误，不要自动重试破坏性操作
- sudo 权限不足时提示用户，不要尝试提权
```

---

## inputs 字段 type 说明

| type | 渲染形式 | 说明 |
|------|---------|------|
| `string` | 单行文本框 | 最常用 |
| `select` | 下拉选择 | 需要配 `options` |
| `boolean` | 复选框 | 勾选后值为 `true` |

`visibleWhen` 支持：
- `value: "single"` — 单值匹配
- `value: ["a", "b"]` — 多值匹配（任意一个即显示）

---

## 命名约定

| 场景 | 命名 |
|------|------|
| Skill ID（文件夹名）| `kebab-case`，如 `deploy-app` |
| inputs.name | `snake_case`，如 `target_host` |
| workflow 文件 | 动词开头，如 `list.md` / `create.md` / `delete.md` |
| 内部工具（不显示给用户）| `hidden: true` in SKILL.md |
| 固定在本机执行的 Skill | `forceLocal: true` in SKILL.md |