# 约束规则

以下规则在所有证书管理操作中必须遵守，无例外。

## 工具选择
- 优先使用 **acme.sh**（更轻量、无依赖）
- 如果主机已安装 certbot 且用户未指定偏好，可沿用 certbot
- 如果两者都未安装，安装 acme.sh

## 证书存储
- 所有证书统一安装（install/deploy）到 `/etc/ssl/1shell/{{domain}}/` 目录
- 目录结构：
  ```
  /etc/ssl/1shell/example.com/
  ├── fullchain.pem
  ├── privkey.pem
  └── ca.pem (如有)
  ```
- **不要**直接使用 acme.sh/certbot 的内部存储路径作为最终路径

## 幂等性
- 执行前必须检查是否已有该域名的有效证书（剩余 > 30 天）
- 如果证书已存在且有效，**不重复申请**，直接报告状态
- 如果证书即将过期（≤ 30 天），执行续期而非重新申请

## 自动续期
- 完成申请后必须配置自动续期
- 优先使用工具自带的 cron/timer（acme.sh --install-cronjob / certbot renew timer）
- 验证续期配置已生效

## 输出格式
- 任务完成后以简洁表格汇总：域名、证书路径、到期时间、续期方式
- 使用 `openssl x509 -noout -dates -in <cert>` 验证证书有效性