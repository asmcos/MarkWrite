const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('markwrite', {
  version: '0.1.0',
  api: {
    openFile: () => ipcRenderer.invoke('file:open'),
    fileRead: (filePath) => ipcRenderer.invoke('file:read', filePath),
    saveFile: (filePath, content) => ipcRenderer.invoke('file:save', filePath, content),
    saveAs: (content) => ipcRenderer.invoke('file:saveAs', content),
    renderMarkdown: (markdown) => ipcRenderer.invoke('markdown:render', markdown),
    aiChat: (message, context) => ipcRenderer.invoke('ai:chat', { message, context }),
    aiDocEdit: (message, context) => ipcRenderer.invoke('ai:docEdit', { message, context }),
    aiHealth: () => ipcRenderer.invoke('ai:health'),
    aiConfigGet: () => ipcRenderer.invoke('ai:config:get'),
    aiConfigSave: (config) => ipcRenderer.invoke('ai:config:save', config),
  },
});

