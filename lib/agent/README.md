# MarkWrite 智能文档 Agent 框架

实现完整的 12 步 Agent 流程，用于智能编写、修改、润色文档。

## 流程概览

```
1. 用户输入
2. 入口接收 (prompt)
3. 创建 User 消息
4. loop 开始
5. resolveTools (read, edit, write)
6. LLM.stream
7. 模型调用 read
8. 执行 ReadTool
9. 模型调用 edit
10. 执行 EditTool
11. finish-step
12. 退出循环
```

## 目录结构

```
lib/agent/
├── index.js   # 入口，导出 runDocAgent、tools、prompt
├── loop.js    # Agent 主循环，委托 OpenCode session.prompt
├── prompt.js  # 系统提示词（工具优先）
├── tools.js   # 工具定义（read/edit/write）
└── README.md
```

## 使用方式

- **有打开文件时**：自动使用 `docEdit`（工具模式），AI 通过 read/edit/write 直接操作文件
- **无打开文件时**：使用 `chat`（对话模式），AI 返回文本

## 依赖

当前通过 OpenCode 的 `session.prompt` 实现完整 loop，OpenCode 内部已包含 tools 与 12 步流程。
