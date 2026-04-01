# MarkWrite 使用说明书

## 安装与运行

### 1) 克隆项目

```bash
git clone https://github.com/asmcos/MarkWrite
cd MarkWrite
```

### 2) 安装依赖

```bash
npm install
```

### 3) 初始化（同步主题、构建前端与 vendor）

```bash
npm run setup
```

### 4) 启动应用

```bash
npm run start
```

## 概述

MarkWrite 是一个用于编辑 Markdown 文件的桌面编辑器，提供简洁的编辑界面与**智能体辅助**能力。AI 能力基于自研 **OpenAgent** 框架，支持对话润色、文档修改及文件操作（创建/读/写/搜等），可在右侧 Chat 面板中直接使用。

## 主要功能

### 文件操作
- **打开文件**: 弹出文件选择对话框，选择 Markdown 文件打开
- **保存文件**: 将当前编辑内容保存到原文件
- **另存为**: 将当前文件另存为新文件

### 编辑功能
- **Markdown 支持**: 完全支持标准 Markdown 语法
- **实时预览**: 可以在编辑同时查看渲染效果
- **语法高亮**: Markdown 语法组件自动高亮显示

### 智能体辅助（OpenAgent）

MarkWrite 集成 **自研 OpenAgent 框架**，在编辑器右侧提供 AI 对话与智能操作能力，无需单独启动外部服务。

- **聊天 / 润色**：与 AI 对话、对当前文档进行润色、修改、改写、翻译等；AI 可返回修改后的全文，经你**确认后再替换**到编辑框。
- **命令 / 文件操作**：通过自然语言指示 AI 执行**文件级操作**，如创建文件、读取/修改/删除文件、列目录、按内容搜索等，由 OpenAgent 的 tools（如 `read_file`、`write_file`）直接完成，无需再确认。
- **模型与配置**：支持多模型切换（如火山引擎 Ark、Ollama 等），配置写在项目或用户目录的 `config.json`（API Key 等）与 `markwrite-ai-config.json`（后端与模型选择）。详见 `docs/openagent-install.md` 与 `lib/README.md`。
  - **模型下拉框来源**：右侧「模型」列表会从 `config.json` 读取 providers/models 动态生成（不再写死 opencode）。修改 `config.json` 后重启 MarkWrite 即可刷新。

## 配置

MarkWrite 提供了基本配置选项：

- **主题**: 支持浏览式和黑色主题
- **字体大小**: 可调节编辑区域字体大小
- **表格格式**: 支持自动表格格式化

## 数据安全

- **保存机制**: 当前为手动保存（`保存` / `另存为`）与创作页草稿保存，不含定时自动保存
- **垃圾回收**: 不会自动清理文件，保持数据完整性

## 技术信息

- **平台**: 支持跨平台操作系统
- **文件格式**: 主要支持 .md 文件格式
- **编码**: 使用 UTF-8 编码