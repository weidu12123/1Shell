# Program L2 Dispositions

Program companion Skills must report exactly one disposition for each terminal L2 attempt.

| Disposition | Meaning | L3 behavior |
|---|---|---|
| resolved | Low-risk repair or deterministic replacement succeeded | Do not escalate |
| unresolved | L2 cannot solve within allowed scope | Render explanation; do not automatically escalate |
| out_of_scope | Required work is outside this Program/Skill boundary | Usually request user decision or L3 review |
| risk_too_high | Repair requires risky production change | Submit request_l3_escalation |
| needs_human_decision | Correct action depends on owner intent | Ask for confirmation or submit request_l3_escalation |
| suspected_incident | Evidence suggests attack, compromise, data loss, or active abuse | Submit request_l3_escalation |

## request_l3_escalation shape

```json
{
  "programId": "string",
  "runId": "string",
  "hostId": "string",
  "stepId": "string",
  "sourceLayer": "L2",
  "disposition": "risk_too_high",
  "severity": "warning | critical | emergency",
  "reason": "string",
  "evidence": [
    { "type": "stdout", "label": "nginx -t", "content": "..." }
  ],
  "requestedAction": "string",
  "userDecisionNeeded": "string | null"
}
```

L2 submits only the request. L3 decides whether to accept, reject, queue, or request confirmation.
