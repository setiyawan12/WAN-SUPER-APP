import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyActivityEvent,
  applyRecent,
  applyWeights,
  emptyGraph,
  parseTs,
  pruneFirings,
  providerFromModel,
  resolveProvider,
  STICKY_BRIDGE_MS,
} from "./graph";
import { computeLayout, orbitLayoutNodes } from "./layout";
import { normalizeProvider, providerPalette } from "./palette";
import {
  aftershockEnvelope,
  AFTERSHOCK_MS,
  allocateStreamPackets,
  birthProgress,
  BIRTH_MS,
  firingVisual,
  flashEnvelope,
  FLASH_MS,
  gemOrbitAngle,
  GEM_ORBIT_MS,
  gemSpinAngle,
  GEM_SPIN_MS,
  GLOW_MS,
  liveStreamArrivalKick,
  liveStreamBurst,
  liveStreamCoda,
  liveStreamDashPhase,
  liveStreamDesiredPackets,
  liveStreamFocusMul,
  liveStreamGlitch,
  liveStreamHaptic,
  liveStreamIntensity,
  LIVE_CODA_MS,
  LIVE_HOLD_MS,
  LIVE_STREAM_GLOBAL_PACKET_BUDGET,
  liveStreamLaneSeed,
  liveStreamLaunchKick,
  liveStreamPacketT,
  liveStreamPeriodMs,
  liveStreamReturnPeriodMs,
  liveStreamReturnT,
  LIVE_STREAM_PACKET_COUNT,
  liveStreamStutterT,
  liveStreamWave,
  pendingSwirl,
  shockwaveProgress,
  SHOCKWAVE_MS,
  TOTAL_MS,
  travelMsFor,
  TRAVEL_MS,
  wakeStrength,
  WAKE_PEAK,
} from "./anim";
import {
  accountForNode,
  agoText,
  densityMode,
  hitTest,
  nodeStatus,
  pinDetailFor,
  placeNodes,
  recentAccountsForNode,
  shortAccount,
  stageStats,
  statusLabel,
  tooltipFor,
} from "./overlay";
import { buildAuthIndexMap, resolveAccountLabel } from "./accounts";
import type { Firing, NeuronNode } from "./types";
import type { AuthFileEntry, RecentUsageRecord } from "../../api/client";

const node = (over: Partial<NeuronNode> & { id: string; provider: string; model: string }): NeuronNode => ({
  requests: 1,
  lastHitTs: null,
  lastFailed: false,
  lastLatencyMs: null,
  lastAuthIndex: null,
  ...over,
});

const rec = (over: Partial<RecentUsageRecord>): RecentUsageRecord => ({
  timestamp: new Date().toISOString(),
  provider: "gemini",
  model: "gemini-3-pro",
  failed: false,
  latency_ms: 500,
  tokens: {},
  endpoint: null,
  auth_type: null,
  auth_index: null,
  ...over,
});

test("path A: start fires a live pending neuron; proxy end soft-settles (sticky LIVE)", () => {
  const s = emptyGraph();
  const t0 = 1_000_000;
  applyActivityEvent(s, { phase: "start", reqId: "r1", model: "claude-opus-4-6", provider: "anthropic", ts: t0 });
  assert.equal(s.firings.length, 1);
  assert.equal(s.firings[0].live, true);
  assert.equal(s.firings[0].pending, true);
  assert.equal(s.nodes["anthropic::claude-opus-4-6"].lastHitTs, t0);

  applyActivityEvent(s, {
    phase: "end",
    reqId: "r1",
    model: "claude-opus-4-6",
    ok: true,
    latency_ms: 812,
    ts: t0 + 800,
    source: "proxy",
  });
  assert.equal(s.firings.length, 1, "end must not add a second firing");
  assert.equal(s.firings[0].pending, true, "proxy hop soft-settles — sticky bridge keeps LIVE");
  assert.equal(s.firings[0].softEndedAt, t0 + 800);
  assert.equal(s.firings[0].failed, false);
  assert.equal(s.nodes["anthropic::claude-opus-4-6"].lastLatencyMs, 812);
});

test("path A: duplicate start for same reqId is ignored", () => {
  const s = emptyGraph();
  const ev = { phase: "start" as const, reqId: "dup", model: "claude-opus-4-6", provider: "anthropic", ts: 5 };
  applyActivityEvent(s, ev);
  applyActivityEvent(s, ev);
  assert.equal(s.firings.length, 1);
});

test("path A end with ok:false marks failure", () => {
  const s = emptyGraph();
  applyActivityEvent(s, { phase: "start", reqId: "r2", model: "claude-sonnet-4-6", ts: 10 });
  applyActivityEvent(s, {
    phase: "end",
    reqId: "r2",
    model: "claude-sonnet-4-6",
    ok: false,
    ts: 20,
    source: "proxy",
  });
  assert.equal(s.firings[0].failed, true);
  assert.equal(s.firings[0].pending, false, "failed hop hard-settles — no sticky LIVE after error");
  assert.equal(s.firings[0].softEndedAt, null);
  assert.equal(s.firings[0].startedAt, 20, "reclock from end so failure glow survives prune");
  assert.equal(s.nodes["anthropic::claude-sonnet-4-6"].lastFailed, true);
});

test("dedupe: a Claude hit seen on A then B does NOT double-fire", () => {
  const s = emptyGraph();
  const ts = Date.parse("2026-07-19T00:00:00.000Z");
  applyActivityEvent(s, { phase: "start", reqId: "r3", model: "claude-opus-4-6", provider: "anthropic", ts });
  applyRecent(
    s,
    [
      rec({
        provider: "anthropic",
        model: "claude-opus-4-6",
        timestamp: new Date(ts + 4000).toISOString(),
        auth_index: "cred-42",
        latency_ms: 900,
      }),
    ],
    ts + 4000
  );
  const claudeFirings = s.firings.filter((f) => f.nodeId.endsWith("::claude-opus-4-6"));
  assert.equal(claudeFirings.length, 1, "path B must fold into the existing A firing, not add one");
  assert.equal(claudeFirings[0].live, true);
  assert.equal(claudeFirings[0].authIndex, "cred-42", "path B folds auth_index into the live A firing");
  assert.equal(s.nodes["anthropic::claude-opus-4-6"].lastAuthIndex, "cred-42");
  assert.equal(claudeFirings[0].latencyMs, 900);
});

test("path B: a provider not seen on A (gemini) fires near-live", () => {
  const s = emptyGraph();
  const ts = Date.parse("2026-07-19T00:00:00.000Z");
  applyRecent(
    s,
    [rec({ provider: "gemini", model: "gemini-3-pro", timestamp: new Date(ts).toISOString(), auth_index: "g-7" })],
    ts
  );
  assert.equal(s.firings.length, 1);
  assert.equal(s.firings[0].live, false);
  assert.equal(s.firings[0].nodeId, "gemini::gemini-3-pro");
  assert.equal(s.firings[0].authIndex, "g-7");
  assert.equal(s.nodes["gemini::gemini-3-pro"].lastAuthIndex, "g-7");
});

// Path B safety net: hits only in recent[] (legacy direct CLIProxyAPI URL,
// offline, lag). usage-poller drains ~15s later so request ts can be > TTL.
// Animate from observation time. IDE models now also take path A via chat-proxy
// when ownBaseUrl is set (toCopilotModelEntry) — this test keeps the B net.
test("path B: delayed Grok record still fires and survives prune (observation clock)", () => {
  const s = emptyGraph();
  const hitAt = Date.parse("2026-07-20T12:00:00.000Z");
  const observedAt = hitAt + 18_000; // 18s later — typical usage-queue drain lag
  applyRecent(
    s,
    [
      rec({
        provider: "xai",
        model: "grok-4.5",
        timestamp: new Date(hitAt).toISOString(),
        auth_index: "xai-cred-1",
        latency_ms: 1200,
      }),
    ],
    observedAt
  );
  assert.equal(s.firings.length, 1, "stale-timestamp Grok hit must still create a firing");
  assert.equal(s.firings[0].nodeId, "xai::grok-4.5");
  assert.equal(s.firings[0].live, false, "path B stays near-live (~), not instant ⚡");
  assert.equal(s.firings[0].startedAt, observedAt, "animation clock starts at discovery");
  assert.equal(s.nodes["xai::grok-4.5"].lastHitTs, hitAt, "node keeps real request time");
  assert.equal(s.nodes["xai::grok-4.5"].lastAuthIndex, "xai-cred-1");

  pruneFirings(s, observedAt + 500, 4000);
  assert.equal(s.firings.length, 1, "must not prune within LIVE/TTL window after discovery");

  const st = nodeStatus(s.nodes["xai::grok-4.5"], s.firings, observedAt + 500);
  assert.equal(st.live, true, "LIVE chip must light for newly-discovered path-B hits");
  assert.equal(st.label, "live");
});

test("path B: same record processed twice fires only once", () => {
  const s = emptyGraph();
  const r = rec({ timestamp: "2026-07-19T01:00:00.000Z" });
  applyRecent(s, [r], Date.now());
  applyRecent(s, [r], Date.now());
  assert.equal(s.firings.length, 1);
});

test("prime (emitFirings:false) records history without firing", () => {
  const s = emptyGraph();
  applyRecent(s, [rec({}), rec({ model: "gpt-5", provider: "openai" })], Date.now(), { emitFirings: false });
  assert.equal(s.firings.length, 0);
  assert.equal(Object.keys(s.nodes).length, 2, "nodes still created for weight/last-hit");
});

test("null timestamp falls back to now and does not throw", () => {
  const s = emptyGraph();
  const now = 9_999;
  applyRecent(s, [rec({ timestamp: null })], now);
  assert.equal(s.firings.length, 1);
  assert.equal(s.firings[0].startedAt, now);
});

test("applyWeights sets cumulative request counts", () => {
  const s = emptyGraph();
  applyWeights(s, [{ provider: "anthropic", model: "claude-opus-4-6", requests: 42, failed: 0, input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cached_tokens: 0, total_tokens: 0 }]);
  assert.equal(s.nodes["anthropic::claude-opus-4-6"].requests, 42);
});

test("pruneFirings drops finished past TTL but keeps pending", () => {
  const s = emptyGraph();
  applyActivityEvent(s, { phase: "start", reqId: "pend", model: "claude-opus-4-6", ts: 0 });
  // Path B now stamps startedAt=now (observation). Use a finished B firing that
  // is already past TTL relative to the prune clock so only the pending A survives.
  applyRecent(s, [rec({ timestamp: new Date(0).toISOString() })], 0);
  pruneFirings(s, 10_000, 4000);
  assert.equal(s.firings.length, 1);
  assert.equal(s.firings[0].pending, true);
});

// Streams longer than FIRING_TTL_MS stay pending mid-flight. Hard session end
// (source chat) reclocks startedAt so prune doesn't drop the completion glow.
test("path A: long stream chat-end reclocks startedAt so completion glow survives prune", () => {
  const s = emptyGraph();
  const t0 = 1_000_000;
  const tEnd = t0 + 30_000; // 30s stream
  applyActivityEvent(s, {
    phase: "start",
    reqId: "long",
    model: "claude-opus-4-6",
    provider: "anthropic",
    ts: t0,
    source: "chat",
  });
  pruneFirings(s, t0 + 10_000, 4000);
  assert.equal(s.firings.length, 1, "pending survives mid-stream prune");
  assert.equal(s.firings[0].pending, true);

  applyActivityEvent(s, {
    phase: "end",
    reqId: "long",
    model: "claude-opus-4-6",
    ok: true,
    latency_ms: 30_000,
    ts: tEnd,
    source: "chat",
  });
  assert.equal(s.firings[0].pending, false);
  assert.equal(s.firings[0].startedAt, tEnd, "end must reclock animation clock");

  pruneFirings(s, tEnd + 500, 4000);
  assert.equal(s.firings.length, 1, "must not prune immediately after long-stream end");
  const st = nodeStatus(s.nodes["anthropic::claude-opus-4-6"], s.firings, tEnd + 500);
  assert.equal(st.live, true, "LIVE chip after long stream completes");
});

// usage-tokens often tags Claude as provider "claude" or "antigravity", while
// path A emits "anthropic". Without normalize they spawn twin neurons.
test("provider normalize: path B claude/antigravity merge onto anthropic path-A node", () => {
  const s = emptyGraph();
  const t0 = Date.parse("2026-07-20T12:00:00.000Z");
  applyActivityEvent(s, {
    phase: "start",
    reqId: "merge-a",
    model: "claude-opus-4-6",
    provider: "anthropic",
    ts: t0,
  });
  applyRecent(
    s,
    [
      rec({
        provider: "claude",
        model: "claude-opus-4-6",
        timestamp: new Date(t0 + 2000).toISOString(),
        auth_index: "claude-cred",
        latency_ms: 800,
      }),
    ],
    t0 + 3000
  );
  assert.equal(Object.keys(s.nodes).filter((k) => k.includes("claude-opus-4-6")).length, 1);
  assert.ok(s.nodes["anthropic::claude-opus-4-6"]);
  assert.equal(s.firings.length, 1, "B folds into A — no twin pulse");
  assert.equal(s.firings[0].authIndex, "claude-cred");

  const s2 = emptyGraph();
  applyRecent(
    s2,
    [
      rec({
        provider: "antigravity",
        model: "claude-sonnet-4-6",
        timestamp: new Date(t0).toISOString(),
        auth_index: "ag-1",
      }),
    ],
    t0 + 1000
  );
  assert.equal(s2.firings[0].nodeId, "anthropic::claude-sonnet-4-6");
  assert.equal(resolveProvider("antigravity", "claude-sonnet-4-6"), "anthropic");
  assert.equal(resolveProvider("claude", "claude-opus-4-6"), "anthropic");
  assert.equal(resolveProvider("xai", "grok-4.5"), "xai");
});

// After a long stream ends (startedAt reclocked), late usage B with request-ts
// near the original start must still fold — not spawn a second near-live pulse.
test("path A+B: late recent after long stream still folds into A", () => {
  const s = emptyGraph();
  const t0 = 2_000_000;
  const tEnd = t0 + 25_000;
  applyActivityEvent(s, {
    phase: "start",
    reqId: "late-b",
    model: "claude-opus-4-6",
    provider: "anthropic",
    ts: t0,
    source: "chat",
  });
  applyActivityEvent(s, {
    phase: "end",
    reqId: "late-b",
    model: "claude-opus-4-6",
    ok: true,
    latency_ms: 25_000,
    ts: tEnd,
    source: "chat",
  });
  applyRecent(
    s,
    [
      rec({
        provider: "anthropic",
        model: "claude-opus-4-6",
        timestamp: new Date(t0 + 100).toISOString(),
        auth_index: "late-cred",
        latency_ms: 25_000,
      }),
    ],
    tEnd + 1000
  );
  const claude = s.firings.filter((f) => f.nodeId === "anthropic::claude-opus-4-6");
  assert.equal(claude.length, 1, "must not double-fire when B arrives after long A");
  assert.equal(claude[0].authIndex, "late-cred");
});

// LIVE used to drop as soon as the HTTP stream ended, even while the in-app
// agent was still running tools / another round. Sticky bridge + chat session
// keep the chip until the turn is really done.
test("sticky: proxy end keeps LIVE; next hop folds; bridge expires after STICKY_BRIDGE_MS", () => {
  const s = emptyGraph();
  const t0 = 3_000_000;
  applyActivityEvent(s, {
    phase: "start",
    reqId: "hop1",
    model: "claude-opus-4-6",
    provider: "anthropic",
    ts: t0,
    source: "proxy",
  });
  applyActivityEvent(s, {
    phase: "end",
    reqId: "hop1",
    model: "claude-opus-4-6",
    ok: true,
    latency_ms: 500,
    ts: t0 + 500,
    source: "proxy",
  });
  assert.equal(s.firings[0].pending, true);
  const stMid = nodeStatus(s.nodes["anthropic::claude-opus-4-6"], s.firings, t0 + 2000);
  assert.equal(stMid.live, true, "LIVE stays during sticky bridge (tool gap)");

  applyActivityEvent(s, {
    phase: "start",
    reqId: "hop2",
    model: "claude-opus-4-6",
    provider: "anthropic",
    ts: t0 + 3000,
    source: "proxy",
  });
  assert.equal(s.firings.length, 1, "second hop folds into same firing");
  assert.equal(s.firings[0].reqId, "hop2");
  assert.equal(s.firings[0].softEndedAt, null);

  applyActivityEvent(s, {
    phase: "end",
    reqId: "hop2",
    model: "claude-opus-4-6",
    ok: true,
    latency_ms: 400,
    ts: t0 + 3500,
    source: "proxy",
  });
  pruneFirings(s, t0 + 3500 + STICKY_BRIDGE_MS + 100, 4000);
  assert.equal(s.firings[0].pending, false, "sticky bridge expires → hard settle");
  const stAfter = nodeStatus(
    s.nodes["anthropic::claude-opus-4-6"],
    s.firings,
    t0 + 3500 + STICKY_BRIDGE_MS + 100
  );
  assert.equal(stAfter.live, true, "still within post-settle LIVE_MS window");
});

test("chat session: LIVE until chat end, ignores premature feel of hop end", () => {
  const s = emptyGraph();
  const t0 = 4_000_000;
  applyActivityEvent(s, {
    phase: "start",
    reqId: "sess-1",
    model: "claude-opus-4-6",
    provider: "anthropic",
    ts: t0,
    source: "chat",
  });
  // Proxy hop for same model mid-turn folds without rebinding session reqId.
  applyActivityEvent(s, {
    phase: "start",
    reqId: "proxy-hop",
    model: "claude-opus-4-6",
    provider: "anthropic",
    ts: t0 + 100,
    source: "proxy",
  });
  assert.equal(s.firings.length, 1);
  assert.equal(s.firings[0].reqId, "sess-1", "session id wins over hop");
  applyActivityEvent(s, {
    phase: "end",
    reqId: "proxy-hop",
    model: "claude-opus-4-6",
    ok: true,
    ts: t0 + 2000,
    source: "proxy",
  });
  assert.equal(s.firings[0].pending, true, "orphan proxy end does not settle session");
  assert.equal(s.firings[0].reqId, "sess-1");

  applyActivityEvent(s, {
    phase: "end",
    reqId: "sess-1",
    model: "claude-opus-4-6",
    ok: true,
    latency_ms: 15_000,
    ts: t0 + 15_000,
    source: "chat",
  });
  assert.equal(s.firings[0].pending, false);
  assert.equal(s.firings[0].startedAt, t0 + 15_000);
});

test("parseTs + providerFromModel helpers", () => {
  assert.equal(parseTs(null), null);
  assert.equal(parseTs(1234), 1234);
  assert.equal(parseTs("2026-07-19T00:00:00.000Z"), Date.parse("2026-07-19T00:00:00.000Z"));
  assert.equal(parseTs("not-a-date"), null);
  assert.equal(providerFromModel("claude-opus-4-6"), "anthropic");
  assert.equal(providerFromModel("gemini-3-pro"), "gemini");
  assert.equal(providerFromModel("gpt-5"), "openai");
  assert.equal(providerFromModel("grok-3"), "xai");
  assert.equal(providerFromModel("mystery"), "unknown");
});

test("layout: empty input yields centered, no nodes", () => {
  const l = computeLayout([]);
  assert.deepEqual(l.center, { x: 0.5, y: 0.5 });
  assert.equal(l.nodes.length, 0);
});

test("layout: deterministic and all coords within [0,1]", () => {
  const input: NeuronNode[] = [
    node({ id: "anthropic::claude-opus-4-6", provider: "anthropic", model: "claude-opus-4-6", requests: 90 }),
    node({ id: "anthropic::claude-sonnet-4-6", provider: "anthropic", model: "claude-sonnet-4-6", requests: 30 }),
    node({ id: "gemini::gemini-3-pro", provider: "gemini", model: "gemini-3-pro", requests: 10 }),
    node({ id: "openai::gpt-5", provider: "openai", model: "gpt-5", requests: 5 }),
  ];
  const a = computeLayout(input);
  const b = computeLayout(input);
  assert.deepEqual(a, b, "same input must give same layout");
  assert.equal(a.nodes.length, 4);
  for (const n of a.nodes) {
    assert.ok(n.x >= 0 && n.x <= 1, `x in range: ${n.x}`);
    assert.ok(n.y >= 0 && n.y <= 1, `y in range: ${n.y}`);
    assert.ok(n.size >= 0.4 && n.size <= 1.0001, `size in range: ${n.size}`);
  }
});

test("layout: bigger requests → bigger size", () => {
  const l = computeLayout([
    node({ id: "p::big", provider: "p", model: "big", requests: 100 }),
    node({ id: "p::small", provider: "p", model: "small", requests: 1 }),
  ]);
  const big = l.nodes.find((n) => n.model === "big")!;
  const small = l.nodes.find((n) => n.model === "small")!;
  assert.ok(big.size > small.size);
});

test("layout: orbitLayoutNodes rotates around center and preserves distance", () => {
  const center = { x: 0.5, y: 0.5 };
  const nodes = [
    { id: "a", provider: "p", model: "m", x: 0.5, y: 0.2, size: 0.8 },
    { id: "b", provider: "p", model: "n", x: 0.8, y: 0.5, size: 0.5 },
  ];
  assert.equal(orbitLayoutNodes(nodes, center, 0), nodes, "zero angle returns same ref");
  const half = orbitLayoutNodes(nodes, center, Math.PI / 2);
  // (0.5,0.2) → dx=0, dy=-0.3 → after +90°: dx=0.3, dy=0 → (0.8, 0.5)
  assert.ok(Math.abs(half[0].x - 0.8) < 1e-9 && Math.abs(half[0].y - 0.5) < 1e-9);
  for (let i = 0; i < nodes.length; i++) {
    const d0 = Math.hypot(nodes[i].x - center.x, nodes[i].y - center.y);
    const d1 = Math.hypot(half[i].x - center.x, half[i].y - center.y);
    assert.ok(Math.abs(d0 - d1) < 1e-9, "radius preserved");
    assert.equal(half[i].id, nodes[i].id);
    assert.equal(half[i].size, nodes[i].size);
  }
  const full = orbitLayoutNodes(nodes, center, Math.PI * 2);
  assert.ok(Math.abs(full[0].x - nodes[0].x) < 1e-9 && Math.abs(full[0].y - nodes[0].y) < 1e-9);
});

test("anim: gemOrbitAngle is slow full-turn and zero at origin", () => {
  assert.equal(gemOrbitAngle(0), 0);
  assert.ok(Math.abs(gemOrbitAngle(GEM_ORBIT_MS / 4) - Math.PI / 2) < 1e-9);
  assert.ok(Math.abs(gemOrbitAngle(GEM_ORBIT_MS) - 0) < 1e-9 || Math.abs(gemOrbitAngle(GEM_ORBIT_MS) - Math.PI * 2) < 1e-9);
  assert.ok(GEM_ORBIT_MS >= 60_000, "constellation orbit is deliberately slow");
});

test("anim: gemSpinAngle cycles independently of orbit", () => {
  assert.equal(gemSpinAngle(0, 0), 0);
  assert.ok(Math.abs(gemSpinAngle(GEM_SPIN_MS / 2, 0) - Math.PI) < 1e-9);
  assert.ok(GEM_SPIN_MS < GEM_ORBIT_MS, "facet spin is faster than constellation orbit");
});

test("palette: known providers + aliases resolve, unknown falls back", () => {
  assert.equal(normalizeProvider("Claude"), "anthropic");
  assert.equal(normalizeProvider("google-gemini"), "gemini");
  assert.equal(normalizeProvider("gpt-5"), "openai");
  assert.equal(normalizeProvider("codex"), "openai");
  assert.equal(normalizeProvider("grok"), "xai");
  assert.equal(providerPalette("anthropic").accent, "#e8c48a");
  assert.equal(providerPalette("totally-unknown").accent, "#a8b0c4");
});

test("anim: travel phase moves the pulse, neuron only pre-lit", () => {
  // travel is easeOutCubic(age/TRAVEL_MS), so mid-time sits past linear 0.5.
  const v = firingVisual(TRAVEL_MS / 2, false, true);
  assert.ok(v.travel != null && v.travel > 0.7 && v.travel < 0.95, `travel mid (eased): ${v.travel}`);
  assert.equal(v.ripple, null, "no ripple before arrival");
  assert.ok(v.glow < 0.35, "pre-lit until arrival");
  assert.ok(v.spark > 0.5, "spark peaks mid-travel");
  assert.equal(v.active, true);
});

test("anim: arrival starts a ripple and lights the neuron", () => {
  const v = firingVisual(TRAVEL_MS + 10, false, true);
  assert.equal(v.travel, null, "pulse has arrived");
  assert.ok(v.ripple != null && v.ripple >= 0 && v.ripple < 0.1, `ripple just started: ${v.ripple}`);
  assert.ok(v.glow > 0.9, "glow near full right after arrival");
});

test("anim: glow decays to zero and the firing goes inactive at end of life", () => {
  const mid = firingVisual(TRAVEL_MS + GLOW_MS / 2, false, true);
  assert.ok(mid.glow > 0.4 && mid.glow < 0.6, `half-decayed: ${mid.glow}`);
  const done = firingVisual(TOTAL_MS + 1, false, true);
  assert.equal(done.visible, false);
  assert.equal(done.active, false);
  assert.equal(done.glow, 0);
});

test("anim: a pending firing stays lit and keeps requesting frames past TOTAL_MS", () => {
  const v = firingVisual(TOTAL_MS + 5000, true, true);
  assert.equal(v.visible, true);
  assert.equal(v.active, true);
  assert.ok(v.glow > 0.5, "held bright while pending");
});

test("anim: reduced motion drops pulse + ripple but keeps the glow, no frame request", () => {
  const v = firingVisual(TRAVEL_MS + 100, false, false);
  assert.equal(v.travel, null);
  assert.equal(v.ripple, null);
  assert.ok(v.glow > 0.5, "glow still shown statically");
  assert.equal(v.active, false, "reduced motion never spins rAF");
});

test("anim: clock skew (negative age) is treated as a just-launched pulse", () => {
  const v = firingVisual(-50, false, true);
  assert.equal(v.travel, 0);
  assert.equal(v.active, true);
});

test("anim: travelMsFor defaults to TRAVEL_MS for live unknown latency", () => {
  assert.equal(travelMsFor(null, true), TRAVEL_MS);
  assert.equal(travelMsFor(undefined, true), TRAVEL_MS);
  assert.ok(travelMsFor(null, false) > TRAVEL_MS, "near-live slower");
});

test("anim: travelMsFor scales with latency and stays bounded", () => {
  const fast = travelMsFor(80, true);
  const mid = travelMsFor(800, true);
  const slow = travelMsFor(5000, true);
  assert.ok(fast < TRAVEL_MS, `fast ${fast}`);
  assert.ok(mid >= fast, `mid ${mid} >= fast ${fast}`);
  assert.ok(slow >= mid, `slow ${slow} >= mid ${mid}`);
  assert.ok(slow < TRAVEL_MS * 1.5, `slow capped ${slow}`);
});

test("anim: firingVisual optional travelMs extends life for slow hops", () => {
  const trip = 1200;
  const mid = firingVisual(trip + GLOW_MS / 2, false, true, trip);
  assert.ok(mid.glow > 0.4 && mid.glow < 0.6, `half-decayed custom: ${mid.glow}`);
  const done = firingVisual(trip + GLOW_MS + 1, false, true, trip);
  assert.equal(done.visible, false);
  // Default arg still uses TRAVEL_MS so existing TOTAL_MS contract holds
  const defaultDone = firingVisual(TOTAL_MS + 1, false, true);
  assert.equal(defaultDone.visible, false);
});

test("anim: flashEnvelope peaks early and dies by FLASH_MS", () => {
  assert.equal(flashEnvelope(-1), 0);
  assert.equal(flashEnvelope(FLASH_MS), 0);
  assert.ok(flashEnvelope(0) >= 0);
  const peak = flashEnvelope(FLASH_MS * 0.15);
  const tail = flashEnvelope(FLASH_MS * 0.7);
  assert.ok(peak > 0.7, `peak ${peak}`);
  assert.ok(tail > 0 && tail < peak, `tail ${tail}`);
});

test("anim: birthProgress eases out to 1 by BIRTH_MS", () => {
  assert.equal(birthProgress(-10), 0);
  assert.equal(birthProgress(BIRTH_MS), 1);
  assert.equal(birthProgress(BIRTH_MS + 100), 1);
  const mid = birthProgress(BIRTH_MS / 2);
  assert.ok(mid > 0.5 && mid < 1, `ease-out mid ${mid}`);
});

test("anim: aftershockEnvelope peaks early then dies by AFTERSHOCK_MS", () => {
  assert.equal(aftershockEnvelope(-1), 0);
  assert.equal(aftershockEnvelope(AFTERSHOCK_MS), 0);
  const peak = aftershockEnvelope(AFTERSHOCK_MS * 0.1);
  const tail = aftershockEnvelope(AFTERSHOCK_MS * 0.7);
  assert.ok(peak > 0.7, `peak ${peak}`);
  assert.ok(tail > 0 && tail < peak, `tail ${tail}`);
});

test("anim: shockwaveProgress delays then sweeps to 1", () => {
  assert.equal(shockwaveProgress(0), null, "delayed start");
  assert.equal(shockwaveProgress(50), null);
  const early = shockwaveProgress(200);
  assert.ok(early != null && early > 0 && early < 0.2, `early ${early}`);
  assert.equal(shockwaveProgress(90 + SHOCKWAVE_MS), null);
});

test("anim: wakeStrength peaks mid-travel and softens near-live", () => {
  assert.equal(wakeStrength(null, true), 0);
  assert.ok(Math.abs(wakeStrength(0, true)) < 1e-12);
  // sin(π) is float-noise near 0, not exact 0
  assert.ok(Math.abs(wakeStrength(1, true)) < 1e-12);
  const mid = wakeStrength(0.5, true);
  assert.ok(Math.abs(mid - WAKE_PEAK) < 1e-9, `mid live ${mid}`);
  const soft = wakeStrength(0.5, false);
  assert.ok(soft < mid && soft > 0.5, `near-live soft ${soft}`);
});

test("anim: pendingSwirl only while sticky/session open", () => {
  assert.equal(pendingSwirl(0, false), 0);
  assert.ok(pendingSwirl(-10, true) > 0, "pre-arrival pending hint");
  const hold = pendingSwirl(100, true);
  const later = pendingSwirl(20_000, true);
  assert.ok(hold > 0.5, `hold ${hold}`);
  assert.ok(later > 0 && later < hold, `decay ${later}`);
});

test("anim: firingVisual enrichment layers stay within life contracts", () => {
  // Mid-time uses easeOutCubic, so travel≈0.87 → wake is lower than pure mid-sine peak.
  const mid = firingVisual(TRAVEL_MS / 2, false, true);
  assert.ok(mid.wake > 0.2 && mid.wake < WAKE_PEAK, `wake mid ${mid.wake}`);
  assert.equal(mid.aftershock, 0);
  assert.equal(mid.shock, null);

  // Peak is ~12% of AFTERSHOCK_MS (~108ms); 50ms is still rising.
  const hit = firingVisual(TRAVEL_MS + 50, false, true);
  assert.ok(hit.aftershock > 0.4, `aftershock rising ${hit.aftershock}`);
  const peakHit = firingVisual(TRAVEL_MS + Math.round(AFTERSHOCK_MS * 0.12), false, true);
  assert.ok(peakHit.aftershock > 0.9, `aftershock peak ${peakHit.aftershock}`);
  assert.ok(hit.ember > 0, "ember spray on arrival");

  const delayed = firingVisual(TRAVEL_MS + 200, false, true);
  assert.ok(delayed.shock != null && delayed.shock > 0, `shock ${delayed.shock}`);

  const pending = firingVisual(TRAVEL_MS + 500, true, true);
  assert.ok(pending.swirl > 0.4, `swirl ${pending.swirl}`);
  assert.equal(pending.visible, true);

  // Default TOTAL_MS contract still holds
  const done = firingVisual(TOTAL_MS + 1, false, true);
  assert.equal(done.visible, false);
  assert.equal(done.aftershock, 0);
  assert.equal(done.wake, 0);
  assert.equal(done.swirl, 0);
});

test("anim: liveStreamIntensity stays full while pending, fades across LIVE_HOLD_MS", () => {
  assert.equal(liveStreamIntensity(100, true, true), 1, "pending live full stream");
  assert.ok(liveStreamIntensity(100, true, false) < 1, "near-live pending softer");
  const early = liveStreamIntensity(200, false, true);
  const late = liveStreamIntensity(LIVE_HOLD_MS - 200, false, true);
  assert.ok(early > 0.5, `early settled stream ${early}`);
  assert.ok(late > 0 && late < early, `late fade ${late} < early ${early}`);
  assert.equal(liveStreamIntensity(LIVE_HOLD_MS, false, true), 0);
  assert.equal(liveStreamIntensity(LIVE_HOLD_MS + 500, false, true), 0);
});

test("anim: liveStreamPacketT staggers packets in 0..1 and advances with time", () => {
  const a = liveStreamPacketT(0, 42, 0, LIVE_STREAM_PACKET_COUNT);
  const b = liveStreamPacketT(0, 42, 1, LIVE_STREAM_PACKET_COUNT);
  assert.ok(a >= 0 && a < 1, `packet0 ${a}`);
  assert.ok(b >= 0 && b < 1, `packet1 ${b}`);
  assert.ok(Math.abs(a - b) > 0.1, "staggered phases");
  const later = liveStreamPacketT(600, 42, 0, LIVE_STREAM_PACKET_COUNT);
  assert.notEqual(later, a, "moves over time");
  // Return lane is outbound inverted (within wrap).
  const ret = liveStreamReturnT(0, 42, 0, 2);
  assert.ok(ret >= 0 && ret <= 1, `return ${ret}`);
});

test("anim: liveStreamWave peaks at phase and dies outside width", () => {
  assert.ok(liveStreamWave(0.5, 0.5, 0.14) > 0.95, "peak on phase");
  assert.equal(liveStreamWave(0.5, 0.5 + 0.2, 0.14), 0, "outside width");
  // Wrap-around: phase near 0, sample near 1 should still register.
  const wrap = liveStreamWave(0.98, 0.02, 0.14);
  assert.ok(wrap > 0.2, `wrap lobe ${wrap}`);
  const phase = liveStreamDashPhase(1000, 7);
  assert.ok(phase >= 0 && phase < 1, `dash phase ${phase}`);
});

test("anim: liveStreamCoda soft-exits after LIVE_HOLD_MS", () => {
  assert.equal(liveStreamCoda(100, true, true), 0, "pending never codas");
  assert.equal(liveStreamCoda(LIVE_HOLD_MS * 0.5, false, true), 0, "mid-hold no coda");
  const pre = liveStreamCoda(LIVE_HOLD_MS * 0.9, false, true);
  assert.ok(pre > 0 && pre < 0.5, `pre-hold coda ramp ${pre}`);
  const justAfter = liveStreamCoda(LIVE_HOLD_MS + 1, false, true);
  assert.ok(justAfter > 0.2, `post-hold residual ${justAfter}`);
  assert.equal(liveStreamCoda(LIVE_HOLD_MS + LIVE_CODA_MS, false, true), 0, "coda ends");
  // Failed coda is shorter.
  assert.equal(liveStreamCoda(LIVE_HOLD_MS + LIVE_CODA_MS * 0.6, false, true, true), 0);
});

test("anim: liveStreamPeriodMs scales with latency + pending", () => {
  const mid = liveStreamPeriodMs(800, true, false);
  const fast = liveStreamPeriodMs(80, true, false);
  const slow = liveStreamPeriodMs(4000, true, false);
  assert.ok(fast < mid && mid < slow, `period ${fast} < ${mid} < ${slow}`);
  const pending = liveStreamPeriodMs(800, true, true);
  assert.ok(pending < mid, "pending snappier");
  const near = liveStreamPeriodMs(800, false, false);
  assert.ok(near > mid, "near-live slightly slower");
  const ret = liveStreamReturnPeriodMs(800, true, false);
  assert.ok(ret > mid, "return longer than outbound");
});

test("anim: liveStreamDesiredPackets + allocateStreamPackets budget", () => {
  const dense = liveStreamDesiredPackets(100, true, true, "high");
  const thin = liveStreamDesiredPackets(2500, false, false, "low");
  assert.ok(dense >= thin, `dense ${dense} >= thin ${thin}`);
  assert.ok(dense <= 8 && thin >= 2);

  const weights = [3, 1, 0.01, 2];
  const alloc = allocateStreamPackets(weights, 20, 2, 6);
  assert.equal(alloc.length, 4);
  assert.equal(alloc.reduce((a, b) => a + b, 0), 20);
  assert.ok(alloc[0] >= alloc[1], "heavier cable gets more packets");
  assert.ok(alloc.every((n) => n <= 6));
  // Zero budget empties.
  assert.deepEqual(allocateStreamPackets([1, 1], 0), [0, 0]);
  assert.ok(LIVE_STREAM_GLOBAL_PACKET_BUDGET >= 20);
});

test("anim: stutter/burst/kicks/glitch/focus/lane/haptic", () => {
  // Path A: stutter is identity.
  assert.equal(liveStreamStutterT(0.4, 1000, 9, true), 0.4);
  const st = liveStreamStutterT(0.4, 1000, 9, false);
  assert.ok(st >= 0 && st < 1 && st !== 0.4, `stutter ${st}`);

  const burstP = liveStreamBurst(500, 3, true);
  const burstI = liveStreamBurst(500, 3, false);
  assert.ok(burstP >= 0.62 && burstP <= 1.45);
  assert.ok(burstI >= 0.62 && burstI <= 1.45);

  assert.equal(liveStreamArrivalKick(0.5), 0);
  assert.ok(liveStreamArrivalKick(0.9) > 0.3, "arrival near gem");
  assert.equal(liveStreamLaunchKick(0.5), 0);
  assert.ok(liveStreamLaunchKick(0.08) > 0.3, "launch near caller");

  assert.equal(liveStreamGlitch(100, 1, false), 0);
  const g = liveStreamGlitch(100, 1, true);
  assert.ok(g > 0.3 && g <= 1, `glitch ${g}`);

  assert.equal(liveStreamFocusMul("a", null), 1);
  assert.equal(liveStreamFocusMul("a", "a"), 1);
  assert.equal(liveStreamFocusMul("a", "b"), 0.42);

  const s0 = liveStreamLaneSeed(10, 0);
  const s1 = liveStreamLaneSeed(10, 1);
  assert.notEqual(s0, s1);

  assert.equal(liveStreamHaptic(-1), 0);
  assert.ok(liveStreamHaptic(20) > 0.5, "haptic peak early");
  assert.equal(liveStreamHaptic(200), 0);

  // period-aware packet / dash
  const tFast = liveStreamPacketT(0, 1, 0, 4, 600);
  const tSlow = liveStreamPacketT(0, 1, 0, 4, 1800);
  assert.equal(tFast, tSlow, "same offset at t=0");
  const tFastLater = liveStreamPacketT(300, 1, 0, 4, 600);
  const tSlowLater = liveStreamPacketT(300, 1, 0, 4, 1800);
  assert.notEqual(tFastLater, tSlowLater, "period affects advance");
  const dash = liveStreamDashPhase(500, 11, 1000);
  assert.ok(dash >= 0 && dash < 1);
});

test("overlay: densityMode flips compact at 10 nodes", () => {
  assert.equal(densityMode(0), "full");
  assert.equal(densityMode(9), "full");
  assert.equal(densityMode(10), "compact");
  assert.equal(densityMode(40), "compact");
});

test("overlay: stageStats counts live/near/fail and last hit", () => {
  const now = 10_000;
  const nodes = [
    { id: "openai::a", provider: "openai", model: "a", requests: 2, lastHitTs: 9000, lastLatencyMs: 100, lastFailed: false, lastAuthIndex: 0 },
    { id: "xai::b", provider: "xai", model: "b", requests: 1, lastHitTs: 8000, lastLatencyMs: null, lastFailed: false, lastAuthIndex: null },
  ];
  const firings = [
    { id: "1", nodeId: "openai::a", startedAt: now - 100, failed: false, latencyMs: 90, live: true, pending: false, authIndex: 0 },
    { id: "2", nodeId: "xai::b", startedAt: now - 200, failed: true, latencyMs: 40, live: false, pending: false, authIndex: 1 },
    { id: "3", nodeId: "openai::a", startedAt: now - 50, failed: false, latencyMs: 80, live: true, pending: false, authIndex: 0 },
  ];
  const s = stageStats(nodes as any, firings as any, now);
  assert.equal(s.nodes, 2);
  assert.equal(s.live, 1, "unique live nodes");
  assert.equal(s.nearLive, 1);
  assert.equal(s.fails, 1);
  assert.equal(s.lastHitTs, now - 50);
  assert.ok(s.lastHitAgo.length > 0);
});

test("overlay: pinDetailFor returns recent trail + status", () => {
  const now = 20_000;
  const node = {
    id: "anthropic::claude",
    provider: "anthropic",
    model: "claude",
    requests: 3,
    lastHitTs: now - 500,
    lastLatencyMs: 120,
    lastFailed: false,
    lastAuthIndex: 2,
  };
  const firings = [
    { id: "a", nodeId: node.id, startedAt: now - 400, failed: false, latencyMs: 120, live: true, pending: false, authIndex: 2 },
    { id: "b", nodeId: node.id, startedAt: now - 900, failed: false, latencyMs: 40, live: false, pending: false, authIndex: 1 },
    { id: "c", nodeId: "other", startedAt: now - 100, failed: false, latencyMs: 10, live: true, pending: false, authIndex: 0 },
  ];
  const pin = pinDetailFor(node as any, firings as any, now, (i) => (i == null ? null : `acc-${i}`));
  assert.equal(pin.model, "claude");
  assert.equal(pin.provider, "anthropic");
  assert.equal(pin.status, "live");
  assert.equal(pin.failing, false);
  assert.equal(pin.hasFail, false);
  assert.equal(pin.account, "acc-2");
  assert.equal(pin.recent.length, 2);
  assert.equal(pin.recent[0].live, true);
  assert.ok(pin.latency?.includes("120"));
  // Solo fresh fail → failed chip/status.
  const pinFail = pinDetailFor(
    node as any,
    [{ ...firings[0], failed: true }] as any,
    now,
    (i) => (i == null ? null : `acc-${i}`),
  );
  assert.equal(pinFail.status, "failed");
  assert.equal(pinFail.failing, true);
  assert.equal(pinFail.hasFail, true);
  // Concurrent healthy LIVE on same gem wins over a fail hop, but notes the fail.
  const pinMixed = pinDetailFor(
    node as any,
    [
      { ...firings[0], id: "ok", failed: false, live: true, pending: true },
      { ...firings[0], id: "bad", failed: true, live: true, pending: false, startedAt: now - 300 },
    ] as any,
    now,
    (i) => (i == null ? null : `acc-${i}`),
  );
  assert.equal(pinMixed.status, "live · also fail");
  assert.equal(pinMixed.failing, false);
  assert.equal(pinMixed.hasFail, true);
});

const firing = (over: Partial<Firing> & { nodeId: string }): Firing => ({
  id: `f-${Math.random()}`,
  startedAt: 0,
  failed: false,
  latencyMs: null,
  live: true,
  pending: false,
  authIndex: null,
  ...over,
});

test("overlay: placeNodes maps normalized layout into px and hitTest finds the nearest", () => {
  const layout = computeLayout([
    node({ id: "anthropic::claude-opus-4-6", provider: "anthropic", model: "claude-opus-4-6", requests: 50 }),
    node({ id: "gemini::gemini-3-pro", provider: "gemini", model: "gemini-3-pro", requests: 10 }),
  ]);
  const views = placeNodes(layout, 800, 400);
  assert.equal(views.length, 2);
  for (const v of views) {
    assert.ok(v.x >= 0 && v.x <= 800 && v.y >= 0 && v.y <= 400, `${v.id} in px bounds`);
    assert.ok(v.r > 0, "has a radius");
  }
  const target = views[0];
  assert.equal(hitTest(views, target.x, target.y), target.id, "dead-center hits");
  assert.equal(hitTest(views, 5, 395), null, "empty corner hits nothing");
});

test("overlay: placeNodes with orbitRad moves gems and hitTest tracks them", () => {
  const layout = computeLayout([
    node({ id: "anthropic::claude-opus-4-6", provider: "anthropic", model: "claude-opus-4-6", requests: 50 }),
    node({ id: "gemini::gemini-3-pro", provider: "gemini", model: "gemini-3-pro", requests: 10 }),
  ]);
  const staticViews = placeNodes(layout, 800, 400, 0);
  const spun = placeNodes(layout, 800, 400, Math.PI / 2);
  assert.equal(spun.length, staticViews.length);
  // At least one gem should move under a non-zero orbit (unless coincidentally at center).
  const moved = staticViews.some((v, i) => Math.hypot(v.x - spun[i].x, v.y - spun[i].y) > 1);
  assert.ok(moved, "orbit shifts gem pixel positions");
  const target = spun[0];
  assert.equal(hitTest(spun, target.x, target.y), target.id, "hit-test follows orbit");
  // Old static center should usually miss after a quarter turn (unless radius ~0).
  if (Math.hypot(staticViews[0].x - 400, staticViews[0].y - 200) > 40) {
    assert.notEqual(hitTest(spun, staticViews[0].x, staticViews[0].y), staticViews[0].id);
  }
});

test("overlay: agoText buckets seconds, minutes, and null", () => {
  const now = 1_000_000;
  assert.equal(agoText(null, now), "—");
  assert.equal(agoText(now, now), "now");
  assert.equal(agoText(now - 8000, now), "8s ago");
  assert.equal(agoText(now - 125_000, now), "2m 5s ago");
});

test("overlay: nodeStatus reports live for a pending firing, ago otherwise", () => {
  const now = 1_000_000;
  const n = node({ id: "anthropic::claude-opus-4-6", provider: "anthropic", model: "claude-opus-4-6", lastHitTs: now - 3000 });
  const live = nodeStatus(n, [firing({ nodeId: n.id, startedAt: now, pending: true })], now);
  assert.equal(live.live, true);
  assert.equal(live.label, "live");
  const idle = nodeStatus(n, [], now);
  assert.equal(idle.live, false);
  assert.equal(idle.label, "3s ago");
});

test("overlay: nodeStatus flags a failing live firing", () => {
  const now = 1_000_000;
  const n = node({ id: "gemini::gemini-3-pro", provider: "gemini", model: "gemini-3-pro", lastHitTs: now });
  const st = nodeStatus(n, [firing({ nodeId: n.id, startedAt: now - 500, failed: true })], now);
  assert.equal(st.live, true);
  assert.equal(st.failing, true);
  assert.equal(st.hasFail, true);
});

test("overlay: nodeStatus prefers healthy live over concurrent fail on same gem", () => {
  const now = 1_000_000;
  const n = node({ id: "anthropic::claude-opus-4-6", provider: "anthropic", model: "claude-opus-4-6", lastHitTs: now });
  const st = nodeStatus(
    n,
    [
      firing({ nodeId: n.id, startedAt: now - 100, failed: false, live: true, pending: true }),
      firing({ nodeId: n.id, startedAt: now - 200, failed: true, live: true, pending: false }),
    ],
    now,
  );
  assert.equal(st.live, true);
  assert.equal(st.failing, false, "healthy LIVE wins chip over fail hop");
  assert.equal(st.hasFail, true, "concurrent fail still flagged for secondary UI");
});

test("overlay: statusLabel notes secondary fail while primary stays live", () => {
  assert.equal(statusLabel({ live: true, failing: false, hasFail: false }), "live");
  assert.equal(statusLabel({ live: true, failing: true, hasFail: true }), "failed");
  assert.equal(statusLabel({ live: true, failing: false, hasFail: true }), "live · also fail");
  assert.equal(statusLabel({ live: false, failing: false, hasFail: false }), "idle");
});

test("overlay: tooltipFor lists provider/requests/last-hit and omits latency when null", () => {
  const now = 1_000_000;
  const n = node({ id: "openai::gpt-5", provider: "gpt-5", model: "gpt-5", requests: 12, lastHitTs: now - 5000, lastLatencyMs: null });
  const tip = tooltipFor(n, [], now);
  assert.equal(tip.title, "openai::gpt-5");
  const map = new Map(tip.rows);
  assert.equal(map.get("Provider"), "openai", "provider label normalized");
  assert.equal(map.get("Requests"), "12");
  assert.equal(map.get("Last hit"), "5s ago");
  assert.equal(map.has("Last latency"), false, "latency row omitted when null");
  assert.equal(map.has("Account"), false, "account row omitted without auth");
  const withLat = tooltipFor(node({ ...n, lastLatencyMs: 640 }), [], now);
  assert.equal(new Map(withLat.rows).get("Last latency"), "640 ms");
});

test("overlay: tooltipFor shows Account from firing authIndex via resolver", () => {
  const now = 1_000_000;
  const n = node({
    id: "anthropic::claude-opus-4-6",
    provider: "anthropic",
    model: "claude-opus-4-6",
    lastAuthIndex: "old",
    lastHitTs: now,
  });
  const tip = tooltipFor(
    n,
    [firing({ nodeId: n.id, startedAt: now, authIndex: "new-cred" })],
    now,
    (idx) => (idx === "new-cred" ? "a***@example.com" : idx === "old" ? "stale@example.com" : null)
  );
  assert.equal(new Map(tip.rows).get("Account"), "a***@example.com");
});

test("overlay: accountForNode prefers freshest firing auth, else node lastAuthIndex", () => {
  const now = 1_000_000;
  const n = node({
    id: "gemini::gemini-3-pro",
    provider: "gemini",
    model: "gemini-3-pro",
    lastAuthIndex: "node-cred",
  });
  const resolve = (idx: string | null | undefined) =>
    idx === "fire-cred" ? "fire@example.com" : idx === "node-cred" ? "node@example.com" : null;
  assert.equal(accountForNode(n, [], resolve), "node@example.com");
  assert.equal(
    accountForNode(n, [firing({ nodeId: n.id, startedAt: now, authIndex: "fire-cred" })], resolve),
    "fire@example.com"
  );
  assert.equal(accountForNode(n, [firing({ nodeId: n.id, startedAt: now, authIndex: null })], resolve), "node@example.com");
});

// 15× Grok auto-switch: one gem, many credentials — trail must list distinct
// newest-first so LIVE chip + tooltip stay readable.
test("overlay: recentAccountsForNode lists distinct newest-first trail", () => {
  const now = 1_000_000;
  const n = node({
    id: "xai::grok-4.5",
    provider: "xai",
    model: "grok-4.5",
    lastAuthIndex: "c-old",
  });
  const resolve = (idx: string | null | undefined) => {
    if (idx === "c1") return "a1@x.ai";
    if (idx === "c2") return "a2@x.ai";
    if (idx === "c3") return "a3@x.ai";
    if (idx === "c-old") return "old@x.ai";
    return null;
  };
  const trail = recentAccountsForNode(
    n,
    [
      firing({ nodeId: n.id, startedAt: now - 3000, authIndex: "c1" }),
      firing({ nodeId: n.id, startedAt: now - 1000, authIndex: "c2" }),
      firing({ nodeId: n.id, startedAt: now - 2000, authIndex: "c1" }), // dup of c1
      firing({ nodeId: n.id, startedAt: now, authIndex: "c3" }),
    ],
    resolve,
    3
  );
  assert.deepEqual(trail, ["a3@x.ai", "a2@x.ai", "a1@x.ai"]);
  // Falls back to node.lastAuthIndex when firings have no auth.
  assert.deepEqual(recentAccountsForNode(n, [], resolve, 2), ["old@x.ai"]);
});

test("overlay: tooltip shows Recent accounts trail when multi-cred", () => {
  const now = 1_000_000;
  const n = node({
    id: "xai::grok-4.5",
    provider: "xai",
    model: "grok-4.5",
    lastHitTs: now,
  });
  const tip = tooltipFor(
    n,
    [
      firing({ nodeId: n.id, startedAt: now - 1000, authIndex: "c1" }),
      firing({ nodeId: n.id, startedAt: now, authIndex: "c2" }),
    ],
    now,
    (idx) => (idx === "c1" ? "first@x.ai" : idx === "c2" ? "second@x.ai" : null)
  );
  const map = new Map(tip.rows);
  assert.equal(map.get("Account"), "second@x.ai");
  assert.equal(map.get("Recent accounts"), "second@x.ai · first@x.ai");
});

test("overlay: shortAccount keeps email domain when truncating", () => {
  assert.equal(shortAccount("alice@example.com", 40), "alice@example.com");
  const short = shortAccount("verylonglocalpart@example.com", 18);
  assert.ok(short.endsWith("@example.com"), `keeps domain: ${short}`);
  assert.ok(short.includes("…"), `truncates local: ${short}`);
  assert.ok(short.length <= 18, `respects max: ${short}`);
  assert.equal(shortAccount("no-at-label-that-is-long", 12).endsWith("…"), true);
});

test("accounts: buildAuthIndexMap + resolveAccountLabel mask emails unless revealed", () => {
  const files: AuthFileEntry[] = [
    { id: "1", name: "a.json", provider: "anthropic", status: "ok", auth_index: "11", email: "alice@example.com" },
    { id: "2", name: "b.json", provider: "gemini", status: "ok", auth_index: "22", label: "work-gemini" },
    { id: "3", name: "no-index.json", provider: "openai", status: "ok" },
  ];
  const map = buildAuthIndexMap(files);
  assert.equal(map.get("11"), "alice@example.com");
  assert.equal(map.get("22"), "work-gemini");
  assert.equal(map.has("3"), false);
  const masked = resolveAccountLabel(map, "11", false)!;
  assert.ok(masked.startsWith("al"), `masked starts with al: ${masked}`);
  assert.ok(masked.endsWith("@example.com"), `masked ends with domain: ${masked}`);
  assert.ok(masked.includes("\u2022"), `masked uses bullet: ${masked}`);
  assert.notEqual(masked, "alice@example.com");
  assert.equal(resolveAccountLabel(map, "11", true), "alice@example.com");
  assert.equal(resolveAccountLabel(map, "22", false), "work-gemini", "non-email labels stay plain");
  assert.equal(resolveAccountLabel(map, null, true), null);
  assert.equal(resolveAccountLabel(map, "missing", true), null);
});
