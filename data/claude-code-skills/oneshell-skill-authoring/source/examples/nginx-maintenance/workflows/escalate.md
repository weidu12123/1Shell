# Escalation Workflow

Submit request_l3_escalation only when L2 is not allowed to act safely.

Use risk_too_high for service restart, reload, firewall, certificate mutation, private key permission changes, package downgrade, or data deletion.

Use needs_human_decision when multiple valid fixes exist and the correct choice depends on owner intent.

Use suspected_incident when logs or command output suggest active abuse, compromise, credential probing, or tampering.

The request must include programId, runId, hostId, stepId, sourceLayer: L2, disposition, severity, reason, evidence, requestedAction, and userDecisionNeeded.

Do not run the requested L3 action from L2.
