import * as node_fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import { VAULT, isSynced } from "./constants.js";

let dbPath: string;
let data: any;
let inMemory = false;
let recovery: { needed: boolean; message?: string; corruptPath?: string; restoredFrom?: string } = { needed: false };

const CURRENT_SCHEMA_VERSION = 2;

/** In-memory store for unit tests — no Electron app or filesystem required. */
export function initDbForTest() {
  inMemory = true;
  data = empty();
  recovery = { needed: false };
}

function empty() {
  return { schemaVersion: CURRENT_SCHEMA_VERSION, vaultMeta: {}, items: {}, outbox: [], outboxSeq: 0, syncCursor: {}, settings: {} };
}

export function normalizeStoreData(raw: any) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Root database harus berupa object");
  const normalized = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    vaultMeta: raw.vaultMeta && typeof raw.vaultMeta === "object" && !Array.isArray(raw.vaultMeta) ? raw.vaultMeta : {},
    items: raw.items && typeof raw.items === "object" && !Array.isArray(raw.items) ? raw.items : {},
    outbox: Array.isArray(raw.outbox) ? raw.outbox : [],
    outboxSeq: Number.isSafeInteger(raw.outboxSeq) && raw.outboxSeq >= 0 ? raw.outboxSeq : 0,
    syncCursor: raw.syncCursor && typeof raw.syncCursor === "object" && !Array.isArray(raw.syncCursor) ? raw.syncCursor : {},
    settings: raw.settings && typeof raw.settings === "object" && !Array.isArray(raw.settings) ? raw.settings : {}
  };
  for (const [id, row] of Object.entries(normalized.items) as [string, any][]) {
    if (!row || typeof row !== "object" || row.id !== id || !row.payload || typeof row.payload !== "object") {
      delete normalized.items[id];
      continue;
    }
    row.deletedAt = row.deletedAt == null ? null : row.deletedAt;
    row.payload.deletedAt = row.payload.deletedAt == null ? null : row.payload.deletedAt;
    row.syncState = row.syncState === "pending" ? "pending" : "synced";
  }
  normalized.outbox = normalized.outbox.filter((operation: any) =>
    operation && Number.isSafeInteger(operation.seq) && typeof operation.itemId === "string"
  );
  normalized.outboxSeq = normalized.outbox.reduce(
    (maximum: number, operation: any) => Math.max(maximum, operation.seq),
    normalized.outboxSeq
  );
  return normalized;
}

function readDatabase(candidate: string) {
  return normalizeStoreData(JSON.parse(node_fs.readFileSync(candidate, "utf8")));
}

function backupPath(index: number) {
  return `${dbPath}.bak${index}`;
}

/** Rotasi backup mahal (3× copy sinkron); batasi minimal 1× per interval ini. */
const BACKUP_MIN_INTERVAL_MS = 30_000;
let lastBackupAt = 0;

function rotateBackups() {
  if (!node_fs.existsSync(dbPath)) return;
  for (let index = 3; index >= 2; index -= 1) {
    const previous = backupPath(index - 1);
    if (node_fs.existsSync(previous)) node_fs.copyFileSync(previous, backupPath(index));
  }
  node_fs.copyFileSync(dbPath, backupPath(1));
  for (let index = 1; index <= 3; index += 1) {
    try {
      node_fs.chmodSync(backupPath(index), 0o600);
    } catch {
    }
  }
  lastBackupAt = Date.now();
}

export function initDb() {
  dbPath = path.join(app.getPath("userData"), "wann-ssh.json");
  data = undefined;
  node_fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  recovery = { needed: false };
  if (node_fs.existsSync(dbPath)) {
    try {
      data = readDatabase(dbPath);
    } catch (error) {
      const corruptPath = path.join(path.dirname(dbPath), `wann-ssh.corrupt-${Date.now()}.json`);
      try {
        node_fs.copyFileSync(dbPath, corruptPath);
        node_fs.chmodSync(corruptPath, 0o600);
      } catch {
      }
      let restoredFrom: string | undefined;
      for (let index = 1; index <= 3; index += 1) {
        const candidate = backupPath(index);
        if (!node_fs.existsSync(candidate)) continue;
        try {
          data = readDatabase(candidate);
          restoredFrom = candidate;
          break;
        } catch {
        }
      }
      data ??= empty();
      recovery = {
        needed: true,
        message: restoredFrom
          ? "Database utama rusak; backup terakhir yang valid dipulihkan."
          : "Database utama rusak dan tidak ada backup valid; database baru dibuat tanpa menghapus salinan rusak.",
        corruptPath,
        restoredFrom
      };
    }
  } else {
    data = empty();
  }
  persist(false);
}

function persist(withBackup = true) {
  data = normalizeStoreData(data);
  if (inMemory) return;
  const tmp = `${dbPath}.tmp`;
  // Atomic write tetap tiap kali, tapi rotasi backup dibatasi per interval agar
  // burst write (mis. full pull sync) tidak memicu ratusan copy sinkron.
  if (withBackup && Date.now() - lastBackupAt >= BACKUP_MIN_INTERVAL_MS) rotateBackups();
  node_fs.writeFileSync(tmp, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
  const descriptor = node_fs.openSync(tmp, "r");
  try {
    node_fs.fsyncSync(descriptor);
  } finally {
    node_fs.closeSync(descriptor);
  }
  node_fs.renameSync(tmp, dbPath);
  try {
    node_fs.chmodSync(dbPath, 0o600);
  } catch {
  }
}

function ensure() {
  if (!data) throw new Error("DB not initialized");
  return data;
}

export function createTombstonePayload(payload: any, deletedAt: number, version: number) {
  return { ...payload, deletedAt, version, updatedAt: deletedAt };
}

export function createRestoredPayload(payload: any, updatedAt: number, version: number) {
  return { ...payload, deletedAt: null, version, updatedAt };
}

export function replaceSyncedOutbox(d: any, now: number) {
  d.outbox = d.outbox.filter((o: any) => !isSynced(o.vaultId));
  let count = 0;
  for (const row of Object.values(d.items) as any[]) {
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
    count += 1;
  }
  return count;
}

export function clearSyncedData(d: any, preserveVaultMeta = false) {
  let count = 0;
  for (const id of Object.keys(d.items)) {
    if (isSynced(d.items[id].vaultId)) {
      delete d.items[id];
      count += 1;
    }
  }
  d.outbox = d.outbox.filter((o: any) => !isSynced(o.vaultId));
  for (const vaultId of VAULT.syncedVaultIds) {
    if (d.syncCursor) delete d.syncCursor[vaultId];
    if (!preserveVaultMeta && d.vaultMeta) delete d.vaultMeta[vaultId];
  }
  return count;
}

export const jsonStore = {
  storageStatus() {
    return {
      path: dbPath,
      schemaVersion: ensure().schemaVersion,
      backups: [1, 2, 3].map(backupPath).filter((candidate) => node_fs.existsSync(candidate)),
      ...recovery
    };
  },
  acknowledgeRecovery() {
    recovery = { needed: false };
  },
  listByType(vaultId: string, type: string) {
    return Object.values(ensure().items).filter((r: any) => r.vaultId === vaultId && r.type === type && r.deletedAt === null).sort((a: any, b: any) => b.updatedAt - a.updatedAt);
  },
  /** Semua vault (Lokal + Cloud) untuk satu tipe — dipakai UI lintas-workspace. */
  listByTypeAll(type: string) {
    return Object.values(ensure().items).filter((r: any) => r.type === type && r.deletedAt === null).sort((a: any, b: any) => b.updatedAt - a.updatedAt);
  },
  listSyncedPayloads() {
    return Object.values(ensure().items)
      .filter((r: any) => isSynced(r.vaultId) && r.deletedAt === null)
      .map((r: any) => r.payload);
  },
  get(id: string) {
    const r = ensure().items[id];
    return r && r.deletedAt === null ? r : null;
  },
  getRaw(id: string) {
    return ensure().items[id] ?? null;
  },
  upsert(entity: any) {
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
  remove(id: string) {
    const d = ensure();
    const row = d.items[id];
    if (!row) return;
    const now = Date.now();
    row.deletedAt = now;
    row.version += 1;
    row.updatedAt = now;
    row.payload = createTombstonePayload(row.payload, now, row.version);
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
  restoreLatestDeleted(type: string) {
    const d = ensure();
    const row = (Object.values(d.items) as any[])
      .filter((item) => item.type === type && item.deletedAt !== null)
      .sort((a, b) => b.deletedAt - a.deletedAt)[0];
    if (!row) return null;
    const now = Date.now();
    row.version += 1;
    row.updatedAt = now;
    row.deletedAt = null;
    row.payload = createRestoredPayload(row.payload, now, row.version);
    row.syncState = isSynced(row.vaultId) ? "pending" : "synced";
    if (isSynced(row.vaultId)) {
      d.outbox.push({
        seq: ++d.outboxSeq,
        itemId: row.id,
        vaultId: row.vaultId,
        op: "upsert",
        payload: row.payload,
        createdAt: now,
        attempts: 0
      });
    }
    persist();
    return row.payload;
  },
  // ── Sync drain API (M6) ──
  /** Semua operasi belum tersinkron, urut kronologis (seq naik). */
  outboxPending() {
    return [...ensure().outbox].sort((a: any, b: any) => a.seq - b.seq);
  },
  /**
   * Tandai seq tertentu sudah terkirim: buang dari outbox, lalu set item
   * ke 'synced' bila tak ada lagi outbox tertunda untuknya.
   */
  markSynced(seqs: number[]) {
    const d = ensure();
    const done = new Set(seqs);
    d.outbox = d.outbox.filter((o: any) => !done.has(o.seq));
    const stillPending = new Set(d.outbox.map((o: any) => o.itemId));
    for (const row of Object.values(d.items) as any[]) {
      if (row.syncState === "pending" && !stillPending.has(row.id)) row.syncState = "synced";
    }
    persist();
  },
  /** Terapkan record dari remote TANPA mengantri ulang ke outbox (Bab 8.4). */
  applyRemote(entity: any) {
    const d = ensure();
    // RTDB tidak menyimpan value null → deletedAt hilang saat pull (undefined).
    // Normalisasi ke null agar filter `deletedAt === null` di listByType* lolos,
    // kalau tidak host tidak akan muncul di list.
    const deletedAt = entity.deletedAt == null ? null : entity.deletedAt;
    d.items[entity.id] = {
      id: entity.id,
      vaultId: entity.vaultId,
      type: entity.type,
      payload: { ...entity, deletedAt },
      updatedAt: entity.updatedAt,
      version: entity.version,
      deletedAt,
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
    const n = replaceSyncedOutbox(d, now);
    d.syncCursor = {};
    persist();
    return n;
  },
  getCursor(vaultId: string) {
    return ensure().syncCursor?.[vaultId] ?? 0;
  },
  setCursor(vaultId: string, ts2: number) {
    const d = ensure();
    if (!d.syncCursor) d.syncCursor = {};
    d.syncCursor[vaultId] = ts2;
    persist();
  },
  /**
   * Bersihkan SEMUA data vault tersinkron (cloud) beserta outbox & cursornya.
   * Dipakai saat ganti akun (sign in/out) agar host milik akun lama tidak
    * tercampur dengan akun baru. Wrapped vault metadata tetap disimpan agar
    * logout tidak mengubah layar unlock menjadi pembuatan Vault Key baru.
   * Mengembalikan jumlah item yang dibuang.
   */
  clearSyncedItems(preserveVaultMeta = false) {
    const d = ensure();
    const n = clearSyncedData(d, preserveVaultMeta);
    persist();
    return n;
  },
  /**
   * Reset HANYA cursor vault tersinkron ke 0 tanpa menghapus item.
   * Dipakai saat fresh sign-in agar pull berikutnya menyerap SEMUA item cloud
   * (startAt(0+1)), sehingga list host akun ini pasti terisi ulang.
   */
  resetSyncedCursors() {
    const d = ensure();
    if (!d.syncCursor) return;
    for (const vaultId of VAULT.syncedVaultIds) {
      delete d.syncCursor[vaultId];
    }
    persist();
  }
};

export const metaStore = {
  load(vaultId: string) {
    return ensure().vaultMeta[vaultId] ?? null;
  },
  save(meta: any) {
    ensure().vaultMeta[meta.vaultId] = meta;
    persist();
  },
  remove(vaultId: string) {
    delete ensure().vaultMeta[vaultId];
    persist();
  }
};

export const settingsStore = {
  get(key: string, fallback?: any) {
    const value = ensure().settings?.[key];
    return value === undefined ? fallback : value;
  },
  set(key: string, value: any) {
    const d = ensure();
    d.settings ??= {};
    d.settings[key] = value;
    persist();
  }
};

export const syncStore = {
  ...jsonStore,
  loadVaultMeta(vaultId: string) {
    return metaStore.load(vaultId);
  },
  saveRemoteVaultMeta(meta: any) {
    metaStore.save(meta);
  }
};
