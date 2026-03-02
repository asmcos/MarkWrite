# 预览主题（VitePress 样式）

预览区使用内置的 Markdown 渲染（与 VitePress 相同的代码块、mermaid 规则）。若要让**版式、字体、配色**与 VitePress 完全一致，请把 VitePress 项目里的样式复制到此目录。

目录结构需与下面一致（对应 `$lib/vitepress-assets/styles/`）：

```
preview-theme/
  base.css
  vars.css
  fonts.css
  icons.css
  utils.css
  components/
    custom-block.css
    vp-code.css
    vp-doc.css
    vp-code-group.css
    vp-sponsor.css
```

复制完成后重启应用即可。
