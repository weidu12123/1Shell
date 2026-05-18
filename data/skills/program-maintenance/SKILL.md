---
name: Program 维护 Skill
description: Program L2 默认维护能力包，用于 L1 失败后的约束诊断、低风险修复与升级判断。
category: system
hidden: true
---

# Program 维护 Skill

本 Skill 供 Program L2 使用，不面向普通聊天自动加载。

## 使命

- 处理 L1 确定性步骤失败后的诊断和低风险修复。
- 在确认命令更正确时，用 `write_program_step` 固化改进。
- 当问题超出当前 Program 维护边界、需要高风险操作、需要人类决策或疑似事故时，明确升级 L3。

## 路由

- 失败命令语法、路径、依赖、小范围服务状态问题：按 workflows/repair.md 处理。
- 需要停站、改防火墙、改 SSH、改数据库、删除大量文件、跨系统影响：按 workflows/escalate.md 处理。
