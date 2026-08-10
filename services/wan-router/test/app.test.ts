import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { StaticBearerAuthenticator } from "../src/auth/authenticator.js";
import { ApiKeyService } from "../src/auth/api-keys.js";
import { createGatewayApp } from "../src/app.js";
import { ProviderCredentialService } from "../src/control/provider-credentials.js";
import { InMemoryRouterRepository } from "../src/data/memory.js";
import { GenerationService } from "../src/inference/generations.js";
import type { GatewayLogger, LogFields } from "../src/observability/logger.js";
import { createGatewayMetrics } from "../src/observability/metrics.js";
import { AuditService } from "../src/observability/audit.js";
import type { AuditRecorder } from "../src/observability/audit.js";
import { DeterministicMockProvider } from "../src/providers/mock.js";
import { ProviderVerifierRegistry } from "../src/providers/credentials.js";
import { LocalEnvelopeCipher } from "../src/security/envelope.js";

const API_KEY = "wan_sk_dev_test_secret";
const METRICS_TOKEN = "metrics_test_token_with_at_least_32_bytes_8194";
const logs: { message: string; fields: LogFields }[] = [];
const logger: GatewayLogger = {
  info: (message, fields) => logs.push({ message, fields }),
  error: (message, fields) => logs.push({ message, fields }),
};

let server: Server;
let origin = "";
let repository: InMemoryRouterRepository;

before(async () => {
  repository = new InMemoryRouterRepository();
  const apiKeyService = new ApiKeyService(
    repository,
    "app-test-pepper-material-with-at-least-32-bytes",
    "dev",
  );
  const providerCredentialService = new ProviderCredentialService(
    repository,
    new LocalEnvelopeCipher(randomBytes(32)),
    new ProviderVerifierRegistry(new Map()),
  );
  const authenticator = new StaticBearerAuthenticator([{
    token: API_KEY,
    principal: {
      authType: "dev-static",
      subjectId: "user_test",
      workspaceId: "workspace_test",
      apiKeyId: "key_test",
      scopes: new Set(["models:read", "chat:write"]),
    },
  }]);
  server = createServer(createGatewayApp({
    dataAuthenticator: authenticator,
    controlAuthenticator: authenticator,
    apiKeyService,
    providerCredentialService,
    provider: new DeterministicMockProvider(),
    generations: new GenerationService(repository),
    logger,
    metrics: createGatewayMetrics(),
    metricsBearerToken: METRICS_TOKEN,
    audit: new AuditService(repository),
    environment: "test",
    allowedOrigins: ["http://client.test"],
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not expose a TCP address.");
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return { Authorization: `Bearer ${API_KEY}`, ...extra };
}

test("health endpoint is public and does not expose credentials", async () => {
  const response = await fetch(`${origin}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok", environment: "test", provider: "mock" });
  assert.ok(response.headers.get("x-request-id")?.startsWith("req_"));
});

test("models require auth and use normalized errors", async () => {
  const response = await fetch(`${origin}/v1/models`);
  assert.equal(response.status, 401);
  const body = await response.json() as { error: { code: string; request_id: string } };
  assert.equal(body.error.code, "invalid_api_key");
  assert.equal(body.error.request_id, response.headers.get("x-request-id"));
});

test("models return the OpenAI-compatible list shape", async () => {
  const response = await fetch(`${origin}/v1/models`, { headers: authHeaders() });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    object: "list",
    data: [
      { id: "mock/echo", object: "model", created: 0, owned_by: "wan-mock" },
      { id: "mock/slow", object: "model", created: 0, owned_by: "wan-mock" },
    ],
  });
});

test("metrics require a dedicated token and expose bounded Prometheus labels", async () => {
  const unauthenticated = await fetch(`${origin}/metrics`);
  assert.equal(unauthenticated.status, 401);

  const wanCredential = await fetch(`${origin}/metrics`, { headers: authHeaders() });
  assert.equal(wanCredential.status, 401);

  const chat = await fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      model: "mock/echo",
      messages: [{ role: "user", content: "metrics private prompt 4058" }],
    }),
  });
  assert.equal(chat.status, 200);
  await chat.arrayBuffer();

  const response = await fetch(`${origin}/metrics`, {
    headers: { Authorization: `Bearer ${METRICS_TOKEN}` },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /^text\/plain/);
  const body = await response.text();
  assert.match(body, /wan_router_http_requests_total/);
  assert.match(body, /wan_router_generation_total\{status="succeeded",stream="false"\} 1/);
  assert.match(body, /wan_router_provider_attempts_total\{provider="mock",status="succeeded",code="none"\} 1/);
  assert.match(body, /wan_router_tokens_total\{dimension="total",estimated="true"\}/);
  assert.doesNotMatch(body, /workspace_test|key_test|wan_sk_|metrics private prompt 4058/);
});

test("browser CORS uses an exact allowlist and never replaces authentication", async () => {
  const preflight = await fetch(`${origin}/v1/models`, {
    method: "OPTIONS",
    headers: {
      Origin: "http://client.test",
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "Authorization",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "http://client.test");
  assert.equal(
    preflight.headers.get("access-control-allow-methods"),
    "GET, POST, PATCH, DELETE, OPTIONS",
  );

  const stillUnauthenticated = await fetch(`${origin}/v1/models`, {
    headers: { Origin: "http://client.test" },
  });
  assert.equal(stillUnauthenticated.status, 401);

  const denied = await fetch(`${origin}/v1/models`, {
    headers: { Origin: "http://attacker.test", Authorization: `Bearer ${API_KEY}` },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
});

test("non-stream chat returns deterministic output and usage", async () => {
  const response = await fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      model: "mock/echo",
      messages: [{ role: "user", content: "contract probe 9472" }],
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as {
    id: string;
    choices: { message: { content: string } }[];
    usage: { total_tokens: number; estimated: boolean };
  };
  assert.equal(body.choices[0].message.content, "Mock response: contract probe 9472");
  assert.ok(body.usage.total_tokens > 0);
  assert.equal(body.usage.estimated, true);
  assert.equal((await repository.findGeneration("workspace_test", body.id))?.status, "succeeded");
  assert.equal((await repository.listProviderAttempts("workspace_test", body.id))[0]?.status, "succeeded");
  assert.equal((await repository.listUsageLedger("workspace_test", body.id)).length, 3);
  const generationLog = logs.find(({ message, fields }) => (
    message === "generation_finalized" && fields.generation_id === body.id
  ));
  assert.ok(generationLog);
  assert.equal(generationLog.fields.generation_status, "succeeded");
  assert.equal(generationLog.fields.requested_model, "mock/echo");
  assert.equal(generationLog.fields.resolved_model, "mock/echo");
  assert.equal(generationLog.fields.total_tokens, body.usage.total_tokens);
  assert.equal(generationLog.fields.usage_estimated, true);
  assert.equal(typeof generationLog.fields.latency_ms, "number");
  assert.equal(typeof generationLog.fields.ttft_ms, "number");
  const auditEvents = await repository.listAuditEvents("workspace_test");
  const generationAudit = auditEvents.find((event) => event.resourceId === body.id);
  assert.equal(generationAudit?.action, "generation.succeeded");
  assert.equal(generationAudit?.outcome, "succeeded");
  assert.equal(generationAudit?.metadata.total_tokens, body.usage.total_tokens);
});

test("stream chat emits chunks, one usage event, and DONE", async () => {
  const response = await fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      model: "mock/echo",
      messages: [{ role: "user", content: "stream contract" }],
      stream: true,
      stream_options: { include_usage: true },
    }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /^text\/event-stream/);
  const text = await response.text();
  assert.match(text, /chat\.completion\.chunk/);
  assert.equal((text.match(/"usage":/g) || []).length, 1);
  assert.match(text, /data: \[DONE\]/);
});

test("client cancellation closes the stream and records an internal 499", async () => {
  const controller = new AbortController();
  const response = await fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      model: "mock/slow",
      messages: [{ role: "user", content: "abort contract" }],
      stream: true,
    }),
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const requestId = response.headers.get("x-request-id");
  controller.abort();
  await assert.rejects(response.text(), (error: unknown) => error instanceof Error && error.name === "AbortError");
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  assert.ok(logs.some(({ fields }) => fields.status === 499 && fields.error_code === "request_cancelled"));
  const generation = await repository.findGenerationByRequestId("workspace_test", requestId!);
  assert.equal(generation?.status, "cancelled");
  assert.equal(generation?.errorCode, "request_cancelled");
  const attempts = await repository.listProviderAttempts("workspace_test", generation!.id);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, "cancelled");
  assert.deepEqual(await repository.listUsageLedger("workspace_test", generation!.id), []);
  const generationLogs = logs.filter(({ message, fields }) => (
    message === "generation_finalized" && fields.generation_id === generation!.id
  ));
  assert.equal(generationLogs.length, 1);
  assert.equal(generationLogs[0].fields.generation_status, "cancelled");
  assert.equal(generationLogs[0].fields.error_code, "request_cancelled");
  assert.equal(generationLogs[0].fields.total_tokens, undefined);
  const auditEvents = await repository.listAuditEvents("workspace_test");
  const cancellationAudit = auditEvents.filter((event) => event.resourceId === generation!.id);
  assert.equal(cancellationAudit.length, 1);
  assert.equal(cancellationAudit[0].action, "generation.cancelled");
  assert.equal(cancellationAudit[0].outcome, "cancelled");
});

test("provider failures emit one allowlisted generation lifecycle event", async () => {
  const response = await fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      model: "mock/missing",
      messages: [{ role: "user", content: "failure prompt must stay private 6193" }],
    }),
  });
  assert.equal(response.status, 404);
  const requestId = response.headers.get("x-request-id");
  const body = await response.json() as { error: { code: string } };
  assert.equal(body.error.code, "model_not_found");
  const generation = await repository.findGenerationByRequestId("workspace_test", requestId!);
  assert.equal(generation?.status, "failed");
  const generationLogs = logs.filter(({ message, fields }) => (
    message === "generation_finalized" && fields.generation_id === generation!.id
  ));
  assert.equal(generationLogs.length, 1);
  assert.equal(generationLogs[0].fields.generation_status, "failed");
  assert.equal(generationLogs[0].fields.error_code, "model_not_found");
  assert.equal(generationLogs[0].fields.total_tokens, undefined);
  const auditEvents = await repository.listAuditEvents("workspace_test");
  const failureAudit = auditEvents.filter((event) => event.resourceId === generation!.id);
  assert.equal(failureAudit.length, 1);
  assert.equal(failureAudit[0].action, "generation.failed");
  assert.equal(failureAudit[0].metadata.error_code, "model_not_found");
});

test("unsupported parameters are rejected instead of ignored", async () => {
  const response = await fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      model: "mock/echo",
      messages: [{ role: "user", content: "hello" }],
      imaginary_parameter: true,
    }),
  });
  assert.equal(response.status, 400);
  const body = await response.json() as { error: { code: string } };
  assert.equal(body.error.code, "unsupported_parameter");
});

test("malformed JSON receives a normalized client error", async () => {
  const response = await fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: "{not-json",
  });
  assert.equal(response.status, 400);
  const body = await response.json() as { error: { code: string } };
  assert.equal(body.error.code, "invalid_json");
});

test("structured logs never contain prompt or Bearer secrets", async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  const serialized = JSON.stringify(logs);
  assert.doesNotMatch(serialized, /contract probe 9472/);
  assert.doesNotMatch(serialized, /failure prompt must stay private 6193/);
  assert.doesNotMatch(serialized, new RegExp(API_KEY));
  assert.doesNotMatch(JSON.stringify(await repository.listAuditEvents("workspace_test")), /contract probe 9472|failure prompt must stay private 6193/);
});

test("audit persistence failures raise a bounded metric without leaking payloads", async () => {
  const failureRepository = new InMemoryRouterRepository();
  const failureLogs: { message: string; fields: LogFields }[] = [];
  const failureMetrics = createGatewayMetrics();
  const failingAudit: AuditRecorder = {
    async record() {
      throw new Error("audit sink raw failure detail must stay private");
    },
    async list() { return []; },
  };
  const apiKeyService = new ApiKeyService(
    failureRepository,
    "audit-failure-test-pepper-with-at-least-32-bytes",
    "dev",
  );
  const providerCredentialService = new ProviderCredentialService(
    failureRepository,
    new LocalEnvelopeCipher(randomBytes(32)),
    new ProviderVerifierRegistry(new Map()),
  );
  const authenticator = new StaticBearerAuthenticator([{
    token: "audit-failure-test-token",
    principal: {
      authType: "dev-static",
      subjectId: "audit_failure_user",
      workspaceId: "audit_failure_workspace",
      apiKeyId: "audit_failure_key",
      scopes: new Set(["chat:write"]),
    },
  }]);
  const failureServer = createServer(createGatewayApp({
    dataAuthenticator: authenticator,
    controlAuthenticator: authenticator,
    apiKeyService,
    providerCredentialService,
    provider: new DeterministicMockProvider(),
    generations: new GenerationService(failureRepository),
    audit: failingAudit,
    metrics: failureMetrics,
    metricsBearerToken: METRICS_TOKEN,
    logger: {
      info: (message, fields) => failureLogs.push({ message, fields }),
      error: (message, fields) => failureLogs.push({ message, fields }),
    },
    environment: "test",
  }));

  try {
    await new Promise<void>((resolve) => failureServer.listen(0, "127.0.0.1", resolve));
    const address = failureServer.address();
    if (!address || typeof address === "string") throw new Error("Audit failure test server did not start.");
    const failureOrigin = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${failureOrigin}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: "Bearer audit-failure-test-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "mock/echo",
        messages: [{ role: "user", content: "audit failure private prompt 7741" }],
      }),
    });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    const metricResponse = await fetch(`${failureOrigin}/metrics`, {
      headers: { Authorization: `Bearer ${METRICS_TOKEN}` },
    });
    const metricsBody = await metricResponse.text();
    assert.match(metricsBody, /wan_router_audit_failures_total\{action="generation\.succeeded"\} 1/);
    assert.ok(failureLogs.some(({ message, fields }) => (
      message === "audit_event_failed" && fields.error_code === "audit_persistence_failed"
    )));
    assert.doesNotMatch(
      JSON.stringify(failureLogs),
      /audit failure private prompt 7741|audit sink raw failure detail must stay private/,
    );
  } finally {
    await new Promise<void>((resolve, reject) => failureServer.close((error) => error ? reject(error) : resolve()));
  }
});