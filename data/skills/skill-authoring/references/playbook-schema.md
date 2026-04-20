# Playbook Schema 参考

## 什么是 playbook.yaml

`playbook.yaml` 是 Skill 的**确定性执行清单**。存在时，1Shell 会跳过 AI-loop，由 L1
执行器直接按步骤在目标主机上跑命令——**零 token 消耗**。

只有步骤失败且 verify 未通过时，才会唤醒 L2 AI Rescuer 介入修复（最多 `budget.max_rescues` 次）。

## 何时生成 playbook.yaml vs 传统 workflow

| 任务特征 | 选择 |
|---------|------|
| 步骤固定、命令确定、错误少见（信息采集、服务重启、状态查询） | **生成 playbook.yaml** |
| 步骤之间有大量条件分支、错误形态多变、需要深度推理（证书申请、故障排查、环境初始化） | **生成传统 workflows/*.md**，走 AI-loop |

简单判断：**命令能事先写死吗？** 能 → playbook；不能 → workflow。

## 完整 schema

```yaml
# ─── 顶层 ───────────────────────────────────────────────────────────────────
goal: string          # 必填，一句话描述目标（Rescuer 介入时会读到）
description: string   # 可选，对 goal 的补充说明

budget:
  max_rescues: 2      # AI 兜底最多介入次数，默认 2，最大 10
  max_tokens: 50000   # Token 软上限（用于审计，不强制熔断），默认 50000

steps:
  - id: string        # 必填，步骤唯一 ID，格式：^[a-zA-Z_][a-zA-Z0-9_]*$
    type: exec        # 'exec'（默认）| 'render'
    label: string     # 展示名，默认与 id 相同

    # ── exec 步骤专属字段 ────────────────────────────────────────────────
    run: string           # 必填，shell 命令（单行或多行 YAML literal block）
    timeout: 30000        # 超时毫秒，默认 30000，最大 600000
    optional: false       # true 时失败仅跳过，不触发 Rescuer
    capture_stdout: true  # 保存 stdout 供后续 render step 引用，默认 true
    on_error_hint: string # 可选，给 Rescuer 的中文修复提示

    verify:               # 成功判定（缺省只检查 exit_code === 0）
      exit_code: 0              # 期望退出码
      stdout_match: '^\d+'      # stdout 必须匹配此正则
      stdout_contains: "active" # stdout 必须包含此字符串
      stderr_not_contains: "Error" # stderr 不得含此字符串
      min_duration_ms: 100      # 最短执行时间（防止命令秒退）

    # ── render 步骤专属字段 ──────────────────────────────────────────────
    format: keyvalue      # 必填：keyvalue | table | list | message
    title: string
    subtitle: string
    level: info           # info | success | warning | error

    # keyvalue 格式
    items_from_steps:     # 从前面 exec step 的 stdout 组装 key-value
      - key: 展示名称
        value_from: step_id   # 取哪个 exec step 的 stdout
        transform: trim       # 可选变换：trim（去首尾空白）| first_line（只取第一行）
        prefix: "前缀"
        suffix: "%"
    items:                # 静态 key-value（不依赖 step 输出）
      - key: 版本
        value: "1.0"

    # table 格式
    columns: [列1, 列2, 列3]
    rows_from_step: step_id   # 用某 step 的 stdout 生成行；按 \n 分行，每行按 2+空格或 \t 分列
    rows:                     # 或者静态行数据
      - ["值1", "值2"]

    # list 格式
    listItems:
      - title: "项目标题"
        description: "项目描述"

    # message 格式
    content: "固定文本"
    content_from: step_id  # 用某 step 的 stdout 作为消息内容
```

## 完整示例：服务状态检查

```yaml
goal: 检查 nginx / mysql / redis 运行状态

budget:
  max_rescues: 1

steps:
  - id: nginx_status
    label: Nginx 状态
    run: systemctl is-active nginx 2>&1
    verify: { exit_code: 0, stdout_contains: "active" }
    on_error_hint: 若 nginx not found，先执行 apt-get install -y nginx

  - id: mysql_status
    label: MySQL 状态
    run: systemctl is-active mysql 2>&1 || systemctl is-active mysqld 2>&1
    verify: { exit_code: 0 }
    optional: true

  - id: redis_status
    label: Redis 状态
    run: systemctl is-active redis 2>&1 || systemctl is-active redis-server 2>&1
    verify: { exit_code: 0 }
    optional: true

  - id: render_status
    type: render
    format: keyvalue
    title: 服务运行状态
    level: info
    items_from_steps:
      - key: Nginx
        value_from: nginx_status
        transform: first_line
      - key: MySQL
        value_from: mysql_status
        transform: first_line
      - key: Redis
        value_from: redis_status
        transform: first_line
```

## 常见命令模式

### 采集数值（供 render step 用）

```bash
# CPU 使用率（数字）
top -bn1 | awk '/Cpu\(s\)/ {printf "%.1f", $2+$4}'

# 内存使用率（数字）
free -m | awk 'NR==2 {printf "%.1f", $3/$2*100}'

# 根分区使用率（数字，去 %）
df -P / | awk 'NR==2 {gsub("%","",$5); print $5}'
```

### 生成适合 table 渲染的输出（列用两个以上空格或 \t 分隔）

```bash
ps -eo comm,pcpu,user --sort=-pcpu --no-headers | head -3 \
  | awk '{printf "%s\t%s%%\t%s\n", $1, $2, $3}'
```

### 使用用户输入（inputs 插值）

```yaml
inputs 中定义的变量用 ${inputs.变量名} 插入 run 字段：

run: systemctl restart ${inputs.service_name}
```

## 注意事项

1. **step id 唯一**：同一 playbook 内不能重复
2. **render step 里的 `value_from`** 必须指向已经执行过的 exec step id
3. **多行命令**：YAML 使用 `|` 语法（literal block），每行可自由使用管道和重定向
4. **playbook.yaml 与 workflows/ 可共存**：前者用于确定性执行，后者保留给 AI-loop 的 fallback 参考
5. **不要在 run 里用交互式命令**：vim、nano、less 等会让 exec 挂起