import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decodeBridgeFrame, encodeBridgeFrame, FRAME_CLOSE, FRAME_DATA } from "../src/agent/frames.js";
import { clearStore, decodePairing, encodePairing, readStore, writeStore, type AgentPairing } from "../src/agent-client/pairing.js";
import { createEgressPolicy } from "../src/agent-client/policy.js";

const pairing: AgentPairing = {
  v: 1,
  url: "https://ssh.example.com",
  mode: "firebase",
  apiKey: "test-api-key",
  refreshToken: "test-refresh-token",
  account: "operator@example.com"
};

function storeFile() {
  return join(mkdtempSync(join(tmpdir(), "wan-ssh-agent-")), "agent.json");
}

test("pairing codes round-trip and reject foreign payloads", () => {
  const code = encodePairing(pairing);
  assert.ok(code.startsWith("WANSSH1."));
  assert.deepEqual(decodePairing(` ${code} \n`), pairing);
  assert.throws(() => decodePairing("not-a-wan-code"), /not a WAN SSH agent code/);
  assert.throws(() => encodePairing({ ...pairing, refreshToken: undefined }), /no Firebase refresh token/);
  assert.throws(() => encodePairing({ ...pairing, url: "ftp://ssh.example.com" }), /http or https/);
});

test("dev-anonymous pairing needs no Firebase credential", () => {
  const local: AgentPairing = { v: 1, url: "http://localhost:5179/", mode: "dev-anonymous" };
  const decoded = decodePairing(encodePairing(local));
  assert.equal(decoded.url, "http://localhost:5179");
  assert.equal(decoded.apiKey, undefined);
});

test("the pairing store keeps the refresh token in a 0600 file", () => {
  const path = storeFile();
  writeStore({ ...pairing, allowCidrs: ["10.8.0.0/24"], pairedAt: 1_755_302_400_000 }, path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const store = readStore(path);
  assert.equal(store?.refreshToken, "test-refresh-token");
  assert.deepEqual(store?.allowCidrs, ["10.8.0.0/24"]);
  assert.equal(store?.pairedAt, 1_755_302_400_000);
  assert.ok(!readFileSync(path, "utf8").includes("undefined"));
  clearStore(path);
  assert.equal(readStore(path), undefined);
});

test("the agent policy blocks loopback and metadata targets the gateway no longer screens", async () => {
  const policy = createEgressPolicy();
  await assert.rejects(policy.resolve("127.0.0.1", 22), /forbidden network range/);
  await assert.rejects(policy.resolve("169.254.169.254", 80), /forbidden network range/);
  await assert.rejects(policy.resolve("::1", 22), /forbidden network range/);
  await assert.rejects(policy.resolve("10.8.0.5", 0), /port is invalid/);
  assert.deepEqual(await policy.resolve("10.8.0.5", 22), { address: "10.8.0.5", family: 4, port: 22 });
});

test("the agent allowlist keeps sessions inside the VPN range", async () => {
  const policy = createEgressPolicy({ allowCidrs: ["10.8.0.0/24"] });
  assert.equal((await policy.resolve("10.8.0.9", 22)).address, "10.8.0.9");
  await assert.rejects(policy.resolve("192.168.1.9", 22), /outside the agent allowlist/);
  assert.throws(() => createEgressPolicy({ allowCidrs: ["10.8.0.0"] }), /Allowed CIDR is invalid/);
  const loopback = createEgressPolicy({ allowLoopback: true });
  assert.equal((await loopback.resolve("127.0.0.1", 2222)).address, "127.0.0.1");
});

test("bridge frames stay byte-compatible with the gateway hub", () => {
  const channelId = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
  const encoded = encodeBridgeFrame(FRAME_DATA, channelId, Buffer.from("ssh"));
  assert.equal(encoded.length, 1 + 16 + 3);
  assert.equal(encoded[0], FRAME_DATA);
  assert.equal(encoded.subarray(1, 17).toString("hex"), "3f2504e04f8911d39a0c0305e82c3301");
  const decoded = decodeBridgeFrame(encoded);
  assert.equal(decoded.channelId, channelId);
  assert.equal(decoded.payload.toString(), "ssh");
  assert.equal(decodeBridgeFrame(encodeBridgeFrame(FRAME_CLOSE, channelId)).kind, FRAME_CLOSE);
  assert.throws(() => decodeBridgeFrame(Buffer.alloc(4)), /truncated/);
});
