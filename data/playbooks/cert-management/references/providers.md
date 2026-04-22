# 验证工具对比

## acme.sh vs certbot

| 维度 | acme.sh | certbot |
|------|---------|---------|
| 安装方式 | curl 一行命令 | apt/yum 安装 |
| 依赖 | 纯 shell，无依赖 | Python + 大量依赖 |
| 默认证书路径 | `~/.acme.sh/<domain>/` | `/etc/letsencrypt/live/<domain>/` |
| 自动续期 | cron | systemd timer |
| DNS 插件 | 内置 50+ DNS 提供商 | 需要额外安装 plugin |
| 推荐场景 | 轻量环境、容器内 | 已有 certbot 的主机 |

## Cloudflare API Token 要求

创建 Token 时需要以下权限：
- **Zone > DNS > Edit**（必需）
- **Zone > Zone > Read**（如果是多 Zone 场景）

Token 类型选 **Custom token**，不要用 Global API Key。

## 证书文件说明

| 文件 | 内容 | 用途 |
|------|------|------|
| fullchain.pem | 服务器证书 + 中间证书链 | Nginx/Apache 的 ssl_certificate |
| privkey.pem | 私钥 | Nginx/Apache 的 ssl_certificate_key |
| ca.pem | CA 证书 | 部分场景需要（OCSP stapling） |