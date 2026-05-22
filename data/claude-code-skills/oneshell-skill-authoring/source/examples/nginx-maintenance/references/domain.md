# Nginx Domain Reference

Useful low-risk checks:

- nginx -t 2>&1
- nginx -V 2>&1 | head -1
- test -r <path> && echo readable || echo unreadable

Common nginx -t categories:

- syntax error: usually line-specific and may be suitable for a small deterministic Program fix.
- missing certificate path: usually needs user decision or certificate provisioning.
- private key permission denied: high risk; do not change permissions from L2.
- bind() address already in use: may require process/service decision; escalate or ask.
