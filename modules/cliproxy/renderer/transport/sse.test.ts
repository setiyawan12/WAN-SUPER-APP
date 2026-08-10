import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSseData } from "./sse.ts";

function fragmentedStream(text: string, cutPoints: number[]): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const chunks: Uint8Array[] = [];
  let start = 0;
  for (const end of [...cutPoints, bytes.length]) {
    chunks.push(bytes.slice(start, end));
    start = end;
  }
  return new ReadableStream({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  });
}

test("parseSseData handles fragmented events, comments, and multiline data", async () => {
  const input = [
    ": heartbeat\n",
    "data: {\"part\":1}\n\n",
    "data: first\n",
    "data: second\n\n",
    "data: [DONE]\n\n",
  ].join("");
  const results: string[] = [];
  for await (const data of parseSseData(fragmentedStream(input, [1, 4, 11, 19, 27, 42, 55]))) {
    results.push(data);
  }
  assert.deepEqual(results, ["{\"part\":1}", "first\nsecond", "[DONE]"]);
});

test("parseSseData flushes a final event without a trailing blank line", async () => {
  const results: string[] = [];
  for await (const data of parseSseData(fragmentedStream("data: tail", [2, 7]))) {
    results.push(data);
  }
  assert.deepEqual(results, ["tail"]);
});