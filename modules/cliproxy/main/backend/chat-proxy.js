import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fetch from "node-fetch";
import yaml from "js-yaml";
import { configPath, proxyBaseUrl } from "./settings.js";
import { activityBus } from "./activity-bus.js";
import { readState } from "./state.js";
import { applyTokenSaver } from "./token-saver.js";
import { getModelCombo, orderedComboModels, shouldFallback } from "./model-combos.js";

// Fire-and-forget notification for the dashboard's live "neuron" activity feed.
// MUST never throw or block: a bug here cannot be allowed to break the proxy
// pipe that VS Code / JetBrains depend on, so every emit is wrapped.
function emitHit(evt) {
  try {
    activityBus.emit("hit", evt);
  } catch {
    /* never break the proxy */
  }
}

// Best-effort provider tag for path-A activity (mirrors graph.ts providerFromModel).
// Dashboard still re-resolves via resolveProvider; tagging here keeps chips/lobes
// correct even before path-B recent[] folds auth_index in.
function providerFromModel(model) {
  if (getModelCombo(String(model || ""))) return "combo";
  const m = String(model || "").toLowerCase();
  if (m.includes("claude")) return "anthropic";
  if (m.includes("gemini")) return "gemini";
  if (m.includes("gpt") || m.includes("o1") || m.includes("o3") || m.includes("o4")) return "openai";
  if (m.includes("grok")) return "xai";
  return "unknown";
}

// Anthropic hard-rejects non-default top_p/temperature/top_k on Claude
// Opus 4.7+ / Sonnet 4.5+ ("top_p is deprecated for this model", HTTP 400).
// VS Code's Copilot Chat still sends these as request defaults regardless of
// model, and CLIProxyAPI forwards them to Anthropic unmodified -- so this
// strips them for Claude-family requests before proxying to CLIProxyAPI's
// real /v1/chat/completions. Non-Claude models also use this hop now (Neuron
// path-A LIVE for Grok/Gemini/GPT) but keep sampling params intact.
const DEPRECATED_SAMPLING_PARAMS = ["top_p", "temperature", "top_k"];
const SAMPLING_PARAM_REJECTION =
  /unsupported value|does not support|only the default(?:\s*\([^)]*\))?\s+value is supported|deprecated for this model/i;
let openAiCompatModelCache = { mtimeMs: -1, ids: new Set() };

function openAiCompatModelIds() {
  const filePath = configPath();
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return new Set();
  }
  if (stat.mtimeMs === openAiCompatModelCache.mtimeMs) return openAiCompatModelCache.ids;

  const ids = new Set();
  try {
    const config = yaml.load(fs.readFileSync(filePath, "utf8")) || {};
    const providers = Array.isArray(config["openai-compatibility"])
      ? config["openai-compatibility"]
      : [];
    for (const provider of providers) {
      const models = Array.isArray(provider?.models) ? provider.models : [];
      if (!models.length && provider?.name) ids.add(String(provider.name));
      for (const model of models) {
        if (model?.name) ids.add(String(model.name));
        if (model?.alias) ids.add(String(model.alias));
      }
    }
  } catch {
    // A concurrent Management API write can briefly leave the file unreadable.
  }
  openAiCompatModelCache = { mtimeMs: stat.mtimeMs, ids };
  return ids;
}

function isOpenAiCompatModel(model) {
  const id = String(model || "").replace(/\([^)]*\)\s*$/, "");
  return openAiCompatModelIds().has(id);
}

function shouldRetryWithoutSamplingParams(body, message) {
  if (!SAMPLING_PARAM_REJECTION.test(message)) return false;
  return DEPRECATED_SAMPLING_PARAMS.some(
    (key) => Object.prototype.hasOwnProperty.call(body, key) && new RegExp(`\\b${key}\\b`, "i").test(message)
  );
}

function stripSamplingParams(body) {
  const stripped = { ...body };
  for (const key of DEPRECATED_SAMPLING_PARAMS) delete stripped[key];
  return stripped;
}

function prepareAttemptBody(baseBody, requestedModel, attemptModel, levelFromUrl) {
  const body = { ...baseBody, model: attemptModel };
  if (/claude/i.test(attemptModel) || isOpenAiCompatModel(attemptModel)) {
    for (const key of DEPRECATED_SAMPLING_PARAMS) delete body[key];
  }

  const savedLevel = readState().modelThinkingLevels?.[attemptModel] || "";
  const level = requestedModel === attemptModel ? levelFromUrl || savedLevel : savedLevel;
  if (level && !/\([^)]*\)\s*$/.test(body.model)) body.model = `${body.model}(${level})`;
  return body;
}

function forwardHeaders(upstream, res) {
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (["content-encoding", "content-length", "transfer-encoding", "connection"].includes(lower)) return;
    res.setHeader(key, value);
  });
}

function errorMessage(text, statusText) {
  try {
    const data = text ? JSON.parse(text) : {};
    return String(data?.error?.message || data?.error || data?.message || statusText || text || "");
  } catch {
    return String(text || statusText || "");
  }
}

export async function proxyChatCompletions(req, res) {
  const body = { ...req.body };
  const model = typeof body.model === "string" ? body.model : "unknown";

  // CLIProxyAPI selects a model's thinking budget via a "(level)" suffix on the
  // model NAME (e.g. "claude-opus-4-6(high)"), which it translates per provider
  // -- Claude -> thinking.budget_tokens, Gemini -> thinkingConfig.thinkingBudget,
  // OpenAI/Codex -> reasoning_effort. It is NOT a top-level reasoning_effort
  // field the client sets (the proxy derives that itself from the suffix). See
  // help.router-for.me/configuration/thinking. So we encode the chosen level
  // onto the model name here. The level comes from the URL (?thinking=, the
  // VS Code export path where we can only set a per-model URL, not a body) or,
  // failing that, the per-model choice saved in the dashboard's Models page
  // (state.modelThinkingLevels, keyed by model id) -- that fallback is what
  // makes the in-app Chat and every other proxy client honor the selection too.
  // Skipped when the caller already put its own "(...)" on the model name.
  const levelFromUrl = typeof req.query?.thinking === "string" ? req.query.thinking.trim() : "";

  // Live activity tap (see activity-bus.js). All IDE models are routed here via
  // toCopilotModelEntry when ownBaseUrl is set, so path A covers Claude + Grok +
  // Gemini + GPT. `ended` guards the one-shot end event. source:"proxy" tags
  // where this hit came from (in-app chat uses source:"chat" from chat-service).
  // Token Saver (see token-saver.js): append enabled output-style directives to
  // the system prompt to trim output tokens. Best-effort and idempotent-safe --
  // a failure here must never break the proxy pipe.
  try {
    applyTokenSaver(body);
  } catch {
    /* never break the proxy */
  }

  const reqId = randomUUID().slice(0, 8);
  const startedAt = Date.now();
  const provider = providerFromModel(model);
  emitHit({ phase: "start", reqId, model, provider, ts: startedAt, source: "proxy" });
  let ended = false;
  const finish = (ok) => {
    if (ended) return;
    ended = true;
    emitHit({
      phase: "end",
      reqId,
      model,
      provider,
      ok,
      latency_ms: Date.now() - startedAt,
      ts: Date.now(),
      source: "proxy",
    });
  };

  const combo = getModelCombo(model);
  const candidates = combo ? orderedComboModels(combo, body) : [model];
  const headers = {
    "Content-Type": "application/json",
    // Pass through whatever Authorization the client sent verbatim --
    // this proxy doesn't own auth, CLIProxyAPI's own proxy-auth setting
    // (see cliproxy-manager.js's setProxyAuthEnabled) still applies.
    ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
  };

  let upstream = null;
  let bufferedError = "";
  candidateLoop:
  for (let index = 0; index < candidates.length; index += 1) {
    const attemptModel = candidates[index];
    let attemptBody = prepareAttemptBody(body, model, attemptModel, levelFromUrl);
    let retriedWithoutSamplingParams = false;
    let message = "";

    while (true) {
      try {
        upstream = await fetch(`${proxyBaseUrl()}/v1/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(attemptBody),
        });
      } catch (err) {
        bufferedError = JSON.stringify({ error: { message: err.message || String(err) } });
        if (combo && index < candidates.length - 1) {
          console.warn(`Combo "${combo.name}": ${attemptModel} transport failed, trying next: ${err.message}`);
          continue candidateLoop;
        }
        finish(false);
        return res.status(503).type("application/json").send(bufferedError);
      }

      if (upstream.status < 400) break;

      bufferedError = await upstream.text();
      message = errorMessage(bufferedError, upstream.statusText);
      if (!retriedWithoutSamplingParams && shouldRetryWithoutSamplingParams(attemptBody, message)) {
        retriedWithoutSamplingParams = true;
        attemptBody = stripSamplingParams(attemptBody);
        upstream = null;
        console.warn(`${attemptModel} rejected custom sampling parameters; retrying with provider defaults.`);
        continue;
      }
      break;
    }

    if (upstream?.status < 400) break;
    if (combo && index < candidates.length - 1 && shouldFallback(upstream.status, message)) {
      console.warn(`Combo "${combo.name}": ${attemptModel} failed (${upstream.status}), trying next.`);
      upstream = null;
      continue candidateLoop;
    }
    break;
  }

  if (!upstream) {
    finish(false);
    return res.status(503).type("application/json").send(bufferedError || JSON.stringify({ error: { message: "All combo models unavailable." } }));
  }

  const upstreamOk = upstream.status < 400;
  res.status(upstream.status);
  forwardHeaders(upstream, res);

  if (!upstreamOk) {
    finish(false);
    res.end(bufferedError);
    return;
  }

  if (!upstream.body) {
    finish(upstreamOk);
    res.end();
    return;
  }

  // A mid-stream error on the upstream body (CLIProxyAPI dropping the
  // connection, a network blip during a long Claude response) would
  // otherwise be an unhandled stream 'error' event -- which crashes the
  // whole backend process, not just this one request. Tear the response
  // down cleanly instead. Also stop pulling from upstream if the client
  // (VS Code) disconnects first, so an abandoned request doesn't keep a
  // CLIProxyAPI stream open.
  upstream.body.on("error", (err) => {
    console.error(`chat-proxy stream error (${model}): ${err.message}`);
    finish(false);
    res.destroy(err);
  });
  // "close" fires on both a clean finish and a client (VS Code) disconnect;
  // "finish" fires once the response is fully flushed. Either way `ended`
  // makes the end event one-shot.
  res.on("close", () => {
    upstream.body.destroy();
    finish(upstreamOk);
  });
  res.on("finish", () => finish(upstreamOk));
  upstream.body.pipe(res);
}
