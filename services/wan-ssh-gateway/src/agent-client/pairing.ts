import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const PAIRING_PREFIX = "WANSSH1.";

export type AgentPairing = {
  v: 1;
  url: string;
  mode: "firebase" | "dev-anonymous";
  apiKey?: string;
  refreshToken?: string;
  tokenUrl?: string;
  account?: string;
};

export type AgentStore = AgentPairing & {
  allowCidrs?: string[];
  allowLoopback?: boolean;
  pairedAt?: number;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function normalizeUrl(raw: string) {
  const url = new URL(raw);
  assert(url.protocol === "http:" || url.protocol === "https:", "Gateway URL must be http or https");
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

export function normalizePairing(value: unknown): AgentPairing {
  assert(value && typeof value === "object", "Pairing payload is not an object");
  const raw = value as Record<string, unknown>;
  assert(raw.v === 1, "Pairing payload version is unsupported");
  assert(typeof raw.url === "string" && raw.url, "Pairing payload has no gateway URL");
  assert(raw.mode === "firebase" || raw.mode === "dev-anonymous", "Pairing payload has an unknown auth mode");
  const pairing: AgentPairing = { v: 1, url: normalizeUrl(raw.url), mode: raw.mode };
  if (typeof raw.account === "string" && raw.account) pairing.account = raw.account.slice(0, 200);
  if (raw.mode === "dev-anonymous") return pairing;
  assert(typeof raw.apiKey === "string" && raw.apiKey, "Pairing payload has no Firebase API key");
  assert(typeof raw.refreshToken === "string" && raw.refreshToken, "Pairing payload has no Firebase refresh token");
  pairing.apiKey = raw.apiKey;
  pairing.refreshToken = raw.refreshToken;
  if (typeof raw.tokenUrl === "string" && raw.tokenUrl) pairing.tokenUrl = normalizeUrl(raw.tokenUrl);
  return pairing;
}

export function encodePairing(pairing: AgentPairing) {
  return PAIRING_PREFIX + Buffer.from(JSON.stringify(normalizePairing(pairing)), "utf8").toString("base64url");
}

export function decodePairing(text: string): AgentPairing {
  const trimmed = text.trim();
  assert(trimmed.startsWith(PAIRING_PREFIX), "Pairing code is not a WAN SSH agent code");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(trimmed.slice(PAIRING_PREFIX.length), "base64url").toString("utf8"));
  } catch {
    throw new Error("Pairing code is malformed");
  }
  return normalizePairing(parsed);
}

export function storePath() {
  return process.env.WAN_SSH_AGENT_STORE ?? join(process.env.WAN_SSH_AGENT_HOME ?? join(homedir(), ".wan-ssh"), "agent.json");
}

export function readStore(path = storePath()): AgentStore | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const store: AgentStore = { ...normalizePairing(parsed) };
  if (Array.isArray(parsed.allowCidrs)) store.allowCidrs = parsed.allowCidrs.filter((entry): entry is string => typeof entry === "string");
  if (typeof parsed.allowLoopback === "boolean") store.allowLoopback = parsed.allowLoopback;
  if (typeof parsed.pairedAt === "number") store.pairedAt = parsed.pairedAt;
  return store;
}

/**
 * Refresh token Firebase setara dengan sesi login penuh, jadi file pairing
 * selalu ditulis dengan mode 0600 dan isinya tidak pernah dicetak ke log.
 */
export function writeStore(store: AgentStore, path = storePath()) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function clearStore(path = storePath()) {
  rmSync(path, { force: true });
  return path;
}
