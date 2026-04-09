/**
 * 与 eventstoreUI `src/routes/editbook/+page.svelte` 中书籍信息一致：
 * - 发布：`create_book` / `update_book` 的 `data` 使用 `coverImgurl`、`labels`、**`coAuthors`（公钥 hex 数组）**。
 *   eventstoreUI 始终传 `coAuthors: pubkeys`（可为 `[]`）；esclient 再写到 `event.coAuthors`。须始终带该字段，否则更新时无法清空联合作者。
 * - 读取：`get_book_id` / `get_books` 回调里 `message.data` 同上，封面以 `coverImgurl` 为主。
 * - 大纲：与 eventstoreUI `viewbooks/[bookId]/+page.server.js` 一致，目录 JSON 存在章节 **`outline.md`**
 *   中，需 `get_chapter_author(bookId, 'outline.md', authorPubkey, ...)`，**不要**依赖 `data.outline`（可能为空）。
 */

/** 与 editbook `create_chapter(..., "outline.md", ...)` 一致 */
const OUTLINE_CHAPTER_NAME = 'outline.md';

/**
 * 远程 data → 本地草稿用的封面文件名（与 meta.cover 一致，不含域名）
 * @param {Record<string, unknown>} data
 * @returns {string}
 */
function coverFilenameFromRemoteBookData(data) {
  if (!data || typeof data !== 'object') return '';
  const raw =
    data.coverImgurl != null && String(data.coverImgurl).trim() !== ''
      ? data.coverImgurl
      : data.cover != null && String(data.cover).trim() !== ''
        ? data.cover
        : data.coverUrl;
  return String(raw || '').trim();
}

/**
 * 远程 data → 标签列表（eventstoreUI 用 `labels`，兼容 `tags`）
 * @param {Record<string, unknown>} data
 * @returns {string[]}
 */
function tagsFromRemoteBookData(data) {
  if (!data || typeof data !== 'object') return [];
  const fromLabels = data.labels;
  if (Array.isArray(fromLabels) && fromLabels.length) {
    return fromLabels.map((x) => String(x || '').trim()).filter(Boolean);
  }
  const fromTags = data.tags;
  if (Array.isArray(fromTags) && fromTags.length) {
    return fromTags.map((x) => String(x || '').trim()).filter(Boolean);
  }
  return [];
}

/**
 * 组装与 eventstoreUI `submitBookInfo` 同构的 `bookInfo`，并保留 MarkWrite 整书字段。
 * @param {{
 *   normalized: { title: string, tags: string[], extra: string, author: string, outline: string, content: string },
 *   coverFile: string,
 *   remoteId: string,
 *   coAuthorPubkeys: string[],
 * }} args
 * @returns {Record<string, unknown>}
 */
function buildCreateBookWirePayload(args) {
  const { normalized, coverFile, remoteId, coAuthorPubkeys } = args;
  /** 与 eventstoreUI `submitBookInfo` 一致：create_book / update_book 的 data 不含整书正文与大纲 JSON；二者通过 create_chapter 上传 */
  const bookData = {
    title: normalized.title,
    author: normalized.author,
    coverImgurl: coverFile,
    labels: normalized.tags,
    extra: normalized.extra,
    summary: normalized.extra,
  };
  if (normalized.tags.length) bookData.tags = normalized.tags;
  if (remoteId) bookData.bookId = remoteId;
  bookData.coAuthors = Array.isArray(coAuthorPubkeys) ? coAuthorPubkeys.slice() : [];
  return bookData;
}

function walkOutlineChapterIds(items, out) {
  if (!Array.isArray(items)) return;
  items.forEach((it) => {
    if (!it || typeof it !== 'object') return;
    if (it.type === 'chapter' && typeof it.id === 'number') out.push(it.id);
    if (Array.isArray(it.children)) walkOutlineChapterIds(it.children, out);
  });
}

function parseOutlineChapterIds(outlineStr) {
  try {
    const j = JSON.parse(String(outlineStr || '').trim() || '[]');
    const ids = [];
    walkOutlineChapterIds(Array.isArray(j) ? j : [], ids);
    return ids;
  } catch (_) {
    return [];
  }
}

function promisifyCreateChapter(mod, bookId, content, name, pubkeyHex, privkeyBytes) {
  return new Promise((resolve) => {
    if (!mod || typeof mod.create_chapter !== 'function') {
      resolve({ code: 500, message: 'esclient 缺少 create_chapter' });
      return;
    }
    const body = typeof content === 'string' ? content : String(content ?? '');
    const chapterName = typeof name === 'number' ? String(name) : String(name ?? '');
    try {
      mod.create_chapter(bookId, body, chapterName, pubkeyHex, privkeyBytes, (msg) => {
        const m = msg && Array.isArray(msg) ? msg[2] : msg;
        resolve(m && typeof m === 'object' ? m : { code: 200 });
      });
    } catch (e) {
      resolve({ code: 500, message: e && e.message ? e.message : String(e) });
    }
  });
}

/**
 * 与 eventstoreUI editbook 一致：大纲 JSON → create_chapter(..., "outline.md")；各章正文 → create_chapter(..., String(章节id))。
 * tag `d` 为 bookId + '_' + name（见 esclient create_chapter），与 get_chapter_author(bookId, id|'outline.md') 一致。
 */
async function syncBookOutlineAndChaptersToServer(mod, opts) {
  const {
    bookId,
    outlineStr,
    chapterContents,
    pubkeyHex,
    privkeyBytes,
    log,
    /** 为 false 时跳过 outline.md（本地大纲未变更时） */
    uploadOutline = true,
    /**
     * null：按大纲上传全部章节；number[]：仅上传列出的章节 id（增量同步）
     */
    chapterIdsFilter = null,
  } = opts;
  const logFn = typeof log === 'function' ? log : () => {};
  let outlineJson = '[]';
  try {
    const j = JSON.parse(String(outlineStr || '').trim() || '[]');
    outlineJson = JSON.stringify(Array.isArray(j) ? j : [], null, 2);
  } catch (_) {
    outlineJson = '[]';
  }
  if (uploadOutline) {
    logFn('book-chapters', { phase: 'outline.md', bookId, bytes: outlineJson.length });
    const rOutline = await promisifyCreateChapter(
      mod,
      bookId,
      outlineJson,
      OUTLINE_CHAPTER_NAME,
      pubkeyHex,
      privkeyBytes,
    );
    if (rOutline && Number(rOutline.code) >= 400) {
      return { ok: false, message: rOutline.message || `大纲上传失败 (${rOutline.code})` };
    }
  }
  const idsAll = parseOutlineChapterIds(outlineStr);
  const filter =
    chapterIdsFilter == null
      ? null
      : new Set(
          (Array.isArray(chapterIdsFilter) ? chapterIdsFilter : [])
            .map((n) => Number(n))
            .filter((n) => Number.isFinite(n)),
        );
  const ids =
    filter == null ? idsAll : idsAll.filter((id) => filter.has(id));
  const cc = chapterContents && typeof chapterContents === 'object' ? chapterContents : {};
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i];
    const raw = cc[id] != null ? cc[id] : cc[String(id)];
    const body = raw != null ? String(raw) : '';
    logFn('book-chapters', { phase: 'chapter', bookId, chapterId: id, bytes: body.length });
    const r = await promisifyCreateChapter(mod, bookId, body, String(id), pubkeyHex, privkeyBytes);
    if (r && Number(r.code) >= 400) {
      return { ok: false, message: r.message || `章节 ${id} 上传失败 (${r.code})` };
    }
  }
  return { ok: true };
}

module.exports = {
  OUTLINE_CHAPTER_NAME,
  coverFilenameFromRemoteBookData,
  tagsFromRemoteBookData,
  buildCreateBookWirePayload,
  parseOutlineChapterIds,
  syncBookOutlineAndChaptersToServer,
};
