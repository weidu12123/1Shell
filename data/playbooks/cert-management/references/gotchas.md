# 已知踩坑

## 1. 80 端口占用（高频）

**症状**：standalone 验证失败，报 `Could not bind to port 80`

**原因**：Nginx / Apache / Caddy 等 Web 服务器占用了 80 端口

**解决**：
- 方案 A：临时停止 Web 服务 → 申请 → 恢复（推荐给 standalone）
- 方案 B：改用 DNS-01 验证（推荐给生产环境）
- 方案 C：使用 webroot 模式（如果有 Web 服务器且能配置 `/.well-known/acme-challenge/`）

**检查命令**：
```bash
ss -tlnp | grep ':80 '
lsof -i :80
```

## 2. Let's Encrypt 速率限制

**症状**：申请返回 `too many certificates already issued for exact set of domains`

**限制**：
- 每域名每周最多 5 张正式证书
- 同一 IP 每 3 小时最多 10 个 pending 订单

**预防**：
- 开发测试时使用 `--staging` / `--test` 参数
- 不要频繁重复申请同一域名

## 3. DNS 传播延迟

**症状**：DNS-01 验证失败，报 `DNS problem: NXDOMAIN`

**原因**：DNS 记录还没传播到 Let's Encrypt 的验证服务器

**解决**：
- acme.sh 默认等待 120 秒，通常够用
- 如果持续失败，手动等几分钟后重试
- 检查 CF Token 权限是否正确（需要 `Zone:DNS:Edit`）

## 4. 权限问题

**症状**：`Permission denied` 写入 `/etc/ssl/1shell/`

**原因**：当前用户不是 root

**解决**：使用 sudo，或确认 SSH 用户是 root