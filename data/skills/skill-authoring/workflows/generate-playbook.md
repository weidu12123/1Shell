<!-- smoke-test: meta-workflow -->
# Workflow: Generate Playbook — 创作确定性剧本

本 workflow **只**负责生成 `data/playbooks/<id>/` 下的**一次性确定性程序**。

> 如果任务需要 AI 根据运行时结果决策、有破坏性操作、步骤不能预写死——那是 Skill，
> 请改走 `workflows/generate-skill.md`。本 workflow 专治"步骤固定、命令能写死"的场景。

## 什么时候用本 workflow

- classify workflow 推荐 `Playbook`
- 用户明确选了"创作 Playbook"
- 任务特征全部命中：
  - 步骤顺序固定、每条命令能事先写死
  - 以信息采集 / 状态查询 / 批量列表为主
  - 命令参数**不**依赖用户输入动态拼接
  - 错误场景少且可预判

## Playbook vs playbook.yaml

Playbook 可以选两种执行方式：

| 方式 | 何时选 | 产出文件 |
|------|--------|---------|
| L1 确定性执行（零 token） | 所有步骤能写死 | `playbook.yaml` |
| AI-loop（有 AI 介入） | 少数步骤需要 AI 判断 | `workflows/main.md` |

**多数场景选 playbook.yaml**——这是 Playbook 的核心价值。只有在"明明是 Playbook 但
偶尔要 AI 临场判断"的边缘场景才用 workflow 形式（且大多数时候那说明应该拆成 Skill）。

## 第一步：理解需求 + 探测环境

读用户 `task`。如有远端 VPS 主机，用 `execute_command` 加 `host_id` 探测（最多 3 条，只读）。

Windows 本机时不要探测本机环境，按通用 Linux 惯例生成。

## 第二步：选定执行模式并展示方案

用 `render_result format=message level=info` 1-2 句话说明：

```
Playbook ID：<kebab-case>
执行模式：⚡ Playbook（playbook.yaml 确定性执行，0 token）
包含 Step：N 个（含 M 个 render step）
```

## 第三步：并行写入文件

### playbook.yaml 模式（主推）

```
data/playbooks/<playbook-id>/
  SKILL.md              # frontmatter 描述 + Common Tasks 指向 playbook.yaml
  playbook.yaml         # 完整步骤定义（见 references/playbook-schema.md）
  rules/
    constraints.md      # 可选：安全约束
```

### AI-loop 模式（边缘场景）

```
data/playbooks/<playbook-id>/
  SKILL.md
  rules/constraints.md
  workflows/main.md
```

**用 `write_local_file` 并行写**，不要用 `execute_command + node`。

## 第四步：SKILL.md frontmatter

```yaml
---
name: <中文名>
icon: "<emoji>"
hidden: false
description: |
  <一句话英文描述>
category: <docker|web|database|system|custom>
tags:
  - <tag1>

inputs:                  # Playbook 的 inputs 会被 ${inputs.xxx} 插值到 playbook.yaml 的 run
  - name: <snake_case>
    label: <中文>
    type: string | select | boolean
    required: true
    placeholder: ...

# Playbook 固有字段（runner 识别）
hasPlaybook: true        # 可选，registry 会自己根据 playbook.yaml 存在自动探测，但写着清晰

# 如需要 L2 救援（失败时 AI 介入），可选绑定 Rescue Skill
referencedSkills:
  - <rescue-skill-id>    # 可选
---

# <Playbook 名称>

## Always Read
- rules/constraints.md   # 可选

## Common Tasks

| 用户意图 | 读取 |
|---------|------|
| 执行本剧本 | playbook.yaml |
```

## 第五步：playbook.yaml 规范

参考 `references/playbook-schema.md`。关键点：

- `goal` 必填（Rescuer 介入时会读到）
- 每个 step 的 `id` 必须唯一且符合 `^[a-zA-Z_][a-zA-Z0-9_]*$`
- `verify` 尽量精确：加 `stdout_match` 或 `stdout_contains` 防止"命令返回 0 但业务失败"
- 用 `${inputs.xxx}` 插值用户输入

### render step 输出格式规范（必须遵守）

最后必须加一个 `type: render` step 展示结果，格式按展示内容选择：

| 展示什么 | 用 format | 示例场景 |
|---------|----------|---------|
| 多行对象（网站列表、容器列表）| `table` + `columns` + `rows_from_step` | 网站列表、进程列表 |
| 单对象详情 | `keyvalue` + `items_from_steps` | 容器详情、VPS 状态 |
| 操作结果通知 | `message` + `level` | 删除成功、错误报告 |
| 配置文件内容 | `code` + `language` | nginx.conf 预览 |

**禁止**用 `format=message` 展示应该是表格的数据。

### rowActions 配置规范（关键！）

如果表格里的每一行需要触发操作（删除、重启、配置等），必须配置 rowActions 和 rowActionSkill。

**必须先检查 rowActionSkill 对应的 Skill 是否存在：**
```bash
# 先用 execute_command 确认目标 Skill 存在
ls data/skills/<skill-id>/SKILL.md
```

只有 Skill 存在时才能设置 `rowActionSkill`。如果不存在：
- 选项 A：提示用户"需要先创建 XXX Skill，再来配置 rowActions"
- 选项 B：告知用户改用 AI 工具（Skill）模式，在同一会话中处理列表+操作

table 格式 + rowActions 完整示例：
```yaml
- id: render_sites
  type: render
  format: table
  title: 网站列表
  columns: ["域名", "端口", "HTTPS", "站点目录"]
  rows_from_step: extract_sites   # 该 step 的 stdout 按 tab 分列
  rowActions:
    - label: "删除"
      value: "delete"
  rowActionSkill: vps-website-delete   # ← 必须是存在的 Skill id
  rowInputKey: domain                   # ← 第一列传给 Skill 的参数名
```

**rowActionSkill 不存在时绝不能设置此字段！** 点击按钮时会报错"Skill不存在"。

## 第六步：结果展示 + 保持对话

```
render_result format=message level=success

Playbook「<name>」创建成功

路径：data/playbooks/<id>/
文件：SKILL.md · playbook.yaml · rules/constraints.md

执行：
- 在"剧本库"页找到「<name>」→ 填参数 → 运行
- 或从 row_action_skill 触发
```

然后 `ask_user type=input`：
- title: "还要调整什么？"
- placeholder: "例如：步骤 2 改成... / 加一个输入参数..."

## 常见错误（写完自检）

- [ ] ❌ 在 `data/playbooks/` 下用 Skill 结构（SKILL.md + rules/ + workflows/ 但没 playbook.yaml）
      → 如果真的要走 AI-loop，workflows/ 里至少要有一个文件
- [ ] ❌ playbook.yaml 里用了 `${inputs.xxx}` 但 SKILL.md 没定义这个 input
- [ ] ❌ 破坏性命令（rm -rf、docker rm -f）写死在 step 里没二次确认
      → 带破坏性应该改走 Skill（让 AI 有机会 ask_user）
- [ ] ❌ verify 只写 `exit_code: 0`，没有 stdout_match，会漏掉"返回 0 但业务没跑"
- [ ] ❌ step id 含连字符或从数字开头（会 schema 校验失败）
- [ ] ❌ render step 用 `message` 展示应该是表格的数据（多行列表必须用 `table`）
- [ ] ❌ table 格式 step 没有写 `columns` 字段
- [ ] **Task Closure Protocol**：AAR 完成，Rationalizations 检查，Red Flags 清零