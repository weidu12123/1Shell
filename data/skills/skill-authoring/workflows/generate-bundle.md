<!-- smoke-test: meta-workflow -->
# Workflow: Generate Bundle — 组合创作 Program + companion L2 Skill

本 workflow 生成配套组合：一个长驻 Program + 一个绑定它的 companion 1Shell Skill Extension。

适用场景：用户的需求是“持续监控 + L1 失败后需要受约束的 AI 诊断/维护”。

## 执行顺序（严格）

### Step 1 · 规划

读完用户需求后，用 `render_result format=keyvalue level=info` 列出：

```
- 产物组合：Program + companion L2 Skill
- Program ID：<prog-id>（kebab-case）
- Companion Skill ID：<prog-id>-maintenance 或 <domain>-maintenance
- Program 绑定主机：<...>
- 触发：cron ... + manual
- L1 steps：<确定性步骤列表>
- L2 dispositions：unresolved / out_of_scope / risk_too_high / needs_human_decision / suspected_incident 的触发条件
- L3：仅通过 request_l3_escalation 请求，不直接执行高权限动作
```

### Step 2 · 先创建 companion Skill

顺序很重要：先写 Skill 再写 Program，这样 Program 的 `l2.skill` 指向的 id 从一开始就存在，避免 Program 启用时加载失败。

目录：`data/skills/<skill-id>/`
- SKILL.md
- rules/constraints.md
- workflows/repair.md
- workflows/escalate.md
- references/domain.md

Skill 必须写清：
- 适用 Program / step 类型
- 低风险修复范围
- 禁止操作
- 各 disposition 的判断条件
- 何时调用 `request_l3_escalation`
- 结果说明格式

### Step 3 · 再创建 Program

切到 `workflows/generate-program.md` 的流程，关键点：

- `l2.skill: <刚刚创建的 skill-id>`
- `on_fail: repair`
- `l3.skills: [guardian-protocol]`
- `l3.require_confirmation: true`
- 每个 action 最后有 render step
- 普通 `unresolved` 只渲染说明，不自动进入 L3
- 高风险/需人工/疑似事故由 L2 请求 L3，而不是直接执行 L3 动作

### Step 4 · 统一成功反馈

两者都写入后用一个 `render_result format=keyvalue level=success`：

```
title: "Bundle 创建成功"
items:
  - key: Program
    value: "<name> (data/programs/<prog-id>/program.yaml)"
  - key: Companion Skill
    value: "<name> (data/skills/<skill-id>/)"
  - key: 绑定关系
    value: "program.l2.skill = <skill-id>"
  - key: 启用方式
    value: "在程序页找到该 Program，先单台主机手动触发 smoke test"
```

### Step 5 · 保持对话

用 `ask_user type=input`：
- title: "还要调整什么？"
- placeholder: "例如：L2 增加一种 unresolved 分类 / Program 改成每小时..."

用户指示调整时，明确他想改哪个产物：
- 提到“诊断/修复/约束/升级” → 改 `data/skills/<id>/`
- 提到“cron/主机/step/触发/render” → 改 `data/programs/<id>/program.yaml`

## 命名约定

如果用户没指定 id，用这个规则生成：

- Program id：反映“监控什么”（`cert-monitor`、`disk-watch`、`nginx-health`）
- Companion Skill id：`<program-id>-maintenance` 或 `<domain>-maintenance`

## 反模式（不要做）

- 把 companion Skill 写到 `data/playbooks/`，或创建任何独立 Playbook 产物
- 把 Claude Code Skill 和 1Shell runtime Skill 混在 `data/skills/`
- Program 的 `l2.skill` 指向不存在的 Skill id
- 先写 Program 后写 Skill（启用时会失败）
- 为了“凑齐 bundle”强行加 companion Skill；纯确定性 Program 可以只使用 L1 + render
- 把运行时维修手册塞进 program.yaml，而不是写到 companion Skill 的 rules/workflows/references
