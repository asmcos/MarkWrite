# 预览主题（VitePress 样式）

预览区使用与 VitePress 默认主题一致的样式（代码块、变量、字体等）。

## 如何更新样式

样式来自 [VitePress](https://github.com/vuejs/vitepress) 仓库的 `src/client/theme-default/styles/`，**无需安装 vitepress 包**，用脚本拉取即可：

```bash
npm run sync-preview-theme
```

会从 GitHub 拉取以下文件到本目录：

- `base.css`, `vars.css`, `fonts.css`, `icons.css`, `utils.css`
- `components/custom-block.css`, `vp-code.css`, `vp-doc.css`, `vp-code-group.css`, `vp-sponsor.css`

拉取完成后重启应用即可生效。

## 手动复制（可选）

若网络不可用，可手动从本地 VitePress 项目复制：将 `node_modules/vitepress` 中对应路径下的上述文件复制到本目录相同结构即可。
