import * as node_crypto from "node:crypto";
import { VAULT } from "./constants.js";
import { itemRepo } from "./repo.js";
import type { VaultCore } from "./vault.js";

export function generateKey(alg: string, bits = 4096, passphrase?: string) {
  const priv: any = passphrase ? { type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase } : { type: "pkcs8", format: "pem" };
  const { publicKey, privateKey } = node_crypto.generateKeyPairSync(alg as any, {
    ...alg === "rsa" ? { modulusLength: bits } : {},
    ...alg === "ecdsa" ? { namedCurve: "prime256v1" } : {},
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: priv
  } as any);
  const fingerprintSha256 = "SHA256:" + node_crypto.createHash("sha256").update(publicKey).digest("base64").replace(/=+$/, "");
  return { publicKey, privateKey, fingerprintSha256 };
}

export function fpOf(pem: string) {
  return "SHA256:" + node_crypto.createHash("sha256").update(pem).digest("base64").replace(/=+$/, "");
}

export class KeyService {
  vault: VaultCore;
  ownerUid: () => string;
  constructor(vault: VaultCore, ownerUid: () => string) {
    this.vault = vault;
    this.ownerUid = ownerUid;
  }
  toView(k: any) {
    return {
      id: k.id,
      label: k.label,
      algorithm: k.algorithm,
      bits: k.bits,
      publicKey: k.publicKey,
      fingerprintSha256: k.fingerprintSha256,
      source: k.source
    };
  }
  list() {
    return itemRepo.listByTypeAll("sshkey").map((k) => this.toView(k));
  }
  persist(input: any) {
    const now = Date.now();
    const id = itemRepo.newId();
    const key = {
      id,
      type: "sshkey",
      ownerUid: this.ownerUid(),
      vaultId: VAULT.defaultVaultId,
      updatedAt: now,
      version: 1,
      deletedAt: null,
      label: input.label,
      algorithm: input.algorithm,
      bits: input.bits,
      publicKey: input.publicKey,
      privateKey: this.vault.encryptField(input.privateKeyPem, id, "privateKey"),
      passphrase: input.passphrase ? this.vault.encryptField(input.passphrase, id, "passphrase") : null,
      fingerprintSha256: input.fingerprintSha256,
      source: input.source
    };
    itemRepo.upsert(key);
    return id;
  }
  generate(o: any) {
    const gen = generateKey(o.algorithm, o.bits ?? 4096, o.passphrase);
    return this.persist({
      algorithm: o.algorithm,
      bits: o.algorithm === "rsa" ? o.bits ?? 4096 : null,
      label: o.label,
      publicKey: gen.publicKey,
      privateKeyPem: gen.privateKey,
      passphrase: o.passphrase,
      fingerprintSha256: gen.fingerprintSha256,
      source: "generated"
    });
  }
  /** Import PEM/OpenSSH private key. publicKey diturunkan bila memungkinkan. */
  importPem(o: any) {
    const { createPrivateKey, createPublicKey } = node_crypto;
    let publicKey = "";
    let algorithm = "ed25519";
    let bits: number | null = null;
    try {
      const priv = createPrivateKey({ key: o.pem, passphrase: o.passphrase });
      const pubPem = createPublicKey(priv).export({ type: "spki", format: "pem" }) as string;
      publicKey = pubPem;
      const t = priv.asymmetricKeyType;
      algorithm = t === "rsa" ? "rsa" : t === "ec" ? "ecdsa" : "ed25519";
      bits = priv.asymmetricKeyDetails?.modulusLength ?? null;
    } catch {
      publicKey = "";
    }
    return this.persist({
      algorithm,
      bits,
      label: o.label,
      publicKey,
      privateKeyPem: o.pem,
      passphrase: o.passphrase,
      fingerprintSha256: fpOf(o.pem),
      source: "imported"
    });
  }
  exportPublic(id: string) {
    const k = itemRepo.get(id);
    if (!k) throw new Error("Key tidak ditemukan");
    return k.publicKey || "(public key tidak tersedia untuk key ini)";
  }
  remove(id: string) {
    itemRepo.remove(id);
  }
}
