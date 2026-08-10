import assert from "node:assert/strict";
import { test } from "node:test";
import { loadServerConfig } from "../src/config.js";

const baseEnv: NodeJS.ProcessEnv = {
  WAN_ENV: "dev",
  WAN_AUTH_MODE: "dev-static",
  WAN_DEV_API_KEY: "wan_sk_dev_test",
  WAN_DATABASE_URL: "postgres://wan-router-test",
  WAN_API_KEY_PEPPER: "config-test-pepper-with-at-least-32-bytes",
};

test("local envelope mode requires a development master key", () => {
  const encodedKey = Buffer.alloc(32, 7).toString("base64");
  const config = loadServerConfig({ ...baseEnv, WAN_LOCAL_ENVELOPE_KEY: encodedKey });

  assert.equal(config.envelopeMode, "local");
  assert.equal(config.localEnvelopeMasterKey, encodedKey);
  assert.throws(() => loadServerConfig(baseEnv), /WAN_LOCAL_ENVELOPE_KEY/);
});

test("gcp-kms envelope mode requires a CryptoKey and does not require a local master key", () => {
  const cryptoKey = "projects/wan/locations/asia-southeast2/keyRings/router/cryptoKeys/provider-credentials";
  const config = loadServerConfig({
    ...baseEnv,
    WAN_ENVELOPE_MODE: "gcp-kms",
    WAN_KMS_CRYPTO_KEY: cryptoKey,
  });

  assert.equal(config.envelopeMode, "gcp-kms");
  assert.equal(config.kmsCryptoKeyName, cryptoKey);
  assert.equal(config.localEnvelopeMasterKey, undefined);
  assert.throws(() => loadServerConfig({
    ...baseEnv,
    WAN_ENVELOPE_MODE: "gcp-kms",
    WAN_KMS_CRYPTO_KEY: `${cryptoKey}/cryptoKeyVersions/1`,
  }), /WAN_KMS_CRYPTO_KEY/);
});

test("provider mode defaults to mock and validates live upstream configuration", () => {
  const encodedKey = Buffer.alloc(32, 8).toString("base64");
  const defaults = loadServerConfig({ ...baseEnv, WAN_LOCAL_ENVELOPE_KEY: encodedKey });
  assert.equal(defaults.providerMode, "mock");
  assert.equal(defaults.providerTimeoutMs, 60_000);
  assert.equal(defaults.providerCircuitFailureThreshold, 3);
  assert.equal(defaults.providerCircuitCooldownMs, 30_000);
  assert.equal(defaults.limitRequestsPerMinute, 60);
  assert.equal(defaults.limitMaxConcurrent, 4);
  assert.equal(defaults.limitMaxTokensPerRequest, 16_384);
  assert.equal(defaults.limitDailyTokens, 1_000_000);
  assert.equal(defaults.limitDefaultMaxCompletionTokens, 4_096);
  assert.equal(defaults.limitDailyBudgetMicros, undefined);
  assert.equal(defaults.limitCostMicrosPerToken, 0n);
  assert.equal(defaults.metricsBearerToken, undefined);

  const metrics = loadServerConfig({
    ...baseEnv,
    WAN_LOCAL_ENVELOPE_KEY: encodedKey,
    WAN_METRICS_BEARER_TOKEN: "metrics-config-token-with-at-least-32-bytes",
  });
  assert.equal(metrics.metricsBearerToken, "metrics-config-token-with-at-least-32-bytes");
  assert.throws(() => loadServerConfig({
    ...baseEnv,
    WAN_LOCAL_ENVELOPE_KEY: encodedKey,
    WAN_METRICS_BEARER_TOKEN: "too-short",
  }), /WAN_METRICS_BEARER_TOKEN/);

  const cliproxy = loadServerConfig({
    ...baseEnv,
    WAN_LOCAL_ENVELOPE_KEY: encodedKey,
    WAN_PROVIDER_MODE: "cliproxy",
    WAN_CLIPROXY_BASE_URL: "https://cliproxy.example.com/v1",
    WAN_CLIPROXY_API_KEY: "cliproxy_proxy_secret",
  });
  assert.equal(cliproxy.providerMode, "cliproxy");
  assert.equal(cliproxy.cliproxyBaseUrl, "https://cliproxy.example.com/v1");
  assert.equal(cliproxy.cliproxyApiKey, "cliproxy_proxy_secret");

  const openai = loadServerConfig({
    ...baseEnv,
    WAN_AUTH_MODE: "firebase",
    WAN_FIREBASE_PROJECT_ID: "wan-test",
    WAN_DEV_API_KEY: undefined,
    WAN_LOCAL_ENVELOPE_KEY: encodedKey,
    WAN_PROVIDER_MODE: "openai",
    WAN_PROVIDER_TIMEOUT_MS: "45000",
    WAN_PROVIDER_CIRCUIT_FAILURE_THRESHOLD: "5",
    WAN_PROVIDER_CIRCUIT_COOLDOWN_MS: "45000",
    WAN_LIMIT_REQUESTS_PER_MINUTE: "120",
    WAN_LIMIT_MAX_CONCURRENT: "8",
    WAN_LIMIT_MAX_TOKENS_PER_REQUEST: "32000",
    WAN_LIMIT_DAILY_TOKENS: "2000000",
    WAN_LIMIT_DEFAULT_MAX_COMPLETION_TOKENS: "8000",
    WAN_LIMIT_DAILY_BUDGET_MICROS: "5000000",
    WAN_LIMIT_COST_MICROS_PER_TOKEN: "2",
  });
  assert.equal(openai.providerMode, "openai");
  assert.equal(openai.providerTimeoutMs, 45_000);
  assert.equal(openai.providerCircuitFailureThreshold, 5);
  assert.equal(openai.providerCircuitCooldownMs, 45_000);
  assert.equal(openai.limitRequestsPerMinute, 120);
  assert.equal(openai.limitMaxConcurrent, 8);
  assert.equal(openai.limitMaxTokensPerRequest, 32_000);
  assert.equal(openai.limitDailyTokens, 2_000_000);
  assert.equal(openai.limitDefaultMaxCompletionTokens, 8_000);
  assert.equal(openai.limitDailyBudgetMicros, 5_000_000n);
  assert.equal(openai.limitCostMicrosPerToken, 2n);
  assert.throws(() => loadServerConfig({
    ...baseEnv,
    WAN_LOCAL_ENVELOPE_KEY: encodedKey,
    WAN_PROVIDER_MODE: "custom",
  }), /WAN_PROVIDER_MODE/);
  assert.throws(() => loadServerConfig({
    ...baseEnv,
    WAN_LOCAL_ENVELOPE_KEY: encodedKey,
    WAN_PROVIDER_MODE: "cliproxy",
    WAN_CLIPROXY_API_KEY: "cliproxy_proxy_secret",
  }), /WAN_CLIPROXY_BASE_URL/);
  assert.throws(() => loadServerConfig({
    ...baseEnv,
    WAN_LOCAL_ENVELOPE_KEY: encodedKey,
    WAN_PROVIDER_MODE: "cliproxy",
    WAN_CLIPROXY_BASE_URL: "https://cliproxy.example.com/v1",
  }), /WAN_CLIPROXY_API_KEY/);
  assert.throws(() => loadServerConfig({
    ...baseEnv,
    WAN_LOCAL_ENVELOPE_KEY: encodedKey,
    WAN_PROVIDER_MODE: "openai",
  }), /WAN_AUTH_MODE=firebase/);
  assert.throws(() => loadServerConfig({
    ...baseEnv,
    WAN_LOCAL_ENVELOPE_KEY: encodedKey,
    WAN_PROVIDER_TIMEOUT_MS: "999",
  }), /WAN_PROVIDER_TIMEOUT_MS/);
  assert.throws(() => loadServerConfig({
    ...baseEnv,
    WAN_LOCAL_ENVELOPE_KEY: encodedKey,
    WAN_PROVIDER_CIRCUIT_FAILURE_THRESHOLD: "0",
  }), /WAN_PROVIDER_CIRCUIT_FAILURE_THRESHOLD/);
  assert.throws(() => loadServerConfig({
    ...baseEnv,
    WAN_LOCAL_ENVELOPE_KEY: encodedKey,
    WAN_PROVIDER_CIRCUIT_COOLDOWN_MS: "999",
  }), /WAN_PROVIDER_CIRCUIT_COOLDOWN_MS/);
  assert.throws(() => loadServerConfig({
    ...baseEnv,
    WAN_LOCAL_ENVELOPE_KEY: encodedKey,
    WAN_LIMIT_MAX_CONCURRENT: "0",
  }), /WAN_LIMIT_MAX_CONCURRENT/);
  assert.throws(() => loadServerConfig({
    ...baseEnv,
    WAN_LOCAL_ENVELOPE_KEY: encodedKey,
    WAN_LIMIT_DAILY_BUDGET_MICROS: "1000",
  }), /WAN_LIMIT_COST_MICROS_PER_TOKEN/);
});