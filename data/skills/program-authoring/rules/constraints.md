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

---

## 7. "本机" / local 的含义

**`local` = 1Shell 服务进程所在的 OS，不是用户浏览器所在的电脑。**

1Shell 可以跑在 Linux VPS 上，也可以跑在用户的 Windows/macOS 本机上。
所以 `local` 的 OS 类型不确定，**必须先用 execute_command 探测再写命令**：

探测命令：`uname -s 2>/dev/null || echo Windows`

- 返回 `Linux` → 用 /proc/stat、free、df -P 等 Linux 命令
- 返回 `Windows` 或探测失败 → 用 tasklist、wmic、PowerShell 等 Windows 命令
- 如果用户已明确说「部署在 VPS / 服务器上」→ 直接用 Linux 命令，无需探测

---

## 8. hosts 字段

- 若用户明确指定了主机 ID，用数组：`hosts: [host-abc, host-def]`
- 若用户说"所有主机"，用：`hosts: all`
- 不要编造 host ID，从用户提供的上下文中取

---

## 9. render step 规则

Program 的 `type: render` step 的输出会显示在程序页的 **「📊 结果」Tab** 中：

- cron 触发 / 手动触发时，render step 的数据实时推送到前端
- 每次新 run 开始会清空结果面板，显示最新数据
- 多个 render step 依次追加显示

**因此**：
- 采集类 Program（指标、日志、状态）**必须有 render step** 把数据展示出来
- 展示列表数据（多台 VPS 指标）用 `format: table`
- 展示单台详情（内存/CPU/磁盘）用 `format: keyvalue`
- 只有 1 个 render step 时放最后；有多个时按"总览 → 详情"顺序排列

### render step 合法字段

四种 format 公共字段：`title`、`subtitle`、`level`(info/success/warning/error)

| format | 专属字段 | 说明 |
|--------|---------|------|
| `keyvalue` | `items_from_steps: [{key, value_from, value, prefix, suffix, transform}]` | 从前面步骤 stdout 取值 |
| `keyvalue` | `items: [{key, value}]` | 静态键值对（可与 items_from_steps 共存） |
| `table` | `columns: []` + `rows_from_step` 或 `rows: [[]]` | 表格 |
| `message` | `content` 或 `content_from` | 文本消息 |
| `list` | `listItems: [{title, description}]` | 列表 |

**注意**：`items_from_steps`、`rows_from_step`、`content_from` 都是合法字段，不要误删。

---

## 10. cron 表达式格式

1Shell 使用 node-cron，支持 6 位（含秒）和 5 位（无秒）格式：
```
"*/1 * * * *"      # 每分钟（5 位）
"0 */5 * * *"      # 每 5 分钟（5 位）
"0 0 3 * *"        # 每天 3:00（5 位）
"*/30 * * * * *"   # 每 30 秒（6 位，含秒）
```

---

## 11. YAML 安全规则（edit 模式必须遵守）

以下写法会导致 program.yaml 解析失败，**绝对禁止**：

- `python3 - <<'PYEOF' ... PYEOF` — Python heredoc，`#` 注释破坏 YAML
- `python3 -c "..."` 多行字符串 — `try:` `except:` 等冒号触发 YAML mapping 解析
- 任何 `<<'EOF'` heredoc — YAML block scalar 内不支持

**替代方案**：
- 把 Python 逻辑写成单行（用 `;` 分隔语句，不换行）
- 或把脚本预先写到文件，step 只调用文件路径

---

## 12. ui.instance_actions 自定义实例按钮

当程序有**多个 action** 或需要给用户提供**多种操作入口**时，必须声明 `ui.instance_actions`：

```yaml
ui:
  instance_actions:
    - id: check_now          # 必填，唯一标识（snake_case）
      label: "▶ 立即检查"    # 按钮文本（默认等于 id）
      action: health_check   # 必填，映射到 actions{} 中的 action 名
      style: primary         # primary | success | danger | default
    - id: force_restart
      label: "⚠ 强制重启"
      action: restart_service
      style: danger
      confirm: "确认要在此主机上强制重启服务吗？"  # 可选，点击后弹出确认框
```

**何时使用**：
- 程序有 ≥2 个不同 action（如 `check` + `restart` + `cleanup`）→ **必须加**
- 程序只有 1 个 action 但需要更直观的按钮文本 → 建议加
- 程序只有 1 个 action 且默认"触发"按钮够用 → 不加（前端自动显示默认按钮）

**规则**：
- `action` 必须引用 `actions{}` 中已定义的 action 名，否则 schema 校验报错
- 破坏性操作（重启、删除、清理）**必须** `style: danger` + `confirm` 提示
- 按钮顺序 = 声明顺序，常用操作放前面
- `id` 用 snake_case，不允许连字符或数字开头

---

## 13. edit 模式最小修改原则

修改已有 program.yaml 时：
- 只改用户明确描述的字段
- 禁止删除用户未提及的 step
- 禁止修改 `enabled` 字段（除非用户明确要求）
- 禁止重写整个文件（除非用户明确说"重写"）
- 保留原有注释、字段顺序、格式风格
