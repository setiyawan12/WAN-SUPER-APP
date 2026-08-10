import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiKeyService } from "../src/auth/api-keys.js";
import { InMemoryRouterRepository } from "../src/data/memory.js";
import { GatewayError } from "../src/errors.js";

const PEPPER = "test-only-pepper-material-with-at-least-32-bytes";

test("API key plaintext is returned once while storage contains only a digest", async () => {
  const repository = new InMemoryRouterRepository();
  const service = new ApiKeyService(repository, PEPPER, "dev");
  const created = await service.create("workspace_a", {
    name: "CI key",
    scopes: ["models:read", "chat:write"],
  });

  assert.match(created.key, /^wan_sk_dev_[0-9a-f-]{36}_[A-Za-z0-9_-]+$/);
  assert.match(created.prefix, /^wan_sk_dev_[0-9a-f]{8}\.\.\.$/);
  const stored = await repository.findApiKeyById(created.id);
  assert.ok(stored);
  assert.notEqual(stored.digest, created.key);
  assert.doesNotMatch(JSON.stringify(stored), new RegExp(created.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(Object.hasOwn((await service.list("workspace_a"))[0], "key"), false);
});

test("API keys authenticate with stored scopes and revoke immediately", async () => {
  const repository = new InMemoryRouterRepository();
  const service = new ApiKeyService(repository, PEPPER, "dev");
  const created = await service.create("workspace_a", {
    name: "Runtime key",
    scopes: ["models:read", "chat:write"],
  });

  const principal = await service.authenticate(created.key);
  assert.equal(principal.authType, "api-key");
  assert.equal(principal.workspaceId, "workspace_a");
  assert.deepEqual([...principal.scopes], ["models:read", "chat:write"]);

  await service.revoke("workspace_a", created.id);
  await assert.rejects(
    service.authenticate(created.key),
    (error: unknown) => error instanceof GatewayError && error.code === "invalid_api_key",
  );
});

test("workspace scoping blocks cross-tenant list and revoke", async () => {
  const repository = new InMemoryRouterRepository();
  const service = new ApiKeyService(repository, PEPPER, "dev");
  const created = await service.create("workspace_a", {
    name: "Tenant A",
    scopes: ["models:read"],
  });

  assert.equal((await service.list("workspace_b")).length, 0);
  await assert.rejects(
    service.revoke("workspace_b", created.id),
    (error: unknown) => error instanceof GatewayError && error.code === "api_key_not_found",
  );
  assert.equal((await service.authenticate(created.key)).workspaceId, "workspace_a");
});