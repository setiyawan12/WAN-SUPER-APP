import { randomUUID } from "node:crypto";
import fetch from "node-fetch";
import { proxyBaseUrl } from "./settings.js";
import { activityBus } from "./activity-bus.js";

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

export async function proxyChatCompletions(req, res) {
  const body = { ...req.body };
  const model = typeof body.model === "string" ? body.model : "unknown";
  const isClaude = /claude/i.test(model);
  if (isClaude) {
    for (const key of DEPRECATED_SAMPLING_PARAMS) delete body[key];
  }

  // Live activity tap (see activity-bus.js). All IDE models are routed here via
  // toCopilotModelEntry when ownBaseUrl is set, so path A covers Claude + Grok +
  // Gemini + GPT. `ended` guards the one-shot end event. source:"proxy" tags
  // where this hit came from (in-app chat uses source:"chat" from chat-service).
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

  const upstream = await fetch(`${proxyBaseUrl()}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Pass through whatever Authorization the client sent verbatim --
      // this proxy doesn't own auth, CLIProxyAPI's own proxy-auth setting
      // (see cliproxy-manager.js's setProxyAuthEnabled) still applies.
      ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
    },
    body: JSON.stringify(body),
  });

  const upstreamOk = upstream.status < 400;
  res.status(upstream.status);
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    // Node/Express recomputes these for its own response -- forwarding
    // CLIProxyAPI's original values here would corrupt the stream.
    if (lower === "content-encoding" || lower === "transfer-encoding" || lower === "connection") return;
    res.setHeader(key, value);
  });

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
