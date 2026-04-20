# 工作流：证书自动续期

适用场景：配置或检查证书自动续期。

## 检查当前续期配置

```bash
# acme.sh 的 cron
crontab -l 2>/dev/null | grep -i acme

# certbot 的 systemd timer
systemctl list-timers 2>/dev/null | grep certbot
systemctl is-enabled certbot.timer 2>/dev/null
```

## 配置续期（acme.sh）

acme.sh 安装时默认会配置 cron，但需要验证：

```bash
# 确认 cron 已安装
~/.acme.sh/acme.sh --install-cronjob

# 验证
crontab -l | grep acme
```

## 配置续期（certbot）

```bash
# 确认 timer 已启用
systemctl enable certbot.timer
systemctl start certbot.timer

# 测试续期（dry-run）
certbot renew --dry-run
```

## 手动续期测试

```bash
# acme.sh
~/.acme.sh/acme.sh --renew -d {{domain}} --force

# certbot
certbot renew --cert-name {{domain}} --force-renewal
```

## 续期后钩子

如果有 Web 服务器需要重载证书：
```bash
# 示例：Nginx
~/.acme.sh/acme.sh --install-cert -d {{domain}} \
  --fullchain-file /etc/ssl/1shell/{{domain}}/fullchain.pem \
  --key-file /etc/ssl/1shell/{{domain}}/privkey.pem \
  --reloadcmd "systemctl reload nginx"
```