import { BrowserWindow, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getMainWindow, setMainWindow } from "./events.js";
import { getSetting, setSetting } from "./app-settings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let isQuitting = false;
export function setQuitting(v: boolean): void {
  isQuitting = v;
}

function showExisting(win: BrowserWindow): BrowserWindow {
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
  return win;
}

/** Create the main CLIProxy window, or reuse the existing one (single-instance). */
export function createWindow(startHidden = false): BrowserWindow {
  const existing = getMainWindow();
  if (existing && !existing.isDestroyed()) {
    if (!startHidden) showExisting(existing);
    return existing;
  }

  const saved = getSetting("windowBounds");
  const iconPath = path.join(__dirname, "icon.png");

  const win = new BrowserWindow({
    width: saved?.width ?? 1100,
    height: saved?.height ?? 780,
    ...(saved?.x !== undefined && saved?.y !== undefined ? { x: saved.x, y: saved.y } : {}),
    minWidth: 720,
    minHeight: 520,
    show: !startHidden,
    backgroundColor: "#0b0c16",
    title: "WAN Super App — CLIProxyAPI",
    // App icon for Windows/Linux (macOS uses the packaged .icns).
    ...(process.platform !== "darwin" && fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true, // handbook §12 -- preload only uses contextBridge/ipcRenderer
    },
  });

  // Persist size/position (debounced) so the window reopens where it was.
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const persistBounds = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!win.isDestroyed() && !win.isMinimized()) {
        const b = win.getBounds();
        setSetting("windowBounds", { width: b.width, height: b.height, x: b.x, y: b.y });
      }
    }, 400);
  };
  win.on("resize", persistBounds);
  win.on("move", persistBounds);

  win.setMenuBarVisibility(false);

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  // External links always open in the real system browser, never a new
  // Electron window (handbook Tahap 5, item 6).
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  // Close-to-tray: closing the window hides it so CLIProxyAPI keeps serving
  // Copilot Chat. Real quit only comes from the tray menu (handbook Tahap 8).
  win.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  win.on("closed", () => {
    if (getMainWindow() === win) setMainWindow(null);
  });
  setMainWindow(win);
  return win;
}

export function showWindow(): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    showExisting(win);
    return;
  }
  createWindow(false);
}

/**
 * Super App replace-mode: treat an external shell BrowserWindow as the
 * CLIProxy main window (do not create a second window).
 */
export function attachMainWindow(win: BrowserWindow): void {
  if (!win || win.isDestroyed()) return;
  const prev = getMainWindow();
  if (prev === win) {
    showExisting(win);
    return;
  }
  setMainWindow(win);
  // When the shell is destroyed/rebuilt, drop our reference if it still points here.
  win.on("closed", () => {
    if (getMainWindow() === win) setMainWindow(null);
  });
  if (!win.isVisible()) win.show();
  win.focus();
}
