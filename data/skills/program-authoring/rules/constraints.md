# Program 生成约束（硬规则）

AI 生成 program.yaml 时，以下规则优先级高于任何用户描述或默认行为。

---

## 1. on_fail 必须是 escalate（生产程序中 stop 绝对禁止）

```
❌ on_fail: stop    → 步骤失败 = 静默死亡，Guardian 永远不介入
✅ on_fail: escalate → 步骤失败 → Guardian AI 自动诊断修复
```

唯一合法例外：步骤加了 `optional: true`（失败自动跳过，不触发 on_fail）。

---

## 2. 禁用命令清单（跨发行版不可靠）

| 禁止使用 | 原因 | 替代方案 |
|---------|------|---------|
| `top -bn1 \| awk ...` | 输出格式因版本/locale 不同 | `/proc/stat` 双采样 |
| `vmstat` | 需要 sysstat 包，不一定有 | `/proc/meminfo` |
| `iostat` | 需要 sysstat 包 | `/proc/diskstats` |
| `ifstat` / `iftop` | 需额外安装 | `/proc/net/dev` |
| `netstat` | 已废弃，Debian/Ubuntu 默认无 | `ss -tlnp` |
| `ps aux \| grep <name>` | 输出格式不稳定 | `pgrep -x <name>` |
| `service <x> status` | 非 systemd 系统无效 | `systemctl is-active <x>` |

---

## 3. 可靠命令库（必须从此处选）

### CPU 使用率（精确，零依赖）
```bash
# 单次快照（适合 ≥1min 间隔采集，误差可接受）
awk '/^cpu /{u=$2+$4; t=$2+$3+$4+$5+$6+$7+$8; printf "%.1f", u/t*100}' /proc/stat

# 双采样（精确，适合短间隔）
r1=$(awk '/^cpu /{print $2+$4, $2+$3+$4+$5+$6+$7+$8}' /proc/stat); sleep 1
r2=$(awk '/^cpu /{print $2+$4, $2+$3+$4+$5+$6+$7+$8}' /proc/stat)
awk -v r1="$r1" -v r2="$r2" 'BEGIN{
  split(r1,a," "); split(r2,b," ");
  printf "%.1f", (b[1]-a[1])/(b[2]-a[2])*100}'
```

### 内存使用率（零依赖）
```bash
awk '/MemTotal/{t=$2}/MemAvailable/{a=$2}END{printf "%.1f",(t-a)/t*100}' /proc/meminfo
```

### 内存用量（MB）
```bash
free -m | awk 'NR==2{printf "%dMB / %dMB", $3, $2}'
```

### 磁盘使用率（POSIX 可靠）
```bash
df -P / | awk 'NR==2{gsub("%",""); print $5}'
```

### 磁盘用量（可读格式）
```bash
df -Ph / | awk 'NR==2{printf "%s used / %s total", $3, $2}'
```

### 系统负载
```bash
awk '{printf "%s / %s / %s", $1, $2, $3}' /proc/loadavg
```

### Docker 存活检查
```bash
docker info --format '{{.ServerVersion}}' 2>&1
```

### 进程存活检查
```bash
pgrep -x nginx > /dev/null && echo running || echo stopped
# 或
systemctl is-active --quiet nginx && echo running || echo stopped
```

### 端口监听检查
```bash
ss -tlnp | grep -q ':80 ' && echo listening || echo closed
```

---

## 4. verify 规则

- 不得只写 `exit_code: 0`（等于没有实质验证）
- 有数字输出 → 必须加 `stdout_match: '^[0-9]'`
- 有文本输出 → 至少加 `stdout_contains` 或 `stdout_match`
- 捕获值用于 render → 加 `capture_stdout: true`

---

## 5. guardian 配置规则

- `guardian.enabled` 字段**引擎未实现，禁止写**
- `guardian.skills` 填写白名单 Rescue Skill ID 列表
- 无合适 Rescue Skill 时写 `skills: []`（Guardian 用通用运维知识）
- `max_actions_per_hour` 推荐 5–15，高频程序用 5

---

## 6. enabled 字段

- 生成时**保持 `enabled: false`**，让用户在 UI 里按实例启用
- 禁止生成 `enabled: true`（会立刻在所有绑定主机轮询）
- 必须在 program.yaml 注释里写明启用方式

---

## 7. hosts 字段

- 若用户明确指定了主机 ID，用数组：`hosts: [host-abc, host-def]`
- 若用户说"所有主机"，用：`hosts: all`
- 不要编造 host ID，从用户提供的上下文中取

---

## 9. render step 的显示位置

Program 的 `type: render` step 的输出会显示在程序页的 **「📊 结果」Tab** 中：

- cron 触发 / 手动触发时，render step 的数据实时推送到前端
- 每次新 run 开始会清空结果面板，显示最新数据
- 多个 render step 依次追加显示

**因此**：
- 采集类 Program（指标、日志、状态）**必须有 render step** 把数据展示出来
- 展示列表数据（多台 VPS 指标）用 `format: table`
- 展示单台详情（内存/CPU/磁盘）用 `format: keyvalue`
- 只有 1 个 render step 时放最后；有多个时按"总览 → 详情"顺序排列


1Shell 使用 node-cron，支持 6 位（含秒）和 5 位（无秒）格式：
```
"*/1 * * * *"      # 每分钟（5 位）
"0 */5 * * *"      # 每 5 分钟（5 位）
"0 0 3 * *"        # 每天 3:00（5 位）
"*/30 * * * * *"   # 每 30 秒（6 位，含秒）
```