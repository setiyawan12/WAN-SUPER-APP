"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.VaultCore = void 0;
const node_crypto = __importStar(require("node:crypto"));
const constants_js_1 = require("./constants.js");
const errors_js_1 = require("./errors.js");
const crypto_js_1 = require("./crypto.js");
class VaultCore {
    meta;
    vaultKey = null;
    state = "locked";
    autoLockTimer;
    autoLockMs = constants_js_1.VAULT.autoLockMs;
    /** Dipanggil VaultCore.lock() untuk menutup semua sesi aktif. */
    onBeforeLock;
    onLock;
    constructor(meta) {
        this.meta = meta;
    }
    get vaultId() {
        return constants_js_1.VAULT.personalVaultId;
    }
    status() {
        if (this.state === "unlocked")
            return "unlocked";
        return this.meta.load(this.vaultId) ? "locked" : "no-vault";
    }
    isUnlocked() {
        return this.state === "unlocked" && this.vaultKey !== null;
    }
    /** Buat vault baru dari master password. */
    async create(password) {
        if (this.meta.load(this.vaultId))
            throw new errors_js_1.VaultError("ALREADY_EXISTS");
        const salt = node_crypto.randomBytes(16);
        const mk = await (0, crypto_js_1.deriveMasterKey)(password, salt);
        const kek = (0, crypto_js_1.hkdf)(mk, crypto_js_1.KEK_INFO);
        const vaultKey = (0, crypto_js_1.randomVaultKey)();
        const wrapped = (0, crypto_js_1.seal)(vaultKey, kek, `wrap|${this.vaultId}`, crypto_js_1.CURRENT_KID);
        (0, crypto_js_1.wipe)(mk, kek);
        this.meta.save({
            vaultId: this.vaultId,
            wrappedVaultKey: wrapped,
            kdfSalt: salt.toString("base64"),
            kdfParams: crypto_js_1.KDF_PARAMS_SERIALIZED,
            keyRing: [crypto_js_1.CURRENT_KID],
            schemaVersion: 1,
            version: 1,
            updatedAt: Date.now()
        });
        this.vaultKey = vaultKey;
        this.state = "unlocked";
        this.resetAutoLock();
    }
    async unlock(password) {
        const meta = this.meta.load(this.vaultId);
        if (!meta)
            throw new errors_js_1.VaultError("NO_VAULT");
        const mk = await (0, crypto_js_1.deriveMasterKey)(password, Buffer.from(meta.kdfSalt, "base64"));
        const kek = (0, crypto_js_1.hkdf)(mk, crypto_js_1.KEK_INFO);
        try {
            this.vaultKey = (0, crypto_js_1.open)(meta.wrappedVaultKey, kek);
        }
        catch {
            (0, crypto_js_1.wipe)(mk, kek);
            throw new errors_js_1.VaultError("WRONG_PASSWORD");
        }
        (0, crypto_js_1.wipe)(mk, kek);
        this.state = "unlocked";
        this.resetAutoLock();
    }
    async verifyPassword(password) {
        const meta = this.meta.load(this.vaultId);
        if (!meta || !this.vaultKey)
            throw new errors_js_1.VaultError("LOCKED");
        const mk = await (0, crypto_js_1.deriveMasterKey)(password, Buffer.from(meta.kdfSalt, "base64"));
        const kek = (0, crypto_js_1.hkdf)(mk, crypto_js_1.KEK_INFO);
        let candidate = null;
        try {
            candidate = (0, crypto_js_1.open)(meta.wrappedVaultKey, kek);
            return candidate.length === this.vaultKey.length && node_crypto.timingSafeEqual(candidate, this.vaultKey);
        }
        catch {
            return false;
        }
        finally {
            (0, crypto_js_1.wipe)(mk, kek, candidate);
        }
    }
    /** Unlock langsung dengan Vault Key dari OS keychain (biometrik). */
    unlockWithVaultKey(vaultKey) {
        if (!this.meta.load(this.vaultId))
            throw new errors_js_1.VaultError("NO_VAULT");
        this.vaultKey = Buffer.from(vaultKey);
        this.state = "unlocked";
        this.resetAutoLock();
    }
    lock() {
        this.onBeforeLock?.();
        (0, crypto_js_1.wipe)(this.vaultKey);
        this.vaultKey = null;
        this.state = "locked";
        clearTimeout(this.autoLockTimer);
        this.onLock?.();
    }
    /** Ganti master password: bungkus ulang Vault Key saja (O(1), Bab 7.5). */
    async changePassword(oldPw, newPw) {
        await this.unlock(oldPw);
        if (!this.vaultKey)
            throw new errors_js_1.VaultError("LOCKED");
        const salt = node_crypto.randomBytes(16);
        const mk = await (0, crypto_js_1.deriveMasterKey)(newPw, salt);
        const kek = (0, crypto_js_1.hkdf)(mk, crypto_js_1.KEK_INFO);
        const wrapped = (0, crypto_js_1.seal)(this.vaultKey, kek, `wrap|${this.vaultId}`, crypto_js_1.CURRENT_KID);
        (0, crypto_js_1.wipe)(mk, kek);
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
        if (!this.vaultKey)
            throw new errors_js_1.VaultError("LOCKED");
        return Buffer.from(this.vaultKey);
    }
    encryptField(plain, itemId, field) {
        if (!this.vaultKey)
            throw new errors_js_1.VaultError("LOCKED");
        this.resetAutoLock();
        return (0, crypto_js_1.seal)(plain, (0, crypto_js_1.hkdf)(this.vaultKey, `item:${itemId}`), `${this.vaultId}|${itemId}|${field}`, crypto_js_1.CURRENT_KID);
    }
    decryptField(env, itemId) {
        if (!this.vaultKey)
            throw new errors_js_1.VaultError("LOCKED");
        this.resetAutoLock();
        try {
            return (0, crypto_js_1.open)(env, (0, crypto_js_1.hkdf)(this.vaultKey, `item:${itemId}`));
        }
        catch {
            // GCM gagal autentikasi → secret ini disegel dengan Vault Key LAIN
            // (mis. instalasi lama / perangkat lain; Vault Key belum tersinkron).
            // Jangan biarkan error crypto mentah menjatuhkan handler IPC.
            throw new errors_js_1.VaultError("UNDECRYPTABLE");
        }
    }
    decryptString(env, itemId) {
        return this.decryptField(env, itemId).toString("utf8");
    }
    assertCanDecryptItems(items) {
        if (!this.vaultKey)
            throw new errors_js_1.VaultError("LOCKED", "Buka vault sebelum melakukan re-upload.");
        for (const item of items) {
            const encryptedFields = item.type === "identity"
                ? [item.secret]
                : item.type === "sshkey"
                    ? [item.privateKey, item.passphrase]
                    : [];
            for (const encrypted of encryptedFields) {
                if (!encrypted)
                    continue;
                const plain = this.decryptField(encrypted, item.id);
                (0, crypto_js_1.wipe)(plain);
            }
        }
    }
    touch() {
        if (this.isUnlocked())
            this.resetAutoLock();
    }
    setAutoLockMs(value) {
        this.autoLockMs = value;
        if (this.isUnlocked())
            this.resetAutoLock();
    }
    resetAutoLock() {
        clearTimeout(this.autoLockTimer);
        this.autoLockTimer = setTimeout(() => this.lock(), this.autoLockMs);
    }
}
exports.VaultCore = VaultCore;
