import { app, BrowserWindow, dialog } from "electron";
import { broadcast } from "./events.js";
import { prepareBackendEnv, ensureFreePort } from "./config.js";
import { getSettings } from "./app-settings.js";
import { registerIpc } from "./ipc.js";
import { createWindow, showWindow, setQuitting } from "./window.js";
import { createTray } from "./tray.js";
import { startVsCodeAutoSync, stopVsCodeAutoSync } from "./vscode-sync.js";
import { registerQuickChat, unregisterQuickChat } from "./quick-chat.js";

// The backend/* files are verbatim plain-JS ESM from the extension repo -- not
// part of the TypeScript program (tsconfig excludes them). Load them by
// computed URL so tsc doesn't try to resolve/typecheck the specifier; at
// runtime this resolves relative to this module and copies untouched via
// scripts/copy-assets.mjs.
const loadBackend = (rel: string): Promise<any> => import(new URL(rel, import.meta.url).href);

// Single-instance lock: two instances would spawn two CLIProxyAPI binaries
// fighting over port 8317 (handbook Tahap 1 -- free in VS Code, explicit here).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());

  app.whenReady().then(async () => {
    const settings = getSettings();

    // Configure + boot the VERBATIM backend (Express on 127.0.0.1:4317). Env
    // must be set before the import so backend/settings.js reads it. The
    // backend self-starts CLIProxyAPI when RENN_AUTO_START_SERVER=1 AND the
    // binary is already installed.
    prepareBackendEnv(settings.autoStartServer);
    // Walk up from the default port if it's already taken (extension backend
    // or a lingering tray instance) so app.listen() inside the verbatim
    // backend can't throw an uncaught EADDRINUSE.
    const port = await ensureFreePort();
    if (port !== 4317) {
      console.log(`[wan] default port 4317 busy — using ${port} instead`);
    }
    try {
      await loadBackend("./backend/index.js");
    } catch (err) {
      dialog.showErrorBox(
        "WAN X RENN CLIProxyAPI — startup error",
        `The internal server failed to start on port ${port}.\n\n` +
          `${err instanceof Error ? err.message : String(err)}\n\n` +
          `If the Renn-Copilot VS Code extension or another copy of this app is ` +
          `running, quit it and relaunch.`
      );
      throw err;
    }

    // Bridge the verbatim backend's proxy activity bus to the renderer's live
    // "neuron" activity feed. Wired here (not inside backend) so the backend
    // never imports Electron. A missing bus (older build) is non-fatal -- the
    // dashboard still falls back to its recent[] usage poll.
    try {
      const { activityBus } = await loadBackend("./backend/activity-bus.js");
      activityBus.on("hit", (evt: unknown) => broadcast("activity", evt));
    } catch (err) {
      console.warn(`[wan] activity bus unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }

    registerIpc();
    createTray();
    createWindow(settings.autoLaunch && settings.startHidden);
    startVsCodeAutoSync();
    // Global hotkey (Cmd/Ctrl+Shift+Space) → quick-chat mini window (HANDBOOK M6).
    registerQuickChat();

    if (process.platform !== "linux") {
      app.setLoginItemSettings({
        openAtLogin: settings.autoLaunch,
        openAsHidden: settings.startHidden,
      });
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWindow();
    });
  });

  // Tray-first lifecycle: closing every window must NOT quit -- CLIProxyAPI
  // keeps serving Copilot Chat in the background (handbook Tahap 1/8).
  app.on("window-all-closed", () => {
    /* stay alive in the tray */
  });

  // Real quit: kill the CLIProxyAPI child process so it doesn't orphan and
  // block the next start from binding port 8317 (handbook Jebakan #-, Tahap 1).
  let cleanedUp = false;
  app.on("before-quit", async (e) => {
    if (cleanedUp) return;
    e.preventDefault();
    setQuitting(true);
    stopVsCodeAutoSync();
    unregisterQuickChat();
    try {
      const mgr = await loadBackend("./backend/cliproxy-manager.js");
      await mgr.stopServer();
    } catch {
      /* nothing to stop */
    }
    cleanedUp = true;
    app.quit();
  });
}
