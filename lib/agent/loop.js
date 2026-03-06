'use strict';

/**
 * Agent Loop - 12 步流程
 *
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
 * 当前实现：委托给 OpenCode session.prompt，OpenCode 内部已实现完整 loop。
 * 本模块负责：构建正确的 prompt、传递 directory、解析响应、检测文件变更。
 */
const path = require('path');
const fs = require('fs').promises;
const { buildSystemPrompt } = require('./prompt.js');

/**
 * 通过 OpenCode 执行文档 Agent 流程
 * @param {Object} opts
 * @param {Function} opts.promptFn - (input) => Promise<response>，即 session.prompt 的封装
 * @param {string} opts.userMessage - 用户输入
 * @param {string} [opts.filePath] - 当前文档路径
 * @param {string} [opts.editorContent] - 编辑器当前内容（可选，用于无文件时的上下文）
 * @param {Object} [opts.model] - { providerID, modelID }
 * @returns {Promise<{ text: string, fileModified?: boolean, error?: string }>}
 */
async function runDocAgent(opts) {
  const { promptFn, userMessage, filePath, editorContent, model } = opts;
  if (!promptFn || typeof promptFn !== 'function') {
    return { error: 'promptFn 未提供' };
  }
  if (!userMessage || !userMessage.trim()) {
    return { error: '请输入内容' };
  }

  const workDir = filePath ? path.dirname(path.resolve(filePath)) : undefined;
  const filename = filePath ? path.basename(filePath) : '未命名';

  const systemPrompt = buildSystemPrompt({ filename, workDir });
  const userText = [
    '【用户指令】',
    userMessage.trim(),
    '',
    editorContent != null && editorContent !== ''
      ? '【当前编辑器内容（供参考，请用 read 工具读取磁盘上的最新内容后再修改）】'
      : '',
    editorContent != null && editorContent !== ''
      ? '---\n' + String(editorContent).slice(0, 15000) + (editorContent.length > 15000 ? '\n...(已截断)' : '') + '\n---'
      : '',
  ].filter(Boolean).join('\n');

  const parts = [{ type: 'text', text: userText }];
  const input = {
    parts,
    model: model || { providerID: 'opencode', modelID: 'trinity-large-preview-free' },
    directory: workDir,
    system: systemPrompt,
  };

  let fileModified = false;
  const contentBefore = filePath ? await readFileSafe(filePath) : null;

  try {
    const res = await promptFn(input);
    const data = res?.data ?? res;
    const partsOut = Array.isArray(data?.parts) ? data.parts : [];
    const textParts = partsOut.filter((p) => p && p.type === 'text' && p.text).map((p) => p.text);
    const toolParts = partsOut.filter((p) => p && p.type === 'tool');
    const hadEditOrWrite = toolParts.some(
      (p) => p.tool === 'edit' || p.tool === 'write'
    );
    if (hadEditOrWrite && filePath) {
      const contentAfter = await readFileSafe(filePath);
      fileModified = contentBefore !== contentAfter;
    }

    return {
      text: textParts.join('\n').trim() || '已完成。',
      fileModified,
    };
  } catch (e) {
    return {
      error: (e && e.message) ? e.message : String(e),
    };
  }
}

async function readFileSafe(filePath) {
  try {
    const c = await fs.readFile(filePath, 'utf8');
    return c;
  } catch (_) {
    return null;
  }
}

module.exports = { runDocAgent };
