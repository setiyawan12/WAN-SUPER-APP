import * as node_crypto from "node:crypto";
import * as ssh2 from "ssh2";
import { VAULT } from "./constants.js";
import { itemRepo } from "./repo.js";
import type { VaultCore } from "./vault.js";

export function toOpenSshPublicKey(key: string, passphrase?: string) {
  const parsed = (ssh2 as any).utils.parseKey(key, passphrase);
  if (!(parsed instanceof Error)) {
    const publicBlob = parsed.getPublicSSH();
    return {
      publicKey: `${parsed.type} ${publicBlob.toString("base64")}`,
      fingerprintSha256: "SHA256:" + node_crypto.createHash("sha256").update(publicBlob).digest("base64").replace(/=+$/, "")
    };
  }
  const keyObject = key.includes("PRIVATE KEY")
    ? node_crypto.createPublicKey(node_crypto.createPrivateKey({ key, passphrase }))
    : node_crypto.createPublicKey(key);
  if (keyObject.asymmetricKeyType !== "ed25519") throw parsed;
  const jwk = keyObject.export({ format: "jwk" });
  if (!jwk.x) throw parsed;
  const algorithm = Buffer.from("ssh-ed25519");
  const publicBytes = Buffer.from(jwk.x, "base64url");
  const publicBlob = Buffer.concat([sshString(algorithm), sshString(publicBytes)]);
  return {
    publicKey: `ssh-ed25519 ${publicBlob.toString("base64")}`,
    fingerprintSha256: "SHA256:" + node_crypto.createHash("sha256").update(publicBlob).digest("base64").replace(/=+$/, "")
  };
}

function sshString(value: Buffer) {
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(value.length);
  return Buffer.concat([length, value]);
}

export function generateKey(alg: string, bits = 4096, passphrase?: string) {
  const nodeAlgorithm = alg === "ecdsa" ? "ec" : alg;
  const privateKeyType = alg === "ecdsa" ? "sec1" : "pkcs8";
  const priv: any = passphrase
    ? { type: privateKeyType, format: "pem", cipher: "aes-256-cbc", passphrase }
    : { type: privateKeyType, format: "pem" };
  const { privateKey } = node_crypto.generateKeyPairSync(nodeAlgorithm as any, {
    ...alg === "rsa" ? { modulusLength: bits } : {},
    ...alg === "ecdsa" ? { namedCurve: "prime256v1" } : {},
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: priv
  } as any);
  const publicInfo = toOpenSshPublicKey(privateKey, passphrase);
  return { ...publicInfo, privateKey };
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
      publicKey = toOpenSshPublicKey(pubPem).publicKey;
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
      fingerprintSha256: publicKey ? toOpenSshPublicKey(o.pem, o.passphrase).fingerprintSha256 : "",
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
