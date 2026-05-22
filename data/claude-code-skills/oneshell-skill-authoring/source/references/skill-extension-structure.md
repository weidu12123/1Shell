# 1Shell Skill Extension Structure

A runtime 1Shell Skill Extension lives under data/skills/<skill-id>/ and is executed or read by the 1Shell runner. It is not a Claude Code Skill package.

```text
data/skills/<skill-id>/
├── SKILL.md
├── rules/
│   └── constraints.md
├── workflows/
│   ├── repair.md
│   └── escalate.md
├── references/
│   └── domain.md
├── data/        # optional
├── scripts/     # optional
└── templates/   # optional
```

## File responsibilities

- SKILL.md routes tasks. It should contain description, Always Read, Common Tasks, and short gotchas.
- rules/ contains hard constraints, forbidden actions, required confirmations, and allowed command boundaries.
- workflows/ contains diagnostic flow, repair order, escalation flow, and outcome reporting.
- references/ contains domain knowledge, command references, sample outputs, and known pitfalls.

## SKILL.md rules

- Keep it concise, ideally under 100 lines.
- Always Read must point to required rules and workflows.
- Common Tasks should route to the right workflow.
- Do not duplicate long command catalogs or domain explanations in SKILL.md.
