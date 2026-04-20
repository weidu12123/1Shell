# 诊断流程：容器相关失败

标准的 Docker 相关失败救援流程，尽量用**最少的 execute_command** 定位。

## Step 1 · 读失败上下文
- 失败步骤的 `run` 命令里提到了 `docker` / `docker compose` / `container` 关键字？
- stderr 末尾是否匹配 `references/known-issues.md` 中的某条模式？**若匹配，直接跳到该条处方，不要再诊断**

## Step 2 · 单次探测（选一）
只选最相关的一条探测，不要堆命令：

| 线索 | 探测命令 |
|---|---|
| 怀疑 daemon 挂了 | `docker info 2>&1 \| head -5` |
| 怀疑容器状态问题 | `docker ps -a --filter name=<猜的容器名> --format '{{.Names}}\t{{.Status}}'` |
| 怀疑端口占用 | `ss -ltnp 'sport = :<port>' 2>/dev/null \|\| lsof -i:<port> 2>/dev/null` |
| 怀疑启动失败 | `docker logs --tail 30 <container> 2>&1` |

## Step 3 · 决断
根据探测结果，按 `rules/constraints.md` 的动作映射决定：

- 能 retry_ok，直接报告
- 需要新的步骤序列，`patch_plan` 写出 2-3 个新 step（每个有 verify）
- 涉及跨会话 / 网络 / 权限升级，`give_up` 把原因写清楚

## 反模式（不要做）
- ❌ 跑 `docker ps -a`（无过滤）然后肉眼搜 — 目标容器名应该从失败 step 推断
- ❌ 连续跑 3 条 docker 命令只为"了解状态"— 预算就 3 次，用掉了修不了
- ❌ 自动 `docker rm` 或 `docker rmi` — 除非 Playbook on_error_hint 明确授权