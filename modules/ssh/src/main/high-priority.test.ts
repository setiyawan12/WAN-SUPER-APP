import assert from "node:assert/strict";
import test from "node:test";
import { RealtimeDbTransport, vaultMetaPath } from "./firebase.js";
import { generateKey } from "./keys.js";
import { clearSyncedData, createRestoredPayload, createTombstonePayload, replaceSyncedOutbox } from "./store.js";
import { SyncEngine } from "./sync.js";
import { VaultCore } from "./vault.js";

class MemoryMetaStore {
  value: any = null;
  load() {
    return this.value;
  }
  save(meta: any) {
    this.value = structuredClone(meta);
  }
}

class MemorySyncStore {
  meta: MemoryMetaStore;
  constructor(meta: MemoryMetaStore) {
    this.meta = meta;
  }
  loadVaultMeta() { return this.meta.load(); }
  saveRemoteVaultMeta(meta: any) { this.meta.save(meta); }
  outboxPending() { return []; }
  markSynced() {}
  getRaw() { return null; }
  applyRemote() {}
  getCursor() { return 0; }
  setCursor() {}
}

class MemoryTransport {
  meta: any = null;
  isConfigured() { return true; }
  currentUser() { return "uid-1"; }
  async pushVaultMeta(_vaultId: string, meta: any) { this.meta = structuredClone(meta); }
  async pullVaultMeta() { return this.meta ? structuredClone(this.meta) : null; }
  async push(_vaultId: string, _entities: any[]) {}
  async pull() { return []; }
}

test("delete payload carries the current tombstone", () => {
  const tombstone = createTombstonePayload({ id: "host-1", version: 1, deletedAt: null }, 200, 2);
  assert.deepEqual(tombstone, { id: "host-1", version: 2, deletedAt: 200, updatedAt: 200 });
});

test("restored payload clears tombstone and advances version", () => {
  const restored = createRestoredPayload({ id: "host-1", version: 2, deletedAt: 200 }, 300, 3);
  assert.deepEqual(restored, { id: "host-1", version: 3, deletedAt: null, updatedAt: 300 });
});

test("force re-upload replaces existing cloud outbox instead of duplicating it", () => {
  const cloudPayload = { id: "host-1", vaultId: "personal", version: 2 };
  const localPayload = { id: "host-local", vaultId: "local", version: 1 };
  const data = {
    items: {
      "host-1": { id: "host-1", vaultId: "personal", deletedAt: null, payload: cloudPayload, syncState: "pending" },
      "host-local": { id: "host-local", vaultId: "local", deletedAt: null, payload: localPayload, syncState: "synced" }
    },
    outboxSeq: 5,
    outbox: [
      { seq: 4, itemId: "host-1", vaultId: "personal" },
      { seq: 5, itemId: "local-op", vaultId: "local" }
    ]
  };

  const requeued = replaceSyncedOutbox(data, 500);

  assert.equal(requeued, 1);
  assert.deepEqual(data.outbox, [
    { seq: 5, itemId: "local-op", vaultId: "local" },
    {
      seq: 6,
      itemId: "host-1",
      vaultId: "personal",
      op: "upsert",
      payload: cloudPayload,
      createdAt: 500,
      attempts: 0
    }
  ]);
  assert.equal(data.items["host-local"].syncState, "synced");
});

test("logout clears cloud cache but preserves wrapped vault metadata", () => {
  const metadata = { vaultId: "personal", wrappedVaultKey: { ciphertext: "wrapped" } };
  const data = {
    vaultMeta: { personal: metadata },
    items: {
      cloud: { id: "cloud", vaultId: "personal" },
      local: { id: "local", vaultId: "local" }
    },
    outbox: [
      { itemId: "cloud", vaultId: "personal" },
      { itemId: "local", vaultId: "local" }
    ],
    syncCursor: { personal: 123 }
  };

  const removed = clearSyncedData(data, true);

  assert.equal(removed, 1);
  assert.deepEqual(data.items, { local: { id: "local", vaultId: "local" } });
  assert.deepEqual(data.outbox, [{ itemId: "local", vaultId: "local" }]);
  assert.deepEqual(data.syncCursor, {});
  assert.deepEqual(data.vaultMeta.personal, metadata);
});

test("account switch clears the previous account vault metadata", () => {
  const data = {
    vaultMeta: { personal: { vaultId: "personal" } },
    items: {},
    outbox: [],
    syncCursor: {}
  };

  clearSyncedData(data);

  assert.deepEqual(data.vaultMeta, {});
});

test("vault metadata uses the RTDB path allowed by the deployed rules", () => {
  assert.equal(vaultMetaPath("uid-1", "personal"), "users/uid-1/vaultMeta/personal");
});

test("fresh login pulls the complete RTDB items node without an indexed query", async () => {
  const transport = new RealtimeDbTransport();
  let queried = false;
  const remoteItems = {
    "host-1": { id: "host-1", vaultId: "personal", updatedAt: 100 },
    "host-2": { id: "host-2", vaultId: "personal", updatedAt: 200 }
  };
  transport.uid = "uid-1";
  transport.db = {};
  transport.auth = {};
  transport.fb = {
    dbMod: {
      ref: (_db: any, path: string) => ({ path }),
      get: async (node: any) => ({
        exists: () => node.path === "users/uid-1/vaults/personal/items",
        val: () => remoteItems
      }),
      query: () => {
        queried = true;
        throw new Error("fresh pull must not use query");
      },
      orderByChild: () => ({}),
      startAt: () => ({})
    }
  };

  const pulled = await transport.pull("personal", 0);

  assert.deepEqual(pulled, Object.values(remoteItems));
  assert.equal(queried, false);
});

test("a new device can unlock ciphertext after vault metadata sync", async () => {
  const cloud = new MemoryTransport();
  const metaA = new MemoryMetaStore();
  const vaultA = new VaultCore(metaA);
  await vaultA.create("master-password");
  const encrypted = vaultA.encryptField("server-password", "host-1", "secret");

  const syncA = new SyncEngine(new MemorySyncStore(metaA), cloud, () => {}, ["personal"]);
  await syncA.syncVaultMeta();

  const metaB = new MemoryMetaStore();
  const syncB = new SyncEngine(new MemorySyncStore(metaB), cloud, () => {}, ["personal"]);
  await syncB.syncVaultMeta();

  const vaultB = new VaultCore(metaB);
  await vaultB.unlock("master-password");
  assert.equal(vaultB.decryptString(encrypted, "host-1"), "server-password");
  vaultA.lock();
  vaultB.lock();
});

test("explicit login restores remote metadata despite an equal-version local conflict", async () => {
  const localMeta = new MemoryMetaStore();
  localMeta.save({
    vaultId: "personal",
    wrappedVaultKey: { ciphertext: "stale-local" },
    version: 1,
    updatedAt: 200
  });
  const remoteMeta = {
    vaultId: "personal",
    wrappedVaultKey: { ciphertext: "account-remote" },
    version: 1,
    updatedAt: 100
  };
  const cloud = new MemoryTransport();
  cloud.meta = remoteMeta;
  let metadataChanges = 0;
  const sync = new SyncEngine(
    new MemorySyncStore(localMeta),
    cloud,
    () => {},
    ["personal"],
    undefined,
    () => { metadataChanges += 1; }
  );

  const outcome = await sync.syncNow({ preferRemoteMeta: true });

  assert.equal(outcome.ok, true);
  assert.deepEqual(localMeta.load(), remoteMeta);
  assert.deepEqual(cloud.meta, remoteMeta);
  assert.equal(metadataChanges, 1);
});

test("force re-upload preflight rejects credentials encrypted with another Vault Key", async () => {
  const metaA = new MemoryMetaStore();
  const vaultA = new VaultCore(metaA);
  await vaultA.create("same-password");
  const staleSecret = vaultA.encryptField("server-password", "identity-1", "secret");

  const metaB = new MemoryMetaStore();
  const vaultB = new VaultCore(metaB);
  await vaultB.create("same-password");

  assert.throws(
    () => vaultB.assertCanDecryptItems([{ id: "identity-1", type: "identity", secret: staleSecret }]),
    (error: any) => error?.code === "UNDECRYPTABLE"
  );
  vaultA.lock();
  vaultB.lock();
});

test("force re-upload preflight accepts credentials encrypted with the active Vault Key", async () => {
  const meta = new MemoryMetaStore();
  const vault = new VaultCore(meta);
  await vault.create("master-password");
  const secret = vault.encryptField("server-password", "identity-1", "secret");
  const privateKey = vault.encryptField("private-key", "key-1", "privateKey");

  assert.doesNotThrow(() => vault.assertCanDecryptItems([
    { id: "identity-1", type: "identity", secret },
    { id: "key-1", type: "sshkey", privateKey, passphrase: null }
  ]));
  vault.lock();
});

test("force re-upload overwrites remote vault metadata and drains local items", async () => {
  const localMeta = {
    vaultId: "personal",
    wrappedVaultKey: { ciphertext: "local" },
    version: 1,
    updatedAt: 100
  };
  const itemPayload = { id: "host-1", vaultId: "personal", version: 1, updatedAt: 100 };
  const pending = [{
    seq: 1,
    itemId: "host-1",
    vaultId: "personal",
    payload: itemPayload
  }];
  const store = {
    loadVaultMeta: () => localMeta,
    saveRemoteVaultMeta: () => {},
    outboxPending: () => [...pending],
    markSynced: (seqs: number[]) => {
      if (seqs.includes(1)) pending.length = 0;
    },
    getCursor: () => 0,
    setCursor: () => {},
    getRaw: () => null,
    applyRemote: () => {}
  };
  const transport = new MemoryTransport();
  transport.meta = {
    vaultId: "personal",
    wrappedVaultKey: { ciphertext: "remote-conflict" },
    version: 1,
    updatedAt: 200
  };
  const pushedItems: any[] = [];
  transport.push = async (_vaultId: string, entities: any[]) => {
    pushedItems.push(...structuredClone(entities));
  };

  const sync = new SyncEngine(store, transport, () => {}, ["personal"]);
  const outcome = await sync.syncNow({ forceLocal: true });

  assert.deepEqual(transport.meta, localMeta);
  assert.deepEqual(pushedItems, [itemPayload]);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.pushed, 1);
  assert.equal(pending.length, 0);
});

test("generated public keys use one-line OpenSSH format", () => {
  const generated = generateKey("ed25519");
  assert.match(generated.publicKey, /^ssh-ed25519 [A-Za-z0-9+/]+=*$/);
  assert.equal(generated.publicKey.includes("\n"), false);
  assert.match(generated.fingerprintSha256, /^SHA256:/);
});