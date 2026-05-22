#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
#  1Shell 一键安装脚本
#  用法: curl -fsSL https://raw.githubusercontent.com/weidu12123/1Shell/main/install.sh | bash
#  或:   bash install.sh [选项]
#
#  选项:
#    --port PORT        服务端口 (默认 3301)
#    --password PASS    登录密码 (默认随机生成)
#    --dir DIR          安装目录 (默认 /opt/1shell)
#    --docker           使用 Docker 部署
# ============================================================================

INSTALL_DIR="/opt/1shell"
PORT="3301"
PASSWORD=""
USE_DOCKER=false
REPO_URL="https://github.com/weidu12123/1Shell.git"
BRANCH="main"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${GREEN}[1Shell]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()  { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# 解析参数
while [[ $# -gt 0 ]]; do
  case $1 in
    --port)     PORT="$2"; shift 2 ;;
    --password) PASSWORD="$2"; shift 2 ;;
    --dir)      INSTALL_DIR="$2"; shift 2 ;;
    --docker)   USE_DOCKER=true; shift ;;
    *)          err "未知参数: $1"; exit 1 ;;
  esac
done

# 生成随机密码
if [[ -z "$PASSWORD" ]]; then
  PASSWORD=$(head -c 16 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 12)
fi

# 生成随机密钥
APP_SECRET=$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 32)
BRIDGE_TOKEN=$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 32)

echo ""
echo -e "${BLUE}╔════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║         1Shell 一键安装脚本 v3.3.0            ║${NC}"
echo -e "${BLUE}║     One Shell to rule them all.                ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════╝${NC}"
echo ""

# ─── 检查 Node.js ─────────────────────────────────────────────────────────
check_node() {
  if command -v node &>/dev/null; then
    local ver
    ver=$(node -v | tr -d 'v')
    local major
    major=$(echo "$ver" | cut -d. -f1)
    if [[ "$major" -ge 18 ]]; then
      log "Node.js v${ver} 已安装"
      return 0
    fi
  fi
  return 1
}

install_node() {
  log "正在安装 Node.js 20.x ..."
  if command -v apt-get &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  elif command -v yum &>/dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    yum install -y nodejs
  else
    err "不支持的包管理器，请手动安装 Node.js >= 18"
    exit 1
  fi
}

# ─── 检查编译依赖（node-pty 需要）────────────────────────────────────────
install_build_deps() {
  log "检查编译依赖..."
  if command -v apt-get &>/dev/null; then
    apt-get update -qq
    apt-get install -y -qq make g++ python3 2>/dev/null || true
  elif command -v yum &>/dev/null; then
    yum install -y make gcc-c++ python3 2>/dev/null || true
  fi
}

# ─── Docker 部署 ──────────────────────────────────────────────────────────
deploy_docker() {
  log "使用 Docker 部署..."

  if ! command -v docker &>/dev/null; then
    err "Docker 未安装，请先安装 Docker"
    exit 1
  fi

  mkdir -p "$INSTALL_DIR"
  cd "$INSTALL_DIR"

  # 如果目录已有代码就 pull，否则 clone
  if [[ -d ".git" ]]; then
    log "更新代码..."
    git pull origin "$BRANCH" 2>/dev/null || true
  else
    log "克隆代码..."
    git clone --depth 1 -b "$BRANCH" "$REPO_URL" .
  fi

  # 写入 .env
  write_env

  # 构建并启动
  log "构建 Docker 镜像..."
  docker compose down 2>/dev/null || true
  docker compose up -d --build

  log "等待服务启动..."
  sleep 5

  if curl -sf "http://localhost:${PORT}/api/auth/status" &>/dev/null; then
    log "Docker 部署成功!"
  else
    warn "服务可能还在启动中，请稍等后检查"
    docker compose logs --tail 20
  fi
}

# ─── 原生部署 ─────────────────────────────────────────────────────────────
deploy_native() {
  # 检查/安装 Node.js
  if ! check_node; then
    install_node
  fi

  install_build_deps

  mkdir -p "$INSTALL_DIR"
  cd "$INSTALL_DIR"

  # 克隆或更新代码
  if [[ -d ".git" ]]; then
    log "更新代码..."
    git pull origin "$BRANCH" 2>/dev/null || true
  else
    log "克隆代码..."
    git clone --depth 1 -b "$BRANCH" "$REPO_URL" .
  fi

  # 安装依赖
  log "安装依赖..."
  npm install --omit=dev 2>&1 | tail -3

  # 创建数据目录
  mkdir -p data

  # 写入 .env
  write_env

  # 创建 systemd service
  setup_systemd

  # 启动服务
  log "启动服务..."
  systemctl daemon-reload
  systemctl enable 1shell
  systemctl restart 1shell

  sleep 3

  if curl -sf "http://localhost:${PORT}/api/auth/status" &>/dev/null; then
    log "原生部署成功!"
  else
    warn "服务可能还在启动中..."
    journalctl -u 1shell --no-pager -n 10
  fi
}

write_env() {
  if [[ -f ".env" ]]; then
    warn ".env 已存在，跳过覆盖（如需重置请先删除 .env）"
    return
  fi

  cat > .env << ENVEOF
OPENAI_API_BASE=https://api.openai.com/v1
OPENAI_API_KEY=sk-your-api-key-here
OPENAI_MODEL=gpt-4o
APP_SECRET=${APP_SECRET}
APP_LOGIN_USERNAME=admin
APP_LOGIN_PASSWORD=${PASSWORD}
PORT=${PORT}
BRIDGE_TOKEN=${BRIDGE_TOKEN}
LOG_LEVEL=info
ENVEOF

  chmod 600 .env
  log ".env 配置文件已生成"
}

setup_systemd() {
  cat > /etc/systemd/system/1shell.service << SVCEOF
[Unit]
Description=1Shell - One Shell to rule them all
After=network.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
ExecStart=$(which node) ${INSTALL_DIR}/server.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
SVCEOF

  log "systemd 服务已配置"
}

# ─── 执行部署 ─────────────────────────────────────────────────────────────

if $USE_DOCKER; then
  deploy_docker
else
  deploy_native
fi

# ─── 输出信息 ─────────────────────────────────────────────────────────────
LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")

echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║         1Shell 安装完成!                       ║${NC}"
echo -e "${GREEN}╠════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║  访问地址: http://${LOCAL_IP}:${PORT}${NC}"
echo -e "${GREEN}║  登录密码: ${PASSWORD}${NC}"
echo -e "${GREEN}║  安装目录: ${INSTALL_DIR}${NC}"
if $USE_DOCKER; then
echo -e "${GREEN}║  部署方式: Docker${NC}"
else
echo -e "${GREEN}║  部署方式: systemd 原生${NC}"
echo -e "${GREEN}║  管理命令: systemctl {start|stop|restart} 1shell${NC}"
echo -e "${GREEN}║  查看日志: journalctl -u 1shell -f${NC}"
fi
echo -e "${GREEN}╠════════════════════════════════════════════════╣${NC}"
echo -e "${YELLOW}║  请编辑 ${INSTALL_DIR}/.env 配置 AI API Key${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════╝${NC}"
echo ""
