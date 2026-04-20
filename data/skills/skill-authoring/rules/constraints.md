# Skill 创作硬约束

以下规则在任何模式下均适用，优先级高于用户描述。

---

## 1. 产物归位不能混

| 产物 | 路径 | 禁止 |
|------|------|------|
| Skill（AI 能力包）| `data/skills/<id>/` | 不得含 `playbook.yaml` |
| Playbook（确定性剧本）| `data/playbooks/<id>/` | 不得当作 Skill 用 |
| Program（长驻程序）| `data/programs/<id>/program.yaml` | 不得写到 skills/ 或 playbooks/ |

## 2. Skill 的四类文件严格分离

```
rules/       → 注入 system prompt 的硬约束（AI 必须遵守，不可被 workflow 覆盖）
workflows/   → 自然语言推理指引（不是步骤脚本，不是 YAML）
references/  → 按需加载的背景知识（坑点、已知问题、领域术语）
SKILL.md     → ≤ 100 行，只做路由导航，不做内容百科
```

**workflows/ 里绝对禁止出现：**
- 编号步骤列表（`1. 2. 3.`）且每步是固定命令 → 那是 Playbook，不是 Skill
- YAML 代码块（除非是示例说明）
- `run:` / `command:` / `execute:` 字段定义

## 3. Skill 是"推理上下文"，不是"执行脚本"

Skill 的 workflows/ 应该告诉 AI：
- **遇到什么情况时做什么判断**（条件 → 决策）
- **有哪些陷阱需要避开**（坑点前置）
- **不确定时问用户**（ask_user 触发条件）

不应该告诉 AI：
- 第一步执行 X，第二步执行 Y（那是 Playbook）

## 4. render_result 输出规范（必须遵守）

生成的 Skill 中，凡是向用户展示信息的场景，**必须**在 workflows/ 里明确指定 render_result 格式：

| 场景 | 必须用的 format |
|------|----------------|
| 多行列表（容器、网站、进程…）| `table`，指定 columns |
| 单个对象详情 | `keyvalue` |
| 操作结果（成功/失败）| `message` + 对应 level |
| 配置文件/脚本内容 | `code` + language |

**禁止：**
- 用 `message` format 展示本该是表格的数据
- workflows/ 里只说"告知用户结果"而不指定 format

## 5. Skill 生成完成后必须保持对话

所有 generate workflow 最后**必须** `ask_user type=input`，title: "还要调整什么？"
不得直接结束会话。用户回复后用 `write_local_file` 迭代修改。

## 6. ID 命名规则

一律 `kebab-case`（小写字母/数字/连字符，字母开头）。
- ✅ `vps-website-delete`、`cert-check`
- ❌ `VPSDelete`、`cert_check`、`1shell-monitor`