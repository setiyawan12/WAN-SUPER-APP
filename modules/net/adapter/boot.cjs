'use strict';

/**
 * Super App adapter for WAN NET (CJS).
 * Loads modules/net/electron/main.js with WAN_SUPER_APP_EMBED so it does not
 * take ownership of app.whenReady / tray / before-quit.
 */
const path = require('path');

let handle = null;

/**
 * @param {{ show?: boolean, moduleRoot?: string }} opts
 */
async function bootNet(opts = {}) {
  const show = opts.show !== false;
  if (handle) {
    if (show) handle.show();
    return handle;
  }

  process.env.WAN_SUPER_APP_EMBED = '1';

  // Do NOT delete require.cache — re-registering ipcMain.handle crashes Electron.
  const mainPath = path.join(__dirname, '../electron/main.js');
  const net = require(mainPath);

  await net.initRuntime();
  if (show) net.openLauncherWindow();

  handle = {
    id: 'net',
    show: () => net.openLauncherWindow(),
    hide: () => {
      // launcher close-to-hide is handled inside main.js
      try {
        const { BrowserWindow } = require('electron');
        for (const w of BrowserWindow.getAllWindows()) {
          if (String(w.getTitle() || '').includes('NET')) w.hide();
        }
      } catch {}
    },
    shutdown: async () => {
      try {
        net.setQuitting(true);
        net.shutdownAll();
      } catch (e) {
        console.warn('[net] shutdown:', e && e.message);
      }
      handle = null;
    },
    isRunning: () => true,
    getStatus: () => {
      try { return net.getStatus(); }
      catch { return { running: true, liveTunnels: 0 }; }
    },
  };

  return handle;
}

module.exports = { bootNet };
