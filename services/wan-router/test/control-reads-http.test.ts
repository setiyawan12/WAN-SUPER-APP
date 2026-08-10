import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { ApiKeyService } from "../src/auth/api-keys.js";
import { StaticBearerAuthenticator } from "../src/auth/authenticator.js";
import { createGatewayApp } from "../src/app.js";
import { ProviderCredentialService } from "../src/control/provider-credentials.js";
import { InMemoryRouterRepository } from "../src/data/memory.js";
import { GenerationService } from "../src/inference/generations.js";
import { ProviderVerifierRegistry } from "../src/providers/credentials.js";
import { DeterministicMockProvider } from "../src/providers/mock.js";
import { LocalEnvelopeCipher } from "../src/security/envelope.js";

const FIREBASE_A_TOKEN = "firebase-control-read-a";
const FIREBASE_B_TOKEN = "firebase-control-read-b";
const FIREBASE_NO_SCOPE_TOKEN = "firebase-control-read-no-scope";
const DEV_TOKEN = "dev-control-read";
const API_KEY_PRINCIPAL_TOKEN = "api-key-control-read";
const SUCCESS_ID = "gen_control_read_success";
const FAILED_ID = "gen_control_read_failed";
const logger = { info() {}, error() {} };
let server: Server;
let origin = "";

before(async () => {
  const repository = new InMemoryRouterRepository();
  const generations = new GenerationService(repository);
  for (let index = 0; index < 51; index += 1) {
    await generations.start({
      id: `gen_control_history_${String(index).padStart(2, "0")}`,
      workspaceId: "workspace_a",
      requestId: `req_control_history_${index}`,
      requestedModel: "mock/history",
      startedAt: new Date(Date.parse("2026-08-10T00:00:00.000Z") + index * 1_000),
    });
  }
  await generations.start({
    id: FAILED_ID,
    workspaceId: "workspace_a",
    requestId: "req_control_read_failed",
    requestedModel: "mock/requested",
    startedAt: new Date("2026-08-10T01:00:00.000Z"),
  });
  await generations.fail({
    workspaceId: "workspace_a",
    generationId: FAILED_ID,
    status: "failed",
    errorCode: "provider_raw_body_private_marker",
    completedAt: new Date("2026-08-10T01:00:05.000Z"),
  });
  await generations.start({
    id: SUCCESS_ID,
    workspaceId: "workspace_a",
    apiKeyId: "api_key_metadata_a",
    requestId: "req_control_read_success",
    requestedModel: "mock/requested",
    startedAt: new Date("2026-08-10T02:00:00.000Z"),
  });
  const attempts = generations.attempts("workspace_a", SUCCESS_ID);
  const attemptId = await attempts.begin({
    providerId: "provider_private_marker",
    endpointId: "endpoint-a",
    credentialId: "credential_secret_marker",
    startedAt: new Date("2026-08-10T02:00:00.000Z"),
  });
  const usage = { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13, estimated: true };
  await attempts.firstToken(attemptId, new Date("2026-08-10T02:00:01.000Z"));
  await attempts.finish(attemptId, {
    status: "succeeded",
    usage,
    completedAt: new Date("2026-08-10T02:00:03.000Z"),
  });
  await generations.firstToken("workspace_a", SUCCESS_ID, new Date("2026-08-10T02:00:01.000Z"));
  await generations.succeed({
    workspaceId: "workspace_a",
    generationId: SUCCESS_ID,
    resolvedModel: "mock/resolved",
    usage,
    completedAt: new Date("2026-08-10T02:00:03.000Z"),
  });
  await generations.start({
    id: "gen_control_read_workspace_b",
    workspaceId: "workspace_b",
    requestId: "req_control_read_workspace_b",
    requestedModel: "mock/workspace-b-private",
    startedAt: new Date("2026-08-10T03:00:00.000Z"),
  });

  const controlAuthenticator = new StaticBearerAuthenticator([
    {
      token: FIREBASE_A_TOKEN,
      principal: {
        authType: "firebase",
        subjectId: "firebase_control_a",
        workspaceId: "workspace_a",
        scopes: new Set(["usage:read"]),
      },
    },
    {
      token: FIREBASE_B_TOKEN,
      principal: {
        authType: "firebase",
        subjectId: "firebase_control_b",
        workspaceId: "workspace_b",
        scopes: new Set(["usage:read"]),
      },
    },
    {
      token: FIREBASE_NO_SCOPE_TOKEN,
      principal: {
        authType: "firebase",
        subjectId: "firebase_control_no_scope",
        workspaceId: "workspace_a",
        scopes: new Set(["models:read"]),
      },
    },
    {
      token: DEV_TOKEN,
      principal: {
        authType: "dev-static",
        subjectId: "dev_control_read",
        workspaceId: "workspace_a",
        scopes: new Set(["usage:read"]),
      },
    },
    {
      token: API_KEY_PRINCIPAL_TOKEN,
      principal: {
        authType: "api-key",
        subjectId: "key_control_read",
        workspaceId: "workspace_a",
        apiKeyId: "key_control_read",
        scopes: new Set(["usage:read"]),
      },
    },
  ]);
  const apiKeyService = new ApiKeyService(
    repository,
    "control-read-http-pepper-material-at-least-32-bytes",
    "dev",
  );
  const providerCredentialService = new ProviderCredentialService(
    repository,
    new LocalEnvelopeCipher(randomBytes(32)),
    new ProviderVerifierRegistry(new Map()),
  );
  server = createServer(createGatewayApp({
    dataAuthenticator: controlAuthenticator,
    controlAuthenticator,
    apiKeyService,
    providerCredentialService,
    repository,
    provider: new DeterministicMockProvider(),
    generations,
    logger,
    environment: "test",
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not expose a TCP address.");
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

test("generation history returns the exact sanitized metadata contract newest first", async () => {
  const response = await fetch(`${origin}/api/generations?limit=2`, { headers: bearer(FIREBASE_A_TOKEN) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, {
    data: [
      {
        id: SUCCESS_ID,
        requestId: "req_control_read_success",
        apiKeyId: "api_key_metadata_a",
        requestedModel: "mock/requested",
        resolvedModel: "mock/resolved",
        providerEndpointId: "endpoint-a",
        status: "succeeded",
        promptTokens: 9,
        completionTokens: 4,
        totalTokens: 13,
        usageEstimated: true,
        requestStartedAt: "2026-08-10T02:00:00.000Z",
        firstTokenAt: "2026-08-10T02:00:01.000Z",
        completedAt: "2026-08-10T02:00:03.000Z",
      },
      {
        id: FAILED_ID,
        requestId: "req_control_read_failed",
        apiKeyId: null,
        requestedModel: "mock/requested",
        resolvedModel: null,
        providerEndpointId: null,
        status: "failed",
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        usageEstimated: null,
        requestStartedAt: "2026-08-10T01:00:00.000Z",
        firstTokenAt: null,
        completedAt: "2026-08-10T01:00:05.000Z",
      },
    ],
  });
  assert.doesNotMatch(
    JSON.stringify(body),
    /credential_secret_marker|provider_private_marker|provider_raw_body_private_marker|workspace_b/i,
  );
});

test("generation history defaults to 50, validates 1 through 200, and ignores tenant query input", async () => {
  const defaultResponse = await fetch(`${origin}/api/generations`, { headers: bearer(FIREBASE_A_TOKEN) });
  assert.equal(defaultResponse.status, 200);
  assert.equal((await defaultResponse.json() as { data: unknown[] }).data.length, 50);

  for (const query of ["limit=0", "limit=201", "limit=1.5", "limit=1e2", "limit=1&limit=2"]) {
    const response = await fetch(`${origin}/api/generations?${query}`, { headers: bearer(FIREBASE_A_TOKEN) });
    assert.equal(response.status, 400);
    const body = await response.json() as { error: { code: string; request_id: string } };
    assert.equal(body.error.code, "invalid_generation_limit");
    assert.equal(body.error.request_id, response.headers.get("x-request-id"));
  }

  const tenantBResponse = await fetch(
    `${origin}/api/generations?limit=200&workspaceId=workspace_a`,
    { headers: bearer(FIREBASE_B_TOKEN) },
  );
  assert.equal(tenantBResponse.status, 200);
  assert.deepEqual(
    (await tenantBResponse.json() as { data: Array<{ id: string }> }).data.map(({ id }) => id),
    ["gen_control_read_workspace_b"],
  );
});

test("usage returns exact workspace totals, status counts, and estimated generation count", async () => {
  const response = await fetch(`${origin}/api/usage`, { headers: bearer(FIREBASE_A_TOKEN) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    totals: { promptTokens: 9, completionTokens: 4, totalTokens: 13 },
    generations: { total: 53, succeeded: 1, failed: 1, cancelled: 0, pending: 51 },
    estimatedGenerations: 1,
  });

  const tenantBResponse = await fetch(`${origin}/api/usage?workspaceId=workspace_a`, {
    headers: bearer(FIREBASE_B_TOKEN),
  });
  assert.equal(tenantBResponse.status, 200);
  assert.deepEqual(await tenantBResponse.json(), {
    totals: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    generations: { total: 1, succeeded: 0, failed: 0, cancelled: 0, pending: 1 },
    estimatedGenerations: 0,
  });
});

test("generation and usage controls require Firebase usage read principals", async () => {
  for (const path of ["/api/generations", "/api/usage"]) {
    const unauthenticated = await fetch(`${origin}${path}`);
    assert.equal(unauthenticated.status, 401);
    assert.equal((await unauthenticated.json() as { error: { code: string } }).error.code, "invalid_api_key");

    const missingScope = await fetch(`${origin}${path}`, { headers: bearer(FIREBASE_NO_SCOPE_TOKEN) });
    assert.equal(missingScope.status, 403);
    assert.equal((await missingScope.json() as { error: { code: string } }).error.code, "insufficient_scope");

    for (const token of [DEV_TOKEN, API_KEY_PRINCIPAL_TOKEN]) {
      const nonFirebase = await fetch(`${origin}${path}`, { headers: bearer(token) });
      assert.equal(nonFirebase.status, 403);
      assert.equal(
        (await nonFirebase.json() as { error: { code: string } }).error.code,
        "firebase_session_required",
      );
    }
  }
});