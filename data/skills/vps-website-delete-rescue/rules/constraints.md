# 删除网站救援约束

## 诊断顺序（从便宜到昂贵）

1. **确认容器存活**：`docker ps --format "{{.Names}}" | grep -i openresty`
   - 有输出 → 继续；无输出 → 先排查容器问题，参见 known-issues #1
2. **确认 conf 文件是否还在**：
   `docker exec <container> ls /usr/local/openresty/nginx/conf/conf.d/<domain>.conf 2>&1`
   - 文件已不存在 → conf 删除成功，跳到步骤 4
3. **确认宿主机站点目录是否还在**：
   `ls /www/sites/<domain>/ 2>&1`
   - 目录已不存在 → 目录删除成功，跳到步骤 4
4. **确认 nginx 是否已重载**（网站还能访问则未生效）：
   `docker exec <container> nginx -t 2>&1`
   - 若配置检查报错 → 说明还有其他残留配置，参见 known-issues #3

## 边界（禁止操作）

- **禁止删除容器本身**（`docker rm`）：只能删除容器内的 conf 文件，不能动容器
- **禁止** `rm -rf /www/sites/` 不带具体域名：必须精确到 `/www/sites/<domain>/`
- **禁止修改** 1Panel 数据库（`/opt/1panel/db/` 或 MySQL）：1Panel 元数据由 1Panel 管理，手动改会导致面板与实际不一致
- **禁止** 在未确认域名的情况下批量删除 conf 文件
- **禁止** 跳过 `nginx -t` 直接 reload：配置有语法错误会导致 OpenResty 停止服务

## 建议动作映射

| 失败现象 | 推荐 action |
|---------|------------|
| docker exec 报 `No such container` | `patch_plan`：重新查找容器名再重试 |
| `rm` conf 文件报 `Permission denied` | `patch_plan`：以 root 权限删除或用 docker exec 删除 |
| `nginx -t` 报语法错误（非目标域名文件） | `patch_plan`：先修复其他错误配置，再 reload |
| `nginx -t` 报目标域名 conf 仍被包含 | `patch_plan`：conf 未真正删除，重新删除 |
| 目录删除成功但网站仍可访问（CDN 缓存） | `retry_ok`：说明只是 CDN 缓存，实际已删除 |
| `/www/sites/<domain>/` 不存在 | `retry_ok`：目录已被删除，标记成功 |
| 多次 reload 失败，OpenResty 进程异常 | `give_up`：需要人工介入重启容器 |
