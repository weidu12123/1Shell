---
name: 证书管理
icon: "\U0001F510"
hidden: true
description: This skill should be used when the user wants to apply, check, renew, deploy, or manage SSL/TLS HTTPS certificates on a remote host using Let's Encrypt via acme.sh or certbot.
category: web
tags:
  - HTTPS
  - SSL
  - Let's Encrypt
  - 证书
  - Caddy
  - Nginx
inputs:
  - name: domain
    label: 域名
    type: string
    required: true
    placeholder: example.com
  - name: email
    label: 邮箱（用于 LE 注册）
    type: string
    required: true
    placeholder: admin@example.com
  - name: provider
    label: 验证方式
    type: select
    required: true
    default: standalone
    options:
      - value: standalone
        label: HTTP-01（需要 80 端口可用）
      - value: cloudflare
        label: Cloudflare DNS-01（支持泛域名）
  - name: cf_token
    label: Cloudflare API Token
    type: string
    required: false
    placeholder: 使用 CF DNS 验证时必填
    visibleWhen:
      field: provider
      value: cloudflare
---

# 证书管理 Skill

## Always Read
- rules/constraints.md
- rules/security.md

## Common Tasks

| 用户意图 | 读取 |
|---------|------|
| 申请新证书（HTTP-01 / standalone） | workflows/apply-standalone.md |
| 申请新证书（DNS-01 / Cloudflare） | workflows/apply-cloudflare.md |
| 检查现有证书状态 | workflows/check-status.md |
| 配置或检查自动续期 | workflows/renew.md |
| 其他/未列出任务 | references/gotchas.md 然后自行判断 |

## Known Gotchas
1. **80 端口占用**：standalone 验证需要 80 端口空闲，Nginx/Apache/Caddy 可能占用 → 详见 references/gotchas.md
2. **证书路径不统一**：acme.sh 和 certbot 默认存储路径不同 → 详见 references/providers.md
3. **速率限制**：Let's Encrypt 每域名每周最多 5 张证书 → 先用 `--test`/`--staging` 测试