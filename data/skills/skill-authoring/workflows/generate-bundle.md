<!-- smoke-test: meta-workflow -->
# Workflow: Generate Bundle — 组合创作 Program + Rescue Skill

本 workflow 生成**配套组合**：一个长驻 Program + 一个绑定它的 Rescue Skill。

适用场景：用户的需求"持续监控 + 出问题自动诊断"，这两者必须一起用才能闭环。

## 执行顺序（严格）

### Step 1 · 规划

读完用户需求后，用 `render_result format=keyvalue level=info` 列出：

```
- 产物组合：Program + Rescue Skill (Bundle)
- Program ID：<prog-id>   （kebab-case）
- Rescue Skill ID：<prog-id>-rescue 或 <domain>-rescue
- Program 绑定主机：<...>
- 触发：cron ...
- Guardian 使用该 Skill：是
```

### Step 2 · 先创建 Rescue Skill

**顺序很重要**：先写 Skill 再写 Program，这样 Program 的 `guardian.skills` 指向的 id
从一开始就存在，避免 Program 启用时加载失败。

切换思路到 `workflows/generate-rescue-skill.md`，但**跳过**它原有"提醒用户绑定"那一步
（因为本 workflow 稍后会自动把 skill id 写进 Program 的 yaml）。

目录：`data/skills/<skill-id>/`
- SKILL.md（`category: rescue`）
- rules/constraints.md
- references/known-issues.md
- workflows/diagnose.md

### Step 3 · 再创建 Program

切到 `workflows/generate-program.md` 的流程，**关键点**：

- `guardian.enabled: true`
- `guardian.skills: [<刚刚创建的 skill-id>]`
- 至少有一个 action 的 `on_fail: escalate`
- `max_actions_per_hour` 设 5-15（太低不够用，太高容易失控）

### Step 4 · 统一成功反馈

两者都写入后用**一个** `render_result format=keyvalue level=success`：

```
title: "Bundle 创建成功"
items:
  - key: Program
    value: "<name> (data/programs/<prog-id>/)"
  - key: Rescue Skill
    value: "<name> (data/skills/<skill-id>/)"
  - key: 绑定关系
    value: "program.guardian.skills = [<skill-id>]"
  - key: 启用方式
    value: "在 /programs.html 找到该 Program，点'启用'+单台主机测试"
```

### Step 5 · 保持对话

用 `ask_user type=input`：
- title: "还要调整什么？"
- placeholder: "例如：Rescue Skill 增加一条 known issue... / Program 改成每小时..."

用户指示调整时，明确他想改哪个产物：
- 提到"诊断/修复/已知坑" → 改 `data/skills/<id>/`
- 提到"cron/主机/step/触发" → 改 `data/programs/<id>/program.yaml`

## 命名约定

如果用户没指定 id，用这个规则生成：

- Program id：反映"监控什么"（`cert-monitor`、`disk-watch`、`nginx-health`）
- Rescue Skill id：`<program-id>-rescue`（清晰表达从属关系）

## 反模式（不要做）

- ❌ 把 Rescue Skill 写到 `data/playbooks/`（应该是 `data/skills/`）
- ❌ Program 的 `guardian.skills` 指向 Playbook id
- ❌ 先写 Program 后写 Skill（启用时会失败）
- ❌ 为了"凑齐 bundle"强行加 Rescue Skill——如果 Program 的 step 很简单且 `on_fail: stop`
  就够用，没必要加 Rescue Skill，可以退回单纯的 `generate-program.md`