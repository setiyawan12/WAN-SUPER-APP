// Dev-only screenshot harness: renders scene.ts against mock data on a real
// canvas so the visuals can be inspected headlessly (esbuild → HTML → Chrome).
// Not shipped in the app.
//
// Query params:
//   ?frame=ms        sample age for default firings (default 300)
//   ?live=1          force continuous LIVE stream (~10s window) for visual QA
//   ?motion=0        reduced-motion path (static LIVE sheath)
//   ?quality=high|balanced|low
//   ?hover=nodeId    focus dim other cables
//   ?shake=1         simulate path-A haptic shake
import { computeLayout } from "./layout";
import { drawScene } from "./scene";
import type { Firing, NeuronNode } from "./types";

const node = (id: string, provider: string, model: string, requests: number, over: Partial<NeuronNode> = {}): NeuronNode => ({
  id,
  provider,
  model,
  requests,
  lastHitTs: null,
  lastFailed: false,
  lastLatencyMs: null,
  lastAuthIndex: null,
  ...over,
});

const nodes: NeuronNode[] = [
  node("anthropic::claude-opus-4-6", "anthropic", "claude-opus-4-6", 90, { lastHitTs: Date.now(), lastAuthIndex: "a1" }),
  node("anthropic::claude-sonnet-4-6", "anthropic", "claude-sonnet-4-6", 45),
  node("anthropic::claude-haiku-4-5", "anthropic", "claude-haiku-4-5", 12),
  node("gemini::gemini-3-pro", "gemini", "gemini-3-pro", 60, { lastHitTs: Date.now(), lastAuthIndex: "g1" }),
  node("gemini::gemini-3-flash", "gemini", "gemini-3-flash", 20),
  node("openai::gpt-5", "openai", "gpt-5", 35),
  node("openai::gpt-5-mini", "openai", "gpt-5-mini", 8, { lastFailed: true }),
  node("xai::grok-4", "xai", "grok-4", 15),
];

const params = new URLSearchParams(location.search);
const now = 100_000;
const frame = Number(params.get("frame") ?? "300");
const forceLive = params.get("live") === "1" || params.get("live") === "true";
const motion = params.get("motion") !== "0";
const qualityParam = params.get("quality");
const quality: "high" | "balanced" | "low" =
  qualityParam === "low" || qualityParam === "balanced" || qualityParam === "high"
    ? qualityParam
    : "high";
const hoverId = params.get("hover");
const shake = params.get("shake") === "1" ? 0.45 : 0;

// Force LIVE: pending sticky + multi-hop concurrency + failed lane for QA.
const firings: Firing[] = forceLive
  ? [
      {
        id: "live-a",
        nodeId: "anthropic::claude-opus-4-6",
        startedAt: now - 200,
        failed: false,
        latencyMs: 180,
        live: true,
        pending: true,
        authIndex: "a1",
        source: "chat",
      },
      // Concurrent hop on same gem (multi-lane).
      {
        id: "live-a2",
        nodeId: "anthropic::claude-opus-4-6",
        startedAt: now - 80,
        failed: false,
        latencyMs: 900,
        live: true,
        pending: true,
        authIndex: "a2",
        source: "proxy",
      },
      {
        id: "live-b",
        nodeId: "gemini::gemini-3-pro",
        startedAt: now - 400,
        failed: false,
        latencyMs: 1400,
        live: false,
        pending: false,
        authIndex: "g1",
      },
      {
        id: "live-fail",
        nodeId: "openai::gpt-5-mini",
        startedAt: now - 120,
        failed: true,
        latencyMs: 320,
        live: true,
        pending: false,
        authIndex: null,
      },
      // Settled LIVE near end of hold — exercises coda dissolve.
      {
        id: "live-coda",
        nodeId: "xai::grok-4",
        startedAt: now - 3600,
        failed: false,
        latencyMs: 600,
        live: true,
        pending: false,
        authIndex: "x1",
      },
    ]
  : [
      { id: "f1", nodeId: "anthropic::claude-opus-4-6", startedAt: now - frame, failed: false, latencyMs: 800, live: true, pending: false, authIndex: "a1" },
      { id: "f2", nodeId: "gemini::gemini-3-pro", startedAt: now - frame - 250, failed: false, latencyMs: 1200, live: false, pending: false, authIndex: "g1" },
      { id: "f3", nodeId: "openai::gpt-5-mini", startedAt: now - frame - 100, failed: true, latencyMs: 400, live: true, pending: false, authIndex: null },
    ];

const canvas = document.getElementById("c") as HTMLCanvasElement;
const w = canvas.clientWidth;
const h = canvas.clientHeight;
const dpr = window.devicePixelRatio || 1;
canvas.width = Math.round(w * dpr);
canvas.height = Math.round(h * dpr);
const ctx = canvas.getContext("2d")!;
ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

const layout = computeLayout(nodes);
const opts = {
  quality,
  hoverId: hoverId || null,
  shakePx: shake,
  flashAt: forceLive ? now - 40 : null,
};

if (forceLive && motion) {
  // Animated preview ~10s so continuous stream can be eyeballed without real traffic.
  const t0 = performance.now();
  const durationMs = 10_000;
  const tick = (ts: number) => {
    const elapsed = ts - t0;
    const clock = now + elapsed;
    drawScene(ctx, w, h, layout, firings, clock, true, opts);
    if (elapsed < durationMs) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
} else {
  drawScene(ctx, w, h, layout, firings, now, motion, opts);
}
