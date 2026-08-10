import { KeyManagementServiceClient } from "@google-cloud/kms";
import type { KmsDataKeyWrapper } from "./envelope.js";

interface KmsChecksum {
  value?: number | string | { toString(): string } | null;
}

export interface GoogleCloudKmsEncryptRequest {
  name: string;
  plaintext: Buffer;
  additionalAuthenticatedData: Buffer;
  plaintextCrc32c: { value: number };
  additionalAuthenticatedDataCrc32c: { value: number };
}

export interface GoogleCloudKmsDecryptRequest {
  name: string;
  ciphertext: Buffer;
  additionalAuthenticatedData: Buffer;
  ciphertextCrc32c: { value: number };
  additionalAuthenticatedDataCrc32c: { value: number };
}

export interface GoogleCloudKmsClient {
  encrypt(request: GoogleCloudKmsEncryptRequest): Promise<[{
    name?: string | null;
    ciphertext?: Uint8Array | Buffer | string | null;
    ciphertextCrc32c?: KmsChecksum | null;
    verifiedPlaintextCrc32c?: boolean | null;
    verifiedAdditionalAuthenticatedDataCrc32c?: boolean | null;
  }]>;
  decrypt(request: GoogleCloudKmsDecryptRequest): Promise<[{
    plaintext?: Uint8Array | Buffer | string | null;
    plaintextCrc32c?: KmsChecksum | null;
  }]>;
}

export interface KmsOperationObserver {
  failed(operation: "encrypt" | "decrypt", error: unknown): void;
}

const CRYPTO_KEY_PATTERN = /^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+$/;
const CRC32C_POLYNOMIAL = 0x82f63b78;

export function calculateCrc32c(bytes: Buffer): number {
  let checksum = 0xffff_ffff;
  for (const byte of bytes) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = (checksum >>> 1) ^ (-(checksum & 1) & CRC32C_POLYNOMIAL);
    }
  }
  return (checksum ^ 0xffff_ffff) >>> 0;
}

function responseBytes(value: Uint8Array | Buffer | string | null | undefined, field: string): Buffer {
  if (!value || typeof value === "string") throw new Error(`Cloud KMS returned an invalid ${field}.`);
  const bytes = Buffer.from(value);
  if (!bytes.length) throw new Error(`Cloud KMS returned an empty ${field}.`);
  return bytes;
}

function checksumValue(checksum: KmsChecksum | null | undefined): number {
  const raw = checksum?.value;
  const value = typeof raw === "number" ? raw : Number(raw?.toString());
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error("Cloud KMS returned an invalid CRC32C checksum.");
  }
  return value;
}

function verifyChecksum(bytes: Buffer, checksum: KmsChecksum | null | undefined, field: string): void {
  if (calculateCrc32c(bytes) !== checksumValue(checksum)) {
    throw new Error(`Cloud KMS ${field} failed CRC32C verification.`);
  }
}

function sdkClient(): GoogleCloudKmsClient {
  const client = new KeyManagementServiceClient();
  return {
    async encrypt(request) {
      const [response] = await client.encrypt(request);
      return [response];
    },
    async decrypt(request) {
      const [response] = await client.decrypt(request);
      return [response];
    },
  };
}

export class GoogleCloudKmsDataKeyWrapper implements KmsDataKeyWrapper {
  private readonly keyVersionPrefix: string;

  constructor(
    private readonly client: GoogleCloudKmsClient,
    private readonly cryptoKeyName: string,
    private readonly observer?: KmsOperationObserver,
  ) {
    if (!CRYPTO_KEY_PATTERN.test(cryptoKeyName)) {
      throw new Error("Cloud KMS key must be a fully-qualified CryptoKey resource name.");
    }
    this.keyVersionPrefix = `${cryptoKeyName}/cryptoKeyVersions/`;
  }

  async wrapDataKey(dataKey: Buffer, context: string): Promise<{ wrappedKey: Buffer; keyVersion: string }> {
    try {
      const aad = Buffer.from(context, "utf8");
      const [response] = await this.client.encrypt({
        name: this.cryptoKeyName,
        plaintext: dataKey,
        additionalAuthenticatedData: aad,
        plaintextCrc32c: { value: calculateCrc32c(dataKey) },
        additionalAuthenticatedDataCrc32c: { value: calculateCrc32c(aad) },
      });
      if (response.verifiedPlaintextCrc32c !== true || response.verifiedAdditionalAuthenticatedDataCrc32c !== true) {
        throw new Error("Cloud KMS did not verify the encryption request checksums.");
      }
      const keyVersion = response.name || "";
      if (!keyVersion.startsWith(this.keyVersionPrefix) || keyVersion.length === this.keyVersionPrefix.length) {
        throw new Error("Cloud KMS returned a key version outside the configured CryptoKey.");
      }
      const wrappedKey = responseBytes(response.ciphertext, "ciphertext");
      verifyChecksum(wrappedKey, response.ciphertextCrc32c, "ciphertext");
      return { wrappedKey, keyVersion };
    } catch (error) {
      this.observer?.failed("encrypt", error);
      throw error;
    }
  }

  async unwrapDataKey(wrappedKey: Buffer, keyVersion: string, context: string): Promise<Buffer> {
    try {
      if (!keyVersion.startsWith(this.keyVersionPrefix) || keyVersion.length === this.keyVersionPrefix.length) {
        throw new Error("Stored key version does not belong to the configured CryptoKey.");
      }
      const aad = Buffer.from(context, "utf8");
      const [response] = await this.client.decrypt({
        name: this.cryptoKeyName,
        ciphertext: wrappedKey,
        additionalAuthenticatedData: aad,
        ciphertextCrc32c: { value: calculateCrc32c(wrappedKey) },
        additionalAuthenticatedDataCrc32c: { value: calculateCrc32c(aad) },
      });
      const dataKey = responseBytes(response.plaintext, "plaintext");
      verifyChecksum(dataKey, response.plaintextCrc32c, "plaintext");
      return dataKey;
    } catch (error) {
      this.observer?.failed("decrypt", error);
      throw error;
    }
  }
}

export function createGoogleCloudKmsDataKeyWrapper(
  cryptoKeyName: string,
  observer?: KmsOperationObserver,
): GoogleCloudKmsDataKeyWrapper {
  return new GoogleCloudKmsDataKeyWrapper(sdkClient(), cryptoKeyName, observer);
}