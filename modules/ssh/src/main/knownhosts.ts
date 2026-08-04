import * as node_crypto from "node:crypto";
import { VAULT } from "./constants.js";
import { itemRepo } from "./repo.js";

export function knownHostPattern(address: string, port = 22) {
  return `${address}:${port}`;
}

export function fingerprintOf(key: Buffer) {
  return "SHA256:" + node_crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
}

export const knownHosts = {
  find(pattern: string) {
    const all = itemRepo.listByTypeAll("knownhost");
    return all.find((k: any) => k.hostPattern === pattern) ?? null;
  },
  matches(entry: any, key: Buffer) {
    const stored = Buffer.from(entry.publicKey, "base64");
    return stored.length === key.length && node_crypto.timingSafeEqual(stored, key);
  },
  add(pattern: string, keyType: string, key: Buffer, ownerUid: string, vaultId = VAULT.defaultVaultId) {
    const now = Date.now();
    const existing = this.find(pattern);
    const entity = {
      id: existing?.id ?? itemRepo.newId(),
      type: "knownhost",
      ownerUid,
      vaultId: existing?.vaultId ?? vaultId,
      updatedAt: now,
      version: (existing?.version ?? 0) + 1,
      deletedAt: null,
      hostPattern: pattern,
      keyType,
      publicKey: key.toString("base64"),
      firstSeenAt: existing?.firstSeenAt ?? now
    };
    itemRepo.upsert(entity);
    return entity;
  },
  list() {
    return itemRepo.listByTypeAll("knownhost").map((entry: any) => ({
      id: entry.id,
      vaultId: entry.vaultId,
      hostPattern: entry.hostPattern,
      keyType: entry.keyType,
      fingerprint: fingerprintOf(Buffer.from(entry.publicKey, "base64")),
      firstSeenAt: entry.firstSeenAt,
      updatedAt: entry.updatedAt
    }));
  },
  remove(id: string) {
    itemRepo.remove(id);
  }
};
