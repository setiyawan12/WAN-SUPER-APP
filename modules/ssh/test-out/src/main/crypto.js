"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.CURRENT_KID = exports.KEK_INFO = exports.KDF_PARAMS_SERIALIZED = exports.KDF_PARAMS = void 0;
exports.deriveMasterKey = deriveMasterKey;
exports.hkdf = hkdf;
exports.seal = seal;
exports.open = open;
exports.wipe = wipe;
exports.randomVaultKey = randomVaultKey;
const node_crypto = __importStar(require("node:crypto"));
const argon2 = __importStar(require("argon2"));
exports.KDF_PARAMS = {
    type: argon2.argon2id,
    memoryCost: 65536,
    // 64 MiB
    timeCost: 3,
    parallelism: 4,
    hashLength: 32
};
exports.KDF_PARAMS_SERIALIZED = {
    m: exports.KDF_PARAMS.memoryCost,
    t: exports.KDF_PARAMS.timeCost,
    p: exports.KDF_PARAMS.parallelism,
    hashLength: exports.KDF_PARAMS.hashLength
};
async function deriveMasterKey(password, salt) {
    return argon2.hash(password, { ...exports.KDF_PARAMS, salt, raw: true });
}
function hkdf(key, info, len = 32) {
    return Buffer.from(node_crypto.hkdfSync("sha256", key, Buffer.alloc(0), Buffer.from(info), len));
}
function seal(plain, key, aad, kid) {
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
function open(env, key) {
    const d = node_crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(env.iv, "base64"));
    d.setAAD(Buffer.from(env.aad, "base64"));
    d.setAuthTag(Buffer.from(env.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(env.ct, "base64")), d.final()]);
}
function wipe(...bufs) {
    for (const b of bufs)
        if (b)
            b.fill(0);
}
function randomVaultKey() {
    return node_crypto.randomBytes(32);
}
exports.KEK_INFO = "vault-kek-v1";
exports.CURRENT_KID = "k1";
