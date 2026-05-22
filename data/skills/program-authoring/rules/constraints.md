# Program 生成约束（硬规则）

AI 生成 program.yaml 时，以下规则优先级高于任何用户描述或默认行为。

---

## 1. on_fail 必须是 repair（L1 失败先进入 L2）

```
❌ on_fail: stop      → 步骤失败后直接终止，L2/L3 都无法介入
❌ on_fail: escalate  → 跳过 L2 维护边界，除非用户明确要求危机直升
✅ on_fail: repair    → L1 失败 → L2 维护 Skill 修复/分类 → 必要时再升级 L3
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

## 5. L2 / L3 配置规则

- 必须写 `l2.skill`，默认使用 `program-maintenance`
- L2 是 Program 绑定 Skill 约束下的维护层，不是全权 AI
- L3 使用 `l3.skills` 和 `l3.max_actions_per_hour`，不要再写旧 `guardian.enabled`
- L3 只用于 incident、L2 越界/高风险/需人工、疑似事故或重复失败
- `l3.max_actions_per_hour` 推荐 5–15，高频程序用 5

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

**注意**：`items_from_steps`、`rows_from_step`、`content_from` 都是合法字段，不要误删。`transform` 只允许 `trim` / `first_line` / `last_line` / `kv:<key>`，不要写 shell 管道。表格用 `row_separator` 指定分隔符。

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

## 12. Program 输入与 capability contract

当用户需求包含“在前端填入/选择/输入”任何运行参数时，Program 必须声明 `inputs` 或 `actions.<action>.inputs`，不能只把占位符写进 shell 命令。

```yaml
actions:
  request_certificate:
    label: 申请证书
    inputs:
      - name: domain
        label: 域名
        type: string
        required: true
        placeholder: example.com
      - name: cloudflare_api_key
        label: Cloudflare API Token
        type: password
        required: true
        secret: true
      - name: port
        label: 端口
        type: number
        required: true
        min: 1
        max: 65535
      - name: method
        label: 申请方式
        type: select
        required: true
        options:
          - value: cloudflare_dns
            label: Cloudflare DNS-01
          - value: http_standalone
            label: HTTP-01 standalone
    steps:
      - id: run_request
        run: |
          DOMAIN="{{ inputs.domain }}"
          CF_TOKEN="{{ inputs.cloudflare_api_key }}"
          PORT="{{ inputs.port }}"
```

**规则**：
- 需要用户填写参数的 action 必须有 `inputs`，UI artifact 根据这些字段组织专属交互。
- 密钥、Token、API Key 必须 `type: password` 或 `secret: true`，不得 render 输出。
- `{{ inputs.name }}` 只能引用已声明的 input；在 shell 中必须放进双引号赋值或双引号参数里。
- `select` 必须提供 `options`；端口等数字必须写 `type: number`、`min`、`max`。
- `ui.instance_actions` 只负责 Program action 入口声明，不能替代 input schema，也不能替代 UI artifact。
- 每个 action 必须有 render 结果，终态能在结果界面解释，不能只留下“运行失败”。

---

## 13. 可选精修模式 / 需求扩写

创作台应支持一个与安全模式并列的可选创作模式，例如「精修模式」「高质量创作」或「需求扩写」。

**默认行为**：不强制开启，保持快速创作路径。

**开启后**：生成 Program 前必须先把用户的自然语言需求扩写为结构化 Brief，作为后续 spec / plan / draft 的依据。Brief 至少包含：

- Program 定位：监控面板、证书工作台、部署向导、诊断工具等。
- 操作流程：用户打开 Program 后从选择对象、填写参数、执行动作到查看结果的完整路径。
- 主机选择：必须复用 1Shell 主机上下文/选择器，展示可读主机名、地址、用户或标签；禁止让用户手填 raw hostId。
- 输入契约：字段类型、required、secret、默认值、placeholder、number min/max、select options。
- 安全边界：不会修改什么；哪些动作需要 confirm；secret 不进入 DOM/log/render/localStorage。
- UI 质量目标：不能只有薄表单；应是专属小应用/工作台，覆盖空状态、运行中、成功、失败、L2/L3。
- 结果展示：成功结果、文件路径、指标摘要、下一步说明；失败时的脱敏错误和 AI 修复入口。
- 校验清单：`frontend_contract_check`、`ui_artifact_check`、`sandbox_preview_check` 必过。

如果用户确认 Brief 或说“按你的来”，再进入 Program 生成；如果用户只是要快速草案，不要强制精修模式。

---

## 14. Program UI artifact 硬规则

新建 Program 或重构 Program 主体验时，必须生成完整 UI artifact：

- `data/programs/<program-id>/ui/manifest.json`
- `data/programs/<program-id>/ui/App.jsx`
- `data/programs/<program-id>/ui/style.css`
- `data/programs/<program-id>/ui/DESIGN.md`

### manifest.json

- `schemaVersion` 必须是 `1`。
- `runtime` 必须是 `react-jsx`。
- `entry` 必须指向 `App.jsx`。
- `styles` 至少包含 `style.css`。
- `design` 必须指向 `DESIGN.md`。
- `permissions.actions` 只能列出 `program.yaml` 中真实存在的 action。

### App.jsx

- 使用 iframe 注入的全局 `React`、`ReactDOM`、`window.$oneShell`，第一阶段不得写 ESM `import` / `export`。
- 必须调用 `ReactDOM.createRoot(document.getElementById('root')).render(<App />)`。
- 执行动作只能用 `window.$oneShell.runAction(actionName, { hostId, inputs })`。
- 读取上下文与历史只能用 `useProgram`、`getRuns`、`getResults`、`getEvents`、`subscribe`。
- 禁止访问 `window.parent.document`。
- 禁止直接 `fetch('/api/...')` 访问 1Shell 私有 API。
- 禁止 `eval`、`new Function`、`localStorage`。
- secret 只能作为当前表单 state 和 action input；不得写入 DOM、console、localStorage、result。

### style.css / DESIGN.md

- CSS 只服务 sandbox iframe 内 UI，不依赖主应用 DOM 或外部 CDN。
- 必须覆盖空状态、加载中、成功、失败、disabled/loading 等基本状态。
- DESIGN.md 必须记录产品目标、布局、状态模型、bridge 使用、安全边界。

---

## 15. Program artifact gate

Program 页面只消费明确契约，不在运行时临时补齐半成品。生成或编辑 Program 后必须检查：

- `program.yaml` schema 可加载。
- `frontend_contract_check` 通过：action、input、render、confirm 都明确。
- `ui_artifact_check` 通过：manifest、entry、style、design、权限、安全 pattern 都有效。
- `sandbox_preview_check` 通过：App.jsx 可被 Babel standalone 转译，bridge 方法和 action 权限符合宿主白名单，srcdoc 体积在限制内。
- secret 字段使用 `type: password` 或 `secret: true`，且不进入 render、DOM、console、localStorage、result。
- 危险 action 有 `style: danger` + `confirm`，宿主确认不能被 UI 自己绕过。

强制命令：

```bash
node data/claude-code-skills/program-authoring/source/scripts/validate-program.js data/programs/<program-id>/program.yaml
```

脚本失败时必须修复 `program.yaml` 或 `ui/` 文件，不能进入 done。

---

## 16. ui.instance_actions 自定义实例按钮

当程序有**多个 action** 或需要给用户提供**多种操作入口**时，必须声明 `ui.instance_actions`：

```yaml
ui:
  instance_actions:
    - id: check_now
      label: "立即检查"
      action: health_check
      style: primary
    - id: force_restart
      label: "强制重启"
      action: restart_service
      style: danger
      confirm: "确认要在此主机上强制重启服务吗？"
```

**何时使用**：
- 程序有 ≥2 个不同 action（如 `check` + `restart` + `cleanup`）→ **必须加**
- 程序只有 1 个 action 但需要更直观的 action 文案 → 建议加
- 程序只有 1 个 action 且 UI artifact 已有明确入口 → 可以不加

**规则**：
- `action` 必须引用 `actions{}` 中已定义的 action 名，否则 schema 校验报错
- 破坏性操作（重启、删除、清理）**必须** `style: danger` + `confirm` 提示
- 按钮顺序 = 声明顺序，常用操作放前面
- `id` 用 snake_case，不允许连字符或数字开头

---

## 16. edit 模式最小修改原则

修改已有 Program 时：
- 先判断是能力变更、UI 体验变更，还是两者都有
- 能力变更改 `program.yaml`，并检查 UI artifact 是否仍匹配 action/input/render
- UI 体验变更改 `ui/App.jsx`、`ui/style.css`、`ui/DESIGN.md`，不得无故改 L1/L2/L3 能力
- manifest 权限变化必须和真实 action 同步
- 只改用户明确描述的字段或 UI 行为
- 禁止删除用户未提及的 step 或 UI 功能
- 禁止修改 `enabled` 字段（除非用户明确要求）
- 禁止重写整个文件（除非用户明确说“重写”或当前 artifact 架构已经不满足需求）
- 保留原有注释、字段顺序、格式风格
- 修改后必须重新运行 Program artifact gate
