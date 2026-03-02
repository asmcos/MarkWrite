'use strict';

const { getAiConfig } = require('../ai-config.js');
const opencode = require('./opencode.js');

/**
 * 根据当前配置返回对应的 AI 后端适配器。
 * 适配器统一接口：{ chat(text), health(), cleanup() }
 *
 * @param {string} [userDataPath] - Electron userData 路径，用于读配置
 * @returns {{ chat: Function, health: Function, cleanup: Function }}
 */
function getBackend(userDataPath) {
  const config = getAiConfig(userDataPath);

  if (config.backend === 'opencode') {
    opencode.configure(config.opencode || {});
    return {
      chat: (text) => opencode.chat(text),
      health: () => opencode.health(),
      cleanup: () => opencode.cleanup(),
    };
  }

  if (config.backend === 'openclaw') {
    return {
      chat: async () => ({ error: 'OpenClaw 后端尚未实现，请在配置中改用 backend: "opencode" 或等待后续版本。' }),
      health: async () => ({ ok: false, message: 'OpenClaw 未实现' }),
      cleanup: () => {},
    };
  }

  return {
    chat: async () => ({ error: `未知后端: ${config.backend}。请在配置中设置 backend 为 "opencode" 或 "openclaw"。` }),
    health: async () => ({ ok: false, message: `未知后端: ${config.backend}` }),
    cleanup: () => {},
  };
}

module.exports = { getBackend };
