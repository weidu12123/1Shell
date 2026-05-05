<div align="center">

# 1Shell

**One Shell to rule them all.**

基于 Web 的零侵入多服务器管理平台，内置三层渐进式 AI 运维引擎

[![version](https://img.shields.io/badge/version-3.3.0-4f8cff?style=flat-square)](https://github.com/weidu12123/1Shell/releases)
[![node](https://img.shields.io/badge/node-%3E%3D18-43a047?style=flat-square&logo=node.js)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-f9a825?style=flat-square)](LICENSE)
[![docker](https://img.shields.io/badge/docker-ready-2496ed?style=flat-square&logo=docker)](https://hub.docker.com)

</div>

---

## 什么是 1Shell？

1Shell 是一个**多服务器集中管理平台**，用户通过浏览器就能同时管理多台云服务器，并借助 AI 实现自动巡检、故障发现和自主修复。

它**不是**"又一个 Web SSH 面板"。传统面板解决的是"能连上"，1Shell 要解决的是**连上之后如何高效、持续、安全地管理整个服务器集群**。

**三个核心特点：**

- **零侵入** — 目标服务器不安装任何 Agent 或客户端，一条 SSH 链路复用终端、探针、文件浏览与 AI 协作
- **AI 自动化** — 内置三层渐进式 AI 引擎，从检测到诊断到修复全程自动化，无需人工值守
- **开放协作** — 自身通过 MCP 协议标准化输出，可与 Claude Code、Cursor 等外部 AI 工具双向协作

---

## 功能总览

### 基础管理

| 功能 | 描述 |
|------|------|
| **多机 SSH 终端** | 本地 Shell + 远端 SSH，支持跳板机级联，多标签页切换 |
| **SFTP 文件浏览** | 本地 + 远程双模式，目录导航、文件预览、上传下载、在线编辑 |
| **Agentless 探针** | SSH 采集 CPU / 内存 / 磁盘 / 负载 / 网络，定时轮询，主机离线实时告警 |
| **网站任意门** | 每台主机关联多个业务入口，一键直达 |
| **审计日志** | 所有操作记录到 SQLite，分页查询，完整追溯 |
| **轻量化** | 面板内存占用不到 80MB，单文件部署 |

### AI 能力

| 功能 | 描述 |
|------|------|
| **1Shell AI（全局 AI 助手）** | 常驻右下角，在任何页面展开对话；拥有对所有服务器的执行权限、对所有产物的读写权限，相当于一个 7×24 小时的 AI 运维工程师 |
| **AI 运维程序** | 用自然语言描述需求，AI 自动生成声明式 YAML 运维程序，定时在所有服务器上执行 |
| **三层 AI 引擎** | L1 确定性执行 → L2 AI 约束修复 → L3 AI 全权介入，渐进式升级介入程度（详见下方） |
| **创作工作台** | 可视化创建 Program（长驻程序）、Skill（AI 能力包）、Playbook（一次性脚本） |
| **AI Chat** | OpenAI 兼容 API 接入，流式对话，终端上下文感知 |
| **Ghost Text** | 终端输入时 AI 实时内联补全，Tab 采纳 |
| **AI 命令建议** | 自然语言描述需求，AI 生成可执行命令，一键注入终端 |
| **AI 选区分析** | 框选终端输出，AI 自动解读错误并给出修复命令 |

### 开放能力

| 功能 | 描述 |
|------|------|
| **MCP Server** | 1Shell 自身暴露为 MCP Server，外部 AI 工具可直接调用多服务器管理能力 |
| **MCP 工具扩展** | 支持接入外部 MCP 工具（天气、数据库、通知等），AI 运维过程中可调用 |
| **Bridge API** | HTTP API 桥接 SSH 执行，适配任意 CLI 工具 |
| **AI Agent 面板** | 侧边栏运行 Claude Code / OpenCode / Codex |

---

## 核心创新：三层渐进式 AI 运维引擎

这是 1Shell 最重要的架构设计——**不是所有问题都需要 AI，但 AI 在需要时必须能介入。**

```
正常运行                    异常发生
   │                          │
   ▼                          ▼
┌──────────────┐    ┌──────────────────────┐
│   L1 · 确定性执行  │───▶│ 执行预设命令 + verify │
│   零 AI 消耗      │    │ 通过 → 继续          │
└──────────────┘    │ 失败 ↓                   │
                    └──────────────────────┘
                              │
                    ┌──────────────────────┐
                    │   L2 · AI 约束执行     │
                    │ 调用 Skill，限定范围修复 │
                    │ 修好 → 继续             │
                    │ 失败 ↓                  │
                    └──────────────────────┘
                              │
                    ┌──────────────────────┐
                    │   L3 · Guardian 全权介入│
                    │ AI 获得完整诊断权限     │
                    │ 自主分析 + 执行修复     │
                    │ 频率限制防止失控循环     │
                    └──────────────────────┘
```

| 层级 | 名称 | 做什么 | AI 消耗 | 约束机制 |
|------|------|--------|---------|---------|
| **L1** | 确定性执行 | 运行预设检查命令，用 verify 规则自动判定 | 零 | 明确的退出码 + 正则匹配 |
| **L2** | AI 约束执行 | 当 L1 发现异常，调用 Skill 在限定范围内修复 | 少量 | when 条件触发，Skill 规则约束 |
| **L3** | Guardian AI | L2 也解决不了时，AI 全权诊断修复 | 按需 | max_actions_per_hour 滑动窗口，危险命令强制人工确认 |

**设计理念：** 能用简单规则解决的不动用 AI，需要判断力的才让 AI 介入。既省成本，又保安全。

---

## 安全体系

在赋予 AI 强大权限的同时，1Shell 设计了多层安全防护：

| 安全机制 | 说明 |
|---------|------|
| **安全模式** | 开启后 AI 的每一步写操作都弹出审批框，用户逐条确认后才执行 |
| **登录认证** | 用户名密码 + Session 管理，支持运行时修改凭据并即时生效 |
| **凭据加密** | AES-256-GCM + scrypt 随机盐，SSH 密码和私钥加密存储 |
| **CSRF 防护** | HttpOnly Session Cookie + JS 可读 CSRF Cookie 双 Token 机制 |
| **暴力破解防护** | 同一 IP 连续失败 5 次自动锁定 60 秒 |
| **时序安全** | 密码比对使用 `crypto.timingSafeEqual`，防时序攻击 |
| **反向代理感知** | 可配置受信任代理 IP 白名单，防止 IP 伪造绕过锁定 |
| **AI 频率限制** | Guardian 设有 `max_actions_per_hour` 滑动窗口，防 AI 失控循环 |
| **安全红线** | AI 硬编码禁止 `rm -rf /`、`shutdown`、修改 SSH 配置等破坏性操作 |
| **IP 访问控制** | 白名单 / 黑名单，CIDR 支持 |
| **API 安全** | Helmet 安全头、CSP、AI 接口滑动窗口限流 |
| **Bridge 鉴权** | 独立 Token，与 Web Session 完全隔离 |

---

## 快速开始

### 方式一：Docker（推荐）

```bash
# 1. 克隆
git clone https://github.com/weidu12123/1Shell.git
cd 1Shell

# 2. 配置
cp .env.example .env
# 编辑 .env，设置登录密码和密钥

# 3. 启动
docker compose up -d

# 4. 访问
# http://localhost:3301  →  默认账号 admin / admin（请立即修改）
```

### 方式二：直接运行（Node.js ≥ 18）

```bash
git clone https://github.com/weidu12123/1Shell.git
cd 1Shell
npm install
cp .env.example .env
# 编辑 .env
npm start
```

### 方式三：开发模式

```bash
npm run dev   # nodemon 自动重启
npm test      # 运行单元 / 集成测试
```

---

## 环境变量

复制 `.env.example` 后按需修改：

```env
# ── 登录认证 ──────────────────────────────────
APP_LOGIN_USERNAME=admin
APP_LOGIN_PASSWORD=your-strong-password   # 必改

# ── 会话加密（必填，用于 SSH 凭据加密存储）────
APP_SECRET=your-random-secret-64chars     # 必填

# ── AI API（Web UI 内也可配置）────────────────
OPENAI_API_BASE=https://api.openai.com/v1
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o

# ── MCP / Bridge API 鉴权 ─────────────────────
BRIDGE_TOKEN=your-random-bridge-token     # 启用 MCP 时必填

# ── 服务端口 ──────────────────────────────────
PORT=3301

# ── 反向代理受信任 IP（Nginx 等场景）─────────
# TRUSTED_PROXY_IPS=127.0.0.1
```

> **安全提示**：生产环境请务必修改 `APP_LOGIN_PASSWORD` 和 `APP_SECRET`，并通过 HTTPS 访问。

---

## AI CLI 接入（MCP）

1Shell 内置 MCP Server，让 **Claude Code** 等工具直接操控你的远端主机：

**方式 A：Agent 面板一键接入**

登录后点击顶栏 **AI Agent** → **⚡ 一键接入**，自动完成配置。

**方式 B：手动配置**

```json
// ~/.claude/mcp_settings.json
{
  "mcpServers": {
    "1shell": {
      "url": "http://your-server:3301/mcp/sse",
      "headers": { "X-Bridge-Token": "your-bridge-token" }
    }
  }
}
```

可用 MCP 工具：

| 工具 | 说明 |
|------|------|
| `execute_ssh_command` | 在指定主机执行命令，返回 stdout / stderr / exitCode |
| `list_hosts` | 列出所有已配置主机 |
| `list_mcp_tools` | 列出 1Shell 已接入的所有 MCP 工具 |
| `call_mcp_tool` | 调用 1Shell 已接入的 MCP 工具 |

---

## 架构概览

```
浏览器（xterm.js + Vanilla JS）
    ↕  HTTP + WebSocket（Socket.IO）
1Shell Server（Node.js + Express）
    ├── Auth Service        Cookie Session + CSRF + 暴力破解防护
    ├── Session Service     node-pty（本地）/ ssh2（远端）
    ├── Probe Service       SSH exec 零侵入采集
    ├── File Service        fs（本地）/ SFTP（远端）
    ├── AI Service          OpenAI 兼容流式 API
    ├── IDE Service         1Shell AI 引擎（全局 AI 助手）
    ├── Program Engine      三层 AI 运维引擎（L1/L2/L3）
    ├── Skill Runner        Skill 能力包执行器
    ├── Bridge Service      SSH exec 命令桥接
    ├── MCP Service         MCP SSE + JSON-RPC 2.0（双向）
    ├── Agent Service       PTY 启动 AI CLI 工具
    ├── Audit Service       SQLite 审计日志
    └── IP Filter           白名单 / 黑名单
```

---

## 技术栈

| 层 | 技术 |
|---|---|
| 运行时 | Node.js ≥ 18 |
| Web 框架 | Express + Helmet |
| 实时通信 | Socket.IO |
| SSH | ssh2 + node-pty |
| 终端渲染 | xterm.js 5 |
| 数据库 | better-sqlite3 |
| AI | OpenAI 兼容 API（任意兼容服务商） |
| 协议 | MCP（Model Context Protocol） |
| 容器化 | Docker + docker-compose |

---

## 项目结构

```
1Shell/
├── server.js                   # 入口：服务装配与启动
├── src/
│   ├── services/               # 业务逻辑层
│   │   ├── auth.service.js     # 认证与会话
│   │   ├── session.service.js  # SSH / PTY 会话
│   │   ├── host.service.js     # 主机管理与连接
│   │   ├── probe.service.js    # Agentless 探针
│   │   ├── file.service.js     # 文件浏览
│   │   ├── ai.service.js       # AI 补全与对话
│   │   ├── bridge.service.js   # SSH exec 桥接
│   │   └── audit.service.js    # 审计日志
│   ├── ide/                    # 1Shell AI 引擎
│   │   ├── ide.service.js      # AI 会话管理与系统提示
│   │   └── ide.tools.js        # 23 个内置 AI 工具
│   ├── programs/               # 运维程序引擎
│   │   ├── engine.js           # 三层执行架构
│   │   ├── program-schema.js   # YAML schema 校验
│   │   └── state.service.js    # 实例状态管理
│   ├── skills/                 # Skill 系统
│   │   ├── runner.js           # Skill 执行器
│   │   └── playbook-schema.js  # Playbook schema
│   ├── agents/                 # AI CLI PTY 服务
│   ├── mcp/                    # MCP 协议实现
│   ├── routes/                 # HTTP 路由
│   ├── sockets/                # Socket.IO 事件
│   ├── middleware/             # 限流、错误处理
│   ├── repositories/           # 数据访问层
│   └── database/               # SQLite 管理
├── data/
│   └── skills/                 # Skill 能力包
│       ├── skill-authoring/    # 创作台元 Skill
│       ├── program-authoring/  # 程序创作规范
│       └── guardian-protocol/  # Guardian 协议
├── public/                     # 前端（Vanilla JS）
├── lib/                        # 工具库（加密、日志）
├── test/                       # 测试用例
├── Dockerfile
├── docker-compose.yml
└── .github/workflows/ci.yml    # CI 流水线
```

---

## 适用场景

- 个人开发者或小团队拥有 3~10 台 VPS，需要统一管理入口
- 不想在目标机器安装任何额外 Agent 或修改配置
- 希望 AI 自动巡检服务器健康状态，异常时自动修复而非凌晨被告警叫醒
- 需要让 Claude Code 等 AI 工具安全、可控地操控远端主机

---

## 与同类项目的区别

| | 传统面板（宝塔/1Panel） | Ansible/Terraform | 1Shell |
|---|---|---|---|
| AI 能力 | 无 | 无 | 三层渐进式 AI，检测→诊断→修复全自动 |
| 多机管理 | 需每台安装客户端 | Agentless 但无 Web UI | Agentless + Web 终端 + 实时监控 |
| 自动化 | 预设脚本 | 声明式编排 | AI 根据实际情况动态决策 |
| 扩展性 | 固定功能 | 模块化 | MCP 协议 + Skill 系统，能力可扩展 |
| 实时交互 | 有 | 无 | SSH 终端 + AI 对话 + 文件浏览一体化 |

---

## License

[MIT](LICENSE) © 2025 weidu12123

