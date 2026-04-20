FROM node:20-slim

# node-pty / better-sqlite3 编译依赖
# 某些 VPS 的 Docker build 默认网络无法正确继承宿主机 DNS，
# compose 中已显式使用 build.network=host 以避免 apt 源解析失败。
# 运行时工具：openssl（证书解析）、procps（pgrep）、curl、cron（crontab -l）——
# site-scan / container 管理脚本在"本机"模式下需要这些二进制。
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    pkg-config \
    openssl \
    procps \
    curl \
    cron \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先复制依赖清单，利用 Docker 缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# 数据目录（挂载卷持久化）
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3301

ENV NODE_ENV=production

CMD ["node", "server.js"]
