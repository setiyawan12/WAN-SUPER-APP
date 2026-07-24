'use strict';

/**
 * electron/main.js — WAN NET (Electron wrapper)
 *
 * Main window = launcher dashboard (electron/launcher.html)
 * User starts tunnels on-demand; Cloudflare URL appears when ready.
 */

const {
  app, BrowserWindow, Tray, Menu, nativeImage,
  ipcMain, Notification, shell, clipboard,
} = require('electron');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const QRCode  = require('qrcode');
// electron-updater may not be installed yet (npm install required after adding dependency)
let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch {}

// ── Linux sandbox workaround ──────────────────────────────────────────────────
if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');

// ── Paths ─────────────────────────────────────────────────────────────────────
const ROOT      = path.join(__dirname, '..');
const CFG_FILE  = path.join(app.getPath('userData'), 'wan-net-cfg.json');
const ICON_FILE = path.join(__dirname, 'icon.png');

// ── Default config ────────────────────────────────────────────────────────────
// routes: flat array { tunnelId, tunnelName, hostname, port }
const DEFAULT_CFG = { pass: '', autoStart: [], labels: {}, domains: {}, routes: [] };

// ── Runtime state ─────────────────────────────────────────────────────────────
let _cfg         = DEFAULT_CFG;
let _inspPort    = 0;
let _tray        = null;
let _launcherWin = null;
let _settingsWin = null;
let _isQuitting  = false;

/**
 * Per-tunnel tracking (keyed by localPort number):
 * { localPort, tunnelPort, clientPort, tunnelSrv, clientSrv, client, cfProc,
 *   status: 'starting'|'live'|'stopped', url: string|null }
 */
const _tunnelMap = new Map();

// ── Load wan-net modules ──────────────────────────────────────────────────────
const state      = require(path.join(ROOT, 'lib/state'));
const { findFreePort }       = require(path.join(ROOT, 'lib/utils'));
const { createTunnelServer, attachWebSocketProxy } = require(path.join(ROOT, 'lib/tunnel-server'));
const { createClientServer } = require(path.join(ROOT, 'lib/client-server'));
const inspectorServer        = require(path.join(ROOT, 'lib/inspector-server'));
const { createClient }       = require(path.join(ROOT, 'lib/tunnel-client'));
const cloudflared            = require(path.join(ROOT, 'lib/cloudflared'));
const persist                = require(path.join(ROOT, 'lib/persist'));
const registerCFHandlers = require('./cf-manager');


// ── Config helpers ────────────────────────────────────────────────────────────
function loadConfig() {
  try {
    if (fs.existsSync(CFG_FILE)) {
      return { ...DEFAULT_CFG, ...JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) };
    }
  } catch (e) { console.warn('Config parse error:', e.message); }
  return { ...DEFAULT_CFG };
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(CFG_FILE), { recursive: true });
    fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2));
    return true;
  } catch (e) { console.error('Config save error:', e.message); return false; }
}

// ── Push tunnel state to launcher window ─────────────────────────────────────
function pushUpdate() {
  if (!_launcherWin || _launcherWin.isDestroyed()) return;
  _launcherWin.webContents.send('tunnel-update', _snapshotTunnels());
  refreshTray();
}

function _snapshotTunnels() {
  const labels    = _cfg.labels    || {};
  const autoStart = _cfg.autoStart || [];
  return [..._tunnelMap.values()].map(t => ({
    tunnelKey   : t.tunnelKey,
    localPort   : t.localPort,
    staticHost  : t.staticHost,
    displayName : t.displayName,
    status      : t.status,
    url         : t.url,
    inspUrl     : `http://localhost:${_inspPort}`,
    startedAt      : t.startedAt || null,
    label          : labels[t.tunnelKey] || null,
    autoStart      : autoStart.includes(t.tunnelKey),
    reconnectCount : t.reconnectCount || 0,
    urlHistory     : t.urlHistory || [],
    customDomain   : t.customDomain || null,
    tunnelId       : t.tunnelId || null,
    rateLimit      : state.tunnels.get(t.tunnelKey)?.rateLimit || null,
  }));
}

// ── Dynamic tunnel: start ─────────────────────────────────────────────────────
async function startTunnel(localPort, opts = {}) {
  // tunnelKey: string identifier — hostname for static host, stringified port otherwise
  const tunnelKey   = opts.staticHost ? opts.staticHost : String(localPort);
  const displayName = opts.staticHost ? opts.staticHost : `:${localPort}`;

  if (_tunnelMap.has(tunnelKey)) {
    const t = _tunnelMap.get(tunnelKey);
    if (t.status !== 'stopped') return { ok: false, error: `${displayName} sudah berjalan` };
    // stopped → restart (preserve opts from existing entry if not overridden)
    if (!opts.staticHost && !opts.customDomain && t.customDomain) {
      opts = { customDomain: t.customDomain, tunnelId: t.tunnelId };
    }
    _tunnelMap.delete(tunnelKey);
    state.tunnels.delete(tunnelKey);
  }

  const tunnelPort = await findFreePort(3000);
  const clientPort = await findFreePort(4040);

  const entry = {
    tunnelKey, displayName,
    localPort   : opts.staticHost ? null : localPort,
    staticHost  : opts.staticHost || null,
    tunnelPort, clientPort,
    tunnelSrv: null, clientSrv: null, client: null, cfProc: null,
    status: 'starting', url: null,
    startedAt: Date.now(),
    reconnectCount: 0,
    urlHistory: [],
    customDomain : opts.customDomain || null,
    tunnelId     : opts.tunnelId     || null,
  };
  _tunnelMap.set(tunnelKey, entry);
  state.tunnels.set(tunnelKey, { clientSSE: null, pending: new Map(), tunnelPort, publicUrl: null });

  // Persist domain config
  if (opts.customDomain && opts.tunnelId) {
    if (!_cfg.domains) _cfg.domains = {};
    _cfg.domains[tunnelKey] = { customDomain: opts.customDomain, tunnelId: opts.tunnelId };
    saveConfig(_cfg);
  }

  // Start servers
  entry.tunnelSrv = createTunnelServer(tunnelKey);
  attachWebSocketProxy(entry.tunnelSrv, tunnelKey, localPort);
  entry.clientSrv = createClientServer(tunnelKey);

  await new Promise(r =>
    entry.tunnelSrv.listen(tunnelPort, () => entry.clientSrv.listen(clientPort, r))
  );

  // Connect tunnel client
  entry.client = createClient();
  entry.client.connect({ localPort, serverHost: 'localhost', clientPort, staticHost: opts.staticHost });

  // Spawn cloudflared
  _attachCloudflared(tunnelKey, tunnelPort, opts);

  pushUpdate();
  return { ok: true };
}

/**
 * Spawn (or re-spawn) cloudflared for a tunnel entry.
 * Handles crash detection and auto-restart with exponential backoff.
 * opts: { customDomain?, tunnelId? } — if set, uses named tunnel instead of Quick Tunnel.
 */
function _attachCloudflared(tunnelKey, tunnelPort, opts = {}, retryDelay = 3000) {
  const t = _tunnelMap.get(tunnelKey);
  if (!t || t.status === 'stopped') return;

  const onURL = url => {
    const entry = _tunnelMap.get(tunnelKey);
    if (!entry || entry.status === 'stopped') return;

    entry.status = 'live';
    entry.url    = url;
    if (!entry.urlHistory.includes(url)) entry.urlHistory.push(url);
    state.tunnels.get(tunnelKey).publicUrl = url;

    if (!_cfg.autoStart.includes(tunnelKey)) {
      _cfg.autoStart.push(tunnelKey);
      saveConfig(_cfg);
    }

    pushUpdate();
    console.log(`✅ ${t.displayName} → ${url}`);

    if (Notification.isSupported()) {
      new Notification({
        title: 'WAN NET — Tunnel Ready',
        body : `${t.displayName} → ${url}`,
        icon : ICON_FILE,
      }).show();
    }
  };

  const cfProc = (opts.customDomain && opts.tunnelId)
    ? cloudflared.startNamedTunnel(opts.tunnelId, tunnelPort, opts.customDomain, onURL, _cfEnv())
    : cloudflared.startTunnel(tunnelPort, onURL);

  t.cfProc = cfProc;

  cfProc.stderr?.on('data', chunk => {
    const text = chunk.toString();
    if (!text.includes('trycloudflare.com') && !text.includes(opts.customDomain)) {
      process.stdout.write(`[cf:${tunnelKey}] ${text}`);
    }
  });

  cfProc.on('close', (code, signal) => {
    const entry = _tunnelMap.get(tunnelKey);
    if (!entry || entry.status === 'stopped') return;

    entry.reconnectCount++;
    console.warn(`⚠  ${t.displayName} cloudflared exited (code=${code} signal=${signal}) — retry in ${retryDelay / 1000}s [#${entry.reconnectCount}]`);
    entry.status = 'reconnecting';
    entry.url    = null;
    pushUpdate();

    const next = Math.min(retryDelay * 2, 30_000);
    setTimeout(() => _attachCloudflared(tunnelKey, tunnelPort, opts, next), retryDelay);
  });
}

// ── Dynamic tunnel: stop ──────────────────────────────────────────────────────
function stopTunnel(tunnelKey) {
  const t = _tunnelMap.get(tunnelKey);
  if (!t) return { ok: false, error: 'Tunnel tidak ditemukan' };

  t.status = 'stopped';
  t.url    = null;
  state.tunnels.delete(tunnelKey);

  try { t.cfProc?.kill(); }       catch {}
  try { t.client?.disconnect(); } catch {}
  try { t.clientSrv?.close(); }   catch {}
  try { t.tunnelSrv?.close(); }   catch {}

  _cfg.autoStart = (_cfg.autoStart || []).filter(k => k !== tunnelKey);
  saveConfig(_cfg);

  pushUpdate();
  return { ok: true };
}

// ── Launcher (main) window ────────────────────────────────────────────────────

/**
 * Show the launcher window safely.
 * On macOS, hiding + re-showing a BrowserWindow can leave the renderer
 * suspended (black screen). Fix: call webContents.invalidate() after show
 * so the GPU compositing pipeline repaints the frame.
 */
function _showLauncherWin() {
  if (!_launcherWin || _launcherWin.isDestroyed()) {
    createLauncherWindow();
    return;
  }
  if (_launcherWin.isMinimized()) _launcherWin.restore();
  _launcherWin.show();
  _launcherWin.focus();
  // Force repaint — fixes macOS black window after hide/show
  if (process.platform === 'darwin') {
    setTimeout(() => {
      if (_launcherWin && !_launcherWin.isDestroyed()) {
        _launcherWin.webContents.invalidate();
      }
    }, 50);
  }
}

function createLauncherWindow() {
  _launcherWin = new BrowserWindow({
    width          : 760,
    height         : 560,
    minWidth       : 600,
    minHeight      : 420,
    fullscreen     : true,
    title          : 'WAN Super App — NET',
    icon           : ICON_FILE,
    backgroundColor: '#0a0b14',
    webPreferences : {
      nodeIntegration : false,
      contextIsolation: true,
      preload         : path.join(__dirname, 'launcher-preload.js'),
    },
    show: false,
  });

  _launcherWin.setMenuBarVisibility(false);
  _launcherWin.once('ready-to-show', () => _launcherWin.show());
  _launcherWin.on('close', e => {
    if (!_isQuitting) {
      e.preventDefault();
      _launcherWin.hide();
      // Remove from Dock while hidden (tray-only mode) — standalone only
      if (!process.env.WAN_SUPER_APP_EMBED && process.platform === 'darwin') app.dock?.hide();
    }
  });

  _launcherWin.loadFile(path.join(__dirname, 'launcher.html'));
}

// ── Settings window ───────────────────────────────────────────────────────────
function openSettings() {
  if (_settingsWin && !_settingsWin.isDestroyed()) { _settingsWin.focus(); return; }
  _settingsWin = new BrowserWindow({
    width : 440, height: 320,
    title : 'WAN NET Settings',
    icon  : ICON_FILE,
    resizable      : false,
    backgroundColor: '#0a0b14',
    parent  : _launcherWin || undefined,
    modal   : false,
    webPreferences: {
      nodeIntegration : false,
      contextIsolation: true,
      preload         : path.join(__dirname, 'preload.js'),
    },
  });
  _settingsWin.setMenuBarVisibility(false);
  _settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  _settingsWin.on('closed', () => { _settingsWin = null; });
}

// ── Tray ──────────────────────────────────────────────────────────────────────
function buildTrayMenu() {
  const tunnelItems = [..._tunnelMap.values()]
    .filter(t => t.status === 'live')
    .map(t => ({
      label  : `${t.displayName}  →  ${t.url}`,
      click  : () => { if (t.url) shell.openExternal(t.url); },
    }));

  return Menu.buildFromTemplate([
    { label: '⚡ WAN NET', enabled: false },
    { type: 'separator' },
    {
      label: 'Buka Dashboard',
      click: () => _showLauncherWin(),
    },
    ...(tunnelItems.length ? [{ type: 'separator' }, ...tunnelItems] : []),
    { type: 'separator' },
    { label: 'Settings…', click: openSettings },
    { label: 'Check for Update…', click: () => {
        _showLauncherWin();
        if (_launcherWin && !_launcherWin.isDestroyed())
          _launcherWin.webContents.send('trigger-check-update');
    }},
    { type: 'separator' },
    { label: 'Keluar', click: () => { _isQuitting = true; app.quit(); } },
  ]);
}

function createTray() {
  const trayIcon = nativeImage.createFromPath(ICON_FILE).resize({ width: 16, height: 16 });
  trayIcon.setTemplateImage(true); // macOS: ikuti warna menu bar (light/dark)
  _tray = new Tray(trayIcon);
  _tray.setToolTip('WAN NET');
  _tray.setContextMenu(buildTrayMenu());
  _tray.on('click', () => _showLauncherWin());
}

function refreshTray() {
  if (_tray && !_tray.isDestroyed()) _tray.setContextMenu(buildTrayMenu());
  // Super App shell owns the global tray; module still pushes tunnel snapshot to UI.
}

// ── Inspector server init ─────────────────────────────────────────────────────
async function startInspector() {
  await cloudflared.ensureCloudflared();
  _inspPort       = await findFreePort(4040);
  state.INSP_PORT = _inspPort;
  if (_cfg.pass) process.env.INSPECTOR_PASS = _cfg.pass;

  await new Promise(r => inspectorServer.listen(_inspPort, r));
  persist.load();
  console.log(`▶  Inspector → http://localhost:${_inspPort}`);
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function cleanup() {
  persist.saveSync();
  for (const t of _tunnelMap.values()) {
    try { t.cfProc?.kill(); }       catch {}
    try { t.client?.disconnect(); } catch {}
    try { t.clientSrv?.close(); }   catch {}
    try { t.tunnelSrv?.close(); }   catch {}
  }
  try { inspectorServer.close(); } catch {}
}

// ── IPC handlers ──────────────────────────────────────────────────────────────
ipcMain.handle('start-tunnel', (_e, port, opts) => {
  if (opts?.staticHost) return startTunnel(0, opts);
  return startTunnel(Number(port), opts || {});
});
ipcMain.handle('stop-tunnel',   (_e, key) => stopTunnel(key));
ipcMain.handle('delete-tunnel', (_e, key) => {
  stopTunnel(key);
  _tunnelMap.delete(key);
  if (_cfg.domains) delete _cfg.domains[key];
  if (_cfg.labels)  delete _cfg.labels[key];
  _cfg.autoStart = (_cfg.autoStart || []).filter(k => k !== key);
  saveConfig(_cfg);
  pushUpdate();
  return { ok: true };
});
ipcMain.handle('delete-all-tunnels', () => {
  for (const key of [..._tunnelMap.keys()]) stopTunnel(key);
  _tunnelMap.clear();
  _cfg.autoStart = [];
  saveConfig(_cfg);
  pushUpdate();
  return { ok: true };
});
ipcMain.handle('list-tunnels',  ()          => _snapshotTunnels());
ipcMain.handle('get-insp-port', ()          => _inspPort);
ipcMain.handle('get-version',  ()          => app.getVersion());
ipcMain.handle('open-inspector',()          => _showLauncherWin());
ipcMain.handle('open-external', (_e, url)  => shell.openExternal(url));
ipcMain.handle('open-settings', ()          => openSettings());
ipcMain.handle('copy-text',     (_e, text) => { clipboard.writeText(text); return true; });
ipcMain.handle('show-notification', (_e, title, body) => {
  if (!Notification.isSupported()) return;
  new Notification({ title: String(title), body: String(body), icon: ICON_FILE }).show();
});
ipcMain.handle('generate-qr', async (_e, url) => {
  try {
    return await QRCode.toDataURL(url, { width: 256, margin: 2,
      color: { dark: '#000000', light: '#ffffff' } });
  } catch { return null; }
});
ipcMain.handle('set-label', (_e, key, label) => {
  if (!_cfg.labels) _cfg.labels = {};
  if (label && label.trim()) _cfg.labels[key] = label.trim();
  else delete _cfg.labels[key];
  saveConfig(_cfg);
  pushUpdate();
  return { ok: true };
});
ipcMain.handle('install-update', () => {
  if (!app.isPackaged) {
    console.warn('[updater] quitAndInstall skip — dev mode');
    return;
  }
  try {
    _isQuitting = true;   // ← izinkan window benar-benar close
    cleanup();
    autoUpdater?.quitAndInstall(false, true); // isSilent=false, isForceRunAfter=true
  } catch (e) {
    console.warn('[updater] quitAndInstall error:', e.message);
    _isQuitting = false;
  }
});
ipcMain.handle('set-rate-limit', (_e, key, maxReq, windowMs) => {
  const tunnel = state.tunnels.get(key);
  if (!tunnel) return { ok: false, error: 'Tunnel not found' };
  if (!maxReq || maxReq <= 0) {
    tunnel.rateLimit  = null;
    tunnel.rateWindow = [];
  } else {
    tunnel.rateLimit = { maxReq: Number(maxReq), windowMs: Number(windowMs) || 1000 };
    if (!tunnel.rateWindow) tunnel.rateWindow = [];
  }
  pushUpdate();
  return { ok: true };
});
ipcMain.handle('toggle-autostart', (_e, key) => {
  const arr = _cfg.autoStart || [];
  _cfg.autoStart = arr.includes(key) ? arr.filter(k => k !== key) : [...arr, key];
  saveConfig(_cfg);
  pushUpdate();
  return { ok: true, enabled: _cfg.autoStart.includes(key) };
});
// ── Cloudflare credential helper ─────────────────────────────────────────────
function _cfEnv() {
  if (_cfg.cfApiToken && _cfg.cfAccountId) {
    return {
      ...process.env,
      CLOUDFLARE_API_TOKEN : _cfg.cfApiToken,
      CLOUDFLARE_ACCOUNT_ID: _cfg.cfAccountId,
    };
  }
  return process.env;
}

// ── Cloudflare IPC handlers (see electron/cf-manager.js) ────────────────────
registerCFHandlers(ipcMain, {
  getCfg:         () => _cfg,
  saveCfg:        () => saveConfig(_cfg),
  cfEnv:          () => _cfEnv(),
  getLauncherWin: () => _launcherWin,
  startTunnel,
  stopTunnel,
  pushUpdate,
  cloudflared,
});

ipcMain.handle('get-config',    ()          => ({ ..._cfg }));
ipcMain.handle('save-config',   (_e, cfg)  => {
  _cfg = { ...DEFAULT_CFG, ...cfg };
  if (_cfg.pass !== undefined) process.env.INSPECTOR_PASS = _cfg.pass;
  return { ok: saveConfig(_cfg) };
});
// ── Super App embed API (WAN Super App shell) ─────────────────────────────────
let _netBooted = false;
let _ipcUpdateRegistered = false;

async function initRuntime() {
  if (_netBooted) return;
  _cfg = loadConfig();
  try { await startInspector(); }
  catch (err) { console.error('Inspector start failed:', err.message); }

  if (!_ipcUpdateRegistered) {
    _ipcUpdateRegistered = true;
    ipcMain.handle('check-for-update', async () => {
      if (!autoUpdater) return { ok: false, error: 'updater not available' };
      try { await autoUpdater.checkForUpdates(); return { ok: true }; }
      catch (e) { return { ok: false, error: e.message }; }
    });
    ipcMain.handle('start-download-update', async () => {
      if (!autoUpdater) return { ok: false };
      try { await autoUpdater.downloadUpdate(); return { ok: true }; }
      catch (e) { console.warn('downloadUpdate error:', e.message); return { ok: false, error: e.message }; }
    });
  }

  // Auto-start saved tunnels
  const autoStart = Array.isArray(_cfg.autoStart) ? _cfg.autoStart : [];
  for (const key of autoStart) {
    const numKey = Number(key);
    const isPort = !isNaN(numKey) && numKey > 0 && Number.isInteger(numKey);
    if (isPort) {
      const route    = (_cfg.routes || []).find(r => r.port === numKey);
      const legacy   = (_cfg.domains || {})[key] || (_cfg.domains || {})[numKey];
      const domainOpts = route
        ? { customDomain: route.hostname, tunnelId: route.tunnelId }
        : (legacy || {});
      try { await startTunnel(numKey, domainOpts); }
      catch (err) { console.error(`Auto-start :${numKey} failed:`, err.message); }
    } else {
      try { await startTunnel(0, { staticHost: key }); }
      catch (err) { console.error(`Auto-start ${key} failed:`, err.message); }
    }
  }
  _netBooted = true;
}

function openLauncherWindow() {
  _showLauncherWin();
}

function shutdownAll() {
  _isQuitting = true;
  cleanup();
  if (_launcherWin && !_launcherWin.isDestroyed()) {
    try { _launcherWin.destroy(); } catch {}
  }
  if (_settingsWin && !_settingsWin.isDestroyed()) {
    try { _settingsWin.destroy(); } catch {}
  }
  _launcherWin = null;
  _settingsWin = null;
  _netBooted = false;
}

function liveTunnelCount() {
  let n = 0;
  for (const t of _tunnelMap.values()) if (t.status === 'live') n++;
  return n;
}

function getStatus() {
  return {
    running: _netBooted,
    inspPort: _inspPort,
    liveTunnels: liveTunnelCount(),
    tunnels: liveTunnelCount(),
  };
}

module.exports = {
  initRuntime,
  openLauncherWindow,
  showLauncher: openLauncherWindow,
  shutdownAll,
  cleanup,
  getStatus,
  liveTunnelCount,
  startTunnel,
  setQuitting: (v) => { _isQuitting = !!v; },
};

// ── App lifecycle (standalone only — Super App sets WAN_SUPER_APP_EMBED=1) ───
if (!process.env.WAN_SUPER_APP_EMBED) {
  app.whenReady().then(async () => {
    await initRuntime();
    createTray();
    createLauncherWindow();

    if (autoUpdater) {
      autoUpdater.autoDownload         = false;
      autoUpdater.autoInstallOnAppQuit = true;
      if (!app.isPackaged) autoUpdater.forceDevUpdateConfig = true;

      const _sendUpdate = (channel, info) => {
        if (_launcherWin && !_launcherWin.isDestroyed()) {
          _launcherWin.webContents.send(channel, info);
        }
      };

      autoUpdater.on('update-available',  info => _sendUpdate('update-available',  info));
      autoUpdater.on('update-not-available', () => _sendUpdate('update-not-available', {}));
      autoUpdater.on('download-progress', prog => _sendUpdate('download-progress', prog));
      autoUpdater.on('update-downloaded', info => _sendUpdate('update-downloaded', info));
      autoUpdater.on('error', err => {
        console.warn('autoUpdater error:', err.message);
        _sendUpdate('update-error', { message: err.message });
      });

      setTimeout(() => {
        try { autoUpdater.checkForUpdates(); } catch (e) { console.warn('update check failed:', e.message); }
      }, 5000);
    }
  });

  app.on('window-all-closed', e => e.preventDefault());
  app.on('activate', () => {
    if (process.platform === 'darwin') app.dock?.show();
    _showLauncherWin();
  });
  app.on('before-quit', () => { _isQuitting = true; cleanup(); });
}
app.on('before-quit', () => { _isQuitting = true; cleanup(); });
