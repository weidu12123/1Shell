---
name: 删除 VPS 网站
icon: "🗑️"
hidden: false
description: |
  Delete a website from OpenResty / 1Panel / nginx on a VPS: remove the conf.d file,
  clean the site directory under /www/sites/, and reload the web server. Triggered
  from vps-website-list row action, or invoked directly with an explicit domain.
  Use this when the user asks to remove / tear down / take offline a website.
category: web
tags:
  - nginx
  - openresty
  - 1panel
  - website
  - delete

inputs:
  - name: domain
    label: 域名
    type: string
    required: true
    placeholder: 例如：example.com
  - name: action
    label: 操作
    type: string
    required: false
    default: delete
---

# 删除 VPS 网站

本 Skill 是 **AI 驱动的能力包**。AI 根据 Common Tasks 路由到对应 workflow，
严格遵守 rules/ 下的约束，按需加载 references/ 中的参考资料。

## Always Read
- rules/constraints.md

## Common Tasks

| 用户意图 | 读取 |
|---------|------|
| 删除网站 / 下线域名 | workflows/delete.md |
| 仅清理残留（conf 已丢失）| workflows/delete.md 的"残留清理"段 |

## Known Gotchas
1. **OpenResty 容器名每台主机不同** — 必须用 `docker ps | grep openresty` 动态探测
2. **chattr +i 锁定** — rm 失败时检查 `lsattr`，必要时先 `chattr -i`
3. **nginx -t 失败时绝不 reload** — 宁可残留 conf 也不能把整个 web 服务弄崩
4. **站点目录路径有两种** — `/opt/1panel/apps/openresty/openresty/www/sites/<d>` 和 `/www/sites/<d>`，两处都要查
5. **1Panel 容器里 `-u root` 可能需要** — 配置文件由 root 写入时