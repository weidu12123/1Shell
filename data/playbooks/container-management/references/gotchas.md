# 已知踩坑

## 1. Docker 未安装

**症状**：`command not found: docker`

**检测**：
```bash
command -v docker && docker --version
```

**建议**：
- 报告给用户 Docker 未安装
- 给出安装命令（但不要自动执行，安装 Docker 超出此 Skill 范围）：
  ```
  curl -fsSL https://get.docker.com | sh
  ```

## 2. Docker daemon 未运行

**症状**：`Cannot connect to the Docker daemon`

**检测**：
```bash
systemctl is-active docker
```

**修复**：
```bash
sudo systemctl start docker
sudo systemctl enable docker
```

## 3. 权限不足

**症状**：`permission denied while trying to connect to the Docker daemon socket`

**原因**：当前用户不在 `docker` 组

**临时方案**：所有命令加 `sudo`

**永久方案**（提示用户，不自动执行）：
```bash
sudo usermod -aG docker $USER
# 需要重新登录生效
```

## 4. 容器名称 vs ID

- 用户可能输入容器名称或 ID 的前几位
- `docker inspect` 都能接受
- 如果输入不匹配任何容器，列出所有容器帮助用户找到正确的名称