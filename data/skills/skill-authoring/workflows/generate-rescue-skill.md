<!-- smoke-test: meta-workflow -->
# Workflow: Generate Rescue Skill

> ⚠️ **本 workflow 仅供 `generate-bundle.md` 内部调用，不作为独立创作入口。**
> Rescue Skill 必须通过 Bundle 和 Program 一起生成，命名规范 `<program-id>-rescue`。
> 系统会按约定自动发现该 Skill，无需在 program.yaml 中手动填写引用。

为某个目标 Program 量身创作一个 **Rescue Skill**，存放到 `data/skills/<skill-id>/`。

Rescue Skill 是 Guardian AI 的**场景化约束**——它不被执行，只被 Guardian 读取、
拼进 system prompt，用于在 Program 步骤失败时引导诊断顺序与边界。

## 关键差异 vs 创建 Playbook

| | Playbook | Rescue Skill |
|---|---|---|
| 写入目录 | `data/playbooks/<id>/` | `data/skills/<id>/` |
| frontmatter `category` | 业务自选 | **必须** `rescue` |
| 是否可执行 | 是（AI-loop 或 playbook.yaml） | **否**，仅作 prompt |
| 必需文件 | SKILL.md + (workflows 或 playbook.yaml) | SKILL.md + rules/ + references/ + workflows/ |
| 是否要 `inputs` | 通常要 | **不要**（不执行就不需要输入） |
| 是否要 `mcpServers` | 按需 | **不要** |

## 创作步骤

### 1. 读目标 Playbook 的完整上下文

用户给的 task 里会带一个 `目标 Playbook` 标识（id + 内容摘要）。你需要：

- **读目标 Playbook 的 SKILL.md**：了解 goal、描述、步骤目的
- **读目标 Playbook 的 playbook.yaml（若有）**：逐步扫一遍，记下每个 step 的 `run` / `verify` / `on_error_hint`。特别注意带 shell 命令的步骤：什么工具？什么容器？什么路径？
- **记下所有涉及的外部依赖**：docker、nginx、mysql、systemd、网络等 —— 这些是 Rescue Skill 要覆盖的场景。

### 2.（可选）采风目标主机

如果 task 里声明了"目标主机（VPS）"，你**可以**用 `execute_command` 在主机上快速探测：

- 工具版本：`docker --version`、`nginx -v`、`mysql --version` 等
- 容器状态：`docker ps -a --format '{{.Names}}\t{{.Image}}'` —— 但**只记录信息**，不要修改状态
- 路径约定：关键配置文件在哪（`/etc/nginx/` vs `/etc/caddy/`；容器内部路径 vs 宿主路径）

**采风是为了把"v5+ 用 A / v4 用 B"这类分支写进 Skill，而不是把主机 IP 硬编码**。Rescue Skill 要对"同类环境"都通用。

预算：采风最多 3 条 `execute_command`，够不够都停，不要浪费 token。

### 3. 设计目录结构

标准 Rescue Skill 目录：

```
data/skills/<skill-id>/
├── SKILL.md                      # frontmatter(category: rescue) + 概述 + 作用范围
├── rules/
│   └── constraints.md            # 硬性边界（"不能做什么"），1-2 个文件
├── references/
│   └── known-issues.md           # 已知坑位映射表（"现象 → 处方"），1-3 个文件
└── workflows/
    └── diagnose.md               # 诊断流程（诊断顺序、探测命令选择），1-2 个文件
```

- 每个 .md **不超过 8KB**（rescuer 加载时每文件 8KB 截断）
- 整个 Skill 总字节数 **目标 < 20KB**（rescuer 总量上限 24KB）
- 文件名用 `kebab-case` 或 snake_case，都行

### 4. SKILL.md 规范

```markdown
---
name: <人类可读名字，如 "MySQL 运维救援">
icon: "<emoji>"
hidden: false
description: |
  Rescue Skill：当绑定到此 Skill 的 Playbook 在 <具体场景> 失败时，
  为 rescuer 提供诊断顺序与已知坑位。
category: rescue
tags:
  - rescue
  - <关键技术 tag>
---

# <Title>

本 Skill 是 **Rescue Skill**，被 Playbook 的 `rescuer_skill: <skill-id>` 字段绑定
后生效。**不是可执行的 Playbook**。

## 作用范围
- <列举覆盖的失败场景>
- <列举优先处理的坑位类别>
```

**不要加** `inputs`、`mcpServers`、`hasPlaybook` 等执行相关字段。

### 5. rules/constraints.md 规范

写"**不能做什么**"与"**诊断顺序**"。

典型结构：
- `## 诊断顺序（从便宜到昂贵）`：列 3-5 条命令递进
- `## 边界`：列 3-5 条"绝不 xxx"，每条带理由
- `## 建议动作映射`：表格把"失败现象"映射到 `retry_ok` / `patch_plan` / `give_up`

**切记**：硬约束（最多 3 次 execute_command、必须 report_outcome、三选一 action）已经在 rescuer 代码里写死，**Skill 不需要重复这些**。Skill 只加场景化内容。

### 6. references/known-issues.md 规范

"**已知坑位速查表**"。每条一个章节：

```markdown
## N. <短标题>
**现象**：<一句话现象，最好带典型 stderr 文本>
**判定**：<这种现象说明的根因>
**处方**：<具体怎么做：探测命令 / 修复步骤 / 为何给 give_up>
```

有多少条写多少条。条目越具体越好（带具体错误关键词、具体路径、具体版本）。

### 7. workflows/diagnose.md 规范

"**诊断流程**"。结构：

```markdown
## Step 1 · 读失败上下文
<如何从 failing step 提取线索>

## Step 2 · 单次探测（选一）
<表格：线索 → 探测命令>

## Step 3 · 决断
<根据探测结果怎么选 retry_ok / patch_plan / give_up>

## 反模式（不要做）
- ❌ <具体反模式>
```

### 8. 写入文件

用 `write_local_file` 工具（参考 references/tool-api.md），每个文件分别写入：

1. `data/skills/<skill-id>/SKILL.md`
2. `data/skills/<skill-id>/rules/constraints.md`
3. `data/skills/<skill-id>/references/known-issues.md`
4. `data/skills/<skill-id>/workflows/diagnose.md`

**写入前先检查目录是否已存在**（用 `execute_command` 跑 `ls data/skills/<skill-id>/ 2>/dev/null`）。已存在则用 `ask_user` 问用户是否覆盖。

### 9. 最后一步：提醒用户绑定

创作完成后，**必须** `render_result` 输出一条信息告诉用户：

> 要让这个 Rescue Skill 生效，需要在目标 Playbook 的 `playbook.yaml` 顶部加一行：
> `rescuer_skill: <skill-id>`
> 然后重启或让 Playbook 仓库 reload 即可。

然后 `render_result` 显示一个 message 格式的结果，title 是 "Rescue Skill 创建完成"，content 里说明 Skill id + 4 个文件路径 + 绑定提示。

## 质量检查清单（写完自检）

- [ ] `category: rescue` 存在于 frontmatter
- [ ] **没有** `inputs` / `mcpServers` / `hasPlaybook` 字段
- [ ] 至少有 `SKILL.md + rules/constraints.md + references/known-issues.md + workflows/diagnose.md` 四个文件
- [ ] 每个文件 < 8KB，总和 < 20KB
- [ ] rules 里**没有**重复 rescuer 代码硬约束（3 次上限、report_outcome 等）
- [ ] references 里每条都带具体错误文本或错误码
- [ ] 文档里**没有**硬编码主机 IP、用户名、密码、token
- [ ] 最后 render_result 提醒用户把 `rescuer_skill: <id>` 加到目标 Playbook