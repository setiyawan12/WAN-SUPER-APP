import { management } from "./management-client.js";
import { getCodexUsage } from "./codex-usage.js";
import {
  getProviderUsageWindows,
  getUsageByCredential,
  getUsageByCredentialWindows,
} from "./usage-store.js";
import { readState, writeState } from "./state.js";
import { quotaBudgetBus } from "./quota-budget-bus.js";

const DEFAULT_PROVIDERS = ["codex", "claude", "antigravity", "xai"];
const ALERT_THRESHOLDS = [80, 90, 100];
const ROUTE_CACHE_MS = 15_000;
const MONITOR_INTERVAL_MS = 60_000;

const PRICING_PER_MILLION = {
  claude: { input: 3, output: 15 },
  anthropic: { input: 3, output: 15 },
  gemini: { input: 1.25, output: 5 },
  antigravity: { input: 1.25, output: 5 },
  codex: { input: 2, output: 8 },
  chatgpt: { input: 2, output: 8 },
  openai: { input: 2, output: 8 },
  xai: { input: 2, output: 10 },
};
const DEFAULT_PRICING = { input: 1, output: 3 };

function normalizeList(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const list = Object.values(raw).find((value) => Array.isArray(value));
    if (list) return list;
  }
  return [];
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : fallback;
}

export function canonicalProvider(provider) {
  const key = String(provider || "unknown").trim().toLowerCase();
  if (key === "anthropic") return "claude";
  if (key === "gemini") return "antigravity";
  if (key === "chatgpt") return "codex";
  return key || "unknown";
}

export function ratesForProvider(provider) {
  const key = String(provider || "").toLowerCase();
  const match = Object.keys(PRICING_PER_MILLION).find((name) => key.includes(name));
  return match ? PRICING_PER_MILLION[match] : DEFAULT_PRICING;
}

function estimateCost(stats, provider) {
  const rates = ratesForProvider(provider);
  return ((stats?.input_tokens || 0) / 1_000_000) * rates.input
    + ((stats?.output_tokens || 0) / 1_000_000) * rates.output;
}

function normalizeConfig(raw = {}) {
  const providerBudgets = {};
  for (const [provider, value] of Object.entries(raw.providerBudgets || {})) {
    const key = canonicalProvider(provider);
    providerBudgets[key] = {
      dailyUsd: safeNumber(value?.dailyUsd),
      monthlyUsd: safeNumber(value?.monthlyUsd),
    };
  }
  return {
    enabled: raw.enabled !== false,
    notificationsEnabled: raw.notificationsEnabled !== false,
    autoRouteEnabled: Boolean(raw.autoRouteEnabled),
    providerBudgets,
  };
}

export function getQuotaBudgetConfig() {
  return normalizeConfig(readState().quotaBudget || {});
}

export function setQuotaBudgetConfig(raw) {
  const config = normalizeConfig(raw);
  writeState({ quotaBudget: config });
  routeCache = { at: 0, statuses: new Map() };
  return config;
}

function emptyStats() {
  return {
    requests: 0,
    failed: 0,
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cached_tokens: 0,
    total_tokens: 0,
  };
}

function aggregateCanonical(rawWindow) {
  const result = {};
  for (const [rawProvider, stats] of Object.entries(rawWindow || {})) {
    const provider = canonicalProvider(rawProvider);
    result[provider] ??= emptyStats();
    for (const key of Object.keys(result[provider])) result[provider][key] += stats?.[key] || 0;
  }
  return result;
}

function nextLocalMidnight(now) {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
}

function nextLocalMonth(now) {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime();
}

function elapsedDayHours(now) {
  const date = new Date(now);
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  return Math.max(1 / 60, (now - start) / 3_600_000);
}

function elapsedMonthHours(now) {
  const date = new Date(now);
  const start = new Date(date.getFullYear(), date.getMonth(), 1).getTime();
  return Math.max(1 / 60, (now - start) / 3_600_000);
}

function totalMonthHours(now) {
  const date = new Date(now);
  const start = new Date(date.getFullYear(), date.getMonth(), 1).getTime();
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime();
  return (end - start) / 3_600_000;
}

function localPeriodKey(now, monthly = false) {
  const date = new Date(now);
  const pad = (value) => String(value).padStart(2, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return monthly ? day.slice(0, 7) : day;
}

function predictBudgetExhaustion(costUsd, budgetUsd, burnPerHourUsd, resetAt, now) {
  if (!(budgetUsd > 0) || !(burnPerHourUsd > 0) || costUsd >= budgetUsd) return null;
  const hours = (budgetUsd - costUsd) / burnPerHourUsd;
  const at = now + hours * 3_600_000;
  return at < resetAt ? Math.round(at) : null;
}

function budgetWindow({ costUsd, budgetUsd, projectedUsd, burnPerHourUsd, resetAt, now }) {
  const percent = budgetUsd > 0 ? Math.max(0, (costUsd / budgetUsd) * 100) : 0;
  return {
    costUsd,
    budgetUsd,
    percent,
    projectedUsd,
    resetAt,
    exhaustionAt: predictBudgetExhaustion(costUsd, budgetUsd, burnPerHourUsd, resetAt, now),
    status: budgetUsd <= 0 ? "off" : percent >= 100 ? "exhausted" : percent >= 90 ? "critical" : percent >= 80 ? "warning" : "ok",
  };
}

function providerBudgetRows(now = Date.now()) {
  const config = getQuotaBudgetConfig();
  const usage = getProviderUsageWindows({ now });
  const today = aggregateCanonical(usage.today);
  const month = aggregateCanonical(usage.month);
  const trailing24h = aggregateCanonical(usage.trailing24h);
  const providers = new Set([
    ...DEFAULT_PROVIDERS,
    ...Object.keys(today),
    ...Object.keys(month),
    ...Object.keys(config.providerBudgets),
  ]);

  return [...providers].sort().map((provider) => {
    const dailyStats = today[provider] || emptyStats();
    const monthlyStats = month[provider] || emptyStats();
    const recentStats = trailing24h[provider] || emptyStats();
    const budget = config.providerBudgets[provider] || { dailyUsd: 0, monthlyUsd: 0 };
    const dailyCost = estimateCost(dailyStats, provider);
    const monthlyCost = estimateCost(monthlyStats, provider);
    const recentCost = estimateCost(recentStats, provider);
    const dailyBurn = dailyCost / elapsedDayHours(now);
    const recentBurn = recentCost / 24;
    const monthlyBurn = recentBurn > 0 ? recentBurn : monthlyCost / elapsedMonthHours(now);

    return {
      provider,
      rates: ratesForProvider(provider),
      tokens: {
        today: dailyStats.total_tokens,
        month: monthlyStats.total_tokens,
        trailing24h: recentStats.total_tokens,
      },
      requests: { today: dailyStats.requests, month: monthlyStats.requests },
      daily: budgetWindow({
        costUsd: dailyCost,
        budgetUsd: budget.dailyUsd,
        projectedUsd: dailyCost / elapsedDayHours(now) * 24,
        burnPerHourUsd: dailyBurn,
        resetAt: nextLocalMidnight(now),
        now,
      }),
      monthly: budgetWindow({
        costUsd: monthlyCost,
        budgetUsd: budget.monthlyUsd,
        projectedUsd: monthlyCost / elapsedMonthHours(now) * totalMonthHours(now),
        burnPerHourUsd: monthlyBurn,
        resetAt: nextLocalMonth(now),
        now,
      }),
    };
  });
}

export function predictQuotaExhaustion(window, now = Date.now()) {
  const usedPercent = safeNumber(window?.usedPercent);
  const windowSeconds = safeNumber(window?.windowSeconds);
  const resetAfterSeconds = safeNumber(window?.resetAfterSeconds);
  const elapsedSeconds = Math.max(0, windowSeconds - resetAfterSeconds);
  if (!(usedPercent > 0) || elapsedSeconds < 300 || !(resetAfterSeconds > 0)) {
    return { exhaustionAt: null, beforeReset: false, confidence: "low", burnPercentPerHour: null };
  }
  const burnPercentPerSecond = usedPercent / elapsedSeconds;
  const secondsToExhaustion = (100 - usedPercent) / burnPercentPerSecond;
  const beforeReset = secondsToExhaustion > 0 && secondsToExhaustion < resetAfterSeconds;
  return {
    exhaustionAt: beforeReset ? Math.round(now + secondsToExhaustion * 1000) : null,
    beforeReset,
    confidence: elapsedSeconds >= Math.min(windowSeconds * 0.2, 3_600) ? "medium" : "low",
    burnPercentPerHour: burnPercentPerSecond * 3_600,
  };
}

function quotaWindow(window, now) {
  if (!window) return null;
  return {
    usedPercent: window.usedPercent ?? null,
    windowSeconds: window.windowSeconds ?? null,
    resetAfterSeconds: window.resetAfterSeconds ?? null,
    resetAt: window.resetAt || (window.resetAfterSeconds ? now + window.resetAfterSeconds * 1000 : null),
    prediction: predictQuotaExhaustion(window, now),
  };
}

function parseRetryAfter(value) {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric > 1e12 ? numeric : numeric * 1000;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

async function credentialQuotaRows(now = Date.now()) {
  let raw;
  try {
    raw = await management.listAuthFiles();
  } catch {
    return [];
  }
  const files = Array.isArray(raw?.files) ? raw.files : normalizeList(raw);
  const totalsByAuth = getUsageByCredential({ days: 90 });
  const windowsByAuth = getUsageByCredentialWindows();

  return Promise.all(files.map(async (file) => {
    const authIndex = file.auth_index !== undefined && file.auth_index !== null ? String(file.auth_index) : null;
    const totals = (authIndex && totalsByAuth[authIndex]) || emptyStats();
    const windows = (authIndex && windowsByAuth[authIndex]) || { window5h: emptyStats(), window7d: emptyStats() };
    const quota = file.provider === "codex" && file.name && file.path
      ? await getCodexUsage(file.name, file.path)
      : null;
    return {
      name: file.name,
      label: file.label || file.email || file.name,
      provider: canonicalProvider(file.provider),
      disabled: Boolean(file.disabled),
      unavailable: Boolean(file.unavailable),
      nextRetryAt: parseRetryAfter(file.next_retry_after),
      totalTokens: totals.total_tokens,
      window5hTokens: windows.window5h.total_tokens,
      window7dTokens: windows.window7d.total_tokens,
      quota: quota?.ok ? {
        ok: true,
        planType: quota.planType ?? null,
        primary: quotaWindow(quota.primary, now),
        secondary: quotaWindow(quota.secondary, now),
      } : quota ? { ok: false, reason: quota.reason || "unavailable" } : null,
    };
  }));
}

function resetCalendar(providers, credentials, now) {
  const events = [];
  const configured = providers.filter((row) => row.daily.budgetUsd > 0 || row.monthly.budgetUsd > 0);
  if (configured.some((row) => row.daily.budgetUsd > 0)) {
    events.push({ id: "budget-daily", kind: "budget", label: "Daily provider budgets", at: nextLocalMidnight(now), scope: "All configured providers" });
  }
  if (configured.some((row) => row.monthly.budgetUsd > 0)) {
    events.push({ id: "budget-monthly", kind: "budget", label: "Monthly provider budgets", at: nextLocalMonth(now), scope: "All configured providers" });
  }
  for (const credential of credentials) {
    const windows = [
      ["5h quota", credential.quota?.primary],
      ["Weekly quota", credential.quota?.secondary],
    ];
    for (const [label, window] of windows) {
      if (window?.resetAt) events.push({
        id: `${credential.name}:${label}:${window.resetAt}`,
        kind: "quota",
        label,
        at: window.resetAt,
        scope: `${credential.provider} · ${credential.label}`,
      });
    }
    if (credential.nextRetryAt) events.push({
      id: `${credential.name}:retry:${credential.nextRetryAt}`,
      kind: "retry",
      label: "Account retry",
      at: credential.nextRetryAt,
      scope: `${credential.provider} · ${credential.label}`,
    });
  }
  return events.filter((event) => event.at >= now - 60_000).sort((a, b) => a.at - b.at);
}

function alertHistory() {
  const state = readState().quotaBudgetAlertState;
  return Array.isArray(state?.history) ? state.history.slice(0, 50) : [];
}

export async function getQuotaBudgetCenter() {
  const now = Date.now();
  const config = getQuotaBudgetConfig();
  const providers = providerBudgetRows(now);
  const credentials = await credentialQuotaRows(now);
  return {
    config,
    providers,
    credentials,
    resets: resetCalendar(providers, credentials, now),
    alerts: alertHistory(),
    thresholds: ALERT_THRESHOLDS,
    generatedAt: now,
    pricingNote: "Estimated from static public API rates; subscription billing may differ.",
  };
}

function highestThreshold(percent) {
  if (!(percent >= ALERT_THRESHOLDS[0])) return null;
  return [...ALERT_THRESHOLDS].reverse().find((threshold) => percent >= threshold) || null;
}

function budgetAlertCandidates(center) {
  const candidates = [];
  for (const row of center.providers) {
    for (const [windowName, window] of [["daily", row.daily], ["monthly", row.monthly]]) {
      const threshold = highestThreshold(window.percent);
      if (!threshold || !(window.budgetUsd > 0)) continue;
      const period = localPeriodKey(center.generatedAt, windowName === "monthly");
      candidates.push({
        key: `budget:${row.provider}:${windowName}:${period}:${threshold}`,
        kind: "budget",
        threshold,
        provider: row.provider,
        title: threshold >= 100 ? `${row.provider} ${windowName} budget exhausted` : `${row.provider} ${windowName} budget at ${threshold}%`,
        message: `$${window.costUsd.toFixed(2)} of $${window.budgetUsd.toFixed(2)} used.`,
      });
    }
  }
  for (const credential of center.credentials) {
    for (const [windowName, window] of [["5h", credential.quota?.primary], ["weekly", credential.quota?.secondary]]) {
      const threshold = highestThreshold(window?.usedPercent);
      if (!threshold || !window?.resetAt) continue;
      candidates.push({
        key: `quota:${credential.name}:${windowName}:${Math.round(window.resetAt / 60_000)}:${threshold}`,
        kind: "quota",
        threshold,
        provider: credential.provider,
        title: threshold >= 100 ? `${credential.provider} ${windowName} quota exhausted` : `${credential.provider} ${windowName} quota at ${threshold}%`,
        message: `Account quota is ${Math.round(window.usedPercent)}% used.`,
      });
    }
  }
  return candidates;
}

export async function evaluateQuotaBudgetAlerts() {
  const config = getQuotaBudgetConfig();
  if (!config.enabled) return [];
  const center = await getQuotaBudgetCenter();
  const rawState = readState().quotaBudgetAlertState || {};
  const sent = { ...(rawState.sent || {}) };
  const history = Array.isArray(rawState.history) ? [...rawState.history] : [];
  const emitted = [];

  for (const candidate of budgetAlertCandidates(center)) {
    if (sent[candidate.key]) continue;
    const event = { ...candidate, id: candidate.key, at: Date.now(), severity: candidate.threshold >= 100 ? "exhausted" : candidate.threshold >= 90 ? "critical" : "warning" };
    sent[candidate.key] = event.at;
    history.unshift(event);
    emitted.push(event);
    // Always broadcast to the in-app event bridge. `notifyOs` controls only
    // native macOS/Windows notifications, not dashboard alerts/history.
    quotaBudgetBus.emit("alert", { ...event, notifyOs: config.notificationsEnabled });
  }

  if (emitted.length) {
    const sentEntries = Object.entries(sent).sort((a, b) => b[1] - a[1]).slice(0, 500);
    writeState({ quotaBudgetAlertState: { sent: Object.fromEntries(sentEntries), history: history.slice(0, 100) } });
  }
  return emitted;
}

let monitorStarted = false;
export function startQuotaBudgetMonitor() {
  if (monitorStarted) return;
  monitorStarted = true;
  // Give Electron main enough time to attach quotaBudgetBus listeners after
  // importing backend/index.js; otherwise the first alert could be persisted
  // as sent before the OS notification bridge exists.
  const initial = setTimeout(() => evaluateQuotaBudgetAlerts().catch(() => {}), 5_000);
  initial.unref?.();
  const timer = setInterval(() => evaluateQuotaBudgetAlerts().catch(() => {}), MONITOR_INTERVAL_MS);
  timer.unref?.();
}

export function providerForModel(modelId) {
  const state = readState();
  const remembered = state.modelProviderMemory?.[modelId];
  if (remembered) return canonicalProvider(remembered);
  const value = String(modelId || "").toLowerCase();
  const prefix = value.includes("/") ? value.slice(0, value.indexOf("/")) : "";
  if (["claude", "codex", "antigravity", "xai", "openai"].includes(prefix)) return canonicalProvider(prefix);
  if (value.includes("claude")) return "claude";
  if (value.includes("gemini")) return "antigravity";
  if (value.includes("grok")) return "xai";
  if (value.includes("gpt") || value.includes("codex") || /(^|[/-])o[134]([/-]|$)/.test(value)) return "codex";
  return prefix || "unknown";
}

let routeCache = { at: 0, statuses: new Map() };
function routingStatuses() {
  if (Date.now() - routeCache.at < ROUTE_CACHE_MS) return routeCache.statuses;
  const rows = providerBudgetRows();
  routeCache = {
    at: Date.now(),
    statuses: new Map(rows.map((row) => [row.provider, {
      blocked: row.daily.status === "exhausted" || row.monthly.status === "exhausted",
      costScore: (row.rates.input + row.rates.output) / 2,
    }])),
  };
  return routeCache.statuses;
}

/**
 * If a Combo's current primary provider has exhausted a configured WAN budget,
 * float cheaper providers that remain within budget to the front. Single-model
 * requests are never rewritten, and no routing change occurs before a budget
 * is actually exhausted.
 */
export function prioritizeModelsByBudget(models) {
  const config = getQuotaBudgetConfig();
  if (!config.enabled || !config.autoRouteEnabled || !Array.isArray(models) || models.length < 2) return models;
  const statuses = routingStatuses();
  const primary = statuses.get(providerForModel(models[0]));
  if (!primary?.blocked) return models;
  const decorated = models.map((model, index) => {
    const provider = providerForModel(model);
    const status = statuses.get(provider) || { blocked: false, costScore: (ratesForProvider(provider).input + ratesForProvider(provider).output) / 2 };
    return { model, index, ...status };
  });
  if (!decorated.some((item) => !item.blocked)) return models;
  return decorated
    .sort((a, b) => Number(a.blocked) - Number(b.blocked) || a.costScore - b.costScore || a.index - b.index)
    .map((item) => item.model);
}