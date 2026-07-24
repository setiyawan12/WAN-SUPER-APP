import { app, Menu, Tray, nativeImage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { showHubWindow } from "./hub/hub-window.js";
import { getSettings, setSetting } from "./hub/hub-settings.js";
import type { ModuleHandle, ModuleId } from "./module-types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tray: Tray | null = null;
let openModuleFn: ((id: ModuleId, opts?: { show?: boolean }) => Promise<ModuleHandle>) | null =
  null;
let getHandles: (() => { cliproxy: ModuleHandle | null; net: ModuleHandle | null }) | null =
  null;

function loadIcon(): Electron.NativeImage {
  // Compiled to out/main/tray.js — icons copied next to it
  for (const name of ["tray.png", "icon.png"]) {
    const iconPath = path.join(__dirname, name);
    if (fs.existsSync(iconPath)) {
      const img = nativeImage.createFromPath(iconPath);
      return process.platform === "darwin" ? img.resize({ width: 18, height: 18 }) : img;
    }
  }
  return nativeImage.createEmpty();
}

export function setTrayCallbacks(opts: {
  openModule: (id: ModuleId, opts?: { show?: boolean }) => Promise<ModuleHandle>;
  getHandles: () => { cliproxy: ModuleHandle | null; net: ModuleHandle | null };
}): void {
  openModuleFn = opts.openModule;
  getHandles = opts.getHandles;
  rebuildTrayMenu();
}

export function rebuildTrayMenu(): void {
  if (!tray) return;
  const handles = getHandles?.() ?? { cliproxy: null, net: null };
  const settings = getSettings();

  const menu = Menu.buildFromTemplate([
    { label: "⚡ WAN Super App", enabled: false },
    { type: "separator" },
    { label: "Buka Hub", click: () => showHubWindow() },
    { type: "separator" },
    {
      label: "CLIProxyAPI",
      submenu: [
        {
          label: "Buka dashboard",
          click: () => void openModuleFn?.("cliproxy", { show: true }),
        },
        {
          label: handles.cliproxy?.isRunning() ? "Running" : "Not started",
          enabled: false,
        },
      ],
    },
    {
      label: "WAN NET",
      submenu: [
        {
          label: "Buka dashboard",
          click: () => void openModuleFn?.("net", { show: true }),
        },
        {
          label: handles.net?.isRunning() ? "Running" : "Not started",
          enabled: false,
        },
      ],
    },
    { type: "separator" },
    {
      label: "Launch at login",
      type: "checkbox",
      checked: settings.autoLaunch,
      click: (item) => {
        setSetting("autoLaunch", item.checked);
        if (process.platform !== "linux") {
          app.setLoginItemSettings({
            openAtLogin: item.checked,
            openAsHidden: getSettings().startHidden,
          });
        }
      },
    },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);

  tray.setContextMenu(menu);
  tray.setToolTip("WAN Super App");
}

export function createTray(): void {
  tray = new Tray(loadIcon());
  rebuildTrayMenu();
  tray.on("click", () => showHubWindow());
}
