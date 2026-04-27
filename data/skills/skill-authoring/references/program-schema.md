# Program Schema 参考

## 什么是 Program

Program 是 1Shell 的**长驻运维程序**（`data/programs/<id>/program.yaml`），由 triggers 驱动，
在绑定的 hosts 上持续运行。与一次性的 Playbook 对比：

| | Playbook | Program |
|---|---|---|
| 运行模式 | 点击"运行"执行一次 | 启用后常驻后台 |
| 触发 | 手动 / 前端按钮 | cron / 手动 / (未来 watch/metric) |
| 实例 | 单次 run | 每台绑定 host 一个持久实例 |
| 异常处理 | 失败即停 / Rescuer 单次救援 | L2 Skill AI 约束执行 + L3 Guardian AI 全权介入 |
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
      # steps 三种类型：exec（默认）| render | skill
      # ─── exec 步骤（L1，确定性，0 token）─────────────────────
      - id: string          # 必填，同 Playbook
        type: exec          # 默认
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

      # ─── skill 步骤（L2，Skill 驱动的 AI，约束执行）──────────
      # 用于 L1 做不到的场景：需要判断力、多分支决策、复杂修复
      - id: string
        type: skill
        label: string
        skill: string       # 必填，Skill ID（data/skills/<id>/）
        goal: string        # 必填，AI 的任务目标（一句话）
        when:               # 可选，不满足则跳过此步
          step: string      # 引用前置步骤的 id
          exit_code: 0      # 可选，检查 exit_code
          exit_code_not: 0  # 可选，检查 exit_code 不等于
          stdout_contains: 'string'  # 可选
          stdout_match: 'regex'      # 可选
        optional: false
        on_error_hint: string   # 可选，给 AI 的修复提示

# ─── monitors（L3 声明式健康检查，可选）────────────────────────
# 定期在每台绑定主机上执行检查命令，不符合预期时自动唤醒 Guardian AI
monitors:
  - id: string            # 必填，唯一
    check: string         # 必填，要执行的 shell 命令
    expect:               # 期望结果，不满足则触发 L3
      exit_code: 0        # 默认检查 exit_code === 0
      stdout_contains: 'string'  # 可选
      stdout_match: 'regex'      # 可选
    interval: '*/5 * * * *'  # 必填，cron 表达式
    action: string        # 必填，触发哪个 action

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

      # L2 skill 步骤：磁盘使用率过高时用 AI 清理
      - id: disk_cleanup
        type: skill
        label: AI 磁盘清理
        skill: disk-cleanup
        goal: "清理磁盘空间，确保根分区使用率低于 80%"
        when:
          step: disk_root
          stdout_match: '^[8-9][0-9]$|^100$'

# L3 声明式健康检查：nginx 挂掉时自动唤醒 Guardian
monitors:
  - id: nginx_alive
    check: "curl -sf http://localhost/ > /dev/null"
    expect: { exit_code: 0 }
    interval: "*/5 * * * *"
    action: health_check

guardian:
  enabled: true
  skills: [docker-rescue]
  max_actions_per_hour: 10
```

## 设计原则

1. **结果导向**：每个 Program 的 action **必须**以 `type: render` 步骤结尾，将关键数据输出到前端「结果」Tab。用户看不到 render 就等于看不到程序在跑。手动触发时 render 是唯一的反馈。
2. **三层渐进架构**：能用 L1（exec + verify）解决的不上 L2，L2（skill 步骤）解决不了的才 escalate 到 L3（Guardian）
2. **L2 skill 步骤的使用场景**：
   - 需要根据运行结果做判断（如"磁盘满了该删什么"）
   - 有多种修复路径需要 AI 选择
   - 操作复杂度超出单条 bash 命令
   - 配合 `when` 条件实现"只在异常时才启动 AI"
3. **monitors 的使用场景**：
   - 关键服务存活检查（nginx、MySQL、Redis）
   - 端口可达性检查
   - 日志异常 pattern 检测
   - 与 triggers 独立：triggers 按时间跑 action，monitors 按时间检查健康
4. **steps 尽量短且独立**：每步只做一件小事，verify 要精确
5. **on_fail 的选择**：
   - 探测类 step → `optional: true`，失败跳过
   - 关键 step → `on_fail: escalate`，交给 L3
   - 清理类 step → `on_fail: ignore`
6. **skill 步骤必须配合已有 Skill**：`skill` 字段必须指向 `data/skills/` 下的一个 Skill ID

## 禁止事项

- **禁止 enable: true 一开始就开**（除非用户明确要求）——新 Program 默认停用，由用户在 UI 上启用单个实例
- **禁止 steps 里直接放破坏性命令**（rm -rf、dd、mkfs 等）——这类操作应该放在 Skill 里，让 Guardian 在 `ask_user` 确认后再执行
- **禁止在 run 里用 ssh/scp** 去连接其他主机——Program 的每个实例已经绑定一个 host
- **禁止在 hosts 里混入 `local` 和远程 VPS**（如果命令用了 Linux-only 语法）——Windows 本机跑不了 `df -P /`