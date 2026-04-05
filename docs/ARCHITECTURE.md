# 1Shell V6 技术路线图：零节点云端总司令

> 项目名：1Shell
> Slogan：One Shell to rule them all.
> 版本：V6 Zero-Agent Cloud Commander
> 基线：V5 沉浸式 AI 终端（v5-20260402-immersive-ai-terminal）

---

## 1. V6 总目标

V5 完成了 PTY Agent 透传的第一步——claude-code 可以在侧边栏启动，通过 banner 注入感知当前目标主机。

V6 的目标是将这个"感知"升级为"执行"：

- 让 AI CLI 工具（claude-code、gemini-cli、opencode 等）获得**真正的 SSH 执行能力**，而不依赖 prompt 层面的行为约束
- 通过 **MCP (Model Context Protocol)** 给 claude-code 注册标准工具，实现可靠的远端命令执行闭环
- 通过 **Bridge Exec API** 给其他 CLI 工具提供 1shell-exec 调用路径
- 保持 1Shell 的核心灵魂：**目标 VPS 零侵入，凭据不离主控端**

---

## 2. V5 已有基础

| 模块 | 文件 | 状态 |
|------|------|------|
| PTY Agent 服务 | `src/agents/agent-pty.service.js` | 已完成，可复用 |
| CLI Provider 注册表 | `src/agents/providers/index.js` | 已有 Claude Code |
| Agent Socket 处理 | `src/sockets/registerAgentSocketHandlers.js` | 已完成 |
| SSH 连接与认证 | `src/services/host.service.js` | 已完成，buildConnectionConfig |
| 主机 CRUD | `src/services/host.service.js` | 已完成 |
| Banner 上下文注入 | `agent-pty.service.js#buildHostBanner` | 已完成，作为 fallback 保留 |

V6 在此之上新增两个独立模块，**不破坏任何已有链路**。

---

## 3. V6 架构设计

### 3.1 核心原则

```
claude-code（本地 PTY 进程）
    ↕ MCP 协议（HTTP SSE）
1Shell MCP Server（Express 新增路由）
    ↕ Bridge Service（ssh2 exec 模式）
目标 VPS（零侵入，凭据从不离开主控端）
```

### 3.2 两条技术路线（分层降级）

**路线 A（首选）：MCP Server + claude-code 原生工具调用**

- 在 1Shell Express 服务器新增 `/mcp/sse` 端点
- 实现 MCP HTTP SSE 传输协议（JSON-RPC 2.0）
- 注册 `execute_ssh_command`、`list_hosts` 工具
- claude-code 通过 `--mcp-server` 或 `.claude/mcp_settings.json` 配置接入
- AI 调用的是 **已注册工具**，不依赖 prompt 约束

**路线 B（降级 fallback）：1shell-exec 本地包装器**

- 在主控机注册全局命令 `1shell-exec`（Node.js 脚本或 shell wrapper）
- 调用 `POST /api/internal/bridge/exec`（内部 token 鉴权）
- 适用于不支持 MCP 的 CLI 工具（gemini-cli、opencode 等）
- banner 注入中明确告知 AI 使用 `1shell-exec` 代替 `ssh`

### 3.3 Bridge Exec API（两条路线共享底层）

```
POST /api/internal/bridge/exec
Header: X-Bridge-Token: <BRIDGE_TOKEN>
Body: { hostId, command, timeout? }
Response: { ok, stdout, stderr, exitCode, durationMs }
```

- **复用** `host.service.js#buildConnectionConfig` 获取 SSH 连接参数
- 使用 ssh2 `client.exec()` 模式（非 shell），干净的 stdout/stderr 分离
- 不在目标机器上留任何文件或进程
- `BRIDGE_TOKEN` 独立于 Web 登录 session，防止 CSRF

---

## 4. V6 实施范围

### 4.1 P0：Bridge Service + Bridge API（最小闭环）

**新文件：**
- `src/services/bridge.service.js` — SSH exec 桥接，返回 `{stdout, stderr, exitCode}`
- `src/routes/bridge.routes.js` — `POST /api/internal/bridge/exec` 路由

**配置新增（`src/config/env.js`）：**
- `BRIDGE_TOKEN` — 内部 API 鉴权 token（环境变量）
- `BRIDGE_EXEC_TIMEOUT_MS` — 默认命令执行超时（默认 30s）

**价值：** 立即可用，任何能发 HTTP 请求的 CLI 工具或脚本都能接入

### 4.2 P1：MCP Server（claude-code 原生接入）

**新文件：**
- `src/mcp/mcp.service.js` — MCP SSE 服务，管理连接生命周期
- `src/mcp/mcp.tools.js` — Tool 定义（execute_ssh_command、list_hosts）
- `src/routes/mcp.routes.js` — `GET /mcp/sse` 和 `POST /mcp/message`

**协议版本：** MCP 2024-11-05（claude-code 当前支持版本）

**工具列表：**
```
execute_ssh_command(hostId, command, timeout?) → { stdout, stderr, exitCode }
list_hosts() → { hosts: [{id, name, type, host, port}] }
```

**价值：** claude-code 将这两个工具视为 first-class 工具，无 prompt hacking

### 4.3 P2：扩展 Agent Providers

**更新文件：**
- `src/agents/providers/index.js` — 添加 Gemini CLI、OpenCode provider

**provider 最小结构：**
```javascript
{ id, label, command, args, env }
```

**策略：** 对不支持 MCP 的 provider，banner 注入中追加 1shell-exec 使用说明

---

## 5. 不做的事（明确边界）

| 事项 | 原因 |
|------|------|
| 在目标 VPS 安装任何东西 | 违背零侵入原则 |
| 重写 PTY Agent 架构 | V5 已稳定，只在其上增量 |
| 实现 WebSocket 版 MCP | HTTP SSE 更简单且 claude-code 已支持 |
| 自动发现并配置 MCP server | 需要用户手动配置一次即可 |
| 实现 AI 编排层（自己调 LLM API） | 这是 CLI 工具自己的职责 |
| 修改目标机 SSH 配置 | 零侵入 |

---

## 6. 文件改动清单

### 新增文件
```
src/services/bridge.service.js
src/routes/bridge.routes.js
src/mcp/mcp.service.js
src/mcp/mcp.tools.js
src/routes/mcp.routes.js
```

### 修改文件
```
src/config/env.js          — 新增 BRIDGE_TOKEN、BRIDGE_EXEC_TIMEOUT_MS
src/agents/providers/index.js  — 新增 Gemini CLI、OpenCode provider
server.js                  — 装配新路由和服务
.env.example               — 新增变量说明
```

### 不动文件
```
src/services/session.service.js       — 保持不变
src/agents/agent-pty.service.js       — 保持不变（banner 注入作为 fallback）
src/sockets/registerAgentSocketHandlers.js — 保持不变
src/services/host.service.js          — 保持不变，被 bridge 复用
```

---

## 7. claude-code 接入方式（用户配置）

启动 1Shell 服务后，在本机 `.claude/mcp_settings.json`（或项目级）添加：

```json
{
  "mcpServers": {
    "1shell": {
      "url": "http://localhost:3301/mcp/sse",
      "headers": {
        "X-Bridge-Token": "<your BRIDGE_TOKEN>"
      }
    }
  }
}
```

或使用命令行启动时指定：

```bash
claude --mcp-server http://localhost:3301/mcp/sse
```

---

## 8. 完成标准

### Bridge API
- `POST /api/internal/bridge/exec` 能在指定主机执行命令并返回结果
- token 验证失败返回 401
- 命令超时返回 408
- 主机不存在返回 404

### MCP Server
- claude-code 能连接 `/mcp/sse` 并列出工具
- claude-code 能调用 `execute_ssh_command` 在目标主机执行命令
- claude-code 能调用 `list_hosts` 获取主机列表
- SSE 连接断开时资源正确清理

### Providers 扩展
- 前端 provider 选择器能看到 Gemini CLI 和 OpenCode 选项
- 对应 CLI 工具存在时能正常启动 PTY session

---

## 9. 后续 V7 方向（本版不做）

- 任务编排：多步骤自动化任务的状态追踪与回滚
- 主机组：批量对多台机器执行操作
- 审计日志：记录每次 Bridge 执行的命令与结果
- MCP 权限控制：限制特定 AI 会话只能操作指定主机
