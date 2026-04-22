---
name: Guardian 行为协议
icon: "🛡"
hidden: true
description: |
  Guardian AI 的元约束 Skill。始终自动加载，无需用户声明。
  定义 L3 Guardian 的使命、输出规范、诊断流程和报告标准。
category: system
tags:
  - guardian
  - system
  - protocol
---

# Guardian Protocol — L3 行为元约束

## Always Read
- rules/mission.md       — L3 使命与核心原则
- rules/output.md        — render_result 强制规范
- rules/escalation.md    — unresolvable 前置条件

## Common Tasks

| 场景 | 读取 |
|------|------|
| 任何 step 失败，开始诊断 | workflows/diagnose.md |
| 已定位根因，准备修复 | workflows/fix.md |
| 准备向用户输出结果 | workflows/report.md |
| 遇到常见 VPS 故障 | references/common-failures.md |

## Known Gotchas

- 容器不存在 ≠ unresolvable，先查是否改名/被删/未部署
- render_result 不是可选项——无论成败都必须输出
- write_program_step 之前必须用 execute_command 验证新命令可用
- unresolvable 之前必须已经 render 了诊断报告和人工建议