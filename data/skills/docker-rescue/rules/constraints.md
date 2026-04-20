# Docker 场景的诊断原则

这些是本 Rescue Skill 强调的诊断顺序与边界，不覆盖 rescuer 的硬约束。

## 诊断顺序（从便宜到昂贵）

1. **先看 daemon 是否运行**：`docker info >/dev/null 2>&1 || systemctl status docker`
2. **再看目标容器/镜像是否存在**：`docker ps -a --filter name=<xxx>` / `docker images | grep <image>`
3. **再看最近日志**：`docker logs --tail 50 <container>`（注意 `--tail` 而非全量）
4. **最后才考虑重启/重建**

## 边界

- **绝不** `docker rm -f` 用户未声明为"可销毁"的容器 — 先读 Playbook 的 goal 与 on_error_hint，如果没授权销毁，就 `give_up` 并说明原因
- **绝不** `docker system prune -a` 或任何全局清理命令 — 副作用超出本次失败步骤
- **绝不** 修改 `/var/run/docker.sock` 权限 — 生产环境常见踩坑，留给人工
- 端口占用时优先查进程（`ss -ltnp` / `lsof -i:<port>`），**不要**盲目杀进程

## 建议动作映射

| 失败现象 | 建议 action |
|---|---|
| daemon 未跑、已尝试 `systemctl start docker` 成功 | `retry_ok`（原步骤应已可通过） |
| 容器存在但 stopped，可安全 restart | `patch_plan`（新步骤 restart 后再 verify） |
| 镜像拉取超时 / registry 不可达 | `give_up`（网络问题非本层能解决） |
| 端口被未知进程占用 | `give_up`（需要人确认进程归属） |