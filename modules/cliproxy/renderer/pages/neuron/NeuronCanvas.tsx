import { useEffect, useRef, useState } from "react";
import { computeLayout, type Layout } from "./layout";
import { providerPalette } from "./palette";
import {
  accountForNode,
  densityMode,
  hitTest,
  nodeStatus,
  pinDetailFor,
  placeNodes,
  recentAccountsForNode,
  shortAccount,
  tooltipFor,
  type PinDetail,
} from "./overlay";
import { drawScene, FAIL_ACCENT, FAIL_SOFT, hexA } from "./scene";
import type { AccountLabelFn } from "./overlay";
import type { Firing, NeuronNode } from "./types";
import { BIRTH_MS, FLASH_MS, gemOrbitAngle, liveStreamHaptic } from "./anim";

// Animated Canvas 2D "brain" with DOM overlay.
// rAF loop: self-idles when nothing animating, pauses on hidden tab / reduced-motion.
// FPS governor: demotes quality mid-session if frames stay heavy.
// DOM overlay: live chips, frosted tooltip, click-to-pin detail panel.
// Constellation orbit: gems slowly revolve around the caller (default on); Stop freezes.
export function NeuronCanvas({
  nodes,
  firings = [],
  height = 720,
  now = Date.now(),
  accountLabel,
}: {
  nodes: NeuronNode[];
  firings?: Firing[];
  height?: number;
  now?: number;
  accountLabel?: AccountLabelFn;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const firingsRef = useRef(firings);
  const layoutRef = useRef<{ src: NeuronNode[]; layout: Layout }>({ src: [], layout: computeLayout([]) });
  const kickRef = useRef<() => void>(() => {});
  const hoverIdRef = useRef<string | null>(null);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const flashAtRef = useRef<number | null>(null);
  const birthAtRef = useRef<Record<string, number>>({});
  const seenLiveRef = useRef<Set<string>>(new Set());
  const knownNodesRef = useRef<Set<string>>(new Set());
  const qualityCapRef = useRef<"high" | "balanced" | "low">("high");
  const frameMsRef = useRef<number[]>([]);
  const lastFrameAtRef = useRef(0);
  // Constellation orbit clock (accumulated ms). Freeze by not advancing.
  const orbitElapsedRef = useRef(0);
  const orbitLastTsRef = useRef(0);
  const orbitOverlayAtRef = useRef(0);
  const orbitOnRef = useRef(true);
  const [cssW, setCssW] = useState(0);
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const [pin, setPin] = useState<PinDetail | null>(null);
  const [pinId, setPinId] = useState<string | null>(null);
  /** Default on: gems slowly revolve. Stop freezes angle in place. */
  const [orbitOn, setOrbitOn] = useState(true);
  /** Throttled angle for DOM chips / hit-test (synced with paint). */
  const [orbitRad, setOrbitRad] = useState(0);

  orbitOnRef.current = orbitOn;
  firingsRef.current = firings;
  if (layoutRef.current.src !== nodes) {
    layoutRef.current = { src: nodes, layout: computeLayout(nodes) };
  }

  // First-fire birth: record when each node id first appears.
  useEffect(() => {
    const known = knownNodesRef.current;
    const birth = { ...birthAtRef.current };
    let added = false;
    const t = Date.now();
    for (const n of nodes) {
      if (!known.has(n.id)) {
        known.add(n.id);
        birth[n.id] = t;
        added = true;
      }
    }
    // Drop birth keys for nodes that left long ago (keep map small).
    for (const id of Object.keys(birth)) {
      if (!nodes.some((n) => n.id === id) && t - birth[id] > BIRTH_MS) {
        delete birth[id];
        known.delete(id);
        added = true;
      }
    }
    if (added) {
      birthAtRef.current = birth;
      kickRef.current();
    }
  }, [nodes]);

  // Cinematic flash when a brand-new live (path A) firing starts.
  useEffect(() => {
    const seen = seenLiveRef.current;
    let newest: number | null = null;
    for (const f of firings) {
      if (!f.live) continue;
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      if (newest == null || f.startedAt > newest) newest = f.startedAt;
    }
    // Prune stale ids so the set doesn't grow forever.
    if (seen.size > 200) {
      const liveIds = new Set(firings.filter((f) => f.live).map((f) => f.id));
      for (const id of [...seen]) {
        if (!liveIds.has(id)) seen.delete(id);
      }
    }
    if (newest != null) {
      flashAtRef.current = Date.now();
      kickRef.current();
      // Clear after window so future paints don't keep flash active forever.
      window.setTimeout(() => {
        if (flashAtRef.current != null && Date.now() - flashAtRef.current >= FLASH_MS) {
          flashAtRef.current = null;
        }
      }, FLASH_MS + 30);
    }
  }, [firings]);

  // Refresh pin panel contents when data ticks.
  useEffect(() => {
    if (!pinId) {
      setPin(null);
      return;
    }
    const n = nodes.find((x) => x.id === pinId);
    if (!n) {
      setPin(null);
      setPinId(null);
      return;
    }
    setPin(pinDetailFor(n, firings, now, accountLabel));
  }, [pinId, nodes, firings, now, accountLabel]);

  useEffect(() => {
    const wrap = wrapRef.current, canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0, running = false, w = 0;
    const reduce = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    const paused = () => document.hidden || (reduce?.matches ?? false);

    const demote = (q: "high" | "balanced" | "low"): "high" | "balanced" | "low" => {
      const cap = qualityCapRef.current;
      if (cap === "low" || q === "low") return "low";
      if (cap === "balanced" && q === "high") return "balanced";
      return q;
    };

    const tickOrbit = (wallNow: number) => {
      // Prefer reduced-motion: never advance constellation orbit.
      if (reduce?.matches) {
        orbitLastTsRef.current = 0;
        return;
      }
      if (!orbitOnRef.current) {
        orbitLastTsRef.current = 0;
        return;
      }
      if (orbitLastTsRef.current > 0) {
        const dt = wallNow - orbitLastTsRef.current;
        // Cap huge jumps after tab sleep so gems don't teleport.
        if (dt > 0 && dt < 250) orbitElapsedRef.current += dt;
      }
      orbitLastTsRef.current = wallNow;
      // Throttle React overlay updates (~20fps) so chips track gems without jank.
      if (wallNow - orbitOverlayAtRef.current >= 48) {
        orbitOverlayAtRef.current = wallNow;
        setOrbitRad(gemOrbitAngle(orbitElapsedRef.current));
      }
    };

    const sceneOpts = () => {
      const dpr = window.devicePixelRatio || 1;
      const nCount = layoutRef.current.layout.nodes.length;
      let quality: "high" | "balanced" | "low" = "high";
      if (nCount >= 18 || dpr >= 2.5) quality = "balanced";
      if (nCount >= 28) quality = "low";
      if (reduce?.matches) quality = "low";
      quality = demote(quality);
      // Path-A cinematic haptic: tiny canvas shake on flash start.
      let shakePx = 0;
      const flashAt = flashAtRef.current;
      if (flashAt != null && !reduce?.matches) {
        const hap = liveStreamHaptic(Date.now() - flashAt);
        if (hap > 0.02) {
          // Sub-pixel jitter — expensive UI feel without nausea.
          const s = Math.sin(Date.now() / 9) * hap * 0.55;
          shakePx = s;
        }
      }
      return {
        hoverId: hoverIdRef.current,
        pointer: pointerRef.current,
        density: densityMode(nCount),
        birthAt: birthAtRef.current,
        flashAt: flashAtRef.current,
        quality,
        shakePx,
        orbitElapsedMs: orbitElapsedRef.current,
        // Reduced-motion forces freeze even if the toggle is on.
        orbitEnabled: orbitOnRef.current && !(reduce?.matches ?? false),
      };
    };

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      w = wrap.clientWidth || 600;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      setCssW(w);
      // Fresh geometry after resize — quality may recover later via light frames.
      qualityCapRef.current = "high";
      frameMsRef.current = [];
    };

    const noteFrameCost = (ms: number) => {
      const buf = frameMsRef.current;
      buf.push(ms);
      if (buf.length > 24) buf.shift();
      if (buf.length < 10) return;
      const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
      // Demote when consistently heavy; promote slowly when light again.
      if (avg > 16.5 && qualityCapRef.current === "high") {
        qualityCapRef.current = "balanced";
        buf.length = 0;
      } else if (avg > 22 && qualityCapRef.current !== "low") {
        qualityCapRef.current = "low";
        buf.length = 0;
      } else if (avg < 10 && qualityCapRef.current === "low") {
        qualityCapRef.current = "balanced";
        buf.length = 0;
      } else if (avg < 8 && qualityCapRef.current === "balanced") {
        qualityCapRef.current = "high";
        buf.length = 0;
      }
    };

    const paint = (motion: boolean) => {
      const t0 = performance.now();
      if (motion) tickOrbit(t0);
      const active = drawScene(
        ctx, w, height, layoutRef.current.layout, firingsRef.current, Date.now(), motion, sceneOpts(),
      );
      if (motion) noteFrameCost(performance.now() - t0);
      return active;
    };

    const frame = () => {
      lastFrameAtRef.current = performance.now();
      const active = paint(true);
      if (active && !paused()) { raf = requestAnimationFrame(frame); } else { running = false; }
    };

    const kick = () => {
      if (paused()) { paint(false); return; }
      if (running) return;
      running = true; raf = requestAnimationFrame(frame);
    };
    kickRef.current = kick;

    resize(); kick();

    const ro = new ResizeObserver(() => { resize(); if (running) paint(true); else kick(); });
    ro.observe(wrap);
    const onVis = () => { if (!document.hidden) kick(); else paint(false); };
    document.addEventListener("visibilitychange", onVis);
    reduce?.addEventListener?.("change", kick);

    return () => {
      cancelAnimationFrame(raf); running = false;
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      reduce?.removeEventListener?.("change", kick);
    };
  }, [height]);

  // Snap overlay to frozen angle when stopping; resume from same elapsed when playing.
  useEffect(() => {
    setOrbitRad(gemOrbitAngle(orbitElapsedRef.current));
    if (!orbitOn) orbitLastTsRef.current = 0;
    kickRef.current();
  }, [orbitOn]);

  const views = cssW > 0 ? placeNodes(layoutRef.current.layout, cssW, height, orbitRad) : [];
  const nodeById = new Map(nodes.map((n) => [n.id, n] as const));
  const density = densityMode(nodes.length);
  const hovered = hover ? nodeById.get(hover.id) : undefined;
  // Hide floating tooltip while pin panel is open for the same gem (pin is richer).
  const tip =
    hover && hovered && hover.id !== pinId
      ? tooltipFor(hovered, firings, now, accountLabel)
      : null;

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const id = hitTest(views, mx, my);
    hoverIdRef.current = id;
    pointerRef.current = { x: cssW > 0 ? mx / cssW : 0.5, y: height > 0 ? my / height : 0.5 };
    setHover(id ? { id, x: mx, y: my } : null);
    kickRef.current();
  };

  const onLeave = () => {
    hoverIdRef.current = null;
    pointerRef.current = null;
    setHover(null);
    kickRef.current();
  };

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // Ignore clicks on the orbit control (button stops propagation, but be safe).
    if ((e.target as HTMLElement | null)?.closest?.(".neuron-orbit-btn")) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const id = hitTest(views, e.clientX - rect.left, e.clientY - rect.top);
    if (!id) {
      setPinId(null);
      return;
    }
    setPinId((cur) => (cur === id ? null : id));
    kickRef.current();
  };

  const toggleOrbit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setOrbitOn((v) => !v);
  };

  return (
    <div
      ref={wrapRef}
      className={`neuron-canvas-wrap${density === "compact" ? " density-compact" : ""}${orbitOn ? " orbit-on" : " orbit-off"}`}
      style={{ width: "100%", position: "relative", cursor: hover ? "pointer" : "default" }}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      onClick={onClick}
    >
      {/* Soft chrome frame over the constellation */}
      <div className="neuron-canvas-glow" aria-hidden />
      <canvas ref={canvasRef} className="neuron-canvas" style={{ display: "block", borderRadius: 18 }} />

      {/* Constellation orbit control — default moving; Stop freezes gems in place */}
      <button
        type="button"
        className={`neuron-orbit-btn${orbitOn ? " is-moving" : " is-stopped"}`}
        onClick={toggleOrbit}
        aria-pressed={!orbitOn}
        title={orbitOn ? "Stop constellation orbit" : "Resume constellation orbit"}
      >
        <span className="neuron-orbit-btn-icon" aria-hidden>{orbitOn ? "■" : "▶"}</span>
        <span className="neuron-orbit-btn-label">{orbitOn ? "Stop" : "Play"}</span>
      </button>

      {/* Empty state */}
      {nodes.length === 0 && (
        <div className="neuron-empty">
          <div className="neuron-empty-orb" aria-hidden>
            <span className="neuron-empty-ring" />
            <span className="neuron-empty-ring delay" />
            <span className="neuron-empty-core">◉</span>
          </div>
          <div className="neuron-empty-title">No neurons firing yet</div>
          <div className="neuron-empty-sub">
            Hit a model from VS Code, JetBrains, or in-app chat — each one lights up as a gem the moment it fires.
          </div>
        </div>
      )}

      {/* Live status + account chips per neuron.
          Compact density: only live chips, shorter account labels. */}
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
        {views.map((v) => {
          const n = nodeById.get(v.id);
          if (!n) return null;
          const st = nodeStatus(n, firings, now);
          const account = accountForNode(n, firings, accountLabel);
          const trail = recentAccountsForNode(n, firings, accountLabel, 3);
          const prev = trail.length > 1 && density === "full" ? trail.slice(1) : [];
          const accent = st.failing ? FAIL_ACCENT : providerPalette(v.provider).accent;
          const mixedFail = st.live && st.hasFail && !st.failing;
          const statusWord = st.failing ? "failed" : mixedFail ? "live · also fail" : "live";
          const pinned = pinId === v.id;
          if (!st.live && !account && !pinned) return null;
          // Compact: suppress idle account pins to reduce clutter.
          if (density === "compact" && !st.live && !pinned) return null;
          const stackH = st.live && account ? (prev.length ? 52 : 40) : st.live || account || pinned ? 22 : 0;
          const accLen = density === "compact" ? 14 : 22;
          return (
            <div
              key={v.id}
              style={{
                position: "absolute",
                left: v.x,
                top: v.y - v.r - stackH,
                transform: "translateX(-50%)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 3,
                maxWidth: density === "compact" ? 132 : 168,
              }}
            >
              {st.live && (
                <span
                  className={`neuron-live-chip${st.failing ? " fail" : ""}${mixedFail ? " mixed-fail" : ""}`}
                  style={{
                    background: accent,
                    boxShadow: `0 0 18px ${hexA(accent, 0.8)}, 0 0 5px ${hexA(accent, 0.95)}, inset 0 1px 0 rgba(255,255,255,0.35)`,
                  }}
                  title={account ? `${statusWord} · ${account}` : statusWord}
                >
                  <span className="neuron-live-dot" />
                  {st.failing ? "failed" : "live"}
                  {mixedFail && <span className="neuron-also-fail" aria-label="also fail">fail</span>}
                  {account ? ` · ${shortAccount(account, accLen)}` : ""}
                </span>
              )}
              {!st.live && account && density === "full" && (
                <span className="neuron-account-pin" title={account}>
                  {shortAccount(account, 20)}
                </span>
              )}
              {st.live && prev.length > 0 && (
                <span
                  className="neuron-prev-trail"
                  title={`Recent: ${trail.join(" → ")}`}
                  style={{ borderColor: hexA(accent, 0.3) }}
                >
                  prev {prev.map((a) => shortAccount(a, 12)).join(" · ")}
                </span>
              )}
              {pinned && (
                <span className="neuron-pin-marker" style={{ borderColor: hexA(accent, 0.45), color: accent }}>
                  pinned
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Frosted-glass tooltip */}
      {tip && hover && (
        <div
          className={`neuron-tooltip${tip.failing ? " fail" : ""}${!tip.failing && tip.hasFail ? " mixed-fail" : ""}`}
          style={{
            left: Math.min(Math.max(hover.x + 16, 8), Math.max(cssW - 236, 8)),
            top: Math.min(hover.y + 16, height - 8),
            borderColor: tip.failing ? FAIL_SOFT : tip.hasFail ? "rgba(251,113,133,0.22)" : undefined,
          }}
        >
          <div className="neuron-tooltip-title" style={{ color: tip.failing ? FAIL_ACCENT : undefined }}>
            {tip.title}
          </div>
          <div className="neuron-tooltip-rows">
            {tip.rows.map(([k, val]) => (
              <div key={k} className="neuron-tooltip-row">
                <span className="neuron-tooltip-k">{k}</span>
                <span
                  className="neuron-tooltip-v"
                  style={{
                    color:
                      k === "Status" && (tip.failing || tip.hasFail) ? FAIL_ACCENT : undefined,
                  }}
                >
                  {val}
                </span>
              </div>
            ))}
          </div>
          <div className="neuron-tooltip-hint">Click gem to pin details</div>
        </div>
      )}

      {/* Pin detail panel */}
      {pin && (
        <div
          className={`neuron-pin-panel${pin.failing ? " fail" : ""}${!pin.failing && pin.hasFail ? " mixed-fail" : ""}`}
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-label={`Pinned ${pin.title}`}
        >
          <div className="neuron-pin-head">
            <div>
              <div className="neuron-pin-kicker">{pin.provider}</div>
              <div className="neuron-pin-title" style={{ color: pin.failing ? FAIL_ACCENT : undefined }}>
                {pin.model}
              </div>
            </div>
            <button
              type="button"
              className="neuron-pin-close"
              onClick={(e) => {
                e.stopPropagation();
                setPinId(null);
              }}
              aria-label="Close pin"
            >
              ×
            </button>
          </div>
          <div className="neuron-pin-rows">
            <div className="neuron-pin-row">
              <span>Status</span>
              <span className={pin.failing || pin.hasFail ? "fail" : ""}>{pin.status}</span>
            </div>
            <div className="neuron-pin-row"><span>Requests</span><span>{pin.requests}</span></div>
            <div className="neuron-pin-row"><span>Last hit</span><span>{pin.lastHit}</span></div>
            {pin.latency && <div className="neuron-pin-row"><span>Latency</span><span>{pin.latency}</span></div>}
            {pin.account && <div className="neuron-pin-row"><span>Account</span><span title={pin.account}>{shortAccount(pin.account, 28)}</span></div>}
            {pin.trail.length > 1 && (
              <div className="neuron-pin-row"><span>Trail</span><span title={pin.trail.join(" · ")}>{pin.trail.map((a) => shortAccount(a, 10)).join(" · ")}</span></div>
            )}
          </div>
          {pin.recent.length > 0 && (
            <div className="neuron-pin-recent">
              <div className="neuron-pin-recent-title">Recent hits</div>
              {pin.recent.map((r, i) => (
                <div key={i} className={`neuron-pin-hit${r.failed ? " fail" : ""}`}>
                  <span>{r.live ? "⚡" : "~"} {r.when}</span>
                  <span>
                    {r.account ? shortAccount(r.account, 14) : "—"}
                    {r.latency ? ` · ${r.latency}` : ""}
                    {r.failed ? " · fail" : ""}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
