import assert from "node:assert/strict";
import { test } from "node:test";
import { GatewayError } from "../src/errors.js";
import type { NormalizedChatRequest, TokenUsage } from "../src/inference/contracts.js";
import { CliproxyRemoteAdapter } from "../src/providers/cliproxy-remote.js";
import type { NormalizedChatEvent, ProviderAttemptObserver } from "../src/providers/types.js";

const PROXY_KEY = "cliproxy_proxy_secret_8842";
const TOOL_CALL_ID = "call_remote_weather";
const TOOL_ARGUMENTS = "{\"city\":\"Jakarta\"}";

function request(stream: boolean): NormalizedChatRequest {
  return {
    model: "claude-sonnet-4-5",
    messages: [{ role: "user", content: "remote adapter contract" }],
    stream,
    temperature: 0.2,
  };
}

function toolRequest(stream: boolean): NormalizedChatRequest {
  return {
    ...request(stream),
    tools: [{
      type: "function",
      function: {
        name: "get_weather",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    }],
    tool_choice: "auto",
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

test("Cliproxy remote adapter discovers live models with its server-side proxy key", async () => {
  let capturedUrl = "";
  let capturedAuthorization = "";
  const adapter = new CliproxyRemoteAdapter({
    baseUrl: "https://cliproxy.test/router/v1",
    apiKey: PROXY_KEY,
    fetch: (async (input, init) => {
      capturedUrl = String(input);
      capturedAuthorization = new Headers(init?.headers).get("authorization") || "";
      return Response.json({
        object: "list",
        data: [
          { id: "claude-sonnet-4-5", owned_by: "anthropic" },
          { id: "gemini-2.5-pro", owned_by: "google" },
          { id: "claude-sonnet-4-5", owned_by: "duplicate" },
        ],
      });
    }) as typeof fetch,
  });

  assert.deepEqual(await adapter.listModels(), [
    {
      id: "claude-sonnet-4-5",
      ownedBy: "anthropic",
      status: "active",
      capabilities: { tools: false, responseFormat: false },
    },
    {
      id: "gemini-2.5-pro",
      ownedBy: "google",
      status: "active",
      capabilities: { tools: false, responseFormat: false },
    },
  ]);
  assert.equal(capturedUrl, "https://cliproxy.test/router/v1/models");
  assert.equal(capturedAuthorization, `Bearer ${PROXY_KEY}`);
});

test("Cliproxy remote adapter preserves model IDs and records non-stream attempts", async () => {
  let capturedUrl = "";
  let capturedBody: Record<string, unknown> | undefined;
  let capturedHeaders = new Headers();
  const attemptEvents: Array<Record<string, unknown>> = [];
  const attempts: ProviderAttemptObserver = {
    async begin(input) {
      attemptEvents.push({ event: "begin", ...input });
      return "attempt_remote_1";
    },
    async firstToken(attemptId, at) {
      attemptEvents.push({ event: "first_token", attemptId, at });
    },
    async finish(attemptId, input) {
      attemptEvents.push({ event: "finish", attemptId, ...input });
    },
  };
  const adapter = new CliproxyRemoteAdapter({
    baseUrl: "https://cliproxy.test/v1/",
    apiKey: PROXY_KEY,
    fetch: (async (input, init) => {
      capturedUrl = String(input);
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      capturedHeaders = new Headers(init?.headers);
      return Response.json({
        choices: [{ message: { role: "assistant", content: "remote answer" } }],
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
      });
    }) as typeof fetch,
  });

  assert.deepEqual(await collect(adapter.chat(request(false), {
    requestId: "req_remote_1",
    workspaceId: "workspace_a",
    signal: new AbortController().signal,
    attempts,
  })), [
    { type: "delta", text: "remote answer" },
    { type: "usage", usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } },
  ]);
  assert.equal(capturedUrl, "https://cliproxy.test/v1/chat/completions");
  assert.equal(capturedBody?.model, "claude-sonnet-4-5");
  assert.equal(capturedHeaders.get("authorization"), `Bearer ${PROXY_KEY}`);
  assert.equal(capturedHeaders.get("x-request-id"), "req_remote_1");
  assert.equal(attemptEvents[0].providerId, "cliproxy");
  assert.equal(attemptEvents[0].endpointId, "cliproxy-remote");
  assert.equal(attemptEvents[0].credentialId, undefined);
  assert.equal(attemptEvents[1].event, "first_token");
  assert.equal(attemptEvents[2].status, "succeeded");
  assert.deepEqual(attemptEvents[2].usage, { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 });
});

test("Cliproxy remote adapter handles fragmented SSE and forces final usage", async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const adapter = new CliproxyRemoteAdapter({
    baseUrl: "https://cliproxy.test/v1",
    apiKey: PROXY_KEY,
    fetch: (async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return streamResponse([
        "data: {\"choices\":[{\"delta\":{\"content\":\"hel",
        "lo\",\"tool_calls\":null}}]}\n\n",
        "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":1,\"total_tokens\":3}}\n\n",
        "data: [DONE]\n\n",
      ]);
    }) as typeof fetch,
  });

  assert.deepEqual(await collect(adapter.chat(request(true), {
    requestId: "req_remote_2",
    workspaceId: "workspace_a",
    signal: new AbortController().signal,
  })), [
    { type: "ready" },
    { type: "delta", text: "hello" },
    { type: "usage", usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } },
  ]);
  assert.deepEqual(capturedBody?.stream_options, { include_usage: true });
});

test("Cliproxy remote adapter normalizes non-stream tool calls", async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const adapter = new CliproxyRemoteAdapter({
    baseUrl: "https://cliproxy.test/v1",
    apiKey: PROXY_KEY,
    fetch: (async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        choices: [{
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: TOOL_CALL_ID,
              type: "function",
              function: { name: "get_weather", arguments: TOOL_ARGUMENTS },
            }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
      });
    }) as typeof fetch,
  });

  assert.deepEqual(await collect(adapter.chat(toolRequest(false), {
    requestId: "req_remote_tool_non_stream",
    workspaceId: "workspace_a",
    signal: new AbortController().signal,
  })), [
    {
      type: "tool_call_delta",
      toolCall: {
        index: 0,
        id: TOOL_CALL_ID,
        type: "function",
        function: { name: "get_weather", arguments: TOOL_ARGUMENTS },
      },
    },
    { type: "usage", usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } },
  ]);
  assert.equal(capturedBody?.tool_choice, "auto");
  assert.equal(Array.isArray(capturedBody?.tools), true);
});

test("Cliproxy remote adapter preserves fragmented streamed tool-call deltas", async () => {
  const adapter = new CliproxyRemoteAdapter({
    baseUrl: "https://cliproxy.test/v1",
    apiKey: PROXY_KEY,
    fetch: (async () => streamResponse([
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"${TOOL_CALL_ID}","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":"}}]},"finish_reason":null}]}\n\n`,
      "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"Jakarta\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
      "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":8,\"completion_tokens\":4,\"total_tokens\":12}}\n\n",
      "data: [DONE]\n\n",
    ])) as typeof fetch,
  });

  assert.deepEqual(await collect(adapter.chat(toolRequest(true), {
    requestId: "req_remote_tool_stream",
    workspaceId: "workspace_a",
    signal: new AbortController().signal,
  })), [
    { type: "ready" },
    {
      type: "tool_call_delta",
      toolCall: {
        index: 0,
        id: TOOL_CALL_ID,
        type: "function",
        function: { name: "get_weather", arguments: "{\"city\":" },
      },
    },
    {
      type: "tool_call_delta",
      toolCall: { index: 0, function: { arguments: "\"Jakarta\"}" } },
    },
    { type: "usage", usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } },
  ]);
});

test("Cliproxy remote adapter rejects incomplete tool calls", async () => {
  const adapter = new CliproxyRemoteAdapter({
    baseUrl: "https://cliproxy.test/v1",
    apiKey: PROXY_KEY,
    fetch: (async () => Response.json({
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            type: "function",
            function: { name: "get_weather", arguments: TOOL_ARGUMENTS },
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    })) as typeof fetch,
  });

  await assert.rejects(collect(adapter.chat(toolRequest(false), {
    requestId: "req_remote_tool_invalid",
    workspaceId: "workspace_a",
    signal: new AbortController().signal,
  })), (error: unknown) => (
    error instanceof GatewayError && error.code === "provider_invalid_response"
  ));
});

test("Cliproxy remote adapter normalizes upstream errors without exposing bodies", async () => {
  const rawSecret = "raw-cli-proxy-error-secret-9918";
  const adapter = new CliproxyRemoteAdapter({
    baseUrl: "https://cliproxy.test/v1",
    apiKey: PROXY_KEY,
    fetch: (async () => new Response(rawSecret, { status: 401 })) as typeof fetch,
  });

  await assert.rejects(collect(adapter.chat(request(false), {
    requestId: "req_remote_3",
    workspaceId: "workspace_a",
    signal: new AbortController().signal,
  })), (error: unknown) => {
    assert.ok(error instanceof GatewayError);
    assert.equal(error.status, 502);
    assert.equal(error.code, "provider_authentication_failed");
    assert.doesNotMatch(error.message, new RegExp(rawSecret));
    return true;
  });
});

test("Cliproxy remote adapter rejects response formats that are not normalized", () => {
  let fetchCalls = 0;
  const adapter = new CliproxyRemoteAdapter({
    baseUrl: "https://cliproxy.test/v1",
    apiKey: PROXY_KEY,
    fetch: (async () => {
      fetchCalls += 1;
      return Response.json({});
    }) as typeof fetch,
  });
  const context = {
    requestId: "req_remote_capabilities",
    workspaceId: "workspace_a",
    signal: new AbortController().signal,
  };

  assert.throws(() => adapter.chat({
    ...request(false),
    response_format: { type: "json_object" },
  }, context), (error: unknown) => error instanceof GatewayError && error.code === "unsupported_parameter");
  assert.equal(fetchCalls, 0);
});

test("Cliproxy remote adapter propagates client cancellation", async () => {
  const adapter = new CliproxyRemoteAdapter({
    baseUrl: "http://127.0.0.1:8317",
    apiKey: PROXY_KEY,
    fetch: ((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch,
  });
  const controller = new AbortController();
  const pending = collect(adapter.chat(request(false), {
    requestId: "req_remote_cancel",
    workspaceId: "workspace_a",
    signal: controller.signal,
  }));
  setImmediate(() => controller.abort());

  await assert.rejects(
    pending,
    (error: unknown) => error instanceof GatewayError && error.status === 499 && error.code === "request_cancelled",
  );
});

test("Cliproxy remote adapter rejects unsafe or ambiguous base URLs", () => {
  assert.throws(() => new CliproxyRemoteAdapter({
    baseUrl: "http://cliproxy.test/v1",
    apiKey: PROXY_KEY,
  }), /must use HTTPS/);
  assert.throws(() => new CliproxyRemoteAdapter({
    baseUrl: "https://cliproxy.test/api",
    apiKey: PROXY_KEY,
  }), /must end in \/v1/);
  assert.throws(() => new CliproxyRemoteAdapter({
    baseUrl: "https://user:password@cliproxy.test/v1",
    apiKey: PROXY_KEY,
  }), /cannot contain credentials/);
});