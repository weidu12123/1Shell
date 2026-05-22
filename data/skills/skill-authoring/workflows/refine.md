<!-- smoke-test: meta-workflow -->
# 修改已有 Program / Skill

## 第一步：识别目标类型

从 `target_id` 输入读取要修改的产物 ID，并根据注册表或路径判断类型：

- Program：`data/programs/<target_id>/program.yaml`
- Skill：`data/skills/<target_id>/SKILL.md`

如果只找到历史 `data/playbooks/<target_id>/`，不要继续修改；用 `render_result format=message level=warning` 告知用户：Playbook 已并入 Program，需要先迁移到 `data/programs/<target_id>/program.yaml`。

## 第二步：读取现状

Program 读取：

- `data/programs/<target_id>/program.yaml`
- 同目录下与 Program 相关的 rules / references（如存在）

Skill 读取：

- `data/skills/<target_id>/SKILL.md`
- `data/skills/<target_id>/rules/*.md`
- `data/skills/<target_id>/workflows/*.md`
- `data/skills/<target_id>/references/*.md`

用 `render_result format=message level=info` 列出当前结构、关键字段和风险点。

## 第三步：确认修改意图

如果用户任务描述已经明确，直接进入草案；否则用 `ask_user type=input` 询问：你想修改什么？

常见修改类型：

- Program：调整 triggers、L1/action、render 输出、guardian 边界、危险动作确认。
- Skill：调整描述、规则、workflow、参考资料、适用范围。
- Bundle：同时调整 Program 与 companion L2 Skill，但仍分别写入 `data/programs/` 和 `data/skills/`。

## 第四步：生成可审查草案

必须走 staged authoring：

1. 需要先给 spec / plan，说明修改范围。
2. 生成 draft artifact，列出完整文件路径和新内容。
3. 对 draft 做校验。
4. 请求用户 commit approval。
5. 只有用户批准后，才能通过 artifact commit 写入文件。

不要直接调用普通写文件工具绕过审查。

## 第五步：验证与继续追问

写入后 reload 对应注册表并验证：

- Program：确认 `programRegistry` 能加载目标 Program，必要时做 smoke test。
- Skill：确认 `skillRegistry` 能加载目标 Skill。

验证失败时回到 draft 阶段修正；验证成功后 `render_result level=success` 说明修改了哪些文件，并用 `ask_user type=input` 等待用户继续补充修改。

## 边界

- 禁止创建或修改 `data/playbooks/`。
- 禁止创建 `playbook.yaml`。
- 固定步骤应放入 Program L1/action。
- AI 判断、领域规则、危险动作边界应放入 Skill 或 companion L2 Skill。
