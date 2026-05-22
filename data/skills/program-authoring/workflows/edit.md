# Program 编辑 Workflow

> 用于修改**已存在**的 Program：`program.yaml` 以及 `ui/` artifact。
> 核心原则：**先判断能力变更还是 UI 体验变更；在对应边界内做最小必要修改。**

## 前置：必须先读

- `rules/constraints.md` — YAML 安全规则、命令白名单、UI artifact gate
- 当前 `program.yaml` 全文（已由 Studio 注入上下文）
- 当前 `ui/DESIGN.md`、`ui/manifest.json`、`ui/App.jsx`、`ui/style.css`（如果存在）

---

## Step 1：理解现有程序

从注入的 Program 文件中提取：
- `hosts`：当前绑定的主机列表
- `actions.<action>.inputs`：用户输入、secret、select/number 约束
- `actions.<action>.steps`：所有 step 的 id / run / verify / render
- `l2.skill`：Program 绑定的维护 Skill
- `l3.skills`：L3 危机升级协议 Skill
- `triggers`：触发周期
- `ui.instance_actions`：已有的 action 入口
- `ui/manifest.json`：runtime、entry、styles、permissions.actions
- `ui/App.jsx`：表单、bridge 调用、状态、结果/历史展示
- `ui/style.css`：布局和视觉状态
- `ui/DESIGN.md`：产品目标和安全约束

**必须完整读完再动手，不得跳过。**

---

## Step 2：解析修改意图

| 用户说 | 对应修改 |
|---|---|
| 加入 VPS2 / 增加主机 | 只改 `hosts` |
| 去掉某台主机 | 只改 `hosts` |
| 改成所有主机 | 只改 `hosts: all` |
| 增加监控项 / 新功能 | 改 `program.yaml` steps/action，必要时同步 UI 展示 |
| 修改某个 step 命令 | 只改该 step 的 `run` / `verify` / `on_error_hint` |
| 改触发频率 | 只改 `triggers[].schedule` |
| 更换 L2 维护 Skill | 只改 `l2.skill` |
| 加 L3 升级协议 Skill | `l3.skills` 追加 id |
| 修改阈值/参数 | 只改对应 input/default 或 step `run` 内参数值 |
| 加自定义按钮 / 操作入口 | 改 `actions` / `ui.instance_actions` / `manifest.permissions.actions` / `App.jsx` |
| 改按钮文本 / 样式 | 优先改 `App.jsx` / `style.css`，必要时同步 `ui.instance_actions[].label/style` |
| 加前端填写/选择/确认 | 改 `actions.<action>.inputs` + `App.jsx` 表单 + 必要 confirm |
| 改成功结果展示 | 改 render step 与 `App.jsx` 的结果展示 |
| 调整页面布局/视觉 | 只改 `ui/App.jsx`、`ui/style.css`、`ui/DESIGN.md`，不得无故改 Program 能力 |
| 修复 artifact runtime error / 白屏 | 改 `ui/`，并跑 sandbox preview gate |

如需探测新主机或新服务，用 `execute_command` 做 1-2 条只读探测。

---

## Step 3：决定改动边界

写入前必须明确：

- **能力变更**：改 `program.yaml`，并检查 UI 是否仍能调用新/旧 action、展示新结果。
- **UI 体验变更**：改 `ui/App.jsx`、`ui/style.css`、`ui/DESIGN.md`，不改 L1/L2/L3 能力。
- **权限变更**：任何新增/删除 action 调用都必须同步 `ui/manifest.json` 的 `permissions.actions`。
- **secret 变更**：secret 只能进入 action input；不得显示、记录或持久化。

用 `render_result format=keyvalue level=info` 列出将改什么、不改什么。

---

## Step 4：写入文件

根据 Step 3 只写必要文件：

- 能力变更：`data/programs/<programId>/program.yaml`
- UI 体验变更：`data/programs/<programId>/ui/App.jsx`、`style.css`、`DESIGN.md`
- bridge/action 权限变更：`data/programs/<programId>/ui/manifest.json`

> 写入约束见 `rules/constraints.md` §11（YAML 安全规则）与 §13（UI artifact 硬规则）。

---

## Step 5：Program artifact gate

写入后必须运行：

```bash
node data/claude-code-skills/program-authoring/source/scripts/validate-program.js data/programs/<programId>/program.yaml
```

只有脚本通过，才允许进入成功反馈。失败时回到 Step 3/4 修复；即使是小编辑，也不能留下 `frontend_contract_check`、`ui_artifact_check` 或 `sandbox_preview_check` 失败的 Program。

---

## Step 6：成功反馈 + 保持对话

```
render_result format=message level=success
已更新 <programId>：
  - <改了什么>
  - <改了哪些文件>
  - validation: program_schema_check / ui_artifact_check / sandbox_preview_check passed
  → 未改动：<列出未改动主要能力或 UI 区域>
```

然后 `ask_user type=input title="还要继续调整吗？"`

---

## 自检（写入前）

- [ ] 已判断能力变更 vs UI 体验变更
- [ ] 只改了用户描述的部分
- [ ] 未删除用户未提及的 step 或 UI 功能
- [ ] 未修改 `enabled` 字段（除非用户明确要求）
- [ ] run 字段无 heredoc、无多行 Python（见 rules/constraints.md §11）
- [ ] 新增/修改 `ui.instance_actions` 时，action 引用的 action 名在 `actions{}` 中存在
- [ ] 新增/修改 `App.jsx` 的 `runAction` 时，`manifest.permissions.actions` 已同步
- [ ] 新增/修改 inputs 时，字段类型可渲染；select 有 options；number 有 min/max；secret 不进入 render/DOM/console/localStorage/result
- [ ] 新增/修改 action 时，保留最终 render 结果
- [ ] 破坏性按钮有 `style: danger` + `confirm`
- [ ] `App.jsx` 未直接 fetch 私有 API、未访问父窗口 DOM、未使用 eval/new Function/localStorage
- [ ] `validate-program.js` 的 artifact gate 通过
