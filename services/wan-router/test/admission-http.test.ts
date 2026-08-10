import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { AdmissionService } from "../src/admission/limits.js";
import { InMemoryAdmissionStore } from "../src/admission/memory.js";
import { ApiKeyService } from "../src/auth/api-keys.js";
import { StaticBearerAuthenticator } from "../src/auth/authenticator.js";
import { createGatewayApp } from "../src/app.js";
import { ProviderCredentialService } from "../src/control/provider-credentials.js";
import { InMemoryRouterRepository } from "../src/data/memory.js";
import { GenerationService } from "../src/inference/generations.js";
import { ProviderVerifierRegistry } from "../src/providers/credentials.js";
import { DeterministicMockProvider } from "../src/providers/mock.js";
import { LocalEnvelopeCipher } from "../src/security/envelope.js";

const API_KEY = "wan_sk_admission_http_test";

test("gateway parallel admission never exceeds hard concurrency and releases completed slots", async () => {
  const repository = new InMemoryRouterRepository();
  const authenticator = new StaticBearerAuthenticator([{
    token: API_KEY,
    principal: {
      authType: "dev-static",
      subjectId: "user_admission",
      workspaceId: "workspace_admission",
      apiKeyId: "key_admission",
      scopes: new Set(["chat:write"]),
    },
  }]);
  const server = createServer(createGatewayApp({
    dataAuthenticator: authenticator,
    controlAuthenticator: authenticator,
    apiKeyService: new ApiKeyService(repository, "admission-http-pepper-with-at-least-32-bytes", "dev"),
    providerCredentialService: new ProviderCredentialService(
      repository,
      new LocalEnvelopeCipher(randomBytes(32)),
      new ProviderVerifierRegistry(new Map()),
    ),
    provider: new DeterministicMockProvider(),
    generations: new GenerationService(repository),
    admission: new AdmissionService(new InMemoryAdmissionStore(), {
      requestsPerMinute: 100,
      maxConcurrent: 2,
      maxTokensPerRequest: 1_000,
      dailyTokenLimit: 10_000,
    }),
    logger: { info() {}, error() {} },
    environment: "test",
  }));

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Admission fixture server did not start.");
    const origin = `http://127.0.0.1:${address.port}`;
    const call = (index: number) => fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "mock/slow",
        messages: [{ role: "user", content: `parallel ${index}` }],
        stream: true,
        max_tokens: 20,
      }),
    });

    const responses = await Promise.all(Array.from({ length: 12 }, (_, index) => call(index)));
    const accepted = responses.filter((response) => response.status === 200);
    const rejected = responses.filter((response) => response.status === 429);
    assert.equal(accepted.length, 2);
    assert.equal(rejected.length, 10);
    for (const response of rejected) {
      assert.equal((await response.json() as { error: { code: string } }).error.code, "concurrency_limit_exceeded");
      const generation = await repository.findGenerationByRequestId(
        "workspace_admission",
        response.headers.get("x-request-id")!,
      );
      assert.equal(generation?.status, "failed");
      assert.equal(generation?.errorCode, "concurrency_limit_exceeded");
    }
    await Promise.all(accepted.map((response) => response.text()));

    const afterRelease = await call(99);
    assert.equal(afterRelease.status, 200);
    await afterRelease.text();
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});