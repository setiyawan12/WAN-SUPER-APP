import type { ProviderModelUsage, RecentUsageRecord } from "../../api/client";
import { normalizeProvider } from "./palette";
import type { ActivityEvent, Firing, GraphState, NeuronNode } from "./types";

// Pure merge/dedupe core for the neuron view. No React/DOM/window here so it
// can be unit-tested in isolation (see neuron.test.ts). All functions take an
// explicit `now` where time matters, and mutate+return the passed state so the
// hook can hold it in a ref while tests can hand in a fresh state each call.

const NODE_SEP = "::";
const DEDUPE_WINDOW_MS = 20_000; // A and B report the same Claude hit seconds apart
// Bound dedupe logs. Keep above usage-store MAX_RECENT (300) so a full ring
// buffer can't age a hash out and re-fire the same record as "new".
const SEEN_CAP = 800;
export const FIRING_TTL_MS = 4000; // how long a finished firing stays "active"
// After a path-A hop `end`, keep the neuron LIVE this long so tool rounds /
// multi-hop agent turns don't blink LIVE off between HTTP requests. Cleared
// early if a new `start` arrives on the same node. Hard end (source:"chat"
// session) settles immediately.
export const STICKY_BRIDGE_MS = 12_000;

export const nodeIdOf = (provider: string, model: string): string => `${provider}${NODE_SEP}${model}`;

export function emptyGraph(): GraphState {
  return { nodes: {}, firings: [], seenReqIds: [], seenRecent: [] };
}

// Parse either an ISO string (recent[].timestamp) or a number (event ts) to ms.
export function parseTs(ts: string | number | null | undefined): number | null {
  if (ts == null) return null;
  if (typeof ts === "number") return Number.isFinite(ts) ? ts : null;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

// Best-effort provider when an event omits it (proxy only tags Claude).
export function providerFromModel(model: string): string {
  const m = model.toLowerCase();
  if (m.includes("claude")) return "anthropic";
  if (m.includes("gemini")) return "gemini";
  if (m.includes("gpt") || m.includes("o1") || m.includes("o3") || m.includes("o4")) return "openai";
  if (m.includes("grok")) return "xai";
  return "unknown";
}

const KNOWN_LOBES = new Set(["anthropic", "gemini", "openai", "xai"]);

// Collapse aliases (claude→anthropic, codex→openai, …) so path A "anthropic"
// and path B "claude" / "antigravity" land on ONE neuron instead of twin gems.
// Login-provider names that aren't palette keys (e.g. antigravity) fall through
// to the model family so Claude-on-antigravity merges with anthropic::claude-*.
export function resolveProvider(provider: string | null | undefined, model: string): string {
  const raw = provider && provider !== "unknown" ? provider : "";
  const fromProvider = raw ? normalizeProvider(raw) : "";
  if (fromProvider && KNOWN_LOBES.has(fromProvider)) return fromProvider;
  const fromModel = providerFromModel(model);
  if (fromModel !== "unknown") return fromModel;
  return fromProvider || "unknown";
}

function ensureNode(state: GraphState, provider: string, model: string): NeuronNode {
  const id = nodeIdOf(provider, model);
  let node = state.nodes[id];
  if (!node) {
    node = {
      id,
      provider,
      model,
      requests: 0,
      lastHitTs: null,
      lastFailed: false,
      lastLatencyMs: null,
      lastAuthIndex: null,
    };
    state.nodes[id] = node;
  }
  return node;
}

function authIndexOf(value: string | null | undefined): string | null {
  if (value == null || value === "") return null;
  return String(value);
}

// Records `key`; returns true only the first time it's seen (bounded log).
function remember(list: string[], key: string): boolean {
  if (list.includes(key)) return false;
  list.push(key);
  if (list.length > SEEN_CAP) list.shift();
  return true;
}

// Stable hash for path-B dedupe. Include auth_index so two concurrent hits on
// the same model at the same timestamp (different credentials) stay distinct.
function recentHash(r: RecentUsageRecord): string {
  return [
    r.timestamp ?? "",
    r.provider ?? "",
    r.model ?? "",
    r.failed ? "1" : "0",
    r.latency_ms ?? "",
    r.auth_index ?? "",
    r.endpoint ?? "",
  ].join("|");
}

function hardSettle(firing: Firing, ev: ActivityEvent): void {
  firing.pending = false;
  firing.softEndedAt = null;
  firing.failed = ev.ok === false;
  if (ev.latency_ms != null) firing.latencyMs = ev.latency_ms;
  // Reclock so prune / LIVE / glow run from completion, not original start
  // (streams >> FIRING_TTL_MS would otherwise prune on the same tick as end).
  firing.startedAt = ev.ts;
}

// Path A: an instant live event from the proxy / in-app chat.
//
// LIVE must track the *user-visible turn*, not just one HTTP hop:
// - source "chat": whole in-app agent turn (tools + multi-round) — hard settle only on session end.
// - source "proxy": one stream through chat-proxy — soft-settle on end so tool gaps keep LIVE.
export function applyActivityEvent(state: GraphState, ev: ActivityEvent): GraphState {
  const provider = resolveProvider(ev.provider, ev.model);
  const node = ensureNode(state, provider, ev.model);
  const source = ev.source === "chat" ? "chat" : "proxy";

  if (ev.phase === "start") {
    // Duplicate start for a reqId we already fired → ignore.
    if (ev.reqId && !remember(state.seenReqIds, ev.reqId)) return state;

    // Fold into an open firing on the same neuron (session + hop, or hop + hop
    // after sticky soft-end). Avoids twin pulses and keeps LIVE continuous.
    const open = state.firings.find((f) => f.live && f.pending && f.nodeId === node.id);
    if (open) {
      open.softEndedAt = null;
      open.failed = false;
      // Rebind hop reqId so the matching proxy end can soft-settle this pulse.
      // Never rebind a chat-session id — session end must still find it.
      if (open.source !== "chat" && ev.reqId) open.reqId = ev.reqId;
      if (open.source === "proxy" && source === "chat") open.source = "chat";
      node.lastHitTs = Math.max(node.lastHitTs ?? 0, ev.ts);
      return state;
    }

    state.firings.push({
      id: ev.reqId ? `A:${ev.reqId}` : `A:${ev.ts}:${node.id}`,
      nodeId: node.id,
      reqId: ev.reqId,
      startedAt: ev.ts,
      failed: false,
      latencyMs: ev.latency_ms ?? null,
      live: true,
      pending: true,
      // Proxy-tap does not know which credential CLIProxyAPI picked; path B
      // fills this in when the same hit lands in recent[] (coveredByA fold).
      authIndex: null,
      source,
      softEndedAt: null,
    });
    node.lastHitTs = Math.max(node.lastHitTs ?? 0, ev.ts);
    return state;
  }

  // phase === "end"
  const firing = ev.reqId ? state.firings.find((f) => f.reqId === ev.reqId) : undefined;
  if (firing) {
    if (ev.latency_ms != null) firing.latencyMs = ev.latency_ms;
    firing.failed = ev.ok === false;
    // Session end (in-app chat) always hard-settles. Proxy hop soft-settles so
    // LIVE stays on during tool execution until the next hop or sticky timeout.
    // Also: if the open firing is a chat session, orphan proxy ends must not
    // hard-settle it (reqId may not match; when it does, source still wins).
    // Failed hops hard-settle: sticky LIVE after ok:false looked like a hang
    // (chip stayed "live · failed" for STICKY_BRIDGE_MS with nothing in flight).
    if (source === "chat" || firing.source === "chat" || ev.ok === false) {
      hardSettle(firing, ev);
    } else {
      firing.softEndedAt = ev.ts;
      firing.pending = true; // sticky bridge — still "in flight" for UI
    }
  }
  node.lastHitTs = Math.max(node.lastHitTs ?? 0, ev.ts);
  node.lastFailed = ev.ok === false;
  if (ev.latency_ms != null) node.lastLatencyMs = ev.latency_ms;
  return state;
}

// Path B: diff the recent[] ring buffer (newest-first) into near-live firings.
// `emitFirings: false` primes the dedupe log on first load without blinking the
// whole history. A record already covered by a live path-A firing for the same
// model within the window folds its metrics in but does NOT fire again.
//
// IMPORTANT — animation clock vs request clock:
// CLIProxyAPI's usage-queue is drained only every ~15s (usage-poller), so by the
// time a record reaches recent[] its `timestamp` is often already older than
// FIRING_TTL_MS / LIVE_MS (4s). If we set startedAt to that request timestamp,
// pruneFirings drops the firing on the same tick and Grok/Gemini/GPT (path-B
// only — they bypass chat-proxy) never show a pulse or LIVE chip. Node
// lastHitTs still uses the real request time; the firing's startedAt uses
// `now` (observation time) so the animation and LIVE window run from discovery.
export function applyRecent(
  state: GraphState,
  recent: RecentUsageRecord[],
  now: number,
  opts: { emitFirings?: boolean } = {}
): GraphState {
  const emit = opts.emitFirings !== false;
  // Walk oldest→newest so firings append in chronological order.
  for (let i = recent.length - 1; i >= 0; i--) {
    const r = recent[i];
    const ts = parseTs(r.timestamp) ?? now;
    const hash = recentHash(r);
    if (!remember(state.seenRecent, hash)) continue;

    const provider = resolveProvider(r.provider, r.model);
    const node = ensureNode(state, provider, r.model);
    const authIndex = authIndexOf(r.auth_index);
    node.lastHitTs = Math.max(node.lastHitTs ?? 0, ts);
    node.lastFailed = !!r.failed;
    if (r.latency_ms != null) node.lastLatencyMs = r.latency_ms;
    if (authIndex) node.lastAuthIndex = authIndex;
    if (!emit) continue;

    // Prefer folding into a live path-A firing for the same model so Claude
    // hits (instant A, then recent[] B) pick up the credential without a second pulse.
    // Match by nodeId (provider already normalized) OR model suffix fallback.
    // Long streams reclock startedAt to end on settle, so request ts may sit
    // far from that anchor — still fold if A is pending on the same node, or
    // settled A is still within the dedupe window of observation time / request.
    const targetId = node.id;
    const covered = state.firings.find((f) => {
      if (!f.live) return false;
      if (f.nodeId !== targetId && !f.nodeId.endsWith(`${NODE_SEP}${r.model}`)) return false;
      if (f.pending && f.nodeId === targetId) return true;
      if (Math.abs(f.startedAt - ts) <= DEDUPE_WINDOW_MS) return true;
      // After long-stream reclock, startedAt ≈ end; still fold if observation is
      // close to the reclocked start (completion) and models match.
      if (f.nodeId === targetId && Math.abs(f.startedAt - now) <= DEDUPE_WINDOW_MS) return true;
      return false;
    });
    if (covered) {
      if (authIndex) covered.authIndex = authIndex;
      if (r.latency_ms != null && covered.latencyMs == null) covered.latencyMs = r.latency_ms;
      if (r.failed) covered.failed = true;
      continue;
    }

    state.firings.push({
      id: `B:${hash}`,
      nodeId: node.id,
      // Observation time — see comment above. Real hit time is on node.lastHitTs.
      startedAt: now,
      failed: !!r.failed,
      latencyMs: r.latency_ms ?? null,
      live: false,
      pending: false,
      authIndex,
      source: "proxy",
      softEndedAt: null,
    });
  }
  return state;
}

// Fold cumulative request counts (node size) from the aggregated table.
export function applyWeights(state: GraphState, byProviderModel: ProviderModelUsage[]): GraphState {
  for (const pm of byProviderModel) {
    ensureNode(state, resolveProvider(pm.provider, pm.model), pm.model).requests = pm.requests;
  }
  return state;
}

// Soft-ended hops past STICKY_BRIDGE_MS hard-settle, then drop finished past TTL.
// Pending firings always survive (in-flight chat session / sticky bridge).
// Reclock startedAt to `now` on sticky timeout so the post-settle LIVE/glow
// window still runs (softEndedAt is already > FIRING_TTL_MS in the past).
export function pruneFirings(state: GraphState, now: number, ttl: number = FIRING_TTL_MS): GraphState {
  for (const f of state.firings) {
    if (f.pending && f.softEndedAt != null && now - f.softEndedAt > STICKY_BRIDGE_MS) {
      f.pending = false;
      f.startedAt = now;
      f.softEndedAt = null;
    }
  }
  state.firings = state.firings.filter((f) => f.pending || now - f.startedAt <= ttl);
  return state;
}

export function activeFirings(state: GraphState): Firing[] {
  return state.firings;
}
