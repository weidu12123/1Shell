# 工作流：启动 / 停止 / 重启容器

## 前置检查
- 确认容器存在且名称不包含 "1shell"
- 如果未指定容器名，用 `ask_user type=select` 让用户选择

## 启动
```bash
docker start {{container}}
docker ps --filter "name={{container}}" --format '{{json .}}'
```

## 停止
```bash
docker stop {{container}}
docker ps -a --filter "name={{container}}" --format '{{json .}}'
```

## 重启
```bash
docker restart {{container}}
docker ps --filter "name={{container}}" --format '{{json .}}'
```

## 结果展示
操作后用 `render_result format=message` 展示：
```
level: success （或 error）
title: "容器 {{container}} 已重启"
content: "当前状态: Up 2 seconds"
```

## 失败处理
- 操作后验证状态已变更
- 如果操作失败，执行 `docker logs --tail 20 {{container}}` 获取错误信息
- 用 `render_result level=error` 展示失败原因和建议