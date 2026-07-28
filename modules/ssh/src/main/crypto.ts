import * as node_crypto from "node:crypto";
import * as argon2 from "argon2";

export const KDF_PARAMS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  // 64 MiB
  timeCost: 3,
  parallelism: 4,
  hashLength: 32
};

export const KDF_PARAMS_SERIALIZED = {
  m: KDF_PARAMS.memoryCost,
  t: KDF_PARAMS.timeCost,
  p: KDF_PARAMS.parallelism,
  hashLength: KDF_PARAMS.hashLength
};

export async function deriveMasterKey(password: string, salt: Buffer): Promise<Buffer> {
  return argon2.hash(password, { ...KDF_PARAMS, salt, raw: true } as any) as unknown as Buffer;
}

export function hkdf(key: Buffer, info: string, len = 32): Buffer {
  return Buffer.from(node_crypto.hkdfSync("sha256", key, Buffer.alloc(0), Buffer.from(info), len));
}

export function seal(plain: string | Buffer, key: Buffer, aad: string, kid: string) {
  const iv = node_crypto.randomBytes(12);
  const aadBuf = Buffer.from(aad, "utf8");
  const c = node_crypto.createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(aadBuf);
  const input = typeof plain === "string" ? Buffer.from(plain, "utf8") : plain;
  const ct = Buffer.concat([c.update(input), c.final()]);
  return {
    v: 1,
    alg: "A256GCM",
    iv: iv.toString("base64"),
    ct: ct.toString("base64"),
    tag: c.getAuthTag().toString("base64"),
    aad: aadBuf.toString("base64"),
    kid
  };
}

export function open(env: any, key: Buffer): Buffer {
  const d = node_crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(env.iv, "base64"));
  d.setAAD(Buffer.from(env.aad, "base64"));
  d.setAuthTag(Buffer.from(env.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(env.ct, "base64")), d.final()]);
}

export function wipe(...bufs: (Buffer | undefined | null)[]): void {
  for (const b of bufs) if (b) b.fill(0);
}

export function randomVaultKey(): Buffer {
  return node_crypto.randomBytes(32);
}

export const KEK_INFO = "vault-kek-v1";
export const CURRENT_KID = "k1";
