# 程序编辑常见修改示例

## 添加主机

```yaml
# 原来
hosts:
  - host_abc123

# 改后（追加，不替换）
hosts:
  - host_abc123
  - host_def456
```

---

## 改为所有主机

```yaml
hosts: all
```

---

## 增加监控 step（加在 render step 之前）

```yaml
      # 新增 step
      - id: check_openresty
        label: 检查 OpenResty 存活
        run: docker inspect 1Panel-openresty-YygR --format '{{.State.Status}}'
        verify:
          exit_code: 0
          stdout_contains: "running"
        on_error_hint: OpenResty 容器异常，检查是主动停止还是意外崩溃

      # 原有 render step 保持不动
      - id: render_status
        type: render
```

---

## 修改 cron 触发频率

```yaml
# 原来：每分钟
schedule: "* * * * *"

# 改为每5分钟
schedule: "*/5 * * * *"
```

---

## 添加 Guardian Rescue Skill

```yaml
guardian:
  skills:
    - existing-rescue-skill
    - new-rescue-skill      # 追加，保留原有
  max_actions_per_hour: 10
```

---

## 常见坑（edit 模式特有）

1. **不要重写整个文件** — 保留原有注释、格式、字段顺序
2. **不要改 `enabled`** — 启用/停用让用户在 UI 里操作
3. **新增 step 必须加 `on_error_hint`** — Guardian 介入时会读
4. **容器名确认** — 添加 Docker 相关 step 前先 `execute_command` 验证容器名