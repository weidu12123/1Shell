<!-- smoke-test: meta-workflow -->
# Workflow: Classify — 意图分类器

本 workflow 是创作台的**第一道门**：读取用户的自然语言需求，推荐该做成哪种产物。

> **输出必须通过 `render_result format=keyvalue`**，用户看到后才能确认是否按推荐走。
> **不要自己动手写文件**——只推荐，不生成。

## 两类核心产物

| | 何时选 | 写到哪 | 执行方式 |
|---|---|---|---|
| **Program** | 任务需要定时/手动触发、持续守护、或步骤能明确落到 L1/action | `data/programs/<id>/` | triggers 驱动；L1 执行确定性步骤，L2 维护，必要时请求 L3 |
| **Skill** | 让 **AI** 学会一类操作（含分支、不确定性、破坏性确认、领域判断） | `data/skills/<id>/` | 被 AI-Loop 加载进 context，AI 按 rules/workflows 执行 |

> Playbook 不再是独立产物。原“固定步骤/一次性剧本”能力必须归入 Program L1/action；简单一行命令可建议用户放到 Script。

## 分类决策树（严格按此顺序判断）

### Step 1 · 是否需要平台托管的自动化？

关键词：`每 / 定时 / 每天 / 每小时 / 监控 / 守护 / 一直 / 持续 / 长期 / 手动触发 / 批量执行 / 固定步骤`
→ 是 → 推荐 `Program`
→ 否 → 进 Step 2

### Step 2 · 是否需要 AI 能力包？

关键判据（用户真实描述里有这些特征 → 选 **Skill**）：

- 需要**根据运行时结果决定下一步**（“先查容器名，再用它操作”）
- 涉及**破坏性操作**（删除、修改、下线）→ 需要 `ask_user` 确认
- 命令参数要**根据用户输入动态拼接**（domain、container 名、端口）
- 错误场景多变，需要 AI 临场判断
- 需要把一类领域知识沉淀成可复用 AI 约束

→ 满足任一 → **Skill**
→ 都不满足，但仍要保存成 1Shell 产物 → **Program**（manual trigger + L1/action）
→ 只是单条命令或一次性即时操作 → 直接回答或建议 Script，不创建 Program/Skill

### Step 3 · 是否需要配套？

- 推荐 Program → 问自己“失败时该怎么办”
  - 需要 AI 诊断/维护 → 推荐 **Bundle**（Program + companion L2 Skill，一次性生成两者）
  - 简单失败写审计就够 → 单独 Program
- 推荐 Skill → 通常单独即可
- **companion L2 Skill 只约束 Program 运行时维护边界**，不要和 Claude Code Skill 混用

## 第四步：输出推荐卡片

用 `render_result format=keyvalue level=info` 推送：

```yaml
title: "产物类型推荐"
subtitle: "点击下方按钮确认，或告诉我你想换成另一种"
items:
  - key: 推荐产物
    value: "Program + companion L2 Skill (Bundle)"   # 或 Program / Skill
  - key: 推荐 ID
    value: "vps-cert-monitor"                  # kebab-case
  - key: 理由
    value: "用户要求'每周检查证书过期'，是持续性任务；失败时需要自动续期，需要 AI 判断证书类型"
  - key: 备选方案
    value: "也可以做成单独 Program；固定步骤放在 L1/action"
  - key: 下一步
    value: "确认后我会用 generate-bundle workflow 创作 Program + companion Skill"
```

## 第五步：等待用户确认

`ask_user type=select`：

```yaml
title: "按推荐创作吗？"
options:
  - value: "accept"     label: "✅ 按推荐创作"
  - value: "program"    label: "⚙️ 改为 Program"
  - value: "skill"      label: "🧰 改为 Skill"
  - value: "bundle"     label: "改为 Bundle（Program + companion L2 Skill）"
  - value: "cancel"     label: "取消"
```

## 第六步：路由到对应生成 workflow

根据用户选择：
- `accept` 或 `program` → 读 `workflows/generate-program.md`
- `skill` → 读 `workflows/generate-skill.md`
- `bundle` → 读 `workflows/generate-bundle.md`
- `cancel` → `render_result level=info "已取消"`，结束

## 常见误判（要小心）

1. **“删除一个网站”** → Skill（破坏性操作 + 需要 ask_user 确认）
2. **“列出所有容器”** → 如果要保存为平台按钮，做 Program manual action；否则直接回答或建议 Script
3. **“每天备份 MySQL”** → Program（周期性）
4. **“服务器出问题了就通知我”** → Program（事件驱动，短周期 cron 轮询近似）+ companion L2 Skill
5. **“申请一个 Let's Encrypt 证书”** → Skill 或 Bundle（分支多：DNS 方式 vs HTTP 方式 vs 不同 DNS 厂商）
6. **“重启 nginx”** → 单条命令通常不需要 Skill；可建议 Script 或 Program manual action

## 质量自检

- [ ] 推荐前读过 `references/program-schema.md` / `references/skill-format.md` 里相关的部分吗？
- [ ] 没把固定步骤推荐成独立 Playbook 吗？
- [ ] 有给用户明确的“备选方案”和“下一步”说明吗？
- [ ] 没直接动手写文件吗？（classify workflow 只负责推荐）
