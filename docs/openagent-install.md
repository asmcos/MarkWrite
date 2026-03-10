# OpenAgent 安装说明

流程是**两步合一**：先用命令从 GitHub 拉取 openagent，再用本地的 `file:` 依赖安装，两者都保留在工程里。

- **从 GitHub 取**：`preinstall` 会自动执行 `openagent:clone`（若目录不存在才克隆）。
- **用 file 装**：`package.json` 里写的是 `file:./openagent-repo/packages/core` 和 `file:./openagent-repo/packages/app`，兼容 npm 和 Yarn。

## API Key 配置（与 openagent-example.mjs 一致）

**apiKey 写在 config.json 里**，在对应 provider 的 `options.apiKey` 中填写即可（环境变量可覆盖）。

- MarkWrite 使用的 config：在 **userData 目录**（或设置中的 `openagent.configPath`）下的 `config.json`。首次运行若无该文件会自动生成一份模板，请打开后把 `"apiKey": "在此填写你的 API Key"` 改成你的真实 Key。
- 命令行示例：在项目根目录放 `config.json`，可复制 `config.example.json` 为 `config.json` 再修改其中的 `apiKey`。

## 安装步骤

直接安装即可（会自动从 GitHub 克隆 openagent，再按 file 依赖安装）：

```bash
npm install
# 或
yarn install
```

若想**只克隆不安装**，可单独执行：

```bash
npm run openagent:clone
```

（若 `openagent-repo` 已存在，该命令不会重复克隆。）

## 运行示例

```bash
node openagent-example.mjs
```

注意：`openagent-repo` 已在 `.gitignore` 中忽略，不会提交到仓库。若以后要更新 OpenAgent，可进入 `openagent-repo` 执行 `git pull`，再重新 `npm install` 或 `yarn install`。
