<!-- smoke-test: meta-workflow -->
# 修改已有 Skill

## 第一步：读取现有 Playbook

从 `skill_id` 输入读取要修改的 Playbook ID。

**重要：宿主机为 Windows，不能用 ls/find/cat 等 Unix 命令来检查或读取文件。**
直接用 `write_local_file` 写入即可（会自动创建父目录）；读取文件内容可用：
```
execute_command: type "data\playbooks\<skill_id>\SKILL.md"
```
（Windows 的 type 命令等价于 cat，路径用反斜杠）

若文件不存在，`type` 会返回非零 exitCode，此时用 `render_result level=error` 告知，并建议用「创建新 Playbook」流程。

逐一读取所有需要修改的文件（SKILL.md、playbook.yaml、workflows/*.md、rules/*.md）。

## 第二步：展示现状并询问修改意图

用 `render_result format=message level=info` 列出文件结构和当前关键内容。

然后 `ask_user type=input` 询问：**你想修改什么？**（若用户在创作台的任务描述里已经说清楚了，跳过此步直接执行修改）

常见修改类型：
- 添加新的 input 字段
- 添加新的 workflow
- 修改某个 workflow 的执行步骤
- 修改安全约束
- 修改 Skill 的描述或标签

## 第三步：执行修改

根据用户描述，生成修改后的文件内容，**直接用 `write_local_file` 写入，不要用 ask_user confirm 做额外确认**。

```
write_local_file:
  path: data/playbooks/<skill_id>/<目标文件>
  content: [修改后的完整内容]
```

## 第四步：确认修改

`write_local_file` 返回 OK 即表示写入成功。用 `render_result level=success` 告知完成，并说明修改了哪些文件。

## 第五步：保持对话，等待追问

**立刻**用 `ask_user type=input` 等待用户追问：

- title: "还有需要调整的地方吗？"
- placeholder: "继续说修改要求，或取消结束"

收到用户回复后：
- **有意义的内容** → 直接修改对应文件（`write_local_file`），render_result success，然后**再次 ask_user**（无限循环直到用户取消）
- **用户取消 / 回复为空** → 直接结束