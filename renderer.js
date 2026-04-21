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

window.addEventListener('DOMContentLoaded', async () => {
  const settingsBody = document.getElementById('settings-body');
  if (settingsBody) {
    try {
      const res = await fetch('/settings-modal.html');
      if (res.ok) settingsBody.innerHTML = await res.text();
    } catch (_) {}
  }

  // 身份页状态必须在任何使用它们的函数之前声明（避免 let TDZ / 闭包读到未初始化变量）
  let currentSettingsTab = 'sync';
  let identityHasExisting = false;
  let lastDerivedEsec = '';
  let identityLoginMode = 'paste'; // 'paste' | 'new'
  let identityPrefillNonce = 0;
  /** 服务器 profile 中的头像 URL，保存时原样写回（本页不再提供头像 URL 输入） */
  let profileServerAvatarUrl = '';
  /** 用户信息是否在本次会话中被用户修改过；若已修改则不自动用服务器数据覆盖 */
  let profileDirtyInSession = false;
  /** 仅当「新用户（邮箱）」模式点击过“生成新用户密钥”后为 true，用于决定是否需要向服务器注册 create_user */
  let identityGeneratedThisSession = false;
  /** 「用户信息」页密钥展示：编码（epub / ESEC）或裸 hex */
  let profileKeyDisplayMode = 'encoded';
  const identityKeyHexCache = { pubkeyHex: '', privkeyHex: '' };
  const composeState = {
    mode: null,
    draft: null,
    tags: [],
    /** 书籍联合作者：{ email, pubkey }，与 eventstoreUI create_book.coAuthors 一致（发布时传 pubkey 数组） */
    coAuthors: [],
    draftFileId: null,
    remoteId: '',
    assetMap: {},
    /** 书籍：各章节正文（内存）；当前编辑章节见 bookActiveChapterId */
    bookChapterContents: {},
    bookActiveChapterId: null,
    /** 本机新建书籍会话盐，用于首次保存时生成与「远程下载」同规则的草稿目录 id */
    bookNewLocalSalt: null,
  };
  /** 书籍上传：Monaco setValue 程序化换章时不应记为「待上传」 */
  let bookPendingSuppress = 0;
  let bookUploadPendingTimer = null;
  let activeComposeUploadRequestId = null;
  let composeGenerateStatusTimer = null;

  function refreshIdentityKeyHexCacheFromIdentity(id) {
    if (!id || typeof id !== 'object') return;
    if (typeof id.pubkeyHex === 'string' && id.pubkeyHex.trim()) identityKeyHexCache.pubkeyHex = id.pubkeyHex.trim();
    if (typeof id.privkeyHex === 'string' && id.privkeyHex.trim()) identityKeyHexCache.privkeyHex = id.privkeyHex.trim();
  }

  function updateProfileKeyFormatUi() {
    const encBtn = document.getElementById('settings-profile-key-format-encoded');
    const hexBtn = document.getElementById('settings-profile-key-format-hex');
    const pubLabel = document.getElementById('settings-profile-pubkey-label-text');
    const privLabel = document.getElementById('settings-profile-privkey-label-text');
    const isHex = profileKeyDisplayMode === 'hex';
    if (encBtn) encBtn.classList.toggle('profile-form-key-format-btn--active', !isHex);
    if (hexBtn) hexBtn.classList.toggle('profile-form-key-format-btn--active', isHex);
    if (pubLabel) pubLabel.textContent = isHex ? '公钥（hex）' : '公钥（epub）';
    if (privLabel) privLabel.textContent = isHex ? '私钥（hex）' : '私钥（ESEC）';
  }

  function updateProfileHeroNameDisplay(name) {
    const heroNameEl = document.getElementById('settings-profile-hero-name');
    if (!heroNameEl) return;
    const v = typeof name === 'string' ? name.trim() : '';
    heroNameEl.textContent = v || '未设置昵称';
  }

  function renderProfileAvatarPreview(url) {
    const previewEl = document.getElementById('settings-profile-avatar-preview');
    if (!previewEl) return;
    previewEl.innerHTML = '';
    const raw = typeof url === 'string' ? url.trim() : '';
    const src = raw ? resolveAvatarUrlForDisplay(raw) : '';
    if (!src) {
      const icon = document.createElement('i');
      icon.className = 'bi bi-person-fill profile-form-avatar-empty-icon';
      icon.setAttribute('aria-hidden', 'true');
      previewEl.appendChild(icon);
      return;
    }
    const img = document.createElement('img');
    img.src = src;
    img.alt = '';
    img.onerror = () => {
      previewEl.innerHTML = '';
      const icon = document.createElement('i');
      icon.className = 'bi bi-person-fill profile-form-avatar-empty-icon';
      icon.setAttribute('aria-hidden', 'true');
      previewEl.appendChild(icon);
    };
    previewEl.appendChild(img);
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
      reader.onerror = () => reject(new Error('读取图片失败'));
      reader.readAsDataURL(file);
    });
  }

  /** 居中裁成正方形，用于封面上传 */
  function cropImageFileToSquareBlob(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        try {
          const w = img.naturalWidth;
          const h = img.naturalHeight;
          const side = Math.min(w, h);
          const sx = (w - side) / 2;
          const sy = (h - side) / 2;
          const canvas = document.createElement('canvas');
          canvas.width = side;
          canvas.height = side;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            URL.revokeObjectURL(url);
            reject(new Error('canvas'));
            return;
          }
          ctx.drawImage(img, sx, sy, side, side, 0, 0, side, side);
          URL.revokeObjectURL(url);
          canvas.toBlob(
            (blob) => {
              if (!blob) reject(new Error('crop failed'));
              else resolve(blob);
            },
            'image/png',
            0.92,
          );
        } catch (e) {
          URL.revokeObjectURL(url);
          reject(e);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('load image failed'));
      };
      img.src = url;
    });
  }

  function normalizeComposeTag(s) {
    return String(s || '')
      .trim()
      .replace(/^#/, '')
      .replace(/\s+/g, ' ');
  }

  function renderComposeTags() {
    const container = document.getElementById('content-compose-tags-list');
    const hidden = document.getElementById('content-compose-tags');
    if (!container) return;
    container.innerHTML = '';
    composeState.tags.forEach((tag, i) => {
      const chip = document.createElement('span');
      chip.className = 'content-compose-tag-chip';
      const text = document.createElement('span');
      text.className = 'content-compose-tag-text';
      text.textContent = tag;
      chip.appendChild(text);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'content-compose-tag-remove';
      btn.setAttribute('aria-label', '删除标签');
      btn.innerHTML = '<i class="bi bi-x-lg"></i>';
      btn.addEventListener('click', () => {
        composeState.tags.splice(i, 1);
        renderComposeTags();
        if (composeState.mode === 'book' && composeState.draftFileId) {
          scheduleMarkBookUploadPending({ meta: true });
        }
      });
      chip.appendChild(btn);
      container.appendChild(chip);
    });
    if (hidden) hidden.value = composeState.tags.join(', ');
  }

  function toggleComposeCoAuthorInput(show) {
    const row = document.getElementById('content-compose-coauthors-input-row');
    const btn = document.getElementById('content-compose-coauthor-show');
    if (row) row.style.display = show ? 'flex' : 'none';
    if (btn) btn.style.display = show ? 'none' : 'inline-flex';
    if (show) {
      const inp = document.getElementById('content-compose-coauthor-input');
      if (inp) setTimeout(() => inp.focus(), 50);
    }
  }

  async function tryAddComposeCoAuthor() {
    const input = document.getElementById('content-compose-coauthor-input');
    const v = input && String(input.value || '').trim();
    if (!v) return;
    const api = window.markwrite && window.markwrite.api;
    if (!api || typeof api.eventstoreLookupUser !== 'function') {
      showAppAlert('联合作者查询需要桌面版并已配置 Sync 服务器');
      return;
    }
    let res;
    try {
      res = await api.eventstoreLookupUser({ value: v });
    } catch (e) {
      showAppAlert(`查询失败：${e && e.message ? e.message : String(e)}`);
      return;
    }
    if (!res || !res.ok) {
      showAppAlert((res && res.message) || '未找到用户');
      return;
    }
    const pk = res.pubkey ? String(res.pubkey).trim() : '';
    if (!pk) {
      showAppAlert('未返回公钥');
      return;
    }
    if (composeState.coAuthors.some((a) => a.pubkey === pk)) {
      showAppAlert('该联合作者已存在');
      if (input) input.value = '';
      return;
    }
    composeState.coAuthors.push({
      email: res.email ? String(res.email).trim() : '',
      pubkey: pk,
    });
    if (input) input.value = '';
    renderComposeCoAuthors();
    toggleComposeCoAuthorInput(false);
    if (composeState.mode === 'book' && composeState.draftFileId) {
      scheduleMarkBookUploadPending({ meta: true });
    }
  }

  function composeCoAuthorRowDisplay(co) {
    const em = co && co.email != null ? String(co.email).trim() : '';
    if (em) return em;
    const pk = co && co.pubkey ? String(co.pubkey) : '';
    if (pk.length > 20) return `${pk.slice(0, 8)}…${pk.slice(-6)}`;
    return pk || '';
  }

  async function hydrateComposeCoAuthorEmails() {
    const api = window.markwrite && window.markwrite.api;
    if (!api || typeof api.eventstoreLookupUser !== 'function') return;
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    let changed = false;
    for (let i = 0; i < composeState.coAuthors.length; i++) {
      const co = composeState.coAuthors[i];
      if (!co || !co.pubkey) continue;
      const em = String(co.email || '').trim();
      if (em && emailRe.test(em)) continue;
      try {
        const res = await api.eventstoreLookupUser({ value: co.pubkey });
        if (res && res.ok && res.email && String(res.email).trim()) {
          composeState.coAuthors[i] = {
            ...co,
            email: String(res.email).trim(),
          };
          changed = true;
        }
      } catch (_) {}
    }
    if (changed) renderComposeCoAuthors();
  }

  function renderComposeCoAuthors() {
    const list = document.getElementById('content-compose-coauthors-list');
    if (!list) return;
    list.innerHTML = '';
    composeState.coAuthors.forEach((co, i) => {
      const row = document.createElement('div');
      row.className = 'content-compose-coauthor-row';
      const label = document.createElement('span');
      label.className = 'content-compose-coauthor-label';
      const display = composeCoAuthorRowDisplay(co);
      label.textContent = display;
      label.title = (co && co.pubkey) ? String(co.pubkey) : '';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'content-compose-coauthor-remove';
      btn.setAttribute('aria-label', '移除联合作者');
      btn.innerHTML = '<i class="bi bi-x-lg"></i>';
      btn.addEventListener('click', () => {
        composeState.coAuthors = composeState.coAuthors.filter((_, j) => j !== i);
        renderComposeCoAuthors();
        if (composeState.mode === 'book' && composeState.draftFileId) {
          scheduleMarkBookUploadPending({ meta: true });
        }
      });
      row.appendChild(label);
      row.appendChild(btn);
      list.appendChild(row);
    });
  }

  function addComposeTagFromInput() {
    const input = document.getElementById('content-compose-tag-input');
    const v = normalizeComposeTag(input && input.value);
    if (!v) return;
    if (composeState.tags.includes(v)) {
      if (input) input.value = '';
      return;
    }
    composeState.tags.push(v);
    if (input) input.value = '';
    renderComposeTags();
    if (composeState.mode === 'book' && composeState.draftFileId) {
      scheduleMarkBookUploadPending({ meta: true });
    }
  }

  function setComposeUploadProgress(text, kind) {
    if (!contentComposeUploadProgress) return;
    const msg = String(text || '').trim();
    if (!msg) {
      contentComposeUploadProgress.textContent = '';
      contentComposeUploadProgress.style.display = 'none';
      contentComposeUploadProgress.classList.remove('is-error');
      return;
    }
    contentComposeUploadProgress.style.display = 'block';
    contentComposeUploadProgress.textContent = msg;
    contentComposeUploadProgress.classList.toggle('is-error', kind === 'error');
  }

  function setComposeGenerateStatus(text, kind) {
    if (!contentComposeGenerateStatus) return;
    const msg = String(text || '').trim();
    if (composeGenerateStatusTimer) {
      clearTimeout(composeGenerateStatusTimer);
      composeGenerateStatusTimer = null;
    }
    if (!msg) {
      contentComposeGenerateStatus.textContent = '';
      contentComposeGenerateStatus.style.display = 'none';
      contentComposeGenerateStatus.classList.remove('is-loading', 'is-success');
      return;
    }
    contentComposeGenerateStatus.style.display = 'inline-flex';
    contentComposeGenerateStatus.textContent = msg;
    contentComposeGenerateStatus.classList.toggle('is-loading', kind === 'loading');
    contentComposeGenerateStatus.classList.toggle('is-success', kind === 'success');
    if (kind === 'success') {
      composeGenerateStatusTimer = setTimeout(() => setComposeGenerateStatus(''), 1800);
    }
  }

  /** 书籍大纲由树同步到隐藏 textarea；始终用 document 取当前节点，避免模板切换后缓存引用失效。 */
  function getLiveBookOutlineTextFromDom() {
    const el = document.getElementById('content-compose-outline');
    return el && typeof el.value === 'string' ? el.value.trim() : '';
  }

  function isBookOutlineDirtyComparedToBaseline() {
    if (composeState.mode !== 'book') return false;
    return getLiveBookOutlineTextFromDom() !== getOutlineFromSerializedState(composeBaselineSerialized);
  }

  function readComposeDraftFromUi() {
    const titleEl = document.getElementById('content-compose-main-title');
    const coverEl = document.getElementById('content-compose-cover');
    const extraEl = document.getElementById('content-compose-extra');
    const authorEl = document.getElementById('content-compose-author');
    const outline = getLiveBookOutlineTextFromDom();
    let content = editor ? editor.getValue() : '';
    if (composeState.mode === 'book') {
      const map = { ...composeState.bookChapterContents };
      const aid = composeState.bookActiveChapterId;
      if (aid != null && editor) map[aid] = editor.getValue();
      const ids = collectBookChapterIdsFromOutlineStr(outline);
      content = mergeBookChaptersPlain(ids, map);
    }
    const isBook = composeState.mode === 'book';
    return {
      title: (titleEl && titleEl.value.trim()) || '',
      tags: composeState.tags.length ? composeState.tags.join(', ') : '',
      cover: (coverEl && coverEl.value.trim()) || '',
      extra: isBook ? '' : ((extraEl && extraEl.value.trim()) || ''),
      /** 博客：作者由发布端/身份自动生成，不采集联合作者 */
      author: isBook && authorEl ? authorEl.value.trim() : '',
      coAuthors: isBook && Array.isArray(composeState.coAuthors)
        ? composeState.coAuthors.map((x) => ({
            email: typeof x.email === 'string' ? x.email : '',
            pubkey: typeof x.pubkey === 'string' ? x.pubkey : '',
          }))
        : [],
      outline,
      content,
    };
  }

  /** 与主进程书籍草稿一致：编辑器用 <!-- mw-chapter:id --> 分章；发布/上传前去掉标记 */
  function stripMwChapterMarkers(md) {
    return String(md || '').replace(/<!--\s*mw-chapter:\d+\s*-->\s*/g, '');
  }

  function collectBookChapterIdsFromOutlineStr(outlineStr) {
    try {
      const j = JSON.parse(String(outlineStr || '').trim() || '[]');
      const ids = [];
      function walk(items) {
        if (!Array.isArray(items)) return;
        items.forEach((it) => {
          if (!it || typeof it !== 'object') return;
          if (it.type === 'chapter' && typeof it.id === 'number') ids.push(it.id);
          if (Array.isArray(it.children)) walk(it.children);
        });
      }
      walk(Array.isArray(j) ? j : []);
      return ids;
    } catch (_) {
      return [];
    }
  }

  function splitEditorIntoBookChapterMap(content, outlineStr) {
    const s = String(content || '');
    const re = /<!--\s*mw-chapter:(\d+)\s*-->/g;
    const matches = [];
    let m;
    while ((m = re.exec(s)) !== null) {
      matches.push({ id: Number(m[1]), start: m.index, endAfter: m.index + m[0].length });
    }
    const ids = collectBookChapterIdsFromOutlineStr(outlineStr);
    const map = {};
    if (matches.length === 0) {
      if (ids.length) map[ids[0]] = s;
      ids.slice(1).forEach((id) => { map[id] = ''; });
      return map;
    }
    for (let i = 0; i < matches.length; i++) {
      const cur = matches[i];
      const next = matches[i + 1];
      let body = s.slice(cur.endAfter, next ? next.start : s.length);
      if (body.startsWith('\n')) body = body.slice(1);
      map[cur.id] = body;
    }
    ids.forEach((id) => {
      if (map[id] === undefined) map[id] = '';
    });
    return map;
  }

  function mergeBookChaptersPlain(ids, map) {
    return ids.map((id) => String(map[id] != null ? map[id] : '')).join('\n\n');
  }

  function buildBookChapterContentsPayload() {
    const map = { ...composeState.bookChapterContents };
    const aid = composeState.bookActiveChapterId;
    if (aid != null && editor) map[aid] = editor.getValue();
    return map;
  }

  function walkOutlineChapterIdsForPrune(items, out) {
    if (!Array.isArray(items)) return;
    items.forEach((it) => {
      if (!it || typeof it !== 'object') return;
      if (it.type === 'chapter' && typeof it.id === 'number') out.push(it.id);
      if (Array.isArray(it.children)) walkOutlineChapterIdsForPrune(it.children, out);
    });
  }

  function pruneBookChapterContentsToOutlineItems(items) {
    const ids = [];
    walkOutlineChapterIdsForPrune(Array.isArray(items) ? items : [], ids);
    const set = new Set(ids);
    Object.keys(composeState.bookChapterContents).forEach((k) => {
      const n = Number(k);
      if (!set.has(n)) delete composeState.bookChapterContents[k];
    });
    if (composeState.bookActiveChapterId != null && !set.has(composeState.bookActiveChapterId)) {
      const first = ids[0];
      composeState.bookActiveChapterId = first != null ? first : null;
      if (editor) {
        runWithBookPendingSuppressed(() => {
          editor.setValue(first != null ? String(composeState.bookChapterContents[first] ?? '') : '');
        });
      }
      if (bookOutlinePaneInstance && first != null) {
        bookOutlinePaneInstance.setSelectedChapterId(first);
      }
    }
  }

  let bookChapterSwitchResolver = null;
  function openBookChapterSwitchConfirm() {
    return new Promise((resolve) => {
      bookChapterSwitchResolver = resolve;
      const el = document.getElementById('book-chapter-switch-modal');
      if (el) {
        el.style.display = 'flex';
        el.setAttribute('aria-hidden', 'false');
      } else {
        resolve('cancel');
      }
    });
  }
  function closeBookChapterSwitchModal(choice) {
    const el = document.getElementById('book-chapter-switch-modal');
    if (el) {
      el.style.display = 'none';
      el.setAttribute('aria-hidden', 'true');
    }
    if (bookChapterSwitchResolver) {
      bookChapterSwitchResolver(choice);
      bookChapterSwitchResolver = null;
    }
  }

  async function onBeforeBookChapterSelect(nextId, prevId) {
    if (composeState.mode !== 'book' || !editor) return true;
    if (prevId == null || prevId === nextId) {
      composeState.bookActiveChapterId = nextId;
      runWithBookPendingSuppressed(() => {
        editor.setValue(String(composeState.bookChapterContents[nextId] ?? ''));
      });
      return true;
    }
    const cur = editor.getValue();
    const committed = String(composeState.bookChapterContents[prevId] ?? '');
    if (cur === committed) {
      composeState.bookActiveChapterId = nextId;
      runWithBookPendingSuppressed(() => {
        editor.setValue(String(composeState.bookChapterContents[nextId] ?? ''));
      });
      return true;
    }
    const choice = await openBookChapterSwitchConfirm();
    if (choice === 'cancel') return false;
    if (choice === 'save') {
      composeState.bookChapterContents[prevId] = cur;
      const r = await saveComposeDraftToDisk();
      if (!r.ok) {
        showAppAlert(r.error || '保存失败');
        return false;
      }
      markComposeBaselineFromCurrent();
    }
    composeState.bookActiveChapterId = nextId;
    runWithBookPendingSuppressed(() => {
      editor.setValue(String(composeState.bookChapterContents[nextId] ?? ''));
    });
    return true;
  }

  function onBookOutlineSynced(items) {
    if (composeState.mode !== 'book') return;
    pruneBookChapterContentsToOutlineItems(items);
    updateBookOutlineSaveButtonState();
  }

  function wireBookOutlinePaneIPC() {
    if (!bookOutlinePaneInstance) return;
    bookOutlinePaneInstance.onBeforeChapterSelect = onBeforeBookChapterSelect;
    bookOutlinePaneInstance.onOutlineSynced = onBookOutlineSynced;
  }

  function initEmptyBookChapterMapFromOutlineStr(outlineStr) {
    const ids = collectBookChapterIdsFromOutlineStr(outlineStr);
    const m = {};
    ids.forEach((id) => { m[id] = ''; });
    composeState.bookChapterContents = m;
  }

  /**
   * 将当前创作页（文章信息 + 大纲 + 正文）写入本地草稿文件，生成/固定 draftFileId。
   * 发布到服务器前应先调用，否则没有本地索引，远端 ID 难以可靠写回。
   * @param {{ bookSaveChapterOnly?: boolean }} [opts] `bookSaveChapterOnly`：仅写入当前章节的 `chapters/{id}.md`，不覆盖其它章节文件。
   */
  async function saveComposeDraftToDisk(opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const api = window.markwrite && window.markwrite.api;
    if (!api || typeof api.composeDraftsSave !== 'function') {
      return { ok: false, error: '草稿保存不可用（请使用桌面版）' };
    }
    if (!composeState.mode) {
      return { ok: false, error: '请先通过「新建 Blog / 新建书籍」进入创作页' };
    }
    const ui = readComposeDraftFromUi();
    if (composeState.mode === 'book' && !String(ui.author || '').trim()) {
      return { ok: false, error: '请先填写作者' };
    }
    if (composeState.mode === 'book' && o.bookSaveChapterOnly) {
      if (!composeState.draftFileId) {
        return { ok: false, error: '请先完整保存一次书籍草稿后再仅保存本章' };
      }
      commitActiveBookChapterFromEditor();
      const aid = composeState.bookActiveChapterId;
      if (aid == null) return { ok: false, error: '未选中章节' };
      const body = String(composeState.bookChapterContents[aid] ?? '');
      const payloadChapter = {
        id: composeState.draftFileId,
        mode: 'book',
        title: ui.title,
        tags: composeState.tags.slice(),
        cover: ui.cover,
        extra: ui.extra,
        author: ui.author || '',
        coAuthors: Array.isArray(ui.coAuthors) ? ui.coAuthors : [],
        outline: getLiveBookOutlineTextFromDom() || ui.outline || '',
        content: '',
        remoteId: composeState.remoteId || '',
        assetMap: composeState.assetMap || {},
        bookSaveChapterOnly: aid,
        chapterContents: { [String(aid)]: body },
      };
      const resCh = await api.composeDraftsSave(payloadChapter);
      if (resCh && resCh.ok && resCh.id) {
        return { ok: true, id: resCh.id };
      }
      return { ok: false, error: (resCh && resCh.error) || '保存章节失败' };
    }
    const payload = {
      id: composeState.draftFileId || undefined,
      mode: composeState.mode || 'blog',
      title: ui.title,
      tags: composeState.tags.slice(),
      cover: ui.cover,
      extra: ui.extra,
      author: ui.author || '',
      coAuthors: Array.isArray(ui.coAuthors) ? ui.coAuthors : [],
      outline: ui.outline || '',
      content: ui.content,
      remoteId: composeState.remoteId || '',
      assetMap: composeState.assetMap || {},
    };
    if (composeState.mode === 'book') {
      const cc = buildBookChapterContentsPayload();
      const ids = collectBookChapterIdsFromOutlineStr(ui.outline || '');
      ids.forEach((id) => {
        if (cc[id] === undefined) cc[id] = '';
      });
      payload.chapterContents = cc;
      payload.content = mergeBookChaptersPlain(ids, cc);
    }
    if (composeState.mode === 'book' && !composeState.draftFileId && composeState.bookNewLocalSalt) {
      let myPk = '';
      if (typeof api.identityGet === 'function') {
        try {
          const idRes = await api.identityGet({ serverId: getActiveSyncServerIdForIdentity() });
          myPk = (idRes && idRes.pubkeyHex) ? String(idRes.pubkeyHex).trim() : '';
        } catch (_) {}
      }
      if (!myPk && identityKeyHexCache.pubkeyHex) myPk = identityKeyHexCache.pubkeyHex;
      const stableId = buildRemoteImportDraftId({
        mode: 'book',
        title: ui.title,
        remoteId: composeState.bookNewLocalSalt,
        authorPubkeyHex: myPk,
      });
      const go = await confirmOverwriteIfLocalDraftExists(api, stableId);
      if (!go) return { ok: false, error: '已取消保存' };
      payload.id = stableId;
    }
    let outlineWasDirtyBeforeFullSave = false;
    if (composeState.mode === 'book') {
      const liveOutline = getLiveBookOutlineTextFromDom();
      payload.outline = liveOutline;
      const cc = buildBookChapterContentsPayload();
      const ids = collectBookChapterIdsFromOutlineStr(liveOutline);
      ids.forEach((id) => {
        if (cc[id] === undefined) cc[id] = '';
      });
      payload.chapterContents = cc;
      payload.content = mergeBookChaptersPlain(ids, cc);
      outlineWasDirtyBeforeFullSave = isBookOutlineDirtyComparedToBaseline();
    }
    const res = await api.composeDraftsSave(payload);
    if (res && res.ok && res.id) {
      composeState.draftFileId = res.id;
      composeState.bookNewLocalSalt = null;
      if (composeState.mode === 'book') {
        commitActiveBookChapterFromEditor();
        if (
          outlineWasDirtyBeforeFullSave
          && typeof api.composeBookUploadMarkPending === 'function'
        ) {
          try {
            await api.composeBookUploadMarkPending({ draftId: res.id, outline: true });
          } catch (_) {}
        }
      }
      return { ok: true, id: res.id };
    }
    return { ok: false, error: (res && res.error) || '保存草稿失败' };
  }

  function serializeComposeDraftState() {
    const ui = readComposeDraftFromUi();
    const am = composeState.assetMap && typeof composeState.assetMap === 'object' ? composeState.assetMap : {};
    const isBook = composeState.mode === 'book';
    return JSON.stringify({
      mode: composeState.mode || '',
      title: ui.title,
      cover: ui.cover,
      extra: ui.extra,
      author: isBook ? (ui.author || '') : '',
      coAuthors: isBook && Array.isArray(composeState.coAuthors) ? composeState.coAuthors.slice() : [],
      outline: ui.outline || '',
      content: ui.content,
      tags: composeState.tags.slice(),
      draftFileId: composeState.draftFileId || null,
      remoteId: composeState.remoteId || '',
      assetMap: am,
    });
  }

  function markEditorBaselineFromCurrent() {
    if (!editor) return;
    editorBaseline = {
      path: currentFilePath,
      content: editor.getValue(),
    };
  }

  /** 书籍：把当前章 Monaco 正文写回 bookChapterContents。切换章节时用 map 与编辑器比较「是否未保存」，保存后必须同步，否则会误判。 */
  function commitActiveBookChapterFromEditor() {
    if (composeState.mode !== 'book' || !editor) return;
    const aid = composeState.bookActiveChapterId;
    if (aid == null) return;
    composeState.bookChapterContents[aid] = editor.getValue();
  }

  /** 书籍：显式「待上传」标记（见 book-upload-sync.json pending），不用 SHA */
  function scheduleMarkBookUploadPending(patch) {
    if (composeState.mode !== 'book' || !composeState.draftFileId) return;
    if (bookPendingSuppress > 0) return;
    if (bookUploadPendingTimer) clearTimeout(bookUploadPendingTimer);
    bookUploadPendingTimer = setTimeout(() => {
      bookUploadPendingTimer = null;
      if (bookPendingSuppress > 0) return;
      const api = window.markwrite && window.markwrite.api;
      if (!api || typeof api.composeBookUploadMarkPending !== 'function') return;
      void api.composeBookUploadMarkPending({ draftId: composeState.draftFileId, ...patch });
    }, 400);
  }

  function runWithBookPendingSuppressed(fn) {
    bookPendingSuppress++;
    try {
      fn();
    } finally {
      bookPendingSuppress--;
    }
  }

  function markComposeBaselineFromCurrent() {
    commitActiveBookChapterFromEditor();
    composeBaselineSerialized = serializeComposeDraftState();
    updateBookOutlineSaveButtonState();
  }

  function getOutlineFromSerializedState(s) {
    if (!s) return '';
    try {
      const j = JSON.parse(String(s));
      return (j && typeof j.outline === 'string') ? j.outline.trim() : '';
    } catch (_) {
      return '';
    }
  }

  function updateBookOutlineSaveButtonState() {
    const btn = document.getElementById('book-outline-save-draft');
    if (!btn) return;
    if (composeState.mode !== 'book') {
      btn.classList.remove('is-dirty');
      return;
    }
    const currentOutline = getLiveBookOutlineTextFromDom();
    const baselineOutline = getOutlineFromSerializedState(composeBaselineSerialized);
    btn.classList.toggle('is-dirty', currentOutline !== baselineOutline);
  }

  function isContentDirty() {
    if (composeState.mode) {
      return serializeComposeDraftState() !== composeBaselineSerialized;
    }
    if (!editor) return false;
    const p = currentFilePath || null;
    const bp = editorBaseline.path || null;
    return editor.getValue() !== editorBaseline.content || p !== bp;
  }

  /**
   * 将服务端返回的相对路径拼成可访问 URL（与 main.js compose 上传里 mkPublicUrl 一致）。
   * uploadpath 已以 /uploads 结尾时不再重复加 uploads/；否则为纯文件名等补上 uploads/。
   */
  function toPublicUploadUrl(webPath) {
    const rel = (webPath || '').trim();
    if (!rel) return '';
    if (/^https?:\/\//i.test(rel) || /^data:/i.test(rel) || /^blob:/i.test(rel)) return rel;
    if (/^\/\//.test(rel)) {
      try {
        return `${window.location.protocol}${rel}`;
      } catch (_) {
        return `https:${rel}`;
      }
    }
    const active = getActiveSyncServer();
    const uploadBase = active && typeof active.uploadpath === 'string' ? active.uploadpath.trim() : '';
    if (!uploadBase) return rel;
    let p = rel.replace(/^\//, '');
    try {
      const base = uploadBase.endsWith('/') ? uploadBase : `${uploadBase}/`;
      const baseUrl = new URL(base);
      const basePath = (baseUrl.pathname || '').replace(/\/+$/, '');
      if (/\/uploads$/i.test(basePath)) {
        if (/^uploads\//i.test(p)) p = p.replace(/^uploads\//i, '');
        return String(new URL(p, base).href).replace(/\/uploads\/uploads\//gi, '/uploads/');
      }
      if (!/^uploads\//i.test(p)) p = `uploads/${p}`;
      return String(new URL(p, base).href).replace(/\/uploads\/uploads\//gi, '/uploads/');
    } catch (_) {
      const b = uploadBase.replace(/\/+$/, '');
      if (/\/uploads$/i.test(b)) {
        if (/^uploads\//i.test(p)) p = p.replace(/^uploads\//i, '');
        return `${b}/${p}`.replace(/\/uploads\/uploads\//gi, '/uploads/');
      }
      if (!/^uploads\//i.test(p)) p = `uploads/${p}`;
      return `${b}/${p}`.replace(/\/uploads\/uploads\//gi, '/uploads/');
    }
  }

  /** 封面图：绝对 URL、协议相对、本地 uploads/*、其余走 Sync 的 uploadpath */
  function resolveCoverImgSrc(v) {
    const raw = String(v || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw) || /^data:/i.test(raw) || /^blob:/i.test(raw)) return raw;
    if (/^\/\//.test(raw)) {
      try {
        return `${window.location.protocol}${raw}`;
      } catch (_) {
        return `https:${raw}`;
      }
    }
    if (/^\/?uploads\//i.test(raw)) return `/${raw.replace(/^\//, '')}`;
    return toPublicUploadUrl(raw);
  }

  function normalizeLocalUploadsWebPath(v) {
    const raw = String(v || '').trim();
    if (!raw) return '';
    if (/^\/?uploads\//i.test(raw)) return raw.replace(/^\//, '');
    return raw;
  }

  function resolveComposeCoverPreviewSrc(v) {
    return resolveCoverImgSrc(v);
  }

  function renderComposeCoverPreview(url) {
    if (!contentComposeCoverPreview) return;
    contentComposeCoverPreview.innerHTML = '';
    const src = resolveComposeCoverPreviewSrc(url);
    if (!src) {
      const icon = document.createElement('i');
      icon.className = 'bi bi-image';
      contentComposeCoverPreview.appendChild(icon);
      return;
    }
    const img = document.createElement('img');
    img.src = src;
    img.alt = '';
    img.onerror = () => {
      contentComposeCoverPreview.innerHTML = '<i class="bi bi-image"></i>';
    };
    contentComposeCoverPreview.appendChild(img);
  }

  async function applyProfileAvatarFile(file) {
    if (!file) return false;
    if (!file.type || !file.type.startsWith('image/')) {
      showAppAlert('请选择图片文件（png/jpg/webp/gif）');
      return false;
    }
    if (file.size > 3 * 1024 * 1024) {
      showAppAlert('图片过大，请选择 3MB 以内的头像');
      return false;
    }
    try {
      const dataUrl = await fileToDataUrl(file);
      if (!dataUrl) throw new Error('图片数据为空');
      profileServerAvatarUrl = dataUrl;
      profileDirtyInSession = true;
      renderProfileAvatarPreview(profileServerAvatarUrl);
      return true;
    } catch (e) {
      showAppAlert(`头像上传失败：${e && e.message ? e.message : String(e)}`);
      return false;
    }
  }

  function normalizeRemoteProfile(raw) {
    const p = raw && typeof raw === 'object' ? raw : {};
    const displayName = String(
      p.displayName || p.display_name || p.name || p.nickname || p.nick || '',
    ).trim();
    const title = String(
      p.title || p.jobTitle || p.job_title || p.role || '',
    ).trim();
    const bio = String(
      p.bio || p.about || p.description || p.intro || '',
    ).trim();
    const avatarUrl = String(
      p.avatarUrl || p.avatar_url || p.avatar || p.picture || p.image || '',
    ).trim();
    return { displayName, title, bio, avatarUrl };
  }

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
  const syncConnStatus = document.getElementById('sync-conn-status');
  const syncConnText = document.getElementById('sync-conn-text');
  const syncConnReconnectBtn = document.getElementById('sync-conn-reconnect');
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
  const menuContentNewBlog = document.getElementById('menu-content-new-blog');
  const menuContentNewBook = document.getElementById('menu-content-new-book');
  const menuContentDraftsBlog = document.getElementById('menu-content-drafts-blog');
  const menuContentDraftsBook = document.getElementById('menu-content-drafts-book');
  const menuContentRemoteBlogMine = document.getElementById('menu-content-remote-blog-mine');
  const menuContentRemoteBlogAll = document.getElementById('menu-content-remote-blog-all');
  const menuContentRemoteBookMine = document.getElementById('menu-content-remote-book-mine');
  const menuContentRemoteBookAll = document.getElementById('menu-content-remote-book-all');
  const contentComposePanel = document.getElementById('content-compose-panel');
  const contentComposeTopHost = document.getElementById('content-compose-top-host');
  const contentComposeBottomHost = document.getElementById('content-compose-bottom-host');
  let contentComposeTitle = document.getElementById('content-compose-title');
  let contentComposeSubtitle = document.getElementById('content-compose-subtitle');
  let contentComposeMainTitle = null;
  let contentComposeTagInput = null;
  let contentComposeTagAdd = null;
  let contentComposeCover = null;
  let contentComposeAuthor = null;
  let contentComposeExtraWrap = null;
  let contentComposeExtra = null;
  let contentComposeGenerateTags = null;
  let contentComposeGenerateSummary = null;
  let contentComposeGenerateStatus = null;
  let contentComposeCoverUpload = null;
  let contentComposeCoverScreenshot = null;
  let contentComposeCoverFile = null;
  let contentComposeCoverPreview = null;
  let contentComposeClose = document.getElementById('content-compose-close');
  let contentComposeSaveDraft = null;
  let contentComposePublish = null;
  let contentComposeUploadProgress = null;
  let contentComposeBookShell = null;
  let contentComposeOutline = null;
  function setupBookUploadPendingListeners() {
    const panel = document.getElementById('content-compose-panel');
    if (!panel || panel.dataset.bookPendingHooked) return;
    panel.dataset.bookPendingHooked = '1';
    panel.addEventListener('input', (e) => {
      if (composeState.mode !== 'book' || !composeState.draftFileId) return;
      const tid = e.target && e.target.id;
      if (tid === 'content-compose-outline') return;
      if (['content-compose-main-title', 'content-compose-author', 'content-compose-extra', 'content-compose-tag-input'].includes(tid)) {
        scheduleMarkBookUploadPending({ meta: true });
      }
    });
  }
  function bindComposeDomRefs() {
    contentComposeTitle = document.getElementById('content-compose-title');
    contentComposeSubtitle = document.getElementById('content-compose-subtitle');
    contentComposeMainTitle = document.getElementById('content-compose-main-title');
    contentComposeTagInput = document.getElementById('content-compose-tag-input');
    contentComposeTagAdd = document.getElementById('content-compose-tag-add');
    contentComposeCover = document.getElementById('content-compose-cover');
    contentComposeAuthor = document.getElementById('content-compose-author');
    contentComposeExtraWrap = document.getElementById('content-compose-extra-wrap');
    contentComposeExtra = document.getElementById('content-compose-extra');
    contentComposeGenerateTags = document.getElementById('content-compose-generate-tags');
    contentComposeGenerateSummary = document.getElementById('content-compose-generate-summary');
    contentComposeGenerateStatus = document.getElementById('content-compose-generate-status');
    contentComposeCoverUpload = document.getElementById('content-compose-cover-upload');
    contentComposeCoverScreenshot = document.getElementById('content-compose-cover-screenshot');
    contentComposeCoverFile = document.getElementById('content-compose-cover-file');
    contentComposeCoverPreview = document.getElementById('content-compose-cover-preview');
    contentComposeClose = document.getElementById('content-compose-close');
    contentComposeSaveDraft = document.getElementById('content-compose-save-draft');
    contentComposePublish = document.getElementById('content-compose-publish');
    contentComposeUploadProgress = document.getElementById('content-compose-upload-progress');
    contentComposeBookShell = document.getElementById('content-compose-book-shell');
    contentComposeOutline = document.getElementById('content-compose-outline');
    if (contentComposeOutline) {
      const onOutlineField = () => {
        updateBookOutlineSaveButtonState();
      };
      contentComposeOutline.oninput = onOutlineField;
      contentComposeOutline.onchange = onOutlineField;
    }
    setupBookUploadPendingListeners();
    bookOutlinePaneInstance = null;
  }
  const composeTemplateCache = { blog: '', book: '' };
  async function loadComposeTemplate(mode) {
    if (!contentComposeTopHost || !contentComposeBottomHost) return;
    // After syncComposeModeUi('blog'), save/publish live inside bottom host. Replacing
    // innerHTML would destroy those nodes; move them back to the header first.
    const headActionsPreserve = document.getElementById('content-compose-head-actions');
    if (headActionsPreserve && contentComposeBottomHost.contains(headActionsPreserve)) {
      const headTrailingPreserve = document.querySelector('.content-compose-head-trailing');
      const closePreserve = document.getElementById('content-compose-close');
      if (headTrailingPreserve) {
        headTrailingPreserve.insertBefore(headActionsPreserve, closePreserve || null);
      }
    }
    const key = mode === 'book' ? 'book' : 'blog';
    if (!composeTemplateCache[key]) {
      const res = await fetch(`./compose/${key}-compose.html`);
      composeTemplateCache[key] = await res.text();
    }
    const tmp = document.createElement('div');
    tmp.innerHTML = composeTemplateCache[key];
    const top = tmp.querySelector('[data-compose-slot="top"]');
    const bottom = tmp.querySelector('[data-compose-slot="bottom"]');
    contentComposeTopHost.innerHTML = top ? top.innerHTML : '';
    contentComposeBottomHost.innerHTML = bottom ? bottom.innerHTML : '';
    bindComposeDomRefs();
  }
  let bookOutlinePaneInstance = null;
  function ensureBookOutlinePane() {
    if (bookOutlinePaneInstance) return bookOutlinePaneInstance;
    const B = window.BookOutlinePane;
    if (!B || typeof B.create !== 'function') return null;
    const tree = document.getElementById('book-outline-tree');
    const hidden = document.getElementById('content-compose-outline');
    if (!tree || !hidden) return null;
    bookOutlinePaneInstance = B.create({
      hiddenTextarea: hidden,
      treeContainer: tree,
      editJsonBtn: document.getElementById('book-outline-edit-json'),
      addFolderBtn: document.getElementById('book-outline-add-folder'),
      addChapterBtn: document.getElementById('book-outline-add-chapter'),
      modal: document.getElementById('book-outline-json-modal'),
      modalTextarea: document.getElementById('book-outline-json-textarea'),
      modalError: document.getElementById('book-outline-json-error'),
      modalApply: document.getElementById('book-outline-json-apply'),
      renameModal: document.getElementById('book-outline-rename-modal'),
      renameInput: document.getElementById('book-outline-rename-input'),
      renameConfirm: document.getElementById('book-outline-rename-confirm'),
    });
    wireBookOutlinePaneIPC();
    return bookOutlinePaneInstance;
  }
  const paneEditor = document.getElementById('pane-editor');
  // 设置弹窗元素
  const settingsOverlay = document.getElementById('settings-overlay');
  const settingsCloseBtn = document.getElementById('settings-close-btn');
  const settingsCancelBtn = document.getElementById('settings-cancel-btn');
  const settingsSaveBtn = document.getElementById('settings-save-btn'); // 全局 footer 目前隐藏，仅保留兼容
  const settingsSyncSaveBtn = document.getElementById('settings-sync-save-btn');
  const settingsSyncCancelBtn = document.getElementById('settings-sync-cancel-btn');
  const settingsIdentityEmptyHint = document.getElementById('settings-identity-empty-hint');
  const settingsIdentityModePasteBtn = document.getElementById('settings-identity-mode-paste-btn');
  const settingsIdentityModeNewBtn = document.getElementById('settings-identity-mode-new-btn');
  const settingsIdentityEmailWrap = document.getElementById('settings-identity-email-wrap');
  const settingsIdentityGenerateMainBtn = document.getElementById('settings-identity-generate-main-btn');
  const settingsIdentitySaveBtn = document.getElementById('settings-identity-save-btn');
  const settingsIdentityRegisterServerBtn = document.getElementById('settings-identity-register-server-btn');
  const settingsIdentityLogoutBtn = document.getElementById('settings-identity-logout-btn');
  const settingsIdentityProfileBlock = document.getElementById('settings-identity-profile-block');
  const settingsIdentityProfileLoading = document.getElementById('settings-identity-profile-loading');
  const settingsIdentityProfileHas = document.getElementById('settings-identity-profile-has');
  const settingsIdentityProfileEmpty = document.getElementById('settings-identity-profile-empty');
  const settingsIdentityProfileError = document.getElementById('settings-identity-profile-error');
  const settingsIdentityProfileName = document.getElementById('settings-identity-profile-name');
  const settingsIdentityProfileSetBtn = document.getElementById('settings-identity-profile-set-btn');
  const settingsIdentityProfileSkipBtn = document.getElementById('settings-identity-profile-skip-btn');
  const settingsIdentityProfileFormWrap = document.getElementById('settings-identity-profile-form-wrap');
  const settingsIdentityKeySection = document.getElementById('settings-identity-key-section');
  const settingsProfileNameInput = document.getElementById('settings-profile-name');
  const settingsProfileTitleInput = document.getElementById('settings-profile-title');
  const settingsProfileBioInput = document.getElementById('settings-profile-bio');
  const settingsProfileAvatarPreview = document.getElementById('settings-profile-avatar-preview');
  const settingsProfileAvatarTrigger = document.getElementById('settings-profile-avatar-trigger');
  const settingsProfileAvatarFileInput = document.getElementById('settings-profile-avatar-file');
  const settingsProfileSaveBtn = document.getElementById('settings-profile-save-btn');
  const settingsProfileBackBtn = document.getElementById('settings-profile-back-btn');
  const settingsIdentityCopyBtn = document.getElementById('settings-identity-copy-btn');
  const settingsTabs = Array.from(document.querySelectorAll('.settings-tab'));
  const settingsPanels = Array.from(document.querySelectorAll('.settings-panel'));
  const settingsSyncName = document.getElementById('settings-sync-name');
  const settingsEsserver = document.getElementById('settings-sync-esserver');
  const settingsUploadpath = document.getElementById('settings-sync-uploadpath');
  const settingsSitename = document.getElementById('settings-sync-sitename');
  const settingsDomain = document.getElementById('settings-sync-domain');
  const settingsSyncServerList = document.getElementById('settings-sync-server-list');
  const settingsSyncNewBtn = document.getElementById('settings-sync-new');
  const settingsSyncDuplicateBtn = document.getElementById('settings-sync-duplicate');
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

  const THEME_STORAGE_KEY = 'markwrite-theme';
  let themeSavedHintTimer = null;
  function syncSettingsThemeButtons() {
    const t = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    document.querySelectorAll('.settings-theme-btn').forEach((btn) => {
      const choice = btn.getAttribute('data-theme-choice');
      if (!choice) return;
      const on = choice === t;
      btn.classList.toggle('is-theme-active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  function applyMarkwriteTheme(theme) {
    const t = theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem(THEME_STORAGE_KEY, t); } catch (_) {}
    if (editor && window.monaco && window.monaco.editor && typeof window.monaco.editor.setTheme === 'function') {
      window.monaco.editor.setTheme(t === 'light' ? 'vs' : 'vs-dark');
    }
    syncSettingsThemeButtons();
    const themeSavedHint = document.getElementById('settings-theme-saved-hint');
    if (themeSavedHint) {
      themeSavedHint.textContent = '已保存到本机，下次启动将使用此主题。';
      if (themeSavedHintTimer) clearTimeout(themeSavedHintTimer);
      themeSavedHintTimer = setTimeout(() => {
        themeSavedHint.textContent = '';
        themeSavedHintTimer = null;
      }, 3200);
    }
  }
  let editorBaseline = { path: null, content: '' };
  let composeBaselineSerialized = '';
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

  /** 关闭页内弹层后恢复焦点，避免 Electron 原生 alert/confirm 抢焦点 */
  function restoreFocusAfterAppDialog() {
    requestAnimationFrame(() => {
      try {
        const settingsOverlay = document.getElementById('settings-overlay');
        if (settingsOverlay && settingsOverlay.style.display !== 'none') {
          const closeBtn = document.getElementById('settings-close-btn');
          if (closeBtn) closeBtn.focus();
          return;
        }
        if (typeof editor !== 'undefined' && editor && typeof editor.focus === 'function') {
          editor.focus();
        }
      } catch (_) {}
    });
  }

  /**
   * 应用内统一弹层（替代 alert / confirm），z-index 高于 Settings
   * @param {{ title?: string, message?: string, showCancel?: boolean, confirmText?: string, cancelText?: string, variant?: 'default' | 'warning', onDone?: (confirmed: boolean) => void }} options
   * showCancel=false 时等价于 alert，onDone 仅收到 true
   */
  function showAppModal(options) {
    const {
      title = '提示',
      message = '',
      showCancel = true,
      confirmText = '确定',
      cancelText = '取消',
      variant = 'default',
      onDone,
    } = options || {};

    const overlay = document.createElement('div');
    overlay.className = 'settings-inline-confirm-overlay';
    if (variant === 'warning') overlay.classList.add('settings-inline-confirm-overlay--warning');
    const box = document.createElement('div');
    box.className = 'settings-inline-confirm-box';
    if (variant === 'warning') box.classList.add('settings-inline-confirm-box--warning');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    const titleEl = document.createElement('div');
    titleEl.className = 'settings-inline-confirm-title';
    if (variant === 'warning') {
      titleEl.classList.add('settings-inline-confirm-title--warning');
      const ic = document.createElement('i');
      ic.className = 'bi bi-exclamation-triangle-fill settings-inline-confirm-warn-ic';
      ic.setAttribute('aria-hidden', 'true');
      titleEl.appendChild(ic);
      const titleSpan = document.createElement('span');
      titleSpan.textContent = title;
      titleEl.appendChild(titleSpan);
    } else {
      titleEl.textContent = title;
    }
    const desc = document.createElement('div');
    desc.className = 'settings-inline-confirm-desc';
    desc.textContent = message || '';
    const actions = document.createElement('div');
    actions.className = 'settings-inline-confirm-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'apply-editor-btn apply-editor-btn-secondary';
    cancelBtn.textContent = cancelText;
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'apply-editor-btn apply-editor-btn-primary';
    okBtn.textContent = confirmText;
    if (showCancel) {
      actions.appendChild(cancelBtn);
    }
    actions.appendChild(okBtn);
    box.appendChild(titleEl);
    box.appendChild(desc);
    box.appendChild(actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const finalize = (confirmed) => {
      document.removeEventListener('keydown', onKeyDown);
      overlay.remove();
      if (typeof onDone === 'function') {
        onDone(showCancel ? !!confirmed : true);
      }
      restoreFocusAfterAppDialog();
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') finalize(showCancel ? false : true);
    };
    document.addEventListener('keydown', onKeyDown);
    okBtn.addEventListener('click', () => finalize(true));
    if (showCancel) {
      cancelBtn.addEventListener('click', () => finalize(false));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) finalize(false); });
    } else {
      overlay.addEventListener('click', (e) => { if (e.target === overlay) finalize(true); });
    }
    requestAnimationFrame(() => {
      try { okBtn.focus(); } catch (_) {}
    });
  }

  function showAppAlert(message, onClose) {
    showAppModal({
      title: '提示',
      message: String(message || ''),
      showCancel: false,
      confirmText: '确定',
      onDone: () => {
        if (typeof onClose === 'function') onClose();
      },
    });
  }

  /** @param {(ok: boolean) => void} onDone */
  function showAppConfirm(message, onDone, opts) {
    const o = opts || {};
    showAppModal({
      title: o.title != null ? o.title : '确认',
      message: String(message || ''),
      showCancel: true,
      confirmText: o.confirmText != null ? o.confirmText : '确定',
      cancelText: o.cancelText != null ? o.cancelText : '取消',
      variant: o.variant === 'warning' ? 'warning' : 'default',
      onDone,
    });
  }

  function confirmDiscardIfDirty(onProceed) {
    if (!isContentDirty()) {
      onProceed();
      return;
    }
    showAppConfirm(
      '当前内容尚未保存，确定继续？未保存的更改将丢失。',
      (ok) => { if (ok) onProceed(); },
      { title: '未保存', confirmText: '仍要继续', cancelText: '取消' },
    );
  }

  function confirmDiscardIfDirtyAsync() {
    return new Promise((resolve) => {
      if (!isContentDirty()) {
        resolve(true);
        return;
      }
      showAppConfirm(
        '当前内容尚未保存，确定继续？未保存的更改将丢失。',
        (ok) => { resolve(ok); },
        { title: '未保存', confirmText: '仍要继续', cancelText: '取消' },
      );
    });
  }

  function showSettingsConfirm(message, onDone) {
    showAppConfirm(message, onDone, {
      title: '退出登录',
      confirmText: '确定退出',
      cancelText: '取消',
    });
  }

  let aiMode = 'chat';
  /** 用户手动选择的模式，null 表示由系统根据输入自动判断 */
  // ---- VSCode-like 布局：聊天宽度拖拽 + 文件侧栏收起/展开 ----
  const LAYOUT_CHAT_WIDTH_KEY = 'markwrite-layout-chat-width'; // number px
  const LAYOUT_EXPLORER_HIDDEN_KEY = 'markwrite-layout-explorer-hidden'; // '1' | '0'

  // Sync 服务器配置：当前仅在内存中维护一组 profile，后续可接入持久化
  let syncServers = [];
  let activeSyncServerId = null;
  const syncConnState = {
    status: 'idle', // idle | connecting | connected | disconnected | stopped
    serverId: '',
    esserver: '',
    inflight: false,
    pollTimer: null,
    restartTimer: null,
    generation: 0,
    /** 用户点击状态栏按钮主动停止后，不再轮询，直至再次点击「开始」或配置变更 */
    userStopped: false,
  };

  function getActiveSyncServer() {
    return syncServers.find((s) => s.id === activeSyncServerId) || syncServers[0] || null;
  }

  function getActiveSyncServerIdForIdentity() {
    return activeSyncServerId || (syncServers[0] && syncServers[0].id) || '';
  }

  function setSyncConnStatus(status, text, title) {
    syncConnState.status = status;
    if (syncConnStatus) {
      syncConnStatus.classList.remove('is-idle', 'is-connecting', 'is-connected', 'is-disconnected', 'is-stopped');
      syncConnStatus.classList.add(
        status === 'connected'
          ? 'is-connected'
          : status === 'connecting'
            ? 'is-connecting'
            : status === 'disconnected'
              ? 'is-disconnected'
              : status === 'stopped'
                ? 'is-stopped'
                : 'is-idle',
      );
      if (title) syncConnStatus.title = title;
    }
    if (syncConnText) syncConnText.textContent = text || '服务器：未检测';
    updateSyncConnToggleUi();
  }

  function clearSyncConnTimers() {
    if (syncConnState.pollTimer) {
      clearTimeout(syncConnState.pollTimer);
      syncConnState.pollTimer = null;
    }
    if (syncConnState.restartTimer) {
      clearTimeout(syncConnState.restartTimer);
      syncConnState.restartTimer = null;
    }
  }

  function scheduleSyncConnRestart(delayMs = 500) {
    if (syncConnState.restartTimer) clearTimeout(syncConnState.restartTimer);
    syncConnState.restartTimer = setTimeout(() => {
      syncConnState.restartTimer = null;
      syncConnState.userStopped = false;
      updateSyncConnToggleUi();
      startSyncConnMonitor();
    }, delayMs);
  }

  function resumeSyncConnMonitor() {
    syncConnState.userStopped = false;
    updateSyncConnToggleUi();
    startSyncConnMonitor();
  }

  function startSyncConnMonitor() {
    if (syncConnState.userStopped) return;
    clearSyncConnTimers();
    syncConnState.generation += 1;
    const gen = syncConnState.generation;
    const active = getActiveSyncServer();
    const serverId = (active && active.id) || '';
    const serverName = (active && active.name) || '';
    const esserver = (active && typeof active.esserver === 'string') ? active.esserver.trim() : '';
    syncConnState.serverId = serverId;
    syncConnState.esserver = esserver;
    syncConnState.inflight = false;

    if (!esserver) {
      setSyncConnStatus('idle', '服务器：未配置', '请在设置里填写 esserver');
      return;
    }

    const runCheck = () => {
      if (gen !== syncConnState.generation) return;
      if (syncConnState.inflight) return;
      syncConnState.inflight = true;
      setSyncConnStatus('connecting', `服务器：正在连接（未就绪） (${serverName || serverId || '未命名'})`, esserver);
      const api = window.markwrite && window.markwrite.api;
      if (!api || typeof api.syncGetConnectionStatus !== 'function') {
        syncConnState.inflight = false;
        setSyncConnStatus('idle', '服务器：状态不可用', '当前环境不支持连接状态检测');
        return;
      }
      api.syncGetConnectionStatus().then((res) => {
        if (gen !== syncConnState.generation) return;
        const status = (res && res.status) || '';
        const msg = (res && res.message) ? String(res.message) : '';
        const title = `${esserver}${msg ? `\n${msg}` : ''}`;
        if (status === 'connected' && res && res.ok) {
          setSyncConnStatus('connected', `服务器：已连接 (${serverName || serverId || '未命名'})`, title);
          return;
        }
        if (status === 'idle') {
          setSyncConnStatus('idle', `服务器：未配置 (${serverName || serverId || '未命名'})`, title);
          return;
        }
        setSyncConnStatus(
          'disconnected',
          `服务器：连接失败 (${serverName || serverId || '未命名'})${msg ? `：${msg}` : ''}`,
          title,
        );
      }).catch((e) => {
        if (gen !== syncConnState.generation) return;
        const msg = e && e.message ? e.message : String(e);
        setSyncConnStatus('disconnected', `服务器：连接失败 (${serverName || serverId || '未命名'})：${msg}`, `${esserver}\n${msg}`);
      }).finally(() => {
        syncConnState.inflight = false;
        if (gen !== syncConnState.generation) return;
        syncConnState.pollTimer = setTimeout(() => {
          syncConnState.pollTimer = null;
          runCheck();
        }, 8000);
      });
    };

    runCheck();
  }

  function updateSyncConnToggleUi() {
    const btn = syncConnReconnectBtn;
    const icon = document.getElementById('sync-conn-toggle-icon');
    if (!btn) return;
    const stopped = syncConnState.userStopped;
    const st = syncConnState.status;
    btn.classList.toggle('is-paused', stopped);
    btn.classList.toggle('is-online', !stopped && st === 'connected');
    btn.classList.toggle('is-connecting', !stopped && st === 'connecting');
    if (stopped) {
      btn.title = '连接服务器（WebSocket）';
      btn.setAttribute('aria-label', '连接服务器');
      if (icon) icon.className = 'bi bi-play-fill sync-conn-toggle-ic';
      return;
    }
    if (st === 'connected') {
      btn.title = '断开与 EventStore 的连接';
      btn.setAttribute('aria-label', '断开连接');
    } else {
      btn.title = '停止连接与自动重试';
      btn.setAttribute('aria-label', '停止连接与自动重试');
    }
    if (icon) icon.className = 'bi bi-stop-fill sync-conn-toggle-ic';
  }

  async function toggleSyncConnFromStatusBar() {
    if (syncConnState.userStopped) {
      syncConnReconnectBtn?.classList.remove('is-spinning');
      void syncConnReconnectBtn?.offsetWidth;
      syncConnReconnectBtn?.classList.add('is-spinning');
      setTimeout(() => {
        syncConnReconnectBtn?.classList.remove('is-spinning');
      }, 700);
      resumeSyncConnMonitor();
      return;
    }
    syncConnState.userStopped = true;
    syncConnState.generation += 1;
    clearSyncConnTimers();
    syncConnState.inflight = false;
    const api = window.markwrite && window.markwrite.api;
    if (api && typeof api.syncDisconnect === 'function') {
      try {
        await api.syncDisconnect();
      } catch (_) {}
    }
    setSyncConnStatus('stopped', '服务器：已停止', '点击右侧圆形按钮重新连接');
  }

  function hydrateIdentityUiFromRecord(id) {
    const hasPriv = !!(id && id.privkey && typeof id.privkey === 'string' && id.privkey.trim());
    identityHasExisting = hasPriv;
    const displayPub = (id && (id.pubkeyEpub || id.pubkey || id.pubkeyHex)) || '';
    const pubEl = document.getElementById('settings-identity-pubkey');
    const privEl = document.getElementById('settings-identity-privkey');
    if (pubEl) pubEl.value = displayPub;
    if (privEl) privEl.value = (id && id.privkey) || '';
    refreshIdentityKeyHexCacheFromIdentity(id);
    if (settingsIdentityEmptyHint) {
      settingsIdentityEmptyHint.style.display = identityHasExisting ? 'none' : 'block';
    }
    if (identityHasExisting) identityLoginMode = 'paste';
    else if (identityLoginMode !== 'new') identityLoginMode = 'paste';
    applyIdentityLoginMode();
    if (currentSettingsTab === 'identity-profile') syncProfileIdentityKeys();
  }

  function loadIdentityForActiveServer() {
    if (!window.markwrite?.api?.identityGet) return;
    const nonce = ++identityPrefillNonce;
    const sid = getActiveSyncServerIdForIdentity();
    window.markwrite.api.identityGet({ serverId: sid }).then((id) => {
      if (nonce !== identityPrefillNonce) return;
      hydrateIdentityUiFromRecord(id || {});
    }).catch(() => {
      if (nonce !== identityPrefillNonce) return;
      hydrateIdentityUiFromRecord({});
    });
  }

  /**
   * 将服务器 profile 中的头像路径转为可展示的绝对 URL。
   * 已是 http(s) / data / blob 的保持不变；相对路径则拼到当前 Sync 里配置的 Upload Base URL。
   */
  function resolveAvatarUrlForDisplay(raw) {
    const s = typeof raw === 'string' ? raw.trim() : '';
    if (!s) return '';
    if (/^data:/i.test(s) || /^blob:/i.test(s)) return s;
    if (/^https?:\/\//i.test(s) || /^\/\//.test(s)) return s;
    const active = getActiveSyncServer();
    const uploadBase = active && typeof active.uploadpath === 'string' ? active.uploadpath.trim() : '';
    if (!uploadBase) return s;
    try {
      const base = uploadBase.endsWith('/') ? uploadBase : `${uploadBase}/`;
      return new URL(s, base).href;
    } catch (_) {
      const b = uploadBase.replace(/\/$/, '');
      const p = s.replace(/^\//, '');
      return `${b}/${p}`;
    }
  }

  function renderSyncServerList() {
    if (!settingsSyncServerList) return;
    settingsSyncServerList.innerHTML = '';
    syncServers.forEach((srv) => {
      const li = document.createElement('li');
      li.className = 'settings-sync-server-item';
      if (srv.id === activeSyncServerId) li.classList.add('is-active');
      li.dataset.id = srv.id;
      const dot = document.createElement('span');
      dot.className = 'settings-sync-server-dot';
      const nameEl = document.createElement('span');
      nameEl.className = 'settings-sync-server-name';
      nameEl.textContent = srv.name || '(未命名服务器)';
      li.appendChild(dot);
      li.appendChild(nameEl);
      li.addEventListener('click', () => {
        activeSyncServerId = srv.id;
        renderSyncServerList();
        fillSyncFormFromActive();
        loadIdentityForActiveServer();
        resumeSyncConnMonitor();
      });
      settingsSyncServerList.appendChild(li);
    });
  }

  function fillSyncFormFromActive() {
    const cur = getActiveSyncServer();
    if (!cur) return;
    if (settingsSyncName) settingsSyncName.value = cur.name || '';
    if (settingsEsserver) settingsEsserver.value = cur.esserver || '';
    if (settingsUploadpath) settingsUploadpath.value = cur.uploadpath || '';
    if (settingsSitename) settingsSitename.value = cur.sitename || '';
    if (settingsDomain) settingsDomain.value = cur.domain || '';
    if (currentSettingsTab === 'identity-profile') {
      renderProfileAvatarPreview(profileServerAvatarUrl);
    }
  }

  function saveFormToActive() {
    const cur = getActiveSyncServer();
    if (!cur) return;
    if (settingsSyncName) cur.name = settingsSyncName.value || cur.name;
    if (settingsEsserver) cur.esserver = settingsEsserver.value || '';
    if (settingsUploadpath) cur.uploadpath = settingsUploadpath.value || '';
    if (settingsSitename) cur.sitename = settingsSitename.value || '';
    if (settingsDomain) cur.domain = settingsDomain.value || '';
    renderSyncServerList();
    if (currentSettingsTab === 'identity-profile') {
      renderProfileAvatarPreview(profileServerAvatarUrl);
    }
    scheduleSyncConnRestart(700);
  }

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
    confirmDiscardIfDirty(() => {
      if (composeState.mode) exitContentComposeImpl();
      editor.setValue('');
      setFilename(null);
      markEditorBaselineFromCurrent();
      editor.focus();
    });
  }

  async function doOpenFileOrWorkspace() {
    if (!window.markwrite || !window.markwrite.api) return;
    const proceed = await confirmDiscardIfDirtyAsync();
    if (!proceed) return;
    const result = await window.markwrite.api.openFile();
    if (!result) return;
    // 若选择的是目录，则将该目录作为文件树根；若选择的是文件，则打开文件并将其所在目录作为文件树根
    if (result.directory) {
      setFileRoot(result.directory);
      await loadFileTree();
    } else if (result.filePath && editor) {
      if (composeState.mode) exitContentComposeImpl();
      editor.setValue(result.content);
      setFilename(result.filePath);
      markEditorBaselineFromCurrent();
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
      if (ok) {
        setFilename(currentFilePath);
        if (!composeState.mode) markEditorBaselineFromCurrent();
      }
    } else {
      const p = await window.markwrite.api.saveAs(content);
      if (p) {
        setFilename(p);
        if (!composeState.mode) markEditorBaselineFromCurrent();
      }
    }
  }

  async function doSaveAs() {
    if (!editor || !window.markwrite || !window.markwrite.api) return;
    const p = await window.markwrite.api.saveAs(editor.getValue());
    if (p) {
      setFilename(p);
      if (!composeState.mode) markEditorBaselineFromCurrent();
    }
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
    // 避免 Monaco 仍持焦点导致按键进编辑器而非设置里的输入框
    if (editor && typeof editor.blur === 'function') {
      try { editor.blur(); } catch (_) {}
    }
    // 从主进程加载 Sync & Servers 配置
    if (window.markwrite?.api?.syncGetConfig) {
      window.markwrite.api.syncGetConfig().then((cfg) => {
        if (!cfg) return;
        syncServers = Array.isArray(cfg.servers) ? cfg.servers.slice() : [];
        activeSyncServerId = cfg.activeId || (syncServers[0] && syncServers[0].id) || null;
        renderSyncServerList();
        fillSyncFormFromActive();
        loadIdentityForActiveServer();
        resumeSyncConnMonitor();
      }).catch(() => {
        // 失败时仍使用内存中的默认结构（可能为空）
        renderSyncServerList();
        fillSyncFormFromActive();
        loadIdentityForActiveServer();
        resumeSyncConnMonitor();
      });
    } else {
      renderSyncServerList();
      fillSyncFormFromActive();
      if (window.markwrite?.api?.identityGet) loadIdentityForActiveServer();
      else hydrateIdentityUiFromRecord({});
      resumeSyncConnMonitor();
    }
    // 预填 Workspace 只读展示
    if (settingsWorkspaceCurrent && window.markwrite?.api?.getDefaultWorkspace) {
      window.markwrite.api.getDefaultWorkspace().then((r) => {
        if (!r) return;
        settingsWorkspaceCurrent.value = r.path || '';
      }).catch(() => {});
    }
    syncSettingsThemeButtons();
    // 预填 Identity（由 sync 配置加载完成后再执行，避免 serverId 竞态）
  }

  function closeSettingsModal() {
    if (!settingsOverlay) return;
    settingsOverlay.style.display = 'none';
  }

  function applyIdentityLoginMode() {
    // 必须每次从 DOM 取节点：settings 内容异步注入后，缓存的 const 可能为 null，导致改的是“空引用”，页面上输入框永远被锁
    const privEl = document.getElementById('settings-identity-privkey');
    const emailEl = document.getElementById('settings-identity-email');
    const emailWrapEl = document.getElementById('settings-identity-email-wrap');
    const modeTabsElLive = document.querySelector('.identity-mode-tabs');

    if (modeTabsElLive) {
      modeTabsElLive.style.display = identityHasExisting ? 'none' : 'flex';
    }

    // 邮箱 / ESEC 始终可编辑，不再用 readOnly 按登录态锁定（避免各种异步竞态导致“不能输入”）
    if (privEl) {
      privEl.readOnly = false;
      privEl.removeAttribute('readonly');
      privEl.removeAttribute('disabled');
    }
    if (emailEl) {
      emailEl.readOnly = false;
      emailEl.removeAttribute('readonly');
      emailEl.removeAttribute('disabled');
    }

    
    const isNew = identityLoginMode === 'new';
    if (privEl) {
      privEl.placeholder = isNew
        ? '点击“生成新用户密钥”后自动填充 ESEC（不上传服务器）'
        : '粘贴或导入 ESEC 密钥，例如 esec1...';
    }

    if (emailWrapEl) emailWrapEl.style.display = isNew ? 'flex' : 'none';
    if (settingsIdentityGenerateMainBtn) settingsIdentityGenerateMainBtn.style.display = (isNew && !identityHasExisting) ? 'inline-flex' : 'none';
    if (settingsIdentityModePasteBtn) {
      settingsIdentityModePasteBtn.classList.toggle('apply-editor-btn-primary', !isNew);
      settingsIdentityModePasteBtn.classList.toggle('apply-editor-btn-secondary', isNew);
    }
    if (settingsIdentityModeNewBtn) {
      settingsIdentityModeNewBtn.classList.toggle('apply-editor-btn-primary', isNew);
      settingsIdentityModeNewBtn.classList.toggle('apply-editor-btn-secondary', !isNew);
    }

    if (settingsIdentitySaveBtn) {
      settingsIdentitySaveBtn.style.display = identityHasExisting ? 'none' : 'inline-flex';
    }
    if (settingsIdentityLogoutBtn) {
      settingsIdentityLogoutBtn.style.display = identityHasExisting ? 'inline-flex' : 'none';
    }
    if (settingsIdentityRegisterServerBtn) {
      // 只有「新用户生成的 ESEC」才需要 create_user 注册；粘贴已有 ESEC 不需要
      settingsIdentityRegisterServerBtn.style.display = (identityHasExisting && identityGeneratedThisSession) ? 'inline-flex' : 'none';
    }
  }

  /** 新用户邮箱：基本格式（与常见 type=email 规则一致） */
  function isValidIdentityEmail(s) {
    const t = (s || '').trim();
    if (!t) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t);
  }

  /**
   * 保存身份前校验：「新用户」须有效邮箱；ESEC 须能被主进程解析（与 identity:save 一致）
   */
  async function assertIdentityInputsCanSave() {
    const privEl = document.getElementById('settings-identity-privkey');
    const emailEl = document.getElementById('settings-identity-email');
    const priv = (privEl && privEl.value.trim()) || '';
    if (!priv) {
      throw new Error('请先粘贴或输入 ESEC 密钥');
    }
    if (identityLoginMode === 'new') {
      const email = (emailEl && emailEl.value.trim()) || '';
      if (!isValidIdentityEmail(email)) {
        throw new Error('「新用户（邮箱）」模式下请填写有效的邮箱地址');
      }
    }
    if (window.markwrite?.api?.identityDeriveFromEsec) {
      const d = await window.markwrite.api.identityDeriveFromEsec(priv);
      if (!d || !d.ok) {
        throw new Error('ESEC 无效：须为以 esec 开头的完整密钥（可粘贴后重试）');
      }
    }
  }

  /**
   * 本地 identity 已写入后，按当前 Sync 的 esserver 调用与 eventstoreUI create_user 相同的注册（code 100）。
   * @param {string} [emailForServer] 「新用户」模式下的邮箱；粘贴 ESEC 可为空串。
   */
  async function runServerRegisterAfterLocalIdentity(emailForServer) {
    if (!window.markwrite?.api?.identityRegisterOnServer) return;
    const email = typeof emailForServer === 'string' ? emailForServer.trim() : '';
    const reg = await window.markwrite.api.identityRegisterOnServer({ email });
    if (reg && reg.skipped) {
      showAppAlert('本地身份已保存。请在 Sync & Servers 中填写 EventStore WebSocket（esserver）后再点击「使用此 ESEC 登录」以完成服务器注册。');
      return;
    }
    if (reg && !reg.ok) {
      showAppAlert(`本地已保存，服务器注册失败：${reg.message || ''}`);
      return;
    }
    showAppAlert('已在 EventStore 服务器完成用户注册（与 eventstoreUI create_user 一致，code 100）。');
  }

  function syncProfileIdentityKeys() {
    updateProfileKeyFormatUi();
    const pubEl = document.getElementById('settings-identity-pubkey');
    const privEl = document.getElementById('settings-identity-privkey');
    const pubDisplay = document.getElementById('settings-profile-pubkey-display');
    const privDisplay = document.getElementById('settings-profile-privkey-display');
    if (!pubDisplay || !privDisplay) return;

    if (profileKeyDisplayMode === 'encoded') {
      pubDisplay.value = (pubEl && pubEl.value) || '';
      privDisplay.value = (privEl && privEl.value) || '';
      return;
    }

    const applyHexFromCache = () => {
      pubDisplay.value = identityKeyHexCache.pubkeyHex || '';
      privDisplay.value = identityKeyHexCache.privkeyHex || '';
    };

    if (identityKeyHexCache.pubkeyHex && identityKeyHexCache.privkeyHex) {
      applyHexFromCache();
      return;
    }

    const esec = (privEl && privEl.value.trim()) || '';
    const finishHydrate = () => {
      if (profileKeyDisplayMode !== 'hex') return;
      applyHexFromCache();
    };

    if (esec.startsWith('esec') && window.markwrite?.api?.identityDeriveFromEsec) {
      window.markwrite.api.identityDeriveFromEsec(esec).then((res) => {
        if (res && res.ok) refreshIdentityKeyHexCacheFromIdentity(res);
        finishHydrate();
      }).catch(() => { finishHydrate(); });
      applyHexFromCache();
      return;
    }

    if (window.markwrite?.api?.identityGet) {
      window.markwrite.api.identityGet({ serverId: getActiveSyncServerIdForIdentity() }).then((id) => {
        refreshIdentityKeyHexCacheFromIdentity(id);
        finishHydrate();
      }).catch(() => { finishHydrate(); });
    }
    applyHexFromCache();
  }

  function loadProfileFormFromServer() {
    if (!window.markwrite?.api?.identityFetchProfile) return Promise.resolve();
    const hasBufferedProfile = !!(
      (settingsProfileNameInput && settingsProfileNameInput.value && settingsProfileNameInput.value.trim())
      || (settingsProfileTitleInput && settingsProfileTitleInput.value && settingsProfileTitleInput.value.trim())
      || (settingsProfileBioInput && settingsProfileBioInput.value && settingsProfileBioInput.value.trim())
      || (profileServerAvatarUrl && String(profileServerAvatarUrl).trim())
    );
    if (profileDirtyInSession && hasBufferedProfile) {
      // B 模式：本地已有会话缓冲时先展示当前内容，但仍继续发起一次请求（只是不覆盖）。
      renderProfileAvatarPreview(profileServerAvatarUrl);
      updateProfileHeroNameDisplay((settingsProfileNameInput && settingsProfileNameInput.value) || '');
    }
    return window.markwrite.api.identityFetchProfile().then((res) => {
      const nameEl = document.getElementById('settings-profile-name');
      const titleEl = document.getElementById('settings-profile-title');
      const bioEl = document.getElementById('settings-profile-bio');
      if (!res || !res.ok) return;
      // B 模式：从服务器拉取仅用于“有数据时填充”，不要因为网络超时/空返回把当前页面内容冲掉
      if (!res.profile) return;
      const p = normalizeRemoteProfile(res.profile);
      if (!p.displayName && !p.title && !p.bio && !p.avatarUrl) return;
      // B 模式：如果用户已经编辑了本地会话缓冲，避免被服务器结果覆盖。
      if (profileDirtyInSession && hasBufferedProfile) return;
      if (nameEl) nameEl.value = p.displayName || '';
      if (titleEl) titleEl.value = p.title || '';
      if (bioEl) bioEl.value = p.bio || '';
      profileServerAvatarUrl = p.avatarUrl || '';
      profileDirtyInSession = false;
      renderProfileAvatarPreview(profileServerAvatarUrl);
      updateProfileHeroNameDisplay(p.displayName || '');
    }).catch(() => {});
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
    currentSettingsTab = name;
    syncSettingsThemeButtons();
    if ((name === 'identity-login' || name === 'identity-profile') && window.markwrite?.api?.identityFetchProfile) {
      startCheckProfile();
    }
    if (name === 'identity-profile') {
      updateProfileHeroNameDisplay(settingsProfileNameInput && settingsProfileNameInput.value ? settingsProfileNameInput.value : '');
      renderProfileAvatarPreview(profileServerAvatarUrl);
      syncProfileIdentityKeys();
      startCheckProfile();
      return loadProfileFormFromServer();
    }
    return Promise.resolve();
  }

  /** 检查远程 profile：老用户看是否有资料，新用户提示完善。丝滑无弹窗，仅更新状态区 */
  function startCheckProfile() {
    if (!settingsIdentityProfileBlock || !window.markwrite?.api?.identityFetchProfile) return;
    settingsIdentityProfileBlock.style.display = 'block';
    if (settingsIdentityProfileLoading) settingsIdentityProfileLoading.style.display = 'flex';
    if (settingsIdentityProfileHas) settingsIdentityProfileHas.style.display = 'none';
    if (settingsIdentityProfileEmpty) settingsIdentityProfileEmpty.style.display = 'none';
    if (settingsIdentityProfileError) {
      settingsIdentityProfileError.style.display = 'none';
      settingsIdentityProfileError.textContent = '';
    }
    window.markwrite.api.identityFetchProfile().then((res) => {
      if (settingsIdentityProfileLoading) settingsIdentityProfileLoading.style.display = 'none';
      if (!res) return;
      if (!res.ok) {
        if (settingsIdentityProfileError) {
          settingsIdentityProfileError.textContent = res.message || '检查失败';
          settingsIdentityProfileError.style.display = 'block';
        }
        return;
      }
      const profile = normalizeRemoteProfile(res.profile);
      if (profile.displayName || profile.avatarUrl || profile.bio || profile.title) {
        if (settingsIdentityProfileHas) {
          settingsIdentityProfileName.textContent = profile.displayName || '(已设置)';
          settingsIdentityProfileHas.style.display = 'block';
        }
      } else {
        if (settingsIdentityProfileEmpty) settingsIdentityProfileEmpty.style.display = 'block';
      }
    }).catch(() => {
      if (settingsIdentityProfileLoading) settingsIdentityProfileLoading.style.display = 'none';
      if (settingsIdentityProfileError) {
        settingsIdentityProfileError.textContent = '网络或服务异常';
        settingsIdentityProfileError.style.display = 'block';
      }
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
  document.querySelectorAll('.settings-theme-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const ch = btn.getAttribute('data-theme-choice');
      if (ch === 'light' || ch === 'dark') applyMarkwriteTheme(ch);
    });
  });
  syncSettingsThemeButtons();
  if (settingsOverlay) {
    settingsOverlay.addEventListener('click', (e) => {
      if (e.target === settingsOverlay) closeSettingsModal();
    });
  }
  if (settingsCloseBtn) settingsCloseBtn.addEventListener('click', closeSettingsModal);
  if (settingsCancelBtn) settingsCancelBtn.addEventListener('click', closeSettingsModal);
  if (settingsSaveBtn) {
    // 旧的全局保存按钮已隐藏，这里保持向后兼容：等同于「Sync 保存」
    settingsSaveBtn.addEventListener('click', () => {
      if (!window.markwrite?.api?.syncSaveConfig) {
        closeSettingsModal();
        return;
      }
      saveFormToActive();
      const payload = {
        servers: syncServers,
        activeId: activeSyncServerId || (syncServers[0] && syncServers[0].id) || null,
      };
      window.markwrite.api.syncSaveConfig(payload).finally(() => {
        closeSettingsModal();
      });
    });
  }

  // Sync & Servers 表单变更时实时写回当前 profile
  if (settingsSyncName) {
    settingsSyncName.addEventListener('input', () => {
      saveFormToActive();
    });
  }
  if (settingsEsserver) {
    settingsEsserver.addEventListener('input', () => {
      saveFormToActive();
    });
  }
  if (settingsUploadpath) {
    settingsUploadpath.addEventListener('input', () => {
      saveFormToActive();
    });
  }
  if (settingsSitename) {
    settingsSitename.addEventListener('input', () => {
      saveFormToActive();
    });
  }
  if (settingsDomain) {
    settingsDomain.addEventListener('input', () => {
      saveFormToActive();
    });
  }

  if (settingsSyncCancelBtn) {
    settingsSyncCancelBtn.addEventListener('click', () => {
      // 取消：丢弃未保存修改，重新从磁盘加载 Sync 配置
      if (window.markwrite?.api?.syncGetConfig) {
        window.markwrite.api.syncGetConfig().then((cfg) => {
          if (!cfg) return;
          syncServers = Array.isArray(cfg.servers) ? cfg.servers.slice() : [];
          activeSyncServerId = cfg.activeId || (syncServers[0] && syncServers[0].id) || null;
          renderSyncServerList();
          fillSyncFormFromActive();
          loadIdentityForActiveServer();
          resumeSyncConnMonitor();
        }).catch(() => {});
      }
    });
  }

  if (settingsSyncSaveBtn && window.markwrite?.api?.syncSaveConfig) {
    settingsSyncSaveBtn.addEventListener('click', () => {
      saveFormToActive();
      const payload = {
        servers: syncServers,
        activeId: activeSyncServerId || (syncServers[0] && syncServers[0].id) || null,
      };
      window.markwrite.api.syncSaveConfig(payload).catch(() => {});
    });
  }

  // 身份：独立按钮「使用此 ESEC 登录」与「退出登录」，用显示/隐藏切换，不复用同一按钮改文案
  if (settingsIdentityLogoutBtn && window.markwrite?.api?.identitySave) {
    settingsIdentityLogoutBtn.addEventListener('click', () => {
      showSettingsConfirm(
        '建议先复制并备份好 ESEC 密钥。\n确定要退出登录并清除当前用户的本地密钥吗？',
        (ok) => {
          if (!ok) return;
          const payload = { pubkey: '', privkey: '' };
          window.markwrite.api.identitySave({
            ...payload,
            serverId: getActiveSyncServerIdForIdentity(),
          }).then((res) => {
            if (res && res.ok) {
              identityPrefillNonce += 1;
              identityHasExisting = false;
              identityGeneratedThisSession = false;
              const pubOut = document.getElementById('settings-identity-pubkey');
              const privOut = document.getElementById('settings-identity-privkey');
              const emailOut = document.getElementById('settings-identity-email');
              if (pubOut) pubOut.value = '';
              if (privOut) privOut.value = '';
              if (emailOut) emailOut.value = '';
              if (settingsIdentityEmptyHint) settingsIdentityEmptyHint.style.display = 'block';
              identityKeyHexCache.pubkeyHex = '';
              identityKeyHexCache.privkeyHex = '';
              identityLoginMode = 'paste';
              applyIdentityLoginMode();
              syncProfileIdentityKeys();
              // 退出登录：清空本次会话的「用户信息」缓冲
              profileDirtyInSession = false;
              profileServerAvatarUrl = '';
              const nameEl = document.getElementById('settings-profile-name');
              const titleEl = document.getElementById('settings-profile-title');
              const bioEl = document.getElementById('settings-profile-bio');
              if (nameEl) nameEl.value = '';
              if (titleEl) titleEl.value = '';
              if (bioEl) bioEl.value = '';
              updateProfileHeroNameDisplay('');
              renderProfileAvatarPreview('');
              requestAnimationFrame(() => {
                try {
                  const saveBtn = document.getElementById('settings-identity-save-btn');
                  if (saveBtn && saveBtn.offsetParent !== null) saveBtn.focus();
                } catch (_) {}
              });
            } else {
              showAppAlert((res && res.message) || '退出登录失败');
            }
          }).catch((e) => {
            showAppAlert(`退出登录失败：${e && e.message ? e.message : String(e)}`);
          });
        },
      );
    });
  }

  if (settingsIdentitySaveBtn && window.markwrite?.api?.identitySave) {
    settingsIdentitySaveBtn.addEventListener('click', () => {
      if (identityHasExisting) return;
      void (async () => {
        try {
          await assertIdentityInputsCanSave();
        } catch (e) {
          showAppAlert(e && e.message ? e.message : String(e));
          return;
        }
        const pubElSave = document.getElementById('settings-identity-pubkey');
        const privElSave = document.getElementById('settings-identity-privkey');
        const payload = {
          pubkey: pubElSave ? pubElSave.value.trim() : '',
          privkey: privElSave ? privElSave.value.trim() : '',
        };
        try {
          const res = await window.markwrite.api.identitySave({
            ...payload,
            serverId: getActiveSyncServerIdForIdentity(),
          });
          if (res && res.ok) {
            refreshIdentityKeyHexCacheFromIdentity(res);
            const emailForServer = identityLoginMode === 'new'
              ? (document.getElementById('settings-identity-email') && document.getElementById('settings-identity-email').value.trim()) || ''
              : '';
            identityHasExisting = !!(payload.privkey && payload.privkey.trim());
            if (settingsIdentityEmptyHint) {
              settingsIdentityEmptyHint.style.display = identityHasExisting ? 'none' : 'block';
            }
            identityLoginMode = 'paste';
            applyIdentityLoginMode();
            if (currentSettingsTab === 'identity-profile') syncProfileIdentityKeys();
            if (identityHasExisting) {
              if (window.markwrite?.api?.identityGet) {
                window.markwrite.api.identityGet({ serverId: getActiveSyncServerIdForIdentity() }).then((id) => {
                  if (!id) return;
                  const displayPub = id.pubkeyEpub || id.pubkey || id.pubkeyHex || '';
                  const pubEl = document.getElementById('settings-identity-pubkey');
                  if (pubEl) pubEl.value = displayPub;
                  if (currentSettingsTab === 'identity-profile') syncProfileIdentityKeys();
                }).catch(() => {});
              }
              if (shouldRegisterOnServerAfterSave(emailForServer)) {
                await runServerRegisterAfterLocalIdentity(emailForServer);
              }
              startCheckProfile();
            }
          } else {
            showAppAlert((res && res.message) || '保存失败');
          }
        } catch (e) {
          showAppAlert(`保存身份失败：${e && e.message ? e.message : String(e)}`);
        }
      })();
    });
  }

  if (settingsIdentityRegisterServerBtn && window.markwrite?.api?.identityRegisterOnServer) {
    settingsIdentityRegisterServerBtn.addEventListener('click', () => {
      if (!identityHasExisting) return;
      void (async () => {
        const emailEl = document.getElementById('settings-identity-email');
        let emailForServer = '';
        if (emailEl && emailEl.value && isValidIdentityEmail(emailEl.value.trim())) {
          emailForServer = emailEl.value.trim();
        }
        if (!identityGeneratedThisSession) {
          showAppAlert('只有「新用户（邮箱）」生成的新 ESEC 才需要向服务器注册。');
          return;
        }
        if (!emailForServer) {
          showAppAlert('请填写有效邮箱后再注册到服务器。');
          return;
        }
        await runServerRegisterAfterLocalIdentity(emailForServer);
      })();
    });
  }

  if (settingsIdentityCopyBtn) {
    settingsIdentityCopyBtn.addEventListener('click', () => {
      const privEl = document.getElementById('settings-identity-privkey');
      const v = (privEl && privEl.value) || '';
      if (!v.trim() || !window.markwrite?.api?.clipboardWriteText) return;
      const showCopyState = (text) => {
        const oldText = settingsIdentityCopyBtn.textContent;
        settingsIdentityCopyBtn.textContent = text;
        setTimeout(() => {
          settingsIdentityCopyBtn.textContent = oldText;
        }, 5000);
      };
      window.markwrite.api.clipboardWriteText(v).then((res) => {
        if (res && res.ok) showCopyState('已复制');
        else showCopyState('复制失败');
      }).catch(() => {
        showCopyState('复制失败');
      });
    });
  }

  function shouldRegisterOnServerAfterSave(email) {
    if (identityLoginMode !== 'new') return false;
    if (!identityGeneratedThisSession) return false;
    return typeof email === 'string' && email.trim().length > 0;
  }

  function handleGenerateIdentity() {
    if (!window.markwrite?.api?.identityGenerate) return;
    if (identityLoginMode !== 'new') {
      showAppAlert('请先切换到“新用户（邮箱）”模式。');
      return;
    }
    const emailEl = document.getElementById('settings-identity-email');
    const email = (emailEl && emailEl.value.trim()) || '';
    if (!isValidIdentityEmail(email)) {
      showAppAlert('请先输入有效的邮箱地址（需包含 @ 与域名）。');
      return;
    }
    window.markwrite.api.identityGenerate().then((result) => {
      if (!result || !result.ok) {
        showAppAlert(`生成 ESEC 失败：${(result && result.message) || '未知错误'}`);
        return;
      }
      const privEl = document.getElementById('settings-identity-privkey');
      const pubEl = document.getElementById('settings-identity-pubkey');
      if (privEl) privEl.value = result.esec || '';
      if (pubEl) pubEl.value = result.epub || result.pubkeyHex || '';
      refreshIdentityKeyHexCacheFromIdentity({
        pubkeyHex: result.pubkeyHex,
        privkeyHex: result.privkeyHex,
      });
      if (settingsIdentityEmptyHint) settingsIdentityEmptyHint.style.display = 'none';
      identityHasExisting = false;
      identityGeneratedThisSession = true;
      applyIdentityLoginMode();
      // 新用户生成后不自动保存，用户可继续完善资料后点击上传再保存
      if (settingsIdentityProfileSetBtn) {
        settingsIdentityProfileSetBtn.click();
      }
    }).catch((e) => {
      showAppAlert(`生成 ESEC 失败：${e && e.message ? e.message : String(e)}`);
    });
  }

  if (settingsIdentityGenerateMainBtn && window.markwrite?.api?.identityGenerate) {
    settingsIdentityGenerateMainBtn.addEventListener('click', handleGenerateIdentity);
  }

  if (settingsIdentityModePasteBtn) {
    settingsIdentityModePasteBtn.addEventListener('click', () => {
      identityLoginMode = 'paste';
      identityGeneratedThisSession = false;
      applyIdentityLoginMode();
      const priv = document.getElementById('settings-identity-privkey');
      if (priv) {
        setTimeout(() => {
          priv.focus();
          const len = priv.value ? priv.value.length : 0;
          try { priv.setSelectionRange(len, len); } catch (_) {}
        }, 0);
      }
    });
  }
  if (settingsIdentityModeNewBtn) {
    settingsIdentityModeNewBtn.addEventListener('click', () => {
      identityLoginMode = 'new';
      identityGeneratedThisSession = false;
      applyIdentityLoginMode();
      const email = document.getElementById('settings-identity-email');
      if (email) {
        setTimeout(() => {
          email.focus();
          const len = email.value ? email.value.length : 0;
          try { email.setSelectionRange(len, len); } catch (_) {}
        }, 0);
      }
    });
  }

  // 在 ESEC 框中粘贴/输入新 esec 时，自动计算并填充 epub（委托到 overlay，避免初始化时节点引用为 null）
  if (settingsOverlay && window.markwrite?.api?.identityDeriveFromEsec) {
    settingsOverlay.addEventListener('input', (e) => {
      const t = e.target;
      if (!t || t.id !== 'settings-identity-privkey') return;
      if (currentSettingsTab === 'identity-profile') syncProfileIdentityKeys();
      // 手工粘贴/编辑 ESEC（区别于“生成新用户密钥”）不应触发服务器注册
      identityGeneratedThisSession = false;
      const v = (t.value || '').trim();
      if (!v || !v.startsWith('esec') || v === lastDerivedEsec) return;
      if (v.length < 10) return;
      lastDerivedEsec = v;
      window.markwrite.api.identityDeriveFromEsec(v).then((res) => {
        if (!res || !res.ok) return;
        refreshIdentityKeyHexCacheFromIdentity(res);
        const pubEl = document.getElementById('settings-identity-pubkey');
        if (pubEl) pubEl.value = res.pubkeyEpub || res.pubkeyHex || '';
        if (currentSettingsTab === 'identity-profile') syncProfileIdentityKeys();
      }).catch(() => {});
    });
  }

  if (settingsIdentityProfileSetBtn && settingsIdentityProfileFormWrap && settingsIdentityKeySection) {
    settingsIdentityProfileSetBtn.addEventListener('click', () => {
      if (settingsIdentityProfileEmpty) settingsIdentityProfileEmpty.style.display = 'none';
      switchSettingsTab('identity-profile').then(() => {
        const nameEl = document.getElementById('settings-profile-name');
        if (nameEl) nameEl.focus();
      });
    });
  }
  if (settingsProfileBackBtn && settingsIdentityProfileFormWrap && settingsIdentityKeySection) {
    settingsProfileBackBtn.addEventListener('click', () => {
      switchSettingsTab('identity-login');
    });
  }
  if (settingsIdentityProfileSkipBtn && settingsIdentityProfileEmpty) {
    settingsIdentityProfileSkipBtn.addEventListener('click', () => {
      settingsIdentityProfileEmpty.style.display = 'none';
    });
  }
  function copyProfileKey(btn, text) {
    const v = (text || '').trim();
    if (!v || !window.markwrite?.api?.clipboardWriteText) return;
    const showCopyState = (msg) => {
      const oldText = btn.textContent;
      btn.textContent = msg;
      setTimeout(() => {
        btn.textContent = oldText;
      }, 5000);
    };
    window.markwrite.api.clipboardWriteText(v).then((res) => {
      if (res && res.ok) showCopyState('已复制');
      else showCopyState('复制失败');
    }).catch(() => {
      showCopyState('复制失败');
    });
  }
  const settingsProfileCopyPubkeyBtn = document.getElementById('settings-profile-copy-pubkey');
  const settingsProfileCopyPrivkeyBtn = document.getElementById('settings-profile-copy-privkey');
  if (settingsProfileCopyPubkeyBtn) {
    settingsProfileCopyPubkeyBtn.addEventListener('click', () => {
      const el = document.getElementById('settings-profile-pubkey-display');
      copyProfileKey(settingsProfileCopyPubkeyBtn, el && el.value);
    });
  }
  if (settingsProfileCopyPrivkeyBtn) {
    settingsProfileCopyPrivkeyBtn.addEventListener('click', () => {
      const el = document.getElementById('settings-profile-privkey-display');
      copyProfileKey(settingsProfileCopyPrivkeyBtn, el && el.value);
    });
  }
  const settingsProfileKeyFormatEncoded = document.getElementById('settings-profile-key-format-encoded');
  const settingsProfileKeyFormatHex = document.getElementById('settings-profile-key-format-hex');
  if (settingsProfileKeyFormatEncoded) {
    settingsProfileKeyFormatEncoded.addEventListener('click', () => {
      profileKeyDisplayMode = 'encoded';
      syncProfileIdentityKeys();
    });
  }
  if (settingsProfileKeyFormatHex) {
    settingsProfileKeyFormatHex.addEventListener('click', () => {
      profileKeyDisplayMode = 'hex';
      syncProfileIdentityKeys();
    });
  }
  const settingsProfileKeysToggleBtn = document.getElementById('settings-profile-keys-toggle');
  if (settingsProfileKeysToggleBtn) {
    settingsProfileKeysToggleBtn.addEventListener('click', () => {
      const keysEl = document.getElementById('settings-profile-keys-section');
      const textEl = settingsProfileKeysToggleBtn.querySelector('.profile-form-page-more-toggle-text');
      if (!keysEl) return;
      const nextExpanded = keysEl.hasAttribute('hidden');
      if (nextExpanded) keysEl.removeAttribute('hidden');
      else keysEl.setAttribute('hidden', '');
      settingsProfileKeysToggleBtn.setAttribute('aria-expanded', nextExpanded ? 'true' : 'false');
      if (textEl) {
        textEl.innerHTML = nextExpanded
          ? '<i class="bi bi-key-fill"></i> 收起密钥信息（公钥 / 私钥）'
          : '<i class="bi bi-key"></i> 展开密钥信息（公钥 / 私钥）';
      }
      if (nextExpanded) {
        syncProfileIdentityKeys();
        keysEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  }
  if (settingsProfileNameInput) {
    settingsProfileNameInput.addEventListener('input', () => {
      profileDirtyInSession = true;
      updateProfileHeroNameDisplay(settingsProfileNameInput.value || '');
    });
  }
  if (settingsProfileTitleInput) {
    settingsProfileTitleInput.addEventListener('input', () => {
      profileDirtyInSession = true;
    });
  }
  if (settingsProfileBioInput) {
    settingsProfileBioInput.addEventListener('input', () => {
      profileDirtyInSession = true;
    });
  }
  if (settingsProfileAvatarPreview) {
    renderProfileAvatarPreview(profileServerAvatarUrl);
  }
  if (settingsProfileAvatarTrigger && settingsProfileAvatarFileInput) {
    settingsProfileAvatarTrigger.addEventListener('click', () => {
      settingsProfileAvatarFileInput.click();
    });
    settingsProfileAvatarTrigger.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items ? Array.from(e.clipboardData.items) : [];
      const imageItem = items.find((it) => it && it.type && it.type.startsWith('image/'));
      if (!imageItem) return;
      e.preventDefault();
      const file = imageItem.getAsFile ? imageItem.getAsFile() : null;
      if (!file) return;
      void applyProfileAvatarFile(file);
    });
    settingsProfileAvatarTrigger.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      settingsProfileAvatarFileInput.click();
    });
    settingsProfileAvatarFileInput.addEventListener('change', () => {
      const f = settingsProfileAvatarFileInput.files && settingsProfileAvatarFileInput.files[0];
      if (!f) return;
      void applyProfileAvatarFile(f).finally(() => {
        settingsProfileAvatarFileInput.value = '';
      });
    });
  }
  if (settingsProfileSaveBtn) {
    settingsProfileSaveBtn.addEventListener('click', () => {
      const displayName = (settingsProfileNameInput && settingsProfileNameInput.value.trim()) || '';
      const title = (settingsProfileTitleInput && settingsProfileTitleInput.value.trim()) || '';
      const avatarUrl = (profileServerAvatarUrl || '').trim();
      const bio = (settingsProfileBioInput && settingsProfileBioInput.value.trim()) || '';
      const profile = { displayName, title, avatarUrl, bio };
      // B 模式：不保存到服务器，仅在本次会话缓存（profileDirtyInSession 保持为 true）
      profileDirtyInSession = true;
      updateProfileHeroNameDisplay(displayName);
      renderProfileAvatarPreview(profileServerAvatarUrl);
      console.log('[profile] cached in session:', profile);
      showAppAlert('已缓存（仅本次会话有效，不会上传服务器）。');
    });
  }

  if (settingsSyncNewBtn) {
    settingsSyncNewBtn.addEventListener('click', () => {
      const idBase = 'server';
      let idx = syncServers.length + 1;
      let id = `${idBase}-${idx}`;
      while (syncServers.some((s) => s.id === id)) {
        idx += 1;
        id = `${idBase}-${idx}`;
      }
      const srv = {
        id,
        name: `Server ${idx}`,
        esserver: '',
        uploadpath: '',
        sitename: '',
        domain: '',
      };
      syncServers.push(srv);
      activeSyncServerId = srv.id;
      renderSyncServerList();
      fillSyncFormFromActive();
      loadIdentityForActiveServer();
      resumeSyncConnMonitor();
    });
  }

  if (settingsSyncDuplicateBtn) {
    settingsSyncDuplicateBtn.addEventListener('click', () => {
      const cur = getActiveSyncServer();
      if (!cur) return;
      const baseName = cur.name || 'Server';
      const idBase = cur.id || 'server';
      let idx = 1;
      let id = `${idBase}-copy-${idx}`;
      while (syncServers.some((s) => s.id === id)) {
        idx += 1;
        id = `${idBase}-copy-${idx}`;
      }
      const srv = {
        id,
        name: `${baseName} (copy ${idx})`,
        esserver: cur.esserver,
        uploadpath: cur.uploadpath,
        sitename: cur.sitename,
        domain: cur.domain,
      };
      syncServers.push(srv);
      activeSyncServerId = srv.id;
      renderSyncServerList();
      fillSyncFormFromActive();
      loadIdentityForActiveServer();
      resumeSyncConnMonitor();
    });
  }

  function syncLeftPaneForCompose(mode) {
    const pane = document.getElementById('pane-files');
    const titleEl = document.getElementById('pane-files-title');
    const actions = document.getElementById('pane-files-actions-explorer');
    if (!pane) return;
    const isBook = mode === 'book';
    if (isBook) {
      pane.setAttribute('data-book-compose', '1');
      if (titleEl) titleEl.textContent = '书籍大纲';
      if (actions) actions.style.display = 'none';
    } else {
      pane.removeAttribute('data-book-compose');
      if (titleEl) titleEl.textContent = 'Files';
      if (actions) actions.style.display = '';
    }
  }

  let bookComposeView = 'info';

  function clearBookComposeView() {
    bookComposeView = 'info';
    const pe = document.getElementById('pane-editor');
    const pf = document.getElementById('pane-files');
    if (pe) pe.removeAttribute('data-book-view');
    if (pf) pf.removeAttribute('data-book-view');
    const navInfo = document.getElementById('book-compose-nav-info');
    const navEd = document.getElementById('book-compose-nav-editor');
    const navUp = document.getElementById('book-compose-nav-upload');
    if (navInfo) navInfo.classList.toggle('is-active', false);
    if (navEd) navEd.classList.toggle('is-active', false);
    if (navUp) navUp.classList.toggle('is-active', false);
  }

  function setBookUploadPanelProgress(text, kind) {
    const el = document.getElementById('book-upload-panel-progress');
    if (!el) return;
    const msg = String(text || '').trim();
    if (!msg) {
      el.textContent = '';
      el.style.display = 'none';
      el.classList.remove('is-error');
      return;
    }
    el.style.display = 'block';
    el.textContent = msg;
    el.classList.toggle('is-error', kind === 'error');
  }

  async function refreshBookUploadPanel() {
    const listEl = document.getElementById('book-upload-parts-list');
    const legacyEl = document.getElementById('book-upload-legacy-hint');
    const noDraftEl = document.getElementById('book-upload-no-draft');
    const remoteEl = document.getElementById('book-upload-remote-line');
    if (!listEl || composeState.mode !== 'book') return;
    const api = window.markwrite && window.markwrite.api;
    if (!composeState.draftFileId) {
      listEl.innerHTML = '';
      if (noDraftEl) {
        noDraftEl.style.display = 'block';
        noDraftEl.textContent = '请先点击「保存草稿」生成本地目录草稿后再上传。';
      }
      if (legacyEl) legacyEl.style.display = 'none';
      if (remoteEl) remoteEl.textContent = '';
      return;
    }
    if (noDraftEl) noDraftEl.style.display = 'none';
    if (!api || typeof api.composeBookUploadDiff !== 'function') {
      listEl.innerHTML = '';
      const li = document.createElement('li');
      li.className = 'book-upload-part';
      li.textContent = '上传状态需要桌面版';
      listEl.appendChild(li);
      return;
    }
    const diff = await api.composeBookUploadDiff({ draftId: composeState.draftFileId });
    if (!diff.ok) {
      listEl.innerHTML = '';
      if (noDraftEl) {
        noDraftEl.style.display = 'block';
        noDraftEl.textContent = diff.message || '读取同步状态失败';
      }
      return;
    }
    if (diff.isLegacyJson) {
      if (legacyEl) {
        legacyEl.style.display = 'block';
        legacyEl.textContent = diff.message || '请先保存为目录草稿';
      }
      listEl.innerHTML = '';
      return;
    }
    if (legacyEl) legacyEl.style.display = 'none';
    if (remoteEl) {
      if (diff.hasRemoteId) {
        remoteEl.innerHTML = '';
        const ic = document.createElement('i');
        ic.className = 'bi bi-cloud-check';
        remoteEl.appendChild(ic);
        remoteEl.appendChild(document.createTextNode(' 已关联远程书籍 ID：'));
        const code = document.createElement('code');
        code.textContent = diff.remoteId || '';
        remoteEl.appendChild(code);
        remoteEl.appendChild(document.createTextNode('（将使用 update_book）'));
      } else {
        remoteEl.innerHTML = '';
        const ic = document.createElement('i');
        ic.className = 'bi bi-cloud-slash';
        remoteEl.appendChild(ic);
        remoteEl.appendChild(
          document.createTextNode(' 未有远程 ID，首次发布将 create_book。'),
        );
      }
    }
    listEl.innerHTML = '';
    (diff.parts || []).forEach((p) => {
      const li = document.createElement('li');
      li.className = `book-upload-part${p.dirty ? ' is-dirty' : ''}`;
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'book-upload-part-cb';
      cb.dataset.partId = p.partId || '';
      cb.setAttribute('aria-label', `选择 ${p.label}`);
      cb.checked = true;
      const badge = document.createElement('span');
      badge.className = p.dirty ? 'book-upload-badge book-upload-badge--dirty' : 'book-upload-badge book-upload-badge--ok';
      badge.textContent = p.dirty ? '待上传' : '已同步';
      const body = document.createElement('div');
      body.className = 'book-upload-part-body';
      const title = document.createElement('span');
      title.className = 'book-upload-part-title';
      title.textContent = p.label || '';
      const meta = document.createElement('span');
      meta.className = 'book-upload-part-meta';
      const t = p.mtimeMs ? new Date(p.mtimeMs).toLocaleString('zh-CN') : '—';
      const ts = p.syncedMtimeMs ? new Date(p.syncedMtimeMs).toLocaleString('zh-CN') : '—';
      meta.textContent = `本地修改：${t} · 上次上传记录：${ts}`;
      body.appendChild(title);
      body.appendChild(meta);
      const upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.className = 'book-upload-part-upload';
      upBtn.textContent = '上传';
      upBtn.dataset.partId = p.partId || '';
      upBtn.disabled = false;
      upBtn.title = p.dirty
        ? '上传到服务器（检测到有未同步的变更）'
        : '与上次上传记录一致；仍可点击以强制再传该项';
      upBtn.addEventListener('click', () => {
        void runComposePublishPipeline({ partId: p.partId });
      });
      li.appendChild(cb);
      li.appendChild(badge);
      li.appendChild(body);
      li.appendChild(upBtn);
      listEl.appendChild(li);
    });
  }

  /**
   * 与 `composeBookUploadDiff` 分项一致：默认只上传有变更的大纲/章节；勾选「全部重传」则全书。
   * @returns {Promise<{ forceFull: boolean, uploadMeta: boolean, uploadOutline: boolean, chapterIds: number[]|null }>}
   */
  async function buildBookSyncPlanForPublish(bookUploadGate, outlineStr) {
    const forceEl = document.getElementById('book-upload-force-full');
    const forceFull = Boolean(forceEl && forceEl.checked);
    const api = window.markwrite && window.markwrite.api;
    if (!composeState.remoteId) {
      return { forceFull: false, uploadMeta: true, uploadOutline: true, chapterIds: null };
    }
    if (forceFull) {
      return { forceFull: true, uploadMeta: true, uploadOutline: true, chapterIds: null };
    }
    /** 单行「上传」：按分项强制同步，不依赖是否标为待上传 */
    if (bookUploadGate && typeof bookUploadGate === 'object' && bookUploadGate.partId) {
      const pid = String(bookUploadGate.partId);
      if (pid === 'meta') {
        return { forceFull: false, uploadMeta: true, uploadOutline: false, chapterIds: [] };
      }
      if (pid === 'outline') {
        return { forceFull: false, uploadMeta: false, uploadOutline: true, chapterIds: [] };
      }
      if (pid.startsWith('chapter:')) {
        const n = Number(pid.slice(8));
        if (Number.isFinite(n)) {
          return { forceFull: false, uploadMeta: false, uploadOutline: false, chapterIds: [n] };
        }
      }
    }
    let diff = { ok: false, parts: [], isLegacyJson: false };
    if (api && composeState.draftFileId && typeof api.composeBookUploadDiff === 'function') {
      try {
        diff = await api.composeBookUploadDiff({ draftId: composeState.draftFileId });
      } catch (_) {}
    }
    if (!diff.ok || diff.isLegacyJson) {
      return { forceFull: false, uploadMeta: true, uploadOutline: true, chapterIds: null };
    }
    const parts = diff.parts || [];
    const metaDirty = Boolean(parts.find((x) => x.partId === 'meta' && x.dirty));
    const outlineDirty = Boolean(parts.find((x) => x.partId === 'outline' && x.dirty));
    const chaptersDirty = parts
      .filter((x) => x.kind === 'chapter' && x.dirty)
      .map((x) => x.chapterId)
      .filter((n) => n != null && Number.isFinite(Number(n)))
      .map((n) => Number(n));

    let uploadMeta = metaDirty;
    let uploadOutline = outlineDirty;
    let chapterIds = chaptersDirty.slice();

    if (bookUploadGate === 'all' || bookUploadGate == null) {
      return { forceFull: false, uploadMeta, uploadOutline, chapterIds };
    }
    if (bookUploadGate === 'selected') {
      const allowed = new Set();
      document.querySelectorAll('#book-upload-parts-list input.book-upload-part-cb:checked').forEach((b) => {
        if (b && b.dataset && b.dataset.partId) allowed.add(b.dataset.partId);
      });
      const outlineIds = collectBookChapterIdsFromOutlineStr(outlineStr || '');
      const chapterIdsSel = outlineIds.filter((cid) => allowed.has(`chapter:${cid}`));
      return {
        forceFull: false,
        uploadMeta: allowed.has('meta'),
        uploadOutline: allowed.has('outline'),
        chapterIds: chapterIdsSel,
      };
    }
    return { forceFull: false, uploadMeta, uploadOutline, chapterIds };
  }

  async function runComposePublishPipeline(bookUploadGate) {
    const api = window.markwrite && window.markwrite.api;
    if (syncConnState.status !== 'connected') {
      showAppAlert('当前服务器未连接，请先确认状态栏为“已连接”后再发布。');
      return { ok: false };
    }
    const needBookUploadGate =
      composeState.mode === 'book'
      && bookUploadGate != null
      && (
        bookUploadGate === 'all'
        || bookUploadGate === 'selected'
        || (typeof bookUploadGate === 'object' && bookUploadGate.partId)
      );
    if (needBookUploadGate) {
      if (!composeState.draftFileId) {
        showAppAlert('请先保存草稿');
        return { ok: false };
      }
      if (!api || typeof api.composeBookUploadDiff !== 'function') {
        showAppAlert('上传状态不可用（请使用桌面版）');
        return { ok: false };
      }
      const diff = await api.composeBookUploadDiff({ draftId: composeState.draftFileId });
      if (!diff.ok) {
        showAppAlert(diff.message || '读取同步状态失败');
        return { ok: false };
      }
      if (diff.isLegacyJson) {
        showAppAlert(diff.message || '请先将草稿保存为目录草稿');
        return { ok: false };
      }
      // 不按「是否标为待上传」拦截「全部上传」：本地可有 provisional remoteId 而 pending 全 false，
      // 或用户希望强制再传；具体是否 no-op 由主进程与 bookSyncPlan 决定。
      if (bookUploadGate === 'selected') {
        const boxes = document.querySelectorAll('#book-upload-parts-list input.book-upload-part-cb');
        const selected = [...boxes].filter((b) => b.checked);
        if (!selected.length) {
          showAppAlert('请勾选要上传的分项');
          return { ok: false };
        }
      }
    }
    const uiPub = readComposeDraftFromUi();
    let bookSyncPlan = null;
    if (composeState.mode === 'book') {
      bookSyncPlan = await buildBookSyncPlanForPublish(bookUploadGate, uiPub.outline || '');
    }
    const payload = {
      mode: composeState.mode || 'blog',
      ...uiPub,
      content: composeState.mode === 'book'
        ? stripMwChapterMarkers(uiPub.content)
        : uiPub.content,
    };
    if (!payload.title) {
      showAppAlert('请先填写标题');
      if (contentComposeMainTitle) contentComposeMainTitle.focus();
      return { ok: false };
    }
    if (payload.mode === 'book' && !String(payload.author || '').trim()) {
      showAppAlert('请先填写作者');
      if (contentComposeAuthor) contentComposeAuthor.focus();
      return { ok: false };
    }
    if (!api || typeof api.composeUploadAssetsAndFixPaths !== 'function') {
      showAppAlert('发布前图片上传不可用（请使用桌面版）');
      return { ok: false };
    }
    setComposeUploadProgress('正在保存本地草稿（建立索引）…');
    setBookUploadPanelProgress('正在保存本地草稿…');
    const draftFirst = await saveComposeDraftToDisk();
    if (!draftFirst.ok) {
      setComposeUploadProgress(`保存草稿失败：${draftFirst.error || '未知错误'}`, 'error');
      setBookUploadPanelProgress(`保存草稿失败：${draftFirst.error || '未知错误'}`, 'error');
      showAppAlert(draftFirst.error || '请先成功保存本地草稿后再发布');
      return { ok: false };
    }
    activeComposeUploadRequestId = `up-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setComposeUploadProgress('正在扫描并上传图片…');
    setBookUploadPanelProgress('正在扫描并上传图片…');
    const uploadPayload = {
      requestId: activeComposeUploadRequestId,
      cover: payload.cover || '',
      content: payload.content || '',
      assetMap: composeState.assetMap || {},
    };
    if (composeState.mode === 'book') {
      uploadPayload.chapterContents = buildBookChapterContentsPayload();
    }
    const fixed = await api.composeUploadAssetsAndFixPaths(uploadPayload);
    if (!fixed || !fixed.ok) {
      setComposeUploadProgress(`上传失败：${(fixed && fixed.message) || '未知错误'}`, 'error');
      setBookUploadPanelProgress(`上传失败：${(fixed && fixed.message) || '未知错误'}`, 'error');
      activeComposeUploadRequestId = null;
      return { ok: false };
    }
    activeComposeUploadRequestId = null;
    const next = {
      ...payload,
      cover: fixed.cover || payload.cover,
      content: fixed.content || payload.content,
      remoteId: composeState.remoteId || '',
      draftFileId: composeState.draftFileId || '',
      assetMap: composeState.assetMap || {},
    };
    if (composeState.mode === 'book') {
      next.chapterContents =
        fixed.chapterContents && typeof fixed.chapterContents === 'object'
          ? fixed.chapterContents
          : buildBookChapterContentsPayload();
      if (bookSyncPlan) next.bookSyncPlan = bookSyncPlan;
    }
    const uploadedCount = Object.keys(fixed.uploaded || {}).length;
    if (fixed.assetMap && typeof fixed.assetMap === 'object') {
      composeState.assetMap = fixed.assetMap;
    }
    setComposeUploadProgress(`图片处理完成：${uploadedCount} 张已替换（可复用），正在发布…`);
    setBookUploadPanelProgress(`图片处理完成，正在发布…`);
    if (typeof api.composeCreateContent !== 'function') {
      showAppAlert('创建内容接口不可用');
      return { ok: false };
    }
    const created = await api.composeCreateContent(next);
    if (!created || !created.ok) {
      setBookUploadPanelProgress((created && created.message) || '发布失败', 'error');
      showAppAlert((created && created.message) || '发布失败');
      return { ok: false };
    }
    if (created.id) composeState.remoteId = created.id;
    const postSave = await saveComposeDraftToDisk();
    markComposeBaselineFromCurrent();
    setComposeUploadProgress(`发布完成：${uploadedCount} 张图片已上传并替换。`);
    setBookUploadPanelProgress('');
    const msgFromServer = created.message && String(created.message).trim();
    let doneMsg = msgFromServer || `发布成功${created.id ? `（ID: ${created.id}）` : ''}`;
    if (!postSave.ok) {
      doneMsg += `；写回本地草稿失败：${postSave.error || ''}`;
    }
    showAppAlert(doneMsg);
    if (
      composeState.mode === 'book'
      && composeState.draftFileId
      && typeof api.composeBookUploadMarkSynced === 'function'
    ) {
      let partialSync = null;
      if (bookSyncPlan && bookSyncPlan.chapterIds != null) {
        partialSync = {
          uploadMeta: Boolean(bookSyncPlan.uploadMeta),
          uploadOutline: Boolean(bookSyncPlan.uploadOutline),
          chapterIds: Array.isArray(bookSyncPlan.chapterIds) ? bookSyncPlan.chapterIds.slice() : [],
        };
      }
      const mr = await api.composeBookUploadMarkSynced({
        draftId: composeState.draftFileId,
        ...(partialSync ? { partialSync } : {}),
      });
      if (!mr || !mr.ok) {
        console.warn('[book-upload-sync]', mr && mr.message);
      }
      await refreshBookUploadPanel();
    }
    return { ok: true, created };
  }

  function syncBookComposeView(view) {
    if (view !== 'info' && view !== 'editor' && view !== 'upload') return;
    bookComposeView = view;
    const pe = document.getElementById('pane-editor');
    const pf = document.getElementById('pane-files');
    if (pe) pe.setAttribute('data-book-view', view);
    if (pf) pf.setAttribute('data-book-view', view);
    const navInfo = document.getElementById('book-compose-nav-info');
    const navEd = document.getElementById('book-compose-nav-editor');
    const navUp = document.getElementById('book-compose-nav-upload');
    if (navInfo) navInfo.classList.toggle('is-active', view === 'info');
    if (navEd) navEd.classList.toggle('is-active', view === 'editor');
    if (navUp) navUp.classList.toggle('is-active', view === 'upload');
    if (contentComposeSubtitle && composeState.mode === 'book') {
      if (view === 'info') {
        contentComposeSubtitle.textContent =
          '填写封面、标题、作者与标签；左侧切换到「编辑正文」撰写全书内容。';
      } else if (view === 'editor') {
        contentComposeSubtitle.textContent = '撰写全书 Markdown 正文；左侧为大纲树。';
      } else {
        contentComposeSubtitle.textContent =
          '对比本地与上次上传；可勾选后「上传选中项」、「全部上传」，或各行「上传」。';
      }
    }
    if (view === 'upload') {
      void refreshBookUploadPanel();
    }
    if (view === 'info' && composeState.mode === 'book') {
      void hydrateComposeCoAuthorEmails();
    }
    if (editor && window.monaco) {
      setTimeout(() => {
        try {
          editor.layout();
        } catch (_) {}
      }, 100);
    }
  }

  function syncComposeModeUi(mode) {
    if (contentComposePanel) {
      contentComposePanel.setAttribute('data-compose-mode', mode === 'book' ? 'book' : 'blog');
      contentComposePanel.classList.toggle('compose-book-root', mode === 'book');
      contentComposePanel.classList.toggle('compose-blog-root', mode !== 'book');
    }
    syncLeftPaneForCompose(mode);
    if (contentComposeBookShell) {
      const showBook = mode === 'book';
      contentComposeBookShell.style.display = showBook ? 'block' : 'none';
      contentComposeBookShell.setAttribute('aria-hidden', showBook ? 'false' : 'true');
    }
    const headActions = document.getElementById('content-compose-head-actions');
    const blogActionsSlot = document.getElementById('compose-blog-actions-slot');
    const headTrailing = document.querySelector('.content-compose-head-trailing');
    if (mode === 'blog') {
      if (headActions && blogActionsSlot && headActions.parentElement !== blogActionsSlot) {
        blogActionsSlot.appendChild(headActions);
      }
    } else if (headActions && headTrailing && headActions.parentElement !== headTrailing) {
      headTrailing.insertBefore(headActions, contentComposeClose || null);
    }
    if (mode === 'blog') {
      clearBookComposeView();
      if (contentComposeTitle) contentComposeTitle.textContent = '创作新博客';
      if (contentComposeSubtitle) contentComposeSubtitle.textContent = '使用下方 Markdown 工具栏与 Monaco 编辑正文';
      if (contentComposeExtraWrap) contentComposeExtraWrap.style.display = 'grid';
      if (contentComposeExtra) contentComposeExtra.placeholder = '博客简介（可选）';
      setFilename('未发布-blog.md');
    } else {
      if (contentComposeTitle) contentComposeTitle.textContent = '创作新书籍';
      setFilename('未发布-book.md');
      syncBookComposeView('info');
    }
    updateBookOutlineSaveButtonState();
  }

  function applyLoadedComposeDraft(d) {
    if (!d || typeof d !== 'object') return;
    composeState.bookNewLocalSalt = null;
    composeState.draftFileId = d.id || null;
    composeState.remoteId = typeof d.remoteId === 'string' ? d.remoteId : '';
    composeState.assetMap = (d && typeof d.assetMap === 'object' && d.assetMap) ? d.assetMap : {};
    const t = d.tags;
    if (Array.isArray(t)) {
      composeState.tags = t.map((x) => normalizeComposeTag(String(x || ''))).filter(Boolean);
    } else if (typeof t === 'string') {
      composeState.tags = t
        .split(/[，,、]/)
        .map((s) => normalizeComposeTag(s))
        .filter(Boolean);
    } else {
      composeState.tags = [];
    }
    renderComposeTags();
    if (contentComposeMainTitle) contentComposeMainTitle.value = d.title || '';
    if (contentComposeCover) contentComposeCover.value = d.cover || '';
    renderComposeCoverPreview(d.cover || '');
    if (contentComposeExtra) {
      contentComposeExtra.value = d.mode === 'book' ? '' : (typeof d.extra === 'string' ? d.extra : '');
    }
    if (d.mode === 'book') {
      if (contentComposeAuthor) contentComposeAuthor.value = typeof d.author === 'string' ? d.author : '';
      if (Array.isArray(d.coAuthors)) {
        composeState.coAuthors = d.coAuthors
          .filter((x) => x && typeof x === 'object' && typeof x.pubkey === 'string')
          .map((x) => ({
            email: typeof x.email === 'string' ? x.email : '',
            pubkey: String(x.pubkey).trim(),
          }));
      } else {
        composeState.coAuthors = [];
      }
    } else {
      if (contentComposeAuthor) contentComposeAuthor.value = '';
      composeState.coAuthors = [];
    }
    renderComposeCoAuthors();
    void hydrateComposeCoAuthorEmails();
    if (d.mode === 'book') {
      bookPendingSuppress++;
      try {
        const p = ensureBookOutlinePane();
        const B = window.BookOutlinePane;
        if (p && B && typeof B.parseOutlineString === 'function') {
          p.setOutline(B.parseOutlineString(d.outline));
        } else if (contentComposeOutline) {
          contentComposeOutline.value = typeof d.outline === 'string' ? d.outline : '';
        }
        const outlineStr = contentComposeOutline ? contentComposeOutline.value.trim() : '';
        const map = splitEditorIntoBookChapterMap(
          typeof d.content === 'string' ? d.content : '',
          outlineStr,
        );
        composeState.bookChapterContents = map;
        const ids = collectBookChapterIdsFromOutlineStr(outlineStr);
        const firstId = ids.length ? ids[0] : null;
        composeState.bookActiveChapterId = firstId;
        if (editor) {
          editor.setValue(firstId != null ? String(map[firstId] ?? '') : '');
        }
        if (p && firstId != null) p.setSelectedChapterId(firstId);
      } finally {
        bookPendingSuppress--;
      }
    } else {
      composeState.bookChapterContents = {};
      composeState.bookActiveChapterId = null;
      if (contentComposeOutline) {
        contentComposeOutline.value = typeof d.outline === 'string' ? d.outline : '';
      }
      if (editor) editor.setValue(typeof d.content === 'string' ? d.content : '');
    }
  }

  function enterContentCompose(mode) {
    confirmDiscardIfDirty(() => {
      void enterContentComposeImpl(mode);
    });
  }

  async function enterContentComposeImpl(mode) {
    if (!contentComposePanel || !editor) return;
    await loadComposeTemplate(mode);
    wireComposeModeEvents(mode);
    if (!composeState.mode) {
      composeState.draft = {
        filename: currentFilePath,
        value: editor.getValue(),
      };
    }
    composeState.mode = mode;
    composeState.draftFileId = null;
    composeState.remoteId = '';
    composeState.assetMap = {};
    composeState.coAuthors = [];
    renderComposeCoAuthors();
    toggleComposeCoAuthorInput(false);
    const coInp = document.getElementById('content-compose-coauthor-input');
    if (coInp) coInp.value = '';
    contentComposePanel.style.display = 'block';
    syncComposeModeUi(mode);
    if (contentComposeMainTitle) contentComposeMainTitle.value = '';
    composeState.tags = [];
    renderComposeTags();
    if (contentComposeCover) contentComposeCover.value = '';
    if (contentComposeExtra) contentComposeExtra.value = '';
    if (contentComposeAuthor) contentComposeAuthor.value = '';
    if (mode === 'book') {
      bookPendingSuppress++;
      try {
        composeState.bookNewLocalSalt = newBookSessionSalt();
        const p = ensureBookOutlinePane();
        const B = window.BookOutlinePane;
        if (p && B && typeof B.defaultOutline === 'function') {
          p.setOutline(B.defaultOutline());
        } else if (contentComposeOutline) contentComposeOutline.value = '';
        const outlineStr = contentComposeOutline ? contentComposeOutline.value.trim() : '';
        initEmptyBookChapterMapFromOutlineStr(outlineStr);
        const ids = collectBookChapterIdsFromOutlineStr(outlineStr);
        const firstId = ids.length ? ids[0] : null;
        composeState.bookActiveChapterId = firstId;
        if (editor) {
          editor.setValue(firstId != null ? String(composeState.bookChapterContents[firstId] ?? '') : '');
        }
        if (p && firstId != null) p.setSelectedChapterId(firstId);
      } finally {
        bookPendingSuppress--;
      }
    } else {
      composeState.bookNewLocalSalt = null;
      composeState.bookChapterContents = {};
      composeState.bookActiveChapterId = null;
      if (contentComposeOutline) contentComposeOutline.value = '';
      editor.setValue('');
    }
    renderComposeCoverPreview('');
    setComposeUploadProgress('');
    setComposeGenerateStatus('');
    if (paneEditor) paneEditor.dataset.composeOpen = '1';
    editor.focus();
    markComposeBaselineFromCurrent();
  }

  function exitContentCompose() {
    confirmDiscardIfDirty(() => {
      exitContentComposeImpl();
    });
  }

  function exitContentComposeImpl() {
    if (!contentComposePanel || !editor) return;
    contentComposePanel.style.display = 'none';
    if (paneEditor) delete paneEditor.dataset.composeOpen;
    const prev = composeState.draft;
    composeState.mode = null;
    composeState.draft = null;
    composeState.coAuthors = [];
    renderComposeCoAuthors();
    composeState.draftFileId = null;
    composeState.remoteId = '';
    composeState.assetMap = {};
    composeState.bookNewLocalSalt = null;
    composeState.bookChapterContents = {};
    composeState.bookActiveChapterId = null;
    activeComposeUploadRequestId = null;
    setComposeUploadProgress('');
    setComposeGenerateStatus('');
    if (prev) {
      setFilename(prev.filename || null);
      editor.setValue(prev.value || '');
    }
    syncLeftPaneForCompose(null);
    clearBookComposeView();
    markEditorBaselineFromCurrent();
  }

  async function openComposeDraftById(id) {
    const proceed = await confirmDiscardIfDirtyAsync();
    if (!proceed) return;
    const api = window.markwrite && window.markwrite.api;
    if (!api || typeof api.composeDraftsLoad !== 'function') {
      showAppAlert('草稿加载接口不可用');
      return;
    }
    const res = await api.composeDraftsLoad(id);
    if (!res || !res.ok || !res.draft) {
      showAppAlert((res && res.error) || '加载草稿失败');
      return;
    }
    const d = res.draft;
    const mode = d.mode === 'book' ? 'book' : 'blog';
    if (!composeState.mode) {
      if (!contentComposePanel || !editor) return;
      composeState.draft = {
        filename: currentFilePath,
        value: editor.getValue(),
      };
      composeState.mode = mode;
      contentComposePanel.style.display = 'block';
      if (paneEditor) paneEditor.dataset.composeOpen = '1';
    } else {
      composeState.mode = mode;
    }
    await loadComposeTemplate(mode);
    wireComposeModeEvents(mode);
    syncComposeModeUi(mode);
    applyLoadedComposeDraft(d);
    updateBookOutlineSaveButtonState();
    markComposeBaselineFromCurrent();
    editor.focus();
  }

  const composeDraftsOverlay = document.getElementById('compose-drafts-overlay');
  const composeDraftsTitleEl = document.querySelector('.compose-drafts-title');
  const composeDraftsListEl = document.getElementById('compose-drafts-list');
  const composeDraftsEmptyEl = document.getElementById('compose-drafts-empty');
  const composeDraftsCloseBtn = document.getElementById('compose-drafts-close');
  const composeDraftsFilterAllBtn = document.getElementById('compose-drafts-filter-all');
  const composeDraftsFilterBlogBtn = document.getElementById('compose-drafts-filter-blog');
  const composeDraftsFilterBookBtn = document.getElementById('compose-drafts-filter-book');
  const remoteBlogsOverlay = document.getElementById('remote-blogs-overlay');
  const remoteBlogsTitleEl = document.getElementById('remote-blogs-title');
  const remoteBlogsHintEl = document.getElementById('remote-blogs-hint');
  const remoteBlogsListEl = document.getElementById('remote-blogs-list');
  const remoteBlogsEmptyEl = document.getElementById('remote-blogs-empty');
  const remoteBlogsCloseBtn = document.getElementById('remote-blogs-close');
  const remoteBlogsPrevBtn = document.getElementById('remote-blogs-prev');
  const remoteBlogsNextBtn = document.getElementById('remote-blogs-next');
  const remoteBlogsRefreshBtn = document.getElementById('remote-blogs-refresh');
  const remoteBlogsPageEl = document.getElementById('remote-blogs-page');
  const remoteBooksOverlay = document.getElementById('remote-books-overlay');
  const remoteBooksTitleEl = document.getElementById('remote-books-title');
  const remoteBooksHintEl = document.getElementById('remote-books-hint');
  const remoteBooksListEl = document.getElementById('remote-books-list');
  const remoteBooksEmptyEl = document.getElementById('remote-books-empty');
  const remoteBooksCloseBtn = document.getElementById('remote-books-close');
  const remoteBooksPrevBtn = document.getElementById('remote-books-prev');
  const remoteBooksNextBtn = document.getElementById('remote-books-next');
  const remoteBooksRefreshBtn = document.getElementById('remote-books-refresh');
  const remoteBooksPageEl = document.getElementById('remote-books-page');
  let composeDraftsFilterMode = 'all';
  const remoteBlogsState = {
    scope: 'mine',
    page: 1,
    pageSize: 20,
    lastCount: 0,
    loading: false,
    serverId: '',
    serverName: '',
  };
  const remoteBooksState = {
    scope: 'mine',
    page: 1,
    pageSize: 20,
    lastCount: 0,
    loading: false,
    serverId: '',
    serverName: '',
  };

  function closeComposeDraftsModal() {
    if (composeDraftsOverlay) composeDraftsOverlay.style.display = 'none';
  }

  function formatDraftTime(ts) {
    const n = typeof ts === 'number' ? ts : 0;
    if (!n) return '';
    try {
      const ms = n > 1e12 ? n : (n * 1000);
      const d = new Date(ms);
      return d.toLocaleString();
    } catch (_) {
      return '';
    }
  }

  function normalizePubkeyHex(s) {
    const t = String(s || '').trim().toLowerCase();
    return t.startsWith('0x') ? t.slice(2) : t;
  }

  /** 与远程 id 绑定，用于同一篇内容重复导入时稳定落在同一草稿目录 */
  function hashStringToHex8(s) {
    const str = String(s || '');
    let h = 2166136261;
    for (let i = 0; i < str.length; i += 1) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  /** 本机「新建书籍」会话盐：与书名、公钥前 6 位共同决定首次落盘的草稿目录 id */
  function newBookSessionSalt() {
    return hashStringToHex8(`${Date.now()}-${Math.random()}-${typeof performance !== 'undefined' && performance.now ? performance.now() : 0}`);
  }

  /** 书名 / 博客标题，用于本地草稿目录名（不含路径非法字符） */
  function sanitizeTitleForDraftId(title, fallback) {
    let t = String(title || '').trim();
    t = t.replace(/[\/\\:*?"<>|\x00-\x1f]/g, ' ');
    t = t.replace(/\s+/g, ' ').trim();
    t = t.replace(/^\.+/, '');
    if (t.length > 48) t = t.slice(0, 48).trim();
    return t || fallback || 'untitled';
  }

  /**
   * 远程导入草稿的稳定 id：「标题-作者公钥前6位-远端id哈希」
   * 便于在文件树中辨认博客名/书名与来源用户。
   */
  function buildRemoteImportDraftId({ mode, title, remoteId, authorPubkeyHex }) {
    const rid = String(remoteId || '').trim();
    const hex = normalizePubkeyHex(authorPubkeyHex);
    let u6 = 'nouser';
    if (hex.length >= 6) u6 = hex.slice(0, 6);
    else if (hex.length > 0) u6 = `${hex}000000`.slice(0, 6);
    const fb = mode === 'book' ? 'book' : 'blog';
    const titlePart = sanitizeTitleForDraftId(title, fb);
    const uniq = hashStringToHex8(rid || `${titlePart}-${u6}`);
    return `${titlePart}-${u6}-${uniq}`;
  }

  /** 本地已有同 id 草稿时询问是否覆盖；resolve(true) 表示继续保存 */
  function confirmOverwriteIfLocalDraftExists(api, draftId) {
    return new Promise((resolve) => {
      if (!draftId || !api || typeof api.composeDraftsLoad !== 'function') {
        resolve(true);
        return;
      }
      api.composeDraftsLoad(draftId).then((res) => {
        if (res && res.ok && res.draft) {
          showAppConfirm(
            '本地已存在相同标识的草稿（书名/标题、用户公钥前 6 位与记录键一致）。继续保存将用当前内容覆盖原有草稿，是否覆盖？',
            (ok) => { resolve(ok); },
            { title: '草稿已存在', confirmText: '覆盖', cancelText: '取消', variant: 'warning' },
          );
        } else {
          resolve(true);
        }
      }).catch(() => resolve(true));
    });
  }

  function closeRemoteBlogsModal() {
    if (remoteBlogsOverlay) remoteBlogsOverlay.style.display = 'none';
  }

  function closeRemoteBooksModal() {
    if (remoteBooksOverlay) remoteBooksOverlay.style.display = 'none';
    const dp = document.getElementById('remote-books-download-panel');
    const dst = document.getElementById('remote-books-download-steps');
    if (dp) dp.style.display = 'none';
    if (dst) dst.innerHTML = '';
  }

  function renderRemoteBlogsRows(rows) {
    if (!remoteBlogsListEl) return;
    remoteBlogsListEl.innerHTML = '';
    const list = Array.isArray(rows) ? rows : [];
    if (remoteBlogsEmptyEl) remoteBlogsEmptyEl.style.display = list.length ? 'none' : 'block';
    list.forEach((row) => {
      const li = document.createElement('li');
      li.className = 'remote-blogs-item';
      const title = document.createElement('div');
      title.className = 'remote-blogs-item-title';
      title.textContent = (row && row.title && String(row.title).trim()) || '（无标题）';
      const meta = document.createElement('div');
      meta.className = 'remote-blogs-item-meta';
      const ts = formatDraftTime(Number(row && row.createdAt ? row.createdAt : 0));
      const user = (row && row.user) ? String(row.user).slice(0, 12) : '';
      meta.innerHTML = `<span>ID: ${(row && row.id) ? String(row.id).slice(0, 12) : '—'}</span><span>用户: ${user || '—'}</span><span>${ts || '—'}</span>`;
      li.appendChild(title);
      li.appendChild(meta);
      const summary = (row && row.summary && String(row.summary).trim()) || '';
      if (summary) {
        const p = document.createElement('div');
        p.className = 'remote-blogs-item-summary';
        p.textContent = summary;
        li.appendChild(p);
      }
      const actions = document.createElement('div');
      actions.className = 'remote-blogs-item-actions';
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'remote-blogs-save-btn';
      saveBtn.textContent = '存到本地草稿';
      saveBtn.addEventListener('click', async () => {
        const api = window.markwrite && window.markwrite.api;
        if (!api || typeof api.composeDraftsSave !== 'function') {
          showAppAlert('草稿保存接口不可用');
          return;
        }
        const rid = (row && row.id) ? String(row.id).trim() : '';
        const authorPk = (row && row.user) ? String(row.user).trim() : '';
        const stableId = rid
          ? buildRemoteImportDraftId({
            mode: 'blog',
            title: (row && row.title) ? String(row.title) : '',
            remoteId: rid,
            authorPubkeyHex: authorPk,
          })
          : '';
        const tags = Array.isArray(row && row.tags) ? row.tags.map((x) => String(x || '').trim()).filter(Boolean) : [];
        let remoteIdToSave = '';
        if (rid && typeof api.identityGet === 'function') {
          try {
            const idRes = await api.identityGet({ serverId: remoteBlogsState.serverId || undefined });
            const myHex = normalizePubkeyHex(idRes && idRes.pubkeyHex);
            const rowUserHex = normalizePubkeyHex(row && row.user);
            if (myHex && rowUserHex && myHex === rowUserHex) remoteIdToSave = rid;
          } catch (_) {}
        }
        if (stableId) {
          const go = await confirmOverwriteIfLocalDraftExists(api, stableId);
          if (!go) return;
        }
        const saveRes = await api.composeDraftsSave({
          id: stableId,
          mode: 'blog',
          title: (row && row.title) ? String(row.title) : '',
          tags,
          cover: (row && row.cover) ? String(row.cover) : '',
          extra: (row && (row.extra || row.summary)) ? String(row.extra || row.summary) : '',
          author: '',
          coAuthors: [],
          outline: '',
          content: (row && row.content) ? String(row.content) : '',
          remoteId: remoteIdToSave,
          assetMap: {},
        });
        if (saveRes && saveRes.ok) {
          showAppAlert('已保存到本地草稿箱');
        } else {
          showAppAlert((saveRes && saveRes.error) || '保存草稿失败');
        }
      });
      actions.appendChild(saveBtn);
      li.appendChild(actions);
      remoteBlogsListEl.appendChild(li);
    });
  }

  async function refreshRemoteBlogsList() {
    const api = window.markwrite && window.markwrite.api;
    if (!api || typeof api.remoteBlogsList !== 'function') {
      showAppAlert('远程博客接口不可用');
      return;
    }
    if (remoteBlogsState.loading) return;
    remoteBlogsState.loading = true;
    try {
      const offset = (remoteBlogsState.page - 1) * remoteBlogsState.pageSize;
      if (remoteBlogsPageEl) remoteBlogsPageEl.textContent = `第 ${remoteBlogsState.page} 页`;
      if (remoteBlogsHintEl) remoteBlogsHintEl.textContent = '正在加载远程博客...';
      const res = await api.remoteBlogsList({
        scope: remoteBlogsState.scope,
        offset,
        limit: remoteBlogsState.pageSize,
      });
      if (!res || !res.ok) {
        renderRemoteBlogsRows([]);
        if (remoteBlogsHintEl) remoteBlogsHintEl.textContent = `读取失败：${(res && res.message) || '未知错误'}`;
        return;
      }
      const rows = Array.isArray(res.rows) ? res.rows : [];
      remoteBlogsState.lastCount = rows.length;
      remoteBlogsState.serverId = (res && res.serverId) ? String(res.serverId) : '';
      remoteBlogsState.serverName = (res && res.serverName) ? String(res.serverName) : '';
      renderRemoteBlogsRows(rows);
      if (remoteBlogsHintEl) {
        const who = remoteBlogsState.scope === 'mine' ? '我的博客' : '全部博客';
        remoteBlogsHintEl.textContent = `${res.serverName || '当前服务器'} · ${who} · 已加载 ${rows.length} 条`;
      }
      if (remoteBlogsPrevBtn) remoteBlogsPrevBtn.disabled = remoteBlogsState.page <= 1;
      if (remoteBlogsNextBtn) remoteBlogsNextBtn.disabled = rows.length < remoteBlogsState.pageSize;
    } catch (e) {
      renderRemoteBlogsRows([]);
      if (remoteBlogsHintEl) remoteBlogsHintEl.textContent = `读取失败：${e && e.message ? e.message : String(e)}`;
    } finally {
      remoteBlogsState.loading = false;
    }
  }

  async function openRemoteBlogsModal(scope) {
    remoteBlogsState.scope = scope === 'all' ? 'all' : 'mine';
    remoteBlogsState.page = 1;
    if (remoteBlogsTitleEl) {
      remoteBlogsTitleEl.textContent = remoteBlogsState.scope === 'mine' ? '远程博客 · 我的' : '远程博客 · 全部';
    }
    if (!remoteBlogsOverlay) return;
    remoteBlogsOverlay.style.display = 'flex';
    await refreshRemoteBlogsList();
  }

  function renderRemoteBooksRows(rows) {
    if (!remoteBooksListEl) return;
    remoteBooksListEl.innerHTML = '';
    const list = Array.isArray(rows) ? rows : [];
    if (remoteBooksEmptyEl) remoteBooksEmptyEl.style.display = list.length ? 'none' : 'block';
    list.forEach((row) => {
      const li = document.createElement('li');
      li.className = 'remote-blogs-item';
      const title = document.createElement('div');
      title.className = 'remote-blogs-item-title';
      title.textContent = (row && row.title && String(row.title).trim()) || '（无标题）';
      const meta = document.createElement('div');
      meta.className = 'remote-blogs-item-meta';
      const ts = formatDraftTime(Number(row && row.createdAt ? row.createdAt : 0));
      const user = (row && row.user) ? String(row.user).slice(0, 12) : '';
      const author = (row && row.author && String(row.author).trim()) ? String(row.author).slice(0, 24) : '—';
      const coCount = Array.isArray(row && row.coAuthorPubkeys) ? row.coAuthorPubkeys.length : 0;
      const coHint = coCount > 0 ? `<span>联合作者: ${coCount} 人</span>` : '';
      meta.innerHTML = `<span>ID: ${(row && row.id) ? String(row.id).slice(0, 12) : '—'}</span><span>作者: ${author}</span>${coHint}<span>用户: ${user || '—'}</span><span>${ts || '—'}</span>`;
      li.appendChild(title);
      li.appendChild(meta);
      const summary = (row && row.summary && String(row.summary).trim()) || '';
      if (summary) {
        const p = document.createElement('div');
        p.className = 'remote-blogs-item-summary';
        p.textContent = summary;
        li.appendChild(p);
      }
      const actions = document.createElement('div');
      actions.className = 'remote-blogs-item-actions';
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'remote-blogs-save-btn';
      saveBtn.textContent = '存到本地草稿';
      saveBtn.addEventListener('click', async () => {
        const api = window.markwrite && window.markwrite.api;
        if (!api || typeof api.remoteBooksDownloadBook !== 'function') {
          showAppAlert('完整下载书籍需要桌面版（remoteBooks:downloadBook）');
          return;
        }
        const rid = (row && row.id) ? String(row.id).trim() : '';
        const authorPk = (row && row.user) ? String(row.user).trim() : '';
        const stableId = rid
          ? buildRemoteImportDraftId({
            mode: 'book',
            title: (row && row.title) ? String(row.title) : '',
            remoteId: rid,
            authorPubkeyHex: authorPk,
          })
          : '';
        if (!rid || !authorPk) {
          showAppAlert('缺少书籍 ID 或作者公钥，无法下载');
          return;
        }
        if (stableId) {
          const go = await confirmOverwriteIfLocalDraftExists(api, stableId);
          if (!go) return;
        }
        const panel = document.getElementById('remote-books-download-panel');
        const ul = document.getElementById('remote-books-download-steps');
        if (panel) panel.style.display = 'block';
        if (ul) ul.innerHTML = '';
        const scrollRemoteBookDownloadPanelToBottom = () => {
          if (!panel) return;
          requestAnimationFrame(() => {
            panel.scrollTop = panel.scrollHeight;
          });
        };
        const onProg = (evt) => {
          if (!ul || !evt) return;
          const li = document.createElement('li');
          li.className = `remote-books-download-step${evt.status === 'loading' ? ' is-loading' : ''}`;
          li.textContent = evt.label || '';
          ul.appendChild(li);
          scrollRemoteBookDownloadPanelToBottom();
        };
        if (api.onRemoteBooksDownloadProgress) api.onRemoteBooksDownloadProgress(onProg);
        saveBtn.disabled = true;
        try {
          const res = await api.remoteBooksDownloadBook({
            bookId: rid,
            authorPubkey: authorPk,
            stableId,
            row: {
              title: row.title,
              author: row.author,
              cover: row.cover,
              coverImgurl: row.coverImgurl,
              tags: row.tags,
              summary: row.summary,
              extra: row.extra,
              outline: row.outline,
              content: row.content,
              coAuthorPubkeys: row.coAuthorPubkeys,
              user: row.user,
            },
          });
          scrollRemoteBookDownloadPanelToBottom();
          if (res && res.ok) {
            showAppAlert('已保存到本地草稿箱');
          } else {
            showAppAlert((res && res.message) || (res && res.error) || '下载或保存失败');
          }
        } catch (e) {
          showAppAlert(`下载失败：${e && e.message ? e.message : String(e)}`);
        } finally {
          scrollRemoteBookDownloadPanelToBottom();
          if (api.onRemoteBooksDownloadProgress) api.onRemoteBooksDownloadProgress(null);
          saveBtn.disabled = false;
        }
      });
      actions.appendChild(saveBtn);
      li.appendChild(actions);
      remoteBooksListEl.appendChild(li);
    });
  }

  async function refreshRemoteBooksList() {
    const api = window.markwrite && window.markwrite.api;
    if (!api || typeof api.remoteBooksList !== 'function') {
      showAppAlert('远程书籍接口不可用');
      return;
    }
    if (remoteBooksState.loading) return;
    remoteBooksState.loading = true;
    try {
      const offset = (remoteBooksState.page - 1) * remoteBooksState.pageSize;
      if (remoteBooksPageEl) remoteBooksPageEl.textContent = `第 ${remoteBooksState.page} 页`;
      if (remoteBooksHintEl) remoteBooksHintEl.textContent = '正在加载远程书籍（get_books）…';
      const res = await api.remoteBooksList({
        scope: remoteBooksState.scope,
        offset,
        limit: remoteBooksState.pageSize,
      });
      if (!res || !res.ok) {
        renderRemoteBooksRows([]);
        if (remoteBooksHintEl) remoteBooksHintEl.textContent = `读取失败：${(res && res.message) || '未知错误'}`;
        return;
      }
      const rows = Array.isArray(res.rows) ? res.rows : [];
      remoteBooksState.lastCount = rows.length;
      remoteBooksState.serverId = (res && res.serverId) ? String(res.serverId) : '';
      remoteBooksState.serverName = (res && res.serverName) ? String(res.serverName) : '';
      renderRemoteBooksRows(rows);
      if (remoteBooksHintEl) {
        const who = remoteBooksState.scope === 'mine' ? '我的书籍' : '全部书籍';
        remoteBooksHintEl.textContent = `${res.serverName || '当前服务器'} · ${who} · 已加载 ${rows.length} 条`;
      }
      if (remoteBooksPrevBtn) remoteBooksPrevBtn.disabled = remoteBooksState.page <= 1;
      if (remoteBooksNextBtn) remoteBooksNextBtn.disabled = rows.length < remoteBooksState.pageSize;
    } catch (e) {
      renderRemoteBooksRows([]);
      if (remoteBooksHintEl) remoteBooksHintEl.textContent = `读取失败：${e && e.message ? e.message : String(e)}`;
    } finally {
      remoteBooksState.loading = false;
    }
  }

  async function openRemoteBooksModal(scope) {
    remoteBooksState.scope = scope === 'all' ? 'all' : 'mine';
    remoteBooksState.page = 1;
    if (remoteBooksTitleEl) {
      remoteBooksTitleEl.textContent = remoteBooksState.scope === 'mine' ? '远程书籍 · 我的' : '远程书籍 · 全部';
    }
    if (!remoteBooksOverlay) return;
    remoteBooksOverlay.style.display = 'flex';
    await refreshRemoteBooksList();
  }

  async function refreshComposeDraftsList() {
    const api = window.markwrite && window.markwrite.api;
    if (!api || typeof api.composeDraftsList !== 'function' || !composeDraftsListEl) return;
    const res = await api.composeDraftsList();
    const draftsRaw = (res && res.ok && Array.isArray(res.drafts)) ? res.drafts : [];
    const drafts = composeDraftsFilterMode === 'all'
      ? draftsRaw
      : draftsRaw.filter((d) => (d && d.mode) === composeDraftsFilterMode);
    composeDraftsListEl.innerHTML = '';
    if (composeDraftsEmptyEl) {
      composeDraftsEmptyEl.style.display = drafts.length ? 'none' : 'block';
    }
    drafts.forEach((row) => {
      const li = document.createElement('li');
      li.className = 'compose-drafts-item';
      li.tabIndex = 0;
      li.title = '点击打开草稿';
      const isBook = row.mode === 'book';
      const modeLabel = isBook ? '书籍' : '博客';

      const badge = document.createElement('span');
      badge.className = `compose-drafts-item-badge ${isBook ? 'is-book' : 'is-blog'}`;
      badge.setAttribute('aria-hidden', 'true');
      const badgeIcon = document.createElement('i');
      badgeIcon.className = isBook ? 'bi bi-book' : 'bi bi-journal-text';
      badge.appendChild(badgeIcon);

      const body = document.createElement('div');
      body.className = 'compose-drafts-item-body';
      const title = document.createElement('div');
      title.className = 'compose-drafts-item-title';
      title.textContent = (row.title && String(row.title).trim()) || '（无标题）';
      const meta = document.createElement('div');
      meta.className = 'compose-drafts-item-meta';
      const timeStr = formatDraftTime(row.updatedAt);
      const hasRemote = !!(row && row.remoteId && String(row.remoteId).trim());
      const assetCount = Number(row && row.assetCount ? row.assetCount : 0);
      const publishTag = hasRemote
        ? '<span class="compose-drafts-item-flag is-linked"><i class="bi bi-cloud-check"></i>已上传（有ID）</span>'
        : '<span class="compose-drafts-item-flag is-unlinked"><i class="bi bi-cloud-slash"></i>未上传（无ID）</span>';
      const assetsTag = `<span class="compose-drafts-item-flag is-assets"><i class="bi bi-images"></i>图片已上传 ${assetCount}</span>`;
      meta.innerHTML = `<span class="compose-drafts-item-mode">${modeLabel}</span><span class="compose-drafts-item-sep">·</span><span class="compose-drafts-item-time"><i class="bi bi-clock" aria-hidden="true"></i>${timeStr || '—'}</span>${publishTag}${assetsTag}`;

      body.appendChild(title);
      body.appendChild(meta);

      const coverThumb = document.createElement('div');
      coverThumb.className = 'compose-drafts-item-cover';
      const coverSrc = resolveCoverImgSrc((row && row.cover) || '');
      if (coverSrc) {
        const img = document.createElement('img');
        img.src = coverSrc;
        img.alt = '';
        img.loading = 'lazy';
        img.onerror = () => {
          coverThumb.innerHTML = '<i class="bi bi-image"></i>';
        };
        coverThumb.appendChild(img);
      } else {
        coverThumb.innerHTML = '<i class="bi bi-image"></i>';
      }

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'compose-drafts-item-del';
      delBtn.title = '删除';
      delBtn.setAttribute('aria-label', '删除草稿');
      delBtn.innerHTML = '<i class="bi bi-trash"></i>';
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (typeof api.composeDraftsDelete !== 'function') return;
        const ok = window.confirm('确定删除这条草稿？');
        if (!ok) return;
        const r = await api.composeDraftsDelete(row.id);
        if (r && r.ok) {
          if (composeState.draftFileId === row.id) composeState.draftFileId = null;
          await refreshComposeDraftsList();
        } else {
          showAppAlert((r && r.error) || '删除失败');
        }
      });

      const openDraft = async () => {
        await openComposeDraftById(row.id);
        closeComposeDraftsModal();
      };
      li.addEventListener('click', async (e) => {
        if (e.target.closest('button')) return;
        await openDraft();
      });
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          void openDraft();
        }
      });

      li.appendChild(badge);
      li.appendChild(body);
      li.appendChild(coverThumb);
      li.appendChild(delBtn);
      composeDraftsListEl.appendChild(li);
    });
  }

  async function openComposeDraftsModal() {
    if (!composeDraftsOverlay) return;
    composeDraftsOverlay.style.display = 'flex';
    await refreshComposeDraftsList();
  }

  function setComposeDraftFilter(mode) {
    composeDraftsFilterMode = (mode === 'blog' || mode === 'book') ? mode : 'all';
    if (composeDraftsTitleEl) {
      composeDraftsTitleEl.textContent = composeDraftsFilterMode === 'blog'
        ? '博客草稿箱'
        : (composeDraftsFilterMode === 'book' ? '书籍草稿箱' : '草稿箱');
    }
    if (composeDraftsFilterAllBtn) composeDraftsFilterAllBtn.classList.toggle('is-active', composeDraftsFilterMode === 'all');
    if (composeDraftsFilterBlogBtn) composeDraftsFilterBlogBtn.classList.toggle('is-active', composeDraftsFilterMode === 'blog');
    if (composeDraftsFilterBookBtn) composeDraftsFilterBookBtn.classList.toggle('is-active', composeDraftsFilterMode === 'book');
    void refreshComposeDraftsList();
  }
  setComposeDraftFilter('all');

  if (window.markwrite?.api?.onComposeUploadProgress) {
    window.markwrite.api.onComposeUploadProgress((evt) => {
      if (!evt || typeof evt !== 'object') return;
      if (!activeComposeUploadRequestId || evt.requestId !== activeComposeUploadRequestId) return;
      const total = Number(evt.totalFiles || 0);
      const done = Number(evt.completedFiles || 0);
      const pct = Number(evt.overallPercent || 0);
      if (evt.phase === 'error') {
        setComposeUploadProgress(`上传失败：${evt.message || '未知错误'}`, 'error');
        return;
      }
      if (evt.phase === 'done') {
        setComposeUploadProgress(`图片上传完成：${done}/${total}（${pct}%）`);
        return;
      }
      if (evt.phase === 'start' || evt.phase === 'file_start' || evt.phase === 'file_progress' || evt.phase === 'file_done') {
        const msg = evt.message || `上传进度：${done}/${total}（${pct}%）`;
        setComposeUploadProgress(msg);
      }
    });
  }

  if (menuContentNewBlog) menuContentNewBlog.addEventListener('click', () => enterContentCompose('blog'));
  if (menuContentNewBook) menuContentNewBook.addEventListener('click', () => enterContentCompose('book'));
  const bookComposeNavInfo = document.getElementById('book-compose-nav-info');
  const bookComposeNavEditor = document.getElementById('book-compose-nav-editor');
  if (bookComposeNavInfo) {
    bookComposeNavInfo.addEventListener('click', (e) => {
      e.preventDefault();
      if (composeState.mode !== 'book') return;
      syncBookComposeView('info');
    });
  }
  if (bookComposeNavEditor) {
    bookComposeNavEditor.addEventListener('click', (e) => {
      e.preventDefault();
      if (composeState.mode !== 'book') return;
      syncBookComposeView('editor');
    });
  }
  if (menuContentDraftsBlog) menuContentDraftsBlog.addEventListener('click', () => {
    setComposeDraftFilter('blog');
    openComposeDraftsModal();
  });
  if (menuContentDraftsBook) menuContentDraftsBook.addEventListener('click', () => {
    setComposeDraftFilter('book');
    openComposeDraftsModal();
  });
  if (menuContentRemoteBlogMine) menuContentRemoteBlogMine.addEventListener('click', () => {
    openRemoteBlogsModal('mine');
  });
  if (menuContentRemoteBlogAll) menuContentRemoteBlogAll.addEventListener('click', () => {
    openRemoteBlogsModal('all');
  });
  if (menuContentRemoteBookMine) {
    menuContentRemoteBookMine.addEventListener('click', () => {
      void openRemoteBooksModal('mine');
    });
  }
  if (menuContentRemoteBookAll) {
    menuContentRemoteBookAll.addEventListener('click', () => {
      void openRemoteBooksModal('all');
    });
  }
  if (composeDraftsFilterAllBtn) composeDraftsFilterAllBtn.addEventListener('click', () => setComposeDraftFilter('all'));
  if (composeDraftsFilterBlogBtn) composeDraftsFilterBlogBtn.addEventListener('click', () => setComposeDraftFilter('blog'));
  if (composeDraftsFilterBookBtn) composeDraftsFilterBookBtn.addEventListener('click', () => setComposeDraftFilter('book'));
  if (composeDraftsCloseBtn) composeDraftsCloseBtn.addEventListener('click', () => closeComposeDraftsModal());
  if (composeDraftsOverlay) {
    composeDraftsOverlay.addEventListener('click', (e) => {
      if (e.target === composeDraftsOverlay) closeComposeDraftsModal();
    });
  }
  if (remoteBlogsCloseBtn) remoteBlogsCloseBtn.addEventListener('click', () => closeRemoteBlogsModal());
  if (remoteBlogsOverlay) {
    remoteBlogsOverlay.addEventListener('click', (e) => {
      if (e.target === remoteBlogsOverlay) closeRemoteBlogsModal();
    });
  }
  if (remoteBlogsPrevBtn) remoteBlogsPrevBtn.addEventListener('click', () => {
    if (remoteBlogsState.page <= 1) return;
    remoteBlogsState.page -= 1;
    void refreshRemoteBlogsList();
  });
  if (remoteBlogsNextBtn) remoteBlogsNextBtn.addEventListener('click', () => {
    if (remoteBlogsState.lastCount < remoteBlogsState.pageSize) return;
    remoteBlogsState.page += 1;
    void refreshRemoteBlogsList();
  });
  if (remoteBlogsRefreshBtn) remoteBlogsRefreshBtn.addEventListener('click', () => {
    void refreshRemoteBlogsList();
  });
  if (remoteBooksCloseBtn) remoteBooksCloseBtn.addEventListener('click', () => closeRemoteBooksModal());
  if (remoteBooksOverlay) {
    remoteBooksOverlay.addEventListener('click', (e) => {
      if (e.target === remoteBooksOverlay) closeRemoteBooksModal();
    });
  }
  if (remoteBooksPrevBtn) remoteBooksPrevBtn.addEventListener('click', () => {
    if (remoteBooksState.page <= 1) return;
    remoteBooksState.page -= 1;
    void refreshRemoteBooksList();
  });
  if (remoteBooksNextBtn) remoteBooksNextBtn.addEventListener('click', () => {
    if (remoteBooksState.lastCount < remoteBooksState.pageSize) return;
    remoteBooksState.page += 1;
    void refreshRemoteBooksList();
  });
  if (remoteBooksRefreshBtn) remoteBooksRefreshBtn.addEventListener('click', () => {
    void refreshRemoteBooksList();
  });
  if (contentComposeCoverPreview && contentComposeCoverFile && contentComposePanel) {
    contentComposeCoverPreview.addEventListener('click', () => {
      if (contentComposePanel.style.display === 'none') return;
      contentComposeCoverFile.click();
    });
    contentComposeCoverPreview.style.cursor = 'pointer';
  }
  if (contentComposeCoverUpload && contentComposeCoverFile) {
    contentComposeCoverUpload.addEventListener('click', () => contentComposeCoverFile.click());
    contentComposeCoverFile.addEventListener('change', async () => {
      const f = contentComposeCoverFile.files && contentComposeCoverFile.files[0];
      if (!f) return;
      try {
        if (!window.markwrite?.api?.uploadPastedImage) return;
        let blob;
        try {
          blob = await cropImageFileToSquareBlob(f);
        } catch (e) {
          showAppAlert(`图片处理失败：${e && e.message ? e.message : String(e)}`);
          return;
        }
        const buf = await blob.arrayBuffer();
        const res = await window.markwrite.api.uploadPastedImage({
          data: Array.from(new Uint8Array(buf)),
          ext: 'png',
          name: 'cover.png',
        });
        if (!res || !res.ok || !res.webPath) {
          showAppAlert((res && res.error) || '封面上传失败');
          return;
        }
        const localPath = normalizeLocalUploadsWebPath(res.webPath);
        if (contentComposeCover) contentComposeCover.value = localPath;
        renderComposeCoverPreview(localPath);
        if (composeState.mode === 'book' && composeState.draftFileId) {
          scheduleMarkBookUploadPending({ meta: true });
        }
      } finally {
        contentComposeCoverFile.value = '';
      }
    });
  }
  if (contentComposeCoverScreenshot) {
    contentComposeCoverScreenshot.addEventListener('click', async () => {
      if (!window.markwrite?.api?.uploadClipboardImage) return;
      const res = await window.markwrite.api.uploadClipboardImage();
      if (!res || !res.ok || !res.webPath) {
        showAppAlert((res && res.error) || '剪贴板没有可用图片');
        return;
      }
      const localPath = normalizeLocalUploadsWebPath(res.webPath);
      if (contentComposeCover) contentComposeCover.value = localPath;
      renderComposeCoverPreview(localPath);
      if (composeState.mode === 'book' && composeState.draftFileId) {
        scheduleMarkBookUploadPending({ meta: true });
      }
      showAppAlert('已设为封面。');
    });
  }
  if (contentComposeGenerateSummary) {
    contentComposeGenerateSummary.addEventListener('click', async () => {
      if (!window.markwrite?.api?.aiChat) return;
      contentComposeGenerateSummary.disabled = true;
      if (contentComposeGenerateTags) contentComposeGenerateTags.disabled = true;
      const title = (contentComposeMainTitle && contentComposeMainTitle.value.trim()) || '';
      const content = editor ? editor.getValue() : '';
      if (!title && !content.trim()) {
        showAppAlert('请先输入标题或正文，再生成简介。');
        contentComposeGenerateSummary.disabled = false;
        if (contentComposeGenerateTags) contentComposeGenerateTags.disabled = false;
        return;
      }
      try {
        setComposeGenerateStatus('生成中：简介…', 'loading');
        const prompt = `请根据以下内容生成 1 句中文简介（不超过40字，不加引号）。\n标题：${title}\n正文：\n${content.slice(0, 3000)}`;
        const result = await window.markwrite.api.aiChat(prompt, { scene: 'compose-summary' });
        const text = result && result.text ? String(result.text).trim() : '';
        if (!text) {
          setComposeGenerateStatus('');
          showAppAlert((result && result.error) || '简介生成失败，请重试');
          return;
        }
        if (contentComposeExtra) contentComposeExtra.value = text.replace(/\n+/g, ' ').trim();
        setComposeGenerateStatus('简介已更新', 'success');
        if (composeState.mode === 'book' && composeState.draftFileId) {
          scheduleMarkBookUploadPending({ meta: true });
        }
      } catch (e) {
        setComposeGenerateStatus('');
        showAppAlert(`简介生成失败：${e && e.message ? e.message : String(e)}`);
      } finally {
        contentComposeGenerateSummary.disabled = false;
        if (contentComposeGenerateTags) contentComposeGenerateTags.disabled = false;
      }
    });
  }
  if (contentComposeGenerateTags) {
    contentComposeGenerateTags.addEventListener('click', async () => {
      if (!window.markwrite?.api?.aiChat) return;
      contentComposeGenerateTags.disabled = true;
      if (contentComposeGenerateSummary) contentComposeGenerateSummary.disabled = true;
      const title = (contentComposeMainTitle && contentComposeMainTitle.value.trim()) || '';
      const content = editor ? editor.getValue() : '';
      if (!title && !content.trim()) {
        showAppAlert('请先输入标题或正文，再生成标签。');
        contentComposeGenerateTags.disabled = false;
        if (contentComposeGenerateSummary) contentComposeGenerateSummary.disabled = false;
        return;
      }
      try {
        setComposeGenerateStatus('生成中：标签…', 'loading');
        const prompt = `请基于以下博客/书籍内容生成恰好 3 个中文标签，使用逗号分隔，只输出标签本身，不要编号或解释。\n标题：${title}\n正文：\n${content.slice(0, 3000)}`;
        const result = await window.markwrite.api.aiChat(prompt, { scene: 'compose-tags' });
        const raw = result && result.text ? String(result.text) : '';
        if (!raw.trim()) {
          setComposeGenerateStatus('');
          showAppAlert((result && result.error) || '标签生成失败，请重试');
          return;
        }
        const tags = raw
          .replace(/\n/g, ',')
          .split(/[，,、]/)
          .map((s) => normalizeComposeTag(s))
          .filter(Boolean)
          .slice(0, 3);
        composeState.tags = tags;
        renderComposeTags();
        setComposeGenerateStatus('标签已更新', 'success');
        if (composeState.mode === 'book' && composeState.draftFileId) {
          scheduleMarkBookUploadPending({ meta: true });
        }
      } catch (e) {
        setComposeGenerateStatus('');
        showAppAlert(`标签生成失败：${e && e.message ? e.message : String(e)}`);
      } finally {
        contentComposeGenerateTags.disabled = false;
        if (contentComposeGenerateSummary) contentComposeGenerateSummary.disabled = false;
      }
    });
  }
  if (contentComposeTagAdd) {
    contentComposeTagAdd.addEventListener('click', () => addComposeTagFromInput());
  }
  if (contentComposeTagInput) {
    contentComposeTagInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addComposeTagFromInput();
      }
    });
  }
  const contentComposeCoauthorShow = document.getElementById('content-compose-coauthor-show');
  const contentComposeCoauthorAdd = document.getElementById('content-compose-coauthor-add');
  const contentComposeCoauthorCancel = document.getElementById('content-compose-coauthor-cancel');
  const contentComposeCoauthorInput = document.getElementById('content-compose-coauthor-input');
  if (contentComposeCoauthorShow) {
    contentComposeCoauthorShow.addEventListener('click', () => toggleComposeCoAuthorInput(true));
  }
  if (contentComposeCoauthorCancel) {
    contentComposeCoauthorCancel.addEventListener('click', () => {
      if (contentComposeCoauthorInput) contentComposeCoauthorInput.value = '';
      toggleComposeCoAuthorInput(false);
    });
  }
  if (contentComposeCoauthorAdd) {
    contentComposeCoauthorAdd.addEventListener('click', () => tryAddComposeCoAuthor());
  }
  if (contentComposeCoauthorInput) {
    contentComposeCoauthorInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        tryAddComposeCoAuthor();
      }
      if (e.key === 'Escape') {
        contentComposeCoauthorInput.value = '';
        toggleComposeCoAuthorInput(false);
      }
    });
  }
  async function handleComposeSaveDraftClick() {
    const r = await saveComposeDraftToDisk();
    if (r.ok) {
      markComposeBaselineFromCurrent();
      showAppAlert('草稿已保存');
      if (composeState.mode === 'book') void refreshBookUploadPanel();
    } else {
      showAppAlert(r.error || '保存草稿失败');
    }
  }

  async function handleBookChapterSaveDraftClick() {
    if (composeState.mode !== 'book') {
      await handleComposeSaveDraftClick();
      return;
    }
    if (!composeState.draftFileId) {
      showAppAlert('请先使用其它位置的「保存草稿」生成书籍目录后再仅保存本章');
      return;
    }
    const r = await saveComposeDraftToDisk({ bookSaveChapterOnly: true });
    if (r.ok) {
      markComposeBaselineFromCurrent();
      showAppAlert('本章内容已保存');
      const apiUp = window.markwrite && window.markwrite.api;
      if (
        apiUp
        && composeState.draftFileId
        && composeState.bookActiveChapterId != null
        && typeof apiUp.composeBookUploadMarkPending === 'function'
      ) {
        await apiUp.composeBookUploadMarkPending({
          draftId: composeState.draftFileId,
          chapterIds: [composeState.bookActiveChapterId],
        });
      }
      void refreshBookUploadPanel();
    } else {
      showAppAlert(r.error || '保存失败');
    }
  }
  function wireComposeModeEvents(mode) {
    if (contentComposeClose) {
      contentComposeClose.onclick = () => exitContentCompose();
    }
    if (contentComposeCoverPreview && contentComposeCoverFile && contentComposePanel) {
      contentComposeCoverPreview.onclick = () => {
        if (contentComposePanel.style.display === 'none') return;
        contentComposeCoverFile.click();
      };
      contentComposeCoverPreview.style.cursor = 'pointer';
    }
    if (contentComposeCoverUpload && contentComposeCoverFile) {
      contentComposeCoverUpload.onclick = () => contentComposeCoverFile.click();
      contentComposeCoverFile.onchange = async () => {
        const f = contentComposeCoverFile.files && contentComposeCoverFile.files[0];
        if (!f) return;
        try {
          if (!window.markwrite?.api?.uploadPastedImage) return;
          let blob;
          try {
            blob = await cropImageFileToSquareBlob(f);
          } catch (e) {
            showAppAlert(`图片处理失败：${e && e.message ? e.message : String(e)}`);
            return;
          }
          const buf = await blob.arrayBuffer();
          const res = await window.markwrite.api.uploadPastedImage({
            data: Array.from(new Uint8Array(buf)),
            ext: 'png',
            name: 'cover.png',
          });
          if (!res || !res.ok || !res.webPath) {
            showAppAlert((res && res.error) || '封面上传失败');
            return;
          }
          const localPath = normalizeLocalUploadsWebPath(res.webPath);
          if (contentComposeCover) contentComposeCover.value = localPath;
          renderComposeCoverPreview(localPath);
          if (composeState.mode === 'book' && composeState.draftFileId) {
            scheduleMarkBookUploadPending({ meta: true });
          }
        } finally {
          contentComposeCoverFile.value = '';
        }
      };
    }
    if (contentComposeCoverScreenshot) {
      contentComposeCoverScreenshot.onclick = async () => {
        if (!window.markwrite?.api?.uploadClipboardImage) return;
        const res = await window.markwrite.api.uploadClipboardImage();
        if (!res || !res.ok || !res.webPath) {
          showAppAlert((res && res.error) || '剪贴板没有可用图片');
          return;
        }
        const localPath = normalizeLocalUploadsWebPath(res.webPath);
        if (contentComposeCover) contentComposeCover.value = localPath;
        renderComposeCoverPreview(localPath);
        if (composeState.mode === 'book' && composeState.draftFileId) {
          scheduleMarkBookUploadPending({ meta: true });
        }
        showAppAlert('已设为封面。');
      };
    }
    if (contentComposeGenerateSummary) {
      contentComposeGenerateSummary.onclick = async () => {
        if (!window.markwrite?.api?.aiChat) return;
        contentComposeGenerateSummary.disabled = true;
        if (contentComposeGenerateTags) contentComposeGenerateTags.disabled = true;
        const title = (contentComposeMainTitle && contentComposeMainTitle.value.trim()) || '';
        const content = editor ? editor.getValue() : '';
        if (!title && !content.trim()) {
          showAppAlert('请先输入标题或正文，再生成简介。');
          contentComposeGenerateSummary.disabled = false;
          if (contentComposeGenerateTags) contentComposeGenerateTags.disabled = false;
          return;
        }
        try {
          setComposeGenerateStatus('生成中：简介…', 'loading');
          const prompt = `请根据以下内容生成 1 句中文简介（不超过40字，不加引号）。\n标题：${title}\n正文：\n${content.slice(0, 3000)}`;
          const result = await window.markwrite.api.aiChat(prompt, { scene: 'compose-summary' });
          const text = result && result.text ? String(result.text).trim() : '';
          if (!text) {
            setComposeGenerateStatus('');
            showAppAlert((result && result.error) || '简介生成失败，请重试');
            return;
          }
          if (contentComposeExtra) contentComposeExtra.value = text.replace(/\n+/g, ' ').trim();
          setComposeGenerateStatus('简介已更新', 'success');
          if (composeState.mode === 'book' && composeState.draftFileId) {
            scheduleMarkBookUploadPending({ meta: true });
          }
        } catch (e) {
          setComposeGenerateStatus('');
          showAppAlert(`简介生成失败：${e && e.message ? e.message : String(e)}`);
        } finally {
          contentComposeGenerateSummary.disabled = false;
          if (contentComposeGenerateTags) contentComposeGenerateTags.disabled = false;
        }
      };
    }
    if (contentComposeGenerateTags) {
      contentComposeGenerateTags.onclick = async () => {
        if (!window.markwrite?.api?.aiChat) return;
        contentComposeGenerateTags.disabled = true;
        if (contentComposeGenerateSummary) contentComposeGenerateSummary.disabled = true;
        const title = (contentComposeMainTitle && contentComposeMainTitle.value.trim()) || '';
        const content = editor ? editor.getValue() : '';
        if (!title && !content.trim()) {
          showAppAlert('请先输入标题或正文，再生成标签。');
          contentComposeGenerateTags.disabled = false;
          if (contentComposeGenerateSummary) contentComposeGenerateSummary.disabled = false;
          return;
        }
        try {
          setComposeGenerateStatus('生成中：标签…', 'loading');
          const prompt = `请基于以下博客/书籍内容生成恰好 3 个中文标签，使用逗号分隔，只输出标签本身，不要编号或解释。\n标题：${title}\n正文：\n${content.slice(0, 3000)}`;
          const result = await window.markwrite.api.aiChat(prompt, { scene: 'compose-tags' });
          const raw = result && result.text ? String(result.text) : '';
          if (!raw.trim()) {
            setComposeGenerateStatus('');
            showAppAlert((result && result.error) || '标签生成失败，请重试');
            return;
          }
          const tags = raw
            .replace(/\n/g, ',')
            .split(/[，,、]/)
            .map((s) => normalizeComposeTag(s))
            .filter(Boolean)
            .slice(0, 3);
          composeState.tags = tags;
          renderComposeTags();
          setComposeGenerateStatus('标签已更新', 'success');
          if (composeState.mode === 'book' && composeState.draftFileId) {
            scheduleMarkBookUploadPending({ meta: true });
          }
        } catch (e) {
          setComposeGenerateStatus('');
          showAppAlert(`标签生成失败：${e && e.message ? e.message : String(e)}`);
        } finally {
          contentComposeGenerateTags.disabled = false;
          if (contentComposeGenerateSummary) contentComposeGenerateSummary.disabled = false;
        }
      };
    }
    if (contentComposeTagAdd) contentComposeTagAdd.onclick = () => addComposeTagFromInput();
    if (contentComposeTagInput) {
      contentComposeTagInput.onkeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          addComposeTagFromInput();
        }
      };
    }
    const contentComposeCoauthorShow = document.getElementById('content-compose-coauthor-show');
    const contentComposeCoauthorAdd = document.getElementById('content-compose-coauthor-add');
    const contentComposeCoauthorCancel = document.getElementById('content-compose-coauthor-cancel');
    const contentComposeCoauthorInput = document.getElementById('content-compose-coauthor-input');
    if (contentComposeCoauthorShow) contentComposeCoauthorShow.onclick = () => toggleComposeCoAuthorInput(true);
    if (contentComposeCoauthorCancel) {
      contentComposeCoauthorCancel.onclick = () => {
        if (contentComposeCoauthorInput) contentComposeCoauthorInput.value = '';
        toggleComposeCoAuthorInput(false);
      };
    }
    if (contentComposeCoauthorAdd) contentComposeCoauthorAdd.onclick = () => tryAddComposeCoAuthor();
    if (contentComposeCoauthorInput) {
      contentComposeCoauthorInput.onkeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          tryAddComposeCoAuthor();
        }
        if (e.key === 'Escape') {
          contentComposeCoauthorInput.value = '';
          toggleComposeCoAuthorInput(false);
        }
      };
    }
    if (contentComposeSaveDraft) contentComposeSaveDraft.onclick = () => handleComposeSaveDraftClick();
    const bookComposeInfoSaveDraft = document.getElementById('book-compose-info-save-draft');
    if (bookComposeInfoSaveDraft) bookComposeInfoSaveDraft.onclick = () => handleComposeSaveDraftClick();
    const bookOutlineSaveDraft = document.getElementById('book-outline-save-draft');
    if (bookOutlineSaveDraft) bookOutlineSaveDraft.onclick = () => handleComposeSaveDraftClick();
    if (contentComposePublish) contentComposePublish.onclick = () => { void runComposePublishPipeline(null); };
    const bookUploadRefresh = document.getElementById('book-upload-refresh');
    const bookUploadAll = document.getElementById('book-upload-all');
    const bookUploadSelected = document.getElementById('book-upload-selected');
    const bookChapterSaveDraft = document.getElementById('book-chapter-save-draft');
    if (bookUploadRefresh) bookUploadRefresh.onclick = () => { void refreshBookUploadPanel(); };
    if (bookUploadAll) bookUploadAll.onclick = () => { void runComposePublishPipeline('all'); };
    if (bookUploadSelected) bookUploadSelected.onclick = () => { void runComposePublishPipeline('selected'); };
    if (bookChapterSaveDraft) bookChapterSaveDraft.onclick = () => { void handleBookChapterSaveDraftClick(); };
    if (mode !== 'book') toggleComposeCoAuthorInput(false);
  }
  /** 保存草稿：仅由 wireComposeModeEvents 绑定，避免与下方重复 addEventListener 导致双击两次弹框 */
  const bookChapterSwitchModal = document.getElementById('book-chapter-switch-modal');
  const bookChapterSwitchSave = document.getElementById('book-chapter-switch-save');
  const bookChapterSwitchDiscard = document.getElementById('book-chapter-switch-discard');
  const bookChapterSwitchCancel = document.getElementById('book-chapter-switch-cancel');
  if (bookChapterSwitchSave) bookChapterSwitchSave.addEventListener('click', () => closeBookChapterSwitchModal('save'));
  if (bookChapterSwitchDiscard) {
    bookChapterSwitchDiscard.addEventListener('click', () => closeBookChapterSwitchModal('discard'));
  }
  if (bookChapterSwitchCancel) bookChapterSwitchCancel.addEventListener('click', () => closeBookChapterSwitchModal('cancel'));
  if (bookChapterSwitchModal) {
    bookChapterSwitchModal.addEventListener('click', (e) => {
      if (e.target === bookChapterSwitchModal) closeBookChapterSwitchModal('cancel');
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (bookChapterSwitchModal.style.display !== 'flex') return;
      closeBookChapterSwitchModal('cancel');
    });
  }
  if (contentComposePublish) {
    contentComposePublish.addEventListener('click', () => {
      void runComposePublishPipeline(null);
    });
  }
  const bookComposeNavUpload = document.getElementById('book-compose-nav-upload');
  if (bookComposeNavUpload) {
    bookComposeNavUpload.addEventListener('click', (e) => {
      e.preventDefault();
      if (composeState.mode !== 'book') return;
      syncBookComposeView('upload');
    });
  }
  const bookUploadRefresh = document.getElementById('book-upload-refresh');
  const bookUploadAll = document.getElementById('book-upload-all');
  const bookUploadSelected = document.getElementById('book-upload-selected');
  if (bookUploadRefresh) {
    bookUploadRefresh.addEventListener('click', () => {
      void refreshBookUploadPanel();
    });
  }
  if (bookUploadAll) {
    bookUploadAll.addEventListener('click', () => {
      void runComposePublishPipeline('all');
    });
  }
  if (bookUploadSelected) {
    bookUploadSelected.addEventListener('click', () => {
      void runComposePublishPipeline('selected');
    });
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
        if (entry.path === currentFilePath && !isContentDirty()) return;
        if (isContentDirty()) {
          const proceed = await confirmDiscardIfDirtyAsync();
          if (!proceed) return;
        }
        if (composeState.mode) exitContentComposeImpl();
        const res = await window.markwrite.api.fileRead(entry.path);
        if (res && typeof res.content === 'string') {
          editor.setValue(res.content);
          setFilename(entry.path);
          markEditorBaselineFromCurrent();
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
              showAppAlert(`重命名失败：${res.message}`);
            }
          } catch (_) {
            showAppAlert('重命名失败');
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
      deleteItem.addEventListener('click', () => {
        doClose();
        const isDir = !!entry.isDir;
        const msg = isDir ? `确定删除目录及其所有内容？\n${entry.path}` : `确定删除文件？\n${entry.path}`;
        showAppConfirm(msg, (ok) => {
          if (!ok) return;
          void (async () => {
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
                showAppAlert(`删除失败：${res.message}`);
              }
            } catch (err) {
              showAppAlert('删除失败');
            }
          })();
        }, { title: '确认删除', confirmText: '删除', cancelText: '取消' });
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
    if (window.markwrite?.api?.syncGetConfig) {
      try {
        const cfg = await window.markwrite.api.syncGetConfig();
        if (cfg) {
          syncServers = Array.isArray(cfg.servers) ? cfg.servers.slice() : [];
          activeSyncServerId = cfg.activeId || (syncServers[0] && syncServers[0].id) || null;
        }
      } catch (_) {}
    }
    resumeSyncConnMonitor();
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
      theme: document.documentElement.getAttribute('data-theme') === 'light' ? 'vs' : 'vs-dark',
      automaticLayout: true,
      minimap: { enabled: true },
      fontSize: 14,
      lineNumbers: 'on',
      wordWrap: 'on',
    });
    setFilename(null);
    markEditorBaselineFromCurrent();
    setupMdToolbar(editor);
    setupMdPreview(editor);
    // 供 main 进程通过 executeJavaScript 读取当前编辑框内容（Agent 工具 markwrite_get_editor_content）
    window.__markwrite_getEditorContent = function () { return editor ? editor.getValue() : ''; };
    window.__markwrite_getEditorFilename = function () { return currentFilePath || '未命名'; };
    editor.onDidChangeModelContent(() => {
      if (bookPendingSuppress > 0) return;
      if (composeState.mode !== 'book' || composeState.bookActiveChapterId == null) return;
      if (!composeState.draftFileId) return;
      scheduleMarkBookUploadPending({ chapterIds: [composeState.bookActiveChapterId] });
    });
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
  if (syncConnReconnectBtn) {
    syncConnReconnectBtn.addEventListener('click', () => {
      void toggleSyncConnFromStatusBar();
    });
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
        if (r && r.loading) {
          setTimeout(() => { refreshModelsFromBackend(); }, 700);
        }
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
      const api = window.markwrite && window.markwrite.api;
      if (!api || typeof api.aiConfigGet !== 'function' || typeof api.aiConfigSave !== 'function') return;
      const opt = aiModelSelect.options[aiModelSelect.selectedIndex];
      const label = (opt && opt.textContent) ? String(opt.textContent).trim() : aiModelSelect.value;
      setAiStatus(false, '正在切换模型并重新连接…');
      api.aiConfigGet()
        .then((cfg) => {
          if (!cfg) cfg = {};
          if (!cfg.openagent) cfg.openagent = {};
          cfg.openagent = { ...cfg.openagent, model: preset };
          return api.aiConfigSave(cfg);
        })
        .then(() => (typeof api.aiHealth === 'function' ? api.aiHealth() : Promise.resolve(null)))
        .then((r) => {
          if (r && r.ok) {
            const name = r.backend === 'openagent' ? 'OpenAgent' : (r.backend || 'AI');
            const extra = r.selfStarted ? '（已自动启动）' : '';
            const ver = r.version ? ` ${r.version}` : '';
            setAiStatus(true, `${name} 已连接 · ${label}${extra}`);
            appendMessage('system', `已切换模型：${label}。${name} 已重新连接${extra}${ver}。`);
          } else {
            setAiStatus(false, (r && r.message) ? r.message : '连接检测失败');
            appendMessage('system', `模型已保存，但连接检测失败：${(r && r.message) ? r.message : '未知错误'}`);
          }
        })
        .catch((e) => {
          setAiStatus(false, '切换模型失败');
          appendMessage('system', `切换模型或重新连接时出错：${e && e.message ? e.message : String(e)}`);
        });
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
