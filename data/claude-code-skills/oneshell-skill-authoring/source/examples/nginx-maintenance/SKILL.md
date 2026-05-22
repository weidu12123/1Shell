# nginx-maintenance

## Description

Use this skill when a Program L1 step related to Nginx health, config test, reload validation, log diagnosis, or certificate path verification fails.

## Always Read

- rules/constraints.md
- workflows/repair.md
- workflows/escalate.md

## Common Tasks

- Diagnose nginx -t failure -> workflows/repair.md
- Classify certificate or private key permission issue -> workflows/escalate.md
- Report unresolved Program failure -> workflows/repair.md

## Known Gotchas

- Never reload or restart Nginx unless the Program explicitly allows it and config test passes.
- Private key permission changes require human confirmation.
