import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { getHubWindow, setHubQuitting } from "./hub-window.js";

// electron-updater is CommonJS; named ESM import fails at runtime in Electron.
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { autoUpdater } = require("electron-updater") as {
  autoUpdater: {
    autoDownload: boolean;
    autoInstallOnAppQuit: boolean;
    forceDevUpdateConfig: boolean;
    checkForUpdates: () => Promise<unknown>;
    downloadUpdate: () => Promise<unknown>;
    quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void;
    setFeedURL: (options: Record<string, unknown>) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on: (event: string, listener: (...args: any[]) => void) => void;
  };
};

/** Must match electron-builder.yml publish. */
const UPDATE_FEED = {
  provider: "github",
  owner: "setiyawan12",
  repo: "WAN-SUPER-APP",
} as const;

function devUpdateYmlPath(): string {
  // electron-updater looks for dev-app-update.yml in process.cwd() by default;
  // write/read next to package.json via app.getAppPath() when possible.
  try {
    return path.join(app.getAppPath(), "dev-app-update.yml");
  } catch {
    return path.join(process.cwd(), "dev-app-update.yml");
  }
}

type ProgressInfo = {
  percent?: number;
  bytesPerSecond?: number;
  transferred?: number;
  total?: number;
};

type UpdateInfo = {
  version?: string;
};

export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error";

export interface UpdateStatus {
  phase: UpdatePhase;
  currentVersion: string;
  availableVersion: string | null;
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
  message: string | null;
  /** true when running unpackaged; updater may still check with forceDevUpdateConfig */
  isPackaged: boolean;
  lastCheckedAt: number | null;
}

type Listener = (status: UpdateStatus) => void;

let status: UpdateStatus = {
  phase: "idle",
  currentVersion: app.getVersion(),
  availableVersion: null,
  percent: 0,
  bytesPerSecond: 0,
  transferred: 0,
  total: 0,
  message: null,
  isPackaged: app.isPackaged,
  lastCheckedAt: null,
};

let initialized = false;
let checking = false;
const listeners = new Set<Listener>();

function snapshot(): UpdateStatus {
  return { ...status };
}

function setStatus(patch: Partial<UpdateStatus>): void {
  status = { ...status, ...patch, currentVersion: app.getVersion(), isPackaged: app.isPackaged };
  const next = snapshot();
  for (const fn of listeners) {
    try {
      fn(next);
    } catch {
      /* ignore listener errors */
    }
  }
  broadcast(next);
}

function broadcast(next: UpdateStatus): void {
  const targets = new Set<BrowserWindow>();
  const hub = getHubWindow();
  if (hub && !hub.isDestroyed()) targets.add(hub);
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) targets.add(win);
  }
  for (const win of targets) {
    try {
      win.webContents.send("super:updateStatus", next);
    } catch {
      /* window may be mid-destroy */
    }
  }
}

export function getUpdateStatus(): UpdateStatus {
  return snapshot();
}

export function onUpdateStatus(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function friendlyUpdateError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/ENOENT/i.test(raw) && /dev-app-update\.yml/i.test(raw)) {
    return "Config update dev belum ada (dev-app-update.yml).";
  }
  if (/ENOENT/i.test(raw) && /app-update\.yml/i.test(raw)) {
    return "Feed update tidak ditemukan di build ini.";
  }
  if (/net::|ENOTFOUND|ECONN|timed out|403|404/i.test(raw)) {
    return `Gagal menghubungi GitHub Releases: ${raw}`;
  }
  return raw || "Update gagal";
}

function configureUpdateFeed(): void {
  // Explicit feed so both packaged and unpackaged runs hit the Super App repo.
  try {
    autoUpdater.setFeedURL({ ...UPDATE_FEED });
  } catch (err) {
    console.warn("[updater] setFeedURL failed:", err instanceof Error ? err.message : err);
  }

  // Unpackaged Electron needs forceDevUpdateConfig + dev-app-update.yml.
  if (!app.isPackaged) {
    autoUpdater.forceDevUpdateConfig = true;
    const ymlPath = devUpdateYmlPath();
    if (!fs.existsSync(ymlPath)) {
      try {
        fs.writeFileSync(
          ymlPath,
          [
            "provider: github",
            `owner: ${UPDATE_FEED.owner}`,
            `repo: ${UPDATE_FEED.repo}`,
            "updaterCacheDirName: wan-super-app-updater",
            "",
          ].join("\n"),
          "utf8"
        );
        console.log("[updater] wrote", ymlPath);
      } catch (err) {
        console.warn(
          "[updater] could not write dev-app-update.yml:",
          err instanceof Error ? err.message : err
        );
      }
    }
  }
}

export function initAppUpdater(opts: { autoCheck?: boolean } = {}): void {
  if (initialized) return;
  initialized = true;

  status.currentVersion = app.getVersion();
  status.isPackaged = app.isPackaged;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  configureUpdateFeed();

  autoUpdater.on("checking-for-update", () => {
    checking = true;
    setStatus({
      phase: "checking",
      message: "Mengecek update…",
      percent: 0,
    });
  });

  autoUpdater.on("update-available", (info: UpdateInfo) => {
    checking = false;
    setStatus({
      phase: "available",
      availableVersion: info.version ?? null,
      message: `Versi ${info.version} tersedia`,
      lastCheckedAt: Date.now(),
    });
  });

  autoUpdater.on("update-not-available", (info: UpdateInfo) => {
    checking = false;
    setStatus({
      phase: "not-available",
      availableVersion: info?.version ?? app.getVersion(),
      message: "Aplikasi sudah terbaru",
      lastCheckedAt: Date.now(),
    });
  });

  autoUpdater.on("download-progress", (prog: ProgressInfo) => {
    setStatus({
      phase: "downloading",
      percent: prog.percent ?? 0,
      bytesPerSecond: prog.bytesPerSecond ?? 0,
      transferred: prog.transferred ?? 0,
      total: prog.total ?? 0,
      message: "Mengunduh update…",
    });
  });

  autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
    setStatus({
      phase: "downloaded",
      availableVersion: info.version ?? null,
      percent: 100,
      message: `Update ${info.version} siap dipasang`,
    });
  });

  autoUpdater.on("error", (err: Error) => {
    checking = false;
    setStatus({
      phase: "error",
      message: friendlyUpdateError(err),
    });
  });

  // Auto-check only in packaged builds (dev still supports manual "Check for updates").
  const shouldAutoCheck = opts.autoCheck !== false && app.isPackaged;
  if (shouldAutoCheck) {
    setTimeout(() => {
      void checkForAppUpdates().catch((err) => {
        console.warn("[updater] auto-check failed:", err instanceof Error ? err.message : err);
      });
    }, 6000);
  } else if (!app.isPackaged) {
    setStatus({
      phase: "idle",
      message: "Mode development — klik Check for updates untuk cek GitHub Releases.",
    });
  }
}

export async function checkForAppUpdates(): Promise<UpdateStatus> {
  if (!initialized) initAppUpdater({ autoCheck: false });
  if (checking || status.phase === "downloading") return snapshot();
  try {
    checking = true;
    configureUpdateFeed();
    setStatus({ phase: "checking", message: "Mengecek update…", percent: 0 });
    await autoUpdater.checkForUpdates();
  } catch (err) {
    checking = false;
    setStatus({
      phase: "error",
      message: friendlyUpdateError(err),
      lastCheckedAt: Date.now(),
    });
  }
  return snapshot();
}

export async function downloadAppUpdate(): Promise<UpdateStatus> {
  if (!initialized) initAppUpdater({ autoCheck: false });
  if (status.phase !== "available" && status.phase !== "error") {
    return snapshot();
  }
  try {
    setStatus({
      phase: "downloading",
      percent: 0,
      message: "Mengunduh update…",
      transferred: 0,
      total: 0,
      bytesPerSecond: 0,
    });
    await autoUpdater.downloadUpdate();
  } catch (err) {
    setStatus({
      phase: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
  return snapshot();
}

export function installAppUpdate(): { ok: boolean; error?: string } {
  if (!app.isPackaged) {
    return {
      ok: false,
      error: "Install update hanya tersedia di build production (packaged).",
    };
  }
  if (status.phase !== "downloaded") {
    return { ok: false, error: "Belum ada update yang terunduh." };
  }
  try {
    // Allow windows to close without tray-hide behavior.
    setHubQuitting(true);
    // isSilent=false, isForceRunAfter=true
    autoUpdater.quitAndInstall(false, true);
    return { ok: true };
  } catch (err) {
    setHubQuitting(false);
    const message = err instanceof Error ? err.message : String(err);
    setStatus({ phase: "error", message });
    return { ok: false, error: message };
  }
}
