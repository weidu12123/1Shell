---
name: Docker 运维救援
icon: "🐳"
hidden: false
description: |
  Rescue Skill：当 Playbook 在 Docker 相关步骤失败（容器启动失败、镜像拉取失败、
  端口占用、权限问题等）时，给 rescuer AI 提供场景化诊断顺序与已知坑位。
  本 Skill 被 Playbook frontmatter 的 rescuer_skill 字段绑定后生效，不直接执行。
category: rescue
tags:
  - rescue
  - docker
  - container
---

# Docker 运维救援

## Always Read
- rules/constraints.md

## Common Tasks

| 失败场景 | 读取 workflow |
|---------|--------------|
| 容器启停 / 镜像拉取 / 端口冲突 / daemon 未运行 | workflows/diagnose.md |

## Known Gotchas

1. `docker info` 返回 "permission denied" → daemon 未运行或当前用户不在 docker 组
2. 端口冲突时 `ss -tlnp` 比 `netstat` 更可靠（netstat 可能未安装）