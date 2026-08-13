import * as node_crypto from "node:crypto";
import { VAULT } from "./constants.js";
import { VaultError } from "./errors.js";
import {
  deriveMasterKey,
  hkdf,
  seal,
  open,
  wipe,
  randomVaultKey,
  KDF_PARAMS_SERIALIZED,
  KEK_INFO,
  CURRENT_KID
} from "./crypto.js";

export class VaultCore {
  meta: any;
  vaultKey: Buffer | null = null;
  state: string = "locked";
  autoLockTimer: any;
  autoLockMs = VAULT.autoLockMs;
  /** Dipanggil VaultCore.lock() untuk menutup semua sesi aktif. */
  onBeforeLock?: () => void;
  onLock?: () => void;

  constructor(meta: any) {
    this.meta = meta;
  }

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
  async create(password: string) {
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
      schemaVersion: 1,
      version: 1,
      updatedAt: Date.now()
    });
    this.vaultKey = vaultKey;
    this.state = "unlocked";
    this.resetAutoLock();
  }
  async unlock(password: string) {
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
  async verifyPassword(password: string) {
    const meta = this.meta.load(this.vaultId);
    if (!meta || !this.vaultKey) throw new VaultError("LOCKED");
    const mk = await deriveMasterKey(password, Buffer.from(meta.kdfSalt, "base64"));
    const kek = hkdf(mk, KEK_INFO);
    let candidate: Buffer | null = null;
    try {
      candidate = open(meta.wrappedVaultKey, kek);
      return candidate.length === this.vaultKey.length && node_crypto.timingSafeEqual(candidate, this.vaultKey);
    } catch {
      return false;
    } finally {
      wipe(mk, kek, candidate);
    }
  }
  /** Unlock langsung dengan Vault Key dari OS keychain (biometrik). */
  unlockWithVaultKey(vaultKey: Buffer) {
    if (!this.meta.load(this.vaultId)) throw new VaultError("NO_VAULT");
    this.vaultKey = Buffer.from(vaultKey);
    this.state = "unlocked";
    this.resetAutoLock();
  }
  lock() {
    this.onBeforeLock?.();
    wipe(this.vaultKey);
    this.vaultKey = null;
    this.state = "locked";
    clearTimeout(this.autoLockTimer);
    this.onLock?.();
  }
  /** Ganti master password: bungkus ulang Vault Key saja (O(1), Bab 7.5). */
  async changePassword(oldPw: string, newPw: string) {
    await this.unlock(oldPw);
    if (!this.vaultKey) throw new VaultError("LOCKED");
    const salt = node_crypto.randomBytes(16);
    const mk = await deriveMasterKey(newPw, salt);
    const kek = hkdf(mk, KEK_INFO);
    const wrapped = seal(this.vaultKey, kek, `wrap|${this.vaultId}`, CURRENT_KID);
    wipe(mk, kek);
    const meta = this.meta.load(this.vaultId);
    this.meta.save({
      ...meta,
      wrappedVaultKey: wrapped,
      kdfSalt: salt.toString("base64"),
      version: (meta.version ?? 1) + 1,
      updatedAt: Date.now()
    });
  }
  /** Export Vault Key untuk disimpan di OS keychain. Hati-hati memakainya. */
  exportVaultKey() {
    if (!this.vaultKey) throw new VaultError("LOCKED");
    return Buffer.from(this.vaultKey);
  }
  encryptField(plain: string | Buffer, itemId: string, field: string) {
    if (!this.vaultKey) throw new VaultError("LOCKED");
    this.resetAutoLock();
    return seal(
      plain,
      hkdf(this.vaultKey, `item:${itemId}`),
      `${this.vaultId}|${itemId}|${field}`,
      CURRENT_KID
    );
  }
  decryptField(env: any, itemId: string) {
    if (!this.vaultKey) throw new VaultError("LOCKED");
    this.resetAutoLock();
    try {
      return open(env, hkdf(this.vaultKey, `item:${itemId}`));
    } catch {
      // GCM gagal autentikasi → secret ini disegel dengan Vault Key LAIN
      // (mis. instalasi lama / perangkat lain; Vault Key belum tersinkron).
      // Jangan biarkan error crypto mentah menjatuhkan handler IPC.
      throw new VaultError("UNDECRYPTABLE");
    }
  }
  decryptString(env: any, itemId: string) {
    return this.decryptField(env, itemId).toString("utf8");
  }
  assertCanDecryptItems(items: any[]) {
    if (!this.vaultKey) throw new VaultError("LOCKED", "Buka vault sebelum melakukan re-upload.");
    for (const item of items) {
      const encryptedFields = item.type === "identity"
        ? [item.secret]
        : item.type === "sshkey"
          ? [item.privateKey, item.passphrase]
          : [];
      for (const encrypted of encryptedFields) {
        if (!encrypted) continue;
        const plain = this.decryptField(encrypted, item.id);
        wipe(plain);
      }
    }
  }
  touch() {
    if (this.isUnlocked()) this.resetAutoLock();
  }
  setAutoLockMs(value: number) {
    this.autoLockMs = value;
    if (this.isUnlocked()) this.resetAutoLock();
  }
  resetAutoLock() {
    clearTimeout(this.autoLockTimer);
    this.autoLockTimer = setTimeout(() => this.lock(), this.autoLockMs);
  }
}
