# AI 后端模块

Chat 使用的 AI 后端为**可配置、可插拔**：默认使用 OpenAgent，或后续接入 OpenClaw 等，无需改业务代码。

## ai-config.js 与 markwrite-ai-config.json

- **作用**：`lib/ai-config.js` 负责**读取和保存** MarkWrite 的 AI 相关配置（选用哪个后端、当前模型等）。主进程和设置界面通过它统一读写，避免散落多处。
- **CONFIG_FILENAME**：常量 `markwrite-ai-config.json` 是配置**文件名**。完整路径 = `userDataPath` + 该文件名。例如：
  - Linux：`~/.config/MarkWrite/markwrite-ai-config.json`
  - macOS：`~/Library/Application Support/MarkWrite/markwrite-ai-config.json`
  - Windows：`%APPDATA%/MarkWrite/markwrite-ai-config.json`
- **读写**：`getAiConfig(userDataPath)` 读配置（环境变量 + 文件合并），`saveAiConfig(userDataPath, config)` 写回文件。界面里切换模型、后端时会调用 `saveAiConfig`，把当前选择写入该 JSON 文件。

## 配置方式

1. **环境变量**（优先）
   - `MARKWRITE_AI_BACKEND`：`openagent` | `openclaw`（默认 `openagent`）
   - `OPENAGENT_PROVIDER`：config.json 中的 provider key（如 `volcengine`、`ollama`）
   - `OPENAGENT_MODEL`：模型 ID（如 `deepseek-v3.2`）
   - 各 provider 的 API Key 等：如 `VOLCENGINE_API_KEY`、`VOLCENGINE_BASE_URL`、`VOLCENGINE_MODEL`（见 OpenAgent 文档）

2. **配置文件**（用户可编辑，由 ai-config 读写）
   - 路径：`userDataPath / markwrite-ai-config.json`（即 CONFIG_FILENAME）
   - 示例：
   ```json
   {
     "backend": "openagent",
     "openagent": {
       "providerKey": "volcengine",
       "modelId": "deepseek-v3.2",
       "configPath": null
     }
   }
   ```
   - **configPath**：不填则使用 userData 目录；该目录下需有 `config.json`（OpenAgent 格式，含 providers 与 models）。首次运行若无 `config.json` 会自动生成一份默认（volcengine）模板。
   - **模型**：界面 Chat 面板下拉框选择后，会写入 `openagent.model`（providerID/modelID），后端据此切换 provider 与 model。

## 目录结构

- `ai-config.js`：AI 配置模块。定义 `CONFIG_FILENAME`（`markwrite-ai-config.json`），提供 `getAiConfig` / `saveAiConfig`，读写 userData 下的该文件并与环境变量合并。
- `backends/openagent.js`：OpenAgent 对接（@openagent/core + @openagent/app，本地运行，无需独立服务）
- `backends/openagent-tools.js`：MarkWrite 自定义 tools（如 markwrite_apply_content），后续新增 tool 在此注册
- `backends/index.js`：根据配置返回当前后端适配器（统一接口：`chat`、`docEdit`、`health`、`models`、`cleanup`）

## 无文件名时润色/编辑（OpenAgent 工具）

当用户**未打开文件**（编辑器显示「未命名」）时，OpenAgent 后端会注册工具 `markwrite_apply_content`：将润色/修改后的全文 POST 到 MarkWrite 的 `/apply-content`。MarkWrite 启动时会把 base URL 写入 `~/.config/markwrite/apply-url`，供该工具读取。

## 使用火山引擎 Ark（CodingPlan / API）

在 userData 目录（或 `configPath`）的 `config.json` 中配置 volcengine provider（baseURL、apiKey、models），并在 `.env` 或环境中设置 `VOLCENGINE_API_KEY` 等。详见 `docs/openagent-install.md` 与 OpenAgent 仓库说明。

## 新增后端（如 OpenClaw）

1. 在 `backends/` 下新增实现文件，导出 `chat`、`docEdit`、`health`、`models`、`cleanup`、`configure`。
2. 在 `backends/index.js` 的 `getBackend()` 中增加对应分支，传入配置并返回适配器。
3. 在 `ai-config.js` 的默认配置中增加该后端的默认项。

主进程仅依赖 `getBackend(userDataPath)`，不直接依赖具体后端。
