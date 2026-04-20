# Workflow: 删除 VPS 网站

## 触发场景

用户提到"删除网站"、"移除域名"、"下线站点"时进入本流程。

---

## 执行前必须搞清楚

- **OpenResty 容器是否存在？** `docker ps --filter name=openresty` 或 `docker ps | grep -i openresty`
  - 不存在 → render_result level=error 告知，停止
- **conf 文件在哪？** 两个常见路径：
  - `/usr/local/openresty/nginx/conf/conf.d/<domain>.conf`
  - `/etc/nginx/conf.d/<domain>.conf`
  - 两个都不存在也要告知用户，让其确认后可跳过 conf 删除
- **站点目录在哪？**
  - `/opt/1panel/apps/openresty/openresty/www/sites/<domain>/`（1Panel 标准路径）
  - `/www/sites/<domain>/`（旧版路径）
  - 不存在则跳过，不要报错

把探测结果汇总后进行二次确认，不要边探测边删除。

---

## 危险操作确认（必须）

列出即将删除的具体路径，用 `ask_user type=confirm danger=true`：
- 标题：`确认删除 <domain>？`
- 描述：conf 文件路径 + 站点目录路径（不存在的写"不存在，跳过"）
- 提示：删除后会执行 nginx -t 验证再 reload

用户取消 → `render_result format=message level=warn` 告知已取消，停止。

---

## 执行判断

按探测结果决策，不要假设路径：

**conf 文件存在时**：`docker exec -u root <容器名> rm -f <conf路径>`
- 若报 "Operation not permitted" 或 "Read-only file system" → 先 `lsattr <conf路径>` 检查是否 `+i`，有则 `chattr -i` 后再删

**站点目录存在时**：`rm -rf <站点目录>`
- 只删除明确探测到的路径，不要 glob 删除

**nginx 验证（必须在 reload 前做）**：`docker exec <容器名> nginx -t`
- 失败 → `render_result format=message level=error` 输出 stderr，告知"conf 已删但 nginx -t 不通过，请手动检查 conf.d 其他文件"，**停止，不执行 reload**

**reload**：`docker exec <容器名> nginx -s reload`

---

## 输出规范

成功时用 `render_result format=keyvalue level=success`：
- 标题：`网站 <domain> 已删除`
- 项目：域名 / conf 文件状态 / 站点目录状态 / nginx reload 结果

失败时用 `render_result format=message level=error`，包含失败原因和建议操作。

---

## 残留清理场景

用户说"清理残留"（conf 已删但目录还在，或反之）：
- 跳过二次确认中"不存在"的项目，只清理实际存在的部分，然后 reload