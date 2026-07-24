import type { NeuronNode } from "./types";

// Deterministic radial "brain" layout. Pure (no DOM) so it can be unit-tested;
// the canvas maps the normalized [0..1] coordinates to pixels. Center = the
// "caller" (VS Code / JetBrains / in-app chat). Each provider owns an angular
// lobe around it; that provider's models cluster around the lobe, sized by
// cumulative requests.

export interface PlacedNode {
  id: string;
  provider: string;
  model: string;
  x: number; // 0..1
  y: number; // 0..1
  size: number; // 0.4..1.0 relative (∝ sqrt of requests share)
}

export interface Layout {
  center: { x: number; y: number };
  nodes: PlacedNode[];
}

/**
 * Rotate every gem around the caller center by `angleRad` (normalized 0..1 space).
 * Pure: returns new node list; empty / zero-angle short-circuits.
 * Used by canvas geom + overlay chips so hit-test stays aligned with paint.
 */
export function orbitLayoutNodes(
  nodes: PlacedNode[],
  center: { x: number; y: number },
  angleRad: number,
): PlacedNode[] {
  if (nodes.length === 0 || !Number.isFinite(angleRad) || angleRad === 0) return nodes;
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  return nodes.map((n) => {
    const dx = n.x - center.x;
    const dy = n.y - center.y;
    return {
      ...n,
      x: center.x + dx * c - dy * s,
      y: center.y + dx * s + dy * c,
    };
  });
}

// Distance of a provider lobe from center — pushed outward so gems don't crowd
// the caller nucleus or each other. Adaptive: shrinks slightly when there are
// many providers to keep everything inside the viewport.
function lobeRadius(providerCount: number): number {
  if (providerCount <= 2) return 0.40;
  if (providerCount <= 4) return 0.38;
  return 0.36;
}

export function computeLayout(nodes: NeuronNode[]): Layout {
  const center = { x: 0.5, y: 0.5 };
  if (nodes.length === 0) return { center, nodes: [] };

  const byProvider = new Map<string, NeuronNode[]>();
  for (const n of nodes) {
    const arr = byProvider.get(n.provider) ?? [];
    arr.push(n);
    byProvider.set(n.provider, arr);
  }
  const providers = [...byProvider.keys()].sort();
  const P = providers.length;
  const maxReq = Math.max(1, ...nodes.map((n) => n.requests));

  const LOBE_R = lobeRadius(P);

  const placed: PlacedNode[] = [];
  providers.forEach((provider, p) => {
    const baseAngle = (p / P) * Math.PI * 2 - Math.PI / 2;
    const lobeX = center.x + Math.cos(baseAngle) * LOBE_R;
    const lobeY = center.y + Math.sin(baseAngle) * LOBE_R;
    const models = byProvider
      .get(provider)!
      .slice()
      .sort((a, b) => b.requests - a.requests || a.model.localeCompare(b.model));
    const M = models.length;
    // Wider cluster radius so models within a provider don't overlap.
    // Grows with model count, clamped so it doesn't escape the viewport.
    const clusterR = M <= 1 ? 0 : Math.min(0.26, 0.10 + 0.022 * M);
    models.forEach((n, m) => {
      const a = M <= 1 ? 0 : (m / M) * Math.PI * 2;
      placed.push({
        id: n.id,
        provider: n.provider,
        model: n.model,
        x: lobeX + Math.cos(a) * clusterR,
        y: lobeY + Math.sin(a) * clusterR,
        size: 0.4 + 0.6 * Math.sqrt(n.requests / maxReq),
      });
    });
  });

  // ── Collision relaxation ───────────────────────────────────────────────────
  // Simple iterative push-apart so overlapping gems separate. Operates in
  // normalized [0..1] space. The "desired gap" is proportional to the sum of
  // both node sizes so bigger gems get more breathing room.
  const MIN_GAP = 0.105; // minimum center-to-center distance (normalized)
  for (let iter = 0; iter < 14; iter++) {
    let moved = false;
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i], b = placed[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 0.001;
        const desired = MIN_GAP * (a.size + b.size) * 0.5 / 0.7; // scale by avg size
        if (dist < desired) {
          moved = true;
          const push = (desired - dist) * 0.5;
          const nx = (dx / dist) * push;
          const ny = (dy / dist) * push;
          a.x -= nx; a.y -= ny;
          b.x += nx; b.y += ny;
        }
      }
    }
    // Clamp back into safe viewport area (leave margin for gem radius + label)
    const MARGIN = 0.08;
    for (const n of placed) {
      n.x = Math.max(MARGIN, Math.min(1 - MARGIN, n.x));
      n.y = Math.max(MARGIN, Math.min(1 - MARGIN, n.y));
    }
    if (!moved) break;
  }

  return { center, nodes: placed };
}
