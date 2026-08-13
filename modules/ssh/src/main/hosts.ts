import { VAULT, logger } from "./constants.js";
import { VaultError } from "./errors.js";
import { resolveJumpChain } from "./jumps.js";
import { itemRepo, resolveEffective } from "./repo.js";
import type { VaultCore } from "./vault.js";

export class HostService {
  vault: VaultCore;
  ownerUid: () => string;
  constructor(vault: VaultCore, ownerUid: () => string) {
    this.vault = vault;
    this.ownerUid = ownerUid;
  }
  toView(h: any) {
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
      startupSnippetId: h.startupSnippetId,
      tags: h.tags,
      environment: h.environment,
      favorite: h.favorite,
      agentForwarding: h.agentForwarding,
      autoReconnect: h.autoReconnect,
      reconnectLimit: h.reconnectLimit,
      keepAliveInterval: h.keepAliveInterval,
      lastConnectedAt: h.lastConnectedAt,
      openSshAlias: h.openSshAlias ?? null,
      effectiveUsername: eff.username,
      effectivePort: eff.port,
      hasCredential,
      groupPath: eff.groupPath
    };
  }
  listHosts() {
    return itemRepo.listByTypeAll("host").map((h) => this.toView(h));
  }
  getHost(id: string) {
    const h = itemRepo.get(id);
    return h ? this.toView(h) : null;
  }
  /** Decrypt password efektif host (dari identity inline/tersimpan) untuk ditampilkan
   *  di UI — vault WAJIB sudah unlock. Return null bila host pakai SSH key / tanpa password. */
  revealPassword(id: string): string | null {
    const h = itemRepo.get(id);
    if (!h) return null;
    const eff = resolveEffective(h, (rid: string) => itemRepo.get(rid));
    const identity = eff.identityId ? itemRepo.get(eff.identityId) : null;
    if (!identity || !identity.secret) return null;
    try {
      return this.vault.decryptString(identity.secret, identity.id);
    } catch (e) {
      // Secret disegel dengan Vault Key berbeda (belum tersinkron ke perangkat
      // ini). Kembalikan null — UI menampilkan field kosong, bukan crash.
      if (e instanceof VaultError && e.code === "UNDECRYPTABLE") {
        logger.warn("revealPassword: secret tak bisa didekripsi (Vault Key beda) untuk identity", identity.id);
        return null;
      }
      throw e;
    }
  }
  saveHost(input: any) {
    const now = Date.now();
    const existing = input.id ? itemRepo.get(input.id) : null;
    const id = existing?.id ?? itemRepo.newId();
    const vaultId = existing?.vaultId ?? input.vaultId ?? VAULT.defaultVaultId;
    let identityId = input.identityId !== undefined ? input.identityId : existing?.identityId ?? null;
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
      groupId: input.groupId !== undefined ? input.groupId : existing?.groupId ?? null,
      label: input.label,
      address: input.address,
      port: input.port !== undefined ? input.port : existing?.port ?? null,
      protocol: input.protocol ?? existing?.protocol ?? "ssh",
      identityId,
      keyId: input.keyId !== undefined ? input.keyId : existing?.keyId ?? null,
      jumpHostId: input.jumpHostId !== undefined ? input.jumpHostId : existing?.jumpHostId ?? null,
      tags: input.tags ?? existing?.tags ?? [],
      environment: input.environment ?? existing?.environment ?? "none",
      themeId: existing?.themeId ?? null,
      fontId: existing?.fontId ?? null,
      startupSnippetId: input.startupSnippetId !== undefined ? input.startupSnippetId : existing?.startupSnippetId ?? null,
      backspaceMode: existing?.backspaceMode ?? "del",
      keepAliveInterval: input.keepAliveInterval ?? existing?.keepAliveInterval ?? 0,
      agentForwarding: input.agentForwarding ?? existing?.agentForwarding ?? false,
      autoReconnect: input.autoReconnect ?? existing?.autoReconnect ?? true,
      reconnectLimit: input.reconnectLimit ?? existing?.reconnectLimit ?? 3,
      charset: existing?.charset ?? "utf-8",
      notes: existing?.notes ?? null,
      favorite: input.favorite ?? existing?.favorite ?? false,
      lastConnectedAt: existing?.lastConnectedAt ?? null,
      openSshAlias: input.openSshAlias ?? existing?.openSshAlias ?? null
    };
    resolveJumpChain(host, (hostId) => hostId === id ? host : itemRepo.get(hostId));
    itemRepo.upsert(host);
    return id;
  }
  upsertInlineIdentity(existingId: string | null, username: string, password: string | undefined, now: number, vaultId: string) {
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
  removeHost(id: string) {
    itemRepo.remove(id);
  }
  restoreLatestDeletedHost() {
    return itemRepo.restoreLatestDeleted("host");
  }
  listGroups() {
    return itemRepo.listByTypeAll("group").map((g) => ({
      id: g.id,
      parentId: g.parentId,
      name: g.name,
      defaults: g.defaults
    }));
  }
  saveGroup(input: any) {
    const now = Date.now();
    const existing = input.id ? itemRepo.get(input.id) : null;
    const id = existing?.id ?? itemRepo.newId();
    const parentId = input.parentId !== undefined ? input.parentId : existing?.parentId ?? null;
    if (parentId && id) {
      const seen = new Set<string>();
      let cursor: string | null = parentId;
      while (cursor && !seen.has(cursor)) {
        if (cursor === id) throw new Error("Parent grup membentuk siklus");
        seen.add(cursor);
        const parent = itemRepo.get(cursor);
        cursor = parent && parent.type === "group" ? parent.parentId ?? null : null;
      }
    }
    const group = {
      id,
      type: "group",
      ownerUid: this.ownerUid(),
      updatedAt: now,
      version: (existing?.version ?? 0) + 1,
      deletedAt: null,
      parentId,
      vaultId: existing?.vaultId ?? VAULT.defaultVaultId,
      name: input.name,
      defaults: input.defaults ?? existing?.defaults ?? {}
    };
    itemRepo.upsert(group);
    return id;
  }
  removeGroup(id: string) {
    itemRepo.remove(id);
  }
}

export class IdentityService {
  vault: VaultCore;
  ownerUid: () => string;
  constructor(vault: VaultCore, ownerUid: () => string) {
    this.vault = vault;
    this.ownerUid = ownerUid;
  }
  toView(i: any) {
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
  save(input: any) {
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
      keyId: input.keyId !== undefined ? input.keyId : existing?.keyId ?? null
    };
    itemRepo.upsert(identity);
    return id;
  }
  remove(id: string) {
    itemRepo.remove(id);
  }
}
