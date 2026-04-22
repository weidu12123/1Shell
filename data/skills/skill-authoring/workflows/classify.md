<!-- smoke-test: meta-workflow -->
# Workflow: Classify — 意图分类器

本 workflow 是创作台的**第一道门**：读取用户的自然语言需求，推荐该做成哪种产物。

> **输出必须通过 `render_result format=keyvalue`**，用户看到后才能确认是否按推荐走。
> **不要自己动手写文件**——只推荐，不生成。

## 三种产物的本质区别

| | 何时选 | 写到哪 | 执行方式 |
|---|---|---|---|
| **Program** | 任务要**持续**做、周期性触发、或需要守护 | `data/programs/<id>/` | 启用后常驻，cron/事件驱动，Guardian 托底 |
| **Skill** | 让 **AI** 学会一类操作（含分支、不确定性、破坏性） | `data/skills/<id>/` | 被 AI-Loop 加载进 context，AI 按 rules/workflows 执行 |
| **Playbook** | 步骤**固定**、命令**能事先写死**、用完即弃 | `data/playbooks/<id>/` | 用户点"运行"一次性跑完 |

## 分类决策树（严格按此顺序判断）

### Step 1 · 是"持续做"还是"只做一次"？

关键词：`每 / 定时 / 每天 / 每小时 / 监控 / 守护 / 一直 / 持续 / 长期`
→ 持续 → 进 Step 2
→ 一次性 → 进 Step 3

### Step 2 · 持续任务：是监控还是触发响应？

- **有明确周期**（每 5 分钟查一次 / 每天备份） → `Program`（cron trigger）
- **事件驱动**（日志出错时、指标超阈值时）→ 现在 trigger 只支持 cron/manual，可以让 Program 用短周期 cron 近似轮询，告诉用户"watch/metric trigger 将在 Phase 5 支持"
- **不确定** → `Program`（默认推荐）

### Step 3 · 一次性任务：步骤能事先写死吗？

关键判据（**用户真实描述**里有这些特征 → 选 **AI 工具**）：

- 需要**根据运行时结果决定下一步**（"先查容器名，再用它操作"）
- 涉及**破坏性操作**（删除、修改、下线）→ 需要 `ask_user` 确认
- 命令参数要**根据用户输入动态拼接**（domain、container 名、端口）
- 错误场景多变，需要 AI 临场判断

→ 满足任一 → **AI 工具（Skill）** — 用户主动触发的交互型操作
→ 全部不满足（纯信息采集、状态查询、批量列表）→ **Playbook**

### Step 4 · 是否需要配套？

- 推荐 Program → 问自己"失败时该怎么办"
  - 需要 AI 诊断/自愈 → 推荐 **Bundle**（Program + Rescue Skill，一次性生成两者）
  - 简单失败写审计就够 → 单独 Program
- 推荐 AI 工具 / Playbook → 通常单独即可
- **Rescue Skill 只通过 Bundle 创建**，不单独推荐

## 第三步：输出推荐卡片

用 `render_result format=keyvalue level=info` 推送：

```
title: "产物类型推荐"
subtitle: "点击下方按钮确认，或告诉我你想换成另一种"
items:
  - key: 推荐产物
    value: "Program + Rescue Skill (Bundle)"   # 或 Program / Skill / Playbook
  - key: 推荐 ID
    value: "vps-cert-monitor"                  # kebab-case
  - key: 理由
    value: "用户要求'每周检查证书过期'，是持续性任务；失败时需要自动续期，需要 AI 判断证书类型"
  - key: 备选方案
    value: "也可以做成 Playbook（手动点运行），但会失去自动守护"
  - key: 下一步
    value: "确认后我会用 generate-program + generate-rescue-skill workflow 创作"
```

## 第四步：等待用户确认

`ask_user type=select`：

```
title: "按推荐创作吗？"
options:
  - value: "accept"     label: "✅ 按推荐创作"
  - value: "program"    label: "⚙️ 改为 Program"
  - value: "skill"      label: "🧰 改为 AI 工具"
  - value: "playbook"   label: "📜 改为 Playbook"
  - value: "bundle"     label: "📦 改为 Bundle（Program + Rescue Skill）"
  - value: "cancel"     label: "取消"
```

## 第五步：路由到对应生成 workflow

根据用户选择：
- `accept` 或 `program` → 读 `workflows/generate-program.md`
- `skill` → 读 `workflows/generate-skill.md`
- `playbook` → 读 `workflows/generate-playbook.md`
- `bundle` → 读 `workflows/generate-bundle.md`
- `cancel` → `render_result level=info "已取消"`，结束

## 常见误判（要小心）

1. **"删除一个网站"** → 容易误判为 Playbook，其实应该是 **Skill**（破坏性操作 + 需要 ask_user 确认）
2. **"列出所有容器"** → Playbook（纯查询，步骤固定）
3. **"每天备份 MySQL"** → Program（周期性）
4. **"服务器出问题了就通知我"** → Program（事件驱动，短周期 cron 轮询近似）+ 配 Rescue Skill
5. **"申请一个 Let's Encrypt 证书"** → Skill（分支多：DNS 方式 vs HTTP 方式 vs 不同 DNS 厂商）
6. **"重启 nginx"** → 单条命令，其实不需要 Skill 也不需要 Playbook——告诉用户可以直接在"脚本库"写个一行脚本

## 质量自检

- [ ] 推荐前读过 `references/program-schema.md` / `references/skill-format.md` / `references/playbook-schema.md` 里相关的部分吗？
- [ ] 有给用户明确的"备选方案"和"下一步"说明吗？
- [ ] 没直接动手写文件吗？（classify workflow 只负责推荐）