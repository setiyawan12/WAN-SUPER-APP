import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProviderSse } from "../src/providers/sse.js";

function fragmentedStream(text: string, splitPoints: number[]): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(text);
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (const splitPoint of splitPoints) {
    chunks.push(encoded.slice(offset, splitPoint));
    offset = splitPoint;
  }
  chunks.push(encoded.slice(offset));
  return new ReadableStream({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  });
}

test("provider SSE parser handles arbitrary fragmentation, comments, CRLF, and multiline data", async () => {
  const source = [
    ": heartbeat\r\n",
    "data: {\"choices\":[{\"delta\":{\"content\":\"hel\"}}]}\r\n\r\n",
    "data: first\n",
    "data: second\n\n",
    "data: [DONE]\n\n",
  ].join("");
  const events: string[] = [];
  for await (const event of parseProviderSse(fragmentedStream(source, [1, 3, 9, 22, 51, 83, 101]))) {
    events.push(event);
  }

  assert.deepEqual(events, [
    "{\"choices\":[{\"delta\":{\"content\":\"hel\"}}]}",
    "first\nsecond",
    "[DONE]",
  ]);
});

test("provider SSE parser flushes the final event and rejects oversized data", async () => {
  const tail: string[] = [];
  for await (const event of parseProviderSse(fragmentedStream("data: tail", [2, 6]))) tail.push(event);
  assert.deepEqual(tail, ["tail"]);

  await assert.rejects(async () => {
    for await (const _event of parseProviderSse(fragmentedStream("data: oversized\n\n", [4]), 4)) {
      // Consume the stream to trigger validation.
    }
  }, /oversized stream event/);

  await assert.rejects(async () => {
    for await (const _event of parseProviderSse(fragmentedStream("data: no-newline", [3, 6, 9]), 8)) {
      // Consume the stream to trigger validation before EOF.
    }
  }, /oversized stream event/);
});

test("provider SSE parser cancels the upstream body when the consumer stops at DONE", async () => {
  const encoder = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    },
    cancel() {
      cancelled = true;
    },
  });

  for await (const event of parseProviderSse(stream)) {
    assert.equal(event, "[DONE]");
    break;
  }
  assert.equal(cancelled, true);
});