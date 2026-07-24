import { BrowserWindow, globalShortcut, screen, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Quick-chat (HANDBOOK M6 — Tahap 9). A small frameless, always-on-top window
// for a fast one-off question, summoned by a global hotkey or the tray. It
// loads the SAME renderer bundle as the dashboard but at the "#quick" hash, so
// main.tsx swaps in the minimal <QuickChat/> view instead of the full <App/>.
// Reuses the identical preload/CSP/IPC surface — no second attack surface.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOTKEY = "CommandOrControl+Shift+Space";

let quickWin: BrowserWindow | null = null;

function createQuickWindow(): BrowserWindow {
  const { width: sw } = screen.getPrimaryDisplay().workAreaSize;
  const w = 560;
  const h = 480;

  const win = new BrowserWindow({
    width: w,
    height: h,
    x: Math.round((sw - w) / 2),
    y: 120, // near the top, like a spotlight launcher
    frame: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: "#0b0c16",
    title: "Ask AI",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.setMenuBarVisibility(false);

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(`${devUrl}#quick`);
  } else {
    void win.loadFile(path.join(__dirname, "../renderer/index.html"), { hash: "quick" });
  }

  // External links open in the OS browser, never a new Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  // Auto-hide when it loses focus so it behaves like a transient launcher —
  // but keep it alive (hidden) to preserve the in-flight answer/state.
  win.on("blur", () => {
    if (!win.isDestroyed() && !win.webContents.isDevToolsOpened()) win.hide();
  });
  win.on("closed", () => {
    quickWin = null;
  });
  return win;
}

/** Show + focus the quick-chat window, creating it on first use. */
export function showQuickChat(): void {
  if (!quickWin || quickWin.isDestroyed()) quickWin = createQuickWindow();
  quickWin.show();
  quickWin.focus();
}

export function hideQuickChat(): void {
  if (quickWin && !quickWin.isDestroyed()) quickWin.hide();
}

/** Toggle for the global hotkey: summon if hidden, dismiss if already up. */
function toggleQuickChat(): void {
  if (quickWin && !quickWin.isDestroyed() && quickWin.isVisible() && quickWin.isFocused()) {
    quickWin.hide();
  } else {
    showQuickChat();
  }
}

/** Register the global hotkey. Safe to call once on app-ready. */
export function registerQuickChat(): void {
  try {
    globalShortcut.register(HOTKEY, toggleQuickChat);
  } catch {
    /* another app may own the combo — quick-chat is still reachable from the tray */
  }
}

export function unregisterQuickChat(): void {
  globalShortcut.unregister(HOTKEY);
  if (quickWin && !quickWin.isDestroyed()) quickWin.destroy();
  quickWin = null;
}
