import { test } from "node:test";
import assert from "node:assert/strict";
import {
  xmlEscape,
  xmlUnescape,
  serializeServicesXml,
  parseServicesXml,
  mergeServices,
  serviceIdFor,
  buildService,
  keychainServiceName,
  hasWanService,
  type JbService,
  type RemoteModelEntry,
} from "./jetbrains-config.js";

const svc = (id: string): JbService => ({
  id,
  name: id,
  template: "OPENAI",
  chatCompletionSettings: {},
  codeCompletionSettings: {},
});

test("xmlEscape escapes reserved characters and round-trips", () => {
  const raw = `a & b < c > d " e`;
  const esc = xmlEscape(raw);
  assert.ok(!/[<>"]/.test(esc), "no raw <, >, or \" should remain");
  assert.match(esc, /&amp;/);
  assert.equal(xmlUnescape(esc), raw);
});

test("serialize -> parse round-trips services (including quotes/ampersands in values)", () => {
  const services: JbService[] = [
    {
      id: "wan-model-a",
      name: `A "quoted" & <angled>`,
      template: "OPENAI",
      contextWindowSize: 200000,
      chatCompletionSettings: { url: "http://127.0.0.1:4317", headers: { Authorization: "Bearer k&y" } },
      codeCompletionSettings: {},
    },
  ];
  const xml = serializeServicesXml(services);
  assert.ok(xml.includes(`name="services"`));
  assert.ok(!xml.includes(`"quoted"`), "inner quotes must be escaped, not raw");

  const parsed = parseServicesXml(xml);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.services, services);
});

test("parseServicesXml: blank and component-only files parse as empty", () => {
  const blank = parseServicesXml("");
  assert.ok(blank.ok && blank.services.length === 0);

  const componentOnly = parseServicesXml(
    `<application>\n  <component name="CodeGPT_CustomServicesSettings" />\n</application>`
  );
  assert.ok(componentOnly.ok && componentOnly.services.length === 0);
});

test("parseServicesXml: unrecognised or malformed content is rejected (never clobbered)", () => {
  const foreign = parseServicesXml(`<application><component name="SomethingElse"/></application>`);
  assert.equal(foreign.ok, false);

  const brokenJson = parseServicesXml(
    `<application><component name="CodeGPT_CustomServicesSettings"><option name="services" value="[{not json" /></component></application>`
  );
  assert.equal(brokenJson.ok, false);
});

test("mergeServices drops our old wan- entries, keeps foreign ones, appends desired", () => {
  const existing = [svc("user-custom-1"), svc("wan-old-model"), svc("another-user-svc")];
  const desired = [svc("wan-new-a"), svc("wan-new-b")];
  const merged = mergeServices(existing, desired);
  assert.deepEqual(
    merged.map((s) => s.id),
    ["user-custom-1", "another-user-svc", "wan-new-a", "wan-new-b"]
  );
});

test("hasWanService detects our services", () => {
  assert.equal(hasWanService([svc("user-1")]), false);
  assert.equal(hasWanService([svc("user-1"), svc("wan-x")]), true);
});

test("serviceIdFor is stable and sanitises non-id characters", () => {
  assert.equal(serviceIdFor("claude-sonnet-4-6"), "wan-claude-sonnet-4-6");
  assert.equal(serviceIdFor("antigravity/claude sonnet"), "wan-antigravity-claude-sonnet");
  assert.equal(serviceIdFor("gpt-5.3"), serviceIdFor("gpt-5.3"));
});

test("buildService produces a ProxyAI-shaped service with the literal key in the header", () => {
  const model: RemoteModelEntry = {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet",
    url: "http://127.0.0.1:4317/api/proxy/v1/chat/completions",
    maxInputTokens: 128000,
    maxOutputTokens: 16000,
  };
  const s = buildService(model, "SECRET_KEY") as any;
  assert.equal(s.id, "wan-claude-sonnet-4-6");
  assert.equal(s.name, "Claude Sonnet (WAN)");
  assert.equal(s.template, "OPENAI");
  assert.equal(s.contextWindowSize, 128000);
  assert.equal(s.chatCompletionSettings.url, model.url);
  assert.equal(s.chatCompletionSettings.headers.Authorization, "Bearer SECRET_KEY");
  assert.equal(s.chatCompletionSettings.body.model, "claude-sonnet-4-6");
  assert.equal(s.chatCompletionSettings.body.max_tokens, 16000);
  assert.equal(s.codeCompletionSettings.codeCompletionsEnabled, false);
});

test("buildService falls back to defaults when token limits are absent", () => {
  const s = buildService({ id: "m", name: "M", url: "u" }, "k") as any;
  assert.equal(s.contextWindowSize, 200000);
  assert.equal(s.chatCompletionSettings.body.max_tokens, 32768);
});

test("keychainServiceName matches ProxyAI's PasswordSafe naming", () => {
  assert.equal(
    keychainServiceName("wan-claude-sonnet-4-6"),
    "IntelliJ Platform CodeGPT — CUSTOM_SERVICE_API_KEY_ID:wan-claude-sonnet-4-6"
  );
});
