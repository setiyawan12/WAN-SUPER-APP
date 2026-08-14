import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deleteApp, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { app, BrowserWindow } from "electron";
import { createServer as createViteServer } from "vite";
import { createFirebaseAuthenticator } from "../dist/src/auth/firebase.js";
import { loadConfig } from "../dist/src/config.js";
import { createGatewayRuntime } from "../dist/src/server.js";

const serviceDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(serviceDirectory, "../..");
const emulatorHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || "demo-wan-super-app";
assert.ok(emulatorHost, "FIREBASE_AUTH_EMULATOR_HOST is required");

const testDirectory = mkdtempSync(path.join(tmpdir(), "wan-ssh-firebase-browser-"));
const privateKeyPath = path.join(testDirectory, "ephemeral-test-key");
writeFileSync(privateKeyPath, "invalid-test-key\n", { mode: 0o600 });
app.disableHardwareAcceleration();
app.setPath("userData", path.join(testDirectory, "user-data"));

const webPort = await availablePort();
const webOrigin = `http://127.0.0.1:${webPort}`;
let authenticatedUid;
const firebaseAuthenticator = createFirebaseAuthenticator(projectId);
const runtime = createGatewayRuntime(loadConfig({
  WAN_SSH_ENV: "development",
  WAN_SSH_AUTH_MODE: "firebase",
  WAN_SSH_FIREBASE_PROJECT_ID: projectId,
  WAN_SSH_BIND_HOST: "127.0.0.1",
  WAN_SSH_ALLOWED_ORIGINS: webOrigin,
  WAN_SSH_CONNECT_TIMEOUT_MS: "500",
  WAN_SSH_AUTH_TIMEOUT_MS: "2000",
  WAN_SSH_HEARTBEAT_MS: "1000",
  WAN_SSH_LOG_LEVEL: "error"
}), {
  authenticator: {
    async authenticate(message) {
      const principal = await firebaseAuthenticator.authenticate(message);
      authenticatedUid = principal.uid;
      return principal;
    },
    refresh(principal, token) {
      return firebaseAuthenticator.refresh(principal, token);
    }
  }
});

let vite;
let window;
let uid;
try {
  const gatewayAddress = await runtime.listen(0, "127.0.0.1");
  if (!gatewayAddress || typeof gatewayAddress === "string") throw new Error("Expected a TCP gateway address");
  const gatewayUrl = `http://127.0.0.1:${gatewayAddress.port}`;
  process.env.VITE_FIREBASE_CONFIG = JSON.stringify({
    apiKey: "demo-key",
    authDomain: `${projectId}.firebaseapp.com`,
    projectId,
    appId: "1:123:web:wan-ssh-emulator"
  });
  process.env.VITE_FIREBASE_AUTH_EMULATOR_HOST = `http://${emulatorHost}`;
  process.env.WAN_SSH_WEB_CONNECT_SRC = `'self' ws://127.0.0.1:${webPort}`;

  vite = await createViteServer({
    configFile: path.join(root, "vite.config.ssh-web.ts"),
    logLevel: "error",
    server: {
      host: "127.0.0.1",
      port: webPort,
      strictPort: true,
      proxy: {
        "/healthz": { target: gatewayUrl },
        "/runtime-config.json": { target: gatewayUrl },
        "/v1/ws": { target: gatewayUrl, ws: true }
      }
    }
  });
  await vite.listen();

  const account = await createAccount();
  uid = account.localId;
  await app.whenReady();
  window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  window.webContents.debugger.attach("1.3");
  await window.loadURL(webOrigin);
  await waitFor(window, "document.querySelector('.web-auth-form h2')?.textContent === 'Sign in'");
  assert.equal(await text(window, ".web-auth-context > small"), "Firebase Auth emulator");
  await assertVisiblePage(window);

  await setInput(window, ".web-auth-form input[type=email]", account.email);
  await setInput(window, ".web-auth-form input[type=password]", account.password);
  await window.webContents.executeJavaScript("document.querySelector('.web-auth-form').requestSubmit()");
  await waitFor(window, "Boolean(document.querySelector('.web-connect-panel'))", 15_000);
  assert.match(await text(window, ".web-account span"), new RegExp(account.email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  await selectFile(window, privateKeyPath);
  await waitFor(window, "document.querySelector('.web-connect-form button[type=submit]')?.disabled === false");
  await window.webContents.executeJavaScript("document.querySelector('.web-connect-form').requestSubmit()");
  await waitUntil(() => authenticatedUid === uid, 15_000, "Gateway did not verify the browser Firebase UID");
  await waitUntil(() => runtime.activeConnectionCount === 1, 5_000, "Authenticated WebSocket was not retained");
  assert.equal(new URL(await window.webContents.executeJavaScript("location.href")).search, "");

  await window.webContents.executeJavaScript("document.querySelector('button[title=\"Sign out\"]').click()");
  await waitFor(window, "document.querySelector('.web-auth-form h2')?.textContent === 'Sign in'", 15_000);
  await waitUntil(() => runtime.activeConnectionCount === 0, 5_000, "Logout did not close the WebSocket");
  assert.equal(runtime.sessions.activeCount, 0);

  window.setContentSize(390, 844);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const layout = await window.webContents.executeJavaScript(`({
    scrollWidth: document.body.scrollWidth,
    clientWidth: document.body.clientWidth,
    formWidth: document.querySelector('.web-auth-form')?.getBoundingClientRect().width ?? 0
  })`);
  assert.equal(layout.scrollWidth, layout.clientWidth);
  assert.ok(layout.formWidth > 0 && layout.formWidth <= layout.clientWidth);

  process.stdout.write("WAN SSH Firebase browser E2E passed: login UI, ID-token WebSocket auth, verified UID, logout cleanup, and mobile layout.\n");
} finally {
  if (window?.webContents.debugger.isAttached()) window.webContents.debugger.detach();
  if (window && !window.isDestroyed()) window.destroy();
  const firebaseApp = getApps().find((candidate) => candidate.name === "wan-ssh-gateway");
  if (firebaseApp && uid) await getAuth(firebaseApp).deleteUser(uid).catch(() => undefined);
  await vite?.close();
  await runtime.shutdown("firebase-browser-test");
  if (firebaseApp) await deleteApp(firebaseApp).catch(() => undefined);
  rmSync(testDirectory, { recursive: true, force: true });
  app.exit(process.exitCode || 0);
}

async function createAccount() {
  const email = `wan-ssh-browser-${crypto.randomUUID()}@example.test`;
  const password = "WanSshBrowser123!";
  const response = await fetch(`http://${emulatorHost}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true })
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Auth Emulator account creation failed: ${JSON.stringify(body)}`);
  assert.equal(typeof body.localId, "string");
  return { email, password, localId: body.localId };
}

async function selectFile(browserWindow, filePath) {
  const document = await browserWindow.webContents.debugger.sendCommand("DOM.getDocument", { depth: 0 });
  const input = await browserWindow.webContents.debugger.sendCommand("DOM.querySelector", {
    nodeId: document.root.nodeId,
    selector: "input[type=file]"
  });
  assert.ok(input.nodeId, "Private-key file input was not found");
  await browserWindow.webContents.debugger.sendCommand("DOM.setFileInputFiles", {
    nodeId: input.nodeId,
    files: [filePath]
  });
}

function setInput(browserWindow, selector, value) {
  return browserWindow.webContents.executeJavaScript(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
}

async function assertVisiblePage(browserWindow) {
  const capture = await browserWindow.webContents.capturePage();
  assert.equal(capture.isEmpty(), false);
  const bitmap = capture.toBitmap();
  assert.ok(new Set(bitmap.subarray(0, Math.min(bitmap.length, 256 * 1024))).size > 8, "Auth page capture is unexpectedly blank");
}

async function waitFor(browserWindow, expression, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await browserWindow.webContents.executeJavaScript(`Boolean(${expression})`)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for browser condition: ${expression}`);
}

async function waitUntil(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

function text(browserWindow, selector) {
  return browserWindow.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`);
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createTcpServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Expected a TCP port"));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}