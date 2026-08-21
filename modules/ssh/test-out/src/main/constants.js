"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = exports.SSH = exports.VAULT = exports.APP = void 0;
exports.isSynced = isSynced;
exports.APP = {
    name: "WANN-SSH",
    scheme: "wannssh",
    version: "0.1.0",
    /** SSH ident: muncul sebagai SSH-2.0-WANN-SSH_0.1.0 di auth.log server. */
    sshIdent: "WANN-SSH_0.1.0",
    term: "xterm-256color"
};
exports.VAULT = {
    /** Auto-lock idle default (Bab 7 & checklist Bab 18). */
    autoLockMs: 15 * 6e4,
    /** ID vault personal (= workspace Cloud, tersinkron). */
    personalVaultId: "personal",
    /** Vault default untuk item baru: Lokal (privasi-dulu). */
    defaultVaultId: "local",
    /** Hanya vault ini yang boleh di-push/pull ke remote (masuk outbox). */
    syncedVaultIds: ["personal"]
};
exports.SSH = {
    defaultPort: 22,
    readyTimeoutMs: 2e4,
    keepAliveIntervalSec: 30,
    keepAliveCountMax: 3,
    maxJumpHosts: 5,
    /** Batching output terminal (Bab 3 & 10): flush tiap frame / saat buffer besar. */
    flushIntervalMs: 16,
    flushChunkThreshold: 200
};
function isSynced(vaultId) {
    return exports.VAULT.syncedVaultIds.includes(vaultId);
}
const tsNow = () => new Date().toISOString();
exports.logger = {
    info: (...a) => console.log(`[${tsNow()}] [info]`, ...a),
    warn: (...a) => console.warn(`[${tsNow()}] [warn]`, ...a),
    error: (...a) => console.error(`[${tsNow()}] [error]`, ...a)
};
