import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface EncryptedPayload {
  ciphertext: string;
  ciphertextIv: string;
  ciphertextTag: string;
  wrappedKey: string;
  wrappedKeyIv: string;
  wrappedKeyTag: string;
  keyVersion: string;
}

export interface EnvelopeCipher {
  encrypt(plaintext: string, context: string): Promise<EncryptedPayload>;
  decrypt(payload: EncryptedPayload, context: string): Promise<string>;
}

export interface KmsDataKeyWrapper {
  wrapDataKey(dataKey: Buffer, context: string): Promise<{
    wrappedKey: Buffer;
    keyVersion: string;
  }>;
  unwrapDataKey(wrappedKey: Buffer, keyVersion: string, context: string): Promise<Buffer>;
}

function encryptAesGcm(key: Buffer, plaintext: Buffer, aad: Buffer): {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
} {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

function decryptAesGcm(
  key: Buffer,
  ciphertext: Buffer,
  iv: Buffer,
  tag: Buffer,
  aad: Buffer,
): Buffer {
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export class KmsEnvelopeCipher implements EnvelopeCipher {
  constructor(private readonly keyWrapper: KmsDataKeyWrapper) {}

  async encrypt(plaintext: string, context: string): Promise<EncryptedPayload> {
    const dataKey = randomBytes(32);
    try {
      const encrypted = encryptAesGcm(dataKey, Buffer.from(plaintext, "utf8"), Buffer.from(context, "utf8"));
      const wrapped = await this.keyWrapper.wrapDataKey(dataKey, context);
      if (!wrapped.keyVersion) throw new Error("KMS did not return the wrapping key version.");
      return {
        ciphertext: encrypted.ciphertext.toString("base64"),
        ciphertextIv: encrypted.iv.toString("base64"),
        ciphertextTag: encrypted.tag.toString("base64"),
        wrappedKey: wrapped.wrappedKey.toString("base64"),
        wrappedKeyIv: "",
        wrappedKeyTag: "",
        keyVersion: wrapped.keyVersion,
      };
    } finally {
      dataKey.fill(0);
    }
  }

  async decrypt(payload: EncryptedPayload, context: string): Promise<string> {
    if (payload.wrappedKeyIv || payload.wrappedKeyTag) {
      throw new Error("KMS envelope payload contains unsupported local wrapping metadata.");
    }
    const dataKey = await this.keyWrapper.unwrapDataKey(
      Buffer.from(payload.wrappedKey, "base64"),
      payload.keyVersion,
      context,
    );
    if (dataKey.length !== 32) {
      dataKey.fill(0);
      throw new Error("KMS unwrapped an invalid data key.");
    }
    try {
      return decryptAesGcm(
        dataKey,
        Buffer.from(payload.ciphertext, "base64"),
        Buffer.from(payload.ciphertextIv, "base64"),
        Buffer.from(payload.ciphertextTag, "base64"),
        Buffer.from(context, "utf8"),
      ).toString("utf8");
    } finally {
      dataKey.fill(0);
    }
  }
}

export class LocalEnvelopeCipher implements EnvelopeCipher {
  constructor(
    private readonly masterKey: Buffer,
    private readonly keyVersion = "local-v1",
  ) {
    if (masterKey.length !== 32) throw new Error("Local envelope master key must decode to exactly 32 bytes.");
  }

  async encrypt(plaintext: string, context: string): Promise<EncryptedPayload> {
    const dataKey = randomBytes(32);
    const aad = Buffer.from(context, "utf8");
    try {
      const encrypted = encryptAesGcm(dataKey, Buffer.from(plaintext, "utf8"), aad);
      const wrapped = encryptAesGcm(this.masterKey, dataKey, Buffer.from(`${context}:${this.keyVersion}`, "utf8"));
      return {
        ciphertext: encrypted.ciphertext.toString("base64"),
        ciphertextIv: encrypted.iv.toString("base64"),
        ciphertextTag: encrypted.tag.toString("base64"),
        wrappedKey: wrapped.ciphertext.toString("base64"),
        wrappedKeyIv: wrapped.iv.toString("base64"),
        wrappedKeyTag: wrapped.tag.toString("base64"),
        keyVersion: this.keyVersion,
      };
    } finally {
      dataKey.fill(0);
    }
  }

  async decrypt(payload: EncryptedPayload, context: string): Promise<string> {
    if (payload.keyVersion !== this.keyVersion) {
      throw new Error(`Unsupported local envelope key version: ${payload.keyVersion}`);
    }
    const dataKey = decryptAesGcm(
      this.masterKey,
      Buffer.from(payload.wrappedKey, "base64"),
      Buffer.from(payload.wrappedKeyIv, "base64"),
      Buffer.from(payload.wrappedKeyTag, "base64"),
      Buffer.from(`${context}:${payload.keyVersion}`, "utf8"),
    );
    try {
      return decryptAesGcm(
        dataKey,
        Buffer.from(payload.ciphertext, "base64"),
        Buffer.from(payload.ciphertextIv, "base64"),
        Buffer.from(payload.ciphertextTag, "base64"),
        Buffer.from(context, "utf8"),
      ).toString("utf8");
    } finally {
      dataKey.fill(0);
    }
  }
}

export function localEnvelopeCipherFromBase64(encodedKey: string): LocalEnvelopeCipher {
  return new LocalEnvelopeCipher(Buffer.from(encodedKey, "base64"));
}