'use strict';

/**
 * AI 后端配置模块：负责读写 MarkWrite 的「AI 相关」配置（选用哪个后端、模型等）。
 * 配置保存在用户数据目录下的 markwrite-ai-config.json，与环境变量合并后供 backends 使用。
 */

const fs = require('fs');
const path = require('path');

/** 配置文件名，位于 Electron userData 目录下（如 Linux ~/.config/MarkWrite/markwrite-ai-config.json） */
const CONFIG_FILENAME = 'markwrite-ai-config.json';

/**
 * 读取 AI 后端配置：优先环境变量，再合并配置文件（用户可编辑）。
 * 配置文件路径：userDataPath / markwrite-ai-config.json
 *
 * @param {string} [userDataPath] - Electron app.getPath('userData')
 * @returns {{ backend: string, openagent: object, openclaw?: object }}
 */
function getAiConfig(userDataPath) {
  const fromEnv = {
    backend: process.env.MARKWRITE_AI_BACKEND || 'openagent',
    openagent: {
      providerKey: process.env.OPENAGENT_PROVIDER || 'volcengine',
      modelId: process.env.OPENAGENT_MODEL || null,
      configPath: null,
    },
    openclaw: {},
  };

  if (!userDataPath) return fromEnv;

  const configPath = path.join(userDataPath, CONFIG_FILENAME);
  let fromFile = {};
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf8');
      fromFile = JSON.parse(raw);
    }
  } catch (_) {}

  return {
    backend: fromFile.backend || fromEnv.backend,
    openagent: { ...fromEnv.openagent, ...fromFile.openagent },
    openclaw: { ...fromEnv.openclaw, ...fromFile.openclaw },
  };
}

/**
 * 写入当前配置到用户目录（供设置界面保存用）。
 * @param {string} userDataPath
 * @param {object} config - 同 getAiConfig 返回结构
 */
function saveAiConfig(userDataPath, config) {
  if (!userDataPath) return;
  const configPath = path.join(userDataPath, CONFIG_FILENAME);
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  } catch (e) {
    console.error('saveAiConfig failed:', e.message);
  }
}

module.exports = { getAiConfig, saveAiConfig, CONFIG_FILENAME };
