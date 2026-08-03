import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

let home;
let budget;
let usage;
let state;
let combos;

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "wan-quota-budget-"));
  process.env.CLIPROXY_HOME = home;
  const stamp = Date.now();
  budget = await import(`./backend/quota-budget.js?test=${stamp}`);
  usage = await import(`./backend/usage-store.js?test=${stamp}`);
  state = await import(`./backend/state.js?test=${stamp}`);
  combos = await import(`./backend/model-combos.js?test=${stamp}`);
});

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function localIsoTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const offsetHours = pad(Math.floor(Math.abs(offsetMinutes) / 60));
  const offsetRemainder = pad(Math.abs(offsetMinutes) % 60);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `${sign}${offsetHours}:${offsetRemainder}`;
}

function usageRecord(provider, inputTokens, outputTokens, timestamp = localIsoTimestamp()) {
  return {
    timestamp,
    provider,
    model: `${provider}-model`,
    failed: false,
    tokens: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}

test("provider windows retain current day and month totals", () => {
  usage.recordUsage([
    usageRecord("codex", 1_000_000, 500_000),
    usageRecord("claude", 500_000, 100_000),
  ]);
  const windows = usage.getProviderUsageWindows();
  assert.equal(windows.today.codex.total_tokens, 1_500_000);
  assert.equal(windows.month.claude.total_tokens, 600_000);
  assert.equal(windows.trailing24h.codex.requests, 1);
});

test("quota prediction estimates exhaustion before reset", () => {
  const now = Date.now();
  const prediction = budget.predictQuotaExhaustion({
    usedPercent: 50,
    windowSeconds: 18_000,
    resetAfterSeconds: 14_400,
  }, now);
  assert.equal(prediction.beforeReset, true);
  assert.ok(prediction.exhaustionAt > now);
  assert.ok(prediction.burnPercentPerHour > 0);
});

test("budget center calculates spend and projected exhaustion", async () => {
  budget.setQuotaBudgetConfig({
    enabled: true,
    notificationsEnabled: false,
    autoRouteEnabled: false,
    providerBudgets: {
      codex: { dailyUsd: 1, monthlyUsd: 10 },
      claude: { dailyUsd: 50, monthlyUsd: 100 },
    },
  });
  const center = await budget.getQuotaBudgetCenter();
  const codex = center.providers.find((row) => row.provider === "codex");
  assert.ok(codex.daily.costUsd > 0);
  assert.equal(codex.daily.status, "exhausted");
  assert.equal(codex.daily.budgetUsd, 1);
  assert.ok(center.resets.some((event) => event.id === "budget-daily"));
  assert.ok(center.resets.some((event) => event.id === "budget-monthly"));
});

test("alerts emit once per threshold period", async () => {
  const first = await budget.evaluateQuotaBudgetAlerts();
  assert.ok(first.some((alert) => alert.provider === "codex" && alert.threshold === 100));
  const second = await budget.evaluateQuotaBudgetAlerts();
  assert.deepEqual(second, []);
  assert.ok(state.readState().quotaBudgetAlertState.history.length > 0);
});

test("auto-route prefers cheaper unblocked Combo providers", () => {
  budget.setQuotaBudgetConfig({
    enabled: true,
    notificationsEnabled: false,
    autoRouteEnabled: true,
    providerBudgets: {
      codex: { dailyUsd: 1, monthlyUsd: 10 },
      antigravity: { dailyUsd: 100, monthlyUsd: 1000 },
      claude: { dailyUsd: 100, monthlyUsd: 1000 },
    },
  });
  const ordered = budget.prioritizeModelsByBudget([
    "codex/gpt-5.2",
    "claude/claude-sonnet-4-6",
    "antigravity/gemini-3-flash",
  ]);
  assert.equal(ordered[0], "antigravity/gemini-3-flash");
  assert.equal(ordered.at(-1), "codex/gpt-5.2");
});

test("hard vision capability stays ahead of budget preference", () => {
  state.writeState({
    modelCapabilities: {
      "codex/gpt-vision": { vision: true },
      "antigravity/gemini-text": { vision: false },
    },
  });
  const ordered = combos.orderedComboModels({
    id: "vision-budget",
    name: "vision-budget",
    models: ["codex/gpt-vision", "antigravity/gemini-text"],
    strategy: "fallback",
    stickyLimit: 1,
  }, {
    messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,x" } }] }],
  });
  assert.equal(ordered[0], "codex/gpt-vision");
});