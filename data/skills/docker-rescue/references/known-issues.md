# Docker 已知坑位

整理自真实运维中常见的"非直觉失败"。命中模式后直接按照处方尝试。

## 1. `permission denied` on docker.sock
**现象**：`docker ps` 返回 `Got permission denied while trying to connect to the Docker daemon socket`

**判定**：当前用户不在 `docker` 组，或 sudo 透传丢失。

**处方**：先 `id -nG` 确认用户组；若缺 docker 组，**不要**自动 `usermod` — 这需要重新登录才生效，属于跨会话变更。直接 `give_up`，reason 写明需要运维把用户加入 docker 组后重新登录。

## 2. `Cannot connect to the Docker daemon at unix:///var/run/docker.sock`
**现象**：连接 daemon 失败

**判定**：daemon 未启动。

**处方**：`systemctl is-active docker` → 若非 active，`systemctl start docker`，等待 2s，retry_ok。若 systemd 无 docker unit，给 `give_up`（可能是 snap 安装或非 systemd 系统）。

## 3. `address already in use` / 端口绑定失败
**现象**：`Error starting userland proxy: listen tcp 0.0.0.0:<port>: bind: address already in use`

**判定**：端口被占用。

**处方**：`ss -ltnp 'sport = :<port>'` 或 `lsof -i:<port>`。如果占用者是另一个 docker-proxy（说明有旧容器未清），`patch_plan` 停掉旧容器后重试。如果是非 docker 进程，`give_up` 并说明占用者 PID/cmdline。

## 4. 容器 restart loop（`Restarting (1)`）
**现象**：`docker ps` 显示 `Restarting`

**判定**：启动命令失败，通常是配置或依赖问题。

**处方**：`docker logs --tail 100 <container>` 看栈末，不要盲目重启。大多数情况应 `give_up` 并把日志末 30 行写进 reason。

## 5. `no such image` 但本地 build 过
**现象**：拉取时报 `manifest unknown` 或 `no such image`

**判定**：镜像名带了错的 registry 前缀，或本地镜像没 tag。

**处方**：`docker images | grep <name>` 看本地是否有对应 tag；若有但名字不一致，`patch_plan` 修正镜像名再重试。