## MarkWrite

本地优先的 **Markdown 桌面编辑器**，基于 **Monaco Editor**（与 VS Code 同源编辑器）+ Electron，支持打开 / 保存 / 另存为，后续可接 **opencode / openclaw** 做 AI 辅助写作。

### 功能

- **编辑**：Monaco 编辑器，Markdown 语法高亮、多光标、查找替换等
- **打开 / 保存 / 另存为**：通过顶部按钮或后续快捷键，读写本地 .md 等文件
- **布局**：左侧工作区（占位）、中间编辑区、右侧 AI 面板（占位，待接 opencode/openclaw）

### 运行

```bash
npm install
npm start
```

启动后使用顶部 **打开**、**保存**、**另存为** 操作文件。

### 技术栈

- Electron（窗口 + 本地文件 API）
- Monaco Editor（编辑）
- 纯 HTML/CSS/JS，无打包步骤

### 后续可做

- 左侧真实文件树、多标签
- AI 面板接入 opencode / openclaw，对话式重命名、重组文档
- 快捷键（如 Ctrl+S 保存）
