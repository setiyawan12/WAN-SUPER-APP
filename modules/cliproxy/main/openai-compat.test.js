import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import {
  normalizeOpenAiCompatBaseUrl,
  testOpenAiCompatibleProvider,
} from "./backend/openai-compat.js";

let server;
let baseUrl;
let received;

before(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      received = { url: req.url, authorization: req.headers.authorization, body: JSON.parse(raw) };
      if (req.headers.authorization !== "Bearer valid-key") {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "invalid API key" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("normalizes OpenAI route URLs to their API root", () => {
  assert.equal(normalizeOpenAiCompatBaseUrl(" https://api.example.com/v1/chat/completions/ "), "https://api.example.com/v1");
  assert.equal(normalizeOpenAiCompatBaseUrl("https://api.example.com/v1/models"), "https://api.example.com/v1");
  assert.throws(() => normalizeOpenAiCompatBaseUrl("ftp://api.example.com/v1"), /http:\/\/ or https:\/\//);
});

test("probes the chat-completions endpoint with the supplied credential and model", async () => {
  const result = await testOpenAiCompatibleProvider({ baseUrl, apiKey: "valid-key", modelId: "test-model" });
  assert.equal(result.ok, true);
  assert.equal(result.baseUrl, baseUrl);
  assert.equal(received.url, "/v1/chat/completions");
  assert.equal(received.authorization, "Bearer valid-key");
  assert.equal(received.body.model, "test-model");
  assert.equal(received.body.stream, false);
  assert.equal(received.body.max_tokens, 8);
});

test("reports upstream authentication failures", async () => {
  await assert.rejects(
    testOpenAiCompatibleProvider({ baseUrl, apiKey: "wrong-key", modelId: "test-model" }),
    /HTTP 401: invalid API key.*Check the API key/
  );
});