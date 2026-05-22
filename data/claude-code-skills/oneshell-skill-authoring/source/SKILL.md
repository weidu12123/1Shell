---
name: oneshell-skill-authoring
description: 创建 data/skills/<id>/ 下的运行时 1Shell Skill Extension。用于 Program 需要配套 L2 Skill，或创建/审查规则、流程、参考资料、结果分类汇报和 request_l3_escalation 边界。
tags:
  - 1shell
  - skill-extension
  - authoring
---

# 1Shell Skill Extension Authoring

This is a Claude Code Skill for the creation phase. It teaches how to write runtime 1Shell Skill Extensions. It is different from a Claude Code Skill package.

## Always Read

- references/skill-extension-structure.md
- references/companion-skill.md
- references/program-l2-dispositions.md

## Common Tasks

| User intent | Read | Output |
|---|---|---|
| Create a general 1Shell Skill Extension | references/skill-extension-structure.md | data/skills/<id>/ |
| Create a Program companion L2 Skill | references/companion-skill.md -> references/program-l2-dispositions.md | SKILL.md, rules/, workflows/, references/ |
| Review an existing Skill Extension | scripts/validate-skill.js | missing boundaries and routing fixes |

## Authoring Flow

1. Identify whether the Skill is user-invoked or a Program companion L2 Skill.
2. Keep SKILL.md as a router: description, Always Read, Common Tasks, known gotchas.
3. Put hard constraints and forbidden operations in rules/constraints.md.
4. Put diagnostic and repair decision flow in workflows/repair.md.
5. Put L3 escalation criteria and request_l3_escalation shape in workflows/escalate.md.
6. Put domain background, command references, and sample output in references/.
7. Define the allowed low-risk repair scope and the exact refusal/escalation boundaries.
8. Define outcome reporting with one disposition: resolved, unresolved, out_of_scope, risk_too_high, needs_human_decision, suspected_incident.
9. Reload the registry after writing files.

## Hard Rules

- Do not put playbook.yaml inside data/skills/<id>/.
- Do not make SKILL.md an encyclopedia; keep detailed knowledge in rules, workflows, and references.
- Do not grant L2 high-risk authority. L2 can request L3 escalation only.
- Program companion Skills must state applicable Program/step types, allowed repairs, forbidden operations, and disposition reporting.
- If a repair requires restart, firewall change, credential change, private key edit, package downgrade, or data deletion, classify risk_too_high or needs_human_decision.
