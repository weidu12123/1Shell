# Playbook Schema 参考 — 已废弃

Playbook 不再是 1Shell 的独立产物类型；不要创建 `data/playbooks/<id>/`、`playbook.yaml` 或 Playbook 专属 SKILL.md。

原 Playbook 的确定性执行清单能力已并入 **Program L1/action**，目标路径为：

```text
data/programs/<program-id>/program.yaml
```

## 迁移判断

| 旧 Playbook 场景 | 现在应选择 |
|---|---|
| 固定步骤、命令能预写死、需要定时或手动触发 | Program L1/action |
| 需要 AI 判断、复杂分支、领域规则、破坏性确认 | Skill |
| Program 失败后需要 AI 维护边界和诊断顺序 | Program + companion L2 Skill Bundle |
| 只是单条命令或临时操作 | 直接回答用户，或建议放到 Script |

## Program L1/action 迁移要点

旧 `steps[].run` 应迁移为 Program 的 L1/action 命令；旧 `verify` 应迁移为 action 的成功判定；旧 `render` 步骤应迁移为 Program 的结果输出配置。

迁移时必须保留这些约束：

1. 每个 action id 唯一，命名稳定。
2. render 输出必须让用户看到结果，不能只有“运行成功”。
3. 多行命令仍使用 YAML literal block。
4. 不要在命令里使用交互式程序，例如 vim、nano、less。
5. 凭据必须标记 secret，不能出现在 render、日志或示例输出中。
6. 涉及 /etc、/var、service reload/restart、证书、DNS、Cloudflare、防火墙、数据库、删除数据的动作必须列为危险动作。

## 被旧流程调用时

如果旧上下文要求读取本文件来生成 Playbook：

1. 停止 Playbook 生成。
2. 用 warning 告知用户：Playbook 已并入 Program。
3. 改走 `workflows/generate-program.md`，把固定步骤写入 Program L1/action。
4. 如果需要失败诊断能力，再改走 `workflows/generate-bundle.md` 生成 companion L2 Skill。
