import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { createGatewayApp } from "../src/app.js";
import { ApiKeyService } from "../src/auth/api-keys.js";
import { StaticBearerAuthenticator } from "../src/auth/authenticator.js";
import { ProviderCredentialService } from "../src/control/provider-credentials.js";
import { InMemoryRouterRepository } from "../src/data/memory.js";
import { GenerationService } from "../src/inference/generations.js";
import type { LogFields } from "../src/observability/logger.js";
import { CliproxyRemoteAdapter } from "../src/providers/cliproxy-remote.js";
import { ProviderVerifierRegistry } from "../src/providers/credentials.js";
import { FixedRoutingProvider } from "../src/providers/fixed-router.js";
import { LocalEnvelopeCipher } from "../src/security/envelope.js";

const WAN_GATEWAY_KEY = "wan_sk_gateway_cliproxy_test";
const CLIPROXY_PROXY_KEY = "cliproxy_gateway_proxy_secret_6724";
const MODEL_ID = "claude-sonnet-4-5";
const TOOL_CALL_ID = "call_weather_123";
const TOOL_NAME = "get_weather";
const TOOL_ARGUMENTS = "{\"city\":\"Jakarta\"}";

function upstreamStream(): Response {
  const chunks = [
    "data: {\"choices\":[{\"delta\":{\"content\":\"remote \"}}]}\n\n",
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

function upstreamToolStream(): Response {
  const chunks = [
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"${TOOL_CALL_ID}","type":"function","function":{"name":"${TOOL_NAME}","arguments":"{\\"city\\":"}}]},"finish_reason":null}]}\n\n`,
    "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"Jakarta\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
    "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":8,\"completion_tokens\":4,\"total_tokens\":12}}\n\n",
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

test("gateway relays models and chat to CLIProxyAPI without forwarding WAN credentials", async () => {
  const repository = new InMemoryRouterRepository();
  const providerCredentialService = new ProviderCredentialService(
    repository,
    new LocalEnvelopeCipher(randomBytes(32)),
    new ProviderVerifierRegistry(new Map()),
  );
  const apiKeyService = new ApiKeyService(
    repository,
    "cliproxy-gateway-test-pepper-with-at-least-32-bytes",
    "dev",
  );
  const authenticator = new StaticBearerAuthenticator([{
    token: WAN_GATEWAY_KEY,
    principal: {
      authType: "dev-static",
      subjectId: "user_cliproxy",
      workspaceId: "workspace_cliproxy",
      apiKeyId: "key_cliproxy",
      scopes: new Set(["models:read", "chat:write"]),
    },
  }]);
  const upstreamRequests: Array<{
    url: string;
    authorization: string;
    requestId: string;
    body?: Record<string, unknown>;
  }> = [];
  const remote = new CliproxyRemoteAdapter({
    baseUrl: "https://cliproxy.test/v1",
    apiKey: CLIPROXY_PROXY_KEY,
    fetch: (async (input, init) => {
      const requestRecord = {
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization") || "",
        requestId: new Headers(init?.headers).get("x-request-id") || "",
        body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined,
      };
      upstreamRequests.push(requestRecord);
      if (requestRecord.url.endsWith("/models")) {
        return Response.json({
          object: "list",
          data: [{ id: MODEL_ID, object: "model", owned_by: "anthropic" }],
        });
      }
      if (Array.isArray(requestRecord.body?.tools)) {
        if (requestRecord.body?.stream === true) return upstreamToolStream();
        return Response.json({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: TOOL_CALL_ID,
                type: "function",
                function: { name: TOOL_NAME, arguments: TOOL_ARGUMENTS },
              }],
            },
            finish_reason: "tool_calls",
          }],
          usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        });
      }
      if (requestRecord.body?.stream === true) return upstreamStream();
      return Response.json({
        choices: [{ message: { role: "assistant", content: "remote completion" } }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      });
    }) as typeof fetch,
  });
  const provider = new FixedRoutingProvider({
    id: "cliproxy-router",
    candidates: [{ id: "cliproxy-remote", adapter: remote, models: ["*"], priority: 100 }],
  });
  const logs: { message: string; fields: LogFields }[] = [];
  const server = createServer(createGatewayApp({
    dataAuthenticator: authenticator,
    controlAuthenticator: authenticator,
    apiKeyService,
    providerCredentialService,
    provider,
    generations: new GenerationService(repository),
    logger: {
      info: (message, fields) => logs.push({ message, fields }),
      error: (message, fields) => logs.push({ message, fields }),
    },
    environment: "test",
  }));

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("CLIProxy gateway fixture did not start.");
    const origin = `http://127.0.0.1:${address.port}`;
    const headers = { Authorization: `Bearer ${WAN_GATEWAY_KEY}`, "Content-Type": "application/json" };

    const modelsResponse = await fetch(`${origin}/v1/models`, { headers });
    assert.equal(modelsResponse.status, 200);
    assert.deepEqual(await modelsResponse.json(), {
      object: "list",
      data: [{ id: MODEL_ID, object: "model", created: 0, owned_by: "anthropic" }],
    });

    const completionResponse = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: MODEL_ID, messages: [{ role: "user", content: "gateway relay" }] }),
    });
    assert.equal(completionResponse.status, 200);
    const completion = await completionResponse.json() as {
      id: string;
      choices: { message: { content: string } }[];
      usage: { total_tokens: number };
    };
    assert.equal(completion.choices[0].message.content, "remote completion");
    assert.equal(completion.usage.total_tokens, 5);
    assert.equal((await repository.findGeneration("workspace_cliproxy", completion.id))?.status, "succeeded");
    const completionAttempts = await repository.listProviderAttempts("workspace_cliproxy", completion.id);
    assert.equal(completionAttempts.length, 1);
    assert.equal(completionAttempts[0].providerId, "cliproxy");
    assert.equal(completionAttempts[0].endpointId, "cliproxy-remote");
    assert.equal(completionAttempts[0].credentialId, null);

    const toolRequest = {
      model: MODEL_ID,
      messages: [{ role: "user", content: "What is the weather in Jakarta?" }],
      tools: [{
        type: "function",
        function: {
          name: TOOL_NAME,
          description: "Get current weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      }],
      tool_choice: "auto",
    };
    const toolResponse = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(toolRequest),
    });
    assert.equal(toolResponse.status, 200);
    const toolCompletion = await toolResponse.json() as {
      choices: Array<{
        message: {
          content: string | null;
          tool_calls: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
        };
        finish_reason: string;
      }>;
    };
    assert.equal(toolCompletion.choices[0].message.content, null);
    assert.deepEqual(toolCompletion.choices[0].message.tool_calls, [{
      id: TOOL_CALL_ID,
      type: "function",
      function: { name: TOOL_NAME, arguments: TOOL_ARGUMENTS },
    }]);
    assert.equal(toolCompletion.choices[0].finish_reason, "tool_calls");

    const streamResponse = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: MODEL_ID, messages: [{ role: "user", content: "gateway stream" }], stream: true }),
    });
    assert.equal(streamResponse.status, 200);
    const streamText = await streamResponse.text();
    assert.match(streamText, /remote /);
    assert.match(streamText, /stream/);
    assert.equal((streamText.match(/"usage":/g) || []).length, 1);
    assert.match(streamText, /data: \[DONE\]/);

    const toolStreamResponse = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...toolRequest, stream: true }),
    });
    assert.equal(toolStreamResponse.status, 200);
    const toolStreamText = await toolStreamResponse.text();
    assert.match(toolStreamText, new RegExp(TOOL_CALL_ID));
    assert.match(toolStreamText, new RegExp(TOOL_NAME));
    assert.match(toolStreamText, /\\"city\\":/);
    assert.match(toolStreamText, /\\"Jakarta\\"/);
    assert.match(toolStreamText, /"finish_reason":"tool_calls"/);
    assert.equal((toolStreamText.match(/"usage":/g) || []).length, 1);
    assert.match(toolStreamText, /data: \[DONE\]/);

    assert.equal(upstreamRequests.length, 5);
    assert.ok(upstreamRequests.every((request) => request.authorization === `Bearer ${CLIPROXY_PROXY_KEY}`));
    assert.ok(upstreamRequests.every((request) => request.authorization !== `Bearer ${WAN_GATEWAY_KEY}`));
    assert.equal(upstreamRequests[0].url, "https://cliproxy.test/v1/models");
    assert.equal(upstreamRequests[1].body?.model, MODEL_ID);
    assert.equal(upstreamRequests[2].body?.tool_choice, "auto");
    assert.equal(upstreamRequests[3].body?.model, MODEL_ID);
    assert.equal(upstreamRequests[4].body?.tool_choice, "auto");
    assert.ok(upstreamRequests[1].requestId.startsWith("req_"));
    assert.ok(upstreamRequests[2].requestId.startsWith("req_"));
    assert.ok(upstreamRequests[3].requestId.startsWith("req_"));
    assert.ok(upstreamRequests[4].requestId.startsWith("req_"));

    const serializedLogs = JSON.stringify(logs);
    assert.doesNotMatch(serializedLogs, new RegExp(WAN_GATEWAY_KEY));
    assert.doesNotMatch(serializedLogs, new RegExp(CLIPROXY_PROXY_KEY));
    assert.doesNotMatch(serializedLogs, /gateway relay|gateway stream/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});