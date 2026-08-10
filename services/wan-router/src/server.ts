import { createServer } from "node:http";
import { AdmissionService } from "./admission/limits.js";
import { PostgresAdmissionStore } from "./admission/postgres.js";
import { ApiKeyService, WanApiKeyAuthenticator } from "./auth/api-keys.js";
import { PrefixRoutingAuthenticator, StaticBearerAuthenticator } from "./auth/authenticator.js";
import { createFirebaseAuthenticator } from "./auth/firebase.js";
import { createGatewayApp } from "./app.js";
import { loadServerConfig } from "./config.js";
import { ProviderCredentialService } from "./control/provider-credentials.js";
import { createPostgresPool, PostgresRouterRepository } from "./data/postgres.js";
import { GenerationService } from "./inference/generations.js";
import { consoleGatewayLogger } from "./observability/logger.js";
import { createGatewayMetrics } from "./observability/metrics.js";
import { AuditService } from "./observability/audit.js";
import { MockProviderCredentialVerifier, ProviderVerifierRegistry } from "./providers/credentials.js";
import { OPENAI_API_BASE_URL, OPENAI_MODELS } from "./providers/catalog.js";
import { CliproxyRemoteAdapter } from "./providers/cliproxy-remote.js";
import { FixedRoutingProvider } from "./providers/fixed-router.js";
import { DeterministicMockProvider } from "./providers/mock.js";
import { OpenAICompatibleAdapter, OpenAICompatibleCredentialVerifier } from "./providers/openai-compatible.js";
import { KmsEnvelopeCipher, localEnvelopeCipherFromBase64 } from "./security/envelope.js";
import { createGoogleCloudKmsDataKeyWrapper } from "./security/gcp-kms.js";

const config = loadServerConfig();
const metrics = createGatewayMetrics();
const pool = createPostgresPool(config.databaseUrl);
const repository = new PostgresRouterRepository(pool);
const apiKeyService = new ApiKeyService(repository, config.apiKeyPepper, config.environment);
const generationService = new GenerationService(repository);
const auditService = new AuditService(repository);
const admissionService = new AdmissionService(new PostgresAdmissionStore(pool), {
  requestsPerMinute: config.limitRequestsPerMinute,
  maxConcurrent: config.limitMaxConcurrent,
  maxTokensPerRequest: config.limitMaxTokensPerRequest,
  dailyTokenLimit: config.limitDailyTokens,
  dailyBudgetMicros: config.limitDailyBudgetMicros,
});
const envelopeCipher = config.envelopeMode === "gcp-kms"
  ? new KmsEnvelopeCipher(createGoogleCloudKmsDataKeyWrapper(config.kmsCryptoKeyName!, {
      failed(operation, error) {
        const code = error instanceof Error && /checksum|CRC32C/i.test(error.message)
          ? "kms_integrity_failed"
          : "kms_operation_failed";
        metrics.kmsOperationFailed(operation, code);
        consoleGatewayLogger.error("kms_operation_failed", {
          request_id: "req_system_kms",
          operation,
          error_code: code,
        });
      },
    }))
  : localEnvelopeCipherFromBase64(config.localEnvelopeMasterKey!);
const providerCredentialService = new ProviderCredentialService(
  repository,
  envelopeCipher,
  new ProviderVerifierRegistry(new Map([
    ["mock", new MockProviderCredentialVerifier()],
    ["openai", new OpenAICompatibleCredentialVerifier(OPENAI_API_BASE_URL)],
  ])),
  config.providerMode === "openai" ? ["openai"] : [],
);
const provider = config.providerMode === "cliproxy"
  ? new FixedRoutingProvider({
      id: "cliproxy-router",
      candidates: [{
        id: "cliproxy-remote",
        adapter: new CliproxyRemoteAdapter({
          baseUrl: config.cliproxyBaseUrl!,
          apiKey: config.cliproxyApiKey!,
          timeoutMs: config.providerTimeoutMs,
        }),
        models: ["*"],
        priority: 100,
      }],
      failureThreshold: config.providerCircuitFailureThreshold,
      cooldownMs: config.providerCircuitCooldownMs,
      circuitObserver: (candidateId, state) => metrics.setCircuitState(candidateId, state),
    })
  : config.providerMode === "openai"
  ? new FixedRoutingProvider({
      id: "openai-router",
      candidates: [{
        id: "openai-official",
        adapter: new OpenAICompatibleAdapter({
          id: "openai",
          endpointId: "openai-official",
          baseUrl: OPENAI_API_BASE_URL,
          models: OPENAI_MODELS,
          credentials: providerCredentialService,
          timeoutMs: config.providerTimeoutMs,
        }),
        models: OPENAI_MODELS.filter((model) => model.status !== "disabled").map((model) => model.id),
        priority: 100,
      }],
      failureThreshold: config.providerCircuitFailureThreshold,
      cooldownMs: config.providerCircuitCooldownMs,
      circuitObserver: (candidateId, state) => metrics.setCircuitState(candidateId, state),
    })
  : new DeterministicMockProvider();
const controlAuthenticator = config.authMode === "firebase"
  ? createFirebaseAuthenticator(config.firebaseProjectId!, repository)
  : new StaticBearerAuthenticator([{
      token: config.developmentApiKey!,
      principal: {
        authType: "dev-static",
        subjectId: "user_dev",
        workspaceId: config.workspaceId,
        apiKeyId: "key_dev",
        scopes: new Set(["models:read", "chat:write", "usage:read"]),
      },
    }]);
const dataAuthenticator = new PrefixRoutingAuthenticator(
  "wan_sk_",
  new WanApiKeyAuthenticator(apiKeyService),
  controlAuthenticator,
);

const app = createGatewayApp({
  dataAuthenticator,
  controlAuthenticator,
  apiKeyService,
  providerCredentialService,
  repository,
  provider,
  audit: auditService,
  logger: consoleGatewayLogger,
  metrics,
  metricsBearerToken: config.metricsBearerToken,
  generations: generationService,
  admission: admissionService,
  admissionDefaultMaxCompletionTokens: config.limitDefaultMaxCompletionTokens,
  admissionCostMicrosPerToken: config.limitCostMicrosPerToken,
  environment: config.environment,
  allowedOrigins: config.allowedOrigins,
});
const server = createServer(app);
let refreshingDatabaseMetrics = false;
async function refreshDatabaseMetrics() {
  if (refreshingDatabaseMetrics) return;
  refreshingDatabaseMetrics = true;
  metrics.setDatabasePool({
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  });
  try {
    const stale = await pool.query<{ count: number }>(
      `SELECT count(*)::integer AS count
       FROM generations
       WHERE status = 'pending'
         AND request_started_at < now() - interval '5 minutes'`,
    );
    metrics.setDatabaseHealth(true);
    metrics.setStaleGenerations(stale.rows[0]?.count ?? 0);
  } catch {
    metrics.setDatabaseHealth(false);
  } finally {
    refreshingDatabaseMetrics = false;
  }
}
void refreshDatabaseMetrics();
const poolMetricsTimer = setInterval(() => void refreshDatabaseMetrics(), 15_000);
poolMetricsTimer.unref();

server.listen(config.port, config.host, () => {
  console.log(JSON.stringify({
    severity: "INFO",
    message: "gateway_listening",
    host: config.host,
    port: config.port,
    environment: config.environment,
  }));
});

let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(poolMetricsTimer);
  console.log(JSON.stringify({ severity: "INFO", message: "gateway_shutdown", signal }));
  server.close(async (error) => {
    await pool.end().catch(() => {});
    if (error) {
      console.error(JSON.stringify({ severity: "ERROR", message: "gateway_shutdown_failed" }));
      process.exitCode = 1;
    }
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));