# 工作流：HTTP-01 (standalone) 申请证书

适用场景：验证方式为 `standalone`，使用 HTTP-01 验证。

## 前置检查

1. 检查是否已有该域名的有效证书
   ```bash
   ls -la /etc/ssl/1shell/{{domain}}/ 2>/dev/null
   # 如有 fullchain.pem，检查有效期
   openssl x509 -noout -dates -in /etc/ssl/1shell/{{domain}}/fullchain.pem 2>/dev/null
   ```
   - 如果证书存在且剩余 > 30 天 → 停止，报告证书状态
   - 如果证书存在但即将过期 → 转到 workflows/renew.md

2. 检查 80 端口是否被占用
   ```bash
   ss -tlnp | grep ':80 '
   ```
   - 如果被占用 → 报告占用进程，询问用户是否临时停止该服务
   - 用户同意后记住服务名，申请完成后恢复

3. 检查 acme.sh 是否已安装
   ```bash
   command -v acme.sh || test -x "$HOME/.acme.sh/acme.sh" && echo "INSTALLED"
   ```
   - 未安装 → 安装：`curl https://get.acme.sh | sh -s email={{email}}`

## 申请步骤

1. 如果 80 端口被其他服务占用且用户同意临时释放：
   ```bash
   systemctl stop <service>  # 记住服务名
   ```

2. 申请证书：
   ```bash
   ~/.acme.sh/acme.sh --issue -d {{domain}} --standalone --email {{email}}
   ```

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

5. 恢复之前停止的服务（如有）：
   ```bash
   systemctl start <service>
   ```

## 验证

1. 检查证书文件存在且有效：
   ```bash
   openssl x509 -noout -subject -dates -in /etc/ssl/1shell/{{domain}}/fullchain.pem
   ```

2. 确认自动续期已配置 → 参见 workflows/renew.md

## 完成输出

输出表格：

| 项目 | 值 |
|------|-----|
| 域名 | {{domain}} |
| 证书路径 | /etc/ssl/1shell/{{domain}}/fullchain.pem |
| 私钥路径 | /etc/ssl/1shell/{{domain}}/privkey.pem |
| 到期时间 | (从 openssl 输出读取) |
| 续期方式 | acme.sh cron |