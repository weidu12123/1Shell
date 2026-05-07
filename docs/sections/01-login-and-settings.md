# 板块一：登录与系统设置

---

## 1. 登录

### 1.1 访问面板

启动 1Shell 后，在浏览器中打开：

```
http://服务器IP:3301
```

如果是本机运行，直接访问 `http://localhost:3301`。

### 1.2 登录界面

登录页面包含两个输入框：

- **用户名** — 默认 `admin`
- **密码** — 默认 `admin`

输入后点击「登录」进入主界面。

### 1.3 首次登录注意事项

- **请立即修改默认密码**，方法见下方「账号设置」
- 如果通过 HTTP（非 HTTPS）+ 非 localhost 地址访问，部分浏览器可能会拦截 Cookie，导致登录后无法进入主界面。解决方案：
  - 推荐：配置域名 + SSL 证书，通过 HTTPS 访问
  - 临时：在浏览器设置中允许该站点使用 Cookie

### 1.4 暴力破解防护

同一 IP 连续登录失败 **5 次**后，自动锁定 **60 秒**，期间该 IP 的任何登录请求都会被拒绝。锁定到期后自动解除。

### 1.5 退出登录

点击右上角的「退出」按钮即可退出登录，会话立即失效。

---

## 2. 系统设置

点击主界面左下角的 **「⚙ 设置」** 按钮，弹出系统设置窗口。

设置窗口包含两个标签页：

### 2.1 账号设置

可以修改登录的用户名和密码。

| 字段 | 说明 |
|------|------|
| **用户名** | 新的登录用户名 |
| **新访问口令** | 新密码，留空表示不修改 |
| **确认新访问口令** | 再次输入新密码，两次必须一致 |

点击「保存设置」即时生效，**无需重启服务**。修改后会同时更新 `.env` 文件中的 `APP_LOGIN_USERNAME` 和 `APP_LOGIN_PASSWORD`。

### 2.2 IP 访问控制

控制哪些 IP 可以访问 1Shell 面板。

**白名单模式：**
- 开启后，只有名单中的 IP 可以访问
- 其他所有 IP 的请求都会被拒绝

**黑名单模式：**
- 开启后，名单中的 IP 无法访问
- 其他 IP 正常访问

两种模式可以同时使用。

**添加规则：**
1. 选择类型（白名单 / 黑名单）
2. 输入 IP 地址或 CIDR 格式网段（如 `192.168.1.0/24`）
3. 可选填写备注
4. 点击「添加」

已添加的规则在下方列表中展示，可随时删除。

---

## 3. AI API 配置

在主界面中找到 **AI 配置**入口（通常在 AI 功能区域附近），弹出 AI API 配置窗口。

| 字段 | 说明 | 示例 |
|------|------|------|
| **API 基础地址** | OpenAI 兼容 API 的地址，不含 `/chat/completions` | `https://api.openai.com/v1` |
| **API Key** | 对应服务商的 API 密钥 | `sk-xxxx...` |
| **模型名称** | 要使用的模型，可手动输入或点击「获取模型」自动拉取 | `gpt-4o` |

**兼容的 API 服务商：**
- OpenAI（官方）
- DeepSeek
- OpenRouter
- 任何兼容 OpenAI Chat Completions 格式的服务

点击「获取模型」按钮，会自动调用 API 拉取该服务商支持的模型列表，填入下拉框供选择。

配置完成后点击「保存」，所有 AI 功能（AI Chat、Ghost Text、命令建议、选区分析、1Shell AI、运维程序 AI 引擎）立即生效。

---

## 4. 环境变量配置（.env 文件）

除了在 Web UI 中配置，也可以直接编辑项目根目录下的 `.env` 文件。首次运行时会自动从 `.env.example` 复制一份。

### 4.1 完整变量说明

| 变量 | 必填 | 说明 | 默认值 |
|------|------|------|--------|
| `APP_LOGIN_USERNAME` | 否 | 登录用户名 | `admin` |
| `APP_LOGIN_PASSWORD` | **建议** | 登录密码，生产环境必须修改 | `admin` |
| `APP_SECRET` | **是** | 会话加密密钥，用于 SSH 凭据的 AES-256-GCM 加密存储 | 无 |
| `APP_SESSION_TTL_HOURS` | 否 | 登录会话有效期（小时） | `12` |
| `PORT` | 否 | 服务监听端口 | `3301` |
| `OPENAI_API_BASE` | 否 | AI API 基础地址 | `https://api.openai.com/v1` |
| `OPENAI_API_KEY` | 否 | AI API 密钥 | 无 |
| `OPENAI_MODEL` | 否 | AI 使用的模型名称 | `gpt-4o` |
| `BRIDGE_TOKEN` | 否 | MCP / Bridge API 鉴权 Token，启用 MCP 时必填 | 无 |
| `BRIDGE_EXEC_TIMEOUT_MS` | 否 | Bridge 命令执行超时（毫秒） | `30000` |
| `AGENT_DEFAULT_PROVIDER` | 否 | 默认 AI Agent 类型 | `claude-code` |
| `LOG_LEVEL` | 否 | 日志级别：debug / info / warn / error | `info` |
| `PROBE_TIMEOUT_MS` | 否 | 探针超时（毫秒） | `12000` |
| `PROBE_INTERVAL_MS` | 否 | 探针轮询间隔（毫秒） | `15000` |
| `PROBE_REMOTE_CONCURRENCY` | 否 | 远程探针并发数 | `3` |
| `TRUSTED_PROXY_IPS` | 否 | 受信任反向代理 IP，用于正确获取客户端真实 IP | 无 |

### 4.2 修改方式

```bash
# 用任意文本编辑器编辑
nano .env      # Linux
notepad .env   # Windows
```

修改 `.env` 后需要**重启 1Shell 才能生效**（Web UI 中修改的账号密码除外，那个是即时生效的）。

### 4.3 安全提示

- `APP_SECRET` 请设置为 64 位以上的随机字符串，用于加密存储 SSH 凭据
- `APP_LOGIN_PASSWORD` 生产环境请务必修改，不要使用默认的 `admin`
- `BRIDGE_TOKEN` 如果启用了 MCP 功能，请设置为高强度随机字符串
- `.env` 文件包含敏感信息，不要提交到版本控制（已在 `.gitignore` 中排除）
