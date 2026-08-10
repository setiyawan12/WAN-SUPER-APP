import assert from "node:assert/strict";
import { test } from "node:test";
import {
  calculateCrc32c,
  GoogleCloudKmsDataKeyWrapper,
  type GoogleCloudKmsClient,
  type GoogleCloudKmsDecryptRequest,
  type GoogleCloudKmsEncryptRequest,
} from "../src/security/gcp-kms.js";

const CRYPTO_KEY = "projects/wan/locations/asia-southeast2/keyRings/router/cryptoKeys/provider-credentials";

class FakeGoogleCloudKmsClient implements GoogleCloudKmsClient {
  lastEncrypt?: GoogleCloudKmsEncryptRequest;
  lastDecrypt?: GoogleCloudKmsDecryptRequest;
  corruptEncryptChecksum = false;

  async encrypt(request: GoogleCloudKmsEncryptRequest): ReturnType<GoogleCloudKmsClient["encrypt"]> {
    this.lastEncrypt = request;
    const ciphertext = Buffer.from(request.plaintext).reverse();
    return [{
      name: `${request.name}/cryptoKeyVersions/7`,
      ciphertext,
      ciphertextCrc32c: { value: this.corruptEncryptChecksum ? 0 : calculateCrc32c(ciphertext) },
      verifiedPlaintextCrc32c: true,
      verifiedAdditionalAuthenticatedDataCrc32c: true,
    }];
  }

  async decrypt(request: GoogleCloudKmsDecryptRequest): ReturnType<GoogleCloudKmsClient["decrypt"]> {
    this.lastDecrypt = request;
    const plaintext = Buffer.from(request.ciphertext).reverse();
    return [{ plaintext, plaintextCrc32c: { value: calculateCrc32c(plaintext) } }];
  }
}

test("CRC32C matches the standard check value", () => {
  assert.equal(calculateCrc32c(Buffer.from("123456789")), 0xe3069283);
});

test("Google Cloud KMS wrapper binds data keys to context and records the primary key version", async () => {
  const client = new FakeGoogleCloudKmsClient();
  const wrapper = new GoogleCloudKmsDataKeyWrapper(client, CRYPTO_KEY);
  const dataKey = Buffer.alloc(32, 13);
  const context = "workspace-a:credential-a:mock";
  const wrapped = await wrapper.wrapDataKey(dataKey, context);

  assert.equal(wrapped.keyVersion, `${CRYPTO_KEY}/cryptoKeyVersions/7`);
  assert.equal(client.lastEncrypt?.name, CRYPTO_KEY);
  assert.deepEqual(client.lastEncrypt?.additionalAuthenticatedData, Buffer.from(context));
  assert.equal(client.lastEncrypt?.plaintextCrc32c.value, calculateCrc32c(dataKey));
  assert.deepEqual(await wrapper.unwrapDataKey(wrapped.wrappedKey, wrapped.keyVersion, context), dataKey);
  assert.deepEqual(client.lastDecrypt?.additionalAuthenticatedData, Buffer.from(context));
  await assert.rejects(
    wrapper.unwrapDataKey(wrapped.wrappedKey, "projects/other/locations/global/keyRings/x/cryptoKeys/y/cryptoKeyVersions/1", context),
    /configured CryptoKey/,
  );
});

test("Google Cloud KMS wrapper rejects a corrupted response checksum", async () => {
  const client = new FakeGoogleCloudKmsClient();
  client.corruptEncryptChecksum = true;
  const failures: Array<{ operation: string; error: unknown }> = [];
  const wrapper = new GoogleCloudKmsDataKeyWrapper(client, CRYPTO_KEY, {
    failed: (operation, error) => failures.push({ operation, error }),
  });

  await assert.rejects(wrapper.wrapDataKey(Buffer.alloc(32, 9), "workspace-a:credential-a:mock"), /CRC32C/);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].operation, "encrypt");
});