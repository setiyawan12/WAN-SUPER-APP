import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { ApiKeyService } from "../src/auth/api-keys.js";
import { StaticBearerAuthenticator } from "../src/auth/authenticator.js";
import { createGatewayApp } from "../src/app.js";
import { ProviderCredentialService } from "../src/control/provider-credentials.js";
import { InMemoryRouterRepository } from "../src/data/memory.js";
import { GenerationService } from "../src/inference/generations.js";
import type { LogFields } from "../src/observability/logger.js";
import { ProviderVerifierRegistry } from "../src/providers/credentials.js";
import { OpenAICompatibleAdapter } from "../src/providers/openai-compatible.js";
import { LocalEnvelopeCipher } from "../src/security/envelope.js";

const GATEWAY_KEY = "wan_sk_gateway_openai_test";
const PROVIDER_SECRET = "provider_gateway_secret_6724";
const MODEL = {
  id: "openai/test-model",
  upstreamId: "test-model-2026-08",
  ownedBy: "openai",
  status: "active" as const,
  capabilities: { tools: false, responseFormat: true },
};

function upstreamStream(): Response {
  const chunks = [
    "data: {\"choices\":[{\"delta\":{\"content\":\"gateway \"}}]}\n\n",
    "data: {\"choices\":[{\"delta\":{\"content\":\"stream\"}}]}\n\n",
    "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2,\"total_tokens\":5}}\n\n",
    "data: [DONE]\n\n",
  ];
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk) controller.enqueue(encoder.encode(chunk));
      else controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
}

test("gateway routes canonical OpenAI models through an encrypted tenant BYOK credential", async () => {
  const repository = new InMemoryRouterRepository();
  const credentials = new ProviderCredentialService(
    repository,
    new LocalEnvelopeCipher(randomBytes(32)),
    new ProviderVerifierRegistry(new Map()),
    ["openai"],
  );
  const created = await credentials.create("workspace_openai", {
    provider: "openai",
    name: "Gateway fixture",
    secret: PROVIDER_SECRET,
    modelFilters: [MODEL.id],
  });
  const stored = await repository.findProviderCredential("workspace_openai", created.id);
  assert.ok(stored);
  assert.doesNotMatch(JSON.stringify(stored), new RegExp(PROVIDER_SECRET));

  const upstreamRequests: { authorization: string; body: Record<string, unknown> }[] = [];
  const provider = new OpenAICompatibleAdapter({
    id: "openai",
    baseUrl: "https://provider.test/v1",
    models: [MODEL],
    credentials,
    fetch: (async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      upstreamRequests.push({
        authorization: new Headers(init?.headers).get("authorization") || "",
        body,
      });
      if (body.stream === true) return upstreamStream();
      return Response.json({
        choices: [{ message: { role: "assistant", content: "gateway completion" } }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      });
    }) as typeof fetch,
  });
  const apiKeyService = new ApiKeyService(
    repository,
    "openai-gateway-test-pepper-with-at-least-32-bytes",
    "dev",
  );
  const authenticator = new StaticBearerAuthenticator([{
    token: GATEWAY_KEY,
    principal: {
      authType: "dev-static",
      subjectId: "user_openai",
      workspaceId: "workspace_openai",
      apiKeyId: "key_openai",
      scopes: new Set(["models:read", "chat:write"]),
    },
  }]);
  const logs: { message: string; fields: LogFields }[] = [];
  const generations = new GenerationService(repository);
  const server = createServer(createGatewayApp({
    dataAuthenticator: authenticator,
    controlAuthenticator: authenticator,
    apiKeyService,
    providerCredentialService: credentials,
    provider,
    generations,
    logger: {
      info: (message, fields) => logs.push({ message, fields }),
      error: (message, fields) => logs.push({ message, fields }),
    },
    environment: "test",
  }));

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("OpenAI gateway fixture did not start.");
    const origin = `http://127.0.0.1:${address.port}`;
    const headers = { Authorization: `Bearer ${GATEWAY_KEY}`, "Content-Type": "application/json" };

    const modelsResponse = await fetch(`${origin}/v1/models`, { headers });
    assert.equal(modelsResponse.status, 200);
    assert.deepEqual(await modelsResponse.json(), {
      object: "list",
      data: [{ id: MODEL.id, object: "model", created: 0, owned_by: "openai" }],
    });

    const completionResponse = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: MODEL.id, messages: [{ role: "user", content: "gateway" }] }),
    });
    assert.equal(completionResponse.status, 200);
    const completion = await completionResponse.json() as {
      id: string;
      choices: { message: { content: string } }[];
      usage: { total_tokens: number };
    };
    assert.equal(completion.choices[0].message.content, "gateway completion");
    assert.equal(completion.usage.total_tokens, 5);
    const storedCompletion = await repository.findGeneration("workspace_openai", completion.id);
    assert.equal(storedCompletion?.status, "succeeded");
    assert.equal(storedCompletion?.totalTokens, 5);
    assert.ok(storedCompletion?.firstTokenAt);
    const completionAttempts = await repository.listProviderAttempts("workspace_openai", completion.id);
    assert.equal(completionAttempts.length, 1);
    assert.equal(completionAttempts[0].status, "succeeded");
    assert.equal(completionAttempts[0].credentialId, created.id);
    assert.equal(completionAttempts[0].totalTokens, 5);
    assert.equal((await repository.listUsageLedger("workspace_openai", completion.id)).length, 3);

    const streamResponse = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: MODEL.id, messages: [{ role: "user", content: "gateway" }], stream: true }),
    });
    assert.equal(streamResponse.status, 200);
    const streamText = await streamResponse.text();
    assert.match(streamText, /gateway /);
    assert.match(streamText, /stream/);
    assert.equal((streamText.match(/"usage":/g) || []).length, 1);
    assert.match(streamText, /data: \[DONE\]/);
    const streamGenerationId = /"id":"(gen_[^"]+)"/.exec(streamText)?.[1];
    assert.ok(streamGenerationId);
    const storedStream = await repository.findGeneration("workspace_openai", streamGenerationId);
    assert.equal(storedStream?.status, "succeeded");
    assert.equal(storedStream?.totalTokens, 5);
    assert.ok(storedStream?.firstTokenAt);
    assert.equal((await repository.listProviderAttempts("workspace_openai", streamGenerationId)).length, 1);
    assert.equal((await repository.listUsageLedger("workspace_openai", streamGenerationId)).length, 3);

    assert.equal(upstreamRequests.length, 2);
    assert.ok(upstreamRequests.every((request) => request.authorization === `Bearer ${PROVIDER_SECRET}`));
    assert.ok(upstreamRequests.every((request) => request.body.model === MODEL.upstreamId));
    assert.doesNotMatch(JSON.stringify(logs), new RegExp(PROVIDER_SECRET));

    await credentials.update("workspace_openai", created.id, { status: "disabled" });
    const unavailableResponse = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: MODEL.id, messages: [{ role: "user", content: "unavailable" }], stream: true }),
    });
    assert.equal(unavailableResponse.status, 503);
    assert.match(unavailableResponse.headers.get("content-type") || "", /^application\/json/);
    assert.equal((await unavailableResponse.json() as { error: { code: string } }).error.code, "provider_credential_unavailable");
    const unavailableRequestId = unavailableResponse.headers.get("x-request-id");
    const failedGeneration = await repository.findGenerationByRequestId("workspace_openai", unavailableRequestId!);
    assert.ok(failedGeneration);
    assert.equal(failedGeneration.status, "failed");
    assert.deepEqual(await repository.listProviderAttempts("workspace_openai", failedGeneration.id), []);
    assert.deepEqual(await repository.listUsageLedger("workspace_openai", failedGeneration.id), []);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});