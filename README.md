<div align="center">

# 1Shell

**One Shell to rule them all.**

**WebSSH + VPS 管理中枢 + MCP Server + AI AgentRun。**

给人和 AI Agent 共用的本地优先多主机运维平台。人可以把它当作 WebSSH / VPS 控制台使用；AI Agent 可以通过 MCP、1Shell AI 和受控工具层调用它，让多台 VPS 成为可观察、可操作、可审计、可协作的运维对象。

[![version](https://img.shields.io/badge/version-4.7.8-4f8cff?style=flat-square)](https://github.com/weidu12123/1Shell/releases)
[![node](https://img.shields.io/badge/node-20%20%2F%2022%20%2F%2024-43a047?style=flat-square&logo=node.js)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-f9a825?style=flat-square)](LICENSE)
[![docker](https://img.shields.io/badge/docker-ready-2496ed?style=flat-square&logo=docker)](https://hub.docker.com)

[项目主页](https://github.com/weidu12123/1Shell) · [**全新重构继任项目：VPS Switch (Rust + GPUI) →**](https://github.com/weidu12123/vps-switch)

</div>

> **项目演进通知（v4.7.8 收官版）**：`v4.7.8` 是 1Shell 的收官维护版本。我们已基于 **Rust + GPUI 原生架构**完成了全面重写与升级，推出全新继任项目 **[VPS Switch](https://github.com/weidu12123/vps-switch)**：
> - **极速轻量**：告别 Electron / Chromium，Windows 桌面端常驻内存直降 70%（约 100 MB），Linux 无头服务空闲仅 **9.7 MB RSS**；
> - **核心体验重做**：`alacritty_terminal` 权威终端状态机 + 2 MiB 历史回放 + 随包新版 ConPTY、16 MiB 窗口高速流式文件传输（断点续传 + SHA-256 对账）、精准物理网卡探针、本机代理端口（SOCKS5 / HTTP CONNECT）出口路由；
> - **标准 MCP Server**：收敛为 7 个核心工具，支持主机名直达与多机并发调度。欢迎前往 [**weidu12123/vps-switch**](https://github.com/weidu12123/vps-switch) 下载体验。

---

## 什么是 1Shell？

1Shell 是一个面向个人开发者、小团队和轻量运维场景的多主机运维平台。它有两个同等重要的身份：

- 对人来说，它是一个 WebSSH / VPS 管理中枢，用来管理终端、文件、脚本、探针、审计和 AI 辅助操作。
- 对 AI Agent 来说，它是一个受安全边界管控的 MCP Server，把多台 VPS 封装成可被智能体调用的运维能力层。

传统 WebSSH 面板解决的是“如何连上服务器”；1Shell 更关注连接之后的人机协同运维闭环：

```text
人 / AI Agent 发起目标
        ↓
1Shell AI AgentRun / MCP Server / Bridge API
        ↓
主机发现 -> 远程命令 / 文件 / 脚本 / 探针 / 诊断
        ↓
Harness 安全边界 -> 执行与观察 -> 验证结果 -> 审计留痕
```

在 4.2 中，1Shell AI 的核心执行单元收敛为 **AgentRun**：一次用户目标对应一次可追踪、可中断、可审计、可验证的运行过程。旧版重型 Program / Task runtime 不再作为默认产品路径；可复用能力会围绕真实成功的 AgentRun、Skill、Script 和轻量 AI Task 逐步沉淀。

4.5 完成了 Panel 与配置的拆分：配置能力独立为“配置”板块，Panel 回到详情、主机、文件、探针、审计等服务器面板主线。下一阶段开始补全 1Shell 还缺少的确定性面板能力，优先从 systemd、Docker / Compose、端口 / 进程、日志、证书、站点 / 反代和主机健康概览做资源发现与只读状态，再逐步加入可审计操作。详见 [Panel 补全计划](docs/oneshell-panel-completion-plan.md)。

下一步路线再强调一次：证书管理不要照抄 1Panel 的常驻证书中心和大 CRUD 面板，优先做“发现 -> 到期预警 -> 任务化签发/续期 -> 验证/审计”的确定性链路。低频、重操作、需要证书密钥参与的部分，交给任务模块和 1Shell AI 编排，尽量不把负担留在受控 VPS 上。

本次同步补齐了几处 agent 体验细节：

- `/compact` 会压缩历史消息，并在前端显示独立的“正在压缩...”状态。
- 主机列表、探针列表等工具结果支持结构化卡片展示，减少模型重新拼表格导致的格式漂移。
- 1Shell AI 的工具结果会尽量把结构化数据交给前端渲染，最终回答只负责总结。
- 清理了过度具体的 GitHub 部署提示，让模型根据目标和上下文自行判断是阅读网页还是拉取源码。

---

## 核心能力

### 1. 多 VPS 集成管理

1Shell 提供统一的 VPS 工作台，用于管理多台远程主机和本机环境。

| 能力 | 说明 |
|---|---|
| 多机 SSH 终端 | 统一管理本机 Shell 与远程 SSH 会话 |
| SFTP 文件管理 | 浏览、预览、编辑、上传、下载、新建、重命名和删除远程文件 |
| 主机仓库 | 管理主机、角色、标签、排序、归档与连接信息 |
| 服务器详情 | 查看单机详情和跨 VPS 健康概览 |
| 服务面板 | 后续补全 systemd、Docker / Compose、端口 / 进程、日志、证书状态与任务化签发/续期、站点 / 反代等确定性能力 |
| 脚本库 | 沉淀常用运维脚本，在终端里一键注入；1Shell AI 可读写和运行 |
| 探针监控 | Agentless SSH 探针、probe-agent、relay-agent 与流量统计 |
| 审计日志 | 记录关键命令、脚本执行、Bridge/MCP 调用和高风险操作 |

1Shell 的目标不是替代所有专业运维系统，而是给个人开发者和小团队提供一个足够完整、足够可控、足够易扩展的 VPS 运维入口。

Panel 的补全遵循“两层视角”：单机下钻提供接近传统服务器面板的查看和操作能力；全局视角负责跨 VPS 汇总、筛选、对比和异常定位。这也是 1Shell 区别于单 VPS 面板的核心产品形态。

### 2. 1Shell AI 与 AgentRun

1Shell AI 是平台内部的智能运维 Agent，也是外部 Agent 调用复杂能力时的网关。

| 概念 | 说明 |
|---|---|
| AgentRun | 单次目标执行循环，保存状态、预算、工具策略、trace、interrupt 和最终结果 |
| Harness | AI 触达真实世界的统一边界，负责风险拦截、审批、能力授权和审计 |
| Skill | 按需加载的 markdown 知识包，指导 AI 完成特定类型任务 |
| Script | 可复用的确定性命令模板，适合固定动作 |
| AI Task | 从真实成功路径中沉淀的轻量任务对象，仍由 1Shell AI 执行 |

AgentRun 的基本循环是：

```text
user goal
-> AgentRun
-> gather context
-> choose a tool
-> execute through Harness / policy
-> observe tool result
-> decide the next action
-> ask user / request secret / request approval when needed
-> verify outcome
-> publish a truthful final status
```

IDE Agent 页面围绕这个循环提供会话侧栏、工具侧栏、时间线、审批卡片、结构化工具卡片、`/compact` 和 `/rewind`。模型仍然负责判断下一步，runtime 负责保存状态、传递事件、约束工具、压缩上下文和记录轨迹。

4.2 的重点不是恢复旧工作流 DSL，而是让模型在清晰工具和安全边界内自主工作。可复用任务必须来自验证过的实践路径，而不是把一句目标直接拆成看起来完整的步骤卡片。

### 3. MCP Server：给外部 Agent 的运维入口

1Shell 可以作为标准 MCP Server 暴露给外部 Agent，也可以作为内部能力总线服务 1Shell AI。Claude Code、Codex、OpenCode、Hermes 以及其他支持 MCP 的 Agent 都可以把 1Shell 当作服务器运维工具层。

内部和外部调用都通过同一套能力层：

```text
Claude Code / Codex / OpenCode / 1Shell AI
        ↓
MCP / Bridge / AgentRun
        ↓
Harness 边界统一管控
        ↓
主机 / 文件 / 脚本 / 探针 / 诊断 / 审计
```

本地访问使用 Bridge Token，远程访问使用 Remote MCP Token。远程 MCP 默认关闭，需要显式开启并建议通过 HTTPS 暴露。

| 校验项 | 说明 |
|---|---|
| 远程开关 | 不显式开启则不对公网暴露 |
| 强制 HTTPS | 远程模式默认拒绝明文传输 |
| Host / Origin 白名单 | 可限制允许访问的域名与浏览器来源 |
| Remote Token | 独立签发、可吊销、可设置过期时间 |
| Token ACL | 限定可调用工具、可访问主机、可运行脚本和可读写路径 |

本地 MCP 示例：

```json
{
  "mcpServers": {
    "1shell": {
      "url": "http://localhost:3301/mcp/sse",
      "headers": {
        "X-Bridge-Token": "replace-with-your-bridge-token"
      }
    }
  }
}
```

远程 MCP 示例：

```json
{
  "mcpServers": {
    "1shell": {
      "url": "https://your-domain/mcp/sse",
      "headers": {
        "X-Remote-Mcp-Token": "replace-with-your-remote-mcp-token"
      }
    }
  }
}
```

### 4. 探针系统与监控闭环

1Shell 内置 VPS 探针系统，用于观察服务器运行状态。

| 模式 | 说明 | 适合场景 |
|---|---|---|
| Agentless SSH 探针 | 不在目标机安装组件，通过 SSH 采集基础指标 | 快速接入、低侵入 |
| probe-agent | 在目标机安装轻量常驻 Agent（Go 二进制） | 长期监控、稳定采样、完整指标 |
| probe-relay-agent | 通过中继 Agent 汇聚不可直连网络中的探针数据 | 内网、隔离网络、中继场景 |

探针能力包括 CPU、内存、磁盘、负载、进程、系统信息、网络速率、累计流量、月度流量统计、离线告警、阈值告警、Ping / DNS / HTTP 诊断，以及 Agent 安装、重启、卸载和真实状态校验。

### 5. 文件管理与 Docker 场景

4.2 补齐了文件管理器的基础写操作：新建文件夹、新建文件、重命名、删除、排序和写后刷新。后端同时提供本机与 SFTP 路径的防护，拒绝路径穿越、根目录删除、盘符根目录操作和重命名覆盖。

Docker 部署时要注意容器视角与宿主机视角：

- 默认挂载可以用只读模式浏览宿主目录，避免容器内工具直接改宿主关键路径。
- 如果确实需要让 1Shell 修改宿主目录，把对应 volume 从 `:ro` 改为 `:rw` 后重启容器。
- 更推荐把宿主机本身作为 SSH 主机添加进 1Shell，通过主机视角读写，权限边界更清晰。

可访问 `/api/files/write-check` 验证当前文件写入工具链状态。

### 6. 登录、2FA 与桌面版

4.2 加强了远程管理的基础安全与发布体验：

- 登录支持 TOTP 2FA，兼容 Google Authenticator 等认证器。
- 支持一次性恢复码，恢复码只展示一次，服务端只保存哈希。
- 设置页独立为 `/settings`，包含账号、安全、IP 访问控制、AI 配置、桌面版和关于页面。
- 桌面版支持 GitHub Releases 自动更新，浏览器/开发模式下可在“设置 -> 关于”前往 Releases 手动下载。

---

## 快速开始

### 环境要求

- Node.js 20.18.3 推荐；Node.js 22 和 24 可运行。
- Node.js 22/24 会优先使用内置 `node:sqlite`，避免本机缺少 `better-sqlite3` 原生绑定时降级到文件存储。
- npm。
- Linux / Windows / macOS 均可运行服务端。
- 远程 VPS 需支持 SSH。
- AI 能力需要配置 OpenAI 兼容 API 或对应 Provider。

### Linux 一键安装

```bash
curl -fsSL https://raw.githubusercontent.com/weidu12123/1Shell/main/install.sh | bash
```

可选参数：

```bash
bash install.sh --port 3301 --password change-me --dir /opt/1shell
bash install.sh --docker
```

### Docker 部署

```bash
git clone https://github.com/weidu12123/1Shell.git
cd 1Shell
cp .env.example .env
docker compose up -d
```

### 源码运行

```bash
git clone https://github.com/weidu12123/1Shell.git
cd 1Shell
nvm use
npm ci
npm --prefix frontend ci
npm --prefix frontend run build
cp .env.example .env
npm start
```

Windows 可以使用：

```bat
start.bat
```

Linux / macOS 可以使用：

```bash
bash start.sh
```

默认访问地址：`http://localhost:3301`

前端开发：

```bash
npm --prefix frontend run dev
```

---

## 首次配置

启动后建议完成以下配置：

1. 修改默认登录账号和密码。
2. 确认 `APP_SECRET` 已由启动脚本自动生成，或手动配置强随机密钥，用于加密存储 SSH 密码、私钥和 passphrase。
3. 配置 AI Provider，例如 OpenAI 兼容 API。
4. 添加第一台 SSH 主机。
5. 按需启用 TOTP 2FA。
6. 启用 Agentless 探针，如需长期监控再部署 probe-agent。
7. 如需外部 Agent 远程接入，开启远程 MCP、创建 Remote MCP Token 并配置 ACL，通过 HTTPS 暴露。

示例 `.env`：

```env
APP_LOGIN_USERNAME=admin
APP_LOGIN_PASSWORD=change-me

APP_SECRET=replace-with-a-long-random-app-secret

OPENAI_API_BASE=https://api.openai.com/v1
OPENAI_API_KEY=replace-with-your-key
OPENAI_MODEL=gpt-4o

# 留空会在首次启动时自动生成并保存到 data/bridge-token.json
BRIDGE_TOKEN=
PORT=3301
```

生产环境请务必修改默认密码、保留或替换为强随机 `APP_SECRET`，并通过 HTTPS 访问。

---

## 架构概览

```text
Browser / Desktop Shell
  └─ Vue 3 SPA / xterm.js / Tailwind / Pinia
        │
        │ HTTP + WebSocket
        ▼
1Shell Server
  ├─ Express / Socket.IO
  ├─ Auth / CSRF / IP Filter / Audit
  ├─ SSH Terminal / SFTP File Service
  ├─ Script Service / Script Runner
  ├─ Probe Service
  │   ├─ Agentless SSH Probe
  │   ├─ probe-agent
  │   └─ probe-relay-agent
  ├─ IDE Service
  │   ├─ session persistence / streaming events
  │   ├─ structured tool result normalization
  │   └─ /compact / /rewind
  ├─ AgentRun Runtime
  │   ├─ state / interrupt / replay / final gate
  │   └─ tool policy / verifier / trajectory
  ├─ Harness Boundary
  │   ├─ risk rules / approval / capability guard
  │   ├─ secret ref / masking
  │   └─ trace
  ├─ MCP Server
  ├─ Skill Registry
  ├─ AI Task Service
  ├─ AI Agent PTY（Claude Code / OpenCode / Codex）
  └─ SQLite / Repositories / Migrations
```

---

## 技术栈

| 层级 | 技术 |
|---|---|
| 前端 | Vue 3、Vite、TypeScript、Tailwind CSS、Pinia、Vue Router、xterm.js |
| 后端 | Node.js、Express、Socket.IO |
| 数据库 | SQLite、better-sqlite3 |
| SSH / SFTP | ssh2、node-pty |
| AI | OpenAI 兼容 API、流式输出、工具调用 |
| AI 边界 | AgentRun + Harness（统一关口、确定性护栏、能力授权、执行轨迹） |
| MCP | MCP SSE / Streamable HTTP，Remote Token ACL |
| 探针 | Agentless SSH、probe-agent（Go）、probe-relay-agent |
| 桌面版 | Electron、electron-builder、electron-updater |
| 部署 | Docker、docker-compose、systemd、便携包 |

---

## 项目结构

```text
1Shell/
├── server.js                    # 服务入口与依赖装配
├── desktop/                     # Electron 桌面入口
├── frontend/                    # Vue 3 前端
│   ├── src/
│   └── dist/                    # 构建产物，源码仓库中不提交
├── src/
│   ├── agent-runtime/           # AgentRun 状态、执行、回放、终态校验
│   ├── agents/                  # AI CLI Agent 面板与沙箱
│   ├── ai/                      # AI 提示词与安全规则
│   ├── app/                     # Express / Server 初始化
│   ├── database/                # SQLite 与 migrations
│   ├── harness/                 # AI 边界层：dispatch / guard / capabilities / trace
│   ├── ide/                     # 1Shell AI 对话引擎与工具调用
│   ├── mcp/                     # MCP Server
│   ├── middleware/              # 安全中间件
│   ├── repositories/            # 数据访问层
│   ├── routes/                  # API 路由
│   ├── services/                # 主机、文件、探针、脚本、审计、2FA 等服务
│   ├── skills/                  # Skill registry
│   └── tools/                   # 统一工具层
├── data/
│   └── skills/                  # 内置 Skill 与模板；运行数据库不提交
├── agent/                       # probe-agent / relay-agent（Go）
├── scripts/                     # 构建、打包、测试辅助脚本
├── .github/workflows/           # CI 与发布工作流
├── Dockerfile
├── docker-compose.yml
└── install.sh
```

---

## 安全设计

1Shell 面向真实服务器操作场景，安全边界是核心设计之一。安全措施分两层：外部安全和 AI 操控安全。

### 外部安全

| 机制 | 说明 |
|---|---|
| 登录认证 | 用户名密码 + Session 管理，失败锁定防暴力破解，时序安全比对 |
| 2FA | TOTP 两步验证，支持一次性恢复码 |
| CSRF 防护 | Session Cookie + CSRF Token |
| IP 访问控制 | 白名单 / 黑名单双模式，支持 CIDR，热更新无需重启 |
| 凭据加密 | SSH 密码、私钥、Passphrase 用 AES-256-GCM 加密存储 |
| Bridge / MCP 鉴权 | Bridge Token 与 Web Session 隔离；Remote Token 支持 ACL、吊销和过期 |

### AI 操控安全

AI 执行命令、读写文件、安装 Agent、调用脚本等真实世界操作都必须经过 Harness。

| 机制 | 说明 |
|---|---|
| 唯一边界 | AI 触达外部世界的路径统一走 Harness dispatch |
| 风险规则 | 灾难命令、明显危险写入和越权工具在执行前拦截 |
| 能力最小授权 | AgentRun / Task / MCP Token 可限制工具、主机、路径和脚本范围 |
| 人审降级 | 写操作和高风险操作可进入人工审批 |
| Secret 引用 | AgentRun trace 不保存密钥明文，只回灌 secret ref |
| 输出脱敏 | token、密码、私钥等敏感信息在日志和前端输出前打码 |
| 执行轨迹 | 工具调用、观察、拦截原因和最终状态可回溯 |

1Shell 的设计目标不是让智能体绕过运维安全边界，而是在明确授权、可审计、可验证的前提下参与运维流程。

---

## 适用场景

- 个人开发者管理多台 VPS。
- 小团队统一管理测试机、部署机和服务节点。
- 在浏览器中同时处理终端、文件、脚本和监控。
- 让智能体在授权范围内协助排障、巡检、部署和维护。
- 通过 MCP 把 1Shell 开放给 Claude Code、Codex、OpenCode 等外部 Agent 协作。
- 在本地优先、可控、可审计的前提下构建个人运维中枢。

---

## 开发与验证

```bash
nvm use
npm ci
npm test
npm --prefix frontend ci
npm --prefix frontend run typecheck
npm --prefix frontend run build
```

探针 Agent：

```bash
cd agent
go test ./...
```

---

## License

[MIT](LICENSE) © 2025 weidu12123

## 友链

http://linux.do
