# 工作流：列出容器

## 步骤

1. 用 `execute_command` 执行：
   ```bash
   docker ps -a --format '{{json .}}'
   ```
   - 如果报权限错误，用 `sudo docker ps -a --format '{{json .}}'` 重试
   - 如果报 command not found 或 daemon 错误 → 走 references/gotchas.md 的修复流程，并用 `render_result level=error` 报告

2. 解析每行 JSON，提取字段：Names / Image / Status / Ports / CreatedAt / State
   - 按 State 分组：running 的在前，其他（exited/created/paused）在后

3. 用 `render_result` 推送结果：
   ```
   format: table
   title: "容器列表"
   subtitle: "运行中 X 个，已停止 Y 个"（按实际数量填）
   columns: ["名称", "镜像", "状态", "端口", "创建时间"]
   rows: [...]
   rowActions: [
     { "label": "查看详情", "value": "status" },
     { "label": "查看日志", "value": "logs" },
     { "label": "重启", "value": "restart" }
   ]
   ```
   - **名称包含 "1shell" 的容器**照常列入 rows 展示，但前端会自动隐藏其操作按钮。rowActions 数组不需要你做特殊处理。

4. 如果容器数量为 0：
   ```
   format: message
   level: info
   title: "当前无容器"
   content: "此主机上没有任何 Docker 容器"
   ```

5. 完成后简短收尾："已列出 N 个容器"，结束。

## 说明
- **绝对不要**只把表格写在 assistant 文本里——用户看不到。必须用 render_result。
- rowActions 是可选的；如果用户后续点了某行的某个动作，会通过下一个 ask_user 回传。