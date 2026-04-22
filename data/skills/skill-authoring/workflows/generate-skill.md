<!-- smoke-test: meta-workflow -->
# Workflow: Generate Skill — 创建 AI 能力包

> **前置**：已读 `rules/constraints.md` 和 `rules/task-closure.md`，所有约束均适用。

---

## Step 0：2/3 录入标准（决定要不要创建这个 Skill）

在开始之前，对用户的需求做三个判断：

| 标准 | 问题 | 是/否 |
|------|------|-------|
| **可重复** | 这个操作会反复发生，还是一次性的？ | ? |
| **代价高** | 如果 AI 每次从头摸索，成本/风险高吗？ | ? |
| **代码不可见** | 需要领域知识/上下文才能做对，代码本身看不出来？ | ? |

**至少 2/3 为"是"才创建 Skill。** 全部为"否" → 直接回答用户，不创建任何产物。

---

## Skill vs Playbook 判断（Step 0 通过后做这个）

**"如果我把步骤写死，不需要 AI 临场判断，能完成吗？"**

- 能 → 这是 Playbook，改走 `workflows/generate-playbook.md`
- 不能（需根据现场决策、有条件分支、有破坏性操作需确认）→ 是 Skill，继续

---

## Step 1：理解需求，提炼触发场景

从用户描述中提炼：
- **触发条件**（description 字段最重要）：用户说什么话、点什么按钮时会调用这个 Skill？
- **核心决策点**：有哪些情况 AI 需要根据现场判断？
- **危险操作**：哪些操作需要 ask_user 确认？
- **输出形式**：用户最终想看到什么？（列表 / 详情 / 操作结果）

---

## Step 2：规划目录结构

参考 `data/skills/_templates/` 下的模板文件（结构已预制，`<!-- FILL: -->` 标记的地方填内容）：

```
data/skills/<skill-id>/
  SKILL.md                   ← 参考 _templates/SKILL.md.tpl
  rules/
    constraints.md           ← 参考 _templates/rules/constraints.md.tpl
  workflows/
    <主流程>.md              ← 参考 _templates/workflows/main.md.tpl
  references/
    gotchas.md               ← 可选，参考 _templates/references/gotchas.md.tpl
```

用 `render_result format=message level=info` 展示规划给用户确认。

---

## Step 3：写 SKILL.md（路由中心）

```yaml
---
name: <中文名>
icon: "<emoji>"
hidden: false
description: |
  <触发条件描述 — 这是最重要的字段>
  用一句话描述"什么情况下 AI 会加载这个 Skill"
  不要写功能列表，要写触发场景
category: <docker|web|database|system|custom>
tags:
  - <tag>

inputs:
  - name: <snake_case>
    label: <中文>
    type: string | select | boolean
    required: true | false
    placeholder: ...
---

# <Skill 名>

## Always Read
- rules/constraints.md

## Common Tasks

| 用户意图 | 读取 workflow |
|---------|--------------|
| <场景1> | workflows/<file>.md |
| <场景2> | workflows/<file>.md |

## Known Gotchas
1. <坑点简述>（详见 references/gotchas.md）
```

**硬性要求：**
- SKILL.md 正文 ≤ 100 行
- description 写触发条件，不写功能列表
- Common Tasks 表格覆盖所有主要用户意图

---

## Step 4：写 rules/constraints.md（硬约束）

rules/ 里的内容会被注入 AI 的 system prompt。写"AI 不能做什么"和"必须先做什么"。

**好的 rules 写法：**
```markdown
## 破坏性操作前必须确认
删除容器、删除配置、覆盖文件等操作，必须先 ask_user type=confirm danger=true。

## 不得批量操作
任何删除/修改只针对用户明确指定的单个目标，不得循环删除多个。

## nginx 操作规范
修改 nginx 配置后必须先 nginx -t，通过验证才能 nginx -s reload。
```

**不好的写法（提示词，不是约束）：**
```markdown
## 操作步骤
1. 先查询...
2. 然后执行...   ← 这是 workflow，不是 rules
```

---

## Step 5：写 workflows/<name>.md（推理指引）

**关键：写"遇到 X 情况时怎么判断"，不是"第一步做 A 第二步做 B"。**

好的 workflow 结构：
```markdown
## 触发场景
用户提到"删除"、"移除"、"下线"某个网站时进入本流程。

## 执行前必须搞清楚
- 网站是否有关联容器？用 docker ps --filter 找
- 是否有数据卷需要保留？问用户
- 是否有多个域名指向同一容器？避免误删其他站点

## 输出（必须用 render_result）
操作完成后用 render_result format=message level=success 告知结果。
如有错误，用 render_result format=message level=error 并说明原因。
失败后不要继续执行后续步骤。

## 危险操作确认
删除容器前必须 ask_user type=confirm danger=true，用户取消后
用 render_result format=message level=warn 告知已取消并停止。
```

**禁止的写法：**
```markdown
## 步骤
1. 运行 docker ps 列出容器    ← 脚本化，不是推理
2. 找到目标容器
3. 运行 docker stop <name>
```

### render_result format 选择规范

生成的 workflow **必须**明确指定输出格式，不能含糊说"展示结果"：

| 展示什么 | format | 示例 |
|---------|--------|------|
| 多行对象（容器列表、网站列表）| `table` + columns | 容器名/状态/端口 |
| 单个对象详情 | `keyvalue` | 容器详情页 |
| 操作成功/失败通知 | `message` + level | "nginx 已重启" |
| 配置文件内容 | `code` + language | nginx.conf |

---

## Step 6：写 references/（可选，按需）

只在以下情况创建 references/ 文件：
- 有已知的跨版本兼容性坑
- 有需要背景知识才能理解的领域术语
- 有过去踩过的 bug 记录

不要为了"看起来完整"而创建空洞的 references 文件。

---

## Step 7：写入文件

用 `write_local_file` 并行写入所有文件。

---

## Step 8：自检清单 + smoke-test 验证

写完后逐项验证，然后运行 smoke-test：

```bash
# 在 1Shell 根目录执行
bash smoke-test.sh <skill-id>
```

smoke-test 全绿后再告知用户成功。如有失败项，先修复再运行。

自检清单：

- [ ] SKILL.md description 描述的是**触发条件**，不是功能列表
- [ ] SKILL.md 正文 ≤ 100 行
- [ ] rules/ 里写的是**约束**，不是步骤
- [ ] rules/ 每条规则**脱离项目上下文仍可读**（泛化规则检查）
- [ ] workflows/ 里没有连续编号步骤且每步是固定命令
- [ ] workflows/ 里每个展示场景都明确了 render_result format
- [ ] 破坏性操作有 ask_user type=confirm danger=true
- [ ] `data/skills/` 下没有 `playbook.yaml`
- [ ] ID 是 kebab-case
- [ ] **Task Closure Protocol**：AAR 完成，Rationalizations 检查，Red Flags 清零

---

## Step 9：成功反馈 + 保持对话

用 `render_result format=message level=success` 展示：
```
Skill「<name>」创建成功
路径：data/skills/<id>/
文件：SKILL.md · rules/constraints.md · workflows/<name>.md
```

然后 `ask_user type=input`：
- title: "还要调整什么？"
- placeholder: "例如：增加一个输入参数 / rules 里加一条限制 / workflow 细化某个判断…"