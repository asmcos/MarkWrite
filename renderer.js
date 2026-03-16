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
  // 旧的文件操作按钮（已在 UI 隐藏，仍可复用其逻辑）
  const btnOpen = document.getElementById('btn-open');
  const btnToggleExplorer = document.getElementById('btn-toggle-explorer');
  const btnExpandExplorer = document.getElementById('btn-expand-explorer');
  const btnRefreshFiles = document.getElementById("btn-refresh-files");
  const btnNew = document.getElementById('btn-new');
  const btnSave = document.getElementById('btn-save');
  const btnSaveAs = document.getElementById('btn-saveas');
  // 顶部自定义菜单项
  const menuFileNew = document.getElementById('menu-file-new');
  const menuFileOpen = document.getElementById('menu-file-open');
  const menuFileSave = document.getElementById('menu-file-save');
  const menuFileSaveAs = document.getElementById('menu-file-saveas');
  const menuFileOpenWorkspace = document.getElementById('menu-file-open-workspace');
  const menuViewToggleExplorer = document.getElementById('menu-view-toggle-explorer');
  const menuViewTogglePreview = document.getElementById('menu-view-toggle-preview');
  const menuViewToggleDevTools = document.getElementById('menu-view-toggle-devtools');
  const menuSettingsOpen = document.getElementById('menu-settings-open');
  // 设置弹窗元素
  const settingsOverlay = document.getElementById('settings-overlay');
  const settingsCloseBtn = document.getElementById('settings-close-btn');
  const settingsCancelBtn = document.getElementById('settings-cancel-btn');
  const settingsSaveBtn = document.getElementById('settings-save-btn');
  const settingsTabs = Array.from(document.querySelectorAll('.settings-tab'));
  const settingsPanels = Array.from(document.querySelectorAll('.settings-panel'));
  const settingsEsserver = document.getElementById('settings-sync-esserver');
  const settingsUploadpath = document.getElementById('settings-sync-uploadpath');
  const settingsSitename = document.getElementById('settings-sync-sitename');
  const settingsDomain = document.getElementById('settings-sync-domain');
  const settingsWorkspaceCurrent = document.getElementById('settings-workspace-current');
  const previewToggle = document.getElementById('preview-toggle');
  const editorWithPreview = document.getElementById('editor-with-preview');
  const splitterChat = document.getElementById('splitter-chat');
  const fileTreeEl = document.getElementById('file-tree');
  const aiMessages = document.getElementById('ai-messages');
  const aiInput = document.getElementById('ai-input');
  const aiSend = document.getElementById('ai-send');
  const btnWinMin = document.getElementById('window-minimize');
  const btnWinMax = document.getElementById('window-maximize');
  const btnWinClose = document.getElementById('window-close');
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
  // ---- VSCode-like 布局：聊天宽度拖拽 + 文件侧栏收起/展开 ----
  const LAYOUT_CHAT_WIDTH_KEY = 'markwrite-layout-chat-width'; // number px
  const LAYOUT_EXPLORER_HIDDEN_KEY = 'markwrite-layout-explorer-hidden'; // '1' | '0'

  function getChatWidth() {
    try {
      const v = parseInt(localStorage.getItem(LAYOUT_CHAT_WIDTH_KEY) || '', 10);
      if (!Number.isFinite(v)) return 320;
      return Math.max(240, Math.min(900, v));
    } catch (_) {
      return 320;
    }
  }

  function getExplorerHidden() {
    try {
      return localStorage.getItem(LAYOUT_EXPLORER_HIDDEN_KEY) === '1';
    } catch (_) {
      return false;
    }
  }

  function applyLayoutState() {
    const explorerHidden = getExplorerHidden();
    document.body.setAttribute('data-explorer-hidden', explorerHidden ? '1' : '0');
    document.documentElement.style.setProperty('--chat-width', `${getChatWidth()}px`);

    if (btnToggleExplorer) {
      btnToggleExplorer.title = explorerHidden ? '展开文件侧栏' : '收起文件侧栏';
    }
    if (btnExpandExplorer) {
      btnExpandExplorer.title = explorerHidden ? '展开文件侧栏' : '文件侧栏已展开';
    }
  }

  function toggleExplorer() {
    const nextHidden = !getExplorerHidden();
    try { localStorage.setItem(LAYOUT_EXPLORER_HIDDEN_KEY, nextHidden ? '1' : '0'); } catch (_) {}
    applyLayoutState();
  }

  // ---- 顶部菜单项与原有按钮的行为复用 ----
  function doNewFile() {
    if (!editor) return;
    editor.setValue('');
    setFilename(null);
    editor.focus();
  }

  async function doOpenFileOrWorkspace() {
    if (!window.markwrite || !window.markwrite.api) return;
    const result = await window.markwrite.api.openFile();
    if (!result) return;
    // 若选择的是目录，则将该目录作为文件树根；若选择的是文件，则打开文件并将其所在目录作为文件树根
    if (result.directory) {
      setFileRoot(result.directory);
      await loadFileTree();
    } else if (result.filePath && editor) {
      editor.setValue(result.content);
      setFilename(result.filePath);
      const dir = result.filePath.replace(/[\\/][^\\/]+$/, '');
      if (dir) {
        setFileRoot(dir);
        await loadFileTree();
      }
    }
  }

  async function doSave() {
    if (!editor || !window.markwrite || !window.markwrite.api) return;
    const content = editor.getValue();
    if (currentFilePath) {
      const ok = await window.markwrite.api.saveFile(currentFilePath, content);
      if (ok) setFilename(currentFilePath);
    } else {
      const p = await window.markwrite.api.saveAs(content);
      if (p) setFilename(p);
    }
  }

  async function doSaveAs() {
    if (!editor || !window.markwrite || !window.markwrite.api) return;
    const p = await window.markwrite.api.saveAs(editor.getValue());
    if (p) setFilename(p);
  }

  applyLayoutState();
  if (btnToggleExplorer) btnToggleExplorer.addEventListener('click', toggleExplorer);
  if (btnExpandExplorer) btnExpandExplorer.addEventListener('click', () => {
    try { localStorage.setItem(LAYOUT_EXPLORER_HIDDEN_KEY, '0'); } catch (_) {}
    applyLayoutState();
  });
  if (btnRefreshFiles && window.markwrite && window.markwrite.api) {
    btnRefreshFiles.addEventListener("click", () => { void loadFileTree(); });
  }

  // 顶部菜单中的 View → Toggle Explorer 复用相同行为
  if (menuViewToggleExplorer) {
    menuViewToggleExplorer.addEventListener('click', () => {
      toggleExplorer();
    });
  }

  // 右侧聊天面板宽度：拖拽分隔线调整（像 VSCode）
  if (splitterChat) {
    let dragging = false;
    let startX = 0;
    let startWidth = 320;
    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const next = Math.max(240, Math.min(900, startWidth - dx));
      document.documentElement.style.setProperty('--chat-width', `${next}px`);
    };
    const onUp = (e) => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('is-resizing');
      const dx = e.clientX - startX;
      const next = Math.max(240, Math.min(900, startWidth - dx));
      try { localStorage.setItem(LAYOUT_CHAT_WIDTH_KEY, String(next)); } catch (_) {}
      document.documentElement.style.setProperty('--chat-width', `${next}px`);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    splitterChat.addEventListener('mousedown', (e) => {
      dragging = true;
      startX = e.clientX;
      startWidth = getChatWidth();
      document.body.classList.add('is-resizing');
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  }

  // ----- 设置弹窗：Tab 切换与打开/关闭 -----
  function openSettingsModal() {
    if (!settingsOverlay) return;
    settingsOverlay.style.display = 'flex';
    // 默认选中 Sync Tab
    if (settingsTabs.length && settingsPanels.length) {
      const first = settingsTabs[0];
      const tabName = first.getAttribute('data-tab');
      switchSettingsTab(tabName || 'sync');
    }
    // 预填 Workspace 只读展示
    if (settingsWorkspaceCurrent && window.markwrite?.api?.getDefaultWorkspace) {
      window.markwrite.api.getDefaultWorkspace().then((r) => {
        if (!r) return;
        settingsWorkspaceCurrent.value = r.path || '';
      }).catch(() => {});
    }
  }

  function closeSettingsModal() {
    if (!settingsOverlay) return;
    settingsOverlay.style.display = 'none';
  }

  function switchSettingsTab(name) {
    settingsTabs.forEach((tab) => {
      const t = tab.getAttribute('data-tab');
      tab.classList.toggle('active', t === name);
    });
    settingsPanels.forEach((panel) => {
      const t = panel.getAttribute('data-tab-panel');
      // eslint-disable-next-line no-param-reassign
      panel.style.display = t === name ? 'block' : 'none';
    });
  }

  if (settingsTabs.length) {
    settingsTabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        const name = tab.getAttribute('data-tab') || 'sync';
        switchSettingsTab(name);
      });
    });
  }
  if (settingsOverlay) {
    settingsOverlay.addEventListener('click', (e) => {
      if (e.target === settingsOverlay) closeSettingsModal();
    });
  }
  if (settingsCloseBtn) settingsCloseBtn.addEventListener('click', closeSettingsModal);
  if (settingsCancelBtn) settingsCancelBtn.addEventListener('click', closeSettingsModal);
  if (settingsSaveBtn) {
    // 目前 Sync / Workspace 仅展示占位，保存按钮先作为“关闭”使用
    settingsSaveBtn.addEventListener('click', closeSettingsModal);
  }

  // 菜单触发 Settings 弹窗
  if (menuSettingsOpen) {
    menuSettingsOpen.addEventListener('click', () => {
      openSettingsModal();
    });
  }

  // 在编辑器里 Ctrl+V 粘贴图片：仅当焦点在 Monaco 时处理，通过主进程 clipboard 读图并存入 uploads
  window.addEventListener('paste', async (e) => {
    try {
      if (!editor || !window.markwrite?.api?.uploadClipboardImage) return;
      if (typeof editor.hasTextFocus === 'function' && !editor.hasTextFocus()) return;
      e.preventDefault();
      const res = await window.markwrite.api.uploadClipboardImage();
      if (!res?.ok || !res.webPath) return;
      const model = editor.getModel();
      const sel = editor.getSelection();
      if (!sel) return;
      const range = {
        startLineNumber: sel.startLineNumber,
        startColumn: sel.startColumn,
        endLineNumber: sel.endLineNumber,
        endColumn: sel.endColumn,
      };
      const raw = model.getValueInRange(sel);
      const defaultAlt = raw ? raw.replace(/\s+/g, ' ').trim() : '';
      const alt = defaultAlt || '图片';
      const url = res.webPath;
      editor.executeEdits('paste-image', [{ range, text: '![' + alt + '](' + url + ')' }]);
      editor.focus();
    } catch (_) {
      // 忽略粘贴图片过程中的错误，避免影响普通文本粘贴
    }
  }, true);

  // 文件树：简单目录浏览，root = 应用工作目录
  const FILE_TREE_KEY = 'markwrite-filetree-expanded'; // JSON: { [path]: boolean }
  const FILE_TREE_ROOT_KEY = 'markwrite-filetree-root'; // string | null
  let fileRootPath = null;
  try {
    const rawRoot = localStorage.getItem(FILE_TREE_ROOT_KEY);
    if (rawRoot && typeof rawRoot === 'string') fileRootPath = rawRoot;
  } catch (_) {
    fileRootPath = null;
  }
  let fileTreeState = {};
  try {
    const raw = localStorage.getItem(FILE_TREE_KEY);
    if (raw) fileTreeState = JSON.parse(raw) || {};
  } catch (_) {
    fileTreeState = {};
  }
  function saveFileTreeState() {
    try { localStorage.setItem(FILE_TREE_KEY, JSON.stringify(fileTreeState)); } catch (_) {}
  }

  function setFileRoot(path) {
    fileRootPath = path || null;
    try {
      if (fileRootPath) localStorage.setItem(FILE_TREE_ROOT_KEY, fileRootPath);
      else localStorage.removeItem(FILE_TREE_ROOT_KEY);
    } catch (_) {}
    // 同步当前工作区根目录到主进程，便于相对路径读写都基于该工作区
    if (fileRootPath && window.markwrite?.api?.setWorkspaceRoot) {
      try { void window.markwrite.api.setWorkspaceRoot(fileRootPath); } catch (_) {}
    }
  }

  function markFileSelected(targetPath) {
    if (!fileTreeEl) return;
    const items = fileTreeEl.querySelectorAll('.file-list-item');
    items.forEach((el) => {
      if (!el || !el.dataset) return;
      const p = el.dataset.path;
      if (p === targetPath) el.classList.add('is-selected');
      else el.classList.remove('is-selected');
    });
  }

  function renderFileTreeNode(entry, depth) {
    const li = document.createElement('li');
    li.className = 'file-list-item' + (entry.isDir ? ' is-dir' : '');
    li.dataset.path = entry.path;
    li.dataset.isDir = entry.isDir ? '1' : '0';
    li.dataset.depth = String(depth);

    const indent = document.createElement('span');
    indent.className = 'file-indent';
    indent.style.marginLeft = depth > 0 ? (depth * 12) + 'px' : '0px';
    li.appendChild(indent);

    const toggle = document.createElement('span');
    toggle.className = 'file-toggle';
    if (!entry.isDir) toggle.classList.add('hidden');
    if (entry.isDir) {
      toggle.innerHTML = fileTreeState[entry.path]
        ? '<i class="bi bi-chevron-down"></i>'
        : '<i class="bi bi-chevron-right"></i>';
    }
    li.appendChild(toggle);

    const icon = document.createElement('span');
    icon.className = 'file-icon';
    if (entry.isDir) {
      icon.innerHTML = '<i class="bi bi-folder2"></i>';
    } else {
      const name = entry.name || '';
      const idx = name.lastIndexOf('.');
      const ext = idx > 0 ? name.slice(idx + 1).toLowerCase() : '';
      let cls = 'bi-file-earmark-text';
      if (ext === 'md' || ext === 'markdown') cls = 'bi-journal-text';
      else if (ext === 'js' || ext === 'jsx') cls = 'bi-filetype-js';
      else if (ext === 'ts' || ext === 'tsx') cls = 'bi-filetype-tsx';
      else if (ext === 'json') cls = 'bi-filetype-json';
      else if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'gif' || ext === 'webp') cls = 'bi-file-image';
      else if (ext === 'css' || ext === 'scss' || ext === 'less') cls = 'bi-filetype-css';
      else if (ext === 'html' || ext === 'htm') cls = 'bi-filetype-html';
      icon.innerHTML = `<i class="bi ${cls}"></i>`;
    }
    li.appendChild(icon);

    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = entry.name;
    li.appendChild(name);

    if (entry.isDir) {
      li.addEventListener('click', async (e) => {
        if (li.classList.contains('is-renaming')) return;
        // 点击 toggle 或行都展开/收起
        if (toggle.contains(e.target) || e.target === name || e.target === icon || e.target === indent) {
          const cur = !!fileTreeState[entry.path];
          fileTreeState[entry.path] = !cur;
          saveFileTreeState();
          await loadFileTree();
          markFileSelected(entry.path);
        }
      });
    } else {
      li.addEventListener('click', async (e) => {
        if (li.classList.contains('is-renaming')) return;
        if (e.target && e.target.tagName === 'INPUT') return;
        if (!window.markwrite || !window.markwrite.api || !editor) return;
        const res = await window.markwrite.api.fileRead(entry.path);
        if (res && typeof res.content === 'string') {
          editor.setValue(res.content);
          setFilename(entry.path);
          markFileSelected(entry.path);
        }
      });
    }

    // 右键菜单：重命名 / 删除
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!window.markwrite || !window.markwrite.api) return;
      const existing = document.getElementById('file-tree-context-menu');
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      const menu = document.createElement('div');
      menu.id = 'file-tree-context-menu';
      menu.style.position = 'fixed';
      menu.style.zIndex = '9999';
      menu.style.minWidth = '120px';
      menu.style.background = '#020617';
      menu.style.border = '1px solid rgba(148,163,184,0.5)';
      menu.style.borderRadius = '6px';
      menu.style.boxShadow = '0 10px 30px rgba(0,0,0,0.6)';
      menu.style.fontSize = '12px';
      menu.style.color = '#e5e7eb';
      menu.style.padding = '4px 0';

      const makeItem = (label) => {
        const item = document.createElement('div');
        item.textContent = label;
        item.style.padding = '4px 10px';
        item.style.cursor = 'pointer';
        item.addEventListener('mouseenter', () => { item.style.background = 'rgba(51,65,85,0.9)'; });
        item.addEventListener('mouseleave', () => { item.style.background = 'transparent'; });
        return item;
      };

      const doClose = () => {
        if (menu.parentNode) menu.parentNode.removeChild(menu);
        window.removeEventListener('click', onWindowClick, true);
        window.removeEventListener('contextmenu', onWindowClick, true);
      };
      const onWindowClick = (evt) => {
        if (evt.target === menu || menu.contains(evt.target)) return;
        doClose();
      };

      const renameItem = makeItem('重命名');
      renameItem.addEventListener('click', () => {
        doClose();
        // 行内重命名：用一个小输入框替换名称
        const currentName = entry.name || '';
        const input = document.createElement('input');
        input.type = 'text';
        input.value = currentName;
        input.style.width = '100%';
        input.style.border = '1px solid rgba(148,163,184,0.6)';
        input.style.borderRadius = '4px';
        input.style.background = 'rgba(15,23,42,0.95)';
        input.style.color = '#e5e7eb';
        input.style.fontSize = '12px';
        input.style.padding = '1px 4px';
        input.style.boxSizing = 'border-box';

        li.classList.add('is-renaming');
        const oldText = name.textContent;
        name.textContent = '';
        name.appendChild(input);
        input.focus();
        input.select();

        const finish = async (commit) => {
          li.classList.remove('is-renaming');
          const newName = String(input.value || '').trim();
          if (name.contains(input)) {
            name.removeChild(input);
          }
          name.textContent = entry.name; // 先恢复旧名，成功后刷新树
          if (!commit || !newName || newName === currentName) return;
          try {
            const res = await window.markwrite.api.renameFile(entry.path, newName);
            if (res && res.ok && res.newPath) {
              if (currentFilePath === entry.path) {
                currentFilePath = res.newPath;
                setFilename(res.newPath);
              }
              await loadFileTree();
              markFileSelected(res.newPath);
            } else if (res && res.message) {
              window.alert(`重命名失败：${res.message}`);
            }
          } catch (_) {
            window.alert('重命名失败');
          }
        };

        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            finish(true);
          } else if (ev.key === 'Escape') {
            ev.preventDefault();
            finish(false);
          }
        });
        input.addEventListener('blur', () => finish(true));
      });

      const deleteItem = makeItem('删除');
      deleteItem.style.color = '#fecaca';
      deleteItem.addEventListener('click', async () => {
        doClose();
        const isDir = !!entry.isDir;
        const ok = window.confirm(isDir ? `确定删除目录及其所有内容？\n${entry.path}` : `确定删除文件？\n${entry.path}`);
        if (!ok) return;
        try {
          const res = await window.markwrite.api.deleteFile(entry.path);
          if (res && res.ok) {
            if (currentFilePath === entry.path) {
              currentFilePath = null;
              if (editor) editor.setValue('');
              setFilename(null);
            }
            await loadFileTree();
          } else if (res && res.message) {
            window.alert(`删除失败：${res.message}`);
          }
        } catch (err) {
          window.alert('删除失败');
        }
      });

      menu.appendChild(renameItem);
      menu.appendChild(deleteItem);

      const x = e.clientX;
      const y = e.clientY;
      menu.style.left = `${x}px`;
      menu.style.top = `${y}px`;
      document.body.appendChild(menu);
      window.addEventListener('click', onWindowClick, true);
      window.addEventListener('contextmenu', onWindowClick, true);
    });

    return li;
  }

  async function buildTree(basePath, depth, container) {
    const res = await window.markwrite.api.listDir(basePath || null);
    if (!res || res.error) return;
    const { path: base, entries } = res;
    const list = entries || [];

    // 若目录为空，顶层给用户一点“有东西”的反馈（类似 . ..）
    if (list.length === 0 && depth === 0) {
      const makePlaceholder = (label, title) => {
        const li = document.createElement('li');
        li.className = 'file-list-item';
        li.style.opacity = '0.6';
        const name = document.createElement('span');
        name.className = 'file-name';
        name.textContent = label;
        if (title) name.title = title;
        li.appendChild(name);
        return li;
      };
      container.appendChild(makePlaceholder('.', `当前工作区: ${base}`));
      container.appendChild(makePlaceholder('..', '该目录为空，可以通过上方“打开”或在此工作区新建文件/子目录'));
      return;
    }

    for (const entry of list) {
      const node = renderFileTreeNode(
        { ...entry, parentPath: base },
        depth
      );
      container.appendChild(node);
      if (entry.isDir && fileTreeState[entry.path]) {
        // 递归展开已标记为展开的目录（保证子目录紧跟在父目录后面）
        // eslint-disable-next-line no-await-in-loop
        await buildTree(entry.path, depth + 1, container);
      }
    }
  }

  async function loadFileTree() {
    if (!fileTreeEl || !window.markwrite || !window.markwrite.api) return;
    fileTreeEl.innerHTML = '';
    await buildTree(fileRootPath, 0, fileTreeEl);
  }

  // 启动时加载一次文件树（默认 root = ~/markwrite-docs，未保存过则用该工作区）
  (async () => {
    if (!fileRootPath && window.markwrite?.api?.getDefaultWorkspace) {
      try {
        const r = await window.markwrite.api.getDefaultWorkspace();
        if (r?.path) setFileRoot(r.path);
      } catch (_) {}
    }
    await loadFileTree();
  })();

  // 监听工作区目录变更：有变化时自动刷新左侧文件树
  if (window.markwrite?.api?.onWorkspaceChanged) {
    try {
      window.markwrite.api.onWorkspaceChanged(() => {
        void loadFileTree();
      });
    } catch (_) {}
  }

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

  // 顶部菜单中的 View → Toggle Preview：直接切换预览开关
  if (menuViewTogglePreview) {
    menuViewTogglePreview.addEventListener('click', () => {
      previewOpen = !previewOpen;
      applyPreviewState();
    });
  }

  // View → Toggle DevTools：调用主进程切换开发者工具
  if (menuViewToggleDevTools && window.markwrite?.api?.toggleDevTools) {
    menuViewToggleDevTools.addEventListener('click', () => {
      try {
        void window.markwrite.api.toggleDevTools();
      } catch (_) {}
    });
  }

  // 自定义窗口控制按钮：最小化 / 最大化 / 关闭
  if (btnWinMin && window.markwrite?.api?.windowMinimize) {
    btnWinMin.addEventListener('click', (e) => {
      e.preventDefault();
      try { void window.markwrite.api.windowMinimize(); } catch (_) {}
    });
  }
  if (btnWinMax && window.markwrite?.api?.windowMaximizeOrRestore) {
    btnWinMax.addEventListener('click', (e) => {
      e.preventDefault();
      try { void window.markwrite.api.windowMaximizeOrRestore(); } catch (_) {}
    });
  }
  if (btnWinClose && window.markwrite?.api?.windowClose) {
    btnWinClose.addEventListener('click', (e) => {
      e.preventDefault();
      try { void window.markwrite.api.windowClose(); } catch (_) {}
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
    // 供 main 进程通过 executeJavaScript 读取当前编辑框内容（Agent 工具 markwrite_get_editor_content）
    window.__markwrite_getEditorContent = function () { return editor ? editor.getValue() : ''; };
    window.__markwrite_getEditorFilename = function () { return currentFilePath || '未命名'; };
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
    const toRange = (sel) => ({
      startLineNumber: sel.startLineNumber,
      startColumn: sel.startColumn,
      endLineNumber: sel.endLineNumber,
      endColumn: sel.endColumn,
    });
    const getSelectedText = () => {
      const s = getSelection();
      return model.getValueInRange(s);
    };
    const replaceSelection = (text) => {
      const s = getSelection();
      ed.executeEdits('md-toolbar', [{ range: toRange(s), text }]);
    };
    const wrapSelection = (before, after, cursorInside) => {
      const s = getSelection();
      const t = getSelectedText();
      const text = t ? before + t + after : before + after;
      ed.executeEdits('md-toolbar', [{ range: toRange(s), text }]);
      if (cursorInside !== false) {
        const start = s.getStartPosition();
        const end = s.getEndPosition();
        ed.setSelection({
          startLineNumber: start.lineNumber,
          startColumn: start.column + before.length,
          endLineNumber: end.lineNumber,
          endColumn: end.column + before.length,
        });
        ed.revealPositionInCenter({ lineNumber: start.lineNumber, column: start.column + before.length });
      }
    };
    const getCurrentLine = () => {
      const p = getSelection().getStartPosition();
      return model.getLineContent(p.lineNumber);
    };
    const insertAtLineStart = (prefix) => {
      const s = getSelection();
      const startLn = s.startLineNumber;
      const endLn = s.endLineNumber;
      let newText = '';
      for (let i = startLn; i <= endLn; i++) {
        const line = model.getLineContent(i);
        const stripped = line.replace(/^#+\s*/, '').trimStart();
        newText += (i > startLn ? '\n' : '') + prefix + stripped;
      }
      const r = { startLineNumber: startLn, startColumn: 1, endLineNumber: endLn, endColumn: model.getLineContent(endLn).length + 1 };
      ed.executeEdits('md-toolbar', [{ range: r, text: newText }]);
      ed.setSelection({ startLineNumber: startLn, startColumn: prefix.length + 1, endLineNumber: endLn, endColumn: prefix.length + (model.getLineContent(endLn).replace(/^#+\s*/, '').trimStart().length) + 1 });
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
      ed.executeEdits('md-toolbar', [{ range: toRange(s), text }]);
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
        const sel = getSelection();
        const range = toRange(sel);
        const overlay = document.createElement('div');
        overlay.className = 'table-size-overlay';
        const box = document.createElement('div');
        box.className = 'table-size-box';
        box.innerHTML = '<div class="table-size-title">插入链接 (Markdown)</div>';
        const row1 = document.createElement('div');
        row1.className = 'table-size-row';
        row1.innerHTML = '<label>链接文字</label><input type="text" id="link-text" placeholder="显示文字" style="flex:1;min-width:0">';
        const row2 = document.createElement('div');
        row2.className = 'table-size-row';
        row2.innerHTML = '<label>链接地址</label><input type="text" id="link-url" placeholder="https://" style="flex:1;min-width:0">';
        const actions = document.createElement('div');
        actions.className = 'table-size-actions';
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'apply-editor-btn apply-editor-btn-secondary';
        cancelBtn.textContent = '取消';
        const okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.className = 'apply-editor-btn apply-editor-btn-primary';
        okBtn.textContent = '确定';
        actions.appendChild(cancelBtn);
        actions.appendChild(okBtn);
        box.appendChild(row1);
        box.appendChild(row2);
        box.appendChild(actions);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        const textInput = box.querySelector('#link-text');
        const urlInput = box.querySelector('#link-url');
        textInput.value = defaultText || '';
        urlInput.value = 'https://';
        textInput.focus();
        const close = (insert) => {
          overlay.remove();
          if (insert) {
            ed.focus();
            ed.setSelection(sel);
            const linkText = String(textInput.value).trim() || urlInput.value.trim() || '链接';
            const u = String(urlInput.value).trim();
            if (u) {
              ed.executeEdits('md-toolbar', [{ range, text: '[' + linkText + '](' + u + ')' }]);
            }
          }
        };
        cancelBtn.addEventListener('click', () => close(false));
        okBtn.addEventListener('click', () => close(true));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
        urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') close(true); });
        textInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); urlInput.focus(); } });
      },
      'md-image': () => {
        const raw = getSelectedText();
        const defaultAlt = raw ? raw.replace(/\s+/g, ' ').trim() : '';
        const sel = getSelection();
        const range = toRange(sel);
        const overlay = document.createElement('div');
        overlay.className = 'table-size-overlay';
        const box = document.createElement('div');
        box.className = 'table-size-box';
        box.innerHTML = '<div class="table-size-title">插入图片 (Markdown)</div>';
        const row1 = document.createElement('div');
        row1.className = 'table-size-row';
        row1.innerHTML = '<label>替代文字</label><input type="text" id="img-alt" placeholder="图片描述" style="flex:1;min-width:0">';
        const row2 = document.createElement('div');
        row2.className = 'table-size-row';
        row2.innerHTML = '<label>图片地址</label><input type="text" id="img-url" placeholder="https://" style="flex:1;min-width:0">';
        const actions = document.createElement('div');
        actions.className = 'table-size-actions';
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'apply-editor-btn apply-editor-btn-secondary';
        cancelBtn.textContent = '取消';
        const okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.className = 'apply-editor-btn apply-editor-btn-primary';
        okBtn.textContent = '确定';
        actions.appendChild(cancelBtn);
        actions.appendChild(okBtn);
        box.appendChild(row1);
        box.appendChild(row2);
        box.appendChild(actions);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        const altInput = box.querySelector('#img-alt');
        const urlInput = box.querySelector('#img-url');
        altInput.value = defaultAlt || '图片';
        urlInput.value = 'https://';
        altInput.focus();
        const close = (insert) => {
          overlay.remove();
          if (insert) {
            ed.focus();
            ed.setSelection(sel);
            const alt = String(altInput.value).trim() || '图片';
            const u = String(urlInput.value).trim();
            if (u) {
              ed.executeEdits('md-toolbar', [{ range, text: '![' + alt + '](' + u + ')' }]);
            }
          }
        };
        cancelBtn.addEventListener('click', () => close(false));
        okBtn.addEventListener('click', () => close(true));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
        urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') close(true); });
        altInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); urlInput.focus(); } });
      },
      'md-upload-image': async () => {
        if (!window.markwrite || !window.markwrite.api || !window.markwrite.api.uploadImage) {
          console.warn('image upload api not available');
          return;
        }
        const res = await window.markwrite.api.uploadImage();
        if (!res || !res.ok || !res.webPath) return;
        const raw = getSelectedText();
        const defaultAlt = raw ? raw.replace(/\s+/g, ' ').trim() : '';
        const sel = getSelection();
        const range = toRange(sel);
        const alt = defaultAlt || '图片';
        const url = res.webPath;
        ed.focus();
        ed.setSelection(sel);
        ed.executeEdits('md-toolbar', [{ range, text: '![' + alt + '](' + url + ')' }]);
      },
      'md-ul': () => prefixLines('- '),
      'md-ol': () => prefixLines((n) => n + '. '),
      'md-quote': () => prefixLines('> '),
      'md-code': () => wrapSelection('`', '`'),
      'md-fence': () => {
        const s = getSelection();
        const t = getSelectedText();
        const range = toRange(s);
        const hasSelection = t && t.trim().length > 0;
        const overlay = document.createElement('div');
        overlay.className = 'table-size-overlay';
        const box = document.createElement('div');
        box.className = 'table-size-box';
        box.style.minWidth = '280px';
        box.innerHTML = '<div class="table-size-title">插入代码块 (Markdown)</div>';
        const row = document.createElement('div');
        row.className = 'table-size-row';
        row.innerHTML = '<label>代码语言</label><input type="text" id="fence-lang" placeholder="可选，如 js / python / bash" style="flex:1;min-width:0">';
        box.appendChild(row);
        const actions = document.createElement('div');
        actions.className = 'table-size-actions';
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'apply-editor-btn apply-editor-btn-secondary';
        cancelBtn.textContent = '取消';
        const okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.className = 'apply-editor-btn apply-editor-btn-primary';
        okBtn.textContent = '确定';
        actions.appendChild(cancelBtn);
        actions.appendChild(okBtn);
        box.appendChild(actions);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        const langInput = box.querySelector('#fence-lang');
        langInput.value = hasSelection ? '' : 'javascript';
        langInput.focus();
        const close = (doInsert) => {
          overlay.remove();
          if (!doInsert) return;
          const langRaw = String(langInput.value).trim();
          const langPart = langRaw ? langRaw + '\n' : '';
          ed.focus();
          ed.setSelection(s);
          if (hasSelection) {
            const content = t.endsWith('\n') ? t : t + '\n';
            ed.executeEdits('md-toolbar', [{ range, text: '```' + langPart + content + '```\n' }]);
          } else {
            const insert = '```' + langPart + '\n\n```\n';
            ed.executeEdits('md-toolbar', [{ range, text: insert }]);
            const startLine = s.startLineNumber;
            ed.setSelection({ startLineNumber: startLine + 1, startColumn: 1, endLineNumber: startLine + 1, endColumn: 1 });
            ed.revealPositionInCenter({ lineNumber: startLine + 1, column: 1 });
          }
        };
        cancelBtn.addEventListener('click', () => close(false));
        okBtn.addEventListener('click', () => close(true));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
        langInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') close(true); });
      },
      'md-hr': () => replaceSelection('\n\n---\n\n'),
      'md-table': () => {
        const sel = getSelection();
        const range = toRange(sel);
        const overlay = document.createElement('div');
        overlay.className = 'table-size-overlay';
        const box = document.createElement('div');
        box.className = 'table-size-box';
        box.innerHTML = '<div class="table-size-title">插入表格</div>';
        const row1 = document.createElement('div');
        row1.className = 'table-size-row';
        row1.innerHTML = '<label>行数</label><input type="number" id="table-rows" min="1" max="20" value="3">';
        const row2 = document.createElement('div');
        row2.className = 'table-size-row';
        row2.innerHTML = '<label>列数</label><input type="number" id="table-cols" min="1" max="10" value="3">';
        const actions = document.createElement('div');
        actions.className = 'table-size-actions';
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'apply-editor-btn apply-editor-btn-secondary';
        cancelBtn.textContent = '取消';
        const okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.className = 'apply-editor-btn apply-editor-btn-primary';
        okBtn.textContent = '确定';
        actions.appendChild(cancelBtn);
        actions.appendChild(okBtn);
        box.appendChild(row1);
        box.appendChild(row2);
        box.appendChild(actions);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        const close = (insert) => {
          const rowsInput = box.querySelector('#table-rows');
          const colsInput = box.querySelector('#table-cols');
          let r = 3, c = 3;
          if (rowsInput) r = Math.max(1, Math.min(20, parseInt(rowsInput.value, 10) || 3));
          if (colsInput) c = Math.max(1, Math.min(10, parseInt(colsInput.value, 10) || 3));
          overlay.remove();
          if (!insert) return;
          const cell = '   ';
          const headerRow = '|' + Array(c).fill(cell).join('|') + '|\n';
          const sepRow = '|' + Array(c).fill(' --- ').join('|') + '|\n';
          const bodyRows = Array(Math.max(0, r - 1)).fill(0).map(() => '|' + Array(c).fill(cell).join('|') + '|\n').join('');
          const table = '\n' + headerRow + sepRow + bodyRows;
          ed.focus();
          ed.setSelection(sel);
          ed.executeEdits('md-toolbar', [{ range, text: table }]);
          const p = sel.getStartPosition();
          ed.setSelection({ startLineNumber: p.lineNumber + 1, startColumn: 2, endLineNumber: p.lineNumber + 1, endColumn: 2 });
          ed.revealPositionInCenter({ lineNumber: p.lineNumber + 1, column: 2 });
        };
        okBtn.addEventListener('click', () => close(true));
        cancelBtn.addEventListener('click', () => close(false));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
      },
    };

    Object.keys(actions).forEach(id => {
      const btn = document.getElementById(id);
      if (!btn) return;
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        ed.focus();
      });
      btn.addEventListener('click', () => {
        if (ed) actions[id]();
      });
    });
  }

  if (window.monaco) {
    initMonaco();
  } else {
    window.addEventListener('monaco-ready', initMonaco);
  }

  if (btnNew) {
    btnNew.addEventListener('click', () => {
      doNewFile();
    });
  }
  if (btnOpen && window.markwrite && window.markwrite.api) {
    btnOpen.addEventListener('click', () => { void doOpenFileOrWorkspace(); });
  }

  if (btnSave && window.markwrite && window.markwrite.api) {
    btnSave.addEventListener('click', () => { void doSave(); });
  }

  if (btnSaveAs && window.markwrite && window.markwrite.api) {
    btnSaveAs.addEventListener('click', () => { void doSaveAs(); });
  }

  // 顶部菜单 File 分组：行为与底部按钮完全一致
  if (menuFileNew) {
    menuFileNew.addEventListener('click', () => {
      doNewFile();
    });
  }
  if (menuFileOpen) {
    menuFileOpen.addEventListener('click', () => { void doOpenFileOrWorkspace(); });
  }
  if (menuFileSave) {
    menuFileSave.addEventListener('click', () => { void doSave(); });
  }
  if (menuFileSaveAs) {
    menuFileSaveAs.addEventListener('click', () => { void doSaveAs(); });
  }
  if (menuFileOpenWorkspace) {
    // 打开工作区：逻辑与「打开」相同，但用户语义是优先选目录
    menuFileOpenWorkspace.addEventListener('click', () => { void doOpenFileOrWorkspace(); });
  }

  function appendMessage(role, content) {
    if (!aiMessages) return;
    const div = document.createElement('div');
    div.className = `ai-message ${role}`;
    if (role === 'assistant') {
      div.textContent = content;
      aiMessages.appendChild(div);
      aiMessages.scrollTop = aiMessages.scrollHeight;
      (async () => {
        if (!window.markwrite || !window.markwrite.api || typeof window.markwrite.api.renderMarkdown !== 'function') return;
        try {
          const html = await window.markwrite.api.renderMarkdown(content || '');
          if (div.parentNode) {
            div.classList.add('ai-message-rendered');
            div.innerHTML = html;
            aiMessages.scrollTop = aiMessages.scrollHeight;
          }
        } catch (_) {}
      })();
    } else {
      div.textContent = content;
      aiMessages.appendChild(div);
      aiMessages.scrollTop = aiMessages.scrollHeight;
    }
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

    aiMode = suggestAiMode(msg);

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
        if (hasError) {
          contentDiv.textContent = text;
        } else {
          try {
            const html = await window.markwrite.api.renderMarkdown(text || '');
            contentDiv.classList.add('ai-message-rendered');
            contentDiv.innerHTML = html;
          } catch (_) {
            contentDiv.textContent = text;
          }
        }

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
