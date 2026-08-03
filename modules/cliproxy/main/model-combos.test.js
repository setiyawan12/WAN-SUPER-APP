import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

let home;
let combos;
let state;

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "wan-combos-"));
  process.env.CLIPROXY_HOME = home;
  combos = await import(`./backend/model-combos.js?test=${Date.now()}`);
  state = await import(`./backend/state.js?test=${Date.now()}`);
});

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

test("creates, updates, and deletes persisted combos", () => {
  const created = combos.createModelCombo({
    name: "coding-stack",
    models: ["claude-a", "gpt-b"],
    strategy: "fallback",
  });
  assert.equal(created.name, "coding-stack");
  assert.deepEqual(combos.listModelCombos()[0].models, ["claude-a", "gpt-b"]);

  state.writeState({ enabledModelIds: ["coding-stack"] });
  const updated = combos.updateModelCombo(created.id, {
    name: "coding-primary",
    models: ["gpt-b", "claude-a"],
    strategy: "round-robin",
    stickyLimit: 2,
  });
  assert.equal(updated.name, "coding-primary");
  assert.deepEqual(state.readState().enabledModelIds, ["coding-primary"]);

  combos.deleteModelCombo(created.id);
  assert.deepEqual(combos.listModelCombos(), []);
  assert.deepEqual(state.readState().enabledModelIds, []);
});

test("validates names, member count, duplicates, and nesting", () => {
  assert.throws(
    () => combos.createModelCombo({ name: "bad name", models: ["a", "b"] }),
    /may only contain/i
  );
  assert.throws(
    () => combos.createModelCombo({ name: "too-short", models: ["a"] }),
    /at least two/i
  );

  const base = combos.createModelCombo({ name: "base", models: ["a", "b"] });
  assert.throws(
    () => combos.createModelCombo({ name: "base", models: ["c", "d"] }),
    /already exists/i
  );
  assert.throws(
    () => combos.createModelCombo({ name: "nested", models: ["base", "c"] }),
    /nested combo/i
  );
  combos.deleteModelCombo(base.id);
});

test("round robin honors sticky request count", () => {
  const combo = {
    id: "rotation-test",
    name: "rotation-test",
    models: ["a", "b", "c"],
    strategy: "round-robin",
    stickyLimit: 2,
  };
  const first = Array.from({ length: 7 }, () => combos.orderedComboModels(combo)[0]);
  assert.deepEqual(first, ["a", "a", "b", "b", "c", "c", "a"]);
});

test("image requests prioritize verified vision models", () => {
  state.writeState({
    modelCapabilities: {
      text: { vision: false },
      unknown: { vision: "unknown" },
      vision: { vision: true },
    },
  });
  const combo = {
    id: "vision-test",
    name: "vision-test",
    models: ["text", "unknown", "vision"],
    strategy: "fallback",
    stickyLimit: 1,
  };
  const body = {
    messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,x" } }] }],
  };
  assert.deepEqual(combos.orderedComboModels(combo, body), ["vision", "unknown", "text"]);
});

test("fallback classifier distinguishes retryable and request errors", () => {
  assert.equal(combos.shouldFallback(404, ""), true);
  assert.equal(combos.shouldFallback(429, ""), true);
  assert.equal(combos.shouldFallback(400, "quota exhausted"), true);
  assert.equal(combos.shouldFallback(400, "image input unsupported"), true);
  assert.equal(combos.shouldFallback(400, "messages is required"), false);
});