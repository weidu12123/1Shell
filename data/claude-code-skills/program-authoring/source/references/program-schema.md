# Program Schema Authoring Reference

Use the current project schema as the source of truth, then apply these authoring rules.

```yaml
id: <program-id>
name: <human-name>
description: <clear purpose>
enabled: false
hosts: all

l2:
  skill: <program-l2-skill>
  max_repair_attempts: 1
  escalate_after_failures: 2
  allow_write_program: true

l3:
  skills:
    - guardian-protocol
  max_actions_per_hour: 10
  require_confirmation: true

triggers:
  - id: manual_run
    type: manual
    action: check

actions:
  check:
    on_fail: repair
    steps:
      - id: deterministic_check
        label: Deterministic check
        run: <portable shell command>
        verify:
          exit_code: 0
          stdout_match: <non-empty or domain-specific regex>
        capture_stdout: true
        on_error_hint: <what L2 should inspect first>
      - id: render_result
        type: render
        format: message
        title: Check result
        level: info
        content_from: deterministic_check

incidents: []
ui:
  instance_actions: []
```

## Required authoring checks

- enabled must stay false unless the user explicitly asks to enable it.
- Every action must have at least one render step.
- A numeric command needs stdout_match such as ^[0-9], not only exit_code: 0.
- on_fail defaults to repair, not escalate.
- type: skill steps need an explicit skill, goal, and preferably when.
- If a skill referenced by l2.skill or a type: skill step does not exist, generate a companion 1Shell Skill Extension first.
- L3 config uses l3.*, not guardian.enabled.
- Destructive instance actions need style: danger and confirm.
- Frontend contract must be complete: every action has a launcher/display name, renderable inputs, no secret render leakage, and a render result.
- Run `scripts/validate-program.js <program.yaml>` after writing; frontend_contract_check failures block completion.
