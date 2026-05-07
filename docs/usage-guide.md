# 1Shell 使用指南

> 版本：v3.3.0 | 更新日期：2025-05

---

## 目录

1. [安装部署](#1-安装部署)
2. [首次登录与配置](#2-首次登录与配置)
3. [主机管理](#3-主机管理)
4. [SSH 终端](#4-ssh-终端)
5. [文件管理](#5-文件管理)
6. [AI 功能](#6-ai-功能)
7. [运维程序](#7-运维程序program)
8. [MCP 接入](#8-mcp-接入)
9. [安全设置](#9-安全设置)
10. [常见问题](#10-常见问题)

---

## 1. 安装部署

### 方式 A：Linux 一键安装（推荐）

```bash
curl -fsSL https://raw.githubusercontent.com/weidu12123/1Shell/main/install.sh | bash
```

支持选项：

```bash
bash install.sh --port 8080 --password MyPass123 --dir /opt/1shell
bash install.sh --docker   # 使用 Docker 部署
```

安装完成后会自动配置 systemd 服务，支持 `systemctl start/stop/restart 1shell`。

### 方式 B：Docker 部署

```bash
git clone https://github.com/weidu12123/1Shell.git
cd 1Shell
cp .env.example .env
# 编辑 .env 设置密码
docker compose up -d
```

### 方式 C：手动部署（Windows / Linux / macOS）

前置要求：Node.js 18+

```bash
git clone https://github.com/weidu12123/1Shell.git
cd 1Shell
npm install
cp .env.example .env
# 编辑 .env
node server.js
```

Windows 用户可直接双击 `start.bat`，Linux 用户可执行 `bash start.sh`。

### 方式 D：下载 Release 压缩包

从 [GitHub Releases](https://github.com/weidu12123/1Shell/releases) 下载对应平台的压缩包，解压后：

- **Windows**：双击 `start.bat`
- **Linux**：执行 `bash start.sh`

首次运行会自动安装依赖并创建配置文件。

---

## 2. 首次登录与配置

### 2.1 访问面板

启动后在浏览器打开：`http://服务器IP:3301`

默认账号密码：`admin` / `admin`

> **重要**：首次登录后请立即修改密码（设置 → 修改凭据）。

### 2.2 配置文件（.env）

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `APP_LOGIN_USERNAME` | 登录用户名 | admin |
| `APP_LOGIN_PASSWORD` | 登录密码 | admin |
| `APP_SECRET` | 会话加密密钥（必改） | - |
| `PORT` | 服务端口 | 3301 |
| `OPENAI_API_BASE` | AI API 地址 | https://api.openai.com/v1 |
| `OPENAI_API_KEY` | AI API Key | - |
| `OPENAI_MODEL` | AI 模型 | gpt-4o |
| `BRIDGE_TOKEN` | MCP/Bridge 鉴权 Token | - |

也可以在 Web UI 的「设置」页面直接修改，修改后立即生效。

---

## 3. 主机管理

### 3.1 添加主机

1. 点击左上角 **「+ 添加主机」**
2. 填写主机信息：
   - **名称**：自定义名称（如「生产服务器 1」）
   - **地址**：IP 或域名
   - **端口**：SSH 端口（默认 22）
   - **认证方式**：密码 或 私钥
3. 点击保存，主机卡片出现在主页

### 3.2 主机卡片

每台主机以卡片形式展示，包含：
- 在线状态（绿色/红色）
- CPU、内存、磁盘使用率（探针自动采集）
- 系统负载
- 快捷操作按钮

### 3.3 探针监控

1Shell 通过 SSH 定期采集主机指标，**无需在目标机器安装任何 Agent**。

采集指标：CPU 使用率、内存使用率、磁盘使用率、系统负载、网络流量。

主机离线时自动告警。

### 3.4 网站任意门

每台主机可关联多个业务网址（如管理后台、API 文档），在主机卡片上一键直达。

设置方式：主机详情 → 网站任意门 → 添加链接

---

## 4. SSH 终端

### 4.1 打开终端

- 点击主机卡片上的终端图标，或点击主机名称
- 支持本地终端（1Shell 所在机器）和远程 SSH 终端
- 多标签页，可同时操作多台主机

### 4.2 终端功能

- **跳板机级联**：通过跳板机连接内网机器
- **AI Ghost Text**：输入命令时 AI 实时内联补全，按 Tab 采纳
- **AI 命令建议**：按快捷键描述需求，AI 生成可执行命令
- **AI 选区分析**：框选终端输出，AI 自动解读错误并给出修复命令

---

## 5. 文件管理

### 5.1 打开文件管理器

主机卡片 → 文件图标，或终端页面顶部切换到文件标签。

### 5.2 支持的操作

- 目录导航与浏览
- 文件预览（文本、图片、代码高亮）
- 文件上传与下载
- 在线编辑文本文件
- 新建文件/文件夹
- 重命名、删除

支持本地文件系统和远程 SFTP 两种模式。

---

## 6. AI 功能

### 6.1 配置 AI

设置 → AI 配置，填写：

- **API 地址**：任何 OpenAI 兼容的 API 地址（如 OpenAI、DeepSeek、OpenRouter 等）
- **API Key**：对应服务商的密钥
- **模型**：推荐 gpt-4o、claude-sonnet-4-20250514、deepseek-chat 等

配置完成后所有 AI 功能自动生效。

### 6.2 1Shell AI（全局 AI 助手）

点击右下角的 AI 按钮展开对话面板，它是一个 7×24 小时的 AI 运维工程师：

- 在任何页面都可展开对话
- 可以在所有已托管主机上执行命令
- 可以读写所有文件
- 可以创建和管理运维程序
- 拥有 23 个内置工具（执行命令、文件读写、主机管理等）

**使用示例**：
- 「帮我检查所有服务器的磁盘使用情况」
- 「nginx 报 502 了，帮我排查一下」
- 「帮我写一个每小时检查 CPU 的监控程序」

### 6.3 AI Chat

终端页面的 AI 对话功能，支持：

- 流式输出
- 终端上下文感知（AI 能看到你当前终端的内容）
- 代码高亮

### 6.4 Ghost Text（终端 AI 补全）

在终端输入命令时，AI 会实时提供内联补全建议（灰色文字），按 **Tab** 采纳。

### 6.5 AI 命令建议

用自然语言描述你想做的事，AI 生成对应的 Shell 命令，点击即可注入终端执行。

### 6.6 AI 选区分析

在终端中框选一段输出（如错误日志），AI 自动分析内容并给出解读和修复建议。

---

## 7. 运维程序（Program）

### 7.1 什么是 Program

Program 是 1Shell 的核心能力——用声明式 YAML 定义一个长驻运维任务，按时间表自动在指定主机上执行，并配备三层 AI 引擎保障。

### 7.2 创建 Program

**方式 A：AI 创作（推荐）**

1. 进入「程序」页面 → 点击「创作工作台」
2. 选择「创作 Program」模式
3. 用自然语言描述需求，例如：「每 5 分钟检查所有服务器的 CPU、内存、磁盘，异常时自动修复」
4. AI 自动生成完整的 program.yaml

**方式 B：手动编写**

在 `data/programs/<program-id>/program.yaml` 下手动创建。

### 7.3 启用与触发

1. 程序页面 → 找到刚创建的程序
2. 点击「实例」Tab → 选择要运行的主机实例
3. 点击「启用」开启定时执行
4. 点击「触发」手动测试一次

### 7.4 查看结果

程序执行后，在「结果」Tab 查看实时输出数据（CPU、内存、磁盘等指标或操作日志）。

### 7.5 三层 AI 引擎

| 层级 | 何时介入 | 做什么 |
|------|---------|--------|
| **L1** | 每次执行 | 运行预设命令，用 verify 规则判断成功/失败 |
| **L2** | L1 发现异常时 | 调用 Skill（AI 能力包）在限定范围内修复 |
| **L3** | L2 也无法修复时 | Guardian AI 全权诊断，自主分析并执行修复 |

### 7.6 Skill（AI 能力包）

Skill 是 AI 的能力模块，可以被 Program 调用。例如：

- 「磁盘清理 Skill」— 当磁盘满时，AI 分析并清理不必要的文件
- 「服务重启 Skill」— 当服务异常时，AI 诊断原因并安全重启

在创作工作台中选择「创作 Skill」即可创建。

### 7.7 Playbook（一次性脚本）

Playbook 是一次性执行的 AI 脚本，适合临时操作（如批量部署、一次性清理）。

---

## 8. MCP 接入

### 8.1 什么是 MCP

MCP（Model Context Protocol）是一个标准化协议，让外部 AI 工具可以直接调用 1Shell 的多服务器管理能力。

### 8.2 配置 MCP

1. 在 `.env` 中设置 `BRIDGE_TOKEN`（必填）
2. 重启 1Shell

### 8.3 接入 Claude Code

**方式 A：一键接入**

登录后点击顶栏 **AI Agent** → **一键接入**，自动完成配置。

**方式 B：手动配置**

编辑 `~/.claude/mcp_settings.json`：

```json
{
  "mcpServers": {
    "1shell": {
      "url": "http://你的服务器IP:3301/mcp/sse",
      "headers": { "X-Bridge-Token": "你的BRIDGE_TOKEN" }
    }
  }
}
```

### 8.4 MCP 工具列表

| 工具 | 说明 |
|------|------|
| `execute_ssh_command` | 在指定主机执行命令 |
| `list_hosts` | 列出所有主机 |
| `list_mcp_tools` | 列出已接入的 MCP 工具 |
| `call_mcp_tool` | 调用已接入的 MCP 工具 |

### 8.5 AI Agent 面板

侧边栏可运行 Claude Code、OpenCode、Codex 等 AI CLI 工具，直接在 Web 界面中使用。

---

## 9. 安全设置

### 9.1 修改登录凭据

设置 → 修改用户名和密码，修改后立即生效（无需重启）。

### 9.2 安全模式

设置 → 开启「安全模式」后，AI 的每一步写操作（执行命令、修改文件）都会弹出审批框，用户逐条确认后才执行。

适用于生产环境或对 AI 操作不完全信任的场景。

### 9.3 IP 访问控制

设置 → IP 过滤，支持：

- **白名单模式**：仅允许指定 IP 访问
- **黑名单模式**：禁止指定 IP 访问
- 支持 CIDR 格式（如 `192.168.1.0/24`）

### 9.4 凭据加密

所有 SSH 密码和私钥使用 AES-256-GCM + scrypt 随机盐加密存储，即使数据库文件泄露也无法还原明文。

### 9.5 反向代理

如果通过 Nginx 等反向代理访问，在 `.env` 中配置：

```env
TRUSTED_PROXY_IPS=127.0.0.1
```

防止 IP 伪造绕过暴力破解防护。

### 9.6 AI 安全红线

AI 硬编码禁止以下操作：
- `rm -rf /`
- `shutdown` / `reboot`（需人工确认）
- 修改 SSH 配置
- 其他高危破坏性命令

Guardian AI 有 `max_actions_per_hour` 滑动窗口限制，防止 AI 失控循环。

---

## 10. 常见问题

### Q: npm install 失败，提示编译错误

A: 1Shell 使用了 `node-pty` 和 `better-sqlite3` 等原生模块，需要 C++ 编译环境：

- **Ubuntu/Debian**：`sudo apt install -y make g++ python3`
- **CentOS/RHEL**：`sudo yum install -y make gcc-c++ python3`
- **Windows**：安装 [windows-build-tools](https://github.com/nicedoc/windows-build-tools) 或 Visual Studio Build Tools

### Q: 连接 SSH 超时

A: 检查以下几点：
1. 目标主机 SSH 端口是否正确
2. 防火墙是否放行
3. 如果需要跳板机，请在主机配置中设置代理

### Q: AI 功能没有响应

A: 确认 AI 配置正确：
1. 设置 → AI 配置 → 检查 API 地址和 Key
2. API 地址不需要包含 `/chat/completions`，只需要到 `/v1`
3. 测试：在 AI Chat 中发送一条消息看是否有回复

### Q: Docker 部署后终端无法使用

A: Docker 容器内的终端是容器自身的 Shell，不是宿主机。要管理宿主机或远程服务器，请通过「添加主机」添加 SSH 连接。

### Q: 如何备份数据

A: 备份 `data/` 目录和 `.env` 文件即可。数据库、主机配置、程序定义都在 `data/` 下。

### Q: 忘记登录密码

A: 编辑 `.env` 文件，修改 `APP_LOGIN_PASSWORD` 的值，然后重启 1Shell。

---

## 附录：键盘快捷键

| 快捷键 | 功能 |
|--------|------|
| `Tab` | 采纳 AI Ghost Text 补全 |
| `Ctrl + Shift + I` | 打开/关闭 AI 命令建议 |

---

> 更多信息请访问 [GitHub 仓库](https://github.com/weidu12123/1Shell)
