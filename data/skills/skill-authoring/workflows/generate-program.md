<!-- smoke-test: meta-workflow -->
# Workflow: Generate Program — 创作长驻程序

> **先读** `data/skills/program-authoring/rules/constraints.md` — 那里有命令白名单、
> `on_fail` 强制规则、L2/L3 配置规范、UI artifact 安全规则和 sandbox preview gate。
>
> **注意**：Studio 的 `create-program` 模式会直接路由到 `program-authoring` Skill 运行。
> 本 workflow 在 `classify` 路由推荐 Program 时使用。两者规则一致。

## 什么时候用本 workflow

- classify workflow 推荐 `Program`（持续性任务）
- 用户明确选了“创作 Program”模式
- 用户想组合（Program + companion L2 Skill）→ 先用 `generate-bundle.md`，会调用本 workflow

## 第零步：可选精修模式 / 需求扩写

如果创作台开启了「精修模式 / 高质量创作 / 需求扩写」，不要立即写文件；先把用户的简短需求扩写为结构化 Brief，再进入第一步。

Brief 至少包含：Program 定位、用户流程、主机选择方式、输入字段、secret 处理、安全边界、UI 质量目标、成功/失败结果展示、L2/L3 路径和 artifact gate 清单。主机选择必须使用 1Shell 上下文/选择器展示可读主机，禁止要求用户手填 raw hostId。

如果精修模式关闭，保持快速创作，直接进入第一步。

## 第一步：挖掘触发条件、执行步骤与 UI 产品目标

用户的需求描述里至少要找出：

- **触发**：周期（每 5 分钟 / 每小时 / 每天）→ cron 表达式
- **作用域**：一台主机 / 多台 / 所有已托管主机 → `hosts: all` 或 `[id1, id2]`；UI 中必须显示可读主机选择，不暴露 raw hostId 给用户手填
- **L1 步骤**：每次触发可确定执行的 exec / verify / render
- **L2 维护边界**：哪些 verify 失败适合 `on_fail: repair`，由哪个 companion Skill 约束
- **L3 升级边界**：哪些 incident、高风险、越界、疑似攻击或需人工判断才进入 L3
- **操作种类**：程序有多种操作（检查 / 重启 / 清理）→ 需要 `ui.instance_actions` 自定义按钮
- **能力契约**：action 入口、inputs、secret 字段、confirm 文案、render 结果必须在 YAML 中明确表达
- **UI artifact**：这个 Program 在页面上应该是什么专属小软件，而不是通用 schema 表单

**命令选取**：只用 `program-authoring/rules/constraints.md` 里的可靠命令库（禁用 `top`、`vmstat`、`netstat`）。

### L2 决策规则

L1 verify 失败默认走 `on_fail: repair`，由 `l2.skill` 指向的 companion 1Shell Skill 进行分类和低风险维护。

当一个步骤满足以下任一条件时，可额外使用 `type: skill` 步骤：
- 需要根据上下文做判断
- 有多条低风险修复路径
- 操作超出单条确定性命令，但仍在 companion Skill 允许范围内
- 需要适配不同环境

`type: skill` 必须配合 `skill`、`goal`，并强烈建议加 `when` 条件，避免无谓 token 消耗。

**重要：Skill 必须先存在。** `l2.skill` 和 `type: skill` 引用的 Skill ID 必须在 `data/skills/` 下存在。
若不存在，必须先创建 companion 1Shell Skill（至少 SKILL.md + rules/constraints.md + workflows/repair.md + workflows/escalate.md），然后 `reload_registry`，再写 Program 文件。

### L3 决策规则

L3 只处理：
- incident 命中
- L2 判断 `risk_too_high`
- L2 判断 `needs_human_decision`
- L2 判断 `suspected_incident`
- L2 判断重大 `out_of_scope`
- 重复失败超过 `escalate_after_failures`

`unresolved` 不自动进入 L3；必须在结果界面渲染原因说明。

### UI artifact 决策规则

Program 页面主体验由 sandbox iframe 运行 `ui/` artifact，不再依赖旧固定 App Shell 临时补齐半成品。生成前必须规划：

- `ui/DESIGN.md`：产品目标、布局、状态模型、交互流程、安全边界
- `ui/manifest.json`：`schemaVersion: 1`、`runtime: react-jsx`、entry/styles/design、bridge permissions
- `ui/App.jsx`：使用全局 `React` / `ReactDOM` / `window.$oneShell`，不得 import/export
- `ui/style.css`：iframe 内样式，覆盖空态、加载、错误、成功、disabled/loading、响应式
- action 调用：只能用 `window.$oneShell.runAction`，且 action 必须在 manifest permissions 与 program.yaml 中同时存在
- 数据读取：用 `useProgram`、`getRuns`、`getResults`、`getEvents`、`subscribe`
- secret：Token/API Key/密码必须 `type: password` 或 `secret: true`，只进入 action input，不进 DOM/console/localStorage/result
- 危险操作：破坏性操作必须由 program.yaml/ui.instance_actions 声明 `style: danger` + `confirm`，UI 自己弹窗不能替代宿主确认

## 第二步：展示方案

用 `render_result format=keyvalue level=info` 简述：产物 ID、绑定主机、触发、L1 steps、L2 Skill、L3 incident/escalation 条件、capability contract、UI artifact 页面目标/布局/bridge/secret 策略。

然后立即写入文件。

## 第三步：生成文件

必须写入完整 Program artifact：

- `data/programs/<id>/program.yaml`
- `data/programs/<id>/ui/DESIGN.md`
- `data/programs/<id>/ui/manifest.json`
- `data/programs/<id>/ui/App.jsx`
- `data/programs/<id>/ui/style.css`

### program.yaml 模板

```yaml
id: <program-id>
name: <中文名>
description: |
  <说明做什么、为何要常驻、预期的成功/失败表现>

enabled: false

hosts: <all 或 [id1, id2]>

l2:
  skill: <program-l2-skill>
  max_repair_attempts: 1
  escalate_after_failures: 2
  allow_write_program: true

l3:
  skills:
    - guardian-protocol
  max_actions_per_hour: 10
  require_confirmation: true

triggers:
  - id: <snake_case_id>
    type: cron
    schedule: "<5位或6位 cron 表达式>"
    action: <action_name>
  - id: manual_run
    type: manual
    action: <action_name>

actions:
  <action_name>:
    label: <中文标签>
    on_fail: repair
    inputs:
      - name: <snake_case>
        label: <表单标签>
        type: string
        required: true
    steps:
      - id: <step_id>
        label: <中文标签>
        run: <来自 program-authoring/rules/constraints.md 可靠命令库的命令>
        verify:
          exit_code: 0
          stdout_match: '^[0-9]'
        capture_stdout: true
        on_error_hint: <给 L2 companion Skill 的中文诊断提示>

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
  - id: <snake_case_id>
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
```

### ui/manifest.json 模板

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

### ui/App.jsx 必须满足

- 末尾调用 `ReactDOM.createRoot(document.getElementById('root')).render(<App />);`
- 只能用 `window.$oneShell` bridge，不得直接 `fetch('/api/...')`
- 不得访问 `window.parent.document`
- 不得使用 `eval`、`new Function`、`localStorage`
- secret 提交成功后清空，不显示、不打印、不写结果

## 第四步：Program artifact gate

写入后必须运行：

```bash
node data/claude-code-skills/program-authoring/source/scripts/validate-program.js data/programs/<id>/program.yaml
```

脚本失败时修复对应文件，不得把 Program 页面不可渲染、缺少 UI artifact、`ui_artifact_check` 失败或 `sandbox_preview_check` 失败的产物交付为 done。

## 第五步：告知成功 + 保持对话

```
render_result format=message level=success
Program「<name>」创建成功
路径：
- data/programs/<id>/program.yaml
- data/programs/<id>/ui/DESIGN.md
- data/programs/<id>/ui/manifest.json
- data/programs/<id>/ui/App.jsx
- data/programs/<id>/ui/style.css
启用：程序页 → 实例 Tab → 点“启用”→ 在 Program Artifact Host 中操作
L2：<companion Skill 与修复策略>
L3：<incident / 升级策略>
```

然后 `ask_user type=input`，title: "还要调整什么？"

## 第四点五步：用户追加需求 → 修改已有文件，不是新建任务

当用户在 Program 创建成功后继续发言时，必须判断意图：

- 用户说“还要加 xxx”/ “没有做 xxx”/ “漏了 xxx” → 修改刚才写的 Program 文件
- 能力变化改 `program.yaml`，UI 变化改 `ui/`，action/permission 变化两边同步
- 绝对禁止：重新走 classify 决策树，把补充需求当成新任务，另建 Program/Skill
- 修改完成后重新运行 Program artifact gate，再用 `render_result` 告知已更新哪些文件

## 第五步：判断是否推荐 companion L2 Skill

如果 Program 需要 AI 维护边界，或 `l2.skill` 指向的 Skill 不存在，主动创建 companion L2 Skill，而不是把运行时知识塞进 program.yaml。

## 常见错误（写完自检）

- [ ] 只写了 program.yaml，缺少 ui/ artifact
- [ ] action 没有 render step 结尾（必须有，结果导向）
- [ ] `on_fail: stop` 用于生产监控（必须 `repair`）
- [ ] `on_fail: escalate` 跳过 L2（除非用户明确要求危机直升）
- [ ] 用了 `top`、`vmstat`、`netstat`（用 `/proc/stat`、`/proc/meminfo`、`ss`）
- [ ] 写了 `guardian.enabled` 字段（引擎不读）
- [ ] 写了旧 `guardian` 配置而不是 `l2` / `l3`
- [ ] `enabled: true`（默认 false）
- [ ] verify 只写 `exit_code: 0` 没有 `stdout_match`
- [ ] step id 含连字符或从数字开头
- [ ] `type: skill` 步骤没有 `skill` / `goal`
- [ ] `type: skill` 步骤没有 `when` 条件（浪费 token）
- [ ] `type: skill` 引用了不存在的 Skill ID
- [ ] 多 action 程序没有 `ui.instance_actions`
- [ ] 需要用户填写/选择但没有声明 inputs
- [ ] secret 字段没有 `password` / `secret: true`，或被 render/DOM/console/localStorage/result 输出
- [ ] select 没有 options，number 没有 min/max
- [ ] 破坏性按钮没有 `style: danger` 或缺少 `confirm` 确认提示
- [ ] `manifest.permissions.actions` 引用了不存在的 action，或漏掉 App.jsx 中的 runAction
- [ ] `App.jsx` 直接 fetch 私有 API、访问父窗口 DOM、使用 eval/new Function/localStorage
- [ ] 没有运行 `validate-program.js` 或 `ui_artifact_check` / `sandbox_preview_check` 未通过
