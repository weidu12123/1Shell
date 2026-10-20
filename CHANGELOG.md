# Changelog

## 4.7.8 - 2026-10-20

> **项目演进通知**：`4.7.8` 是 1Shell 的收官维护版本。后续开发已全面转向基于 Rust + GPUI 原生架构重写的继任项目 **[VPS Switch](https://github.com/weidu12123/vps-switch)**（常驻内存直降 70%、原生桌面客户端 + Linux ~10MB 无头服务、终端与流式传输及探针全面重做）。

- 新增：设置「关于 / 详情」与主页加入继任项目 [VPS Switch](https://github.com/weidu12123/vps-switch) 跳转入口。
- 修复：切换终端标签或从 Agent 模式切回终端时，历史缓冲区重放触发 `xterm` 自动应答控制序列导致终端命令行冒出 `[?1;2c` 等乱码字符的问题。
- 修复：1Shell AI 用户消息进入上下文与落盘时被前置拼接主机目标头、JSON 敏感键名误脱敏及多行缩进被折叠导致原始输入结构破坏的问题。
- 修复：Linux 探针统计 `/proc/net/dev` 时未过滤容器与隧道虚拟网卡、且字节数顶格时 `awk` 列错位导致网速与流量虚高的问题。
- 修复：Debian 等系统的 `mawk` 在流量或磁盘读写超过 2GB 时发生 32 位整型溢出截断的问题。
- 修复：远端主机重装系统后，主机列表的 OS 发行版与内核信息缓存不随探针自动刷新的问题。
- 修复：SSH 探针将内部采样等待耗时计入连接延迟导致延迟显示偏高的问题。
- 修复：`1shell-probe-agent` 在服务端断连或 502 时高频轮询刷满远端 `journald` 日志的问题。

### Verification

- `npm test`（48 个脚本）
- `npm --prefix frontend run build`

## 4.7.7 - 2026-09-08

- 新增命令白名单/黑名单与命令试算（设置 → 安全）。
- docker 日常运维命令风险等级降为 medium，删除类保持 high。
- `ask_1shell_ai` 的 answer/plan 模式支持只读命令探查。
- 新增 AI 审批（默认关闭），外部 MCP 的待审批命令交 1Shell AI 评估。
- MCP 板块新增「1Shell AI」设置页。
- 修复：桌面版后端 PATH 被破坏，第三方 agent 误报未安装、本机命令执行报错。
- 修复：agent 二进制检测在 PATH 异常时误报未安装。
- 修复：1Shell AI 在默认输出 thinking 块的推理模型上多轮工具循环失败。
- 修复：长会话服务器内存无限积压。
- 修复：MCP 板块 1Shell AI 设置的数字输入框保存崩溃。
- 终端界面前端优化。

### Verification

- `npm test`（48 个脚本）
- `npm --prefix frontend run build`

## 4.7.6 - 2026-08-10

脚本库彻底重构：回归"存脚本 + 在终端里用"，并把它接成 1Shell AI 能读能写能跑的东西。

- 脚本库重做，只剩四个字段（名称 / 描述 / 标签 / 正文）。删掉固定分类、风险等级、emoji 图标、运行次数；分类改由自由标签承担，页面从三栏压成两栏，搜索按名称/描述/标签走。正文编辑器从裸 `<textarea>` 换成 CodeMirror + shell 高亮（复用既有 `languageExtensionForFile`，无新增依赖）。
- 参数机制从"结构化定义"改为"自动识别"：不再有参数表格，正文里写 `{{变量名}}` 即为参数，注入时按识别到的占位符生成输入框。此前 UI 上选 `select` 类型必定保存失败（后端要求 options 非空，前端根本没有编辑 options 的地方）、`secret` 脱敏开关无处可开——这两条断链随参数表格一并消失。占位符正则收敛为 `lib/script-placeholders.js` 单一实现，前后端同源。
- Web 端不再执行脚本：执行入口、批量执行（`/run`、`/run-batch`）、执行历史（`script_runs` 表、`/api/script-runs*`、历史面板）整体退役，migration v19 DROP 表并重建 `scripts`。服务端执行只保留给 agent。渲染接口 `/scripts/:id/render` 留在服务端——shell 转义是唯一的防注入手段，不能挪到前端。
- 1Shell AI 现在能读写脚本库：新增 `get_script`（读全文 + 占位符名单）与 `save_script`（新建/覆盖，与 HTTP 层共用校验器），连同既有 `list_scripts` / `run_script` 构成读-写-执行闭环。`save_script` 接入审批链路，审批卡直接贴脚本正文（不贴就会落到 JSON fallback，审的人看不清要入库的是什么）。写工具不对外部 MCP 客户端暴露。
- 修复：`list_scripts` 此前对内部 agent **完全不可用**——三档 capability 的 `allowedTools` 都没登记它，`guard.check` 第一步就拦死。同一个洞下顺带把 `get_script` / `save_script` 一并登记。
- 修复：脚本执行绕过命令风险规则。harness guard 的灾难命令拦截只覆盖 `execute_command` / `host_exec`（它们的 input 里有 command），`run_script` 传进去的只有 `scriptId`，规则库看不到正文；旧的 `riskLevel` 兜底在默认档 `safe` 时直接 return，等于没兜。现在渲染后的成品命令在 service 里过一次 `assessCommandRisk`。
- 修复：终端注入固定发 `bash << EOF`，Windows/PowerShell 会话必坏（而渲染侧是按 hostId 选 PowerShell 转义风格的，两边规则互相矛盾）。现在按服务端返回的 `shellStyle` 决定包装方式，行尾统一为 PTY 要的 `\r`。
- 修复：agent 漏传脚本参数会静默渲染成空值。现在缺键直接 400 并列出缺哪些（空串是合法值，不算缺）。
- 移除 AI 生成脚本弹窗与 `/api/scripts/ai-generate`：提示词产出的 `icon`/`category`/`riskLevel`/`parameters` 在新模型下已全部不存在，且能力被 `save_script` 完全覆盖且更强（可对话迭代）。
- 清理：`ide.tools.js` 里被 core 委派永久遮蔽的 `list_scripts` / `run_script` 影子副本（schema + handler）删除；时间线补上四个脚本工具的中文名（此前 `list_scripts` 会显示成"列出目录"），顺带清掉 4.7.5 漏删的 AI 任务工具标签；`HostInfo` 从脚本模块归位到 `utils/mainConsole`。
- 页面上三个装饰性控件（导入/导出、"+ 新标签"、排序）与 BETA 徽章一并移除。
- Windows 主机进入原生 SSH 托管链路：补齐 PowerShell/cmd shell 识别、远程命令执行、主机探针、风险规则、服务面板工作负载识别与审计数据，并增加 Windows 实机探测脚本和回归测试。
- 文件上传改为 Busboy 流式处理，避免大文件完整进入内存；MCP 文件传输补齐分片上传、后台任务、进度与校验能力。
- Provider 的 `apiBase` 改为严格使用用户填写的版本路径，不再自动追加 `/v1`，兼容非 OpenAI 路径结构的中转与原生接口。

### Verification

- `npm test`（44 个脚本；覆盖脚本库、Windows 原生 SSH/探针/风险规则、流式上传与既有回归守卫）
- `npm --prefix frontend run build`

## 4.7.5 - 2026-07-26

桌面版回归 + 终端区减负 + 会话列表随主机删除联动清理 + AI 任务板块退役。

- 桌面版本机免登录：Electron 启动时生成一次性凭据注入自带后端，窗口打开前主进程静默换取本机会话，桌面窗口不再出现登录页；会话过期后登录页自动重签自愈。仅对本机桌面窗口生效——浏览器/局域网访问照常要求登录，凭据只存在于主进程与后端进程环境，渲染层不可见，非环回请求一律拒绝（不信任代理头）。设置 → 桌面版新增「本机免登录」开关（默认开启，与既有「开机自启」「关闭窗口后后台运行」并列）。
- 桌面版外观：隐藏 Windows/Linux 的 File/Edit/View 默认菜单栏（macOS 保留系统菜单以支持编辑快捷键）；新增品牌图标（渐变「1_」终端光标风，512px 源 + 多尺寸 ico），窗口/托盘/任务栏与打包产物（exe/dmg/AppImage）统一生效，浏览器 favicon.ico 一并升级（此前仅 16px 单尺寸）。

- 移除 AI 任务板块（多轮重做后仍然鸡肋，正式下线）：配置页「AI 任务」tab、Agent 页 `/task` 创作模式与「任务模式」徽标、后端 `ai_tasks`/`ai_task_runs`/`ai_task_authoring_evidence` 三张表（migration v18 DROP）、`/api/ai-tasks*` 路由、4 个任务创作工具与 `task_authoring` 能力、task/task_run 会话语义与失败修复授权整体删除。`/config/features` 现直达脚本库；`/scripts` 旧链接照常重定向。1Shell AI 本体（对话、目标、审批、技能、脚本库）不受影响。

- 移除终端工具条中列的主机简况探针（主机名/CPU/内存/负载/硬盘）：多开会话 tab 时探针与 tab 相互挤占遮挡；tabs 现在拿满左侧整行宽度。随之退役 `useTopbarProbe`（8s 轮询 `/api/health/stats` 不再发起），终端模式 composer 的主机徽标改读主机列表。监控页探针不受影响。
- 移除 AI 行内补全（补全建议条 + ghost 浮层）：补全占位条随打字出现/消失会把终端区上下顶动。前端 `SuggestionBox` / `GhostOverlay` / `useTerminalAi` 与后端 `/api/ai/terminal/complete-inline` 路由、服务、校验器整体退役；选区分析所需的"最近提交命令"上下文保留为轻量输入镜像 `useTerminalCommandHistory`。「AI 命令」面板与选区分析不受影响。
- 删除主机时级联清理其 Agent 对话：仅绑定该主机的 oneshell 会话连记录一起删除；多主机工作区会话只把该主机剔出绑定（消息原样保留）；协议 agent 会话跑在本机，只解绑不删除。服务端启动时补一次孤儿清扫，历史遗留的「主机已删除」残留分组随之消失；删除确认弹窗明示对话会一并删除。

### Verification

- `npm test`（39 个脚本全绿；新增 `test-ide-session-host-prune` 与 `test-desktop-session-login`，`test-task-authoring-capability` 的通用断言迁入新 `test-ide-approval-policy`；守卫测试固化本次全部删除项）
- `npm --prefix frontend run build`
- desktop-session 接口 curl 冒烟（错 token 401 / 对 token 200+cookie / cookie 可访问受保护 API）

## 4.7.4 - 2026-07-11

4.7.4 打通 Agent 板块附件上传全链路，并新增 1Shell AI 配置文件生成器。

- Agent 附件上传：图片/文档/通用文件先落盘到工作目录再交由 agent 自带的读取工具查看（协议 agent 走 `cwd/.1shell-attachments/`，1Shell AI 走 `data/agent-attachments/`），对话中以缩略图/文件卡回显，点击图片全屏灯箱放大；单文件上限提至 12MB，附件总量护栏 12MB。
- 1Shell AI 配置文件生成器（`1shell-ai.json`）：接入配置回归"配置文件"语义，表单/启用自动生成、保存草稿即手工接管立即生效、恢复自动按活跃 provider 重写；运行时按 文件 → skills 槽位 → claude-code 回退解析。
- skills 请求参数自填：1Shell AI 放弃语义化 reasoning 档位翻译，改由用户按上游 API 文档自填原始 JSON 参数（thinking / reasoning_effort / temperature 等），代理请求时原样合并进请求体。
- 修复：1Shell AI 流式文案在工具卡后重复显示——已 stream 的原文不再二次定稿 `ide:text`，前端仅定稿仍打开的气泡，不在工具卡后再代说一遍。
- 修复：ProviderModal 非 Claude Code 入口恢复主模型输入框；配置文件缺 apiKey 时回退有效 provider 而非报错；附件落盘目录名防穿越；配置文件原子写与崩溃自愈；`/ide` 旧路径重定向保留查询参数。
- 其他：暗色模式 scoped 选择器去掉多余 `:global`；release 支持 `ONESHELL_REPACK_ONLY=windows|linux` 分平台打包。

### Verification

- `npm --prefix frontend run build`
- Windows repack on local + Linux repack on build VPS
- secret/path scan before release

## 4.7.3 - 2026-07-10

4.7.3 重构主页与全局导航：主页回归品牌门面，顶栏改为左侧悬停展开导航栏。

- 全新主页：上半屏品牌 Hero（渐变字标 + 座右铭 + 主机概览 KPI 药丸 + 连接最近主机/快捷入口按钮组），下半屏左侧为最近主机与异常主机卡片，右下角为全球部署真实地图。
- 真实地图（Leaflet + CARTO 彩色底图）：主机按定位落点，脉冲标记区分在线/离线/未探测，点击弹出主机气泡可直接连接或手动定位；未定位主机可在列表中逐台补充位置。
- 新增地图瓦片同源代理 `/api/map/tiles`：浏览器不直连第三方瓦片服务（CSP 无需放行外域），服务端按 Voyager → Positron → OSM 逐级降级，仅彩色主源落盘缓存 30 天，过期先返回旧图再后台刷新；启动时自动预热全球低缩放瓦片，配合 keepAlive 连接复用与重试，弱网环境下地图不再整屏灰底。
- 全局导航改为左侧栏：60px 图标栏悬停延迟展开（悬浮覆盖、不挤压内容），主题切换/系统设置/GitHub 入口移至栏底，为所有页面释放原顶栏高度。
- 背景动画减负：移除浅色模式花瓣动画，流星数量精简。
- 清理旧主页实现（WorldHomeView 及其矢量地图/HUD 组件）与 d3-geo 依赖。

### Verification

- `npm test`（34 个脚本全绿）
- `npm --prefix frontend run build`
- unpushed commits secret/path/IP scan before release

## 4.7.2 - 2026-07-09

4.7.2 将终端页并入 Agent 页：一个页面同时承载 AI 对话与终端操作，并清理全部被取代的旧实现。

- Agent 页新增可折叠终端分栏：header「终端」按钮开合，分隔条可拖宽（25–70%），支持全屏；终端惰性启动——不打开终端不再启动本机 PTY；开合状态与宽度本地持久化。
- 主机管理并入 Agent 页左栏：新增「主机」标签页承载主机的添加/编辑/删除与连接，会话列表按主机分组展示（无主机归属的会话进「全局」分组）；`?host=` 链接直达＝选中主机并打开终端。
- 终端与聊天复用同一条 socket 连接（此前终端页会单独再开一条）。
- 路由收敛：/terminal、/console、/ide 全部重定向到 /agent（查询参数保留），主导航精简为 4 项。
- 移除被协议 agent 取代的 agent:* PTY 通道（agent-pty 服务、socket 处理器、providers 目录）与旧版页面/面板（终端页、IDE 页、旧 AI 聊天面板等），连同孤儿组件与无用依赖一并清理，净删约 6200 行。

### Verification

- `npm test`（34 个脚本；守卫测试固化全部删除项，防止误恢复）
- `npm --prefix frontend run build`
- staged source secret/path scan before release

## 4.7.1 - 2026-07-08

4.7.1 实现 1Shell AI 与第三方 agent（Claude Code / Codex）在同一会话内的无缝互切，并简化第三方 agent 的权限接入方式。

- 会话内随时切换 agent：composer 的 agent 选择器对所有会话可见（含 1Shell AI 选项），切换即生效——切到第三方 agent 时自动补写会话日志并注入交接提示，agent 自行补读上下文；切回 1Shell AI 时后端交还会话（结束 CLI 进程、翻转会话归属），完整历史自动延续，无需新建对话。
- 会话归属改为可变状态：消息按其携带的 agentId 双向分流；各 agent 的原生会话绑定（`--resume` / `thread/resume`）在切换间保留，切回原 agent 可继续其原生上下文；回合运行中拒绝切换并提示先停止。
- 第三方 agent 时期的历史回传 1Shell AI 模型前做只读投影（外来工具调用块转文本、剥离附加字段），时间线与文件面板显示不受影响；两侧持久化互不覆盖对方字段（主机绑定、工作目录等）。
- 第三方 agent 改为仅以完全访问权限接入：移除「每次询问」审批模式（真实环境下审批链路会拒绝 agent 的 MCP 工具调用导致任务中断）；权限请求由服务端自动放行。
- 切换到第三方 agent 不再要求填写工作目录（1Shell 以 VPS 为维度，本地目录自动使用用户主目录）；目标 VPS 提示不再把本机（local）当作目标注入，且缺少 1Shell MCP 工具时不再中断当前回合。

### Verification

- `npm test`（34 个脚本，含新增 `test-agent-switch-routing.js` 路由编排 / 消息投影套件与协议服务交还-领养往返用例）
- `npm --prefix frontend run build`
- 真实 claude / codex CLI 冒烟（`scripts/test-agent-switch-real.js`：1Shell AI 历史 → claude 领养补课 → 交还 → codex 领养，上下文全程保留）
- staged source secret/path scan before release

## 4.7.0 - 2026-07-05

4.7.0 让第三方 agent（Claude Code / Codex）以结构化协议方式进入 Agent 板块，与 1Shell AI 共用同一套时间线，并为 Agent 板块加上 IDE 式文件面板。

- 新增协议接入层（`src/agents/protocol/`）：支持 ACP（JSON-RPC over ndjson）、Claude Code stream-json、Codex app-server 三种协议，第三方 agent 的输出统一翻译为 1Shell 的 `ide:event` 事件流，前端时间线零改动复用。
- 会话持久化新增 `agent_id / cwd / native_session_id`，服务重启后可通过 `claude --resume` / codex `thread/resume` 继续对话；Windows 下 `.cmd/.bat` shim 启动与进程树清理已适配。
- 新建会话可选择 agent（1Shell AI / Claude Code / Codex，未安装置灰）与工作目录；协议会话在侧栏按工作目录分组，文件浏览器支持「在此目录新建会话」。
- 审批卡支持 ACP 多选项权限请求（允许一次 / 总是允许 / 拒绝），超时自动拒绝。
- IDE 式文件面板：工具卡展示涉及的文件，点击在右栏打开（CodeMirror 6，代码高亮 / Markdown 预览 / 图片预览 / 可编辑保存）；会话头部聚合本次会话触碰的全部文件；文件面板可反查触碰过该文件的其他会话；Claude 的 Edit/MultiEdit 工具卡内联渲染 diff。
- 模型接入页自动导入本机已有的原生 CLI 配置（Claude Code / Codex / OpenCode）为配置方案，带「本机配置」徽标；由 1Shell「启用」写入的配置会被识别并跳过，避免镜像循环。

### Verification

- `npm test`（33 个脚本，含新增 ACP / codex app-server mock 套件）
- `npm --prefix frontend run build`
- 真实 claude / codex CLI 冒烟（工具调用闭合 + 会话恢复上下文保留）

## 4.6.10 - 2026-07-02

4.6.10 修复模型接入页在 4.6.8/4.6.9 中被隐藏的原生配置文件生成器，并修复添加配置方案时误进入已有方案编辑的问题。

- 恢复 Claude Code / Codex / OpenCode 的原生配置文件生成器，可继续查看、预览和编辑 `settings.json`、`config.toml`、`opencode.jsonc` 等生成内容。
- 修复点击“添加接入 / 添加配置方案”时自动跳转到已存在配置方案编辑态的问题；现在只有明确点击“编辑”才进入已有方案。
- 增加前端回归守卫，防止配置生成器再次被静态关闭，或添加模式再次被当前 provider 劫持。

### Verification

- `npm test`
- `npm --prefix frontend run build`

## 4.6.9 - 2026-07-02

4.6.9 修复 4.6.8 离线更新包漏带新增运行依赖，导致部分从旧版本升级的服务启动失败并出现 502 的问题。

- 修复 repack 复用旧离线包 `node_modules` 时没有同步新增生产依赖的问题，确保 `toml` 这类新增运行依赖会进入 Linux / Windows 更新包。
- repack 现在会在打包前校验所有生产依赖是否实际存在；缺失的可移植 JS 依赖会从当前构建环境复制，native / 平台相关依赖缺失时直接失败，避免发布不可启动的包。
- 保留 4.6.8 已加入的运行态目录清理逻辑，发布包仍不会携带本机 `.env`、`.mindfs`、导入 Skill 或主机配置状态。

### Verification

- `npm test`
- `node scripts/repack-release-assets.js`
- release asset dependency/content scan
- staged source secret/path scan before release

## 4.6.8 - 2026-07-01

4.6.8 将“扩展”重构为主机级 MCP / Skill 能力矩阵，并移除旧版内置 1Shell Skill 与 Claude Code Skill 托管残留。

- 扩展页重建为 MCP / Skill 双矩阵，按 agent 图标列管理 `1Shell AI`、Claude Code、Codex、OpenCode 的能力暴露状态。
- 新增主机能力扫描服务，识别本机 Claude Code / Codex / OpenCode MCP 配置与外部导入 Skill，并区分 `managed`、`installed`、`external`、`preset`、`oneshell` 来源。
- 新增 Skill AI 导入入口，粘贴 GitHub 仓库链接后临时拉取源码、扫描 `SKILL.md`，再由 AI 适配为 1Shell 原生 Skill。
- `1Shell AI` 现在使用同一套 Skill/MCP 管理矩阵，不再走旧的内部隐藏 Skill 注入路径。
- 删除旧 `oneshell-task-authoring` 内置 Skill、旧卡片式扩展组件、旧 `/api/skills/import` 与 `/api/claude-code-skills/*` 托管接口。
- 移除旧 Claude Code Skill 同步 hook，外部 agent 能力暴露统一回到主机能力矩阵的后续 adapter 路线。
- `.gitignore` 收紧本机运行态目录、原生 CLI 配置备份、导入 Skill 数据和 MindFS 会话数据，避免发布包或源码提交携带私人状态。

### Verification

- `npm --prefix frontend run build`
- `npm test`
- `node scripts/test-host-capability-service.js`
- staged source secret/path scan before release

## 4.6.7 - 2026-06-30

4.6.7 集中修复终端与 1Shell AI 输出保真问题，重点让模型看到完整工具信息，并让流式显示过程与最终回答保持一致。

- 修复终端输出刷屏和 ANSI/回车进度类输出导致的前端日志抖动问题。
- 修复 1Shell AI 面板在长输出后横向撑开、输入区不可见的问题。
- 工具结果传给模型前不再做前端式压缩或摘要，`read_remote_file`、`execute_command` 等结果按原文进入模型上下文。
- 移除前端对 assistant 文本的结构化改写，工具卡片只负责展示结果，不再替 AI 生成固定总结。
- 修复 assistant Markdown/inline code 在流式阶段暴露反引号、单引号和半解析标记的问题，最终渲染保留文本保真。
- 流式文本事件携带当前累计全文，前端优先用权威快照替换当前内容，避免中途出现重复汉字、重复冒号或“先错后修”的显示过程。
- 远程命令执行优先通过 `bash -lc` 包装，避免 `/bin/sh` 不支持 `set -o pipefail` 导致工具误失败。
- 在线更新完成后会等待服务重启并自动整页刷新，避免浏览器继续运行更新前已经加载的旧前端代码。

### Verification

- `node scripts/test-ide-text-fidelity.js`
- `node scripts/test-ide-exact-text-handling.js`
- `node scripts/test-markdown-inline-code-safety.js`
- `node scripts/test-bridge-command-shell.js`
- `node scripts/test-structured-tool-results.js`
- `node scripts/test-updater-client-reload-guard.js`
- `npm --prefix frontend run typecheck`
- `npm --prefix frontend run build`

## 4.6.6 - 2026-06-29

4.6.6 继续清理旧版 AI Chat 残留，并调整主控台布局，避免右侧栏默认挤压终端空间。

- 彻底删除旧版 AI Chat 前端入口和旧聊天 composable，主控台右栏只保留 `1Shell AI` 与 `AI Agent`。
- 删除设置页里只服务旧 AI Chat 的 AI 配置入口，模型/API 配置继续使用新的 Provider/渠道配置体系。
- 后端继续移除旧 `/api/chat`、旧 chat upstream、旧 chat validator，以及旧 AI 配置字段透传。
- 主控台右侧栏默认收起，并对旧布局偏好做版本迁移，避免浏览器缓存让右栏继续默认打开。
- 左右侧栏折叠按钮移动到“本机 / 新终端”这一行，分别显示 `左栏` 与 `AI栏`，不再挤在终端状态栏右上角。
- AI Agent 页面在运行结束后会重新加载后端投影时间线，恢复自动修复后的最终报告展示。
- 增加旧 AI Chat 删除守卫测试，防止旧入口、旧范围选择和旧后端接口再次被带回。

### Verification

- `npm test`
- `npm --prefix frontend run build`
- `node scripts/repack-release-assets.js`

### Release assets

- Windows x64 updater package: `release/repacked/1shell-4.6.6-windows-x64.zip`
- Linux x64 updater package: `release/repacked/1shell-4.6.6-linux-x64.tar.gz`

## 4.6.5 - 2026-06-28

4.6.5 清理旧版 AI Chat 的直连聊天链路，避免它继续和新的 1Shell AI / AI Agent 入口混在一起。

- 移除旧后端 `POST /api/chat`、`createChatUpstream()` 以及只服务该旧接口的 chat validator。
- 旧 AI Chat 面板保留为暂存壳，但不再向后端发起聊天请求，也不再保留旧 system prompt、流式 SSE 状态或 VPS 范围注入。
- 移除 AI Chat 面板和终端工具栏里的 VPS/范围选择控件，避免旧 AI Chat 再次伪装成 1Shell AI 工作区选择入口。
- 保留 `1Shell AI`、`AI Agent`、终端补全、模型列表、选区分析、脚本生成和 Skill 适配能力。
- 增加 `test-ai-chat-retired-route-guard` 回归测试，防止旧 `/api/chat` 链路和 AI Chat 范围选择残留再次被带回。

### Verification

- `node scripts/test-ai-chat-retired-route-guard.js`
- `npm --prefix frontend run build`
- `npm test`
- `node scripts/repack-release-assets.js`

### Release assets

- Windows x64 updater package: `release/repacked/1shell-4.6.5-windows-x64.zip`
  - SHA256: `7d7f72b6e6e215ff721bfebbba487baa8f03261fd4d2660336d47fcaea864da1`
- Linux x64 updater package: `release/repacked/1shell-4.6.5-linux-x64.tar.gz`
  - SHA256: `8b50dcc3d44fcb8ceb5e8b66e2d808743f9f75002ca92a38312e4cda7ce211ce`

## 4.6.4 - 2026-06-28

4.6.4 修复 4.6.3 发布包可能携带旧前端构建产物的问题，并收紧 1Shell AI 代理结果结构化重写边界。

- `scripts/repack-release-assets.js` 在重新打包 Windows/Linux updater 包前强制执行 `npm --prefix frontend run build`，并写入 `frontend/dist/.1shell-build.json` 构建标记。
- 在线更新在替换目录前校验 release 包里的 `frontend/dist/index.html` 与 `.1shell-build.json`，前端构建版本与包版本不一致时拒绝更新，避免 VPS 安装到“版本号变了、前端没变”的坏包。
- 便携启动脚本会检测前端 bundle 是否缺失或版本过期，过期时自动重建。
- `start.bat` 的横幅版本改为读取 `package.json`，不再停留在旧硬编码版本。
- 修复 GOST/SOCKS5/HTTP 代理结构化摘要跨用户轮次误用旧 tool result 的问题，普通 VPS 探查报告里的 HTTP 服务 URL 不再被替换成 GOST 代理摘要。

### Verification

- `node scripts/test-structured-tool-results.js`
- `node scripts/test-release-repack-frontend-build.js`
- `node scripts/test-updater-frontend-bundle-guard.js`
- `node scripts/test-start-bat-version.js`
- `npm --prefix frontend run build`
- `npm test`
- `node scripts/repack-release-assets.js`

### Release assets

- Windows x64 updater package: `release/repacked/1shell-4.6.4-windows-x64.zip`
- Linux x64 updater package: `release/repacked/1shell-4.6.4-linux-x64.tar.gz`

## 4.6.3 - 2026-06-27

4.6.3 修复 1Shell AI 面板在真实运维对话中的文本保真、代理信息展示和文件预览边界问题。

- 修复 AI 工具调用前后的文字丢失/隐藏问题，历史回放与实时流式输出保持同一条文本链路。
- 修复代理搭建结果的结构化展示，避免把 `verification passed` 误解析成 `密码 ed`，并在有账号密码时生成带认证信息的 `curl -x` 示例。
- 提高 `read_remote_file`/本机读文件的默认与最低有效预览上限到 2MB，保留 8MB 硬上限；错误提示改为 KB/MB 自适应，避免 `0.0MB`。
- 补充文本保真、代理流、代理 summary 和文件预览上限回归测试。

### Verification

- `node scripts/test-structured-tool-results.js`
- `node scripts/test-file-service.js`
- `npm --prefix frontend run typecheck`
- `npm --prefix frontend run build`
- `node --check src/services/file.service.js`
- `node --check src/tools/oneshell-core.tools.js`
- `node scripts/repack-release-assets.js`

### Release assets

- Windows x64 updater package: `release/repacked/1shell-4.6.3-windows-x64.zip`
  - SHA256: `a4f6c5cdd77751156776af383cc57040f28832d44e940efaf8e466d3e05aeb2c`
- Linux x64 updater package: `release/repacked/1shell-4.6.3-linux-x64.tar.gz`
  - SHA256: `b9bae13c1a345bec773932bc0934e052fa06f4b04c03564332037fa7677717b9`

## 4.6.2 - 2026-06-26

4.6.2 修复“运行”页面在长期运行的 VPS 上反复进入时重复采集所有主机的问题。

- 后端为每台主机保留运行项快照；普通进入页面优先返回缓存，不再重复 SSH/本机采集。
- “刷新全部”“刷新当前主机”和操作后的状态回读会带 `refresh=1`，明确触发真实重新采集并更新缓存。
- `KeepAlive` 继续保留页面状态；后端缓存负责跨页面重建、浏览器刷新和多客户端访问时的秒开体验。
- 增加运行项缓存测试，覆盖单主机和汇总入口。

### Verification

- `node scripts/test-panel-workloads.js`
- `npm --prefix frontend run typecheck`
- `node -c src/services/panel-workloads.service.js`
- `node -c src/routes/panel-workloads.routes.js`

## 4.6.1 - 2026-06-26

4.6.1 修复 4.6.0 发布包中“运行”页面代码已包含但前端入口未注册的问题。

- 将 `WorkloadsView` 正式挂载到 `/panel/workloads`，并补上 `/workloads` 兼容重定向。
- 在 Panel 侧边栏加入“运行”入口，更新 1Shell AI 浮窗的页面上下文。
- 增加 route/nav 注册测试，避免以后再次出现页面文件存在但入口不可见的发布事故。

### Verification

- `npm test`
- `npm --prefix frontend run typecheck`
- `npm --prefix frontend run build`

## 4.6.0 - 2026-06-26

4.6.0 继续补齐 Panel 的确定性运维能力，同时修正 1Shell AI 在精确文本、停止/抢占和托管审批上的边界。

- 运行项面板改为按主机渐进加载，离线主机不再拖住全局首屏；支持刷新全部、刷新当前主机和从主机列表单独刷新。
- 运行项面板新增文本式“操作”展开区，支持 Docker / Compose 容器启动、停止、重启、删除，Compose 容器支持安全重建；systemd / Windows Service 保持启停重启边界。
- 优化端口发现链路：Linux 端口扫描改为一次 `ss` 采集后按唯一 PID 补元数据，连续端口会压缩展示为端口段，降低 zouter/haproxy 等大量监听端口场景的超时和噪声。
- Docker 容器端口补齐 ExposedPorts fallback，并合并 cgroup 归属端口，减少容器与宿主进程重复显示。
- 1Shell AI 文本附件不再按旧 80k 预览截断，800KB 内以原文完整进入模型；需要逐字输出时使用 exact attachment handle，由 1Shell 在服务端按 sha256 校验后展开。
- exact handle 展开后的审计/trace 摘要只记录 handle、文件名、bytes 和 sha256，不保存展开全文；用户消息 trace 摘要同步脱敏。
- 新用户消息会抢占并取消仍在运行的旧 run，避免用户停止/追问后系统继续优先执行旧操作。
- 托管模式不再自动放行 guard 标记为需要审批的副作用操作；Docker/Compose 变更、运行态密钥/配置/数据库文件变更纳入高风险规则。

### Verification

- `npm test`
- `npm --prefix frontend run typecheck`
- `npm --prefix frontend run build`
- `node -c src/ide/ide.service.js`
- `node -c src/services/panel-workloads.service.js`

## 4.5.0 - 2026-06-23

4.5.0 把 1Shell 的 Panel 方向从“多 VPS 连接 + AI/CLI 宿主”推进到“多 VPS 服务器面板中枢”。这一版完成了 Panel 与配置的拆分：配置能力独立为“配置”板块，Panel 回到详情、主机、文件、探针、审计等服务器面板主线；同时保持 AI 在旁路，面板的发现、查看、操作、反馈和错误返回都走确定性流程，AI 只作为解释入口，不参与主流程。

- 将配置能力从 Panel 中拆出为独立“配置”板块，并按 AI、扩展、程序、MCP 重新组织入口，让 Panel 专注服务器面板能力。
- 将 Panel 导航调整为详情、主机、文件、探针、审计；详情页改为更接近服务器概览的布局，增加图形化健康与资源展示，并让本机在选择器中优先出现。
- 重做文件浏览器：VPS 选择移动到顶部工具栏，文件区改为表格化浏览，补足路径、排序、创建、上传、下载、重命名、删除等面板式操作。
- 优化远程文件浏览体验：加入目录缓存、stale-while-revalidate、顶部加载进度线和路径缓存别名，降低跨区域 VPS 浏览时的“点击后卡住”感。
- 新增文件压缩与解压能力：文件/目录可生成压缩包，常见归档文件可解压到同目录新文件夹，目标冲突时拒绝覆盖或使用 `.extracted` 目录。
- 调整密钥与审计边界：用户可以选择直接把密钥交给 AI 处理；审计不记录密钥明文，密码工具保留为可选能力但不强制替代用户意愿。
- 改善长内容与审批/工具结果显示，补充复制入口，并修复部分亮色/暗色主题下文本不可读的问题。

### Verification

- `npm --prefix frontend run build`
- `node --check src/services/file.service.js`
- `node --check src/routes/file.routes.js`
- Local archive/extract smoke test on Windows
- `node scripts/repack-release-assets.js`

### Release assets

- Windows x64 updater package: `release/repacked/1shell-4.5.0-windows-x64.zip`
  - SHA256: `7a7e93d333424220aca6bc8850ffd4f53a9f7ac9ab75ca9e4bfe2fdd60be834d`
- Linux x64 updater package: `release/repacked/1shell-4.5.0-linux-x64.tar.gz`
  - SHA256: `feb1d570d85948f42fa9d21a30ecf1dad9bd368654d418a5039e551741031fb3`

### Next

4.5 之后进入“补能力”阶段：先补资源发现和只读状态，再补确定、可审计、能返回清晰错误的操作，最后补跨 VPS 汇总、筛选、对比和批量定位问题的中枢能力。后续范围见 [Panel 补全计划](docs/oneshell-panel-completion-plan.md)。

## 4.3.0 - 2026-06-22

4.3.0 把第三方 AI CLI 从一个松散的配置入口，收敛成由 1Shell 托管的本地运行环境。Claude Code、Codex、OpenCode 仍然保持各自官方 Agent 的存在形式；1Shell 负责统一配置、网关转发、MCP 注入、CLI 运行目录隔离，以及 1Shell AI 的 VPS 工作区边界。

- API/模型配置改为按渠道独立管理，支持 1Shell AI、Claude Code、Codex、OpenCode 分别配置。
- 新增模型配置项：模型映射、思考程度、上下文长度、最大输出、测试、复制。
- Claude Code 网关按已配置模型暴露 `/v1/models`，`/model` 可以切换到用户映射的模型。
- Codex/OpenCode 保持在配置托管和 1Shell MCP 注入层面，不把它们伪装成通用模型网关。
- 第三方 CLI 支持由 1Shell 注入 MCP 与运行配置，避免每台 VPS 都单独安装和维护 CLI。
- 1Shell AI 新增 VPS 工作区选择，新建对话时可以选择全局、单台 VPS 或多台 VPS。
- 左侧历史记录按工作区分组，支持对话复制、重命名、删除，并保留消息、模型标签和主机范围。
- 优化 Agent/AI 配置界面，弱化多余渠道列表，增强右侧操作按钮与配置细节展示。

### Verification

- `npm test`
- `npm --prefix frontend run build`
- `node scripts/repack-release-assets.js`
- 基于已验证的 4.2.0 offline release baseline 重新打包 Windows 与 Linux 更新包。

### Release assets

- Windows x64 updater package: `release/repacked/1shell-4.3.0-windows-x64.zip`
  - SHA256: `5c834a55ce7c25915eb13a5185f2bc33ccd6f25eb986498ec84252624b5e46d0`
- Linux x64 updater package: `release/repacked/1shell-4.3.0-linux-x64.tar.gz`
  - SHA256: `575f198aa9b2bb4eed3bcf4b59a72c2d0863897c6b52f09bf9265a55ee7b7eb8`

## 4.2.4 - 2026-06-19

4.2.4 focuses on frontend correctness and release polish for the 4.2 patch line. It keeps the fixes in UI, rendering, and runtime plumbing rather than adding more prompt rules.

- Wire real `/model` slash-command behavior into the main console 1Shell AI panel, standalone IDE/Panel page, and global floating 1Shell AI entry.
- Add a shared model-provider loader and model slash menu so provider activation uses the same backend API across 1Shell AI surfaces.
- Limit the floating 1Shell AI slash menu to commands it can actually execute: `/model`, `/mode`, `/compact`, `/remind`, and `/clear`.
- Add safe Markdown table rendering for 1Shell AI timeline text: malformed pipe tables now fall back to literal code blocks instead of being rendered as misleading broken tables.
- Preserve natural assistant text while continuing to filter duplicate tool-boundary fragments and repeated work-note noise.
- Improve Agent sidebar/mobile behavior, terminal resize refresh, and About/version display consistency.
- Broaden the Node engine metadata for the 4.2 package line and keep the SQLite fallback path for newer local Node runtimes.

### Release assets

- Windows x64 updater package: `release/repacked/1shell-4.2.4-windows-x64.zip`
  - SHA256: `f74a612f40add952cf871585c702495625b99833e1a91ac7443a2f2a23b7aced`
- Linux x64 updater package: `release/repacked/1shell-4.2.4-linux-x64.tar.gz`
  - SHA256: `07544245d9aec1fef5ab42b7e023622edfa7c967f2f7056b08b67a146e186a76`

### Verification

- `npm test`
- `npm --prefix frontend run build`
- Repacked Windows and Linux updater assets from the verified 4.2.0 offline release baseline.
- Windows clean extract smoke test with bundled Node `v20.18.3`; `/api/health` returned `status:"ok"` and `usingFallbackSecret:false`.
- Linux/example-hk original offline release script build completed with bundled Node `v20.18.3`, native module checks, frontend build, agent build, SHA256 verification, and `/api/health` returning `status:"ok"` and `usingFallbackSecret:false`.

## 4.2.3 - 2026-06-19

4.2.3 focuses on making 1Shell AI less blind during long-running command failures. It does not add more prompt rules; instead it passes execution facts from the tool layer back to the model so the agent can reason from complete context.

- Add structured `outputDiagnostics` to command results, including runtime, output size, truncation state, terminal progress markers, download-phase hints, interactive prompt hints, clear error/completion hints, and last meaningful output lines.
- Preserve partial stdout/stderr, exit code, duration, timeout, and interactive prompt state through SSH shell, bridge, harness, core tools, IDE tools, frontend tool cards, and provider observations.
- Detect long-running terminal-progress downloads such as BenchOS/curl output and surface `suspectedStalledDownload` as a factual signal for the model.
- Remove duplicate pseudo progress text generated while tool arguments are still streaming, avoiding repeated “preparing parameters”/work-note noise in the agent timeline.
- Keep natural assistant text visible while avoiding repeated `workNote` rendering in tool summaries and tool bodies.
- Keep the core prompt minimal: no task-specific deployment heuristics and no fixed architecture-generated answer templates.
- Add project guardrails in `AGENTS.md` so future maintenance keeps prompt changes rare, avoids architecture impersonating the AI, and preserves full model context.
- Verify the release with syntax checks, targeted stalled-download diagnostics, `npm test`, frontend typecheck, and frontend production build.

## 4.2.2 - 2026-06-18

4.2.2 is a patch release for update-flow testing after 4.2.1. It hardens updater restart behavior and long-running MCP operations so users can continue testing in-place upgrades from the 4.2 line.

- Bump the release line from 4.2.1 to 4.2.2 so updater tests can validate a real version transition.
- Make updater restarts exit with a supervisor-friendly non-zero code by default, while still allowing `ONESHELL_RESTART_EXIT_CODE` / `ONE_SHELL_RESTART_EXIT_CODE` overrides.
- Change the Linux systemd install unit to `Restart=always`, reducing the chance that a successful update exit leaves the service down.
- Extend the stdio MCP client request timeout to 10 minutes by default and make it configurable with `ONESHELL_MCP_REQUEST_TIMEOUT_MS`.
- Preserve Linux executable permissions during release repackaging so `start.sh`, `install.sh`, and MCP stdio entrypoints remain runnable after update.
- Keep MCP large-file/background transfer fixes from 4.2.1 and continue publishing updater assets for Windows x64 and Linux x64 with SHA256 checksum files.

## 4.2.1 - 2026-06-18

4.2.1 is a test patch release for validating the 4.2 feature set. It synchronizes the latest agent, MCP, transfer, terminal, mobile layout, and slash-command fixes into the 4.2 source tree.

- Fix terminal progress-output and resize behavior by stabilizing xterm sizing, delaying remote PTY resize updates until layout settles, resetting terminal state on session switches, and clamping backend PTY dimensions.
- Add MCP core transfer coverage and safer large-file transfer paths, including chunk upload and background task checks.
- Sync 1Shell AI slash-command support and structured tool-result rendering across IDE/Agent surfaces.
- Remove leftover UI noise from the frontend and improve mobile layout behavior for the 4.2 console.
- Keep 4.2's Node engine constraint and release baseline while bumping package metadata to 4.2.1.

## 4.2.0 - 2026-06-18

4.2 是在 4.1 主体闭环上的一次大版本级补强，但版本号仍保留在 4.x。它把 1Shell 从“WebSSH + 程序化工作流面板”进一步收敛为“人和 Agent 共用的本地优先运维 runtime”：模型负责判断，runtime 负责状态、工具、安全边界、审计和可恢复运行。

### 核心变化

- 重构 1Shell AI 的默认产品路径，新增 AgentRun/IDE Agent 体验，弱化旧的重型 Program/Studio 路线。
- 新增 agent runtime 基础模块，覆盖预算、工具策略、观察解释、轨迹、interrupt、replay、final gate 和验证器等运行时职责。
- IDE Agent 页面新增会话侧栏、工具侧栏、时间线、审批卡片、审批模式、结构化工具结果和更稳定的流式状态。
- 新增 `/compact` 历史压缩能力，前端会显示独立的“正在压缩”状态，避免和普通对话生成混淆。
- 主机列表、探针列表等工具结果改为结构化数据交给前端渲染，减少模型重新拼表格导致的格式漂移。
- 清理过度具体的部署提示词，把“该读网页还是拉源码”等判断交回模型和工具上下文。

### Agent Runtime 与安全边界

- 新增 `src/agent-runtime/*`，为多步骤 agent 运行提供状态、预算、工具策略、轨迹、回放和验证基础。
- 强化 Harness 作为 AI 触达外部世界的统一边界，继续承载能力授权、风险识别、审批、人审降级和 trace 记录。
- 新增/调整 MCP 工具 profile，让不同工具集可以按场景裁剪，避免一次性暴露过长工具列表。
- 增强空输出保护，避免模型或工具异常返回空内容时前端进入不明确状态。
- 删除旧的 legacy IDE tool loop，减少 runtime 和模型互相“抢方向”的情况。

### 主机、文件与 Docker

- 文件管理器补齐基础写操作：新建文件夹、新建文件、重命名、删除、排序和写后刷新。
- 后端文件服务同步支持本机与 SFTP 的 mkdir/touch/delete/rename，并拒绝路径穿越、根目录删除、盘符根目录操作和重命名覆盖。
- MCP、Harness、Remote MCP ACL 和 1Shell AI gateway 同步纳入新增文件写工具。
- Docker 场景下增强只读挂载/权限错误提示，明确容器视角、宿主机视角和可执行处理方式。
- 新增文件写入自检接口，便于判断是工具链问题还是目标路径不可写。

### 登录、安全与凭据

- 新增 TOTP 2FA，兼容 Google Authenticator 等认证器。
- 新增一次性恢复码，恢复码只展示一次，服务端仅保存哈希。
- 登录流程支持密码验证后的 2FA 待验证票据，验证码通过后才签发正式会话。
- 设置页新增安全分区，可开启/关闭 2FA、查看恢复码和管理安全选项。
- `APP_SECRET` 缺失时不再阻止首次添加主机；`start.bat` / `start.sh` 首次创建 `.env` 时会自动生成随机 `APP_SECRET`。
- `start.sh` 固定 LF 行尾，避免 Linux 上出现 `env: bash\r` 类启动错误。

### MCP、外部 Agent 与 Bridge

- 本地 MCP 与 Remote MCP 的配置、令牌、ACL 和路径限制继续收敛到统一能力层。
- Bridge Token 自动管理更稳定，避免 `.env` 与持久化 token 读取顺序冲突。
- Claude Code MCP 配置同步能力增强，便于本地 Agent 直接接入 1Shell。
- 新增 `SecretRefPicker` 等前端能力，为工具调用中的 secret 引用做准备。

### 探针与远程监控

- 探针安装支持 `PUBLIC_SERVER_URL` / `ONESHELL_PUBLIC_URL`，可显式指定公网回连地址。
- 反代场景下生成 agent 端点时优先使用显式公网地址、Forwarded 头和浏览器 Origin，减少 http/https/端口推导错误。
- probe-agent、relay-agent、流量统计、告警、诊断和主机状态展示继续完善。
- 前端新增/调整探针结构化卡片和趋势展示，让 Agent 工具结果和人工界面复用同一批数据表达。

### 前端与桌面体验

- 登录页重做为深色终端品牌区 + 浅色登录卡片，移除旧 LoginGlobe。
- 设置从弹窗改为独立 `/settings` 页面，支持账号、安全、IP 访问控制、AI 配置、桌面版和关于分区。
- 默认浅色模式，保留已有用户的深色偏好。
- 主机仓库、主控台、脚本、技能、MCP Hub、Agent/IDE 相关页面都有结构和交互更新。
- 桌面版开始接入 GitHub Releases 更新能力，浏览器/开发模式下提供手动 Release 入口。

### 发布与安装

- 版本升级到 `4.2.0`，Node 支持范围为 `>=20 <23`；推荐 Node 20.18.3，不支持 Node 24 原生依赖安装。
- Windows/Linux 离线发布包内置 Node 20.18.3 与生产依赖，解压后可直接运行启动脚本。
- `start.bat` 优先使用包内 `runtime/node/node.exe`。
- `start.sh` 优先使用包内 `runtime/node/bin/node` 并加入 `PATH`，避免系统 Node 版本过高导致原生模块 ABI 不匹配。
- 发布包已验证 `better-sqlite3` 和 `node-pty` 在内置 Node 20 下可加载。

### 移除或降级的旧路径

- 移除旧 Program runtime、Program routes、Skill Studio 以及对应前端 Studio 组件。
- 移除 SettingsModal，改用独立设置页。
- 移除 LoginGlobe，避免登录页依赖重型视觉组件。
- 旧的“把一句目标拆成完整工作流卡片”的方向不再作为默认产品路径；可复用能力改为从真实 AgentRun、Skill、Script 和轻量 AI Task 中沉淀。

### 迁移说明

- 升级时请保留 `data/`、`.env`、`logs/` 和已有数据库文件，不要用新包直接覆盖这些运行数据。
- 已经配置过 `APP_SECRET` 的部署必须继续保留原值，否则旧凭据无法解密。
- 新部署通过 `start.bat` / `start.sh` 创建 `.env` 时会自动生成 `APP_SECRET`；手动部署未设置时仍可首次使用，但上线前建议设置强随机密钥。
- 如果从旧包手工替换文件，建议使用新 release 包完整替换程序文件，只保留运行数据目录和 `.env`。

### 发布包

- Windows: `release/1shell-4.2.0-windows-x64-offline-20260618-011427.zip`
  - Size: 64,914,600 bytes
  - SHA256: `6b9e9835da567b6289b012a29d7d6d2d2c5ce84e83e28d3c869f7123b9a7eba2`
- Linux x64: `release/1shell-4.2.0-linux-x64-offline-20260617-172258.tar.gz`
  - Size: 83,354,890 bytes
  - SHA256: `5a41c19f21d0f7ba2bb1bea7f2a24accf2406de1b252681b9ef683a2197fabbb`

### 验证

- `npm test`
- `npm --prefix frontend run build`
- Windows 干净解压后运行 `start.bat`，自动生成 `.env` 和 `APP_SECRET`，`/api/health` 返回 `usingFallbackSecret:false`
- Linux/example-hk 干净解压后运行 `start.sh`，自动生成 `.env` 和 `APP_SECRET`，`/api/health` 返回 `usingFallbackSecret:false`
