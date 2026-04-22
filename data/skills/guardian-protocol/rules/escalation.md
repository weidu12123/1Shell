# unresolvable 前置条件

## 必须满足以下全部条件，才能 report_outcome=unresolvable

### 条件 1：已完成诊断
- 已用 execute_command 探测实际状态
- 已确认根因（不是猜测）

### 条件 2：已尝试可用的修复路径
- 如果问题是容器改名 → 已尝试找新容器名并 write_program_step
- 如果问题是服务未启动 → 已尝试 systemctl start / docker start
- 如果问题是配置错误 → 已尝试修复配置
- 如果需要人工确认才能操作 → 已调用 ask_user

### 条件 3：已 render 诊断报告
- 已调用 render_result format=keyvalue level=error
- 报告包含：根因 + 当前状态 + 建议操作 + 参考命令

### 条件 4：确实超出当前权限或能力范围
以下情况才是真正的 unresolvable：
- 容器镜像/配置文件需要重新部署（不在主机上）
- 需要访问外部服务（域名注册商、云厂商控制台）
- 涉及需要人工决策的业务逻辑
- 需要用户提供密码/密钥等凭据

---

## 不符合 unresolvable 的情况（继续尝试）

| 误判为 unresolvable | 正确做法 |
|---|---|
| 容器名变了，原命令失效 | docker ps -a 找新名字，write_program_step 更新 |
| 服务 exited 但容器存在 | docker start / systemctl start 重启 |
| 磁盘满导致失败 | journalctl --vacuum / docker system prune |
| 依赖服务未启动 | 启动依赖服务 |
| 命令路径变了 | which 找新路径，write_program_step 更新 |