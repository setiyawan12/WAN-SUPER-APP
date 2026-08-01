import fs from "node:fs";
import path from "node:path";
import { settings, ensureDirs } from "./settings.js";

function statePath() {
  return path.join(settings.cliproxyHome, "renn-copilot-state.json");
}

const defaultState = {
  enabledModelIds: [],
  // Single global switch for whether account emails are shown in full or
  // masked, shared by the dashboard (every row that renders an email) and
  // the VS Code extension's status bar/tooltip -- replaces what used to be
  // a separate reveal/hide toggle on every individual row.
  revealEmails: false,
  // Learned model id -> provider attributions, recorded only while exactly
  // one OAuth provider is logged in (the only time CLIProxyAPI's flat
  // /v1/models list is unambiguous). Consulted before guessProvider()'s
  // name-based fallback so that logging into a second provider later
  // doesn't re-misattribute ids we already know the real answer for.
  // See model-catalog.js for the full rationale.
  modelProviderMemory: {},
  // Verified (not guessed) per-model capability results, keyed by model id.
  // Populated by routes.js's ensureVisionProbed()/the manual verify-vision
  // endpoint, which actually sends a tiny test image through CLIProxyAPI
  // rather than assuming every model supports it -- a real request that
  // costs real tokens/credit against a live account. Each entry looks like
  // { vision: true | false | "unknown", note?: string, checkedAt: number },
  // and once an id has ANY entry here (even an inconclusive "unknown" one)
  // it is never auto-probed again, no matter how long it's been -- only the
  // dashboard's manual "Re-check" action re-probes an already-checked id, as
  // a deliberate user-initiated request rather than an automatic retry.
  modelCapabilities: {},
  // Per-model reasoning-effort selection, keyed by model id, e.g.
  // { "claude/claude-opus-4-5": "high" }. Only set for models that actually
  // expose a `thinking.levels` list (see routes.js's model-definitions merge).
  // The chosen level is encoded onto the Copilot model URL as a
  // `?reasoning_effort=<level>` query param (see toCopilotModelEntry) and
  // re-injected into the request body by the proxy hop (see chat-proxy.js) --
  // VS Code's custom-OAI BYOK vendor only lets us set a per-model URL, not a
  // per-model request body, so the URL is the only place this choice can ride.
  // An id absent here (or set to "") means "let the provider pick its default".
  modelThinkingLevels: {},
  // Last-known-good reasoning-effort levels advertised by CLIProxyAPI's
  // /model-definitions, keyed by the *base* model id (prefix stripped), e.g.
  // { "claude-opus-4-7": ["low","medium","high","xhigh","max"] }. That endpoint
  // is intermittent here (it depends on provider accounts being reachable, and
  // the dashboard shows many flapping up/down), so relying on a single live
  // fetch made the per-model level dropdowns blink in and out. We remember the
  // levels the last time the endpoint DID return them, and fall back to this
  // when a later fetch comes back empty -- same "learn while data is available,
  // trust the memory afterwards" pattern as modelProviderMemory above. Cleared
  // per id only when the endpoint explicitly returns a different, non-empty set.
  modelThinkingLevelDefs: {},
  // Token Saver config (see token-saver.js). Output-token reduction applied by
  // the proxy hop (chat-proxy.js) — each technique appends a terseness/minimalism
  // directive to the request's system prompt, toggled independently with an
  // intensity level. Applies to every request that flows through the Node hop
  // (/proxy/v1/chat/completions): in-app Chat, VS Code, JetBrains, and any tool
  // pointed at that hop.
  tokenSaver: {
    ponytail: { enabled: false, level: "lite" },
    caveman: { enabled: false, level: "lite" },
  },
};

export function readState() {
  ensureDirs();
  if (!fs.existsSync(statePath())) return { ...defaultState };
  try {
    return { ...defaultState, ...JSON.parse(fs.readFileSync(statePath(), "utf8")) };
  } catch {
    return { ...defaultState };
  }
}

export function writeState(partial) {
  const next = { ...readState(), ...partial };
  ensureDirs();
  fs.writeFileSync(statePath(), JSON.stringify(next, null, 2), "utf8");
  return next;
}
