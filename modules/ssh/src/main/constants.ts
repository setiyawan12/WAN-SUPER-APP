export const APP = {
  name: "WANN-SSH",
  scheme: "wannssh",
  version: "0.1.0",
  /** SSH ident: muncul sebagai SSH-2.0-WANN-SSH_0.1.0 di auth.log server. */
  sshIdent: "WANN-SSH_0.1.0",
  term: "xterm-256color"
};

export const VAULT = {
  /** Auto-lock idle default (Bab 7 & checklist Bab 18). */
  autoLockMs: 15 * 6e4,
  /** ID vault personal (= workspace Cloud, tersinkron). */
  personalVaultId: "personal",
  /** Vault default untuk item baru: Lokal (privasi-dulu). */
  defaultVaultId: "local",
  /** Hanya vault ini yang boleh di-push/pull ke remote (masuk outbox). */
  syncedVaultIds: ["personal"] as string[]
};

export const SSH = {
  defaultPort: 22,
  readyTimeoutMs: 2e4,
  keepAliveIntervalSec: 30,
  keepAliveCountMax: 3,
  maxJumpHosts: 5,
  /** Batching output terminal (Bab 3 & 10): flush tiap frame / saat buffer besar. */
  flushIntervalMs: 16,
  flushChunkThreshold: 200
};

export function isSynced(vaultId: string): boolean {
  return VAULT.syncedVaultIds.includes(vaultId);
}

const tsNow = () => new Date().toISOString();
export const logger = {
  info: (...a: unknown[]) => console.log(`[${tsNow()}] [info]`, ...a),
  warn: (...a: unknown[]) => console.warn(`[${tsNow()}] [warn]`, ...a),
  error: (...a: unknown[]) => console.error(`[${tsNow()}] [error]`, ...a)
};
