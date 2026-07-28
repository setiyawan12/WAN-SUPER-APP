export class VaultError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = "VaultError";
  }
}

export class SshError extends Error {
  kind: string;
  constructor(kind: string, message?: string) {
    super(message ?? kind);
    this.kind = kind;
    this.name = "SshError";
  }
}

export function mapSshError(err: any) {
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
