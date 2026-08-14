import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";

const serviceDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDirectory = readFileSync(path.join(serviceDirectory, ".runtime/fixture-dir"), "utf8").trim();
const privateKeyPath = path.join(fixtureDirectory, "id_ed25519");
const privateKey = readFileSync(privateKeyPath);
const privateMarker = uniquePrivateKeyMarker(privateKey.toString("utf8"));
const password = readFileSync(path.join(fixtureDirectory, "password"), "utf8").trim();

const testDirectory = mkdtempSync(path.join(tmpdir(), "wan-ssh-browser-e2e-"));
app.disableHardwareAcceleration();
app.setPath("userData", path.join(testDirectory, "user-data"));

let window;
try {
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
  await window.loadURL("http://127.0.0.1:5179");
  window.webContents.debugger.attach("1.3");
  await waitFor(window, "document.querySelector('.web-gateway-status strong')?.textContent === 'Gateway online'");

  assert.equal(await inputValue(window, ".web-connect-form input:not([type=password]):not([type=number])"), "172.16.88.17");
  assert.equal(await inputValue(window, ".web-connect-form input[type=number]"), "2244");
  await setInput(window, ".web-connect-form input:not([type=password]):not([type=number])", "ssh-target");
  await setInput(window, ".web-connect-form input[type=number]", "22");
  await setInput(window, ".web-connect-form input[autocomplete=username]", "wan");
  await setInput(window, ".web-connect-form input[autocomplete=current-password]", password);
  await waitFor(window, "document.querySelector('.web-connect-form button[type=submit]')?.disabled === false");
  await window.webContents.executeJavaScript("document.querySelector('.web-connect-form').requestSubmit()");
  await waitFor(window, "document.querySelector('[role=dialog] h2')?.textContent === 'Verify SSH host key'", 15_000).catch(async (error) => {
    const state = await window.webContents.executeJavaScript(`(() => ({
      body: document.body.innerText,
      alert: document.querySelector('[role=alert]')?.textContent,
      session: document.querySelector('.web-terminal-toolbar small')?.textContent,
      passwordLength: document.querySelector('input[autocomplete=current-password]')?.value.length,
      submitDisabled: document.querySelector('.web-connect-form button[type=submit]')?.disabled
    }))()`);
    throw new Error(`${error.message}\nBrowser state: ${JSON.stringify(state)}`);
  });

  const prompt = await window.webContents.executeJavaScript(`(() => ({
    body: document.querySelector('[role=dialog]').innerText,
    password: document.querySelector('input[autocomplete=current-password]').value
  }))()`);
  assert.match(prompt.body, /ssh-target:22/);
  assert.match(prompt.body, /ssh-ed25519/);
  assert.match(prompt.body, /SHA256:/);
  assert.equal(prompt.password, "");

  await window.webContents.executeJavaScript("[...document.querySelectorAll('[role=dialog] button')].find((button) => button.textContent === 'Accept').click()");
  await waitFor(window, "document.querySelector('.web-terminal-toolbar small')?.textContent === 'connected'", 20_000);
  assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('[role=dialog]').length"), 0);

  const terminal = await window.webContents.executeJavaScript(`(() => {
    const screen = document.querySelector('.xterm-screen');
    const rect = screen?.getBoundingClientRect();
    return { visibleWidth: rect?.width ?? 0, visibleHeight: rect?.height ?? 0, hasInput: Boolean(document.querySelector('.xterm-helper-textarea')) };
  })()`);
  assert.ok(terminal.visibleWidth > 0 && terminal.visibleHeight > 0 && terminal.hasInput);
  await window.webContents.executeJavaScript("document.querySelector('.xterm-helper-textarea').focus()");
  for (const character of "printf 'WAN_BROWSER_QA_OK\\n'") {
    window.webContents.sendInputEvent({ type: "char", keyCode: character });
  }
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const capture = await window.webContents.capturePage();
  assert.equal(capture.isEmpty(), false);
  const bitmap = capture.toBitmap();
  assert.ok(new Set(bitmap.subarray(0, Math.min(bitmap.length, 256 * 1024))).size > 8, "Browser capture is unexpectedly blank");

  const storage = await window.webContents.executeJavaScript(`(async () => {
    const databases = await indexedDB.databases();
    const records = [];
    if (databases.some((database) => database.name === 'wan-ssh-web')) {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open('wan-ssh-web', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      records.push(...await new Promise((resolve, reject) => {
        const request = database.transaction('known-hosts', 'readonly').objectStore('known-hosts').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }));
      database.close();
    }
    return { local: { ...localStorage }, session: { ...sessionStorage }, records };
  })()`);
  const serializedStorage = JSON.stringify(storage);
  assert.equal(serializedStorage.includes(privateMarker), false);
  assert.equal(serializedStorage.includes(password), false);
  assert.equal(Object.keys(storage.local).length, 0);
  assert.equal(Object.keys(storage.session).length, 0);
  assert.equal(storage.records.length, 1);
  assert.match(storage.records[0].fingerprint, /^SHA256:/);

  await window.webContents.executeJavaScript("document.querySelector('button[title=\"Close session\"]').click()");
  await waitFor(window, "document.querySelector('.web-terminal-toolbar strong')?.textContent === 'No active session'");
  await window.webContents.executeJavaScript("[...document.querySelectorAll('.web-auth-method button')].find((button) => button.textContent.includes('Private key')).click()");
  await selectFixtureKey(window, privateKeyPath);
  assert.equal(await text(window, ".web-file-picker strong"), "id_ed25519");
  await waitFor(window, "document.querySelector('.web-connect-form button[type=submit]')?.disabled === false");
  await window.webContents.executeJavaScript("document.querySelector('.web-connect-form').requestSubmit()");
  await waitFor(window, "document.querySelector('.web-terminal-toolbar small')?.textContent === 'connected'", 20_000);
  assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('[role=dialog]').length"), 0);

  window.setContentSize(390, 844);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const layout = await window.webContents.executeJavaScript(`(() => ({
    scrollWidth: document.body.scrollWidth,
    clientWidth: document.body.clientWidth,
    scrollHeight: document.body.scrollHeight,
    clientHeight: document.body.clientHeight,
    terminalState: document.querySelector('.web-terminal-toolbar small')?.textContent,
    connect: document.querySelector('.web-connect-panel')?.getBoundingClientRect().toJSON(),
    terminal: document.querySelector('.web-terminal-workspace')?.getBoundingClientRect().toJSON()
  }))()`);
  assert.equal(layout.scrollWidth, layout.clientWidth);
  assert.equal(layout.scrollHeight, layout.clientHeight);
  assert.equal(layout.terminalState, "connected");
  assert.ok(layout.connect.bottom <= layout.terminal.top + 1);

  console.log("WAN SSH browser E2E passed: requested target defaults, password/key login, credential cleanup, TOFU persistence, storage scan, and mobile layout.");
} finally {
  if (window?.webContents.debugger.isAttached()) window.webContents.debugger.detach();
  if (window && !window.isDestroyed()) window.destroy();
  rmSync(testDirectory, { recursive: true, force: true });
  app.exit(process.exitCode || 0);
}

async function selectFixtureKey(browserWindow, filePath) {
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

async function waitFor(browserWindow, expression, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await browserWindow.webContents.executeJavaScript(`Boolean(${expression})`)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for browser condition: ${expression}`);
}

function text(browserWindow, selector) {
  return browserWindow.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`);
}

function inputValue(browserWindow, selector) {
  return browserWindow.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)})?.value ?? ''`);
}

function setInput(browserWindow, selector, value) {
  return browserWindow.webContents.executeJavaScript(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
}

function uniquePrivateKeyMarker(value) {
  const bodyLines = value.split("\n").filter((line) => line && !line.startsWith("-----"));
  assert.ok(bodyLines[1]?.length >= 48, "Fixture private-key body is unexpectedly short");
  return bodyLines[1].slice(-48);
}