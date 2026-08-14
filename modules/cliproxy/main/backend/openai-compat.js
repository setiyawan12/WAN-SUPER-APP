import fetch from "node-fetch";

const OPENAI_ROUTE_SUFFIX = /\/(?:chat\/completions|models)\/?$/i;

function expectedError(message, status = 422, code = "OPENAI_COMPAT_PROBE_FAILED") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.expected = true;
  return error;
}

export function normalizeOpenAiCompatBaseUrl(value) {
  const raw = String(value || "").trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw expectedError("Base URL must be a valid http:// or https:// URL.", 400, "INVALID_BASE_URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw expectedError("Base URL must use http:// or https://.", 400, "INVALID_BASE_URL");
  }
  if (url.username || url.password) {
    throw expectedError("Base URL must not contain credentials.", 400, "INVALID_BASE_URL");
  }
  if (url.search || url.hash) {
    throw expectedError("Base URL must not contain a query string or fragment.", 400, "INVALID_BASE_URL");
  }

  url.pathname = url.pathname.replace(/\/+$/, "").replace(OPENAI_ROUTE_SUFFIX, "").replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function upstreamMessage(text, statusText) {
  try {
    const data = text ? JSON.parse(text) : {};
    return String(data?.error?.message || data?.error || data?.message || statusText || "");
  } catch {
    return String(text || statusText || "");
  }
}

export async function testOpenAiCompatibleProvider(
  { baseUrl, apiKey, modelId },
  { fetchImpl = fetch, timeoutMs = 15_000 } = {}
) {
  const normalizedBaseUrl = normalizeOpenAiCompatBaseUrl(baseUrl);
  const key = String(apiKey || "").trim();
  const model = String(modelId || "").trim();
  if (!key) throw expectedError("API key is required.", 400, "MISSING_API_KEY");
  if (!model) throw expectedError("At least one model ID is required to test the provider.", 400, "MISSING_MODEL");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  let response;
  try {
    response = await fetchImpl(`${normalizedBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        stream: false,
        max_tokens: 8,
        messages: [{ role: "user", content: "Reply with OK." }],
      }),
      signal: controller.signal,
    });
  } catch (cause) {
    if (cause?.name === "AbortError") {
      throw expectedError(`Connection timed out after ${timeoutMs}ms.`, 504, "UPSTREAM_TIMEOUT");
    }
    const detail = cause?.message || String(cause);
    throw expectedError(`Could not connect to ${normalizedBaseUrl}: ${detail}`, 502, "UPSTREAM_UNREACHABLE");
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  const message = upstreamMessage(text, response.statusText).slice(0, 500);
  if (!response.ok) {
    const hint = response.status === 401 || response.status === 403
      ? " Check the API key and provider permissions."
      : response.status === 404
        ? " Check that Base URL is the API root (for example, ending in /v1), not the full /chat/completions URL."
        : "";
    throw expectedError(`Provider returned HTTP ${response.status}${message ? `: ${message}` : "."}${hint}`);
  }

  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw expectedError(`Provider returned a non-JSON response: ${text.slice(0, 200) || "empty response"}`);
  }
  if (!Array.isArray(data?.choices)) {
    throw expectedError("Provider responded, but the payload is not OpenAI chat-completions compatible (missing choices)." );
  }

  return {
    ok: true,
    baseUrl: normalizedBaseUrl,
    model,
    latencyMs: Date.now() - startedAt,
  };
}