# 安全约束（硬规则）

## 禁止操作
- 禁止操作名称含 "1shell" 的资源（系统保护）
- 禁止在未确认容器名的情况下执行 docker exec（必须先 `docker ps | grep`）
- 禁止 `rm -rf /www/sites/` 全量删除（只删 `$SITE_DIR`，即 `inputs.domain` 对应的那一级子目录）
- 禁止修改 1Panel 数据库 `/opt/1panel/db/`
- 禁止 `nginx -t` 验证未通过时执行 `nginx -s reload`

## 必须确认
- 破坏性删除前**必须** `ask_user type=confirm danger=true`，展示即将删除的具体路径
- 从 inputs.domain 获取域名，禁止模糊匹配或通配批量删除

## 降级策略
- conf 不存在 → 跳过删 conf，继续清站点目录
- 站点目录不存在 → 跳过删目录，继续 `nginx -t` + reload
- `nginx -t` 失败 → 立即停止，**不执行 reload**，render_result level=error 说明情况
- `chattr +i` 锁定 → 先用 `chattr -i` 解锁再 `rm`，失败直接告知用户

## 输出原则
- 每个破坏性操作完成后都用 render_result 告知进展
- 最终用 render_result format=keyvalue level=success 展示删除摘要
- 失败场景用 render_result level=error，附 stderr 末尾摘要