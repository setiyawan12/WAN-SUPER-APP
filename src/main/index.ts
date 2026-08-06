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
let sshHandle: ModuleHandle | null = null;
let mindmapHandle: ModuleHandle | null = null;
let cleanedUp = false;

function getHandles() {
  return {
    cliproxy: cliproxyHandle,
    net: netHandle,
    ssh: sshHandle,
    mindmap: mindmapHandle,
  };
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
  } else if (id === "ssh") {
    if (!sshHandle) {
      const bootPath = path.join(__dirname, "../modules/ssh/adapter/boot.cjs");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(bootPath) as {
        bootSsh: (o: {
          show: boolean;
          embedOnly?: boolean;
          moduleRoot: string;
        }) => Promise<ModuleHandle>;
      };
      sshHandle = await mod.bootSsh({
        show: show && openInNewWindow,
        embedOnly: !openInNewWindow,
        moduleRoot: path.join(__dirname, "../modules/ssh"),
      });
    } else if (show && openInNewWindow) {
      sshHandle.show();
    }
    handle = sshHandle!;
  } else if (id === "mindmap") {
    if (!mindmapHandle) {
      const bootPath = path.join(__dirname, "../modules/mindmap/adapter/boot.cjs");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(bootPath) as {
        bootMindmap: (o: {
          show: boolean;
          embedOnly?: boolean;
          moduleRoot: string;
        }) => Promise<ModuleHandle>;
      };
      mindmapHandle = await mod.bootMindmap({
        show: show && openInNewWindow,
        embedOnly: !openInNewWindow,
        moduleRoot: path.join(__dirname, "../modules/mindmap"),
      });
    } else if (show && openInNewWindow) {
      mindmapHandle.show();
    }
    handle = mindmapHandle;
  } else {
    throw new Error(`Unknown module: ${id satisfies never}`);
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

// Linux: Chromium's setuid sandbox needs a root-owned `chrome-sandbox` with the
// SUID bit (mode 4755). AppImage mounts read-only over FUSE so SUID can never
// apply, and newer kernels (Ubuntu 23.10+) block unprivileged user namespaces
// unless a matching AppArmor profile is installed. In both cases Electron either
// refuses to start or crashes in the zygote (LaunchProcess: failed to execvp …
// zygote_host_impl_linux.cc Check failed) and forces the user to launch with
// `--no-sandbox` by hand.
//
// `appendSwitch("no-sandbox")` is not honored early enough to stop the setuid
// sandbox helper from being probed, so the only reliable fix — equivalent to a
// manual `wan-super-app --no-sandbox` — is to relaunch once with the flag as a
// real argv argument. The guard prevents a relaunch loop. (Renderers only load
// bundled local content, so dropping the sandbox is an acceptable trade-off.)
if (process.platform === "linux" && !process.argv.includes("--no-sandbox")) {
  app.commandLine.appendSwitch("no-sandbox");
  app.relaunch({ args: process.argv.slice(1).concat("--no-sandbox") });
  app.exit(0);
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
    // Always land on the hub home page first.
    createHubWindow(settings.autoLaunch && settings.startHidden);

    if (process.platform !== "linux") {
      app.setLoginItemSettings({
        openAtLogin: settings.autoLaunch,
        openAsHidden: settings.startHidden,
      });
    }

    // Reopen last module only as a separate window. In replace-mode
    // (openInNewWindow=false) auto-open would steal the hub shell and skip home.
    const canReopenAsWindow =
      settings.reopenLastModule &&
      !!settings.lastModule &&
      settings.openInNewWindow !== false;
    if (canReopenAsWindow) {
      try {
        await openModule(settings.lastModule!, {
          show: !(settings.autoLaunch && settings.startHidden),
        });
        // Keep hub as the focused home window when both are visible.
        if (!(settings.autoLaunch && settings.startHidden)) {
          showHubWindow();
        }
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
