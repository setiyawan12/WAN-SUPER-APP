'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const http = require('node:http');
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

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function googleIdTokenViaLoopback(clientId, clientSecret) {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64url(crypto.randomBytes(16));

  return new Promise((resolve, reject) => {
    const server = http.createServer();
    let settled = false;
    const timer = setTimeout(
      () => finish(() => reject(new Error('Login Google kedaluwarsa (timeout 3 menit).'))),
      180_000,
    );

    function finish(callback) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        server.close();
      } catch {
        // Server may already be closed after an OAuth failure.
      }
      callback();
    }

    function sendPage(response, status, title, message) {
      response.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(
        '<!doctype html><meta charset="utf-8"><title>' + title + '</title>' +
          '<body style="font-family:system-ui;background:#0d1016;color:#eaeef7;display:grid;place-items:center;height:100vh;margin:0">' +
          '<div style="text-align:center"><h2>' + title + '</h2><p style="color:#9aa5bd">' + message + '</p></div></body>',
      );
    }

    server.on('request', async (request, response) => {
      try {
        const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
        if (!requestUrl.searchParams.has('code') && !requestUrl.searchParams.has('error')) {
          response.writeHead(404).end();
          return;
        }

        const oauthError = requestUrl.searchParams.get('error');
        if (oauthError) {
          sendPage(response, 400, 'Login dibatalkan', 'Silakan kembali ke WAN Mindmap.');
          finish(() => reject(new Error(`Google menolak login: ${oauthError}`)));
          return;
        }
        if (requestUrl.searchParams.get('state') !== state) {
          sendPage(response, 400, 'Login gagal', 'State OAuth tidak cocok.');
          finish(() => reject(new Error('State OAuth tidak cocok (kemungkinan CSRF).')));
          return;
        }

        const code = requestUrl.searchParams.get('code');
        if (!code) {
          sendPage(response, 400, 'Login gagal', 'Authorization code tidak ditemukan.');
          finish(() => reject(new Error('Tidak ada authorization code.')));
          return;
        }

        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        const body = new URLSearchParams({
          code,
          client_id: clientId,
          redirect_uri: `http://127.0.0.1:${port}`,
          grant_type: 'authorization_code',
          code_verifier: verifier,
        });
        if (clientSecret) body.set('client_secret', clientSecret);

        const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        });
        const token = await tokenResponse.json();
        if (!tokenResponse.ok || !token.id_token) {
          const detail = token.error_description || token.error || tokenResponse.status;
          sendPage(response, 502, 'Login gagal', 'Token Google tidak dapat diproses.');
          finish(() => reject(new Error(`Tukar token gagal: ${detail}`)));
          return;
        }

        sendPage(response, 200, 'Login berhasil', 'Silakan kembali ke WAN Mindmap. Tab ini boleh ditutup.');
        finish(() => resolve(token.id_token));
      } catch (error) {
        if (!response.headersSent) {
          sendPage(response, 500, 'Login gagal', 'Terjadi kesalahan saat memproses login Google.');
        }
        finish(() => reject(error));
      }
    });

    server.on('error', (error) => finish(() => reject(error)));
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('redirect_uri', `http://127.0.0.1:${port}`);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', 'openid email profile');
      authUrl.searchParams.set('code_challenge', challenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      authUrl.searchParams.set('state', state);
      authUrl.searchParams.set('prompt', 'select_account');
      void shell.openExternal(authUrl.href).catch((error) => finish(() => reject(error)));
    });
  });
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
  if (!ipcMain.listenerCount('mindmap:signInGoogle')) {
    ipcMain.handle('mindmap:signInGoogle', async () => {
      const config = loadFirebaseConfig();
      if (!config?.googleClientId) {
        throw new Error(
          'Google sign-in desktop belum dikonfigurasi. Tambahkan "googleClientId" dari OAuth 2.0 Client ID tipe Desktop app ke firebase-config.json.',
        );
      }
      const idToken = await googleIdTokenViaLoopback(config.googleClientId, config.googleClientSecret);
      return { idToken };
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