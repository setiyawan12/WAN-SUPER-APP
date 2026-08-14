import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const serviceDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDirectory = (await readFile(path.join(serviceDirectory, ".runtime/fixture-dir"), "utf8")).trim();
let privateKey = await readFile(path.join(fixtureDirectory, "id_ed25519"), "utf8");
let password = (await readFile(path.join(fixtureDirectory, "password"), "utf8")).trim();
const socket = new WebSocket("ws://127.0.0.1:5179/v1/ws", { origin: "http://127.0.0.1:5179" });
const queue = createMessageQueue(socket);

try {
  await waitForOpen(socket);
  const authRequestId = randomUUID();
  socket.send(JSON.stringify({
    type: "auth",
    requestId: authRequestId,
    protocolVersion: 1,
    mode: "dev-anonymous"
  }));
  const authenticated = await queue.next((message) => message.requestId === authRequestId);
  assertMessage(authenticated, "auth.ok");

  const openRequestId = randomUUID();
  socket.send(JSON.stringify({
    type: "session.open",
    requestId: openRequestId,
    target: { host: "ssh-target", port: 22, username: "wan" },
    terminal: { cols: 80, rows: 24, term: "xterm-256color" },
    authentication: { method: "privateKey", privateKey }
  }));
  privateKey = "";
  const opened = await queue.next((message) => message.requestId === openRequestId);
  assertMessage(opened, "session.opened");
  const sessionId = opened.sessionId;
  let fixtureFingerprint;

  while (true) {
    const message = await queue.next((candidate) => candidate.sessionId === sessionId);
    if (message.type === "hostkey.prompt") {
      fixtureFingerprint = message.fingerprint;
      socket.send(JSON.stringify({ type: "hostkey.answer", requestId: randomUUID(), sessionId, accept: true }));
      continue;
    }
    if (message.type === "error") throw new Error(`${message.code}: ${message.message}`);
    if (message.type === "session.state" && message.state === "connected") break;
  }

  socket.send(JSON.stringify({ type: "session.resize", sessionId, cols: 101, rows: 37 }));
  socket.send(JSON.stringify({ type: "session.input", sessionId, data: "printf 'WAN_SSH_E2E_OK\\n'; printf 'SIZE='; stty size; exit\r" }));

  let output = "";
  let exited = false;
  while (!exited) {
    const message = await queue.next((candidate) => candidate.sessionId === sessionId);
    if (message.type === "session.output") output += message.data;
    if (message.type === "error") throw new Error(`${message.code}: ${message.message}`);
    if (message.type === "session.exit") exited = true;
  }

  if (!output.includes("WAN_SSH_E2E_OK")) throw new Error("Terminal output marker was not returned");
  if (!/SIZE=37 101/.test(output.replace(/\r/g, ""))) throw new Error("PTY resize was not observed by the remote shell");

  const passwordRequestId = randomUUID();
  socket.send(JSON.stringify({
    type: "session.open",
    requestId: passwordRequestId,
    target: { host: "ssh-target", port: 22, username: "wan" },
    terminal: { cols: 80, rows: 24, term: "xterm-256color" },
    authentication: { method: "password", password },
    expectedHostKeyFingerprint: fixtureFingerprint
  }));
  password = "";
  const passwordOpened = await queue.next((message) => message.requestId === passwordRequestId);
  assertMessage(passwordOpened, "session.opened");
  const passwordSessionId = passwordOpened.sessionId;
  while (true) {
    const message = await queue.next((candidate) => candidate.sessionId === passwordSessionId);
    if (message.type === "error") throw new Error(`${message.code}: ${message.message}`);
    if (message.type === "session.state" && message.state === "connected") break;
  }
  socket.send(JSON.stringify({ type: "session.input", sessionId: passwordSessionId, data: "printf 'WAN_SSH_PASSWORD_OK\\n'; exit\r" }));
  let passwordOutput = "";
  let passwordExited = false;
  while (!passwordExited) {
    const message = await queue.next((candidate) => candidate.sessionId === passwordSessionId);
    if (message.type === "session.output") passwordOutput += message.data;
    if (message.type === "error") throw new Error(`${message.code}: ${message.message}`);
    if (message.type === "session.exit") passwordExited = true;
  }
  if (!passwordOutput.includes("WAN_SSH_PASSWORD_OK")) throw new Error("Password terminal output marker was not returned");
  process.stdout.write("WAN SSH Web E2E passed: auth, TOFU, key/password login, PTY output, resize, and close.\n");
} finally {
  privateKey = "";
  password = "";
  queue.close();
  socket.close(1000, "E2E complete");
}

function waitForOpen(webSocket) {
  return new Promise((resolve, reject) => {
    webSocket.once("open", resolve);
    webSocket.once("error", reject);
  });
}

function createMessageQueue(webSocket) {
  const messages = [];
  const waiters = [];
  let terminalError;
  const onMessage = (data) => {
    let message;
    try { message = JSON.parse(data.toString()); }
    catch { return fail(new Error("Gateway returned invalid JSON")); }
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timeout);
      waiter.resolve(message);
    } else {
      messages.push(message);
    }
  };
  const fail = (error) => {
    terminalError = error;
    while (waiters.length) {
      const waiter = waiters.shift();
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
  };
  const onError = (error) => fail(error instanceof Error ? error : new Error("WebSocket failed"));
  const onClose = (code) => {
    if (code !== 1000) fail(new Error(`WebSocket closed with code ${code}`));
  };
  webSocket.on("message", onMessage);
  webSocket.on("error", onError);
  webSocket.on("close", onClose);
  return {
    next(predicate, timeoutMs = 20_000) {
      if (terminalError) return Promise.reject(terminalError);
      const index = messages.findIndex(predicate);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error("Timed out waiting for gateway message"));
        }, timeoutMs);
        waiters.push({ predicate, resolve, reject, timeout });
      });
    },
    close() {
      webSocket.off("message", onMessage);
      webSocket.off("error", onError);
      webSocket.off("close", onClose);
      fail(new Error("Message queue closed"));
    }
  };
}

function assertMessage(message, expectedType) {
  if (message.type === "error") throw new Error(`${message.code}: ${message.message}`);
  if (message.type !== expectedType) throw new Error(`Expected ${expectedType}, received ${message.type}`);
}