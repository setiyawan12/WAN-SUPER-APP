import { readState, writeState } from "./state.js";

// Token Saver — output-token reduction via system-directive injection.
//
// Ported (in spirit) from 9router's Token Saver, adapted to this app's
// architecture. In 9router the compression is applied inside its own request
// pipeline; here the only request hop we own is the Node proxy in chat-proxy.js
// (/proxy/v1/chat/completions), so that is where these directives are appended.
//
// Both techniques work the same safe way: they append an OUTPUT-STYLE DIRECTIVE
// to the request's system prompt, steering the MODEL to produce terser / more
// minimal responses. The savings come from smaller *output*. We never rewrite
// the user's own message, and every directive explicitly preserves code
// correctness — so toggling these can trim tokens without corrupting requests.
//
//   • ponytail — minimalism / YAGNI steering (simpler solutions, less code)
//   • caveman  — telegraphic terseness (drop filler, articles, preamble)
//
// Only the techniques we can implement *safely and self-contained* are here.
// 9router's Headroom (external Python service + ML model) and Pxpipe (payload
// compression service) are deliberately NOT ported — they are separate services.

const LEVELS = ["lite", "full", "ultra"];

// Directive text per technique/level, appended to the system prompt. These
// steer OUTPUT only; they never touch the user's message and always keep code
// complete and correct (the wrapper in applyTokenSaver() restates that too).
const DIRECTIVES = {
  ponytail: {
    lite: "Prefer the simplest solution that fully satisfies the request; when two approaches both work, choose the smaller, less complex one.",
    full: "Follow a complexity ladder: reach for the standard library and built-in / native features before adding dependencies or new abstractions, and do not introduce layers the task did not ask for.",
    ultra: "Apply YAGNI strictly: build only exactly what was asked, prefer deleting over adding, make the smallest change that works, and add no speculative abstractions, extra files, or future-proofing.",
  },
  caveman: {
    lite: "Keep your answer concise: drop filler, hedging, and restating the question; keep normal grammar.",
    full: "Answer tersely: omit articles and pleasantries wherever meaning stays clear, sentence fragments are fine, and skip preamble and summaries.",
    ultra: "Answer in maximally compressed, telegraphic style: minimal words, no filler, no preamble, no recap — only essential information.",
  },
};

// Rough per-request output-token savings estimate by level, for the dashboard
// stats strip. Deliberately a heuristic — we never see the counterfactual
// (uncompressed) response — matching how 9router reports tokensSavedEst.
const SAVED_EST = { lite: 120, full: 350, ultra: 700 };

// In-memory since app start; reset on restart. Kept out of persisted state so
// we don't do a disk write on every proxied request.
const stats = { requests: 0, applied: 0, tokensSavedEst: 0, ponytail: 0, caveman: 0 };

function normalizeTech(t) {
  const level = LEVELS.includes(t?.level) ? t.level : "lite";
  return { enabled: Boolean(t?.enabled), level };
}

export function getTokenSaverConfig() {
  const raw = readState().tokenSaver || {};
  return {
    ponytail: normalizeTech(raw.ponytail),
    caveman: normalizeTech(raw.caveman),
  };
}

// GET payload for the dashboard: current config + live stats.
export function getTokenSaver() {
  return { config: getTokenSaverConfig(), stats: { ...stats } };
}

// PATCH: merge a partial config (per-technique) and persist. Returns the same
// shape as getTokenSaver so the UI can update in one round-trip.
export function setTokenSaver(partial = {}) {
  const cur = getTokenSaverConfig();
  const next = {
    ponytail: partial.ponytail ? normalizeTech({ ...cur.ponytail, ...partial.ponytail }) : cur.ponytail,
    caveman: partial.caveman ? normalizeTech({ ...cur.caveman, ...partial.caveman }) : cur.caveman,
  };
  writeState({ tokenSaver: next });
  return { config: next, stats: { ...stats } };
}

function buildDirective(cfg) {
  const parts = [];
  const techniques = [];
  let savedEst = 0;
  if (cfg.ponytail.enabled) {
    parts.push(DIRECTIVES.ponytail[cfg.ponytail.level]);
    savedEst += SAVED_EST[cfg.ponytail.level];
    techniques.push("ponytail");
  }
  if (cfg.caveman.enabled) {
    parts.push(DIRECTIVES.caveman[cfg.caveman.level]);
    savedEst += SAVED_EST[cfg.caveman.level];
    techniques.push("caveman");
  }
  return { text: parts.join(" "), savedEst, techniques };
}

// Appends enabled Token Saver directives to an OpenAI-format chat body IN PLACE
// and bumps the stats counters. Returns { applied, techniques } for logging.
// Caller wraps this in try/catch — a bug here must never break the proxy pipe.
export function applyTokenSaver(body) {
  stats.requests += 1;
  const cfg = getTokenSaverConfig();
  const { text, savedEst, techniques } = buildDirective(cfg);
  if (!text || !Array.isArray(body?.messages)) return { applied: false, techniques: [] };

  const directive =
    "\n\n[Output-style directives — apply to YOUR RESPONSE only. Never alter the user's request, and always keep code blocks complete and correct.]\n" +
    text;

  // Merge into the first system message if there is one; otherwise prepend a
  // system message. Many providers honor only the first system message, so we
  // never add a second one.
  const sysIdx = body.messages.findIndex((m) => m && m.role === "system");
  if (sysIdx >= 0) {
    const msg = body.messages[sysIdx];
    if (typeof msg.content === "string") {
      msg.content += directive;
    } else if (Array.isArray(msg.content)) {
      msg.content = [...msg.content, { type: "text", text: directive }];
    } else {
      body.messages.unshift({ role: "system", content: directive.trimStart() });
    }
  } else {
    body.messages.unshift({ role: "system", content: directive.trimStart() });
  }

  stats.applied += 1;
  stats.tokensSavedEst += savedEst;
  for (const t of techniques) stats[t] += 1;
  return { applied: true, techniques };
}
