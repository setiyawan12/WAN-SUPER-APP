import type { ChatStartInit, ChatStreamEvent, ChatUsage } from "../wan";
import type { ChatStreamHandle, ChatTransport } from "./chat";
import { normalizeCloudBaseUrl, type AccessTokenProvider } from "./cloud-http";
import { parseSseData } from "./sse";

interface CloudChatTransportOptions {
  baseUrl: string;
  getAccessToken: AccessTokenProvider;
}

interface CloudErrorPayload {
  error?: {
    message?: string;
    code?: string;
    request_id?: string;
  };
}

function errorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && "error" in payload) {
    const error = (payload as CloudErrorPayload).error;
    if (error?.message) return error.request_id ? `${error.message} (${error.request_id})` : error.message;
  }
  return fallback;
}

function usageFrom(payload: unknown): ChatUsage | undefined {
  if (!payload || typeof payload !== "object" || !("usage" in payload)) return undefined;
  const usage = (payload as { usage?: Partial<ChatUsage> }).usage;
  if (!usage) return undefined;
  if (![usage.prompt_tokens, usage.completion_tokens, usage.total_tokens].every(Number.isFinite)) return undefined;
  return {
    prompt_tokens: Number(usage.prompt_tokens),
    completion_tokens: Number(usage.completion_tokens),
    total_tokens: Number(usage.total_tokens),
  };
}

function deltaFrom(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || !("choices" in payload)) return undefined;
  const choices = (payload as { choices?: { delta?: { content?: unknown } }[] }).choices;
  const content = choices?.[0]?.delta?.content;
  return typeof content === "string" ? content : undefined;
}

export class CloudHttpChatTransport implements ChatTransport {
  private readonly baseUrl: string;

  constructor(private readonly options: CloudChatTransportOptions) {
    this.baseUrl = normalizeCloudBaseUrl(options.baseUrl);
  }

  startChat(request: ChatStartInit, listener: (event: ChatStreamEvent) => void): ChatStreamHandle {
    const controller = new AbortController();
    let settled = false;
    let started = false;
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    const finish = (event?: ChatStreamEvent) => {
      if (settled) return;
      settled = true;
      if (event) listener(event);
      resolveDone();
    };

    void (async () => {
      try {
        const token = await this.options.getAccessToken();
        if (settled) return;
        if (!token) throw new Error("A signed-in WAN session is required.");
        started = true;
        const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: {
            Accept: "text/event-stream",
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "X-Request-ID": request.reqId,
          },
          body: JSON.stringify({
            model: request.model,
            messages: request.messages,
            stream: true,
            stream_options: { include_usage: true },
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          let payload: unknown;
          try {
            payload = await response.json();
          } catch {
            payload = null;
          }
          finish({
            reqId: request.reqId,
            type: "error",
            error: errorMessage(payload, `WAN Router Cloud returned ${response.status}.`),
          });
          return;
        }
        if (!response.body) throw new Error("WAN Router Cloud returned an empty stream.");

        for await (const data of parseSseData(response.body)) {
          if (data === "[DONE]") {
            finish({ reqId: request.reqId, type: "done" });
            return;
          }
          let payload: unknown;
          try {
            payload = JSON.parse(data);
          } catch {
            continue;
          }
          if (payload && typeof payload === "object" && "error" in payload) {
            finish({ reqId: request.reqId, type: "error", error: errorMessage(payload, "Cloud stream failed.") });
            return;
          }
          const delta = deltaFrom(payload);
          if (delta) listener({ reqId: request.reqId, type: "delta", text: delta });
          const usage = usageFrom(payload);
          if (usage) listener({ reqId: request.reqId, type: "usage", usage });
        }

        finish({ reqId: request.reqId, type: "done" });
      } catch (error) {
        if (controller.signal.aborted) {
          finish({ reqId: request.reqId, type: "aborted" });
          return;
        }
        finish({
          reqId: request.reqId,
          type: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return {
      abort() {
        if (settled) return;
        if (!started) {
          finish({ reqId: request.reqId, type: "aborted" });
          return;
        }
        controller.abort();
      },
      done,
    };
  }
}