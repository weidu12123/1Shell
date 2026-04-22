# 修复流程

## 原则：先在主机上修，修好后固化到 program.yaml

---

## 场景 A：容器改名/ID 后缀变更

```bash
# 1. 找新容器名
docker ps -a --format '{{.Names}}\t{{.Status}}\t{{.Image}}' | grep -i "<镜像关键词>"

# 2. 验证新容器正常运行
docker inspect <新容器名> --format '{{.State.Status}}'

# 3. 用新名字测试原命令逻辑
docker exec <新容器名> <原命令> 2>&1
```

验证成功后：
- 调用 write_program_step，把 step.run 里的旧容器名替换为新容器名
- report_outcome=resolved

---

## 场景 B：容器意外退出（非正常停止）

```bash
# 1. 查退出原因
docker logs <容器名> --tail 50 2>&1

# 2. 尝试重启
docker start <容器名>

# 3. 验证重启后状态
sleep 3 && docker inspect <容器名> --format '{{.State.Status}}'
```

重启成功 → report_outcome=resolved（无需 write_program_step，命令本身没问题）
重启失败 → 查 logs 定位配置问题，若需人工 ask_user

---

## 场景 C：服务未启动

```bash
systemctl start <服务名> 2>&1
sleep 2
systemctl is-active <服务名>
```

---

## 场景 D：磁盘满

```bash
# 查占用
df -Ph / && du -sh /var/log/* 2>/dev/null | sort -rh | head -10

# 清理（安全操作）
journalctl --vacuum-size=200M 2>&1
docker system prune -f 2>&1

# 验证
df -Ph /
```

---

## 场景 E：命令路径变化

```bash
# 找新路径
which <命令> 2>/dev/null || find /usr /opt /root -name "<命令>" 2>/dev/null | head -3
```

找到后用 write_program_step 更新 step.run 里的路径。

---

## write_program_step 使用规则

1. 只有在 execute_command 验证新命令成功（exit=0 + 输出符合预期）后才调用
2. 只改失败的那个 step，不改其他 step
3. 调用后立即 report_outcome=resolved，不需要再次验证