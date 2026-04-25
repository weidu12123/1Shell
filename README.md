<div align="center">

# 1Shell

**One Shell to rule them all.**

零侵入式多机管理中枢 · AI 自动化运维总台

[![version](https://img.shields.io/badge/version-3.2.0-4f8cff?style=flat-square)](https://github.com/weidu12123/1shell/releases)
[![node](https://img.shields.io/badge/node-%3E%3D18-43a047?style=flat-square&logo=node.js)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-f9a825?style=flat-square)](LICENSE)
[![docker](https://img.shields.io/badge/docker-ready-2496ed?style=flat-square&logo=docker)](https://hub.docker.com)
[![CI](https://img.shields.io/github/actions/workflow/status/weidu12123/1shell/ci.yml?style=flat-square&label=CI)](https://github.com/weidu12123/1shell/actions)

</div>

---

>## 🤔 什么是 1Shell？

1Shell **不是**"又一个 Web SSH 面板"。
它是一个零侵入式的多机管理中枢与 AI 自动化运维总台：

- **一端御万机**，集中接管多台跨网机器
- **万机皆可连**，内置中继级联，无缝穿透并管理无公网 IP 的云电脑与 NAS
- **一条 SSH 链路**，复用终端、探针、文件浏览与 AI 协作
- **零侵入**，目标机器不安装任何 Agent，保持 100% 出厂纯净

传统 Web SSH 解决的是"能连上公网"。1Shell 要解决的是**"跨越内外网，连上之后如何高效、持续、安全地管理整个异构节点群"**。
---

## 功能亮点

| 功能 | 描述 |
|------|------|
| **多机 SSH 终端** | 本地 Shell + 远端 SSH，支持跳板机级联，多标签页切换 |
| **轻量化** | 面板本身的占用内存只有不到80MB |
| **Agentless 探针** | 零侵入，SSH 采集 CPU / 内存 / 磁盘 / 负载 / 网络，定时轮询 |
| **SFTP 文件浏览** | 本地 + 远程双模式，目录导航，文件预览 |
| **AI Chat** | OpenAI 兼容 API 接入，流式对话，终端上下文感知 |
| **Ghost Text** | 终端输入时 AI 实时内联补全，Tab 采纳，低打扰 |
| **AI 命令建议** | 自然语言描述需求，AI 生成可执行命令，一键注入终端 |
| **AI 选区分析** | 框选终端输出，AI 自动解读错误并给出修复命令 |
| **MCP Server** | 标准 MCP 协议，让 claude-code 等 AI CLI 直接操控远端主机 |
| **Bridge API** | HTTP API 桥接 SSH 执行，适配任意 CLI 工具 |
| **AI Agent 面板** | 侧边栏运行 claude-code / OpenCode / Codex |
| **网站任意门** | 每台主机关联多个业务入口，一键直达 |
| **审计日志** | 所有操作记录到 SQLite，可翻页查询，可追溯 |
| **IP 访问控制** | 白名单 / 黑名单，CIDR 支持 |
| **登录保护** | HttpOnly Cookie + 暴力破解锁定 + 时序攻击防护 |

---

## 快速开始

### 方式一：Docker（推荐）

```bash
# 1. 克隆
git clone https://github.com/weidu12123/1shell.git
cd 1shell

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
git clone https://github.com/weidu12123/1shell.git
cd 1shell
npm install
cp .env.example .env
# 编辑 .env
npm start
```

### 方式三：开发模式

```bash
npm run dev   # nodemon 自动重启
npm test      # 运行 46 个单元 / 集成测试
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

1Shell 内置 MCP Server，让 **claude-code** 等工具直接操控你的远端主机：

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

---

## 架构概览

```
浏览器（xterm.js + Vanilla JS）
    ↕  HTTP + WebSocket（Socket.IO）
1Shell Server（Node.js + Express）
    ├── Auth Service      Cookie Session + 暴力破解防护
    ├── Session Service   node-pty（本地）/ ssh2（远端）
    ├── Probe Service     SSH exec 零侵入采集
    ├── File Service      fs（本地）/ SFTP（远端）
    ├── AI Service        OpenAI 兼容流式 API
    ├── Bridge Service    SSH exec 命令桥接
    ├── MCP Service       MCP SSE + JSON-RPC 2.0
    ├── Agent Service     PTY 启动 AI CLI 工具
    ├── Audit Service     SQLite 审计日志
    └── IP Filter         白名单 / 黑名单
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
| 数据库 | better-sqlite3（自动降级文件存储） |
| AI | OpenAI 兼容 API（任意兼容服务商） |
| 容器化 | Docker + docker-compose |
| CI | GitHub Actions（Node 18 / 20 / 22）|

---

## 项目结构

```
1shell/
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
│   ├── agents/                 # AI CLI PTY 服务
│   ├── mcp/                    # MCP 协议实现
│   ├── routes/                 # HTTP 路由
│   ├── sockets/                # Socket.IO 事件
│   ├── middleware/             # 限流、错误处理
│   ├── repositories/           # 数据访问层
│   └── database/               # SQLite 管理
├── public/                     # 前端（Vanilla JS）
│   ├── index.html              # 主页面
│   ├── app.js                  # 模块装配
│   ├── session-terminal.js     # 终端会话
│   ├── terminal-ai.js          # Ghost Text
│   ├── ai-chat.js              # AI 对话
│   ├── agent-panel.js          # AI Agent 面板
│   ├── file-browser.js         # 文件浏览器
│   └── layout.js               # 布局与主题
├── lib/                        # 工具库（加密、日志）
├── test/                       # 46 个测试用例
├── Dockerfile
├── docker-compose.yml
└── .github/workflows/ci.yml    # CI 流水线
```

---

## 安全设计

- **凭据加密**：AES-256-GCM + scrypt（随机盐），SSH 密码和私钥加密存储，不离开主控端
- **会话安全**：HttpOnly Cookie + SameSite=Lax + CSRF 双 Token
- **防爆破**：IP 维度失败计数 + 60s 锁定 + `timingSafeEqual` 防时序攻击
- **API 安全**：Helmet 安全头、CSP、AI 接口滑动窗口限流
- **Bridge 鉴权**：独立 Token，与 Web Session 完全隔离，`timingSafeEqual` 对比
- **文件安全**：文件浏览 API 阻止访问应用自身敏感目录（`.env`、`data/`）
- **IP 控制**：可配置白名单 / 黑名单，CIDR 支持
- **代理感知**：`TRUSTED_PROXY_IPS` 控制 X-Forwarded-For 信任范围，防 IP 伪造

---

## 适用场景

- 自建多台 VPS，需要统一入口和巡检面板
- 不想在目标机器安装任何额外 Agent 或修改配置
- 希望把 SSH 终端、状态监控、文件管理和 AI 协作整合到一处
- 需要让 AI CLI 工具（claude-code 等）安全、可控地操控远端主机

---

## Roadmap

- [x] 3.0 Agent Skill：声明式自动化运维（一键建站、容器管理）
- [ ] 前端 Vite 构建工具链
- [ ] TypeScript 迁移
- [ ] 主机组批量操作
- [x] MCP 权限控制（限制 AI 只能操作指定主机）
- [x] HTTPS / TLS 证书自动管理（3.0 已通过 Skill 实现 Let’s Encrypt 自动申请/续期）
- [ ] 国际化（i18n）

---

## 更新日志

### 3.2.0 更新

#### 本地 MCP Server 原生集成

- 新增本地 MCP 进程管理服务（stdio JSON-RPC 客户端），支持 spawn / init / tools/list / tools/call 全链路
- 服务器启动时自动启动所有已注册的本地 MCP Server（异步非阻塞）
- MCP 工具直注入 Anthropic API tools 列表，AI 像使用内置工具一样调用 MCP 工具
- 工具名自动加 `mcp__<mcpId>__` 前缀并限制 ≤ 64 字符，兼容 Anthropic API 规范
- 支持一键从 GitHub 部署本地 MCP（git clone → npm install → 注册）

#### 仓库管理增强

- 新增本地 MCP 分类面板，与远程 MCP 分开展示
- 修复本地 MCP 删除按钮无响应的问题

#### 创作台体验优化

- 顶栏新增「新建对话」快捷按钮，无需打开历史抽屉即可创建新会话

#### 主控台精简

- 移除 1Shell AI 面板的工具选择条（MCP 工具已自动注入，无需手动选择）

### 3.1.0 更新

#### 1Shell 原生 AI 引擎

- 新增 1Shell AI 引擎，替代 Claude Code CLI 依赖，主控台 AI 不再需要外部 CLI 二进制
- 主控台 AI 面板从 PTY/xterm 终端嵌入改为原生聊天界面 + ide:* socket 协议
- AI 面板不再绑定单台主机，可通过 `list_hosts` 自由操控所有 VPS
- AI 配置页 1Shell AI 引擎卡片置顶，一处配置驱动全局

#### IDE 工作台完善

- `run_skill` 从空壳改为真正调用 Skill Runner（AI-Loop），同步返回完整执行结果
- 新增 `run_playbook` 工具，走 L1 确定性执行器 + L2 Rescuer 完整链路
- IDE 引擎 SSE 流式连接增加重试（Premature close / ECONNRESET 最多重试 2 次）

#### 仓库管理

- Skill 卡片新增删除按钮（系统 Skill 不可删）
- Playbook executor 补全 `last_line` 和 `line_count` transform

#### 本机命令执行修复

- Windows 本机执行从 wsl.exe 改为 cmd.exe 直接执行，修复无 WSL 环境的乱码
- 新增 GBK → UTF-8 Buffer 解码（iconv-lite），兜底 Windows 中文输出

### 3.0.0 更新

1Shell 3.0 从「多机运维平台」升级为「约束可控的自维护 AI 运维代理系统」。核心目标：让大模型代理在真实运维场景中既可控、又可持续学习。

#### 三层分级执行架构

- 新增 **L1 Playbook Executor**：声明式 YAML 定义步骤，按 verify 规则自动判定，零 token 消耗，毫秒级完成，全程可审计
- 新增 **L2 AI Rescuer**：L1 步骤失败时激活，硬性预算（3 条命令 / 8 轮对话 / 2048 tokens），输出 retry_ok / patch_plan / give_up 三选一
- 新增 **L3 Guardian**：长驻 Program 的守护者 AI，滑动窗口配额控制每小时介入次数，危险命令强制 ask_user

#### Skill 能力包系统

- rules/ 目录：人类写、AI 不可修改的硬约束（路径沙箱、命令红线、救援预算）
- workflows/ + references/ 目录：AI 可根据执行历史自我演进的软过程
- 新增 Skill 创作台：用户自然语言描述需求 → AI 生成完整 Playbook 目录 → 立即可运行
- 内置 skill-authoring / program-authoring 元 Skill，具备系统自扩展能力

#### 长驻 Program 与守护者

- 新增 Program 模块：cron 触发的持续运行任务
- on_fail=escalate 失败时自动唤醒 Guardian 自愈
- 危险命令模式拦截：rm -rf、dd if=、mkfs、shutdown、reboot 等强制人工确认

#### 开箱即用的元 Skill

仓库仅内置三套最小必需的创作台能力包：

-  — 用自然语言生成 Skill / Playbook / Rescue Skill
-  — 用自然语言生成 Program
-  — 创作时复制的文件模板

其余所有具体运维能力（证书管理、容器巡检、主机巡检、救援策略…）交由用户通过创作台自行生成，仓库不分发特定场景的样例

#### 版本发布

- 当前版本升级为 3.0.0 正式版
- 3.0 对应定位为「让 AI 自动化运维既可控又可持续」的分层智能代理系统

### 2.0.0 更新

1Shell 2.0 已从单页 WebSSH 控制台升级为面向多主机运维场景的操作平台。

#### 脚本库与 Playbook

- 新增脚本库，支持创建、编辑、复制、删除脚本
- 支持标签、分类、参数模板与风险等级
- 支持 AI 一键生成脚本
- 新增 Playbook 多步骤编排与顺序执行能力
- 支持将脚本或 Playbook 直接注入当前终端执行

#### AI CLI 接入中心

- 新增 Claude Code / Codex / OpenCode 三种 AI CLI 接入
- 支持多 Provider 配置与活跃渠道切换
- 新增 OpenAI / Anthropic 双向协议代理
- 通过独立沙箱目录与环境变量启动 CLI，不修改用户本地配置
- 自动注入 1Shell MCP，供 AI 直接调用远端 SSH 能力

#### 审计与探针

- 新增独立审计页面，支持分页与多条件筛选
- 审计覆盖 Bridge API、MCP、SSH Session、脚本执行等链路
- 新增独立探针页面与带宽趋势图
- 展示关键进程摘要，便于快速查看主机运行状态

#### 文件与终端体验

- 优化文件浏览器缓存与远程目录访问性能
- 优化 SFTP 连接池健康检测与本地 stat 并发
- 保留 1.x 终端交互基础，并补齐脚本注入等运维场景能力

#### 版本发布

- 当前版本升级为 2.0.0 正式版
- 2.0 对应定位为「脚本沉淀、编排执行、审计追踪、AI 接入」的一体化多机运维版本

#### 1.1.0 更新

MCP / SSH 稳定性：

改成持久化 SSH shell 连接池，避免每条命令都重新握手。
修复 MCP 经常超时的问题。
给 SSH 加了 keepalive，减少空闲断连。
执行超时策略做了调整，避免短超时误杀。

探针优化：

探针改为复用持久连接，不再频繁新建 SSH 连接。
探针轮询间隔从 15 秒调到 60 秒。
顶栏探针信息会跟随当前切换主机刷新，不再一直显示本机。

终端区体验：

加了终端全屏功能。
加了补全建议框关闭按钮。
左侧栏支持折叠，给终端腾更多空间。
调整了顶部按钮布局、AI 面板按钮样式和位置。

文件浏览器功能补全：

新增 下载文件。
新增 上传文件。
新增 文件预览，包括图片预览。
新增 文本文件编辑并保存。
上传时补上了 CSRF token，解决“CSRF 校验失败”。

文件浏览器性能优化：

后端加入 SFTP 连接池，减少频繁建连。
打开远程目录、读取文件明显更快。
版本发布

当前版本升级为 1.1.0 正式版。
## License

[MIT](LICENSE) © 2026 weidu12123

## 友链
http://linux.do/
