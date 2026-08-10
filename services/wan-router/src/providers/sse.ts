import { GatewayError } from "../errors.js";

const DEFAULT_MAX_EVENT_BYTES = 1_048_576;

export async function* parseProviderSse(
  stream: ReadableStream<Uint8Array>,
  maxEventBytes = DEFAULT_MAX_EVENT_BYTES,
): AsyncIterable<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  let eventBytes = 0;
  let completed = false;

  const consumeLine = (rawLine: string): string | undefined => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line) {
      if (!dataLines.length) return undefined;
      const data = dataLines.join("\n");
      dataLines = [];
      eventBytes = 0;
      return data;
    }
    if (line.startsWith(":")) return undefined;
    if (!line.startsWith("data:")) return undefined;
    const value = line.slice(5).replace(/^ /, "");
    eventBytes += Buffer.byteLength(value);
    if (eventBytes > maxEventBytes) {
      throw new GatewayError(502, "api_error", "provider_stream_too_large", "The provider returned an oversized stream event.");
    }
    dataLines.push(value);
    return undefined;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      if (!buffer.includes("\n") && Buffer.byteLength(buffer) > maxEventBytes) {
        throw new GatewayError(502, "api_error", "provider_stream_too_large", "The provider returned an oversized stream event.");
      }
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const event = consumeLine(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
        if (event !== undefined) yield event;
        newlineIndex = buffer.indexOf("\n");
      }
    }

    buffer += decoder.decode();
    if (Buffer.byteLength(buffer) > maxEventBytes) {
      throw new GatewayError(502, "api_error", "provider_stream_too_large", "The provider returned an oversized stream event.");
    }
    if (buffer) {
      const event = consumeLine(buffer);
      if (event !== undefined) yield event;
    }
    if (dataLines.length) yield dataLines.join("\n");
  } finally {
    if (!completed) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}