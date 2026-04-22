# 约束规则

## 保护性约束
- **不得操作名称或 ID 中包含 "1shell" 的容器**（保护 1Shell 自身）
- 不得修改 Docker daemon 配置（`/etc/docker/daemon.json`）
- 不得执行 `docker system prune` 或 `docker volume prune`（可能误删数据）

## 删除操作
- 删除容器前必须先列出容器详细信息（名称、镜像、状态、端口、挂载卷）
- **必须通过 ask_user (type=confirm, danger=true) 让用户确认后才执行删除**
- 如果容器正在运行，先停止再删除
- 不要使用 `--force` 参数删除运行中的容器

## 输出格式
- list 结果用 `render_result format=table` 展示，按运行状态分组：Running 排前面，Exited/Stopped 排后面
- inspect 结果用 `render_result format=keyvalue` 展示
- 生命周期操作结果用 `render_result format=message` 展示操作是否成功
- 日志内容用 `render_result format=message` 展示
- 如遇错误，用 `render_result level=error` 给出明确的错误原因和修复建议

## 权限处理
- 如果 `docker ps` 提示 permission denied，使用 `sudo docker` 重试
- 报告权限问题并建议将用户加入 docker 组

## 容器名为空时
- 如果用户未指定容器名但操作需要指定容器，用 ask_user (type=select) 列出所有容器让用户选