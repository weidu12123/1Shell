# 1Shell Changelog

## v3.3.0 (2026-04-27)

> **1Shell AI 全局化 + 内置 MCP 工具体系**
>
> 从"主控台有个 AI 按钮"进化到"每个页面都是 AI 的入口，每个功能都是 AI 的工具"。

### 1. 1Shell AI 全局化

- 新增 `ai-fab.js` 浮动 AI 组件，右下角常驻按钮，一键唤起 AI 对话
- 覆盖全部 11 个子页面：容器、网站、脚本、Skill 仓库、长驻程序、Playbook、运行记录、探针、审计、创作台、AI 配置
- 自动感知当前模块上下文（页面类型 + 选中主机），AI 一上来就知道用户在看什么
- 内置安全模式审批条，支持允许 / 拒绝 / 自定义回复
- 自动加载 socket.io，无需各页面额外引入依赖
- index.html 已有 IDE 面板，自动跳过，不冲突

### 2. 内置 MCP 工具体系（IDE 底层扩展）

在 `ide.tools.js` 中新增 9 个 1Shell Core 工具，AI 可直接调用 1Shell 全部业务能力：

| 工具 | 能力 |
|---|---|
| `list_containers` | 列出主机上所有 Docker 容器（名称、镜像、状态、端口） |
| `manage_container` | 容器生命周期管理：start / stop / restart / rm / logs / inspect |
| `list_sites` | 扫描主机 Web 服务器配置 + SSL 证书信息 |
| `list_dns_providers` | 列出已保存的 DNS 验证凭据（token 脱敏） |
| `manage_dns_provider` | DNS 凭据增删改（Cloudflare API Token 等） |
| `list_scripts` | 列出脚本库所有脚本 |
| `run_script` | 在指定主机上执行脚本（支持参数传入） |
| `query_probe` | 获取所有主机的实时监控指标（CPU / 内存 / 磁盘 / 负载） |
| `query_audit` | 查询审计日志（支持按 action / hostId / keyword 过滤） |

工具总数从 14 个扩展到 23 个。

### 3. 数据可发现、可操作

- AI 无需预注入页面数据，通过工具主动探索：用户问"我的 Cloudflare token 配了哪些域名？"，AI 自行调 `list_dns_providers`
- 所有业务数据（容器、站点、证书、DNS 凭据、脚本、探针指标、审计记录）均以结构化文本返回，AI 可理解、可推理、可操作
- 操作全程记录审计日志

### 改动文件

- 新增 `public/ai-fab.js`（浮动 AI 组件）
- 修改 `src/ide/ide.tools.js`（+9 工具 schema + handler）
- 修改 `server.js`（注入 scriptService / probeService / siteScanService / dataDir）
- 修改 11 个 HTML 页面（各加一行 `<script src="ai-fab.js">`）

---

## v3.0.0（规划中）

### 方向：Agent Skill — 声明式自动化运维

> 3.0 的核心命题：**用户给目标，AI Agent 交付结果。**
>
> Skill 不是参数化脚本，不是写好步骤让用户点执行。
> Skill = AI Agent 的任务书。用户只需填入最终想要的东西（域名、端口），
> 点一下按钮，Agent 全权负责在目标 VPS 上完成一切——安装、配置、调试、验证。
> 过程中遇到问题 Agent 自己解决，用户只需等待「完成」。

### 设计原则

1. **结果导向，不是过程导向**
   - 用户填域名和端口 → 网站上线，HTTPS 可访问
   - 用户不需要知道 Nginx 怎么装、证书怎么申请、反代怎么配
   - AI 根据目标机器实际情况自主决策执行路径

2. **放弃零侵入**
   - Agent 需要在 VPS 上自由操作：安装软件包、写配置文件、启动服务
   - 以结果为导向，给予 Agent 最大自由度
   - 用户授权后，Agent 可以做任何完成目标所需的操作

3. **Agent 自主处理异常**
   - 端口被占用 → Agent 自己查进程、决策处理方案
   - 证书申请失败 → 切换验证方式自动重试
   - 依赖缺失 → 自动安装
   - 不把错误日志甩给用户，Agent 自己读、自己改、自己重试

4. **傻瓜式用户界面**
   - 每个 Skill 是一个独立页面，只展示用户需要填的信息
   - 一键建站：填域名、端口、Cloudflare API Token → 点「部署」
   - 容器管理：看到容器列表 → 点启动/停止/删除
   - 不暴露任何技术细节（MCP、JSON Schema、正则、shell 命令）

### 首批 Skill（对标 1Panel）

#### 一键建站
- 输入：域名、端口、Cloudflare API Token（可选）
- 输出：HTTPS 网站可访问
- Agent 自动完成：Docker 环境检查 → 拉取镜像 → 启动容器 → 安装/配置 Nginx → 申请 SSL 证书 → 配置反向代理 → 验证访问

#### 容器管理
- 输入：无（自动扫描）
- 输出：容器列表 + 一键操作
- Agent 自动完成：列出所有容器 → 展示状态/资源占用 → 提供启停/日志/删除操作

### 与旧方案的区别

| | 旧方案（已废弃） | 新方案 |
|---|---|---|
| Skill 本质 | 参数化脚本模板 | AI Agent 的任务书 |
| 执行方式 | 预定义步骤顺序执行 | Agent 自主推理 + 执行 |
| 异常处理 | 失败中断，报错给用户 | Agent 自己读错误、自己修 |
| 用户界面 | 暴露参数/步骤/输出提取 | 只暴露最终目标（域名、端口） |
| 侵入性 | 零侵入（只执行命令） | 按需侵入（安装、配置、写文件） |
| 扩展性 | 人写脚本模板 | Agent 根据目标自适应 |

### 技术路线

- Agent 通过 MCP `execute_ssh_command` 操控目标主机
- 每个 Skill 对应一组 system prompt + 目标描述，由 AI API 驱动推理
- 前端通过 SSE/WebSocket 实时展示 Agent 执行进度
- 执行过程全程审计记录

---

## v2.0.0 (2026-04-15)

> 从「连接主机」升级到「沉淀、复用、审计、协作地操作主机」。

> 这是 1Shell 2.0 正式版，对应多页面运维工作台、脚本/Playbook、审计日志、探针仪表盘与 AI CLI 接入中心的首次完整发布。

### 新增功能

#### 2.0 正式版发布说明

- 发布 `1Shell 2.0.0` 正式版
- 版本定位从 WebSSH 控制台升级为多主机运维操作平台
- UI、后端路由、存储结构、Agent 接入链路同步进入 2.0 版本线
- AI CLI 接入策略以"隔离配置、不污染本地环境、适配 Linux VPS 部署"为原则落地

### 核心能力

#### 脚本库

- 脚本 CRUD：创建、编辑、删除、复制脚本
- 标签 + 分类：system / docker / network / backup / security / other 六大类
- 参数化模板：脚本支持 `{{param}}` 占位符，执行时动态填参
- 风险等级：safe / confirm / danger 三级，danger 级需二次确认
- AI 一键生成：自然语言描述需求，AI 生成完整脚本
- 执行历史：每次执行记录 stdout/stderr/退出码/耗时，可回溯

#### Playbook 多步骤编排

- 可视化步骤编排：拖拽排序、每步指定脚本和参数
- 主机可选：步骤不强制绑定主机，运行时可由调用方指定
- 终端注入执行：Playbook 渲染为完整脚本后注入终端，命令和输出全程可见

#### 主页脚本注入

- 终端工具栏增加「脚本」和「Playbook」按钮
- 选择已有脚本/Playbook → 填参 → 预览 → 注入当前终端执行
- 多行命令自动 heredoc 包装，确保 shell 整体执行

#### CLI 接入中心

- 支持 Claude Code / Codex / OpenCode 三款 AI CLI
- 一键 MCP 接入：自动检测本地 CLI、写入配置文件
- 多协议代理：Anthropic ↔ OpenAI 自动协议转换
- 多 Provider 管理：每个 CLI 可配置多个 API 渠道，一键切换活跃渠道
- 环境变量启动：生成一键启动命令，不污染本地配置

#### 审计日志

- 独立审计页面：分页查询、按操作类型/来源/主机/关键字筛选
- 全链路记录：Bridge API / MCP / SSH Session / 脚本执行 全覆盖
- SQLite 存储 + 文件降级：无 native binding 时自动降级为文件日志

#### 探针增强

- 独立探针页面：全屏探针仪表盘
- 带宽趋势图：SVG 折线图，最近 24 次采样，Rx/Tx 双线
- 关键进程摘要：展示目标机器上运行的关键服务及进程数

#### 文件浏览器优化

- 前端 LRU 缓存：60 秒内回退上级目录秒开
- SFTP 连接池健康检测优化：10 秒内用过的连接跳过 realpath 检测，省 1 RTT
- 绝对路径跳过 realpath：减少不必要的远程调用
- 本地 stat 并发化：`Promise.all` 替代串行 `for await`

### 架构变更

- **多页面架构**：主控台 / 脚本库 / 探针 / 审计 / CLI 接入 五大独立页面
- **多协议代理层**：`proxy.routes.js` 实现 Anthropic ↔ OpenAI 全双向转换
- **Playbook 引擎**：`playbook.service.js` + `playbook.repository.js`，支持多步骤顺序执行
- **ProxyConfigStore**：多 CLI × 多 Provider 的持久化配置，JSON 文件存储

### 数据库

- 新增 `scripts` 表：脚本库
- 新增 `script_runs` 表：脚本执行历史
- 新增 `playbooks` 表：Playbook 定义
- 新增 `playbook_runs` 表：Playbook 执行历史

---

## v1.1.0 (2025-06-01)

> 最后一个 1.x 稳定版，已打 tag `v1.1.0`

### 新增功能

- **文件浏览器 CRUD**：支持远程文件/目录的新建、重命名、删除、上传
- **终端全屏模式**：一键隐藏顶栏/侧栏/AI 面板，终端占满全屏，Esc 退出
- **侧栏折叠**：顶栏按钮一键折叠/展开左侧面板
- **探针主机切换**：顶栏探针信息跟随当前活跃主机实时切换
- **AI Agent 面板**：2:4:4 布局，支持多会话管理、Provider 选择、一键接入
- **AI 选区分析**：终端选区右键 AI 分析，带错误类型识别和修复建议
- **Ghost Text 补全**：终端内 AI 实时命令补全，Tab 采纳 / Esc 拒绝
- **AI 命令建议**：内嵌面板描述目标即可生成命令，支持复制和注入终端
- **暗色主题**：完整深色模式支持，localStorage 持久化
- **移动端适配**：响应式侧栏抽屉、AI 面板底部抽屉

### 基础设施

- Docker + docker-compose 容器化部署
- GitHub Actions CI（Node 18/20/22）
- AES-256-GCM 凭证加密、HttpOnly Cookie、防爆破、IP 黑白名单
- MCP Server + Bridge API 供外部 AI CLI 接入

### 技术栈

- 后端：Node.js + Express + Socket.IO + ssh2 + node-pty + better-sqlite3
- 前端：Vanilla JS + Tailwind CDN + xterm.js 5
- 零框架、零构建工具、单文件部署