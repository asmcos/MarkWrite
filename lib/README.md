# AI 后端模块

Chat 使用的 AI 后端为**可配置、可插拔**：用户可选择 OpenCode、或后续接入 OpenClaw 等，无需改业务代码。

## 配置方式

1. **环境变量**（优先）
   - `MARKWRITE_AI_BACKEND`：`opencode` | `openclaw`（默认 `opencode`）
   - `OPENCODE_URL`：OpenCode 服务地址（默认 `http://127.0.0.1:4096`）
   - `MARKWRITE_OPENCODE_AUTOSTART`：设为 `0` 可禁止未连接时自动启动本地 OpenCode
   - `MARKWRITE_OPENCODE_SERVE_EXECUTABLE`：自启时调用的命令（默认 `opencode`，会自行解析到 `.opencode`；仅在需要时改为完整路径）
   - `MARKWRITE_OPENCODE_SERVE_HOSTNAME`：自启时的 `--hostname`（默认 `127.0.0.1`）

2. **配置文件**（用户可编辑）
   - 路径：`Electron userData / markwrite-ai-config.json`
   - 示例：
   ```json
   {
     "backend": "opencode",
     "opencode": {
       "baseUrl": "http://127.0.0.1:4096",
       "autoStart": true,
       "serveExecutable": "opencode",
       "serveHostname": "127.0.0.1",
      "model": { "providerID": "opencode", "modelID": "gpt-5-nano" }
     }
   }
   ```
  - **模型**：默认使用 OpenCode 云端 `gpt-5-nano`（也可在界面 Chat 面板下拉框切换）；若已配置 Ollama（OpenCode 端 `baseURL: "http://127.0.0.1:11434/v1"`），可切换为对应模型。
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

## OpenCode 自启不成功时（npm start 后 ps 看不到 opencode）

1. **在终端运行** `npm start`（不要从桌面/菜单点图标），触发一次 AI（发一条消息或等界面加载），看终端是否出现：
   - `[MarkWrite] >>> 即将执行 startServerAndWait(port=4096, 20000ms) <<<` → 说明已执行到自启逻辑；
   - `[MarkWrite] OpenCode spawn 失败: ENOENT` → 未找到 `opencode` 命令，需配置 `serveExecutable` 为可执行文件绝对路径（如 `~/.npm-global/lib/node_modules/opencode-ai/bin/.opencode`）。
2. **配置可执行文件路径**：在 `markwrite-ai-config.json` 的 `opencode` 里设置 `"serveExecutable": "/你的路径/.opencode"`，或环境变量 `MARKWRITE_OPENCODE_SERVE_EXECUTABLE`。
3. **看子进程输出**：运行 `DEBUG_OPENCODE=1 npm start`，终端会打印 opencode 子进程的 stderr，便于排查启动失败原因。
