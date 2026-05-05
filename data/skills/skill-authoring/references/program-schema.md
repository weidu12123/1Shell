# Program Schema — 快速参考

> 本文档是 `query_format("program")` 的返回内容。
> 创建规则已内置于系统提示，此处提供模板、render 格式和可靠命令库。

## 模板

```yaml
name: <中文名>
description: |
  <说明>

enabled: false          # 新创建必须 false

hosts: all              # all | [hostId, ...] | hostId

triggers:
  - id: <snake_case>
    type: cron
    schedule: "<cron 表达式>"    # node-cron 支持 5 位和 6 位（含秒）
    action: <action_name>
  - id: manual_run
    type: manual
    action: <action_name>

actions:
  <action_name>:
    on_fail: escalate           # 生产程序必须 escalate，禁止 stop
    steps:
      # ── exec 步骤（L1） ──
      - id: <snake_case>        # 字母开头，下划线分隔，禁止连字符
        label: <中文标签>
        run: <shell 命令>       # 从下方可靠命令库选取
        verify:
          exit_code: 0
          stdout_match: '^[0-9]'   # 有数字输出必须写
        capture_stdout: true       # 值要用于 render 时加
        on_error_hint: <给 Guardian 的诊断提示>

      # ── skill 步骤（L2，按需加） ──
      - id: <snake_case>
        type: skill
        label: <中文标签>
        skill: <skill-id>          # 必须是 data/skills/ 下已有的 Skill
        goal: <一句话描述 AI 任务>
        when:                      # 强烈建议加 when，避免无谓 token 消耗
          step: <前置步骤 id>
          stdout_match: <匹配异常的正则>

      # ── render 步骤（必须有，放最后） ──
      - id: render_result
        type: render
        format: keyvalue           # keyvalue | table | message | list
        title: <标题>
        level: info                # info | success | warning | error
        items_from_steps:
          - key: <显示标签>
            value_from: <step_id>  # 引用前面步骤的 stdout
            suffix: "%"            # 可选

# ── monitors（可选，L3 声明式健康检查） ──
monitors:
  - id: <snake_case>
    check: <shell 命令>
    expect: { exit_code: 0 }       # 或 stdout_contains / stdout_match
    interval: "*/5 * * * *"
    action: <action_name>

guardian:
  skills: []                       # Rescue Skill ID 列表，无则留空
  max_actions_per_hour: 10         # 推荐 5-15
  # 注意：guardian.enabled 字段引擎未实现，禁止写

# ── ui（多 action 程序必须加） ──
ui:
  instance_actions:
    - id: <snake_case>
      label: <按钮文本>
      action: <action_name>        # 指向 actions{} 里的 action
      style: primary               # primary | success | danger | default
    - id: <snake_case>
      label: <按钮文本>
      action: <另一个 action>
      style: danger
      confirm: <确认提示>          # 破坏性操作必须加
```

## render 步骤格式详解

四种 format，公共字段：`title`、`subtitle`、`level`

### keyvalue — 键值对展示
```yaml
- id: render_status
  type: render
  format: keyvalue
  title: 系统状态
  level: info
  items_from_steps:            # 从前面步骤的 stdout 取值
    - key: "CPU 使用率"
      value_from: cpu_usage    # step id
      suffix: "%"
      prefix: ""               # 可选
      transform: trim          # 可选：trim | first_line | json_path:xxx
    - key: "内存使用率"
      value_from: mem_usage
      suffix: "%"
  items:                       # 或直接写死值（二者可共存）
    - key: "检查时间"
      value: "刚才"
```

### table — 表格展示
```yaml
- id: render_table
  type: render
  format: table
  title: 容器列表
  columns: ["容器名", "状态", "端口"]
  rows_from_step: list_containers   # 从某个 step 的 stdout 解析（JSON 数组）
  # 或静态 rows:
  # rows: [["nginx", "running", "80"], ["redis", "running", "6379"]]
```

### message — 文本消息
```yaml
- id: render_msg
  type: render
  format: message
  title: 检查结果
  level: success
  content_from: check_output   # 从某个 step 的 stdout 取全文
  # 或静态 content:
  # content: "所有检查通过"
```

### list — 列表展示
```yaml
- id: render_list
  type: render
  format: list
  title: 发现的问题
  level: warning
  listItems:
    - title: "磁盘空间不足"
      description: "根分区使用率超过 90%"
```

## 可靠命令库

以下命令跨发行版可靠，零依赖。**禁止使用 `top`、`vmstat`、`iostat`、`netstat`。**

```bash
# CPU 使用率（单次快照，适合 ≥1min 间隔）
awk '/^cpu /{u=$2+$4; t=$2+$3+$4+$5+$6+$7+$8; printf "%.1f", u/t*100}' /proc/stat

# 内存使用率
awk '/MemTotal/{t=$2}/MemAvailable/{a=$2}END{printf "%.1f",(t-a)/t*100}' /proc/meminfo

# 内存用量（MB）
free -m | awk 'NR==2{printf "%dMB / %dMB", $3, $2}'

# 磁盘使用率
df -P / | awk 'NR==2{gsub("%",""); print $5}'

# 系统负载
awk '{printf "%s / %s / %s", $1, $2, $3}' /proc/loadavg

# Docker 存活
docker info --format '{{.ServerVersion}}' 2>&1

# 进程存活
pgrep -x nginx > /dev/null && echo running || echo stopped

# 端口监听
ss -tlnp | grep -q ':80 ' && echo listening || echo closed
```

## 常见错误

- `on_fail: stop` → 静默死亡，用 `escalate`
- `guardian.enabled: true` → 引擎不读此字段，禁止写
- `enabled: true` → 会立即在所有主机执行，用 `false`
- `verify` 只写 `exit_code: 0` → 等于没验证，加 `stdout_match`
- step id 用连字符 `cpu-usage` → 校验失败，用 `cpu_usage`
- `type: skill` 没有 `when` → 每次都消耗 token，加条件
- 多 action 没有 `ui.instance_actions` → 用户只看到一个默认"触发"按钮
- `run` 里用 heredoc `<<'EOF'` → YAML 解析失败
- `run` 里用多行 Python → 冒号触发 YAML mapping 解析，用单行或脚本文件
