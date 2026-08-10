import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderCredentialCandidate } from "../src/control/provider-credentials.js";
import { GatewayError } from "../src/errors.js";
import type { NormalizedChatRequest } from "../src/inference/contracts.js";
import {
  OpenAICompatibleAdapter,
  OpenAICompatibleCredentialVerifier,
  type ProviderCredentialAccess,
} from "../src/providers/openai-compatible.js";
import type { NormalizedChatEvent } from "../src/providers/types.js";

const MODEL = {
  id: "openai/test-model",
  upstreamId: "test-model-2026-08",
  ownedBy: "openai",
  status: "active" as const,
  capabilities: { tools: false, responseFormat: true },
};

const DISABLED_MODEL = {
  ...MODEL,
  id: "openai/disabled-model",
  upstreamId: "disabled-model-2026-08",
  status: "disabled" as const,
};

class FakeCredentialAccess implements ProviderCredentialAccess {
  calls: { workspaceId: string; provider: string; model: string }[] = [];
  invalidated: string[] = [];
  candidateIds = ["credential_a"];

  async listCredentialCandidates(
    workspaceId: string,
    provider: string,
    model: string,
  ): Promise<ProviderCredentialCandidate[]> {
    this.calls.push({ workspaceId, provider, model });
    return this.candidateIds.map((id) => ({ id, revision: `revision_${id}` }));
  }

  async withCredentialCandidate<T>(
    workspaceId: string,
    provider: string,
    model: string,
    candidate: ProviderCredentialCandidate,
    operation: (secret: string, credentialId: string) => Promise<T>,
  ): Promise<T> {
    assert.ok(this.calls.some((call) => call.workspaceId === workspaceId && call.provider === provider && call.model === model));
    return operation(`provider_secret_${candidate.id}`, candidate.id);
  }

  async markCredentialInvalid(_workspaceId: string, candidate: ProviderCredentialCandidate): Promise<void> {
    this.invalidated.push(candidate.id);
  }
}

function request(stream: boolean): NormalizedChatRequest {
  return {
    model: MODEL.id,
    messages: [{ role: "user", content: "adapter contract" }],
    stream,
    temperature: 0.2,
  };
}

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk !== undefined) controller.enqueue(encoder.encode(chunk));
      else controller.close();
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
}

async function collect(events: AsyncIterable<NormalizedChatEvent>): Promise<NormalizedChatEvent[]> {
  const result: NormalizedChatEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

test("OpenAI-compatible non-stream requests map canonical models and normalize usage", async () => {
  const credentials = new FakeCredentialAccess();
  let capturedBody: Record<string, unknown> | undefined;
  let capturedAuthorization = "";
  const adapter = new OpenAICompatibleAdapter({
    id: "openai",
    baseUrl: "https://provider.test/v1",
    models: [MODEL, DISABLED_MODEL],
    credentials,
    fetch: (async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      capturedAuthorization = new Headers(init?.headers).get("authorization") || "";
      return Response.json({
        choices: [{ message: { role: "assistant", content: "upstream answer" } }],
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
      });
    }) as typeof fetch,
  });

  assert.deepEqual(await adapter.listModels(), [{
    id: MODEL.id,
    ownedBy: "openai",
    status: "active",
    capabilities: { tools: false, responseFormat: true },
  }]);
  assert.deepEqual(await collect(adapter.chat(request(false), {
    requestId: "req_adapter_1",
    workspaceId: "workspace_a",
    signal: new AbortController().signal,
  })), [
    { type: "delta", text: "upstream answer" },
    { type: "usage", usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } },
  ]);
  assert.equal(capturedBody?.model, MODEL.upstreamId);
  assert.equal(capturedBody?.stream, false);
  assert.equal(capturedAuthorization, "Bearer provider_secret_credential_a");
  assert.deepEqual(credentials.calls, [{ workspaceId: "workspace_a", provider: "openai", model: MODEL.id }]);
  assert.throws(() => adapter.chat({ ...request(false), model: DISABLED_MODEL.id }, {
    requestId: "req_adapter_disabled",
    workspaceId: "workspace_a",
    signal: new AbortController().signal,
  }), (error: unknown) => error instanceof GatewayError && error.code === "model_not_found");
});

test("OpenAI-compatible stream handles fragmented chunks, final usage, and DONE", async () => {
  const adapter = new OpenAICompatibleAdapter({
    id: "openai",
    baseUrl: "https://provider.test/v1",
    models: [MODEL],
    credentials: new FakeCredentialAccess(),
    fetch: (async () => streamResponse([
      "data: {\"choices\":[{\"delta\":{\"content\":\"hel",
      "lo\"}}]}\n\n",
      "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":1,\"total_tokens\":3}}\n\n",
      "data: [DONE]\n\n",
    ])) as typeof fetch,
  });

  assert.deepEqual(await collect(adapter.chat(request(true), {
    requestId: "req_adapter_2",
    workspaceId: "workspace_a",
    signal: new AbortController().signal,
  })), [
    { type: "ready" },
    { type: "delta", text: "hello" },
    { type: "usage", usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } },
  ]);
});

test("OpenAI-compatible adapter normalizes provider errors without forwarding raw bodies", async () => {
  const rawSecret = "raw-upstream-secret-9918";
  const adapter = new OpenAICompatibleAdapter({
    id: "openai",
    baseUrl: "https://provider.test/v1",
    models: [MODEL],
    credentials: new FakeCredentialAccess(),
    fetch: (async () => new Response(rawSecret, { status: 429 })) as typeof fetch,
  });

  await assert.rejects(collect(adapter.chat(request(false), {
    requestId: "req_adapter_3",
    workspaceId: "workspace_a",
    signal: new AbortController().signal,
  })), (error: unknown) => {
    assert.ok(error instanceof GatewayError);
    assert.equal(error.status, 429);
    assert.equal(error.code, "provider_rate_limited");
    assert.doesNotMatch(error.message, new RegExp(rawSecret));
    return true;
  });
});

test("OpenAI-compatible adapter falls back across BYOK credentials only before output", async () => {
  const credentials = new FakeCredentialAccess();
  credentials.candidateIds = ["credential_bad", "credential_good"];
  const authorizations: string[] = [];
  const adapter = new OpenAICompatibleAdapter({
    id: "openai",
    baseUrl: "https://provider.test/v1",
    models: [MODEL],
    credentials,
    fetch: (async (_input, init) => {
      const authorization = new Headers(init?.headers).get("authorization") || "";
      authorizations.push(authorization);
      if (authorization.endsWith("credential_bad")) return new Response(null, { status: 401 });
      return streamResponse([
        "data: {\"choices\":[{\"delta\":{\"content\":\"fallback\"}}]}\n\n",
        "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1,\"total_tokens\":2}}\n\n",
        "data: [DONE]\n\n",
      ]);
    }) as typeof fetch,
  });

  assert.deepEqual(await collect(adapter.chat(request(true), {
    requestId: "req_adapter_fallback",
    workspaceId: "workspace_a",
    signal: new AbortController().signal,
  })), [
    { type: "ready" },
    { type: "delta", text: "fallback" },
    { type: "usage", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  ]);
  assert.deepEqual(authorizations, [
    "Bearer provider_secret_credential_bad",
    "Bearer provider_secret_credential_good",
  ]);
  assert.deepEqual(credentials.invalidated, ["credential_bad"]);

  credentials.candidateIds = ["credential_partial", "credential_unused"];
  authorizations.length = 0;
  const partialAdapter = new OpenAICompatibleAdapter({
    id: "openai",
    baseUrl: "https://provider.test/v1",
    models: [MODEL],
    credentials,
    fetch: (async (_input, init) => {
      authorizations.push(new Headers(init?.headers).get("authorization") || "");
      return streamResponse([
        "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n",
        "data: not-json\n\n",
      ]);
    }) as typeof fetch,
  });
  const seen: NormalizedChatEvent[] = [];
  await assert.rejects(async () => {
    for await (const event of partialAdapter.chat(request(true), {
      requestId: "req_adapter_no_retry",
      workspaceId: "workspace_a",
      signal: new AbortController().signal,
    })) seen.push(event);
  }, (error: unknown) => error instanceof GatewayError && error.code === "provider_invalid_response");
  assert.deepEqual(seen, [{ type: "ready" }, { type: "delta", text: "partial" }]);
  assert.deepEqual(authorizations, ["Bearer provider_secret_credential_partial"]);
});

test("OpenAI-compatible adapter never calls or retries upstream when attempt persistence fails", async () => {
  const credentials = new FakeCredentialAccess();
  credentials.candidateIds = ["credential_a", "credential_b"];
  let fetchCalls = 0;
  const adapter = new OpenAICompatibleAdapter({
    id: "openai",
    baseUrl: "https://provider.test/v1",
    models: [MODEL],
    credentials,
    fetch: (async () => {
      fetchCalls += 1;
      return Response.json({
        choices: [{ message: { content: "should not run" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }) as typeof fetch,
  });

  await assert.rejects(collect(adapter.chat(request(false), {
    requestId: "req_attempt_persistence",
    workspaceId: "workspace_a",
    signal: new AbortController().signal,
    attempts: {
      async begin() { throw new Error("database unavailable"); },
      async firstToken() {},
      async finish() {},
    },
  })), (error: unknown) => error instanceof GatewayError && error.code === "attempt_persistence_failed");
  assert.equal(fetchCalls, 0);
});

test("OpenAI-compatible adapter distinguishes timeout from client cancellation", async () => {
  const blockingFetch: typeof fetch = (_input, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const timeoutAdapter = new OpenAICompatibleAdapter({
    id: "openai",
    baseUrl: "https://provider.test/v1",
    models: [MODEL],
    credentials: new FakeCredentialAccess(),
    timeoutMs: 1_000,
    fetch: blockingFetch,
  });
  await assert.rejects(collect(timeoutAdapter.chat(request(false), {
    requestId: "req_adapter_4",
    workspaceId: "workspace_a",
    signal: new AbortController().signal,
  })), (error: unknown) => error instanceof GatewayError && error.status === 504 && error.code === "provider_timeout");

  const controller = new AbortController();
  const cancellation = collect(timeoutAdapter.chat(request(false), {
    requestId: "req_adapter_5",
    workspaceId: "workspace_a",
    signal: controller.signal,
  }));
  setImmediate(() => controller.abort());
  await assert.rejects(cancellation, (error: unknown) => (
    error instanceof GatewayError && error.status === 499 && error.code === "request_cancelled"
  ));
});

test("OpenAI-compatible stream rejects missing DONE or final usage", async () => {
  const withoutDone = new OpenAICompatibleAdapter({
    id: "openai",
    baseUrl: "https://provider.test/v1",
    models: [MODEL],
    credentials: new FakeCredentialAccess(),
    fetch: (async () => streamResponse(["data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n"])) as typeof fetch,
  });
  await assert.rejects(collect(withoutDone.chat(request(true), {
    requestId: "req_adapter_6",
    workspaceId: "workspace_a",
    signal: new AbortController().signal,
  })), (error: unknown) => error instanceof GatewayError && error.code === "provider_stream_incomplete");

  const withoutUsage = new OpenAICompatibleAdapter({
    id: "openai",
    baseUrl: "https://provider.test/v1",
    models: [MODEL],
    credentials: new FakeCredentialAccess(),
    fetch: (async () => streamResponse(["data: [DONE]\n\n"])) as typeof fetch,
  });
  await assert.rejects(collect(withoutUsage.chat(request(true), {
    requestId: "req_adapter_7",
    workspaceId: "workspace_a",
    signal: new AbortController().signal,
  })), (error: unknown) => error instanceof GatewayError && error.code === "provider_usage_missing");
});

test("OpenAI-compatible credential verification stays generic and cancellation-aware", async () => {
  let authorization = "";
  const accepted = new OpenAICompatibleCredentialVerifier(
    "https://provider.test/v1",
    1_000,
    (async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization") || "";
      return Response.json({ object: "list", data: [] });
    }) as typeof fetch,
  );
  assert.deepEqual(await accepted.verify("provider_verify_secret_8842", new AbortController().signal), { ok: true });
  assert.equal(authorization, "Bearer provider_verify_secret_8842");

  const rejected = new OpenAICompatibleCredentialVerifier(
    "https://provider.test/v1",
    1_000,
    (async () => new Response("raw secret detail", { status: 401 })) as typeof fetch,
  );
  assert.deepEqual(await rejected.verify("invalid-secret", new AbortController().signal), {
    ok: false,
    code: "credential_rejected",
  });

  const controller = new AbortController();
  const blocking = new OpenAICompatibleCredentialVerifier(
    "https://provider.test/v1",
    1_000,
    ((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch,
  );
  const verification = blocking.verify("provider_cancel_secret", controller.signal);
  setImmediate(() => controller.abort());
  await assert.rejects(
    verification,
    (error: unknown) => error instanceof GatewayError && error.code === "request_cancelled",
  );
});