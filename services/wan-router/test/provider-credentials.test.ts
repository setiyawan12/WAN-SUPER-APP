import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { ProviderCredentialService } from "../src/control/provider-credentials.js";
import { InMemoryRouterRepository } from "../src/data/memory.js";
import { MockProviderCredentialVerifier, ProviderVerifierRegistry } from "../src/providers/credentials.js";
import { LocalEnvelopeCipher } from "../src/security/envelope.js";

function service(repository: InMemoryRouterRepository) {
  return new ProviderCredentialService(
    repository,
    new LocalEnvelopeCipher(randomBytes(32)),
    new ProviderVerifierRegistry(new Map([["mock", new MockProviderCredentialVerifier()]])),
    ["mock", "openai"],
  );
}

test("provider credential storage contains ciphertext only and list responses stay masked", async () => {
  const repository = new InMemoryRouterRepository();
  const credentials = service(repository);
  const secret = "mock_provider_secret_probe_5941";
  const created = await credentials.create("workspace_a", {
    provider: "mock",
    name: "Primary mock",
    secret,
    modelFilters: ["mock/echo"],
    priority: 10,
  });

  const stored = await repository.findProviderCredential("workspace_a", created.id);
  assert.ok(stored);
  assert.doesNotMatch(JSON.stringify(stored), new RegExp(secret));
  assert.match(created.maskedValue, /^mock\.\.\.5941$/);
  assert.equal(Object.hasOwn(created, "secret"), false);
  assert.equal(Object.hasOwn((await credentials.list("workspace_a"))[0], "ciphertext"), false);
});

test("provider credential verify decrypts briefly, rotation replaces ciphertext, and delete is tenant scoped", async () => {
  const repository = new InMemoryRouterRepository();
  const credentials = service(repository);
  const created = await credentials.create("workspace_a", {
    provider: "mock",
    name: "Rotating mock",
    secret: "mock_provider_original_1111",
  });
  const before = await repository.findProviderCredential("workspace_a", created.id);
  const verified = await credentials.verify("workspace_a", created.id, new AbortController().signal);
  assert.equal(verified.status, "active");
  assert.ok(verified.lastVerifiedAt);

  const rotated = await credentials.update("workspace_a", created.id, { secret: "mock_provider_rotated_2222" });
  const after = await repository.findProviderCredential("workspace_a", created.id);
  assert.ok(rotated.rotatedAt);
  assert.notEqual(before?.ciphertext, after?.ciphertext);
  assert.notEqual(before?.wrappedKey, after?.wrappedKey);

  assert.equal((await credentials.list("workspace_b")).length, 0);
  await assert.rejects(credentials.delete("workspace_b", created.id));
  await credentials.delete("workspace_a", created.id);
  assert.equal(await repository.findProviderCredential("workspace_a", created.id), null);
});

test("invalid provider credential is marked invalid without exposing the secret", async () => {
  const repository = new InMemoryRouterRepository();
  const credentials = service(repository);
  const created = await credentials.create("workspace_a", {
    provider: "mock",
    name: "Invalid mock",
    secret: "invalid_provider_secret",
  });
  const verified = await credentials.verify("workspace_a", created.id, new AbortController().signal);
  assert.equal(verified.status, "invalid");
  assert.equal(verified.lastVerificationError, "Provider rejected the credential.");
  assert.doesNotMatch(JSON.stringify(verified), /invalid_provider_secret/);
});

test("provider verification persists only allowlisted failure text", async () => {
  const repository = new InMemoryRouterRepository();
  const credentials = new ProviderCredentialService(
    repository,
    new LocalEnvelopeCipher(randomBytes(32)),
    new ProviderVerifierRegistry(new Map([["mock", {
      async verify() {
        return {
          ok: false,
          code: "credential_rejected",
          error: "raw-provider-body fake_secret_4821",
        } as { ok: false; code: "credential_rejected" };
      },
    }]])),
    ["mock"],
  );
  const created = await credentials.create("workspace_a", {
    provider: "mock",
    name: "Adversarial verifier",
    secret: "mock_provider_adversarial_4821",
  });

  const verified = await credentials.verify("workspace_a", created.id, new AbortController().signal);
  assert.equal(verified.lastVerificationError, "Provider rejected the credential.");
  assert.doesNotMatch(JSON.stringify(verified), /raw-provider-body|fake_secret_4821/);
});

test("provider credential lease selects the highest-priority active credential matching the model", async () => {
  const repository = new InMemoryRouterRepository();
  const credentials = service(repository);
  await credentials.create("workspace_a", {
    provider: "openai",
    name: "Wildcard low priority",
    secret: "provider_wildcard_low_1111",
    priority: 10,
  });
  const selected = await credentials.create("workspace_a", {
    provider: "openai",
    name: "Model high priority",
    secret: "provider_model_high_2222",
    modelFilters: ["openai/test-model"],
    priority: 50,
  });
  const disabled = await credentials.create("workspace_a", {
    provider: "openai",
    name: "Disabled highest priority",
    secret: "provider_disabled_high_3333",
    priority: 100,
  });
  await credentials.update("workspace_a", disabled.id, { status: "disabled" });

  const leased = await credentials.withCredential(
    "workspace_a",
    "openai",
    "openai/test-model",
    async (secret, credentialId) => ({ secret, credentialId }),
  );
  assert.deepEqual(leased, {
    secret: "provider_model_high_2222",
    credentialId: selected.id,
  });

  const wildcard = await credentials.withCredential(
    "workspace_a",
    "openai",
    "openai/other-model",
    async (secret) => secret,
  );
  assert.equal(wildcard, "provider_wildcard_low_1111");
});

test("provider credential lease remains tenant scoped and rejects missing eligible credentials", async () => {
  const repository = new InMemoryRouterRepository();
  const credentials = service(repository);
  await credentials.create("workspace_a", {
    provider: "openai",
    name: "Tenant A only",
    secret: "provider_tenant_a_4444",
    modelFilters: ["openai/test-model"],
  });

  await assert.rejects(
    credentials.withCredential("workspace_b", "openai", "openai/test-model", async (secret) => secret),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "provider_credential_unavailable",
  );
  await assert.rejects(
    credentials.withCredential("workspace_a", "openai", "openai/unmatched", async (secret) => secret),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "provider_credential_unavailable",
  );
});

test("provider credential candidate lease rechecks eligibility and can mark a rejected credential invalid", async () => {
  const repository = new InMemoryRouterRepository();
  const credentials = service(repository);
  const created = await credentials.create("workspace_a", {
    provider: "openai",
    name: "Candidate",
    secret: "provider_candidate_secret_5555",
    modelFilters: ["openai/test-model"],
  });
  assert.deepEqual(
    await credentials.listCredentialCandidates("workspace_a", "openai", "openai/test-model"),
    [{ id: created.id, revision: (await repository.findProviderCredential("workspace_a", created.id))!.ciphertext }],
  );
  const [candidate] = await credentials.listCredentialCandidates("workspace_a", "openai", "openai/test-model");
  assert.equal(await credentials.withCredentialCandidate(
    "workspace_a",
    "openai",
    "openai/test-model",
    candidate,
    async (secret) => secret,
  ), "provider_candidate_secret_5555");

  await credentials.markCredentialInvalid("workspace_a", candidate);
  assert.deepEqual(await credentials.listCredentialCandidates("workspace_a", "openai", "openai/test-model"), []);
  const stored = await repository.findProviderCredential("workspace_a", created.id);
  assert.equal(stored?.status, "invalid");
  assert.equal(stored?.lastVerificationError, "Provider rejected the credential during inference.");
  await assert.rejects(
    credentials.withCredentialCandidate(
      "workspace_a",
      "openai",
      "openai/test-model",
      candidate,
      async (secret) => secret,
    ),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "provider_credential_unavailable",
  );
});

test("stale verification and inference results cannot invalidate a rotated credential", async () => {
  const repository = new InMemoryRouterRepository();
  const credentials = service(repository);
  const created = await credentials.create("workspace_a", {
    provider: "openai",
    name: "Race protected",
    secret: "provider_before_rotation_6666",
    modelFilters: ["openai/test-model"],
  });
  const [staleCandidate] = await credentials.listCredentialCandidates("workspace_a", "openai", "openai/test-model");
  await credentials.update("workspace_a", created.id, { secret: "provider_after_rotation_7777" });

  await credentials.markCredentialInvalid("workspace_a", staleCandidate);
  const rotated = await repository.findProviderCredential("workspace_a", created.id);
  assert.equal(rotated?.status, "active");
  assert.equal(rotated?.lastVerificationError, null);
  await assert.rejects(
    credentials.withCredentialCandidate(
      "workspace_a",
      "openai",
      "openai/test-model",
      staleCandidate,
      async (secret) => secret,
    ),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "provider_credential_unavailable",
  );
});