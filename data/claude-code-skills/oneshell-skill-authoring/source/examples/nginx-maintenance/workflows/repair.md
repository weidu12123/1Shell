# Repair Workflow

1. Read the failing step, verify rule, stdout, stderr, previous step outputs, and Program l2 settings.
2. Classify the failure as command mismatch, missing binary, config syntax error, certificate path issue, private key permission issue, log access issue, or incident signal.
3. Run at most one low-risk diagnostic command before deciding.
4. If a deterministic Program command replacement is proven and allow_write_program=true, write the replacement and report resolved.
5. If the issue is ordinary missing dependency, environment mismatch, or unreadable output and no risky action is allowed, report unresolved with evidence.
6. If the issue requires service restart, private key permission change, certificate mutation, firewall change, or host isolation, switch to workflows/escalate.md.
7. End with one disposition: resolved, unresolved, out_of_scope, risk_too_high, needs_human_decision, or suspected_incident.
