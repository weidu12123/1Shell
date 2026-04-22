# 1Shell Playbook 创作设计文档

> 版本：草案 v1 · 日期：2026-04-18
> 本文档是 **Phase 2 ~ Phase 3** 的施工蓝图。Phase 1（基础地基）已落地。

---

## 1. 背景与定位

1Shell 3.0 的核心交付物从"Skill"重新定义为 **Playbook（智能剧本）**。

### 概念分层（2026-04 重命名后）

| 概念 | 定义 | 存放 | 执行方式 |
|------|------|------|----------|
| **Skill** | 可复用能力单元（Anthropic 原语义），如 `skill-authoring` | `data/skills/` | 被 Playbook 或用户直接调用 |
| **MCP Server** | 第三方远程工具，通过 URL 接入 | `data/mcp-servers.json`（Phase 2 引入） | 作为 Tool 挂载到运行时 |
| **Playbook** | 跨主机/跨项目、AI 维护的智能剧本 | `data/playbooks/` | 由 Runner 执行（L1 确定性 / L2 Rescuer / L3 AI-loop 三层）|
| **Workflow** | 脚本页的多步骤脚本编排（与上述无关） | SQLite `playbooks` 表（DB 表名 Batch B 再改）| scripts 页 |
| Routine（将来） | Skill 内部的 AI 指令路由文档 | `data/skills/*/routines/` | 不暴露给用户 |
| Steps（将来） | Playbook 的确定性步骤 YAML | `data/playbooks/*/steps.yaml` | L1 Executor |

### 本文档聚焦：Playbook 创作台（Skill Studio → Playbook Studio）

**目标**：用户通过自然语言 + 选择 VPS/容器/文件/MCP server/Skill，由 AI 生成可运行的 Playbook，存入 `data/playbooks/`。生成的 Playbook 具备：

1. **可运行**：一键执行，不需要再改代码
2. **自维护**：运行出错时，AI 根据历史错误改进 Playbook
3. **组合式**：可以引用其它 Skill 作为能力，引用其它 MCP server 作为工具
4. **可版本化**：每次改动留历史版本（Phase 3）

---

## 2. 用户场景

### 场景 A：跨主机备份
> "每天凌晨 3 点把 VPS-web 的 `/data` 打包推到 VPS-backup 的 `/backups`，保留最近 7 天"

- 左栏选两台主机
- 右栏无 MCP
- 自然语言写出来
- AI 生成含两段 `execute_command` 的 Playbook + cron 建议

### 场景 B：故障排查
> "检查 VPS-api 的 app 容器日志，如果有 OOM 就拉 GitHub issue"

- 左栏选 VPS-api
- 右栏容器选 `app`
- 右栏 MCP 选 `github-issues`
- AI 生成读日志 → 调 MCP 创建 issue 的 Playbook

### 场景 C：从脚本迭代
> "上次这个 Playbook 执行失败了因为 dpkg 锁，改进一下"

- 选 refine 模式
- 选中已有 Playbook
- 自然语言描述要改的地方
- AI 读旧文件 → 增加预处理步骤 → 写回

---

## 3. 架构分层

```
┌──────────────────────────────────────────────┐
│ Playbook 创作台 UI (skill-studio.html)        │
│  左栏：VPS + 路径                              │
│  中栏：执行流(上) + 自然语言(下)               │
│  右栏：容器 + MCP + 引用 Skill (Phase 2)       │
└──────────────────────────────────────────────┘
               │
               ↓
┌──────────────────────────────────────────────┐
│ POST /api/skill-studio/compose                │
│  把表单字段拼成结构化 Markdown task           │
└──────────────────────────────────────────────┘
               │
               ↓
┌──────────────────────────────────────────────┐
│ socket emit skill:run                         │
│   skillId = 'skill-authoring'                 │
│   inputs.task = <composed markdown>           │
└──────────────────────────────────────────────┘
               │
               ↓
┌──────────────────────────────────────────────┐
│ Runner (AI-loop, 本机)                        │
│  skill-authoring SKILL.md + workflows/        │
│  → write_local_file("data/playbooks/<id>/...")│
└──────────────────────────────────────────────┘
               │
               ↓
┌──────────────────────────────────────────────┐
│ 新 Playbook 落盘 → 剧本库可见，可执行          │
└──────────────────────────────────────────────┘
```

---

## 4. 数据模型

### 4.1 Playbook 目录结构

```
data/playbooks/<playbook-id>/
├── SKILL.md           # frontmatter + 元数据（沿用 Skill 格式，兼容 registry）
├── playbook.yaml      # 可选：L1 确定性步骤（将来改名 steps.yaml）
├── rules/
│   └── constraints.md # AI-loop 模式的硬约束
├── workflows/         # AI-loop 模式的指令路由
│   └── main.md
└── references/        # Playbook 自带的参考资料（可选）
    └── env.md
```

### 4.2 SKILL.md frontmatter 扩展字段

```yaml
---
name: 每日备份到 S3
icon: "💾"
category: backup
description: Back up /data to S3 nightly with 7-day retention.
hidden: false

# Phase 1 已支持
mcpServers:
  - name: aws-s3
    url: https://mcp.aws.example/s3/sse
    authToken: env:AWS_MCP_TOKEN

# Phase 2 新增
referencedSkills:  # 引用的可复用 Skill
  - ssh-batch
  - disk-cleanup
rescueSkill: backup-rescuer  # 出错时调用的 Skill-化修复策略
targets:  # 静态绑定的目标主机（可选，不绑定时 runtime 选）
  - hostId: vps-web
    role: source
  - hostId: vps-backup
    role: destination

inputs:
  - name: retention_days
    type: number
    default: 7
---
```

### 4.3 运行时元数据（Phase 3）

每次 run 写入 `data/playbook-runs/<runId>.json`：

```json
{
  "runId": "run-20260418-001",
  "playbookId": "daily-backup",
  "startedAt": "2026-04-18T03:00:00Z",
  "status": "success|failed|cancelled",
  "steps": [...],
  "rescueInvocations": [...],
  "tokenUsage": { "input": 0, "output": 0, "cached": 0 },
  "errors": [...]
}
```

供 AI 改进功能读取历史失败，驱动 refine。

---

## 5. 功能分期

### Phase 1（已完成，2026-04）
- ✅ `mcpServers` frontmatter + Runner 传递给 Anthropic
- ✅ `/api/skill-studio/compose` 后端
- ✅ 创作台三栏布局
- ✅ Skill / Playbook 物理分离
- ✅ `/api/playbooks` 库路由、剧本库页面、侧栏入口
- ✅ scripts 页旧 `/api/playbooks` → `/api/workflows`
- ✅ skill-authoring 改写 Playbook 到 `data/playbooks/`

### Phase 2（下一轮工作）

#### 2.1 右栏增加"引用 Skill"
- `/api/skills` 已就绪，UI 直接复用
- Skill 被引用后，其 SKILL.md 被塞入 Playbook 生成的 prompt，AI 生成时会引用该 Skill 的命令风格/命名
- 生成的 Playbook frontmatter 写入 `referencedSkills: [...]`

#### 2.2 文件浏览器升级
- 当前左下角只是纯文本输入
- 升级为：选中主机后，点"浏览"弹出远程文件树（复用主控台的 file-browser.js）
- 选定的路径作为上下文注入 task

#### 2.3 AI 修复回路（关键！）
- 执行失败后，在 run stream 下方出现"AI 改进"按钮
- 点击后进入 refine 模式，自动填入失败的错误摘要到 task
- AI 读取原 Playbook + 错误日志 → 生成补丁
- 落盘 `PLAYBOOK.md` 追加 `## Known Gotchas · rev N`

#### 2.4 多 Playbook 并发运行面板
- 新增 `playbook-runs.html`，显示所有进行中的 run
- 后端 runner 已经支持 activeRuns Map，只需 UI
- 每个 run 可独立查看/停止

#### 2.5 rescuer Skill 化
- 把 `src/skills/rescuer.js` 的硬编码策略抽出来变成 Skill：`data/skills/error-triage/`
- Playbook frontmatter 声明 `rescueSkill: <id>`，runner 遇到 verify 失败时加载并调用该 Skill
- 不声明的沿用默认 rescuer（向后兼容）

### Phase 3（更远期）

#### 3.1 版本化
- 每次 write_local_file 落盘前把旧版本存到 `.versions/<timestamp>/`
- 剧本库详情页显示版本历史
- 可回滚

#### 3.2 运行历史
- `data/playbook-runs/` 持久化
- refine 模式自动把最近 3 次失败摘要作为上下文

#### 3.3 Skill 市场 import
- `/api/skills/import?url=https://...` 接入远程 Skill 仓库（如 awesome-claude-skills）
- 下载到 `data/skills/imported/<id>/`
- 不做本地 npm spawn 类 MCP，仍只支持远程 URL MCP

#### 3.4 Playbook 编辑器
- 剧本库里除了"运行"按钮，新增"编辑"按钮
- 打开一个 Monaco editor 直接改 SKILL.md / playbook.yaml
- 改完 reload 即生效

---

## 6. 创作台 UI 契约（给 Phase 2 作参考）

### 6.1 布局分区

```
┌─侧活动栏─┬──顶栏（模式：创建/修改 | 返回仓库）─┐
│         ├────────┬──────────────────┬────────┤
│         │ 左栏22% │     中栏flex     │ 右栏24% │
│         ├────────┼──────────────────┼────────┤
│         │ VPS 卡 │  创作过程        │ 项目/容器│
│         │        │ (执行流 log)     │          │
│         │        │                  │          │
│         │────────│                  │────────  │
│         │ 路径   │                  │ MCP      │
│         │        │                  │          │
│         │        │──────────────────│────────  │
│         │        │ refine 选项(显隐)│ 引用 Skill│
│         │        │ 自然语言 textarea│ (Phase 2)│
│         │        │ summary  [创作→] │          │
└─────────┴────────┴──────────────────┴────────┘
```

### 6.2 状态机

```
idle → (click "开始创作") → composing → running → done|error|cancelled
                                  ↑                    │
                                  └────(click "再改")──┘
```

### 6.3 Socket 事件订阅

```
skill:run-started  → 设置 status badge
skill:thinking     → 点动画 "AI 思考中"
skill:thought      → 执行流追加一行（紫色）
skill:exec         → 执行流追加 "$ command"
skill:exec-result  → 追加 stdout/stderr/exit
skill:render       → 追加 "▣ 标题" 高亮
skill:info         → 追加蓝色 info 行
skill:done         → 状态绿，重载剧本库
skill:error        → 状态红，保留错误供 refine
skill:cancelled    → 状态灰
```

---

## 7. 验收标准

Phase 1 已通过的冒烟：
- [x] `/api/skills` 只列 skill-authoring
- [x] `/api/playbooks` 列出 container-list / server-health-check
- [x] `/api/workflows` 替代旧 `/api/playbooks`（scripts 页 OK）
- [x] 创作台可提交 compose，runner 起任务

Phase 2 需达成：
- [ ] 一段自然语言任务 → 真生成可运行的 Playbook（端到端）
- [ ] 该 Playbook 运行失败 → 点"AI 改进"→ 生成 patched Playbook → 再跑成功
- [ ] 容器选择器扫描远程 host 并展示 docker ps
- [ ] MCP 接入一个真实远程 URL（如 Context7 docs MCP），AI 能调用它的 tools

---

## 8. 非目标（明确不做）

- ❌ stdio 类 MCP（spawn npm/uvx）——安全、依赖代价大
- ❌ 跨机器分布式调度（cron by 1Shell 本机）——复杂度爆炸
- ❌ 用户权限/多租户——1Shell 是单用户工具
- ❌ Playbook 执行超过 10 分钟的长任务——改用 cron + 短 Playbook
- ❌ 导入他人未审计的 Playbook——安全风险

---

## 9. 风险与应对

| 风险 | 触发条件 | 缓解 |
|------|----------|------|
| AI 生成的 Playbook 写坏文件 | write_local_file 被骗写 `/etc` | Runner 已限制路径在 `data/` 下 |
| MCP 第三方跑路 | 远程 URL 404 | 生成时验活；失败时 degrade 到无 MCP |
| 大量 Playbook 堆积难管 | 用户反复创建 | Phase 3 加标签、归档、搜索 |
| refine 越改越烂 | AI 修复引入新错误 | 版本化 + diff 审查（Phase 3） |
| Skill 与 Playbook 概念混淆 | 用户把 Skill 当 Playbook 用 | 两个页面视觉明显区分；"创建"按钮只出现在 Playbook 侧 |

---

## 10. 目录决策（防止日后反复）

**Skill 仓库 `data/skills/` 准入标准**：
1. 必须是"可复用能力"——不止用一次
2. 不绑定特定主机、特定项目
3. 命名应是动词短语（authoring、error-triage），不是场景（backup-mysql）
4. 当前只有 `skill-authoring` 合格

**Playbook 仓库 `data/playbooks/` 准入标准**：
1. 解决一个具体场景（即使被多次调用）
2. 可以绑定/引用特定主机、容器、文件路径
3. 命名应是任务名词（daily-backup、cert-renewal）
4. 当前：cert-management、container-list、container-management、server-health-check

---

**本文档会随 Phase 2/3 落地迭代。提交到 git 前先由人（你）review 一遍。**