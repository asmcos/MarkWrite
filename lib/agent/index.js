'use strict';

/**
 * MarkWrite 智能文档 Agent 框架
 *
 * 实现 12 步流程：
 * 1. 用户输入
 * 2. 入口接收 (prompt)
 * 3. 创建 User 消息
 * 4. loop 开始
 * 5. resolveTools (read, edit, write)
 * 6. LLM.stream
 * 7. 模型调用 read
 * 8. 执行 ReadTool
 * 9. 模型调用 edit
 * 10. 执行 EditTool
 * 11. finish-step
 * 12. 退出循环
 *
 * 当前通过 OpenCode 的 session.prompt 实现（OpenCode 内部已含完整 loop + tools）
 */
const { runDocAgent } = require('./loop.js');
const { buildSystemPrompt } = require('./prompt.js');
const { TOOL_DEFS, readFile, editFile, writeFile } = require('./tools.js');

module.exports = {
  runDocAgent,
  buildSystemPrompt,
  TOOL_DEFS,
  tools: { readFile, editFile, writeFile },
};
