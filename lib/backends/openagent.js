'use strict';

/**
 * OpenAgent 后端（LangChain 版）：使用 @langchain/core + @langchain/openai 运行 Agent，
 * 支持 OpenAI 兼容 API（如 volcengine、ollama）。配置来自 config.json（与 openagent 同格式）。
 */

const path = require('path');
const fs = require('fs');
const { getMarkWriteToolsForLangChain } = require('./openagent-tools.js');

// ---------- 彩色日志 ----------
const C = {
  reset: '\x1b[0m',
  dim: '\x1b[90m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  magenta: '\x1b[35m',
  red: '\x1b[31m',
};
const MAX_LOG_LEN = 420;

function truncate(obj, max = MAX_LOG_LEN) {
  const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
  if (s.length <= max) return s;
  return s.slice(0, max) + '...';
}

function logToolCall(name, args, result, err) {
  const tag = `${C.cyan}[Tool]${C.reset}`;
  console.log(`${tag} ${C.magenta}${name}${C.reset} 入参: ${C.dim}${truncate(args)}${C.reset}`);
  if (err) {
    console.log(`${tag} ${name} ${C.red}错误${C.reset}: ${(err && err.message) || err}`);
  } else {
    console.log(`${tag} ${name} 返回: ${C.dim}${truncate(result)}${C.reset}`);
  }
}

function logModelRequest(userMessage, fullPromptSent, historyLength, hasSystemPrompt) {
  const userTag = `${C.yellow}[用户输入]${C.reset}`;
  console.log(`${userTag} ${C.green}${truncate(userMessage, 600)}${C.reset}`);
  const tag = `${C.yellow}[Model 请求]${C.reset}`;
  console.log(`${tag} 历史消息数: ${C.dim}${historyLength}${C.reset}${hasSystemPrompt ? ' (含 system)' : ''}`);
  const isFullPrompt = fullPromptSent !== userMessage && fullPromptSent.length > userMessage.length;
  if (isFullPrompt) {
    console.log(`${tag} 发送给模型: 完整 prompt 共 ${C.dim}${fullPromptSent.length}${C.reset} 字符，开头预览: ${C.dim}${truncate(fullPromptSent, 120)}${C.reset}`);
  } else {
    console.log(`${tag} 发送给模型: ${C.dim}${truncate(fullPromptSent, 400)}${C.reset}`);
  }
}

function logModelResponse(text, finishReason) {
  const tag = `${C.green}[Model 返回]${C.reset}`;
  console.log(`${tag} 长度: ${C.dim}${(text || '').length}${C.reset} 字符, finishReason: ${C.dim}${finishReason || '—'}${C.reset}`);
  console.log(`${tag} 内容预览: ${C.dim}${truncate(text || '', 400)}${C.reset}`);
}

function logModelEndpoint(providerKey, modelId) {
  console.log(`${C.yellow}[Model 接口]${C.reset} ${C.dim}provider=${providerKey} modelId=${modelId}${C.reset}`);
}

// ---------- 配置读取（与 openagent config 同格式，不依赖 @openagent/core） ----------
const ENV_PREFIX = { openai: 'OPENAI', volcengine: 'VOLCENGINE', ollama: 'OLLAMA' };

function getEnvPrefix(providerKey) {
  return ENV_PREFIX[providerKey];
}

function loadConfig(cwd) {
  const dir = path.resolve(cwd || process.cwd());
  for (const name of ['config.json', 'openagent.config.json']) {
    const full = path.join(dir, name);
    if (fs.existsSync(full)) {
      try {
        const data = JSON.parse(fs.readFileSync(full, 'utf8'));
        return { data, path: full };
      } catch (_) {}
    }
  }
  return null;
}

function getProviderConfig(providerKey, cwd) {
  const loaded = loadConfig(cwd);
  if (!loaded) return null;
  const data = loaded.data;
  const top = data.providers || data;
  const block = top[providerKey];
  if (!block || typeof block !== 'object') return null;
  const options = { ...(block.options || {}) };
  const prefix = getEnvPrefix(providerKey);
  if (prefix) {
    if (process.env[`${prefix}_API_KEY`]) options.apiKey = process.env[`${prefix}_API_KEY`];
    if (process.env[`${prefix}_BASE_URL`]) options.baseURL = process.env[`${prefix}_BASE_URL`];
  }
  const modelsMap = block.models || {};
  const modelId = (prefix && process.env[`${prefix}_MODEL`]) || Object.keys(modelsMap)[0] || null;
  return { providerConfig: { name: block.name || providerKey, options }, modelId };
}

function getFirstProviderKey(cwd) {
  const loaded = loadConfig(cwd);
  if (!loaded) return null;
  const top = loaded.data.providers || loaded.data;
  for (const k of Object.keys(top)) {
    if (top[k] && typeof top[k] === 'object') return k;
  }
  return null;
}

function ensureConfig(configPath) {
  if (!configPath) return false;
  const dir = path.resolve(configPath);
  const configFile = path.join(dir, 'config.json');
  if (fs.existsSync(configFile)) return true;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({
      volcengine: {
        name: 'volcengine',
        options: { baseURL: 'https://ark.cn-beijing.volces.com/api/coding/v3', apiKey: '在此填写你的 API Key' },
        models: { 'deepseek-v3.2': { name: 'deepseek-v3.2' } },
      },
    }, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('[OpenAgent] ensureConfig:', e && e.message);
    return false;
  }
}

// ---------- 状态 ----------
let agentState = null; // { llm, tools, systemPrompt }
let history = [];
let resolvedProviderKey = '';
let resolvedModelId = '';
let options = { configPath: null, providerKey: null, modelId: null };

const MAX_EDITOR_CONTEXT_LEN = 8000;
const MAX_STEPS = 5;

function buildPromptWithContext(userMessage, context) {
  const userQ = (userMessage || '').trim();
  const wantsAppend = /(增加|追加|补充|插入|加一段|添加一段|append|insert)/i.test(userQ);
  const instruction = [
    '你是 MarkWrite 编辑器内的写作助手。',
    '如果用户要求修改/润色/改写/改标题等，你必须基于下方【内容】进行修改，不能凭空编造或忽略原文。',
    wantsAppend ? '【追加/增加类任务】你必须保留原文不丢失：输出的结果应为「原文 + 新增内容」。' : '',
    '当文件名为「未命名」且用户要求润色/修改/改写时：优先调用工具 markwrite_apply_content（content=修改后的完整正文）。',
    '若需要当前编辑框内容而下方【内容】为空或未提供：请先调用工具 markwrite_get_editor_content 获取当前编辑框内容，再基于返回内容进行分析或修改，最后用 markwrite_apply_content 回写。',
    '仅当工具不可用时，才把“修改后的完整正文”放入 Markdown 代码块 ```...``` 中。',
    '如果用户只要求改一两处，也可以用多行 EDIT 指令：EDIT: 原文<Tab>新文。',
    '普通提问则直接回答。',
  ].filter(Boolean).join('\n');

  if (!context || typeof context !== 'object') {
    return `${instruction}\n\n【当前编辑器中的文档】未收到。请回复：请确认已在编辑器中打开要修改的文档后再提问。\n\n【用户的问题】${userQ}`;
  }

  const filename = context.filename != null ? String(context.filename) : '未命名';
  const raw = typeof context.editorContent === 'string' ? context.editorContent : '';
  const wantsEdit = /(润色|修改|改写|重写|改标题|优化|翻译|总结|校对|改错|rewrite|polish|edit|improve)/i.test(userQ);
  const needsDocContext = wantsEdit || wantsAppend;
  const truncated = raw.length > MAX_EDITOR_CONTEXT_LEN;
  const content = truncated ? raw.slice(0, MAX_EDITOR_CONTEXT_LEN) + '\n\n...(内容已截断)' : raw;
  const contentNote = !needsDocContext ? '（本次问题不需要附带全文上下文）' : (content.length === 0 ? '（当前无内容或编辑器未就绪）' : content);
  const toolHint = filename && filename !== '未命名' ? `（当前文件路径：${filename}）` : '（当前无打开文件。若需润色/修改，请直接调用工具 markwrite_apply_content。）';

  return [
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
}

async function getAgentState() {
  if (agentState) return agentState;

  const configPath = options.configPath ? path.resolve(options.configPath) : process.cwd();
  if (!ensureConfig(configPath)) {
    throw new Error('OpenAgent 配置目录不可用或无法创建 config.json');
  }

  const resolvedKey = options.providerKey || process.env.OPENAGENT_PROVIDER || getFirstProviderKey(configPath);
  if (!resolvedKey) {
    throw new Error('未配置 provider。请在 config.json 中至少配置一个 provider，或设置 openagent.providerKey');
  }

  const cfg = getProviderConfig(resolvedKey, configPath);
  if (!cfg || !cfg.providerConfig) {
    throw new Error(`无法加载 provider 配置: ${resolvedKey}`);
  }

  const opts = cfg.providerConfig.options || {};
  const prefix = getEnvPrefix(resolvedKey);
  if (prefix && process.env[`${prefix}_API_KEY`]) opts.apiKey = process.env[`${prefix}_API_KEY`];
  if (prefix && process.env[`${prefix}_BASE_URL`]) opts.baseURL = process.env[`${prefix}_BASE_URL`];
  const apiKey = opts.apiKey || (prefix ? process.env[`${prefix}_API_KEY`] : null);
  const baseURL = opts.baseURL || (prefix ? process.env[`${prefix}_BASE_URL`] : null);
  const modelId = options.modelId || (prefix ? process.env[`${prefix}_MODEL`] : null) || process.env.OPENAGENT_MODEL || cfg.modelId;
  if (!modelId) {
    throw new Error('未配置 modelId，请在配置中设置 openagent.modelId 或环境变量 OPENAGENT_MODEL');
  }

  const needsApiKey = resolvedKey === 'volcengine' || resolvedKey === 'openai' || resolvedKey === 'openai-compatible';
  if (needsApiKey && !apiKey) {
    throw new Error(`OpenAgent: 未配置 apiKey（provider: ${resolvedKey}）。请在 config.json 对应 provider 的 options.apiKey 中填写。`);
  }

  const { ChatOpenAI } = await import('@langchain/openai');
  const { HumanMessage, SystemMessage, AIMessage, ToolMessage } = await import('@langchain/core/messages');

  const llm = new ChatOpenAI({
    model: modelId,
    temperature: 0,
    apiKey: apiKey || 'dummy',
    configuration: baseURL ? { baseURL } : undefined,
  });

  let tools = await getMarkWriteToolsForLangChain({});
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  const wrapTool = (tool) => {
    const name = tool.name;
    const origInvoke = tool.invoke.bind(tool);
    return {
      ...tool,
      invoke: async (input) => {
        try {
          const result = await origInvoke(input);
          logToolCall(name, input, result, null);
          return result;
        } catch (e) {
          logToolCall(name, input, null, e);
          throw e;
        }
      },
    };
  };
  tools = tools.map(wrapTool);
  const toolMapWrapped = new Map(tools.map((t) => [t.name, t]));

  const systemPrompt = `你是 MarkWrite 编辑器内的写作助手。
- 编辑框内容（润色、修改、改写、改错、升级当前正在编辑的正文）：必须先调用工具 markwrite_get_editor_content 获取当前编辑框的完整内容与文件名，再基于返回的内容进行分析或修改，最后用 markwrite_apply_content 传入修改后的完整正文；用户确认后会应用到编辑框。
- 把编辑框内容保存到文件：必须使用工具 markwrite_save_editor_to_file，传入目标路径。
- 磁盘上的文件：使用 list_files、read_file、write_file、append_file、delete_file、grep、find 等工具直接操作文件。
若用户要求润色/修改/改错/升级当前编辑内容，务必先 markwrite_get_editor_content 再 markwrite_apply_content；若要求把编辑框存成某文件，务必用 markwrite_save_editor_to_file。用中文简洁回复。`;

  resolvedProviderKey = resolvedKey;
  resolvedModelId = modelId;

  agentState = {
    llm,
    tools,
    toolMap: toolMapWrapped,
    systemPrompt,
    HumanMessage,
    SystemMessage,
    AIMessage,
    ToolMessage,
  };
  return agentState;
}

async function runAgent(userInput, historyMessages) {
  const state = await getAgentState();
  const { llm, tools, systemPrompt, HumanMessage, SystemMessage, AIMessage, ToolMessage } = state;

  const messages = [
    ...(systemPrompt ? [new SystemMessage(systemPrompt)] : []),
    ...historyMessages,
    new HumanMessage(userInput),
  ];

  let currentMessages = [...messages];
  let lastContent = '';
  let finishReason = 'stop';

  for (let step = 0; step < MAX_STEPS; step++) {
    const bound = tools.length ? llm.bindTools(tools) : llm;
    const response = await bound.invoke(currentMessages);

    const content = response && response.content;
    if (content !== undefined && content !== null) {
      lastContent = typeof content === 'string' ? content : (Array.isArray(content) ? content.map((c) => (c && c.text) || c).join('') : String(content));
    }
    const toolCalls = response && (response.tool_calls || (response.additional_kwargs && response.additional_kwargs.tool_calls));
    if (toolCalls && Array.isArray(toolCalls) && toolCalls.length > 0) {
      currentMessages = [...currentMessages, response];
      for (const tc of toolCalls) {
        const name = tc.name || tc.function?.name;
        let args = tc.args;
        if (args === undefined && tc.function && typeof tc.function.arguments === 'string') {
          try { args = JSON.parse(tc.function.arguments); } catch (_) { args = {}; }
        }
        if (typeof args !== 'object' || args === null) args = {};
        const tool = state.toolMap.get(name);
        let result;
        try {
          result = tool ? await tool.invoke(args) : JSON.stringify({ error: `Unknown tool: ${name}` });
        } catch (e) {
          result = JSON.stringify({ error: (e && e.message) || String(e) });
        }
        if (typeof result !== 'string') result = JSON.stringify(result);
        const toolCallId = tc.id || tc.tool_call_id || name;
        currentMessages.push(new ToolMessage({ content: result, tool_call_id: toolCallId }));
      }
      finishReason = 'tool_calls';
      continue;
    }
    finishReason = 'stop';
    break;
  }

  return { text: lastContent || '', finishReason };
}

async function chat(message, context) {
  const userMessage = typeof message === 'string' ? message : '';
  if (!userMessage.trim()) return { error: '请输入内容' };

  try {
    const hasDocContext = context && typeof context.editorContent === 'string' && context.editorContent.trim().length > 0;
    const textToSend = hasDocContext ? buildPromptWithContext(userMessage, context) : userMessage;

    const state = await getAgentState();
    const historyMessages = history.map((h) =>
      h.role === 'user' ? new state.HumanMessage(h.content) : new state.AIMessage(h.content)
    );

    logModelEndpoint(resolvedProviderKey, resolvedModelId);
    logModelRequest(userMessage, textToSend, history.length, true);
    const { text, finishReason } = await runAgent(textToSend, historyMessages);
    logModelResponse(text, finishReason);

    history.push({ role: 'user', content: userMessage });
    history.push({ role: 'assistant', content: text || '' });
    return { text: text || '' };
  } catch (e) {
    console.log(`${C.red}[OpenAgent 错误]${C.reset} ${(e && e.message) || String(e)}`);
    return { error: (e && e.message) ? e.message : String(e) };
  }
}

async function docEdit(message, context) {
  const userMessage = typeof message === 'string' ? message : '';
  if (!userMessage.trim()) return { error: '请输入内容' };

  try {
    const promptText = buildPromptWithContext(userMessage, context);
    const state = await getAgentState();
    const historyMessages = history.map((h) =>
      h.role === 'user' ? new state.HumanMessage(h.content) : new state.AIMessage(h.content)
    );

    logModelEndpoint(resolvedProviderKey, resolvedModelId);
    logModelRequest(userMessage, promptText, history.length, true);
    const { text, finishReason } = await runAgent(promptText, historyMessages);
    logModelResponse(text, finishReason);

    history.push({ role: 'user', content: userMessage });
    history.push({ role: 'assistant', content: text || '' });
    return { text: text || '' };
  } catch (e) {
    console.log(`${C.red}[OpenAgent 错误]${C.reset} ${(e && e.message) || String(e)}`);
    return { error: (e && e.message) ? e.message : String(e) };
  }
}

async function health() {
  try {
    await getAgentState();
    return { ok: true, backend: 'openagent' };
  } catch (e) {
    return {
      ok: false,
      message: (e && e.message) ? `OpenAgent: ${e.message}` : 'OpenAgent 未就绪',
    };
  }
}

async function models() {
  const configPath = options.configPath ? path.resolve(options.configPath) : process.cwd();
  const configFile = path.join(configPath, 'config.json');
  if (!fs.existsSync(configFile)) {
    return { error: '未找到 config.json，请先在配置目录创建并填写 provider' };
  }
  try {
    const data = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const providers = [];
    const top = data.providers || data;
    for (const key of Object.keys(top)) {
      const block = top[key];
      if (!block || typeof block !== 'object') continue;
      const modelsMap = block.models || {};
      providers.push({
        id: key,
        name: block.name || key,
        models: Object.fromEntries(Object.keys(modelsMap).map((m) => [m, { name: m }])),
      });
    }
    return { providers };
  } catch (e) {
    return { error: (e && e.message) ? e.message : String(e) };
  }
}

function cleanup() {
  agentState = null;
  history = [];
  resolvedProviderKey = '';
  resolvedModelId = '';
}

function configure(opts) {
  const prev = { ...options };
  options = {
    configPath: null,
    providerKey: null,
    modelId: null,
    ...opts,
  };
  if (options.model && typeof options.model === 'object') {
    if (options.model.providerID) options.providerKey = options.model.providerID;
    if (options.model.modelID) options.modelId = options.model.modelID;
    if (options.model.modelId) options.modelId = options.model.modelId;
  }
  const changed = prev.configPath !== options.configPath ||
    prev.providerKey !== options.providerKey ||
    prev.modelId !== options.modelId;
  if (changed) cleanup();
}

module.exports = { chat, docEdit, health, models, cleanup, configure };
