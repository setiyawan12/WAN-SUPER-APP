import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareChatAdmission } from "../src/admission/chat.js";

test("chat admission applies a hard default output limit and conservative prompt bound", () => {
  const prepared = prepareChatAdmission({
    model: "mock/echo",
    messages: [{ role: "user", content: "hello" }],
    stream: false,
  }, 512);
  assert.equal(prepared.request.max_completion_tokens, 512);
  assert.ok(prepared.requestedTokens > 512);
  assert.equal(prepared.requestedTokens, Buffer.byteLength(JSON.stringify(prepared.request)) + 512);
});

test("chat admission preserves explicit output limits", () => {
  const prepared = prepareChatAdmission({
    model: "mock/echo",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
    max_tokens: 25,
  }, 512);
  assert.equal(prepared.request.max_tokens, 25);
  assert.equal(prepared.request.max_completion_tokens, undefined);
  assert.ok(prepared.requestedTokens > 25);
});

test("chat admission includes tools and metadata in the hard reservation", () => {
  const withoutTools = prepareChatAdmission({
    model: "mock/echo",
    messages: [{ role: "user", content: "hello" }],
    stream: false,
    max_tokens: 25,
  }, 512);
  const withTools = prepareChatAdmission({
    model: "mock/echo",
    messages: [{ role: "user", content: "hello" }],
    stream: false,
    max_tokens: 25,
    tools: [{ type: "function", function: { name: "lookup", description: "x".repeat(500) } }],
    metadata: { workflow: "admission-test" },
  }, 512);
  assert.ok(withTools.requestedTokens > withoutTools.requestedTokens + 500);
});