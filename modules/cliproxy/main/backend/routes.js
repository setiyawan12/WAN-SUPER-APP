import fs from "node:fs";
import express from "express";
import {
  getStatus,
  getRecentLogs,
  installOrUpdateBinary,
  startServer,
  stopServer,
  restartServer,
  setProxyAuthEnabled,
  startXaiLogin,
  getXaiLoginStatus,
} from "./cliproxy-manager.js";
import { management, patchRoutingStrategy, readRoutingStrategy } from "./management-client.js";
import { getCliProxyApiModels, listLiveModelIds, probeVisionSupport } from "./proxy-client.js";
import { buildModelList, toCopilotModelEntry } from "./model-catalog.js";
import { readState, writeState } from "./state.js";
import { settings, proxyBaseUrl } from "./settings.js";
import { getUsageSummary, getUsageByCredential, getUsageByCredentialWindows } from "./usage-store.js";
import { getCodexUsage } from "./codex-usage.js";
import { proxyChatCompletions } from "./chat-proxy.js";
import { testOpenAiCompatibleProvider } from "./openai-compat.js";
import { listCliTools, applyCliTool, resetCliTool } from "./cli-tools.js";
import { getTokenSaver, setTokenSaver } from "./token-saver.js";
import {
  createModelCombo,
  deleteModelCombo,
  listModelCombos,
  updateModelCombo,
} from "./model-combos.js";
import {
  evaluateQuotaBudgetAlerts,
  getQuotaBudgetCenter,
  setQuotaBudgetConfig,
} from "./quota-budget.js";

export const router = express.Router();

// CLIProxyAPI's GET for these list endpoints doesn't consistently document
// whether it returns a bare array or an object wrapping one -- normalize
// either shape into a plain array so the dashboard always gets the same
// { items: [...] } envelope regardless of upstream's exact response shape.
function normalizeList(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const arr = Object.values(raw).find((v) => Array.isArray(v));
    if (arr) return arr;
  }
  return [];
}

function asyncHandler(fn) {
  return (req, res) => fn(req, res).catch((err) => {
    if (err.expected) console.warn(err.message);
    else console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  });
}

const MODEL_DEFINITION_CHANNELS = [
  "claude",
  "gemini",
  "vertex",
  "aistudio",
  "codex",
  "kimi",
  "antigravity",
  "xai",
];
const MODEL_DEFINITIONS_TTL_MS = 5 * 60 * 1000;
// The endpoint is intermittent here (provider accounts flap up/down). Caching an
// *empty* result for the full 5 min would hide every thinking-level dropdown for
// minutes after one unlucky fetch, so a fetch that yields nothing is retried
// soon instead -- we only settle into the long TTL once we actually got data.
const MODEL_DEFINITIONS_EMPTY_TTL_MS = 20 * 1000;
let modelDefinitionsCache = { expiresAt: 0, byId: new Map() };
let modelDefinitionsRequest = null;

async function getModelDefinitionsById() {
  if (Date.now() < modelDefinitionsCache.expiresAt) return modelDefinitionsCache.byId;
  if (modelDefinitionsRequest) return modelDefinitionsRequest;

  modelDefinitionsRequest = Promise.allSettled(
    MODEL_DEFINITION_CHANNELS.map((channel) => management.getModelDefinitions(channel))
  ).then((results) => {
    const byId = new Map();
    for (const result of results) {
      if (result.status !== "fulfilled" || !Array.isArray(result.value?.models)) continue;
      for (const model of result.value.models) {
        if (!model?.id) continue;
        const current = byId.get(model.id);
        if (!current?.thinking || model.thinking) byId.set(model.id, model);
      }
    }
    modelDefinitionsCache = {
      expiresAt: Date.now() + (byId.size ? MODEL_DEFINITIONS_TTL_MS : MODEL_DEFINITIONS_EMPTY_TTL_MS),
      byId,
    };
    return byId;
  }).finally(() => {
    modelDefinitionsRequest = null;
  });

  return modelDefinitionsRequest;
}

// --- CLI Tools (wire external coding CLIs to this local proxy) -------------
// GET returns the catalog + live per-tool status; POST/DELETE write/remove a
// tool's config file. Endpoint + API key are filled in server-side from the
// running CLIProxyAPI (see cli-tools.js), so the renderer only sends models.
router.get("/cli-tools", asyncHandler(async (req, res) => res.json(await listCliTools())));
router.post("/cli-tools/:id", express.json(), asyncHandler(async (req, res) => res.json(await applyCliTool(req.params.id, req.body || {}))));
router.delete("/cli-tools/:id", asyncHandler(async (req, res) => res.json(await resetCliTool(req.params.id))));

// Token Saver (see token-saver.js): read config + live stats, and patch the
// per-technique on/off + level. The proxy hop applies whatever is enabled here.
router.get("/token-saver", (req, res) => res.json(getTokenSaver()));
router.patch("/token-saver", express.json(), (req, res) => res.json(setTokenSaver(req.body || {})));

// Virtual model ids backed by ordered real-model chains. They live in the
// desktop state because CLIProxyAPI itself does not provide cross-model
// fallback; chat-proxy.js expands them before forwarding upstream.
router.get("/model-combos", (req, res) => res.json({ combos: listModelCombos() }));
router.post(
  "/model-combos",
  express.json(),
  asyncHandler(async (req, res) => {
    await validateComboInput(req.body || {});
    res.status(201).json(createModelCombo(req.body || {}));
  })
);
router.put(
  "/model-combos/:id",
  express.json(),
  asyncHandler(async (req, res) => {
    await validateComboInput(req.body || {}, req.params.id);
    res.json(updateModelCombo(req.params.id, req.body || {}));
  })
);
router.delete("/model-combos/:id", asyncHandler(async (req, res) => res.json(deleteModelCombo(req.params.id))));

router.get(
  "/quota-budget",
  asyncHandler(async (req, res) => res.json(await getQuotaBudgetCenter()))
);
router.put(
  "/quota-budget/config",
  express.json(),
  asyncHandler(async (req, res) => {
    setQuotaBudgetConfig(req.body || {});
    await evaluateQuotaBudgetAlerts();
    res.json(await getQuotaBudgetCenter());
  })
);
router.post(
  "/quota-budget/check",
  asyncHandler(async (req, res) => {
    const emitted = await evaluateQuotaBudgetAlerts();
    res.json({ emitted, center: await getQuotaBudgetCenter() });
  })
);

// --- Server lifecycle -----------------------------------------------------
router.get("/server/status", (req, res) => res.json(getStatus()));

router.post(
  "/server/install",
  asyncHandler(async (req, res) => {
    const version = await installOrUpdateBinary();
    res.json({ ok: true, version });
  })
);

router.post("/server/start", asyncHandler(async (req, res) => res.json(await startServer())));
router.post("/server/stop", asyncHandler(async (req, res) => res.json(await stopServer())));
router.post("/server/restart", asyncHandler(async (req, res) => res.json(await restartServer())));

router.get("/server/logs", (req, res) => res.json({ lines: getRecentLogs() }));

// Diagnostic passthrough of CLIProxyAPI's native GET /v1/models response.
// No desktop catalog labels, provider inference, enabled state, capability
// probes, or model-definition metadata are merged into this payload.
router.get(
  "/models-cliproxyapi",
  asyncHandler(async (req, res) => res.json(await getCliProxyApiModels()))
);

// Lets the extension flip whether CLIProxyAPI requires the proxy API key at
// all -- needed for VS Code's "customoai" BYOK vendor, which never sends an
// Authorization header (see setProxyAuthEnabled's doc comment).
router.put(
  "/server/proxy-auth",
  express.json(),
  asyncHandler(async (req, res) => {
    const enabled = req.body?.enabled !== false;
    res.json({ ok: true, enabled, ...setProxyAuthEnabled(enabled) });
  })
);

// Hop in front of CLIProxyAPI's /v1/chat/completions for ALL IDE models when
// toCopilotModelEntry has ownBaseUrl (Neuron path-A LIVE). Claude also gets
// sampling-param sanitizing here (Anthropic rejects top_p/temperature/top_k on
// Opus 4.7+/Sonnet 4.5+; VS Code still sends them by default) — see chat-proxy.js.
router.post("/proxy/v1/chat/completions", express.json({ limit: "25mb" }), asyncHandler(proxyChatCompletions));

// --- Config (proxied to CLIProxyAPI's Management API) ---------------------
router.get("/config", asyncHandler(async (req, res) => res.json(await management.getConfig())));

router.get(
  "/config.yaml",
  asyncHandler(async (req, res) => {
    const yamlText = await management.getConfigYaml();
    res.type("text/plain").send(yamlText);
  })
);

router.put(
  "/config.yaml",
  express.text({ type: "*/*" }),
  asyncHandler(async (req, res) => res.json(await management.putConfigYaml(req.body)))
);

// Routing strategy CLIProxyAPI uses when multiple credentials match a
// request -- "round-robin" (default) or "fill-first". There's no dedicated
// Management API endpoint for this, so it's read/written through the same
// raw config.yaml the Config page already edits, surgically patching just
// the `routing.strategy` line (see patchRoutingStrategy) instead of
// re-serializing the whole file and losing the user's comments.
const ROUTING_STRATEGIES = ["round-robin", "fill-first"];

router.get(
  "/routing-strategy",
  asyncHandler(async (req, res) => {
    const yamlText = await management.getConfigYaml();
    res.json({ strategy: readRoutingStrategy(yamlText) });
  })
);

router.put(
  "/routing-strategy",
  express.json(),
  asyncHandler(async (req, res) => {
    const { strategy } = req.body || {};
    if (!ROUTING_STRATEGIES.includes(strategy)) {
      return res.status(400).json({ error: `Body must include { strategy: "round-robin" | "fill-first" }` });
    }
    const current = await management.getConfigYaml();
    const patched = patchRoutingStrategy(current, strategy);
    await management.putConfigYaml(patched);
    res.json({ strategy });
  })
);

// --- Logs from CLIProxyAPI itself (separate from our own process logs) ----
router.get(
  "/proxy-logs",
  asyncHandler(async (req, res) => res.json(await management.getLogs(req.query.after)))
);

// --- Auth files (OAuth credential management) ------------------------------

// GET /auth-files' response doesn't include each credential's `prefix`
// (confirmed empirically -- the field is stored and applied for routing, but
// not surfaced in this listing), so we read it directly off the auth file on
// disk (same pattern as codex-usage.js/antigravity-usage.js) and merge it in.
function readPrefixFromDisk(filePath) {
  if (!filePath) return "";
  try {
    const doc = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return typeof doc.prefix === "string" ? doc.prefix : "";
  } catch {
    return "";
  }
}

router.get(
  "/auth-files",
  asyncHandler(async (req, res) => {
    const raw = await management.listAuthFiles();
    const files = Array.isArray(raw?.files) ? raw.files : normalizeList(raw);
    const withPrefix = files.map((f) => ({ ...f, prefix: readPrefixFromDisk(f.path) }));
    // Light diagnostic when debugging "OAuth logged in but empty Auth store":
    // log provider counts (not tokens) on each fetch is too noisy — only when
    // query ?debug=1 is set.
    if (req.query.debug === "1" || req.query.debug === "true") {
      const byProvider = {};
      for (const f of withPrefix) {
        const p = f.provider || "unknown";
        byProvider[p] = (byProvider[p] || 0) + 1;
      }
      console.log(
        `[auth-files] count=${withPrefix.length} byProvider=${JSON.stringify(byProvider)} ` +
          `names=${withPrefix.map((f) => `${f.name}:${f.provider || "?"}`).join(",")}`
      );
    }
    res.json(Array.isArray(raw?.files) ? { ...raw, files: withPrefix } : withPrefix);
  })
);

router.delete(
  "/auth-files/:name",
  asyncHandler(async (req, res) => res.json(await management.deleteAuthFile(req.params.name)))
);

// Active/inactive switch: disabled=true takes the credential out of CLIProxyAPI's
// routing/round-robin without deleting its stored token, so it can be flipped
// back on later without re-logging in.
router.patch(
  "/auth-files/status",
  express.json(),
  asyncHandler(async (req, res) => {
    const { name, disabled } = req.body || {};
    if (!name || typeof disabled !== "boolean") {
      return res.status(400).json({ error: "Body must include { name: string, disabled: boolean }" });
    }
    res.json(await management.setAuthFileDisabled(name, disabled));
  })
);

// Namespaces a credential's models as "<prefix>/<model-id>" -- see
// management-client.js's setAuthFilePrefix doc comment for why this exists:
// it's the only way to address one specific credential when two providers
// (or two credentials of the same provider) serve the identical bare model
// id, since CLIProxyAPI otherwise pools every credential serving that id
// into one round-robin/fill-first group. Pass prefix: "" to clear it.
router.patch(
  "/auth-files/prefix",
  express.json(),
  asyncHandler(async (req, res) => {
    const { name, prefix } = req.body || {};
    if (!name || typeof prefix !== "string") {
      return res.status(400).json({ error: "Body must include { name: string, prefix: string }" });
    }
    if (!/^[a-zA-Z0-9_-]*$/.test(prefix)) {
      return res.status(400).json({ error: "Prefix may only contain letters, numbers, hyphens, and underscores" });
    }
    res.json(await management.setAuthFilePrefix(name, prefix));
  })
);

// Manually clears CLIProxyAPI's own quota/cooldown tracking for one account.
// `authIndex` is the stable runtime id from GET /auth-files (not the file name).
router.post(
  "/auth-files/reset-quota",
  express.json(),
  asyncHandler(async (req, res) => {
    const { authIndex } = req.body || {};
    if (!authIndex) {
      return res.status(400).json({ error: "Body must include { authIndex: string }" });
    }
    res.json(await management.resetQuota(authIndex));
  })
);

// Masks an API key for display, keeping just enough on each end to recognize
// which key is which without exposing the secret in the dashboard's network
// tab / React devtools.
function maskKey(key) {
  if (!key) return "";
  if (key.length <= 7) return "***";
  return `${key.slice(0, 3)}...${key.slice(-4)}`;
}

// Merges the two usage data sources CLIProxyAPI exposes:
//  - GET /auth-files: per-OAuth-account cumulative success/failed counters
//    plus a 20-bucket (10 min each) recent_requests timeline -- already
//    fetched for the Providers page, just re-shaped here.
//  - GET /api-key-usage: the same success/failed/recent_requests shape, but
//    keyed by provider + "base_url|api_key" for non-OAuth providers
//    (openai-compatibility, plus extra gemini/claude/codex API keys).
// Wrapped in one response so the dashboard's Usage page makes a single call.
router.get(
  "/usage",
  asyncHandler(async (req, res) => {
    const [authFilesRaw, apiKeyUsageRaw, openAiCompatEntries] = await Promise.all([
      management.listAuthFiles(),
      // Older CLIProxyAPI builds may not have this endpoint yet -- degrade
      // to "no api-key usage data" rather than failing the whole page.
      management.getApiKeyUsage().catch(() => ({})),
      getOpenAiCompatEntries(),
    ]);

    const files = Array.isArray(authFilesRaw?.files) ? authFilesRaw.files : normalizeList(authFilesRaw);
    const accounts = files.map((f) => ({
      name: f.name,
      label: f.label || f.email || f.name,
      provider: f.provider,
      disabled: !!f.disabled,
      unavailable: !!f.unavailable,
      success: f.success ?? 0,
      failed: f.failed ?? 0,
      recent_requests: f.recent_requests ?? [],
      // When unavailable=true, CLIProxyAPI may set this to when it expects
      // the quota/rate-limit to clear. Format varies by CLIProxyAPI version
      // (seen as either a unix timestamp or an ISO string) -- the dashboard
      // does best-effort parsing rather than assuming one format.
      next_retry_after: f.next_retry_after ?? null,
    }));

    // GET /api-key-usage only gives us "base_url|api_key" -- no human name.
    // For custom (openai-compatibility) providers we do have one: the entry's
    // own `name` field, matched here by base URL so the dashboard/extension
    // can show e.g. "minimax-m3" instead of a masked key like "sk-...Pzn4".
    const nameByBaseUrl = new Map(
      openAiCompatEntries.filter((e) => e?.name && e["base-url"]).map((e) => [e["base-url"], e.name])
    );

    const apiKeys = [];
    for (const [provider, keyed] of Object.entries(apiKeyUsageRaw || {})) {
      if (!keyed || typeof keyed !== "object") continue;
      for (const [composite, stats] of Object.entries(keyed)) {
        const sep = composite.indexOf("|");
        const baseUrl = sep === -1 ? "" : composite.slice(0, sep);
        const rawKey = sep === -1 ? composite : composite.slice(sep + 1);
        apiKeys.push({
          provider,
          name: (baseUrl && nameByBaseUrl.get(baseUrl)) || null,
          baseUrl: baseUrl || null,
          keyMasked: maskKey(rawKey),
          success: stats?.success ?? 0,
          failed: stats?.failed ?? 0,
          recent_requests: stats?.recent_requests ?? [],
        });
      }
    }

    const totals = [...accounts, ...apiKeys].reduce(
      (acc, x) => ({ success: acc.success + (x.success || 0), failed: acc.failed + (x.failed || 0) }),
      { success: 0, failed: 0 }
    );

    res.json({ accounts, apiKeys, totals });
  })
);

// Token-level usage as reported directly by the provider in each response
// body (input/output/total tokens, etc.) -- drained from CLIProxyAPI's
// pop-and-remove GET /usage-queue by usage-poller.js and persisted in
// usage-store.js, since that endpoint deletes records the moment anyone
// reads them. `days` controls how many of our own stored daily buckets to
// sum over (default 7); it does not change what CLIProxyAPI itself retains.
router.get("/usage/tokens", (req, res) => {
  const days = Number(req.query.days) || 7;
  res.json(getUsageSummary({ days }));
});

const ZERO_CRED_STATS = { requests: 0, failed: 0, input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cached_tokens: 0, total_tokens: 0 };

// Per-credential usage table (request/token/cache-rate totals joined with
// live rate-limit quota) for the Usage page's "Auth Files" view -- inspired
// by cpa-usage-keeper's dashboard, adapted to reuse the usage-queue data
// this backend already has instead of requiring Redis (see usage-store.js's
// getUsageByCredential/getUsageByCredentialWindows). Only Codex gets a live
// quota (see codex-usage.js) -- Antigravity's equivalent was removed: its
// only real quota data is Gemini-only (no 5h/weekly split to match this
// shape), and there's no legitimate remote API for its Claude/GPT usage
// (the only way to get that requires spoofing a client identity to Google,
// which risks the account being flagged -- not worth it for this feature).
router.get(
  "/usage/credentials",
  asyncHandler(async (req, res) => {
    const authFilesRaw = await management.listAuthFiles();
    const files = Array.isArray(authFilesRaw?.files) ? authFilesRaw.files : normalizeList(authFilesRaw);
    const totalsByAuth = getUsageByCredential({ days: 14 });
    const windowsByAuth = getUsageByCredentialWindows();

    const credentials = await Promise.all(
      files.map(async (f) => {
        const authIndex = f.auth_index !== undefined && f.auth_index !== null ? String(f.auth_index) : null;
        const totals = (authIndex && totalsByAuth[authIndex]) || ZERO_CRED_STATS;
        const windows = (authIndex && windowsByAuth[authIndex]) || { window5h: ZERO_CRED_STATS, window7d: ZERO_CRED_STATS };
        const cacheRate = totals.input_tokens > 0 ? Math.round((totals.cached_tokens / totals.input_tokens) * 100) : 0;

        const quota = f.provider === "codex" && f.name && f.path ? await getCodexUsage(f.name, f.path) : null;

        return {
          name: f.name,
          label: f.label || f.email || f.name,
          provider: f.provider,
          disabled: !!f.disabled,
          unavailable: !!f.unavailable,
          requests: totals.requests,
          failedRequests: totals.failed,
          totalTokens: totals.total_tokens,
          cacheRate,
          window5hTokens: windows.window5h.total_tokens,
          window7dTokens: windows.window7d.total_tokens,
          quota,
        };
      })
    );
    res.json({ credentials });
  })
);

// --- OAuth login flows ------------------------------------------------------
// Supported directly by CLIProxyAPI's Management API today.
const LOGIN_HANDLERS = {
  antigravity: management.getAntigravityAuthUrl,
  claude: management.getAnthropicAuthUrl,
  codex: management.getCodexAuthUrl,
};

router.get(
  "/providers/:provider/login",
  asyncHandler(async (req, res) => {
    // xAI has no Management API OAuth endpoint (see cliproxy-manager.js's
    // startXaiLogin doc comment) -- it goes through a standalone CLI login
    // process instead of the Management API flow every other provider uses,
    // but returns the same { status, url, state } shape so the dashboard's
    // existing startLogin/pollLogin flow doesn't need special-casing.
    if (req.params.provider === "xai") {
      console.log(`[oauth] GET /providers/xai/login — starting device-code flow`);
      const { url, state, userCode } = await startXaiLogin();
      console.log(
        `[oauth] xai login ready state=xai:${state} userCode=${userCode || "(none)"} url=${url}`
      );
      return res.json({ status: "ok", url, state: `xai:${state}`, userCode });
    }

    const handler = LOGIN_HANDLERS[req.params.provider];
    if (!handler) {
      return res.status(400).json({
        error: `No OAuth login endpoint for "${req.params.provider}". ` +
          `Gemini CLI / Qwen / iFlow currently require running the CLIProxyAPI CLI's ` +
          `own --login flow manually (see README "Known limitations").`,
      });
    }
    res.json(await handler());
  })
);

router.get(
  "/providers/login-status",
  asyncHandler(async (req, res) => {
    const state = req.query.state || "";
    // xAI login states are namespaced with an "xai:" prefix (see above) so
    // this route can tell them apart from Management-API-issued OAuth states
    // without a separate polling endpoint for the dashboard to call.
    if (state.startsWith("xai:")) {
      const result = getXaiLoginStatus(state.slice(4));
      if (result.status !== "wait") {
        console.log(
          `[oauth] xai login-status state=${state} status=${result.status}` +
            (result.error ? ` error=${result.error}` : "") +
            (result.diagnostics?.newFiles?.length
              ? ` newFiles=${result.diagnostics.newFiles.join(",")}`
              : "") +
            (result.diagnostics?.xaiFiles?.length
              ? ` xaiFiles=${result.diagnostics.xaiFiles.join(",")}`
              : "")
        );
      }
      return res.json(result);
    }
    res.json(await management.getAuthStatus(state));
  })
);

// --- Model catalog + BYOK sync for the VS Code extension --------------------
// The extension polls /models/export and writes the result into
// github.copilot.chat.customOAIModels itself (see extension/src/extension.ts) --
// this backend never touches VS Code's settings.json directly.
//
// Model list is fetched live from CLIProxyAPI's GET /v1/models (the real,
// currently-supported set for whatever accounts are logged in) and merged
// with the static MODEL_CATALOG for nicer labels. If the live call fails
// (server not running yet, no accounts logged in, proxy key not ready),
// we fall back to the static catalog so the page still renders something.
async function getLoggedInProviders() {
  try {
    const authFilesRaw = await management.listAuthFiles();
    const files = Array.isArray(authFilesRaw?.files) ? authFilesRaw.files : normalizeList(authFilesRaw);
    return Array.from(new Set(files.map((f) => f.provider).filter(Boolean)));
  } catch {
    // If auth-files can't be read, fall back to name-based guessing in buildModelList.
    return [];
  }
}

// Maps each credential's `prefix` (see /auth-files/prefix, management-client.js's
// setAuthFilePrefix doc comment) to its real provider, so buildModelList can
// resolve a prefixed live id like "claude/claude-sonnet-4-6" to the exact
// credential that owns it -- CLIProxyAPI's Management API doesn't surface
// `prefix` in GET /auth-files, so this reads each auth file directly (same
// pattern as the /auth-files route's readPrefixFromDisk).
async function getPrefixIndex() {
  try {
    const authFilesRaw = await management.listAuthFiles();
    const files = Array.isArray(authFilesRaw?.files) ? authFilesRaw.files : normalizeList(authFilesRaw);
    const index = {};
    for (const f of files) {
      const prefix = readPrefixFromDisk(f.path);
      if (prefix) index[prefix] = f.provider;
    }
    return index;
  } catch {
    return {};
  }
}

async function getOpenAiCompatEntries() {
  try {
    return normalizeList(await management.getOpenAiCompatibility());
  } catch {
    // Custom-provider lookup is best-effort -- if it fails, ids just fall
    // back to guessProvider() like before.
    return [];
  }
}

// In-process only (not persisted) -- tracks model ids currently mid-probe so
// concurrent /models polls (the dashboard refetches periodically) don't fire
// a second real request for the same id while the first is still in flight.
// Safe to lose on restart: a probe that was interrupted just gets re-queued
// the next time that id shows up unprobed.
const visionProbeInFlight = new Set();

/**
 * Fires (but does not await) a vision probe for `modelId` -- but only ever
 * once, automatically, for the lifetime of that id's entry. This costs a
 * real chat-completion request (and real tokens/credit) against a live
 * account, so an inconclusive result (quota exceeded, rate-limited, auth
 * hiccup, transient error) is cached exactly like a resolved one instead of
 * being retried on a timer: automatic retries used to fire on every GET
 * /models poll (every ~15s from the dashboard), which could keep spending
 * credit indefinitely against an account that was already rate-limited.
 * The dashboard's manual "Re-check" button is the only way to probe an id
 * again after this (see the /models/:id/verify-vision route below) --
 * that's a deliberate, user-initiated request, not an automatic retry.
 *
 * Deliberately fire-and-forget: probing means a real chat-completion request
 * against a live OAuth account, which can take a few seconds, and the
 * /models endpoint that triggers this needs to keep responding immediately
 * with whatever it already knows (capabilities.vision: "unknown" until the
 * probe lands).
 */
function ensureVisionProbed(modelId) {
  const existing = readState().modelCapabilities || {};
  if (existing[modelId] || visionProbeInFlight.has(modelId)) return;

  visionProbeInFlight.add(modelId);
  probeVisionSupport(modelId)
    .then((result) => {
      const current = readState().modelCapabilities || {};
      writeState({ modelCapabilities: { ...current, [modelId]: { ...result, checkedAt: Date.now() } } });
    })
    .catch((err) => {
      // Cache inconclusive results too (see the doc comment above for why)
      // so this id is never auto-probed again -- only "Re-check" retries it.
      const current = readState().modelCapabilities || {};
      writeState({
        modelCapabilities: { ...current, [modelId]: { vision: "unknown", note: err.message, checkedAt: Date.now() } },
      });
      if (err.inconclusive) {
        console.warn(`Vision probe for "${modelId}" inconclusive, won't auto-retry: ${err.message}`);
      }
    })
    .finally(() => visionProbeInFlight.delete(modelId));
}

async function getMergedCatalog() {
  const [loggedInProviders, openAiCompatEntries, prefixIndex, definitionsById] = await Promise.all([
    getLoggedInProviders(),
    getOpenAiCompatEntries(),
    getPrefixIndex(),
    getModelDefinitionsById(),
  ]);
  try {
    const liveIds = await listLiveModelIds();
    const state = readState();
    const memory = state.modelProviderMemory;
    const { models: baseModels, memory: nextMemory } = buildModelList(liveIds, loggedInProviders, openAiCompatEntries, memory, prefixIndex);
    // Last-known-good levels per base id. /model-definitions is intermittent
    // here, so we remember what it advertised while it was up and fall back to
    // that when a later fetch returns nothing -- otherwise the dropdowns blink
    // out every time the endpoint flaps. See state.js's modelThinkingLevelDefs.
    const levelDefs = state.modelThinkingLevelDefs || {};
    const nextLevelDefs = { ...levelDefs };
    const models = baseModels.map((model) => {
      const baseId = basePartOf(model.id, prefixIndex);
      const definition = definitionsById.get(baseId);
      const liveLevels = Array.isArray(definition?.thinking?.levels)
        ? definition.thinking.levels.filter((level) => typeof level === "string" && level.length > 0)
        : [];
      if (liveLevels.length) nextLevelDefs[baseId] = liveLevels; // learn while the endpoint is up
      const thinkingLevels = liveLevels.length ? liveLevels : levelDefs[baseId] || [];
      return {
        ...model,
        thinking: model.thinking || Boolean(definition?.thinking) || thinkingLevels.length > 0,
        ...(thinkingLevels.length ? { thinkingLevels } : {}),
      };
    });
    // Only hits disk when something actually changed -- a newly-learned
    // provider attribution or a freshly-seen set of thinking levels.
    if (JSON.stringify(nextMemory) !== JSON.stringify(memory)) {
      writeState({ modelProviderMemory: nextMemory });
    }
    if (JSON.stringify(nextLevelDefs) !== JSON.stringify(levelDefs)) {
      writeState({ modelThinkingLevelDefs: nextLevelDefs });
    }
    return {
      catalog: models,
      source: liveIds.length ? "live" : "empty",
      liveError: null,
      prefixIndex,
    };
  } catch (err) {
    return { catalog: [], source: "empty", liveError: err.message, prefixIndex };
  }
}

async function validateComboInput(input, editingId = "") {
  const { catalog } = await getMergedCatalog();
  const modelIds = new Set(catalog.map((model) => model.id));
  const comboNames = new Set(listModelCombos().filter((combo) => combo.id !== editingId).map((combo) => combo.name));
  const name = String(input?.name || "").trim();
  if (modelIds.has(name) || comboNames.has(name)) {
    throw Object.assign(new Error(`Model id "${name}" is already in use.`), { status: 409, expected: true });
  }

  if (modelIds.size > 0) {
    const unknown = (Array.isArray(input?.models) ? input.models : []).find((modelId) => !modelIds.has(modelId));
    if (unknown) {
      throw Object.assign(new Error(`Unknown live model "${unknown}".`), { status: 400, expected: true });
    }
  }
}

// Strips a live id's prefix segment (see /auth-files/prefix) back down to the
// underlying model name, e.g. "claude/claude-sonnet-4-6" -> "claude-sonnet-4-6".
// Only ever strips when the segment before "/" is a real, currently-set
// credential prefix -- a customProvider or catalog id's own "/" (e.g. an
// OpenRouter-style "meta-llama/llama-3.1-70b") is left untouched.
function basePartOf(id, prefixIndex) {
  const slash = id.indexOf("/");
  if (slash > 0 && prefixIndex[id.slice(0, slash)]) return id.slice(slash + 1);
  return id;
}

function comboModelEntry(combo, capabilities, enabledModelIds) {
  const memberCapabilities = combo.models.map((modelId) => capabilities[modelId]?.vision);
  const vision = memberCapabilities.includes(true)
    ? true
    : memberCapabilities.length > 0 && memberCapabilities.every((value) => value === false)
      ? false
      : "unknown";
  return {
    id: combo.name,
    provider: "combo",
    family: "combo",
    label: combo.name,
    thinking: false,
    enabled: enabledModelIds.includes(combo.name),
    capabilities: {
      vision,
      note: vision === true
        ? "At least one combo member is verified for vision."
        : vision === false
          ? "No combo member is verified for vision."
          : "Vision follows the selected combo member.",
    },
    combo: {
      models: combo.models,
      strategy: combo.strategy,
      stickyLimit: combo.stickyLimit,
    },
  };
}

router.get(
  "/models",
  asyncHandler(async (req, res) => {
    const state = readState();
    const { catalog, source, liveError, prefixIndex } = await getMergedCatalog();
    const capabilities = { ...(state.modelCapabilities || {}) };

    // A prefixed id and its bare counterpart both live-list from CLIProxyAPI
    // once force-model-prefix is on, but when they resolve to the same
    // provider (i.e. genuinely the same credential) they're the identical
    // underlying model -- probing vision support twice would fire two real,
    // quota-costing chat-completion requests for one fact. Reuse whichever
    // form was already probed instead of re-probing the other. (Ids that
    // resolve to *different* providers -- e.g. the bare id now routing to
    // Antigravity while the prefixed one is pinned to Claude Code -- are
    // correctly kept separate, since they may be genuinely different accounts.)
    const groups = new Map();
    for (const m of catalog) {
      const key = `${m.provider}::${basePartOf(m.id, prefixIndex)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m.id);
    }
    let capabilitiesChanged = false;
    for (const ids of groups.values()) {
      if (ids.length < 2) continue;
      const known = ids.find((id) => capabilities[id]);
      if (!known) continue;
      for (const id of ids) {
        if (id !== known && !capabilities[id]) {
          capabilities[id] = capabilities[known];
          capabilitiesChanged = true;
        }
      }
    }
    if (capabilitiesChanged) writeState({ modelCapabilities: capabilities });

    const thinkingLevels = state.modelThinkingLevels || {};
    const models = catalog.map((m) => {
      const capability = capabilities[m.id];
      if (!capability) ensureVisionProbed(m.id); // first time we've seen this id -- queue a one-time probe
      return {
        ...m,
        enabled: state.enabledModelIds.includes(m.id),
        capabilities: capability || { vision: "unknown" },
        // Current per-model reasoning-effort choice ("" = provider default).
        // Only surfaced for models that actually expose selectable levels.
        thinkingLevel: m.thinkingLevels?.length ? thinkingLevels[m.id] || "" : "",
      };
    });
    const comboModels = listModelCombos().map((combo) => comboModelEntry(combo, capabilities, state.enabledModelIds));
    res.json({ models: [...comboModels, ...models], source, liveError });
  })
);

// Manually (re-)probes one model's vision support, bypassing the "only ever
// probed once" rule that GET /models follows automatically -- used by the
// dashboard's "Re-check" action when a cached result looks stale or wrong.
// This is a real request against a live account, so unlike the auto-probe it
// runs synchronously and the caller waits for the actual result.
router.post(
  "/models/:id/verify-vision",
  asyncHandler(async (req, res) => {
    const modelId = req.params.id;
    const combo = listModelCombos().find((item) => item.name === modelId);
    if (combo) {
      return res.status(400).json({ error: "Combo capability is derived from its member models." });
    }
    try {
      const result = await probeVisionSupport(modelId);
      const current = readState().modelCapabilities || {};
      writeState({ modelCapabilities: { ...current, [modelId]: { ...result, checkedAt: Date.now() } } });
      res.json({ modelId, ...result });
    } catch (err) {
      if (err.inconclusive) {
        return res.status(409).json({ modelId, vision: "unknown", note: err.message, inconclusive: true });
      }
      res.status(500).json({ error: err.message });
    }
  })
);

router.put("/models", express.json(), (req, res) => {
  const enabledModelIds = Array.isArray(req.body?.enabledModelIds) ? req.body.enabledModelIds : [];
  const state = writeState({ enabledModelIds });
  res.json({ ok: true, enabledModelIds: state.enabledModelIds });
});

// Sets (or clears) the per-model reasoning-effort choice. `level` must be one
// of the model's own advertised thinking.levels (from the model-definitions
// merge) -- anything else is rejected so we never write a value CLIProxyAPI
// would reject at request time. An empty/absent `level` clears the choice,
// restoring the provider's default. Persisted to modelThinkingLevels and
// re-read by /models/export, which encodes it onto the Copilot model URL.
router.put(
  "/models/:id/thinking-level",
  express.json(),
  asyncHandler(async (req, res) => {
    const modelId = req.params.id;
    const level = typeof req.body?.level === "string" ? req.body.level.trim() : "";

    const { catalog } = await getMergedCatalog();
    const model = catalog.find((m) => m.id === modelId);
    if (!model) return res.status(404).json({ error: `Unknown model "${modelId}".` });

    const available = Array.isArray(model.thinkingLevels) ? model.thinkingLevels : [];
    if (level && !available.includes(level)) {
      return res.status(400).json({
        error: `"${level}" is not a selectable thinking level for ${modelId}.`,
        available,
      });
    }

    const current = { ...(readState().modelThinkingLevels || {}) };
    if (level) current[modelId] = level;
    else delete current[modelId];
    writeState({ modelThinkingLevels: current });
    res.json({ ok: true, modelId, level });
  })
);

router.get(
  "/models/export",
  asyncHandler(async (req, res) => {
    const state = readState();
    const { catalog } = await getMergedCatalog();
    const capabilities = state.modelCapabilities || {};
    const thinkingLevels = state.modelThinkingLevels || {};
    const comboCatalog = listModelCombos().map((combo) => comboModelEntry(combo, capabilities, state.enabledModelIds));
    const enabled = [...comboCatalog, ...catalog].filter((m) => state.enabledModelIds.includes(m.id));
    const entries = enabled.map((m) =>
      toCopilotModelEntry(
        { ...m, capabilities: capabilities[m.id], thinkingLevel: thinkingLevels[m.id] || "" },
        { proxyUrl: proxyBaseUrl(), ownBaseUrl: `http://127.0.0.1:${settings.port}` }
      )
    );
    // VS Code's current BYOK mechanism ("Custom Endpoint" provider, written to
    // chatLanguageModels.json) keys the API key at the *provider* level, not
    // per-model -- so the extension needs CLIProxyAPI's proxy key alongside
    // the model list to assemble that provider entry itself.
    res.json({ models: entries, apiKey: settings.proxyApiKey });
  })
);

// --- Custom API-key providers (GLM, Kimi, or any OpenAI-compatible endpoint,
// plus extra Gemini/Claude/Codex API keys alongside OAuth logins) -----------
// CLIProxyAPI's PUT here replaces the *entire* array, so the dashboard always
// sends back the full desired list (read full list, edit client-side, PUT
// whole list) rather than diffing single entries server-side.
router.post(
  "/api-providers/openai-compat/test",
  express.json(),
  asyncHandler(async (req, res) => {
    res.json(await testOpenAiCompatibleProvider({
      baseUrl: req.body?.baseUrl,
      apiKey: req.body?.apiKey,
      modelId: req.body?.modelId,
    }));
  })
);
router.get(
  "/api-providers/openai-compat",
  asyncHandler(async (req, res) => res.json({ items: normalizeList(await management.getOpenAiCompatibility()) }))
);
router.put(
  "/api-providers/openai-compat",
  express.json(),
  asyncHandler(async (req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    res.json({ items: normalizeList(await management.putOpenAiCompatibility(items)) });
  })
);

// xAI has no dedicated Management API key list (confirmed against
// help.router-for.me/management/api.html -- unlike gemini/claude/codex-key
// below, there's no /xai-api-key endpoint at all). Its API is OpenAI-
// compatible, so this reads/writes one openai-compatibility entry pinned to
// api.x.ai instead, presenting it to the dashboard as a single { item }
// (not a list) since xAI only ever needs the one shared entry -- multiple
// raw keys can still round-robin inside its api-key-entries array.
const XAI_BASE_URL = "https://api.x.ai/v1";

async function findXaiEntry() {
  const items = normalizeList(await management.getOpenAiCompatibility());
  return items.find((e) => e["base-url"] === XAI_BASE_URL) || null;
}

router.get(
  "/api-providers/xai-key",
  asyncHandler(async (req, res) => res.json({ item: await findXaiEntry() }))
);
router.put(
  "/api-providers/xai-key",
  express.json(),
  asyncHandler(async (req, res) => {
    const incoming = req.body?.item;
    const items = normalizeList(await management.getOpenAiCompatibility());
    const idx = items.findIndex((e) => e["base-url"] === XAI_BASE_URL);

    if (!incoming || !incoming["api-key-entries"]?.length) {
      if (idx !== -1) items.splice(idx, 1);
    } else {
      const entry = { ...incoming, name: "xai", "base-url": XAI_BASE_URL };
      if (idx === -1) items.push(entry);
      else items[idx] = entry;
    }

    await management.putOpenAiCompatibility(items);
    res.json({ item: await findXaiEntry() });
  })
);

router.get(
  "/api-providers/gemini-key",
  asyncHandler(async (req, res) => res.json({ items: normalizeList(await management.getGeminiApiKeys()) }))
);
router.put(
  "/api-providers/gemini-key",
  express.json(),
  asyncHandler(async (req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    res.json({ items: normalizeList(await management.putGeminiApiKeys(items)) });
  })
);

router.get(
  "/api-providers/claude-key",
  asyncHandler(async (req, res) => res.json({ items: normalizeList(await management.getClaudeApiKeys()) }))
);
router.put(
  "/api-providers/claude-key",
  express.json(),
  asyncHandler(async (req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    res.json({ items: normalizeList(await management.putClaudeApiKeys(items)) });
  })
);

router.get(
  "/api-providers/codex-key",
  asyncHandler(async (req, res) => res.json({ items: normalizeList(await management.getCodexApiKeys()) }))
);
router.put(
  "/api-providers/codex-key",
  express.json(),
  asyncHandler(async (req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    res.json({ items: normalizeList(await management.putCodexApiKeys(items)) });
  })
);

// --- Preferences --------------------------------------------------------
// Currently just the one global "show full emails vs. masked" switch, read by
// both the dashboard (every row with an email) and the VS Code extension's
// status bar/tooltip, so toggling it in one place updates both.
router.get("/preferences", (req, res) => res.json({ revealEmails: readState().revealEmails }));
router.put("/preferences", express.json(), (req, res) => {
  const revealEmails = Boolean(req.body?.revealEmails);
  const state = writeState({ revealEmails });
  res.json({ revealEmails: state.revealEmails });
});

// --- Misc -------------------------------------------------------------------
router.get("/settings", (req, res) =>
  res.json({
    cliproxyHome: settings.cliproxyHome,
    cliproxyPort: settings.cliproxyPort,
    cliproxyHost: settings.cliproxyHost,
    proxyBaseUrl: proxyBaseUrl(),
  })
);
