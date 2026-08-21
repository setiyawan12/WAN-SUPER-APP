import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connect, createServer, type AddressInfo } from "node:net";
import test from "node:test";
import WebSocket from "ws";
import type { Authenticator } from "../src/auth/index.js";
import { loadConfig } from "../src/config.js";
import { CLOSE_CODES, GatewayError } from "../src/errors.js";
import type { ClientMessage, SessionOpenMessage } from "../src/protocol.js";
import { createGatewayRuntime } from "../src/server.js";
import type { ConnectionContext, SessionService } from "../src/sessions/types.js";

async function start(overrides: Record<string, string> = {}, authenticator?: Authenticator, sessions?: SessionService) {
  const runtime = createGatewayRuntime(loadConfig({
    WAN_SSH_BIND_HOST: "127.0.0.1",
    WAN_SSH_AUTH_TIMEOUT_MS: "250",
    WAN_SSH_HEARTBEAT_MS: "1000",
    WAN_SSH_LOG_LEVEL: "error",
    ...overrides
  }), { authenticator, sessions });
  const address = await runtime.listen(0, "127.0.0.1");
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  return { runtime, httpUrl: `http://127.0.0.1:${address.port}`, wsUrl: `ws://127.0.0.1:${address.port}/v1/ws` };
}

function openSocket(url: string, origin = "http://127.0.0.1:5179") {
  return new WebSocket(url, { origin });
}

function nextMessage(socket: WebSocket) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    socket.once("message", (data) => {
      try { resolve(JSON.parse(data.toString()) as Record<string, unknown>); }
      catch (error) { reject(error); }
    });
    socket.once("error", reject);
  });
}

function opened(socket: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function closed(socket: WebSocket) {
  return new Promise<number>((resolve) => socket.once("close", resolve));
}

function firebaseConfig() {
  return {
    WAN_SSH_ENV: "development",
    WAN_SSH_AUTH_MODE: "firebase",
    WAN_SSH_FIREBASE_PROJECT_ID: "demo-wan-super-app"
  };
}

function firebaseAuthenticator(expiresInMs: number): Authenticator {
  const principal = (uid: string) => ({
    kind: "firebase" as const,
    id: `firebase:${uid}`,
    uid,
    tenantId: uid,
    expiresAt: Date.now() + expiresInMs
  });
  return {
    async authenticate(message) {
      if (message.mode !== "firebase" || !message.token) {
        throw new GatewayError("AUTH_INVALID", "Authentication token was rejected", false, CLOSE_CODES.authInvalid);
      }
      return principal(message.token);
    },
    async refresh(_current, token) {
      return principal(token);
    }
  };
}

class TrackingSessions implements SessionService {
  private readonly byConnection = new Map<string, number>();
  activeCount = 0;

  async open(context: ConnectionContext, _message: SessionOpenMessage) {
    this.activeCount += 1;
    this.byConnection.set(context.id, (this.byConnection.get(context.id) ?? 0) + 1);
    return randomUUID();
  }

  start() {}
  handle(_context: ConnectionContext, _message: Exclude<ClientMessage, SessionOpenMessage>) {}

  closeConnection(connectionId: string) {
    const count = this.byConnection.get(connectionId) ?? 0;
    this.activeCount -= count;
    this.byConnection.delete(connectionId);
  }

  closeAll() {
    this.activeCount = 0;
    this.byConnection.clear();
  }
}

test("health, readiness, and runtime config expose only public metadata", async (context) => {
  const { runtime, httpUrl } = await start();
  context.after(() => runtime.shutdown("test-complete"));
  const health = await fetch(`${httpUrl}/healthz`).then((response) => response.json()) as Record<string, unknown>;
  const ready = await fetch(`${httpUrl}/readyz`).then((response) => response.json()) as Record<string, unknown>;
  const clientConfig = await fetch(`${httpUrl}/runtime-config.json`).then((response) => response.json()) as Record<string, unknown>;
  const metrics = await fetch(`${httpUrl}/metrics`).then((response) => response.text());
  assert.deepEqual(Object.keys(health).sort(), ["ok", "protocolVersion", "service", "version"]);
  assert.equal(ready.ok, true);
  assert.deepEqual(Object.keys(clientConfig).sort(), ["authMode", "protocolVersion", "service"]);
  assert.match(metrics, /wan_ssh_process_ready 1/);
  assert.match(metrics, /wan_ssh_ws_connections 0/);
  assert.doesNotMatch(metrics, /password|privateKey|token|uid=/i);
});

test("WebSocket upgrade requires the exact allowed origin", async (context) => {
  const { runtime, wsUrl } = await start();
  context.after(() => runtime.shutdown("test-complete"));
  const status = await new Promise<number>((resolve) => {
    const socket = openSocket(wsUrl, "http://localhost:5179");
    socket.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
  });
  assert.equal(status, 403);
});

test("authentication must be the first frame", async (context) => {
  const { runtime, wsUrl } = await start();
  context.after(() => runtime.shutdown("test-complete"));
  const socket = openSocket(wsUrl);
  context.after(() => socket.terminate());
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  socket.send(JSON.stringify({ type: "session.input", sessionId: "4299a3a9-38bf-485b-9648-c343c861f9b6", data: "x" }));
  const message = await nextMessage(socket);
  assert.equal(message.code, "AUTH_REQUIRED");
  const closeCode = await new Promise<number>((resolve) => socket.once("close", resolve));
  assert.equal(closeCode, 4401);
});

test("development auth succeeds and malformed JSON closes deterministically", async (context) => {
  const { runtime, wsUrl } = await start();
  context.after(() => runtime.shutdown("test-complete"));
  const socket = openSocket(wsUrl);
  context.after(() => socket.terminate());
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  socket.send(JSON.stringify({
    type: "auth",
    requestId: "5e1bbfc4-63b0-42f1-8e14-d79d8fd97b95",
    protocolVersion: 1,
    mode: "dev-anonymous"
  }));
  const authenticated = await nextMessage(socket);
  assert.equal(authenticated.type, "auth.ok");
  socket.send("not-json");
  const error = await nextMessage(socket);
  assert.equal(error.code, "MESSAGE_INVALID");
  const closeCode = await new Promise<number>((resolve) => socket.once("close", resolve));
  assert.equal(closeCode, 4400);
});

test("Firebase authentication closes at the verified expiry without refresh", async (context) => {
  const sessions = new TrackingSessions();
  const { runtime, wsUrl } = await start(firebaseConfig(), firebaseAuthenticator(120), sessions);
  context.after(() => runtime.shutdown("test-complete"));
  const socket = openSocket(wsUrl);
  context.after(() => socket.terminate());
  await opened(socket);
  socket.send(JSON.stringify({
    type: "auth",
    requestId: "96b1bea3-7a92-4a15-9d36-6e6ca4dc34c4",
    protocolVersion: 1,
    mode: "firebase",
    token: "user-a"
  }));
  const authenticated = await nextMessage(socket);
  assert.equal(authenticated.type, "auth.ok");
  assert.equal((authenticated.principal as { uid?: string }).uid, "user-a");
  socket.send(JSON.stringify({
    type: "session.open",
    requestId: "b7420cc8-40c4-4721-a172-b593f14d928c",
    target: { host: "example.test", port: 22, username: "wan" },
    terminal: { cols: 80, rows: 24, term: "xterm-256color" },
    authentication: { method: "privateKey", privateKey: "ephemeral-test-key" }
  }));
  assert.equal((await nextMessage(socket)).type, "session.opened");
  assert.equal(sessions.activeCount, 1);
  assert.equal(await closed(socket), CLOSE_CODES.authInvalid);
  assert.equal(sessions.activeCount, 0);
});

test("Firebase refresh with the same UID replaces the verified expiry", async (context) => {
  const authenticator = firebaseAuthenticator(180);
  const { runtime, wsUrl } = await start(firebaseConfig(), authenticator);
  context.after(() => runtime.shutdown("test-complete"));
  const socket = openSocket(wsUrl);
  context.after(() => socket.terminate());
  await opened(socket);
  socket.send(JSON.stringify({
    type: "auth",
    requestId: "ae6736e9-ac94-40c5-b45e-e592f85fb7db",
    protocolVersion: 1,
    mode: "firebase",
    token: "user-a"
  }));
  assert.equal((await nextMessage(socket)).type, "auth.ok");
  await new Promise((resolve) => setTimeout(resolve, 80));
  socket.send(JSON.stringify({
    type: "auth.refresh",
    requestId: "7812a256-76e0-4448-9b7c-a6cfb79dc63e",
    token: "user-a"
  }));
  assert.equal((await nextMessage(socket)).type, "auth.refreshed");
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(socket.readyState, WebSocket.OPEN);
  assert.equal(await closed(socket), CLOSE_CODES.authInvalid);
});

test("gateway shutdown closes sockets with 1012 and does not resume sessions", async (context) => {
  const sessions = new TrackingSessions();
  const { runtime, wsUrl } = await start({}, undefined, sessions);
  const socket = openSocket(wsUrl);
  context.after(() => socket.terminate());
  await opened(socket);
  socket.send(JSON.stringify({
    type: "auth",
    requestId: "5e1bbfc4-63b0-42f1-8e14-d79d8fd97b95",
    protocolVersion: 1,
    mode: "dev-anonymous"
  }));
  assert.equal((await nextMessage(socket)).type, "auth.ok");
  socket.send(JSON.stringify({
    type: "session.open",
    requestId: "b7420cc8-40c4-4721-a172-b593f14d928c",
    target: { host: "example.test", port: 22, username: "wan" },
    terminal: { cols: 80, rows: 24, term: "xterm-256color" },
    authentication: { method: "privateKey", privateKey: "ephemeral-test-key" }
  }));
  assert.equal((await nextMessage(socket)).type, "session.opened");
  assert.equal(sessions.activeCount, 1);
  const closing = closed(socket);
  await runtime.shutdown("service-restart");
  assert.equal(await closing, CLOSE_CODES.serviceRestart);
  assert.equal(sessions.activeCount, 0);
});

test("Firebase refresh cannot change the verified UID", async (context) => {
  const sessions = new TrackingSessions();
  const { runtime, wsUrl } = await start(firebaseConfig(), firebaseAuthenticator(1_000), sessions);
  context.after(() => runtime.shutdown("test-complete"));
  const socket = openSocket(wsUrl);
  context.after(() => socket.terminate());
  await opened(socket);
  socket.send(JSON.stringify({
    type: "auth",
    requestId: "d77f7024-d183-414a-9680-c6c355f66b3c",
    protocolVersion: 1,
    mode: "firebase",
    token: "user-a"
  }));
  assert.equal((await nextMessage(socket)).type, "auth.ok");
  socket.send(JSON.stringify({
    type: "session.open",
    requestId: "7f37b2f7-c496-4c64-a89c-f5ae4863a1bb",
    target: { host: "example.test", port: 22, username: "wan" },
    terminal: { cols: 80, rows: 24, term: "xterm-256color" },
    authentication: { method: "privateKey", privateKey: "ephemeral-test-key" }
  }));
  assert.equal((await nextMessage(socket)).type, "session.opened");
  assert.equal(sessions.activeCount, 1);
  socket.send(JSON.stringify({
    type: "auth.refresh",
    requestId: "0cffcb1c-f5ac-409f-b4e7-f7a89850fe78",
    token: "user-b"
  }));
  const error = await nextMessage(socket);
  assert.equal(error.code, "AUTH_INVALID");
  assert.equal(await closed(socket), CLOSE_CODES.authInvalid);
  assert.equal(sessions.activeCount, 0);
});
// Regresi yang dijaga: handler upgrade klien pernah menulis 503 ke socket
// `/v1/agent` yang sudah di-upgrade hub, sehingga agent tidak pernah register.
test("the local-agent upgrade survives alongside the client WebSocket handler", { timeout: 20_000 }, async () => {
  const { runtime, httpUrl } = await start();
  const echo = createServer((socket) => socket.pipe(socket));
  await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
  const echoPort = (echo.address() as AddressInfo).port;
  const agent = new WebSocket(`${httpUrl.replace("http", "ws")}/v1/agent`);
  try {
    await opened(agent);
    agent.send(JSON.stringify({
      type: "agent.register",
      requestId: randomUUID(),
      protocolVersion: 1,
      mode: "dev-anonymous"
    }));
    const registered = await nextMessage(agent);
    assert.equal(registered.type, "agent.registered");

    const channels = new Map<string, ReturnType<typeof connect>>();
    agent.on("message", (raw, isBinary) => {
      if (isBinary) return;
      const message = JSON.parse(raw.toString()) as Record<string, any>;
      if (message.type !== "bridge.open") return;
      const target = connect({ host: message.host, port: message.port });
      target.once("connect", () => {
        channels.set(message.channelId, target);
        agent.send(JSON.stringify({ type: "bridge.opened", requestId: message.requestId, channelId: message.channelId }));
      });
      target.once("error", () => agent.send(JSON.stringify({ type: "bridge.failed", requestId: message.requestId, channelId: message.channelId, message: "unreachable" })));
    });

    const client = openSocket(`${httpUrl.replace("http", "ws")}/v1/ws`);
    await opened(client);
    client.send(JSON.stringify({ type: "auth", requestId: randomUUID(), protocolVersion: 1, mode: "dev-anonymous" }));
    assert.equal((await nextMessage(client)).type, "auth.ok");
    client.send(JSON.stringify({
      type: "diagnostics.run",
      requestId: randomUUID(),
      target: { host: "127.0.0.1", port: echoPort },
      egress: { mode: "client-agent" }
    }));
    const diagnostics = await nextMessage(client) as { type: string; phases: Array<{ name: string; ok: boolean }> };
    assert.equal(diagnostics.type, "diagnostics.result");
    assert.deepEqual(diagnostics.phases.map((phase) => [phase.name, phase.ok]), [["resolve", true], ["tcp", true]]);
    for (const channel of channels.values()) channel.destroy();
    client.close();
  } finally {
    agent.close();
    echo.close();
    await runtime.shutdown("test");
  }
});
