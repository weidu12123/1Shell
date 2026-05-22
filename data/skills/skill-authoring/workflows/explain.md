<!-- smoke-test: meta-workflow -->
# 解释 Program / Skill 结构

## 步骤

1. 读取 `target_id` 输入。

2. 判断目标类型并读取文件：

   - Program：读取 `data/programs/<target_id>/program.yaml`，以及同目录下相关 rules / references（如存在）。
   - Skill：读取 `data/skills/<target_id>/SKILL.md`、`rules/*.md`、`workflows/*.md`、`references/*.md`。

   如果只找到历史 `data/playbooks/<target_id>/`，用 warning 说明 Playbook 已并入 Program，不再解释为独立产物；建议迁移到 Program L1/action。

3. 用 `render_result format=message` 用中文解释：

   - 这个产物解决什么问题。
   - 它是 Program、Skill，还是 Program + companion L2 Skill 的 Bundle。
   - Program 的 triggers、L1/action、render 输出和 guardian 边界分别做什么。
   - Skill 的 rules、workflows、references 分别约束什么。
   - 是否涉及危险动作、凭据、服务重启、删除数据或 L3 升级边界。
   - 如果要修改，哪些文件需要改。

4. 如果用户想修改，引导到 refine 流程（mode=refine）。

## 边界

- 不要把 `data/playbooks/` 解释成当前有效产物入口。
- 不要建议新建 Playbook。
- 固定步骤解释为 Program L1/action；AI 判断和维护边界解释为 Skill。
