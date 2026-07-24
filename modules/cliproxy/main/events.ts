import { BrowserWindow } from "electron";

// Tiny hub so any module (sync, ipc, tray) can push events to the renderer
// without importing window.ts and creating a cycle. Replaces the extension's
// webview postMessage plumbing; the handbook's `window.wan.onEvent` (Tahap 2)
// listens for the "wan:event" channel these fire on.

let win: BrowserWindow | null = null;

export function setMainWindow(w: BrowserWindow | null): void {
  win = w;
}

export function getMainWindow(): BrowserWindow | null {
  return win;
}

export function broadcast(type: string, payload: unknown = null): void {
  // Fan out to every window so Quick Chat (and any future aux windows) receive
  // chat stream / tool / approval events — not only the main dashboard window.
  const envelope = { type, payload };
  const windows = BrowserWindow.getAllWindows();
  if (windows.length) {
    for (const w of windows) {
      if (!w.isDestroyed()) w.webContents.send("wan:event", envelope);
    }
    return;
  }
  if (win && !win.isDestroyed()) {
    win.webContents.send("wan:event", envelope);
  }
}
