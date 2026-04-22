<!-- smoke-test: meta-workflow -->
# 解释 Skill 结构

## 步骤

1. 读取 `skill_id` 输入

2. 读取所有文件：
```
execute_command: find data/playbooks/<skill_id>/ -type f -name "*.md" | sort
```
逐一 `cat` 每个文件。

3. 用 `render_result format=message` 用中文解释：
   - 这个 Skill 做什么
   - 用户需要填哪些参数，各参数的作用
   - 有哪几个执行路径（workflow），分别在什么情况下触发
   - 有哪些安全约束
   - 如果要修改，哪些文件需要改

4. 如果用户想修改，引导到 refine 流程（切换 mode=refine）。