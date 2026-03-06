'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_FILENAME = 'markwrite-ai-config.json';

/**
 * 读取 AI 后端配置：优先环境变量，再合并配置文件（用户可编辑）。
 * 配置文件路径：userDataPath / markwrite-ai-config.json
 *
 * @param {string} [userDataPath] - Electron app.getPath('userData')
 * @returns {{ backend: string, opencode: object, openclaw?: object }}
 */
function getAiConfig(userDataPath) {
  const fromEnv = {
    backend: process.env.MARKWRITE_AI_BACKEND || 'opencode',
    opencode: {
      baseUrl: process.env.OPENCODE_URL || 'http://127.0.0.1:4096',
      autoStart: process.env.MARKWRITE_OPENCODE_AUTOSTART !== '0',
      serveExecutable: process.env.MARKWRITE_OPENCODE_SERVE_EXECUTABLE || null,
      serveHostname: process.env.MARKWRITE_OPENCODE_SERVE_HOSTNAME || '127.0.0.1',
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
    opencode: { ...fromEnv.opencode, ...fromFile.opencode },
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
