---
name: program-authoring
description: 设计和生成 1Shell Program。用于创建或审查 program.yaml，判断 L1/L2/L3 边界、结果展示、事故升级、手动操作，以及是否需要配套 1Shell Skill Extension。
tags:
  - 1shell
  - program
  - authoring
---

# 1Shell Program Authoring

This is a Claude Code Skill for the creation phase. It teaches how to design a Program; it is not a runtime 1Shell Skill Extension and must not be installed under data/skills/.

## Always Read

- references/three-layer-design.md
- references/program-schema.md
- references/examples.md

## Common Tasks

| User intent | Read | Output |
|---|---|---|
| Create a Program | references/three-layer-design.md -> references/program-schema.md | data/programs/<id>/program.yaml |
| Add AI maintenance | references/three-layer-design.md | l2.skill decision plus companion Skill requirement |
| Add crisis handling | references/three-layer-design.md | incidents/l3 rules, not direct L3 execution |
| Review a Program | scripts/validate-program.js | concrete schema and boundary fixes |

## Authoring Flow

1. Decide whether the request is a one-shot script, Playbook, interactive Skill, or recurring Program.
2. Define the Program target, host selector, trigger, action names, and final result surface.
3. Define the frontend contract: action launchers, inputs, secret fields, confirm text, and render result for each action.
4. Split deterministic L1 exec/verify/render steps from AI-dependent L2 work.
5. Give every L1 exec step a real verify rule; numeric output must not rely on exit_code alone.
6. Default action failure behavior to on_fail: repair so L2 can classify and repair within a companion Skill boundary.
7. Add type: skill steps only when the Program explicitly needs AI judgment during normal execution.
8. Decide whether a companion 1Shell Skill Extension is required and name it in l2.skill.
9. Add L3 only for incidents, high risk, out-of-scope, human decision, suspected attack, or repeated failure.
10. End every action in a render step so every terminal state reaches the Results tab.
11. Add ui.instance_actions for multiple manual actions; destructive actions require style: danger and confirm.
12. Run scripts/validate-program.js and fix any frontend_contract_check issue before calling the Program done.

## Hard Rules

- Keep enabled: false for generated Programs.
- Prefer on_fail: repair; do not default to on_fail: escalate.
- Do not write legacy guardian.enabled.
- Do not put runtime repair instructions inside Program YAML; put them in a companion 1Shell Skill Extension.
- L2 can request L3 escalation, but must not get L3 execution authority.
- All final outcomes must render a result or an explanation.
- A Program is not done until `scripts/validate-program.js` passes, including frontend_contract_check.
