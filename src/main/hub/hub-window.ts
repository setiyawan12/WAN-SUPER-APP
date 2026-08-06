import { BrowserWindow, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSettings, setSetting } from "./hub-settings.js";
import type { ModuleId } from "../module-types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type ShellView = "hub" | ModuleId;

let hubWindow: BrowserWindow | null = null;
let isQuitting = false;
/** What the shell window is currently showing (hub or an embedded module). */
let shellView: ShellView = "hub";
/** Guard: ignore close-to-hide while we intentionally rebuild the shell. */
let rebuilding = false;

export function setHubQuitting(v: boolean): void {
  isQuitting = v;
}

export function getHubWindow(): BrowserWindow | null {
  return hubWindow && !hubWindow.isDestroyed() ? hubWindow : null;
}

export function getShellView(): ShellView {
  return shellView;
}

function hubPreloadPath(): string {
  return path.join(__dirname, "../../preload/hub.cjs");
}

function hubIconPath(): string {
  return path.join(__dirname, "../icon.png");
}

function cliproxyPreloadPath(): string {
  return path.join(__dirname, "../../modules/cliproxy/preload/index.cjs");
}

function netPreloadPath(): string {
  return path.join(__dirname, "../../modules/net/electron/launcher-preload.js");
}

function sshPreloadPath(): string {
  return path.join(__dirname, "../../modules/ssh/preload/index.js");
}

function mindmapPreloadPath(): string {
  return path.join(__dirname, "../../modules/mindmap/preload/index.cjs");
}

function loadHubContent(win: BrowserWindow): void {
  const devUrl = process.env.VITE_DEV_SERVER_URL_HUB;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(path.join(__dirname, "../../hub-renderer/index.html"));
  }
}

function loadCliproxyContent(win: BrowserWindow): void {
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(
      path.join(__dirname, "../../modules/cliproxy/renderer/index.html")
    );
  }
}

function loadNetContent(win: BrowserWindow): void {
  void win.loadFile(
    path.join(__dirname, "../../modules/net/electron/launcher.html")
  );
}

function loadSshContent(win: BrowserWindow): void {
  const devUrl = process.env.VITE_DEV_SERVER_URL_SSH;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(
      path.join(__dirname, "../../modules/ssh/renderer/index.html")
    );
  }
}

function loadMindmapContent(win: BrowserWindow): void {
  const devUrl = process.env.VITE_DEV_SERVER_URL_MINDMAP;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(
      path.join(__dirname, "../../modules/mindmap/renderer/index.html")
    );
  }
}

function bindShellChrome(win: BrowserWindow): void {
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const persistBounds = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!win.isDestroyed() && !win.isMinimized()) {
        const b = win.getBounds();
        setSetting("windowBoundsHub", {
          width: b.width,
          height: b.height,
          x: b.x,
          y: b.y,
        });
      }
    }, 400);
  };
  win.on("resize", persistBounds);
  win.on("move", persistBounds);
  win.setMenuBarVisibility(false);

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  win.on("close", (e) => {
    if (rebuilding) return;
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  win.on("closed", () => {
    if (hubWindow === win) {
      hubWindow = null;
      shellView = "hub";
    }
  });
}

function createShellWindow(opts: {
  title: string;
  preload: string;
  startHidden?: boolean;
  minWidth?: number;
  minHeight?: number;
  width?: number;
  height?: number;
  /** Default true (hub/cliproxy). NET launcher historically runs unsandboxed. */
  sandbox?: boolean;
  /** Extra argv forwarded to the (sandboxed) preload via process.argv. */
  additionalArguments?: string[];
}): BrowserWindow {
  const saved = getSettings().windowBoundsHub;
  const iconPath = hubIconPath();

  const win = new BrowserWindow({
    width: opts.width ?? saved?.width ?? 920,
    height: opts.height ?? saved?.height ?? 640,
    ...(saved?.x !== undefined && saved?.y !== undefined
      ? { x: saved.x, y: saved.y }
      : {}),
    minWidth: opts.minWidth ?? 720,
    minHeight: opts.minHeight ?? 480,
    show: !opts.startHidden,
    backgroundColor: "#0b0c16",
    title: opts.title,
    ...(process.platform !== "darwin" && fs.existsSync(iconPath)
      ? { icon: iconPath }
      : {}),
    webPreferences: {
      preload: opts.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: opts.sandbox !== false,
      ...(opts.additionalArguments
        ? { additionalArguments: opts.additionalArguments }
        : {}),
    },
  });

  bindShellChrome(win);
  hubWindow = win;
  return win;
}

/**
 * Destroy the current shell without close-to-hide, so we can rebuild with a
 * different preload (hub vs cliproxy vs net).
 */
function destroyShellForRebuild(): void {
  const win = getHubWindow();
  if (!win) return;
  rebuilding = true;
  try {
    win.removeAllListeners("close");
    win.destroy();
  } catch {
    /* ignore */
  } finally {
    hubWindow = null;
    rebuilding = false;
  }
}

export function showHubWindow(): void {
  // Always restore the hub UI (not an embedded module page).
  if (shellView !== "hub" || !getHubWindow()) {
    ensureHubShell(false);
    return;
  }
  const win = getHubWindow()!;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

export function createHubWindow(startHidden = false): BrowserWindow {
  return ensureHubShell(startHidden);
}

/** Ensure shell is the hub landing page (with hub preload). */
export function ensureHubShell(startHidden = false): BrowserWindow {
  const existing = getHubWindow();
  if (existing && shellView === "hub") {
    if (!startHidden) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
    }
    return existing;
  }

  if (existing) destroyShellForRebuild();

  const win = createShellWindow({
    title: "WAN Super App",
    preload: hubPreloadPath(),
    startHidden,
  });
  shellView = "hub";
  loadHubContent(win);
  return win;
}

/**
 * Rebuild the single shell window for an embedded module view.
 * Caller must then call module.presentIn(win) if extra wiring is needed.
 */
export function ensureModuleShell(
  id: ModuleId,
  opts: { startHidden?: boolean } = {}
): BrowserWindow {
  const existing = getHubWindow();
  if (existing && shellView === id) {
    if (!opts.startHidden) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
    }
    return existing;
  }

  if (existing) destroyShellForRebuild();

  if (id === "cliproxy") {
    const win = createShellWindow({
      title: "WAN Super App — CLIProxyAPI",
      preload: cliproxyPreloadPath(),
      startHidden: opts.startHidden,
      minWidth: 720,
      minHeight: 520,
      width: getSettings().windowBoundsHub?.width ?? 1100,
      height: getSettings().windowBoundsHub?.height ?? 780,
    });
    shellView = "cliproxy";
    loadCliproxyContent(win);
    return win;
  }

  if (id === "ssh") {
    const win = createShellWindow({
      title: "WAN Super App — WANN SSH",
      preload: sshPreloadPath(),
      startHidden: opts.startHidden,
      minWidth: 900,
      minHeight: 560,
      width: getSettings().windowBoundsHub?.width ?? 1200,
      height: getSettings().windowBoundsHub?.height ?? 780,
      // wann-ssh WAJIB sandbox:true (Bab 18 handbook SSH).
      sandbox: true,
      // Tandai embed agar preload wann-ssh meng-expose window.superApp (tombol
      // "kembali ke hub"). Standalone wann-ssh tidak menerima argv ini.
      additionalArguments: ["--wan-super-app-embed"],
    });
    shellView = "ssh";
    loadSshContent(win);
    return win;
  }

  if (id === "mindmap") {
    const win = createShellWindow({
      title: "WAN Super App — Mindmap",
      preload: mindmapPreloadPath(),
      startHidden: opts.startHidden,
      minWidth: 980,
      minHeight: 640,
      width: getSettings().windowBoundsHub?.width ?? 1440,
      height: getSettings().windowBoundsHub?.height ?? 900,
      sandbox: true,
      additionalArguments: ["--wan-super-app-embed"],
    });
    shellView = "mindmap";
    loadMindmapContent(win);
    return win;
  }

  const win = createShellWindow({
    title: "WAN Super App — NET",
    preload: netPreloadPath(),
    startHidden: opts.startHidden,
    minWidth: 600,
    minHeight: 420,
    width: getSettings().windowBoundsHub?.width ?? 760,
    height: getSettings().windowBoundsHub?.height ?? 560,
    // Match dedicated NET launcher window prefs.
    sandbox: false,
  });
  shellView = "net";
  loadNetContent(win);
  return win;
}
