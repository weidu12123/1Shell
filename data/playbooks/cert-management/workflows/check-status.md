# 工作流：检查证书状态

适用场景：用户想查看某个域名当前的证书情况。

## 步骤

1. 检查 1Shell 标准路径下是否有证书：
   ```bash
   ls -la /etc/ssl/1shell/{{domain}}/ 2>/dev/null
   ```

2. 如果存在，读取证书详情：
   ```bash
   openssl x509 -noout -subject -issuer -dates -in /etc/ssl/1shell/{{domain}}/fullchain.pem
   ```

3. 同时检查 acme.sh / certbot 的管理列表：
   ```bash
   ~/.acme.sh/acme.sh --list 2>/dev/null | grep {{domain}}
   certbot certificates 2>/dev/null | grep -A5 {{domain}}
   ```

4. 检查自动续期状态：
   ```bash
   crontab -l 2>/dev/null | grep -i acme
   systemctl list-timers 2>/dev/null | grep certbot
   ```

## 输出

以表格形式汇总：

| 项目 | 值 |
|------|-----|
| 域名 | {{domain}} |
| 证书存在 | 是/否 |
| 证书路径 | /etc/ssl/1shell/{{domain}}/fullchain.pem |
| 签发者 | (从 openssl 读取) |
| 签发日期 | (从 openssl 读取) |
| 到期日期 | (从 openssl 读取) |
| 剩余天数 | (计算) |
| 自动续期 | 已配置/未配置 |
| 管理工具 | acme.sh / certbot / 未知 |