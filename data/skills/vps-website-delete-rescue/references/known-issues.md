# 已知坑位速查表

## 1. OpenResty 容器不存在或名称变更

**现象**：`docker exec 1Panel-openresty-XXXX ... ` 报错
`Error: No such container: 1Panel-openresty-XXXX`

**判定**：容器在上次查询后被重启或重建，容器 ID 后缀（如 `YygR`）已变化。

**处方**：
```bash
# 重新查找当前容器名
docker ps --format "{{.Names}}" | grep -i openresty | head -1
# 用新容器名重试删除操作
```

---

## 2. conf 文件删除失败（Permission denied）

**现象**：`docker exec <container> rm /usr/local/openresty/nginx/conf/conf.d/<domain>.conf`
报 `rm: cannot remove '...': Permission denied`

**判定**：容器内该文件被设置了不可变属性（chattr +i），或 docker exec 用户不是 root。

**处方**：
```bash
# 强制以 root 执行
docker exec -u root <container> rm -f /usr/local/openresty/nginx/conf/conf.d/<domain>.conf
# 若仍失败，检查 chattr
docker exec -u root <container> lsattr /usr/local/openresty/nginx/conf/conf.d/<domain>.conf
# 去除不可变标记后重试
docker exec -u root <container> chattr -i /usr/local/openresty/nginx/conf/conf.d/<domain>.conf
docker exec -u root <container> rm -f /usr/local/openresty/nginx/conf/conf.d/<domain>.conf
```

---

## 3. nginx -t 报语法错误（其他 conf 文件的问题）

**现象**：`docker exec <container> nginx -t` 报错
`nginx: [emerg] ... in /usr/local/openresty/nginx/conf/conf.d/other-site.conf:42`
（错误来自**非目标域名**的 conf 文件）

**判定**：目标 conf 已删除，但其他配置文件有语法错误，导致 reload 失败。

**处方**：
- 这不是目标删除操作的问题，conf 文件已成功删除
- 告知用户：目标网站 conf 已删除，但另一个网站配置有语法错误（指出文件名和行号），需要先修复才能 reload
- 推荐 action：`patch_plan`，建议用户在 1Panel 面板里修复该错误配置

---

## 4. 宿主机站点目录无法删除（目录不存在或非空保护）

**现象**：`rm -rf /www/sites/<domain>/` 报 `No such file or directory`

**判定**：目录已经被删除（可能在之前的步骤已成功），或者路径不正确。

**处方**：
```bash
# 先确认目录是否存在
ls /www/sites/ | grep <domain>
```
- 不存在 → 目录已删除，action `retry_ok`，标记此步骤成功
- 存在但路径不同 → 检查实际路径（1Panel 可能将站点放在其他位置）
```bash
find /www/sites -maxdepth 2 -name "*<domain>*" 2>/dev/null
```

---

## 5. OpenResty reload 后网站仍可访问

**现象**：`docker exec <container> nginx -s reload` 返回 exit_code 0，但域名仍然可以访问。

**判定**：通常是 CDN/反代缓存（Cloudflare、Nginx 上游缓存等），不是删除失败。

**处方**：
- 直接用 `curl -H "Host: <domain>" http://<server-ip>/` 绕过 DNS 测试
- 若服务器直连已返回 404 或 connection refused → 删除成功，是 CDN 缓存，action `retry_ok`
- 若服务器直连仍返回网站内容 → 检查是否有其他 server_name 匹配了该域名

---

## 6. 1Panel 面板与实际配置不同步

**现象**：手动删除 conf 文件和 /www/sites 目录后，1Panel 面板里网站列表仍显示该网站。

**判定**：1Panel 的 SQLite 数据库（`/opt/1panel/db/1Panel.db`）仍有该网站的记录。

**处方**：
- **不要手动修改数据库**（会导致面板异常）
- 告知用户：文件层面已删除，但需要在 1Panel 面板里手动同步/删除该网站记录
- 或者建议通过 1Panel CLI：`1panel website delete <website-id>`（如果版本支持）
- action：`give_up`（技术上已完成，需用户在 1Panel 界面操作）

---

## 7. SSL 证书文件残留

**现象**：conf 和 www 目录已删除，但 `/etc/letsencrypt/live/<domain>/` 或容器内
`/etc/ssl/certs/<domain>/` 仍有证书文件。

**判定**：证书文件不影响网站访问，只是磁盘残留。

**处方**：
- 告知用户：网站已彻底删除，证书文件属于残留但不影响运行
- 若用户要求清理：`docker exec <container> rm -rf /etc/ssl/certs/<domain>/`
  宿主机 Let's Encrypt 证书：`certbot delete --cert-name <domain>`（需确认）
- action：`retry_ok`（核心删除已完成）
