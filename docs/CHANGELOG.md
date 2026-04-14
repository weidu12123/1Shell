# 1Shell Changelog

## v3.0.0（规划中）

### 方向：Skill 引擎 + 运维能力包

> 3.0 的核心命题：让 1Shell 从「连接工具」进化为「运维能力平台」。
> Skill = Playbook + MCP Tool，用户定义的每个 Skill 自动注册为 MCP 工具，
> AI Agent 可以直接调用结构化的高级操作，而不是每次手搓 shell 命令。

#### Phase 1 — Skill 引擎（基座）

- **Skill 定义格式**：在 Playbook 基础上扩展 `inputs`（参数 schema）和 `outputs`（返回值提取规则）
- **MCP 自动注册**：每个 Skill 自动生成一个 MCP tool，AI Agent 可结构化调用
- **终端可见执行**：Skill 执行时命令和输出注入终端，全程可观测
- **Skill 市场 UI**：浏览、安装、管理 Skill 包

#### Phase 2 — 内置 Skill 包

- **cert-manager**：ACME 证书申请 → 部署到 Nginx/Caddy → 自动续期调度
- **container**：docker ps/logs/stats、compose up/down、镜像管理
- 更多社区 Skill 扩展...

---

## v2.0.0 (2026-04-15)

> 从「连接主机」升级到「沉淀、复用、审计、协作地操作主机」。

> 这是 1Shell 2.0 正式版，对应多页面运维工作台、脚本/Playbook、审计日志、探针仪表盘与 AI CLI 接入中心的首次完整发布。

### 新增功能

#### 2.0 正式版发布说明

- 发布 `1Shell 2.0.0` 正式版
- 版本定位从 WebSSH 控制台升级为多主机运维操作平台
- UI、后端路由、存储结构、Agent 接入链路同步进入 2.0 版本线
- AI CLI 接入策略以“隔离配置、不污染本地环境、适配 Linux VPS 部署”为原则落地

### 核心能力

#### 脚本库

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
