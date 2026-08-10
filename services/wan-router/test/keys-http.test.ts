import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { ApiKeyService, WanApiKeyAuthenticator } from "../src/auth/api-keys.js";
import { PrefixRoutingAuthenticator, StaticBearerAuthenticator } from "../src/auth/authenticator.js";
import { createGatewayApp } from "../src/app.js";
import { ProviderCredentialService } from "../src/control/provider-credentials.js";
import { InMemoryRouterRepository } from "../src/data/memory.js";
import { DeterministicMockProvider } from "../src/providers/mock.js";
import { ProviderVerifierRegistry } from "../src/providers/credentials.js";
import { LocalEnvelopeCipher } from "../src/security/envelope.js";
import { AuditService } from "../src/observability/audit.js";

const FIREBASE_TOKEN = "firebase-test-token";
const FIREBASE_TOKEN_B = "firebase-test-token-b";
const DEV_TOKEN = "development-static-token";
let server: Server;
let origin = "";
let repository: InMemoryRouterRepository;

before(async () => {
  repository = new InMemoryRouterRepository();
  const service = new ApiKeyService(
    repository,
    "http-route-pepper-material-with-at-least-32-bytes",
    "dev",
  );
  const providerCredentialService = new ProviderCredentialService(
    repository,
    new LocalEnvelopeCipher(randomBytes(32)),
    new ProviderVerifierRegistry(new Map()),
  );
  const controlAuthenticator = new StaticBearerAuthenticator([
    {
      token: FIREBASE_TOKEN,
      principal: {
        authType: "firebase",
        subjectId: "firebase_user_a",
        workspaceId: "workspace_a",
        scopes: new Set(["models:read", "chat:write", "usage:read", "keys:manage"]),
      },
    },
    {
      token: FIREBASE_TOKEN_B,
      principal: {
        authType: "firebase",
        subjectId: "firebase_user_b",
        workspaceId: "workspace_b",
        scopes: new Set(["models:read", "chat:write", "usage:read", "keys:manage"]),
      },
    },
    {
      token: DEV_TOKEN,
      principal: {
        authType: "dev-static",
        subjectId: "dev_user",
        workspaceId: "workspace_dev",
        scopes: new Set(["models:read", "chat:write", "usage:read", "keys:manage"]),
      },
    },
  ]);
  const dataAuthenticator = new PrefixRoutingAuthenticator(
    "wan_sk_",
    new WanApiKeyAuthenticator(service),
    controlAuthenticator,
  );

  server = createServer(createGatewayApp({
    dataAuthenticator,
    controlAuthenticator,
    apiKeyService: service,
    providerCredentialService,
    provider: new DeterministicMockProvider(),
    audit: new AuditService(repository),
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

function bearer(token: string, json = false): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

test("Firebase control plane creates, lists, uses, and immediately revokes a WAN API key", async () => {
  const createdResponse = await fetch(`${origin}/api/keys`, {
    method: "POST",
    headers: bearer(FIREBASE_TOKEN, true),
    body: JSON.stringify({ name: "External client", scopes: ["models:read"] }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json() as {
    id: string;
    key: string;
    prefix: string;
    scopes: string[];
  };
  assert.match(created.key, /^wan_sk_dev_/);
  assert.deepEqual(created.scopes, ["models:read"]);

  const listedResponse = await fetch(`${origin}/api/keys`, { headers: bearer(FIREBASE_TOKEN) });
  assert.equal(listedResponse.status, 200);
  const listed = await listedResponse.json() as { data: Record<string, unknown>[] };
  assert.equal(listed.data.length, 1);
  assert.equal(Object.hasOwn(listed.data[0], "key"), false);
  assert.equal(listed.data[0].prefix, created.prefix);

  const tenantBList = await fetch(`${origin}/api/keys`, { headers: bearer(FIREBASE_TOKEN_B) });
  assert.equal(tenantBList.status, 200);
  assert.equal((await tenantBList.json() as { data: unknown[] }).data.length, 0);

  const tenantBRevoke = await fetch(`${origin}/api/keys/${created.id}`, {
    method: "DELETE",
    headers: bearer(FIREBASE_TOKEN_B),
  });
  assert.equal(tenantBRevoke.status, 404);

  const modelsBeforeRevoke = await fetch(`${origin}/v1/models`, { headers: bearer(created.key) });
  assert.equal(modelsBeforeRevoke.status, 200);

  const chatWithoutScope = await fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: bearer(created.key, true),
    body: JSON.stringify({ model: "mock/echo", messages: [{ role: "user", content: "scope probe" }] }),
  });
  assert.equal(chatWithoutScope.status, 403);
  assert.equal((await chatWithoutScope.json() as { error: { code: string } }).error.code, "insufficient_scope");

  const revokedResponse = await fetch(`${origin}/api/keys/${created.id}`, {
    method: "DELETE",
    headers: bearer(FIREBASE_TOKEN),
  });
  assert.equal(revokedResponse.status, 204);

  const modelsAfterRevoke = await fetch(`${origin}/v1/models`, { headers: bearer(created.key) });
  assert.equal(modelsAfterRevoke.status, 401);
  assert.equal((await modelsAfterRevoke.json() as { error: { code: string } }).error.code, "invalid_api_key");

  const auditEvents = await repository.listAuditEvents("workspace_a");
  assert.deepEqual(auditEvents.map((event) => event.action).sort(), ["api_key.created", "api_key.revoked"]);
  assert.equal((await repository.listAuditEvents("workspace_b")).length, 0);
  assert.doesNotMatch(JSON.stringify(auditEvents), new RegExp(created.key));

  const auditResponse = await fetch(`${origin}/api/audit-events?limit=10`, { headers: bearer(FIREBASE_TOKEN) });
  assert.equal(auditResponse.status, 200);
  const auditBody = await auditResponse.json() as { data: Array<{ action: string }> };
  assert.deepEqual(auditBody.data.map((event) => event.action).sort(), ["api_key.created", "api_key.revoked"]);
  const tenantBAudit = await fetch(`${origin}/api/audit-events`, { headers: bearer(FIREBASE_TOKEN_B) });
  assert.equal(tenantBAudit.status, 200);
  assert.equal((await tenantBAudit.json() as { data: unknown[] }).data.length, 0);
});

test("non-Firebase credentials cannot access API-key management", async () => {
  const response = await fetch(`${origin}/api/keys`, { headers: bearer(DEV_TOKEN) });
  assert.equal(response.status, 403);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "firebase_session_required");

  const auditResponse = await fetch(`${origin}/api/audit-events`, { headers: bearer(DEV_TOKEN) });
  assert.equal(auditResponse.status, 403);
  assert.equal((await auditResponse.json() as { error: { code: string } }).error.code, "firebase_session_required");
});