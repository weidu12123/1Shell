# 报告流程

## 报告时机

在 report_outcome 之前，**必须至少调用两次 render_result**：
1. 一张「全局状态快照」（无论成败都要）
2. 一张「诊断/修复结论」（针对失败 step）

不得以任何理由跳过。

---

## 第一张：全局状态快照（必须最先输出）

Guardian 介入时，用户不只想知道"哪里坏了"，更想看到"整体现在怎么样"。
**在诊断之后、输出结论之前，主动采集以下信息并渲染**：

```
render_result
  format: keyvalue
  level: info
  title: "📊 主机巡检快照"
  items:
    - 采集时间: <date '+%Y-%m-%d %H:%M:%S'>
    - 系统负载: <awk '{print $1,$2,$3}' /proc/loadavg>
    - 内存使用: <free -m | awk 'NR==2{printf "%dMB / %dMB (%.0f%%)", $3,$2,$3/$2*100}'>
    - 磁盘使用: <df -Ph / | awk 'NR==2{printf "%s / %s (%s)", $3,$2,$5}'>
    - 容器总数: <docker ps -a --format '{{.Names}}' | wc -l> 个
    - 运行容器: <docker ps --format '{{.Names}}' | wc -l> 个
    - 失败 step: <failingStep.id>
    - 失败原因: <failureReason 的简短描述>
```

采集命令可以根据当前主机实际情况调整，但**必须包含负载、内存、磁盘、容器状态**这四项基础指标。

---

## 第二张：修复成功的结论

```
render_result
  format: message
  level: success
  title: "✅ 已自动修复：<step id>"
  content: |
    根因：<一句话>
    操作：<做了什么>
    持久化：已更新 program.yaml / 无需更新（临时修复）
```

---

## 第二张：无法修复的结论（必须用 keyvalue）

```
render_result
  format: keyvalue
  level: error
  title: "⚠ 需人工处置：<step id>"
  items:
    - 根因: <具体描述，不能模糊>
    - 当前状态: <execute_command 的实际输出>
    - 影响: <哪些服务/功能受影响>
    - 建议操作: <人工要做什么>
    - 参考命令: <可以直接在终端运行的命令>
```

---

## 报告质量检查（输出前自问）

- [ ] 全局状态快照输出了吗？（第一张）
- [ ] 四项基础指标都有吗？（负载/内存/磁盘/容器状态）
- [ ] 根因写清楚了吗？（不是"容器不存在"，而是具体描述）
- [ ] 当前状态贴了实际输出吗？
- [ ] 建议操作是人工可以直接执行的具体步骤吗？

---

## 30 秒 AAR（report_outcome 之前的自检）

1. 两张 render_result 都调用了吗？
2. 快照里四项基础指标都有数据吗？
3. 如果是 resolved，write_program_step 调用了吗？
4. 用户拿到我的报告能立刻了解主机全貌并采取行动吗？