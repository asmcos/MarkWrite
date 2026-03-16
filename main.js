const { app, BrowserWindow, ipcMain, dialog, Menu, nativeImage, clipboard } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');
const chokidar = require('chokidar');

// 让 Linux 程序坞/任务栏用 .desktop 的图标（需与 StartupWMClass 一致）
app.setName('MarkWrite');

const PORT_BASE = 3131;
const PORT_LAST = 3140;
const ROOT = __dirname;
const DEFAULT_WORKSPACE = path.join(os.homedir(), 'markwrite-docs');
const MARKWRITE_CFG_DIR = path.join(os.homedir(), '.config', 'markwrite');
const WORKSPACE_ROOT_FILE = path.join(MARKWRITE_CFG_DIR, 'workspace-root');
const SYNC_CONFIG_FILE = path.join(MARKWRITE_CFG_DIR, 'sync-servers.json');
let workspaceRoot = DEFAULT_WORKSPACE;
let workspaceWatcher = null;
let workspaceChangeTimer = null;
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
    frame: false, // 使用自绘标题栏与边框
    titleBarStyle: 'hidden', // macOS 上更贴合系统样式，其它平台会忽略
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

  // 应用菜单改为完全由前端页面自绘，这里清空系统级菜单
  Menu.setApplicationMenu(null);
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
    properties: ['openFile', 'openDirectory'],
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown'] },
      { name: 'All', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const targetPath = result.filePaths[0];
  try {
    const stat = fs.statSync(targetPath);
    if (stat.isDirectory()) {
      return { directory: targetPath };
    }
  } catch (_) {}
  const content = fs.readFileSync(targetPath, 'utf8');
  return { filePath: targetPath, content };
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

ipcMain.handle('file:rename', async (_, oldPath, newName) => {
  if (!oldPath || typeof oldPath !== 'string' || !newName || typeof newName !== 'string') {
    return { ok: false, message: '参数无效' };
  }
  try {
    const dir = path.dirname(oldPath);
    const target = path.join(dir, newName.trim());
    if (target === oldPath) return { ok: true, oldPath, newPath: target };
    fs.renameSync(oldPath, target);
    return { ok: true, oldPath, newPath: target };
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : String(e) };
  }
});

ipcMain.handle('file:delete', async (_, targetPath) => {
  if (!targetPath || typeof targetPath !== 'string') {
    return { ok: false, message: '参数无效' };
  }
  try {
    if (!fs.existsSync(targetPath)) {
      return { ok: true, deleted: false };
    }
    const stat = fs.statSync(targetPath);
    if (stat.isDirectory()) {
      fs.rmSync(targetPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(targetPath);
    }
    return { ok: true, deleted: true };
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : String(e) };
  }
});

ipcMain.handle('file:save', async (_, filePath, content) => {
  if (!filePath) return false;
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
});

// 保存到指定路径：相对路径以当前工作区根目录为基准（默认 ~/markwrite-docs 或左侧工作区）
ipcMain.handle('file:saveTo', async (_, targetPath, content) => {
  if (!targetPath || typeof targetPath !== 'string') return null;
  const p = targetPath.trim();
  if (!p) return null;
  try {
    const root = workspaceRoot || DEFAULT_WORKSPACE;
    const abs = path.isAbsolute(p) ? p : path.join(root, p);
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

// 上传图片：弹出文件选择对话框，将图片复制到项目根目录下的 uploads 目录，并返回供 Markdown 使用的相对路径
ipcMain.handle('image:upload', async () => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const src = result.filePaths[0];
  try {
    const stat = fs.statSync(src);
    if (!stat.isFile()) return { error: '不是有效文件' };
  } catch (e) {
    return { error: e && e.message ? e.message : String(e) };
  }
  const uploadsDir = path.join(ROOT, 'uploads');
  try {
    fs.mkdirSync(uploadsDir, { recursive: true });
  } catch (e) {
    return { error: e && e.message ? e.message : String(e) };
  }
  const ext = path.extname(src) || '';
  const base = path.basename(src, ext) || 'image';
  const rand = Math.random().toString(36).slice(2, 8);
  let destName = `${base}-${rand}${ext}`;
  let destPath = path.join(uploadsDir, destName);
  let tries = 0;
  while (fs.existsSync(destPath) && tries < 5) {
    const r = Math.random().toString(36).slice(2, 8);
    destName = `${base}-${r}${ext}`;
    destPath = path.join(uploadsDir, destName);
    tries += 1;
  }
  try {
    fs.copyFileSync(src, destPath);
  } catch (e) {
    return { error: e && e.message ? e.message : String(e) };
  }
  // Web 访问路径：由内置 HTTP 服务器以 ROOT 为根提供静态文件
  const webPath = `uploads/${destName}`;
  return { ok: true, filePath: destPath, webPath };
});

// 从粘贴板数据保存图片：renderer 传入二进制数组和可选扩展名/原始文件名
ipcMain.handle('image:pasteBinary', async (_event, payload) => {
  try {
    if (!payload || !payload.data) return { error: 'no image data' };
    const data = payload.data;
    const extInput = payload.ext || '';
    const nameInput = payload.name || '';
    const uploadsDir = path.join(ROOT, 'uploads');
    fs.mkdirSync(uploadsDir, { recursive: true });
    const fromNameExt = path.extname(nameInput || '') || '';
    let ext = extInput || fromNameExt || '.png';
    if (ext[0] !== '.') ext = `.${ext}`;
    const base = (nameInput && path.basename(nameInput, fromNameExt)) || 'pasted-image';
    const rand = Math.random().toString(36).slice(2, 8);
    let destName = `${base}-${rand}${ext}`;
    let destPath = path.join(uploadsDir, destName);
    let tries = 0;
    while (fs.existsSync(destPath) && tries < 5) {
      const r = Math.random().toString(36).slice(2, 8);
      destName = `${base}-${r}${ext}`;
      destPath = path.join(uploadsDir, destName);
      tries += 1;
    }
    const buf = Buffer.from(data);
    fs.writeFileSync(destPath, buf);
    const webPath = `uploads/${destName}`;
    return { ok: true, filePath: destPath, webPath };
  } catch (e) {
    return { error: e && e.message ? e.message : String(e) };
  }
});

// 直接从系统剪贴板读取图片（备用方案，防止 DOM 粘贴事件拿不到 image items）
ipcMain.handle('image:fromClipboard', async () => {
  try {
    const img = clipboard.readImage();
    if (!img || img.isEmpty()) return { error: 'clipboard has no image' };
    const uploadsDir = path.join(ROOT, 'uploads');
    fs.mkdirSync(uploadsDir, { recursive: true });
    const rand = Math.random().toString(36).slice(2, 8);
    const destName = `clipboard-image-${rand}.png`;
    const destPath = path.join(uploadsDir, destName);
    const buf = img.toPNG();
    fs.writeFileSync(destPath, buf);
    const webPath = `uploads/${destName}`;
    return { ok: true, filePath: destPath, webPath };
  } catch (e) {
    return { error: e && e.message ? e.message : String(e) };
  }
});

// 默认/当前工作区：~/markwrite-docs，或由前端设置的工作区
function ensureDefaultWorkspace() {
  try {
    fs.mkdirSync(DEFAULT_WORKSPACE, { recursive: true });
  } catch (_) {}
}

function notifyWorkspaceChanged() {
  if (workspaceChangeTimer) clearTimeout(workspaceChangeTimer);
  workspaceChangeTimer = setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.send('workspace:changed');
      } catch (_) {}
    }
  }, 400);
}

function setupWorkspaceWatcher() {
  try {
    if (workspaceWatcher) {
      workspaceWatcher.close();
      workspaceWatcher = null;
    }
    const root = workspaceRoot || DEFAULT_WORKSPACE;
    if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) return;
    // 监听当前工作区及其子目录；使用轮询方式，行为与 test.js 中一致
    workspaceWatcher = chokidar.watch(root, {
      persistent: true,
      ignoreInitial: true,
      depth: Infinity,
      usePolling: true,   // 与 test.js 一样，强制轮询，兼容性更好
      interval: 800,
      alwaysStat: true,
    });
    workspaceWatcher
      .on('ready', () => {
        // watcher 就绪
      })
      .on('add', () => {
        notifyWorkspaceChanged();
      })
      .on('change', () => {
        notifyWorkspaceChanged();
      })
      .on('addDir', () => {
        notifyWorkspaceChanged();
      })
      .on('unlink', () => {
        notifyWorkspaceChanged();
      })
      .on('unlinkDir', () => {
        notifyWorkspaceChanged();
      })
      .on('error', () => {
        // 监听错误时静默失败，避免打断应用
      });
  } catch (_) {
    workspaceWatcher = null;
  }
}

function loadWorkspaceRoot() {
  ensureDefaultWorkspace();
  try {
    if (fs.existsSync(WORKSPACE_ROOT_FILE)) {
      const p = (fs.readFileSync(WORKSPACE_ROOT_FILE, 'utf8') || '').trim();
      // 若记录的是应用自身目录（旧版本遗留），则忽略，退回默认工作区
      if (p && fs.existsSync(p) && fs.statSync(p).isDirectory() && !p.startsWith(ROOT)) {
        workspaceRoot = p;
        setupWorkspaceWatcher();
        return;
      }
    }
  } catch (_) {}
  workspaceRoot = DEFAULT_WORKSPACE;
  setupWorkspaceWatcher();
}

function setWorkspaceRoot(dirPath) {
  ensureDefaultWorkspace();
  const p = (dirPath || '').trim();
  if (!p) return;
  try {
    const stat = fs.statSync(p);
    if (!stat.isDirectory()) return;
    workspaceRoot = p;
    const cfgDir = path.dirname(WORKSPACE_ROOT_FILE);
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(WORKSPACE_ROOT_FILE, workspaceRoot, 'utf8');
  } catch (_) {
    workspaceRoot = DEFAULT_WORKSPACE;
  }
  setupWorkspaceWatcher();
}

ipcMain.handle('app:getDefaultWorkspace', async () => {
  loadWorkspaceRoot();
  return { path: workspaceRoot || DEFAULT_WORKSPACE };
});

ipcMain.handle('app:setWorkspaceRoot', async (_, dirPath) => {
  if (dirPath && typeof dirPath === 'string') {
    try {
      setWorkspaceRoot(dirPath);
    } catch (_) {}
  }
  return { path: workspaceRoot || DEFAULT_WORKSPACE };
});

// 列出目录内容：用于左侧文件树（无 dirPath 时使用当前工作区根目录）
ipcMain.handle('fs:listDir', async (_, dirPath) => {
  try {
    loadWorkspaceRoot();
    const root = workspaceRoot || DEFAULT_WORKSPACE;
    const target = dirPath && typeof dirPath === 'string' && dirPath.trim() !== ''
      ? (path.isAbsolute(dirPath) ? dirPath : path.join(root, dirPath.trim()))
      : root;
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) return { path: target, entries: [] };
    const names = fs.readdirSync(target);
    const entries = names.map((name) => {
      const full = path.join(target, name);
      let isDir = false;
      try {
        isDir = fs.statSync(full).isDirectory();
      } catch (_) {}
      return { name, path: full, isDir };
    }).sort((a, b) => {
      if (a.isDir && !b.isDir) return -1;
      if (!a.isDir && b.isDir) return 1;
      return a.name.localeCompare(b.name);
    });
    return { path: target, entries };
  } catch (e) {
    return { error: e && e.message ? e.message : String(e) };
  }
});

ipcMain.handle('markdown:render', async (_, markdown) => {
  try {
    return renderMarkdown(markdown || '');
  } catch (e) {
    return `<p>渲染失败: ${e.message}</p>`;
  }
});

// Sync & Servers 配置：读写 ~/.config/markwrite/sync-servers.json
ipcMain.handle('sync:getConfig', async () => {
  try {
    if (fs.existsSync(SYNC_CONFIG_FILE)) {
      const raw = fs.readFileSync(SYNC_CONFIG_FILE, 'utf8');
      const data = JSON.parse(raw);
      if (Array.isArray(data.servers) && data.servers.length > 0) {
        return {
          servers: data.servers,
          activeId: data.activeId || (data.servers[0] && data.servers[0].id) || null,
        };
      }
    }
  } catch (_) {}
  // 默认返回一个本地配置
  const fallback = {
    servers: [
      {
        id: 'local',
        name: '本地',
        esserver: 'ws://127.0.0.1:8080/',
        uploadpath: 'http://127.0.0.1:8081/uploads/',
        sitename: '辰龙文档中心',
        domain: 'http://localhost:5173',
      },
    ],
    activeId: 'local',
  };
  return fallback;
});

ipcMain.handle('sync:saveConfig', async (_event, payload) => {
  try {
    const cfgDir = MARKWRITE_CFG_DIR;
    fs.mkdirSync(cfgDir, { recursive: true });
    const toSave = {
      servers: Array.isArray(payload && payload.servers) ? payload.servers : [],
      activeId: payload && typeof payload.activeId === 'string' ? payload.activeId : null,
    };
    fs.writeFileSync(SYNC_CONFIG_FILE, JSON.stringify(toSave, null, 2), 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : String(e) };
  }
});

// 切换 DevTools：供前端自定义菜单调用
ipcMain.handle('app:toggleDevTools', () => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  if (!win) return false;
  const wc = win.webContents;
  if (wc.isDevToolsOpened()) wc.closeDevTools();
  else wc.openDevTools({ mode: 'detach' });
  return true;
});

// 窗口控制：最小化 / 最大化或还原 / 关闭
ipcMain.handle('app:window:minimize', () => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  if (!win) return false;
  win.minimize();
  return true;
});

ipcMain.handle('app:window:maximizeOrRestore', () => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  if (!win) return false;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
  return true;
});

ipcMain.handle('app:window:close', () => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  if (!win) return false;
  win.close();
  return true;
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
