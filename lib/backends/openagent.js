'use strict';

/**
 * OpenAgent 后端：使用 @openagent/core + @openagent/app，本地运行 Agent（无需独立服务）。
 * 配置：configPath（含 config.json）、providerKey、modelId，来自 ai-config 的 openagent 段。
 */

const path = require('path');
const fs = require('fs');
const { registerMarkWriteTools } = require('./openagent-tools.js');

/** 动态加载 OpenAgent 依赖（ESM），在 getAgent 内首次调用，结果可复用逻辑上等同于“文件前面”加载 */
let _deps = null;
async function loadOpenAgentDeps() {
  if (_deps) return _deps;
  const [core, , appTools, ai, zod] = await Promise.all([
    import('@openagent/core'),
    import('@openagent/app/src/providers/register.js'),
    import('@openagent/app/src/tools/index.js'),
    import('ai'),
    import('zod'),
  ]);
  _deps = {
    ...core,
    defaultTools: appTools.defaultTools,
    tool: ai.tool,
    z: zod.z,
  };
  return _deps;
}

let agentInstance = null;
let history = [];
let options = {
  configPath: null,
  providerKey: null,
  modelId: null,
};

// 与 openagent-example 一致：apiKey 写在 config.json 的 options.apiKey 中
const DEFAULT_CONFIG = {
  volcengine: {
    name: 'volcengine',
    npm: '@ai-sdk/openai-compatible',
    options: {
      baseURL: 'https://ark.cn-beijing.volces.com/api/coding/v3',
      apiKey: '在此填写你的 API Key',
    },
    models: {
      'deepseek-v3.2': { name: 'deepseek-v3.2' },
      'ark-code-latest': { name: 'ark-code-latest' },
    },
  },
};

function ensureConfig(configPath) {
  if (!configPath) return false;
  const dir = path.resolve(configPath);
  const configFile = path.join(dir, 'config.json');
  if (fs.existsSync(configFile)) return true;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('[OpenAgent] ensureConfig:', e && e.message);
    return false;
  }
}

const MAX_EDITOR_CONTEXT_LEN = 8000;

function buildPromptWithContext(userMessage, context) {
  const userQ = (userMessage || '').trim();
  const wantsAppend = /(增加|追加|补充|插入|加一段|加一段话|加一句|加几句|添加一段|append|add a paragraph|insert)/i.test(userQ);
  const instruction = [
    '你是 MarkWrite 编辑器内的写作助手。',
    '如果用户要求修改/润色/改写/改标题等，你必须基于下方【内容】进行修改，不能凭空编造或忽略原文。',
    wantsAppend
      ? '【追加/增加类任务】你必须保留原文不丢失：输出的结果应为「原文 + 新增内容」（除非用户明确要求删减/重写）。'
      : '',
    '当文件名为「未命名」且用户要求润色/修改/改写时：优先调用工具 markwrite_apply_content（content=修改后的完整正文）。',
    '仅当工具不可用时，才把“修改后的完整正文”放入 Markdown 代码块 ```...``` 中（代码块外可简短说明）。',
    '如果用户只要求改一两处，也可以用多行 EDIT 指令：EDIT: 原文<Tab>新文（精确匹配）。',
    '普通提问则直接回答，不要输出工具调用格式。',
  ].filter(Boolean).join('\n');

  if (!context || typeof context !== 'object') {
    return `${instruction}\n\n【当前编辑器中的文档】未收到。请回复：请确认已在编辑器中打开要修改的文档后再提问。\n\n【用户的问题】${userQ}`;
  }

  const filename = context.filename != null ? String(context.filename) : '未命名';
  const raw = typeof context.editorContent === 'string' ? context.editorContent : '';
  const wantsEdit = /(润色|修改|改写|重写|改标题|标题|优化|翻译|总结|校对|语法|错别字|改一下|rewrite|polish|edit|improve|translate|summarize)/i.test(userQ);
  const truncated = raw.length > MAX_EDITOR_CONTEXT_LEN;
  const content = truncated ? raw.slice(0, MAX_EDITOR_CONTEXT_LEN) + '\n\n...(内容已截断)' : raw;
  const contentNote = !wantsEdit
    ? '（本次问题不需要附带全文上下文）'
    : (content.length === 0 ? '（当前无内容或编辑器未就绪）' : content);
  const hasPath = filename && filename !== '未命名';
  const toolHint = hasPath
    ? `（当前文件路径：${filename}；请根据下方「内容」直接输出修改后的全文到代码块。）`
    : '（当前无打开文件。若需润色/修改/改写，请直接调用工具 markwrite_apply_content，参数 content 为修改后的完整正文；系统将弹出确认框，确认后替换编辑框内容。）';

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

async function getAgent() {
  if (agentInstance) return agentInstance;

  const configPath = options.configPath ? path.resolve(options.configPath) : process.cwd();
  if (!ensureConfig(configPath)) {
    throw new Error('OpenAgent 配置目录不可用或无法创建 config.json');
  }

  const deps = await loadOpenAgentDeps();
  const { createProvider, ToolRegistry, createAgent, getProviderConfig, getFirstProviderKey, getEnvPrefix, defaultTools } = deps;

  const resolvedKey = options.providerKey || process.env.OPENAGENT_PROVIDER || getFirstProviderKey(configPath);
  if (!resolvedKey) {
    throw new Error('未配置 provider。请在 config.json 中至少配置一个 provider，或设置 openagent.providerKey / OPENAGENT_PROVIDER');
  }

  const cfg = getProviderConfig(resolvedKey, configPath);
  if (!cfg || !cfg.providerConfig) {
    throw new Error(`无法加载 provider 配置: ${resolvedKey}`);
  }

  cfg.providerConfig.options = cfg.providerConfig.options || {};
  const prefix = getEnvPrefix(resolvedKey);
  const apiKeyFromEnv = prefix ? process.env[`${prefix}_API_KEY`] : process.env.OPENAGENT_API_KEY;
  const apiKey = apiKeyFromEnv || cfg.providerConfig.options.apiKey;
  cfg.providerConfig.options.apiKey = apiKey || cfg.providerConfig.options.apiKey;
  // 只有部分 provider 需要 apiKey（例如 volcengine/openai）；ollama 本地通常不需要
  const needsApiKey = resolvedKey === 'volcengine' || resolvedKey === 'openai' || resolvedKey === 'openai-compatible';
  if (needsApiKey && !cfg.providerConfig.options.apiKey) {
    throw new Error(`OpenAgent: 未配置 apiKey（provider: ${resolvedKey}）。请在 config.json 对应 provider 的 options.apiKey 中填写，或设置 ${prefix ? `${prefix}_API_KEY` : 'OPENAGENT_API_KEY'} 等环境变量。`);
  }
  if (prefix && process.env[`${prefix}_BASE_URL`]) {
    cfg.providerConfig.options.baseURL = process.env[`${prefix}_BASE_URL`];
  }

  const provider = createProvider(cfg.providerConfig);
  const modelId = options.modelId || (prefix ? process.env[`${prefix}_MODEL`] : null) || process.env.OPENAGENT_MODEL || cfg.modelId;
  if (!modelId) {
    throw new Error('未配置 modelId，请在配置中设置 openagent.modelId 或环境变量 OPENAGENT_MODEL');
  }

  const model = provider.chatModel(modelId);

  const registry = new ToolRegistry();
  registry.registerAll(defaultTools);
  await registerMarkWriteTools(registry, {});

  const systemPrompt = `你是 MarkWrite 编辑器内的写作助手。
- 编辑框内容（润色、修改、改写当前正在编辑的正文）：使用工具 markwrite_apply_content，传入修改后的完整正文，用户确认后会应用到编辑框。
- 磁盘上的文件（创建文件、读文件、改文件、删文件）：使用 list_files、read_file、write_file、append_file、delete_file、grep、find，直接操作文件，无需用户再确认。
若用户只要求润色/修改当前编辑内容，优先用 markwrite_apply_content；若要求创建或修改磁盘上的文件，用上述文件类工具。用中文简洁回复。`;

  agentInstance = createAgent({
    model,
    getTools: () => registry.getTools(),
    systemPrompt,
    maxSteps: 5,
  });

  return agentInstance;
}

async function chat(message, context) {
  const userMessage = typeof message === 'string' ? message : '';
  if (!userMessage.trim()) return { error: '请输入内容' };

  try {
    const agent = await getAgent();
    const hasDocContext = context && typeof context.editorContent === 'string' && context.editorContent.trim().length > 0;
    const textToSend = hasDocContext ? buildPromptWithContext(userMessage, context) : userMessage;

    const { text } = await agent.chat(textToSend, history);
    history.push({ role: 'user', content: userMessage });
    history.push({ role: 'assistant', content: text || '' });
    return { text: text || '' };
  } catch (e) {
    return { error: (e && e.message) ? e.message : String(e) };
  }
}

async function docEdit(message, context) {
  const userMessage = typeof message === 'string' ? message : '';
  if (!userMessage.trim()) return { error: '请输入内容' };

  try {
    const agent = await getAgent();
    const promptText = buildPromptWithContext(userMessage, context);
    const { text } = await agent.chat(promptText, history);
    history.push({ role: 'user', content: userMessage });
    history.push({ role: 'assistant', content: text || '' });
    return { text: text || '' };
  } catch (e) {
    return { error: (e && e.message) ? e.message : String(e) };
  }
}

async function health() {
  try {
    await getAgent();
    return { ok: true, backend: 'openagent' };
  } catch (e) {
    return {
      ok: false,
      message: (e && e.message) ? `OpenAgent: ${e.message}` : 'OpenAgent 未就绪',
    };
  }
}

async function models(context) {
  const configPath = (options.configPath ? path.resolve(options.configPath) : process.cwd());
  const configFile = path.join(configPath, 'config.json');
  if (!fs.existsSync(configFile)) {
    return { error: '未找到 config.json，请先在配置目录创建并填写 provider' };
  }
  try {
    const raw = fs.readFileSync(configFile, 'utf8');
    const data = JSON.parse(raw);
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
  agentInstance = null;
  history = [];
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

  // 若切换了 provider/model/configPath，则需要重建 Agent（否则会继续复用旧 model）
  const changed = prev.configPath !== options.configPath
    || prev.providerKey !== options.providerKey
    || prev.modelId !== options.modelId;
  if (changed) cleanup();
}

module.exports = { chat, docEdit, health, models, cleanup, configure };
