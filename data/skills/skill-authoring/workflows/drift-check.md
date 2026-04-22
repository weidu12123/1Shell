<!-- smoke-test: meta-workflow -->
# Workflow: Skill 自维护 — Drift 检查与规则清退

当用户说"检查一下这个 Skill 是否还有效"、"这个规则还适用吗"、"清理 Skill" 时进入本流程。

---

## Drift 检查（Skill 是否过期）

用 `execute_command` 读取目标 Skill 目录下所有文件，对照以下标准逐项检查：

### 检查 1：rules/ 规则是否仍然必要

对每条规则问：**"如果删掉这条规则，AI 会自然违反它吗？"**

- 不会违反 → 规则可清退（激活优于存储）
- 会违反 → 规则保留

### 检查 2：规则是否泛化

对每条规则问：**"把 Skill ID / 产物名换掉，规则还成立吗？"**

- 成立 → 泛化良好
- 不成立 → 规则过于项目特定，建议重写或删除

### 检查 3：workflows/ 是否有脚本化倾向

检查 workflows/ 文件是否出现：
- 3 条以上连续编号步骤（`1. 2. 3.`）且每步是固定命令
- YAML 代码块定义命令（`run:` / `command:`）

发现 → 标记为需要重写

### 检查 4：SKILL.md 行数

`wc -l SKILL.md` 超过 100 行 → 需要精简

### 检查 5：references/ 是否有用

对每个 references/ 文件问：**"AI 在运行这个 Skill 时真的需要这些背景知识吗？"**

- 不需要 → 删除

---

## 规则清退流程

发现可清退的规则时：

1. 用 `render_result format=list` 展示候选清退项，说明清退理由
2. `ask_user type=confirm` 确认是否清退
3. 确认后用 `write_local_file` 更新文件（移除对应规则）
4. `ask_user type=input` 问是否继续检查其他 Skill

---

## 输出规范

检查完成后用 `render_result format=keyvalue` 展示报告：

```
- Skill ID: <id>
- rules/ 规则数: N 条（保留 X，清退 Y）
- workflows/ 健康度: 良好 / 有脚本化倾向
- SKILL.md 行数: N 行
- references/ 文件: N 个（保留 X，建议删除 Y）
- 结论: 健康 / 需要维护
```

---

## 批量检查

若用户没有指定具体 Skill，用 `execute_command ls data/skills/` 列出所有 Skill，
依次逐个检查，或先展示列表让用户 `ask_user type=select` 选择目标。