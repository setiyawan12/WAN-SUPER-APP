import assert from "node:assert/strict";
import { test } from "node:test";
import { GatewayError } from "../src/errors.js";
import type { NormalizedChatRequest } from "../src/inference/contracts.js";
import { FixedRoutingProvider } from "../src/providers/fixed-router.js";
import type { NormalizedChatEvent, ProviderAdapter, ProviderContext, ProviderModel } from "../src/providers/types.js";

const MODEL: ProviderModel = {
  id: "openai/test-model",
  ownedBy: "openai",
  status: "active",
  capabilities: { tools: false, responseFormat: false },
};

const REQUEST: NormalizedChatRequest = {
  model: MODEL.id,
  messages: [{ role: "user", content: "route" }],
  stream: true,
};

const CONTEXT = (): ProviderContext => ({
  requestId: "req_fixed_route",
  workspaceId: "workspace_a",
  signal: new AbortController().signal,
});

class FixtureProvider implements ProviderAdapter {
  calls = 0;

  constructor(
    readonly id: string,
    private readonly behavior: () => AsyncIterable<NormalizedChatEvent>,
  ) {}

  async listModels(): Promise<ProviderModel[]> {
    return [MODEL];
  }

  chat(): AsyncIterable<NormalizedChatEvent> {
    this.calls += 1;
    return this.behavior();
  }
}

async function collect(events: AsyncIterable<NormalizedChatEvent>): Promise<NormalizedChatEvent[]> {
  const result: NormalizedChatEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function failBefore(error: GatewayError): AsyncIterable<NormalizedChatEvent> {
  return (async function* () {
    throw error;
  })();
}

function readyThenFail(error: GatewayError): AsyncIterable<NormalizedChatEvent> {
  return (async function* () {
    yield { type: "ready" } as const;
    throw error;
  })();
}

function succeed(text: string): AsyncIterable<NormalizedChatEvent> {
  return (async function* () {
    yield { type: "ready" } as const;
    yield { type: "delta", text } as const;
    yield { type: "usage", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } as const;
  })();
}

test("fixed router wildcard candidates expose and route discovered models", async () => {
  const remote = new FixtureProvider("remote", () => succeed("dynamic"));
  const router = new FixedRoutingProvider({
    candidates: [{ id: "remote", adapter: remote, models: ["*"], priority: 100 }],
  });

  assert.deepEqual(await router.listModels(), [MODEL]);
  assert.deepEqual(await collect(router.chat(REQUEST, CONTEXT())), [
    { type: "ready" },
    { type: "delta", text: "dynamic" },
    { type: "usage", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  ]);
});

test("fixed router falls back in priority order after a transient pre-token failure", async () => {
  const primary = new FixtureProvider("primary", () => failBefore(
    new GatewayError(429, "rate_limit_error", "provider_rate_limited", "limited"),
  ));
  const secondary = new FixtureProvider("secondary", () => succeed("secondary"));
  const router = new FixedRoutingProvider({
    candidates: [
      { id: "secondary", adapter: secondary, models: [MODEL.id], priority: 10 },
      { id: "primary", adapter: primary, models: [MODEL.id], priority: 100 },
    ],
  });

  assert.deepEqual(await collect(router.chat(REQUEST, CONTEXT())), [
    { type: "ready" },
    { type: "delta", text: "secondary" },
    { type: "usage", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  ]);
  assert.equal(primary.calls, 1);
  assert.equal(secondary.calls, 1);
});

test("fixed router falls back after readiness but before the first output event", async () => {
  const primary = new FixtureProvider("primary", () => readyThenFail(
    new GatewayError(502, "api_error", "provider_network_error", "stream failed before token"),
  ));
  const secondary = new FixtureProvider("secondary", () => succeed("secondary"));
  const router = new FixedRoutingProvider({
    candidates: [
      { id: "primary", adapter: primary, models: [MODEL.id], priority: 100 },
      { id: "secondary", adapter: secondary, models: [MODEL.id], priority: 10 },
    ],
  });

  assert.deepEqual(await collect(router.chat(REQUEST, CONTEXT())), [
    { type: "ready" },
    { type: "ready" },
    { type: "delta", text: "secondary" },
    { type: "usage", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  ]);
});

test("fixed router never falls back for request errors or after output starts", async () => {
  const requestFailure = new FixtureProvider("request-failure", () => failBefore(
    new GatewayError(400, "invalid_request_error", "provider_invalid_request", "invalid"),
  ));
  const unused = new FixtureProvider("unused", () => succeed("unused"));
  const requestRouter = new FixedRoutingProvider({
    candidates: [
      { id: "request-failure", adapter: requestFailure, models: [MODEL.id], priority: 100 },
      { id: "unused", adapter: unused, models: [MODEL.id], priority: 10 },
    ],
  });
  await assert.rejects(collect(requestRouter.chat(REQUEST, CONTEXT())), (error: unknown) => (
    error instanceof GatewayError && error.code === "provider_invalid_request"
  ));
  assert.equal(unused.calls, 0);

  const partial = new FixtureProvider("partial", () => (async function* () {
    yield { type: "delta", text: "partial" } as const;
    throw new GatewayError(502, "api_error", "provider_network_error", "failed after output");
  })());
  const afterOutput = new FixtureProvider("after-output", () => succeed("duplicate"));
  const streamRouter = new FixedRoutingProvider({
    candidates: [
      { id: "partial", adapter: partial, models: [MODEL.id], priority: 100 },
      { id: "after-output", adapter: afterOutput, models: [MODEL.id], priority: 10 },
    ],
    failureThreshold: 1,
  });
  const seen: NormalizedChatEvent[] = [];
  await assert.rejects(async () => {
    for await (const event of streamRouter.chat(REQUEST, CONTEXT())) seen.push(event);
  }, (error: unknown) => error instanceof GatewayError && error.code === "provider_network_error");
  assert.deepEqual(seen, [{ type: "delta", text: "partial" }]);
  assert.equal(afterOutput.calls, 0);
  assert.deepEqual(await collect(streamRouter.chat(REQUEST, CONTEXT())), [
    { type: "ready" },
    { type: "delta", text: "duplicate" },
    { type: "usage", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  ]);
  assert.equal(partial.calls, 1);
  assert.equal(afterOutput.calls, 1);

  const partialTool = new FixtureProvider("partial-tool", () => (async function* () {
    yield { type: "ready" } as const;
    yield {
      type: "tool_call_delta",
      toolCall: {
        index: 0,
        id: "call_route_test",
        type: "function",
        function: { name: "lookup", arguments: "{\"query\":" },
      },
    } as const;
    throw new GatewayError(502, "api_error", "provider_network_error", "failed after tool output");
  })());
  const afterToolOutput = new FixtureProvider("after-tool-output", () => succeed("duplicate tool call"));
  const toolRouter = new FixedRoutingProvider({
    candidates: [
      { id: "partial-tool", adapter: partialTool, models: [MODEL.id], priority: 100 },
      { id: "after-tool-output", adapter: afterToolOutput, models: [MODEL.id], priority: 10 },
    ],
  });
  const seenToolEvents: NormalizedChatEvent[] = [];
  await assert.rejects(async () => {
    for await (const event of toolRouter.chat(REQUEST, CONTEXT())) seenToolEvents.push(event);
  }, (error: unknown) => error instanceof GatewayError && error.code === "provider_network_error");
  assert.deepEqual(seenToolEvents, [
    { type: "ready" },
    {
      type: "tool_call_delta",
      toolCall: {
        index: 0,
        id: "call_route_test",
        type: "function",
        function: { name: "lookup", arguments: "{\"query\":" },
      },
    },
  ]);
  assert.equal(afterToolOutput.calls, 0);
});

test("fixed router preserves a single candidate transient error", async () => {
  const provider = new FixtureProvider("only", () => failBefore(
    new GatewayError(429, "rate_limit_error", "provider_rate_limited", "limited"),
  ));
  const router = new FixedRoutingProvider({
    candidates: [{ id: "only", adapter: provider, models: [MODEL.id], priority: 100 }],
  });

  await assert.rejects(collect(router.chat(REQUEST, CONTEXT())), (error: unknown) => (
    error instanceof GatewayError && error.status === 429 && error.code === "provider_rate_limited"
  ));
});

test("fixed router opens a failing circuit, skips it, and retries after cooldown", async () => {
  let now = 1_000;
  let primaryFails = true;
  const circuitEvents: Array<{ candidateId: string; state: "closed" | "open" }> = [];
  const primary = new FixtureProvider("primary", () => primaryFails
    ? failBefore(new GatewayError(503, "api_error", "provider_unavailable", "down"))
    : succeed("primary"));
  const secondary = new FixtureProvider("secondary", () => succeed("secondary"));
  const router = new FixedRoutingProvider({
    candidates: [
      { id: "primary", adapter: primary, models: [MODEL.id], priority: 100 },
      { id: "secondary", adapter: secondary, models: [MODEL.id], priority: 10 },
    ],
    failureThreshold: 2,
    cooldownMs: 5_000,
    now: () => now,
    circuitObserver: (candidateId, state) => circuitEvents.push({ candidateId, state }),
  });

  await collect(router.chat(REQUEST, CONTEXT()));
  await collect(router.chat(REQUEST, CONTEXT()));
  await collect(router.chat(REQUEST, CONTEXT()));
  assert.equal(primary.calls, 2);
  assert.equal(secondary.calls, 3);
  assert.ok(circuitEvents.some((event) => event.candidateId === "primary" && event.state === "open"));

  now += 5_001;
  primaryFails = false;
  assert.deepEqual((await collect(router.chat(REQUEST, CONTEXT()))).slice(0, 2), [
    { type: "ready" },
    { type: "delta", text: "primary" },
  ]);
  assert.equal(primary.calls, 3);
  assert.equal(secondary.calls, 3);
  assert.equal(circuitEvents.at(-1)?.state, "closed");
});

test("fixed router merges configured active model metadata once", async () => {
  const primary = new FixtureProvider("primary", () => succeed("primary"));
  const secondary = new FixtureProvider("secondary", () => succeed("secondary"));
  const router = new FixedRoutingProvider({
    candidates: [
      { id: "primary", adapter: primary, models: [MODEL.id], priority: 100 },
      { id: "secondary", adapter: secondary, models: [MODEL.id], priority: 10 },
    ],
  });

  assert.deepEqual(await router.listModels(), [MODEL]);
});