import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow } from "electron";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const testRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wan-cliproxy-electron-")));
const userData = path.join(testRoot, "user-data");
const cliproxyHome = path.join(testRoot, "cliproxy-home");
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(cliproxyHome, { recursive: true });
fs.writeFileSync(path.join(userData, "wan-settings.json"), JSON.stringify({
  autoStartServer: false,
  requireApiKey: false,
  autoSyncVsCode: false,
  autoLaunch: false,
  startHidden: false,
  coworkPolicy: "safe",
  maxToolCalls: 0,
  chatComposerMode: "chat",
}), "utf8");

app.disableHardwareAcceleration();
app.setPath("userData", userData);

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

let handle;
let window;
let backendServer;

try {
  const port = await reservePort();
  const cliproxyPort = await reservePort();
  process.env.PORT = String(port);
  process.env.CLIPROXY_HOME = cliproxyHome;
  process.env.CLIPROXY_HOST = "127.0.0.1";
  process.env.CLIPROXY_PORT = String(cliproxyPort);
  process.env.RENN_AUTO_START_SERVER = "0";

  await app.whenReady();
  const bootUrl = pathToFileURL(path.join(root, "out/modules/cliproxy/main/super-boot.js"));
  const { bootCliproxy } = await import(bootUrl.href);
  handle = await bootCliproxy({ show: false, embedOnly: true });

  window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(root, "out/modules/cliproxy/preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await window.loadURL("data:text/html,<meta charset=utf-8><title>Cliproxy Local Smoke</title>");

  const result = await window.webContents.executeJavaScript(`(async () => {
    const response = await window.wan.request({ method: "GET", path: "/server/status" });
    const backendInfo = await window.wan.backendInfo();
    const settings = await window.wan.getSettings();
    return {
      response,
      backendInfo,
      settings,
      hasWan: typeof window.wan === "object",
      hasRawIpcRenderer: "ipcRenderer" in window,
    };
  })()`);

  assert.equal(result.hasWan, true);
  assert.equal(result.hasRawIpcRenderer, false);
  assert.equal(result.response.ok, true);
  assert.equal(result.response.status, 200);
  const status = JSON.parse(result.response.text);
  assert.equal(status.running, false);
  assert.equal(status.binaryInstalled, false);
  assert.equal(fs.realpathSync(status.home), fs.realpathSync(cliproxyHome));
  assert.equal(result.backendInfo.port, port);
  assert.equal(result.backendInfo.proxyUrl, `http://127.0.0.1:${port}/api/proxy/v1/chat/completions`);
  assert.equal(result.settings.autoStartServer, false);
  assert.equal(result.settings.autoSyncVsCode, false);
  assert.equal(handle.isRunning(), true);
  assert.deepEqual(handle.getStatus(), { running: true, port });

  const backend = await import(pathToFileURL(path.join(root, "out/modules/cliproxy/main/backend/index.js")).href);
  backendServer = backend.backendServer;
  const address = backendServer.address();
  assert.ok(address && typeof address === "object");
  assert.equal(address.address, "127.0.0.1");

  console.log(`Cliproxy Electron Local smoke passed (preload -> named IPC -> loopback backend :${port}, no cloud login).`);
} catch (error) {
  process.exitCode = 1;
  console.error(error);
} finally {
  if (window && !window.isDestroyed()) window.destroy();
  if (handle) await handle.shutdown();
  if (backendServer?.listening) {
    await new Promise((resolve, reject) => {
      backendServer.close((error) => error ? reject(error) : resolve());
    });
  }
  fs.rmSync(testRoot, { recursive: true, force: true });
  app.exit(process.exitCode || 0);
}