import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { GatewayError } from "../src/errors.js";
import { writeSseDone, writeSseJson } from "../src/inference/downstream-sse.js";

class FakeWritable extends EventEmitter {
  destroyed = false;
  chunks: string[] = [];
  acceptWrites = true;

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return this.acceptWrites;
  }
}

test("downstream SSE waits for drain when a slow client applies backpressure", async () => {
  const destination = new FakeWritable();
  destination.acceptWrites = false;
  let settled = false;
  const pending = writeSseJson(destination, { delta: "slow" }).then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(destination.chunks, ["data: {\"delta\":\"slow\"}\n\n"]);

  destination.emit("drain");
  await pending;
  assert.equal(settled, true);
  assert.equal(destination.listenerCount("close"), 0);
  assert.equal(destination.listenerCount("error"), 0);
});

test("downstream SSE aborts a blocked write when the client closes", async () => {
  const destination = new FakeWritable();
  destination.acceptWrites = false;
  const pending = writeSseDone(destination);
  destination.destroyed = true;
  destination.emit("close");

  await assert.rejects(pending, (error: unknown) => (
    error instanceof GatewayError && error.status === 499 && error.code === "request_cancelled"
  ));
  assert.equal(destination.listenerCount("drain"), 0);
  assert.equal(destination.listenerCount("error"), 0);
});