# 1Shell 使用指南

> **One Shell to rule them all.** — 基于 Web 的零侵入多服务器管理平台，内置三层渐进式 AI 运维引擎。

---

## 快速导航

### 基础功能

| 章节 | 内容 |
|------|------|
| [登录与系统设置](sections/01-login-and-settings.md) | 首次登录、修改密码、IP 访问控制、AI API 配置、环境变量 |
| [主机管理](sections/02-host-management.md) | 添加主机、探针监控、网站任意门、跳板机 |
| [SSH 终端](sections/03-ssh-terminal.md) | 本地/远程终端、多标签页、工具栏、导航栏 |
| [文件管理](sections/04-file-management.md) | 本地/SFTP 文件浏览、上传下载、在线编辑 |

### AI 能力

| 章节 | 内容 |
|------|------|
| [AI 功能](sections/05-ai-features.md) | AI Chat、1Shell AI 全局助手、Ghost Text、命令建议、选区分析、AI Agent |
| [运维程序 Program](sections/06-program.md) | 创建 Program、三层 AI 引擎（L1/L2/L3）、实例管理 |
| [Skill / Playbook / 脚本库](sections/07-skill-playbook-scripts.md) | 创作工作台、Skill 能力包、一次性 Playbook、脚本管理 |

### 扩展与安全

| 章节 | 内容 |
|------|------|
| [MCP 接入与仓库](sections/08-mcp-warehouse.md) | MCP 协议、一键部署 MCP Server、Claude Code 接入、仓库管理 |
| [安全体系与审计日志](sections/09-security-audit.md) | 安全模式、IP 过滤、凭据加密、AI 安全红线、审计日志 |

---

## 快速开始

### 1. 安装

```bash
# Linux 一键安装
curl -fsSL https://raw.githubusercontent.com/weidu12123/1Shell/main/install.sh | bash

# 或 Docker 部署
git clone https://github.com/weidu12123/1Shell.git
cd 1Shell
cp .env.example .env
docker compose up -d

# 或手动安装（Node.js 18+）
git clone https://github.com/weidu12123/1Shell.git
cd 1Shell
npm install
cp .env.example .env
node server.js
```

### 2. 访问

浏览器打开 `http://服务器IP:3301`，默认账号 `admin` / `admin`。

### 3. 首要配置

1. **修改密码** — 设置 → 账号设置
2. **配置 AI** — AI 配置 → 填写 API Key
3. **添加主机** — 主控台 → + 添加主机

---

> 版本：v3.3.0 | [GitHub](https://github.com/weidu12123/1Shell) | [下载](https://github.com/weidu12123/1Shell/releases)
