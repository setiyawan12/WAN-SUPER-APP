'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, shell } = require('electron');

let mindmapWindow = null;
let initialized = false;

function configPath() {
  return path.join(app.getPath('userData'), 'firebase-config.json');
}

function loadFirebaseConfig() {
  const raw = process.env.WANN_FIREBASE_CONFIG;
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  try {
    const file = configPath();
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  } catch {
    return null;
  }
}

function rendererUrl() {
  return process.env.VITE_DEV_SERVER_URL_MINDMAP || null;
}

function rendererFile() {
  return path.join(__dirname, '../renderer/index.html');
}

function preloadFile() {
  return path.join(__dirname, '../preload/index.cjs');
}

function isInternalRendererUrl(url) {
  try {
    const target = new URL(url);
    const devUrl = rendererUrl();
    if (devUrl) return target.origin === new URL(devUrl).origin;
    if (target.protocol !== 'file:') return false;
    const rendererDir = path.resolve(__dirname, '../renderer');
    const targetPath = path.resolve(decodeURIComponent(target.pathname));
    return targetPath === rendererDir || targetPath.startsWith(`${rendererDir}${path.sep}`);
  } catch {
    return false;
  }
}

function loadContent(win) {
  const devUrl = rendererUrl();
  if (devUrl) return win.loadURL(devUrl);
  return win.loadFile(rendererFile());
}

function secureWindow(win) {
  win.webContents.on('will-navigate', (event, url) => {
    if (!isInternalRendererUrl(url)) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) void shell.openExternal(url);
    return { action: 'deny' };
  });
}

function initMindmap() {
  if (initialized) return;
  initialized = true;
  if (!ipcMain.listenerCount('mindmap:getConfig')) {
    ipcMain.handle('mindmap:getConfig', () => {
      const config = loadFirebaseConfig();
      return {
        configured: !!(config?.apiKey && config?.projectId && config?.appId),
        config,
        configPath: configPath(),
      };
    });
  }
  if (!ipcMain.listenerCount('mindmap:reload')) {
    ipcMain.handle('mindmap:reload', (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) return false;
      win.webContents.reload();
      return true;
    });
  }
}

function openMindmapWindow() {
  initMindmap();
  if (mindmapWindow && !mindmapWindow.isDestroyed()) {
    if (mindmapWindow.isMinimized()) mindmapWindow.restore();
    mindmapWindow.show();
    mindmapWindow.focus();
    return mindmapWindow;
  }

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: '#090b0d',
    title: 'WAN Mindmap',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: preloadFile(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
      additionalArguments: ['--wan-super-app-embed'],
    },
  });

  secureWindow(win);
  win.setMenuBarVisibility(false);
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (mindmapWindow === win) mindmapWindow = null;
  });
  mindmapWindow = win;
  void loadContent(win);
  return win;
}

function attachMindmapWindow(win) {
  initMindmap();
  if (!win || win.isDestroyed()) return;
  secureWindow(win);
  void loadContent(win);
  if (!win.isVisible()) win.show();
  win.focus();
}

function hideMindmapWindow() {
  if (mindmapWindow && !mindmapWindow.isDestroyed()) mindmapWindow.hide();
}

function shutdownMindmap() {
  if (mindmapWindow && !mindmapWindow.isDestroyed()) {
    mindmapWindow.removeAllListeners('close');
    mindmapWindow.destroy();
  }
  mindmapWindow = null;
}

function getMindmapStatus() {
  const config = loadFirebaseConfig();
  return {
    running: !!(mindmapWindow && !mindmapWindow.isDestroyed()),
    cloud: !!(config?.apiKey && config?.projectId && config?.appId),
    storage: config ? 'firebase' : 'local',
  };
}

module.exports = {
  initMindmap,
  openMindmapWindow,
  attachMindmapWindow,
  hideMindmapWindow,
  shutdownMindmap,
  getMindmapStatus,
};