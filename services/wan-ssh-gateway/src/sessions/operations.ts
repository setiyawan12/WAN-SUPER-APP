import { createHash, createPrivateKey, generateKeyPairSync } from "node:crypto";
import ssh2 from "ssh2";
import type { AgentBridgeConnector } from "../agent/hub.js";
import type { GatewayConfig } from "../config.js";
import { GatewayError } from "../errors.js";
import { connectResolvedTarget, resolveTarget } from "./target-policy.js";

function sshKeyInfo(privateKey: string, passphrase?: string) {
  const parsedValue = ssh2.utils.parseKey(privateKey, passphrase);
  const parsed = Array.isArray(parsedValue) ? parsedValue[0] : parsedValue;
  if (!parsed || parsed instanceof Error) throw new GatewayError("KEY_OPERATION_FAILED", "Private key could not be parsed");
  const publicBlob = parsed.getPublicSSH();
  const publicKey = `${parsed.type} ${publicBlob.toString("base64")}`;
  const fingerprintSha256 = `SHA256:${createHash("sha256").update(publicBlob).digest("base64").replace(/=+$/, "")}`;
  const algorithm = parsed.type === "ssh-rsa" ? "rsa" : parsed.type.startsWith("ecdsa-") ? "ecdsa" : "ed25519";
  let bits: number | null = null;
  try {
    bits = createPrivateKey({ key: privateKey, passphrase }).asymmetricKeyDetails?.modulusLength ?? null;
  } catch {}
  return { publicKey, fingerprintSha256, algorithm, bits };
}

export function generateSshKey(input: { algorithm: "ed25519" | "ecdsa" | "rsa"; bits?: number; passphrase?: string }) {
  const privateKeyType = input.algorithm === "ecdsa" ? "sec1" : "pkcs8";
  const privateKeyEncoding = input.passphrase
    ? { type: privateKeyType, format: "pem", cipher: "aes-256-cbc", passphrase: input.passphrase }
    : { type: privateKeyType, format: "pem" };
  const encoding = {
    publicKeyEncoding: { type: "spki" as const, format: "pem" as const },
    privateKeyEncoding: privateKeyEncoding as { type: "pkcs8" | "sec1"; format: "pem"; cipher?: string; passphrase?: string }
  };
  const privateKey = input.algorithm === "rsa"
    ? generateKeyPairSync("rsa", { ...encoding, modulusLength: input.bits ?? 4_096 }).privateKey
    : input.algorithm === "ecdsa"
      ? generateKeyPairSync("ec", { ...encoding, namedCurve: "prime256v1" }).privateKey
      : generateKeyPairSync("ed25519", encoding).privateKey;
  const value = String(privateKey);
  return { privateKey: value, ...sshKeyInfo(value, input.passphrase) };
}

export function inspectSshKey(privateKey: string, passphrase?: string) {
  return sshKeyInfo(privateKey, passphrase);
}

export async function runTargetDiagnostics(config: GatewayConfig, target: { host: string; port: number }) {
  const phases: Array<{ name: "resolve" | "tcp"; ok: boolean; durationMs: number; detail: string }> = [];
  const resolveStarted = Date.now();
  let resolved;
  try {
    resolved = await resolveTarget(config, target.host, target.port);
    phases.push({ name: "resolve", ok: true, durationMs: Date.now() - resolveStarted, detail: resolved.address });
  } catch (error) {
    phases.push({ name: "resolve", ok: false, durationMs: Date.now() - resolveStarted, detail: error instanceof Error ? error.message : "Resolution failed" });
    return phases;
  }
  const tcpStarted = Date.now();
  try {
    const socket = await connectResolvedTarget(resolved, config.connectTimeoutMs);
    socket.destroy();
    phases.push({ name: "tcp", ok: true, durationMs: Date.now() - tcpStarted, detail: `${target.host}:${target.port} accepts TCP connections` });
  } catch (error) {
    phases.push({ name: "tcp", ok: false, durationMs: Date.now() - tcpStarted, detail: error instanceof Error ? error.message : "TCP probe failed" });
  }
  return phases;
}

export async function runAgentDiagnostics(agentBridge: AgentBridgeConnector | undefined, principalId: string, target: { host: string; port: number }) {
  const connected = Boolean(agentBridge?.isConnected(principalId));
  const phases: Array<{ name: "resolve" | "tcp"; ok: boolean; durationMs: number; detail: string }> = [{
    name: "resolve",
    ok: connected,
    durationMs: 0,
    detail: connected ? "Paired local agent online" : "No paired local agent online"
  }];
  if (!agentBridge || !connected) return phases;
  const started = Date.now();
  try {
    const socket = await agentBridge.open(principalId, target.host, target.port);
    socket.destroy();
    phases.push({ name: "tcp", ok: true, durationMs: Date.now() - started, detail: `${target.host}:${target.port} is reachable through the local agent` });
  } catch (error) {
    phases.push({ name: "tcp", ok: false, durationMs: Date.now() - started, detail: error instanceof Error ? error.message : "Local-agent probe failed" });
  }
  return phases;
}