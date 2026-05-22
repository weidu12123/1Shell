<!-- smoke-test: meta-workflow -->
# Workflow: Generate Companion L2 Skill

> 本 workflow 仅供 `generate-bundle.md` 内部调用，不作为独立创作入口。
> Companion L2 Skill 必须通过 Bundle 和 Program 一起生成，命名规范 `<program-id>-rescue`。
> 系统会按约定自动发现该 Skill，无需创建独立 Playbook 或在 Program 中绑定 Playbook 字段。

为某个目标 Program 量身创作一个 **companion L2 Skill**，存放到 `data/skills/<skill-id>/`。

Companion L2 Skill 是 Guardian AI 的场景化约束：它不承载 L1 确定性步骤，只在 Program 步骤失败、需要 L2 诊断或修复建议时被加载进上下文。

## 关键边界

| | Program L1/action | Companion L2 Skill |
|---|---|---|
| 写入目录 | `data/programs/<program-id>/` | `data/skills/<skill-id>/` |
| 作用 | 确定性执行、render 输出、触发器 | 失败诊断顺序、维护边界、已知坑位 |
| 是否可执行 | 是，由 Program engine 执行 | 否，只作为 AI 上下文 |
| 必需文件 | `program.yaml` | `SKILL.md` + rules/ + references/ + workflows/ |
| 禁止内容 | 把 AI 判断写进 L1 | `playbook.yaml`、固定执行步骤、凭据明文 |

## 创作步骤

### 1. 读取目标 Program 上下文

用户给的 task 里会带目标 Program 标识（id + 内容摘要）。你需要：

- 读取 `data/programs/<program-id>/program.yaml`：了解 triggers、L1/action、render、guardian 边界。
- 记录每个 action 的命令、verify、危险动作和失败提示。
- 记录外部依赖：docker、nginx、mysql、systemd、网络、证书、DNS、Cloudflare、防火墙、数据库等。
- 判断哪些失败需要 L2 给诊断建议，哪些必须升级 L3 或请求人工确认。

### 2. 可选采风目标环境

如果 task 里声明了目标主机，你可以用只读命令采集少量上下文：

- 工具版本：`docker --version`、`nginx -v`、`mysql --version` 等。
- 运行状态：`docker ps -a --format '{{.Names}}\t{{.Image}}'`。
- 路径约定：关键配置文件位置、容器名、服务名。

采风最多 3 条只读命令；不要修改状态，不要硬编码主机 IP、用户名、密码或 token。

### 3. 设计目录结构

标准 companion L2 Skill 目录：

```text
data/skills/<skill-id>/
├── SKILL.md
├── rules/
│   └── constraints.md
├── references/
│   └── known-issues.md
└── workflows/
    └── diagnose.md
```

- 每个 .md 目标不超过 8KB。
- 整个 Skill 目标小于 20KB。
- 文件名用 kebab-case 或 snake_case。

### 4. SKILL.md 规范

```markdown
---
name: <人类可读名字，如 "MySQL 运维救援">
icon: "<emoji>"
hidden: false
description: |
  Companion L2 Skill：当 Program <program-id> 在 <具体场景> 失败时，
  为 Guardian 提供诊断顺序、边界和已知坑位。
category: rescue
tags:
  - rescue
  - program
  - <关键技术 tag>
---

# <Title>

本 Skill 是 Program 的 companion L2 Skill，只约束失败后的诊断和修复建议，不执行固定步骤。

## 作用范围
- <列举覆盖的失败场景>
- <列举优先处理的坑位类别>
```

不要加 `inputs`、`mcpServers`、`hasPlaybook` 或任何执行入口字段。

### 5. rules/constraints.md 规范

写不能做什么、何时升级 L3、诊断优先级。

典型结构：

- `## 诊断顺序`：从便宜到昂贵列 3-5 条只读探测。
- `## L2 边界`：列出不能自行处理的动作，例如私钥、凭据变更、服务重启、防火墙、删除数据。
- `## 决策映射`：表格把失败现象映射到 `retry_ok` / `patch_plan` / `give_up` / `request_l3`。

### 6. references/known-issues.md 规范

每条已知坑位一个章节：

```markdown
## N. <短标题>
**现象**：<一句话现象，最好带典型 stderr 文本>
**判定**：<这种现象说明的根因>
**处方**：<探测命令 / 修改建议 / 升级 L3 条件>
```

### 7. workflows/diagnose.md 规范

```markdown
## Step 1 · 读取 Program 失败上下文
<如何从 failing action、stdout/stderr、verify 结果提取线索>

## Step 2 · 单次探测候选
<表格：线索 → 只读探测命令>

## Step 3 · 决断
<根据探测结果怎么选 retry_ok / patch_plan / give_up / request_l3>

## 反模式
- <具体反模式>
```

### 8. 写入文件

用 staged authoring 生成可审查 draft，最终只写入：

1. `data/skills/<skill-id>/SKILL.md`
2. `data/skills/<skill-id>/rules/constraints.md`
3. `data/skills/<skill-id>/references/known-issues.md`
4. `data/skills/<skill-id>/workflows/diagnose.md`

禁止写入 `data/playbooks/` 或任何 `playbook.yaml`。

## 质量检查清单

- [ ] `category: rescue` 存在于 frontmatter。
- [ ] 没有 `inputs` / `mcpServers` / `hasPlaybook` 字段。
- [ ] 至少有 `SKILL.md + rules/constraints.md + references/known-issues.md + workflows/diagnose.md` 四个文件。
- [ ] Skill 中没有固定执行步骤；确定性步骤保留在 Program L1/action。
- [ ] 每条危险动作都明确 L2 是否必须升级 L3 或请求人工确认。
- [ ] references 里每条都带具体错误文本、错误码或判定条件。
- [ ] 没有硬编码主机 IP、用户名、密码、token。
