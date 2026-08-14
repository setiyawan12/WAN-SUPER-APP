import { createHash } from "node:crypto";

export function fingerprintHostKey(key: Buffer) {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

export function hostKeyAlgorithm(key: Buffer) {
  if (key.length < 4) return "unknown";
  const length = key.readUInt32BE(0);
  if (length < 1 || length > key.length - 4 || length > 128) return "unknown";
  const algorithm = key.subarray(4, 4 + length).toString("ascii");
  return /^[a-z0-9@._+-]+$/i.test(algorithm) ? algorithm : "unknown";
}