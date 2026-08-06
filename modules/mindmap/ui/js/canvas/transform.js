// ── js/canvas/transform.js ───────────────────────────────────
import { state, $c, $cv, $zlb, $el } from '../state.js';

export function toCanvas(cx, cy) {
  const r = $c.getBoundingClientRect();
  return {
    x: (cx - r.left - state.pan.x) / state.zoom,
    y: (cy - r.top  - state.pan.y) / state.zoom,
  };
}

export function applyTransform() {
  $cv.style.transform = `translate(${state.pan.x}px,${state.pan.y}px) scale(${state.zoom})`;
  if ($zlb) $zlb.textContent = Math.round(state.zoom * 100) + '%';
  document.dispatchEvent(new CustomEvent('wcf:canvas-transform'));
}

/** Pan canvas agar node id muncul di tengah viewport (tanpa ubah zoom) */
export function panToNode(id) {
  const n  = state.nodes[id];
  const el = $el(id);
  if (!n || !el) return;
  const w  = el.offsetWidth  || (n.width ?? 140);
  const h  = el.offsetHeight || 56;
  const cx = n.x + w / 2;
  const cy = n.y + h / 2;
  const cw = $c.offsetWidth  || window.innerWidth;
  const ch = $c.offsetHeight || window.innerHeight;
  // Smooth pan dengan CSS transition sementara
  $cv.style.transition = 'transform 0.25s cubic-bezier(0.4,0,0.2,1)';
  state.pan.x = cw / 2 - cx * state.zoom;
  state.pan.y = ch / 2 - cy * state.zoom;
  applyTransform();
  setTimeout(() => { $cv.style.transition = ''; }, 260);
}

/** Zoom to fit semua node di viewport dengan padding */
export function fitToNodes(padding = 60) {
  const nodeIds = Object.keys(state.nodes);
  if (!nodeIds.length) return;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const id of nodeIds) {
    const n  = state.nodes[id];
    const el = $el(id);
    const w  = el ? el.offsetWidth  : (n.width ?? 140);
    const h  = el ? el.offsetHeight : 56;
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + w);
    maxY = Math.max(maxY, n.y + h);
  }

  const cw = $c.offsetWidth  || window.innerWidth;
  const ch = $c.offsetHeight || window.innerHeight;
  const contentW = maxX - minX;
  const contentH = maxY - minY;
  const scaleX = (cw - padding * 2) / (contentW  || 1);
  const scaleY = (ch - padding * 2) / (contentH || 1);
  state.zoom  = Math.min(Math.min(scaleX, scaleY), 1.5);
  state.pan.x = padding - minX * state.zoom + (cw - padding * 2 - contentW * state.zoom) / 2;
  state.pan.y = padding - minY * state.zoom + (ch - padding * 2 - contentH * state.zoom) / 2;
  applyTransform();
}
