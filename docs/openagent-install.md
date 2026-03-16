# OpenAgent 安装说明

本项目通过 **Git 依赖** 引入 OpenAgent：`package.json` 中 `openagent` 为 `git+https://github.com/asmcos/openagent.git`，`@openagent/app` 与 `@openagent/core` 通过 `file:./node_modules/openagent/packages/...` 引用克隆后的子包。

- **默认安装**：执行 `npm install` 时会使用 `package-lock.json` 里**锁定的提交**，因此装到的是安装当时锁定的版本（可能是较旧的）。
- **获取最新 OpenAgent**：运行 `npm run update:openagent`，会从 GitHub 拉取默认分支最新提交并更新 `package-lock.json`，安装完成后即是最新版本。

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

**升级到最新 OpenAgent**：执行 `npm run update:openagent` 即可拉取并安装仓库默认分支的最新代码（首次或更新时可能需等待 Git 克隆）。当前锁定版本可在 `package-lock.json` 中搜索 `node_modules/openagent` 的 `resolved` 字段查看提交 hash。
