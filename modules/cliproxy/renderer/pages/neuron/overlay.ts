// N4 overlay + interaction math, kept DOM-free so hit-testing and label/tooltip
// formatting stay unit-testable. NeuronCanvas maps the pure layout (normalized
// 0..1) into pixel-space NodeViews, hit-tests the pointer against them, and asks
// this module how to label each neuron ("live" vs "~Ns ago") and what to show in
// the hover tooltip. Everything here is a pure function of inputs + `now`.

import type { Layout } from "./layout";
import { orbitLayoutNodes } from "./layout";
import { normalizeProvider } from "./palette";
import type { Firing, NeuronNode } from "./types";

// A firing keeps a node "live" while pending or this fresh (mirrors the canvas
// glow window; FIRING_TTL_MS in graph.ts is 4000).
export const LIVE_MS = 4000;

// Pixel-space placement of a neuron, derived from the normalized layout + canvas
// size. baseR matches NeuronCanvas so overlay chips sit exactly on the glow.
export interface NodeView {
  id: string;
  provider: string;
  model: string;
  x: number; // css px
  y: number; // css px
  r: number; // css px radius
}

export function placeNodes(
  layout: Layout,
  w: number,
  h: number,
  /** Constellation orbit angle (radians). Keeps chips / hit-test on painted gems. */
  orbitRad = 0,
): NodeView[] {
  const baseR = Math.min(w, h) * 0.05;
  const nodes = orbitLayoutNodes(layout.nodes, layout.center, orbitRad);
  return nodes.map((n) => ({
    id: n.id,
    provider: n.provider,
    model: n.model,
    x: n.x * w,
    y: n.y * h,
    r: baseR * n.size,
  }));
}

// Nearest neuron under the pointer, within a forgiving reach; null if none.
export function hitTest(views: NodeView[], mx: number, my: number): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const v of views) {
    const d = Math.hypot(mx - v.x, my - v.y);
    const reach = Math.max(v.r * 1.6, 16);
    if (d <= reach && d < bestD) {
      bestD = d;
      best = v.id;
    }
  }
  return best;
}

export function agoText(ts: number | null, now: number): string {
  if (ts == null) return "—";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 1) return "now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

export interface NodeStatus {
  live: boolean; // a firing is pending or within LIVE_MS
  failing: boolean; // fresh fail with no concurrent healthy live on this gem
  hasFail: boolean; // any fresh fail hop (even when healthy LIVE is primary)
  label: string; // "live" when live, else "~Ns ago"
}

/** Chip / pin / tooltip status text — healthy LIVE wins; concurrent fail is secondary. */
export function statusLabel(st: Pick<NodeStatus, "live" | "failing" | "hasFail">): string {
  if (st.failing) return "failed";
  if (st.live && st.hasFail) return "live · also fail";
  if (st.live) return "live";
  return "idle";
}

export function nodeStatus(node: NeuronNode, firings: Firing[], now: number): NodeStatus {
  let live = false;
  let hasFailed = false;
  let hasHealthy = false;
  for (const f of firings) {
    if (f.nodeId !== node.id) continue;
    if (f.pending || now - f.startedAt < LIVE_MS) {
      live = true;
      if (f.failed) hasFailed = true;
      else hasHealthy = true;
    }
  }
  // Same gem can carry concurrent hops: prefer healthy LIVE over fail / last-error.
  const failing = hasFailed && !hasHealthy;
  return {
    live,
    failing,
    hasFail: hasFailed,
    label: live ? "live" : agoText(node.lastHitTs, now),
  };
}

export interface Tooltip {
  title: string;
  rows: [string, string][];
  failing: boolean;
  hasFail: boolean;
}

// Structured tooltip content for a hovered neuron. Rows are kept as label/value
// pairs so the DOM layer just renders them.
// Optional account label resolver: UI passes auth_index → email/label (masked
// or full depending on the global reveal preference). Pure so tests can inject
// a fixed map without touching /auth-files.
export type AccountLabelFn = (authIndex: string | null | undefined) => string | null;

// Prefer the credential on the freshest firing for this node; fall back to the
// node's last-known auth_index from recent[] history. Shared by tooltips and
// the on-canvas account chips so both stay consistent.
export function authIndexForNode(node: NeuronNode, firings: Firing[]): string | null {
  let authIndex = node.lastAuthIndex;
  let bestTs = -1;
  for (const f of firings) {
    if (f.nodeId !== node.id || !f.authIndex) continue;
    if (f.startedAt >= bestTs) {
      bestTs = f.startedAt;
      authIndex = f.authIndex;
    }
  }
  return authIndex;
}

export function accountForNode(
  node: NeuronNode,
  firings: Firing[],
  accountLabel?: AccountLabelFn
): string | null {
  if (!accountLabel) return null;
  return accountLabel(authIndexForNode(node, firings));
}

// With many logged-in accounts (e.g. 15× Grok) auto-switch lands on ONE gem
// per model. Surface the last few distinct credentials so the chip isn't just
// a silent flip of a single truncated email.
export function recentAccountsForNode(
  node: NeuronNode,
  firings: Firing[],
  accountLabel?: AccountLabelFn,
  limit = 3
): string[] {
  if (!accountLabel || limit <= 0) return [];
  const ordered = [...firings]
    .filter((f) => f.nodeId === node.id && f.authIndex)
    .sort((a, b) => b.startedAt - a.startedAt);
  const labels: string[] = [];
  const seen = new Set<string>();
  const push = (idx: string | null | undefined) => {
    if (idx == null || idx === "" || seen.has(idx)) return;
    const label = accountLabel(idx);
    if (!label) return;
    seen.add(idx);
    labels.push(label);
  };
  for (const f of ordered) {
    push(f.authIndex);
    if (labels.length >= limit) break;
  }
  if (labels.length < limit) push(node.lastAuthIndex);
  return labels;
}

// Compact label for the pin under each gem (emails keep domain when possible).
// Live chips get a slightly higher default so 15 auto-switch accounts stay
// distinguishable (more of the local part before the ellipsis).
export function shortAccount(label: string, max = 18): string {
  if (label.length <= max) return label;
  const at = label.indexOf("@");
  if (at > 0) {
    const domain = label.slice(at);
    // Prefer keeping domain; leave at least 3 chars of local for uniqueness.
    const budget = Math.max(3, max - domain.length - 1);
    if (budget + 1 + domain.length > max && domain.length > 8) {
      // Very long domain — keep local + short domain tail.
      const local = label.slice(0, Math.max(3, max - 6));
      return `${local}…${domain.slice(-4)}`;
    }
    return `${label.slice(0, budget)}…${domain}`;
  }
  return `${label.slice(0, max - 1)}…`;
}

export function tooltipFor(
  node: NeuronNode,
  firings: Firing[],
  now: number,
  accountLabel?: AccountLabelFn
): Tooltip {
  const st = nodeStatus(node, firings, now);
  const account = accountForNode(node, firings, accountLabel);
  const trail = recentAccountsForNode(node, firings, accountLabel, 4);

  const rows: [string, string][] = [
    ["Provider", normalizeProvider(node.provider)],
    ["Model", node.model],
  ];
  if (account) rows.push(["Account", account]);
  // When auto-switch has used several credentials on this gem, show the trail
  // (newest first) so multi-account pools (Grok×N) stay legible.
  if (trail.length > 1) rows.push(["Recent accounts", trail.join(" · ")]);
  rows.push(["Requests", String(node.requests)], ["Last hit", agoText(node.lastHitTs, now)]);
  if (node.lastLatencyMs != null) rows.push(["Last latency", `${node.lastLatencyMs} ms`]);
  rows.push(["Status", statusLabel(st)]);
  // Tooltip keeps primary failing for red chrome; mixed LIVE+fail uses secondary note only.
  return { title: node.id, rows, failing: st.failing, hasFail: st.hasFail };
}

// ── Stage chrome helpers (stats strip, density, pin panel) ────────────────────

export type DensityMode = "full" | "compact";

/** Compact when the constellation is crowded — fewer labels, tighter chips. */
export function densityMode(nodeCount: number): DensityMode {
  return nodeCount >= 10 ? "compact" : "full";
}

export interface StageStats {
  live: number;
  nearLive: number;
  fails: number;
  nodes: number;
  lastHitTs: number | null;
  lastHitAgo: string;
}

/** Aggregate numbers for the glass stats strip over the canvas. */
export function stageStats(nodes: NeuronNode[], firings: Firing[], now: number): StageStats {
  let fails = 0;
  const liveNodes = new Set<string>();
  const nearNodes = new Set<string>();
  for (const f of firings) {
    const fresh = f.pending || now - f.startedAt < LIVE_MS;
    if (!fresh) continue;
    if (f.failed) fails += 1;
    if (f.live) liveNodes.add(f.nodeId);
    else nearNodes.add(f.nodeId);
  }
  // Prefer live over near when both exist for the same gem.
  for (const id of liveNodes) nearNodes.delete(id);
  const live = liveNodes.size;
  const nearLive = nearNodes.size;
  let lastHitTs: number | null = null;
  for (const n of nodes) {
    if (n.lastHitTs != null && (lastHitTs == null || n.lastHitTs > lastHitTs)) {
      lastHitTs = n.lastHitTs;
    }
  }
  for (const f of firings) {
    if (lastHitTs == null || f.startedAt > lastHitTs) lastHitTs = f.startedAt;
  }
  return {
    live,
    nearLive,
    fails,
    nodes: nodes.length,
    lastHitTs,
    lastHitAgo: agoText(lastHitTs, now),
  };
}

export interface PinDetail {
  id: string;
  title: string;
  provider: string;
  model: string;
  account: string | null;
  trail: string[];
  requests: number;
  lastHit: string;
  latency: string | null;
  status: string;
  failing: boolean;
  hasFail: boolean;
  recent: { when: string; live: boolean; failed: boolean; account: string | null; latency: string | null }[];
}

/** Structured pin-panel content for a clicked gem (richer than hover tooltip). */
export function pinDetailFor(
  node: NeuronNode,
  firings: Firing[],
  now: number,
  accountLabel?: AccountLabelFn,
): PinDetail {
  const st = nodeStatus(node, firings, now);
  const account = accountForNode(node, firings, accountLabel);
  const trail = recentAccountsForNode(node, firings, accountLabel, 5);
  const recent = [...firings]
    .filter((f) => f.nodeId === node.id)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 5)
    .map((f) => ({
      when: agoText(f.startedAt, now),
      live: f.live,
      failed: f.failed,
      account: accountLabel ? accountLabel(f.authIndex) : null,
      latency: f.latencyMs != null ? `${f.latencyMs} ms` : null,
    }));
  return {
    id: node.id,
    title: node.id,
    provider: normalizeProvider(node.provider),
    model: node.model,
    account,
    trail,
    requests: node.requests,
    lastHit: agoText(node.lastHitTs, now),
    latency: node.lastLatencyMs != null ? `${node.lastLatencyMs} ms` : null,
    status: statusLabel(st),
    failing: st.failing,
    hasFail: st.hasFail,
    recent,
  };
}
