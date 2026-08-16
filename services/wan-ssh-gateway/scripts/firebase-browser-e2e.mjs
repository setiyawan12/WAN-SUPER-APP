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
const databaseEmulatorHost = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || "demo-wan-super-app";
assert.ok(emulatorHost, "FIREBASE_AUTH_EMULATOR_HOST is required");
assert.ok(databaseEmulatorHost, "FIREBASE_DATABASE_EMULATOR_HOST is required");

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
    appId: "1:123:web:wan-ssh-emulator",
    databaseURL: `https://${projectId}-default-rtdb.firebaseio.com`
  });
  process.env.VITE_FIREBASE_AUTH_EMULATOR_HOST = `http://${emulatorHost}`;
  process.env.VITE_FIREBASE_DATABASE_EMULATOR_HOST = `http://${databaseEmulatorHost}`;
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
  assert.equal(await pathname(window), "/login", "Unauthenticated root must redirect to /login");
  assert.equal(await text(window, ".web-auth-context > small"), "Firebase Auth emulator");
  assert.match(await text(window, ".web-auth-google"), /Continue with Google/);
  await assertVisiblePage(window);

  // Protected route tanpa sesi harus jatuh ke /login, bukan ke workspace.
  await window.loadURL(`${webOrigin}/settings`);
  await waitFor(window, "document.querySelector('.web-auth-form h2')?.textContent === 'Sign in'");
  assert.equal(await pathname(window), "/login", "Protected route must redirect to /login");
  assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('.web-connect-panel').length"), 0);

  await setInput(window, ".web-auth-form input[type=email]", account.email);
  await setInput(window, ".web-auth-form input[type=password]", account.password);
  await window.webContents.executeJavaScript("document.querySelector('.web-auth-form').requestSubmit()");
  await waitFor(window, "document.querySelector('.vault-title-block h1')?.textContent === 'Create encrypted vault'", 15_000);
  assert.equal(await pathname(window), "/dashboard", "Signed-in session must land on /dashboard");
  assert.match(await text(window, ".vault-account"), new RegExp(account.email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const vaultPassword = "WanSshCloudVault123!";
  await setInput(window, ".vault-panel input[type=password]:first-of-type", vaultPassword);
  await setInput(window, ".vault-panel input[type=password]:last-of-type", vaultPassword);
  await window.webContents.executeJavaScript("document.querySelector('.vault-panel').requestSubmit()");
  await waitFor(window, "Boolean(document.querySelector('.resource-explorer'))", 30_000);
  assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('.nav-button').length"), 0, "Cloud workspace must not expose local shell");
  assert.equal(await text(window, ".product-mark strong"), "WANN SSH");

  await window.webContents.executeJavaScript("document.querySelector('button[title=Settings]').click()");
  await waitFor(window, "document.querySelector('.modal-header h2')?.textContent === 'SSH workspace settings'");
  await waitUntil(() => authenticatedUid === uid, 15_000, "Gateway did not verify the browser Firebase UID");
  await waitUntil(() => runtime.activeConnectionCount === 1, 5_000, "Authenticated cloud WebSocket was not retained");
  await window.webContents.executeJavaScript("document.querySelector('.modal-header button').click()");

  await window.webContents.executeJavaScript("[...document.querySelectorAll('.heading-actions button')].find((button) => button.title === 'Tambah host').click()");
  await waitFor(window, "document.querySelector('.modal-header h2')?.textContent === 'New SSH host'");
  await setInput(window, "#host-form input[required]:first-of-type", "Cloud Production");
  const requiredInputs = await window.webContents.executeJavaScript("[...document.querySelectorAll('#host-form input[required]')].map((input) => input.outerHTML)");
  assert.equal(requiredInputs.length >= 2, true);
  await setInput(window, "#host-form input[placeholder*='host.example.com']", "ssh.example.internal");
  await window.webContents.executeJavaScript("[...document.querySelectorAll('.modal-tabs button')].find((button) => button.textContent === 'Authentication').click()");
  await setInput(window, "#host-form input[placeholder=root]", "deploy");
  const sshPassword = "CloudSshPassword123!";
  await setInput(window, "#host-form input[type=password]", sshPassword);
  await window.webContents.executeJavaScript("document.querySelector('#host-form').requestSubmit()");
  await waitFor(window, "document.querySelector('.host-name')?.textContent === 'Cloud Production'", 15_000);

  const stored = await readRtdb(uid, account.idToken);
  assert.equal(stored.meta?.vaultId, "personal");
  assert.equal(stored.meta?.wrappedVaultKey?.alg, "A256GCM");
  const storedValues = Object.values(stored.items || {});
  const storedHost = storedValues.find((item) => item.type === "host");
  const storedIdentity = storedValues.find((item) => item.type === "identity");
  assert.equal(storedHost?.label, "Cloud Production");
  assert.equal(storedIdentity?.username, "deploy");
  assert.equal(storedIdentity?.secret?.alg, "A256GCM");
  assert.equal(JSON.stringify(stored).includes(sshPassword), false);

  // Sesi Firebase harus bertahan setelah reload dan /login harus balik ke dashboard.
  await window.loadURL(`${webOrigin}/login`);
  await waitFor(window, "document.querySelector('.vault-title-block h1')?.textContent === 'Unlock workspace'", 15_000);
  assert.equal(await pathname(window), "/dashboard", "Persisted session must leave /login");
  await setInput(window, ".vault-panel input[type=password]", vaultPassword);
  await window.webContents.executeJavaScript("document.querySelector('.vault-panel').requestSubmit()");
  await waitFor(window, "document.querySelector('.host-name')?.textContent === 'Cloud Production'", 30_000);

  window.setContentSize(390, 844);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const layout = await window.webContents.executeJavaScript(`({
    scrollWidth: document.body.scrollWidth,
    clientWidth: document.body.clientWidth,
    scrollHeight: document.body.scrollHeight,
    clientHeight: document.body.clientHeight,
    titlebarWidth: document.querySelector('.app-titlebar')?.getBoundingClientRect().width ?? 0
  })`);
  assert.equal(layout.scrollWidth, layout.clientWidth);
  assert.equal(layout.scrollHeight, layout.clientHeight);
  assert.ok(layout.titlebarWidth > 0 && layout.titlebarWidth <= layout.clientWidth);

  window.setContentSize(1280, 800);
  await window.webContents.executeJavaScript("[...document.querySelectorAll('.app-titlebar button')].find((button) => button.textContent.includes('Lock')).click()");
  await waitFor(window, "document.querySelector('.vault-title-block h1')?.textContent === 'Unlock workspace'");
  await window.webContents.executeJavaScript("[...document.querySelectorAll('.vault-account button')].find((button) => button.textContent === 'Sign out').click()");
  await waitFor(window, "document.querySelector('.web-auth-form h2')?.textContent === 'Sign in'", 15_000);
  assert.equal(await pathname(window), "/login", "Logout must return to /login");
  await waitUntil(() => runtime.activeConnectionCount === 0, 5_000, "Logout did not close the WebSocket");
  assert.equal(runtime.sessions.activeCount, 0);

  process.stdout.write("WAN SSH Firebase browser E2E passed: route guard, encrypted cloud vault, desktop workspace parity, host persistence without plaintext credentials, lock/unlock, logout cleanup, and mobile layout.\n");
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

function setInput(browserWindow, selector, value) {
  return browserWindow.webContents.executeJavaScript(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
}

async function readRtdb(uid, token) {
  const host = databaseEmulatorHost.replace(/^https?:\/\//, "");
  const [hostname, port] = host.split(":");
  const base = `http://${hostname}:${port}`;
  const [metaResponse, itemsResponse] = await Promise.all([
    fetch(`${base}/users/${uid}/vaultMeta/personal.json?auth=${encodeURIComponent(token)}`),
    fetch(`${base}/users/${uid}/vaults/personal/items.json?auth=${encodeURIComponent(token)}`)
  ]);
  assert.equal(metaResponse.ok, true);
  assert.equal(itemsResponse.ok, true);
  return { meta: await metaResponse.json(), items: await itemsResponse.json() };
}

async function assertVisiblePage(browserWindow, timeoutMs = 10_000) {
  // capturePage() mengembalikan frame yang terakhir di-composite, sehingga
  // capture dapat mendahului paint pertama halaman login. Tunggu sampai frame
  // benar-benar berisi konten, bukan latar polos.
  const deadline = Date.now() + timeoutMs;
  let distinctValues = 0;
  while (Date.now() < deadline) {
    const capture = await browserWindow.webContents.capturePage();
    if (!capture.isEmpty()) {
      const bitmap = capture.toBitmap();
      distinctValues = new Set(bitmap.subarray(0, Math.min(bitmap.length, 256 * 1024))).size;
      if (distinctValues > 8) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.fail(`Auth page capture is unexpectedly blank (distinct sampled values: ${distinctValues})`);
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

function pathname(browserWindow) {
  return browserWindow.webContents.executeJavaScript("location.pathname");
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