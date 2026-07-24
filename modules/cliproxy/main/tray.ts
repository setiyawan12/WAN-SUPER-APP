import { app, Menu, Tray, nativeImage } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { backendUrl } from "./config.js";
import { showWindow } from "./window.js";
import { showQuickChat } from "./quick-chat.js";
import {
  onHealthChange,
  getLastHealth,
  refreshHealth,
  syncNow,
  copyApiKey,
  type HealthSummary,
} from "./vscode-sync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tray: Tray | null = null;

function loadIcon(): Electron.NativeImage {
  // Colored icon copied next to the compiled main (see scripts/copy-assets.mjs)
  // so it's available in the packaged app too. Not a macOS template image --
  // the brand color should show in the menu bar.
  const iconPath = path.join(__dirname, "tray.png");
  if (fs.existsSync(iconPath)) {
    const img = nativeImage.createFromPath(iconPath);
    return process.platform === "darwin" ? img.resize({ width: 18, height: 18 }) : img;
  }
  return nativeImage.createEmpty();
}

async function serverAction(action: "start" | "stop" | "restart"): Promise<void> {
  try {
    await fetch(`${backendUrl()}/api/server/${action}`, { method: "POST" });
  } catch {
    /* backend not reachable -- ignore */
  }
  await refreshHealth();
}

function healthLabel(h: HealthSummary): string {
  if (!h.reachable) return "Health: server unreachable";
  if (!h.entries.length) return "Health: no accounts";
  return h.unavailable > 0
    ? `Health: ${h.available} available, ${h.unavailable} down`
    : `Health: ${h.available} available`;
}

function rebuildMenu(): void {
  if (!tray) return;
  const h = getLastHealth();

  const accountItems: Electron.MenuItemConstructorOptions[] = h.entries.length
    ? h.entries.slice(0, 12).map((e) => ({
        label: `${e.ok ? "🟢" : "🔴"} ${e.label} (${e.provider})`,
        enabled: false,
      }))
    : [{ label: "No provider accounts", enabled: false }];

  const menu = Menu.buildFromTemplate([
    { label: "Open Dashboard", click: () => showWindow() },
    { label: "Ask AI…", click: () => showQuickChat() },
    { type: "separator" },
    { label: "Start CLIProxyAPI", click: () => void serverAction("start") },
    { label: "Stop CLIProxyAPI", click: () => void serverAction("stop") },
    { label: "Restart CLIProxyAPI", click: () => void serverAction("restart") },
    { type: "separator" },
    { label: "Sync VS Code Now", click: () => void syncNow(true) },
    { label: "Copy API Key", click: () => void copyApiKey() },
    { type: "separator" },
    { label: healthLabel(h), enabled: false },
    ...accountItems,
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);

  tray.setContextMenu(menu);
  tray.setToolTip(`WAN X RENN CLIProxyAPI — ${healthLabel(h)}`);
  // A red count in the tray title flags a quota/rate-limit issue at a glance
  // (handbook Tahap 7.4 -- tray instead of a VS Code status bar).
  if (process.platform === "darwin") {
    tray.setTitle(h.reachable && h.unavailable > 0 ? ` ${h.available}/${h.entries.length}` : "");
  }
}

export function createTray(): void {
  tray = new Tray(loadIcon());
  rebuildMenu();
  onHealthChange(() => rebuildMenu());
  tray.on("click", () => showWindow());
}
