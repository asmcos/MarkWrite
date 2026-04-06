/**
 * 书籍大纲：与 eventstoreUI editbook 一致的 JSON 结构（id / title / type / children）。
 * 同步到 #content-compose-outline 隐藏域，供草稿与发布使用。
 */
(function (global) {
  const DEFAULT_OUTLINE = [
    { id: 1, title: '前言', type: 'chapter' },
    {
      id: 2,
      title: '第一部分：基础知识',
      type: 'folder',
      expanded: true,
      children: [],
    },
  ];

  function deepClone(items) {
    return JSON.parse(JSON.stringify(items));
  }

  function defaultOutline() {
    return deepClone(DEFAULT_OUTLINE);
  }

  function computeNextId(items) {
    let max = 0;
    function walk(arr) {
      if (!Array.isArray(arr)) return;
      arr.forEach((item) => {
        if (item && typeof item.id === 'number' && item.id > max) max = item.id;
        if (item && item.children) walk(item.children);
      });
    }
    walk(items);
    return max + 1;
  }

  function findItemById(items, id) {
    for (const item of items) {
      if (item.id === id) return item;
      if (item.children) {
        const found = findItemById(item.children, id);
        if (found) return found;
      }
    }
    return null;
  }

  function findItemParentAndIndex(items, id, parent = null) {
    for (let i = 0; i < items.length; i++) {
      if (items[i].id === id) {
        return { parent: parent || items, index: i };
      }
      if (items[i].children) {
        const result = findItemParentAndIndex(items[i].children, id, items[i].children);
        if (result.index !== -1) return result;
      }
    }
    return { parent: null, index: -1 };
  }

  function validateOutline(parsed) {
    if (!Array.isArray(parsed)) throw new Error('大纲必须是数组格式');
    parsed.forEach((item) => {
      if (!item || typeof item !== 'object') throw new Error('大纲项无效');
      if (item.id == null || !item.title || !item.type) {
        throw new Error(`项目 "${item.title || '未知'}" 缺少必要字段 (id/title/type)`);
      }
      if (item.type !== 'chapter' && item.type !== 'folder') {
        throw new Error(`未知类型: ${item.type}`);
      }
      if (item.type === 'folder' && item.children != null && !Array.isArray(item.children)) {
        throw new Error(`文件夹 "${item.title}" 的 children 必须是数组`);
      }
      if (item.children) validateOutline(item.children);
    });
  }

  function parseOutlineString(s) {
    const raw = String(s || '').trim();
    if (!raw) return defaultOutline();
    try {
      const parsed = JSON.parse(raw);
      validateOutline(parsed);
      return parsed;
    } catch (_) {
      return defaultOutline();
    }
  }

  function handleDragEnd(outline, draggedItem, targetItem, position) {
    const updated = JSON.parse(JSON.stringify(outline));
    const { parent: draggedParent, index: draggedIndex } = findItemParentAndIndex(
      updated,
      draggedItem.id
    );
    const { parent: targetParent, index: targetIndex } = findItemParentAndIndex(
      updated,
      targetItem.id
    );
    if (!draggedParent || draggedIndex === -1 || !targetParent) return outline;

    const [removedItem] = draggedParent.splice(draggedIndex, 1);

    const ti = findItemById(updated, targetItem.id);
    if (position === 'inside' && ti && ti.type === 'folder') {
      const targetFolder = findItemById(updated, targetItem.id);
      if (targetFolder) {
        if (!targetFolder.children) targetFolder.children = [];
        targetFolder.children.push(removedItem);
        targetFolder.expanded = true;
      }
    } else {
      const insertIndex = position === 'before' ? targetIndex : targetIndex + 1;
      targetParent.splice(insertIndex, 0, removedItem);
    }
    return updated;
  }

  function collectExpandedFolderIds(items, set) {
    if (!Array.isArray(items)) return;
    items.forEach((item) => {
      if (item.type === 'folder' && item.expanded !== false) set.add(item.id);
      if (item.children && item.children.length) collectExpandedFolderIds(item.children, set);
    });
  }

  /** 拖拽中禁止 render()，否则会替换 DOM、拖放中断；仅改 class */
  function clearOutlineDragClasses(container) {
    if (!container || !container.querySelectorAll) return;
    container.querySelectorAll('.book-outline-row').forEach((r) => {
      r.classList.remove('is-dragging', 'drag-over', 'drag-before', 'drag-after', 'drag-inside');
    });
  }

  function applyOutlineDragClasses(container, draggedId, targetId, position) {
    clearOutlineDragClasses(container);
    if (draggedId != null) {
      const src = container.querySelector(`.book-outline-row[data-id="${draggedId}"]`);
      if (src) src.classList.add('is-dragging');
    }
    if (targetId != null && position) {
      const tgt = container.querySelector(`.book-outline-row[data-id="${targetId}"]`);
      if (tgt) {
        tgt.classList.add('drag-over');
        if (position === 'before') tgt.classList.add('drag-before');
        else if (position === 'after') tgt.classList.add('drag-after');
        else if (position === 'inside') tgt.classList.add('drag-inside');
      }
    }
  }

  function BookOutlinePane(opts) {
    const self = this;
    this.hidden = opts.hiddenTextarea;
    this.treeContainer = opts.treeContainer;
    this._items = defaultOutline();
    this._nextId = computeNextId(this._items);
    this._expanded = new Set();
    this._selectedId = null;
    this._dragged = null;
    this._dragOver = null;
    this._dragPos = null;
    this._openMenuId = null;
    this._suppressOutlineSync = false;
    this._suppressChapterSwitch = false;
    this.onOutlineSynced = typeof opts.onOutlineSynced === 'function' ? opts.onOutlineSynced : null;
    this.onBeforeChapterSelect = typeof opts.onBeforeChapterSelect === 'function' ? opts.onBeforeChapterSelect : null;

    this._modal = opts.modal;
    this._modalTa = opts.modalTextarea;
    this._modalErr = opts.modalError;
    this._renameModal = opts.renameModal;
    this._renameInput = opts.renameInput;
    this._renameConfirm = opts.renameConfirm;
    this._renameTargetId = null;
    if (opts.editJsonBtn) {
      opts.editJsonBtn.addEventListener('click', () => self.openJsonModal());
    }
    if (opts.addFolderBtn) {
      opts.addFolderBtn.addEventListener('click', () => self.addFolder());
    }
    if (opts.addChapterBtn) {
      opts.addChapterBtn.addEventListener('click', () => self.addChapter());
    }
    if (opts.modalApply) {
      opts.modalApply.addEventListener('click', () => self.applyJsonModal());
    }
    if (this._modal) {
      this._modal.querySelectorAll('.book-outline-json-dismiss').forEach((el) => {
        el.addEventListener('click', () => self.closeJsonModal());
      });
      this._modal.addEventListener('click', (e) => {
        if (e.target === this._modal) self.closeJsonModal();
      });
    }

    if (this._renameModal) {
      this._renameModal.querySelectorAll('.book-outline-rename-dismiss').forEach((el) => {
        el.addEventListener('click', () => self.closeRenameModal());
      });
      this._renameModal.addEventListener('click', (e) => {
        if (e.target === this._renameModal) self.closeRenameModal();
      });
    }
    if (this._renameConfirm) {
      this._renameConfirm.addEventListener('click', () => self.applyRenameModal());
    }
    if (this._renameInput) {
      this._renameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          self.applyRenameModal();
        }
      });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!self._renameModal || self._renameModal.style.display !== 'flex') return;
      self.closeRenameModal();
    });

    document.addEventListener('click', (e) => {
      if (self._openMenuId == null) return;
      if (e.target.closest && e.target.closest('.book-outline-item-actions')) return;
      self._openMenuId = null;
      self.render();
    });

    this.treeContainer.addEventListener('dragstart', (e) => {
      const row = e.target.closest('.book-outline-row');
      if (!row) return;
      const id = Number(row.dataset.id);
      const item = findItemById(self._items, id);
      if (!item) return;
      self._dragged = item;
      self._dragOver = null;
      self._dragPos = null;
      e.dataTransfer.setData('text/plain', String(id));
      try {
        e.dataTransfer.effectAllowed = 'move';
      } catch (_) {}
      row.classList.add('is-dragging');
    });
    this.treeContainer.addEventListener('dragend', () => {
      clearOutlineDragClasses(self.treeContainer);
      self._dragged = null;
      self._dragOver = null;
      self._dragPos = null;
      self.render();
    });
    this.treeContainer.addEventListener('dragenter', (e) => {
      const row = e.target.closest('.book-outline-row');
      if (row && self._dragged) e.preventDefault();
    });
    this.treeContainer.addEventListener('dragover', (e) => {
      if (!self._dragged) return;
      e.preventDefault();
      try {
        e.dataTransfer.dropEffect = 'move';
      } catch (_) {}
      const row = e.target.closest('.book-outline-row');
      if (!row) {
        self._dragOver = null;
        self._dragPos = null;
        applyOutlineDragClasses(self.treeContainer, self._dragged.id, null, null);
        return;
      }
      const id = Number(row.dataset.id);
      const item = findItemById(self._items, id);
      if (!item) return;
      if (self._dragged.id === item.id) {
        self._dragOver = null;
        self._dragPos = null;
        applyOutlineDragClasses(self.treeContainer, self._dragged.id, null, null);
        return;
      }
      const rect = row.getBoundingClientRect();
      const offset = e.clientY - rect.top;
      const h = rect.height || 1;
      let position = 'after';
      if (item.type === 'folder') {
        if (offset > h * 0.7) position = 'inside';
        else if (offset < h * 0.3) position = 'before';
        else position = 'after';
      } else {
        position = offset < h / 2 ? 'before' : 'after';
      }
      self._dragOver = item;
      self._dragPos = position;
      applyOutlineDragClasses(self.treeContainer, self._dragged.id, item.id, position);
    });
    this.treeContainer.addEventListener('drop', (e) => {
      const row = e.target.closest('.book-outline-row');
      if (!row || !self._dragged) return;
      e.preventDefault();
      const id = Number(row.dataset.id);
      const targetItem = findItemById(self._items, id);
      if (!targetItem || self._dragOver == null || self._dragPos == null) return;
      const moved = self._dragged;
      const beforeIds = JSON.stringify(self._items);
      self._items = handleDragEnd(self._items, moved, targetItem, self._dragPos);
      self._dragged = null;
      self._dragOver = null;
      self._dragPos = null;
      self.syncHidden();
      self.render();
    });

    this.syncHidden();
    this.render();
  }

  BookOutlinePane.prototype.syncHidden = function syncHidden() {
    if (this.hidden) {
      this.hidden.value = JSON.stringify(this._items, null, 2);
    }
    if (this.onOutlineSynced && !this._suppressOutlineSync) {
      try {
        this.onOutlineSynced(this._items);
      } catch (_) {}
    }
  };

  BookOutlinePane.prototype.setSelectedChapterId = function setSelectedChapterId(id) {
    this._suppressChapterSwitch = true;
    this._suppressOutlineSync = true;
    this._selectedId = id;
    this.syncHidden();
    this.render();
    this._suppressOutlineSync = false;
    this._suppressChapterSwitch = false;
  };

  BookOutlinePane.prototype.setOutline = function setOutline(items) {
    this._items = Array.isArray(items) && items.length ? deepClone(items) : defaultOutline();
    this._nextId = computeNextId(this._items);
    this._expanded = new Set();
    collectExpandedFolderIds(this._items, this._expanded);
    this.syncHidden();
    this.render();
  };

  BookOutlinePane.prototype.openJsonModal = function openJsonModal() {
    if (!this._modal || !this._modalTa) return;
    if (this._modalErr) this._modalErr.textContent = '';
    this._modalTa.value = JSON.stringify(this._items, null, 2);
    this._modal.style.display = 'flex';
    this._modal.setAttribute('aria-hidden', 'false');
  };

  BookOutlinePane.prototype.closeJsonModal = function closeJsonModal() {
    if (this._modal) {
      this._modal.style.display = 'none';
      this._modal.setAttribute('aria-hidden', 'true');
    }
  };

  BookOutlinePane.prototype.applyJsonModal = function applyJsonModal() {
    if (!this._modalTa) return;
    if (this._modalErr) this._modalErr.textContent = '';
    try {
      const parsed = JSON.parse(this._modalTa.value);
      validateOutline(parsed);
      this._items = parsed;
      this._nextId = computeNextId(this._items);
      this.syncHidden();
      this.render();
      this.closeJsonModal();
    } catch (err) {
      if (this._modalErr) this._modalErr.textContent = '格式错误: ' + (err && err.message ? err.message : err);
    }
  };

  BookOutlinePane.prototype.addFolder = function addFolder() {
    const folder = {
      id: this._nextId++,
      title: '新建目录',
      type: 'folder',
      expanded: true,
      children: [],
    };
    this._expanded.add(folder.id);
    this._items = [...this._items, folder];
    this.syncHidden();
    this.render();
  };

  BookOutlinePane.prototype.addChapter = function addChapter() {
    const chapter = {
      id: this._nextId++,
      title: '新建章节',
      type: 'chapter',
    };
    this._items = [...this._items, chapter];
    this.syncHidden();
    this.render();
  };

  BookOutlinePane.prototype.closeRenameModal = function closeRenameModal() {
    if (this._renameModal) {
      this._renameModal.style.display = 'none';
      this._renameModal.setAttribute('aria-hidden', 'true');
    }
    this._renameTargetId = null;
  };

  BookOutlinePane.prototype.applyRenameModal = function applyRenameModal() {
    const id = this._renameTargetId;
    if (id == null) return;
    const v = this._renameInput && String(this._renameInput.value || '').trim();
    if (!v) {
      if (this._renameInput) this._renameInput.focus();
      return;
    }
    const el = findItemById(this._items, id);
    if (el) el.title = v;
    this.syncHidden();
    this.render();
    this.closeRenameModal();
  };

  BookOutlinePane.prototype.renameItem = function renameItem(item) {
    if (!this._renameModal || !this._renameInput) {
      const next = prompt('请输入新名称', item.title);
      if (next == null || !String(next).trim()) return;
      const el = findItemById(this._items, item.id);
      if (el) el.title = String(next).trim();
      this.syncHidden();
      this.render();
      return;
    }
    this._renameTargetId = item.id;
    const titleEl = document.getElementById('book-outline-rename-modal-title');
    const labelEl = document.getElementById('book-outline-rename-label');
    if (titleEl) titleEl.textContent = item.type === 'folder' ? '重命名目录' : '重命名章节';
    if (labelEl) labelEl.textContent = item.type === 'folder' ? '目录名称' : '章节名称';
    this._renameInput.value = item.title || '';
    this._renameModal.style.display = 'flex';
    this._renameModal.setAttribute('aria-hidden', 'false');
    const input = this._renameInput;
    setTimeout(() => {
      input.focus();
      try {
        input.select();
      } catch (_) {}
    }, 50);
  };

  BookOutlinePane.prototype.deleteItem = function deleteItem(item) {
    if (!confirm(`确定要删除「${item.title}」吗？`)) return;
    const updated = JSON.parse(JSON.stringify(this._items));
    const { parent, index } = findItemParentAndIndex(updated, item.id);
    if (parent && index !== -1) {
      parent.splice(index, 1);
      this._items = updated;
      if (this._selectedId === item.id) this._selectedId = null;
      this.syncHidden();
      this.render();
    }
  };

  BookOutlinePane.prototype.toggleFolder = function toggleFolder(id) {
    if (this._expanded.has(id)) this._expanded.delete(id);
    else this._expanded.add(id);
    this.render();
  };

  BookOutlinePane.prototype.selectItem = function selectItem(item) {
    if (item.type === 'folder') {
      this.toggleFolder(item.id);
      this.render();
      return;
    }
    if (item.type !== 'chapter') return;
    const prev = this._selectedId;
    const next = item.id;
    const self = this;
    const apply = () => {
      self._selectedId = next;
      self.syncHidden();
      self.render();
    };
    const rollback = () => {
      self.render();
    };
    if (this._suppressChapterSwitch) {
      apply();
      return;
    }
    if (this.onBeforeChapterSelect) {
      const ret = this.onBeforeChapterSelect(next, prev);
      if (ret && typeof ret.then === 'function') {
        ret.then((ok) => {
          if (ok) apply();
          else rollback();
        }).catch(() => rollback());
        return;
      }
      if (ret === false) {
        rollback();
        return;
      }
    }
    apply();
  };

  BookOutlinePane.prototype.render = function render() {
    const root = this.treeContainer;
    if (!root) return;
    root.innerHTML = '';
    const frag = document.createElement('div');
    frag.className = 'book-outline-tree-inner';
    this._renderLevel(this._items, 0, frag);
    root.appendChild(frag);
  };

  BookOutlinePane.prototype._renderLevel = function _renderLevel(items, depth, parentEl) {
    const self = this;
    items.forEach((item) => {
      const wrap = document.createElement('div');
      wrap.className = 'book-outline-node';
      wrap.style.paddingLeft = depth ? `${10 + depth * 14}px` : '0';

      const row = document.createElement('div');
      row.className = 'book-outline-row';
      row.dataset.id = String(item.id);
      row.draggable = true;
      if (self._selectedId === item.id) row.classList.add('is-selected');

      const main = document.createElement('div');
      main.className = 'book-outline-row-main';
      main.addEventListener('click', (e) => {
        if (e.target.closest('.book-outline-chevron')) return;
        if (e.target.closest('.book-outline-item-actions')) return;
        self.selectItem(item);
      });

      if (item.type === 'folder') {
        const chev = document.createElement('button');
        chev.type = 'button';
        chev.setAttribute('draggable', 'false');
        chev.className = 'book-outline-chevron';
        chev.innerHTML = '<i class="bi bi-chevron-right"></i>';
        if (self._expanded.has(item.id)) {
          chev.classList.add('is-open');
          chev.querySelector('i').className = 'bi bi-chevron-down';
        }
        chev.addEventListener('click', (e) => {
          e.stopPropagation();
          self.toggleFolder(item.id);
        });
        main.appendChild(chev);
        const ic = document.createElement('span');
        ic.className = 'book-outline-type-ic';
        ic.innerHTML = '<i class="bi bi-folder"></i>';
        main.appendChild(ic);
      } else {
        const sp = document.createElement('span');
        sp.className = 'book-outline-chevron book-outline-chevron--spacer';
        main.appendChild(sp);
        const ic = document.createElement('span');
        ic.className = 'book-outline-type-ic';
        ic.innerHTML = '<i class="bi bi-file-text"></i>';
        main.appendChild(ic);
      }

      const title = document.createElement('span');
      title.className = 'book-outline-title';
      const fullTitle = item.title != null ? String(item.title) : '';
      title.textContent = fullTitle;
      title.setAttribute('title', fullTitle);
      main.appendChild(title);

      const actions = document.createElement('div');
      actions.className = 'book-outline-item-actions';
      const menuBtn = document.createElement('button');
      menuBtn.type = 'button';
      menuBtn.className = 'book-outline-dots';
      menuBtn.title = '操作';
      menuBtn.innerHTML = '<i class="bi bi-three-dots-vertical"></i>';
      menuBtn.setAttribute('draggable', 'false');
      menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        self._openMenuId = self._openMenuId === item.id ? null : item.id;
        self.render();
      });
      actions.appendChild(menuBtn);

      const menu = document.createElement('div');
      menu.className = 'book-outline-action-menu';
      if (self._openMenuId === item.id) menu.classList.add('is-open');

      const renameBtn = document.createElement('button');
      renameBtn.type = 'button';
      renameBtn.textContent = '重命名';
      renameBtn.setAttribute('draggable', 'false');
      renameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        self._openMenuId = null;
        self.renameItem(item);
      });
      menu.appendChild(renameBtn);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.textContent = '删除';
      delBtn.setAttribute('draggable', 'false');
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        self._openMenuId = null;
        self.deleteItem(item);
      });
      menu.appendChild(delBtn);

      actions.appendChild(menu);
      row.appendChild(main);
      row.appendChild(actions);
      wrap.appendChild(row);

      if (item.type === 'folder' && item.children && item.children.length && self._expanded.has(item.id)) {
        self._renderLevel(item.children, depth + 1, wrap);
      } else if (item.type === 'folder' && item.children && item.children.length && !self._expanded.has(item.id)) {
        /* collapsed */
      } else if (item.type === 'folder' && (!item.children || !item.children.length)) {
        /* empty folder */
      }

      parentEl.appendChild(wrap);
    });
  };

  global.BookOutlinePane = {
    create(opts) {
      return new BookOutlinePane(opts);
    },
    parseOutlineString,
    defaultOutline,
    validateOutline,
  };
})(typeof window !== 'undefined' ? window : globalThis);
