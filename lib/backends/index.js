'use strict';

const { getAiConfig } = require('../ai-config.js');
const openagent = require('./openagent.js');

/**
 * 根据当前配置返回对应的 AI 后端适配器。
 * 适配器统一接口：{ chat, docEdit, health, models, cleanup }
 *
 * @param {string} [userDataPath] - Electron userData 路径，用于读配置
 * @returns {{ chat: Function, docEdit: Function, health: Function, models: Function, cleanup: Function }}
 */
function getBackend(userDataPath) {
  const config = getAiConfig(userDataPath);
  const effectiveBackend = config.backend === 'opencode' ? 'openagent' : config.backend;
  const cfg = effectiveBackend === 'openagent'
    ? (config.openagent || config.opencode || {})
    : (config[effectiveBackend] || {});

  if (effectiveBackend === 'openagent') {
    openagent.configure({
      ...cfg,
      // 默认使用当前工作目录（MarkWrite 根目录）下的 config.json，
      // 若用户在配置中显式指定了 openagent.configPath，则优先生效。
      configPath: cfg.configPath || process.cwd(),
    });
    return {
      chat: (message, context) => openagent.chat(message, context),
      docEdit: (message, context) => openagent.docEdit(message, context),
      health: () => openagent.health(),
      models: (context) => openagent.models(context),
      cleanup: () => openagent.cleanup(),
    };
  }

  if (config.backend === 'openclaw') {
    return {
      chat: async () => ({ error: 'OpenClaw 后端尚未实现，请在配置中改用 backend: "openagent"。' }),
      docEdit: async () => ({ error: 'OpenClaw 后端尚未实现' }),
      health: async () => ({ ok: false, message: 'OpenClaw 未实现' }),
      models: async () => ({ error: 'OpenClaw 未实现' }),
      cleanup: () => {},
    };
  }

  return {
    chat: async () => ({ error: `未知后端: ${config.backend}。请在配置中设置 backend 为 "openagent" 或 "openclaw"。` }),
    docEdit: async () => ({ error: `未知后端: ${config.backend}` }),
    health: async () => ({ ok: false, message: `未知后端: ${config.backend}` }),
    models: async () => ({ error: `未知后端: ${config.backend}` }),
    cleanup: () => {},
  };
}

module.exports = { getBackend };
