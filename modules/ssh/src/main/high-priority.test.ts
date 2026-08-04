import assert from "node:assert/strict";
import * as node_crypto from "node:crypto";
import fs from "node:fs";
import * as node_path from "node:path";
import test from "node:test";
import * as ssh2 from "ssh2";
import { RealtimeDbTransport, vaultMetaPath } from "./firebase.js";
import { generateKey } from "./keys.js";
import { knownHostPattern } from "./knownhosts.js";
import { RecordingManager, redactTerminalText } from "./recording.js";
import { resolveEffective } from "./repo.js";
import { SshManager, SshSession } from "./ssh.js";
import { clearSyncedData, createRestoredPayload, createTombstonePayload, normalizeStoreData, replaceSyncedOutbox } from "./store.js";
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

test("ECDSA key generation produces a usable OpenSSH public key", () => {
  const generated = generateKey("ecdsa");
  assert.match(generated.publicKey, /^ecdsa-sha2-nistp256 [A-Za-z0-9+/]+=*$/);
  assert.match(generated.fingerprintSha256, /^SHA256:/);
});

test("effective host settings inherit group port and environment variables", () => {
  const entities: Record<string, any> = {
    group: {
      id: "group",
      type: "group",
      parentId: null,
      name: "Production",
      defaults: {
        username: "deploy",
        port: 2202,
        envVars: { REGION: "ap-southeast-3", ROLE: "api" }
      }
    }
  };
  const effective = resolveEffective(
    { id: "host", type: "host", groupId: "group", port: null, identityId: null, keyId: null },
    (id) => entities[id]
  );

  assert.equal(effective.username, "deploy");
  assert.equal(effective.port, 2202);
  assert.deepEqual(effective.envVars, { REGION: "ap-southeast-3", ROLE: "api" });
});

test("SSH config honors disabled keepalive, effective port, environment, and target verifier port", () => {
  const session = new SshSession(
    { id: "target", address: "target.test", port: 2202, vaultId: "local", keepAliveInterval: 0 },
    { username: "deploy", port: 2202, envVars: { REGION: "test" } },
    "uid-test",
    () => undefined,
    () => undefined
  );
  const cfg = session.connectionConfig(session.host, session.creds);
  assert.equal(cfg.port, 2202);
  assert.equal(cfg.keepaliveInterval, 0);

  assert.deepEqual(session.creds.envVars, { REGION: "test" });
  assert.equal(knownHostPattern(session.host.address, cfg.port), "target.test:2202");
});

test("store migration drops malformed rows and handles a large outbox without stack spreading", () => {
  const outbox = Array.from({ length: 50_000 }, (_value, index) => ({
    seq: index + 1,
    itemId: `host-${index}`
  }));
  const normalized = normalizeStoreData({
    schemaVersion: 1,
    items: {
      valid: {
        id: "valid",
        payload: { id: "valid", deletedAt: undefined },
        deletedAt: undefined,
        syncState: "unexpected"
      },
      malformed: { id: "different" }
    },
    outbox,
    outboxSeq: 2
  });

  assert.equal(normalized.schemaVersion, 2);
  assert.equal(normalized.items.malformed, undefined);
  assert.equal(normalized.items.valid.deletedAt, null);
  assert.equal(normalized.items.valid.payload.deletedAt, null);
  assert.equal(normalized.items.valid.syncState, "synced");
  assert.equal(normalized.outboxSeq, 50_000);
  assert.deepEqual(normalized.settings, {});
});

test("recording redacts common secrets and excludes input unless explicitly enabled", () => {
  assert.equal(
    redactTerminalText("password=secret token:abcd API_KEY=xyz"),
    "password=[REDACTED] token:[REDACTED] API_KEY=[REDACTED]"
  );

  const manager = new RecordingManager();
  manager.start("session-output-only", 80, 24, false);
  manager.captureInput("session-output-only", "typed-secret");
  manager.captureOutput("session-output-only", "token=visible-in-output");
  const outputOnly: any = manager.stop("session-output-only");
  assert.equal(outputOnly.lines.some((line: string) => line.includes("typed-secret")), false);
  assert.equal(outputOnly.lines.some((line: string) => line.includes("token=[REDACTED]")), true);

  manager.start("session-with-input", 80, 24, true);
  manager.captureInput("session-with-input", "echo hello");
  const withInput: any = manager.stop("session-with-input");
  assert.equal(withInput.lines.some((line: string) => line.includes("echo hello")), true);
});

test("SSH session finish is idempotent, flushes output, wipes credentials, and closes transports", () => {
  const events: Array<{ channel: string; payload: any }> = [];
  let endCount = 0;
  let endedSession = "";
  const privateKey = Buffer.from("private-key");
  const credentials = { privateKey, password: "password", passphrase: "passphrase" };
  const session = new SshSession(
    { id: "host-1" },
    credentials,
    "uid-1",
    (channel, payload) => events.push({ channel, payload }),
    (sessionId) => { endedSession = sessionId; }
  );
  session.stream = { end: () => { endCount += 1; }, setWindow: () => undefined };
  session.client = { end: () => { endCount += 1; } } as any;
  session.auxiliaryClients = [{ end: () => { endCount += 1; } } as any];
  session.push("hello");
  session.resize(132, 41);

  session.finish(1, "network-error", "lost connection");
  session.finish(1, "second-finish");

  assert.equal(endedSession, session.id);
  assert.equal(endCount, 3);
  assert.equal(session.cols, 132);
  assert.equal(session.rows, 41);
  assert.equal(privateKey.every((byte) => byte === 0), true);
  assert.equal(credentials.password, undefined);
  assert.equal(credentials.passphrase, undefined);
  assert.deepEqual(events.map((event) => event.channel), ["term:output", "session:state", "term:exit"]);
  assert.equal(events[0].payload.data, "hello");
});

test("connection diagnostics skip host startup snippets", async () => {
  const manager = new SshManager({} as any, () => "uid-1", () => undefined);
  const sessionId = "00000000-0000-4000-8000-000000000001";
  let openArgs: any[] = [];
  let closedSession = "";
  manager.open = async (...args: any[]) => {
    openArgs = args;
    return { sessionId };
  };
  manager.close = (sessionId: string) => { closedSession = sessionId; };

  const result = await manager.testConnection("host-1");

  assert.equal(result.ok, true);
  assert.deepEqual(openArgs, ["host-1", 80, 24, false]);
  assert.equal(closedSession, sessionId);
});

test("in-process SSH shell opens with a PTY, resizes, emits output, and cleans up on remote close", async (t) => {
  const { privateKey } = node_crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" }
  });
  let serverStream: any;
  let initialPty: any;
  let resizeInfo: any;
  let resolveServerStream!: (stream: any) => void;
  let resolveResize!: () => void;
  const serverStreamReady = new Promise<any>((resolve) => { resolveServerStream = resolve; });
  const resized = new Promise<void>((resolve) => { resolveResize = resolve; });
  const server = new (ssh2 as any).Server({ hostKeys: [privateKey] }, (client: any) => {
    client.on("authentication", (context: any) => {
      if (context.method === "password" && context.username === "tester" && context.password === "secret") context.accept();
      else context.reject(["password"]);
    });
    client.on("ready", () => {
      client.once("session", (accept: () => any) => {
        const session = accept();
        session.once("pty", (acceptPty: () => void, _reject: () => void, info: any) => {
          initialPty = info;
          acceptPty();
        });
        session.on("window-change", (acceptResize: (() => void) | undefined, _reject: () => void, info: any) => {
          resizeInfo = info;
          acceptResize?.();
          resolveResize();
        });
        session.once("shell", (acceptShell: () => any) => {
          serverStream = acceptShell();
          resolveServerStream(serverStream);
        });
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.equal(typeof address, "object");
  if (!address || typeof address === "string") throw new Error("SSH test server has no TCP address");

  const events: Array<{ channel: string; payload: any }> = [];
  let resolveEnded!: () => void;
  const ended = new Promise<void>((resolve) => { resolveEnded = resolve; });
  const credentials = { username: "tester", password: "secret" };
  const session = new SshSession(
    { id: "host-test", address: "127.0.0.1", port: address.port, vaultId: "local", keepAliveInterval: 0 },
    credentials,
    "uid-test",
    (channel, payload) => events.push({ channel, payload }),
    () => resolveEnded()
  );
  session.verifyHostKeyFor = async () => true;

  await session.connect(80, 24);
  const stream = await serverStreamReady;
  assert.equal(session.status, "connected");
  assert.equal(initialPty.cols, 80);
  assert.equal(initialPty.rows, 24);

  session.resize(120, 40);
  await resized;
  assert.equal(resizeInfo.cols, 120);
  assert.equal(resizeInfo.rows, 40);

  stream.write("server-ready\n");
  stream.end();
  await ended;

  assert.equal(session.status, "disconnected");
  assert.equal(credentials.password, undefined);
  assert.equal(events.some((event) => event.channel === "term:output" && event.payload.data.includes("server-ready")), true);
  assert.equal(events.some((event) => event.channel === "term:exit" && event.payload.reason === "remote-closed"), true);
});

test("local PTY session reports output, resizes, and cleans up", { skip: process.platform === "win32" }, async () => {
  const { LocalSessionManager } = await import("./local.js");
  const listeners = new Set<(channel: string, payload: any) => void>();
  const manager = new LocalSessionManager((channel, payload) => {
    for (const listener of listeners) listener(channel, payload);
  });
  const { sessionId, pty } = manager.open({ cols: 91, rows: 27, shell: "/bin/sh" });
  assert.equal(pty, true);
  assert.equal(manager.has(sessionId), true);

  const sawSize = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("PTY output timeout")), 8000);
    let buffer = "";
    listeners.add((channel, payload) => {
      if (channel !== "term:output" || payload.sessionId !== sessionId) return;
      buffer += payload.data;
      if (/45\s+123/.test(buffer)) { clearTimeout(timer); resolve(); }
    });
  });

  manager.write(sessionId, "stty size\r");
  await new Promise((resolve) => setTimeout(resolve, 250));
  manager.resize(sessionId, 123, 45);
  manager.write(sessionId, "stty size\r");
  await sawSize;

  const ended = new Promise<void>((resolve) => {
    listeners.add((channel, payload) => {
      if (channel === "term:exit" && payload.sessionId === sessionId) resolve();
    });
  });
  manager.close(sessionId);
  await ended;
  assert.equal(manager.has(sessionId), false);
});

test("saveGroup rejects a parent that would create a cycle", async () => {
  const { initDbForTest } = await import("./store.js");
  initDbForTest();
  const { HostService } = await import("./hosts.js");
  const vault = { encryptField: () => null, decryptString: () => "" } as any;
  const hosts = new HostService(vault, () => "uid-test");
  const parentId = hosts.saveGroup({ name: "Parent", parentId: null, defaults: {} });
  const childId = hosts.saveGroup({ name: "Child", parentId, defaults: {} });
  assert.throws(() => hosts.saveGroup({ id: parentId, name: "Parent", parentId: childId, defaults: {} }), /siklus/);
});

test("preload bridge and channel map stay in sync", async () => {
  const { CH } = await import("./channels.js");
  const bridgeSource = fs.readFileSync(node_path.join(__dirname, "../preload/index.js"), "utf8");
  const flatten = (node: any, prefix = ""): string[] => Object.entries(node).flatMap(([key, value]) =>
    typeof value === "string" ? [value] : flatten(value, `${prefix}${key}.`)
  );
  for (const channel of flatten(CH)) {
    assert.equal(bridgeSource.includes(`"${channel}"`), true, `preload bridge is missing channel ${channel}`);
  }
});