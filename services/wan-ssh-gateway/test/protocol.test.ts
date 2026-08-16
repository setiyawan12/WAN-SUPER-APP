import assert from "node:assert/strict";
import test from "node:test";
import {
  parseAuthMessage,
  parseClientMessage,
  sessionOpenMessageSchema,
  validatePrivateKeySize
} from "../src/protocol.js";

const requestId = "51bf5d23-0dbf-45b1-9cde-592c330469ae";
const sessionId = "4299a3a9-38bf-485b-9648-c343c861f9b6";

test("accepts development auth without a token", () => {
  const result = parseAuthMessage({ type: "auth", requestId, protocolVersion: 1, mode: "dev-anonymous" });
  assert.equal(result.mode, "dev-anonymous");
});

test("requires a Firebase token and rejects unknown auth properties", () => {
  assert.throws(() => parseAuthMessage({ type: "auth", requestId, protocolVersion: 1, mode: "firebase" }));
  assert.throws(() => parseAuthMessage({ type: "auth", requestId, protocolVersion: 1, mode: "dev-anonymous", uid: "client-owned" }));
});

test("accepts a bounded private-key session request", () => {
  const message = sessionOpenMessageSchema.parse({
    type: "session.open",
    requestId,
    target: { host: "ssh-target", port: 22, username: "wan" },
    terminal: { cols: 100, rows: 32, term: "xterm-256color" },
    authentication: { method: "privateKey", privateKey: "fixture-key" }
  });
  assert.doesNotThrow(() => validatePrivateKeySize(message, 256 * 1024));
});

test("accepts a bounded password session request without client ownership", () => {
  const message = sessionOpenMessageSchema.parse({
    type: "session.open",
    requestId,
    target: { host: "172.16.88.17", port: 2244, username: "wan" },
    terminal: { cols: 100, rows: 32, term: "xterm-256color" },
    authentication: { method: "password", password: "session-only-password" }
  });
  assert.equal(message.authentication.method, "password");
  assert.throws(() => sessionOpenMessageSchema.parse({
    ...message,
    principalId: "client-owned"
  }));
});

test("rejects client ownership, unknown messages, and invalid dimensions", () => {
  assert.throws(() => parseClientMessage({ type: "session.input", sessionId, data: "ls\r", principalId: "other" }));
  assert.throws(() => parseClientMessage({ type: "session.resize", sessionId, cols: 0, rows: 24 }));
  assert.throws(() => parseClientMessage({ type: "session.takeover", sessionId }));
});

test("rejects oversized private keys independently of total frame size", () => {
  const message = sessionOpenMessageSchema.parse({
    type: "session.open",
    requestId,
    target: { host: "ssh-target", port: 22, username: "wan" },
    terminal: { cols: 80, rows: 24, term: "xterm-256color" },
    authentication: { method: "privateKey", privateKey: "x".repeat(1025) }
  });
  assert.throws(() => validatePrivateKeySize(message, 1024));
});

test("accepts bounded cloud workspace operation messages", () => {
  const sessionId = "4299a3a9-38bf-485b-9648-c343c861f9b6";
  const requestId = "5e1bbfc4-63b0-42f1-8e14-d79d8fd97b95";
  assert.equal(parseClientMessage({ type: "sftp.list", requestId, sessionId, path: "/home/wan" }).type, "sftp.list");
  assert.equal(parseClientMessage({ type: "sftp.read", requestId, sessionId, path: "/home/wan/file", offset: 0, length: 131_072 }).type, "sftp.read");
  assert.equal(parseClientMessage({ type: "sftp.write", requestId, sessionId, path: "/home/wan/file", offset: 0, data: "d2Fu", truncate: true }).type, "sftp.write");
  assert.equal(parseClientMessage({ type: "tunnel.start", requestId, sessionId, kind: "remote", bindAddress: "127.0.0.1", bindPort: 0, targetHost: "10.20.0.8", targetPort: 8080 }).type, "tunnel.start");
  assert.equal(parseClientMessage({ type: "diagnostics.run", requestId, target: { host: "example.test", port: 22 } }).type, "diagnostics.run");
  assert.equal(parseClientMessage({ type: "knownhost.remove", requestId, host: "example.test", port: 22 }).type, "knownhost.remove");
  assert.equal(parseClientMessage({ type: "key.generate", requestId, algorithm: "ed25519" }).type, "key.generate");
});

test("rejects oversized cloud operation chunks and unsupported tunnel kinds", () => {
  const sessionId = "4299a3a9-38bf-485b-9648-c343c861f9b6";
  const requestId = "5e1bbfc4-63b0-42f1-8e14-d79d8fd97b95";
  assert.throws(() => parseClientMessage({ type: "sftp.read", requestId, sessionId, path: "/file", offset: 0, length: 196_609 }));
  assert.throws(() => parseClientMessage({ type: "tunnel.start", requestId, sessionId, kind: "local", bindAddress: "127.0.0.1", bindPort: 0, targetHost: "10.20.0.8", targetPort: 8080 }));
  assert.throws(() => parseClientMessage({ type: "key.install", requestId, sessionId, publicKey: "x".repeat(32_769) }));
});