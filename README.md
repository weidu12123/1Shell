<p align="center">
  <h1 align="center">1Shell</h1>
  <p align="center"><strong>One Shell to rule them all.</strong></p>
  <p align="center">零侵入式多机管理中枢 + AI 云端总司令</p>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.0-blue" alt="version">
  <img src="https://img.shields.io/badge/node-%3E%3D18-green" alt="node">
  <img src="https://img.shields.io/badge/license-MIT-yellow" alt="license">
  <img src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey" alt="platform">
</p>

---

## 什么是 1Shell

1Shell 不是"又一个 Web SSH 面板"。

它是一个**零侵入式的多机管理中枢与 AI 自动化运维总台**：

- **一端登录**，集中接管多台 VPS
- **一条 SSH 链路**，复用终端、探针、文件浏览与 AI 协作
- **一个控制面**，统一承载站点入口、运维视角与智能运维
- **零侵入**，目标机器不安装任何 Agent，保持 100% 纯净

传统 Web SSH 解决的是"能连上"。1Shell 要解决的是"**连上之后，如何高效、持续、安全地管理整个节点群**"。

## 功能一览

| 功能 | 描述 |
|------|------|
| **多机 SSH 终端** | 本地 Shell + 远端 SSH 会话，支持跳板机级联，多标签页切换 |
| **Agentless Probe** | 零侵入探针，通过 SSH 采集 CPU / 内存 / 磁盘 / 负载 / 网络，自适应超时 |
| **文件浏览** | 本地 + 远程 SFTP 文件浏览，目录导航，文件预览，隐藏文件过滤 |
| **AI Chat** | 集成 OpenAI 兼容 API，流式对话，终端上下文感知 |
| **Ghost Text** | 终端输入时 AI 实时内联补全，Tab 采纳，低打扰 |
| **AI 命令建议** | 自然语言描述需求，AI 生成可执行命令 |
| **自选范围纠错** | 选定指定范围代码让ai辅助分析纠错 |
| **MCP Server** | 标准 MCP 协议，让 claude-code 等 AI CLI 工具直接操控远端主机 |
| **Bridge API** | HTTP API 桥接 SSH 执行，适配任意 CLI 工具 |
| **网站任意门** | 每台主机关联多个业务入口，统一管理 |
| **审计日志** | 所有操作记录到 SQLite，可追溯 |
| **登录保护** | 口令认证 + 暴力破解锁定 + 时序攻击防护 |

## 快速开始

### 方式一：直接运行

```bash
# 1. 克隆项目
git clone https://github.com/YOUR_USERNAME/1shell.git
cd 1shell

# 2. 安装依赖
npm install

# 3. 配置环境变量
cp .env.example .env
# 编辑 .env，至少设置 APP_SECRET 和 OPENAI_API_KEY

# 4. 启动
npm start

# 5. 访问
# http://localhost:3301
```

### 方式二：Docker

```bash
# 1. 配置环境变量
cp .env.example .env
# 编辑 .env

# 2. 启动
docker compose up -d

# 3. 访问
# http://localhost:3301
```

### 环境变量说明

```env
# === 必填 ===
APP_SECRET=your-random-secret-key-here    # 凭据加密密钥，必须设置
OPENAI_API_KEY=sk-your-api-key            # AI 功能所需
OPENAI_API_BASE=https://api.openai.com/v1 # OpenAI 兼容 API 地址
OPENAI_MODEL=gpt-4o                       # 使用的模型

# === 可选 ===
APP_LOGIN_PASSWORD=your-password           # 登录口令，留空关闭认证
PORT=3301                                  # 服务端口
BRIDGE_TOKEN=your-bridge-token             # MCP/Bridge API 鉴权 token
LOG_LEVEL=info                             # 日志级别：debug/info/warn/error
```

## 架构概览

```
浏览器（xterm.js + Vanilla JS）
    ↕ HTTP + WebSocket (Socket.IO)
1Shell Server（Node.js + Express）
    ├── Session Service ── node-pty (本地) / ssh2 (远程)
    ├── Probe Service ──── SSH exec 采集指标
    ├── File Service ───── fs (本地) / SFTP (远程)
    ├── AI Service ─────── OpenAI 兼容 API
    ├── Bridge Service ─── SSH exec 命令桥接
    ├── MCP Service ────── MCP SSE 协议 (JSON-RPC 2.0)
    ├── Audit Service ──── SQLite / 文件降级
    └── Auth Service ───── Cookie Session + 暴力破解防护
```

**核心原则**：目标 VPS 零侵入，凭据 AES-256-GCM 加密存储，不离开主控端。

## 技术栈

| 层 | 技术 |
|---|---|
| 运行时 | Node.js >= 18 |
| Web 框架 | Express |
| 实时通信 | Socket.IO |
| SSH | ssh2 + node-pty |
| 终端 | xterm.js |
| 数据库 | better-sqlite3（自动降级为文件存储） |
| AI | OpenAI 兼容 API（支持任意兼容服务） |
| 容器化 | Docker + docker-compose |
| CI | GitHub Actions |

## MCP 接入（claude-code）

1Shell 内置 MCP Server，让 claude-code 等 AI CLI 工具直接操控你的远端主机：

```json
// .claude/mcp_settings.json
{
  "mcpServers": {
    "1shell": {
      "url": "http://localhost:3301/mcp/sse",
      "headers": {
        "X-Bridge-Token": "your-bridge-token"
      }
    }
  }
}
```

注册的 MCP 工具：
- `execute_ssh_command` — 在指定主机执行命令
- `list_hosts` — 列出所有已配置主机

## 项目结构

```
1shell/
├── server.js              # 入口：服务装配与启动
├── src/
│   ├── services/          # 业务逻辑层
│   │   ├── session.service.js    # SSH/PTY 会话管理
│   │   ├── host.service.js       # 主机管理与 SSH 连接
│   │   ├── probe.service.js      # Agentless 探针
│   │   ├── file.service.js       # 文件浏览（本地 + SFTP）
│   │   ├── ai.service.js         # AI 补全与聊天
│   │   ├── bridge.service.js     # SSH exec 桥接
│   │   ├── auth.service.js       # 认证与会话
│   │   └── audit.service.js      # 审计日志
│   ├── routes/            # HTTP 路由
│   ├── sockets/           # WebSocket 事件处理
│   ├── mcp/               # MCP 协议实现
│   ├── middleware/         # 中间件（错误处理、限流）
│   └── database/          # SQLite 管理
├── public/                # 前端静态文件
│   ├── index.html         # 主页面
│   ├── app.js             # 模块装配入口
│   ├── session-terminal.js # 终端会话管理
│   ├── terminal-ai.js     # Ghost Text 内联补全
│   ├── file-browser.js    # 文件浏览器
│   └── ...                # 其他模块
├── lib/                   # 工具库（加密、日志、token）
├── test/                  # 测试（36 用例）
├── Dockerfile             # 容器构建
├── docker-compose.yml     # 容器编排
└── .github/workflows/     # CI 流水线
```

## 适用场景

- 自建多台 VPS，需要统一接入与巡检
- 机器数量不算夸张，但已不想手工记 IP、站点和口令
- 希望把 SSH、可视化状态和 AI 协作统一到一个面板
- 明确拒绝在目标节点部署额外 Agent
- 需要让 AI CLI 工具（claude-code 等）安全操控远端主机

## 安全设计

- **凭据加密**：AES-256-GCM + scrypt 密钥派生，凭据不离开主控端
- **认证保护**：HttpOnly Cookie + SameSite + 暴力破解锁定
- **密码安全**：`crypto.timingSafeEqual` 防时序攻击
- **API 限流**：AI 接口滑动窗口限流，防滥用
- **Bridge 鉴权**：独立 Token 鉴权，与 Web Session 隔离

## 开发

```bash
# 开发模式（自动重启）
npm run dev

# 运行测试
npm test
```

## Roadmap

- [ ] 前端 Vite 构建工具链
- [ ] TypeScript 迁移
- [ ] 文件上传/下载
- [ ] 主机组批量操作
- [ ] HTTPS / TLS 证书管理
- [ ] 国际化（i18n）

## License

MIT
