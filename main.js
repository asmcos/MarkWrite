const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');

const PORT = 3131;
const ROOT = __dirname;
let mainWindow = null;

const { render: renderMarkdown } = require('./md-renderer.js');

function createServer() {
  const mime = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.wasm': 'application/wasm',
  };

  return http.createServer((req, res) => {
    let pathname = 'index.html';
    try {
      const u = new URL(req.url || '/', 'http://127.0.0.1');
      pathname = decodeURIComponent(u.pathname).replace(/^\//, '') || 'index.html';
      if (pathname === '') pathname = 'index.html';
    } catch (_) {}
    const filePath = path.join(ROOT, pathname);

    fs.readFile(filePath, (err, data) => {
      if (err) {
        if (err.code === 'ENOENT') {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }
        res.writeHead(500);
        res.end(String(err));
        return;
      }
      const ext = path.extname(pathname);
      res.setHeader('Content-Type', mime[ext] || 'application/octet-stream');
      res.end(data);
    });
  });
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 1040,
    webPreferences: {
      sandbox: false,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: true,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/index.html`);

  // 右键菜单：支持复制/粘贴/全选（聊天区等可选中文字处右键即可复制）
  mainWindow.webContents.on('context-menu', (_e, params) => {
    const menu = Menu.buildFromTemplate([
      { role: 'copy', label: '复制' },
      { role: 'paste', label: '粘贴' },
      { type: 'separator' },
      { role: 'selectAll', label: '全选' },
    ]);
    menu.popup({ window: mainWindow });
  });

  // Uncomment for devtools during development
  // mainWindow.webContents.openDevTools();
}

ipcMain.handle('file:open', async () => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown'] },
      { name: 'All', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const filePath = result.filePaths[0];
  const content = fs.readFileSync(filePath, 'utf8');
  return { filePath, content };
});

ipcMain.handle('file:save', async (_, filePath, content) => {
  if (!filePath) return false;
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
});

ipcMain.handle('file:saveAs', async (_, content) => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  const result = await dialog.showSaveDialog(win, {
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown'] },
      { name: 'All', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePath) return null;
  fs.writeFileSync(result.filePath, content, 'utf8');
  return result.filePath;
});

ipcMain.handle('markdown:render', async (_, markdown) => {
  try {
    return renderMarkdown(markdown || '');
  } catch (e) {
    return `<p>渲染失败: ${e.message}</p>`;
  }
});

const { getBackend } = require('./lib/backends/index.js');
const { getAiConfig, saveAiConfig } = require('./lib/ai-config.js');
let aiBackend = null;

app.whenReady().then(() => {
  const userDataPath = app.getPath('userData');
  aiBackend = getBackend(userDataPath);

  ipcMain.handle('ai:chat', async (_, text) => {
    return aiBackend ? aiBackend.chat(text) : { error: 'AI 后端未初始化' };
  });
  ipcMain.handle('ai:health', async () => {
    return aiBackend ? aiBackend.health() : { ok: false, message: 'AI 后端未初始化' };
  });
  ipcMain.handle('ai:config:get', () => getAiConfig(userDataPath));
  ipcMain.handle('ai:config:save', (_, config) => {
    saveAiConfig(userDataPath, config);
    aiBackend = getBackend(userDataPath);
    return true;
  });
  const server = createServer();
  server.listen(PORT, '127.0.0.1', () => {
    createWindow(PORT);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} in use. Close the other app or change PORT in main.js`);
    }
    throw err;
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(PORT);
    }
  });
});

function cleanupAiBackend() {
  if (aiBackend && typeof aiBackend.cleanup === 'function') {
    try {
      aiBackend.cleanup();
    } catch (e) {
      console.error('AI backend cleanup error:', e);
    }
    aiBackend = null;
  }
}

app.on('window-all-closed', () => {
  cleanupAiBackend();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  cleanupAiBackend();
});

process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
  cleanupAiBackend();
});

process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
  cleanupAiBackend();
});
