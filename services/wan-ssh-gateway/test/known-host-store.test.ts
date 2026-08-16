import assert from "node:assert/strict";
import test from "node:test";
import {
  knownHostDocumentId,
  normalizeKnownHost,
  type KnownHostIdentity,
  type KnownHostRecord,
  type KnownHostStore
} from "../src/sessions/known-host-store.js";

class MemoryKnownHostStore implements KnownHostStore {
  private readonly records = new Map<string, KnownHostRecord>();

  async get(identity: KnownHostIdentity) {
    return this.records.get(knownHostDocumentId(identity));
  }

  async accept(identity: KnownHostIdentity, observed: { algorithm: string; fingerprint: string }, actorId: string, expectedVersion?: number) {
    const key = knownHostDocumentId(identity);
    const current = this.records.get(key);
    if (current?.version !== expectedVersion) return "conflict" as const;
    const now = new Date().toISOString();
    this.records.set(key, {
      ...identity,
      host: normalizeKnownHost(identity.host),
      ...observed,
      version: (current?.version ?? 0) + 1,
      createdAt: current?.createdAt ?? now,
      createdBy: current?.createdBy ?? actorId,
      updatedAt: now,
      updatedBy: actorId
    });
    return "accepted" as const;
  }
}

test("known-host identity normalizes DNS names and isolates tenants", () => {
  assert.equal(normalizeKnownHost("Server.Example.COM."), "server.example.com");
  const tenantA = knownHostDocumentId({ tenantId: "a", host: "server.example.com", port: 22 });
  const tenantB = knownHostDocumentId({ tenantId: "b", host: "server.example.com", port: 22 });
  assert.notEqual(tenantA, tenantB);
  assert.equal(tenantA, knownHostDocumentId({ tenantId: "a", host: "SERVER.EXAMPLE.COM.", port: 22 }));
});

test("known-host acceptance is compare-and-set and rejects stale writers", async () => {
  const store = new MemoryKnownHostStore();
  const identity = { tenantId: "tenant-a", host: "server.example.com", port: 22 };
  assert.equal(await store.accept(identity, { algorithm: "ssh-ed25519", fingerprint: "SHA256:first" }, "actor-a"), "accepted");
  const first = await store.get(identity);
  assert.equal(first?.version, 1);
  assert.equal(await store.accept(identity, { algorithm: "ssh-ed25519", fingerprint: "SHA256:stale" }, "actor-b"), "conflict");
  assert.equal(await store.accept(identity, { algorithm: "ssh-ed25519", fingerprint: "SHA256:second" }, "actor-b", 1), "accepted");
  assert.equal((await store.get(identity))?.fingerprint, "SHA256:second");
});