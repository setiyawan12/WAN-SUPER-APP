/**
 * Super App entry for CLIProxyAPI (lazy module boot).
 * Same order as index.ts, without single-instance / tray / app.whenReady.
 */
import { BrowserWindow, dialog, Notification } from "electron";
import { prepareBackendEnv, ensureFreePort, backendPort } from "./config.js";
import { getSettings } from "./app-settings.js";
import { registerIpc } from "./ipc.js";
import { showWindow, setQuitting, attachMainWindow } from "./window.js";
import { startVsCodeAutoSync, stopVsCodeAutoSync } from "./vscode-sync.js";
import { registerQuickChat, unregisterQuickChat } from "./quick-chat.js";
import { broadcast } from "./events.js";

export interface CliproxyBootOpts {
  show?: boolean;
  moduleRoot?: string;
  /**
   * When true, do not create a dedicated CLIProxy BrowserWindow.
   * Super App will call presentIn(shell) for replace-mode.
   */
  embedOnly?: boolean;
}

export interface ModuleHandleLike {
  id: "cliproxy";
  show: () => void;
  hide: () => void;
  shutdown: () => Promise<void>;
  isRunning: () => boolean;
  getStatus: () => Record<string, unknown>;
  presentIn: (win: BrowserWindow) => void;
}

let booted = false;
let ipcRegistered = false;
let quotaAlertsRegistered = false;
let shuttingDown = false;

const loadBackend = (rel: string): Promise<any> =>
  import(new URL(rel, import.meta.url).href);

export async function bootCliproxy(opts: CliproxyBootOpts = {}): Promise<ModuleHandleLike> {
  const show = opts.show !== false;
  const embedOnly = !!opts.embedOnly;

  if (!booted) {
    const settings = getSettings();
    prepareBackendEnv(settings.autoStartServer);
    const port = await ensureFreePort();
    if (port !== 4317) {
      console.log(`[cliproxy] default port 4317 busy — using ${port} instead`);
    }

    try {
      await loadBackend("./backend/index.js");
    } catch (err) {
      dialog.showErrorBox(
        "WAN Super App — CLIProxyAPI startup error",
        `The internal server failed to start on port ${port}.\n\n` +
          `${err instanceof Error ? err.message : String(err)}\n\n` +
          `If the Renn-Copilot VS Code extension or another copy of this app is ` +
          `running, quit it and relaunch.`
      );
      throw err;
    }

    try {
      const { activityBus } = await loadBackend("./backend/activity-bus.js");
      activityBus.on("hit", (evt: unknown) => broadcast("activity", evt));
    } catch (err) {
      console.warn(
        `[cliproxy] activity bus unavailable: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    try {
      const { quotaBudgetBus } = await loadBackend("./backend/quota-budget-bus.js");
      if (!quotaAlertsRegistered) {
        quotaBudgetBus.on("alert", (event: { title?: string; message?: string; notifyOs?: boolean }) => {
          broadcast("quota-budget-alert", event);
          if (event.notifyOs !== false && Notification.isSupported()) {
            new Notification({
              title: event.title || "WAN Quota & Budget Alert",
              body: event.message || "A configured threshold was reached.",
            }).show();
          }
        });
        quotaAlertsRegistered = true;
      }
    } catch (err) {
      console.warn(
        `[cliproxy] quota budget alerts unavailable: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (!ipcRegistered) {
      registerIpc();
      ipcRegistered = true;
    }
    startVsCodeAutoSync();
    registerQuickChat();
    booted = true;
  }

  // Window mode: create/show dedicated window. Replace mode: Super App shells it.
  if (show && !embedOnly) {
    showWindow();
  }

  return {
    id: "cliproxy",
    show: () => {
      // Window mode: focus existing or create once.
      // Replace mode callers should use presentIn / ensureModuleShell instead.
      showWindow();
    },
    hide: () => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed() && w.getTitle().includes("CLIProxyAPI")) w.hide();
      }
    },
    presentIn: (win: BrowserWindow) => {
      attachMainWindow(win);
    },
    shutdown: async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      setQuitting(true);
      stopVsCodeAutoSync();
      unregisterQuickChat();
      try {
        const mgr = await loadBackend("./backend/cliproxy-manager.js");
        await mgr.stopServer();
      } catch {
        /* nothing to stop */
      }
      // Do not destroy Super App shell windows; Super App owns that lifecycle.
      booted = false;
      shuttingDown = false;
    },
    isRunning: () => booted,
    getStatus: () => ({
      running: booted,
      port: backendPort(),
    }),
  };
}
