const { app, BrowserWindow, ipcMain, dialog, Menu, nativeImage } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');

// 让 Linux 程序坞/任务栏用 .desktop 的图标（需与 StartupWMClass 一致）
app.setName('MarkWrite');

const PORT_BASE = 3131;
const PORT_LAST = 3140;
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
    // 供 OpenAgent 工具或外部回调：无文件名时润色/编辑结果直接应用到编辑器（POST 到此）
    if (req.method === 'POST' && pathname === 'apply-content') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        let content = '';
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          const json = JSON.parse(body);
          content = typeof json.content === 'string' ? json.content : '';
        } catch (_) {}
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
          mainWindow.webContents.send('apply-editor-content', content);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
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
  const iconPath = path.join(ROOT, 'assets', 'markwrite-icon.png');
  let iconImage = null;
  if (fs.existsSync(iconPath)) {
    const img = nativeImage.createFromPath(iconPath);
    if (!img.isEmpty()) iconImage = img;
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 1040,
    icon: iconImage || undefined,
    webPreferences: {
      sandbox: false,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: true,
    },
  });

  // Linux 程序坞/任务栏使用窗口图标；显式 setIcon 确保被 compositor 识别
  if (iconImage) mainWindow.setIcon(iconImage);

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

/** Linux: 注册 .desktop 到 ~/.local/share/applications，程序坞用其 Icon 匹配 WM_CLASS */
function ensureLinuxDesktopFile() {
  if (process.platform !== 'linux') return;
  const iconPath = path.join(ROOT, 'assets', 'markwrite-icon.png');
  if (!fs.existsSync(iconPath)) return;
  const desktopDir = path.join(os.homedir(), '.local', 'share', 'applications');
  try {
    fs.mkdirSync(desktopDir, { recursive: true });
  } catch (_) {}
  const exe = process.execPath;
  const quote = (s) => (s && s.includes(' ')) ? `"${s}"` : s;
  const content = [
    '[Desktop Entry]',
    'Name=MarkWrite',
    'Comment=Markdown editor with AI',
    `Exec=${quote(exe)} ${quote(ROOT)}`,
    `Icon=${iconPath}`,
    'Type=Application',
    'StartupWMClass=MarkWrite',
    'Categories=Utility;TextEditor;',
  ].join('\n');
  const desktopPath = path.join(desktopDir, 'markwrite.desktop');
  try {
    if (fs.readFileSync(desktopPath, 'utf8') !== content) {
      fs.writeFileSync(desktopPath, content, 'utf8');
    }
  } catch (_) {}
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

ipcMain.handle('file:read', async (_, filePath) => {
  if (!filePath || typeof filePath !== 'string') return null;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return { filePath, content };
  } catch (_) {
    return null;
  }
});

ipcMain.handle('file:save', async (_, filePath, content) => {
  if (!filePath) return false;
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
});

// 保存到指定路径：若传入相对路径，则以当前进程工作目录为基准（通常为 MarkWrite 项目目录）
ipcMain.handle('file:saveTo', async (_, targetPath, content) => {
  if (!targetPath || typeof targetPath !== 'string') return null;
  const p = targetPath.trim();
  if (!p) return null;
  try {
    const abs = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content || '', 'utf8');
    return abs;
  } catch (e) {
    return { error: e && e.message ? e.message : String(e) };
  }
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
  ensureLinuxDesktopFile();
  const userDataPath = app.getPath('userData');
  aiBackend = getBackend(userDataPath);

  ipcMain.handle('ai:chat', async (_, payload) => {
    const message = payload && typeof payload.message === 'string' ? payload.message : (payload || '');
    const context = payload && typeof payload === 'object' && 'context' in payload ? payload.context : undefined;
    return aiBackend ? aiBackend.chat(message, context) : { error: 'AI 后端未初始化' };
  });
  ipcMain.handle('ai:docEdit', async (_, payload) => {
    const message = payload && typeof payload.message === 'string' ? payload.message : (payload || '');
    const context = payload && typeof payload === 'object' && 'context' in payload ? payload.context : undefined;
    const fn = aiBackend && typeof aiBackend.docEdit === 'function' ? aiBackend.docEdit : null;
    return fn ? fn(message, context) : { error: '智能文档 Agent 未就绪，请使用 OpenAgent 后端' };
  });
  ipcMain.handle('ai:health', async () => {
    return aiBackend ? aiBackend.health() : { ok: false, message: 'AI 后端未初始化' };
  });
  ipcMain.handle('ai:models', async (_, payload) => {
    const directory = payload && typeof payload.directory === 'string' ? payload.directory : undefined;
    const fn = aiBackend && typeof aiBackend.models === 'function' ? aiBackend.models : null;
    return fn ? fn({ directory }) : { error: '当前后端不支持列出模型（请使用 OpenAgent 后端）' };
  });
  ipcMain.handle('ai:config:get', () => getAiConfig(userDataPath));
  ipcMain.handle('ai:config:save', (_, config) => {
    saveAiConfig(userDataPath, config);
    aiBackend = getBackend(userDataPath);
    return true;
  });
  function tryListen(port) {
    if (port > PORT_LAST) {
      console.error(`Ports ${PORT_BASE}-${PORT_LAST} in use. Close the other app or change PORT_BASE in main.js`);
      process.exit(1);
    }
    const server = createServer();
    server.listen(port, '127.0.0.1', () => {
      app.port = port;
      const baseUrl = `http://127.0.0.1:${port}`;
      try {
        const markwriteDir = path.join(os.homedir(), '.config', 'markwrite');
        fs.mkdirSync(markwriteDir, { recursive: true });
        fs.writeFileSync(path.join(markwriteDir, 'apply-url'), baseUrl, 'utf8');
      } catch (_) {}
      createWindow(port);
    });
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        tryListen(port + 1);
      } else {
        throw err;
      }
    });
  }
  tryListen(PORT_BASE);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && app.port != null) {
      createWindow(app.port);
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
