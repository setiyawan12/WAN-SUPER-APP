import { app, BrowserWindow } from "electron";
import { APP, logger } from "./constants.js";
import { initDb } from "./store.js";
import { AppContext } from "./context.js";
import { registerIpc } from "./ipc.js";
import { runtime } from "./runtime.js";
import { createMainWindow, attachWindow, buildMenu } from "./window.js";

let ownWindow: any = null;
let booted = false;
let powerMonitorCleanup: (() => void) | null = null;

export async function initSsh() {
  if (booted) return;
  initDb();
  runtime.ctx = new AppContext();
  if (!runtime.ipcRegistered) {
    registerIpc();
    runtime.ipcRegistered = true;
  }
  const { powerMonitor } = await import("electron");
  const onSuspend = () => runtime.ctx?.vault.lock();
  const onLockScreen = () => runtime.ctx?.vault.lock();
  powerMonitor.on("suspend", onSuspend);
  powerMonitor.on("lock-screen", onLockScreen);
  powerMonitorCleanup = () => {
    powerMonitor.off("suspend", onSuspend);
    powerMonitor.off("lock-screen", onLockScreen);
  };
  booted = true;
  logger.info("WANN SSH embed runtime siap");
}

export function openSshWindow() {
  if (ownWindow && !ownWindow.isDestroyed()) {
    if (ownWindow.isMinimized()) ownWindow.restore();
    ownWindow.show();
    ownWindow.focus();
    return;
  }
  ownWindow = createMainWindow();
  runtime.ctx?.setSender(ownWindow.webContents);
  ownWindow.on("closed", () => {
    ownWindow = null;
  });
}

export function attachSshWindow(win: any) {
  attachWindow(win);
  runtime.ctx?.setSender(win.webContents);
}

export function shutdownSsh() {
  try {
    runtime.ctx?.vault.lock();
  } catch {
  }
  runtime.ctx = null;
  if (powerMonitorCleanup) {
    powerMonitorCleanup();
    powerMonitorCleanup = null;
  }
  if (ownWindow && !ownWindow.isDestroyed()) {
    try {
      ownWindow.destroy();
    } catch {
    }
  }
  ownWindow = null;
  booted = false;
}

export function getSshStatus() {
  return { running: booted, vault: runtime.ctx ? runtime.ctx.vault.status() : "locked" };
}

if (!process.env.WAN_SUPER_APP_EMBED) {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    let mainWindow: any = null;
    const registerProtocol = () => {
      if (process.defaultApp && process.argv.length >= 2) {
        app.setAsDefaultProtocolClient(APP.scheme, process.execPath, [process.argv[1]]);
      } else {
        app.setAsDefaultProtocolClient(APP.scheme);
      }
    };
    app.whenReady().then(() => {
      registerProtocol();
      initDb();
      // Pakai global `ctx` agar registerIpc/requireCtx konsisten dengan path embed Super App.
      runtime.ctx = new AppContext();
      if (!runtime.ipcRegistered) {
        registerIpc();
        runtime.ipcRegistered = true;
      }
      buildMenu();
      mainWindow = createMainWindow();
      runtime.ctx.setSender(mainWindow.webContents);
      import("electron").then(({ powerMonitor }) => {
        powerMonitor.on("suspend", () => runtime.ctx?.vault.lock());
        powerMonitor.on("lock-screen", () => runtime.ctx?.vault.lock());
      });
      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          mainWindow = createMainWindow();
          runtime.ctx?.setSender(mainWindow.webContents);
        }
      });
      logger.info(`${APP.name} ${APP.version} siap`);
    });
    app.on("open-url", (event, url) => {
      event.preventDefault();
      logger.info("deep link diterima:", url);
      mainWindow?.webContents.send("deeplink", url);
    });
    app.on("window-all-closed", () => {
      if (process.platform !== "darwin") app.quit();
    });
  }
}
