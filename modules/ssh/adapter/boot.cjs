'use strict';

/**
 * Super App adapter untuk WANN SSH (CJS bundle).
 * Memuat modules/ssh/main/index.js dengan WAN_SUPER_APP_EMBED agar bundle tidak
 * mengambil alih app.whenReady / tray / before-quit (pola sama dengan WAN NET).
 */
const path = require('path');

let handle = null;

/**
 * @param {{ show?: boolean, moduleRoot?: string, embedOnly?: boolean }} opts
 */
async function bootSsh(opts = {}) {
  const show = opts.show !== false;
  const embedOnly = !!opts.embedOnly;

  if (handle) {
    if (show && !embedOnly) handle.show();
    return handle;
  }

  process.env.WAN_SUPER_APP_EMBED = '1';

  // JANGAN hapus require.cache — re-register ipcMain.handle akan crash Electron.
  const mainPath = path.join(__dirname, '../main/index.js');
  const mod = require(mainPath);
  const ssh = mod.default ?? mod;

  await ssh.initSsh();
  if (show && !embedOnly) ssh.openSshWindow();

  handle = {
    id: 'ssh',
    show: () => ssh.openSshWindow(),
    hide: () => {
      try {
        const { BrowserWindow } = require('electron');
        for (const w of BrowserWindow.getAllWindows()) {
          if (String(w.getTitle() || '').includes('SSH')) w.hide();
        }
      } catch {
        /* ignore */
      }
    },
    /** Replace-mode: pakai shell Super App sebagai jendela SSH. */
    presentIn: (win) => {
      if (typeof ssh.attachSshWindow === 'function') ssh.attachSshWindow(win);
    },
    shutdown: async () => {
      try {
        ssh.shutdownSsh();
      } catch (e) {
        console.warn('[ssh] shutdown:', e && e.message);
      }
      handle = null;
    },
    isRunning: () => true,
    getStatus: () => {
      try {
        return ssh.getSshStatus();
      } catch {
        return { running: true };
      }
    },
  };

  return handle;
}

module.exports = { bootSsh };
