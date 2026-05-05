# Program 生成反模式（不要做什么）

## ❌ 反模式 1：on_fail: stop

```yaml
# 错误
actions:
  collect_metrics:
    on_fail: stop    # 步骤失败 → 静默死亡，无任何 AI 介入，用户完全不知道
```

**后果**：任何步骤失败（网络抖动、命令不存在）都会让程序静默停止。
因为 cron 在后台运行，用户根本看不到失败，只会发现数据一直没更新。

```yaml
# 正确
actions:
  collect_metrics:
    on_fail: escalate  # 失败 → Guardian AI 自动诊断，尝试修复，不行通知用户
```

---

## ❌ 反模式 2：用 top 采集 CPU

```yaml
# 错误
- id: cpu_usage
  run: top -bn1 | awk '/Cpu\(s\)/ {printf "%.1f", $2+$4}'
```

**后果**：
- Ubuntu 22+：输出 `%Cpu(s):  2.0 us` → awk 匹配 `/Cpu\(s\)/` 但字段位置不同
- CentOS：输出 `Cpu(s):  2.0%us` → 格式完全不同
- 中文 locale：输出乱码 → awk 无输出 → verify stdout_match 失败

```yaml
# 正确
- id: cpu_usage
  run: awk '/^cpu /{u=$2+$4; t=$2+$3+$4+$5+$6+$7+$8; printf "%.1f", u/t*100}' /proc/stat
```

`/proc/stat` 是内核接口，格式永远不变，零依赖。

---

## ❌ 反模式 3：guardian.enabled 字段

```yaml
# 错误
guardian:
  enabled: true     # 这个字段在引擎中未实现，写了也没用
  skills: []
```

**后果**：`guardian.enabled` 是死字段，引擎只看全局 guardianService 是否存在，
不读 per-program 的 `enabled`。写了给用户造成"Guardian 已关闭/开启"的错误预期。
无论写 `true` 还是 `false` 都不生效——这个字段**不应该出现**。

```yaml
# 正确（完全不写 enabled 字段）
guardian:
  skills: []           # 只写 skills 和 max_actions_per_hour
  max_actions_per_hour: 10
```

---

## ❌ 反模式 4：verify 只有 exit_code: 0

```yaml
# 错误
- id: cpu_usage
  run: awk '/^cpu /{...}' /proc/stat
  verify:
    exit_code: 0    # awk 命令几乎永远返回 0，即使输出为空也是 0
```

**后果**：命令输出空字符串，但 verify 通过，render 显示空值，用户看到空数据。

```yaml
# 正确
- id: cpu_usage
  run: awk '/^cpu /{u=$2+$4; t=$2+$3+$4+$5+$6+$7+$8; printf "%.1f", u/t*100}' /proc/stat
  verify:
    exit_code: 0
    stdout_match: '^[0-9]'   # 确保有数字输出
  capture_stdout: true
```

---

## ❌ 反模式 5：step id 含连字符

```yaml
# 错误
steps:
  - id: cpu-usage     # 连字符，schema 校验失败
  - id: 1_mem_check   # 数字开头，校验失败
```

```yaml
# 正确（只用 snake_case，字母开头）
steps:
  - id: cpu_usage
  - id: mem_check
```

---

## ❌ 反模式 6：enabled: true

```yaml
# 错误
enabled: true   # 一旦服务重启，程序立即在所有绑定主机开始执行
```

**后果**：用户可能还没配置好主机或 Guardian，程序就已经在跑了，
失败后 Guardian 可能反复尝试修复，消耗配额。

```yaml
# 正确
enabled: false  # 用户在 UI 里按需启用单个实例
```