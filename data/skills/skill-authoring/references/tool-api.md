# 1Shell Skill 工具 API 参考

Skill 运行时，AI 通过四个结构化工具与 1Shell 交互。
**AI 不能直接输出文字给用户** — 所有用户可见内容必须通过这四个工具产生。

---

## execute_command

在目标主机上执行 shell 命令。

```json
{
  "tool": "execute_command",
  "input": {
    "command": "docker ps -a --format '{{json .}}'",
    "timeout": 30000,
    "description": "列出所有容器"
  }
}
```

**参数：**

| 参数 | 类型 | 必须 | 说明 |
|------|------|------|------|
| `command` | string | 是 | 要执行的 shell 命令 |
| `timeout` | number | 否 | 超时毫秒数，默认 30000 |
| `description` | string | 否 | 描述这条命令做什么（界面上显示给用户） |

**返回值：**

```json
{
  "exitCode": 0,
  "stdout": "命令输出",
  "stderr": "错误输出（正常命令也可能有）",
  "durationMs": 1234
}
```

**使用原则：**
- `exitCode === 0` 表示成功，非 0 表示失败
- `stderr` 不一定是错误（nginx -v、git 等程序把版本信息写到 stderr）
- 破坏性操作（删除、覆盖）执行前必须先 `ask_user` 确认
- 单条命令超时设置参考：快速查询 5000，文件操作 15000，编译/安装 120000

---

## render_result

向用户展示结构化结果。这是用户唯一能看到的输出。

### format=table — 表格

```json
{
  "tool": "render_result",
  "input": {
    "format": "table",
    "title": "容器列表",
    "columns": ["名称", "镜像", "状态", "端口"],
    "rows": [
      ["nginx", "nginx:alpine", "Running", "80->80"],
      ["redis", "redis:7",     "Stopped", ""]
    ],
    "rowActions": [
      { "label": "启动", "value": "start", "style": "primary" },
      { "label": "停止", "value": "stop",  "style": "default" },
      { "label": "删除", "value": "delete","style": "danger" }
    ]
  }
}
```

`rowActions` 可选：每行末尾渲染操作按钮，用户点击后触发新一轮 Skill 调用，
传入 `{ action: value, target: 该行第一列的值 }`。

---

### format=keyvalue — 键值详情

```json
{
  "tool": "render_result",
  "input": {
    "format": "keyvalue",
    "title": "容器详情",
    "data": {
      "名称": "nginx",
      "镜像": "nginx:alpine",
      "状态": "running",
      "CPU": "0.5%",
      "内存": "24MB / 512MB"
    }
  }
}
```

适合展示单个对象的详细信息。

---

### format=message — 纯文字消息

```json
{
  "tool": "render_result",
  "input": {
    "format": "message",
    "level": "success",
    "title": "操作成功",
    "content": "容器 nginx 已重启，耗时 1.2s"
  }
}
```

**level 可选值：**

| level | 用途 | 颜色 |
|-------|------|------|
| `success` | 操作完成 | 绿色 |
| `error` | 操作失败，说明原因 | 红色 |
| `warn` | 警告，操作完成但有注意事项 | 黄色 |
| `info` | 中间步骤进度通知 | 蓝色 |

---

### format=code — 代码/配置文件展示

```json
{
  "tool": "render_result",
  "input": {
    "format": "code",
    "title": "生成的 Nginx 配置",
    "language": "nginx",
    "content": "server {\n    listen 80;\n    ...\n}"
  }
}
```

适合展示生成的配置文件、脚本内容、日志片段。

---

## ask_user

暂停执行，等待用户输入后继续。

### type=input — 文字输入

```json
{
  "tool": "ask_user",
  "input": {
    "type": "input",
    "title": "请输入容器名称",
    "description": "输入要操作的容器名称或 ID",
    "placeholder": "my-container",
    "required": true
  }
}
```

用户输入文字后，返回：`{ "value": "用户输入的内容" }`

---

### type=select — 单选

```json
{
  "tool": "ask_user",
  "input": {
    "type": "select",
    "title": "选择要操作的容器",
    "options": [
      { "value": "nginx",  "label": "nginx (Running)" },
      { "value": "redis",  "label": "redis (Stopped)" }
    ]
  }
}
```

用户选择后，返回：`{ "value": "nginx" }`

---

### type=confirm — 确认操作

```json
{
  "tool": "ask_user",
  "input": {
    "type": "confirm",
    "title": "确认删除容器？",
    "description": "即将删除 nginx，此操作不可撤销。",
    "confirmLabel": "确认删除",
    "cancelLabel": "取消",
    "danger": true
  }
}
```

`danger: true` 会把确认按钮渲染为红色。

用户确认后，返回：`{ "confirmed": true }`  
用户取消后，返回：`{ "confirmed": false }` — AI 应立即停止执行并用 `render_result level=warn` 告知已取消。

---

## 工具使用的黄金法则

1. **先查后写**：所有写/删操作前必须先 `execute_command` 确认对象存在
2. **危险必确认**：`danger: true` 操作必须 `ask_user type=confirm` 后才执行
3. **步骤可见**：每个关键步骤的结果用 `render_result level=info` 告知用户进展
4. **失败即停**：`exitCode !== 0` 时用 `render_result level=error` 报错，不要继续执行后续步骤
5. **不要猜测**：信息不足时用 `ask_user` 问，不要假设参数值

## render_result format 选择规范（必须遵守）

| 展示内容 | 必须使用的 format | 禁止用 |
|---------|-----------------|-------|
| 多行对象（容器列表、网站列表、进程列表…）| `table` + `columns` + `rows` | `message` |
| 单个对象的详细信息 | `keyvalue` + `items:[{key,value}]` 或 `data:{...}` | `message` |
| 配置文件 / 脚本 / 日志片段 | `code` + `language` + `content` | `message` |
| 操作成功 / 失败 / 警告通知 | `message` + 对应 `level` | — |

**典型错误**：用 `format=message` 把表格数据拼成一段文字输出 → 用户完全看不到结构化数据。

---

## write_local_file

将文本内容写入 **1Shell 宿主机（本机）** 的文件系统。
路径白名单（按产物类型）：
- `data/skills/<id>/...`    — Skill / Rescue Skill
- `data/playbooks/<id>/...` — Playbook
- `data/programs/<id>/...`  — Program
**创建或修改这三类产物的文件时必须用此工具**，不要用 `execute_command + node -e writeFileSync`。

```json
{
  "tool": "write_local_file",
  "input": {
    "path": "data/skills/my-skill/SKILL.md",
    "content": "---\nname: 我的 Skill\n...\n---\n",
    "mkdir": true
  }
}
```

**参数：**

| 参数 | 类型 | 必须 | 说明 |
|------|------|------|------|
| `path` | string | 是 | 相对于 1Shell 根目录的路径，如 `data/skills/my-skill/SKILL.md` |
| `content` | string | 是 | 文件的完整内容（UTF-8 字符串） |
| `mkdir` | boolean | 否 | 是否自动创建父目录，默认 `true` |

**返回值：**

- 成功：`OK — 文件已写入: data/skills/my-skill/SKILL.md (1234 bytes)`
- 失败：`[ERROR] 写入失败: ...原因...`

**关键原则：**
- 每次调用写入**完整文件内容**（覆盖写）
- 一次响应中可以并行调用多个 `write_local_file`（每个文件一条）
- 路径越界（写到 data/skills/ 外）会被拒绝并报错
- `execute_command` 在目标 VPS 上执行，`write_local_file` 在本机写文件 — **两者不冲突，可组合使用**