import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import WebSocket from "ws";
import { loadConfig } from "../src/config.js";
import { resolveClientAddress } from "../src/security/net.js";
import { assertAllowedOrigin } from "../src/security/origin.js";
import { SlidingWindowRateLimiter } from "../src/security/rate-limit.js";
import { createGatewayRuntime } from "../src/server.js";
import { fingerprintHostKey, hostKeyAlgorithm } from "../src/sessions/host-key.js";
import { sshReadyTimeoutMs } from "../src/sessions/ssh-session.js";
import { connectResolvedTarget, resolveTarget, sshConnectEndpoint } from "../src/sessions/target-policy.js";

test("origin matching is exact", () => {
  const config = loadConfig({ WAN_SSH_LOG_LEVEL: "error" });
  assert.doesNotThrow(() => assertAllowedOrigin(config, "http://127.0.0.1:5179"));
  assert.throws(() => assertAllowedOrigin(config, "http://localhost:5179"));
});

test("target policy blocks metadata and enforces production allowlist", async () => {
  const local = loadConfig({ WAN_SSH_LOG_LEVEL: "error" });
  await assert.rejects(resolveTarget(local, "metadata", 22, async () => [{ address: "169.254.169.254", family: 4 }]), /forbidden/);
  const production = loadConfig({
    WAN_SSH_ENV: "production",
    WAN_SSH_AUTH_MODE: "firebase",
    WAN_SSH_FIREBASE_PROJECT_ID: "test",
    WAN_SSH_ALLOWED_ORIGINS: "https://ssh.example.com",
    WAN_SSH_EGRESS_MODE: "allowlist",
    WAN_SSH_EGRESS_ALLOW_CIDRS: "10.20.0.0/16",
    WAN_SSH_KNOWN_HOST_MODE: "firestore",
    WAN_SSH_TRUSTED_PROXY_CIDRS: "172.31.0.0/24",
    WAN_SSH_LOG_LEVEL: "error"
  });
  const target = await resolveTarget(production, "server.internal", 22, async () => [{ address: "10.20.1.10", family: 4 }]);
  assert.equal(target.address, "10.20.1.10");
  await assert.rejects(resolveTarget(production, "server.internal", 2222, async () => [{ address: "10.20.1.10", family: 4 }]), /port/);
});

test("derives SSH host key algorithm and SHA256 fingerprint", () => {
  const algorithm = Buffer.from("ssh-ed25519");
  const key = Buffer.alloc(4 + algorithm.length + 8);
  key.writeUInt32BE(algorithm.length, 0);
  algorithm.copy(key, 4);
  assert.equal(hostKeyAlgorithm(key), "ssh-ed25519");
  assert.match(fingerprintHostKey(key), /^SHA256:[A-Za-z0-9+/]+$/);
});

test("SSH ready timeout includes the interactive host-key decision window", () => {
  const config = loadConfig({
    WAN_SSH_CONNECT_TIMEOUT_MS: "15000",
    WAN_SSH_HOST_KEY_TIMEOUT_MS: "60000",
    WAN_SSH_LOG_LEVEL: "error"
  });
  assert.equal(sshReadyTimeoutMs(config), 75_000);
});

test("forwarded client headers are ignored unless the peer is a trusted proxy", () => {
  const config = loadConfig({
    WAN_SSH_TRUSTED_PROXY_CIDRS: "172.30.0.0/24",
    WAN_SSH_LOG_LEVEL: "error"
  });
  assert.equal(resolveClientAddress(config, {
    socket: { remoteAddress: "203.0.113.10" },
    headers: { "x-forwarded-for": "198.51.100.20", "x-real-ip": "198.51.100.21" }
  }), "203.0.113.10");
  assert.equal(resolveClientAddress(config, {
    socket: { remoteAddress: "172.30.0.8" },
    headers: { "x-forwarded-for": "198.51.100.20" }
  }), "198.51.100.20");
  assert.equal(resolveClientAddress(config, {
    socket: { remoteAddress: "172.30.0.8" },
    headers: { "x-forwarded-for": "198.51.100.20, 203.0.113.9", "x-real-ip": "198.51.100.21" }
  }), "198.51.100.21");
  assert.equal(resolveClientAddress(config, {
    socket: { remoteAddress: "172.30.0.8" },
    headers: { "x-forwarded-for": "not-an-ip" }
  }), "172.30.0.8");
});

test("connect rate limiter is keyed by identity", () => {
  const limiter = new SlidingWindowRateLimiter(2, 1_000);
  assert.equal(limiter.allow("a", 1), true);
  assert.equal(limiter.allow("a", 2), true);
  assert.equal(limiter.allow("a", 3), false);
  assert.equal(limiter.allow("b", 3), true);
});

test("spoofed X-Forwarded-For cannot bypass the WebSocket connect rate limit", async (context) => {
  const runtime = createGatewayRuntime(loadConfig({
    WAN_SSH_BIND_HOST: "127.0.0.1",
    WAN_SSH_CONNECT_RATE_LIMIT: "1",
    WAN_SSH_CONNECT_RATE_WINDOW_MS: "60000",
    WAN_SSH_LOG_LEVEL: "error"
  }));
  context.after(() => runtime.shutdown("test-complete"));
  const address = await runtime.listen(0, "127.0.0.1");
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  const url = `ws://127.0.0.1:${address.port}/v1/ws`;
  const first = new WebSocket(url, { origin: "http://127.0.0.1:5179", headers: { "X-Forwarded-For": "198.51.100.1" } });
  context.after(() => first.terminate());
  await new Promise<void>((resolve, reject) => { first.once("open", resolve); first.once("error", reject); });
  const status = await new Promise<number>((resolve) => {
    const second = new WebSocket(url, { origin: "http://127.0.0.1:5179", headers: { "X-Forwarded-For": "198.51.100.2" } });
    second.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
    second.once("open", () => resolve(200));
  });
  assert.equal(status, 429);
});

test("SSH uses a preconnected socket to the inspected address, not a second hostname lookup", async () => {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as { port: number }).port;
  let lookups = 0;
  try {
    const inspected = await resolveTarget(
      loadConfig({ WAN_SSH_LOG_LEVEL: "error" }),
      "rebinding.example",
      port,
      async () => {
        lookups += 1;
        return [{ address: "10.20.1.10", family: 4 }];
      }
    );
    assert.equal(lookups, 1);
    assert.deepEqual(sshConnectEndpoint(inspected), { host: "10.20.1.10", port, family: 4 });
    const socket = await connectResolvedTarget({
      originalHost: "rebinding.example",
      address: "127.0.0.1",
      family: 4,
      port
    }, 1_000);
    assert.equal(lookups, 1);
    assert.equal(socket.remoteAddress, "127.0.0.1");
    assert.equal(socket.remotePort, port);
    socket.destroy();
  } finally {
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  }
});