# Program Schema 参考

## 什么是 Program

Program 是 1Shell 的**长驻运维程序**（`data/programs/<id>/program.yaml`），由 triggers 驱动，
在绑定的 hosts 上持续运行。与一次性的 Playbook 对比：

| | Playbook | Program |
|---|---|---|
| 运行模式 | 点击"运行"执行一次 | 启用后常驻后台 |
| 触发 | 手动 / 前端按钮 | cron / 手动 / (未来 watch/metric) |
| 实例 | 单次 run | 每台绑定 host 一个持久实例 |
| 异常处理 | 失败即停 / Rescuer 单次救援 | Guardian AI 自动介入诊断并修复 |
| 典型场景 | 一次性部署、批量删除 | 监控、健康检查、自愈守护 |

## 完整 schema

```yaml
# ─── 顶层 ───────────────────────────────────────────────────────────────
name: string          # 必填，人类可读名称
description: string   # 可选，多行说明
enabled: true         # 默认 true；新创建的建议填 false，让用户手动启用

# hosts：哪些主机上跑这个 Program
#   'all'             → 所有已托管主机（每台独立实例）
#   [hostId, ...]     → 指定主机 id 数组
#   hostId (字符串)   → 单一主机
hosts: all

# ─── triggers ─────────────────────────────────────────────────────────
triggers:
  - id: string          # 必填，唯一
    type: cron          # cron | manual （watch/metric 目前不支持）
    schedule: '*/5 * * * *'   # type=cron 必填，标准 cron 表达式（node-cron 语法）
    action: string      # 必填，指向 actions 里的 action 名

  - id: manual_check
    type: manual
    action: health_check

# ─── actions ──────────────────────────────────────────────────────────
# actions 是一个对象：{ action_name: { steps, on_fail } }
actions:
  health_check:
    # on_fail 三选一：
    #   stop      — 失败即终止本次 run（默认）
    #   ignore    — 失败跳过，继续后续 step
    #   escalate  — 调用 Guardian AI 介入诊断修复
    on_fail: escalate

    steps:
      # steps 语法**完全复用** playbook-schema（exec / render + verify）
      - id: string          # 必填，同 Playbook
        type: exec          # exec（默认）| render
        label: string
        run: string         # 必填（exec），shell 命令
        timeout: 30000
        optional: false
        capture_stdout: true
        verify:
          exit_code: 0
          stdout_match: '^[0-9]+$'
          stdout_contains: 'active'
          stderr_not_contains: 'Error'

# ─── guardian (Phase 3) ────────────────────────────────────────────────
# 当 action.on_fail === 'escalate' 时，Guardian AI 可以用以下 Skill 作为能力包：
guardian:
  enabled: true
  skills:                   # 允许 Guardian 读取的 Skill 白名单（参考其 rules + workflows）
    - docker-rescue
    - nginx-troubleshoot
  max_actions_per_hour: 20  # 每小时最多介入 N 次（滑动窗口），防止 AI 无限循环
```

## 完整示例

```yaml
name: VPS 健康监控
description: 每 5 分钟检查 docker / 磁盘 / 负载，失败自动 AI 诊断
enabled: false
hosts: all

triggers:
  - id: periodic_check
    type: cron
    schedule: "*/5 * * * *"
    action: health_check
  - id: manual_check
    type: manual
    action: health_check

actions:
  health_check:
    on_fail: escalate
    steps:
      - id: docker_up
        label: Docker 存活
        run: docker info --format '{{.ServerVersion}}' 2>&1
        verify: { exit_code: 0 }
        optional: true

      - id: disk_root
        label: 根分区使用率
        run: df -P / | awk 'NR==2 {gsub("%",""); print $5}'
        verify:
          exit_code: 0
          stdout_match: '^[0-9]+$'
        capture_stdout: true

guardian:
  enabled: true
  skills: [docker-rescue]
  max_actions_per_hour: 10
```

## 设计原则

1. **Program = 程序而不是脚本**：它在后台常驻，你不需要"点一次运行一次"
2. **steps 尽量短且独立**：每步只做一件小事，verify 要精确（用 exit_code + stdout_match），
   这样 Guardian 被唤起时能精准定位哪一步的哪个检查失败
3. **on_fail 的选择**：
   - 探测类 step（"容器在吗"）→ `optional: true`，失败跳过
   - 关键 step（"主服务必须活着"）→ 让 action 整体 `on_fail: escalate`，交给 Guardian
   - 清理类 step（"删临时文件"）→ `on_fail: ignore`
4. **guardian.skills 白名单**：必须是 **Skill**（`data/skills/`），不能是 Playbook。Skill 的
   rules + workflows + references 会拼进 Guardian 的 system prompt
5. **cron 表达式**：用 node-cron 语法，支持 `*/5 * * * *` 这样 5 字段或 `秒 分 时 日 月 周` 6 字段

## 禁止事项

- **禁止 enable: true 一开始就开**（除非用户明确要求）——新 Program 默认停用，由用户在 UI 上启用单个实例
- **禁止 steps 里直接放破坏性命令**（rm -rf、dd、mkfs 等）——这类操作应该放在 Skill 里，让 Guardian 在 `ask_user` 确认后再执行
- **禁止在 run 里用 ssh/scp** 去连接其他主机——Program 的每个实例已经绑定一个 host
- **禁止在 hosts 里混入 `local` 和远程 VPS**（如果命令用了 Linux-only 语法）——Windows 本机跑不了 `df -P /`