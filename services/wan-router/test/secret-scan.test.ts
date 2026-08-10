import assert from "node:assert/strict";
import { test } from "node:test";
import { scanSecretText } from "../src/security/secret-scan.js";

test("secret scanner detects high-confidence credentials without returning their values", () => {
  const text = [
    "safe metadata",
    "wan_sk_live_123e4567-e89b-12d3-a456-426614174000_abcdefghijklmnopqrstuvwxyzABCDEF",
    "postgres://service:private-password@database.internal/router",
    "-----BEGIN PRIVATE KEY-----",
  ].join("\n");
  const findings = scanSecretText("fixture.log", text);
  assert.deepEqual(findings.map(({ rule, line }) => ({ rule, line })), [
    { rule: "private-key", line: 4 },
    { rule: "wan-api-key", line: 2 },
    { rule: "postgres-password-url", line: 3 },
  ]);
  assert.doesNotMatch(JSON.stringify(findings), /private-password|abcdefghijklmnopqrstuvwxyzABCDEF/);
});

test("secret scanner permits placeholders and structured metadata", () => {
  assert.deepEqual(scanSecretText("safe.json", JSON.stringify({
    request_id: "req_safe",
    error_code: "provider_unavailable",
    api_key: "<Secret Manager reference>",
    database: "postgres://user@localhost/router",
  })), []);
});