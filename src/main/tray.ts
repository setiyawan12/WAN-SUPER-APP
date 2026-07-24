import { app, Menu, Tray, nativeImage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { showHubWindow } from "./hub/hub-window.js";
import { getSettings, setSetting } from "./hub/hub-settings.js";
import { checkForAppUpdates, getUpdateStatus, installAppUpdate } from "./hub/app-updater.js";
import type { ModuleHandle, ModuleId } from "./module-types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tray: Tray | null = null;
let openModuleFn: ((id: ModuleId, opts?: { show?: boolean }) => Promise<ModuleHandle>) | null =
  null;
let getHandles: (() => { cliproxy: ModuleHandle | null; net: ModuleHandle | null }) | null =
  null;

function loadIcon(): Electron.NativeImage {
  // Compiled to out/main/tray.js — icons copied next to it.
  // Prefer monochrome tray mark; on macOS mark as template for light/dark menu bar.
  for (const name of ["tray.png", "icon.png"]) {
    const iconPath = path.join(__dirname, name);
    if (!fs.existsSync(iconPath)) continue;
    const img = nativeImage.createFromPath(iconPath);
    if (img.isEmpty()) continue;
    if (process.platform === "darwin") {
      const sized = img.resize({ width: 18, height: 18 });
      // Template = system tints the glyph (menu bar light/dark).
      sized.setTemplateImage(true);
      return sized;
    }
    return img.resize({ width: 24, height: 24 });
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
    {
      label: (() => {
        const u = getUpdateStatus();
        if (u.phase === "downloaded") return `Pasang update ${u.availableVersion ?? ""}…`.trim();
        if (u.phase === "available") return `Update tersedia (${u.availableVersion})…`;
        if (u.phase === "downloading") return `Mengunduh update… ${Math.round(u.percent)}%`;
        return "Check for Update…";
      })(),
      click: () => {
        showHubWindow();
        const u = getUpdateStatus();
        if (u.phase === "downloaded") {
          installAppUpdate();
          return;
        }
        void checkForAppUpdates();
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
