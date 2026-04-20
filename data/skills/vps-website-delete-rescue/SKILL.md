---
name: VPS 网站删除救援
icon: "🗑️"
hidden: false
description: |
  Rescue Skill: When the vps-website-list playbook's delete action fails
  (removing nginx conf, site files, or reloading OpenResty), guide the
  rescuer to diagnose and resolve the failure safely.
category: rescue
tags:
  - rescue
  - nginx
  - openresty
  - 1panel
  - website
  - delete
---

# VPS 网站删除救援

## Always Read
- rules/constraints.md
- references/known-issues.md

## Common Tasks

| 失败场景 | 读取 workflow |
|---------|--------------|
| conf 删除 / 目录删除 / nginx reload 失败 | workflows/diagnose.md |

## Known Gotchas

1. conf 文件有 `chattr +i` 属性时 rm 会报 "Operation not permitted"
2. 容器被重启后 docker exec 的容器名会变，需重新探测
3. nginx -t 失败时绝对不能 reload，先修 conf 再 reload
