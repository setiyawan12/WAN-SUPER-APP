import * as node_fs from "node:fs";
import * as path from "node:path";
import { app, safeStorage } from "electron";

export function keychainPath() {
  return path.join(app.getPath("userData"), "vaultkey.bin");
}

export function biometricAvailable() {
  return safeStorage.isEncryptionAvailable();
}

export async function storeVaultKey(vaultKey: Buffer) {
  if (!biometricAvailable()) throw new Error("BIOMETRIC_UNAVAILABLE");
  const blob = safeStorage.encryptString(vaultKey.toString("base64"));
  await node_fs.promises.writeFile(keychainPath(), blob, { mode: 0o600 });
  try {
    await node_fs.promises.chmod(keychainPath(), 0o600);
  } catch {
  }
}

export async function loadVaultKey(): Promise<Buffer | null> {
  try {
    const blob = await node_fs.promises.readFile(keychainPath());
    const b64 = safeStorage.decryptString(blob);
    return Buffer.from(b64, "base64");
  } catch {
    return null;
  }
}
