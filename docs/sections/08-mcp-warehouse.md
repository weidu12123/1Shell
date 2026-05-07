# 板块八：MCP 接入与仓库

---

## 1. 什么是 MCP

MCP（Model Context Protocol）是一个标准化协议，1Shell 通过 MCP 实现两个方向的 AI 协作：

- **对外暴露**：1Shell 自身作为 MCP Server，让 Claude Code 等外部 AI 工具直接调用多服务器管理能力
- **对内接入**：1Shell 可以接入外部 MCP 工具（天气、数据库、办公软件等），AI 运维过程中可调用

---

## 2. 仓库（Warehouse）

仓库是 Skill 和 MCP Server 的统一管理中心。

进入方式：左侧导航栏 → **「仓库」**

![仓库页面](images/08-warehouse.png)

### 2.1 三个标签页

| 标签页 | 内容 |
|--------|------|
| **Skill** | 已有的 AI 能力包（如磁盘健康巡检、Docker 运维救援） |
| **MCP Server** | 远程 MCP Server |
| **本地 MCP** | 本地部署的 MCP Server（如 Office Word、PowerPoint） |

### 2.2 操作

- 点击 **「去创作台 →」** 跳转到创作工作台创建新的 Skill
- Skill 卡片显示名称、ID、标签
- 红色「删除」按钮可移除不需要的 Skill

---

## 3. AI 一键部署 MCP Server

1Shell 支持通过 AI 自动从 GitHub 部署 MCP Server。

![AI 一键部署 MCP](images/08-mcp-deploy.png)

### 3.1 使用方式

1. 在仓库页面或 AI 配置页面，点击 **「AI 一键部署本地 MCP」**
2. 粘贴 GitHub 仓库链接（如 `https://github.com/modelcontextprotocol/servers`）
3. 点击 **「开始部署 →」**
4. AI 自动完成：克隆代码 → 安装依赖 → 初始化配置 → 注册为 MCP Server

部署完成后，MCP Server 自动出现在仓库的「本地 MCP」标签页中，创作工作台和 1Shell AI 可以直接调用。

---

## 4. 接入 Claude Code（对外 MCP）

### 4.1 一键接入

登录后点击顶栏 **「AI Agent」** → **「一键接入」**，自动完成 Claude Code 的 MCP 配置。

### 4.2 手动配置

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

### 4.3 可用 MCP 工具

| 工具 | 说明 |
|------|------|
| `execute_ssh_command` | 在指定主机执行命令，返回 stdout / stderr / exitCode |
| `list_hosts` | 列出所有已配置主机 |
| `list_mcp_tools` | 列出 1Shell 已接入的所有 MCP 工具 |
| `call_mcp_tool` | 调用 1Shell 已接入的 MCP 工具 |

### 4.4 Bridge API

除了 MCP 协议，1Shell 还提供 HTTP Bridge API：

```bash
curl -X POST http://localhost:3301/api/internal/bridge/exec \
  -H "X-Bridge-Token: your-token" \
  -H "Content-Type: application/json" \
  -d '{"hostId": "host-xxx", "command": "uptime"}'
```

适用于任何支持 HTTP 调用的工具或脚本。
