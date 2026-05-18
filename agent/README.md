# 1Shell Probe Agent

1Shell 探针的 Go 二进制 Agent，取代早期的 shell + curl 原型。

## 设计

- 主动上报：Agent 通过 HTTP POST 把指标推到 1Shell server / Relay
- 不暴露端口：对 NAT、内网、Relay 模式天然友好
- 采样精度对齐 dstatus：CPU、Net 用 0.1s 双采样
- v1 Linux only（amd64 / arm64）；Windows / macOS 后续

## 目录

- `cmd/agent` 入口 main
- `internal/collector` 采集 `/proc/*` 算指标
- `internal/reporter` HTTP 上报客户端
- `internal/config` 读取 `/etc/1shell-probe-agent.env`

## 构建

```sh
GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o dist/probe-agent-linux-amd64 ./cmd/agent
GOOS=linux GOARCH=arm64 go build -trimpath -ldflags="-s -w" -o dist/probe-agent-linux-arm64 ./cmd/agent
```

或者用上层项目脚本 `npm run build:agent`。

## 配置（运行时由 systemd `EnvironmentFile` 注入）

```
HOST_ID=...
SERVER_URL=https://1shell.example.com
AGENT_TOKEN=...
INTERVAL_SEC=30
```

## 上报接口（与 1Shell server 现有契约保持兼容）

`POST $SERVER_URL/api/agent/probe/report`，Bearer auth。
