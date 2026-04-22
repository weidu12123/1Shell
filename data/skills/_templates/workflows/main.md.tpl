# Workflow: <!-- FILL: 流程名，例如：添加网站 -->

<!-- workflow 写法原则：
  ✅ 写"遇到 X 情况时做 Y 判断"（条件 → 决策）
  ✅ 写"执行前必须搞清楚 X"（前置探测）
  ✅ 写"输出用 render_result format=table/keyvalue/message/code"（明确格式）
  ❌ 不要写"第1步执行 A 第2步执行 B"（那是 Playbook 的写法）
  ❌ 不要用 YAML/JSON 定义命令（那是 playbook.yaml 的写法） -->

---

## 触发场景

<!-- FILL: 描述什么情况下 AI 会进入本 workflow
  例如：用户提到"添加网站"、"新建域名"、"部署项目"时进入本流程 -->

## 执行前必须搞清楚

<!-- FILL: 列出开始操作前需要探测/确认的信息
  例如：
  - 域名是否已有 nginx 配置？用 ls /etc/nginx/sites-available/ 检查
  - 目标端口是否已被占用？用 ss -tlnp | grep :<port>
  - 是否有同名容器？用 docker ps -a --filter name=<name> -->

## 决策逻辑

<!-- FILL: 描述 AI 需要根据现场情况做的判断
  例如：
  - 若域名已有配置 → ask_user 确认是否覆盖
  - 若端口被占 → 告知用户冲突并建议备选端口
  - 若信息不足 → ask_user type=input 补充 -->

## 危险操作确认

<!-- FILL: 列出本流程中需要 ask_user confirm 的操作
  例如：覆盖已有配置前 ask_user type=confirm danger=true
  用户取消后 render_result level=warn 并停止 -->

## 输出规范

<!-- FILL: 明确本流程结束时的 render_result 格式
  可选项：
  - 列表展示 → format=table，columns=[列1, 列2, ...]
  - 详情展示 → format=keyvalue
  - 操作结果 → format=message，level=success|error|warn
  - 配置内容 → format=code，language=nginx|bash|yaml -->

操作成功：`render_result format=message level=success`，说明完成了什么。
操作失败：`render_result format=message level=error`，说明失败原因，**停止后续步骤**。