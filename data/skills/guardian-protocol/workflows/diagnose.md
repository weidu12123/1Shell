# 通用诊断流程

## Step 1：读失败上下文（不执行任何命令）

从 Guardian 接收到的信息中提取：
- `failingStep.id` 和 `failingStep.run`：失败的步骤和命令
- `failureReason`：verify 失败的具体原因
- `stdout` / `stderr`：命令输出
- `on_error_hint`：程序作者的提示（最重要，优先参考）

**判断**：on_error_hint 是否已经指明根因？
- 是 → 直接进入 workflows/fix.md
- 否 → 继续 Step 2

---

## Step 2：最小化探测（1-3 条命令）

根据 failingStep 的类型选择探测命令：

**Docker 容器相关**
```bash
# 找实际容器名（支持模糊匹配）
docker ps -a --format '{{.Names}}\t{{.Status}}\t{{.Image}}' | grep -i "<关键词>"

# 查容器退出原因
docker inspect <容器名> --format '{{.State.Status}} exit={{.State.ExitCode}}'
docker logs <容器名> --tail 30
```

**服务/端口相关**
```bash
ss -tlnp | grep :<端口>
systemctl is-active <服务名>
systemctl status <服务名> --no-pager -n 20
```

**资源相关**
```bash
df -Ph / && free -m
```

**命令/路径相关**
```bash
which <命令> 2>/dev/null || echo "not found"
```

---

## Step 3：定位根因

根据探测结果分类：

| 探测结果 | 根因分类 | 下一步 |
|---|---|---|
| 容器 exited，exit=0 | 正常停止（用户操作） | ask_user 确认是否重启 |
| 容器 exited，exit≠0 | 意外崩溃 | docker logs 查原因，尝试重启 |
| 容器不存在 | 未部署/已删除/改名 | 模糊搜索找同类容器 |
| 端口未监听 | 服务未启动 | 尝试启动服务 |
| 磁盘满 | 资源耗尽 | 清理日志/缓存 |
| 命令不存在 | 环境变化 | 找替代路径或安装 |
| 配置错误 | 配置问题 | 查 stderr 定位具体字段 |