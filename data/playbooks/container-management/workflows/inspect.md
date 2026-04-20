# 工作流：查看容器详情

## 步骤

1. 如果未指定容器名，先列出所有容器让用户选：
   ```
   ask_user type=select, title="查看哪个容器的详情？"
   options: （从 docker ps -a --format '{{.Names}}' 的结果动态生成）
   ```

2. 用 `execute_command` 收集信息：
   ```bash
   docker inspect {{container}} --format '{{json .}}'
   ```
   ```bash
   docker stats {{container}} --no-stream --format '{{json .}}'
   ```

3. 从 inspect JSON 中提取信息，用 `render_result format=keyvalue` 展示：
   ```
   title: "容器详情 — {{container}}"
   items: [
     { "key": "名称", "value": "..." },
     { "key": "镜像", "value": "..." },
     { "key": "状态", "value": "..." },
     { "key": "启动时间", "value": "..." },
     { "key": "重启次数", "value": "..." },
     { "key": "端口映射", "value": "..." },
     { "key": "CPU 使用", "value": "..." },
     { "key": "内存使用", "value": "..." },
     { "key": "挂载卷", "value": "..." }
   ]
   ```

4. 环境变量中可能包含密码/Token，展示时提醒用户注意。
5. 如果容器不存在，用 `render_result level=error` 报告并建议用 list 查看。