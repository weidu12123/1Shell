# 工作流：DNS-01 (Cloudflare) 申请证书

适用场景：验证方式为 `cloudflare`，使用 DNS-01 验证。支持泛域名。

## 前置检查

1. 检查是否已有该域名的有效证书（同 apply-standalone.md 第 1 步）

2. 确认 Cloudflare API Token 已提供
   - 如果 `{{cf_token}}` 为空 → 停止，提示用户提供 Token

3. 检查 acme.sh 是否已安装
   - 未安装 → 安装：`curl https://get.acme.sh | sh -s email={{email}}`

## 申请步骤

1. 配置 Cloudflare DNS API（通过环境变量，不写入命令行）：
   ```bash
   export CF_Token="{{cf_token}}"
   ```

2. 申请证书：
   ```bash
   ~/.acme.sh/acme.sh --issue -d {{domain}} --dns dns_cf --email {{email}}
   ```
   > 如果需要泛域名，加 `-d '*.{{domain}}'`

3. 安装到标准路径：
   ```bash
   mkdir -p /etc/ssl/1shell/{{domain}}
   ~/.acme.sh/acme.sh --install-cert -d {{domain}} \
     --fullchain-file /etc/ssl/1shell/{{domain}}/fullchain.pem \
     --key-file /etc/ssl/1shell/{{domain}}/privkey.pem
   ```

4. 设置权限：
   ```bash
   chmod 600 /etc/ssl/1shell/{{domain}}/privkey.pem
   chmod 644 /etc/ssl/1shell/{{domain}}/fullchain.pem
   ```

## 验证

```bash
openssl x509 -noout -subject -dates -in /etc/ssl/1shell/{{domain}}/fullchain.pem
```

## 注意事项

- DNS-01 不需要 80 端口，适合内网或无法开放 80 端口的场景
- CF_Token 应该具有 `Zone:DNS:Edit` 权限
- DNS 传播可能需要 30-120 秒，acme.sh 会自动等待