# 删除网站失败诊断流程

## Step 1 · 读失败上下文

从失败步骤提取以下信息：
- **失败的 step id**：`find_openresty` / `delete_conf` / `delete_site_dir` / `reload_nginx`
- **错误信息**：stderr 里的关键词（`No such container` / `Permission denied` / `No such file` / `emerg`）
- **目标域名**：从 step 的 run 命令或上下文中提取（格式通常是 `<domain>.conf`）
- **容器名**：从 `find_openresty` step 的 stdout 中读取

## Step 2 · 单次探测（选一，按失败 step 对应）

| 失败 step | 探测命令 |
|-----------|---------|
| `find_openresty`（容器找不到） | `docker ps --format "{{.Names}}" \| grep -i openresty` |
| `delete_conf`（conf 删除失败） | `docker exec -u root <container> ls /usr/local/openresty/nginx/conf/conf.d/<domain>.conf 2>&1` |
| `delete_site_dir`（目录删除失败） | `ls /www/sites/ 2>/dev/null \| grep <domain>` |
| `reload_nginx`（reload 失败） | `docker exec <container> nginx -t 2>&1` |
| 不确定步骤 | `docker ps --format "{{.Names}}" \| grep -i openresty && docker exec $(docker ps --format "{{.Names}}" \| grep -i openresty \| head -1) nginx -t 2>&1` |

**执行探测时注意**：用从 `find_openresty` stdout 取到的真实容器名替换 `<container>`，
不要硬编码容器名后缀（后缀随部署变化）。

## Step 3 · 决断

根据探测结果选择 action：

### → `retry_ok`（可以直接重试/标记成功）
- conf 文件已不在容器内（删除成功但验证逻辑误判）
- 站点目录 `/www/sites/<domain>/` 已不存在
- nginx -t 通过 && 网站服务器直连已返回 404

### → `patch_plan`（需要先修复再重试）
- 容器名变更 → 重新 find_openresty 再重试
- Permission denied → 改用 `-u root` 重试
- nginx -t 报其他 conf 文件语法错误 → 告知用户需先修复其他网站配置
- conf 文件仍存在 → 检查权限，用 root 强制删除

### → `give_up`（需人工介入）
- docker 守护进程无响应（`docker ps` 超时）
- OpenResty 容器反复崩溃重启（`docker ps -a` 显示 Restarting）
- nginx -t 报错来自目标 conf 文件本身语法错误（文件未删除且无法删除）
- 1Panel 数据库不同步问题（需用户在面板操作）

## 反模式（不要做）

- ❌ 不要在不确认容器名的情况下直接执行删除命令——容器名后缀会变
- ❌ 不要跳过 `nginx -t` 直接 reload——语法错误会让整个 OpenResty 停服
- ❌ 不要删除 `/www/sites/` 目录本身（无域名限定）——会删掉所有网站
- ❌ 不要尝试修复 1Panel 数据库——这属于 give_up 场景，让用户在面板操作
- ❌ 不要因为"网站还能访问"就重复 reload——先用 curl 绕过 DNS 确认是否 CDN 缓存
