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
  const bookData = {
    title: normalized.title,
    author: normalized.author,
    coverImgurl: coverFile,
    labels: normalized.tags,
    content: normalized.content,
    outline: normalized.outline,
    extra: normalized.extra,
    summary: normalized.extra,
  };
  if (normalized.tags.length) bookData.tags = normalized.tags;
  if (remoteId) bookData.bookId = remoteId;
  bookData.coAuthors = Array.isArray(coAuthorPubkeys) ? coAuthorPubkeys.slice() : [];
  return bookData;
}

module.exports = {
  OUTLINE_CHAPTER_NAME,
  coverFilenameFromRemoteBookData,
  tagsFromRemoteBookData,
  buildCreateBookWirePayload,
};
