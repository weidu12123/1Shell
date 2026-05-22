# Three-Layer Program Design

## Layer boundaries

- L1 is deterministic execution: exec, verify, render. It should consume no AI tokens.
- L2 is Program-bound AI maintenance or explicit type: skill execution. It must stay inside the companion 1Shell Skill Extension.
- L3 is Guardian / 1Shell AI escalation for incidents, high risk, out-of-scope work, human decisions, suspected attacks, and repeated failure.

## Default flow

```text
L1 exec -> verify -> render
          |
          v
       on_fail: repair
          |
          v
L2 companion Skill classifies: resolved | unresolved | out_of_scope | risk_too_high | needs_human_decision | suspected_incident
          |
          v
Only high-risk / incident / human-decision cases request L3 escalation.
```

## L2 disposition rules

- resolved: a low-risk deterministic repair or replacement succeeded.
- unresolved: L2 cannot fix within allowed scope; render the explanation and do not automatically enter L3.
- out_of_scope: the needed work is outside the Program or companion Skill boundary; usually ask or request L3 review.
- risk_too_high: repair would restart services, change firewall, edit credentials, delete data, or alter production state; request L3 escalation.
- needs_human_decision: the correct action depends on owner intent or business context; request confirmation or L3 escalation.
- suspected_incident: evidence suggests attack, compromise, data loss, or active abuse; request L3 escalation.

## L3 escalation boundary

L2 may submit a structured request_l3_escalation request. It must not run Guardian commands or directly obtain L3 authority. L3 decides whether to accept, reject, queue, or ask the user for confirmation.
