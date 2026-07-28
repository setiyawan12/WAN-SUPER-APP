import * as node_fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import { VAULT, isSynced } from "./constants.js";

let dbPath: string;
let data: any;

function empty() {
  return { schemaVersion: 1, vaultMeta: {}, items: {}, outbox: [], outboxSeq: 0, syncCursor: {} };
}

export function initDb() {
  dbPath = path.join(app.getPath("userData"), "wann-ssh.json");
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

export const jsonStore = {
  listByType(vaultId: string, type: string) {
    return Object.values(ensure().items).filter((r: any) => r.vaultId === vaultId && r.type === type && r.deletedAt === null).sort((a: any, b: any) => b.updatedAt - a.updatedAt);
  },
  /** Semua vault (Lokal + Cloud) untuk satu tipe — dipakai UI lintas-workspace. */
  listByTypeAll(type: string) {
    return Object.values(ensure().items).filter((r: any) => r.type === type && r.deletedAt === null).sort((a: any, b: any) => b.updatedAt - a.updatedAt);
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
    let n = 0;
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
      n += 1;
    }
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
   * tercampur dengan akun baru. Vault lokal (privasi) TIDAK ikut terhapus.
   * Mengembalikan jumlah item yang dibuang.
   */
  clearSyncedItems() {
    const d = ensure();
    let n = 0;
    for (const id of Object.keys(d.items)) {
      if (isSynced(d.items[id].vaultId)) {
        delete d.items[id];
        n += 1;
      }
    }
    d.outbox = d.outbox.filter((o: any) => !isSynced(o.vaultId));
    for (const vaultId of VAULT.syncedVaultIds) {
      if (d.syncCursor) delete d.syncCursor[vaultId];
    }
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
  }
};
