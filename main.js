const { app, BrowserWindow, ipcMain, dialog, Menu, nativeImage, clipboard } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const { randomUUID, createHash } = require('crypto');
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
const IDENTITY_FILE = path.join(MARKWRITE_CFG_DIR, 'identity.json');
let eventstoreKeyLib = null;
let workspaceRoot = DEFAULT_WORKSPACE;
let workspaceWatcher = null;
let workspaceChangeTimer = null;
let mainWindow = null;

/** 私钥字节 → 小写 hex（用于展示，不含 0x） */
function secretBytesToHex(bytes) {
  if (!bytes) return '';
  try {
    const u8 = bytes instanceof Uint8Array ? bytes : Buffer.from(bytes);
    return Buffer.from(u8).toString('hex');
  } catch (_) {
    return '';
  }
}

const { render: renderMarkdown } = require('./md-renderer.js');
const {
  fetchProfile: fetchEventstoreProfile,
  saveProfile: saveEventstoreProfile,
  registerUserOnServer,
  invalidateEsclientModule,
  loadEsclient,
} = require('./lib/eventstore-profile.js');
const { writeEventstoreConfigFromSync } = require('./lib/write-eventstore-config.js');
const bookEventstoreMap = require('./lib/book-eventstore-map.js');

/** 将当前 Sync 活跃服务器写入 eventstore-vendor/config.cjs 并清 require 缓存，确保 esclient 连到正确 esserver */
let lastSyncedEsserver = '';
function syncEventstoreVendorConfig() {
  let nextEsserver = '';
  try {
    if (fs.existsSync(SYNC_CONFIG_FILE)) {
      const raw = fs.readFileSync(SYNC_CONFIG_FILE, 'utf8');
      const cfg = JSON.parse(raw);
      const servers = Array.isArray(cfg && cfg.servers) ? cfg.servers : [];
      const active = servers.find((s) => s.id === cfg.activeId) || servers[0] || null;
      nextEsserver = active && typeof active.esserver === 'string' ? active.esserver.trim() : '';
    }
  } catch (_) {}
  // 同一服务器不重复失效模块，尽量复用单例 WebSocket 连接
  if (nextEsserver && nextEsserver === lastSyncedEsserver) return;
  writeEventstoreConfigFromSync(SYNC_CONFIG_FILE);
  invalidateEsclientModule();
  lastSyncedEsserver = nextEsserver || '';
}

function readSyncConfigSafe() {
  try {
    if (!fs.existsSync(SYNC_CONFIG_FILE)) return { servers: [], activeId: null };
    const raw = fs.readFileSync(SYNC_CONFIG_FILE, 'utf8');
    const data = JSON.parse(raw);
    return {
      servers: Array.isArray(data.servers) ? data.servers : [],
      activeId: typeof data.activeId === 'string' ? data.activeId : null,
    };
  } catch (_) {
    return { servers: [], activeId: null };
  }
}

function getActiveSyncServerId(syncCfg) {
  const servers = Array.isArray(syncCfg && syncCfg.servers) ? syncCfg.servers : [];
  return (syncCfg && syncCfg.activeId) || (servers[0] && servers[0].id) || 'default';
}

function normalizeIdentityRecord(v) {
  const x = v && typeof v === 'object' ? v : {};
  const pubkeyHex = typeof x.pubkeyHex === 'string'
    ? x.pubkeyHex.trim()
    : (typeof x.pubkey === 'string' ? x.pubkey.trim() : '');
  return {
    pubkeyHex,
    pubkeyEpub: typeof x.pubkeyEpub === 'string' ? x.pubkeyEpub.trim() : '',
    // 兼容旧字段
    pubkey: pubkeyHex,
    privkey: typeof x.privkey === 'string' ? x.privkey.trim() : '',
  };
}

function hasIdentityData(v) {
  return !!(v && (v.pubkeyHex || v.pubkey || v.pubkeyEpub || v.privkey));
}

function readIdentityStoreRaw() {
  try {
    if (!fs.existsSync(IDENTITY_FILE)) return null;
    const raw = fs.readFileSync(IDENTITY_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function readIdentityForServer(serverId) {
  const sid = typeof serverId === 'string' && serverId.trim() ? serverId.trim() : 'default';
  const raw = readIdentityStoreRaw();
  if (!raw) return normalizeIdentityRecord({});
  if (raw && typeof raw === 'object' && raw.byServer && typeof raw.byServer === 'object') {
    return normalizeIdentityRecord(raw.byServer[sid] || {});
  }
  // 兼容旧格式（全局单身份）
  const legacy = normalizeIdentityRecord(raw);
  if (!hasIdentityData(legacy)) return legacy;
  const legacyServerId = getActiveSyncServerId(readSyncConfigSafe());
  return sid === legacyServerId ? legacy : normalizeIdentityRecord({});
}

function saveIdentityForServer(serverId, identity) {
  const sid = typeof serverId === 'string' && serverId.trim() ? serverId.trim() : 'default';
  const next = normalizeIdentityRecord(identity);
  const raw = readIdentityStoreRaw();
  const store = { version: 2, byServer: {} };

  if (raw && typeof raw === 'object' && raw.byServer && typeof raw.byServer === 'object') {
    Object.keys(raw.byServer).forEach((k) => {
      store.byServer[k] = normalizeIdentityRecord(raw.byServer[k]);
    });
  } else if (raw && typeof raw === 'object') {
    // 迁移旧格式：挂到当前 active server 下
    const legacy = normalizeIdentityRecord(raw);
    if (hasIdentityData(legacy)) {
      const cfg = readSyncConfigSafe();
      const legacyServerId = getActiveSyncServerId(cfg);
      store.byServer[legacyServerId] = legacy;
    }
  }

  if (hasIdentityData(next)) {
    store.byServer[sid] = next;
  } else {
    delete store.byServer[sid];
  }

  if (!Object.keys(store.byServer).length) {
    try {
      if (fs.existsSync(IDENTITY_FILE)) fs.unlinkSync(IDENTITY_FILE);
    } catch (_) {}
    return;
  }
  fs.mkdirSync(MARKWRITE_CFG_DIR, { recursive: true });
  fs.writeFileSync(IDENTITY_FILE, JSON.stringify(store, null, 2), 'utf8');
}

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
  loadWorkspaceRoot();
  const defaultDir = workspaceRoot || DEFAULT_WORKSPACE;
  const result = await dialog.showOpenDialog(win, {
    defaultPath: defaultDir,
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
  loadWorkspaceRoot();
  const defaultDir = workspaceRoot || DEFAULT_WORKSPACE;
  const defaultFile = path.join(defaultDir, 'untitled.md');
  const result = await dialog.showSaveDialog(win, {
    defaultPath: defaultFile,
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

// 将文本写入系统剪贴板：用于 ESEC 复制按钮，避免浏览器剪贴板限制
ipcMain.handle('clipboard:writeText', async (_event, text) => {
  try {
    const v = typeof text === 'string' ? text : String(text || '');
    if (!v.trim()) return { ok: false, message: 'empty' };
    clipboard.writeText(v);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : String(e) };
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
    writeEventstoreConfigFromSync(SYNC_CONFIG_FILE);
    invalidateEsclientModule();
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : String(e) };
  }
});

ipcMain.handle('sync:getConnectionStatus', async () => {
  try {
    const syncCfg = readSyncConfigSafe();
    const servers = Array.isArray(syncCfg.servers) ? syncCfg.servers : [];
    const activeId = syncCfg.activeId || (servers[0] && servers[0].id) || null;
    const activeServer = servers.find((s) => s.id === activeId) || servers[0] || null;
    const esserver = activeServer && typeof activeServer.esserver === 'string' ? activeServer.esserver.trim() : '';
    if (!esserver) {
      return {
        ok: false,
        status: 'idle',
        message: '未配置 esserver',
        serverId: activeId || '',
        serverName: activeServer && activeServer.name ? activeServer.name : '',
        esserver: '',
      };
    }
    syncEventstoreVendorConfig();
    const mod = loadEsclient();
    if (!mod || typeof mod.ensure_connected !== 'function') {
      return {
        ok: false,
        status: 'disconnected',
        message: 'esclient 缺少 ensure_connected',
        serverId: activeId || '',
        serverName: activeServer && activeServer.name ? activeServer.name : '',
        esserver,
      };
    }
    const r = await mod.ensure_connected(6000);
    return {
      ok: !!(r && r.ok),
      status: r && r.ok ? 'connected' : 'disconnected',
      message: r && r.message ? r.message : '',
      serverId: activeId || '',
      serverName: activeServer && activeServer.name ? activeServer.name : '',
      esserver,
    };
  } catch (e) {
    return {
      ok: false,
      status: 'disconnected',
      message: e && e.message ? e.message : String(e),
      serverId: '',
      serverName: '',
      esserver: '',
    };
  }
});

// 身份配置：读写 ~/.config/markwrite/identity.json
ipcMain.handle('identity:get', async (_event, payload) => {
  const syncCfg0 = readSyncConfigSafe();
  const requestedServerId = payload && typeof payload.serverId === 'string' && payload.serverId.trim()
    ? payload.serverId.trim()
    : getActiveSyncServerId(syncCfg0);
  try {
    const data = readIdentityForServer(requestedServerId);
    if (hasIdentityData(data)) {
      const pubkeyHex = typeof data.pubkeyHex === 'string' ? data.pubkeyHex : '';
      let pubkeyEpub = typeof data.pubkeyEpub === 'string' ? data.pubkeyEpub : '';
      try {
        if (!pubkeyEpub && pubkeyHex) {
          if (!eventstoreKeyLib) {
            // eslint-disable-next-line global-require, import/no-extraneous-dependencies
            eventstoreKeyLib = require('eventstore-tools/src/key');
          }
          if (eventstoreKeyLib && typeof eventstoreKeyLib.epubEncode === 'function') {
            pubkeyEpub = eventstoreKeyLib.epubEncode(pubkeyHex);
          }
        }
      } catch (_) {}
      let privkeyHex = '';
      const privkeyStr = typeof data.privkey === 'string' ? data.privkey.trim() : '';
      if (privkeyStr && privkeyStr.startsWith('esec')) {
        try {
          if (!eventstoreKeyLib) {
            // eslint-disable-next-line global-require, import/no-extraneous-dependencies
            eventstoreKeyLib = require('eventstore-tools/src/key');
          }
          const decoded = eventstoreKeyLib.esecDecode(privkeyStr);
          const privBytes = (decoded && (decoded.data || decoded)) || decoded;
          privkeyHex = secretBytesToHex(privBytes);
        } catch (_) {}
      }
      return {
        serverId: requestedServerId,
        pubkey: pubkeyEpub || pubkeyHex || '',
        pubkeyHex,
        pubkeyEpub,
        privkey: typeof data.privkey === 'string' ? data.privkey : '',
        privkeyHex,
      };
    }
  } catch (_) {}
  return {
    serverId: requestedServerId,
    pubkey: '',
    pubkeyHex: '',
    pubkeyEpub: '',
    privkey: '',
    privkeyHex: '',
  };
});

ipcMain.handle('identity:save', async (_event, payload) => {
  try {
    if (!eventstoreKeyLib) {
      // eslint-disable-next-line global-require, import/no-extraneous-dependencies
      eventstoreKeyLib = require('eventstore-tools/src/key');
    }
    const syncCfg = readSyncConfigSafe();
    const fallbackServerId = getActiveSyncServerId(syncCfg);
    const serverId = payload && typeof payload.serverId === 'string' && payload.serverId.trim()
      ? payload.serverId.trim()
      : fallbackServerId;
    const rawPub = payload && typeof payload.pubkey === 'string' ? payload.pubkey.trim() : '';
    const privkey = payload && typeof payload.privkey === 'string' ? payload.privkey.trim() : '';

    // 退出登录：清空 pubkey+privkey 时直接删除文件，避免残留空 JSON 导致前端/状态不一致
    if (!rawPub && !privkey) {
      saveIdentityForServer(serverId, { pubkeyHex: '', pubkeyEpub: '', pubkey: '', privkey: '' });
      return { ok: true, pubkeyHex: '', pubkeyEpub: '' };
    }

    let pubkeyHex = '';
    let pubkeyEpub = '';

    if (privkey) {
      if (!privkey.startsWith('esec')) {
        return { ok: false, message: 'ESEC 密钥应以 esec 开头' };
      }
      try {
        const decoded = eventstoreKeyLib.esecDecode(privkey);
        const privBytes = (decoded && (decoded.data || decoded)) || decoded;
        pubkeyHex = eventstoreKeyLib.getPublicKey(privBytes);
        if (typeof eventstoreKeyLib.epubEncode === 'function') {
          pubkeyEpub = eventstoreKeyLib.epubEncode(pubkeyHex);
        }
      } catch (e) {
        return { ok: false, message: '无效的 ESEC 密钥，无法解析' };
      }
      if (!pubkeyHex) {
        return { ok: false, message: '无效的 ESEC 密钥' };
      }
    } else if (rawPub) {
      try {
        if (rawPub.startsWith('epub1') && typeof eventstoreKeyLib.epubDecode === 'function') {
          const decoded = eventstoreKeyLib.epubDecode(rawPub);
          pubkeyHex = typeof decoded === 'string' ? decoded : (decoded && decoded.data) || '';
          pubkeyEpub = rawPub;
        } else {
          pubkeyHex = rawPub;
          if (typeof eventstoreKeyLib.epubEncode === 'function') {
            pubkeyEpub = eventstoreKeyLib.epubEncode(pubkeyHex);
          }
        }
      } catch (e) {
        return { ok: false, message: '无效的公钥格式' };
      }
      if (!pubkeyHex && !pubkeyEpub) {
        return { ok: false, message: '无效的公钥格式' };
      }
    } else {
      return { ok: false, message: '请填写 ESEC 密钥' };
    }

    const toSave = {
      pubkeyHex,
      pubkeyEpub,
      // 兼容旧字段，保留 pubkey 为 hex
      pubkey: pubkeyHex,
      privkey,
    };
    saveIdentityForServer(serverId, toSave);
    let privkeyHexOut = '';
    if (privkey && privkey.startsWith('esec')) {
      try {
        const decoded = eventstoreKeyLib.esecDecode(privkey);
        const privBytes = (decoded && (decoded.data || decoded)) || decoded;
        privkeyHexOut = secretBytesToHex(privBytes);
      } catch (_) {}
    }
    return { ok: true, pubkeyHex, pubkeyEpub, privkeyHex: privkeyHexOut };
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : String(e) };
  }
});

// 生成新的 ESEC 密钥对，并返回 { esec, pubkeyHex, epub }（不自动写入磁盘）
ipcMain.handle('identity:generate', async () => {
  try {
    if (!eventstoreKeyLib) {
      // 延迟加载，避免启动时硬依赖失败
      // eslint-disable-next-line global-require, import/no-extraneous-dependencies
      eventstoreKeyLib = require('eventstore-tools/src/key');
    }
    const { generateSecretKey, getPublicKey, esecEncode, epubEncode } = eventstoreKeyLib;
    const privBytes = generateSecretKey();
    const pubkeyHex = getPublicKey(privBytes);
    const esec = esecEncode(privBytes);
    const epub = epubEncode(pubkeyHex);
    const privkeyHex = secretBytesToHex(privBytes);

    return { ok: true, esec, pubkeyHex, epub, privkeyHex };
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : String(e) };
  }
});

// 从 ESEC 推导公钥（hex + epub），供前端在粘贴时即时计算展示
ipcMain.handle('identity:deriveFromEsec', async (_event, esec) => {
  try {
    if (!eventstoreKeyLib) {
      // eslint-disable-next-line global-require, import/no-extraneous-dependencies
      eventstoreKeyLib = require('eventstore-tools/src/key');
    }
    const { esecDecode, getPublicKey, epubEncode } = eventstoreKeyLib;
    const v = typeof esec === 'string' ? esec.trim() : '';
    if (!v || !v.startsWith('esec')) return { ok: false, message: 'invalid esec' };
    const decoded = esecDecode(v);
    const privBytes = (decoded && (decoded.data || decoded)) || decoded;
    const pubkeyHex = getPublicKey(privBytes);
    const pubkeyEpub = epubEncode(pubkeyHex);
    const privkeyHex = secretBytesToHex(privBytes);
    return { ok: true, pubkeyHex, pubkeyEpub, privkeyHex };
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : String(e) };
  }
});

// 从当前配置的同步服务器拉取用户 profile（老用户查是否有资料）
ipcMain.handle('identity:fetchProfile', async () => {
  try {
    let syncCfg = { servers: [], activeId: null };
    if (fs.existsSync(SYNC_CONFIG_FILE)) {
      const raw = fs.readFileSync(SYNC_CONFIG_FILE, 'utf8');
      syncCfg = JSON.parse(raw);
    }
    const servers = Array.isArray(syncCfg.servers) ? syncCfg.servers : [];
    const activeId = syncCfg.activeId || (servers[0] && servers[0].id) || null;
    const activeServer = servers.find((s) => s.id === activeId) || servers[0];
    const esserver = (activeServer && activeServer.esserver) || '';
    if (!esserver) return { ok: false, message: '请先在 Sync & Servers 中配置 WebSocket 地址' };

    const identity = readIdentityForServer(activeId);
    const pubkeyHex = (identity.pubkeyHex && String(identity.pubkeyHex).trim())
      || (identity.pubkey && String(identity.pubkey).trim())
      || '';
    const pubkey = pubkeyHex;
    if (!pubkey) return { ok: false, message: '请先保存用户密钥' };

    syncEventstoreVendorConfig();
    return await fetchEventstoreProfile(esserver, pubkey);
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : String(e) };
  }
});

/**
 * 本地身份已写入后：按当前 Sync 配置的 esserver 调用与 eventstoreUI create_user 相同的注册（code 100）。
 * payload: { email?: string }
 */
ipcMain.handle('identity:registerOnServer', async (_event, payload) => {
  try {
    let syncCfg = { servers: [], activeId: null };
    if (fs.existsSync(SYNC_CONFIG_FILE)) {
      const raw = fs.readFileSync(SYNC_CONFIG_FILE, 'utf8');
      syncCfg = JSON.parse(raw);
    }
    const servers = Array.isArray(syncCfg.servers) ? syncCfg.servers : [];
    const activeServer = servers.find((s) => s.id === syncCfg.activeId) || servers[0];
    const esserver = (activeServer && activeServer.esserver) || '';
    if (!esserver) {
      return { ok: true, skipped: true, message: '未配置 EventStore WebSocket，已跳过服务器注册' };
    }

    const identity = readIdentityForServer(syncCfg.activeId || (servers[0] && servers[0].id) || 'default');
    const pubkeyHex = (identity.pubkeyHex && String(identity.pubkeyHex).trim())
      || (identity.pubkey && String(identity.pubkey).trim())
      || '';
    const privkey = (identity.privkey && identity.privkey.trim()) || '';
    if (!pubkeyHex || !privkey) {
      return { ok: false, message: '本地身份不完整，无法向服务器注册' };
    }

    const email = payload && typeof payload.email === 'string' ? payload.email.trim() : '';
    syncEventstoreVendorConfig();
    return await registerUserOnServer(esserver, email, pubkeyHex, privkey);
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : String(e) };
  }
});

// 保存用户 profile 到当前同步服务器（新用户完善资料）
ipcMain.handle('identity:saveProfile', async (_event, profile) => {
  try {
    let syncCfg = { servers: [], activeId: null };
    if (fs.existsSync(SYNC_CONFIG_FILE)) {
      const raw = fs.readFileSync(SYNC_CONFIG_FILE, 'utf8');
      syncCfg = JSON.parse(raw);
    }
    const servers = Array.isArray(syncCfg.servers) ? syncCfg.servers : [];
    const activeServer = servers.find((s) => s.id === syncCfg.activeId) || servers[0];
    const esserver = (activeServer && activeServer.esserver) || '';
    if (!esserver) return { ok: false, message: '请先在 Sync & Servers 中配置 WebSocket 地址' };

    const identity = readIdentityForServer(syncCfg.activeId || (servers[0] && servers[0].id) || 'default');
    const pubkey = (identity.pubkeyHex && String(identity.pubkeyHex).trim())
      || (identity.pubkey && String(identity.pubkey).trim())
      || '';
    const privkey = (identity.privkey && identity.privkey.trim()) || '';
    if (!pubkey || !privkey) return { ok: false, message: '请先保存用户密钥（含 ESEC）' };

    const payload = typeof profile === 'object' && profile !== null ? profile : {};
    syncEventstoreVendorConfig();
    return await saveEventstoreProfile(esserver, pubkey, privkey, payload);
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : String(e) };
  }
});

/**
 * 发布前：将封面/正文里引用的本地 uploads/* 图片上传到服务器，并返回替换后的 cover/content。
 * - 仅处理形如 uploads/xxx 或 /uploads/xxx 的资源
 * - 返回的 URL 以当前 Sync 的 uploadpath 为前缀
 */
ipcMain.handle('compose:uploadAssetsAndFixPaths', async (_event, payload) => {
  try {
    const p = payload && typeof payload === 'object' ? payload : {};
    const requestId = typeof p.requestId === 'string' ? p.requestId : '';
    const uploadTraceId = requestId || `up-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const logUpload = (...args) => console.log(`[compose-upload][${uploadTraceId}]`, ...args);
    const emitProgress = (data) => {
      try {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.webContents.send('compose:uploadProgress', { requestId, ...(data || {}) });
      } catch (_) {}
    };

    let syncCfg = { servers: [], activeId: null };
    if (fs.existsSync(SYNC_CONFIG_FILE)) {
      const raw = fs.readFileSync(SYNC_CONFIG_FILE, 'utf8');
      syncCfg = JSON.parse(raw);
    }
    const servers = Array.isArray(syncCfg.servers) ? syncCfg.servers : [];
    const activeServer = servers.find((s) => s.id === syncCfg.activeId) || servers[0];
    const uploadBase = (activeServer && typeof activeServer.uploadpath === 'string' ? activeServer.uploadpath.trim() : '')
      || '';
    const esserver = (activeServer && typeof activeServer.esserver === 'string' ? activeServer.esserver.trim() : '')
      || '';
    logUpload('start', { hasServer: Boolean(esserver), hasUploadBase: Boolean(uploadBase) });
    if (!esserver) return { ok: false, message: '请先在 Sync & Servers 中配置 WebSocket 地址' };
    if (!uploadBase) return { ok: false, message: '请先在 Sync & Servers 中配置 uploadpath（用于生成图片访问地址）' };

    const identity = readIdentityForServer(syncCfg.activeId || (servers[0] && servers[0].id) || 'default');
    const pubkeyHex = (identity.pubkeyHex && String(identity.pubkeyHex).trim())
      || (identity.pubkey && String(identity.pubkey).trim())
      || '';
    const privkeyEsec = (identity.privkey && String(identity.privkey).trim()) || '';
    if (!pubkeyHex || !privkeyEsec) return { ok: false, message: '请先保存用户密钥（含 ESEC）' };

    if (!eventstoreKeyLib) {
      // eslint-disable-next-line global-require, import/no-extraneous-dependencies
      eventstoreKeyLib = require('eventstore-tools/src/key');
    }
    const { esecDecode } = eventstoreKeyLib;
    let privkeyBytes;
    try {
      const decoded = esecDecode(privkeyEsec);
      privkeyBytes = (decoded && (decoded.data || decoded)) || decoded;
    } catch (_) {
      privkeyBytes = null;
    }
    if (!privkeyBytes) return { ok: false, message: 'ESEC 密钥解析失败' };
    const cover = typeof p.cover === 'string' ? p.cover : '';
    const content = typeof p.content === 'string' ? p.content : '';
    const prevAssetMapRaw = p && typeof p.assetMap === 'object' && p.assetMap ? p.assetMap : {};
    const prevAssetMap = {};
    Object.keys(prevAssetMapRaw).forEach((k) => {
      const v = prevAssetMapRaw[k];
      if (!k || typeof k !== 'string') return;
      if (!v || typeof v !== 'object') return;
      const sha256 = typeof v.sha256 === 'string' ? v.sha256.trim() : '';
      const fileUrl = typeof v.fileUrl === 'string' ? v.fileUrl.trim() : '';
      if (!sha256 || !fileUrl) return;
      prevAssetMap[k] = { sha256, fileUrl };
    });

    const toUpload = new Set();
    const addUploadRef = (u) => {
      const s = typeof u === 'string' ? u.trim() : '';
      if (!s) return;
      const m = s.match(/^(?:\/)?uploads\/([^\s?#)]+)$/i);
      if (!m) return;
      const rel = `uploads/${m[1]}`;
      toUpload.add(rel);
    };

    // cover
    addUploadRef(cover);
    // markdown image: ![](...)
    const mdImgRe = /!\[[^\]]*]\(([^)]+)\)/g;
    let m;
    while ((m = mdImgRe.exec(content)) !== null) {
      const rawUrl = (m[1] || '').trim().replace(/^<|>$/g, '');
      const url = rawUrl.split(/\s+/)[0]; // strip optional title
      addUploadRef(url.replace(/^["']|["']$/g, ''));
    }
    // html image: <img src="...">
    const htmlImgRe = /<img[^>]+src=["']([^"']+)["']/gi;
    while ((m = htmlImgRe.exec(content)) !== null) {
      addUploadRef(m[1]);
    }

    const uploadsDir = path.join(ROOT, 'uploads');
    const uploadedMap = {};
    const nextAssetMap = { ...prevAssetMap };
    const targets = Array.from(toUpload).filter((rel) => fs.existsSync(path.join(uploadsDir, path.basename(rel))));
    const totalFiles = targets.length;
    let completedFiles = 0;
    logUpload('scan-finished', { totalRefs: toUpload.size, existingLocalFiles: totalFiles, targets });

    emitProgress({
      phase: 'start',
      totalFiles,
      completedFiles,
      overallPercent: totalFiles ? 0 : 100,
      message: totalFiles ? `准备上传 ${totalFiles} 张图片` : '没有需要上传的本地图片',
    });

    if (!totalFiles) {
      logUpload('no-local-files-to-upload, return directly');
      return {
        ok: true,
        uploaded: uploadedMap,
        cover,
        content,
      };
    }

    syncEventstoreVendorConfig();
    const mod = loadEsclient();
    /** 将服务端返回的 fileUrl/path/url 归一为可访问地址（优先使用服务端返回值） */
    const mkPublicUrl = (serverPathOrUrl) => {
      const base = uploadBase.endsWith('/') ? uploadBase : `${uploadBase}/`;
      let p = String(serverPathOrUrl || '').trim();
      if (!p) return '';
      if (/^https?:\/\//i.test(p)) return p.replace(/\/uploads\/uploads\//gi, '/uploads/');
      p = p.replace(/^\//, '');
      try {
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
    };
    const safeName = (name) => String(name || '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-');

    for (let fileIndex = 0; fileIndex < targets.length; fileIndex += 1) {
      const rel = targets[fileIndex];
      const baseName = path.basename(rel);
      const ext = path.extname(baseName) || '.png';
      const fileStem = safeName(path.basename(baseName, ext)) || 'image';
      const remoteName = `${fileStem}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
      const localPath = path.join(uploadsDir, baseName);
      const buf = fs.readFileSync(localPath);
      const sha256 = createHash('sha256').update(buf).digest('hex');
      logUpload('file-begin', {
        index: fileIndex + 1,
        totalFiles,
        rel,
        bytes: buf.length,
        sha256: sha256.slice(0, 12),
      });

      const prev = prevAssetMap[rel];
      if (prev && prev.sha256 === sha256 && typeof prev.fileUrl === 'string' && prev.fileUrl.trim()) {
        const url = mkPublicUrl(prev.fileUrl);
        uploadedMap[rel] = url;
        nextAssetMap[rel] = { sha256, fileUrl: prev.fileUrl };
        logUpload('file-reused', { rel, fileUrl: prev.fileUrl, publicUrl: url });
        completedFiles += 1;
        emitProgress({
          phase: 'file_done',
          fileIndex: fileIndex + 1,
          totalFiles,
          completedFiles,
          currentFile: rel,
          currentFilePercent: 100,
          overallPercent: Math.floor((completedFiles / totalFiles) * 100),
          message: `已复用 ${completedFiles}/${totalFiles}: ${baseName}`,
        });
        continue;
      }
      const fileData = Array.from(new Uint8Array(buf));
      let serverReturnedPath = '';
      emitProgress({
        phase: 'file_start',
        fileIndex: fileIndex + 1,
        totalFiles,
        completedFiles,
        currentFile: rel,
        currentFilePercent: 0,
        overallPercent: Math.floor((completedFiles / totalFiles) * 100),
        message: `上传中 ${fileIndex + 1}/${totalFiles}: ${baseName}`,
      });
      await new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;
        const armTimeout = () => {
          if (timer) clearTimeout(timer);
          // 滑动超时：只要仍有回包/分片进度，就持续等待，避免大图误判超时
          timer = setTimeout(() => done(false, '上传超时（45s）'), 45000);
        };
        const done = (ok, err) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          logUpload('file-finish', { rel, ok, err: err || '', serverReturnedPath: serverReturnedPath || '' });
          if (ok) resolve();
          else reject(new Error(err || 'upload failed'));
        };
        armTimeout();
        try {
          mod.upload_file(remoteName, fileData, pubkeyHex, privkeyBytes, (msg) => {
            try {
              armTimeout();
              const maybe = msg && Array.isArray(msg) ? msg[2] : msg;
              const pickServerFilePath = (obj) => {
                if (!obj || typeof obj !== 'object') return '';
                const cands = [
                  obj.fileUrl,
                  obj.fileName,
                  obj.filename,
                  obj.file,
                  obj.webPath,
                  obj.path,
                  obj.url,
                  obj?.data?.fileName,
                  obj?.data?.filename,
                  obj?.data?.file,
                  obj?.data?.webPath,
                  obj?.data?.path,
                  obj?.data?.url,
                  obj?.data?.fileUrl,
                ];
                for (const c of cands) {
                  if (typeof c !== 'string') continue;
                  const v = c.trim();
                  if (!v) continue;
                  return v;
                }
                return '';
              };
              if (maybe && typeof maybe === 'object' && typeof maybe.message === 'string') {
                const mm = maybe.message.match(/^(\d+)\/(\d+)$/);
                if (mm) {
                  const chunkDone = Number(mm[1]) + 1;
                  const chunkTotal = Number(mm[2]);
                  const currentFilePercent = chunkTotal > 0
                    ? Math.max(1, Math.min(99, Math.floor((chunkDone / chunkTotal) * 100)))
                    : 0;
                  const overallPercent = Math.max(
                    1,
                    Math.min(
                      99,
                      Math.floor((((completedFiles + (currentFilePercent / 100)) / totalFiles) * 100)),
                    ),
                  );
                  emitProgress({
                    phase: 'file_progress',
                    fileIndex: fileIndex + 1,
                    totalFiles,
                    completedFiles,
                    currentFile: rel,
                    currentFilePercent,
                    overallPercent,
                    message: `上传中 ${fileIndex + 1}/${totalFiles}: ${baseName} ${currentFilePercent}%`,
                  });
                }
              }
              if (maybe && typeof maybe === 'object') {
                const picked = pickServerFilePath(maybe);
                if (picked) serverReturnedPath = picked;
              }
              if (maybe && typeof maybe === 'object' && maybe.code != null) {
                logUpload('file-callback', {
                  rel,
                  code: Number(maybe.code),
                  message: typeof maybe.message === 'string' ? maybe.message : '',
                  id: maybe.id || '',
                });
              }
              if (maybe && typeof maybe === 'object' && maybe.code != null && Number(maybe.code) >= 400) {
                done(false, maybe.message || `服务器错误 (${maybe.code})`);
                return;
              }
              if (maybe && typeof maybe === 'object' && maybe.code != null && Number(maybe.code) < 400) {
                // code 202 常用于分片进度，最终响应通常是其它 2xx
                if (Number(maybe.code) !== 202) {
                  done(true);
                }
              }
            } catch (_) {}
          });
        } catch (e) {
          done(false, e && e.message ? e.message : String(e));
        }
      });
      uploadedMap[rel] = mkPublicUrl(serverReturnedPath || remoteName);
      // 记录服务端返回的 fileUrl/path（不强制是文件名；优先用服务端返回值）
      nextAssetMap[rel] = { sha256, fileUrl: serverReturnedPath || remoteName };
      logUpload('file-mapped', { rel, finalFileUrl: nextAssetMap[rel].fileUrl, publicUrl: uploadedMap[rel] });
      completedFiles += 1;
      emitProgress({
        phase: 'file_done',
        fileIndex: fileIndex + 1,
        totalFiles,
        completedFiles,
        currentFile: rel,
        currentFilePercent: 100,
        overallPercent: Math.floor((completedFiles / totalFiles) * 100),
        message: `已完成 ${completedFiles}/${totalFiles}: ${baseName}`,
      });
    }

    const rewrite = (text) => {
      let out = String(text || '');
      Object.keys(uploadedMap).forEach((rel) => {
        const remote = uploadedMap[rel];
        const escaped = rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        out = out.replace(new RegExp(`(?<![\\w/])${escaped}`, 'g'), remote);
        out = out.replace(new RegExp(`(?<![\\w/])\\/${escaped}`, 'g'), remote);
      });
      return out;
    };

    const dedupeUploadsInText = (s) => String(s || '').replace(/\/uploads\/uploads\//gi, '/uploads/');

    emitProgress({
      phase: 'done',
      totalFiles,
      completedFiles,
      overallPercent: 100,
      message: `上传完成 ${completedFiles}/${totalFiles}`,
    });
    logUpload('all-done', {
      uploadedCount: Object.keys(uploadedMap).length,
      assetMapCount: Object.keys(nextAssetMap).length,
    });

    return {
      ok: true,
      uploaded: uploadedMap,
      assetMap: nextAssetMap,
      cover: dedupeUploadsInText(rewrite(cover)),
      content: dedupeUploadsInText(rewrite(content)),
    };
  } catch (e) {
    console.error('[compose-upload][fatal]', e);
    try {
      const requestId = payload && typeof payload === 'object' && typeof payload.requestId === 'string'
        ? payload.requestId
        : '';
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('compose:uploadProgress', {
          requestId,
          phase: 'error',
          message: e && e.message ? e.message : String(e),
        });
      }
    } catch (_) {}
    return { ok: false, message: e && e.message ? e.message : String(e) };
  }
});

ipcMain.handle('compose:createContent', async (_event, payload) => {
  try {
    const p = payload && typeof payload === 'object' ? payload : {};
    const publishTraceId = `pub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const logPublish = (...args) => console.log(`[compose-publish][${publishTraceId}]`, ...args);
    const mode = p.mode === 'book' ? 'book' : 'blog';
    const title = String(p.title || '').trim();
    if (!title) return { ok: false, message: '标题不能为空' };
    if (mode === 'book' && !String(p.author || '').trim()) {
      return { ok: false, message: '作者不能为空' };
    }

    let syncCfg = { servers: [], activeId: null };
    if (fs.existsSync(SYNC_CONFIG_FILE)) {
      const raw = fs.readFileSync(SYNC_CONFIG_FILE, 'utf8');
      syncCfg = JSON.parse(raw);
    }
    const servers = Array.isArray(syncCfg.servers) ? syncCfg.servers : [];
    const activeServer = servers.find((s) => s.id === syncCfg.activeId) || servers[0];
    const esserver = (activeServer && typeof activeServer.esserver === 'string' ? activeServer.esserver.trim() : '')
      || '';
    if (!esserver) return { ok: false, message: '请先在 Sync & Servers 中配置 WebSocket 地址' };

    const identity = readIdentityForServer(syncCfg.activeId || (servers[0] && servers[0].id) || 'default');
    const pubkeyHex = (identity.pubkeyHex && String(identity.pubkeyHex).trim())
      || (identity.pubkey && String(identity.pubkey).trim())
      || '';
    const privkeyEsec = (identity.privkey && String(identity.privkey).trim()) || '';
    if (!pubkeyHex || !privkeyEsec) return { ok: false, message: '请先保存用户密钥（含 ESEC）' };

    if (!eventstoreKeyLib) {
      // eslint-disable-next-line global-require, import/no-extraneous-dependencies
      eventstoreKeyLib = require('eventstore-tools/src/key');
    }
    const { esecDecode } = eventstoreKeyLib;
    let privkeyBytes;
    try {
      const decoded = esecDecode(privkeyEsec);
      privkeyBytes = (decoded && (decoded.data || decoded)) || decoded;
    } catch (_) {
      privkeyBytes = null;
    }
    if (!privkeyBytes) return { ok: false, message: 'ESEC 密钥解析失败' };

    const parseTags = (v) => {
      if (Array.isArray(v)) return v.map((x) => String(x || '').trim()).filter(Boolean);
      if (typeof v === 'string') return v.split(/[，,、]/).map((x) => x.trim()).filter(Boolean);
      return [];
    };

    const normalized = {
      title,
      tags: parseTags(p.tags),
      cover: String(p.cover || '').trim(),
      extra: String(p.extra || '').trim(),
      author: String(p.author || '').trim(),
      outline: String(p.outline || '').trim(),
      content: typeof p.content === 'string' ? p.content : '',
    };
    const remoteId = typeof p.remoteId === 'string' ? p.remoteId.trim() : '';
    logPublish('start', {
      mode,
      titleLen: title.length,
      hasRemoteId: Boolean(remoteId),
      tagsCount: normalized.tags.length,
      contentLen: normalized.content.length,
      cover: normalized.cover,
    });

    /** 与线上一致：封面只存文件名，不带域名 */
    function coverToFileNameOnly(cover) {
      const s = String(cover || '').trim();
      if (!s) return '';
      if (/^https?:\/\//i.test(s)) {
        try {
          const u = new URL(s);
          const segs = u.pathname.split('/').filter(Boolean);
          return segs.pop() || '';
        } catch (_) {
          return '';
        }
      }
      return s.replace(/^\//, '').replace(/^uploads\//i, '').split('/').pop() || '';
    }
    const coverFile = coverToFileNameOnly(normalized.cover);

    const blogData = {
      title: normalized.title,
      content: normalized.content,
      cover: coverFile,
      coverUrl: coverFile,
      extra: normalized.extra,
      summary: normalized.extra,
      labels: normalized.tags,
      tags: normalized.tags,
    };
    if (remoteId) blogData.blogId = remoteId;
    const coAuthorsPayload = Array.isArray(p.coAuthors) ? p.coAuthors : [];
    const coAuthorPubkeys = coAuthorsPayload
      .map((x) => (x && typeof x.pubkey === 'string' ? x.pubkey.trim() : ''))
      .filter(Boolean);
    const bookData = bookEventstoreMap.buildCreateBookWirePayload({
      normalized,
      coverFile,
      remoteId,
      coAuthorPubkeys,
    });

    syncEventstoreVendorConfig();
    const mod = loadEsclient();

    if (mode === 'blog') {
      return await new Promise((resolve) => {
        let settled = false;
        let timer = null;
        let provisionalId = '';
        let provisionalDoneTimer = null;
        const armTimeout = () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => done(false, '发布超时（30s）', provisionalId), 30000);
        };
        const done = (ok, message, id) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (provisionalDoneTimer) clearTimeout(provisionalDoneTimer);
          logPublish('finish', { mode: 'blog', ok, message, id: id || provisionalId || '' });
          resolve({ ok, message, id });
        };
        armTimeout();
        try {
          logPublish('invoke create_blog', { hasBlogId: Boolean(blogData.blogId), blogId: blogData.blogId || '' });
          mod.create_blog(JSON.stringify(blogData), pubkeyHex, privkeyBytes, (msg) => {
            try {
              armTimeout();
              const m = msg && Array.isArray(msg) ? msg[2] : msg;
              if (!m || m === 'EOSE') return;
              if (typeof m === 'object' && m.code != null) {
                const c = Number(m.code);
                logPublish('callback', { mode: 'blog', code: c, message: m.message || '', id: m.id || '' });
                if (c >= 400) {
                  done(false, m.message || `服务器错误 (${c})`);
                  return;
                }
                if (c === 201) {
                  // 201 仅代表本地/前置生成了 id，不代表服务器发布成功；继续等待 200
                  provisionalId = m.id || provisionalId;
                  // 有些服务端偶发不回 200，这里给一个兜底：拿到 201 后短暂等待再按成功处理
                  if (!provisionalDoneTimer && provisionalId) {
                    provisionalDoneTimer = setTimeout(
                      () => done(true, '已生成ID（未收到200确认，按成功处理）', provisionalId),
                      3500,
                    );
                  }
                  return;
                }
                if (c >= 200 && c < 300) {
                  done(true, m.message || '发布成功', m.id || provisionalId || '');
                }
              }
            } catch (_) {}
          });
        } catch (e) {
          done(false, e && e.message ? e.message : String(e));
        }
      });
    }

    return await new Promise((resolve) => {
      let settled = false;
      let timer = null;
      let provisionalDoneTimer = null;
      const armTimeout = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => done(false, '发布超时（30s）', remoteId || ''), 30000);
      };
      const done = (ok, message, id) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (provisionalDoneTimer) clearTimeout(provisionalDoneTimer);
        logPublish('finish', { mode: 'book', ok, message, id: id || remoteId || '' });
        resolve({ ok, message, id });
      };
      armTimeout();
      try {
        const cb = (msg) => {
          try {
            armTimeout();
            const m = msg && Array.isArray(msg) ? msg[2] : msg;
            if (!m || m === 'EOSE') return;
            if (typeof m === 'object' && m.code != null) {
              const c = Number(m.code);
              logPublish('callback', { mode: 'book', code: c, message: m.message || '', id: m.id || '' });
              if (c >= 400) {
                done(false, m.message || `服务器错误 (${c})`);
                return;
              }
              if (c === 201) {
                // create_book 的 201 仅是生成 id；继续等待 200
                if (!provisionalDoneTimer && m.id) {
                  provisionalDoneTimer = setTimeout(
                    () => done(true, '已生成ID（未收到200确认，按成功处理）', m.id),
                    3500,
                  );
                }
                return;
              }
              if (c >= 200 && c < 300) {
                done(true, m.message || '发布成功', m.id || remoteId || '');
              }
            }
          } catch (_) {}
        };
        if (remoteId && typeof mod.update_book === 'function') {
          logPublish('invoke update_book', { remoteId });
          mod.update_book(bookData, remoteId, pubkeyHex, privkeyBytes, cb);
        } else {
          logPublish('invoke create_book', { hasBookId: Boolean(bookData.bookId), bookId: bookData.bookId || '' });
          mod.create_book(bookData, pubkeyHex, privkeyBytes, cb);
        }
      } catch (e) {
        done(false, e && e.message ? e.message : String(e));
      }
    });
  } catch (e) {
    console.error('[compose-publish][fatal]', e);
    return { ok: false, message: e && e.message ? e.message : String(e) };
  }
});

/** 与 eventstoreUI editbook 一致：按邮箱或公钥查询用户，用于联合作者 */
ipcMain.handle('eventstore:lookupUser', async (_event, payload) => {
  const raw = String(payload && payload.value != null ? payload.value : '').trim();
  if (!raw) return { ok: false, message: '请输入邮箱或公钥' };
  const sc = readSyncConfigSafe();
  const servers = sc.servers || [];
  const active = servers.find((s) => s.id === sc.activeId) || servers[0];
  const esserver = active && typeof active.esserver === 'string' ? active.esserver.trim() : '';
  if (!esserver) return { ok: false, message: '请先在 Sync & Servers 中配置 WebSocket 地址' };

  if (!eventstoreKeyLib) {
    try {
      // eslint-disable-next-line global-require, import/no-extraneous-dependencies
      eventstoreKeyLib = require('eventstore-tools/src/key');
    } catch (_) {
      return { ok: false, message: '无法加载密钥库' };
    }
  }

  syncEventstoreVendorConfig();
  const mod = loadEsclient();
  if (!mod || typeof mod.get_user_by_email !== 'function') {
    return { ok: false, message: 'EventStore 客户端不可用' };
  }

  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  return await new Promise((resolve) => {
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, message: '查询超时（15s）' }), 15000);

    const onMsg = (m) => {
      if (settled) return;
      if (m === 'EOSE') {
        clearTimeout(timer);
        finish({ ok: false, message: '未找到用户' });
        return;
      }
      if (m && typeof m === 'object' && m.pubkey) {
        const pubkey = String(m.pubkey).trim();
        const email =
          typeof m.email === 'string' && m.email.trim() ? m.email.trim() : '';
        const displayLabel =
          email || `${pubkey.slice(0, 8)}…${pubkey.slice(-6)}`;
        clearTimeout(timer);
        finish({ ok: true, email, displayLabel, pubkey });
      }
    };

    if (emailRe.test(raw)) {
      mod.get_user_by_email(raw, onMsg);
      return;
    }

    let pkHex = '';
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
      pkHex = raw.toLowerCase();
    } else if (raw.startsWith('epub1') && typeof eventstoreKeyLib.epubDecode === 'function') {
      try {
        const decoded = eventstoreKeyLib.epubDecode(raw);
        let hex = typeof decoded === 'string' ? decoded : '';
        if (!hex && decoded && decoded.data) {
          const d = decoded.data;
          hex = secretBytesToHex(d instanceof Uint8Array ? d : Buffer.from(d));
        }
        if (hex && /^[0-9a-fA-F]{64}$/i.test(hex)) pkHex = hex.toLowerCase();
      } catch (_) {
        clearTimeout(timer);
        finish({ ok: false, message: '公钥格式无效' });
        return;
      }
    }

    if (!pkHex || pkHex.length !== 64) {
      clearTimeout(timer);
      finish({ ok: false, message: '请输入有效邮箱，或 64 位 hex 公钥 / epub1 公钥' });
      return;
    }
    mod.get_user_by_pubkeys([pkHex], onMsg);
  });
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
let aiBackendInitAttempted = false;
let aiModelsCache = null;
let aiModelsLastFetchAt = 0;
let aiModelsRefreshing = false;
let aiModelsRefreshScheduled = false;

function ensureAiBackend(userDataPath) {
  if (aiBackend) return aiBackend;
  if (aiBackendInitAttempted) return null;
  aiBackendInitAttempted = true;
  try {
    aiBackend = getBackend(userDataPath);
  } catch (e) {
    aiBackend = null;
  }
  return aiBackend;
}

async function refreshAiModelsCache(userDataPath, directory) {
  if (aiModelsRefreshing) return aiModelsCache;
  aiModelsRefreshing = true;
  try {
    const b = ensureAiBackend(userDataPath);
    if (!b || typeof b.models !== 'function') {
      aiModelsCache = { error: '当前后端不支持列出模型（请使用 OpenAgent 后端）' };
      aiModelsLastFetchAt = Date.now();
      return aiModelsCache;
    }
    const r = await b.models({ directory });
    if (r && !r.error) {
      aiModelsCache = r;
      aiModelsLastFetchAt = Date.now();
    } else if (r && r.error) {
      aiModelsCache = r;
      aiModelsLastFetchAt = Date.now();
    }
    return aiModelsCache;
  } finally {
    aiModelsRefreshing = false;
  }
}

function scheduleAiModelsRefresh(userDataPath, directory) {
  if (aiModelsRefreshing || aiModelsRefreshScheduled) return;
  aiModelsRefreshScheduled = true;
  setTimeout(() => {
    aiModelsRefreshScheduled = false;
    void refreshAiModelsCache(userDataPath, directory);
  }, 0);
}

app.whenReady().then(() => {
  writeEventstoreConfigFromSync(SYNC_CONFIG_FILE);
  ensureLinuxDesktopFile();
  const userDataPath = app.getPath('userData');

  ipcMain.handle('ai:chat', async (_, payload) => {
    const message = payload && typeof payload.message === 'string' ? payload.message : (payload || '');
    const context = payload && typeof payload === 'object' && 'context' in payload ? payload.context : undefined;
    const b = ensureAiBackend(userDataPath);
    return b ? b.chat(message, context) : { error: 'AI 后端未初始化' };
  });
  ipcMain.handle('ai:docEdit', async (_, payload) => {
    const message = payload && typeof payload.message === 'string' ? payload.message : (payload || '');
    const context = payload && typeof payload === 'object' && 'context' in payload ? payload.context : undefined;
    const b = ensureAiBackend(userDataPath);
    const fn = b && typeof b.docEdit === 'function' ? b.docEdit : null;
    return fn ? fn(message, context) : { error: '智能文档 Agent 未就绪，请使用 OpenAgent 后端' };
  });
  ipcMain.handle('ai:health', async () => {
    const b = ensureAiBackend(userDataPath);
    return b ? b.health() : { ok: false, message: 'AI 后端未初始化' };
  });
  ipcMain.handle('ai:models', async (_, payload) => {
    const directory = payload && typeof payload.directory === 'string' ? payload.directory : undefined;
    const now = Date.now();
    const cacheFresh = aiModelsCache && (now - aiModelsLastFetchAt < 60 * 1000);
    if (cacheFresh) {
      scheduleAiModelsRefresh(userDataPath, directory);
      return { ...aiModelsCache, loading: false, fromCache: true };
    }
    if (aiModelsCache) {
      scheduleAiModelsRefresh(userDataPath, directory);
      return { ...aiModelsCache, loading: true, fromCache: true };
    }
    // 首次请求也立即返回，后台异步刷新，避免任何同步初始化阻塞 UI
    scheduleAiModelsRefresh(userDataPath, directory);
    return { providers: [], loading: true, fromCache: false };
  });
  ipcMain.handle('ai:config:get', () => getAiConfig(userDataPath));
  ipcMain.handle('ai:config:save', (_, config) => {
    saveAiConfig(userDataPath, config);
    aiBackend = null;
    aiBackendInitAttempted = false;
    aiModelsCache = null;
    aiModelsLastFetchAt = 0;
    ensureAiBackend(userDataPath);
    return true;
  });

  const composeDraftsLegacyDir = path.join(userDataPath, 'compose-drafts');
  function getComposeDraftsDir() {
    try {
      loadWorkspaceRoot();
      const root = (workspaceRoot || DEFAULT_WORKSPACE || '').trim();
      if (root) return path.join(root, '.markwrite', 'compose-drafts');
    } catch (_) {}
    return composeDraftsLegacyDir;
  }
  function ensureComposeDraftsDir() {
    const dir = getComposeDraftsDir();
    fs.mkdirSync(dir, { recursive: true });
    // 兼容迁移：首次切到工作区草稿目录时，把旧 userData 草稿复制过去
    try {
      if (dir !== composeDraftsLegacyDir && fs.existsSync(composeDraftsLegacyDir)) {
        const oldNames = fs.readdirSync(composeDraftsLegacyDir).filter((n) => n.endsWith('.json'));
        oldNames.forEach((name) => {
          const from = path.join(composeDraftsLegacyDir, name);
          const to = path.join(dir, name);
          if (!fs.existsSync(to)) fs.copyFileSync(from, to);
        });
      }
    } catch (_) {}
    return dir;
  }
  function isSafeDraftId(id) {
    return typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id);
  }
  const BOOK_META_FILE = 'meta.json';
  const BOOK_OUTLINE_FILE = 'outline.json';
  const BOOK_CHAPTERS_DIR = 'chapters';
  const BOOK_UPLOAD_SYNC_FILE = 'book-upload-sync.json';
  function walkBookChapterIds(items, out) {
    if (!Array.isArray(items)) return;
    items.forEach((it) => {
      if (!it || typeof it !== 'object') return;
      if (it.type === 'chapter' && typeof it.id === 'number') out.push(it.id);
      if (Array.isArray(it.children)) walkBookChapterIds(it.children, out);
    });
  }
  function parseOutlineForChapterIds(outlineStr) {
    try {
      const j = JSON.parse(String(outlineStr || '').trim() || '[]');
      const ids = [];
      walkBookChapterIds(Array.isArray(j) ? j : [], ids);
      return ids;
    } catch (_) {
      return [];
    }
  }
  function findChapterTitleInOutlineTree(items, cid) {
    if (!Array.isArray(items)) return '';
    for (const it of items) {
      if (!it || typeof it !== 'object') continue;
      if (it.type === 'chapter' && it.id === cid) return String(it.title || '').trim();
      const nested = findChapterTitleInOutlineTree(it.children, cid);
      if (nested) return nested;
    }
    return '';
  }
  function fetchChapterTextOnce(mod, bookId, chapterName, authorPubkey, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve('');
      }, timeoutMs || 20000);
      const finish = (s) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(typeof s === 'string' ? s : '');
      };
      try {
        mod.get_chapter_author(bookId, chapterName, authorPubkey, (message) => {
          if (settled) return;
          try {
            if (message === 'EOSE') {
              finish('');
              return;
            }
            if (!message || typeof message !== 'object') return;
            const raw = message.data;
            let s = '';
            if (typeof raw === 'string') s = raw;
            else if (raw != null && typeof raw === 'object') s = JSON.stringify(raw);
            if (s.trim()) finish(s.trim());
          } catch (_) {
            finish('');
          }
        });
      } catch (_) {
        finish('');
      }
    });
  }
  function fetchBookEventOnce(mod, bookId) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(null);
      }, 15000);
      try {
        mod.get_book_id(bookId, (message) => {
          if (settled) return;
          try {
            if (message === 'EOSE') {
              settled = true;
              clearTimeout(timer);
              resolve(null);
              return;
            }
            if (message && typeof message === 'object') {
              settled = true;
              clearTimeout(timer);
              resolve(message);
            }
          } catch (_) {
            settled = true;
            clearTimeout(timer);
            resolve(null);
          }
        });
      } catch (_) {
        settled = true;
        clearTimeout(timer);
        resolve(null);
      }
    });
  }
  function walkOutlineChapterTitles(items, out) {
    if (!Array.isArray(items)) return;
    items.forEach((it) => {
      if (!it || typeof it !== 'object') return;
      if (it.type === 'chapter' && typeof it.id === 'number') {
        out.push({ id: it.id, title: String(it.title || '') });
      }
      if (Array.isArray(it.children)) walkOutlineChapterTitles(it.children, out);
    });
  }
  function partDirtyUpload(localMs, syncedMs) {
    if (!localMs || localMs <= 0) return false;
    if (syncedMs == null || Number(syncedMs) <= 0) return true;
    return Math.abs(Number(localMs) - Number(syncedMs)) > 0.5;
  }
  function readBookDraftMeta(bookRoot) {
    const fp = path.join(bookRoot, BOOK_META_FILE);
    if (!fs.existsSync(fp)) return null;
    const raw = fs.readFileSync(fp, 'utf8');
    return JSON.parse(raw);
  }
  function loadBookDraftChapters(bookRoot, outlineStr) {
    const ids = parseOutlineForChapterIds(outlineStr);
    const chaptersDir = path.join(bookRoot, BOOK_CHAPTERS_DIR);
    const map = {};
    ids.forEach((id) => {
      const fp = path.join(chaptersDir, `${id}.md`);
      if (fs.existsSync(fp)) {
        try {
          map[id] = fs.readFileSync(fp, 'utf8');
        } catch (_) {
          map[id] = '';
        }
      } else {
        map[id] = '';
      }
    });
    return map;
  }
  function joinBookDraftEditorContent(chapterMap, orderedIds) {
    const parts = [];
    orderedIds.forEach((id) => {
      const body = chapterMap[id] != null ? String(chapterMap[id]) : '';
      parts.push(`<!-- mw-chapter:${id} -->\n${body}`);
    });
    return parts.join('\n\n');
  }
  function splitComposePayloadIntoChapterMap(content, outlineStr) {
    const ids = parseOutlineForChapterIds(outlineStr);
    const s = String(content || '');
    const re = /<!--\s*mw-chapter:(\d+)\s*-->/g;
    const matches = [];
    let m;
    while ((m = re.exec(s)) !== null) {
      matches.push({ id: Number(m[1]), start: m.index, endAfter: m.index + m[0].length });
    }
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
  function normalizeComposeTagsInput(tags) {
    if (Array.isArray(tags)) {
      return tags.map((t) => String(t || '').trim()).filter(Boolean);
    }
    if (typeof tags === 'string') {
      return tags
        .split(/[，,、]/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
    return [];
  }
  ipcMain.handle('composeDrafts:list', async () => {
    try {
      const dir = ensureComposeDraftsDir();
      const entries = fs.readdirSync(dir);
      const seenIds = new Set();
      const drafts = [];
      for (const name of entries) {
        const abs = path.join(dir, name);
        let st;
        try {
          st = fs.statSync(abs);
        } catch (_) {
          continue;
        }
        if (st.isDirectory()) {
          if (!isSafeDraftId(name)) continue;
          const meta = readBookDraftMeta(abs);
          if (!meta || meta.mode !== 'book') continue;
          seenIds.add(name);
          const updatedAt = typeof meta.updatedAt === 'number' ? meta.updatedAt : 0;
          const remoteId = typeof meta.remoteId === 'string' ? meta.remoteId : '';
          const assetMap = (meta && typeof meta.assetMap === 'object' && meta.assetMap) ? meta.assetMap : {};
          const assetCount = Object.keys(assetMap).length;
          drafts.push({
            id: name,
            mode: 'book',
            title: typeof meta.title === 'string' ? meta.title : '',
            cover: typeof meta.cover === 'string' ? meta.cover : '',
            updatedAt,
            remoteId,
            assetCount,
          });
        }
      }
      for (const name of entries) {
        if (!name.endsWith('.json')) continue;
        const id = name.replace(/\.json$/i, '');
        if (!isSafeDraftId(id)) continue;
        if (seenIds.has(id)) continue;
        const fp = path.join(dir, name);
        try {
          const raw = fs.readFileSync(fp, 'utf8');
          const j = JSON.parse(raw);
          const updatedAt = typeof j.updatedAt === 'number' ? j.updatedAt : 0;
          const remoteId = typeof j.remoteId === 'string' ? j.remoteId : '';
          const assetMap = (j && typeof j.assetMap === 'object' && j.assetMap) ? j.assetMap : {};
          const assetCount = Object.keys(assetMap).length;
          drafts.push({
            id,
            mode: j.mode === 'book' ? 'book' : 'blog',
            title: typeof j.title === 'string' ? j.title : '',
            cover: typeof j.cover === 'string' ? j.cover : '',
            updatedAt,
            remoteId,
            assetCount,
          });
        } catch (_) {}
      }
      drafts.sort((a, b) => b.updatedAt - a.updatedAt);
      return { ok: true, drafts };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e), drafts: [] };
    }
  });
  async function composeDraftsSaveImpl(payload) {
    try {
      const dir = ensureComposeDraftsDir();
      const p = payload && typeof payload === 'object' ? payload : {};
      const modeSave = p.mode === 'book' ? 'book' : 'blog';
      if (modeSave === 'book' && !String(p.author != null ? p.author : '').trim()) {
        return { ok: false, error: '作者不能为空' };
      }
      let id = typeof p.id === 'string' && isSafeDraftId(p.id) ? p.id : randomUUID();
      const now = Date.now();
      const tags = normalizeComposeTagsInput(p.tags);
      const assetMapRaw = p && typeof p.assetMap === 'object' && p.assetMap ? p.assetMap : {};
      const assetMap = {};
      Object.keys(assetMapRaw).forEach((k) => {
        const v = assetMapRaw[k];
        if (!k || typeof k !== 'string') return;
        if (!v || typeof v !== 'object') return;
        const sha256 = typeof v.sha256 === 'string' ? v.sha256.trim() : '';
        const fileUrl = typeof v.fileUrl === 'string' ? v.fileUrl.trim() : '';
        if (!sha256 || !fileUrl) return;
        assetMap[k] = { sha256, fileUrl };
      });
      const incomingRemoteId = typeof p.remoteId === 'string' ? p.remoteId.trim() : '';
      let persistedRemoteId = incomingRemoteId;
      const coAuthorsRaw = p && p.coAuthors;
      let coAuthors = [];
      if (Array.isArray(coAuthorsRaw)) {
        coAuthors = coAuthorsRaw
          .filter((x) => x && typeof x === 'object' && typeof x.pubkey === 'string' && x.pubkey.trim())
          .map((x) => ({
            email: typeof x.email === 'string' ? x.email.slice(0, 320) : '',
            pubkey: String(x.pubkey).trim().slice(0, 128),
          }));
      }
      const outlineStr = String(p.outline != null ? p.outline : '');
      const legacyJsonPath = path.join(dir, `${id}.json`);
      const bookRoot = path.join(dir, id);

      if (modeSave === 'book') {
        if (fs.existsSync(bookRoot) && fs.statSync(bookRoot).isDirectory()) {
          try {
            const oldMeta = readBookDraftMeta(bookRoot);
            const oldRemoteId = oldMeta && typeof oldMeta.remoteId === 'string' ? oldMeta.remoteId.trim() : '';
            if (oldRemoteId) persistedRemoteId = oldRemoteId;
          } catch (_) {}
        } else if (fs.existsSync(legacyJsonPath)) {
          try {
            const rawOld = fs.readFileSync(legacyJsonPath, 'utf8');
            const oldDraft = JSON.parse(rawOld);
            const oldRemoteId = oldDraft && typeof oldDraft.remoteId === 'string' ? oldDraft.remoteId.trim() : '';
            if (oldRemoteId) persistedRemoteId = oldRemoteId;
          } catch (_) {}
        }
        let chapterMap = {};
        if (p.chapterContents && typeof p.chapterContents === 'object') {
          Object.keys(p.chapterContents).forEach((k) => {
            const n = Number(k);
            if (!Number.isFinite(n)) return;
            chapterMap[n] = String(p.chapterContents[k] != null ? p.chapterContents[k] : '');
          });
        } else {
          chapterMap = splitComposePayloadIntoChapterMap(
            typeof p.content === 'string' ? p.content : '',
            outlineStr,
          );
        }
        const chapterIds = parseOutlineForChapterIds(outlineStr);
        chapterIds.forEach((cid) => {
          if (chapterMap[cid] === undefined) chapterMap[cid] = '';
        });
        fs.mkdirSync(bookRoot, { recursive: true });
        const chaptersDir = path.join(bookRoot, BOOK_CHAPTERS_DIR);
        fs.mkdirSync(chaptersDir, { recursive: true });
        let outlineFileBody = '[]';
        try {
          const parsed = JSON.parse(outlineStr.trim() || '[]');
          outlineFileBody = JSON.stringify(Array.isArray(parsed) ? parsed : [], null, 2);
        } catch (_) {
          outlineFileBody = '[]';
        }
        fs.writeFileSync(path.join(bookRoot, BOOK_OUTLINE_FILE), outlineFileBody, 'utf8');
        chapterIds.forEach((cid) => {
          const body = chapterMap[cid] != null ? String(chapterMap[cid]) : '';
          fs.writeFileSync(path.join(chaptersDir, `${cid}.md`), body, 'utf8');
        });
        try {
          const existing = fs.readdirSync(chaptersDir).filter((n) => n.endsWith('.md'));
          const keep = new Set(chapterIds.map((cid) => `${cid}.md`));
          existing.forEach((n) => {
            if (!keep.has(n)) fs.unlinkSync(path.join(chaptersDir, n));
          });
        } catch (_) {}
        const meta = {
          id,
          mode: 'book',
          title: String(p.title != null ? p.title : '').slice(0, 500),
          tags,
          cover: String(p.cover != null ? p.cover : ''),
          extra: String(p.extra != null ? p.extra : ''),
          author: String(p.author != null ? p.author : '').slice(0, 200),
          coAuthors,
          remoteId: persistedRemoteId,
          assetMap,
          updatedAt: now,
        };
        fs.writeFileSync(path.join(bookRoot, BOOK_META_FILE), JSON.stringify(meta, null, 2), 'utf8');
        if (fs.existsSync(legacyJsonPath)) {
          try {
            fs.unlinkSync(legacyJsonPath);
          } catch (_) {}
        }
        return { ok: true, id };
      }

      const fp = legacyJsonPath;
      if (fs.existsSync(fp)) {
        try {
          const rawOld = fs.readFileSync(fp, 'utf8');
          const oldDraft = JSON.parse(rawOld);
          const oldRemoteId = oldDraft && typeof oldDraft.remoteId === 'string' ? oldDraft.remoteId.trim() : '';
          if (oldRemoteId) {
            persistedRemoteId = oldRemoteId;
          }
        } catch (_) {}
      }
      const draft = {
        id,
        mode: 'blog',
        title: String(p.title != null ? p.title : '').slice(0, 500),
        tags,
        cover: String(p.cover != null ? p.cover : ''),
        extra: String(p.extra != null ? p.extra : ''),
        author: String(p.author != null ? p.author : '').slice(0, 200),
        coAuthors,
        outline: outlineStr,
        content: typeof p.content === 'string' ? p.content : '',
        remoteId: persistedRemoteId,
        assetMap,
        updatedAt: now,
      };
      fs.writeFileSync(fp, JSON.stringify(draft, null, 2), 'utf8');
      return { ok: true, id };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  }
  ipcMain.handle('composeDrafts:save', async (_event, payload) => composeDraftsSaveImpl(payload));
  ipcMain.handle('composeDrafts:load', async (_event, id) => {
    try {
      if (!isSafeDraftId(id)) return { ok: false, error: '无效的草稿 id' };
      const dir = ensureComposeDraftsDir();
      const bookRoot = path.join(dir, id);
      const legacyFp = path.join(dir, `${id}.json`);
      if (fs.existsSync(bookRoot) && fs.statSync(bookRoot).isDirectory()) {
        const meta = readBookDraftMeta(bookRoot);
        if (!meta || meta.mode !== 'book') return { ok: false, error: '草稿不存在' };
        let outlineStr = '[]';
        try {
          const ofp = path.join(bookRoot, BOOK_OUTLINE_FILE);
          if (fs.existsSync(ofp)) outlineStr = fs.readFileSync(ofp, 'utf8');
        } catch (_) {}
        const chapterMap = loadBookDraftChapters(bookRoot, outlineStr);
        const chapterIds = parseOutlineForChapterIds(outlineStr);
        const contentJoined = joinBookDraftEditorContent(chapterMap, chapterIds);
        let coAuthorsLoad = [];
        if (Array.isArray(meta.coAuthors)) {
          coAuthorsLoad = meta.coAuthors
            .filter((x) => x && typeof x === 'object' && typeof x.pubkey === 'string')
            .map((x) => ({
              email: typeof x.email === 'string' ? x.email : '',
              pubkey: String(x.pubkey).trim(),
            }));
        }
        const draft = {
          id,
          mode: 'book',
          title: typeof meta.title === 'string' ? meta.title : '',
          tags: normalizeComposeTagsInput(meta.tags),
          cover: typeof meta.cover === 'string' ? meta.cover : '',
          extra: typeof meta.extra === 'string' ? meta.extra : '',
          author: typeof meta.author === 'string' ? meta.author : '',
          coAuthors: coAuthorsLoad,
          outline: outlineStr,
          content: contentJoined,
          remoteId: typeof meta.remoteId === 'string' ? meta.remoteId : '',
          assetMap: (meta && typeof meta.assetMap === 'object' && meta.assetMap) ? meta.assetMap : {},
          updatedAt: typeof meta.updatedAt === 'number' ? meta.updatedAt : 0,
        };
        return { ok: true, draft };
      }
      if (!fs.existsSync(legacyFp)) return { ok: false, error: '草稿不存在' };
      const raw = fs.readFileSync(legacyFp, 'utf8');
      const j = JSON.parse(raw);
      let coAuthorsLoad = [];
      if (Array.isArray(j.coAuthors)) {
        coAuthorsLoad = j.coAuthors
          .filter((x) => x && typeof x === 'object' && typeof x.pubkey === 'string')
          .map((x) => ({
            email: typeof x.email === 'string' ? x.email : '',
            pubkey: String(x.pubkey).trim(),
          }));
      }
      const draft = {
        id,
        mode: j.mode === 'book' ? 'book' : 'blog',
        title: typeof j.title === 'string' ? j.title : '',
        tags: normalizeComposeTagsInput(j.tags),
        cover: typeof j.cover === 'string' ? j.cover : '',
        extra: typeof j.extra === 'string' ? j.extra : '',
        author: typeof j.author === 'string' ? j.author : '',
        coAuthors: coAuthorsLoad,
        outline: typeof j.outline === 'string' ? j.outline : '',
        content: typeof j.content === 'string' ? j.content : '',
        remoteId: typeof j.remoteId === 'string' ? j.remoteId : '',
        assetMap: (j && typeof j.assetMap === 'object' && j.assetMap) ? j.assetMap : {},
        updatedAt: typeof j.updatedAt === 'number' ? j.updatedAt : 0,
      };
      return { ok: true, draft };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });
  ipcMain.handle('composeDrafts:delete', async (_event, id) => {
    try {
      if (!isSafeDraftId(id)) return { ok: false, error: '无效的草稿 id' };
      const dir = ensureComposeDraftsDir();
      const bookRoot = path.join(dir, id);
      const fp = path.join(dir, `${id}.json`);
      if (fs.existsSync(bookRoot) && fs.statSync(bookRoot).isDirectory()) {
        fs.rmSync(bookRoot, { recursive: true, force: true });
        return { ok: true };
      }
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  ipcMain.handle('compose:bookUploadDiff', async (_event, payload) => {
    try {
      const p = payload && typeof payload === 'object' ? payload : {};
      const draftId = typeof p.draftId === 'string' ? p.draftId.trim() : '';
      if (!isSafeDraftId(draftId)) return { ok: false, message: '无效的草稿 id' };
      const dir = ensureComposeDraftsDir();
      const bookRoot = path.join(dir, draftId);
      const legacyFp = path.join(dir, `${draftId}.json`);
      if (fs.existsSync(legacyFp) && (!fs.existsSync(bookRoot) || !fs.statSync(bookRoot).isDirectory())) {
        try {
          const raw = fs.readFileSync(legacyFp, 'utf8');
          const j = JSON.parse(raw);
          if (j.mode === 'book') {
            return {
              ok: true,
              isLegacyJson: true,
              message: '当前为单文件书籍草稿，请先点击「保存草稿」转为目录草稿后再上传。',
              remoteId: '',
              hasRemoteId: false,
              parts: [],
            };
          }
        } catch (_) {}
      }
      if (!fs.existsSync(bookRoot) || !fs.statSync(bookRoot).isDirectory()) {
        return { ok: false, message: '书籍目录草稿不存在，请先保存草稿' };
      }
      const metaPath = path.join(bookRoot, BOOK_META_FILE);
      if (!fs.existsSync(metaPath)) return { ok: false, message: '缺少 meta.json' };
      const meta = readBookDraftMeta(bookRoot);
      const remoteId = meta && typeof meta.remoteId === 'string' ? meta.remoteId.trim() : '';
      let outlineStr = '[]';
      try {
        const ofp = path.join(bookRoot, BOOK_OUTLINE_FILE);
        if (fs.existsSync(ofp)) outlineStr = fs.readFileSync(ofp, 'utf8');
      } catch (_) {}
      let outlineParsed = [];
      try {
        outlineParsed = JSON.parse(outlineStr.trim() || '[]');
        if (!Array.isArray(outlineParsed)) outlineParsed = [];
      } catch (_) {
        outlineParsed = [];
      }
      const chapterTitles = [];
      walkOutlineChapterTitles(outlineParsed, chapterTitles);
      const syncPath = path.join(bookRoot, BOOK_UPLOAD_SYNC_FILE);
      let sync = {};
      try {
        if (fs.existsSync(syncPath)) sync = JSON.parse(fs.readFileSync(syncPath, 'utf8'));
      } catch (_) {}
      function statMs(fp) {
        try {
          return fs.statSync(fp).mtimeMs;
        } catch (_) {
          return 0;
        }
      }
      const metaMs = statMs(metaPath);
      const outlinePath = path.join(bookRoot, BOOK_OUTLINE_FILE);
      const outlineMs = statMs(outlinePath);
      const chaptersDir = path.join(bookRoot, BOOK_CHAPTERS_DIR);
      const sm = sync.syncedMetaMtimeMs;
      const so = sync.syncedOutlineMtimeMs;
      const sc = sync.syncedChapters && typeof sync.syncedChapters === 'object' ? sync.syncedChapters : {};
      const parts = [];
      parts.push({
        partId: 'meta',
        kind: 'meta',
        label: '书籍信息（标题、封面、作者、标签等）',
        mtimeMs: metaMs,
        syncedMtimeMs: typeof sm === 'number' ? sm : 0,
        dirty: partDirtyUpload(metaMs, sm),
      });
      parts.push({
        partId: 'outline',
        kind: 'outline',
        label: '大纲',
        mtimeMs: outlineMs,
        syncedMtimeMs: typeof so === 'number' ? so : 0,
        dirty: partDirtyUpload(outlineMs, so),
      });
      chapterTitles.forEach(({ id, title }) => {
        const cfp = path.join(chaptersDir, `${id}.md`);
        const cms = statMs(cfp);
        const synced = sc[id] != null ? sc[id] : sc[String(id)];
        const syncedNum = typeof synced === 'number' ? synced : 0;
        parts.push({
          partId: `chapter:${id}`,
          kind: 'chapter',
          chapterId: id,
          label: title ? `章节：${title}` : `章节 #${id}`,
          mtimeMs: cms,
          syncedMtimeMs: syncedNum,
          dirty: partDirtyUpload(cms, syncedNum),
        });
      });
      return {
        ok: true,
        isLegacyJson: false,
        remoteId,
        hasRemoteId: Boolean(remoteId),
        parts,
      };
    } catch (e) {
      return { ok: false, message: String(e && e.message ? e.message : e) };
    }
  });

  ipcMain.handle('compose:bookUploadMarkSynced', async (_event, payload) => {
    try {
      const p = payload && typeof payload === 'object' ? payload : {};
      const draftId = typeof p.draftId === 'string' ? p.draftId.trim() : '';
      if (!isSafeDraftId(draftId)) return { ok: false, message: '无效的草稿 id' };
      const dir = ensureComposeDraftsDir();
      const bookRoot = path.join(dir, draftId);
      if (!fs.existsSync(bookRoot) || !fs.statSync(bookRoot).isDirectory()) {
        return { ok: false, message: '书籍目录不存在' };
      }
      const metaPath = path.join(bookRoot, BOOK_META_FILE);
      const outlinePath = path.join(bookRoot, BOOK_OUTLINE_FILE);
      const chaptersDir = path.join(bookRoot, BOOK_CHAPTERS_DIR);
      let outlineStr = '[]';
      try {
        if (fs.existsSync(outlinePath)) outlineStr = fs.readFileSync(outlinePath, 'utf8');
      } catch (_) {}
      const chapterIds = parseOutlineForChapterIds(outlineStr);
      function statMs(fp) {
        try {
          return fs.statSync(fp).mtimeMs;
        } catch (_) {
          return 0;
        }
      }
      const syncedChapters = {};
      chapterIds.forEach((cid) => {
        syncedChapters[cid] = statMs(path.join(chaptersDir, `${cid}.md`));
      });
      const meta = readBookDraftMeta(bookRoot);
      const remoteId = meta && typeof meta.remoteId === 'string' ? meta.remoteId.trim() : '';
      const out = {
        remoteId,
        syncedMetaMtimeMs: statMs(metaPath),
        syncedOutlineMtimeMs: statMs(outlinePath),
        syncedChapters,
        lastUploadAt: Date.now(),
      };
      fs.writeFileSync(
        path.join(bookRoot, BOOK_UPLOAD_SYNC_FILE),
        JSON.stringify(out, null, 2),
        'utf8',
      );
      return { ok: true };
    } catch (e) {
      return { ok: false, message: String(e && e.message ? e.message : e) };
    }
  });

ipcMain.handle('remoteBlogs:list', async (_event, payload) => {
  try {
    const p = payload && typeof payload === 'object' ? payload : {};
    const scope = p.scope === 'mine' ? 'mine' : 'all';
    const offset = Math.max(0, Number(p.offset) || 0);
    const limit = Math.max(1, Math.min(100, Number(p.limit) || 20));

    let syncCfg = { servers: [], activeId: null };
    if (fs.existsSync(SYNC_CONFIG_FILE)) {
      const raw = fs.readFileSync(SYNC_CONFIG_FILE, 'utf8');
      syncCfg = JSON.parse(raw);
    }
    const servers = Array.isArray(syncCfg.servers) ? syncCfg.servers : [];
    const activeId = syncCfg.activeId || (servers[0] && servers[0].id) || null;
    const activeServer = servers.find((s) => s.id === activeId) || servers[0];
    const esserver = (activeServer && activeServer.esserver) || '';
    if (!esserver) return { ok: false, message: '请先在 Sync & Servers 中配置 WebSocket 地址' };

    const identity = readIdentityForServer(activeId || 'default');
    const myPubkey = (identity.pubkeyHex && String(identity.pubkeyHex).trim())
      || (identity.pubkey && String(identity.pubkey).trim())
      || '';
    if (scope === 'mine' && !myPubkey) return { ok: false, message: '当前服务器未配置用户密钥' };

    syncEventstoreVendorConfig();
    const mod = loadEsclient();
    if (!mod || typeof mod.get_blogs !== 'function') {
      return { ok: false, message: 'esclient 缺少 get_blogs 接口' };
    }

    const getTagValue = (tags, key) => {
      if (!Array.isArray(tags)) return '';
      const t = tags.find((item) => Array.isArray(item) && item[0] === key);
      return t && t[1] ? String(t[1]) : '';
    };

    const rows = await new Promise((resolve) => {
      let done = false;
      const out = [];
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve(out);
      }, 12000);
      try {
        mod.get_blogs(scope === 'mine' ? myPubkey : null, 0, offset, limit, (message) => {
          if (done) return;
          try {
            if (message === 'EOSE') {
              done = true;
              clearTimeout(timer);
              resolve(out);
              return;
            }
            if (!message || typeof message !== 'object') return;
            const rawData = message.data;
            let data = {};
            if (typeof rawData === 'string') {
              try { data = JSON.parse(rawData); } catch (_) { data = {}; }
            } else if (rawData && typeof rawData === 'object') {
              data = rawData;
            }
            const blogId = getTagValue(message.tags, 'd') || message.id || '';
            out.push({
              id: blogId,
              user: message.user || '',
              title: data && data.title ? String(data.title) : '(无标题)',
              summary: data && (data.summary || data.extra) ? String(data.summary || data.extra) : '',
              extra: data && data.extra ? String(data.extra) : '',
              content: data && data.content ? String(data.content) : '',
              cover: data && (data.cover || data.coverUrl) ? String(data.cover || data.coverUrl) : '',
              createdAt: message.created_at || 0,
              tags: Array.isArray(data && data.tags) ? data.tags : (Array.isArray(data && data.labels) ? data.labels : []),
            });
          } catch (_) {}
        });
      } catch (_) {
        done = true;
        clearTimeout(timer);
        resolve(out);
      }
    });

    return {
      ok: true,
      rows: rows.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)),
      offset,
      limit,
      scope,
      serverId: activeId || '',
      serverName: (activeServer && activeServer.name) || '',
    };
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : String(e) };
  }
});

ipcMain.handle('remoteBooks:list', async (_event, payload) => {
  try {
    const p = payload && typeof payload === 'object' ? payload : {};
    const scope = p.scope === 'mine' ? 'mine' : 'all';
    const offset = Math.max(0, Number(p.offset) || 0);
    const limit = Math.max(1, Math.min(100, Number(p.limit) || 20));

    let syncCfg = { servers: [], activeId: null };
    if (fs.existsSync(SYNC_CONFIG_FILE)) {
      const raw = fs.readFileSync(SYNC_CONFIG_FILE, 'utf8');
      syncCfg = JSON.parse(raw);
    }
    const servers = Array.isArray(syncCfg.servers) ? syncCfg.servers : [];
    const activeId = syncCfg.activeId || (servers[0] && servers[0].id) || null;
    const activeServer = servers.find((s) => s.id === activeId) || servers[0];
    const esserver = (activeServer && activeServer.esserver) || '';
    if (!esserver) return { ok: false, message: '请先在 Sync & Servers 中配置 WebSocket 地址' };

    const identity = readIdentityForServer(activeId || 'default');
    const myPubkey = (identity.pubkeyHex && String(identity.pubkeyHex).trim())
      || (identity.pubkey && String(identity.pubkey).trim())
      || '';
    if (scope === 'mine' && !myPubkey) return { ok: false, message: '当前服务器未配置用户密钥' };

    syncEventstoreVendorConfig();
    const mod = loadEsclient();
    if (!mod || typeof mod.get_books !== 'function') {
      return { ok: false, message: 'esclient 缺少 get_books 接口' };
    }

    const getTagValue = (tags, key) => {
      if (!Array.isArray(tags)) return '';
      const t = tags.find((item) => Array.isArray(item) && item[0] === key);
      return t && t[1] ? String(t[1]) : '';
    };

    const outlineToString = (raw) => {
      if (raw == null || raw === '') return '';
      if (typeof raw === 'string') return raw;
      try {
        return JSON.stringify(raw, null, 2);
      } catch (_) {
        return '[]';
      }
    };

    const rows = await new Promise((resolve) => {
      let done = false;
      const out = [];
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve(out);
      }, 12000);
      try {
        mod.get_books(scope === 'mine' ? myPubkey : null, offset, limit, (message) => {
          if (done) return;
          try {
            if (message === 'EOSE') {
              done = true;
              clearTimeout(timer);
              resolve(out);
              return;
            }
            if (!message || typeof message !== 'object') return;
            const rawData = message.data;
            let data = {};
            if (typeof rawData === 'string') {
              try { data = JSON.parse(rawData); } catch (_) { data = {}; }
            } else if (rawData && typeof rawData === 'object') {
              data = rawData;
            }
            const bookId = getTagValue(message.tags, 'd') || message.id || '';
            const coAuthorPubkeysRemote = Array.isArray(data && data.coAuthors)
              ? data.coAuthors.map((x) => String(x || '').trim()).filter(Boolean)
              : [];
            out.push({
              id: bookId,
              user: message.user || '',
              title: data && data.title ? String(data.title) : '(无标题)',
              author: data && data.author ? String(data.author) : '',
              summary: data && (data.summary || data.extra) ? String(data.summary || data.extra) : '',
              extra: data && data.extra ? String(data.extra) : '',
              content: data && data.content ? String(data.content) : '',
              cover: bookEventstoreMap.coverFilenameFromRemoteBookData(data),
              coverImgurl: data && data.coverImgurl != null ? String(data.coverImgurl).trim() : '',
              /** 仅 create_book.data 内嵌大纲时的兜底；规范大纲在章节 outline.md，见 remoteBooks:getOutline */
              outline: outlineToString(data && data.outline),
              createdAt: message.created_at || 0,
              tags: bookEventstoreMap.tagsFromRemoteBookData(data),
              coAuthorPubkeys: coAuthorPubkeysRemote,
            });
          } catch (_) {}
        });
      } catch (_) {
        done = true;
        clearTimeout(timer);
        resolve(out);
      }
    });

    return {
      ok: true,
      rows: rows.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)),
      offset,
      limit,
      scope,
      serverId: activeId || '',
      serverName: (activeServer && activeServer.name) || '',
    };
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : String(e) };
  }
});

/** 与 eventstoreUI viewbooks/[bookId]/+page.server.js 一致：大纲 JSON 在章节 outline.md，非 create_book.data.outline */
ipcMain.handle('remoteBooks:getOutline', async (_event, payload) => {
  try {
    const p = payload && typeof payload === 'object' ? payload : {};
    const bookId = String(p.bookId || '').trim();
    const authorPubkey = String(p.authorPubkey || '').trim();
    if (!bookId) return { ok: false, message: '缺少 bookId' };
    if (!authorPubkey) return { ok: false, message: '缺少书籍作者公钥（eventuser）' };

    syncEventstoreVendorConfig();
    const mod = loadEsclient();
    if (!mod || typeof mod.get_chapter_author !== 'function') {
      return { ok: false, message: 'esclient 缺少 get_chapter_author' };
    }

    const outlineName = bookEventstoreMap.OUTLINE_CHAPTER_NAME || 'outline.md';

    const outlineRaw = await fetchChapterTextOnce(mod, bookId, outlineName, authorPubkey, 15000);

    let outline = '[]';
    if (outlineRaw) {
      try {
        const j = JSON.parse(outlineRaw);
        outline = JSON.stringify(Array.isArray(j) ? j : [], null, 2);
      } catch (_) {
        outline = '[]';
      }
    }

    return { ok: true, outline, hadRaw: Boolean(outlineRaw && outlineRaw.trim()) };
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : String(e) };
  }
});

/** 按 eventstoreUI：get_book_id → outline.md → 各章节 get_chapter_author；进度通过 remoteBooks:downloadProgress 推送 */
ipcMain.handle('remoteBooks:downloadBook', async (event, payload) => {
  const send = (data) => {
    try {
      if (event.sender && !event.sender.isDestroyed()) {
        event.sender.send('remoteBooks:downloadProgress', data);
      }
    } catch (_) {}
  };
  try {
    const p = payload && typeof payload === 'object' ? payload : {};
    const bookId = String(p.bookId || '').trim();
    const authorPubkey = String(p.authorPubkey || '').trim();
    const row = p.row && typeof p.row === 'object' ? p.row : {};
    const stableIdRaw = typeof p.stableId === 'string' ? p.stableId.trim() : '';
    if (!bookId) return { ok: false, message: '缺少 bookId' };
    if (!authorPubkey) return { ok: false, message: '缺少作者公钥' };

    syncEventstoreVendorConfig();
    const mod = loadEsclient();
    if (!mod || typeof mod.get_chapter_author !== 'function' || typeof mod.get_book_id !== 'function') {
      return { ok: false, message: 'esclient 缺少 get_chapter_author / get_book_id' };
    }

    const outlineChapterName = bookEventstoreMap.OUTLINE_CHAPTER_NAME || 'outline.md';

    let activeServerId = '';
    try {
      let syncCfg = { servers: [], activeId: null };
      if (fs.existsSync(SYNC_CONFIG_FILE)) {
        syncCfg = JSON.parse(fs.readFileSync(SYNC_CONFIG_FILE, 'utf8'));
      }
      const servers = Array.isArray(syncCfg.servers) ? syncCfg.servers : [];
      activeServerId = syncCfg.activeId || (servers[0] && servers[0].id) || '';
    } catch (_) {}

    send({ phase: 'book', status: 'loading', label: '正在获取书籍信息…' });
    const bookMsg = await fetchBookEventOnce(mod, bookId);
    let data = {};
    if (bookMsg && bookMsg.data) {
      const rawData = bookMsg.data;
      if (typeof rawData === 'string') {
        try { data = JSON.parse(rawData); } catch (_) { data = {}; }
      } else if (rawData && typeof rawData === 'object') {
        data = rawData;
      }
    }
    const title = (data.title != null && String(data.title).trim())
      ? String(data.title).trim()
      : (row.title ? String(row.title).trim() : '');
    const author = (data.author != null && String(data.author).trim())
      ? String(data.author).trim()
      : (row.author ? String(row.author).trim() : '');
    const dataForCover = { ...data };
    if (!bookEventstoreMap.coverFilenameFromRemoteBookData(dataForCover)) {
      if (row.coverImgurl) dataForCover.coverImgurl = row.coverImgurl;
      if (row.cover) dataForCover.cover = row.cover;
    }
    const cover = bookEventstoreMap.coverFilenameFromRemoteBookData(dataForCover);
    const extra = (data.extra != null && String(data.extra).trim())
      ? String(data.extra).trim()
      : (row.extra ? String(row.extra).trim() : (row.summary ? String(row.summary).trim() : ''));
    const tagsMerged = bookEventstoreMap.tagsFromRemoteBookData(data);
    const tags = tagsMerged.length ? tagsMerged : (Array.isArray(row.tags) ? row.tags.map((x) => String(x || '').trim()).filter(Boolean) : []);
    let coAuthors = [];
    if (Array.isArray(row.coAuthorPubkeys) && row.coAuthorPubkeys.length) {
      coAuthors = row.coAuthorPubkeys.map((pk) => ({
        email: '',
        pubkey: String(pk || '').trim(),
      })).filter((x) => x.pubkey);
    } else if (Array.isArray(data.coAuthors)) {
      coAuthors = data.coAuthors.map((pk) => ({
        email: '',
        pubkey: String(pk || '').trim(),
      })).filter((x) => x.pubkey);
    }
    send({ phase: 'book', status: 'done', label: '书籍信息' });

    send({ phase: 'outline', status: 'loading', label: '正在获取大纲（outline.md）…' });
    let outlineRaw = await fetchChapterTextOnce(mod, bookId, outlineChapterName, authorPubkey, 20000);
    if (!String(outlineRaw || '').trim() && row.outline) {
      outlineRaw = String(row.outline);
    }
    let outlineStr = '[]';
    if (outlineRaw) {
      try {
        const j = JSON.parse(outlineRaw);
        outlineStr = JSON.stringify(Array.isArray(j) ? j : [], null, 2);
      } catch (_) {
        outlineStr = '[]';
      }
    }
    let outlineArr = [];
    try {
      outlineArr = JSON.parse(outlineStr);
    } catch (_) {
      outlineArr = [];
    }
    send({ phase: 'outline', status: 'done', label: '大纲' });

    const chapterIds = parseOutlineForChapterIds(outlineStr);
    const chapterMap = {};
    const totalCh = chapterIds.length;
    for (let i = 0; i < chapterIds.length; i++) {
      const cid = chapterIds[i];
      const chapterTitle = findChapterTitleInOutlineTree(Array.isArray(outlineArr) ? outlineArr : [], cid);
      send({
        phase: 'chapter',
        status: 'loading',
        label: chapterTitle ? `正在下载章节 ${cid}「${chapterTitle}」` : `正在下载章节 ${cid}`,
        index: i + 1,
        total: totalCh,
      });
      const body = await fetchChapterTextOnce(mod, bookId, String(cid), authorPubkey, 20000);
      chapterMap[cid] = body != null ? String(body) : '';
      send({
        phase: 'chapter',
        status: 'done',
        label: chapterTitle ? `已下载：${chapterTitle}` : `已下载章节 ${cid}`,
        index: i + 1,
        total: totalCh,
      });
    }

    const identity = readIdentityForServer(activeServerId || 'default');
    const myHex = String(identity.pubkeyHex || identity.pubkey || '').trim().toLowerCase().replace(/^0x/, '');
    const authorHex = authorPubkey.trim().toLowerCase().replace(/^0x/, '');
    let remoteIdToSave = '';
    if (bookId && myHex && authorHex && myHex === authorHex) remoteIdToSave = bookId;

    const contentJoined = joinBookDraftEditorContent(chapterMap, chapterIds);
    const savePayload = {
      mode: 'book',
      title: title || '（无标题）',
      author: author || '远程',
      tags,
      cover,
      extra,
      coAuthors,
      remoteId: remoteIdToSave,
      outline: outlineStr,
      chapterContents: chapterMap,
      content: contentJoined,
      assetMap: {},
    };
    if (stableIdRaw && isSafeDraftId(stableIdRaw)) savePayload.id = stableIdRaw;

    send({ phase: 'save', status: 'loading', label: '正在写入本地草稿…' });
    const saveRes = await composeDraftsSaveImpl(savePayload);
    send({
      phase: 'save',
      status: saveRes && saveRes.ok ? 'done' : 'error',
      label: (saveRes && saveRes.ok) ? '已保存到本地草稿箱' : ((saveRes && saveRes.error) || '保存失败'),
    });
    return saveRes;
  } catch (e) {
    send({ phase: 'error', status: 'error', label: String(e && e.message ? e.message : e) });
    return { ok: false, message: e && e.message ? e.message : String(e) };
  }
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
