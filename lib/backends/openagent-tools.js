'use strict';

/**
 * MarkWrite 自定义 tools：支持 AI SDK（OpenAgent 原版）与 LangChain 两种格式。
 * - registerMarkWriteTools(registry, options)：向 ToolRegistry 注册（AI SDK 格式）
 * - getMarkWriteToolsForLangChain(options)：返回 LangChain 格式的 tools 数组，供 LangChain agent 使用
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * 在 main 进程中通过 Electron 从当前焦点窗口获取编辑框内容（若未注入 getEditorContent）。
 * @returns {{ content: string, filename: string }}
 */
async function getEditorContentFromRenderer() {
  try {
    const { BrowserWindow } = require('electron');
    const w = BrowserWindow.getFocusedWindow();
    if (!w || !w.webContents) return { content: '', filename: '' };
    const result = await w.webContents.executeJavaScript(`
      (function() {
        var getContent = window.__markwrite_getEditorContent;
        var getFilename = window.__markwrite_getEditorFilename;
        if (typeof getContent !== 'function') return { content: '', filename: '' };
        return { content: getContent(), filename: typeof getFilename === 'function' ? getFilename() : '' };
      })()
    `).catch(() => ({ content: '', filename: '' }));
    return result && typeof result === 'object' ? result : { content: '', filename: '' };
  } catch (_) {
    return { content: '', filename: '' };
  }
}

/**
 * 注册 MarkWrite 自定义 tools 到 OpenAgent 的 registry。
 * @param {object} registry - ToolRegistry 实例
 * @param {{ applyBaseUrl?: string, getEditorContent?: () => Promise<{ content: string, filename: string }> }} options - applyBaseUrl 为 MarkWrite 的 base URL；getEditorContent 可选，不传则尝试从 Electron 窗口读取
 */
async function registerMarkWriteTools(registry, options = {}) {
  let applyBaseUrl = options.applyBaseUrl;
  if (!applyBaseUrl) {
    const applyUrlPath = path.join(process.env.HOME || process.env.USERPROFILE || '', '.config', 'markwrite', 'apply-url');
    if (fs.existsSync(applyUrlPath)) {
      applyBaseUrl = (fs.readFileSync(applyUrlPath, 'utf8') || '').trim().replace(/\/$/, '');
    }
  }

  const getEditorContent = options.getEditorContent || getEditorContentFromRenderer;
  const { tool } = await import('ai');
  const { z } = await import('zod');

  // 先读取编辑框内容，再分析/改错/润色时由 Agent 主动调用，不依赖请求里是否带了全文
  registry.register(
    'markwrite_get_editor_content',
    tool({
      description: '获取当前 MarkWrite 编辑框中的完整正文与文件名。在润色、改写、改错、升级、分析当前编辑内容之前，必须先调用本工具拿到当前内容，再基于该内容进行分析或修改，最后用 markwrite_apply_content 回写。',
      parameters: z.object({}),
      execute: async () => {
        const { content, filename } = await getEditorContent();
        return { content: content || '', filename: filename || '未命名' };
      },
    })
  );

  // 将编辑框内容保存到指定文件：内部先读取编辑框再写入，避免存成空文件
  registry.register(
    'markwrite_save_editor_to_file',
    tool({
      description: '将当前 MarkWrite 编辑框中的全部内容保存到指定文件。保存前会先读取编辑框内容再写入磁盘，确保文件包含编辑框的当前内容。仅用于用户明确要求“把编辑框内容存成 xxx 文件”“保存编辑框到 xxx”等场景；不要用 write_file 去存编辑框内容（write_file 无法可靠获取编辑框当前内容，容易存成空文件）。',
      parameters: z.object({ path: z.string().describe('目标文件路径，可为绝对路径或相对当前工作区根目录的路径（默认 ~/markwrite-docs 或左侧打开的工作区），例如 1245.txt 或 notes/today.md') }),
      execute: async ({ path: targetPath }) => {
        const { content } = await getEditorContent();
        const p = (targetPath || '').trim();
        if (!p) return { ok: false, message: '未指定保存路径' };
        const workspaceRootPath = getWorkspaceRoot();
        const absolutePath = path.isAbsolute(p) ? p : path.join(workspaceRootPath, p);
        try {
          fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
          fs.writeFileSync(absolutePath, content || '', 'utf8');
          const basename = path.basename(absolutePath);
          return { ok: true, path: absolutePath, message: `已成功将当前编辑框内容保存为 ${basename}，存储路径为：${absolutePath}` };
        } catch (e) {
          return { ok: false, message: (e && e.message) ? e.message : String(e) };
        }
      },
    })
  );

  if (applyBaseUrl) {
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
}

/**
 * 解析 applyBaseUrl（与 registerMarkWriteTools 相同逻辑）
 */
function getApplyBaseUrl(options = {}) {
  let applyBaseUrl = options.applyBaseUrl;
  if (!applyBaseUrl) {
    const applyUrlPath = path.join(process.env.HOME || process.env.USERPROFILE || '', '.config', 'markwrite', 'apply-url');
    if (fs.existsSync(applyUrlPath)) {
      applyBaseUrl = (fs.readFileSync(applyUrlPath, 'utf8') || '').trim().replace(/\/$/, '');
    }
  }
  return applyBaseUrl;
}

/**
 * 返回 LangChain 格式的 MarkWrite 工具数组（DynamicStructuredTool），供 LangChain agent 使用。
 * @param {{ applyBaseUrl?: string, getEditorContent?: () => Promise<{ content: string, filename: string }> }} [options]
 * @returns {Promise<import('@langchain/core/tools').StructuredToolInterface[]>}
 */
async function getMarkWriteToolsForLangChain(options = {}) {
  const applyBaseUrl = getApplyBaseUrl(options);
  const getEditorContent = options.getEditorContent || getEditorContentFromRenderer;
  const { DynamicStructuredTool } = await import('@langchain/core/tools');
  const { z } = await import('zod');

  const tools = [];

  tools.push(
    new DynamicStructuredTool({
      name: 'markwrite_get_editor_content',
      description: '获取当前 MarkWrite 编辑框中的完整正文与文件名。在润色、改写、改错、升级、分析当前编辑内容之前，必须先调用本工具拿到当前内容，再基于该内容进行分析或修改，最后用 markwrite_apply_content 回写。',
      schema: z.object({}),
      func: async () => {
        const { content, filename } = await getEditorContent();
        return JSON.stringify({ content: content || '', filename: filename || '未命名' });
      },
    })
  );

  tools.push(
    new DynamicStructuredTool({
      name: 'markwrite_save_editor_to_file',
      description: '将当前 MarkWrite 编辑框中的全部内容保存到指定文件。保存前会先读取编辑框内容再写入磁盘，确保文件包含编辑框的当前内容。仅用于用户明确要求“把编辑框内容存成 xxx 文件”“保存编辑框到 xxx”等场景。',
      schema: z.object({ path: z.string().describe('目标文件路径，可为绝对路径或相对当前工作区根目录的路径（默认 ~/markwrite-docs 或左侧打开的工作区），例如 1245.txt 或 notes/today.md') }),
      func: async ({ path: targetPath }) => {
        const { content } = await getEditorContent();
        const p = (targetPath || '').trim();
        if (!p) return JSON.stringify({ ok: false, message: '未指定保存路径' });
        const workspaceRootPath = getWorkspaceRoot();
        const absolutePath = path.isAbsolute(p) ? p : path.join(workspaceRootPath, p);
        try {
          fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
          fs.writeFileSync(absolutePath, content || '', 'utf8');
          const basename = path.basename(absolutePath);
          return JSON.stringify({ ok: true, path: absolutePath, message: `已成功将当前编辑框内容保存为 ${basename}，存储路径为：${absolutePath}` });
        } catch (e) {
          return JSON.stringify({ ok: false, message: (e && e.message) ? e.message : String(e) });
        }
      },
    })
  );

  if (applyBaseUrl) {
    tools.push(
      new DynamicStructuredTool({
        name: 'markwrite_apply_content',
        description: '润色或修改当前编辑框中的内容。仅用于操作编辑器内正文：传入修改后的完整正文，MarkWrite 会提示用户确认后再替换到编辑框。',
        schema: z.object({ content: z.string().describe('修改后的完整正文，将经用户确认后应用到编辑框') }),
        func: async ({ content }) => {
          const url = `${applyBaseUrl}/apply-content`;
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: content || '' }),
          });
          if (!res.ok) return JSON.stringify({ ok: false, message: `HTTP ${res.status}` });
          return JSON.stringify({ ok: true, message: '已应用到 MarkWrite 编辑器' });
        },
      })
    );
  }

  return tools;
}

// 当前工作区根目录：优先读取 main 进程记录在 ~/.config/markwrite/workspace-root 的目录；
// 若无效或指向应用自身目录，则退回默认 ~/markwrite-docs，最后再退回进程工作目录
function getWorkspaceRoot() {
  const cfgDir = path.join(os.homedir(), '.config', 'markwrite');
  const workspaceFile = path.join(cfgDir, 'workspace-root');
  const defaultWorkspace = path.join(os.homedir(), 'markwrite-docs');
  try {
    if (fs.existsSync(workspaceFile)) {
      const p = (fs.readFileSync(workspaceFile, 'utf8') || '').trim();
      const appRoot = process.cwd();
      if (p && fs.existsSync(p) && fs.statSync(p).isDirectory() && !p.startsWith(appRoot)) {
        return p;
      }
    }
  } catch (_) {}
  try {
    if (fs.existsSync(defaultWorkspace) && fs.statSync(defaultWorkspace).isDirectory()) {
      return defaultWorkspace;
    }
  } catch (_) {}
  return process.cwd();
}

module.exports = { registerMarkWriteTools, getMarkWriteToolsForLangChain };
