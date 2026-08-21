"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SshError = exports.VaultError = void 0;
exports.mapSshError = mapSshError;
class VaultError extends Error {
    code;
    constructor(code, message) {
        super(message ?? code);
        this.code = code;
        this.name = "VaultError";
    }
}
exports.VaultError = VaultError;
class SshError extends Error {
    kind;
    constructor(kind, message) {
        super(message ?? kind);
        this.kind = kind;
        this.name = "SshError";
    }
}
exports.SshError = SshError;
function mapSshError(err) {
    const raw = err instanceof Error ? err.message : String(err);
    const code = err?.code ?? "";
    if (code === "ECONNREFUSED" || /ECONNREFUSED/.test(raw))
        return { kind: "ECONNREFUSED", message: "Server menolak koneksi di port tersebut." };
    if (code === "ETIMEDOUT" || /ETIMEDOUT|timeout/i.test(raw))
        return { kind: "ETIMEDOUT", message: "Tidak ada respons dalam 20 detik — cek firewall atau VPN." };
    if (code === "ENOTFOUND" || /ENOTFOUND/.test(raw))
        return { kind: "ENOTFOUND", message: "Hostname tidak ditemukan." };
    if (/All configured authentication methods failed|authentication/i.test(raw))
        return { kind: "AUTH_FAILED", message: "Autentikasi gagal — periksa username, password, atau key." };
    return { kind: "UNKNOWN", message: raw };
}
