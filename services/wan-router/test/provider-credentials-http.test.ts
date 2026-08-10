import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { ApiKeyService } from "../src/auth/api-keys.js";
import { StaticBearerAuthenticator } from "../src/auth/authenticator.js";
import { createGatewayApp } from "../src/app.js";
import { ProviderCredentialService } from "../src/control/provider-credentials.js";
import { InMemoryRouterRepository } from "../src/data/memory.js";
import { MockProviderCredentialVerifier, ProviderVerifierRegistry } from "../src/providers/credentials.js";
import { DeterministicMockProvider } from "../src/providers/mock.js";
import { LocalEnvelopeCipher } from "../src/security/envelope.js";
import { AuditService } from "../src/observability/audit.js";

const TOKEN_A = "firebase-provider-a";
const TOKEN_B = "firebase-provider-b";
const SECRET = "mock_provider_http_secret_7529";
let server: Server;
let origin = "";
let repository: InMemoryRouterRepository;

before(async () => {
  repository = new InMemoryRouterRepository();
  const apiKeyService = new ApiKeyService(repository, "provider-http-api-key-pepper-at-least-32-bytes", "dev");
  const providerCredentialService = new ProviderCredentialService(
    repository,
    new LocalEnvelopeCipher(randomBytes(32)),
    new ProviderVerifierRegistry(new Map([["mock", new MockProviderCredentialVerifier()]])),
    ["mock"],
  );
  const authenticator = new StaticBearerAuthenticator([
    {
      token: TOKEN_A,
      principal: {
        authType: "firebase",
        subjectId: "provider-user-a",
        workspaceId: "workspace_a",
        scopes: new Set(["models:read", "chat:write", "providers:manage"]),
      },
    },
    {
      token: TOKEN_B,
      principal: {
        authType: "firebase",
        subjectId: "provider-user-b",
        workspaceId: "workspace_b",
        scopes: new Set(["models:read", "chat:write", "providers:manage"]),
      },
    },
  ]);

  server = createServer(createGatewayApp({
    dataAuthenticator: authenticator,
    controlAuthenticator: authenticator,
    apiKeyService,
    providerCredentialService,
    provider: new DeterministicMockProvider(),
    audit: new AuditService(repository),
    environment: "test",
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Provider credential test server did not start.");
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

function headers(token: string, json = false): Record<string, string> {
  return { Authorization: `Bearer ${token}`, ...(json ? { "Content-Type": "application/json" } : {}) };
}

test("runtime capabilities are Firebase-only and expose no tenant or secret metadata", async () => {
  const response = await fetch(`${origin}/api/me`, { headers: headers(TOKEN_A) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, { capabilities: { providerCredentialProviders: ["mock"] } });
  assert.doesNotMatch(JSON.stringify(body), /workspace_a|provider-user-a|secret|ciphertext/i);
});

test("disabled direct providers are rejected before credential storage", async () => {
  const response = await fetch(`${origin}/api/provider-credentials`, {
    method: "POST",
    headers: headers(TOKEN_A, true),
    body: JSON.stringify({
      provider: "openai",
      name: "Disabled OpenAI",
      secret: "sk-disabled-provider-secret-7529",
    }),
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "provider_not_enabled");
  assert.equal((await repository.listProviderCredentials("workspace_a")).length, 0);
});

test("provider credential HTTP lifecycle stays masked and tenant scoped", async () => {
  const createdResponse = await fetch(`${origin}/api/provider-credentials`, {
    method: "POST",
    headers: headers(TOKEN_A, true),
    body: JSON.stringify({ provider: "mock", name: "HTTP mock", secret: SECRET, modelFilters: ["mock/echo"] }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json() as { id: string; maskedValue: string; status: string };
  assert.equal(Object.hasOwn(created, "secret"), false);
  assert.equal(created.maskedValue, "mock...7529");

  const listA = await fetch(`${origin}/api/provider-credentials`, { headers: headers(TOKEN_A) });
  const bodyA = await listA.json() as { data: Record<string, unknown>[] };
  assert.equal(bodyA.data.length, 1);
  assert.doesNotMatch(JSON.stringify(bodyA), new RegExp(SECRET));

  const listB = await fetch(`${origin}/api/provider-credentials`, { headers: headers(TOKEN_B) });
  assert.equal((await listB.json() as { data: unknown[] }).data.length, 0);

  const tenantBVerify = await fetch(`${origin}/api/provider-credentials/${created.id}/verify`, {
    method: "POST",
    headers: headers(TOKEN_B),
  });
  assert.equal(tenantBVerify.status, 404);

  const verified = await fetch(`${origin}/api/provider-credentials/${created.id}/verify`, {
    method: "POST",
    headers: headers(TOKEN_A),
  });
  assert.equal(verified.status, 200);
  assert.equal((await verified.json() as { status: string }).status, "active");

  const rotated = await fetch(`${origin}/api/provider-credentials/${created.id}`, {
    method: "PATCH",
    headers: headers(TOKEN_A, true),
    body: JSON.stringify({ secret: "mock_provider_rotated_http_8642", priority: 20 }),
  });
  assert.equal(rotated.status, 200);
  const rotatedBody = await rotated.json() as { maskedValue: string; rotatedAt: string | null; priority: number };
  assert.equal(rotatedBody.maskedValue, "mock...8642");
  assert.ok(rotatedBody.rotatedAt);
  assert.equal(rotatedBody.priority, 20);

  const deleted = await fetch(`${origin}/api/provider-credentials/${created.id}`, {
    method: "DELETE",
    headers: headers(TOKEN_A),
  });
  assert.equal(deleted.status, 204);
  assert.equal((await fetch(`${origin}/api/provider-credentials`, { headers: headers(TOKEN_A) }).then((response) => response.json()) as { data: unknown[] }).data.length, 0);
  const auditEvents = await repository.listAuditEvents("workspace_a");
  assert.deepEqual(auditEvents.map((event) => event.action).sort(), [
    "provider_credential.created",
    "provider_credential.deleted",
    "provider_credential.updated",
    "provider_credential.verified",
  ]);
  assert.equal((await repository.listAuditEvents("workspace_b")).length, 0);
  assert.doesNotMatch(JSON.stringify(auditEvents), /mock_provider_http_secret_7529|mock_provider_rotated_http_8642/);
});