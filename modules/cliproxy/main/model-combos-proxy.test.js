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

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "wan-combo-proxy-"));
  attempts = [];

  upstream = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = JSON.parse(raw);
      attempts.push(body.model);
      const invalid = body.messages?.[0]?.content === "invalid";
      if (body.model === "first-model") {
        const status = invalid ? 400 : 429;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: invalid ? "messages is required" : "quota exhausted" } }));
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
  const response = await fetch(proxyUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "test-combo", messages: [{ role: "user", content: "invalid" }] }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(attempts, ["first-model"]);
});