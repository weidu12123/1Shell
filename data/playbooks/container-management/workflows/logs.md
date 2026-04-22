# 工作流：查看容器日志

## 步骤

1. 如果未指定容器，用 `ask_user type=select` 让用户选择。

2. 用 `execute_command` 取最后 N 行日志（N 来自参数 tail_lines，默认 100）：
   ```bash
   docker logs --tail {{tail_lines}} {{container}} 2>&1
   ```

3. 用 `render_result format=message` 展示：
   ```
   title: "容器日志 — {{container}}（最后 {{tail_lines}} 行）"
   content: <日志原文>
   level: info
   ```

## 大日志截断
- 如果日志 > 20000 字符，在 content 中只保留最后 20000 字符，在 subtitle 标明"已截断"
- 建议用户改用 `docker logs --since 1h` 等时间范围过滤

## 其他命令（仅在用户明确要求时）
- 实时跟随：`docker logs -f`（本 Skill 不用，因为是非交互场景）
- 带时间戳：`docker logs --tail {{tail_lines}} -t {{container}}`
- 按时间过滤：`docker logs --since 1h {{container}}`
- 搜索关键词：`docker logs {{container}} 2>&1 | grep -i "关键词"`