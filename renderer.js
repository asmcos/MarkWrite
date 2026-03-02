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

  let editor = null;
  let currentFilePath = null;

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

  if (aiMessages) {
    if (window.markwrite && window.markwrite.api && typeof window.markwrite.api.aiHealth === 'function') {
      const statusEl = document.createElement('div');
      statusEl.className = 'ai-message system';
      statusEl.textContent = '正在检测 AI 后端…';
      aiMessages.appendChild(statusEl);
      aiMessages.scrollTop = aiMessages.scrollHeight;

      window.markwrite.api.aiHealth().then((r) => {
        if (r && r.ok) {
          const name = r.backend === 'opencode' ? 'OpenCode' : r.backend || 'AI';
          const extra = r.selfStarted ? '（已自动启动本地服务）' : '';
          statusEl.textContent = `${name} 已连接${extra}${r.version ? ' ' + r.version : ''}。可直接在下方输入与 AI 对话，例如：“帮我重命名当前文档”“修改文内标题”等。`;
        } else {
          statusEl.textContent = r && r.message ? r.message : 'AI 后端未连接。请在设置中选择后端（OpenCode/OpenClaw）并配置。';
        }
        aiMessages.scrollTop = aiMessages.scrollHeight;
      }).catch(() => {
        statusEl.textContent = 'AI 后端未连接。请在设置中配置后端（如 OpenCode：默认 http://127.0.0.1:4096）。';
        aiMessages.scrollTop = aiMessages.scrollHeight;
      });
    } else {
      appendMessage('system', 'AI 后端未连接。请在设置中配置。');
    }
  }

  function sendChatMessage() {
    const msg = (aiInput && aiInput.value) ? aiInput.value.trim() : '';
    if (!msg) return;
    appendMessage('user', msg);
    aiInput.value = '';

    const placeholder = document.createElement('div');
    placeholder.className = 'ai-message assistant';
    placeholder.textContent = '.';
    if (aiMessages) aiMessages.appendChild(placeholder);
    aiMessages.scrollTop = aiMessages.scrollHeight;

    if (!window.markwrite || !window.markwrite.api || typeof window.markwrite.api.aiChat !== 'function') {
      placeholder.textContent = 'AI 接口未就绪，请重启应用。';
      if (aiMessages) aiMessages.scrollTop = aiMessages.scrollHeight;
      return;
    }

    const dots = ['.', '..', '...'];
    let step = 0;
    const loadingTimer = setInterval(() => {
      step = (step + 1) % dots.length;
      placeholder.textContent = dots[step];
    }, 400);

    (async () => {
      try {
        const result = await window.markwrite.api.aiChat(msg);
        clearInterval(loadingTimer);
        placeholder.textContent = result.error || result.text || '（无回复）';
      } catch (e) {
        clearInterval(loadingTimer);
        placeholder.textContent = '请求失败: ' + (e && e.message ? e.message : String(e));
      }
      if (aiMessages) aiMessages.scrollTop = aiMessages.scrollHeight;
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
