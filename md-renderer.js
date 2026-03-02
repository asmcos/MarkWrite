/**
 * Markdown 渲染器：行为与 VitePress 类似
 * - mermaid 代码块输出为 <div class="mermaid">
 * - 普通代码块带 code-header、复制按钮、语法高亮
 */
const MarkdownIt = require('markdown-it');
const hljs = require('highlight.js');

function createMarkdownRenderer() {
  const md = new MarkdownIt({
    html: true,
    highlight: function (str, lang) {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(str, { language: lang }).value;
        } catch (_) {}
      }
      return md.utils.escapeHtml(str);
    },
  });

  const defaultFence = md.renderer.rules.fence;
  md.renderer.rules.fence = function (tokens, idx, options, env, self) {
    const token = tokens[idx];
    const info = token.info ? md.utils.unescapeAll(token.info).trim() : '';
    const code = token.content.trim();
    const lines = code.split('\n').length;

    let langName = '';
    let langAttrs = '';
    if (info) {
      const arr = info.split(/(\s+)/g);
      langName = arr[0] || '';
      langAttrs = arr.slice(2).join('');
    }

    if (langName === 'mermaid') {
      const id = `mermaid-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
      return `<div id="${id}" class="mermaid">${token.content}</div>`;
    }

    let inner;
    const highlightFn = options.highlight || md.options.highlight;
    if (highlightFn) {
      const out = highlightFn(token.content, langName, langAttrs);
      inner = (out && typeof out === 'string') ? out : md.utils.escapeHtml(token.content);
    } else {
      inner = md.utils.escapeHtml(token.content);
    }
    const highlighted = `<pre><code class="hljs${langName ? ' language-' + langName : ''}">${inner}</code></pre>`;

    if (lines <= 3) {
      return `<div class="code-block">
          <div class="code-header">
            <span>${langName}</span>
            <button class="copy-btn" onclick="copyCode(this)">复制</button>
          </div>
        ${highlighted}
      </div>`;
    }

    return `<div class="code-block">
      <div class="code-header">
        <div class="code-header-left">
          <span class="dot red"></span>
          <span class="dot yellow"></span>
          <span class="dot green"></span>
        </div>
        <span>${langName}</span>
        <button class="copy-btn" onclick="copyCode(this)">复制</button>
      </div>
      ${highlighted}
    </div>`;
  };

  return md;
}

const md = createMarkdownRenderer();

function render(markdown) {
  return md.render(markdown || '');
}

module.exports = { render, createMarkdownRenderer };
