import { z } from "zod";
import { GatewayError } from "../errors.js";
import type { NormalizedChatRequest, TokenUsage } from "../inference/contracts.js";
import { parseProviderSse } from "./sse.js";
import type { NormalizedChatEvent, ProviderAdapter, ProviderContext, ProviderModel } from "./types.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_JSON_RESPONSE_BYTES = 4 * 1_048_576;
const MAX_TOOL_CALLS = 64;
const MAX_TOOL_ARGUMENT_BYTES = 1_048_576;

const usageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
}).passthrough();

const completedToolCallSchema = z.object({
  id: z.string().min(1).max(256),
  type: z.literal("function"),
  function: z.object({
    name: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
    arguments: z.string().max(MAX_TOOL_ARGUMENT_BYTES),
  }).passthrough(),
}).passthrough();

const streamedToolCallSchema = z.object({
  index: z.number().int().min(0).max(MAX_TOOL_CALLS - 1),
  id: z.string().min(1).max(256).optional(),
  type: z.literal("function").optional(),
  function: z.object({
    name: z.string().max(128).regex(/^[a-zA-Z0-9_-]*$/).optional(),
    arguments: z.string().max(MAX_TOOL_ARGUMENT_BYTES).optional(),
  }).passthrough().optional(),
}).passthrough().refine((toolCall) => (
  toolCall.id !== undefined
  || toolCall.type !== undefined
  || toolCall.function?.name !== undefined
  || toolCall.function?.arguments !== undefined
), "Tool call delta is empty.");

const completionSchema = z.object({
  choices: z.array(z.object({
    message: z.object({
      content: z.string().nullable().optional(),
      tool_calls: z.array(completedToolCallSchema).max(MAX_TOOL_CALLS).optional(),
    }).passthrough(),
    finish_reason: z.string().nullable().optional(),
  }).passthrough()).min(1),
  usage: usageSchema,
}).passthrough();

const streamChunkSchema = z.object({
  choices: z.array(z.object({
    delta: z.object({
      content: z.string().nullable().optional(),
      tool_calls: z.array(streamedToolCallSchema).max(MAX_TOOL_CALLS).nullable().optional(),
    }).passthrough(),
    finish_reason: z.string().nullable().optional(),
  }).passthrough()).optional(),
  usage: usageSchema.nullable().optional(),
  error: z.unknown().optional(),
}).passthrough();

const modelListSchema = z.object({
  data: z.array(z.object({
    id: z.string().min(1).max(256).refine((id) => id === id.trim()),
    owned_by: z.string().min(1).max(128).optional(),
  }).passthrough()).max(10_000),
}).passthrough();

export interface CliproxyRemoteAdapterOptions {
  id?: string;
  endpointId?: string;
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface RequestAbort {
  signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
}

interface StreamedToolCallState {
  id?: string;
  type?: "function";
  name: string;
  sawArguments: boolean;
  argumentBytes: number;
}

function apiBaseUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("CLIProxyAPI base URL must be a valid URL.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("CLIProxyAPI base URL cannot contain credentials, query parameters, or a fragment.");
  }
  const loopback = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  const localHttp = parsed.protocol === "http:" && loopback.has(parsed.hostname.toLowerCase());
  if (parsed.protocol !== "https:" && !localHttp) {
    throw new Error("CLIProxyAPI base URL must use HTTPS, except for loopback development.");
  }
  const pathname = parsed.pathname.replace(/\/+$/, "");
  if (!pathname) parsed.pathname = "/v1/";
  else if (pathname.endsWith("/v1")) parsed.pathname = `${pathname}/`;
  else throw new Error("CLIProxyAPI base URL path must end in /v1.");
  return parsed;
}

function timeoutMs(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 300_000) {
    throw new Error("CLIProxyAPI timeout must be between 1000 and 300000 milliseconds.");
  }
  return timeout;
}

function requestAbort(parent: AbortSignal | undefined, timeout: number): RequestAbort {
  const controller = new AbortController();
  let timeoutTriggered = false;
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => {
    timeoutTriggered = true;
    controller.abort(new Error("CLIProxyAPI request timed out."));
  }, timeout);

  return {
    signal: controller.signal,
    timedOut: () => timeoutTriggered,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
      if (!controller.signal.aborted) controller.abort();
    },
  };
}

function upstreamError(status: number, operation: "models" | "chat"): GatewayError {
  if (operation === "chat" && status === 404) {
    return new GatewayError(404, "invalid_request_error", "model_not_found", "The requested model was not found by CLIProxyAPI.");
  }
  if (status === 400 || status === 413 || status === 422) {
    return new GatewayError(400, "invalid_request_error", "provider_invalid_request", "CLIProxyAPI rejected the request.");
  }
  if (status === 401 || status === 403) {
    return new GatewayError(502, "api_error", "provider_authentication_failed", "CLIProxyAPI rejected the proxy credential.");
  }
  if (status === 429) {
    return new GatewayError(429, "rate_limit_error", "provider_rate_limited", "The CLIProxyAPI upstream rate limit was reached.");
  }
  if (status === 408 || status === 504) {
    return new GatewayError(504, "api_error", "provider_timeout", "CLIProxyAPI timed out.");
  }
  return new GatewayError(502, "api_error", "provider_unavailable", "CLIProxyAPI could not complete the request.");
}

function mappedError(error: unknown, parent: AbortSignal | undefined, request: RequestAbort): GatewayError {
  if (error instanceof GatewayError) return error;
  if (parent?.aborted) {
    return new GatewayError(499, "request_error", "request_cancelled", "The client cancelled the request.");
  }
  if (request.timedOut()) {
    return new GatewayError(504, "api_error", "provider_timeout", "CLIProxyAPI timed out.");
  }
  return new GatewayError(502, "api_error", "provider_network_error", "CLIProxyAPI could not be reached.");
}

async function attemptOperation<T>(operation: (() => Promise<T>) | undefined): Promise<T | undefined> {
  if (!operation) return undefined;
  try {
    return await operation();
  } catch {
    throw new GatewayError(503, "api_error", "attempt_persistence_failed", "WAN Router could not persist the provider attempt.");
  }
}

async function boundedResponseText(response: Response): Promise<string> {
  if (!response.body) throw new GatewayError(502, "api_error", "provider_invalid_response", "CLIProxyAPI returned an empty response.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      bytes += value.byteLength;
      if (bytes > MAX_JSON_RESPONSE_BYTES) {
        throw new GatewayError(502, "api_error", "provider_response_too_large", "CLIProxyAPI returned an oversized response.");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    if (!completed) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function usage(value: z.infer<typeof usageSchema>): TokenUsage {
  return {
    prompt_tokens: value.prompt_tokens,
    completion_tokens: value.completion_tokens,
    total_tokens: value.total_tokens,
  };
}

export class CliproxyRemoteAdapter implements ProviderAdapter {
  readonly id: string;
  private readonly endpointId: string;
  private readonly modelsUrl: string;
  private readonly completionUrl: string;
  private readonly apiKey: string;
  private readonly timeout: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CliproxyRemoteAdapterOptions) {
    this.id = options.id ?? "cliproxy";
    this.endpointId = options.endpointId ?? "cliproxy-remote";
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(this.id)) throw new Error("CLIProxyAPI adapter ID is invalid.");
    if (!/^[a-z0-9][a-z0-9_-]{1,127}$/.test(this.endpointId)) throw new Error("CLIProxyAPI endpoint ID is invalid.");
    const baseUrl = apiBaseUrl(options.baseUrl);
    this.modelsUrl = new URL("models", baseUrl).toString();
    this.completionUrl = new URL("chat/completions", baseUrl).toString();
    this.apiKey = options.apiKey.trim();
    if (!this.apiKey || /[\u0000-\u001f\u007f]/.test(this.apiKey)) throw new Error("CLIProxyAPI proxy API key is invalid.");
    this.timeout = timeoutMs(options.timeoutMs);
    this.fetchImpl = options.fetch ?? fetch;
  }

  async listModels(): Promise<ProviderModel[]> {
    const abort = requestAbort(undefined, this.timeout);
    try {
      const response = await this.fetchImpl(this.modelsUrl, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "User-Agent": "wan-router/0.1",
        },
        signal: abort.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw upstreamError(response.status, "models");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await boundedResponseText(response));
      } catch (error) {
        if (error instanceof GatewayError) throw error;
        throw new GatewayError(502, "api_error", "provider_invalid_response", "CLIProxyAPI returned an invalid model list.");
      }
      const modelList = modelListSchema.safeParse(parsed);
      if (!modelList.success) {
        throw new GatewayError(502, "api_error", "provider_invalid_response", "CLIProxyAPI returned an invalid model list.");
      }
      const models = new Map<string, ProviderModel>();
      for (const model of modelList.data.data) {
        if (models.has(model.id)) continue;
        models.set(model.id, {
          id: model.id,
          ownedBy: model.owned_by ?? "cliproxy",
          status: "active",
          capabilities: { tools: false, responseFormat: false },
        });
      }
      return [...models.values()];
    } catch (error) {
      throw mappedError(error, undefined, abort);
    } finally {
      abort.dispose();
    }
  }

  chat(request: NormalizedChatRequest, context: ProviderContext): AsyncIterable<NormalizedChatEvent> {
    if (request.response_format) {
      throw new GatewayError(400, "invalid_request_error", "unsupported_parameter", "Remote CLIProxyAPI response_format is not normalized yet.");
    }
    return this.execute(request, context);
  }

  private async *execute(
    request: NormalizedChatRequest,
    context: ProviderContext,
  ): AsyncIterable<NormalizedChatEvent> {
    const abort = requestAbort(context.signal, this.timeout);
    let attemptId: string | undefined;
    let attemptFinished = false;
    let attemptFirstToken = false;
    const finishAttempt = async (
      status: "succeeded" | "failed" | "cancelled",
      input: { usage?: TokenUsage; errorCode?: string } = {},
    ) => {
      if (!attemptId || attemptFinished) return;
      await attemptOperation(context.attempts
        ? () => context.attempts!.finish(attemptId!, {
            status,
            usage: input.usage,
            errorCode: input.errorCode,
            completedAt: new Date(),
          })
        : undefined);
      attemptFinished = true;
    };
    const markAttemptFirstToken = async () => {
      if (!attemptId || attemptFirstToken) return;
      await attemptOperation(context.attempts
        ? () => context.attempts!.firstToken(attemptId!, new Date())
        : undefined);
      attemptFirstToken = true;
    };

    try {
      attemptId = await attemptOperation(context.attempts
        ? () => context.attempts!.begin({
            providerId: this.id,
            endpointId: this.endpointId,
            startedAt: new Date(),
          })
        : undefined);
      const response = await this.fetchImpl(this.completionUrl, {
        method: "POST",
        headers: {
          Accept: request.stream ? "text/event-stream" : "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": "wan-router/0.1",
          "X-Request-ID": context.requestId,
        },
        body: JSON.stringify({
          ...request,
          ...(request.stream ? { stream_options: { include_usage: true } } : {}),
        }),
        signal: abort.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw upstreamError(response.status, "chat");
      }

      if (!request.stream) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(await boundedResponseText(response));
        } catch (error) {
          if (error instanceof GatewayError) throw error;
          throw new GatewayError(502, "api_error", "provider_invalid_response", "CLIProxyAPI returned invalid JSON.");
        }
        const completion = completionSchema.safeParse(parsed);
        if (!completion.success) {
          throw new GatewayError(502, "api_error", "provider_invalid_response", "CLIProxyAPI returned an invalid completion response.");
        }
        const text = completion.data.choices.map((choice) => choice.message.content || "").join("");
        const toolCalls = completion.data.choices.flatMap((choice) => choice.message.tool_calls ?? []);
        if (toolCalls.length > MAX_TOOL_CALLS
          || completion.data.choices.some((choice) => (
            choice.message.tool_calls?.length && choice.finish_reason !== "tool_calls"
          ))
          || (!text && !toolCalls.length)) {
          throw new GatewayError(502, "api_error", "provider_invalid_response", "CLIProxyAPI returned an invalid completion response.");
        }
        if (toolCalls.some((toolCall) => Buffer.byteLength(toolCall.function.arguments) > MAX_TOOL_ARGUMENT_BYTES)) {
          throw new GatewayError(502, "api_error", "provider_response_too_large", "CLIProxyAPI returned oversized tool arguments.");
        }
        const finalUsage = usage(completion.data.usage);
        if (text || toolCalls.length) await markAttemptFirstToken();
        await finishAttempt("succeeded", { usage: finalUsage });
        if (text) yield { type: "delta", text };
        for (const [index, toolCall] of toolCalls.entries()) {
          yield {
            type: "tool_call_delta",
            toolCall: {
              index,
              id: toolCall.id,
              type: toolCall.type,
              function: {
                name: toolCall.function.name,
                arguments: toolCall.function.arguments,
              },
            },
          };
        }
        yield { type: "usage", usage: finalUsage };
        return;
      }

      if (!response.body || !/^text\/event-stream(?:;|$)/i.test(response.headers.get("content-type") || "")) {
        await response.body?.cancel().catch(() => {});
        throw new GatewayError(502, "api_error", "provider_invalid_response", "CLIProxyAPI did not return an SSE stream.");
      }
      yield { type: "ready" };
      let sawDone = false;
      let finalUsage: TokenUsage | undefined;
      let finalFinishReason: string | undefined;
      const streamedToolCalls = new Map<number, StreamedToolCallState>();
      for await (const data of parseProviderSse(response.body)) {
        if (data === "[DONE]") {
          sawDone = true;
          break;
        }
        let decoded: unknown;
        try {
          decoded = JSON.parse(data);
        } catch {
          throw new GatewayError(502, "api_error", "provider_invalid_response", "CLIProxyAPI returned an invalid stream event.");
        }
        const chunk = streamChunkSchema.safeParse(decoded);
        if (!chunk.success || chunk.data.error !== undefined) {
          throw new GatewayError(502, "api_error", "provider_invalid_response", "CLIProxyAPI returned an invalid stream event.");
        }
        if (chunk.data.usage) finalUsage = usage(chunk.data.usage);
        for (const choice of chunk.data.choices ?? []) {
          const text = choice.delta.content;
          if (text) {
            await markAttemptFirstToken();
            yield { type: "delta", text };
          }
          for (const toolCall of choice.delta.tool_calls ?? []) {
            let state = streamedToolCalls.get(toolCall.index);
            if (!state) {
              if (streamedToolCalls.size >= MAX_TOOL_CALLS) {
                throw new GatewayError(502, "api_error", "provider_invalid_response", "CLIProxyAPI returned too many tool calls.");
              }
              state = { name: "", sawArguments: false, argumentBytes: 0 };
              streamedToolCalls.set(toolCall.index, state);
            }
            if (toolCall.id !== undefined) {
              if (state.id !== undefined && state.id !== toolCall.id) {
                throw new GatewayError(502, "api_error", "provider_invalid_response", "CLIProxyAPI changed a streamed tool call ID.");
              }
              state.id = toolCall.id;
            }
            if (toolCall.type !== undefined) {
              if (state.type !== undefined && state.type !== toolCall.type) {
                throw new GatewayError(502, "api_error", "provider_invalid_response", "CLIProxyAPI changed a streamed tool call type.");
              }
              state.type = toolCall.type;
            }
            if (toolCall.function?.name !== undefined) {
              state.name += toolCall.function.name;
              if (state.name.length > 128 || !/^[a-zA-Z0-9_-]*$/.test(state.name)) {
                throw new GatewayError(502, "api_error", "provider_invalid_response", "CLIProxyAPI returned an invalid streamed tool name.");
              }
            }
            if (toolCall.function?.arguments !== undefined) {
              state.sawArguments = true;
              state.argumentBytes += Buffer.byteLength(toolCall.function.arguments);
              if (state.argumentBytes > MAX_TOOL_ARGUMENT_BYTES) {
                throw new GatewayError(502, "api_error", "provider_stream_too_large", "CLIProxyAPI returned oversized streamed tool arguments.");
              }
            }
            await markAttemptFirstToken();
            yield { type: "tool_call_delta", toolCall };
          }
          if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
            if (finalFinishReason !== undefined && finalFinishReason !== choice.finish_reason) {
              throw new GatewayError(502, "api_error", "provider_invalid_response", "CLIProxyAPI returned conflicting finish reasons.");
            }
            finalFinishReason = choice.finish_reason;
          }
        }
      }
      if (!sawDone) {
        throw new GatewayError(502, "api_error", "provider_stream_incomplete", "CLIProxyAPI stream ended before DONE.");
      }
      if (!finalUsage) {
        throw new GatewayError(502, "api_error", "provider_usage_missing", "CLIProxyAPI stream ended without final usage.");
      }
      if (streamedToolCalls.size) {
        const ordered = [...streamedToolCalls.entries()].sort(([left], [right]) => left - right);
        if (finalFinishReason !== "tool_calls" || ordered.some(([index, toolCall], position) => (
          index !== position
          || !toolCall.id
          || toolCall.type !== "function"
          || !toolCall.name
          || !toolCall.sawArguments
        ))) {
          throw new GatewayError(502, "api_error", "provider_invalid_response", "CLIProxyAPI returned an incomplete streamed tool call.");
        }
      } else if (finalFinishReason === "tool_calls") {
        throw new GatewayError(502, "api_error", "provider_invalid_response", "CLIProxyAPI ended with tool_calls without a tool call.");
      }
      await finishAttempt("succeeded", { usage: finalUsage });
      yield { type: "usage", usage: finalUsage };
    } catch (error) {
      const normalized = mappedError(error, context.signal, abort);
      await finishAttempt(normalized.status === 499 ? "cancelled" : "failed", { errorCode: normalized.code });
      throw normalized;
    } finally {
      if (!attemptFinished) {
        await finishAttempt(context.signal.aborted ? "cancelled" : "failed", {
          errorCode: context.signal.aborted ? "request_cancelled" : "provider_attempt_abandoned",
        });
      }
      abort.dispose();
    }
  }
}