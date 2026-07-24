"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const electron = require("electron");
const node_fs = require("node:fs");
const path = require("node:path");
const node_crypto = require("node:crypto");
const argon2 = require("argon2");
const ssh2 = require("ssh2");
const zod = require("zod");
const APP = {
  name: "WANN-SSH",
  scheme: "wannssh",
  version: "0.1.0",
  /** SSH ident: muncul sebagai SSH-2.0-WANN-SSH_0.1.0 di auth.log server. */
  sshIdent: "WANN-SSH_0.1.0",
  term: "xterm-256color"
};
const VAULT = {
  /** Auto-lock idle default (Bab 7 & checklist Bab 18). */
  autoLockMs: 15 * 6e4,
  /** ID vault personal (= workspace Cloud, tersinkron). */
  personalVaultId: "personal",
  /** Vault default untuk item baru: Lokal (privasi-dulu). */
  defaultVaultId: "local",
  /** Hanya vault ini yang boleh di-push/pull ke remote (masuk outbox). */
  syncedVaultIds: ["personal"]
};
const SSH = {
  defaultPort: 22,
  readyTimeoutMs: 2e4,
  keepAliveIntervalSec: 30,
  keepAliveCountMax: 3,
  /** Batching output terminal (Bab 3 & 10): flush tiap frame / saat buffer besar. */
  flushIntervalMs: 16,
  flushChunkThreshold: 200
};
function isSynced(vaultId) {
  return VAULT.syncedVaultIds.includes(vaultId);
}
let dbPath;
let data;
function empty() {
  return { schemaVersion: 1, vaultMeta: {}, items: {}, outbox: [], outboxSeq: 0, syncCursor: {} };
}
function initDb() {
  dbPath = path.join(electron.app.getPath("userData"), "wann-ssh.json");
  if (node_fs.existsSync(dbPath)) {
    try {
      data = JSON.parse(node_fs.readFileSync(dbPath, "utf8"));
    } catch {
      data = empty();
    }
  } else {
    data = empty();
  }
}
function persist() {
  const tmp = `${dbPath}.tmp`;
  node_fs.writeFileSync(tmp, JSON.stringify(data), "utf8");
  node_fs.renameSync(tmp, dbPath);
}
function ensure() {
  if (!data) throw new Error("DB not initialized");
  return data;
}
const jsonStore = {
  listByType(vaultId, type) {
    return Object.values(ensure().items).filter((r) => r.vaultId === vaultId && r.type === type && r.deletedAt === null).sort((a, b) => b.updatedAt - a.updatedAt);
  },
  /** Semua vault (Lokal + Cloud) untuk satu tipe — dipakai UI lintas-workspace. */
  listByTypeAll(type) {
    return Object.values(ensure().items).filter((r) => r.type === type && r.deletedAt === null).sort((a, b) => b.updatedAt - a.updatedAt);
  },
  get(id) {
    const r = ensure().items[id];
    return r && r.deletedAt === null ? r : null;
  },
  getRaw(id) {
    return ensure().items[id] ?? null;
  },
  upsert(entity) {
    const d = ensure();
    d.items[entity.id] = {
      id: entity.id,
      vaultId: entity.vaultId,
      type: entity.type,
      payload: entity,
      updatedAt: entity.updatedAt,
      version: entity.version,
      deletedAt: entity.deletedAt,
      syncState: isSynced(entity.vaultId) ? "pending" : "synced"
    };
    if (isSynced(entity.vaultId)) {
      d.outbox.push({
        seq: ++d.outboxSeq,
        itemId: entity.id,
        vaultId: entity.vaultId,
        op: "upsert",
        payload: entity,
        createdAt: Date.now(),
        attempts: 0
      });
    }
    persist();
  },
  remove(id) {
    const d = ensure();
    const row = d.items[id];
    if (!row) return;
    const now = Date.now();
    row.deletedAt = now;
    row.version += 1;
    row.updatedAt = now;
    row.syncState = isSynced(row.vaultId) ? "pending" : "synced";
    if (isSynced(row.vaultId)) {
      d.outbox.push({
        seq: ++d.outboxSeq,
        itemId: id,
        vaultId: row.vaultId,
        op: "delete",
        payload: row.payload,
        createdAt: now,
        attempts: 0
      });
    }
    persist();
  },
  // ── Sync drain API (M6) ──
  /** Semua operasi belum tersinkron, urut kronologis (seq naik). */
  outboxPending() {
    return [...ensure().outbox].sort((a, b) => a.seq - b.seq);
  },
  /**
   * Tandai seq tertentu sudah terkirim: buang dari outbox, lalu set item
   * ke 'synced' bila tak ada lagi outbox tertunda untuknya.
   */
  markSynced(seqs) {
    const d = ensure();
    const done = new Set(seqs);
    d.outbox = d.outbox.filter((o) => !done.has(o.seq));
    const stillPending = new Set(d.outbox.map((o) => o.itemId));
    for (const row of Object.values(d.items)) {
      if (row.syncState === "pending" && !stillPending.has(row.id)) row.syncState = "synced";
    }
    persist();
  },
  /** Terapkan record dari remote TANPA mengantri ulang ke outbox (Bab 8.4). */
  applyRemote(entity) {
    const d = ensure();
    d.items[entity.id] = {
      id: entity.id,
      vaultId: entity.vaultId,
      type: entity.type,
      payload: entity,
      updatedAt: entity.updatedAt,
      version: entity.version,
      deletedAt: entity.deletedAt,
      syncState: "synced"
    };
    persist();
  },
  /**
   * Antre ulang SEMUA item lokal ke outbox (full re-upload). Dipakai saat remote
   * hilang/terhapus manual dan perlu dibangun ulang dari lokal. Reset cursor agar
   * pull berikutnya menyerap ulang dari awal. Mengembalikan jumlah item.
   */
  requeueAll() {
    const d = ensure();
    const now = Date.now();
    let n = 0;
    for (const row of Object.values(d.items)) {
      if (!isSynced(row.vaultId)) continue;
      d.outbox.push({
        seq: ++d.outboxSeq,
        itemId: row.id,
        vaultId: row.vaultId,
        op: row.deletedAt ? "delete" : "upsert",
        payload: row.payload,
        createdAt: now,
        attempts: 0
      });
      row.syncState = "pending";
      n += 1;
    }
    d.syncCursor = {};
    persist();
    return n;
  },
  getCursor(vaultId) {
    return ensure().syncCursor?.[vaultId] ?? 0;
  },
  setCursor(vaultId, ts2) {
    const d = ensure();
    if (!d.syncCursor) d.syncCursor = {};
    d.syncCursor[vaultId] = ts2;
    persist();
  }
};
const metaStore = {
  load(vaultId) {
    return ensure().vaultMeta[vaultId] ?? null;
  },
  save(meta) {
    ensure().vaultMeta[meta.vaultId] = meta;
    persist();
  }
};
class VaultError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.code = code;
    this.name = "VaultError";
  }
}
class SshError extends Error {
  constructor(kind, message) {
    super(message ?? kind);
    this.kind = kind;
    this.name = "SshError";
  }
}
function mapSshError(err) {
  const raw = err instanceof Error ? err.message : String(err);
  const code = err?.code ?? "";
  if (code === "ECONNREFUSED" || /ECONNREFUSED/.test(raw))
    return { kind: "ECONNREFUSED", message: "Server menolak koneksi di port tersebut." };
  if (code === "ETIMEDOUT" || /ETIMEDOUT|timeout/i.test(raw))
    return { kind: "ETIMEDOUT", message: "Tidak ada respons dalam 20 detik — cek firewall atau VPN." };
  if (code === "ENOTFOUND" || /ENOTFOUND/.test(raw))
    return { kind: "ENOTFOUND", message: "Hostname tidak ditemukan." };
  if (/All configured authentication methods failed|authentication/i.test(raw))
    return { kind: "AUTH_FAILED", message: "Autentikasi gagal — periksa username, password, atau key." };
  return { kind: "UNKNOWN", message: raw };
}
const KDF_PARAMS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  // 64 MiB
  timeCost: 3,
  parallelism: 4,
  hashLength: 32
};
const KDF_PARAMS_SERIALIZED = {
  m: KDF_PARAMS.memoryCost,
  t: KDF_PARAMS.timeCost,
  p: KDF_PARAMS.parallelism,
  hashLength: KDF_PARAMS.hashLength
};
async function deriveMasterKey(password, salt) {
  return argon2.hash(password, { ...KDF_PARAMS, salt, raw: true });
}
function hkdf(key, info, len = 32) {
  return Buffer.from(node_crypto.hkdfSync("sha256", key, Buffer.alloc(0), Buffer.from(info), len));
}
function seal(plain, key, aad, kid) {
  const iv = node_crypto.randomBytes(12);
  const aadBuf = Buffer.from(aad, "utf8");
  const c = node_crypto.createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(aadBuf);
  const input = typeof plain === "string" ? Buffer.from(plain, "utf8") : plain;
  const ct = Buffer.concat([c.update(input), c.final()]);
  return {
    v: 1,
    alg: "A256GCM",
    iv: iv.toString("base64"),
    ct: ct.toString("base64"),
    tag: c.getAuthTag().toString("base64"),
    aad: aadBuf.toString("base64"),
    kid
  };
}
function open(env, key) {
  const d = node_crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(env.iv, "base64"));
  d.setAAD(Buffer.from(env.aad, "base64"));
  d.setAuthTag(Buffer.from(env.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(env.ct, "base64")), d.final()]);
}
function wipe(...bufs) {
  for (const b of bufs) if (b) b.fill(0);
}
function randomVaultKey() {
  return node_crypto.randomBytes(32);
}
const KEK_INFO = "vault-kek-v1";
const CURRENT_KID = "k1";
class VaultCore {
  constructor(meta) {
    this.meta = meta;
  }
  vaultKey = null;
  state = "locked";
  autoLockTimer;
  autoLockMs = VAULT.autoLockMs;
  /** Dipanggil VaultCore.lock() untuk menutup semua sesi aktif. */
  onLock;
  get vaultId() {
    return VAULT.personalVaultId;
  }
  status() {
    if (this.state === "unlocked") return "unlocked";
    return this.meta.load(this.vaultId) ? "locked" : "no-vault";
  }
  isUnlocked() {
    return this.state === "unlocked" && this.vaultKey !== null;
  }
  /** Buat vault baru dari master password. */
  async create(password) {
    if (this.meta.load(this.vaultId)) throw new VaultError("ALREADY_EXISTS");
    const salt = node_crypto.randomBytes(16);
    const mk = await deriveMasterKey(password, salt);
    const kek = hkdf(mk, KEK_INFO);
    const vaultKey = randomVaultKey();
    const wrapped = seal(vaultKey, kek, `wrap|${this.vaultId}`, CURRENT_KID);
    wipe(mk, kek);
    this.meta.save({
      vaultId: this.vaultId,
      wrappedVaultKey: wrapped,
      kdfSalt: salt.toString("base64"),
      kdfParams: KDF_PARAMS_SERIALIZED,
      keyRing: [CURRENT_KID],
      schemaVersion: 1
    });
    this.vaultKey = vaultKey;
    this.state = "unlocked";
    this.resetAutoLock();
  }
  async unlock(password) {
    const meta = this.meta.load(this.vaultId);
    if (!meta) throw new VaultError("NO_VAULT");
    const mk = await deriveMasterKey(password, Buffer.from(meta.kdfSalt, "base64"));
    const kek = hkdf(mk, KEK_INFO);
    try {
      this.vaultKey = open(meta.wrappedVaultKey, kek);
    } catch {
      wipe(mk, kek);
      throw new VaultError("WRONG_PASSWORD");
    }
    wipe(mk, kek);
    this.state = "unlocked";
    this.resetAutoLock();
  }
  /** Unlock langsung dengan Vault Key dari OS keychain (biometrik). */
  unlockWithVaultKey(vaultKey) {
    if (!this.meta.load(this.vaultId)) throw new VaultError("NO_VAULT");
    this.vaultKey = vaultKey;
    this.state = "unlocked";
    this.resetAutoLock();
  }
  lock() {
    wipe(this.vaultKey);
    this.vaultKey = null;
    this.state = "locked";
    clearTimeout(this.autoLockTimer);
    this.onLock?.();
  }
  /** Ganti master password: bungkus ulang Vault Key saja (O(1), Bab 7.5). */
  async changePassword(oldPw, newPw) {
    await this.unlock(oldPw);
    if (!this.vaultKey) throw new VaultError("LOCKED");
    const salt = node_crypto.randomBytes(16);
    const mk = await deriveMasterKey(newPw, salt);
    const kek = hkdf(mk, KEK_INFO);
    const wrapped = seal(this.vaultKey, kek, `wrap|${this.vaultId}`, CURRENT_KID);
    wipe(mk, kek);
    const meta = this.meta.load(this.vaultId);
    this.meta.save({ ...meta, wrappedVaultKey: wrapped, kdfSalt: salt.toString("base64") });
  }
  /** Export Vault Key untuk disimpan di OS keychain. Hati-hati memakainya. */
  exportVaultKey() {
    if (!this.vaultKey) throw new VaultError("LOCKED");
    return Buffer.from(this.vaultKey);
  }
  encryptField(plain, itemId, field) {
    if (!this.vaultKey) throw new VaultError("LOCKED");
    this.resetAutoLock();
    return seal(
      plain,
      hkdf(this.vaultKey, `item:${itemId}`),
      `${this.vaultId}|${itemId}|${field}`,
      CURRENT_KID
    );
  }
  decryptField(env, itemId) {
    if (!this.vaultKey) throw new VaultError("LOCKED");
    this.resetAutoLock();
    return open(env, hkdf(this.vaultKey, `item:${itemId}`));
  }
  decryptString(env, itemId) {
    return this.decryptField(env, itemId).toString("utf8");
  }
  touch() {
    if (this.isUnlocked()) this.resetAutoLock();
  }
  resetAutoLock() {
    clearTimeout(this.autoLockTimer);
    this.autoLockTimer = setTimeout(() => this.lock(), this.autoLockMs);
  }
}
const itemRepo = {
  newId() {
    return node_crypto.randomUUID();
  },
  listByType(vaultId, type) {
    return jsonStore.listByType(vaultId, type).map((r) => r.payload);
  },
  /** Lintas semua vault (Lokal + Cloud). */
  listByTypeAll(type) {
    return jsonStore.listByTypeAll(type).map((r) => r.payload);
  },
  get(id) {
    const r = jsonStore.get(id);
    return r ? r.payload : null;
  },
  /** Upsert entity + catat ke outbox untuk sync (Bab 3, 8.3). */
  upsert(entity) {
    jsonStore.upsert(entity);
  },
  /** Soft delete (tombstone) — hard delete dilarang (Bab 8.2). */
  remove(id) {
    jsonStore.remove(id);
  }
};
function groupChain(host, get) {
  const chain = [];
  const seen = /* @__PURE__ */ new Set();
  let gid = host.groupId;
  while (gid && !seen.has(gid)) {
    seen.add(gid);
    const g = get(gid);
    if (!g || g.type !== "group") break;
    chain.push(g);
    gid = g.parentId;
  }
  return chain;
}
function resolveEffective(host, get) {
  const chain = groupChain(host, get);
  const nearest = (pick) => {
    for (const g of chain) {
      const v = pick(g.defaults);
      if (v !== void 0 && v !== null && v !== "") return v;
    }
    return void 0;
  };
  const asIdentity = (id) => {
    if (!id) return null;
    const e = get(id);
    return e && e.type === "identity" ? e : null;
  };
  const hostIdentity = asIdentity(host.identityId);
  const groupIdentityId = nearest((d) => d.identityId) ?? null;
  const groupIdentity = asIdentity(groupIdentityId);
  const effIdentity = hostIdentity ?? groupIdentity;
  const username = (hostIdentity?.username || void 0) ?? nearest((d) => d.username) ?? (effIdentity?.username || void 0) ?? null;
  const port = host.port ?? nearest((d) => d.port) ?? null;
  const identityId = host.identityId ?? groupIdentityId ?? null;
  const keyId = host.keyId ?? hostIdentity?.keyId ?? nearest((d) => d.keyId) ?? groupIdentity?.keyId ?? null;
  const envVars = {};
  for (let i = chain.length - 1; i >= 0; i--) {
    Object.assign(envVars, chain[i].defaults.envVars ?? {});
  }
  const groupPath = chain.map((g) => g.name).reverse();
  return { username, port, identityId, keyId, envVars, groupPath };
}
class HostService {
  constructor(vault, ownerUid) {
    this.vault = vault;
    this.ownerUid = ownerUid;
  }
  toView(h) {
    const eff = resolveEffective(h, (id) => itemRepo.get(id));
    const identity = eff.identityId ? itemRepo.get(eff.identityId) : null;
    const hasCredential = (identity?.secret ?? null) !== null || eff.keyId !== null;
    return {
      id: h.id,
      vaultId: h.vaultId,
      groupId: h.groupId,
      label: h.label,
      address: h.address,
      port: h.port,
      protocol: h.protocol,
      identityId: h.identityId,
      keyId: h.keyId,
      jumpHostId: h.jumpHostId,
      tags: h.tags,
      environment: h.environment,
      favorite: h.favorite,
      agentForwarding: h.agentForwarding,
      keepAliveInterval: h.keepAliveInterval,
      lastConnectedAt: h.lastConnectedAt,
      effectiveUsername: eff.username,
      effectivePort: eff.port,
      hasCredential,
      groupPath: eff.groupPath
    };
  }
  listHosts() {
    return itemRepo.listByTypeAll("host").map((h) => this.toView(h));
  }
  getHost(id) {
    const h = itemRepo.get(id);
    return h ? this.toView(h) : null;
  }
  saveHost(input) {
    const now = Date.now();
    const existing = input.id ? itemRepo.get(input.id) : null;
    const id = existing?.id ?? itemRepo.newId();
    const vaultId = existing?.vaultId ?? input.vaultId ?? VAULT.defaultVaultId;
    let identityId = input.identityId ?? existing?.identityId ?? null;
    if (input.password || input.username) {
      const identity = this.upsertInlineIdentity(
        identityId,
        input.username ?? "root",
        input.password,
        now,
        vaultId
      );
      identityId = identity;
    }
    const host = {
      id,
      type: "host",
      ownerUid: this.ownerUid(),
      vaultId,
      updatedAt: now,
      version: (existing?.version ?? 0) + 1,
      deletedAt: null,
      groupId: input.groupId ?? existing?.groupId ?? null,
      label: input.label,
      address: input.address,
      port: input.port ?? existing?.port ?? null,
      protocol: input.protocol ?? existing?.protocol ?? "ssh",
      identityId,
      keyId: input.keyId ?? existing?.keyId ?? null,
      jumpHostId: input.jumpHostId ?? existing?.jumpHostId ?? null,
      tags: input.tags ?? existing?.tags ?? [],
      environment: input.environment ?? existing?.environment ?? "none",
      themeId: existing?.themeId ?? null,
      fontId: existing?.fontId ?? null,
      startupSnippetId: existing?.startupSnippetId ?? null,
      backspaceMode: existing?.backspaceMode ?? "del",
      keepAliveInterval: input.keepAliveInterval ?? existing?.keepAliveInterval ?? 0,
      agentForwarding: input.agentForwarding ?? existing?.agentForwarding ?? false,
      charset: existing?.charset ?? "utf-8",
      notes: existing?.notes ?? null,
      favorite: input.favorite ?? existing?.favorite ?? false,
      lastConnectedAt: existing?.lastConnectedAt ?? null
    };
    itemRepo.upsert(host);
    return id;
  }
  upsertInlineIdentity(existingId, username, password, now, vaultId) {
    const prev = existingId ? itemRepo.get(existingId) : null;
    const id = prev?.id ?? itemRepo.newId();
    const secret = password ? this.vault.encryptField(password, id, "secret") : prev?.secret ?? null;
    const identity = {
      id,
      type: "identity",
      ownerUid: this.ownerUid(),
      vaultId: prev?.vaultId ?? vaultId,
      updatedAt: now,
      version: (prev?.version ?? 0) + 1,
      deletedAt: null,
      label: `${username}@inline`,
      username,
      secret,
      keyId: prev?.keyId ?? null
    };
    itemRepo.upsert(identity);
    return id;
  }
  removeHost(id) {
    itemRepo.remove(id);
  }
  listGroups() {
    return itemRepo.listByTypeAll("group").map((g) => ({
      id: g.id,
      parentId: g.parentId,
      name: g.name,
      defaults: g.defaults
    }));
  }
  saveGroup(input) {
    const now = Date.now();
    const existing = input.id ? itemRepo.get(input.id) : null;
    const id = existing?.id ?? itemRepo.newId();
    const group = {
      id,
      type: "group",
      ownerUid: this.ownerUid(),
      updatedAt: now,
      version: (existing?.version ?? 0) + 1,
      deletedAt: null,
      parentId: input.parentId ?? existing?.parentId ?? null,
      vaultId: existing?.vaultId ?? VAULT.defaultVaultId,
      name: input.name,
      defaults: input.defaults ?? existing?.defaults ?? {}
    };
    itemRepo.upsert(group);
    return id;
  }
  removeGroup(id) {
    itemRepo.remove(id);
  }
}
class IdentityService {
  constructor(vault, ownerUid) {
    this.vault = vault;
    this.ownerUid = ownerUid;
  }
  toView(i) {
    return {
      id: i.id,
      vaultId: i.vaultId,
      label: i.label,
      username: i.username,
      keyId: i.keyId,
      hasSecret: i.secret !== null
    };
  }
  list() {
    return itemRepo.listByTypeAll("identity").map((i) => this.toView(i));
  }
  save(input) {
    const now = Date.now();
    const existing = input.id ? itemRepo.get(input.id) : null;
    const id = existing?.id ?? itemRepo.newId();
    const secret = input.password ? this.vault.encryptField(input.password, id, "secret") : existing?.secret ?? null;
    const identity = {
      id,
      type: "identity",
      ownerUid: this.ownerUid(),
      vaultId: existing?.vaultId ?? input.vaultId ?? VAULT.defaultVaultId,
      updatedAt: now,
      version: (existing?.version ?? 0) + 1,
      deletedAt: null,
      label: input.label,
      username: input.username,
      secret,
      keyId: input.keyId ?? existing?.keyId ?? null
    };
    itemRepo.upsert(identity);
    return id;
  }
  remove(id) {
    itemRepo.remove(id);
  }
}
function fingerprintOf(key) {
  return "SHA256:" + node_crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
}
const knownHosts = {
  find(pattern) {
    const all = itemRepo.listByType(VAULT.personalVaultId, "knownhost");
    return all.find((k) => k.hostPattern === pattern) ?? null;
  },
  matches(entry, key) {
    const stored = Buffer.from(entry.publicKey, "base64");
    return stored.length === key.length && node_crypto.timingSafeEqual(stored, key);
  },
  add(pattern, keyType, key, ownerUid) {
    const now = Date.now();
    const existing = this.find(pattern);
    const entity = {
      id: existing?.id ?? itemRepo.newId(),
      type: "knownhost",
      ownerUid,
      vaultId: VAULT.personalVaultId,
      updatedAt: now,
      version: (existing?.version ?? 0) + 1,
      deletedAt: null,
      hostPattern: pattern,
      keyType,
      publicKey: key.toString("base64"),
      firstSeenAt: existing?.firstSeenAt ?? now
    };
    itemRepo.upsert(entity);
  }
};
class SshSession {
  constructor(host, creds, ownerUid, emit) {
    this.host = host;
    this.creds = creds;
    this.ownerUid = ownerUid;
    this.emit = emit;
  }
  id = node_crypto.randomUUID();
  client = new ssh2.Client();
  stream;
  outBuf = [];
  flushTimer;
  pendingAuthFinish;
  pendingHostKey;
  async connect(cols, rows) {
    const cfg = {
      host: this.host.address,
      port: this.host.port ?? SSH.defaultPort,
      username: this.creds.username,
      ident: APP.sshIdent,
      readyTimeout: SSH.readyTimeoutMs,
      keepaliveInterval: (this.host.keepAliveInterval || SSH.keepAliveIntervalSec) * 1e3,
      keepaliveCountMax: SSH.keepAliveCountMax,
      agentForward: this.host.agentForwarding,
      tryKeyboard: true,
      hostVerifier: (key, verify) => {
        void this.verifyHostKey(key).then(verify);
      }
    };
    if (this.creds.privateKey) {
      cfg.privateKey = this.creds.privateKey;
      if (this.creds.passphrase) cfg.passphrase = this.creds.passphrase;
    } else if (this.creds.password) {
      cfg.password = this.creds.password;
    }
    this.client.on("keyboard-interactive", (_n, _i, _l, prompts, finish) => {
      this.pendingAuthFinish = finish;
      this.emit("auth:prompt", { sessionId: this.id, prompts: prompts.map((p) => p.prompt) });
    });
    await new Promise((resolve, reject) => {
      this.client.once("ready", () => resolve());
      this.client.once("error", reject);
      this.client.connect(cfg);
    });
    wipe(this.creds.privateKey);
    this.creds.password = void 0;
    this.creds.passphrase = void 0;
    this.stream = await this.openShell(cols, rows);
  }
  openShell(cols, rows) {
    return new Promise((resolve, reject) => {
      this.client.shell({ term: APP.term, cols, rows }, (err, stream) => {
        if (err) return reject(err);
        stream.on("data", (d) => this.push(d.toString("utf8")));
        stream.stderr.on("data", (d) => this.push(d.toString("utf8")));
        stream.on("close", (code) => {
          this.flush();
          this.emit("term:exit", { sessionId: this.id, code: code ?? 0, reason: "closed" });
        });
        resolve(stream);
      });
    });
  }
  async verifyHostKey(key) {
    const pattern = `${this.host.address}:${this.host.port ?? SSH.defaultPort}`;
    const fp = fingerprintOf(key);
    const known = knownHosts.find(pattern);
    if (!known) {
      const ok = await this.promptHostKey("unknown", pattern, fp);
      if (ok) knownHosts.add(pattern, "ssh", key, this.ownerUid);
      return ok;
    }
    if (knownHosts.matches(known, key)) return true;
    return this.promptHostKey("changed", pattern, fp, known.publicKey);
  }
  promptHostKey(kind, pattern, fingerprint, previous) {
    return new Promise((resolve) => {
      this.pendingHostKey = resolve;
      this.emit("host:keyPrompt", { sessionId: this.id, kind, pattern, fingerprint, previous });
    });
  }
  answerHostKey(accept) {
    this.pendingHostKey?.(accept);
    this.pendingHostKey = void 0;
  }
  answerAuthPrompt(answers) {
    this.pendingAuthFinish?.(answers);
    this.pendingAuthFinish = void 0;
  }
  /** Batching output — pembeda terminal mulus vs patah-patah (Bab 10.1). */
  push(chunk) {
    this.outBuf.push(chunk);
    if (this.outBuf.length > SSH.flushChunkThreshold) return this.flush();
    this.flushTimer ??= setTimeout(() => this.flush(), SSH.flushIntervalMs);
  }
  flush() {
    if (!this.outBuf.length) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = void 0;
    const data2 = this.outBuf.join("");
    this.outBuf.length = 0;
    this.emit("term:output", { sessionId: this.id, data: data2 });
  }
  write(data2) {
    this.stream?.write(data2);
  }
  resize(cols, rows) {
    this.stream?.setWindow(rows, cols, 0, 0);
  }
  close() {
    try {
      this.stream?.end();
      this.client.end();
    } catch {
    }
  }
}
class SshManager {
  constructor(vault, ownerUid, emit) {
    this.vault = vault;
    this.ownerUid = ownerUid;
    this.emit = emit;
  }
  sessions = /* @__PURE__ */ new Map();
  /** Resolve credential efektif via warisan host → identity → group chain (Bab 2.2, M3). */
  resolveCredentials(host) {
    const eff = resolveEffective(host, (id) => itemRepo.get(id));
    let password;
    let privateKey;
    let passphrase;
    const username = eff.username || "root";
    const identity = eff.identityId ? itemRepo.get(eff.identityId) : null;
    if (identity?.secret) password = this.vault.decryptString(identity.secret, identity.id);
    if (eff.keyId) {
      const key = itemRepo.get(eff.keyId);
      if (key) {
        privateKey = this.vault.decryptField(key.privateKey, key.id);
        if (key.passphrase) passphrase = this.vault.decryptString(key.passphrase, key.id);
      }
    }
    return { username, password, privateKey, passphrase };
  }
  async open(hostId, cols, rows) {
    const host = itemRepo.get(hostId);
    if (!host) throw new SshError("UNKNOWN", "Host tidak ditemukan");
    const creds = this.resolveCredentials(host);
    const session = new SshSession(host, creds, this.ownerUid(), this.emit);
    this.sessions.set(session.id, session);
    try {
      await session.connect(cols, rows);
    } catch (err) {
      this.sessions.delete(session.id);
      wipe(creds.privateKey);
      const mapped = mapSshError(err);
      throw new SshError(mapped.kind, mapped.message);
    }
    return { sessionId: session.id };
  }
  /** Test koneksi cepat: sukses connect lalu langsung tutup (Bab 15.4). */
  async testConnection(hostId) {
    const started = Date.now();
    try {
      const { sessionId } = await this.open(hostId, 80, 24);
      const latencyMs = Date.now() - started;
      this.close(sessionId);
      return { ok: true, latencyMs };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  write(sessionId, data2) {
    this.sessions.get(sessionId)?.write(data2);
  }
  resize(sessionId, cols, rows) {
    this.sessions.get(sessionId)?.resize(cols, rows);
  }
  answerAuthPrompt(sessionId, answers) {
    this.sessions.get(sessionId)?.answerAuthPrompt(answers);
  }
  answerHostKey(sessionId, accept) {
    this.sessions.get(sessionId)?.answerHostKey(accept);
  }
  close(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.close();
    this.sessions.delete(sessionId);
  }
  /** Push public key ke authorized_keys server, idempoten (Bab 10.4). */
  async pushKey(publicKey, hostId) {
    if (!publicKey || publicKey.startsWith("(")) throw new SshError("UNKNOWN", "Public key tidak tersedia");
    const host = itemRepo.get(hostId);
    if (!host) throw new SshError("UNKNOWN", "Host tidak ditemukan");
    const creds = this.resolveCredentials(host);
    const client = new ssh2.Client();
    const cfg = {
      host: host.address,
      port: host.port ?? SSH.defaultPort,
      username: creds.username,
      ident: APP.sshIdent,
      readyTimeout: SSH.readyTimeoutMs,
      hostVerifier: (key, verify) => {
        const known = knownHosts.find(`${host.address}:${host.port ?? SSH.defaultPort}`);
        verify(!!known && knownHosts.matches(known, key));
      }
    };
    if (creds.privateKey) {
      cfg.privateKey = creds.privateKey;
      if (creds.passphrase) cfg.passphrase = creds.passphrase;
    } else if (creds.password) cfg.password = creds.password;
    const q = publicKey.trim().replace(/'/g, `'\\''`);
    const cmd = [
      "mkdir -p ~/.ssh && chmod 700 ~/.ssh",
      "touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys",
      `grep -qxF '${q}' ~/.ssh/authorized_keys || echo '${q}' >> ~/.ssh/authorized_keys`
    ].join(" && ");
    try {
      await new Promise((resolve, reject) => {
        client.once("ready", () => {
          client.exec(cmd, (err, stream) => {
            if (err) return reject(err);
            stream.on("close", (code) => code === 0 ? resolve() : reject(new Error("exec gagal")));
            stream.resume();
          });
        });
        client.once("error", reject);
        client.connect(cfg);
      });
    } catch (e) {
      const m = mapSshError(e);
      throw new SshError(m.kind, m.kind === "HOST_KEY_REJECTED" || /verif/i.test(m.message) ? "Hubungkan ke host ini dulu agar kuncinya dipercaya, lalu ulangi push." : m.message);
    } finally {
      wipe(creds.privateKey);
      client.end();
    }
  }
  /** Tutup semua sesi — dipanggil saat vault di-lock (Bab 7.3). */
  closeAll(reason) {
    for (const [id, s] of this.sessions) {
      s.close();
      this.emit("term:exit", { sessionId: id, code: 0, reason });
    }
    this.sessions.clear();
  }
}
function generateKey(alg, bits = 4096, passphrase) {
  const priv = passphrase ? { type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase } : { type: "pkcs8", format: "pem" };
  const { publicKey, privateKey } = node_crypto.generateKeyPairSync(alg, {
    ...alg === "rsa" ? { modulusLength: bits } : {},
    ...alg === "ecdsa" ? { namedCurve: "prime256v1" } : {},
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: priv
  });
  const fingerprintSha256 = "SHA256:" + node_crypto.createHash("sha256").update(publicKey).digest("base64").replace(/=+$/, "");
  return { publicKey, privateKey, fingerprintSha256 };
}
function fpOf(pem) {
  return "SHA256:" + node_crypto.createHash("sha256").update(pem).digest("base64").replace(/=+$/, "");
}
class KeyService {
  constructor(vault, ownerUid) {
    this.vault = vault;
    this.ownerUid = ownerUid;
  }
  toView(k) {
    return {
      id: k.id,
      label: k.label,
      algorithm: k.algorithm,
      bits: k.bits,
      publicKey: k.publicKey,
      fingerprintSha256: k.fingerprintSha256,
      source: k.source
    };
  }
  list() {
    return itemRepo.listByTypeAll("sshkey").map((k) => this.toView(k));
  }
  persist(input) {
    const now = Date.now();
    const id = itemRepo.newId();
    const key = {
      id,
      type: "sshkey",
      ownerUid: this.ownerUid(),
      vaultId: VAULT.defaultVaultId,
      updatedAt: now,
      version: 1,
      deletedAt: null,
      label: input.label,
      algorithm: input.algorithm,
      bits: input.bits,
      publicKey: input.publicKey,
      privateKey: this.vault.encryptField(input.privateKeyPem, id, "privateKey"),
      passphrase: input.passphrase ? this.vault.encryptField(input.passphrase, id, "passphrase") : null,
      fingerprintSha256: input.fingerprintSha256,
      source: input.source
    };
    itemRepo.upsert(key);
    return id;
  }
  generate(o) {
    const gen = generateKey(o.algorithm, o.bits ?? 4096, o.passphrase);
    return this.persist({
      algorithm: o.algorithm,
      bits: o.algorithm === "rsa" ? o.bits ?? 4096 : null,
      label: o.label,
      publicKey: gen.publicKey,
      privateKeyPem: gen.privateKey,
      passphrase: o.passphrase,
      fingerprintSha256: gen.fingerprintSha256,
      source: "generated"
    });
  }
  /** Import PEM/OpenSSH private key. publicKey diturunkan bila memungkinkan. */
  importPem(o) {
    const { createPrivateKey, createPublicKey } = require("node:crypto");
    let publicKey = "";
    let algorithm = "ed25519";
    let bits = null;
    try {
      const priv = createPrivateKey({ key: o.pem, passphrase: o.passphrase });
      const pubPem = createPublicKey(priv).export({ type: "spki", format: "pem" });
      publicKey = pubPem;
      const t = priv.asymmetricKeyType;
      algorithm = t === "rsa" ? "rsa" : t === "ec" ? "ecdsa" : "ed25519";
      bits = priv.asymmetricKeyDetails?.modulusLength ?? null;
    } catch {
      publicKey = "";
    }
    return this.persist({
      algorithm,
      bits,
      label: o.label,
      publicKey,
      privateKeyPem: o.pem,
      passphrase: o.passphrase,
      fingerprintSha256: fpOf(o.pem),
      source: "imported"
    });
  }
  exportPublic(id) {
    const k = itemRepo.get(id);
    if (!k) throw new Error("Key tidak ditemukan");
    return k.publicKey || "(public key tidak tersedia untuk key ini)";
  }
  remove(id) {
    itemRepo.remove(id);
  }
}
function remoteWins(local, remote) {
  if (!local) return true;
  if (remote.version !== local.version) return remote.version > local.version;
  return remote.updatedAt > local.updatedAt;
}
class SyncEngine {
  constructor(store, transport, emit, vaults) {
    this.store = store;
    this.transport = transport;
    this.emit = emit;
    this.vaults = vaults;
  }
  running = false;
  pendingCount() {
    return this.store.outboxPending().length;
  }
  status() {
    return {
      state: this.transport.isConfigured() ? "idle" : "offline",
      pending: this.pendingCount(),
      user: this.transport.currentUser(),
      configured: this.transport.isConfigured()
    };
  }
  /** Satu siklus sync penuh. Aman dipanggil ulang; menolak reentrancy. */
  async syncNow() {
    if (this.running) return { ok: false, pushed: 0, pulled: 0, reason: "busy" };
    if (!this.transport.isConfigured() || !this.transport.currentUser()) {
      this.emit("offline", this.pendingCount());
      return { ok: false, pushed: 0, pulled: 0, reason: "not-configured" };
    }
    this.running = true;
    this.emit("syncing", this.pendingCount());
    try {
      const pushed = await this.pushPhase();
      const pulled = await this.pullPhase();
      this.emit("idle", this.pendingCount());
      return { ok: true, pushed, pulled };
    } catch (err) {
      this.emit("error", this.pendingCount());
      return { ok: false, pushed: 0, pulled: 0, reason: err instanceof Error ? err.message : String(err) };
    } finally {
      this.running = false;
    }
  }
  async pushPhase() {
    const pending = this.store.outboxPending();
    if (pending.length === 0) return 0;
    const byVault = /* @__PURE__ */ new Map();
    for (const row of pending) {
      const list = byVault.get(row.vaultId) ?? [];
      list.push(row);
      byVault.set(row.vaultId, list);
    }
    let pushed = 0;
    for (const [vaultId, rows] of byVault) {
      const entities = rows.map((r) => r.payload).filter((p) => p !== null);
      await this.transport.push(vaultId, entities);
      this.store.markSynced(rows.map((r) => r.seq));
      pushed += rows.length;
    }
    return pushed;
  }
  async pullPhase() {
    let pulled = 0;
    for (const vaultId of this.vaults) {
      const since = this.store.getCursor(vaultId);
      const remote = await this.transport.pull(vaultId, since);
      let maxSeen = since;
      for (const entity of remote) {
        maxSeen = Math.max(maxSeen, entity.updatedAt);
        if (remoteWins(this.store.getRaw(entity.id), entity)) {
          this.store.applyRemote(entity);
          pulled += 1;
        }
      }
      this.store.setCursor(vaultId, maxSeen);
    }
    return pulled;
  }
}
const ts = () => (/* @__PURE__ */ new Date()).toISOString();
const logger = {
  info: (...a) => console.log(`[${ts()}] [info]`, ...a),
  warn: (...a) => console.warn(`[${ts()}] [warn]`, ...a),
  error: (...a) => console.error(`[${ts()}] [error]`, ...a)
};
function firebaseConfigPath() {
  return path.join(electron.app.getPath("userData"), "firebase-config.json");
}
async function loadFirebase() {
  try {
    const appMod = await import("firebase/app");
    const authMod = await import("firebase/auth");
    const fsMod = await import("firebase/firestore");
    return { appMod, authMod, fsMod };
  } catch (e) {
    logger.warn("firebase belum terpasang; sync nonaktif", e);
    return null;
  }
}
function loadConfig() {
  const env = process.env.WANN_FIREBASE_CONFIG;
  if (env) {
    try {
      return JSON.parse(env);
    } catch {
    }
  }
  try {
    const p = firebaseConfigPath();
    if (node_fs.existsSync(p)) return JSON.parse(node_fs.readFileSync(p, "utf8"));
  } catch {
  }
  return null;
}
class FirestoreTransport {
  config = loadConfig();
  fb = null;
  db = null;
  auth = null;
  uid = null;
  isConfigured() {
    return this.config !== null;
  }
  /** Baca ulang config dari disk (dipanggil setelah import). Reset app agar init ulang. */
  reloadConfig() {
    this.config = loadConfig();
    this.fb = null;
    this.db = null;
    this.auth = null;
    return this.isConfigured();
  }
  currentUser() {
    return this.uid;
  }
  async ensureInit() {
    if (this.db || !this.config) return;
    this.fb = await loadFirebase();
    if (!this.fb) throw new Error("Paket firebase belum terpasang (npm install firebase)");
    const application = this.fb.appMod.initializeApp(this.config);
    this.db = this.fb.fsMod.getFirestore(application);
    this.auth = this.fb.authMod.getAuth(application);
  }
  /** Sign-in email/password. Password TIDAK disimpan (Bab 18). */
  async signIn(email, password) {
    await this.ensureInit();
    const cred = await this.fb.authMod.signInWithEmailAndPassword(this.auth, email, password);
    this.uid = cred.user.uid;
    return this.uid;
  }
  async signOut() {
    if (this.auth) await this.fb.authMod.signOut(this.auth);
    this.uid = null;
  }
  itemsCol(vaultId) {
    return this.fb.fsMod.collection(this.db, "users", this.uid, "vaults", vaultId, "items");
  }
  async push(vaultId, entities) {
    if (!this.uid) throw new Error("Belum sign-in");
    await this.ensureInit();
    const { doc, setDoc } = this.fb.fsMod;
    for (const entity of entities) {
      await setDoc(doc(this.itemsCol(vaultId), entity.id), entity);
    }
  }
  async pull(vaultId, since) {
    if (!this.uid) throw new Error("Belum sign-in");
    await this.ensureInit();
    const { query, where, getDocs } = this.fb.fsMod;
    const q = query(this.itemsCol(vaultId), where("updatedAt", ">", since));
    const snap = await getDocs(q);
    const out = [];
    snap.forEach((d) => out.push(d.data()));
    return out;
  }
}
function keychainPath() {
  return path.join(electron.app.getPath("userData"), "vaultkey.bin");
}
function biometricAvailable() {
  return electron.safeStorage.isEncryptionAvailable();
}
async function storeVaultKey(vaultKey) {
  if (!biometricAvailable()) throw new Error("BIOMETRIC_UNAVAILABLE");
  const blob = electron.safeStorage.encryptString(vaultKey.toString("base64"));
  await node_fs.promises.writeFile(keychainPath(), blob);
}
async function loadVaultKey() {
  try {
    const blob = await node_fs.promises.readFile(keychainPath());
    const b64 = electron.safeStorage.decryptString(blob);
    return Buffer.from(b64, "base64");
  } catch {
    return null;
  }
}
const CH = {
  vault: {
    status: "vault:status",
    create: "vault:create",
    unlock: "vault:unlock",
    lock: "vault:lock",
    changePassword: "vault:changePassword",
    enableBiometric: "vault:enableBiometric",
    biometricAvailable: "vault:biometricAvailable"
  },
  hosts: {
    list: "hosts:list",
    get: "hosts:get",
    save: "hosts:save",
    remove: "hosts:remove",
    testConnection: "hosts:testConnection"
  },
  groups: {
    list: "groups:list",
    save: "groups:save",
    remove: "groups:remove"
  },
  identities: {
    list: "identities:list",
    save: "identities:save",
    remove: "identities:remove"
  },
  sync: {
    status: "sync:status",
    now: "sync:now",
    pushAll: "sync:pushAll",
    signIn: "sync:signIn",
    signOut: "sync:signOut",
    importConfig: "sync:importConfig"
  },
  keys: {
    list: "keys:list",
    generate: "keys:generate",
    importPem: "keys:importPem",
    exportPublic: "keys:exportPublic",
    pushToHost: "keys:pushToHost",
    remove: "keys:remove"
  },
  session: {
    open: "session:open",
    write: "session:write",
    resize: "session:resize",
    close: "session:close",
    answerAuthPrompt: "session:answerAuthPrompt",
    answerHostKey: "session:answerHostKey"
  },
  evt: {
    vaultLocked: "vault:locked",
    syncState: "sync:state"
  }
};
class AppContext {
  vault;
  hosts;
  identities;
  ssh;
  keys;
  sync;
  syncTransport;
  sender = null;
  /** UID lokal-only sampai Firebase auth aktif. */
  uid = "local-user";
  constructor() {
    this.vault = new VaultCore(metaStore);
    const uidFn = () => this.uid;
    const emit = (channel, payload) => this.emit(channel, payload);
    this.hosts = new HostService(this.vault, uidFn);
    this.identities = new IdentityService(this.vault, uidFn);
    this.ssh = new SshManager(this.vault, uidFn, emit);
    this.keys = new KeyService(this.vault, uidFn);
    this.syncTransport = new FirestoreTransport();
    this.sync = new SyncEngine(
      jsonStore,
      this.syncTransport,
      (state, pending) => this.emit(CH.evt.syncState, { state, pending }),
      [VAULT.personalVaultId]
    );
    this.vault.onLock = () => {
      this.ssh.closeAll("vault-locked");
      this.emit(CH.evt.vaultLocked, void 0);
    };
  }
  setSender(wc) {
    this.sender = wc;
  }
  emit(channel, payload) {
    if (this.sender && !this.sender.isDestroyed()) this.sender.send(channel, payload);
  }
  biometricAvailable() {
    return biometricAvailable();
  }
  async enableBiometric() {
    const key = this.vault.exportVaultKey();
    await storeVaultKey(key);
    key.fill(0);
  }
  async tryBiometricUnlock() {
    if (this.vault.status() !== "locked") return false;
    const key = await loadVaultKey();
    if (!key) return false;
    this.vault.unlockWithVaultKey(key);
    return true;
  }
}
const PasswordSchema = zod.z.string().min(1).max(1024);
const VaultIdSchema = zod.z.enum(["local", "personal"]);
const HostInputSchema = zod.z.object({
  id: zod.z.string().uuid().optional(),
  vaultId: VaultIdSchema.optional(),
  groupId: zod.z.string().uuid().nullable().optional(),
  label: zod.z.string().min(1).max(200),
  address: zod.z.string().min(1).max(255),
  port: zod.z.number().int().min(1).max(65535).nullable().optional(),
  protocol: zod.z.enum(["ssh", "telnet", "mosh", "local"]).optional(),
  identityId: zod.z.string().uuid().nullable().optional(),
  keyId: zod.z.string().uuid().nullable().optional(),
  jumpHostId: zod.z.string().uuid().nullable().optional(),
  tags: zod.z.array(zod.z.string().max(64)).max(50).optional(),
  environment: zod.z.enum(["none", "prod", "staging", "dev"]).optional(),
  favorite: zod.z.boolean().optional(),
  agentForwarding: zod.z.boolean().optional(),
  keepAliveInterval: zod.z.number().int().min(0).max(3600).optional(),
  password: zod.z.string().max(1024).optional(),
  username: zod.z.string().max(255).optional()
});
const GroupDefaultsSchema = zod.z.object({
  username: zod.z.string().max(255).optional(),
  port: zod.z.number().int().min(1).max(65535).optional(),
  identityId: zod.z.string().uuid().optional(),
  keyId: zod.z.string().uuid().optional(),
  envVars: zod.z.record(zod.z.string().max(255), zod.z.string().max(4096)).optional()
});
const GroupInputSchema = zod.z.object({
  id: zod.z.string().uuid().optional(),
  name: zod.z.string().min(1).max(200),
  parentId: zod.z.string().uuid().nullable().optional(),
  defaults: GroupDefaultsSchema.optional()
});
const IdentityInputSchema = zod.z.object({
  id: zod.z.string().uuid().optional(),
  vaultId: VaultIdSchema.optional(),
  label: zod.z.string().min(1).max(200),
  username: zod.z.string().min(1).max(255),
  password: zod.z.string().max(1024).optional(),
  keyId: zod.z.string().uuid().nullable().optional()
});
const SessionOpenSchema = zod.z.object({
  hostId: zod.z.string().uuid(),
  cols: zod.z.number().int().min(1).max(1e3),
  rows: zod.z.number().int().min(1).max(1e3)
});
const KeyGenSchema = zod.z.object({
  label: zod.z.string().min(1).max(200),
  algorithm: zod.z.enum(["ed25519", "rsa", "ecdsa"]),
  bits: zod.z.number().int().optional(),
  passphrase: zod.z.string().max(1024).optional()
});
const KeyImportSchema = zod.z.object({
  label: zod.z.string().min(1).max(200),
  pem: zod.z.string().min(1).max(1e5),
  passphrase: zod.z.string().max(1024).optional()
});
const IdSchema = zod.z.string().uuid();
const SignInSchema = zod.z.object({
  email: zod.z.string().email().max(320),
  password: zod.z.string().min(1).max(1024)
});
const FirebaseConfigSchema = zod.z.object({
  apiKey: zod.z.string().min(1).max(500),
  authDomain: zod.z.string().min(1).max(500),
  projectId: zod.z.string().min(1).max(200),
  appId: zod.z.string().min(1).max(500)
}).passthrough();
function registerIpc(ctx2) {
  const { vault, hosts, identities, ssh, keys, sync, syncTransport } = ctx2;
  electron.ipcMain.handle(CH.vault.status, () => ({ state: vault.status() }));
  electron.ipcMain.handle(CH.vault.create, async (_e, raw) => {
    await vault.create(PasswordSchema.parse(raw));
  });
  electron.ipcMain.handle(CH.vault.unlock, async (_e, raw) => {
    await vault.unlock(PasswordSchema.parse(raw));
  });
  electron.ipcMain.handle(CH.vault.lock, () => vault.lock());
  electron.ipcMain.handle(CH.vault.changePassword, async (_e, oldPw, newPw) => {
    await vault.changePassword(PasswordSchema.parse(oldPw), PasswordSchema.parse(newPw));
  });
  electron.ipcMain.handle(CH.vault.biometricAvailable, () => ctx2.biometricAvailable());
  electron.ipcMain.handle(CH.vault.enableBiometric, async () => ctx2.enableBiometric());
  electron.ipcMain.handle(CH.hosts.list, () => hosts.listHosts());
  electron.ipcMain.handle(CH.hosts.get, (_e, raw) => hosts.getHost(IdSchema.parse(raw)));
  electron.ipcMain.handle(CH.hosts.save, (_e, raw) => hosts.saveHost(HostInputSchema.parse(raw)));
  electron.ipcMain.handle(CH.hosts.remove, (_e, raw) => hosts.removeHost(IdSchema.parse(raw)));
  electron.ipcMain.handle(CH.hosts.testConnection, (_e, raw) => ssh.testConnection(IdSchema.parse(raw)));
  electron.ipcMain.handle(CH.groups.list, () => hosts.listGroups());
  electron.ipcMain.handle(CH.groups.save, (_e, raw) => hosts.saveGroup(GroupInputSchema.parse(raw)));
  electron.ipcMain.handle(CH.groups.remove, (_e, raw) => hosts.removeGroup(IdSchema.parse(raw)));
  electron.ipcMain.handle(CH.identities.list, () => identities.list());
  electron.ipcMain.handle(CH.identities.save, (_e, raw) => identities.save(IdentityInputSchema.parse(raw)));
  electron.ipcMain.handle(CH.identities.remove, (_e, raw) => identities.remove(IdSchema.parse(raw)));
  electron.ipcMain.handle(CH.sync.status, () => sync.status());
  electron.ipcMain.handle(CH.sync.now, () => sync.syncNow());
  electron.ipcMain.handle(CH.sync.pushAll, async () => {
    const requeued = jsonStore.requeueAll();
    const outcome = await sync.syncNow();
    return { requeued, ...outcome };
  });
  electron.ipcMain.handle(CH.sync.signIn, async (_e, rawEmail, rawPw) => {
    const { email, password } = SignInSchema.parse({ email: rawEmail, password: rawPw });
    const uid = await syncTransport.signIn(email, password);
    void sync.syncNow();
    return { uid };
  });
  electron.ipcMain.handle(CH.sync.signOut, () => syncTransport.signOut());
  electron.ipcMain.handle(CH.sync.importConfig, async () => {
    const win = electron.BrowserWindow.getFocusedWindow();
    const opts = {
      title: "Pilih firebase-config.json",
      filters: [{ name: "Firebase config", extensions: ["json"] }],
      properties: ["openFile"]
    };
    const res = win ? await electron.dialog.showOpenDialog(win, opts) : await electron.dialog.showOpenDialog(opts);
    if (res.canceled || res.filePaths.length === 0) {
      return { configured: syncTransport.isConfigured(), canceled: true };
    }
    try {
      const cfg = FirebaseConfigSchema.parse(JSON.parse(node_fs.readFileSync(res.filePaths[0], "utf8")));
      node_fs.writeFileSync(firebaseConfigPath(), JSON.stringify(cfg, null, 2), "utf8");
      const configured = syncTransport.reloadConfig();
      logger.info("Firebase config diimpor; sync configured =", configured);
      return { configured };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      return { configured: syncTransport.isConfigured(), error: `File config tidak valid: ${error}` };
    }
  });
  electron.ipcMain.handle(CH.keys.list, () => keys.list());
  electron.ipcMain.handle(CH.keys.generate, (_e, raw) => keys.generate(KeyGenSchema.parse(raw)));
  electron.ipcMain.handle(CH.keys.exportPublic, (_e, raw) => keys.exportPublic(IdSchema.parse(raw)));
  electron.ipcMain.handle(CH.keys.importPem, (_e, raw) => keys.importPem(KeyImportSchema.parse(raw)));
  electron.ipcMain.handle(CH.keys.remove, (_e, raw) => keys.remove(IdSchema.parse(raw)));
  electron.ipcMain.handle(CH.keys.pushToHost, async (_e, keyId, hostId) => {
    const pub = keys.exportPublic(IdSchema.parse(keyId));
    await ssh.pushKey(pub, IdSchema.parse(hostId));
  });
  electron.ipcMain.handle(CH.session.open, async (_e, raw) => {
    const input = SessionOpenSchema.parse(raw);
    return ssh.open(input.hostId, input.cols, input.rows);
  });
  electron.ipcMain.on(CH.session.write, (_e, sessionId, data2) => {
    if (typeof sessionId === "string" && typeof data2 === "string") ssh.write(sessionId, data2);
  });
  electron.ipcMain.on(CH.session.resize, (_e, sessionId, cols, rows) => {
    ssh.resize(sessionId, cols, rows);
  });
  electron.ipcMain.handle(CH.session.close, (_e, raw) => {
    ssh.close(IdSchema.parse(raw));
  });
  electron.ipcMain.handle(CH.session.answerAuthPrompt, (_e, sessionId, answers) => {
    ssh.answerAuthPrompt(IdSchema.parse(sessionId), answers.map(String));
  });
  electron.ipcMain.handle(CH.session.answerHostKey, (_e, sessionId, accept) => {
    ssh.answerHostKey(IdSchema.parse(sessionId), Boolean(accept));
  });
  logger.info("IPC handlers registered");
}
function createMainWindow() {
  const win = new electron.BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: "#12151c",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      contextIsolation: true,
      // WAJIB
      nodeIntegration: false,
      // WAJIB
      sandbox: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
      preload: path.join(__dirname, "../preload/index.js")
    }
  });
  win.once("ready-to-show", () => win.show());
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https:")) void electron.shell.openExternal(url);
    return { action: "deny" };
  });
  if (process.env["ELECTRON_RENDERER_URL"]) {
    void win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
  return win;
}
function attachWindow(win) {
  if (!win || win.isDestroyed()) return;
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https:")) void electron.shell.openExternal(url);
    return { action: "deny" };
  });
  if (process.env["ELECTRON_RENDERER_URL"]) {
    void win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
  if (!win.isVisible()) win.show();
  win.focus();
}
function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...isMac ? [{ role: "appMenu" }] : [],
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" }
  ];
  electron.Menu.setApplicationMenu(electron.Menu.buildFromTemplate(template));
}
let ctx = null;
let ownWindow = null;
let booted = false;
let ipcRegistered = false;
async function initSsh() {
  if (booted) return;
  initDb();
  ctx = new AppContext();
  if (!ipcRegistered) {
    registerIpc(ctx);
    ipcRegistered = true;
  }
  const { powerMonitor } = await import("electron");
  powerMonitor.on("suspend", () => ctx?.vault.lock());
  powerMonitor.on("lock-screen", () => ctx?.vault.lock());
  booted = true;
  logger.info("WANN SSH embed runtime siap");
}
function openSshWindow() {
  if (ownWindow && !ownWindow.isDestroyed()) {
    if (ownWindow.isMinimized()) ownWindow.restore();
    ownWindow.show();
    ownWindow.focus();
    return;
  }
  ownWindow = createMainWindow();
  ctx?.setSender(ownWindow.webContents);
  ownWindow.on("closed", () => {
    ownWindow = null;
  });
}
function attachSshWindow(win) {
  attachWindow(win);
  ctx?.setSender(win.webContents);
}
function shutdownSsh() {
  try {
    ctx?.vault.lock();
  } catch {
  }
  if (ownWindow && !ownWindow.isDestroyed()) {
    try {
      ownWindow.destroy();
    } catch {
    }
  }
  ownWindow = null;
  booted = false;
}
function getSshStatus() {
  return { running: booted, vault: ctx ? ctx.vault.status() : "locked" };
}
if (!process.env.WAN_SUPER_APP_EMBED) {
  if (!electron.app.requestSingleInstanceLock()) {
    electron.app.quit();
  } else {
    let ctx2;
    let mainWindow = null;
    const registerProtocol = () => {
      if (process.defaultApp && process.argv.length >= 2) {
        electron.app.setAsDefaultProtocolClient(APP.scheme, process.execPath, [process.argv[1]]);
      } else {
        electron.app.setAsDefaultProtocolClient(APP.scheme);
      }
    };
    electron.app.whenReady().then(() => {
      registerProtocol();
      initDb();
      ctx2 = new AppContext();
      registerIpc(ctx2);
      buildMenu();
      mainWindow = createMainWindow();
      ctx2.setSender(mainWindow.webContents);
      import("electron").then(({ powerMonitor }) => {
        powerMonitor.on("suspend", () => ctx2.vault.lock());
        powerMonitor.on("lock-screen", () => ctx2.vault.lock());
      });
      electron.app.on("activate", () => {
        if (electron.BrowserWindow.getAllWindows().length === 0) {
          mainWindow = createMainWindow();
          ctx2.setSender(mainWindow.webContents);
        }
      });
      logger.info(`${APP.name} ${APP.version} siap`);
    });
    electron.app.on("open-url", (event, url) => {
      event.preventDefault();
      logger.info("deep link diterima:", url);
      mainWindow?.webContents.send("deeplink", url);
    });
    electron.app.on("window-all-closed", () => {
      if (process.platform !== "darwin") electron.app.quit();
    });
  }
}
exports.attachSshWindow = attachSshWindow;
exports.getSshStatus = getSshStatus;
exports.initSsh = initSsh;
exports.openSshWindow = openSshWindow;
exports.shutdownSsh = shutdownSsh;
