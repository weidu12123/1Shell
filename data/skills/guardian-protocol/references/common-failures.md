# 常见 VPS 故障速查

## Docker 容器

| 症状 | 诊断命令 | 常见原因 |
|---|---|---|
| docker inspect 报 "no such object" | `docker ps -a \| grep -i <关键词>` | 容器改名/未创建/已删除 |
| 容器 exited exit=0 | `docker logs <name> --tail 20` | 用户主动停止，通常不需修复 |
| 容器 exited exit=1 | `docker logs <name> --tail 50` | 配置错误/启动脚本失败 |
| 容器 exited exit=137 | `free -m` | OOM Kill，内存不足 |
| 容器 exited exit=143 | — | SIGTERM 超时，通常是 docker stop |
| 容器 restarting | `docker logs <name> --tail 20` | 启动循环失败，检查配置 |

**容器名变更规律（1Panel）**：
1Panel 管理的容器名格式为 `1Panel-<app>-<随机4字符>`，重装/重建后后缀会变。
遇到容器不存在时先执行：
```bash
docker ps -a --format '{{.Names}}\t{{.Status}}\t{{.Image}}' | grep -i "<app名关键词>"
```

---

## 端口/网络

| 症状 | 诊断命令 |
|---|---|
| 端口未监听 | `ss -tlnp \| grep :<port>` |
| 端口被占用 | `ss -tlnp \| grep :<port>` → 找 pid → `ps -p <pid> -o comm=` |
| 网络不通 | `curl -sS --max-time 5 <url> 2>&1` |

---

## 系统资源

| 症状 | 诊断命令 |
|---|---|
| 磁盘满 | `df -Ph /` |
| 内存不足 | `free -m` |
| 高负载 | `cat /proc/loadavg` |
| 日志占满磁盘 | `du -sh /var/log/* 2>/dev/null \| sort -rh \| head -5` |

---

## Nginx / OpenResty（1Panel 容器内）

| 症状 | 诊断命令 |
|---|---|
| nginx 配置错误 | `docker exec <容器名> nginx -t 2>&1` |
| nginx 进程未运行 | `docker exec <容器名> pgrep nginx` |
| 访问日志路径 | 通常在容器内 `/logs/nginx_access.log` 或 `/var/log/nginx/access.log` |

---

## 常见坑

1. **1Panel 容器名后缀变更**：重建后 `1Panel-xxx-ABCD` 变成 `1Panel-xxx-EFGH`，是正常行为
2. **容器内没有 systemctl**：容器里用 `s6-svc` 或直接 `kill -HUP <pid>` 重载
3. **iptables 在 Docker 网络中需要谨慎**：添加规则前确认不会影响容器互联
4. **`date -d` 在 Alpine 容器内不可用**：Alpine 用 BusyBox date，语法不同