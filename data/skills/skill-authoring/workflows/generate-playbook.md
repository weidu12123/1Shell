<!-- smoke-test: meta-workflow -->
# Workflow: Generate Playbook — 已废弃

Playbook 不再是 1Shell 的独立产物类型，禁止创建 `data/playbooks/<id>/`、`playbook.yaml` 或 Playbook 专属 SKILL.md。

## 必须改走的路径

- 固定步骤、可预写死的确定性自动化 → `workflows/generate-program.md`，写入 `data/programs/<id>/program.yaml` 的 L1/action。
- 需要 AI 判断、分支、破坏性确认、领域上下文 → `workflows/generate-skill.md`。
- Program 运行失败需要 AI 维护边界 → `workflows/generate-bundle.md`，生成 Program + companion L2 Skill。
- 只是单条命令或临时操作 → 直接回答用户，或建议放到 Script。

## 被调用时的处理

如果由于旧入口或旧上下文读到本文件：

1. 不要写任何文件。
2. 用 `render_result format=message level=warning` 告知用户：Playbook 已并入 Program。
3. 根据需求重新路由到 Program / Skill / Bundle。
4. 继续按对应 workflow 的 staged authoring 规则执行。
