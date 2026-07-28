import * as path from "node:path";
import { BrowserWindow, Menu, shell } from "electron";

export function createMainWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: "#12151c",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      contextIsolation: true,
      // WAJIB
      nodeIntegration: false,
      // WAJIB
      sandbox: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
      preload: path.join(__dirname, "../preload/index.js")
    }
  });
  win.once("ready-to-show", () => win.show());
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https:")) void shell.openExternal(url);
    return { action: "deny" };
  });
  if (process.env["ELECTRON_RENDERER_URL"]) {
    void win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
  return win;
}

export function attachWindow(win: any) {
  if (!win || win.isDestroyed()) return;
  win.webContents.on("will-navigate", (e: any) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }: any) => {
    if (url.startsWith("https:")) void shell.openExternal(url);
    return { action: "deny" };
  });
  if (process.env["ELECTRON_RENDERER_URL"]) {
    void win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
  if (!win.isVisible()) win.show();
  win.focus();
}

export function buildMenu() {
  const isMac = process.platform === "darwin";
  const template: any[] = [
    ...isMac ? [{ role: "appMenu" }] : [],
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
