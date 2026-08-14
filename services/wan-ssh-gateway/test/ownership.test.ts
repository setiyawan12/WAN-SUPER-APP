import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/observability/logger.js";
import type { SessionOpenMessage } from "../src/protocol.js";
import { SessionManager } from "../src/sessions/manager.js";
import type { ManagedSession, SessionState } from "../src/sessions/ssh-session.js";

const input: SessionOpenMessage = {
  type: "session.open",
  requestId: "5e1bbfc4-63b0-42f1-8e14-d79d8fd97b95",
  target: { host: "ssh-target", port: 22, username: "wan" },
  terminal: { cols: 80, rows: 24, term: "xterm-256color" },
  authentication: { method: "privateKey", privateKey: "fixture" }
};

class FakeSession implements ManagedSession {
  state: SessionState = "created";
  constructor(
    readonly id: string,
    readonly connectionId: string,
    readonly principalId: string,
    private readonly onClose: (session: ManagedSession) => void
  ) {}
  start() { this.state = "connected"; }
  write() {}
  resize() {}
  answerHostKey() {}
  answerAuthPrompt() {}
  close() { this.state = "closed"; this.onClose(this); }
}

function context(connectionId: string, principalId: string) {
  return {
    id: connectionId,
    principal: { kind: "development" as const, id: principalId, uid: principalId },
    send: () => true,
    bufferedAmount: () => 0
  };
}

function manager(maxPerUser = 3) {
  let sequence = 0;
  return new SessionManager(
    loadConfig({ WAN_SSH_MAX_SESSIONS_PER_USER: String(maxPerUser), WAN_SSH_LOG_LEVEL: "error" }),
    createLogger("error"),
    ({ context: owner, onClose }) => new FakeSession(`session-${++sequence}`, owner.id, owner.principal.id, onClose)
  );
}

test("session ownership checks both connection and principal", async () => {
  const sessions = manager();
  const id = await sessions.open(context("connection-a", "principal-a"), structuredClone(input));
  assert.equal(sessions.owned(id, "connection-a", "principal-a").id, id);
  assert.throws(() => sessions.owned(id, "connection-b", "principal-a"), /not found/);
  assert.throws(() => sessions.owned(id, "connection-a", "principal-b"), /not found/);
  sessions.closeConnection("connection-a", "socket-closed");
  assert.equal(sessions.activeCount, 0);
});

test("synchronous allocation cannot exceed the principal limit", async () => {
  const sessions = manager(1);
  await sessions.open(context("connection-a", "principal-a"), structuredClone(input));
  await assert.rejects(sessions.open(context("connection-b", "principal-a"), structuredClone(input)), /limit/);
  assert.equal(sessions.activeCount, 1);
});