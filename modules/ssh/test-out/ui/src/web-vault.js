"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebVault = void 0;
const hash_wasm_1 = require("hash-wasm");
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const KEK_INFO = "vault-kek-v1";
const CURRENT_KID = "k1";
function bytesToBase64(value) {
    let binary = "";
    for (let offset = 0; offset < value.length; offset += 0x8000) {
        binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
}
function base64ToBytes(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1)
        bytes[index] = binary.charCodeAt(index);
    return bytes;
}
function concatBytes(...values) {
    const output = new Uint8Array(values.reduce((total, value) => total + value.length, 0));
    let offset = 0;
    for (const value of values) {
        output.set(value, offset);
        offset += value.length;
    }
    return output;
}
function arrayBuffer(value) {
    const copy = new Uint8Array(value.byteLength);
    copy.set(value);
    return copy.buffer;
}
async function deriveMasterKey(password, meta) {
    return (0, hash_wasm_1.argon2id)({
        password,
        salt: base64ToBytes(meta.kdfSalt),
        iterations: meta.kdfParams.t,
        parallelism: meta.kdfParams.p,
        memorySize: meta.kdfParams.m,
        hashLength: meta.kdfParams.hashLength,
        outputType: "binary"
    });
}
async function hkdf(key, info, length = 32) {
    const material = await crypto.subtle.importKey("raw", arrayBuffer(key), "HKDF", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new ArrayBuffer(0), info: arrayBuffer(encoder.encode(info)) }, material, length * 8);
    return new Uint8Array(bits);
}
async function openEnvelope(envelope, key) {
    if (envelope.v !== 1 || envelope.alg !== "A256GCM")
        throw new Error("Unsupported vault envelope");
    const cryptoKey = await crypto.subtle.importKey("raw", arrayBuffer(key), "AES-GCM", false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({
        name: "AES-GCM",
        iv: arrayBuffer(base64ToBytes(envelope.iv)),
        additionalData: arrayBuffer(base64ToBytes(envelope.aad)),
        tagLength: 128
    }, cryptoKey, arrayBuffer(concatBytes(base64ToBytes(envelope.ct), base64ToBytes(envelope.tag))));
    return new Uint8Array(plain);
}
async function sealEnvelope(plain, key, aad) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aadBytes = encoder.encode(aad);
    const cryptoKey = await crypto.subtle.importKey("raw", arrayBuffer(key), "AES-GCM", false, ["encrypt"]);
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: arrayBuffer(iv), additionalData: arrayBuffer(aadBytes), tagLength: 128 }, cryptoKey, arrayBuffer(plain)));
    const tagOffset = sealed.length - 16;
    return {
        v: 1,
        alg: "A256GCM",
        iv: bytesToBase64(iv),
        ct: bytesToBase64(sealed.subarray(0, tagOffset)),
        tag: bytesToBase64(sealed.subarray(tagOffset)),
        aad: bytesToBase64(aadBytes),
        kid: CURRENT_KID
    };
}
class WebVault {
    vaultKey;
    get unlocked() {
        return Boolean(this.vaultKey);
    }
    async unlock(password, meta) {
        const masterKey = await deriveMasterKey(password, meta);
        const kek = await hkdf(masterKey, KEK_INFO);
        try {
            this.vaultKey = await openEnvelope(meta.wrappedVaultKey, kek);
        }
        catch {
            throw new Error("Master password is incorrect or this cloud vault cannot be unlocked.");
        }
        finally {
            masterKey.fill(0);
            kek.fill(0);
        }
    }
    async verifyPassword(password, meta) {
        if (!this.vaultKey)
            return false;
        const masterKey = await deriveMasterKey(password, meta);
        const kek = await hkdf(masterKey, KEK_INFO);
        let candidate;
        try {
            candidate = await openEnvelope(meta.wrappedVaultKey, kek);
            if (candidate.length !== this.vaultKey.length)
                return false;
            let difference = 0;
            for (let index = 0; index < candidate.length; index += 1)
                difference |= candidate[index] ^ this.vaultKey[index];
            return difference === 0;
        }
        catch {
            return false;
        }
        finally {
            masterKey.fill(0);
            kek.fill(0);
            candidate?.fill(0);
        }
    }
    async create(password) {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const meta = {
            vaultId: "personal",
            kdfSalt: bytesToBase64(salt),
            kdfParams: { m: 65_536, t: 3, p: 4, hashLength: 32 },
            keyRing: [CURRENT_KID],
            schemaVersion: 1,
            version: 1,
            updatedAt: Date.now()
        };
        const masterKey = await deriveMasterKey(password, { ...meta, wrappedVaultKey: {} });
        const kek = await hkdf(masterKey, KEK_INFO);
        const vaultKey = crypto.getRandomValues(new Uint8Array(32));
        try {
            const wrappedVaultKey = await sealEnvelope(vaultKey, kek, "wrap|personal");
            this.vaultKey = vaultKey;
            return { ...meta, wrappedVaultKey };
        }
        finally {
            masterKey.fill(0);
            kek.fill(0);
        }
    }
    lock() {
        this.vaultKey?.fill(0);
        this.vaultKey = undefined;
    }
    async changePassword(oldPassword, newPassword, meta) {
        await this.unlock(oldPassword, meta);
        if (!this.vaultKey)
            throw new Error("Cloud vault is locked");
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const next = { ...meta, kdfSalt: bytesToBase64(salt), version: (meta.version ?? 1) + 1, updatedAt: Date.now() };
        const masterKey = await deriveMasterKey(newPassword, next);
        const kek = await hkdf(masterKey, KEK_INFO);
        try {
            return { ...next, wrappedVaultKey: await sealEnvelope(this.vaultKey, kek, "wrap|personal") };
        }
        finally {
            masterKey.fill(0);
            kek.fill(0);
        }
    }
    async encryptString(value, itemId, field) {
        if (!this.vaultKey)
            throw new Error("Cloud vault is locked");
        const itemKey = await hkdf(this.vaultKey, `item:${itemId}`);
        try {
            return await sealEnvelope(encoder.encode(value), itemKey, `personal|${itemId}|${field}`);
        }
        finally {
            itemKey.fill(0);
        }
    }
    async decryptString(envelope, itemId) {
        if (!this.vaultKey)
            throw new Error("Cloud vault is locked");
        const itemKey = await hkdf(this.vaultKey, `item:${itemId}`);
        try {
            return decoder.decode(await openEnvelope(envelope, itemKey));
        }
        catch {
            throw new Error("This credential was encrypted with a different cloud vault key.");
        }
        finally {
            itemKey.fill(0);
        }
    }
}
exports.WebVault = WebVault;
