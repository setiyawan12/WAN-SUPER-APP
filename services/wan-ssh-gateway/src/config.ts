import { isIP } from "node:net";

export type GatewayEnvironment = "development" | "production";
export type GatewayAuthMode = "dev-anonymous" | "firebase";
export type GatewayEgressMode = "development" | "allowlist";
export type GatewayKnownHostMode = "client-hint" | "firestore";

export interface GatewayConfig {
  environment: GatewayEnvironment;
  bindHost: string;
  port: number;
  authMode: GatewayAuthMode;
  firebaseProjectId?: string;
  allowedOrigins: string[];
  maxSessionsPerUser: number;
  maxSessionsTotal: number;
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  maxSessionMs: number;
  authTimeoutMs: number;
  hostKeyTimeoutMs: number;
  maxMessageBytes: number;
  maxPrivateKeyBytes: number;
  outputHighWaterBytes: number;
  outputLowWaterBytes: number;
  backpressureTimeoutMs: number;
  outputBatchBytes: number;
  egressMode: GatewayEgressMode;
  knownHostMode: GatewayKnownHostMode;
  egressAllowCidrs: string[];
  trustedProxyCidrs: string[];
  connectRateLimit: number;
  connectRateWindowMs: number;
  logLevel: LogLevel;
  heartbeatMs: number;
  shutdownGraceMs: number;
  agentBridgeEnabled: boolean;
  agentRegistrationTimeoutMs: number;
  agentOpenTimeoutMs: number;
  agentMaxBufferedBytes: number;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

type Environment = Record<string, string | undefined>;

const defaults = {
  WAN_SSH_ENV: "development",
  WAN_SSH_BIND_HOST: "0.0.0.0",
  WAN_SSH_PORT: "8788",
  WAN_SSH_AUTH_MODE: "dev-anonymous",
  WAN_SSH_ALLOWED_ORIGINS: "http://127.0.0.1:5179",
  WAN_SSH_MAX_SESSIONS_PER_USER: "4",
  WAN_SSH_MAX_SESSIONS_TOTAL: "20",
  WAN_SSH_CONNECT_TIMEOUT_MS: "15000",
  WAN_SSH_IDLE_TIMEOUT_MS: "900000",
  WAN_SSH_MAX_SESSION_MS: "14400000",
  WAN_SSH_AUTH_TIMEOUT_MS: "5000",
  WAN_SSH_HOST_KEY_TIMEOUT_MS: "60000",
  WAN_SSH_MAX_MESSAGE_BYTES: "524288",
  WAN_SSH_MAX_PRIVATE_KEY_BYTES: "262144",
  WAN_SSH_OUTPUT_HIGH_WATER_BYTES: "1048576",
  WAN_SSH_OUTPUT_LOW_WATER_BYTES: "262144",
  WAN_SSH_BACKPRESSURE_TIMEOUT_MS: "10000",
  WAN_SSH_OUTPUT_BATCH_BYTES: "65536",
  WAN_SSH_EGRESS_MODE: "development",
  WAN_SSH_KNOWN_HOST_MODE: "client-hint",
  WAN_SSH_TRUSTED_PROXY_CIDRS: "172.30.0.0/24",
  WAN_SSH_CONNECT_RATE_LIMIT: "30",
  WAN_SSH_CONNECT_RATE_WINDOW_MS: "60000",
  WAN_SSH_LOG_LEVEL: "info",
  WAN_SSH_HEARTBEAT_MS: "30000",
  WAN_SSH_SHUTDOWN_GRACE_MS: "10000",
  WAN_SSH_AGENT_BRIDGE_ENABLED: "true",
  WAN_SSH_AGENT_REGISTRATION_TIMEOUT_MS: "5000",
  WAN_SSH_AGENT_OPEN_TIMEOUT_MS: "15000",
  WAN_SSH_AGENT_MAX_BUFFERED_BYTES: "1048576"
} as const;

function value(env: Environment, key: keyof typeof defaults) {
  return env[key] ?? defaults[key];
}

function integer(env: Environment, key: keyof typeof defaults, minimum: number, maximum = Number.MAX_SAFE_INTEGER) {
  const raw = value(env, key);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${key} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function boolean(env: Environment, key: keyof typeof defaults) {
  const raw = value(env, key);
  if (raw !== "true" && raw !== "false") throw new Error(`${key} must be true or false`);
  return raw === "true";
}

function list(raw: string | undefined) {
  return (raw ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
}

function parseOrigin(origin: string) {
  if (origin.includes("*")) throw new Error("WAN_SSH_ALLOWED_ORIGINS cannot contain wildcards");
  const url = new URL(origin);
  if (url.origin !== origin || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`WAN_SSH_ALLOWED_ORIGINS contains an invalid origin: ${origin}`);
  }
  return url;
}

function isLoopbackOrigin(url: URL) {
  return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
}

function validateCidr(cidr: string) {
  const [address, prefixText, extra] = cidr.split("/");
  const family = isIP(address);
  const prefix = Number(prefixText);
  const maxPrefix = family === 4 ? 32 : family === 6 ? 128 : 0;
  if (extra !== undefined || !family || !Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
    throw new Error(`Invalid CIDR: ${cidr}`);
  }
}

function validateNoCredentialEnvironment(env: Environment) {
  const forbidden = /(?:PRIVATE.?KEY|PASSWORD|PASSPHRASE|AUTH.?TOKEN|USER.?SECRET)/i;
  const safeLimitKeys = new Set(["WAN_SSH_MAX_PRIVATE_KEY_BYTES"]);
  for (const [key, entry] of Object.entries(env)) {
    if (key.startsWith("WAN_SSH_") && entry && forbidden.test(key) && !safeLimitKeys.has(key)) {
      throw new Error(`${key} is forbidden: user credentials must not be configured in the gateway environment`);
    }
  }
}

export function loadConfig(env: Environment = process.env): GatewayConfig {
  validateNoCredentialEnvironment(env);
  const environment = value(env, "WAN_SSH_ENV");
  const authMode = value(env, "WAN_SSH_AUTH_MODE");
  const egressMode = value(env, "WAN_SSH_EGRESS_MODE");
  const knownHostMode = value(env, "WAN_SSH_KNOWN_HOST_MODE");
  const logLevel = value(env, "WAN_SSH_LOG_LEVEL");
  if (environment !== "development" && environment !== "production") throw new Error("WAN_SSH_ENV must be development or production");
  if (authMode !== "dev-anonymous" && authMode !== "firebase") throw new Error("WAN_SSH_AUTH_MODE must be dev-anonymous or firebase");
  if (egressMode !== "development" && egressMode !== "allowlist") throw new Error("WAN_SSH_EGRESS_MODE must be development or allowlist");
  if (knownHostMode !== "client-hint" && knownHostMode !== "firestore") throw new Error("WAN_SSH_KNOWN_HOST_MODE must be client-hint or firestore");
  if (!["debug", "info", "warn", "error"].includes(logLevel)) throw new Error("WAN_SSH_LOG_LEVEL is invalid");

  const allowedOrigins = list(env.WAN_SSH_ALLOWED_ORIGINS ?? defaults.WAN_SSH_ALLOWED_ORIGINS);
  if (!allowedOrigins.length) throw new Error("WAN_SSH_ALLOWED_ORIGINS must not be empty");
  const originUrls = allowedOrigins.map(parseOrigin);
  const trustedProxyCidrs = list(env.WAN_SSH_TRUSTED_PROXY_CIDRS ?? defaults.WAN_SSH_TRUSTED_PROXY_CIDRS);
  trustedProxyCidrs.forEach(validateCidr);
  const egressAllowCidrs = list(env.WAN_SSH_EGRESS_ALLOW_CIDRS);
  egressAllowCidrs.forEach(validateCidr);

  const config: GatewayConfig = {
    environment,
    bindHost: value(env, "WAN_SSH_BIND_HOST"),
    port: integer(env, "WAN_SSH_PORT", 1, 65_535),
    authMode,
    firebaseProjectId: env.WAN_SSH_FIREBASE_PROJECT_ID?.trim() || undefined,
    allowedOrigins,
    maxSessionsPerUser: integer(env, "WAN_SSH_MAX_SESSIONS_PER_USER", 1, 1_000),
    maxSessionsTotal: integer(env, "WAN_SSH_MAX_SESSIONS_TOTAL", 1, 100_000),
    connectTimeoutMs: integer(env, "WAN_SSH_CONNECT_TIMEOUT_MS", 100, 300_000),
    idleTimeoutMs: integer(env, "WAN_SSH_IDLE_TIMEOUT_MS", 1_000, 86_400_000),
    maxSessionMs: integer(env, "WAN_SSH_MAX_SESSION_MS", 1_000, 604_800_000),
    authTimeoutMs: integer(env, "WAN_SSH_AUTH_TIMEOUT_MS", 100, 60_000),
    hostKeyTimeoutMs: integer(env, "WAN_SSH_HOST_KEY_TIMEOUT_MS", 1_000, 300_000),
    maxMessageBytes: integer(env, "WAN_SSH_MAX_MESSAGE_BYTES", 1_024, 16_777_216),
    maxPrivateKeyBytes: integer(env, "WAN_SSH_MAX_PRIVATE_KEY_BYTES", 1_024, 1_048_576),
    outputHighWaterBytes: integer(env, "WAN_SSH_OUTPUT_HIGH_WATER_BYTES", 1_024, 67_108_864),
    outputLowWaterBytes: integer(env, "WAN_SSH_OUTPUT_LOW_WATER_BYTES", 0, 67_108_864),
    backpressureTimeoutMs: integer(env, "WAN_SSH_BACKPRESSURE_TIMEOUT_MS", 100, 300_000),
    outputBatchBytes: integer(env, "WAN_SSH_OUTPUT_BATCH_BYTES", 1_024, 1_048_576),
    egressMode,
    knownHostMode,
    connectRateLimit: integer(env, "WAN_SSH_CONNECT_RATE_LIMIT", 1, 100_000),
    connectRateWindowMs: integer(env, "WAN_SSH_CONNECT_RATE_WINDOW_MS", 100, 3_600_000),
    egressAllowCidrs,
    trustedProxyCidrs,
    logLevel: logLevel as LogLevel,
    heartbeatMs: integer(env, "WAN_SSH_HEARTBEAT_MS", 1_000, 300_000),
    shutdownGraceMs: integer(env, "WAN_SSH_SHUTDOWN_GRACE_MS", 1_000, 120_000),
    agentBridgeEnabled: boolean(env, "WAN_SSH_AGENT_BRIDGE_ENABLED"),
    agentRegistrationTimeoutMs: integer(env, "WAN_SSH_AGENT_REGISTRATION_TIMEOUT_MS", 100, 60_000),
    agentOpenTimeoutMs: integer(env, "WAN_SSH_AGENT_OPEN_TIMEOUT_MS", 100, 300_000),
    agentMaxBufferedBytes: integer(env, "WAN_SSH_AGENT_MAX_BUFFERED_BYTES", 65_536, 16_777_216)
  };

  if (config.outputLowWaterBytes >= config.outputHighWaterBytes) throw new Error("Output low-water limit must be below high-water limit");
  if (config.outputBatchBytes > config.outputHighWaterBytes) throw new Error("Output batch size must not exceed high-water limit");
  if (config.maxPrivateKeyBytes >= config.maxMessageBytes) throw new Error("Private-key limit must be below total message limit");
  if (config.maxSessionsPerUser > config.maxSessionsTotal) throw new Error("Per-user session limit must not exceed total limit");

  if (config.authMode === "dev-anonymous") {
    if (config.environment !== "development") throw new Error("Development authentication is forbidden in production");
    if (originUrls.some((origin) => origin.protocol !== "http:" || !isLoopbackOrigin(origin))) {
      throw new Error("Development authentication requires exact loopback HTTP origins");
    }
  }
  if (config.authMode === "firebase" && !config.firebaseProjectId) throw new Error("WAN_SSH_FIREBASE_PROJECT_ID is required for Firebase authentication");

  if (config.environment === "production") {
    if (config.authMode !== "firebase") throw new Error("Production requires Firebase authentication");
    if (originUrls.some((origin) => origin.protocol !== "https:")) throw new Error("Production origins must use HTTPS");
    if (config.egressMode !== "allowlist" || !config.egressAllowCidrs.length) throw new Error("Production requires a non-empty egress allowlist");
    if (config.knownHostMode !== "firestore") throw new Error("Production requires the Firestore authoritative known-host store");
    if (!config.trustedProxyCidrs.length || config.trustedProxyCidrs.some((cidr) => cidr === "0.0.0.0/0" || cidr === "::/0")) {
      throw new Error("Production requires bounded trusted proxy CIDRs");
    }
  }

  return config;
}