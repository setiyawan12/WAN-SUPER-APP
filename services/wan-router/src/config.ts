import { GatewayError } from "./errors.js";

export interface ServerConfig {
  environment: "dev";
  authMode: "dev-static" | "firebase";
  envelopeMode: "local" | "gcp-kms";
  providerMode: "mock" | "cliproxy" | "openai";
  cliproxyBaseUrl?: string;
  cliproxyApiKey?: string;
  providerTimeoutMs: number;
  providerCircuitFailureThreshold: number;
  providerCircuitCooldownMs: number;
  limitRequestsPerMinute: number;
  limitMaxConcurrent: number;
  limitMaxTokensPerRequest: number;
  limitDailyTokens: number;
  limitDefaultMaxCompletionTokens: number;
  limitDailyBudgetMicros?: bigint;
  limitCostMicrosPerToken: bigint;
  host: string;
  port: number;
  metricsBearerToken?: string;
  developmentApiKey?: string;
  firebaseProjectId?: string;
  workspaceId: string;
  allowedOrigins: string[];
  databaseUrl: string;
  apiKeyPepper: string;
  localEnvelopeMasterKey?: string;
  kmsCryptoKeyName?: string;
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const environment = env.WAN_ENV || "dev";
  if (environment !== "dev") {
    throw new GatewayError(
      503,
      "configuration_error",
      "production_auth_not_configured",
      "This gateway build only supports the development environment.",
    );
  }

  const authMode = env.WAN_AUTH_MODE === "firebase" ? "firebase" : "dev-static";
  const developmentApiKey = env.WAN_DEV_API_KEY?.trim();
  const firebaseProjectId = env.WAN_FIREBASE_PROJECT_ID?.trim() || env.GCLOUD_PROJECT?.trim();
  if (authMode === "dev-static" && !developmentApiKey) throw new Error("WAN_DEV_API_KEY is required for dev-static auth.");
  if (authMode === "firebase" && !firebaseProjectId) throw new Error("WAN_FIREBASE_PROJECT_ID is required for Firebase auth.");
  const databaseUrl = env.WAN_DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("WAN_DATABASE_URL is required.");
  const apiKeyPepper = env.WAN_API_KEY_PEPPER?.trim();
  if (!apiKeyPepper || Buffer.byteLength(apiKeyPepper) < 32) {
    throw new Error("WAN_API_KEY_PEPPER must contain at least 32 bytes.");
  }
  const envelopeMode = env.WAN_ENVELOPE_MODE?.trim() || "local";
  if (envelopeMode !== "local" && envelopeMode !== "gcp-kms") {
    throw new Error("WAN_ENVELOPE_MODE must be local or gcp-kms.");
  }
  const localEnvelopeMasterKey = env.WAN_LOCAL_ENVELOPE_KEY?.trim();
  const kmsCryptoKeyName = env.WAN_KMS_CRYPTO_KEY?.trim();
  if (envelopeMode === "local" && (!localEnvelopeMasterKey || Buffer.from(localEnvelopeMasterKey, "base64").length !== 32)) {
    throw new Error("WAN_LOCAL_ENVELOPE_KEY must be a base64-encoded 32-byte development key in local envelope mode.");
  }
  if (envelopeMode === "gcp-kms" && !/^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+$/.test(kmsCryptoKeyName || "")) {
    throw new Error("WAN_KMS_CRYPTO_KEY must be a fully-qualified CryptoKey resource name in gcp-kms envelope mode.");
  }
  const providerMode = env.WAN_PROVIDER_MODE?.trim() || "mock";
  if (providerMode !== "mock" && providerMode !== "cliproxy" && providerMode !== "openai") {
    throw new Error("WAN_PROVIDER_MODE must be mock, cliproxy, or openai.");
  }
  const cliproxyBaseUrl = env.WAN_CLIPROXY_BASE_URL?.trim();
  const cliproxyApiKey = env.WAN_CLIPROXY_API_KEY?.trim();
  if (providerMode === "cliproxy" && !cliproxyBaseUrl) {
    throw new Error("WAN_CLIPROXY_BASE_URL is required for cliproxy provider mode.");
  }
  if (providerMode === "cliproxy" && !cliproxyApiKey) {
    throw new Error("WAN_CLIPROXY_API_KEY is required for cliproxy provider mode.");
  }
  if (providerMode === "openai" && authMode !== "firebase") {
    throw new Error("WAN_PROVIDER_MODE=openai requires WAN_AUTH_MODE=firebase for the BYOK control plane.");
  }
  const providerTimeoutMs = Number(env.WAN_PROVIDER_TIMEOUT_MS || 60_000);
  if (!Number.isInteger(providerTimeoutMs) || providerTimeoutMs < 1_000 || providerTimeoutMs > 300_000) {
    throw new Error("WAN_PROVIDER_TIMEOUT_MS must be an integer between 1000 and 300000.");
  }
  const providerCircuitFailureThreshold = Number(env.WAN_PROVIDER_CIRCUIT_FAILURE_THRESHOLD || 3);
  if (!Number.isInteger(providerCircuitFailureThreshold) || providerCircuitFailureThreshold < 1 || providerCircuitFailureThreshold > 100) {
    throw new Error("WAN_PROVIDER_CIRCUIT_FAILURE_THRESHOLD must be an integer between 1 and 100.");
  }
  const providerCircuitCooldownMs = Number(env.WAN_PROVIDER_CIRCUIT_COOLDOWN_MS || 30_000);
  if (!Number.isInteger(providerCircuitCooldownMs) || providerCircuitCooldownMs < 1_000 || providerCircuitCooldownMs > 3_600_000) {
    throw new Error("WAN_PROVIDER_CIRCUIT_COOLDOWN_MS must be an integer between 1000 and 3600000.");
  }
  const positiveLimit = (name: string, fallback: number): number => {
    const value = Number(env[name] || fallback);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer.`);
    return value;
  };
  const limitRequestsPerMinute = positiveLimit("WAN_LIMIT_REQUESTS_PER_MINUTE", 60);
  const limitMaxConcurrent = positiveLimit("WAN_LIMIT_MAX_CONCURRENT", 4);
  const limitMaxTokensPerRequest = positiveLimit("WAN_LIMIT_MAX_TOKENS_PER_REQUEST", 16_384);
  const limitDailyTokens = positiveLimit("WAN_LIMIT_DAILY_TOKENS", 1_000_000);
  const limitDefaultMaxCompletionTokens = positiveLimit("WAN_LIMIT_DEFAULT_MAX_COMPLETION_TOKENS", 4_096);
  if (limitDefaultMaxCompletionTokens >= limitMaxTokensPerRequest) {
    throw new Error("WAN_LIMIT_DEFAULT_MAX_COMPLETION_TOKENS must be lower than WAN_LIMIT_MAX_TOKENS_PER_REQUEST.");
  }
  const nonNegativeBigInt = (name: string, fallback?: bigint): bigint | undefined => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer string.`);
    return BigInt(raw);
  };
  const limitDailyBudgetMicros = nonNegativeBigInt("WAN_LIMIT_DAILY_BUDGET_MICROS");
  const limitCostMicrosPerToken = nonNegativeBigInt("WAN_LIMIT_COST_MICROS_PER_TOKEN", 0n)!;
  if (limitDailyBudgetMicros !== undefined && limitCostMicrosPerToken === 0n) {
    throw new Error("WAN_LIMIT_COST_MICROS_PER_TOKEN must be positive when WAN_LIMIT_DAILY_BUDGET_MICROS is set.");
  }

  const port = Number(env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be a valid TCP port.");
  const metricsBearerToken = env.WAN_METRICS_BEARER_TOKEN?.trim();
  if (metricsBearerToken && Buffer.byteLength(metricsBearerToken) < 32) {
    throw new Error("WAN_METRICS_BEARER_TOKEN must contain at least 32 bytes when metrics are enabled.");
  }

  return {
    environment,
    authMode,
    envelopeMode,
    providerMode,
    cliproxyBaseUrl,
    cliproxyApiKey,
    providerTimeoutMs,
    providerCircuitFailureThreshold,
    providerCircuitCooldownMs,
    limitRequestsPerMinute,
    limitMaxConcurrent,
    limitMaxTokensPerRequest,
    limitDailyTokens,
    limitDefaultMaxCompletionTokens,
    limitDailyBudgetMicros,
    limitCostMicrosPerToken,
    host: env.HOST || "127.0.0.1",
    port,
    metricsBearerToken,
    developmentApiKey,
    firebaseProjectId,
    workspaceId: env.WAN_DEV_WORKSPACE_ID || "workspace_dev",
    databaseUrl,
    apiKeyPepper,
    localEnvelopeMasterKey,
    kmsCryptoKeyName,
    allowedOrigins: (env.WAN_CORS_ORIGINS || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  };
}