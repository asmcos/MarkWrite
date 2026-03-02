# AI 后端模块

Chat 使用的 AI 后端为**可配置、可插拔**：用户可选择 OpenCode、或后续接入 OpenClaw 等，无需改业务代码。

## 配置方式

1. **环境变量**（优先）
   - `MARKWRITE_AI_BACKEND`：`opencode` | `openclaw`（默认 `opencode`）
   - `OPENCODE_URL`：OpenCode 服务地址（默认 `http://127.0.0.1:4096`）
   - `MARKWRITE_OPENCODE_AUTOSTART`：设为 `0` 可禁止未连接时自动启动本地 OpenCode

2. **配置文件**（用户可编辑）
   - 路径：`Electron userData / markwrite-ai-config.json`
   - 示例：
   ```json
   {
     "backend": "opencode",
     "opencode": {
       "baseUrl": "http://127.0.0.1:4096",
       "autoStart": true
     }
   }
   ```
   - 切换为其他后端时，将 `backend` 改为 `openclaw`（待实现）即可；各后端有独立配置块（`opencode`、`openclaw` 等）。

## 目录结构

- `ai-config.js`：读取/写入配置（环境变量 + 配置文件）
- `backends/opencode.js`：OpenCode 对接（连接、会话、自动启动、清理）
- `backends/index.js`：根据配置返回当前后端适配器（统一接口：`chat`、`health`、`cleanup`）

## 新增后端（如 OpenClaw）

1. 在 `backends/` 下新增 `openclaw.js`，实现 `chat(text)`、`health()`、`cleanup()`，并导出。
2. 在 `backends/index.js` 的 `getBackend()` 中增加 `config.backend === 'openclaw'` 分支，传入 `config.openclaw` 并返回该适配器。
3. 在 `ai-config.js` 的默认配置中增加 `openclaw: { ... }` 默认项。

主进程仅依赖 `getBackend(userDataPath)`，不直接依赖具体后端。
