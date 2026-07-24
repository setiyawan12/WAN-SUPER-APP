// Animation math for the constellation view. Pure (no DOM) so each phase is
// unit-testable. Given a firing's age, returns pulse travel, glow, and ripple.
// Tuned for a luxury deep-space feel: eased travel, long glow, ambient breathing.

export const TRAVEL_MS  = 860;    // longer arc so the bead + trail read clearly
export const RIPPLE_MS  = 1100;   // richer multi-ring swell on arrival
export const GLOW_MS    = 3000;
export const TOTAL_MS   = TRAVEL_MS + GLOW_MS; // keep under FIRING_TTL_MS (4000)
export const BASE_GLOW  = 0.2;    // soft ambient at rest (slightly richer idle)

// ── Ambient constants ─────────────────────────────────────────────────────────
// Idle breath: neuron radius oscillates ±BREATHE_AMP relative to base, period BREATHE_MS
export const BREATHE_MS  = 3000;
export const BREATHE_AMP = 0.16;  // more visible idle life

// Star twinkle: each star has independent phase offset so they don't sync
export const TWINKLE_MS  = 2200;  // base period; individual stars vary by their seed

// Synapse shimmer: idle hairlines have a faint travelling brightness wave
export const SHIMMER_MS  = 4000;

// Caller idle ring animation: slow rotation of dashed orbit rings
export const RING_ROT_MS = 11000; // ms per full revolution

// Constellation orbit: gems slowly revolve around the caller nucleus.
// ~90s per full turn — calm enough to read, still clearly "alive".
export const GEM_ORBIT_MS = 90_000;

// In-place gem facet spin (independent of constellation orbit).
export const GEM_SPIN_MS = 14_000;

// Hot corona pulse period on a live/glowing gem
export const CORONA_MS = 1280;

// Cinematic screen flash window after a brand-new live (path A) start.
export const FLASH_MS = 120;

// First-fire gem materialize window (ring expand + fade-in body).
export const BIRTH_MS = 720;

// Secondary impact aftershock after primary ripple (visual only; life still GLOW_MS).
export const AFTERSHOCK_MS = 900;

// Outer shockwave ring after arrival (pure visual envelope).
export const SHOCKWAVE_MS = 1400;

// Comet / wake stretch along the cable during travel.
export const WAKE_PEAK = 0.92;

/**
 * Latency-aware travel duration. Keeps the default `TRAVEL_MS` contract when
 * latency is unknown; short hops feel snappier, long hops leave a longer trail.
 * Near-live (path B) is slightly slower so the "~" feel reads as delayed.
 */
export function travelMsFor(latencyMs: number | null | undefined, live: boolean): number {
  const base = live ? TRAVEL_MS : TRAVEL_MS * 1.14;
  if (latencyMs == null || !Number.isFinite(latencyMs) || latencyMs < 0) return base;
  // 100ms → ~0.72×, 800ms → ~1.0×, 3000ms+ → ~1.38×
  const t = Math.min(1, Math.max(0, (latencyMs - 100) / 2900));
  return Math.round(base * (0.72 + 0.66 * t));
}

/** Screen-flash envelope (0..1) from ms since flash started. */
export function flashEnvelope(ageMs: number): number {
  if (ageMs < 0 || ageMs >= FLASH_MS) return 0;
  const t = ageMs / FLASH_MS;
  // Fast rise, soft fall.
  return t < 0.18 ? t / 0.18 : 1 - (t - 0.18) / 0.82;
}

/** First-fire birth progress 0..1 (ease-out). */
export function birthProgress(ageMs: number): number {
  if (ageMs < 0) return 0;
  if (ageMs >= BIRTH_MS) return 1;
  const t = ageMs / BIRTH_MS;
  return 1 - (1 - t) * (1 - t);
}

/**
 * Aftershock envelope (0..1) from ms after travel completes.
 * Peaks quickly then soft-decays — used for secondary ring + gem kick.
 */
export function aftershockEnvelope(dgMs: number): number {
  if (dgMs < 0 || dgMs >= AFTERSHOCK_MS) return 0;
  const t = dgMs / AFTERSHOCK_MS;
  // Fast rise ~12%, long soft fall.
  return t < 0.12 ? t / 0.12 : Math.max(0, 1 - (t - 0.12) / 0.88);
}

/**
 * Outer shockwave progress 0..1 (null when not active). Delayed slightly so it
 * trails the primary triple-ripple cascade.
 */
export function shockwaveProgress(dgMs: number): number | null {
  const delay = 90;
  const age = dgMs - delay;
  if (age < 0 || age >= SHOCKWAVE_MS) return null;
  return age / SHOCKWAVE_MS;
}

/**
 * Comet wake strength along the cable (0..1). Peaks mid-travel, soft for near-live.
 */
export function wakeStrength(travel01: number | null, live: boolean): number {
  if (travel01 == null) return 0;
  const mid = Math.sin(travel01 * Math.PI); // 0→1→0
  return mid * WAKE_PEAK * (live ? 1 : 0.72);
}

/**
 * Pending-in-flight swirl intensity while sticky/session still open after travel.
 * Pure 0..1 from age-after-travel + pending flag (scene maps to orbiting flecks).
 */
export function pendingSwirl(dgMs: number, pending: boolean): number {
  if (!pending) return 0;
  if (dgMs < 0) return 0.2;
  // Hold a living swirl; mild decay so long sticks don't look stuck at max.
  const hold = 0.55 + 0.35 * Math.exp(-dgMs / 8000);
  return Math.min(1, hold);
}

// ── Continuous live data-stream (while neuron status is LIVE) ─────────────────
// Mirrors overlay LIVE_MS: pending hop OR within this freshness window.
export const LIVE_HOLD_MS = 4000;
// Soft dissolve after hold so the cable does not hard-cut with the LIVE chip.
export const LIVE_CODA_MS = 720;
// One full center→gem packet lap while streaming (default / mid latency).
export const LIVE_STREAM_PERIOD_MS = 1180;
// Soft reverse "ACK" packets (duplex luxury feel).
export const LIVE_STREAM_RETURN_PERIOD_MS = 1680;
// Default photon count racing along a live cable.
export const LIVE_STREAM_PACKET_COUNT = 4;
// Global on-screen packet budget (scene allocates across live cables).
export const LIVE_STREAM_GLOBAL_PACKET_BUDGET = 40;

/**
 * Stream intensity 0..1 while a firing keeps the neuron LIVE.
 * Pending (in-flight / sticky) stays full-bright; settled live fades across LIVE_HOLD_MS.
 * Path B (near-live) is softer so visual honesty of "~" is preserved.
 * Hard-zero at LIVE_HOLD_MS — use liveStreamCoda for the soft exit tail.
 */
export function liveStreamIntensity(
  ageMs: number,
  pending: boolean,
  live: boolean,
): number {
  if (ageMs < 0) return live ? (pending ? 1 : 0.55) : 0.35;
  if (pending) return live ? 1 : 0.62;
  if (ageMs >= LIVE_HOLD_MS) return 0;
  // Soft hold after settle so packets don't hard-cut with the LIVE chip.
  const fade = 1 - ageMs / LIVE_HOLD_MS;
  // Ease-out so most of the window still reads as "streaming".
  const held = Math.pow(fade, 0.55);
  const base = 0.38 + 0.52 * held;
  return (live ? 1 : 0.55) * base;
}

/**
 * End-of-LIVE coda 0..1 — residual ribbon dissolve after intensity hits 0.
 * Peaks just after LIVE_HOLD_MS then dies by LIVE_HOLD_MS + LIVE_CODA_MS.
 * Pending never codas (still streaming). Failed gets a shorter, harsher tail.
 */
export function liveStreamCoda(
  ageMs: number,
  pending: boolean,
  live: boolean,
  failed = false,
): number {
  if (pending || ageMs < 0) return 0;
  const codaMs = failed ? LIVE_CODA_MS * 0.55 : LIVE_CODA_MS;
  // Start a gentle tail in the last 15% of the hold so the last packet slows in.
  const start = LIVE_HOLD_MS * 0.85;
  const end = LIVE_HOLD_MS + codaMs;
  if (ageMs < start || ageMs >= end) return 0;
  if (ageMs <= LIVE_HOLD_MS) {
    // Ramp up as main intensity fades so the exit reads continuous.
    const t = (ageMs - start) / (LIVE_HOLD_MS - start);
    return (live ? 0.42 : 0.28) * t;
  }
  const t = (ageMs - LIVE_HOLD_MS) / codaMs;
  // Ease-out residual glow.
  return (live ? 0.42 : 0.28) * (1 - t) * (1 - t);
}

/**
 * Latency-aware stream lap period (ms). Fast hops feel like a torrent;
 * slow hops leave longer gaps between photon beads. Pending is snappier.
 */
export function liveStreamPeriodMs(
  latencyMs: number | null | undefined,
  live: boolean,
  pending: boolean,
): number {
  const base = live ? LIVE_STREAM_PERIOD_MS : LIVE_STREAM_PERIOD_MS * 1.18;
  let period = base;
  if (latencyMs != null && Number.isFinite(latencyMs) && latencyMs >= 0) {
    // 80ms → ~0.62×, 800ms → ~1.0×, 3500ms+ → ~1.45×
    const t = Math.min(1, Math.max(0, (latencyMs - 80) / 3400));
    period = base * (0.62 + 0.83 * t);
  }
  if (pending) period *= live ? 0.82 : 0.9;
  return Math.round(Math.max(520, Math.min(2200, period)));
}

/**
 * Soft reverse-lane period; slightly longer than outbound for duplex depth.
 */
export function liveStreamReturnPeriodMs(
  latencyMs: number | null | undefined,
  live: boolean,
  pending: boolean,
): number {
  return Math.round(liveStreamPeriodMs(latencyMs, live, pending) * 1.38);
}

/**
 * Desired photon count for one cable before global budget clamping.
 */
export function liveStreamDesiredPackets(
  latencyMs: number | null | undefined,
  live: boolean,
  pending: boolean,
  quality: "high" | "balanced" | "low",
): number {
  let n = LIVE_STREAM_PACKET_COUNT;
  if (quality === "low") n = Math.max(2, n - 2);
  else if (quality === "balanced") n = Math.max(3, n - 1);
  else if (pending) n += 1;
  // Fast hops pack denser; slow hops thin out so trails read.
  if (latencyMs != null && Number.isFinite(latencyMs) && latencyMs >= 0) {
    if (latencyMs < 250) n += quality === "high" ? 2 : 1;
    else if (latencyMs > 1800) n = Math.max(2, n - 1);
  }
  if (!live) n = Math.max(2, n - 1);
  return Math.max(2, Math.min(8, n));
}

/**
 * Allocate integer packet counts across cables under a global budget.
 * Weights should already include intensity × focus × priority.
 */
export function allocateStreamPackets(
  weights: number[],
  totalBudget: number = LIVE_STREAM_GLOBAL_PACKET_BUDGET,
  minPer: number = 2,
  maxPer: number = 8,
): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const budget = Math.max(0, totalBudget | 0);
  const out = new Array<number>(n).fill(0);
  if (budget === 0) return out;

  // First pass: floor by relative weight, respect min/max.
  let sumW = 0;
  for (const w of weights) sumW += Math.max(0, w);
  if (sumW <= 0) {
    // Equal split when no weight signal.
    const each = Math.min(maxPer, Math.max(minPer, Math.floor(budget / n)));
    return out.map(() => each);
  }

  let used = 0;
  for (let i = 0; i < n; i++) {
    const share = Math.floor((Math.max(0, weights[i]) / sumW) * budget);
    out[i] = Math.min(maxPer, Math.max(weights[i] > 0.02 ? minPer : 0, share));
    used += out[i];
  }
  // Distribute remainder to highest weights.
  let guard = 0;
  while (used < budget && guard < budget + n) {
    guard++;
    let best = -1;
    let bestW = -1;
    for (let i = 0; i < n; i++) {
      if (out[i] >= maxPer) continue;
      if (weights[i] > bestW) {
        bestW = weights[i];
        best = i;
      }
    }
    if (best < 0) break;
    out[best]++;
    used++;
  }
  // If over (min forced), trim lowest weight extras.
  guard = 0;
  while (used > budget && guard < budget + n) {
    guard++;
    let worst = -1;
    let worstW = Infinity;
    for (let i = 0; i < n; i++) {
      if (out[i] <= minPer) continue;
      if (weights[i] < worstW) {
        worstW = weights[i];
        worst = i;
      }
    }
    if (worst < 0) break;
    out[worst]--;
    used--;
  }
  return out;
}

/**
 * Packet head position 0..1 along the synapse (caller → gem).
 * Packets are phase-staggered so the cable always carries multiple data beads.
 */
export function liveStreamPacketT(
  now: number,
  seed: number,
  index: number,
  count: number = LIVE_STREAM_PACKET_COUNT,
  periodMs: number = LIVE_STREAM_PERIOD_MS,
): number {
  const n = Math.max(1, count | 0);
  const period = periodMs > 0 ? periodMs : LIVE_STREAM_PERIOD_MS;
  // Desync per-node + per-packet; seed keeps lanes from marching in lockstep.
  const offset = ((seed * 0.00137) + index / n) % 1;
  const t = ((now / period) + offset) % 1;
  return t < 0 ? t + 1 : t;
}

/**
 * Reverse-lane packet (gem → caller) for a faint duplex ACK stream.
 */
export function liveStreamReturnT(
  now: number,
  seed: number,
  index: number,
  count: number = 2,
  periodMs: number = LIVE_STREAM_RETURN_PERIOD_MS,
): number {
  // Same math as outbound, then invert so motion reads toward the caller.
  return 1 - liveStreamPacketT(now, seed ^ 0x9e37, index, count, periodMs);
}

/**
 * Near-live (path B) phase stutter — slight hesitation so "~" reads delayed.
 * Path A returns `t` unchanged (liquid stream).
 */
export function liveStreamStutterT(
  t: number,
  now: number,
  seed: number,
  live: boolean,
): number {
  if (live) return t;
  const jitter =
    0.035 * Math.sin(now / 170 + seed * 0.01) *
    Math.sin(now / 41 + seed * 0.02);
  let u = t + jitter;
  u = u - Math.floor(u);
  return u < 0 ? u + 1 : u;
}

/**
 * Poisson-ish burst multiplier (not true Poisson — pure, deterministic).
 * Pending chat streams "breathe" denser so packets never look metronomic.
 */
export function liveStreamBurst(now: number, seed: number, pending: boolean): number {
  const a = 0.5 + 0.5 * Math.sin(now / 210 + seed * 0.013);
  const b = 0.5 + 0.5 * Math.sin(now / 67 + seed * 0.029);
  // Occasional spike when both lobes align (chunky token feel).
  const spike = a * b;
  const base = pending ? 0.78 + 0.55 * spike : 0.86 + 0.32 * spike;
  return Math.min(1.45, Math.max(0.62, base));
}

/**
 * Micro kick 0..1 as a packet dissolves into the gem (t near 1).
 * Scene sums kicks across packets for gem corona / specular flash.
 */
export function liveStreamArrivalKick(t: number): number {
  if (t < 0.82 || t > 0.995) return 0;
  const u = (t - 0.82) / 0.175;
  // Fast rise, soft fall into the gem.
  return u < 0.35 ? u / 0.35 : Math.max(0, 1 - (u - 0.35) / 0.65);
}

/**
 * Launch bloom 0..1 as a packet leaves the caller (t near 0).
 */
export function liveStreamLaunchKick(t: number): number {
  if (t < 0.01 || t > 0.18) return 0;
  const u = (t - 0.01) / 0.17;
  return Math.sin(u * Math.PI);
}

/**
 * Failed-stream glitch amount 0..1 (alpha/position flicker).
 */
export function liveStreamGlitch(now: number, seed: number, failed: boolean): number {
  if (!failed) return 0;
  const a = 0.5 + 0.5 * Math.sin(now / 38 + seed * 0.07);
  const b = 0.5 + 0.5 * Math.sin(now / 11 + seed * 0.19);
  // Harsh, irregular — not a smooth breathe.
  return 0.35 + 0.65 * Math.pow(a * b, 0.45);
}

/**
 * Hover focus multiplier: full on hovered stream, dim others when any hover.
 */
export function liveStreamFocusMul(
  nodeId: string,
  hoverId: string | null | undefined,
): number {
  if (!hoverId) return 1;
  return hoverId === nodeId ? 1 : 0.42;
}

/**
 * Multi-hop lane seed so concurrent firings on one gem don't lockstep.
 */
export function liveStreamLaneSeed(nodeSeed: number, laneIndex: number): number {
  return (nodeSeed + Math.imul(laneIndex + 1, 7919)) | 0;
}

/**
 * Animated dash / plasma-ribbon phase 0..1 used to light sequential path samples.
 */
export function liveStreamDashPhase(
  now: number,
  seed: number,
  periodMs: number = LIVE_STREAM_PERIOD_MS,
): number {
  const period = (periodMs > 0 ? periodMs : LIVE_STREAM_PERIOD_MS) * 0.72;
  return ((now / period) + (seed % 1000) * 0.001) % 1;
}

/**
 * Soft envelope along the cable for a travelling brightness wave (0..1).
 * `pos` is sample position 0..1; phase from liveStreamDashPhase.
 */
export function liveStreamWave(pos: number, phase: number, width = 0.14): number {
  // Distance on a loop so the wave wraps cleanly around the strand.
  let d = Math.abs(pos - phase);
  if (d > 0.5) d = 1 - d;
  const w = Math.max(0.04, width);
  if (d >= w) return 0;
  // Smooth cosine lobe.
  return 0.5 + 0.5 * Math.cos((d / w) * Math.PI);
}

/**
 * Path-A start haptic envelope for a tiny canvas shake (0..1).
 * Peaks in the first ~90ms of a cinematic flash window.
 */
export function liveStreamHaptic(ageMs: number): number {
  if (ageMs < 0 || ageMs > 140) return 0;
  const t = ageMs / 140;
  return t < 0.2 ? t / 0.2 : Math.max(0, 1 - (t - 0.2) / 0.8);
}

export interface FiringVisual {
  visible: boolean;
  active:  boolean;
  travel:  number | null; // 0..1 along synapse
  glow:    number;        // 0..1
  ripple:  number | null; // 0..1 ring progress
  ripple2: number | null; // secondary slightly-delayed ring
  ripple3: number | null; // tertiary outer ring
  spark:   number;        // 0..1 electric spark intensity during travel/arrival
  ember:   number;        // 0..1 post-arrival particle spray
  aftershock: number;     // 0..1 secondary impact kick
  wake:    number;        // 0..1 comet trail stretch during travel
  shock:   number | null; // 0..1 outer shockwave progress
  swirl:   number;        // 0..1 pending orbit intensity
}

const GONE: FiringVisual = {
  visible: false,
  active: false,
  travel: null,
  glow: 0,
  ripple: null,
  ripple2: null,
  ripple3: null,
  spark: 0,
  ember: 0,
  aftershock: 0,
  wake: 0,
  shock: null,
  swirl: 0,
};

// Ease-out cubic for travel so the pulse decelerates into the neuron.
function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

// Ease-in-out sine for breathing oscillation.
export function breathe(now: number, offset = 0): number {
  const t = ((now + offset) % BREATHE_MS) / BREATHE_MS;
  return 0.5 - 0.5 * Math.cos(t * Math.PI * 2);
}

// Star twinkle — returns alpha multiplier 0..1 for a given star seed.
export function twinkle(now: number, seed: number): number {
  // Each star gets a slightly different period to desynchronize.
  const period = TWINKLE_MS * (0.7 + (seed & 0xff) / 0xff * 0.6);
  const t = ((now + seed) % period) / period;
  return 0.25 + 0.75 * (0.5 - 0.5 * Math.cos(t * Math.PI * 2));
}

// Synapse shimmer position — 0..1 wave front travelling from center → node.
export function shimmerT(now: number, seed: number): number {
  const period = SHIMMER_MS * (0.8 + (seed & 0xff) / 0xff * 0.4);
  return ((now + seed * 137) % period) / period;
}

// Caller ring phase — slow rotation angle (radians).
export function ringPhase(now: number): number {
  return (now % RING_ROT_MS) / RING_ROT_MS * Math.PI * 2;
}

/**
 * Constellation orbit angle (radians) from accumulated elapsed ms.
 * Pure helper so canvas + overlay + unit tests share one clock contract.
 */
export function gemOrbitAngle(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs === 0) return 0;
  const t = ((elapsedMs % GEM_ORBIT_MS) + GEM_ORBIT_MS) % GEM_ORBIT_MS;
  return (t / GEM_ORBIT_MS) * Math.PI * 2;
}

/** In-place gem facet / glint spin (radians). */
export function gemSpinAngle(now: number, phase = 0): number {
  const t = (((now + phase) % GEM_SPIN_MS) + GEM_SPIN_MS) % GEM_SPIN_MS;
  return (t / GEM_SPIN_MS) * Math.PI * 2;
}

// Hot corona breath for a live gem (0..1), independent of firing age.
export function coronaPulse(now: number, seed = 0): number {
  const t = ((now + seed) % CORONA_MS) / CORONA_MS;
  return 0.5 - 0.5 * Math.cos(t * Math.PI * 2);
}

/**
 * @param travelMs optional per-firing travel duration (latency / path aware).
 * Defaults to `TRAVEL_MS` so existing unit tests keep their exact contracts.
 * Total active life uses `travelMs + GLOW_MS` (still under FIRING_TTL when default).
 */
export function firingVisual(
  age: number,
  pending: boolean,
  motion: boolean,
  travelMs: number = TRAVEL_MS,
): FiringVisual {
  const trip = travelMs > 0 ? travelMs : TRAVEL_MS;
  const life = trip + GLOW_MS;

  if (age < 0) {
    return {
      visible: true, active: true, travel: 0, glow: 0.16,
      ripple: null, ripple2: null, ripple3: null, spark: 0.55, ember: 0,
      aftershock: 0, wake: 0.2, shock: null, swirl: 0.15,
    };
  }
  if (!pending && age >= life) return GONE;

  if (!motion) {
    const decay = pending ? 0.62 : Math.max(0, 1 - Math.max(0, age - trip) / GLOW_MS);
    return {
      visible: true, active: false, travel: null, glow: decay,
      ripple: null, ripple2: null, ripple3: null, spark: 0, ember: 0,
      aftershock: 0, wake: 0, shock: null, swirl: pending ? 0.25 : 0,
    };
  }

  const rawTravel = age < trip ? age / trip : null;
  const travel    = rawTravel == null ? null : easeOutCubic(rawTravel);
  const dg        = age - trip;

  // Triple ripple cascade on arrival
  const ripple  = dg >= 0 && dg < RIPPLE_MS ? dg / RIPPLE_MS : null;
  const dg2     = dg - 140;
  const ripple2 = dg2 >= 0 && dg2 < RIPPLE_MS ? dg2 / RIPPLE_MS : null;
  const dg3     = dg - 280;
  const ripple3 = dg3 >= 0 && dg3 < RIPPLE_MS * 0.9 ? dg3 / (RIPPLE_MS * 0.9) : null;

  let glow: number;
  if (age < trip) glow = 0.14 + 0.28 * (rawTravel ?? 0);
  else if (pending) glow = 0.72;
  else              glow = Math.max(0, 1 - dg / GLOW_MS);

  // Spark peaks mid-travel and again at the arrival flash window.
  let spark = 0;
  if (rawTravel != null) {
    spark = Math.sin(rawTravel * Math.PI) * 0.95;
  } else if (dg >= 0 && dg < 280) {
    spark = Math.max(0, 1 - dg / 280);
  }

  // Ember spray lives for ~1s after arrival (used for floating flecks).
  let ember = 0;
  if (dg >= 0 && dg < 1000) {
    ember = Math.sin(Math.min(1, dg / 1000) * Math.PI) * (pending ? 0.85 : 1);
  } else if (pending) {
    ember = 0.35; // keep a soft swirl while request is in-flight
  }

  // Enrichment layers (visual only — life/TTL contracts unchanged).
  const wake = wakeStrength(travel, true); // live-ness scaled in scene via pl.live
  const aftershock = dg >= 0 ? aftershockEnvelope(dg) : 0;
  const shock = dg >= 0 ? shockwaveProgress(dg) : null;
  const swirl = pendingSwirl(dg, pending);

  // Aftershock briefly kicks glow + spark so the gem "pops" a second time.
  if (aftershock > 0) {
    glow = Math.min(1, glow + 0.18 * aftershock);
    spark = Math.max(spark, 0.55 * aftershock);
  }

  return {
    visible: true, active: true, travel, glow, ripple, ripple2, ripple3, spark, ember,
    aftershock, wake, shock, swirl,
  };
}
