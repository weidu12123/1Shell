# Program Authoring Examples

See examples/basic-monitor.yaml for a pure L1 Program.

See examples/program-with-l2-skill.yaml for a Program that binds a companion runtime Skill and allows L2 maintenance after verify failure.

See examples/incident-escalation.yaml for a Program that keeps normal failures in L2 but defines an incident rule for suspected compromise.

When creating a new Program, adapt the smallest matching example and then run scripts/validate-program.js against the generated YAML.
