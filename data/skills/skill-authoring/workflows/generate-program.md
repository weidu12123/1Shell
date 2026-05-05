<!-- smoke-test: meta-workflow -->
# Workflow: Generate Program — 创作长驻程序

> **先读** `data/skills/program-authoring/rules/constraints.md` — 那里有命令白名单、
> `on_fail` 强制规则、`guardian` 配置规范。本文件只写 workflow 步骤。
>
> **注意**：Studio 的 `create-program` 模式会直接路由到 `program-authoring` Skill 运行。
> 本 workflow 在 `classify` 路由推荐 Program 时使用。两者规则一致。

## 什么时候用本 workflow

- classify workflow 推荐 `Program`（持续性任务）
- 用户明确选了"创作 Program"模式
- 用户想组合（Program + Rescue Skill）→ 先用 `generate-bundle.md`，会调用本 workflow

## 第一步：挖掘触发条件与执行步骤

用户的需求描述里至少要找出：

- **触发**：周期（每 5 分钟 / 每小时 / 每天）→ cron 表达式
- **作用域**：一台主机 / 多台 / 所有已托管主机 → `hosts: all` 或 `[id1, id2]`
- **步骤**：每次触发要干嘛？通常 2-5 个 step
- **失败处理**：生产 Program **必须** `on_fail: escalate`，`on_fail: stop` 只用于开发测试
- **操作种类**：程序有多种操作（检查 / 重启 / 清理）→ 需要 `ui.instance_actions` 自定义按钮
- **L2 判断**：是否有步骤需要 AI 判断力？（见下方 L2 决策规则）
- **L3 监控**：是否需要独立于 triggers 的健康检查？（如服务存活）

**命令选取**：只用 `program-authoring/rules/constraints.md` 里的可靠命令库（禁用 `top`、`vmstat`、`netstat`）。

### L2 决策规则：何时用 `type: skill` 步骤

当一个步骤满足以下任一条件时，用 `type: skill` 而非 `type: exec`：
- **需要根据上下文做判断**：如"磁盘满了，决定删什么"
- **有多条修复路径**：如"服务挂了，可能是配置错 / OOM / 端口冲突"
- **操作超出单条命令**：需要多轮诊断-执行-验证
- **需要适配不同环境**：同一步骤在不同主机上可能需要不同操作

必须配合 `when` 条件使用：先用 L1 exec 步骤检测状态，`when` 判断异常时才触发 L2，避免无谓的 token 消耗。

**重要：Skill 必须先存在。** `skill` 字段引用的 Skill ID 必须在 `data/skills/` 下存在。
若不存在，必须**先用 `write_file` 创建 Skill**（至少包含 SKILL.md + workflows/），然后 `reload_registry`，再写 program.yaml。
创建 Skill 时走 `workflows/generate-skill.md` 的标准流程。

### L3 决策规则：何时加 monitors

当程序需要在 **action 之外** 独立监控某个关键状态时加 monitors：
- 关键服务存活（nginx、MySQL、Redis、Docker）
- 端口可达性
- 证书过期检查
- 日志异常 pattern

monitors 与 triggers 独立运行：triggers 按时间执行 action，monitors 按时间检查健康状态。

### UI 决策规则：何时加 `ui.instance_actions`

当程序有 **≥2 个 action** 或需要给用户提供不同操作入口时：
- **必须声明 `ui.instance_actions`**，为每个用户可触发的 action 配置一个按钮
- 不加 `ui` 时前端只显示一个默认"触发"按钮，无法区分不同操作
- 破坏性操作（重启、删除、清理）**必须** `style: danger` + `confirm` 确认提示
- 只有 1 个 action 且默认按钮够用时可以不加

## 第二步：展示方案

用 `render_result format=keyvalue level=info` 简述：产物 ID、绑定主机、触发、步骤数、失败处理。

然后**立即**并行 `write_local_file`。

## 第三步：program.yaml 模板

```yaml
name: <中文名>
description: |
  <说明做什么、为何要常驻、预期的成功/失败表现>

enabled: false   # 新创建默认停用

hosts: <all 或 [id1, id2]>

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
    on_fail: escalate    # 生产程序必须 escalate，禁止 stop
    steps:
      # L1 exec 步骤（确定性，0 token）
      - id: <step_id>    # snake_case，字母开头
        label: <中文标签>
        run: <来自 program-authoring/rules/constraints.md 可靠命令库的命令>
        verify:
          exit_code: 0
          stdout_match: '^[0-9]'   # 有数字输出必须写
        capture_stdout: true
        on_error_hint: <给 Guardian 的中文修复提示>

      # L2 skill 步骤（AI 约束执行，按需加）
      - id: <step_id>
        type: skill
        label: <中文标签>
        skill: <skill-id>     # 必须是 data/skills/ 下已有的 Skill
        goal: <一句话描述 AI 要完成什么>
        when:                  # 强烈建议加 when，避免无谓 token 消耗
          step: <前置步骤 id>
          stdout_match: <匹配异常的正则>

      # 最后加 render step，手动触发时展示结果
      - id: render_result
        type: render
        format: keyvalue
        title: <标题>
        level: info
        items_from_steps:
          - key: <标签>
            value_from: <step_id>
            suffix: "%"

# L3 monitors（独立健康检查，按需加）
monitors:
  - id: <snake_case_id>
    check: <shell 命令>
    expect: { exit_code: 0 }   # 或 stdout_contains / stdout_match
    interval: "*/5 * * * *"
    action: <action_name>

guardian:
  skills: []           # 填 Rescue Skill id，无则留空
  max_actions_per_hour: 10

# ui（多 action 程序必须加，单 action 可选）
ui:
  instance_actions:
    - id: <snake_case>
      label: <按钮文本>
      action: <action_name>       # 指向 actions{} 里的 action
      style: primary              # primary | success | danger | default
    - id: <snake_case>
      label: <按钮文本>
      action: <另一个 action>
      style: danger
      confirm: <确认提示>         # 破坏性操作必须加
```

## 第四步：告知成功 + 保持对话

```
render_result format=message level=success
Program「<name>」创建成功
路径：data/programs/<id>/program.yaml
启用：程序页 → 实例 Tab → 点「启用」→ 点「触发」手动测试
```

然后 `ask_user type=input`，title: "还要调整什么？"

## 第四点五步：用户追加需求 → 修改已有文件，不是新建任务

**当用户在 Program 创建成功后继续发言时**，必须判断意图：

- 用户说「还要加 xxx」/ 「没有做 xxx」/ 「漏了 xxx」→ **修改刚才写的 program.yaml**，用 `write_local_file` 覆盖原文件
- 绝对禁止：重新走 classify 决策树，把补充需求当成新任务，另建 Playbook/Skill
- 修改完成后用 `render_result` 告知已更新哪些 step，再继续 `ask_user`

## 第五步：判断是否推荐配套 Rescue Skill

如果 `on_fail: escalate` 且 `guardian.skills` 为空，主动询问是否创建配套 Rescue Skill。
用户选"创建" → 切到 `workflows/generate-rescue-skill.md`。

## 常见错误（写完自检）

- [ ] ❌ action 没有 render step 结尾（**必须有**，结果导向）
- [ ] ❌ `on_fail: stop` 用于生产监控（必须 `escalate`）
- [ ] ❌ 用了 `top`、`vmstat`、`netstat`（用 `/proc/stat`、`/proc/meminfo`、`ss`）
- [ ] ❌ 写了 `guardian.enabled` 字段（引擎不读）
- [ ] ❌ `enabled: true`（默认 false）
- [ ] ❌ verify 只写 `exit_code: 0` 没有 `stdout_match`
- [ ] ❌ step id 含连字符或从数字开头
- [ ] ❌ `type: skill` 步骤没有 `goal` 字段
- [ ] ❌ `type: skill` 步骤没有 `when` 条件（浪费 token）
- [ ] ❌ `type: skill` 引用了不存在的 Skill ID
- [ ] ❌ monitor 的 `action` 引用了不存在的 action 名
- [ ] ❌ 多 action 程序没有 `ui.instance_actions`（用户只能看到默认"触发"按钮）
- [ ] ❌ 破坏性按钮没有 `style: danger` 或缺少 `confirm` 确认提示