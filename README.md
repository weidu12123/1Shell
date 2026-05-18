<div align="center">

# 1Shell

**One Shell to rule them all.**

基于 Web 的 AI 原生多服务器管理平台：终端、文件、探针、脚本、MCP、AI Agent 与三层自动运维集中在一个控制台。

[![version](https://img.shields.io/badge/version-4.0.0-4f8cff?style=flat-square)](https://github.com/weidu12123/1Shell/releases)
[![node](https://img.shields.io/badge/node-%3E%3D18-43a047?style=flat-square&logo=node.js)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-f9a825?style=flat-square)](LICENSE)
[![docker](https://img.shields.io/badge/docker-ready-2496ed?style=flat-square&logo=docker)](https://hub.docker.com)
[![docs](https://img.shields.io/badge/docs-使用指南-blue?style=flat-square)](https://docs.1shell.pro)

[**完整使用指南**](https://docs.1shell.pro) | [**下载 v4.0.0 Release**](https://github.com/weidu12123/1Shell/releases/tag/v4.0.0)

</div>

---

## 什么是 1Shell？

1Shell 是一个面向个人开发者、小团队和轻量运维场景的**多服务器集中管理平台**。你可以通过浏览器统一管理多台 VPS / 云服务器，并让 AI 在授权范围内读取状态、执行命令、分析日志、修改文件、生成自动化程序和处理告警。

它不是传统的“Web SSH 面板”。传统面板解决的是“如何连上服务器”，1Shell 要解决的是**连上之后如何持续、安全、高效地管理一组服务器**。

v4.0 将 1Shell 从旧版页面全面升级为 Vue 3 控制台，并把主机、探针、AI、Skill、Program、脚本库、MCP 与 Agent 面板重新整合成一个统一工作台。

---

## v4.0 重点更新

- **全新 Vue 3 控制台**：前端重构为 Vue 3 + Vite + TypeScript SPA，新的首页、主控台、创作台、脚本库、MCP 仓库和设置页统一体验。
- **主机视图升级**：首页支持世界地图 / 地球视图、主机地理位置、在线状态、GeoIP 提示、未解析主机提醒和主机详情浮层。
- **主控台重构**：主机列表、终端、文件浏览器、AI Chat、1Shell AI、AI Agent 面板整合为一个多栏工作区，并保留常用页面状态，返回时无需重新从零加载。
- **探针系统 4.0**：默认支持 Agentless SSH 探针，也支持一键部署 probe-agent / probe-relay-agent，提供趋势、样本、流量、告警、网络诊断和 Agent 生命周期真实校验。
- **1Shell AI 全局助手**：右下角全局唤起，自动感知当前页面上下文，调用内置工具管理主机、文件、脚本、Program、MCP 和探针。
- **Program 三层自动运维**：L1 确定性执行、L2 Skill 约束维护 / AI 功能层、L3 Guardian AI 危机升级，并保证任一终态都进入结果界面。
- **Skill / Program / 脚本库重构**：支持 1Shell Skill Extension、Claude Code Skill 托管、Program 自动化流程和可复用脚本管理。
- **MCP 仓库与 Bridge 能力增强**：1Shell 可作为 MCP Server 暴露主机、远程文件、脚本、审计、探针、告警、流量、诊断和 Agent 生命周期能力，也可在内部接入外部 MCP 工具供 1Shell AI 调用。
- **AI CLI 面板**：在 Web 控制台内运行 Claude Code / OpenCode / Codex，并支持一键接入 1Shell 能力。
- **安全体系补强**：登录认证、凭据加密、CSRF、防暴力破解、IP 访问控制、AI 安全模式、审计日志和 Bridge Token 隔离。

---

## 功能总览

### 基础管理

| 功能 | 说明 |
|------|------|
| **多机 SSH 终端** | 本地 Shell + 远程 SSH，多标签页切换，支持跳板机级联 |
| **SFTP 文件浏览** | 本地 / 远程双模式，目录导航、文件预览、上传下载、在线编辑 |
| **主机控制台** | 主机分组、状态卡片、连接管理、快捷入口、右侧 AI / Agent 工作区 |
| **脚本库** | 脚本创建、编辑、执行、历史记录和跨主机运行 |
| **审计日志** | 关键操作写入 SQLite，支持查询和追溯 |

### 探针与监控

| 功能 | 说明 |
|------|------|
| **Agentless 探针** | 通过 SSH 采集 CPU、内存、磁盘、负载、网络和系统信息，目标机无需预装组件 |
| **probe-agent** | 可选的一键部署常驻探针，支持安装、自动更新重启、日志查看、卸载和运行状态校验 |
| **probe-relay-agent** | 面向中继 / 内网场景的轻量 Relay Agent，帮助 1Shell 获取不可直连主机状态，并在卸载后清理 Relay 残留状态 |
| **趋势与样本** | 多粒度时序数据、指标趋势图、历史样本、月度流量统计，页面返回时复用已加载状态 |
| **告警与诊断** | 离线告警、阈值告警、一键忽略、Ping / DNS / HTTP 网络诊断 |

### AI 能力

| 功能 | 说明 |
|------|------|
| **1Shell AI** | 平台内置的全局 AI 运维助手，可调用 1Shell 工具完成跨主机操作 |
| **AI Chat** | 独立的 OpenAI 兼容聊天入口，用于普通问答、解释和上下文分析 |
| **Ghost Text** | 终端输入时提供 AI 内联补全，Tab 采纳 |
| **命令建议** | 用自然语言描述目标，AI 生成可执行命令并注入终端 |
| **选区分析** | 框选终端输出后让 AI 解释错误、总结日志并给出修复建议 |
| **AI Agent 面板** | 在侧边栏运行 Claude Code / OpenCode / Codex 等 AI CLI 工具 |

### 自动化与扩展

| 功能 | 说明 |
|------|------|
| **Program** | 声明式运维程序，可定时或手动在多台主机上执行 |
| **三层 AI 引擎** | L1 规则执行 → L2 Skill 修复 → L3 Guardian AI 自主诊断 |
| **Skill Extension** | 面向 1Shell runner / Program L2 的 AI 约束包，按 rules / workflows / references 分层组织 |
| **Claude Code Skill 托管** | 统一管理标准 Claude Code Skill 的导入、启用/禁用、查看和更新 |
| **Program 流程** | 将临时巡检、批量修复和交付任务统一沉淀为可执行运维程序 |
| **MCP Server** | 将 1Shell 的主机、文件、脚本、探针等能力暴露给外部 AI 工具 |
| **MCP 工具接入** | 让 1Shell 内部 AI 调用外部 MCP 工具，如数据库、通知、知识库等 |
| **Bridge API** | 独立 Token 鉴权的 HTTP 桥接接口，适配自动化脚本和外部 CLI |

---

## 快速开始

### 方式一：下载便携包

v4.0 Release 提供 Windows 和 Linux x64 便携包。便携包已包含生产依赖和已构建前端，下载解压后不需要再执行 `npm install`，但运行机器仍需要安装 Node.js 18 或更高版本。

| 平台 | 文件 | 启动方式 |
|------|------|----------|
| Windows x64 | `1Shell-v4.0.0-windows-x64.zip` | 解压后运行 `start.bat`，或执行 `node server.js` |
| Linux x64 | `1Shell-v4.0.0-linux-x64.tar.gz` | 解压后运行 `bash start.sh`，或执行 `node server.js` |

访问地址默认是 `http://localhost:3301`。

### 方式二：一键安装 Linux 服务

```bash
curl -fsSL https://raw.githubusercontent.com/weidu12123/1Shell/main/install.sh | bash
```

可选参数：

```bash
bash install.sh --port 3301 --password change-me --dir /opt/1shell
bash install.sh --docker
```

安装脚本会拉取代码、生成 `.env`、安装依赖，并在原生部署模式下创建 `systemd` 服务。

### 方式三：Docker 部署

```bash
git clone https://github.com/weidu12123/1Shell.git
cd 1Shell
cp .env.example .env
# 编辑 .env，设置登录密码、APP_SECRET、BRIDGE_TOKEN 和 AI 配置
docker compose up -d
```

### 方式四：源码运行 / 开发

```bash
git clone https://github.com/weidu12123/1Shell.git
cd 1Shell
npm install
cp .env.example .env
npm start
```

前端开发：

```bash
cd frontend
npm install
npm run dev
npm run build
```

---

## 首次配置

浏览器打开 `http://服务器IP:3301` 后，建议先完成以下配置：

1. **修改登录密码**：设置 → 账号设置。
2. **配置 AI API**：AI 配置中填写任意 OpenAI 兼容 API Base、API Key 和模型名。
3. **添加主机**：在主控台添加 SSH 主机，可选择密码、私钥、跳板机等连接方式。
4. **启用探针**：先使用 Agentless 探针查看基础状态，需要更完整指标时再部署 probe-agent。
5. **设置 Bridge Token**：如果要让 Claude Code、Cursor 或外部脚本调用 1Shell MCP / Bridge 能力，请配置独立 Token。

---

## 环境变量

复制 `.env.example` 后按需修改：

```env
APP_LOGIN_USERNAME=admin
APP_LOGIN_PASSWORD=change-me

APP_SECRET=replace-with-a-random-secret

OPENAI_API_BASE=https://api.openai.com/v1
OPENAI_API_KEY=replace-with-your-api-key
OPENAI_MODEL=gpt-4o

BRIDGE_TOKEN=replace-with-your-bridge-token
PORT=3301

# TRUSTED_PROXY_IPS=127.0.0.1
```

生产环境请务必修改 `APP_LOGIN_PASSWORD`、`APP_SECRET` 和 `BRIDGE_TOKEN`，并通过 HTTPS 访问。

---

## 1Shell AI

1Shell AI 是内置在平台内部的 AI 运维引擎。它不是外部工具通过 MCP 远程调用几个接口，而是直接拥有 1Shell 页面上下文和平台工具能力。

```text
用户提出目标
    ↓
1Shell AI 感知当前页面、主机、文件、终端或 Program 上下文
    ↓
调用内置工具读取状态、执行命令、读写文件、运行脚本或管理自动化
    ↓
安全模式下逐步审批，审计日志记录关键操作
```

与外部 AI 工具的区别：

| | Claude Code / Cursor 等外部工具 | 1Shell AI |
|---|---|---|
| 接入方式 | 通过 MCP / Bridge 调用 1Shell | 原生内嵌在 1Shell 控制台 |
| 上下文 | 主要依赖工具返回和对话内容 | 自动感知当前页面、选中主机、终端、文件和操作区 |
| 适合场景 | 代码协作、外部自动化、跨工具编排 | 日常运维、主机管理、故障处理、Program / Skill 创作 |
| 权限控制 | Bridge Token / MCP 配置 | 登录会话 + 安全模式 + 审计日志 |

AI Chat 与 1Shell AI 是两个入口：AI Chat 更适合普通聊天和解释，1Shell AI 更适合直接调用平台能力完成操作。

---

## Program：三层渐进式自动运维

Program 是 1Shell 的声明式自动运维程序，用 YAML 描述检查、执行、验证、修复、AI 介入和结果输出。它的执行原则是：**L1 能确定执行就不上 AI；L2 能在 Skill 约束内修复就不上 L3；任一终态都必须进入结果界面。**

```text
Manual / Cron Trigger
        ↓
L1 · 确定性执行
  运行 exec / verify / render，零 AI 消耗
        ↓ verify 失败或显式 AI step
L2 · Program Skill 约束层
  作为维护兜底修复 L1 失败，或作为 Program 主动调用的 AI 功能库
        ↓ 越界 / 高风险 / 需人工 / 疑似事故 / 重复失败
L3 · Guardian / 1Shell AI
  面向危机场景和意料之外异常，在审批、频率限制和审计下介入
        ↓
Result · 结果界面
  成功显示数据；失败显示 L2/L3 的问题说明和下一步信息
```

| 层级 | 负责什么 | 典型触发 | 约束方式 |
|------|----------|----------|----------|
| L1 | 固定命令、verify 校验、key-value / table / message 渲染 | 手动触发、cron 触发、普通巡检步骤 | exit code、正则、阈值、结构化 verify |
| L2 | L1 失败维护、环境差异适配、Program 显式 AI 功能 step | verify failed 后 `on_fail: repair`，或 step 声明 `type: skill` | Program 绑定 `l2.skill`，按 Skill 的 rules / workflows / references 执行 |
| L3 | 危机升级、疑似攻击、高风险处置、超出 L2 边界的问题 | incident 命中、L2 返回 `risk_too_high` / `out_of_scope` / `needs_human_decision` / `suspected_incident`、重复修复失败、显式 escalate | Guardian 频率限制、危险命令拦截、人工审批、审计日志 |

L2 的输出必须是结构化终态：`resolved` 表示已修复并继续后续步骤；`unresolved` 表示未解决但会在结果界面说明原因；`out_of_scope`、`risk_too_high`、`needs_human_decision` 和 `suspected_incident` 会作为 L3 升级依据。

Program 的结果可以输出 key-value、表格、列表、消息和 AI 分析说明。即使运行失败，结果 Tab 也会生成终态说明，避免只给出“运行失败”而没有可执行信息。

---

## Skill / Program / 脚本库

v4.0 将 Skill、Program 和脚本能力拆成更清晰的几类。Skill 采用双轨体系：**1Shell Skill Extension** 是 1Shell 自己的运行时能力包；**Claude Code Skill** 是标准 Claude Code 生态 Skill，1Shell 只负责托管和管理。

### 1Shell Skill Extension

用于 1Shell runner 和 Program L2 的 AI 约束包，负责在指定场景中约束和引导 AI 完成运维、排障、创作或自动化任务。一个 1Shell Skill Extension 是一个文件夹，而不是单个提示词文件：

```text
data/skills/<skill-id>/
├── SKILL.md        # 能力入口和路由
├── rules/          # 规则、约束、安全边界
├── workflows/      # 可执行流程
├── references/     # 背景资料、命令参考、排障手册
├── data/           # 示例数据或静态资料
├── scripts/        # 可调用脚本
└── templates/      # 输出模板
```

普通 1Shell AI、全局悬浮 AI 和主控右栏 AI 不会自动加载所有 Skill。Skill runtime 只在用户手动运行 Skill、创作台显式调用 `run_skill`，或 Program step 声明 `type: skill` 时由 runner / Program L2 指定加载，避免上下文污染和越权调用。

### Claude Code Skill 托管

Claude Code Skill 是 Claude Code 生态的标准 Skill 包，通常来自外部 GitHub 仓库或插件市场。1Shell 可以像管理 MCP 一样托管它：导入仓库、扫描标准 `SKILL.md`、展示说明、启用/禁用、查看、更新或删除托管副本。

Claude Code Skill 默认不进入 1Shell runner 执行链，不自动注入日常 1Shell AI，也不自动转换为 1Shell Skill Extension；标准 Skill 的制作和执行仍属于 Claude Code 生态。

### Program 流程与脚本库

- **Program 流程**：承载巡检、批量修复和交付任务，统一进入 Program 的执行、验证、结果输出和 AI 介入链路。
- **脚本库**：可复用脚本资产，支持执行历史、详情查看和跨主机运行，也可作为 Program 的执行单元。

---

## MCP 与外部 AI 接入

1Shell 同时支持“对外暴露能力”和“对内接入工具”。

### 1Shell 作为 MCP Server

Claude Code、Cursor 等外部 AI 工具可以通过 MCP 调用 1Shell 的多服务器能力，例如：

- 列出主机和探针状态
- 查询探针样本、时序、流量和告警
- 执行 Ping / DNS / HTTP 网络诊断
- 安装、重启、卸载 probe-agent
- 在指定主机执行命令
- 读取 / 写入远程文件
- 上传 / 下载文件
- 查询脚本、执行脚本
- 查询审计和管理 MCP Server

手动配置示例：

```json
{
  "mcpServers": {
    "1shell": {
      "url": "http://your-server:3301/mcp/sse",
      "headers": { "X-Bridge-Token": "replace-with-your-bridge-token" }
    }
  }
}
```

也可以在 1Shell 的 AI Agent 面板中使用一键接入，让 Claude Code 自动获得当前 1Shell 的连接配置。

### 1Shell 接入外部 MCP 工具

MCP 仓库可以管理第三方 MCP Server。启用后，这些工具主要供 1Shell 内部 AI 使用，例如数据库查询、通知发送、知识库检索或自定义业务工具。

---

## 探针系统

1Shell 支持两种探针模式：

| 模式 | 是否在目标机安装组件 | 适合场景 |
|------|----------------------|----------|
| Agentless SSH 探针 | 否 | 快速接入、低侵入、基础监控 |
| probe-agent | 是 | 长期监控、更稳定采样、更完整系统指标 |

探针能力包括：

- CPU、内存、磁盘、负载、网络、系统版本、平台架构采集
- 多粒度趋势图和历史样本查询
- 月度流量统计
- 离线告警和阈值告警，支持一键忽略当前告警
- Ping / DNS / HTTP 诊断
- Agent 安装、自动更新重启、卸载、日志查看和状态展示
- 安装 / 重启 / 卸载后的目标机真实校验，避免命令成功但服务未生效
- Relay Agent 支持内网和中继场景，卸载后清理 Relay 残留状态

---

## 安全体系

1Shell 在赋予 AI 运维能力的同时，内置多层安全控制：

| 安全机制 | 说明 |
|----------|------|
| 登录认证 | 用户名密码、Session 管理、运行时修改凭据 |
| 凭据加密 | SSH 密码和私钥使用 AES-256-GCM + scrypt 加密存储 |
| CSRF 防护 | HttpOnly Session Cookie + CSRF Token |
| 暴力破解防护 | 登录失败锁定策略，降低撞库风险 |
| IP 访问控制 | 支持白名单、黑名单和 CIDR |
| 反向代理感知 | 可配置受信任代理 IP，避免伪造来源 IP |
| AI 安全模式 | 写操作和高风险操作可逐步审批 |
| AI 安全红线 | 拦截明显破坏性命令和危险操作 |
| Bridge 隔离 | Bridge Token 与 Web Session 分离 |
| 审计日志 | 关键操作落库，便于追踪和复盘 |

---

## 架构概览

```text
Browser
  └─ Vue 3 SPA / Vite / TypeScript / xterm.js
        │ HTTP + WebSocket
        ▼
1Shell Server
  ├─ Express + Socket.IO
  ├─ Auth / CSRF / IP Filter / Audit
  ├─ SSH Terminal: node-pty + ssh2
  ├─ File Service: fs + SFTP
  ├─ Probe Service: Agentless SSH + probe-agent + relay-agent
  ├─ AI Service: OpenAI-compatible streaming API
  ├─ 1Shell AI Tools: platform-native tool calling
  ├─ Program Engine: L1 / L2 / L3
  ├─ Skill Runner / Program Runner / Script Runner
  ├─ MCP Server / MCP Warehouse / Bridge API
  ├─ Agent Service: Claude Code / OpenCode / Codex PTY
  └─ SQLite / repositories / migrations
```

---

## 技术栈

| 层 | 技术 |
|----|------|
| 前端 | Vue 3.5、Vite 5、TypeScript、Tailwind CSS、Pinia、Vue Router、xterm.js、页面状态持续化 |
| 后端 | Node.js、Express、Socket.IO、Helmet |
| 数据库 | SQLite、better-sqlite3 |
| SSH / SFTP | ssh2、node-pty |
| AI | OpenAI 兼容 API、流式对话、工具调用 |
| 自动化 | Program Engine、Skill Runner、Program 流程、脚本库 |
| 协议 | MCP、Bridge HTTP API |
| 探针 | Agentless SSH、Go probe-agent、probe-relay-agent |
| 部署 | Docker、docker-compose、systemd、便携包 |

---

## 项目结构

```text
1Shell/
├── server.js                    # 服务入口
├── frontend/                    # Vue 3 SPA
│   ├── src/
│   └── dist/                    # 生产构建产物
├── src/
│   ├── agents/                  # AI CLI 面板与 PTY 管理
│   ├── database/                # SQLite 初始化和迁移
│   ├── ide/                     # 1Shell AI 会话和内置工具
│   ├── mcp/                     # MCP Server / MCP 接入
│   ├── middleware/              # 安全、限流、错误处理中间件
│   ├── probes/                  # 探针、告警、诊断相关逻辑
│   ├── programs/                # Program 三层执行引擎
│   ├── repositories/            # 数据访问层
│   ├── routes/                  # HTTP API 路由
│   ├── services/                # 主机、终端、文件、AI、审计等服务
│   ├── skills/                  # Skill runner 与自动化能力支持
│   └── sockets/                 # WebSocket 事件
├── data/
│   ├── skills/                  # 1Shell Skill Extension
│   ├── claude-code-skills/      # Claude Code Skill 托管目录
│   └── geoip/                   # GeoIP 公开数据资源
├── agent/                       # Go probe-agent / relay-agent 源码与构建脚本
├── docs/                        # 使用指南和设计文档
├── lib/                         # 通用工具库
├── public/                      # 静态资源和兼容入口
├── Dockerfile
├── docker-compose.yml
├── install.sh
└── start.sh / start.bat
```

---

## 适用场景

- 个人开发者或小团队有多台 VPS，需要统一入口管理终端、文件、脚本和监控。
- 不希望在所有目标机预装复杂 Agent，但又希望保留可选常驻 Agent 的增强能力。
- 希望 AI 能在安全审批下协助巡检、排障、执行命令、读写文件和生成自动化流程。
- 想让 Claude Code、Cursor 等外部 AI 工具安全调用远程服务器能力。
- 需要把日常运维经验沉淀成 Program、Skill 和脚本资产。

---

## 与同类工具的区别

| | 传统面板 | Ansible / Terraform | 1Shell |
|---|---|---|---|
| 核心定位 | 服务器面板 | 声明式自动化 / 基础设施编排 | AI 原生多服务器控制台 |
| 接入方式 | 通常需要安装服务端组件 | SSH / API / Provider | Web 控制台 + SSH + 可选 Agent |
| 实时交互 | 有限 | 弱 | 终端、文件、AI、探针、脚本一体化 |
| AI 能力 | 通常没有 | 通常没有 | 1Shell AI + AI Chat + AI Agent + Program L2/L3 |
| 自动化沉淀 | 面板任务 | 声明式配置 / State | Program / Skill / Script |
| 外部协作 | API 能力不一 | CLI / Provider | MCP Server + Bridge API |

---

## License

[MIT](LICENSE) © 2025 weidu12123

## 友链

http://linux.do
