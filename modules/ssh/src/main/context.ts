import { VAULT, logger } from "./constants.js";
import { metaStore, jsonStore, syncStore, settingsStore } from "./store.js";
import { VaultCore } from "./vault.js";
import { HostService, IdentityService } from "./hosts.js";
import { SshManager } from "./ssh.js";
import { KeyService } from "./keys.js";
import { RealtimeDbTransport } from "./firebase.js";
import { SyncEngine } from "./sync.js";
import { CH } from "./channels.js";
import { biometricAvailable, storeVaultKey, loadVaultKey } from "./keychain.js";
import { TransferManager } from "./transfer.js";
import { TunnelManager } from "./tunnels.js";
import { LocalSessionManager } from "./local.js";
import { SnippetService } from "./snippets.js";
import { RecordingManager } from "./recording.js";
import { DiagnosticsService } from "./diagnostics.js";

export class AppContext {
  vault: VaultCore;
  hosts: HostService;
  identities: IdentityService;
  ssh: SshManager;
  keys: KeyService;
  transfers: TransferManager;
  tunnels: TunnelManager;
  local: LocalSessionManager;
  snippets: SnippetService;
  recording: RecordingManager;
  diagnostics: DiagnosticsService;
  sync: SyncEngine;
  syncTransport: RealtimeDbTransport;
  sender: any = null;
  /** UID lokal-only sampai Firebase auth aktif. */
  uid = "local-user";

  constructor() {
    this.vault = new VaultCore(metaStore);
    this.vault.setAutoLockMs(settingsStore.get("autoLockMs", VAULT.autoLockMs));
    const uidFn = () => this.uid;
    const emit = (channel: string, payload: any) => this.emit(channel, payload);
    this.hosts = new HostService(this.vault, uidFn);
    this.identities = new IdentityService(this.vault, uidFn);
    this.ssh = new SshManager(this.vault, uidFn, emit);
    this.keys = new KeyService(this.vault, uidFn);
    this.transfers = new TransferManager(this.ssh, emit);
    this.tunnels = new TunnelManager(this.ssh, emit);
    this.local = new LocalSessionManager(emit);
    this.snippets = new SnippetService(uidFn);
    this.recording = new RecordingManager();
    this.diagnostics = new DiagnosticsService(this.ssh);
    this.syncTransport = new RealtimeDbTransport();
    this.sync = new SyncEngine(
      syncStore,
      this.syncTransport,
      (state, pending) => this.emit(CH.evt.syncState, { state, pending }),
      [VAULT.personalVaultId],
      () => this.emit(CH.evt.storeChanged, void 0),
      () => {
        if (this.vault.isUnlocked()) this.vault.lock();
      }
    );
    // Realtime: saat data cloud berubah di RTDB, tarik + reload UI otomatis.
    this.syncTransport.onRemoteChange = () => {
      void this.sync.syncNow();
    };
    // Ganti akun / logout: buang data cloud lokal akun lama lalu reload UI.
    this.syncTransport.onAccountSwitch = (preserveVaultMeta = false) => {
      this.vault.lock();
      const removed = jsonStore.clearSyncedItems(preserveVaultMeta);
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
      this.local.closeAll("vault-locked");
      this.recording.discardAll();
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
    if (channel === CH.evt.termOutput && payload?.sessionId && typeof payload.data === "string") {
      this.recording.captureOutput(payload.sessionId, payload.data);
    }
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
    key.fill(0);
    return true;
  }
  async authorizeSensitiveAction(input: { password?: string; biometric?: boolean }) {
    if (!this.vault.isUnlocked()) return false;
    if (input.biometric) {
      const key = await loadVaultKey();
      if (!key) return false;
      try {
        const active = this.vault.exportVaultKey();
        try {
          return key.length === active.length && (await import("node:crypto")).timingSafeEqual(key, active);
        } finally {
          active.fill(0);
        }
      } finally {
        key.fill(0);
      }
    }
    return typeof input.password === "string" && this.vault.verifyPassword(input.password);
  }
  vaultSettings() {
    return {
      autoLockMs: this.vault.autoLockMs,
      biometricAvailable: this.biometricAvailable()
    };
  }
  setAutoLockMs(value: number) {
    this.vault.setAutoLockMs(value);
    settingsStore.set("autoLockMs", value);
    return this.vaultSettings();
  }
}
