window.copyCode = function copyCode(btn) {
  const block = btn && btn.closest && btn.closest('.code-block');
  const pre = block && block.querySelector('pre');
  const code = pre && (pre.querySelector('code') || pre);
  const text = code ? code.textContent : '';
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      const t = btn.textContent;
      btn.textContent = '已复制';
      setTimeout(() => { btn.textContent = t; }, 1200);
    });
  }
};

window.addEventListener('DOMContentLoaded', () => {
  const PREVIEW_THEME_CSS = [
    'base.css',
    'vars.css',
    'fonts.css',
    'icons.css',
    'utils.css',
    'components/custom-block.css',
    'components/vp-code.css',
    'components/vp-doc.css',
    'components/vp-code-group.css',
    'components/vp-sponsor.css',
  ];
  const base = '/preview-theme/';
  PREVIEW_THEME_CSS.forEach((name) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = base + name;
    document.head.appendChild(link);
  });

  const container = document.getElementById('monaco-container');
  const editorFilename = document.getElementById('editor-filename');
  const btnOpen = document.getElementById('btn-open');
  const btnSave = document.getElementById('btn-save');
  const btnSaveAs = document.getElementById('btn-saveas');
  const previewToggle = document.getElementById('preview-toggle');
  const editorWithPreview = document.getElementById('editor-with-preview');
  const aiMessages = document.getElementById('ai-messages');
  const aiInput = document.getElementById('ai-input');
  const aiSend = document.getElementById('ai-send');
  const aiModeChat = document.getElementById('ai-mode-chat');
  const aiModeCmd = document.getElementById('ai-mode-cmd');

  let editor = null;
  let currentFilePath = null;
  // 若 AI 通过 markwrite_apply_content 回写，则这里会收到 apply-editor-content
  // （目前不再展示“未检测到可替换内容”的提示，因此这里只保留接收逻辑）

  /** 仅用于「润色/修改编辑框」工具：弹出确认后再应用，其他 tools（文件操作）不经过此流程 */
  function showApplyEditorConfirm(content, onDone) {
    const overlay = document.createElement('div');
    overlay.className = 'apply-editor-confirm-overlay';
    const box = document.createElement('div');
    box.className = 'apply-editor-confirm-box';
    const title = document.createElement('div');
    title.className = 'apply-editor-confirm-title';
    title.textContent = '应用到编辑器？';

    const desc = document.createElement('div');
    desc.className = 'apply-editor-confirm-desc';
    desc.textContent = 'AI 生成了新的正文内容。为避免误覆盖，请确认后再替换当前编辑器内容。';

    const preview = document.createElement('pre');
    preview.className = 'apply-editor-confirm-preview';
    const p = (content || '').slice(0, 400);
    preview.textContent = p + ((content || '').length > 400 ? '\n…(已截断预览)…' : '');

    const actions = document.createElement('div');
    actions.className = 'apply-editor-confirm-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'apply-editor-btn apply-editor-btn-secondary apply-editor-cancel';
    cancelBtn.textContent = '取消';
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'apply-editor-btn apply-editor-btn-primary apply-editor-ok';
    okBtn.textContent = '确认修改';
    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);

    box.appendChild(title);
    box.appendChild(desc);
    box.appendChild(preview);
    box.appendChild(actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    const close = (confirmed) => {
      overlay.remove();
      if (typeof onDone === 'function') onDone(!!confirmed);
    };
    okBtn.addEventListener('click', () => close(true));
    cancelBtn.addEventListener('click', () => close(false));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
  }
  let aiMode = 'chat';
  /** 用户手动选择的模式，null 表示由系统根据输入自动判断 */
  let manualAiMode = null;

  // 预览开关：默认打开；点击「预览」在显示/隐藏之间切换
  const PREVIEW_KEY = 'markwrite-preview-open';
  let previewOpen = false;
  try {
    const saved = localStorage.getItem(PREVIEW_KEY);
    if (saved === '1') previewOpen = true;
  } catch (_) {}
  function applyPreviewState() {
    if (editorWithPreview) {
      editorWithPreview.classList.toggle('preview-closed', !previewOpen);
      editorWithPreview.setAttribute('data-preview', previewOpen ? 'open' : 'closed');
    }
    if (previewToggle) {
      previewToggle.classList.toggle('is-on', previewOpen);
      previewToggle.textContent = previewOpen ? '预览 ✓' : '预览';
      previewToggle.title = previewOpen ? '关闭预览' : '打开预览';
    }
    try {
      localStorage.setItem(PREVIEW_KEY, previewOpen ? '1' : '0');
    } catch (_) {}
  }
  applyPreviewState();
  if (previewToggle && editorWithPreview) {
    previewToggle.addEventListener('click', function () {
      previewOpen = !previewOpen;
      applyPreviewState();
    });
  }
  const previewBackBtn = document.getElementById('preview-back-btn');
  if (previewBackBtn && editorWithPreview) {
    previewBackBtn.addEventListener('click', function () {
      previewOpen = false;
      applyPreviewState();
    });
  }

  function setFilename(path) {
    currentFilePath = path;
    if (editorFilename) {
      editorFilename.textContent = path ? path.replace(/^.*[/\\]/, '') || path : '未命名';
    }
  }

  function initMonaco() {
    if (!container || !window.monaco) return;
    editor = window.monaco.editor.create(container, {
      value: '# 欢迎使用 MarkWrite\n\n在此编辑 Markdown，使用顶部 **打开 / 保存 / 另存为** 操作文件。\n',
      language: 'markdown',
      theme: 'vs-dark',
      automaticLayout: true,
      minimap: { enabled: true },
      fontSize: 14,
      lineNumbers: 'on',
      wordWrap: 'on',
    });
    setFilename(null);
    setupMdToolbar(editor);
    setupMdPreview(editor);
    if (window.markwrite && window.markwrite.api && typeof window.markwrite.api.onApplyEditorContent === 'function') {
      window.markwrite.api.onApplyEditorContent((content) => {
        if (!editor || typeof content !== 'string') return;
        showApplyEditorConfirm(content, (confirmed) => {
          if (confirmed) editor.setValue(content);
        });
      });
    }
  }

  function setupMdPreview(ed) {
    const el = document.getElementById('md-preview');
    if (!el) return;
    const render = async () => {
      const raw = ed.getValue();
      const placeholder = '预览将显示在这里…';
      if (window.markwrite && window.markwrite.api && typeof window.markwrite.api.renderMarkdown === 'function') {
        try {
          const html = await window.markwrite.api.renderMarkdown(raw || '');
          el.innerHTML = (html && html.trim()) ? html : '<p class="md-preview-empty">' + placeholder + '</p>';
          if (window.mermaid && typeof window.mermaid.run === 'function') {
            try {
              window.mermaid.run({ nodes: el.querySelectorAll('.mermaid') });
            } catch (_) {}
          }
        } catch (e) {
          el.innerHTML = '<p class="md-preview-error">渲染失败: ' + (e && e.message ? e.message : String(e)) + '</p><pre>' + (raw || '').slice(0, 2000) + '</pre>';
        }
      } else {
        el.textContent = (raw && raw.trim()) ? raw : placeholder;
      }
    };
    let t = null;
    ed.getModel().onDidChangeContent(() => {
      if (t) clearTimeout(t);
      t = setTimeout(render, 150);
    });
    render();
  }

  function setupMdToolbar(ed) {
    const model = ed.getModel();
    const getSelection = () => ed.getSelection();
    const getSelectedText = () => {
      const s = getSelection();
      return model.getValueInRange(s);
    };
    const replaceSelection = (text) => {
      const s = getSelection();
      ed.executeEdits('md-toolbar', [{ range: s, text }]);
    };
    const wrapSelection = (before, after, cursorInside) => {
      const s = getSelection();
      const t = getSelectedText();
      const text = t ? before + t + after : before + after;
      ed.executeEdits('md-toolbar', [{ range: s, text }]);
      if (cursorInside !== false) {
        const p = s.getStartPosition();
        const len = (t ? before.length + t.length : before.length);
        ed.setSelection({
          startLineNumber: p.lineNumber,
          startColumn: p.column + before.length,
          endLineNumber: p.lineNumber + (t ? (t.split('\n').length - 1) : 0),
          endColumn: p.column + len,
        });
        ed.revealPositionInCenter({ lineNumber: p.lineNumber, column: p.column + before.length });
      }
    };
    const getCurrentLine = () => {
      const p = getSelection().getStartPosition();
      return model.getLineContent(p.lineNumber);
    };
    const insertAtLineStart = (prefix) => {
      const p = getSelection().getStartPosition();
      const line = model.getLineContent(p.lineNumber);
      const stripped = line.replace(/^#+\s*/, '').trimStart();
      const r = { startLineNumber: p.lineNumber, startColumn: 1, endLineNumber: p.lineNumber, endColumn: line.length + 1 };
      ed.executeEdits('md-toolbar', [{ range: r, text: prefix + stripped }]);
      ed.setSelection({ startLineNumber: p.lineNumber, startColumn: prefix.length + 1, endLineNumber: p.lineNumber, endColumn: prefix.length + stripped.length + 1 });
    };
    const prefixLines = (getPrefixForLine) => {
      const s = getSelection();
      const start = s.startLineNumber;
      const end = s.endLineNumber;
      let text = '';
      for (let i = start; i <= end; i++) {
        const prefix = typeof getPrefixForLine === 'function' ? getPrefixForLine(i - start + 1, i) : getPrefixForLine;
        text += (i > start ? '\n' : '') + prefix + model.getLineContent(i);
      }
      ed.executeEdits('md-toolbar', [{ range: s, text }]);
    };

    const actions = {
      'md-bold': () => wrapSelection('**', '**'),
      'md-italic': () => wrapSelection('*', '*'),
      'md-strike': () => wrapSelection('~~', '~~'),
      'md-h1': () => insertAtLineStart('# '),
      'md-h2': () => insertAtLineStart('## '),
      'md-h3': () => insertAtLineStart('### '),
      'md-link': () => {
        const raw = getSelectedText();
        const defaultText = raw ? raw.replace(/\s+/g, ' ').trim() : '';
        const url = window.prompt('链接地址 (URL)', 'https://');
        if (url == null) return;
        const u = String(url).trim();
        if (!u) return;
        const linkText = defaultText || u;
        replaceSelection('[' + linkText + '](' + u + ')');
      },
      'md-image': () => {
        const raw = getSelectedText();
        const defaultAlt = raw ? raw.replace(/\s+/g, ' ').trim() : '';
        const url = window.prompt('图片地址 (URL)', 'https://');
        if (url == null) return;
        const u = String(url).trim();
        if (!u) return;
        const alt = defaultAlt || '图片';
        replaceSelection('![' + alt + '](' + u + ')');
      },
      'md-ul': () => prefixLines('- '),
      'md-ol': () => prefixLines((n) => n + '. '),
      'md-quote': () => prefixLines('> '),
      'md-code': () => wrapSelection('`', '`'),
      'md-fence': () => {
        const s = getSelection();
        const t = getSelectedText();
        const hasSelection = t && t.trim().length > 0;
        if (hasSelection) {
          const lines = t.split('\n');
          const lang = window.prompt('代码语言（可选，直接确定则留空）', '');
          const langPart = lang != null && String(lang).trim() ? String(lang).trim() + '\n' : '';
          replaceSelection('```' + langPart + t + '\n```');
        } else {
          const lang = window.prompt('代码语言（可选，直接确定则留空）', 'javascript');
          const langPart = lang != null && String(lang).trim() ? String(lang).trim() + '\n' : '';
          const insert = '```' + langPart + '\n\n```';
          ed.executeEdits('md-toolbar', [{ range: s, text: insert }]);
          const p = s.getStartPosition();
          const cursorCol = 4 + (langPart ? langPart.length : 0) + 1;
          ed.setSelection({ startLineNumber: p.lineNumber, startColumn: cursorCol, endLineNumber: p.lineNumber, endColumn: cursorCol });
          ed.revealPositionInCenter({ lineNumber: p.lineNumber, column: cursorCol });
        }
      },
      'md-hr': () => replaceSelection('\n\n---\n\n'),
      'md-table': () => {
        const raw = window.prompt('表格行数、列数（如 3,3），直接确定则插入 3×3', '3,3');
        let r = 3, c = 3;
        if (raw != null && raw.trim()) {
          const parts = raw.trim().split(/[,x×，\s]+/);
          if (parts.length >= 1) r = parseInt(parts[0], 10) || 3;
          if (parts.length >= 2) c = parseInt(parts[1], 10) || 3;
        }
        r = Math.max(1, Math.min(r, 20));
        c = Math.max(1, Math.min(c, 10));
        const cell = '   ';
        const headerRow = '|' + Array(c).fill(cell).join('|') + '|\n';
        const sepRow = '|' + Array(c).fill(' --- ').join('|') + '|\n';
        const bodyRows = Array(Math.max(0, r - 1)).fill(0).map(() => '|' + Array(c).fill(cell).join('|') + '|\n').join('');
        const table = '\n' + headerRow + sepRow + bodyRows;
        const s = getSelection();
        ed.executeEdits('md-toolbar', [{ range: s, text: table }]);
        const p = s.getStartPosition();
        ed.setSelection({ startLineNumber: p.lineNumber + 1, startColumn: 2, endLineNumber: p.lineNumber + 1, endColumn: 2 });
        ed.revealPositionInCenter({ lineNumber: p.lineNumber + 1, column: 2 });
      },
    };

    Object.keys(actions).forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.addEventListener('click', () => { if (ed) actions[id](); });
    });
  }

  if (window.monaco) {
    initMonaco();
  } else {
    window.addEventListener('monaco-ready', initMonaco);
  }

  if (btnOpen && window.markwrite && window.markwrite.api) {
    btnOpen.addEventListener('click', async () => {
      const result = await window.markwrite.api.openFile();
      if (result && editor) {
        editor.setValue(result.content);
        setFilename(result.filePath);
      }
    });
  }

  if (btnSave && window.markwrite && window.markwrite.api) {
    btnSave.addEventListener('click', async () => {
      if (!editor) return;
      const content = editor.getValue();
      if (currentFilePath) {
        const ok = await window.markwrite.api.saveFile(currentFilePath, content);
        if (ok) setFilename(currentFilePath);
      } else {
        const path = await window.markwrite.api.saveAs(content);
        if (path) setFilename(path);
      }
    });
  }

  if (btnSaveAs && window.markwrite && window.markwrite.api) {
    btnSaveAs.addEventListener('click', async () => {
      if (!editor) return;
      const path = await window.markwrite.api.saveAs(editor.getValue());
      if (path) setFilename(path);
    });
  }

  function appendMessage(role, content) {
    if (!aiMessages) return;
    const div = document.createElement('div');
    div.className = `ai-message ${role}`;
    div.textContent = content;
    aiMessages.appendChild(div);
    aiMessages.scrollTop = aiMessages.scrollHeight;
  }

  const aiStatusText = document.getElementById('ai-status-text');
  const aiStatusDot = document.getElementById('ai-status-dot');

  function setAiStatus(connected, label) {
    if (aiStatusText) aiStatusText.textContent = label || (connected ? 'Connected' : 'Disconnected');
    if (aiStatusDot) {
      aiStatusDot.classList.toggle('connected', !!connected);
    }
  }

  // 动态模型表：由后端从 config.json 读取 providers/models 后填充
  const AI_MODEL_PRESETS = {};
  function modelToSelectValue(m) {
    if (!m || typeof m !== 'object') return '';
    const pid = String(m.providerID || '');
    const mid = String(m.modelID || '');
    for (const k in AI_MODEL_PRESETS) {
      const v = AI_MODEL_PRESETS[k];
      if (v && v.providerID === pid && v.modelID === mid) return k;
    }
    return '';
  }
  const aiModelSelect = document.getElementById('ai-model-select');
  if (aiModelSelect && window.markwrite && window.markwrite.api && typeof window.markwrite.api.aiConfigGet === 'function') {
    function clearOptions() {
      if (!aiModelSelect) return;
      aiModelSelect.innerHTML = '';
    }

    function ensureOption(value, label, groupLabel) {
      if (!aiModelSelect) return;
      if ([...aiModelSelect.options].some((o) => o.value === value)) return;

      // Find or create optgroup
      let group = null;
      if (groupLabel) {
        group = [...aiModelSelect.querySelectorAll('optgroup')].find((g) => g.label === groupLabel) || null;
        if (!group) {
          group = document.createElement('optgroup');
          group.label = groupLabel;
          aiModelSelect.appendChild(group);
        }
      }

      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label || value;
      (group || aiModelSelect).appendChild(opt);
    }

    async function refreshModelsFromBackend() {
      if (!window.markwrite.api.aiModels) return;
      try {
        const directory = currentFilePath ? (currentFilePath.includes('/') ? currentFilePath.split('/').slice(0, -1).join('/') : undefined) : undefined;
        const r = await window.markwrite.api.aiModels(directory);
        if (!r || r.error) return;
        // 重建 options：完全以 config.json 为准
        clearOptions();
        for (const k in AI_MODEL_PRESETS) delete AI_MODEL_PRESETS[k];

        const data = r.providers;
        const providers = Array.isArray(data?.providers) ? data.providers : (Array.isArray(data) ? data : []);
        let firstValue = '';
        for (const p of providers) {
          if (!p || !p.id || !p.models) continue;
          const modelIDs = Object.keys(p.models || {});
          for (const mid of modelIDs) {
            const m = p.models[mid];
            const status = m && m.status ? String(m.status) : '';
            if (status && status !== 'active') continue;
            const presetKey = `${p.id}-${mid}`;
            if (!AI_MODEL_PRESETS[presetKey]) {
              AI_MODEL_PRESETS[presetKey] = { providerID: p.id, modelID: mid };
            }
            const groupLabel = p.id === 'volcengine'
              ? 'Volcengine Ark'
              : (p.id === 'ollama' ? 'Ollama' : `Provider · ${p.id}`);
            const label = (m && m.name) ? String(m.name) : mid;
            ensureOption(presetKey, label, groupLabel);
            if (!firstValue) firstValue = presetKey;
          }
        }

        // 设置当前选中：优先使用保存的选择，否则选第一个
        let desired = '';
        try {
          const cfg = await window.markwrite.api.aiConfigGet();
          const saved = (cfg && cfg.openagent && cfg.openagent.model) || (cfg && cfg.opencode && cfg.opencode.model);
          desired = modelToSelectValue(saved);
        } catch (_) {}
        aiModelSelect.value = desired || firstValue || '';
        if (!aiModelSelect.value) {
          const opt = document.createElement('option');
          opt.value = '';
          opt.textContent = '未在 config.json 中找到可用模型';
          aiModelSelect.appendChild(opt);
          aiModelSelect.value = '';
        }
      } catch (_) {}
    }

    refreshModelsFromBackend();
    aiModelSelect.addEventListener('change', function () {
      const preset = AI_MODEL_PRESETS[aiModelSelect.value];
      if (!preset) return;
      window.markwrite.api.aiConfigGet().then((cfg) => {
        if (!cfg) cfg = {};
        if (!cfg.openagent) cfg.openagent = {};
        cfg.openagent = { ...cfg.openagent, model: preset };
        return window.markwrite.api.aiConfigSave(cfg);
      }).catch(() => {});
    });
  }

  /**
   * 根据输入内容推断应为「聊天」还是「命令」模式
   * 命令：重命名、创建/新建文件、删除文件、另存为、运行等
   * 聊天：润色、修改、改标题、改写、优化、翻译、总结等（默认）
   */
  function suggestAiMode(text) {
    if (!text || typeof text !== 'string') return 'chat';
    const t = text.trim().toLowerCase();
    const cmdKeywords = [
      '重命名', '改名为', '改名字', '创建文件', '新建文件', '删除文件', '另存为', '保存为',
      '打开文件', '读取文件', '运行', '执行', 'run ', 'create file', 'rename', 'delete file',
      'new file', 'save as', 'open file', 'read file',
    ];
    for (const k of cmdKeywords) {
      if (t.includes(k.toLowerCase())) return 'cmd';
    }
    return 'chat';
  }

  if (aiModeChat && aiModeCmd) {
    function setAiMode(mode, fromUser) {
      aiMode = mode;
      if (fromUser) manualAiMode = mode;
      aiModeChat.classList.toggle('active', mode === 'chat');
      aiModeCmd.classList.toggle('active', mode === 'cmd');
    }
    aiModeChat.addEventListener('click', () => setAiMode('chat', true));
    aiModeCmd.addEventListener('click', () => setAiMode('cmd', true));
  }

  if (aiMessages) {
    if (window.markwrite && window.markwrite.api && typeof window.markwrite.api.aiHealth === 'function') {
      setAiStatus(false, '检测中…');
      const statusEl = document.createElement('div');
      statusEl.className = 'ai-message system';
      statusEl.textContent = '正在检测 AI 后端…';
      aiMessages.appendChild(statusEl);
      aiMessages.scrollTop = aiMessages.scrollHeight;

      window.markwrite.api.aiHealth().then((r) => {
        if (r && r.ok) {
          const name = r.backend === 'openagent' ? 'OpenAgent' : r.backend || 'AI';
          const extra = r.selfStarted ? '（已自动启动）' : '';
          setAiStatus(true, `${name} 已连接${extra}`);
          statusEl.textContent = `${name} 已连接${extra}${r.version ? ' ' + r.version : ''}。可直接在下方输入与 AI 对话，例如：“帮我重命名当前文档”“修改文内标题”等。`;
        } else {
          setAiStatus(false, (r && r.message) ? r.message : 'Disconnected · 请配置后端');
          statusEl.textContent = r && r.message ? r.message : 'AI 后端未连接。请在设置中选择后端（OpenAgent/OpenClaw）并配置。';
        }
        aiMessages.scrollTop = aiMessages.scrollHeight;
      }).catch(() => {
        setAiStatus(false, 'Disconnected · 请配置后端');
        statusEl.textContent = 'AI 后端未连接。请配置 OpenAgent（config.json 与 .env 中的 API Key）。';
        aiMessages.scrollTop = aiMessages.scrollHeight;
      });
    } else {
      setAiStatus(false, 'Disconnected · 请配置后端');
      appendMessage('system', 'AI 后端未连接。请在设置中配置。');
    }
  }

  /**
   * 替换策略：绝不把 AI 的整段回复直接当正文替换（可能含「第几行有问题」等说明）。
   * 只认「裸文档」——即写在 ``` 代码块里的内容，才允许一键替换到编辑器。
   *
   * 返回 { content, source }：
   * - source === 'code_block'：从回复中的 ```...``` 里提取得出的正文，可安全用于替换；
   * - source === 'none'：未找到可用的代码块，不提供替换（避免误用说明性文字覆盖原文）。
   */
  function extractReplaceableDocument(responseText, currentText) {
    if (!responseText || typeof responseText !== 'string') {
      return { content: '', source: 'none' };
    }
    const trimmed = responseText.trim();
    const fence = /```(\w*)\s*\n?([\s\S]*?)```/g;
    let best = null;
    let match;
    while ((match = fence.exec(trimmed)) !== null) {
      const content = (match[2] || '').trim();
      if (!content) continue;
      const lines = content.split('\n').length;
      if (!best || lines > (best.lines || 0)) {
        best = { content, lines };
      }
    }
    if (best && best.content) {
      let content = best.content;
      const lines = content.split('\n');
      let start = 0;
      let end = lines.length;
      while (start < end && /^\s*---\s*$/.test(lines[start])) start++;
      while (end > start && /^\s*---\s*$/.test(lines[end - 1])) end--;
      content = lines.slice(start, end).join('\n').trim();
      return { content: content || best.content, source: 'code_block' };
    }
    return { content: '', source: 'none' };
  }

  /**
   * 从 AI 回复中解析可执行的局部修改：每行 EDIT: 原文\t新文 或 EDIT: 原文 → 新文
   * 返回 [{ oldText, newText }]，无则返回 []
   */
  function parseEditInstructions(responseText) {
    if (!responseText || typeof responseText !== 'string') return [];
    const edits = [];
    const lines = responseText.split('\n');
    for (const line of lines) {
      const t = line.trim();
      const tabMatch = t.match(/^EDIT:\s*(.+?)\t(.+)$/);
      if (tabMatch) {
        edits.push({ oldText: tabMatch[1].trim(), newText: tabMatch[2].trim() });
        continue;
      }
      const arrowMatch = t.match(/^EDIT:\s*(.+?)\s*[→>\-]\s*(.+)$/);
      if (arrowMatch) {
        edits.push({ oldText: arrowMatch[1].trim(), newText: arrowMatch[2].trim() });
      }
    }
    return edits.filter((e) => e.oldText.length > 0);
  }

  /** 在编辑器中执行多组「原文→新文」替换；从文档末尾往前应用，避免偏移错位 */
  function applyEditsInEditor(ed, edits) {
    if (!ed || !ed.getModel || !edits.length) return;
    const model = ed.getModel();
    const operations = [];
    for (const { oldText, newText } of edits) {
      const matches = model.findMatches(oldText, true, false, false, null, false);
      for (const m of matches) {
        operations.push({ range: m.range, text: newText });
      }
    }
    if (operations.length === 0) return;
    operations.sort((a, b) => {
      const sa = a.range.getStartPosition();
      const sb = b.range.getStartPosition();
      return sb.lineNumber - sa.lineNumber || sb.column - sa.column;
    });
    ed.executeEdits('ai-edit', operations);
  }

  /** 计算当前内容与新区分的行级差异，用于展示「共 N 处修改」 */
  function getReplaceSummary(oldText, newText) {
    const oldLines = (oldText || '').split('\n');
    const newLines = (newText || '').split('\n');
    let changes = 0;
    for (let i = 0; i < Math.min(oldLines.length, newLines.length); i++) {
      if (oldLines[i] !== newLines[i]) changes += 1;
    }
    changes += Math.abs(oldLines.length - newLines.length);
    return {
      oldLines: oldLines.length,
      newLines: newLines.length,
      changes: Math.max(changes, oldLines.length === 0 && newLines.length > 0 ? newLines.length : changes),
    };
  }

  let aiBusy = false;
  let aiRequestToken = 0;
  let cancelCurrentChat = null;

  function sendChatMessage() {
    // 若当前有请求在进行中，则本次点击视为「停止上一次请求」
    if (aiBusy) {
      if (typeof cancelCurrentChat === 'function') {
        cancelCurrentChat();
      }
      aiBusy = false;
      cancelCurrentChat = null;
      if (aiSend) {
        aiSend.title = '发送';
        aiSend.innerHTML = '<i class="bi bi-arrow-up"></i>';
      }
      appendMessage('system', '⏹ 已停止本次请求。');
      return;
    }

    const msg = (aiInput && aiInput.value) ? aiInput.value.trim() : '';
    if (!msg) return;

    // 本地快速回答：不走 AI，直接读取 Monaco 内容回显。
    // 只要用户在问“编辑框内容是什么/帮我看看”，就拦截（避免 AI 说无法读取）。
    const isEditorContentQuery =
      /编辑(框|器)/.test(msg)
      && /内容|正文|文本/.test(msg)
      && /(是什么|是啥|查看|看看|帮我看|读一下|读取)/.test(msg);
    if (isEditorContentQuery) {
      const text = editor ? editor.getValue() : '';
      const shown = (text || '').trim() ? text : '（当前编辑器为空）';
      appendMessage('user', msg);
      appendMessage('assistant', shown);
      aiInput.value = '';
      return;
    }

    // 若编辑器尚未初始化，直接提示并阻止发送（否则 editorContent 为空，AI 会误以为无正文）
    if (!editor) {
      appendMessage('user', msg);
      appendMessage('system', '编辑器尚未就绪，请稍等 1-2 秒后再试。');
      aiInput.value = '';
      return;
    }

    if (manualAiMode !== null) {
      aiMode = manualAiMode;
    } else {
      aiMode = suggestAiMode(msg);
      if (aiModeChat && aiModeCmd) {
        aiModeChat.classList.toggle('active', aiMode === 'chat');
        aiModeCmd.classList.toggle('active', aiMode === 'cmd');
      }
    }

    appendMessage('user', msg);
    aiInput.value = '';

    const wrap = document.createElement('div');
    wrap.className = 'ai-message-assistant-wrap';
    const contentDiv = document.createElement('div');
    contentDiv.className = 'ai-message assistant';
    contentDiv.textContent = '.';
    const summaryDiv = document.createElement('div');
    summaryDiv.className = 'ai-apply-summary';
    summaryDiv.style.display = 'none';
    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'ai-apply-btn';
    applyBtn.textContent = '确认替换';
    applyBtn.style.display = 'none';
    const applyEditsBtn = document.createElement('button');
    applyEditsBtn.type = 'button';
    applyEditsBtn.className = 'ai-apply-btn ai-apply-edits-btn';
    applyEditsBtn.textContent = '应用局部修改';
    applyEditsBtn.style.display = 'none';
    wrap.appendChild(contentDiv);
    wrap.appendChild(summaryDiv);
    wrap.appendChild(applyBtn);
    wrap.appendChild(applyEditsBtn);
    if (aiMessages) aiMessages.appendChild(wrap);
    aiMessages.scrollTop = aiMessages.scrollHeight;

    if (!window.markwrite || !window.markwrite.api || typeof window.markwrite.api.aiChat !== 'function') {
      contentDiv.textContent = 'AI 接口未就绪，请重启应用。';
      if (aiMessages) aiMessages.scrollTop = aiMessages.scrollHeight;
      return;
    }

    aiBusy = true;
    const myToken = ++aiRequestToken;
    if (aiSend) {
      aiSend.title = '停止本次回答';
      aiSend.innerHTML = '<i class="bi bi-stop-fill"></i>';
    }

    const dots = ['.', '..', '...'];
    let step = 0;
    const loadingTimer = setInterval(() => {
      step = (step + 1) % dots.length;
      contentDiv.textContent = dots[step];
    }, 400);

    cancelCurrentChat = () => {
      clearInterval(loadingTimer);
      cancelCurrentChat = null;
      // 递增 token，令本次请求的后续结果被忽略
      aiRequestToken++;
      contentDiv.textContent = '（已停止）';
      if (aiMessages) aiMessages.scrollTop = aiMessages.scrollHeight;
    };

    const editorContext = {
      editorContent: editor ? editor.getValue() : '',
      filename: currentFilePath || '未命名',
    };

    const useCmd = aiMode === 'cmd' && typeof window.markwrite.api.aiDocEdit === 'function';
    const chatFn = useCmd ? window.markwrite.api.aiDocEdit : window.markwrite.api.aiChat;

    (async () => {
      try {
        const result = await chatFn(msg, editorContext);
        if (myToken !== aiRequestToken) return; // 已被取消或有更新请求
        clearInterval(loadingTimer);
        const hasError = result && result.error;
        const text = hasError ? result.error : (result && result.text ? result.text : '（无回复）');
        contentDiv.textContent = text;

        if (useCmd && !hasError && result && result.fileModified && editor && currentFilePath) {
          try {
            const reloaded = await window.markwrite.api.fileRead(currentFilePath);
            if (reloaded && reloaded.content != null) {
              editor.setValue(reloaded.content);
              appendMessage('system', '✅ 文件已被 AI 修改，已从磁盘重新加载。');
            }
          } catch (_) {}
        }

        if (!hasError && editor && text && text !== '（无回复）') {
          const currentText = editor.getValue();
          const { content: appliedText, source } = extractReplaceableDocument(text, currentText);
          const parsedEdits = parseEditInstructions(text);
          const onlyFromCodeBlock = source === 'code_block';
          const hasLocalEdits = parsedEdits.length > 0;

          if (onlyFromCodeBlock && appliedText.length > 0) {
            const sum = getReplaceSummary(currentText, appliedText);
            summaryDiv.textContent = `已从回复的代码块中提取文档（当前 ${sum.oldLines} 行 → 新内容 ${sum.newLines} 行，共 ${sum.changes} 处修改）。点击下方按钮全部替换。`;
            summaryDiv.style.display = 'block';
            applyBtn.style.display = 'inline-block';
            applyBtn.onclick = () => {
              if (!editor) return;
              showApplyEditorConfirm(appliedText, (confirmed) => {
                if (!confirmed) return;
                editor.setValue(appliedText);
                appendMessage('system', '✅ 已全部替换到编辑器。');
              });
            };
          } else if (!onlyFromCodeBlock && !hasLocalEdits) {
            // 不再提示“未检测到可替换内容”，避免干扰用户阅读（用户可继续对话或让 AI 调用工具）。
          }

          if (hasLocalEdits) {
            if (summaryDiv.style.display !== 'block') summaryDiv.style.display = 'block';
            const editHint = `解析到 ${parsedEdits.length} 处局部修改（EDIT 行），点击下方按钮应用到编辑器。`;
            if (!summaryDiv.textContent) summaryDiv.textContent = editHint;
            else summaryDiv.textContent += ' ' + editHint;
            applyEditsBtn.textContent = `应用局部修改（${parsedEdits.length} 处）`;
            applyEditsBtn.style.display = 'inline-block';
            applyEditsBtn.onclick = () => {
              if (editor) {
                applyEditsInEditor(editor, parsedEdits);
                appendMessage('system', `✅ 已应用 ${parsedEdits.length} 处局部修改。`);
              }
            };
          }
        }
      } catch (e) {
        if (myToken !== aiRequestToken) return;
        clearInterval(loadingTimer);
        contentDiv.textContent = '请求失败: ' + (e && e.message ? e.message : String(e));
      } finally {
        if (myToken === aiRequestToken) {
          aiBusy = false;
          cancelCurrentChat = null;
          if (aiSend) {
            aiSend.title = '发送';
            aiSend.innerHTML = '<i class="bi bi-arrow-up"></i>';
          }
        }
        if (aiMessages) aiMessages.scrollTop = aiMessages.scrollHeight;
      }
    })();
  }

  if (aiSend && aiInput) {
    aiSend.addEventListener('click', sendChatMessage);
    aiInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage();
      }
    });
  }
});
