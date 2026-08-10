import { z } from "zod";
import type { ProviderCredentialCandidate } from "../control/provider-credentials.js";
import { GatewayError } from "../errors.js";
import type { NormalizedChatRequest, TokenUsage } from "../inference/contracts.js";
import type { CredentialVerificationResult, ProviderCredentialVerifier } from "./credentials.js";
import { parseProviderSse } from "./sse.js";
import type { NormalizedChatEvent, ProviderAdapter, ProviderContext, ProviderModel } from "./types.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_JSON_RESPONSE_BYTES = 4 * 1_048_576;

const usageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
}).passthrough();

const completionSchema = z.object({
  choices: z.array(z.object({
    message: z.object({ content: z.string().nullable() }).passthrough(),
  }).passthrough()).min(1),
  usage: usageSchema,
}).passthrough();

const streamChunkSchema = z.object({
  choices: z.array(z.object({
    delta: z.object({ content: z.string().nullable().optional() }).passthrough(),
  }).passthrough()).optional(),
  usage: usageSchema.nullable().optional(),
  error: z.unknown().optional(),
}).passthrough();

export interface ProviderCredentialAccess {
  listCredentialCandidates(
    workspaceId: string,
    provider: string,
    model: string,
  ): Promise<ProviderCredentialCandidate[]>;
  withCredentialCandidate<T>(
    workspaceId: string,
    provider: string,
    model: string,
    candidate: ProviderCredentialCandidate,
    operation: (secret: string, credentialId: string) => Promise<T>,
  ): Promise<T>;
  markCredentialInvalid(workspaceId: string, candidate: ProviderCredentialCandidate): Promise<void>;
}

export interface OpenAICompatibleModel extends ProviderModel {
  upstreamId: string;
}

export interface OpenAICompatibleAdapterOptions {
  id: string;
  endpointId?: string;
  baseUrl: string;
  models: readonly OpenAICompatibleModel[];
  credentials: ProviderCredentialAccess;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface RequestAbort {
  signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
}

function requestAbort(parent: AbortSignal, timeoutMs: number): RequestAbort {
  const controller = new AbortController();
  let timeoutTriggered = false;
  const abortFromParent = () => controller.abort(parent.reason);
  if (parent.aborted) abortFromParent();
  else parent.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => {
    timeoutTriggered = true;
    controller.abort(new Error("Provider request timed out."));
  }, timeoutMs);

  return {
    signal: controller.signal,
    timedOut: () => timeoutTriggered,
    dispose() {
      clearTimeout(timer);
      parent.removeEventListener("abort", abortFromParent);
      if (!controller.signal.aborted) controller.abort();
    },
  };
}

function providerUrl(baseUrl: string, path: string): string {
  const parsed = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  if (parsed.protocol !== "https:") throw new Error("OpenAI-compatible provider URL must use HTTPS.");
  return new URL(path, parsed).toString();
}

function providerTimeout(timeoutMs: number | undefined, fallback: number): number {
  const value = timeoutMs ?? fallback;
  if (!Number.isInteger(value) || value < 1_000 || value > 300_000) {
    throw new Error("Provider timeout must be between 1000 and 300000 milliseconds.");
  }
  return value;
}

function providerError(status: number): GatewayError {
  if (status === 400 || status === 413 || status === 422) {
    return new GatewayError(400, "invalid_request_error", "provider_invalid_request", "The provider rejected the request.");
  }
  if (status === 401 || status === 403) {
    return new GatewayError(502, "api_error", "provider_authentication_failed", "The provider credential was rejected.");
  }
  if (status === 429) {
    return new GatewayError(429, "rate_limit_error", "provider_rate_limited", "The provider rate limit was reached.");
  }
  if (status === 408 || status === 504) {
    return new GatewayError(504, "api_error", "provider_timeout", "The provider timed out.");
  }
  return new GatewayError(502, "api_error", "provider_unavailable", "The provider could not complete the request.");
}

function mappedError(error: unknown, parentSignal: AbortSignal, request: RequestAbort): GatewayError {
  if (error instanceof GatewayError) return error;
  if (parentSignal.aborted) {
    return new GatewayError(499, "request_error", "request_cancelled", "The client cancelled the request.");
  }
  if (request.timedOut()) {
    return new GatewayError(504, "api_error", "provider_timeout", "The provider timed out.");
  }
  return new GatewayError(502, "api_error", "provider_network_error", "The provider could not be reached.");
}

function retryableBeforeOutput(error: GatewayError): boolean {
  return error.code !== "attempt_persistence_failed" && (error.status === 429 || error.status >= 500);
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
  if (!response.body) throw new GatewayError(502, "api_error", "provider_invalid_response", "The provider returned an empty response.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_JSON_RESPONSE_BYTES) {
        throw new GatewayError(502, "api_error", "provider_response_too_large", "The provider returned an oversized response.");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
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

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly id: string;
  private readonly completionUrl: string;
  private readonly endpointId: string;
  private readonly models: ReadonlyMap<string, OpenAICompatibleModel>;
  private readonly credentials: ProviderCredentialAccess;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAICompatibleAdapterOptions) {
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(options.id)) throw new Error("Provider ID is invalid.");
    if (!options.models.length) throw new Error("OpenAI-compatible provider requires at least one model.");
    const models = new Map<string, OpenAICompatibleModel>();
    for (const model of options.models) {
      if (!model.id.startsWith(`${options.id}/`) || !model.upstreamId.trim()) {
        throw new Error("Provider model IDs must be canonical and include an upstream ID.");
      }
      if (models.has(model.id)) throw new Error(`Duplicate provider model: ${model.id}`);
      models.set(model.id, {
        ...model,
        capabilities: { ...model.capabilities },
      });
    }
    this.id = options.id;
    this.endpointId = options.endpointId ?? `${options.id}-official`;
    if (!/^[a-z0-9][a-z0-9_-]{1,127}$/.test(this.endpointId)) throw new Error("Provider endpoint ID is invalid.");
    this.completionUrl = providerUrl(options.baseUrl, "chat/completions");
    this.models = models;
    this.credentials = options.credentials;
    this.timeoutMs = providerTimeout(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.fetchImpl = options.fetch ?? fetch;
  }

  async listModels(): Promise<ProviderModel[]> {
    return [...this.models.values()]
      .filter((model) => model.status !== "disabled")
      .map(({ upstreamId: _upstreamId, ...model }) => ({
        ...model,
        capabilities: { ...model.capabilities },
      }));
  }

  chat(request: NormalizedChatRequest, context: ProviderContext): AsyncIterable<NormalizedChatEvent> {
    const model = this.models.get(request.model);
    if (!model || model.status === "disabled") {
      throw new GatewayError(404, "invalid_request_error", "model_not_found", `Model ${request.model} was not found.`);
    }
    if ((request.tools?.length || request.tool_choice) && !model.capabilities.tools) {
      throw new GatewayError(400, "invalid_request_error", "unsupported_parameter", `${request.model} does not support tools.`);
    }
    if (request.response_format && !model.capabilities.responseFormat) {
      throw new GatewayError(400, "invalid_request_error", "unsupported_parameter", `${request.model} does not support response_format.`);
    }
    return this.execute(request, model, context);
  }

  private async *execute(
    request: NormalizedChatRequest,
    model: OpenAICompatibleModel,
    context: ProviderContext,
  ): AsyncIterable<NormalizedChatEvent> {
    const candidateIds = await this.credentials.listCredentialCandidates(context.workspaceId, this.id, request.model);
    if (!candidateIds.length) {
      throw new GatewayError(503, "api_error", "provider_credential_unavailable", "No active provider credential is available for this model.");
    }

    let attempts = 0;
    let transientFailures = 0;
    for (const candidate of candidateIds) {
      attempts += 1;
      const abort = requestAbort(context.signal, this.timeoutMs);
      let emitted = false;
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
        const response = await this.credentials.withCredentialCandidate(
          context.workspaceId,
          this.id,
          request.model,
          candidate,
          async (secret) => {
            attemptId = await attemptOperation(context.attempts
              ? () => context.attempts!.begin({
                  providerId: this.id,
                  endpointId: this.endpointId,
                  credentialId: candidate.id,
                  startedAt: new Date(),
                })
              : undefined);
            return this.fetchImpl(this.completionUrl, {
              method: "POST",
              headers: {
                Accept: request.stream ? "text/event-stream" : "application/json",
                Authorization: `Bearer ${secret}`,
                "Content-Type": "application/json",
                "User-Agent": "wan-router/0.1",
                "X-Request-ID": context.requestId,
              },
              body: JSON.stringify({
                ...request,
                model: model.upstreamId,
                ...(request.stream ? { stream_options: { include_usage: true } } : {}),
              }),
              signal: abort.signal,
            });
          },
        );
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          if (response.status === 401 || response.status === 403) {
            await this.credentials.markCredentialInvalid(context.workspaceId, candidate);
          }
          throw providerError(response.status);
        }

        if (!request.stream) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(await boundedResponseText(response));
          } catch (error) {
            if (error instanceof GatewayError) throw error;
            throw new GatewayError(502, "api_error", "provider_invalid_response", "The provider returned invalid JSON.");
          }
          const completion = completionSchema.safeParse(parsed);
          if (!completion.success || completion.data.choices[0].message.content === null) {
            throw new GatewayError(502, "api_error", "provider_invalid_response", "The provider returned an invalid completion response.");
          }
          const text = completion.data.choices.map((choice) => choice.message.content || "").join("");
          const finalUsage = usage(completion.data.usage);
          emitted = true;
          if (text) {
            await markAttemptFirstToken();
          }
          await finishAttempt("succeeded", { usage: finalUsage });
          if (text) {
            yield { type: "delta", text };
          }
          yield { type: "usage", usage: finalUsage };
          return;
        }

        if (!response.body || !/^text\/event-stream(?:;|$)/i.test(response.headers.get("content-type") || "")) {
          await response.body?.cancel().catch(() => {});
          throw new GatewayError(502, "api_error", "provider_invalid_response", "The provider did not return an SSE stream.");
        }
        yield { type: "ready" };
        let sawDone = false;
        let finalUsage: TokenUsage | undefined;
        for await (const data of parseProviderSse(response.body)) {
          if (data === "[DONE]") {
            sawDone = true;
            break;
          }
          let decoded: unknown;
          try {
            decoded = JSON.parse(data);
          } catch {
            throw new GatewayError(502, "api_error", "provider_invalid_response", "The provider returned an invalid stream event.");
          }
          const chunk = streamChunkSchema.safeParse(decoded);
          if (!chunk.success || chunk.data.error !== undefined) {
            throw new GatewayError(502, "api_error", "provider_invalid_response", "The provider returned an invalid stream event.");
          }
          if (chunk.data.usage) finalUsage = usage(chunk.data.usage);
          for (const choice of chunk.data.choices ?? []) {
            const text = choice.delta.content;
            if (text) {
              await markAttemptFirstToken();
              emitted = true;
              yield { type: "delta", text };
            }
          }
        }
        if (!sawDone) {
          throw new GatewayError(502, "api_error", "provider_stream_incomplete", "The provider stream ended before DONE.");
        }
        if (!finalUsage) {
          throw new GatewayError(502, "api_error", "provider_usage_missing", "The provider stream ended without final usage.");
        }
        await finishAttempt("succeeded", { usage: finalUsage });
        emitted = true;
        yield { type: "usage", usage: finalUsage };
        return;
      } catch (error) {
        const normalized = mappedError(error, context.signal, abort);
        await finishAttempt(normalized.status === 499 ? "cancelled" : "failed", {
          errorCode: normalized.code,
        });
        if (emitted || !retryableBeforeOutput(normalized)) throw normalized;
        transientFailures += 1;
        if (attempts === candidateIds.length) {
          if (attempts === 1) throw normalized;
          throw new GatewayError(502, "api_error", "all_provider_attempts_failed", "All eligible provider attempts failed before producing output.");
        }
      } finally {
        if (!attemptFinished) {
          await finishAttempt(context.signal.aborted ? "cancelled" : "failed", {
            errorCode: context.signal.aborted ? "request_cancelled" : "provider_attempt_abandoned",
          });
        }
        abort.dispose();
      }
    }

    if (transientFailures) {
      throw new GatewayError(502, "api_error", "all_provider_attempts_failed", "All eligible provider attempts failed before producing output.");
    }
  }
}

export class OpenAICompatibleCredentialVerifier implements ProviderCredentialVerifier {
  private readonly modelsUrl: string;
  private readonly timeoutMs: number;

  constructor(
    baseUrl: string,
    timeoutMs = 10_000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.modelsUrl = providerUrl(baseUrl, "models");
    this.timeoutMs = providerTimeout(timeoutMs, 10_000);
  }

  async verify(secret: string, signal: AbortSignal): Promise<CredentialVerificationResult> {
    const abort = requestAbort(signal, this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.modelsUrl, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${secret}`,
          "User-Agent": "wan-router/0.1",
        },
        signal: abort.signal,
      });
      await response.body?.cancel().catch(() => {});
      if (response.ok) return { ok: true };
      if (response.status === 401 || response.status === 403) {
        return { ok: false, code: "credential_rejected" };
      }
      throw providerError(response.status);
    } catch (error) {
      throw mappedError(error, signal, abort);
    } finally {
      abort.dispose();
    }
  }
}