import * as node_crypto from "node:crypto";
import { VAULT } from "./constants.js";
import { itemRepo } from "./repo.js";

export function fingerprintOf(key: Buffer) {
  return "SHA256:" + node_crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
}

export const knownHosts = {
  find(pattern: string) {
    const all = itemRepo.listByType(VAULT.personalVaultId, "knownhost");
    return all.find((k: any) => k.hostPattern === pattern) ?? null;
  },
  matches(entry: any, key: Buffer) {
    const stored = Buffer.from(entry.publicKey, "base64");
    return stored.length === key.length && node_crypto.timingSafeEqual(stored, key);
  },
  add(pattern: string, keyType: string, key: Buffer, ownerUid: string) {
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
