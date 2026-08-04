import { app, ipcMain } from "electron";
import { getSettings, setSetting, setSettings, type SuperAppSettings } from "./hub-settings.js";
import { showHubWindow } from "./hub-window.js";
import type { ModuleHandle, ModuleId } from "../module-types.js";
import { rebuildTrayMenu } from "../tray.js";
import {
  checkForAppUpdates,
  downloadAppUpdate,
  getUpdateStatus,
  installAppUpdate,
} from "./app-updater.js";

let pendingChatContext: { label: string; text: string; source: "ssh"; createdAt: number } | null = null;

export function registerHubIpc(opts: {
  openModule: (id: ModuleId, opts?: { show?: boolean }) => Promise<ModuleHandle>;
  getHandles: () => {
    cliproxy: ModuleHandle | null;
    net: ModuleHandle | null;
    ssh: ModuleHandle | null;
  };
}): void {
  ipcMain.handle("super:getSettings", () => getSettings());

  ipcMain.handle(
    "super:setSetting",
    (_e, key: keyof SuperAppSettings, value: SuperAppSettings[keyof SuperAppSettings]) => {
      const next = setSetting(key, value as never);
      if (key === "autoLaunch" && process.platform !== "linux") {
        app.setLoginItemSettings({
          openAtLogin: !!value,
          openAsHidden: getSettings().startHidden,
        });
      }
      rebuildTrayMenu();
      return next;
    }
  );

  ipcMain.handle("super:setSettings", (_e, patch: Partial<SuperAppSettings>) => {
    const next = setSettings(patch);
    rebuildTrayMenu();
    return next;
  });

  ipcMain.handle("super:openModule", async (_e, id: ModuleId) => {
    if (id !== "cliproxy" && id !== "net" && id !== "ssh") {
      return { ok: false, error: "unknown module" };
    }
    try {
      await opts.openModule(id, { show: true });
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ipcMain.handle("super:sendToChat", async (_e, raw: unknown) => {
    if (!raw || typeof raw !== "object") return { ok: false, error: "invalid context" };
    const value = raw as { label?: unknown; text?: unknown; source?: unknown };
    if (typeof value.text !== "string" || !value.text.trim()) return { ok: false, error: "empty context" };
    const text = value.text.slice(0, 50_000);
    pendingChatContext = {
      label: typeof value.label === "string" ? value.label.slice(0, 200) : "SSH terminal selection",
      text,
      source: "ssh",
      createdAt: Date.now()
    };
    try {
      await opts.openModule("cliproxy", { show: true });
      return { ok: true, truncated: text.length < value.text.length };
    } catch (err) {
      pendingChatContext = null;
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("super:consumeChatContext", () => {
    const context = pendingChatContext;
    pendingChatContext = null;
    return context;
  });

  ipcMain.handle("super:hasChatContext", () => pendingChatContext !== null);

  ipcMain.handle("super:showHub", () => {
    showHubWindow();
    return { ok: true };
  });

  ipcMain.handle("super:moduleState", async () => {
    const h = opts.getHandles();
    const cliproxy = h.cliproxy;
    const net = h.net;
    const ssh = h.ssh;
    let cliproxyStatus: Record<string, unknown> = {
      running: !!cliproxy?.isRunning(),
    };
    let netStatus: Record<string, unknown> = { running: !!net?.isRunning() };
    let sshStatus: Record<string, unknown> = { running: !!ssh?.isRunning() };
    try {
      if (cliproxy?.getStatus) cliproxyStatus = { ...cliproxyStatus, ...(await cliproxy.getStatus()) };
    } catch {
      /* ignore */
    }
    try {
      if (net?.getStatus) netStatus = { ...netStatus, ...(await net.getStatus()) };
    } catch {
      /* ignore */
    }
    try {
      if (ssh?.getStatus) sshStatus = { ...sshStatus, ...(await ssh.getStatus()) };
    } catch {
      /* ignore */
    }
    return { cliproxy: cliproxyStatus, net: netStatus, ssh: sshStatus };
  });

  ipcMain.handle("super:getVersion", () => app.getVersion());

  ipcMain.handle("super:getUpdateStatus", () => getUpdateStatus());
  ipcMain.handle("super:checkForUpdates", async () => checkForAppUpdates());
  ipcMain.handle("super:downloadUpdate", async () => downloadAppUpdate());
  ipcMain.handle("super:installUpdate", () => installAppUpdate());
}
