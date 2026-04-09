const { contextBridge, ipcRenderer } = require('electron');

let applyEditorContentCallback = null;
let workspaceChangedCallback = null;
let composeUploadProgressCallback = null;
let remoteBooksDownloadProgressCallback = null;
ipcRenderer.on('apply-editor-content', (_, content) => {
  if (typeof applyEditorContentCallback === 'function') applyEditorContentCallback(content);
});
ipcRenderer.on('workspace:changed', () => {
  if (typeof workspaceChangedCallback === 'function') workspaceChangedCallback();
});
ipcRenderer.on('compose:uploadProgress', (_, payload) => {
  if (typeof composeUploadProgressCallback === 'function') composeUploadProgressCallback(payload);
});
ipcRenderer.on('remoteBooks:downloadProgress', (_, payload) => {
  if (typeof remoteBooksDownloadProgressCallback === 'function') remoteBooksDownloadProgressCallback(payload);
});

contextBridge.exposeInMainWorld('markwrite', {
  version: '0.1.0',
  api: {
    /** 注册「无文件名时 OpenAgent 工具回调」：收到内容后替换编辑器全文 */
    onApplyEditorContent: (callback) => {
      applyEditorContentCallback = typeof callback === 'function' ? callback : null;
    },
    onWorkspaceChanged: (callback) => {
      workspaceChangedCallback = typeof callback === 'function' ? callback : null;
    },
    onComposeUploadProgress: (callback) => {
      composeUploadProgressCallback = typeof callback === 'function' ? callback : null;
    },
    onRemoteBooksDownloadProgress: (callback) => {
      remoteBooksDownloadProgressCallback = typeof callback === 'function' ? callback : null;
    },
    openFile: () => ipcRenderer.invoke('file:open'),
    fileRead: (filePath) => ipcRenderer.invoke('file:read', filePath),
    renameFile: (oldPath, newName) => ipcRenderer.invoke('file:rename', oldPath, newName),
    deleteFile: (targetPath) => ipcRenderer.invoke('file:delete', targetPath),
    saveFile: (filePath, content) => ipcRenderer.invoke('file:save', filePath, content),
    saveTo: (targetPath, content) => ipcRenderer.invoke('file:saveTo', targetPath, content),
    saveAs: (content) => ipcRenderer.invoke('file:saveAs', content),
    uploadImage: () => ipcRenderer.invoke('image:upload'),
    uploadPastedImage: (payload) => ipcRenderer.invoke('image:pasteBinary', payload),
    uploadClipboardImage: () => ipcRenderer.invoke('image:fromClipboard'),
    listDir: (dirPath) => ipcRenderer.invoke('fs:listDir', dirPath),
    getDefaultWorkspace: () => ipcRenderer.invoke('app:getDefaultWorkspace'),
    setWorkspaceRoot: (dirPath) => ipcRenderer.invoke('app:setWorkspaceRoot', dirPath),
    renderMarkdown: (markdown) => ipcRenderer.invoke('markdown:render', markdown),
    aiChat: (message, context) => ipcRenderer.invoke('ai:chat', { message, context }),
    aiDocEdit: (message, context) => ipcRenderer.invoke('ai:docEdit', { message, context }),
    aiHealth: () => ipcRenderer.invoke('ai:health'),
    aiModels: (directory) => ipcRenderer.invoke('ai:models', { directory }),
    aiConfigGet: () => ipcRenderer.invoke('ai:config:get'),
    aiConfigSave: (config) => ipcRenderer.invoke('ai:config:save', config),
    toggleDevTools: () => ipcRenderer.invoke('app:toggleDevTools'),
    windowMinimize: () => ipcRenderer.invoke('app:window:minimize'),
    windowMaximizeOrRestore: () => ipcRenderer.invoke('app:window:maximizeOrRestore'),
    windowClose: () => ipcRenderer.invoke('app:window:close'),
    syncGetConfig: () => ipcRenderer.invoke('sync:getConfig'),
    syncSaveConfig: (cfg) => ipcRenderer.invoke('sync:saveConfig', cfg),
    syncGetConnectionStatus: () => ipcRenderer.invoke('sync:getConnectionStatus'),
    identityGet: (payload) => ipcRenderer.invoke('identity:get', payload),
    identitySave: (cfg) => ipcRenderer.invoke('identity:save', cfg),
    identityGenerate: () => ipcRenderer.invoke('identity:generate'),
    identityDeriveFromEsec: (esec) => ipcRenderer.invoke('identity:deriveFromEsec', esec),
    identityFetchProfile: () => ipcRenderer.invoke('identity:fetchProfile'),
    identitySaveProfile: (profile) => ipcRenderer.invoke('identity:saveProfile', profile),
    /** 与 eventstoreUI create_user（code 100）一致，向当前 Sync 的 esserver 注册用户 */
    identityRegisterOnServer: (payload) => ipcRenderer.invoke('identity:registerOnServer', payload),
    clipboardWriteText: (text) => ipcRenderer.invoke('clipboard:writeText', text),
    composeDraftsList: () => ipcRenderer.invoke('composeDrafts:list'),
    composeDraftsSave: (payload) => ipcRenderer.invoke('composeDrafts:save', payload),
    composeDraftsLoad: (id) => ipcRenderer.invoke('composeDrafts:load', id),
    composeDraftsDelete: (id) => ipcRenderer.invoke('composeDrafts:delete', id),
    remoteBlogsList: (payload) => ipcRenderer.invoke('remoteBlogs:list', payload),
    remoteBooksList: (payload) => ipcRenderer.invoke('remoteBooks:list', payload),
    /** 与 eventstoreUI 一致：get_chapter_author(bookId, 'outline.md', authorPubkey) */
    remoteBooksGetOutline: (payload) => ipcRenderer.invoke('remoteBooks:getOutline', payload),
    remoteBooksDownloadBook: (payload) => ipcRenderer.invoke('remoteBooks:downloadBook', payload),
    composeUploadAssetsAndFixPaths: (payload) => ipcRenderer.invoke('compose:uploadAssetsAndFixPaths', payload),
    composeCreateContent: (payload) => ipcRenderer.invoke('compose:createContent', payload),
    composeBookUploadDiff: (payload) => ipcRenderer.invoke('compose:bookUploadDiff', payload),
    composeBookUploadMarkSynced: (payload) => ipcRenderer.invoke('compose:bookUploadMarkSynced', payload),
    composeBookUploadMarkPending: (payload) => ipcRenderer.invoke('compose:bookUploadMarkPending', payload),
    /** 按邮箱或公钥查询 EventStore 用户（联合作者，与 eventstoreUI 一致） */
    eventstoreLookupUser: (payload) => ipcRenderer.invoke('eventstore:lookupUser', payload),
  },
});

