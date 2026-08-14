import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";

test("loads bounded local defaults", () => {
  const config = loadConfig({ WAN_SSH_LOG_LEVEL: "error" });
  assert.equal(config.authMode, "dev-anonymous");
  assert.equal(config.allowedOrigins[0], "http://127.0.0.1:5179");
  assert.ok(config.maxPrivateKeyBytes < config.maxMessageBytes);
});

test("production rejects development authentication", () => {
  assert.throws(() => loadConfig({ WAN_SSH_ENV: "production", WAN_SSH_AUTH_MODE: "dev-anonymous" }), /Production requires|forbidden/);
});

test("production rejects HTTP and empty egress policy", () => {
  assert.throws(() => loadConfig({
    WAN_SSH_ENV: "production",
    WAN_SSH_AUTH_MODE: "firebase",
    WAN_SSH_FIREBASE_PROJECT_ID: "test",
    WAN_SSH_ALLOWED_ORIGINS: "http://ssh.example.com",
    WAN_SSH_EGRESS_MODE: "allowlist",
    WAN_SSH_EGRESS_ALLOW_CIDRS: "10.0.0.0/8"
  }), /HTTPS/);
  assert.throws(() => loadConfig({
    WAN_SSH_ENV: "production",
    WAN_SSH_AUTH_MODE: "firebase",
    WAN_SSH_FIREBASE_PROJECT_ID: "test",
    WAN_SSH_ALLOWED_ORIGINS: "https://ssh.example.com",
    WAN_SSH_EGRESS_MODE: "allowlist"
  }), /egress allowlist/);
});

test("credential-like gateway environment variables are forbidden", () => {
  assert.throws(() => loadConfig({ WAN_SSH_PRIVATE_KEY: "secret" }), /forbidden/);
});