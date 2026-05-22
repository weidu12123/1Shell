# Program 生成 Workflow

## 前置：必须先读 rules/constraints.md

所有命令从 `rules/constraints.md` 的可靠命令库中选取。**禁止使用 `top`、`vmstat`、`netstat` 等不可靠命令。**

新 Program 必须同时生成：

- `data/programs/<program-id>/program.yaml`
- `data/programs/<program-id>/ui/DESIGN.md`
- `data/programs/<program-id>/ui/manifest.json`
- `data/programs/<program-id>/ui/App.jsx`
- `data/programs/<program-id>/ui/style.css`

---

## Step 0：可选「精修模式」需求扩写

创作台可以提供一个与「安全模式」并列的可选开关，例如「精修模式 / 高质量创作 / 需求扩写」。

- **关闭时**：保持快速创作，直接进入 Step 1。
- **开启时**：不得立刻生成文件；先把用户的一句话需求扩写成结构化 Brief，再基于 Brief 进入 Step 1。

精修模式的 Brief 必须覆盖：

```text
原始需求: <用户原话>
Program 定位: <这是监控面板 / 证书工作台 / 部署向导 / 诊断工具 / ...>
目标用户流程: <用户打开 Program 后如何完成任务>
主机选择: <必须使用 1Shell 主机选择器/上下文；禁止让用户手填 raw hostId>
输入字段: <字段、类型、required、secret、默认值、校验范围>
安全边界: <不会做什么；哪些动作需要确认；secret 如何处理>
能力契约: <actions、triggers、L2/L3、on_fail、render 结果>
UI 质量目标: <不是薄表单，而是专属小应用/工作台；包含空/运行中/成功/失败状态>
结果展示: <成功时展示什么路径、指标、摘要、下一步；失败时展示什么 AI 修复入口>
校验清单: <frontend_contract_check / ui_artifact_check / sandbox_preview_check 必过>
```

精修模式下，AI 可以先展示 Brief 摘要让用户确认；如果用户说“按你的来”，按推荐 Brief 继续生成。

---

## Step 1：理解需求

读用户描述，提取：
- **监控/采集目标**：CPU / 内存 / Docker / Nginx / 自定义服务…
- **触发方式**：cron 间隔（每分钟 / 每 5 分钟 / …）+ 是否需要手动触发
- **目标主机**：指定主机列表，还是 `all`；UI 必须用主机选择器/上下文展示可读主机名，禁止要求用户手填 raw hostId
- **告警阈值**（如有）：超过多少算异常
- **操作种类**：只需一个默认 action，还是需要多种操作入口（如检查 + 重启 + 清理）→ 决定 `actions` 与 `ui.instance_actions`
- **前端交互**：用户需要填写、选择、输入、上传、确认哪些内容；哪些是 secret；成功后展示什么结果
- **UI product goal**：用户打开 Program 页面时，应该看到哪个“专属小软件”体验，而不是通用表单

如信息不足，用 `ask_user type=input` 询问，不要假设。

---

## Step 2：规划并展示方案

用 `render_result format=keyvalue level=info` 列出：

```
Program ID: <kebab-case>
触发: cron <schedule>（+ manual）
目标主机: <host list 或 all>
Steps: N 个（列出 step id）
on_fail: repair（L1 失败先进入 L2）
L2 Skill: program-maintenance 或更具体的维护 Skill
L3 Incidents: <危机规则列表或"无">
Capability contract:
  - actions: <action 名称与用途>
  - inputs: <字段、类型、required、secret>
  - confirm: <危险操作确认文案或"无">
  - render: <成功后展示的 render step>
UI artifact:
  - 页面目标: <专属小软件要解决什么>
  - 布局: <主区域、表单、状态、结果、历史>
  - bridge: <runAction/getRuns/getResults/getEvents/subscribe 使用方式>
  - secret 处理: <只进 action input，不进 DOM/console/localStorage/result>
```

---

## Step 3：Program capability + UI artifact plan

在生成文件前必须先明确：

### program.yaml 能力契约

- 用户需要在哪些地方输入 / 选择 / 确认？
- 每个字段的 `type`、`required`、`default`、`placeholder`、`description` 是什么？
- 哪些字段是 secret，必须用 `type: password` 或 `secret: true`？
- 每个 action 的入口是什么？多 action 必须写 `ui.instance_actions`。
- 哪些 action 是危险操作，必须写 `confirm`？
- 每个 action 成功后由哪个 render step 展示结果？secret 不能出现在 render。
- L1 失败、L2 处理中、L3 需要确认时，结果界面应能解释哪个状态。

### UI artifact 体验契约

- `DESIGN.md` 记录产品目标、布局、状态、交互、安全边界。
- `manifest.json` 使用 `schemaVersion: 1`、`runtime: react-jsx`，`permissions.actions` 只能列出真实 action。
- `App.jsx` 必须调用 `ReactDOM.createRoot(...)` 渲染 root。
- `App.jsx` 只能通过 `window.$oneShell` bridge 访问宿主能力。
- `style.css` 只服务 iframe 内 UI，不依赖主应用 class 或外部 CDN。
- 空状态、运行中、成功、失败、需要确认、L2/L3 说明都要有可见表达。

---

## Step 4：生成 program.yaml

### 关键结构

```yaml
name: <中文名>
description: |
  <一句话描述，说明监控什么、多久一次、失败时怎么处理>

enabled: false          # 保持 false，用户在 UI 启用

l2:
  skill: program-maintenance
  max_repair_attempts: 1
  escalate_after_failures: 2
  allow_write_program: true

l3:
  skills:
    - guardian-protocol
  max_actions_per_hour: 10
  require_confirmation: true

hosts:
  - <hostId>            # 从用户上下文取，不要编造

triggers:
  - id: <snake_case>
    type: cron
    schedule: "<cron expression>"
    action: <action_name>
  - id: manual_run
    type: manual
    action: <action_name>

actions:
  <action_name>:
    label: <前端按钮/弹窗标题>
    on_fail: repair
    inputs:
      - name: <snake_case>
        label: <表单标签>
        type: string    # string | number | boolean | select | password | text
        required: true
        secret: false   # API Key / Token / 密码必须 true 或 type: password
    steps:
      - id: <snake_case>
        label: <中文描述>
        run: <从 rules/constraints.md 可靠命令库选取>
        verify:
          exit_code: 0
          stdout_match: '<正则>'
        capture_stdout: true
        on_error_hint: <失败时的诊断提示，L2 会读>

      - id: render_result
        type: render
        format: keyvalue
        title: <标题>
        level: info
        items_from_steps:
          - key: <标签>
            value_from: <step_id>
            suffix: "%"

incidents:
  - id: critical_example
    when:
      step: <step_id>
      stdout_match: <危机条件正则>
    severity: critical
    policy: ask_then_act

ui:
  instance_actions:
    - id: <snake_case>
      label: <按钮文本>
      action: <action_name>
      style: primary
    - id: <snake_case>
      label: <按钮文本>
      action: <另一个 action>
      style: danger
      confirm: <确认提示文本>
```

---

## Step 5：生成 UI artifact

### `ui/manifest.json`

```json
{
  "schemaVersion": 1,
  "runtime": "react-jsx",
  "entry": "App.jsx",
  "styles": ["style.css"],
  "design": "DESIGN.md",
  "permissions": {
    "actions": ["<action_name>"],
    "readRuns": true,
    "readResults": true,
    "readEvents": true,
    "requestL2": true,
    "requestL3": false
  }
}
```

### `ui/App.jsx`

必须满足：

- 使用 iframe 注入的全局 `React`、`ReactDOM`、`window.$oneShell`，不要写 `import` / `export`。
- 初始数据来自 `window.$oneShell.useProgram()`，并从 Program/宿主上下文组织主机选择 UI。
- 执行动作用 `window.$oneShell.runAction('<action_name>', { hostId, inputs })`；`hostId` 来自用户在 UI 中选择的 1Shell 主机，不允许要求用户手填内部 ID。
- 读取历史用 `getRuns` / `getResults` / `getEvents`。
- secret 只能保存在当前表单 state，提交成功后清空；不得写入 DOM、console、localStorage、result。
- 不得 `fetch('/api/...')`、不得访问 `window.parent.document`、不得 `eval` / `new Function`。
- 末尾必须：

```jsx
ReactDOM.createRoot(document.getElementById('root')).render(<App />);
```

### `ui/style.css`

- 写完整视觉状态，不依赖主应用 DOM。
- 至少覆盖桌面布局、窄屏布局、空状态、错误状态、按钮 disabled/loading 状态。

### `ui/DESIGN.md`

记录：产品目标、页面信息架构、交互流程、状态模型、安全约束、bridge 使用清单。

---

## Step 6：写入文件

用 `write_file` 写入：

- `data/programs/<program-id>/program.yaml`
- `data/programs/<program-id>/ui/DESIGN.md`
- `data/programs/<program-id>/ui/manifest.json`
- `data/programs/<program-id>/ui/App.jsx`
- `data/programs/<program-id>/ui/style.css`

---

## Step 7：Program artifact gate

写入后必须运行：

```bash
node data/claude-code-skills/program-authoring/source/scripts/validate-program.js data/programs/<program-id>/program.yaml
```

这个脚本至少包含：

- `program_schema_check`
- `frontend_contract_check`
- `ui_artifact_check`
- `sandbox_preview_check`

只有脚本通过，才允许进入成功反馈。失败时回到 Step 4 或 Step 5 修复对应文件，不得把 YAML-only、无 UI artifact、preview 失败或白屏风险的 Program 交付给用户。

---

## Step 8：成功反馈

```
render_result format=message level=success

Program「<name>」创建成功

路径：
- data/programs/<id>/program.yaml
- data/programs/<id>/ui/DESIGN.md
- data/programs/<id>/ui/manifest.json
- data/programs/<id>/ui/App.jsx
- data/programs/<id>/ui/style.css

启用方式：在程序管理页找到该 Program → 选择主机实例 → 点击「启用」
L2：<维护 Skill 与修复策略>
L3：<incident / 升级策略>
```

---

## Step 9：保持对话

用 `ask_user type=input`：
- title: "还要调整什么？"
- placeholder: "例如：把间隔改成 5 分钟 / 增加一个 Nginx 状态检查 step / 调整页面布局…"
