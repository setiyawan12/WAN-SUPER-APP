import * as node_crypto from "node:crypto";
import { jsonStore } from "./store.js";

export const itemRepo = {
  newId() {
    return node_crypto.randomUUID();
  },
  listByType(vaultId: string, type: string) {
    return jsonStore.listByType(vaultId, type).map((r: any) => r.payload);
  },
  /** Lintas semua vault (Lokal + Cloud). */
  listByTypeAll(type: string) {
    return jsonStore.listByTypeAll(type).map((r: any) => r.payload);
  },
  get(id: string) {
    const r = jsonStore.get(id);
    return r ? r.payload : null;
  },
  /** Upsert entity + catat ke outbox untuk sync (Bab 3, 8.3). */
  upsert(entity: any) {
    jsonStore.upsert(entity);
  },
  /** Soft delete (tombstone) — hard delete dilarang (Bab 8.2). */
  remove(id: string) {
    jsonStore.remove(id);
  }
};

export function groupChain(host: any, get: (id: string) => any) {
  const chain: any[] = [];
  const seen = new Set<string>();
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

export function resolveEffective(host: any, get: (id: string) => any) {
  const chain = groupChain(host, get);
  const nearest = (pick: (d: any) => any) => {
    for (const g of chain) {
      const v = pick(g.defaults);
      if (v !== void 0 && v !== null && v !== "") return v;
    }
    return void 0;
  };
  const asIdentity = (id: string | null | undefined) => {
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
  const envVars: Record<string, string> = {};
  for (let i = chain.length - 1; i >= 0; i--) {
    Object.assign(envVars, chain[i].defaults.envVars ?? {});
  }
  const groupPath = chain.map((g) => g.name).reverse();
  return { username, port, identityId, keyId, envVars, groupPath };
}
