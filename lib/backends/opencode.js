'use strict';

/**
 * OpenCode 后端：连接 OpenCode 服务，支持未启动时自动拉起本地服务。
 * 配置项：{ baseUrl, autoStart }，来自 ai-config 的 opencode 段。
 * 自启的进程会记录 child 与 pid，在 cleanup / 异常退出时关闭。
 */

const { spawn } = require('node:child_process');
const http = require('node:http');
const https = require('node:https');

let client = null;
let sessionId = null;
/** @type { import('node:child_process').ChildProcess | null } */
let serverChild = null;
/** @type { number | null } 自启进程的 PID，用于异常退出时补杀 */
let serverPid = null;
let options = {
  baseUrl: 'http://127.0.0.1:4096',
  autoStart: true,
  model: { providerID: 'opencode', modelID: 'trinity-large-preview-free' },
};
/** 最近一次连接失败原因，用于界面提示 */
let lastConnectError = '';

function getPortFromUrl(url) {
  try {
    const u = new URL(url);
    return u.port ? parseInt(u.port, 10) : 4096;
  } catch (_) {
    return 4096;
  }
}

function getHostFromUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname || '127.0.0.1';
  } catch (_) {
    return '127.0.0.1';
  }
}

/** 等待自启的 opencode 进程就绪，返回 baseUrl */
function startServerAndWait(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proc = spawn('opencode', ['serve', '--hostname=127.0.0.1', `--port=${port}`], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverChild = proc;
    serverPid = proc.pid;
    const timeout = setTimeout(() => {
      killServerProcess();
      reject(new Error(`OpenCode 服务在 ${timeoutMs}ms 内未就绪`));
    }, timeoutMs);
    let output = '';
    const onData = (chunk) => {
      output += chunk.toString();
      const lines = output.split('\n');
      for (const line of lines) {
        if (line.includes('opencode server listening')) {
          const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
          if (match) {
            clearTimeout(timeout);
            resolve(match[1].trim());
            return;
          }
        }
      }
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.on('exit', (code) => {
      clearTimeout(timeout);
      serverChild = null;
      serverPid = null;
      reject(new Error(`OpenCode 进程退出 code=${code}`));
    });
    proc.on('error', (err) => {
      clearTimeout(timeout);
      serverChild = null;
      serverPid = null;
      reject(err);
    });
  });
}

function killServerProcess() {
  if (serverPid != null) {
    try {
      process.kill(serverPid, 'SIGTERM');
    } catch (_) {}
    serverPid = null;
  }
  if (serverChild) {
    try {
      serverChild.kill('SIGTERM');
    } catch (_) {}
    serverChild = null;
  }
}

async function getClient() {
  if (client) return client;
  const baseUrl = options.baseUrl || 'http://127.0.0.1:4096';
  const port = getPortFromUrl(baseUrl);
  const host = getHostFromUrl(baseUrl);
  const maxRetries = 2;
  const retryDelayMs = 2200;

  /** 主进程用 Node 发请求，HTTPS 时忽略证书（仅用于本地） */
  const nodeFetch = (input) => {
    const req = input && typeof input.clone === 'function' ? input : new Request(input);
    const u = new URL(req.url);
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;
    const headers = {};
    req.headers.forEach((v, k) => { headers[k] = v; });
    return new Promise((resolve, reject) => {
      const reqOpts = {
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: req.method || 'GET',
        headers,
        rejectUnauthorized: !isHttps || u.hostname === '127.0.0.1' || u.hostname === 'localhost',
      };
      const nodeReq = mod.request(reqOpts, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString();
          resolve(new Response(body, {
            status: res.statusCode,
            headers: res.headers,
          }));
        });
      });
      nodeReq.on('error', reject);
      if (req.body) {
        req.arrayBuffer().then((buf) => {
          nodeReq.write(Buffer.from(buf));
          nodeReq.end();
        }).catch(reject);
      } else {
        nodeReq.end();
      }
    });
  };

  try {
    const { createOpencodeClient } = await import('@opencode-ai/sdk/v2/client');
    lastConnectError = '';

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        client = createOpencodeClient({ baseUrl });
        await client.global.health();
        return client;
      } catch (connectErr) {
        lastConnectError = (connectErr && connectErr.message) ? connectErr.message : String(connectErr);
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, retryDelayMs));
          continue;
        }

        const tryHttps = baseUrl.startsWith('http://');
        const altUrl = tryHttps
          ? `https://${host}:${port}`
          : `http://${host}:${port}`;
        try {
          if (tryHttps) {
            client = createOpencodeClient({
              baseUrl: altUrl,
              fetch: (req) => nodeFetch(req),
            });
          } else {
            client = createOpencodeClient({ baseUrl: altUrl });
          }
          await client.global.health();
          lastConnectError = '';
          return client;
        } catch (altErr) {
          lastConnectError = (altErr && altErr.message) ? altErr.message : String(altErr);
        }

        if (!options.autoStart) {
          client = null;
          return null;
        }
        try {
          const url = await startServerAndWait(port, 15000);
          client = createOpencodeClient({ baseUrl: url });
          await client.global.health();
          lastConnectError = '';
          return client;
        } catch (startErr) {
          lastConnectError = (startErr && startErr.message) ? startErr.message : String(startErr);
          client = null;
          return null;
        }
      }
    }
    client = null;
    return null;
  } catch (e) {
    lastConnectError = (e && e.message) ? e.message : String(e);
    console.error('OpenCode SDK load failed:', lastConnectError);
    return null;
  }
}

async function chat(text) {
  if (!text || typeof text !== 'string') return { error: '请输入内容' };
  const c = await getClient();
  if (!c) {
    return {
      error: 'OpenCode 未连接。请先启动 OpenCode 服务（默认 http://127.0.0.1:4096），或设置 OPENCODE_URL / 配置中的 opencode.baseUrl。',
    };
  }
  try {
    if (!sessionId) {
      const createRes = await c.session.create({ title: 'MarkWrite' });
      const session = createRes.data ?? createRes;
      sessionId = session?.id;
      if (!sessionId) {
        return { error: '创建会话失败：' + JSON.stringify(createRes) };
      }
    }
    const model = options.model || { providerID: 'opencode', modelID: 'trinity-large-preview-free' };
    const res = await c.session.prompt({
      sessionID: sessionId,
      model,
      parts: [{ type: 'text', text: text.trim() }],
    });
    const data = res.data ?? res;
    const parts = Array.isArray(data?.parts) ? data.parts : [];
    const responseText = parts
      .filter((p) => p && p.type === 'text' && p.text)
      .map((p) => p.text)
      .join('\n');
    return { text: responseText || '' };
  } catch (e) {
    return { error: (e && e.message) ? e.message : String(e) };
  }
}

async function health() {
  const c = await getClient();
  if (!c) {
    return {
      ok: false,
      message: lastConnectError ? `OpenCode 未连接：${lastConnectError}` : 'OpenCode 未连接',
    };
  }
  try {
    const h = await c.global.health();
    const version = (h && (h.data?.version ?? h.version)) || undefined;
    return {
      ok: true,
      version,
      selfStarted: serverChild != null || serverPid != null,
      backend: 'opencode',
    };
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    return { ok: false, message: `Health 请求失败：${msg}` };
  }
}

function cleanup() {
  killServerProcess();
  client = null;
  sessionId = null;
}

function configure(opts) {
  options = { baseUrl: 'http://127.0.0.1:4096', autoStart: true, ...opts };
}

module.exports = { chat, health, cleanup, configure };
