import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  KmsEnvelopeCipher,
  LocalEnvelopeCipher,
  type KmsDataKeyWrapper,
} from "../src/security/envelope.js";

class FakeKmsDataKeyWrapper implements KmsDataKeyWrapper {
  private readonly records = new Map<string, { context: string; dataKey: Buffer; keyVersion: string }>();
  private keyVersion = "projects/test/locations/global/keyRings/wan/cryptoKeys/providers/cryptoKeyVersions/1";

  rotate(): void {
    this.keyVersion = "projects/test/locations/global/keyRings/wan/cryptoKeys/providers/cryptoKeyVersions/2";
  }

  async wrapDataKey(dataKey: Buffer, context: string): Promise<{ wrappedKey: Buffer; keyVersion: string }> {
    const wrappedKey = randomBytes(48);
    this.records.set(wrappedKey.toString("base64"), {
      context,
      dataKey: Buffer.from(dataKey),
      keyVersion: this.keyVersion,
    });
    return { wrappedKey, keyVersion: this.keyVersion };
  }

  async unwrapDataKey(wrappedKey: Buffer, keyVersion: string, context: string): Promise<Buffer> {
    const record = this.records.get(wrappedKey.toString("base64"));
    if (!record || record.context !== context || record.keyVersion !== keyVersion) {
      throw new Error("KMS rejected the wrapped data key.");
    }
    return Buffer.from(record.dataKey);
  }
}

test("local envelope cipher round-trips with a unique per-record data key", async () => {
  const cipher = new LocalEnvelopeCipher(randomBytes(32));
  const plaintext = "provider-secret-probe-4831";
  const context = "workspace-a:credential-a";
  const first = await cipher.encrypt(plaintext, context);
  const second = await cipher.encrypt(plaintext, context);

  assert.equal(await cipher.decrypt(first, context), plaintext);
  assert.equal(await cipher.decrypt(second, context), plaintext);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.notEqual(first.wrappedKey, second.wrappedKey);
  assert.doesNotMatch(JSON.stringify(first), new RegExp(plaintext));
});

test("local envelope cipher rejects wrong tenant context and tampering", async () => {
  const cipher = new LocalEnvelopeCipher(randomBytes(32));
  const encrypted = await cipher.encrypt("secret", "workspace-a:credential-a");

  await assert.rejects(cipher.decrypt(encrypted, "workspace-b:credential-a"));
  await assert.rejects(cipher.decrypt({ ...encrypted, ciphertext: `${encrypted.ciphertext.slice(0, -2)}AA` }, "workspace-a:credential-a"));
});

test("KMS envelope cipher records key versions and decrypts across rotation", async () => {
  const keyWrapper = new FakeKmsDataKeyWrapper();
  const cipher = new KmsEnvelopeCipher(keyWrapper);
  const context = "workspace-a:credential-a";
  const first = await cipher.encrypt("provider-secret-one", context);
  keyWrapper.rotate();
  const second = await cipher.encrypt("provider-secret-two", context);

  assert.match(first.keyVersion, /cryptoKeyVersions\/1$/);
  assert.match(second.keyVersion, /cryptoKeyVersions\/2$/);
  assert.equal(first.wrappedKeyIv, "");
  assert.equal(first.wrappedKeyTag, "");
  assert.equal(await cipher.decrypt(first, context), "provider-secret-one");
  assert.equal(await cipher.decrypt(second, context), "provider-secret-two");
  await assert.rejects(cipher.decrypt(first, "workspace-b:credential-a"));
});