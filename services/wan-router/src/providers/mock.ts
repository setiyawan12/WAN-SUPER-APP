import { GatewayError } from "../errors.js";
import type { NormalizedChatRequest, TokenUsage } from "../inference/contracts.js";
import type { NormalizedChatEvent, ProviderAdapter, ProviderContext, ProviderModel } from "./types.js";

const MODELS: ProviderModel[] = [
  {
    id: "mock/echo",
    ownedBy: "wan-mock",
    status: "active",
    capabilities: { tools: false, responseFormat: false },
  },
  {
    id: "mock/slow",
    ownedBy: "wan-mock",
    status: "active",
    capabilities: { tools: false, responseFormat: false },
  },
];

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new GatewayError(499, "request_error", "request_cancelled", "The client cancelled the request."));
    }, { once: true });
  });
}

function textContent(request: NormalizedChatRequest): string {
  const latest = [...request.messages].reverse().find((message) => message.role === "user");
  if (!latest || latest.content === null) return "";
  if (typeof latest.content === "string") return latest.content;
  return latest.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function estimatedTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function splitOutput(output: string): string[] {
  if (output.length <= 8) return [output];
  const first = Math.max(1, Math.floor(output.length / 3));
  const second = Math.max(first + 1, Math.floor((output.length * 2) / 3));
  return [output.slice(0, first), output.slice(first, second), output.slice(second)].filter(Boolean);
}

export class DeterministicMockProvider implements ProviderAdapter {
  readonly id = "mock";

  async listModels(): Promise<ProviderModel[]> {
    return MODELS;
  }

  chat(request: NormalizedChatRequest, context: ProviderContext): AsyncIterable<NormalizedChatEvent> {
    if (!MODELS.some((model) => model.id === request.model)) {
      throw new GatewayError(404, "invalid_request_error", "model_not_found", `Model ${request.model} was not found.`);
    }
    if (request.tools?.length || request.tool_choice) {
      throw new GatewayError(400, "invalid_request_error", "unsupported_parameter", `${request.model} does not support tools.`);
    }
    if (request.response_format) {
      throw new GatewayError(400, "invalid_request_error", "unsupported_parameter", `${request.model} does not support response_format.`);
    }

    return this.stream(request, context);
  }

  private async *stream(
    request: NormalizedChatRequest,
    context: ProviderContext,
  ): AsyncIterable<NormalizedChatEvent> {
    const attemptId = await context.attempts?.begin({
      providerId: this.id,
      endpointId: "mock-local",
      startedAt: new Date(),
    });
    let attemptFinished = false;
    let firstToken = false;
    try {
      yield { type: "ready" };
      const prompt = textContent(request);
      const limit = request.max_tokens ?? request.max_completion_tokens;
      const rawOutput = `Mock response: ${prompt}`;
      const output = limit ? rawOutput.slice(0, Math.max(1, limit * 4)) : rawOutput;

      for (const chunk of splitOutput(output)) {
        if (context.signal.aborted) {
          throw new GatewayError(499, "request_error", "request_cancelled", "The client cancelled the request.");
        }
        if (request.model === "mock/slow") await delay(350, context.signal);
        else await Promise.resolve();
        if (attemptId && !firstToken) {
          await context.attempts?.firstToken(attemptId, new Date());
          firstToken = true;
        }
        yield { type: "delta", text: chunk };
      }

      const usage: TokenUsage = {
        prompt_tokens: estimatedTokens(prompt),
        completion_tokens: estimatedTokens(output),
        total_tokens: estimatedTokens(prompt) + estimatedTokens(output),
        estimated: true,
      };
      if (attemptId) {
        await context.attempts?.finish(attemptId, { status: "succeeded", usage, completedAt: new Date() });
        attemptFinished = true;
      }
      yield { type: "usage", usage };
    } catch (error) {
      if (attemptId && !attemptFinished) {
        const cancelled = context.signal.aborted || (error instanceof GatewayError && error.status === 499);
        await context.attempts?.finish(attemptId, {
          status: cancelled ? "cancelled" : "failed",
          errorCode: error instanceof GatewayError ? error.code : "provider_unavailable",
          completedAt: new Date(),
        });
        attemptFinished = true;
      }
      throw error;
    } finally {
      if (attemptId && !attemptFinished) {
        await context.attempts?.finish(attemptId, {
          status: context.signal.aborted ? "cancelled" : "failed",
          errorCode: context.signal.aborted ? "request_cancelled" : "provider_attempt_abandoned",
          completedAt: new Date(),
        });
      }
    }
  }
}