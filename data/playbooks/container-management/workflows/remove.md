# 工作流：删除容器

## 安全检查（必须）

1. 检查容器名是否包含 "1shell"：
   ```bash
   docker inspect {{container}} --format '{{.Name}}' | grep -i 1shell && echo "PROTECTED" || echo "OK"
   ```
   - 如果输出 PROTECTED → **立即停止，不删除**，用 `render_result level=error` 报告

2. 收集容器信息：
   ```bash
   docker inspect {{container}} --format '{{json .}}'
   ```

3. **必须通过 ask_user 确认**：
   ```
   ask_user type=confirm
   title: "确认删除容器 {{container}}？"
   description: "镜像: {{image}}\n状态: {{status}}\n挂载卷: {{volumes}}\n\n此操作不可撤销。容器的挂载卷数据仍在宿主机上，需手动清理。"
   danger: true
   confirmLabel: "确认删除"
   cancelLabel: "取消"
   ```

4. 用户取消 → `render_result format=message level=info content="已取消删除"` 结束

## 删除步骤

用户确认后：

```bash
# 如果容器正在运行，先停止
docker stop {{container}} 2>/dev/null

# 删除容器
docker rm {{container}}
```

## 结果展示
- 成功：`render_result format=message level=success title="容器已删除" content="{{container}} 已被删除。挂载卷数据仍在宿主机上，如需清理请手动处理。"`
- 失败：`render_result format=message level=error title="删除失败" content="...错误信息..."`

## 注意
- 不要使用 `docker rm -f`