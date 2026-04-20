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

**命令选取**：只用 `program-authoring/rules/constraints.md` 里的可靠命令库（禁用 `top`、`vmstat`、`netstat`）。

探测：如需针对远端 VPS，可用 `execute_command` 带 `host_id` 做 2-3 条**只读**探测。

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
      - id: <step_id>    # snake_case，字母开头
        label: <中文标签>
        run: <来自 program-authoring/rules/constraints.md 可靠命令库的命令>
        verify:
          exit_code: 0
          stdout_match: '^[0-9]'   # 有数字输出必须写
        capture_stdout: true
        on_error_hint: <给 Guardian 的中文修复提示>

      # 最后加 render step，手动触发时展示结果
      - id: render_result
        type: render
        format: keyvalue   # 多行列表用 table，单对象详情用 keyvalue
        title: <标题>
        level: info
        items_from_steps:
          - key: <标签>
            value_from: <step_id>
            suffix: "%"

guardian:
  skills: []           # 填 Rescue Skill id，无则留空（禁止写 guardian.enabled 字段）
  max_actions_per_hour: 10
```

## 第四步：告知成功 + 保持对话

```
render_result format=message level=success
Program「<name>」创建成功
路径：data/programs/<id>/program.yaml
启用：程序页 → 实例 Tab → 点「启用」→ 点「触发」手动测试
```

然后 `ask_user type=input`，title: "还要调整什么？"

## 第五步：判断是否推荐配套 Rescue Skill

如果 `on_fail: escalate` 且 `guardian.skills` 为空，主动询问是否创建配套 Rescue Skill。
用户选"创建" → 切到 `workflows/generate-rescue-skill.md`。

## 常见错误（写完自检）

- [ ] ❌ `on_fail: stop` 用于生产监控（必须 `escalate`）
- [ ] ❌ 用了 `top`、`vmstat`、`netstat`（用 `/proc/stat`、`/proc/meminfo`、`ss`）
- [ ] ❌ 写了 `guardian.enabled` 字段（引擎不读）
- [ ] ❌ `enabled: true`（默认 false）
- [ ] ❌ verify 只写 `exit_code: 0` 没有 `stdout_match`
- [ ] ❌ step id 含连字符或从数字开头