// Canvas 2D rendering — luxury "deep-space jewel brain" edition.
// Pure: no React, no DOM. Called from NeuronCanvas rAF loop + headless harness.
// Motion math → anim.ts. Pixel painting → here.
//
// Visual language (premium):
//   • Multi-layer nebula void + aurora curtains + micro-star sparkle field
//   • Hairline multi-strand synapses that ignite into luminous plasma cables
//   • Continuous LIVE data-stream: plasma ribbon + multi-packet photons + duplex ACK
//   • Faceted gemstone neurons with dark-glass underlayer, dual speculars, corona
//   • Traveling pulse: eased bead + dissolving bloom + electric spokes
//   • Caller: pearl nucleus with segmented energy rings + launch bloom
//   • Soft cinematic vignette + additive light stack (lighter)

import {
  firingVisual, BASE_GLOW, breathe, twinkle, shimmerT, ringPhase, BREATHE_AMP, coronaPulse,
  travelMsFor, flashEnvelope, birthProgress, FLASH_MS, BIRTH_MS,
  liveStreamIntensity, liveStreamCoda, liveStreamPeriodMs, liveStreamReturnPeriodMs,
  liveStreamDesiredPackets, allocateStreamPackets, liveStreamPacketT, liveStreamReturnT,
  liveStreamDashPhase, liveStreamWave, liveStreamStutterT, liveStreamBurst,
  liveStreamArrivalKick, liveStreamLaunchKick, liveStreamGlitch, liveStreamFocusMul,
  liveStreamLaneSeed, gemOrbitAngle, gemSpinAngle,
  LIVE_STREAM_GLOBAL_PACKET_BUDGET,
} from "./anim";
import type { Layout, PlacedNode } from "./layout";
import { orbitLayoutNodes } from "./layout";
import { providerPalette } from "./palette";
import type { Firing } from "./types";
import type { DensityMode } from "./overlay";

export const FAIL_ACCENT = "#fb7185";
export const FAIL_SOFT = "rgba(251,113,133,0.20)";
const TAU = Math.PI * 2;

/** Optional interactive / quality knobs for the pure canvas renderer. */
export interface SceneOpts {
  hoverId?: string | null;
  /** Normalized pointer 0..1 for parallax (center = 0.5,0.5). */
  pointer?: { x: number; y: number } | null;
  density?: DensityMode;
  /** nodeId → epoch ms when the gem first appeared (first-fire birth). */
  birthAt?: Record<string, number> | null;
  /** Epoch ms of last cinematic flash start (path-A start). */
  flashAt?: number | null;
  /** Cap particle counts for weak GPUs / dense graphs. */
  quality?: "high" | "balanced" | "low";
  /** Tiny haptic shake px (path-A start) applied before paint. */
  shakePx?: number;
  /**
   * Accumulated constellation orbit time (ms). When provided, gems slowly
   * revolve around the caller. Pause the clock externally for Stop.
   * Omit / 0 = static layout positions.
   */
  orbitElapsedMs?: number;
  /** When false, freeze constellation orbit (gems stay put). Default true. */
  orbitEnabled?: boolean;
}

// Bezier sample cache — rebuild on geometry key change (resize / layout move).
type PathSample = { x: number; y: number; nx: number; ny: number };
const pathSampleCache = new Map<string, { key: string; pts: PathSample[] }>();

function pathSamples(
  id: string,
  cx: number, cy: number,
  g: NodeGeom,
  samples: number,
): PathSample[] {
  const key = `${samples}|${cx.toFixed(1)}|${cy.toFixed(1)}|${g.qx.toFixed(1)}|${g.qy.toFixed(1)}|${g.x.toFixed(1)}|${g.y.toFixed(1)}`;
  const hit = pathSampleCache.get(id);
  if (hit && hit.key === key) return hit.pts;
  const pts: PathSample[] = new Array(samples + 1);
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const x = bez(t, cx, g.qx, g.x);
    const y = bez(t, cy, g.qy, g.y);
    const t0 = Math.max(0, t - 0.01);
    const t1 = Math.min(1, t + 0.01);
    const dx = bez(t1, cx, g.qx, g.x) - bez(t0, cx, g.qx, g.x);
    const dy = bez(t1, cy, g.qy, g.y) - bez(t0, cy, g.qy, g.y);
    const len = Math.hypot(dx, dy) || 1;
    pts[i] = { x, y, nx: -dy / len, ny: dx / len };
  }
  pathSampleCache.set(id, { key, pts });
  // Bound cache growth (dense graphs still small; drop oldest if huge).
  if (pathSampleCache.size > 80) {
    const first = pathSampleCache.keys().next().value;
    if (first != null) pathSampleCache.delete(first);
  }
  return pts;
}

function sampleAt(pts: PathSample[], t: number): PathSample {
  const n = pts.length - 1;
  const u = Math.min(1, Math.max(0, t)) * n;
  const i = Math.min(n - 1, Math.floor(u));
  const f = u - i;
  const a = pts[i];
  const b = pts[i + 1];
  return {
    x: a.x + (b.x - a.x) * f,
    y: a.y + (b.y - a.y) * f,
    nx: a.nx + (b.nx - a.nx) * f,
    ny: a.ny + (b.ny - a.ny) * f,
  };
}

/** Simple stable hue fleck from auth index string (account color sparkle). */
function authFleckHex(authIndex: string | null | undefined, fallback: string): string {
  if (!authIndex) return fallback;
  let h = 0;
  for (let i = 0; i < authIndex.length; i++) h = (h * 33 + authIndex.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  // Soft pastel fleck blended toward provider accent by the caller via lighten.
  const s = 55 + (Math.abs(h >> 3) % 25);
  const l = 62 + (Math.abs(h >> 7) % 12);
  return `hsl(${hue} ${s}% ${l}%)`;
}

// Deterministic star field — denser near center, sparse at rim, zero PRNG import.
const STARS = (() => {
  const out: { x: number; y: number; r: number; a: number; seed: number; kind: number }[] = [];
  let s = 0x9e3779b9;
  for (let i = 0; i < 220; i++) {
    s = (Math.imul(s ^ (s >>> 16), 0x85ebca6b) + 0x9e3779b9) >>> 0;
    const xi = (s & 0xffff) / 0xffff;
    const yi = ((s >>> 16) & 0xffff) / 0xffff;
    const ri = 0.22 + ((s >>> 8) & 7) * 0.18;
    const ai = 0.03 + ((s >>> 4) & 15) * 0.012;
    out.push({ x: xi, y: yi, r: ri, a: ai, seed: s, kind: s & 3 });
  }
  return out;
})();

// Soft dust motes for depth parallax (slower drift).
const DUST = (() => {
  const out: { x: number; y: number; r: number; a: number; seed: number }[] = [];
  let s = 0xc2b2ae3d;
  for (let i = 0; i < 48; i++) {
    s = (Math.imul(s ^ (s >>> 13), 0x5bd1e995) + 0x27d4eb2d) >>> 0;
    out.push({
      x: (s & 0xffff) / 0xffff,
      y: ((s >>> 16) & 0xffff) / 0xffff,
      r: 8 + (s & 31),
      a: 0.018 + ((s >>> 6) & 7) * 0.004,
      seed: s,
    });
  }
  return out;
})();

interface NodeGeom {
  x: number; y: number;
  qx: number; qy: number; // quadratic bezier control
  accent: string;
  size: number;
}

const bez = (t: number, a: number, c: number, b: number) =>
  (1 - t) * (1 - t) * a + 2 * (1 - t) * t * c + t * t * b;

export function drawScene(
  ctx: CanvasRenderingContext2D,
  w: number, h: number,
  layout: Layout,
  firings: Firing[],
  now: number,
  motion: boolean,
  opts: SceneOpts = {},
): boolean {
  const hoverId = opts.hoverId ?? null;
  const density = opts.density ?? (layout.nodes.length >= 10 ? "compact" : "full");
  const birthAt = opts.birthAt ?? null;
  const flashAt = opts.flashAt ?? null;
  const quality = opts.quality ?? (layout.nodes.length >= 14 ? "balanced" : "high");
  const ptr = opts.pointer ?? null;
  const shake = opts.shakePx ?? 0;
  const orbitEnabled = opts.orbitEnabled !== false;
  const orbitElapsed = opts.orbitElapsedMs ?? 0;
  const orbitRad = orbitEnabled || orbitElapsed !== 0
    ? gemOrbitAngle(orbitElapsed)
    : 0;
  // Parallax offsets in px (subtle depth) + optional path-A haptic kick
  const pdx = (ptr && motion ? (ptr.x - 0.5) * 10 : 0) + (motion ? shake : 0);
  const pdy = (ptr && motion ? (ptr.y - 0.5) * 7 : 0) + (motion ? shake * 0.65 : 0);

  ctx.clearRect(0, 0, w, h);
  if (shake !== 0 && motion) {
    ctx.save();
    ctx.translate(shake, shake * 0.55);
  }
  paintAtmosphere(ctx, w, h, now, motion, pdx, pdy, quality);

  const px = (nx: number) => nx * w;
  const py = (ny: number) => ny * h;
  const cx = px(layout.center.x);
  const cy = py(layout.center.y);
  const baseR = Math.min(w, h) * 0.054;
  // Apply slow constellation orbit so gems revolve around the caller.
  // Overlay placeNodes uses the same angle so chips / hit-test stay locked.
  const orbitNodes = orbitLayoutNodes(layout.nodes, layout.center, orbitRad);
  const byId = new Map(orbitNodes.map((n) => [n.id, n] as const));

  // ── Gather per-firing visuals ──────────────────────────────────────────────
  type GlowBag = {
    glow: number; failed: boolean; spark: number; ember: number;
    aftershock: number; swirl: number;
  };
  type StreamLane = {
    intensity: number;
    coda: number;
    failed: boolean;
    live: boolean;
    pending: boolean;
    latencyMs: number | null;
    authIndex: string | null;
    seed: number;
    packets: number;
  };
  type StreamBag = {
    intensity: number;
    coda: number;
    failed: boolean;
    live: boolean;
    pending: boolean;
    latencyMs: number | null;
    authIndex: string | null;
    focus: number;
    arrivalKick: number;
    launchKick: number;
    lanes: StreamLane[];
  };
  const glowById = new Map<string, GlowBag>();
  const streamById = new Map<string, StreamBag>();
  const pulses: {
    n: PlacedNode; t: number; failed: boolean; live: boolean; spark: number;
    wake: number; latencyMs: number | null;
  }[] = [];
  const ripples: {
    n: PlacedNode; p: number; p2: number | null; p3: number | null;
    failed: boolean; ember: number; aftershock: number; shock: number | null; swirl: number;
  }[] = [];
  let active = false;
  let coreBoost = 0;
  let launchBoost = 0;

  // Per-node lane counters for multi-hop concurrent streams.
  const laneCountByNode = new Map<string, number>();

  for (const f of firings) {
    const age = now - f.startedAt;
    const trip = travelMsFor(f.latencyMs, f.live);
    const v = firingVisual(age, f.pending, motion, trip);
    if (v.active) active = true;
    // Continuous LIVE data-stream on the cable (independent of one-shot travel pulse).
    const streamI = liveStreamIntensity(age, f.pending, f.live);
    const coda = liveStreamCoda(age, f.pending, f.live, f.failed);
    const streamPower = Math.max(streamI, coda * 0.85);
    if (streamPower > 0.02) {
      active = true; // keep rAF warm while packets race / coda dissolves
      const focus = liveStreamFocusMul(f.nodeId, hoverId);
      const nodeSeed = idlePhase(f.nodeId);
      const laneIdx = laneCountByNode.get(f.nodeId) ?? 0;
      laneCountByNode.set(f.nodeId, laneIdx + 1);
      const lane: StreamLane = {
        intensity: streamI,
        coda,
        failed: f.failed,
        live: f.live,
        pending: f.pending,
        latencyMs: f.latencyMs,
        authIndex: f.authIndex,
        seed: liveStreamLaneSeed(nodeSeed, laneIdx),
        packets: liveStreamDesiredPackets(f.latencyMs, f.live, f.pending, quality),
      };
      const prev = streamById.get(f.nodeId);
      if (!prev) {
        streamById.set(f.nodeId, {
          intensity: streamI,
          coda,
          failed: f.failed,
          live: f.live,
          pending: f.pending,
          latencyMs: f.latencyMs,
          authIndex: f.authIndex,
          focus,
          arrivalKick: 0,
          launchKick: 0,
          lanes: [lane],
        });
      } else {
        prev.lanes.push(lane);
        if (streamI > prev.intensity) prev.intensity = streamI;
        if (coda > prev.coda) prev.coda = coda;
        // Aggregate fail is recomputed after the loop: healthy LIVE wins gem color.
        if (f.pending) prev.pending = true;
        if (f.live) prev.live = true;
        // Prefer freshest healthy latency / auth for period + fleck; keep fail auth secondary.
        if (!f.failed && f.latencyMs != null) prev.latencyMs = f.latencyMs;
        else if (f.latencyMs != null && prev.latencyMs == null) prev.latencyMs = f.latencyMs;
        if (!f.failed && f.authIndex) prev.authIndex = f.authIndex;
        else if (f.authIndex && !prev.authIndex) prev.authIndex = f.authIndex;
        prev.focus = focus;
      }
      // Soft core pull while any cable is streaming data.
      coreBoost = Math.max(
        coreBoost,
        (0.18 + 0.55 * streamPower * (f.live ? 1 : 0.7)) * focus,
      );
    }
    if (!v.visible && streamPower <= 0.02) continue;
    const n = byId.get(f.nodeId);
    if (!n) continue;
    if (v.visible) {
      const cur = glowById.get(f.nodeId);
      if (!cur) {
        glowById.set(f.nodeId, {
          glow: v.glow, failed: f.failed, spark: v.spark, ember: v.ember,
          aftershock: v.aftershock, swirl: v.swirl,
        });
      } else {
        if (v.glow > cur.glow) cur.glow = v.glow;
        // Healthy live/near-live wins gem color over a concurrent fail on same node.
        if (!f.failed) cur.failed = false;
        if (v.spark > (cur.spark ?? 0)) cur.spark = v.spark;
        if (v.ember > (cur.ember ?? 0)) cur.ember = v.ember;
        if (v.aftershock > (cur.aftershock ?? 0)) cur.aftershock = v.aftershock;
        if (v.swirl > (cur.swirl ?? 0)) cur.swirl = v.swirl;
      }
      // Near-live wakes are softer (path B visual honesty).
      const wake = v.wake * (f.live ? 1 : 0.72);
      if (v.travel != null) {
        pulses.push({
          n, t: v.travel, failed: f.failed, live: f.live, spark: v.spark,
          wake, latencyMs: f.latencyMs,
        });
        coreBoost = Math.max(coreBoost, 1 - v.travel * 0.75 + 0.12 * wake);
      }
      if (v.ripple != null || v.ember > 0.05 || v.aftershock > 0.05 || v.shock != null || v.swirl > 0.08) {
        ripples.push({
          n, p: v.ripple ?? 1, p2: v.ripple2, p3: v.ripple3, failed: f.failed,
          ember: v.ember, aftershock: v.aftershock, shock: v.shock, swirl: v.swirl,
        });
      }
    }
  }
  // Prefer healthy LIVE on multi-hop gems: fail lane can still glitch, but gem/cable
  // aggregate color stays provider accent while any healthy lane is active.
  for (const s of streamById.values()) {
    const hasHealthy = s.lanes.some(
      (l) => !l.failed && Math.max(l.intensity, l.coda) > 0.02,
    );
    s.failed = !hasHealthy && s.lanes.some((l) => l.failed);
  }

  // Global packet budget across all streaming cables (priority: pending > live > coda).
  if (streamById.size > 0) {
    const entries = [...streamById.entries()];
    const laneFlat: { nodeId: string; lane: StreamLane; weight: number }[] = [];
    for (const [nodeId, s] of entries) {
      for (const lane of s.lanes) {
        const power = Math.max(lane.intensity, lane.coda * 0.8);
        // Healthy live/pending lanes get budget first; fail is secondary.
        const pri = (lane.pending ? 1.35 : 1) * (lane.live ? 1 : 0.72) * (lane.failed ? 0.85 : 1);
        laneFlat.push({
          nodeId,
          lane,
          weight: power * pri * s.focus * Math.max(1, lane.packets),
        });
      }
    }
    const budget =
      quality === "low" ? Math.min(18, LIVE_STREAM_GLOBAL_PACKET_BUDGET)
        : quality === "balanced" ? Math.min(28, LIVE_STREAM_GLOBAL_PACKET_BUDGET)
          : LIVE_STREAM_GLOBAL_PACKET_BUDGET;
    const alloc = allocateStreamPackets(
      laneFlat.map((x) => x.weight),
      budget,
      2,
      quality === "high" ? 8 : quality === "balanced" ? 6 : 4,
    );
    for (let i = 0; i < laneFlat.length; i++) {
      laneFlat[i].lane.packets = alloc[i];
    }
  }

  // Hold ambient rAF while any LIVE cable stream / coda is alive
  // even if the one-shot firing visual already expired.
  if (streamById.size > 0) active = true;

  // Birth / materialize keeps rAF warm
  if (birthAt) {
    for (const id of Object.keys(birthAt)) {
      if (now - birthAt[id] < BIRTH_MS) active = true;
    }
  }
  if (flashAt != null && now - flashAt < FLASH_MS) active = true;
  if (hoverId) active = true; // keep hover micro-interactions smooth
  if (ptr && motion) active = true; // parallax while pointer moves
  // Keep rAF warm while constellation is orbiting so gems keep revolving.
  if (motion && orbitEnabled && orbitNodes.length > 0) active = true;

  // ── Geometry ───────────────────────────────────────────────────────────────
  const geom = new Map<string, NodeGeom>();
  for (const n of orbitNodes) {
    const x = px(n.x), y = py(n.y);
    const dx = x - cx, dy = y - cy;
    const dist = Math.hypot(dx, dy) || 1;
    const bow = Math.min(dist * 0.24, baseR * 3.8);
    geom.set(n.id, {
      x, y,
      qx: (cx + x) / 2 + (-dy / dist) * bow,
      qy: (cy + y) / 2 + (dx / dist) * bow,
      accent: providerPalette(n.provider).accent,
      size: n.size,
    });
  }
  // Layout-shaped view with orbit-applied nodes (lobe washes + synapse loops).
  const orbitedLayout: Layout = { center: layout.center, nodes: orbitNodes };

  // ── Soft energy disc under the whole constellation ─────────────────────────
  paintConstellationField(ctx, cx, cy, Math.min(w, h), coreBoost, now, motion);

  // ── Provider lobe washes (soft cluster identity) ───────────────────────────
  paintLobeWashes(ctx, orbitedLayout, geom, baseR, hoverId);

  // ── Orbital rings around center ────────────────────────────────────────────
  paintOrbitRings(ctx, cx, cy, Math.min(w, h), coreBoost, now, motion);

  // ── Idle ambience (motion only) ────────────────────────────────────────────
  if (motion) {
    if (quality !== "low") paintIdleAmbience(ctx, cx, cy, w, h, Math.min(w, h), now, quality);
    if (quality === "high") paintRadarSweep(ctx, cx, cy, Math.min(w, h) * 0.48, now);
    paintAuroraCurtains(ctx, w, h, now);
  }

  // ── Synapses ───────────────────────────────────────────────────────────────
  ctx.lineCap = "round";
  for (const n of orbitNodes) {
    const g = geom.get(n.id)!;
    const glow = glowById.get(n.id);
    const stream = streamById.get(n.id);
    const streamPower = stream
      ? Math.max(stream.intensity, stream.coda * 0.9) * stream.focus
      : 0;
    let hot = glow ? glow.glow : 0;
    // LIVE cables stay luminous even after the one-shot travel pulse settles.
    if (streamPower > 0) hot = Math.max(hot, 0.42 + 0.58 * streamPower);
    if (hoverId === n.id) hot = Math.min(1, hot + 0.55);
    else if (hoverId) hot *= stream ? 0.55 : 0.72; // stronger dim when focus mode
    const color = (glow?.failed || stream?.failed) ? FAIL_ACCENT : g.accent;
    paintSynapse(ctx, cx, cy, g, color, hot, baseR, streamPower, !motion && streamPower > 0.05);
  }

  // ── LIVE data-stream — continuous photon packets on live gem cables ────────
  // Reduced motion: static luminous sheath only (status readable, no racing packets).
  if (streamById.size > 0) {
    for (const n of orbitNodes) {
      const stream = streamById.get(n.id);
      if (!stream) continue;
      const g = geom.get(n.id)!;
      const color = stream.failed ? FAIL_ACCENT : g.accent;
      const kicks = paintLiveDataStream(
        ctx, cx, cy, g, color, stream, baseR, now, quality, motion,
      );
      stream.arrivalKick = kicks.arrival;
      stream.launchKick = kicks.launch;
      launchBoost = Math.max(launchBoost, kicks.launch * stream.focus);
      coreBoost = Math.max(coreBoost, kicks.launch * 0.45 * stream.focus);
    }
  }

  // ── Idle synapse chatter — dual beads drift outward on resting strands ──────
  if (motion && quality !== "low") {
    const chatterN = quality === "high" ? 3 : 2;
    ctx.save(); ctx.globalCompositeOperation = "lighter";
    for (const n of orbitNodes) {
      if (glowById.get(n.id) || streamById.get(n.id)) continue;
      if (hoverId && hoverId !== n.id) continue;
      const g = geom.get(n.id)!;
      const phase = idlePhase(n.id);
      for (let k = 0; k < chatterN; k++) {
        const t = shimmerT(now + k * 1100, phase);
        const bx = bez(t, cx, g.qx, g.x);
        const by = bez(t, cy, g.qy, g.y);
        const fade = Math.sin(t * Math.PI);
        const bead = ctx.createRadialGradient(bx, by, 0, bx, by, baseR * (0.5 + 0.12 * k));
        bead.addColorStop(0, hexA(lighten(g.accent, 0.5), (0.12 + 0.05 * k) * fade));
        bead.addColorStop(0.55, hexA(g.accent, 0.05 * fade));
        bead.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = bead;
        ctx.beginPath(); ctx.arc(bx, by, baseR * (0.42 + 0.12 * k), 0, TAU); ctx.fill();
      }
    }
    ctx.restore();
  }

  // ── Traveling pulses ───────────────────────────────────────────────────────
  for (const pl of pulses) {
    paintTravelPulse(ctx, cx, cy, geom.get(pl.n.id)!, pl, baseR, now);
  }

  // ── Caller nucleus ─────────────────────────────────────────────────────────
  const idleBoost = motion ? BREATHE_AMP * breathe(now) : 0;
  const flashBoost = flashAt != null ? flashEnvelope(now - flashAt) : 0;
  callerCore(
    ctx, cx, cy, baseR * 0.86,
    Math.max(coreBoost, idleBoost, flashBoost * 0.95, launchBoost * 0.85),
    now, motion,
  );

  // ── Arrival ripples + ember spray ──────────────────────────────────────────
  paintArrivals(ctx, ripples, geom, baseR, now);

  // ── Neuron gems ──────────────────────────────────────────────────────────────
  for (const n of orbitNodes) {
    const g = geom.get(n.id)!;
    const glow = glowById.get(n.id);
    const stream = streamById.get(n.id);
    const streamI = stream
      ? Math.max(stream.intensity, stream.coda * 0.85) * (stream.focus ?? 1)
      : 0;
    const arrivalKick = stream?.arrivalKick ?? 0;
    const phase = idlePhase(n.id);
    const hovered = hoverId === n.id;
    let intensity = Math.min(1, BASE_GLOW + (glow ? glow.glow * (1 - BASE_GLOW) : 0));
    // LIVE stream keeps the gem lit after the one-shot glow decays.
    if (streamI > 0) intensity = Math.min(1, Math.max(intensity, 0.42 + 0.48 * streamI));
    if (motion && !glow && streamI < 0.05) {
      intensity = Math.min(1, intensity + BREATHE_AMP * breathe(now, phase));
    }
    if (hovered) intensity = Math.min(1, intensity + 0.28);
    let corona = glow && motion
      ? 0.45 + 0.55 * coronaPulse(now, phase * 1000)
        + 0.28 * (glow.ember ?? 0)
        + 0.32 * (glow.aftershock ?? 0)
        + 0.18 * (glow.swirl ?? 0)
      : motion ? 0.1 * breathe(now, phase) : 0;
    // Streaming gems breathe a hot corona for the whole LIVE window.
    if (streamI > 0.05 && motion) {
      corona = Math.max(
        corona,
        0.35 + 0.55 * coronaPulse(now, phase * 1000) * streamI
          + 0.2 * streamI * (stream?.pending ? 1 : 0.7)
          + 0.55 * arrivalKick,
      );
    } else if (arrivalKick > 0.02) {
      corona = Math.max(corona, 0.4 * arrivalKick);
    }
    if (hovered) corona = Math.max(corona, 0.55 + 0.2 * (motion ? coronaPulse(now, phase * 1000) : 0));
    if (glow) intensity = Math.min(1, intensity + 0.12 * corona + 0.14 * (glow.aftershock ?? 0));
    else if (streamI > 0) intensity = Math.min(1, intensity + 0.1 * corona);
    intensity = Math.min(1, intensity + 0.22 * arrivalKick);

    const born = birthAt?.[n.id];
    const birth = born != null ? birthProgress(now - born) : 1;
    const kick = glow
      ? 0.06 * (glow.aftershock ?? 0) + 0.03 * (glow.swirl ?? 0)
      : 0.025 * streamI + 0.05 * arrivalKick;
    const scale = (0.55 + 0.45 * birth) * (hovered ? 1.12 : 1) * (1 + kick);
    const gemR = baseR * n.size * (1 + ((glow || streamI > 0.05) ? 0.08 * corona : 0.035 * corona)) * scale;

    // First-fire expanding ring
    if (birth < 1) {
      paintBirthRing(ctx, g.x, g.y, gemR, g.accent, birth);
    }

    // Slow in-place facet spin; freeze when constellation orbit is stopped.
    const spinNow = orbitEnabled && motion ? now : 0;
    neuronGem(
      ctx,
      g.x,
      g.y,
      gemR,
      (glow?.failed || stream?.failed) ? FAIL_ACCENT : g.accent,
      intensity * (0.35 + 0.65 * birth),
      corona * birth,
      Math.max(glow?.spark ?? 0, (glow?.aftershock ?? 0) * 0.7, streamI * 0.35, arrivalKick * 0.9),
      spinNow,
      phase,
      motion && orbitEnabled,
      Math.max(glow?.swirl ?? 0, stream?.pending ? streamI * 0.55 : 0),
    );
  }

  // ── Labels ─────────────────────────────────────────────────────────────────
  for (const n of orbitNodes) {
    const g = geom.get(n.id)!;
    const stream = streamById.get(n.id);
    const hot = Math.max(
      glowById.get(n.id)?.glow ?? 0,
      stream ? Math.max(stream.intensity, stream.coda * 0.8) * stream.focus : 0,
    );
    const hovered = hoverId === n.id;
    // Density: full = all labels; compact = only hot/hovered
    if (density === "compact" && hot < 0.12 && !hovered) continue;
    const born = birthAt?.[n.id];
    const birth = born != null ? birthProgress(now - born) : 1;
    if (birth < 0.45) continue;
    drawLabel(
      ctx,
      shortModel(n.model),
      g.x,
      g.y + baseR * n.size * (hovered ? 1.18 : 1) + 16,
      Math.max(hot, hovered ? 0.85 : 0),
    );
  }

  // ── Cinematic flash (path A start) ─────────────────────────────────────────
  if (flashBoost > 0.01) {
    paintScreenFlash(ctx, w, h, cx, cy, flashBoost);
  }

  if (shake !== 0 && motion) ctx.restore();

  // Keep rAF alive while in motion so idle ambience (breathing gems, dust,
  // orbiting satellites, aurora) animates even with no traffic.
  // When completely idle + no hover + no nodes, allow sleep.
  const ambient = motion && orbitNodes.length > 0 && quality !== "low";
  return active || ambient;
}

// ── Atmosphere ─────────────────────────────────────────────────────────────────
function paintAtmosphere(
  ctx: CanvasRenderingContext2D, w: number, h: number, now: number, motion: boolean,
  pdx = 0, pdy = 0, quality: "high" | "balanced" | "low" = "high",
): void {
  // Deep multi-stop inkwell with slight cool shift at rim
  const bg = ctx.createRadialGradient(w * 0.5, h * 0.4, 4, w * 0.5, h * 0.52, Math.max(w, h) * 0.95);
  bg.addColorStop(0, "#221b4a");
  bg.addColorStop(0.22, "#16103a");
  bg.addColorStop(0.55, "#0b0a22");
  bg.addColorStop(0.82, "#060612");
  bg.addColorStop(1, "#030308");
  ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);

  // Soft nebula washes (additive)
  ctx.save(); ctx.globalCompositeOperation = "lighter";

  const washV = ctx.createRadialGradient(w * 0.16, h * 0.12, 0, w * 0.16, h * 0.12, Math.max(w, h) * 0.7);
  washV.addColorStop(0, "rgba(140,105,255,0.16)");
  washV.addColorStop(0.45, "rgba(90,70,200,0.05)");
  washV.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = washV; ctx.fillRect(0, 0, w, h);

  const washC = ctx.createRadialGradient(w * 0.88, h * 0.78, 0, w * 0.88, h * 0.78, Math.max(w, h) * 0.58);
  washC.addColorStop(0, "rgba(56,200,255,0.10)");
  washC.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = washC; ctx.fillRect(0, 0, w, h);

  const washR = ctx.createRadialGradient(w * 0.72, h * 0.18, 0, w * 0.72, h * 0.18, Math.max(w, h) * 0.42);
  washR.addColorStop(0, "rgba(244,114,182,0.055)");
  washR.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = washR; ctx.fillRect(0, 0, w, h);

  // Slow breathing center bloom
  if (motion) {
    const breath = 0.5 + 0.5 * Math.sin(now / 4200);
    const core = ctx.createRadialGradient(w * 0.5, h * 0.48, 0, w * 0.5, h * 0.48, Math.min(w, h) * (0.28 + 0.04 * breath));
    core.addColorStop(0, `rgba(160,140,255,${0.06 + 0.04 * breath})`);
    core.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = core; ctx.fillRect(0, 0, w, h);
  }
  ctx.restore();

  // Soft dust clouds (parallax layer mid)
  const dustCap = quality === "high" ? DUST.length : quality === "balanced" ? 28 : 14;
  for (let di = 0; di < dustCap; di++) {
    const d = DUST[di];
    const drift = motion ? Math.sin(now / 9000 + d.seed) * 0.012 : 0;
    const gx = (d.x + drift) * w + pdx * 0.55;
    const gy = (d.y + drift * 0.6) * h + pdy * 0.55;
    const cloud = ctx.createRadialGradient(gx, gy, 0, gx, gy, d.r);
    cloud.addColorStop(0, `rgba(150,140,220,${d.a})`);
    cloud.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = cloud;
    ctx.beginPath(); ctx.arc(gx, gy, d.r, 0, TAU); ctx.fill();
  }

  // Micro-star field with occasional cross sparkles (far parallax)
  const starCap = quality === "high" ? STARS.length : quality === "balanced" ? 140 : 80;
  for (let si = 0; si < starCap; si++) {
    const s = STARS[si];
    const a = motion ? s.a * twinkle(now, s.seed) : s.a;
    const sx = s.x * w + pdx * 1.15, sy = s.y * h + pdy * 1.15;
    ctx.fillStyle = `rgba(230,225,255,${a})`;
    ctx.beginPath(); ctx.arc(sx, sy, s.r, 0, TAU); ctx.fill();
    // Bright stars get a tiny cross sparkle
    if (s.kind === 0 && a > 0.08) {
      ctx.strokeStyle = `rgba(240,235,255,${a * 0.55})`;
      ctx.lineWidth = 0.6;
      const arm = 1.6 + s.r * 1.4;
      ctx.beginPath();
      ctx.moveTo(sx - arm, sy); ctx.lineTo(sx + arm, sy);
      ctx.moveTo(sx, sy - arm); ctx.lineTo(sx, sy + arm);
      ctx.stroke();
    }
  }

  // Film grain — subtle, deterministic, luxury texture
  paintFilmGrain(ctx, w, h, now, motion, quality);

  // Vignette — deep cinematic edge falloff
  const vig = ctx.createRadialGradient(w * 0.5, h * 0.5, Math.min(w, h) * 0.26, w * 0.5, h * 0.5, Math.max(w, h) * 0.78);
  vig.addColorStop(0, "rgba(0,0,0,0)");
  vig.addColorStop(0.7, "rgba(0,0,0,0.18)");
  vig.addColorStop(1, "rgba(0,0,0,0.62)");
  ctx.fillStyle = vig; ctx.fillRect(0, 0, w, h);

  // Inner rim highlight — expensive frame inside the canvas
  const rim = ctx.createLinearGradient(0, 0, 0, h);
  rim.addColorStop(0, "rgba(200,190,255,0.08)");
  rim.addColorStop(0.5, "rgba(200,190,255,0.02)");
  rim.addColorStop(1, "rgba(80,160,255,0.05)");
  ctx.strokeStyle = rim;
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
}

function paintFilmGrain(
  ctx: CanvasRenderingContext2D, w: number, h: number, now: number, motion: boolean,
  quality: "high" | "balanced" | "low" = "high",
): void {
  // Sparse deterministic speckles — cheap visual richness without real noise texture.
  if (quality === "low") return;
  ctx.save();
  ctx.globalCompositeOperation = "overlay";
  let s = (0xdeadbeef ^ (motion ? (now / 80) | 0 : 0)) >>> 0;
  const grainBudget = quality === "high" ? 180 : 90;
  const count = Math.min(grainBudget, Math.floor((w * h) / 2800));
  for (let i = 0; i < count; i++) {
    s = (Math.imul(s ^ (s >>> 16), 0x85ebca6b) + i) >>> 0;
    const x = ((s & 0xffff) / 0xffff) * w;
    const y = (((s >>> 16) & 0xffff) / 0xffff) * h;
    const a = 0.02 + ((s >>> 8) & 7) * 0.006;
    ctx.fillStyle = `rgba(255,255,255,${a})`;
    ctx.fillRect(x, y, 1, 1);
  }
  ctx.restore();
}

function paintAuroraCurtains(ctx: CanvasRenderingContext2D, w: number, h: number, now: number): void {
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (let band = 0; band < 3; band++) {
    const y0 = h * (0.18 + band * 0.22);
    const amp = h * (0.035 + band * 0.01);
    const phase = now / (5200 + band * 900);
    const grad = ctx.createLinearGradient(0, y0 - amp, 0, y0 + amp * 2);
    if (band === 0) {
      grad.addColorStop(0, "rgba(130,100,255,0)");
      grad.addColorStop(0.5, "rgba(140,110,255,0.045)");
      grad.addColorStop(1, "rgba(130,100,255,0)");
    } else if (band === 1) {
      grad.addColorStop(0, "rgba(56,189,248,0)");
      grad.addColorStop(0.5, "rgba(56,189,248,0.035)");
      grad.addColorStop(1, "rgba(56,189,248,0)");
    } else {
      grad.addColorStop(0, "rgba(244,114,182,0)");
      grad.addColorStop(0.5, "rgba(244,114,182,0.03)");
      grad.addColorStop(1, "rgba(244,114,182,0)");
    }
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(0, y0);
    for (let x = 0; x <= w; x += 12) {
      const y = y0 + Math.sin(x / 90 + phase + band) * amp + Math.sin(x / 40 - phase * 1.3) * amp * 0.35;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, y0 + amp * 3);
    ctx.lineTo(0, y0 + amp * 3);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function paintConstellationField(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, minDim: number,
  boost: number, now: number, motion: boolean,
): void {
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const pulse = motion ? 0.5 + 0.5 * Math.sin(now / 2800) : 0.5;
  const r = minDim * (0.42 + 0.02 * pulse + 0.03 * boost);
  const field = ctx.createRadialGradient(cx, cy, minDim * 0.04, cx, cy, r);
  field.addColorStop(0, `rgba(150,130,255,${0.07 + 0.08 * boost})`);
  field.addColorStop(0.45, `rgba(80,120,220,${0.03 + 0.04 * boost})`);
  field.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = field;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fill();
  ctx.restore();
}

// ── Synapse cable ─────────────────────────────────────────────────────────────
function paintSynapse(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number,
  g: NodeGeom,
  color: string,
  hot: number,
  baseR: number,
  stream = 0,
  staticSheath = false,
): void {
  const liveBoost = Math.min(1, stream);
  const heat = Math.min(1, hot + 0.35 * liveBoost);
  // Reduced-motion: still show a luminous LIVE sheath so status is readable.
  const sheath = staticSheath ? Math.max(liveBoost, 0.55) : liveBoost;

  // Outer ghost thread
  ctx.strokeStyle = hexA("#b8b0e0", 0.045 + 0.07 * heat + 0.06 * sheath);
  ctx.lineWidth = 2.2 + g.size * 0.7 + sheath * 1.4;
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.quadraticCurveTo(g.qx, g.qy, g.x, g.y); ctx.stroke();

  // Mid ghost (cool)
  ctx.strokeStyle = hexA("#90a8ff", 0.03 + 0.08 * heat + 0.05 * sheath);
  ctx.lineWidth = 1.2 + g.size * 0.35 + sheath * 0.8;
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.quadraticCurveTo(g.qx, g.qy, g.x, g.y); ctx.stroke();

  // Hot accent strand — thicker plasma sheath while streaming data
  const grad = ctx.createLinearGradient(cx, cy, g.x, g.y);
  grad.addColorStop(0, hexA("#d4c8ff", 0.07 + 0.2 * heat + 0.12 * sheath));
  grad.addColorStop(0.4, hexA(color, 0.1 + 0.42 * heat + 0.22 * sheath));
  grad.addColorStop(1, hexA(color, 0.22 + 0.68 * heat + 0.18 * sheath));
  ctx.strokeStyle = grad;
  ctx.lineWidth = 1.05 + g.size * 0.75 + heat * 2.4 + sheath * 1.8;
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.quadraticCurveTo(g.qx, g.qy, g.x, g.y); ctx.stroke();

  // Ultra-fine highlight hairline when hot / streaming
  if (heat > 0.15 || sheath > 0.1) {
    ctx.strokeStyle = hexA(lighten(color, 0.55), 0.18 * heat + 0.22 * sheath);
    ctx.lineWidth = 0.7 + sheath * 0.5;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.quadraticCurveTo(g.qx, g.qy, g.x, g.y); ctx.stroke();
  }

  // Soft connection pad at neuron end
  if (heat > 0.05 || sheath > 0.05) {
    const padR = baseR * (0.9 + heat + 0.35 * sheath);
    const pad = ctx.createRadialGradient(g.x, g.y, 0, g.x, g.y, padR);
    pad.addColorStop(0, hexA(color, 0.12 * heat + 0.16 * sheath));
    pad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = pad;
    ctx.beginPath(); ctx.arc(g.x, g.y, padR, 0, TAU); ctx.fill();
  }

  // Caller-side launch pad while streaming
  if (sheath > 0.08) {
    const launch = ctx.createRadialGradient(cx, cy, 0, cx, cy, baseR * (1.1 + 0.6 * sheath));
    launch.addColorStop(0, hexA(lighten(color, 0.35), 0.14 * sheath));
    launch.addColorStop(0.55, hexA(color, 0.06 * sheath));
    launch.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = launch;
    ctx.beginPath(); ctx.arc(cx, cy, baseR * (1.1 + 0.6 * sheath), 0, TAU); ctx.fill();
  }
}

type StreamPaint = {
  intensity: number;
  coda: number;
  failed: boolean;
  live: boolean;
  pending: boolean;
  latencyMs: number | null;
  authIndex: string | null;
  focus: number;
  lanes: {
    intensity: number;
    coda: number;
    failed: boolean;
    live: boolean;
    pending: boolean;
    latencyMs: number | null;
    authIndex: string | null;
    seed: number;
    packets: number;
  }[];
};

// ── Continuous LIVE data-stream (packets racing along the gem cable) ──────────
function paintLiveDataStream(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number,
  g: NodeGeom,
  color: string,
  stream: StreamPaint,
  baseR: number,
  now: number,
  quality: "high" | "balanced" | "low",
  motion: boolean,
): { arrival: number; launch: number } {
  const power = Math.max(stream.intensity, stream.coda * 0.9) * stream.focus;
  if (power < 0.02) return { arrival: 0, launch: 0 };

  // Reduced motion: static multi-fiber sheath only (no racing packets).
  if (!motion) {
    paintStaticLiveSheath(ctx, cx, cy, g, color, power, stream.failed, quality);
    return { arrival: 0, launch: 0 };
  }

  let arrivalKick = 0;
  let launchKick = 0;
  const samples = quality === "high" ? 36 : quality === "balanced" ? 26 : 16;
  const cacheId = `${g.x.toFixed(1)},${g.y.toFixed(1)}`;
  const pts = pathSamples(cacheId, cx, cy, g, samples);
  const fleck = authFleckHex(stream.authIndex, color);

  ctx.save();
  // Per-lane fail only — healthy LIVE on the same gem keeps provider color.
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (let li = 0; li < stream.lanes.length; li++) {
    const lane = stream.lanes[li];
    if (lane.packets <= 0 && Math.max(lane.intensity, lane.coda) < 0.02) continue;
    const lanePower = Math.max(lane.intensity, lane.coda * 0.9) * stream.focus;
    if (lanePower < 0.02) continue;

    const live = lane.live;
    const pending = lane.pending;
    const failed = lane.failed || stream.failed;
    const seed = lane.seed;
    const period = liveStreamPeriodMs(lane.latencyMs ?? stream.latencyMs, live, pending);
    const retPeriod = liveStreamReturnPeriodMs(lane.latencyMs ?? stream.latencyMs, live, pending);
    const glitch = liveStreamGlitch(now, seed, failed);
    const burst = liveStreamBurst(now, seed, pending);
    // Coda: slow last packets + dim ribbon.
    const codaSlow = lane.coda > 0.05 && lane.intensity < 0.12
      ? 1 + 0.85 * lane.coda
      : 1;
    const effectivePeriod = period * codaSlow;
    const a = (live ? 1 : 0.62) * lanePower * (failed ? 0.55 + 0.45 * (1 - glitch * 0.5) : 1);
    const soft = lighten(color, live ? 0.2 : 0.12);
    const bright = lighten(color, 0.72);
    const packets = Math.max(0, lane.packets);
    const returnN = quality === "low" ? 0 : quality === "balanced" ? 1 : (pending ? 2 : 1);
    const dashPhase = liveStreamDashPhase(now, seed, effectivePeriod);
    const dashPhase2 = (dashPhase + 0.37) % 1;
    const breath = 0.82 + 0.18 * (0.5 + 0.5 * Math.sin(now / 420 + seed * 0.01));
    // Multi-core fiber: slight perpendicular lane offset for concurrent hops.
    const fiberOff = (li - (stream.lanes.length - 1) / 2) * (quality === "high" ? 2.4 : 1.6);

    // ── Plasma ribbon (primary + optional chromatic dual fiber) ────────────
    const fibers = quality === "high" ? 3 : quality === "balanced" ? 2 : 1;
    for (let f = 0; f < fibers; f++) {
      const fiberSign = f === 0 ? 0 : f === 1 ? 1 : -1;
      const off = fiberOff + fiberSign * (1.1 + f * 0.35);
      // Chromatic: cool / warm fringe on secondary fibers (high only).
      const fiberColor = f === 0
        ? soft
        : f === 1
          ? lighten(color, 0.45)
          : lighten(color, 0.15);
      for (let i = 1; i <= samples; i++) {
        const t = i / samples;
        const p0 = pts[i - 1];
        const p1 = pts[i];
        const w1 = liveStreamWave(t, dashPhase, 0.13);
        const w2 = liveStreamWave(t, dashPhase2, 0.09) * 0.65;
        let wave = Math.min(1, w1 + w2);
        if (!live) {
          // Path B: softer + stuttered ribbon so "~" reads delayed.
          wave *= 0.78 + 0.12 * Math.sin(now / 90 + t * 12 + seed);
        }
        if (failed) wave *= 0.55 + 0.45 * (1 - glitch * Math.sin(t * 40 + now / 20));
        if (wave > 0.02) {
          const edge = Math.sin(t * Math.PI);
          const alpha = (0.1 + 0.52 * wave) * a * edge * breath * (f === 0 ? 1 : 0.45);
          // hexA only works for #rrggbb; fiberColor may be lighten(#).
          ctx.strokeStyle = hexA(wave > 0.55 ? bright : fiberColor, alpha);
          ctx.lineWidth = (1.0 + 3.0 * wave + (pending ? 0.55 : 0))
            * (0.85 + 0.35 * lanePower)
            * (f === 0 ? 1 : 0.55)
            * burst;
          ctx.beginPath();
          ctx.moveTo(p0.x + p0.nx * off, p0.y + p0.ny * off);
          ctx.lineTo(p1.x + p1.nx * off, p1.y + p1.ny * off);
          ctx.stroke();
        }
      }
    }

    // ── Outer glow sheath ──────────────────────────────────────────────────
    if (quality !== "low") {
      for (let i = 1; i <= samples; i++) {
        const t = i / samples;
        const p0 = pts[i - 1];
        const p1 = pts[i];
        const wave = liveStreamWave(t, dashPhase, 0.18);
        if (wave > 0.04) {
          const edge = Math.sin(t * Math.PI);
          ctx.strokeStyle = hexA(color, 0.08 * wave * a * edge);
          ctx.lineWidth = 5.5 + 4.5 * wave;
          ctx.beginPath();
          ctx.moveTo(p0.x + p0.nx * fiberOff, p0.y + p0.ny * fiberOff);
          ctx.lineTo(p1.x + p1.nx * fiberOff, p1.y + p1.ny * fiberOff);
          ctx.stroke();
        }
      }
    }

    // ── Outbound photon packets (caller → gem) ─────────────────────────────
    for (let k = 0; k < packets; k++) {
      let t = liveStreamPacketT(now, seed, k, packets, effectivePeriod);
      t = liveStreamStutterT(t, now, seed + k * 17, live);
      // Coda: last beads drift slower near the gem and dissolve.
      if (lane.coda > 0.08 && lane.intensity < 0.15) {
        t = Math.min(0.97, t * (0.88 + 0.12 * (1 - lane.coda)));
      }
      const p = sampleAt(pts, t);
      const x = p.x + p.nx * fiberOff + (failed ? (glitch - 0.5) * 2.2 : 0);
      const y = p.y + p.ny * fiberOff + (failed ? (glitch - 0.5) * 1.4 : 0);
      const edge = Math.sin(t * Math.PI);
      const headBoost = 0.75 + 0.25 * Math.sin((now / 90) + k * 1.7 + seed) * burst;
      const r = baseR * (0.22 + 0.1 * lanePower) * (live ? 1 : 0.88) * headBoost
        * (failed ? 0.9 + 0.2 * glitch : 1);

      arrivalKick = Math.max(arrivalKick, liveStreamArrivalKick(t) * lanePower * burst);
      launchKick = Math.max(launchKick, liveStreamLaunchKick(t) * lanePower * burst);

      // Comet micro-trail
      const trailN = quality === "high" ? 7 : quality === "balanced" ? 5 : 3;
      const trailStep = live ? 0.018 : 0.024;
      for (let j = trailN; j >= 1; j--) {
        const tt = Math.max(0, t - j * trailStep);
        const tp = sampleAt(pts, tt);
        const fall = 1 - j / (trailN + 1);
        const tr = ctx.createRadialGradient(
          tp.x + tp.nx * fiberOff, tp.y + tp.ny * fiberOff, 0,
          tp.x + tp.nx * fiberOff, tp.y + tp.ny * fiberOff, r * (2.8 + fall * 2.2),
        );
        tr.addColorStop(0, hexA(soft, 0.22 * a * fall * fall * edge));
        tr.addColorStop(0.55, hexA(color, 0.07 * a * fall * edge));
        tr.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = tr;
        ctx.beginPath();
        ctx.arc(tp.x + tp.nx * fiberOff, tp.y + tp.ny * fiberOff, r * (1.6 + fall), 0, TAU);
        ctx.fill();
      }

      // Packet halo
      const halo = ctx.createRadialGradient(x, y, 0, x, y, r * 5.2);
      halo.addColorStop(0, hexA(bright, 0.72 * a * edge));
      halo.addColorStop(0.35, hexA(soft, 0.28 * a * edge));
      halo.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = halo;
      ctx.beginPath(); ctx.arc(x, y, r * 5.2, 0, TAU); ctx.fill();

      // Core bead + white pin
      ctx.fillStyle = hexA(bright, 0.95 * a * edge);
      ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
      ctx.fillStyle = `rgba(255,255,255,${0.85 * a * edge})`;
      ctx.beginPath(); ctx.arc(x - r * 0.18, y - r * 0.2, r * 0.32, 0, TAU); ctx.fill();

      // Account fleck — multi-cred sparkle (not full recolor)
      if (stream.authIndex && quality !== "low" && k % 2 === 0 && edge > 0.4) {
        ctx.save();
        ctx.globalAlpha = 0.5 * a * edge;
        ctx.fillStyle = fleck;
        ctx.beginPath(); ctx.arc(x + r * 0.55, y - r * 0.4, r * 0.28, 0, TAU); ctx.fill();
        ctx.restore();
      }

      // Failed glitch spokes
      if (failed && edge > 0.3) {
        ctx.strokeStyle = hexA(FAIL_ACCENT, 0.35 * a * glitch * edge);
        ctx.lineWidth = 0.8;
        for (let s = 0; s < 2; s++) {
          const ang = (now / 28 + k + s * 2.4) % TAU;
          const len = r * (1.8 + glitch * 1.6);
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
          ctx.stroke();
        }
      }

      // Tiny spark spokes on primary packets (path A / high quality)
      if (live && !failed && quality === "high" && k % 2 === 0 && edge > 0.35) {
        ctx.strokeStyle = hexA(bright, 0.28 * a * edge);
        ctx.lineWidth = 0.9;
        for (let s = 0; s < 3; s++) {
          const ang = (now / 70 + k * 1.3 + s * 2.1) % TAU;
          const len = r * (2.2 + (s % 2) * 0.7);
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
          ctx.stroke();
        }
      }
    }

    // ── Inbound ACK packets (gem → caller) ─────────────────────────────────
    for (let k = 0; k < returnN; k++) {
      let t = liveStreamReturnT(now, seed, k, returnN, retPeriod * codaSlow);
      t = liveStreamStutterT(t, now, seed ^ 0x51, live);
      const p = sampleAt(pts, t);
      const x = p.x + p.nx * fiberOff * 0.6;
      const y = p.y + p.ny * fiberOff * 0.6;
      const edge = Math.sin(t * Math.PI);
      const r = baseR * 0.14 * (0.85 + 0.2 * lanePower);
      const halo = ctx.createRadialGradient(x, y, 0, x, y, r * 4.2);
      halo.addColorStop(0, hexA(lighten(color, 0.55), 0.35 * a * edge));
      halo.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = halo;
      ctx.beginPath(); ctx.arc(x, y, r * 4.2, 0, TAU); ctx.fill();
      ctx.fillStyle = hexA(lighten(color, 0.8), 0.55 * a * edge);
      ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    }

    // ── Micro scintilla dust (high quality only) ───────────────────────────
    if (quality === "high") {
      for (let k = 0; k < 10; k++) {
        const t = ((now / 2100) + k * 0.097 + (seed % 97) * 0.01) % 1;
        const jitter = (Math.sin(now / 180 + k * 2.3 + seed) * 0.5 + 0.5) * 0.04;
        const tt = Math.min(0.98, Math.max(0.02, t + jitter * 0.2));
        const p = sampleAt(pts, tt);
        const ox = p.nx * (2.2 + (k % 3) + fiberOff * 0.3);
        const oy = p.ny * (2.2 + (k % 3) + fiberOff * 0.3);
        const flicker = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(now / 95 + k * 1.7));
        const edge = Math.sin(tt * Math.PI);
        ctx.fillStyle = hexA(bright, 0.16 * a * flicker * edge);
        ctx.beginPath();
        ctx.arc(p.x + ox * ((k & 1) ? 1 : -1), p.y + oy * ((k & 1) ? 1 : -1), 1.05, 0, TAU);
        ctx.fill();
      }
    }
  }

  ctx.restore();
  return { arrival: arrivalKick, launch: launchKick };
}

/** Static LIVE sheath for prefers-reduced-motion (readable status, no motion). */
function paintStaticLiveSheath(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number,
  g: NodeGeom,
  color: string,
  power: number,
  failed: boolean,
  quality: "high" | "balanced" | "low",
): void {
  const c = failed ? FAIL_ACCENT : color;
  const a = 0.35 + 0.45 * power;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";
  const fibers = quality === "low" ? 1 : 2;
  for (let f = 0; f < fibers; f++) {
    const off = (f - (fibers - 1) / 2) * 1.8;
    // Approximate offset by shifting control slightly.
    const qx = g.qx + off * 0.4;
    const qy = g.qy - off * 0.3;
    const grad = ctx.createLinearGradient(cx, cy, g.x, g.y);
    grad.addColorStop(0, hexA(lighten(c, 0.4), 0.12 * a));
    grad.addColorStop(0.5, hexA(c, 0.28 * a));
    grad.addColorStop(1, hexA(c, 0.4 * a));
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2.2 + power * 2.4 - f * 0.6;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.quadraticCurveTo(qx, qy, g.x, g.y);
    ctx.stroke();
  }
  const pad = ctx.createRadialGradient(g.x, g.y, 0, g.x, g.y, baseRStatic(g, power));
  pad.addColorStop(0, hexA(c, 0.22 * a));
  pad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = pad;
  ctx.beginPath();
  ctx.arc(g.x, g.y, 10 + power * 8, 0, TAU);
  ctx.fill();
  ctx.restore();
}

function baseRStatic(g: NodeGeom, power: number): number {
  return 8 + g.size * 4 + power * 6;
}


// ── Traveling pulse ───────────────────────────────────────────────────────────
function paintTravelPulse(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number,
  g: NodeGeom,
  pl: { t: number; failed: boolean; live: boolean; spark: number; wake?: number; latencyMs?: number | null },
  baseR: number,
  now: number,
): void {
  const color = pl.failed ? FAIL_ACCENT : g.accent;
  // Path A (live): sharp lightning plasma. Path B (near-live): softer delayed trail.
  const a = pl.live ? 1 : 0.58;
  const wake = pl.wake ?? 0;
  const trailN = (pl.live ? 22 : 28) + Math.round(wake * 10);
  const step = (pl.live ? 0.011 : 0.016) * (1 - 0.18 * wake);
  const softColor = pl.live ? color : lighten(color, 0.12);

  // Dissolving plasma trail — longer/softer for near-live + comet wake stretch
  for (let i = trailN; i >= 1; i--) {
    const t2 = Math.max(0, pl.t - i * step);
    const tx = bez(t2, cx, g.qx, g.x);
    const ty = bez(t2, cy, g.qy, g.y);
    const fall = 1 - i / (trailN + 1);
    const widen = 1 + wake * 0.55 * fall;
    const tr = ctx.createRadialGradient(
      tx, ty, 0, tx, ty,
      baseR * (1.05 + 0.45 * pl.spark + 0.35 * wake) * fall * (pl.live ? 1 : 1.15) * widen,
    );
    tr.addColorStop(0, hexA(softColor, (0.14 + 0.12 * pl.spark + 0.1 * wake) * a * fall * fall));
    tr.addColorStop(0.55, hexA(lighten(softColor, 0.2), (pl.live ? 0.05 : 0.07) * a * fall));
    tr.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = tr;
    ctx.beginPath();
    ctx.arc(tx, ty, baseR * fall * (pl.live ? 1 : 1.1) * widen, 0, TAU);
    ctx.fill();
  }

  // Bright cable filament just behind the head (comet core streak)
  if (wake > 0.08) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    const segs = pl.live ? 10 : 7;
    for (let i = segs; i >= 1; i--) {
      const tA = Math.max(0, pl.t - i * step * 1.6);
      const tB = Math.max(0, pl.t - (i - 1) * step * 1.6);
      const ax = bez(tA, cx, g.qx, g.x), ay = bez(tA, cy, g.qy, g.y);
      const bx0 = bez(tB, cx, g.qx, g.x), by0 = bez(tB, cy, g.qy, g.y);
      const fall = 1 - i / (segs + 1);
      ctx.strokeStyle = hexA(lighten(softColor, 0.55), (0.18 + 0.45 * wake) * a * fall);
      ctx.lineWidth = (1.1 + 2.4 * wake * fall) * (pl.live ? 1 : 0.75);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx0, by0); ctx.stroke();
    }
    ctx.restore();
  }

  const bx = bez(pl.t, cx, g.qx, g.x);
  const by = bez(pl.t, cy, g.qy, g.y);
  const r = baseR * (0.3 + 0.12 * pl.spark + 0.06 * wake) * (pl.live ? 1 : 0.92);

  ctx.save(); ctx.globalCompositeOperation = "lighter";
  // Outer shock bloom
  const halo = ctx.createRadialGradient(bx, by, 0, bx, by, r * (7.2 + 1.8 * pl.spark + 1.2 * wake));
  halo.addColorStop(0, hexA(lighten(softColor, 0.45), (0.82 + 0.18 * pl.spark) * a));
  halo.addColorStop(0.28, hexA(softColor, 0.34 * a));
  halo.addColorStop(0.65, hexA(softColor, 0.08 * a));
  halo.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(bx, by, r * 7.4, 0, TAU); ctx.fill();

  // Spark flecks + lightning spokes — path A only (path B stays soft)
  if (pl.spark > 0.1 && pl.live) {
    const flecks = 9 + Math.round(wake * 5);
    for (let k = 0; k < flecks; k++) {
      const ang = (now / 65 + k * 0.85 + pl.t * 8.2) % TAU;
      const dist = r * (2.0 + (k % 5) * 0.55 + pl.spark + wake * 0.4);
      const sx = bx + Math.cos(ang) * dist;
      const sy = by + Math.sin(ang) * dist;
      ctx.fillStyle = hexA(lighten(color, 0.85), 0.55 * pl.spark * a);
      ctx.beginPath(); ctx.arc(sx, sy, 1.05 + pl.spark * 1.0, 0, TAU); ctx.fill();
    }
    ctx.strokeStyle = hexA(lighten(color, 0.75), 0.38 * pl.spark * a);
    ctx.lineWidth = 1.05;
    const spokes = 4 + (wake > 0.4 ? 2 : 0);
    for (let k = 0; k < spokes; k++) {
      const ang = (now / 48 + k * 1.7 + pl.t * 4.2) % TAU;
      const len = r * (3.2 + (k % 2) * 0.9 + wake * 0.6);
      ctx.beginPath();
      ctx.moveTo(bx, by);
      const mx = bx + Math.cos(ang + 0.25) * len * 0.45;
      const my = by + Math.sin(ang + 0.25) * len * 0.45;
      ctx.lineTo(mx, my);
      ctx.lineTo(bx + Math.cos(ang) * len, by + Math.sin(ang) * len);
      ctx.stroke();
    }
  } else if (pl.spark > 0.1 && !pl.live) {
    for (let k = 0; k < 5; k++) {
      const ang = (now / 90 + k * 1.1 + pl.t * 5) % TAU;
      const dist = r * (1.8 + (k % 3) * 0.5);
      ctx.fillStyle = hexA(lighten(softColor, 0.6), 0.28 * pl.spark * a);
      ctx.beginPath();
      ctx.arc(bx + Math.cos(ang) * dist, by + Math.sin(ang) * dist, 1.2, 0, TAU);
      ctx.fill();
    }
  }

  // Lead bead core
  ctx.fillStyle = hexA(lighten(softColor, 0.88), a);
  ctx.beginPath(); ctx.arc(bx, by, r, 0, TAU); ctx.fill();
  // Tiny white pin
  ctx.fillStyle = `rgba(255,255,255,${0.85 * a})`;
  ctx.beginPath(); ctx.arc(bx - r * 0.15, by - r * 0.18, r * 0.35, 0, TAU); ctx.fill();
  ctx.restore();
}

// ── Arrivals ──────────────────────────────────────────────────────────────────
function paintArrivals(
  ctx: CanvasRenderingContext2D,
  ripples: {
    n: PlacedNode; p: number; p2: number | null; p3: number | null;
    failed: boolean; ember: number; aftershock?: number; shock?: number | null; swirl?: number;
  }[],
  geom: Map<string, NodeGeom>,
  baseR: number,
  now: number,
): void {
  ctx.save(); ctx.globalCompositeOperation = "lighter";
  for (const rp of ripples) {
    const g = geom.get(rp.n.id)!;
    const color = rp.failed ? FAIL_ACCENT : g.accent;
    const kick = rp.aftershock ?? 0;
    if (rp.p < 1) {
      const r = baseR * rp.n.size * (1 + 3.1 * rp.p + 0.35 * kick);
      const outer = ctx.createRadialGradient(g.x, g.y, r * 0.5, g.x, g.y, r + 6);
      outer.addColorStop(0, hexA(color, (1 - rp.p) * (0.58 + 0.2 * kick)));
      outer.addColorStop(1, "rgba(0,0,0,0)");
      ctx.strokeStyle = outer; ctx.lineWidth = 2.9 * (1 - rp.p * 0.72);
      ctx.beginPath(); ctx.arc(g.x, g.y, r, 0, TAU); ctx.stroke();
    }
    if (rp.p2 != null) {
      const r2 = baseR * rp.n.size * (1 + 2.55 * rp.p2);
      const outer2 = ctx.createRadialGradient(g.x, g.y, r2 * 0.5, g.x, g.y, r2 + 5);
      outer2.addColorStop(0, hexA(color, (1 - rp.p2) * 0.4));
      outer2.addColorStop(1, "rgba(0,0,0,0)");
      ctx.strokeStyle = outer2; ctx.lineWidth = 2.1 * (1 - rp.p2 * 0.8);
      ctx.beginPath(); ctx.arc(g.x, g.y, r2, 0, TAU); ctx.stroke();
    }
    if (rp.p3 != null) {
      const r3 = baseR * rp.n.size * (1 + 2.25 * rp.p3);
      ctx.strokeStyle = hexA(lighten(color, 0.25), (1 - rp.p3) * 0.24);
      ctx.lineWidth = 1.35 * (1 - rp.p3 * 0.85);
      ctx.beginPath(); ctx.arc(g.x, g.y, r3, 0, TAU); ctx.stroke();
    }
    // Outer delayed shockwave (wide soft ring)
    if (rp.shock != null) {
      const sh = rp.shock;
      const rS = baseR * rp.n.size * (1.4 + 4.8 * sh);
      const fade = (1 - sh) * (0.32 + 0.28 * kick);
      ctx.strokeStyle = hexA(lighten(color, 0.35), fade);
      ctx.lineWidth = 2.4 * (1 - sh * 0.75) + 0.4;
      ctx.beginPath(); ctx.arc(g.x, g.y, rS, 0, TAU); ctx.stroke();
      const wash = ctx.createRadialGradient(g.x, g.y, rS * 0.55, g.x, g.y, rS * 1.15);
      wash.addColorStop(0, "rgba(0,0,0,0)");
      wash.addColorStop(0.55, hexA(color, fade * 0.35));
      wash.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = wash;
      ctx.beginPath(); ctx.arc(g.x, g.y, rS * 1.15, 0, TAU); ctx.fill();
    }
  }

  for (const rp of ripples) {
    const g = geom.get(rp.n.id)!;
    const color = rp.failed ? FAIL_ACCENT : g.accent;
    const kick = rp.aftershock ?? 0;
    const swirl = rp.swirl ?? 0;
    if (rp.p < 0.42) {
      const k = 1 - rp.p / 0.42;
      const fr = baseR * (0.5 + 2.6 * rp.p + 0.4 * kick);
      const flash = ctx.createRadialGradient(g.x, g.y, 0, g.x, g.y, fr);
      flash.addColorStop(0, hexA(lighten(color, 0.9), (0.9 + 0.1 * kick) * k));
      flash.addColorStop(0.35, hexA(color, 0.42 * k));
      flash.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = flash;
      ctx.beginPath(); ctx.arc(g.x, g.y, fr, 0, TAU); ctx.fill();

      // Star burst rays on impact
      ctx.strokeStyle = hexA(lighten(color, 0.7), (0.35 + 0.2 * kick) * k);
      ctx.lineWidth = 1.1;
      const rays = 8 + (kick > 0.4 ? 4 : 0);
      for (let ray = 0; ray < rays; ray++) {
        const ang = ray * (TAU / rays) + now / 600;
        const len = fr * (0.55 + (ray % 2) * 0.25 + 0.15 * kick);
        ctx.beginPath();
        ctx.moveTo(g.x + Math.cos(ang) * fr * 0.15, g.y + Math.sin(ang) * fr * 0.15);
        ctx.lineTo(g.x + Math.cos(ang) * len, g.y + Math.sin(ang) * len);
        ctx.stroke();
      }
    }

    // Secondary aftershock pop (short radial flecks)
    if (kick > 0.08) {
      for (let k = 0; k < 10; k++) {
        const ang = (k * 0.71 + now / 220 + idlePhase(rp.n.id) * 0.002) % TAU;
        const dist = baseR * rp.n.size * (1.1 + (k % 4) * 0.35 + (1 - kick) * 1.6);
        const ex = g.x + Math.cos(ang) * dist;
        const ey = g.y + Math.sin(ang) * dist;
        ctx.fillStyle = hexA(lighten(color, 0.85), 0.5 * kick * (0.5 + (k % 3) * 0.15));
        ctx.beginPath(); ctx.arc(ex, ey, 1.2 + kick * 1.6, 0, TAU); ctx.fill();
      }
      // Thin secondary ring
      const ar = baseR * rp.n.size * (1.6 + 2.2 * (1 - kick));
      ctx.strokeStyle = hexA(lighten(color, 0.5), 0.4 * kick);
      ctx.lineWidth = 1.5 * kick + 0.4;
      ctx.beginPath(); ctx.arc(g.x, g.y, ar, 0, TAU); ctx.stroke();
    }

    if (rp.ember > 0.05) {
      const nEmber = 14 + Math.round(kick * 6);
      for (let k = 0; k < nEmber; k++) {
        const ang = (k * 0.62 + now / 380 + idlePhase(rp.n.id) * 0.001) % TAU;
        const dist = baseR * rp.n.size * (1.35 + (k % 6) * 0.32 + (1 - rp.ember) * 1.25);
        const ex = g.x + Math.cos(ang) * dist;
        const ey = g.y + Math.sin(ang) * dist - (1 - rp.ember) * 8;
        ctx.fillStyle = hexA(lighten(color, 0.7), 0.38 * rp.ember * (0.45 + (k % 3) * 0.18));
        ctx.beginPath(); ctx.arc(ex, ey, 1.05 + rp.ember * 1.35, 0, TAU); ctx.fill();
      }
    }

    // Pending swirl: orbiting motes while sticky/session still open
    if (swirl > 0.08) {
      const nOrbit = 8;
      for (let k = 0; k < nOrbit; k++) {
        const ang = now / (480 + k * 40) + k * (TAU / nOrbit) + idlePhase(rp.n.id) * 0.001;
        const orbit = baseR * rp.n.size * (1.7 + (k % 3) * 0.22 + 0.35 * Math.sin(now / 700 + k));
        const ox = g.x + Math.cos(ang) * orbit;
        const oy = g.y + Math.sin(ang) * orbit;
        const sa = 0.18 + 0.4 * swirl * (0.55 + 0.45 * Math.sin(now / 300 + k));
        ctx.fillStyle = hexA(lighten(color, 0.55), sa);
        ctx.beginPath(); ctx.arc(ox, oy, 1.1 + swirl * 1.2, 0, TAU); ctx.fill();
      }
      // Soft orbit guide
      ctx.strokeStyle = hexA(color, 0.1 * swirl);
      ctx.lineWidth = 0.9;
      ctx.setLineDash([2, 6]);
      ctx.beginPath();
      ctx.arc(g.x, g.y, baseR * rp.n.size * 1.95, now / 900, now / 900 + TAU * 0.55);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  ctx.restore();
}

// ── Orbital rings ─────────────────────────────────────────────────────────────
function paintOrbitRings(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, minDim: number,
  boost: number, now: number, motion: boolean,
): void {
  const r1 = minDim * 0.20, r2 = minDim * 0.32, r3 = minDim * 0.43, r4 = minDim * 0.52;
  const spin = motion ? ringPhase(now) : 0;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.lineCap = "round";

  const drawSegRing = (
    radius: number, segs: number, gap: number, alpha: number, width: number, rot: number, colorTpl: string,
  ) => {
    ctx.rotate(rot);
    ctx.strokeStyle = colorTpl.replace("A", String(alpha));
    ctx.lineWidth = width;
    const step = TAU / segs;
    for (let i = 0; i < segs; i++) {
      const a0 = i * step + gap * 0.5;
      const a1 = (i + 1) * step - gap * 0.5;
      if (a1 <= a0) continue;
      ctx.beginPath(); ctx.arc(0, 0, radius, a0, a1); ctx.stroke();
    }
    ctx.rotate(-rot);
  };

  drawSegRing(r1, 12, 0.18, 0.07 + 0.1 * boost, 1.15, spin * 0.4, "rgba(190,175,255,A)");
  drawSegRing(r2, 18, 0.12, 0.055 + 0.08 * boost, 0.95, -spin * 0.55, "rgba(170,190,255,A)");
  drawSegRing(r3, 24, 0.08, 0.04 + 0.06 * boost, 0.8, spin * 0.75, "rgba(100,190,255,A)");
  // Outer faint continuous ring
  ctx.setLineDash([2, 18]);
  ctx.strokeStyle = `rgba(160,150,230,${0.03 + 0.04 * boost})`;
  ctx.lineWidth = 0.7;
  ctx.beginPath(); ctx.arc(0, 0, r4, 0, TAU); ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

// Soft radar sweep for high quality idle motion
function paintRadarSweep(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, radius: number, now: number,
): void {
  const ang = (now / 7000) * TAU;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.translate(cx, cy);
  ctx.rotate(ang);
  // Fallback if createConicGradient unavailable: linear wedge via arc fill
  try {
    const g = ctx.createConicGradient(0, 0, 0);
    g.addColorStop(0, "rgba(170,160,255,0)");
    g.addColorStop(0.02, "rgba(170,160,255,0.08)");
    g.addColorStop(0.08, "rgba(170,160,255,0)");
    g.addColorStop(1, "rgba(170,160,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, radius, 0, TAU); ctx.fill();
  } catch {
    const wedge = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
    wedge.addColorStop(0, "rgba(170,160,255,0.06)");
    wedge.addColorStop(1, "rgba(170,160,255,0)");
    ctx.fillStyle = wedge;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, radius, -0.15, 0.35);
    ctx.closePath();
    ctx.fill();
  }
  // Leading edge line
  ctx.strokeStyle = "rgba(200,195,255,0.12)";
  ctx.lineWidth = 1.1;
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(radius, 0); ctx.stroke();
  ctx.restore();
}

function paintIdleAmbience(
  ctx: CanvasRenderingContext2D, cx: number, cy: number, w: number, h: number, minDim: number, now: number,
  quality: "high" | "balanced" | "low" = "high",
): void {
  ctx.save();
  ctx.globalCompositeOperation = "lighter";

  const motes = quality === "high" ? 56 : 28;
  for (let i = 0; i < motes; i++) {
    const s = i * 12.9898;
    const mx = (Math.sin(now / (7800 + (i % 7) * 720) + s) * 0.5 + 0.5) * w;
    const my = (Math.cos(now / (9400 + (i % 5) * 640) + s * 1.3) * 0.5 + 0.5) * h;
    const pulse = 0.5 + 0.5 * Math.sin(now / 1000 + s);
    const a = 0.03 + 0.07 * pulse;
    // Occasional brighter "shooting" mote
    const streak = (i % 11 === 0);
    if (streak && quality === "high") {
      const ang = s + now / 4000;
      const len = 6 + 4 * pulse;
      ctx.strokeStyle = `rgba(210,215,255,${0.06 + 0.1 * pulse})`;
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(mx, my);
      ctx.lineTo(mx + Math.cos(ang) * len, my + Math.sin(ang) * len);
      ctx.stroke();
    }
    ctx.fillStyle = `rgba(190,200,245,${a})`;
    ctx.beginPath();
    ctx.arc(mx, my, 1.05 + (i % 4) * 0.22, 0, TAU);
    ctx.fill();
  }

  const radii = [minDim * 0.20, minDim * 0.32, minDim * 0.43];
  radii.forEach((rr, i) => {
    for (let j = 0; j < 3; j++) {
      const dir = j === 1 ? -1 : 1;
      const ang = dir * ringPhase(now) * (0.8 + j * 0.15) + i * 2.05 + j * 2.1;
      const ox = cx + Math.cos(ang) * rr;
      const oy = cy + Math.sin(ang) * rr;
      const sat = ctx.createRadialGradient(ox, oy, 0, ox, oy, 8.5);
      sat.addColorStop(0, "rgba(210,220,255,0.62)");
      sat.addColorStop(0.4, "rgba(160,180,255,0.18)");
      sat.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = sat;
      ctx.beginPath(); ctx.arc(ox, oy, 8.5, 0, TAU); ctx.fill();
    }
  });

  // Soft energy spokes from center (idle luxury)
  if (quality === "high") {
    for (let k = 0; k < 6; k++) {
      const ang = ringPhase(now) * 0.35 + k * (TAU / 6);
      const len = minDim * (0.18 + 0.04 * Math.sin(now / 2600 + k));
      const hx = cx + Math.cos(ang) * len;
      const hy = cy + Math.sin(ang) * len;
      const grad = ctx.createLinearGradient(cx, cy, hx, hy);
      grad.addColorStop(0, "rgba(170,160,255,0.05)");
      grad.addColorStop(1, "rgba(170,160,255,0)");
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(hx, hy); ctx.stroke();
    }
  }
  ctx.restore();
}

// ── Gemstone neuron ──────────────────────────────────────────────────────────────
function neuronGem(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  accent: string,
  intensity: number,
  corona = 0,
  spark = 0,
  now = 0,
  phase = 0,
  motion = false,
  swirl = 0,
): void {
  // 1. Wide outer bloom
  ctx.save(); ctx.globalCompositeOperation = "lighter";
  const bloomR = r * (4.8 + 1.25 * corona + 0.7 * spark + 0.45 * swirl);
  const bloom = ctx.createRadialGradient(x, y, r * 0.22, x, y, bloomR);
  bloom.addColorStop(0, hexA(accent, 0.16 + 0.52 * intensity + 0.18 * corona + 0.08 * swirl));
  bloom.addColorStop(0.35, hexA(accent, 0.05 + 0.18 * intensity));
  bloom.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = bloom; ctx.beginPath(); ctx.arc(x, y, bloomR, 0, TAU); ctx.fill();

  // Hot multi-corona rings
  if (corona > 0.05 || swirl > 0.1) {
    const spin = motion ? now / 1800 + phase * 0.001 : 0;
    const spin2 = motion ? now / 1100 + phase * 0.0015 : 0;
    ctx.strokeStyle = hexA(lighten(accent, 0.28), 0.22 + 0.42 * corona * intensity);
    ctx.lineWidth = 1.35 + corona * 1.7;
    ctx.beginPath(); ctx.arc(x, y, r * (1.55 + 0.3 * corona), spin, spin + TAU * 0.82); ctx.stroke();
    ctx.strokeStyle = hexA(lighten(accent, 0.55), 0.12 + 0.25 * corona * intensity);
    ctx.lineWidth = 0.95 + corona;
    ctx.beginPath(); ctx.arc(x, y, r * (1.9 + 0.38 * corona), -spin * 1.3, -spin * 1.3 + TAU * 0.7); ctx.stroke();
    // Micro orbit ticks
    ctx.strokeStyle = hexA(lighten(accent, 0.7), 0.1 + 0.2 * corona);
    ctx.lineWidth = 1.2;
    for (let t = 0; t < 6; t++) {
      const a = spin * 2 + t * (TAU / 6);
      const rr = r * (2.05 + 0.2 * corona);
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
      ctx.lineTo(x + Math.cos(a) * (rr + 2.5), y + Math.sin(a) * (rr + 2.5));
      ctx.stroke();
    }
    // Third partial corona when pending swirl is high (in-flight life)
    if (swirl > 0.12) {
      ctx.strokeStyle = hexA(lighten(accent, 0.4), 0.14 + 0.28 * swirl * intensity);
      ctx.lineWidth = 0.85 + swirl;
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ctx.arc(x, y, r * (2.25 + 0.25 * swirl), spin2, spin2 + TAU * 0.62);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  ctx.restore();

  // 2. Dark-glass underlayer
  ctx.fillStyle = "rgba(5,5,16,0.72)";
  ctx.beginPath(); ctx.arc(x, y, r * 1.1, 0, TAU); ctx.fill();

  // Soft inner shadow ring
  const shade = ctx.createRadialGradient(x, y, r * 0.55, x, y, r * 1.08);
  shade.addColorStop(0, "rgba(0,0,0,0)");
  shade.addColorStop(1, "rgba(0,0,0,0.35)");
  ctx.fillStyle = shade;
  ctx.beginPath(); ctx.arc(x, y, r * 1.08, 0, TAU); ctx.fill();

  // 3. Faceted gem body
  const body = ctx.createRadialGradient(x - r * 0.4, y - r * 0.42, r * 0.03, x + r * 0.2, y + r * 0.24, r);
  body.addColorStop(0, hexA(lighten(accent, 0.72), 0.92 + 0.08 * intensity));
  body.addColorStop(0.32, hexA(accent, 0.78 + 0.22 * intensity));
  body.addColorStop(0.72, hexA(darken(accent, 0.22), 0.86 + 0.12 * intensity));
  body.addColorStop(1, hexA(darken(accent, 0.48), 0.9));
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();

  // Slow in-place facet spin (frozen when motion/orbit is off).
  const facetSpin = motion ? gemSpinAngle(now, phase) : 0;
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r * 0.98, 0, TAU);
  ctx.clip();
  ctx.globalCompositeOperation = "lighter";
  for (let f = 0; f < 5; f++) {
    const ang = f * (TAU / 5) + 0.35 + facetSpin;
    const facet = ctx.createLinearGradient(
      x, y,
      x + Math.cos(ang) * r, y + Math.sin(ang) * r,
    );
    facet.addColorStop(0, "rgba(255,255,255,0)");
    facet.addColorStop(0.45, `rgba(255,255,255,${0.04 + 0.05 * intensity})`);
    facet.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = facet;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.arc(x, y, r, ang - 0.35, ang + 0.35);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  // 4. Crisp rim
  ctx.strokeStyle = hexA("#ffffff", 0.1 + (intensity > 0.45 ? (intensity - 0.45) * 0.95 : 0) + 0.12 * corona);
  ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke();
  // Inner dark rim for glass edge
  ctx.strokeStyle = hexA(darken(accent, 0.55), 0.35);
  ctx.lineWidth = 0.8;
  ctx.beginPath(); ctx.arc(x, y, r * 0.92, 0, TAU); ctx.stroke();

  // 5. Dual specular glints + spark core (orbit with facet spin)
  const gx1 = Math.cos(facetSpin + Math.PI * 1.25) * r * 0.34;
  const gy1 = Math.sin(facetSpin + Math.PI * 1.25) * r * 0.38;
  const gx2 = Math.cos(facetSpin + Math.PI * 0.22) * r * 0.28;
  const gy2 = Math.sin(facetSpin + Math.PI * 0.22) * r * 0.22;
  ctx.save(); ctx.globalCompositeOperation = "lighter";
  const glint = ctx.createRadialGradient(x - gx1, y - gy1, 0, x - gx1, y - gy1, r * 0.7);
  glint.addColorStop(0, `rgba(255,255,255,${0.55 + 0.4 * intensity})`);
  glint.addColorStop(0.45, `rgba(255,255,255,${0.14 * intensity})`);
  glint.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = glint; ctx.beginPath(); ctx.arc(x - gx1 * 0.7, y - gy1 * 0.74, r * 0.7, 0, TAU); ctx.fill();

  // Secondary micro glint
  const glint2 = ctx.createRadialGradient(x + gx2, y + gy2, 0, x + gx2, y + gy2, r * 0.28);
  glint2.addColorStop(0, `rgba(255,255,255,${0.22 + 0.2 * intensity})`);
  glint2.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = glint2; ctx.beginPath(); ctx.arc(x + gx2, y + gy2, r * 0.28, 0, TAU); ctx.fill();

  if (spark > 0.18) {
    const core = ctx.createRadialGradient(x, y, 0, x, y, r * 0.6);
    core.addColorStop(0, hexA("#ffffff", 0.42 * spark));
    core.addColorStop(0.5, hexA(lighten(accent, 0.6), 0.18 * spark));
    core.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = core; ctx.beginPath(); ctx.arc(x, y, r * 0.6, 0, TAU); ctx.fill();
  }
  ctx.restore();
}

// ── Caller nucleus ─────────────────────────────────────────────────────────────
function callerCore(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, boost: number, now: number, motion: boolean): void {
  // Wide launch bloom
  ctx.save(); ctx.globalCompositeOperation = "lighter";
  const bloom = ctx.createRadialGradient(x, y, 0, x, y, r * 5.6);
  bloom.addColorStop(0, `rgba(210,200,255,${0.28 + 0.48 * boost})`);
  bloom.addColorStop(0.35, `rgba(120,180,255,${0.08 + 0.16 * boost})`);
  bloom.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = bloom; ctx.beginPath(); ctx.arc(x, y, r * 5.6, 0, TAU); ctx.fill();
  ctx.restore();

  // Segmented energy rings
  const spin = motion ? ringPhase(now) : 0;
  ctx.save();
  ctx.translate(x, y);
  for (let ring = 0; ring < 3; ring++) {
    const rr = r * (1.5 + ring * 0.55 + 0.28 * boost);
    const segs = 10 + ring * 4;
    const rot = spin * (ring % 2 === 0 ? 1 : -1) * (0.6 + ring * 0.2);
    ctx.rotate(rot);
    ctx.strokeStyle = ring === 1
      ? `rgba(140,190,255,${0.16 + 0.28 * boost})`
      : `rgba(220,210,255,${0.18 + 0.3 * boost - ring * 0.03})`;
    ctx.lineWidth = 1.15 - ring * 0.15;
    ctx.lineCap = "round";
    const step = TAU / segs;
    for (let i = 0; i < segs; i++) {
      if (i % 3 === 0) continue; // gaps for luxury segmented look
      ctx.beginPath();
      ctx.arc(0, 0, rr, i * step, i * step + step * 0.55);
      ctx.stroke();
    }
    ctx.rotate(-rot);
  }
  ctx.restore();

  // Dark glass under
  ctx.fillStyle = "rgba(8,8,22,0.55)";
  ctx.beginPath(); ctx.arc(x, y, r * 1.08, 0, TAU); ctx.fill();

  // Pearl-white nucleus body
  const core = ctx.createRadialGradient(x - r * 0.32, y - r * 0.36, 0, x, y, r);
  core.addColorStop(0, "rgba(255,255,255,0.99)");
  core.addColorStop(0.4, "rgba(236,232,255,0.94)");
  core.addColorStop(0.78, "rgba(180,175,230,0.82)");
  core.addColorStop(1, "rgba(120,125,180,0.72)");
  ctx.fillStyle = core; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();

  // Rim
  ctx.strokeStyle = `rgba(255,255,255,${0.35 + 0.35 * boost})`;
  ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke();

  // Specular glint
  ctx.save(); ctx.globalCompositeOperation = "lighter";
  const spec = ctx.createRadialGradient(x - r * 0.32, y - r * 0.36, 0, x - r * 0.32, y - r * 0.36, r * 0.62);
  spec.addColorStop(0, "rgba(255,255,255,0.82)");
  spec.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = spec; ctx.beginPath(); ctx.arc(x - r * 0.32, y - r * 0.36, r * 0.62, 0, TAU); ctx.fill();

  // Inner energy kernel that pulses with boost
  const kernel = ctx.createRadialGradient(x, y, 0, x, y, r * 0.45);
  kernel.addColorStop(0, `rgba(200,190,255,${0.25 + 0.45 * boost})`);
  kernel.addColorStop(1, "rgba(200,190,255,0)");
  ctx.fillStyle = kernel; ctx.beginPath(); ctx.arc(x, y, r * 0.45, 0, TAU); ctx.fill();
  ctx.restore();
}

function idlePhase(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h) % 4000;
}

// ── Label pill ─────────────────────────────────────────────────────────────────
function drawLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, hot = 0): void {
  ctx.font = "500 10px ui-sans-serif, system-ui, -apple-system, sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const tw = ctx.measureText(text).width;
  const padX = 9, boxW = tw + padX * 2, boxH = 18;
  const rr = ctx as CanvasRenderingContext2D & { roundRect?: (x: number, y: number, w: number, h: number, r: number) => void };
  // Frosted glass pill — brighter when firing
  ctx.fillStyle = `rgba(8,7,20,${0.58 + 0.12 * hot})`;
  if (typeof rr.roundRect === "function") {
    ctx.beginPath(); rr.roundRect(x - boxW / 2, y - boxH / 2, boxW, boxH, 10); ctx.fill();
    ctx.strokeStyle = `rgba(200,190,255,${0.1 + 0.18 * hot})`; ctx.lineWidth = 1;
    ctx.stroke();
  } else {
    ctx.fillRect(x - boxW / 2, y - boxH / 2, boxW, boxH);
  }
  ctx.fillStyle = `rgba(236,232,255,${0.88 + 0.1 * hot})`; ctx.fillText(text, x, y + 0.5);
}


// ── Provider lobe soft washes ──────────────────────────────────────────────────
function paintLobeWashes(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  geom: Map<string, NodeGeom>,
  baseR: number,
  hoverId: string | null,
): void {
  if (layout.nodes.length === 0) return;
  const byProv = new Map<string, { x: number; y: number; accent: string; n: number; hot: boolean }>();
  for (const n of layout.nodes) {
    const g = geom.get(n.id);
    if (!g) continue;
    const cur = byProv.get(n.provider);
    if (!cur) {
      byProv.set(n.provider, { x: g.x, y: g.y, accent: g.accent, n: 1, hot: hoverId === n.id });
    } else {
      cur.x = (cur.x * cur.n + g.x) / (cur.n + 1);
      cur.y = (cur.y * cur.n + g.y) / (cur.n + 1);
      cur.n += 1;
      if (hoverId === n.id) cur.hot = true;
    }
  }
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const lobe of byProv.values()) {
    const R = baseR * (3.8 + Math.min(3, lobe.n) * 0.7);
    const a = lobe.hot ? 0.12 : 0.055;
    const wash = ctx.createRadialGradient(lobe.x, lobe.y, 0, lobe.x, lobe.y, R);
    wash.addColorStop(0, hexA(lobe.accent, a));
    wash.addColorStop(0.55, hexA(lobe.accent, a * 0.35));
    wash.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = wash;
    ctx.beginPath(); ctx.arc(lobe.x, lobe.y, R, 0, TAU); ctx.fill();
  }
  ctx.restore();
}

function paintBirthRing(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, r: number, accent: string, birth: number,
): void {
  const k = 1 - birth;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const ringR = r * (1.2 + 2.4 * birth);
  ctx.strokeStyle = hexA(lighten(accent, 0.4), 0.55 * k);
  ctx.lineWidth = 2.2 * k + 0.4;
  ctx.beginPath(); ctx.arc(x, y, ringR, 0, TAU); ctx.stroke();
  const bloom = ctx.createRadialGradient(x, y, 0, x, y, ringR * 1.2);
  bloom.addColorStop(0, hexA(accent, 0.22 * k));
  bloom.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = bloom;
  ctx.beginPath(); ctx.arc(x, y, ringR * 1.2, 0, TAU); ctx.fill();
  ctx.restore();
}

function paintScreenFlash(
  ctx: CanvasRenderingContext2D,
  w: number, h: number, cx: number, cy: number, boost: number,
): void {
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const R = Math.max(w, h) * 0.55;
  const flash = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
  flash.addColorStop(0, `rgba(230,225,255,${0.22 * boost})`);
  flash.addColorStop(0.35, `rgba(160,150,255,${0.1 * boost})`);
  flash.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = flash;
  ctx.fillRect(0, 0, w, h);
  // Thin rim pulse
  ctx.strokeStyle = `rgba(210,205,255,${0.18 * boost})`;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(1.5, 1.5, w - 3, h - 3);
  ctx.restore();
}

// ── Color utilities ────────────────────────────────────────────────────────────
function lighten(hex: string, t: number): string {
  if (hex[0] !== "#") return hex;
  const n = parseInt(hex.slice(1), 16);
  const up = (c: number) => Math.round(c + (255 - c) * t);
  return `#${(up((n >> 16) & 255) << 16 | up((n >> 8) & 255) << 8 | up(n & 255)).toString(16).padStart(6, "0")}`;
}

function darken(hex: string, t: number): string {
  if (hex[0] !== "#") return hex;
  const n = parseInt(hex.slice(1), 16);
  const dn = (c: number) => Math.round(c * (1 - t));
  return `#${(dn((n >> 16) & 255) << 16 | dn((n >> 8) & 255) << 8 | dn(n & 255)).toString(16).padStart(6, "0")}`;
}

export function hexA(hex: string, a: number): string {
  if (hex[0] !== "#") return hex;
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function shortModel(model: string): string {
  return model.length > 22 ? `${model.slice(0, 21)}…` : model;
}
