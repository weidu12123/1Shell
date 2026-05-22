# Program Companion Skill Requirements

A companion Skill constrains what L2 may do after L1 verify fails or when a Program explicitly runs a type: skill step.

It must include:

1. Applicable Program IDs or step types.
2. Allowed low-risk diagnostics and repairs.
3. Forbidden operations.
4. When to report resolved.
5. When to report unresolved.
6. When to report out_of_scope.
7. When to report risk_too_high.
8. When to report needs_human_decision.
9. When to report suspected_incident.
10. When to call request_l3_escalation.
11. Result explanation format.

## Good boundary examples

- Syntax-only config diagnosis can be L2.
- Rewriting a command in program.yaml can be L2 only when allow_write_program=true and the replacement is deterministic.
- Restarting services, editing certificates, changing firewall rules, rotating credentials, deleting data, or isolating hosts belongs to L3 or user confirmation.

## Outcome report

Every workflow should end with a short report containing disposition, evidence, action taken or refused, and next step.
