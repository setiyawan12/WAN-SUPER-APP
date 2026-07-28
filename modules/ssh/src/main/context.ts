import { VAULT, logger } from "./constants.js";
import { metaStore, jsonStore } from "./store.js";
import { VaultCore } from "./vault.js";
import { HostService, IdentityService } from "./hosts.js";
import { SshManager } from "./ssh.js";
import { KeyService } from "./keys.js";
import { RealtimeDbTransport } from "./firebase.js";
import { SyncEngine } from "./sync.js";
import { CH } from "./channels.js";
import { biometricAvailable, storeVaultKey, loadVaultKey } from "./keychain.js";

export class AppContext {
  vault: VaultCore;
  hosts: HostService;
  identities: IdentityService;
  ssh: SshManager;
  keys: KeyService;
  sync: SyncEngine;
  syncTransport: RealtimeDbTransport;
  sender: any = null;
  /** UID lokal-only sampai Firebase auth aktif. */
  uid = "local-user";

  constructor() {
    this.vault = new VaultCore(metaStore);
    const uidFn = () => this.uid;
    const emit = (channel: string, payload: any) => this.emit(channel, payload);
    this.hosts = new HostService(this.vault, uidFn);
    this.identities = new IdentityService(this.vault, uidFn);
    this.ssh = new SshManager(this.vault, uidFn, emit);
    this.keys = new KeyService(this.vault, uidFn);
    this.syncTransport = new RealtimeDbTransport();
    this.sync = new SyncEngine(
      jsonStore,
      this.syncTransport,
      (state, pending) => this.emit(CH.evt.syncState, { state, pending }),
      [VAULT.personalVaultId],
      () => this.emit(CH.evt.storeChanged, void 0)
    );
    // Realtime: saat data cloud berubah di RTDB, tarik + reload UI otomatis.
    this.syncTransport.onRemoteChange = () => {
      void this.sync.syncNow();
    };
    // Ganti akun / logout: buang data cloud lokal akun lama lalu reload UI.
    this.syncTransport.onAccountSwitch = () => {
      const removed = jsonStore.clearSyncedItems();
      logger.info("Ganti akun: buang", removed, "item cloud lokal");
      this.emit(CH.evt.storeChanged, void 0);
    };
    // Tiap sign-in sukses: reset cursor synced vault → paksa FULL pull dari RTDB
    // (menjamin list host terisi walau login akun sama setelah logout).
    this.syncTransport.onFreshLogin = () => {
      jsonStore.resetSyncedCursors();
      logger.info("Fresh login: cursor synced vault direset (full pull)");
    };
    this.vault.onLock = () => {
      this.ssh.closeAll("vault-locked");
      this.emit(CH.evt.vaultLocked, void 0);
    };
    // Pulihkan sesi cloud (bila ada) agar tidak sign-in ulang tiap buka app.
    if (this.syncTransport.isConfigured()) {
      void this.syncTransport.restoreSession().then((uid) => {
        if (uid) {
          logger.info("Sesi Firebase dipulihkan:", uid);
          void this.sync.syncNow();
        }
      });
    }
  }
  setSender(wc: any) {
    this.sender = wc;
  }
  emit(channel: string, payload: any) {
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
