'use strict';

/**
 * MarkWrite 为 OpenAgent 注册的自定义 tools（编辑框润色/修改等）。
 * 后续新增 tool 在此文件添加即可，保持 openagent.js 只负责加载与创建 Agent。
 */

const path = require('path');
const fs = require('fs');

/**
 * 注册 MarkWrite 自定义 tools 到 OpenAgent 的 registry。
 * @param {object} registry - ToolRegistry 实例
 * @param {{ applyBaseUrl?: string }} options - applyBaseUrl 为 MarkWrite 的 base URL（如 http://127.0.0.1:3131），用于 POST 到 /apply-content
 */
async function registerMarkWriteTools(registry, options = {}) {
  let applyBaseUrl = options.applyBaseUrl;
  if (!applyBaseUrl) {
    const applyUrlPath = path.join(process.env.HOME || process.env.USERPROFILE || '', '.config', 'markwrite', 'apply-url');
    if (fs.existsSync(applyUrlPath)) {
      applyBaseUrl = (fs.readFileSync(applyUrlPath, 'utf8') || '').trim().replace(/\/$/, '');
    }
  }
  if (!applyBaseUrl) return;

  const { tool } = await import('ai');
  const { z } = await import('zod');

  registry.register(
    'markwrite_apply_content',
    tool({
      description: '润色或修改当前编辑框中的内容。仅用于操作编辑器内正文：传入修改后的完整正文，MarkWrite 会提示用户确认后再替换到编辑框。不要用于创建/修改磁盘上的文件（创建或改文件请用 write_file、read_file 等）。',
      parameters: z.object({ content: z.string().describe('修改后的完整正文，将经用户确认后应用到编辑框') }),
      execute: async ({ content }) => {
        const url = `${applyBaseUrl}/apply-content`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: content || '' }),
        });
        if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
        return { ok: true, message: '已应用到 MarkWrite 编辑器' };
      },
    })
  );
}

module.exports = { registerMarkWriteTools };
