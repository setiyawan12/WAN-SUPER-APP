import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import WebSocket from "ws";
import { loadConfig } from "../dist/src/config.js";
import { CLOSE_CODES } from "../dist/src/errors.js";
import { createGatewayRuntime } from "../dist/src/server.js";

const emulatorHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || "demo-wan-super-app";
assert.ok(emulatorHost, "FIREBASE_AUTH_EMULATOR_HOST is required");

const runtime = createGatewayRuntime(loadConfig({
  WAN_SSH_ENV: "development",
  WAN_SSH_AUTH_MODE: "firebase",
  WAN_SSH_FIREBASE_PROJECT_ID: projectId,
  WAN_SSH_BIND_HOST: "127.0.0.1",
  WAN_SSH_ALLOWED_ORIGINS: "http://127.0.0.1:5179",
  WAN_SSH_AUTH_TIMEOUT_MS: "2000",
  WAN_SSH_HEARTBEAT_MS: "1000",
  WAN_SSH_LOG_LEVEL: "error"
}));

let uid;
try {
  const address = await runtime.listen(0, "127.0.0.1");
  if (!address || typeof address === "string") throw new Error("Expected a TCP gateway address");
  const wsUrl = `ws://127.0.0.1:${address.port}/v1/ws`;
  const account = await createAccount();
  uid = account.localId;

  const valid = await authenticate(wsUrl, account.idToken);
  assert.equal(valid.message.type, "auth.ok");
  assert.equal(valid.message.principal.uid, uid);

  const app = getApps().find((candidate) => candidate.name === "wan-ssh-gateway");
  assert.ok(app, "Gateway Firebase app was not initialized");
  const adminAuth = getAuth(app);

  const wrongProject = await authenticate(wsUrl, mutateToken(account.idToken, (claims) => ({
    ...claims,
    aud: "another-project",
    iss: "https://securetoken.google.com/another-project"
  })));
  assert.equal(wrongProject.message.code, "AUTH_INVALID");
  assert.equal((await wrongProject.closed).code, CLOSE_CODES.authInvalid);

  const expired = await authenticate(wsUrl, mutateToken(account.idToken, (claims) => ({
    ...claims,
    exp: Math.floor(Date.now() / 1_000) - 60
  })));
  assert.equal(expired.message.code, "AUTH_INVALID");
  assert.equal((await expired.closed).code, CLOSE_CODES.authInvalid);

  const invalid = await authenticate(wsUrl, "not-a-firebase-token");
  assert.equal(invalid.message.code, "AUTH_INVALID");
  assert.equal((await invalid.closed).code, CLOSE_CODES.authInvalid);

  await new Promise((resolve) => setTimeout(resolve, 1_100));
  await adminAuth.revokeRefreshTokens(uid);
  const revokedRefresh = nextMessage(valid.socket);
  valid.socket.send(JSON.stringify({
    type: "auth.refresh",
    requestId: randomUUID(),
    token: account.idToken
  }));
  assert.equal((await revokedRefresh).code, "AUTH_INVALID");
  assert.equal((await valid.closed).code, CLOSE_CODES.authInvalid);

  const revoked = await authenticate(wsUrl, account.idToken);
  assert.equal(revoked.message.code, "AUTH_INVALID");
  assert.equal((await revoked.closed).code, CLOSE_CODES.authInvalid);

  const refreshedAccount = await signInAccount(account.email, account.password);
  const refreshSocket = await authenticate(wsUrl, refreshedAccount.idToken);
  assert.equal(refreshSocket.message.type, "auth.ok");
  assert.equal(refreshSocket.message.principal.uid, uid);

  await adminAuth.updateUser(uid, { disabled: true });
  const disabledRefresh = nextMessage(refreshSocket.socket);
  refreshSocket.socket.send(JSON.stringify({
    type: "auth.refresh",
    requestId: randomUUID(),
    token: refreshedAccount.idToken
  }));
  assert.equal((await disabledRefresh).code, "AUTH_INVALID");
  assert.equal((await refreshSocket.closed).code, CLOSE_CODES.authInvalid);

  const disabled = await authenticate(wsUrl, refreshedAccount.idToken);
  assert.equal(disabled.message.code, "AUTH_INVALID");
  assert.equal((await disabled.closed).code, CLOSE_CODES.authInvalid);

  process.stdout.write("WAN SSH Firebase Auth Emulator E2E passed: verified UID plus invalid, wrong-project, expired, revoked refresh/login, and disabled refresh/login rejection.\n");
} finally {
  const app = getApps().find((candidate) => candidate.name === "wan-ssh-gateway");
  if (app && uid) await getAuth(app).deleteUser(uid).catch(() => undefined);
  await runtime.shutdown("firebase-emulator-test");
}

async function createAccount() {
  const email = `wan-ssh-${randomUUID()}@example.test`;
  const password = "WanSshEmulator123!";
  const response = await fetch(`http://${emulatorHost}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password,
      returnSecureToken: true
    })
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Auth Emulator account creation failed: ${JSON.stringify(body)}`);
  assert.equal(typeof body.localId, "string");
  assert.equal(typeof body.idToken, "string");
  return { ...body, email, password };
}

async function signInAccount(email, password) {
  const response = await fetch(`http://${emulatorHost}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true })
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Auth Emulator sign-in failed: ${JSON.stringify(body)}`);
  assert.equal(typeof body.idToken, "string");
  return body;
}

async function authenticate(wsUrl, token) {
  const socket = new WebSocket(wsUrl, { origin: "http://127.0.0.1:5179" });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const closed = new Promise((resolve) => socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() })));
  const message = new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      try { resolve(JSON.parse(data.toString())); }
      catch (error) { reject(error); }
    });
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({
    type: "auth",
    requestId: randomUUID(),
    protocolVersion: 1,
    mode: "firebase",
    token
  }));
  return { socket, closed, message: await message };
}

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      try { resolve(JSON.parse(data.toString())); }
      catch (error) { reject(error); }
    });
    socket.once("error", reject);
  });
}

function mutateToken(token, transform) {
  const [header, payload, signature = ""] = token.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  const updated = Buffer.from(JSON.stringify(transform(claims))).toString("base64url");
  return `${header}.${updated}.${signature}`;
}