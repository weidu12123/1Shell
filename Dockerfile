FROM node:20-slim

# node-pty 编译依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先复制依赖清单，利用 Docker 缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# 安装 AI CLI 工具（Agent 面板需要在容器内找到这些命令）
RUN npm install -g @anthropic-ai/claude-code

# 数据目录（挂载卷持久化）
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3301

ENV NODE_ENV=production

CMD ["node", "server.js"]
