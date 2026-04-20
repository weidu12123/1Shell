---
name: VPS 网站列表
icon: "🌐"
hidden: false
description: |
  List all websites configured in OpenResty / 1Panel on the target VPS.
  Parses conf.d/*.conf files to extract domain, port, HTTPS status and site directory.
  Each row has a Delete action that triggers the vps-website-delete Skill.
category: web
tags:
  - nginx
  - openresty
  - 1panel
  - website

hasPlaybook: true
---

# VPS 网站列表

## Common Tasks

| 用户意图 | 读取 |
|---------|------|
| 查看网站列表 | playbook.yaml |
