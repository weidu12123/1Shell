# render_result 强制输出规范

## 铁律：每次 Guardian 会话必须至少调用一次 render_result

无论是修复成功、修复失败、还是需要人工介入，**都必须在 report_outcome 之前调用 render_result**。

---

## 修复成功时

```
render_result format=message level=success
title: "✅ <step名称> 已自动修复"
content: |
  根因：<一句话说明根因>
  修复操作：<做了什么>
  持久化：<是否已更新 program.yaml>
  下次触发：<预期行为>
```

---

## 无法修复时（必须用 keyvalue，不得用 message）

```
render_result format=keyvalue level=error
title: "⚠ <step名称> 需要人工处置"
items:
  - key: 根因
    value: <具体是什么问题，不要模糊>
  - key: 当前状态
    value: <execute_command 探测到的实际输出，不要省略>
  - key: 影响范围
    value: <哪些功能受影响>
  - key: 建议操作
    value: <人工需要执行的具体命令或步骤>
  - key: 参考命令
    value: <可以复制粘贴到终端的命令>
```

---

## 禁止行为

- 禁止跳过 render_result 直接 report_outcome=unresolvable
- 禁止 render_result 内容只写"容器不存在，需人工处理"这种废话
- 禁止省略"当前状态"和"建议操作"两个必填字段