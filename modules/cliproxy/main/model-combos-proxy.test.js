import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import express from "express";

let home;
let upstream;
let proxy;
let proxyUrl;
let attempts;
let requestBodies;

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "wan-combo-proxy-"));
  attempts = [];
  requestBodies = [];

  upstream = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = JSON.parse(raw);
      attempts.push(body.model);
      requestBodies.push(body);
      const invalid = body.messages?.[0]?.content === "invalid";
      if (body.model === "first-model") {
        const status = invalid ? 400 : 429;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: invalid ? "messages is required" : "quota exhausted" } }));
        return;
      }
      if (body.model === "strict-sampling-model" && body.temperature !== undefined) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: {
            message: "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"upstream_error\",\"message\":\"Unsupported value: 'temperature' does not support 0.1 with this model. Only the default (1) value is supported.\"}}\n\n",
            type: "upstream_error",
            code: "upstream_error",
          },
        }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "fallback-ok" } }] }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;

  process.env.CLIPROXY_HOME = home;
  process.env.CLIPROXY_PORT = String(upstreamPort);
  process.env.CLIPROXY_HOST = "127.0.0.1";
  fs.writeFileSync(path.join(home, "config.yaml"), [
    "openai-compatibility:",
    "  - name: ohmyagent",
    "    base-url: https://ohhmyagent.com/v1",
    "    models:",
    "      - name: ohh/gpt-5.6",
    "",
  ].join("\n"));

  const [{ proxyChatCompletions }, { createModelCombo }] = await Promise.all([
    import(`./backend/chat-proxy.js?test=${Date.now()}`),
    import("./backend/model-combos.js"),
  ]);
  createModelCombo({ name: "test-combo", models: ["first-model", "second-model"], strategy: "fallback" });

  const app = express();
  app.post("/chat", express.json(), proxyChatCompletions);
  proxy = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => proxy.once("listening", resolve));
  proxyUrl = `http://127.0.0.1:${proxy.address().port}/chat`;
});

after(async () => {
  await Promise.all([
    new Promise((resolve) => upstream.close(resolve)),
    new Promise((resolve) => proxy.close(resolve)),
  ]);
  fs.rmSync(home, { recursive: true, force: true });
});

test("proxy falls through to the next model on retryable failure", async () => {
  attempts.length = 0;
  const response = await fetch(proxyUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "test-combo", messages: [{ role: "user", content: "hello" }] }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, "fallback-ok");
  assert.deepEqual(attempts, ["first-model", "second-model"]);
});

test("proxy returns non-retryable request errors without trying another model", async () => {
  attempts.length = 0;
  requestBodies.length = 0;
  const response = await fetch(proxyUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "test-combo", messages: [{ role: "user", content: "invalid" }] }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(attempts, ["first-model"]);
});

test("proxy retries once with provider-default sampling parameters", async () => {
  attempts.length = 0;
  requestBodies.length = 0;
  const response = await fetch(proxyUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "strict-sampling-model",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      temperature: 0.1,
      top_p: 0.9,
      top_k: 40,
    }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(attempts, ["strict-sampling-model", "strict-sampling-model"]);
  assert.equal(requestBodies[0].temperature, 0.1);
  assert.equal("temperature" in requestBodies[1], false);
  assert.equal("top_p" in requestBodies[1], false);
  assert.equal("top_k" in requestBodies[1], false);
  assert.equal(requestBodies[1].stream, true);
  assert.deepEqual(requestBodies[1].messages, [{ role: "user", content: "hello" }]);
});

test("custom OpenAI-compatible models use provider defaults on the first attempt", async () => {
  attempts.length = 0;
  requestBodies.length = 0;
  const response = await fetch(proxyUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "ohh/gpt-5.6",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      temperature: 0.1,
      top_p: 1,
      top_k: 40,
    }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(attempts, ["ohh/gpt-5.6"]);
  assert.equal("temperature" in requestBodies[0], false);
  assert.equal("top_p" in requestBodies[0], false);
  assert.equal("top_k" in requestBodies[0], false);
  assert.equal(requestBodies[0].stream, true);
  assert.deepEqual(requestBodies[0].messages, [{ role: "user", content: "hello" }]);
});