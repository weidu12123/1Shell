# Program 生成 Workflow

## 前置：必须先读 rules/constraints.md

所有命令从 `rules/constraints.md` 的可靠命令库中选取。**禁止使用 `top`、`vmstat`、`netstat` 等不可靠命令。**

---

## Step 1：理解需求

读用户描述，提取：
- **监控/采集目标**：CPU / 内存 / Docker / Nginx / 自定义服务…
- **触发方式**：cron 间隔（每分钟 / 每 5 分钟 / …）+ 是否需要手动触发
- **目标主机**：指定 hostId 列表，还是 `all`
- **告警阈值**（如有）：超过多少算异常
- **操作种类**：只需一个默认"触发"按钮，还是需要多种操作入口（如检查 + 重启 + 清理）→ 决定是否加 `ui.instance_actions`

如信息不足，用 `ask_user type=input` 询问，不要假设。

---

## Step 2：规划并展示方案

用 `render_result format=keyvalue level=info` 列出：

```
Program ID: <kebab-case>
触发: cron <schedule>（+ manual）
目标主机: <host list 或 all>
Steps: N 个（列出 step id）
on_fail: escalate（Guardian 兜底）
Guardian Skills: <列表或"通用运维知识">
```

---

## Step 3：生成 program.yaml

### 关键结构

```yaml
name: <中文名>
description: |
  <一句话描述，说明监控什么、多久一次、失败时怎么处理>

enabled: false          # 保持 false，用户在 UI 启用

hosts:
  - <hostId>            # 从用户上下文取，不要编造

triggers:
  - id: <snake_case>
    type: cron
    schedule: "<cron expression>"
    action: <action_name>
  - id: manual_run      # 几乎总是要加，方便用户手动触发
    type: manual
    action: <action_name>

actions:
  <action_name>:
    on_fail: escalate   # ← 永远是 escalate，不是 stop
    steps:
      - id: <snake_case>
        label: <中文描述>
        run: <从 rules/constraints.md 可靠命令库选取>
        verify:
          exit_code: 0
          stdout_match: '<正则>'  # 有数字输出必须写
        capture_stdout: true      # 值要用于 render 时加
        on_error_hint: <失败时的诊断提示，Guardian 会读>

      # render step 放最后（手动触发时展示结果）
      - id: render_result
        type: render
        format: keyvalue
        title: <标题>
        level: info
        items_from_steps:
          - key: <标签>
            value_from: <step_id>
            suffix: "%"           # 可选

guardian:
  skills: []            # 填写 Rescue Skill ID，无则留空
  max_actions_per_hour: 10

# ui：自定义实例按钮（程序有多个 action 时必须加）
# 不加 ui 则前端显示默认"触发"按钮（仅触发第一个 manual trigger 的 action）
ui:
  instance_actions:
    - id: <snake_case>
      label: <按钮文本>
      action: <action_name>       # 必须指向 actions{} 里的 action
      style: primary              # primary | success | danger | default
    - id: <snake_case>
      label: <按钮文本>
      action: <另一个 action>
      style: danger
      confirm: <确认提示文本>     # 破坏性操作必须加
```

### 自检清单（写完后逐项检查）

- [ ] 所有 step run 命令来自 rules/constraints.md 可靠命令库
- [ ] `on_fail: escalate`（不是 stop）
- [ ] 没有写 `guardian.enabled` 字段
- [ ] 每个有数字输出的 step 有 `stdout_match: '^[0-9]'`
- [ ] `enabled: false`
- [ ] 有 manual trigger
- [ ] step id 全部 snake_case（无连字符，无数字开头）
- [ ] 有 `on_error_hint`（至少关键步骤）
- [ ] 多 action 程序有 `ui.instance_actions`（否则用户只能看到默认"触发"按钮）
- [ ] `ui.instance_actions` 中破坏性操作有 `style: danger` + `confirm`

---

## Step 4：写入文件

用 `write_local_file`：
- 路径：`data/programs/<program-id>/program.yaml`

---

## Step 5：成功反馈

```
render_result format=message level=success

Program「<name>」创建成功

路径：data/programs/<id>/program.yaml
启用方式：在程序管理页找到该 Program → 选择主机实例 → 点击「启用」
Guardian：<配置说明>
```

---

## Step 6：保持对话

用 `ask_user type=input`：
- title: "还要调整什么？"
- placeholder: "例如：把间隔改成 5 分钟 / 增加一个 Nginx 状态检查 step…"