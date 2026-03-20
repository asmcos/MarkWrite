const { contextBridge, ipcRenderer } = require('electron');

let applyEditorContentCallback = null;
let workspaceChangedCallback = null;
ipcRenderer.on('apply-editor-content', (_, content) => {
  if (typeof applyEditorContentCallback === 'function') applyEditorContentCallback(content);
});
ipcRenderer.on('workspace:changed', () => {
  if (typeof workspaceChangedCallback === 'function') workspaceChangedCallback();
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
    identityGet: () => ipcRenderer.invoke('identity:get'),
    identitySave: (cfg) => ipcRenderer.invoke('identity:save', cfg),
    identityGenerate: () => ipcRenderer.invoke('identity:generate'),
    identityDeriveFromEsec: (esec) => ipcRenderer.invoke('identity:deriveFromEsec', esec),
    identityFetchProfile: () => ipcRenderer.invoke('identity:fetchProfile'),
    identitySaveProfile: (profile) => ipcRenderer.invoke('identity:saveProfile', profile),
    clipboardWriteText: (text) => ipcRenderer.invoke('clipboard:writeText', text),
  },
});

