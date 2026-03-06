'use strict';

/**
 * OpenCode 后端：连接 OpenCode 服务，支持未启动时自动拉起本地服务。
 * 配置项：{ baseUrl, autoStart }，来自 ai-config 的 opencode 段。
 * 自启的进程会记录 child 与 pid，在 cleanup / 异常退出时关闭。
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

let client = null;
let sessionId = null;
/** @type { import('node:child_process').ChildProcess | null } */
let serverChild = null;
/** @type { number | null } 自启进程的 PID，用于异常退出时补杀 */
let serverPid = null;
let options = {
  baseUrl: 'http://127.0.0.1:4096',
  autoStart: true,
  /** 自启时调用的命令，默认 opencode（会自行解析到 .opencode）；需要时也可写完整路径 */
  serveExecutable: null,
  serveHostname: '127.0.0.1',
  model: { providerID: 'opencode', modelID: 'gpt-5-nano' },
};
/** 最近一次连接失败原因，用于界面提示 */
let lastConnectError = '';

function uniqMessageID() {
  if (typeof crypto.randomUUID === 'function') return `msg_${crypto.randomUUID()}`;
  return `msg_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
}

async function getProvidersForDirectory(c, dir) {
  const res = await c.config.providers(dir ? { directory: dir } : undefined);
  const data = res?.data ?? res;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.providers)) return data.providers;
  return [];
}

function getAvailableModelIDs(providers, providerID) {
  const p = (providers || []).find((x) => x && x.id === providerID);
  const models = p && p.models ? p.models : {};
  return Object.keys(models || {});
}

function extractTextFromParts(parts) {
  const arr = Array.isArray(parts) ? parts : [];
  return arr
    .filter((p) => p && p.type === 'text' && p.text)
    .map((p) => p.text)
    .join('\n')
    .trim();
}

async function resolveModelForDirectory(c, dir, requestedModel) {
  const requested = requestedModel && typeof requestedModel === 'object'
    ? requestedModel
    : { providerID: 'opencode', modelID: 'gpt-5-nano' };

  const providers = await getProvidersForDirectory(c, dir);
  const available = getAvailableModelIDs(providers, requested.providerID);
  if (available.includes(requested.modelID)) {
    return { model: requested, warning: null, availableModels: available };
  }

  // Prefer gpt-5-nano, then trinity, otherwise pick first available model.
  const fallbackOrder = ['gpt-5-nano', 'trinity-large-preview-free'];
  const pickedModelID = fallbackOrder.find((m) => available.includes(m)) || available[0] || null;
  if (!pickedModelID) {
    return { model: null, warning: null, availableModels: available };
  }

  return {
    model: { providerID: requested.providerID, modelID: pickedModelID },
    warning: `请求的模型 ${requested.providerID}/${requested.modelID} 在该目录不可用，已改用 ${requested.providerID}/${pickedModelID}。`,
    availableModels: available,
  };
}

async function waitForAssistantMessage(c, { sessionID, directory, startedAt, timeoutMs = 90_000, pollIntervalMs = 1000 }) {
  const deadline = Date.now() + timeoutMs;
  let userMessageID = null;

  while (Date.now() < deadline) {
    const msgRes = await c.session.messages({ sessionID, limit: 50 });
    const msgs = (msgRes?.data ?? msgRes) || [];

    // Fallback: if parentID mapping fails (prompt_async variations), accept the newest assistant after startedAt.
    const recentAssistants = msgs
      .filter((m) => m?.info?.role === 'assistant')
      .filter((m) => (m?.info?.time?.created ?? 0) >= (startedAt - 2000));
    if (recentAssistants.length) {
      const a = recentAssistants[recentAssistants.length - 1];
      const hasText = !!extractTextFromParts(a.parts);
      const completed = a?.info?.completed != null || a?.info?.time?.completed != null;
      if (hasText || completed) return a;
    }

    if (!userMessageID) {
      const users = msgs
        .filter((m) => m && m.info && m.info.role === 'user')
        .filter((m) => (m.info?.time?.created ?? 0) >= (startedAt - 2000));
      const latestUser = users.length ? users[users.length - 1] : [...msgs].reverse().find((m) => m?.info?.role === 'user');
      if (latestUser?.info?.id) userMessageID = latestUser.info.id;
    }

    if (userMessageID) {
      const assistant = [...msgs].reverse().find((m) => m?.info?.role === 'assistant' && m?.info?.parentID === userMessageID);
      if (assistant) {
        const hasText = !!extractTextFromParts(assistant.parts);
        const completed = assistant?.info?.completed != null || assistant?.info?.time?.completed != null;
        if (hasText || completed) return assistant;
      }
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return null;
}

async function promptAndWait(c, { sessionID, directory, requestedModel, system, parts }) {
  const startedAt = Date.now();
  const dirForConfig = directory || process.cwd();
  const resolved = await resolveModelForDirectory(c, dirForConfig, requestedModel);
  if (!resolved.model) {
    throw new Error(`该目录下未找到可用模型（provider: ${requestedModel?.providerID || 'opencode'}）。可用模型: ${resolved.availableModels?.length ? resolved.availableModels.join(', ') : '(空)'}`);
  }

  await c.session.promptAsync({
    sessionID,
    ...(directory && { directory }),
    messageID: uniqMessageID(),
    agent: 'build',
    model: resolved.model,
    ...(system && { system }),
    parts,
  });

  const assistant = await waitForAssistantMessage(c, { sessionID, directory, startedAt });
  if (!assistant) {
    throw new Error(`等待回复超时。当前模型: ${resolved.model.providerID}/${resolved.model.modelID}。可用模型: ${resolved.availableModels?.join(', ') || '(空)'}`);
  }

  const assistantParts = Array.isArray(assistant.parts) ? assistant.parts : [];
  const partsOut = resolved.warning
    ? [{ type: 'text', text: resolved.warning }, ...assistantParts]
    : assistantParts;
  return { data: { info: assistant.info, parts: partsOut } };
}

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

/** 检测 OpenCode 是否已可访问（请求 /global/health，仅当返回像 OpenCode 的 JSON 才视为已有服务） */
function checkServerReachable(baseUrl, timeoutMs = 3000) {
  return new Promise((resolve) => {
    try {
      const u = new URL(baseUrl);
      const healthPath = (u.pathname === '/' || !u.pathname) ? '/global/health' : u.pathname.replace(/\/?$/, '') + '/global/health';
      const url = `${u.protocol}//${u.host}${healthPath}`;
      const mod = u.protocol === 'https:' ? https : http;
      const opts = mod === https
        ? { rejectUnauthorized: u.hostname === '127.0.0.1' || u.hostname === 'localhost' }
        : {};
      const req = mod.get(url, opts, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 400) {
          resolve(false);
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString();
            const j = JSON.parse(body);
            const ok = j && (j.version != null || j.data != null || j.ok === true);
            resolve(!!ok);
          } catch (_) {
            resolve(false);
          }
        });
        res.on('error', () => resolve(false));
      });
      req.on('error', () => resolve(false));
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        resolve(false);
      });
    } catch (_) {
      resolve(false);
    }
  });
}

/** 自启时可选的可执行路径（Electron 下 PATH 可能不含 npm global bin，故增加 shell / npx 方式） */
function getServeExecutables() {
  const explicit = options.serveExecutable;
  if (explicit) return [{ executable: explicit }];
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return [
    { executable: 'opencode' },
    { executable: 'opencode', shell: true },
    { executable: 'npx', argsPrefix: ['opencode-ai'] },
    process.env.MARKWRITE_OPENCODE_SERVE_EXECUTABLE && { executable: process.env.MARKWRITE_OPENCODE_SERVE_EXECUTABLE },
    { executable: path.join(home, '.npm-global/lib/node_modules/opencode-ai/bin/.opencode') },
    { executable: path.join(home, '.local/share/npm/lib/node_modules/opencode-ai/bin/.opencode') },
    { executable: path.join(home, 'node_modules/.bin/opencode') },
  ].filter(Boolean);
}

/** 轮询 /global/health 直到就绪或超时（与 test-opencode-serve.js 一致） */
async function pollServerReachable(baseUrl, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkServerReachable(baseUrl, 2000)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/** 若已有服务在跑则直接返回 baseUrl（不 spawn、不记录 pid）；否则启动并等待就绪。与 test-opencode-serve.js 一致：spawn 后轮询 health，不依赖 stdout。 */
async function startServerAndWait(port, timeoutMs) {
  const hostname = options.serveHostname ?? '127.0.0.1';
  const baseUrl = options.baseUrl || `http://${hostname}:${port}`;
  const reachable = await checkServerReachable(baseUrl);
  if (reachable) return baseUrl;
  const executables = getServeExecutables();
  let lastErr = null;
  for (const item of executables) {
    const executable = typeof item === 'string' ? item : (item && item.executable);
    if (!executable) continue;
    try {
      await trySpawnServer(item, hostname, port);
      const exitPromise = new Promise((resolve) => {
        if (!serverChild || serverChild.exitCode != null) {
          resolve({ exited: true });
          return;
        }
        serverChild.once('exit', () => resolve({ exited: true }));
      });
      const ok = await Promise.race([
        pollServerReachable(baseUrl, timeoutMs).then((reached) => ({ reached })),
        exitPromise,
      ]);
      if (ok.reached) return baseUrl;
      killServerProcess();
    } catch (e) {
      lastErr = e;
      killServerProcess();
      if (e.code === 'ENOENT' || (e.message && e.message.includes('spawn'))) {
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('OpenCode 启动失败，请手动运行 opencode serve 或配置 serveExecutable');
}

/** 仅负责 spawn 进程并立即 resolve；就绪由 startServerAndWait 轮询 /global/health 判断（与 test-opencode-serve.js 一致） */
function trySpawnServer(item, hostname, port) {
  const opt = typeof item === 'string' ? { executable: item } : (item || {});
  const executable = opt.executable;
  const useShell = !!opt.shell;
  const argsPrefix = Array.isArray(opt.argsPrefix) ? opt.argsPrefix : [];
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const extraPaths = [
    path.join(home, '.npm-global/bin'),
    path.join(home, '.npm-global/lib/node_modules/opencode-ai/bin'),
    path.join(home, '.local/share/npm/bin'),
    path.join(home, 'node_modules/.bin'),
  ].filter((p) => p && home).join(path.delimiter);
  const env = { ...process.env };
  if (extraPaths) env.PATH = [extraPaths, env.PATH].filter(Boolean).join(path.delimiter);
  const serveArgs = ['serve', `--hostname=${hostname}`, `--port=${port}`];
  const args = [...argsPrefix, ...serveArgs];
  return new Promise((resolve, reject) => {
    const proc = useShell
      ? spawn(`${executable} ${serveArgs.join(' ')}`, [], { env, stdio: ['ignore', 'pipe', 'pipe'], shell: true })
      : spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    serverChild = proc;
    serverPid = proc.pid;
    const forward = process.env.DEBUG_OPENCODE ? (chunk) => process.stderr.write('[opencode] ' + chunk.toString()) : () => {};
    proc.stdout?.on('data', forward);
    proc.stderr?.on('data', forward);
    proc.on('exit', (code, signal) => {
      serverChild = null;
      serverPid = null;
      reject(new Error(`OpenCode 进程退出 code=${code} signal=${signal}`));
    });
    proc.on('error', (err) => {
      serverChild = null;
      serverPid = null;
      reject(err);
    });
    resolve();
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

  try {
    const { createOpencodeClient } = await import('@opencode-ai/sdk/v2/client');
    lastConnectError = '';

    if (await checkServerReachable(baseUrl)) {
      client = createOpencodeClient({ baseUrl });
      await client.global.health();
      return client;
    }

    // 2. 没有则自启
    if (!options.autoStart) {
      lastConnectError = '未检测到 OpenCode 且未开启自启';
      return null;
    }
    const url = await startServerAndWait(port, 20000);
    if (!url) {
      client = null;
      return null;
    }
    client = createOpencodeClient({ baseUrl: url });
    await client.global.health();
    lastConnectError = '';
    return client;
  } catch (e) {
    lastConnectError = (e && e.message) ? e.message : String(e);
    client = null;
    return null;
  }
}

const MAX_EDITOR_CONTEXT_LEN = 28000;

function buildPromptWithContext(userMessage, context) {
  const instruction = [
    '你正在协助使用 MarkWrite 编辑器的用户。下方是用户当前在编辑器中打开的文件（文件名与全文）。',
    '【重要】当用户要求修改、润色、改标题、修正文章、改某段内容时：',
    '请将「修改后的完整文档全文」放在 Markdown 代码块中输出，格式为：先写一行 ``` 然后换行贴完整正文，最后一行再写 ```。',
    '正文必须是裸内容（从第一个字到最后一个字），代码块外可以加简短说明（如「修改后全文如下」），但只有代码块内的内容会被用来替换编辑器，不会把说明覆盖进文档。',
    '【局部修改】当用户只要求改一两处（如「第五行 我很需要 改成 我现在很需要」）时，除说明外请同时给出可执行格式，便于程序自动应用。每处修改占一行，格式为：',
    'EDIT: 原文\t新文',
    '（原文与新文用 Tab 分隔，原文和新文必须是文档中出现的完整精确字符串。）可多行，每行一处。例如：',
    'EDIT: 我很需要\t我现在很需要',
    '禁止只回复「第几行有问题」「建议改为…」而不给出完整正文或 EDIT 行。',
    '【每次请求都要输出正文】即使用户是连续第二次、第三次要求修改，每次也必须根据下方「当前编辑器中的文档」输出修改后的完整正文到代码块。不要只回复「已改好」或说明而不输出正文；替换始终以本次回复中的代码块为准。',
    '【禁止工具调用格式】不要输出 <function_calls>、<invoke>、read/write 等 XML 或工具调用。当前文档内容已在下方提供，请直接根据该内容写出修改后的全文并放入 ``` 代码块中。',
    '若用户只是普通提问（不要求改文档），则按对话回答即可。',
  ].join('\n');
  const userQ = userMessage.trim();

  if (!context || typeof context !== 'object') {
    return `${instruction}\n\n【当前编辑器中的文档】未收到。请回复：请确认已在编辑器中打开要修改的文档后再提问。\n\n【用户的问题】${userQ}`;
  }

  const filename = context.filename != null ? String(context.filename) : '未命名';
  const raw = typeof context.editorContent === 'string' ? context.editorContent : '';
  const truncated = raw.length > MAX_EDITOR_CONTEXT_LEN;
  const content = truncated ? raw.slice(0, MAX_EDITOR_CONTEXT_LEN) + '\n\n...(内容已截断)' : raw;
  const contentNote = content.length === 0 ? '（当前无内容或编辑器未就绪）' : content;
  const hasPath = filename && filename !== '未命名';
  const toolHint = hasPath
    ? `（当前文件路径：${filename}；请根据下方「内容」直接输出修改后的全文到代码块，不要输出工具调用。）`
    : '';

  const block = [
    instruction,
    '',
    '【当前编辑器中的文档】',
    `文件名：${filename}${toolHint}`,
    '',
    '内容：',
    '---',
    contentNote,
    '---',
    '',
    '【用户的问题】',
    userQ,
  ].join('\n');
  return block;
}

async function chat(message, context) {
  const userMessage = typeof message === 'string' ? message : '';
  if (!userMessage.trim()) return { error: '请输入内容' };
  const c = await getClient();
  if (!c) {
    return {
      error: 'OpenCode 未连接。请先启动 OpenCode 服务（默认 http://127.0.0.1:4096），或设置 OPENCODE_URL / 配置中的 opencode.baseUrl。',
    };
  }
  try {
    if (!sessionId) {
      let createRes;
      try {
        createRes = await c.session.create({ title: 'MarkWrite' });
      } catch (createErr) {
        const msg = (createErr && createErr.message) ? createErr.message : String(createErr);
        return { error: '创建会话失败：' + msg };
      }
      const session = createRes?.data ?? createRes;
      sessionId = session?.id;
      if (!sessionId) {
        const err = createRes?.error;
        let msg = '未返回 session id';
        if (err && typeof err === 'object') {
          if (err.message) msg = String(err.message);
          else if (err.statusText) msg = String(err.statusText);
          else if (err.code) msg = String(err.code);
          else if (Object.keys(err).length) msg = JSON.stringify(err);
        } else if (err) msg = String(err);
        return { error: '创建会话失败：' + msg + '。请检查 OpenCode 服务是否正常。' };
      }
    }
    const promptText = buildPromptWithContext(userMessage, context);
    const model = options.model || { providerID: 'opencode', modelID: 'gpt-5-nano' };
    // 若有当前文件路径，传 directory 给服务端，便于 agent 在该目录下使用 read/write/edit 等 tools
    const workDir = context && context.filename && String(context.filename) !== '未命名'
      ? path.dirname(path.resolve(context.filename))
      : undefined;
    const res = await c.session.prompt({
      sessionID: sessionId,
      ...(workDir && { directory: workDir }),
      model,
      parts: [{ type: 'text', text: promptText }],
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
  const defaultModel = { providerID: 'opencode', modelID: 'gpt-5-nano' };
  options = {
    baseUrl: 'http://127.0.0.1:4096',
    autoStart: true,
    serveExecutable: null,
    serveHostname: '127.0.0.1',
    model: defaultModel,
    ...opts,
  };
  if (!options.model || typeof options.model !== 'object') {
    options.model = defaultModel;
  }
}

/**
 * 智能文档 Agent：使用 read/edit/write 工具直接操作文件
 * 委托给 lib/agent 的 runDocAgent，由 OpenCode 执行完整 12 步 loop
 */
async function docEdit(message, context) {
  const { runDocAgent } = require('../agent/index.js');
  const c = await getClient();
  if (!c) {
    return {
      error: 'OpenCode 未连接。请先启动 OpenCode 服务。',
    };
  }
  const model = options.model || { providerID: 'opencode', modelID: 'gpt-5-nano' };
  const promptFn = async (input) => {
    if (!sessionId) {
      const createRes = await c.session.create({ title: 'MarkWrite' });
      const session = createRes?.data ?? createRes;
      sessionId = session?.id;
      if (!sessionId) throw new Error('创建会话失败');
    }
    return c.session.prompt({
      sessionID: sessionId,
      directory: input.directory,
      model: input.model || model,
      system: input.system,
      parts: input.parts,
    });
  };
  const filePath = context && context.filename && String(context.filename) !== '未命名'
    ? context.filename
    : undefined;
  return runDocAgent({
    promptFn,
    userMessage: typeof message === 'string' ? message : '',
    filePath,
    editorContent: context && context.editorContent,
    model,
  });
}

module.exports = { chat, docEdit, health, cleanup, configure };
