export function remoteWins(local: any, remote: any) {
  if (!local) return true;
  if (remote.version !== local.version) return remote.version > local.version;
  return remote.updatedAt > local.updatedAt;
}

export class SyncEngine {
  store: any;
  transport: any;
  emit: (state: string, pending: number) => void;
  vaults: string[];
  emitStoreChanged: () => void;
  onVaultMetaChanged: () => void;
  running = false;

  constructor(
    store: any,
    transport: any,
    emit: any,
    vaults: string[],
    emitStoreChanged?: () => void,
    onVaultMetaChanged?: () => void
  ) {
    this.store = store;
    this.transport = transport;
    this.emit = emit;
    this.vaults = vaults;
    // Diberi tahu renderer untuk reload list saat data cloud berubah.
    this.emitStoreChanged = emitStoreChanged ?? (() => {});
    this.onVaultMetaChanged = onVaultMetaChanged ?? (() => {});
  }
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
  async syncNow(options: { forceLocal?: boolean; preferRemoteMeta?: boolean } = {}) {
    if (this.running) return { ok: false, pushed: 0, pulled: 0, reason: "busy" };
    if (!this.transport.isConfigured() || !this.transport.currentUser()) {
      this.emit("offline", this.pendingCount());
      return { ok: false, pushed: 0, pulled: 0, reason: "not-configured" };
    }
    this.running = true;
    this.emit("syncing", this.pendingCount());
    try {
      await this.syncVaultMeta(options.forceLocal === true, options.preferRemoteMeta === true);
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
  async syncVaultMeta(forceLocal = false, preferRemote = false) {
    for (const vaultId of this.vaults) {
      const local = this.store.loadVaultMeta(vaultId);
      if (forceLocal && local) {
        await this.transport.pushVaultMeta(vaultId, local);
        continue;
      }
      const remote = await this.transport.pullVaultMeta(vaultId);
      if (!local && remote) {
        this.store.saveRemoteVaultMeta(remote);
        this.onVaultMetaChanged();
        continue;
      }
      if (local && !remote) {
        await this.transport.pushVaultMeta(vaultId, local);
        continue;
      }
      if (!local || !remote) continue;
      if (JSON.stringify(local) === JSON.stringify(remote)) continue;
      if (preferRemote) {
        this.store.saveRemoteVaultMeta(remote);
        this.onVaultMetaChanged();
        continue;
      }
      const localVersion = local.version ?? 1;
      const remoteVersion = remote.version ?? 1;
      if (localVersion > remoteVersion) {
        await this.transport.pushVaultMeta(vaultId, local);
      } else if (remoteVersion > localVersion) {
        this.store.saveRemoteVaultMeta(remote);
        this.onVaultMetaChanged();
      } else {
        throw new Error(`VAULT_META_CONFLICT:${vaultId}`);
      }
    }
  }
  async pushPhase() {
    const pending = this.store.outboxPending();
    if (pending.length === 0) return 0;
    const byVault = new Map<string, any[]>();
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
    // Beri tahu renderer agar reload list host/identitas bila ada perubahan.
    if (pulled > 0) this.emitStoreChanged();
    return pulled;
  }
}
