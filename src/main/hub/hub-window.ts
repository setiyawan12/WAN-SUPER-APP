import { BrowserWindow, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSettings, setSetting } from "./hub-settings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let hubWindow: BrowserWindow | null = null;
let isQuitting = false;

export function setHubQuitting(v: boolean): void {
  isQuitting = v;
}

export function getHubWindow(): BrowserWindow | null {
  return hubWindow && !hubWindow.isDestroyed() ? hubWindow : null;
}

export function showHubWindow(): void {
  const win = getHubWindow();
  if (!win) {
    createHubWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

export function createHubWindow(startHidden = false): BrowserWindow {
  const existing = getHubWindow();
  if (existing) {
    if (!startHidden) {
      existing.show();
      existing.focus();
    }
    return existing;
  }

  const saved = getSettings().windowBoundsHub;
  // Compiled to out/main/hub/*.js — icons live in out/main/, preload in out/preload/
  const iconPath = path.join(__dirname, "../icon.png");
  const preloadPath = path.join(__dirname, "../../preload/hub.cjs");

  const win = new BrowserWindow({
    width: saved?.width ?? 920,
    height: saved?.height ?? 640,
    ...(saved?.x !== undefined && saved?.y !== undefined ? { x: saved.x, y: saved.y } : {}),
    minWidth: 720,
    minHeight: 480,
    show: !startHidden,
    backgroundColor: "#0b0c16",
    title: "WAN Super App",
    ...(process.platform !== "darwin" && fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const persistBounds = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!win.isDestroyed() && !win.isMinimized()) {
        const b = win.getBounds();
        setSetting("windowBoundsHub", { width: b.width, height: b.height, x: b.x, y: b.y });
      }
    }, 400);
  };
  win.on("resize", persistBounds);
  win.on("move", persistBounds);

  win.setMenuBarVisibility(false);

  const devUrl = process.env.VITE_DEV_SERVER_URL_HUB;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(path.join(__dirname, "../../hub-renderer/index.html"));
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  win.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  win.on("closed", () => {
    hubWindow = null;
  });

  hubWindow = win;
  return win;
}
