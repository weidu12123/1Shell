# Constraints

- Do not stop, restart, reload, or disable services unless explicitly allowed by the Program action.
- Do not edit private keys, SSH config, firewall rules, production certificates, package repositories, or system service units.
- Do not run destructive commands or delete logs.
- Only write Program steps when allow_write_program=true and the replacement is low-risk and deterministic.
- If repair requires service restart, firewall change, credential change, certificate mutation, data deletion, or host isolation, report risk_too_high or needs_human_decision.
- Use request_l3_escalation only for risk_too_high, needs_human_decision, out_of_scope with material impact, or suspected_incident.
