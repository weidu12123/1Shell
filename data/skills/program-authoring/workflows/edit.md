# Program 编辑 Workflow

> 用于修改**已存在**的 program.yaml。
> 核心原则：**最小必要修改——只改用户描述的部分，其余原封不动。**

## 前置：必须先读

- `rules/constraints.md` — YAML 安全规则、命令白名单
- 当前 program.yaml 全文（已由 Studio 注入上下文）

---

## Step 1：理解现有程序

从注入的 `## 当前 program.yaml` 块中提取：
- `hosts`：当前绑定的主机列表
- `actions.<action>.steps`：所有 step 的 id / run / verify
- `guardian.skills`：已挂载的 Rescue Skill
- `triggers`：触发周期

**必须完整读完再动手，不得跳过。**

---

## Step 2：解析修改意图

| 用户说 | 对应字段 |
|---|---|
| 加入 VPS2 / 增加主机 | `hosts` 追加 host_id |
| 去掉某台主机 | `hosts` 移除对应 id |
| 改成所有主机 | `hosts: all` |
| 增加监控项 / 新功能 | `steps` 末尾（render 之前）新增 step |
| 修改某个 step 命令 | 只改该 step 的 `run` 字段 |
| 改触发频率 | 只改 `triggers[].schedule` |
| 加 Rescue Skill | `guardian.skills` 追加 id |
| 修改阈值/参数 | 只改对应 step `run` 内的参数值 |

如需探测新主机或新服务，用 `execute_command` 做 1-2 条只读探测。

---

## Step 3：展示计划 + 写入

用 `render_result format=keyvalue level=info` 列出将改什么、不改什么。
然后**立即**用 `write_local_file` 写入修改后的完整 yaml。

路径：`data/programs/<programId>/program.yaml`

> 写入约束见 `rules/constraints.md` §10（YAML 安全规则）

---

## Step 4：成功反馈 + 保持对话

```
render_result format=message level=success
已更新 <programId>：
  ✓ <改了什么>
  → 未改动：<列出未改动主要字段>
```

然后 `ask_user type=input title="还要继续调整吗？"`

---

## 自检（写入前）

- [ ] 只改了用户描述的部分
- [ ] 未删除用户未提及的 step
- [ ] 未修改 `enabled` 字段（除非用户明确要求）
- [ ] run 字段无 heredoc、无多行 Python（见 rules/constraints.md §10）