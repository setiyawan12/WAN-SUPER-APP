import { app, BrowserWindow, dialog } from "electron";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createHubWindow,
  ensureModuleShell,
  setHubQuitting,
  showHubWindow,
} from "./hub/hub-window.js";
import { getSettings, setSetting } from "./hub/hub-settings.js";
import { registerHubIpc } from "./hub/hub-ipc.js";
import { initAppUpdater, onUpdateStatus } from "./hub/app-updater.js";
import { createTray, setTrayCallbacks, rebuildTrayMenu } from "./tray.js";
import { shutdownAll } from "./lifecycle.js";
import type { ModuleHandle, ModuleId } from "./module-types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let cliproxyHandle: ModuleHandle | null = null;
let netHandle: ModuleHandle | null = null;
let cleanedUp = false;

function getHandles() {
  return { cliproxy: cliproxyHandle, net: netHandle };
}

async function openModule(id: ModuleId, opts: { show?: boolean } = {}): Promise<ModuleHandle> {
  const show = opts.show !== false;
  const openInNewWindow = getSettings().openInNewWindow !== false;
  let handle: ModuleHandle;

  if (id === "cliproxy") {
    if (!cliproxyHandle) {
      const bootUrl = pathToFileURL(
        path.join(__dirname, "../modules/cliproxy/main/super-boot.js")
      ).href;
      const mod = await import(bootUrl);
      cliproxyHandle = await mod.bootCliproxy({
        // In replace mode we never create a dedicated module window.
        show: show && openInNewWindow,
        embedOnly: !openInNewWindow,
        moduleRoot: path.join(__dirname, "../modules/cliproxy"),
      });
    } else if (show && openInNewWindow) {
      cliproxyHandle.show();
    }
    handle = cliproxyHandle!;
  } else if (id === "net") {
    if (!netHandle) {
      const bootPath = path.join(__dirname, "../modules/net/adapter/boot.cjs");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(bootPath) as {
        bootNet: (o: {
          show: boolean;
          embedOnly?: boolean;
          moduleRoot: string;
        }) => Promise<ModuleHandle>;
      };
      netHandle = await mod.bootNet({
        show: show && openInNewWindow,
        embedOnly: !openInNewWindow,
        moduleRoot: path.join(__dirname, "../modules/net"),
      });
    } else if (show && openInNewWindow) {
      netHandle.show();
    }
    handle = netHandle!;
  } else {
    throw new Error(`Unknown module: ${id}`);
  }

  // Replace mode: swap hub shell content with the selected module UI.
  if (show && !openInNewWindow) {
    const shell = ensureModuleShell(id, { startHidden: false });
    if (handle.presentIn) {
      await handle.presentIn(shell);
    }
  }

  setSetting("lastModule", id);
  rebuildTrayMenu();
  return handle;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showHubWindow());

  app.whenReady().then(async () => {
    const settings = getSettings();

    setTrayCallbacks({ openModule, getHandles });
    registerHubIpc({ openModule, getHandles });
    createTray();
    // GitHub Releases feed (electron-builder.yml publish). Auto-check after hub mounts.
    initAppUpdater({ autoCheck: true });
    onUpdateStatus(() => rebuildTrayMenu());
    createHubWindow(settings.autoLaunch && settings.startHidden);

    if (process.platform !== "linux") {
      app.setLoginItemSettings({
        openAtLogin: settings.autoLaunch,
        openAsHidden: settings.startHidden,
      });
    }

    if (settings.reopenLastModule && settings.lastModule) {
      try {
        await openModule(settings.lastModule, {
          show: !(settings.autoLaunch && settings.startHidden),
        });
      } catch (err) {
        console.warn("[super] reopen last module failed:", err);
      }
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createHubWindow();
      else showHubWindow();
    });
  });

  app.on("window-all-closed", () => {
    /* tray-first */
  });

  app.on("before-quit", async (e) => {
    if (cleanedUp) return;
    e.preventDefault();
    setHubQuitting(true);
    try {
      await shutdownAll(getHandles());
    } catch (err) {
      console.warn("[super] shutdown error:", err);
      dialog.showErrorBox(
        "WAN Super App",
        `Shutdown warning: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    cleanedUp = true;
    app.quit();
  });
}
