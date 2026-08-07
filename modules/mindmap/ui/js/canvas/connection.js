// ── js/canvas/connection.js ──────────────────────────────────
import { state, ui, $svg, $cv, $el, COLORS, pushUndo, refs } from '../state.js';
import { updateMinimap } from '../ui/minimap.js';
import { toCanvas } from './transform.js';

// Module-level waypoint drag state
let _wpDrag = null; // { conn, idx, startX, startY }

function _setupWpDragListeners() {
  if (_setupWpDragListeners._done) return;
  _setupWpDragListeners._done = true;
  window.addEventListener('mousemove', e => {
    if (!_wpDrag) return;
    const p = toCanvas(e.clientX, e.clientY);
    _wpDrag.conn.waypoints[_wpDrag.idx] = { x: p.x, y: p.y };
    renderLines();
  });
  window.addEventListener('mouseup', e => {
    if (!_wpDrag) return;
    _wpDrag = null;
    refs.dirty = true;
  });
}

// ── Level BFS ────────────────────────────────────────────────
export function getLevels() {
  const inDeg = {};
  for (const id in state.nodes) inDeg[id] = 0;
  for (const c of state.connections) inDeg[c.to] = (inDeg[c.to] ?? 0) + 1;
  const lvl = {}, q = [];
  for (const id in state.nodes) {
    if (!inDeg[id]) { lvl[id] = 0; q.push(id); }
  }
  while (q.length) {
    const id = q.shift();
    for (const ch of (state.nodes[id]?.children ?? [])) {
      if (!(ch in lvl)) { lvl[ch] = lvl[id] + 1; q.push(ch); }
    }
  }
  for (const id in state.nodes) if (!(id in lvl)) lvl[id] = 0;
  return lvl;
}

// Shapes that use clip-path — box-shadow is clipped, skip it
const CLIP_PATH_SHAPES = new Set([
  'shape-hexagon','shape-triangle','shape-parallelogram',
  'shape-trapezoid','shape-pentagon','shape-chevron','shape-star',
]);

export function syncColors() {
  const lvls = getLevels();
  for (const id in state.nodes) {
    const e = $el(id);
    if (!e) continue;
    const n = state.nodes[id];
    const isDiamond    = e.classList.contains('shape-diamond');
    const isClipShape  = [...e.classList].some(c => CLIP_PATH_SHAPES.has(c));
    const c = n.customColor
      ? { bg: n.customColor, glow: `${n.customColor}2e` }
      : COLORS[Math.min(lvls[id] ?? 0, COLORS.length - 1)];

    e.style.setProperty('--node-tone', c.bg);
    e.style.setProperty('--node-tone-glow', c.glow);
    if (!isDiamond) {
      e.style.removeProperty('background');
      e.style.removeProperty('box-shadow');
      if (isClipShape) e.style.boxShadow = '';
    }
  }
}

function nodeCenter(id) {
  const n = state.nodes[id], e = $el(id);
  if (!n) return { x: 0, y: 0 };
  const w = (n.width  ?? (e ? e.offsetWidth  : 80));
  return {
    x: n.x + w / 2,
    y: n.y + (e ? e.offsetHeight : 40) / 2,
  };
}

function _nodeBox(id) {
  const node = state.nodes[id];
  const element = $el(id);
  if (!node) return null;
  const width = node.width ?? element?.offsetWidth ?? 80;
  const height = element?.offsetHeight ?? (node.shape === 'diamond' ? width : 56);
  return {
    left: node.x,
    top: node.y,
    right: node.x + width,
    bottom: node.y + height,
    width,
    height,
    cx: node.x + width / 2,
    cy: node.y + height / 2,
    shape: node.shape || 'rect',
  };
}

function _verticalPort(box, targetX, edge) {
  const delta = targetX - box.cx;
  const offset = Math.abs(delta) < 20 ? 0 : Math.sign(delta) * Math.min(box.width * .24, 32);
  const x = box.cx + offset;
  if (box.shape === 'diamond') {
    const inset = Math.abs(offset) * box.height / box.width;
    return { x, y: edge === 'bottom' ? box.bottom - inset : box.top + inset };
  }
  if (box.shape === 'oval') {
    const ratio = Math.min(1, Math.abs(offset) / (box.width / 2));
    const yOffset = box.height / 2 * Math.sqrt(1 - ratio * ratio);
    return { x, y: edge === 'bottom' ? box.cy + yOffset : box.cy - yOffset };
  }
  return { x, y: edge === 'bottom' ? box.bottom : box.top };
}

function _horizontalPort(box, targetY, edge) {
  const delta = targetY - box.cy;
  const offset = Math.abs(delta) < 20 ? 0 : Math.sign(delta) * Math.min(box.height * .24, 28);
  const y = box.cy + offset;
  if (box.shape === 'diamond') {
    const inset = Math.abs(offset) * box.width / box.height;
    return { x: edge === 'right' ? box.right - inset : box.left + inset, y };
  }
  if (box.shape === 'oval') {
    const ratio = Math.min(1, Math.abs(offset) / (box.height / 2));
    const xOffset = box.width / 2 * Math.sqrt(1 - ratio * ratio);
    return { x: edge === 'right' ? box.cx + xOffset : box.cx - xOffset, y };
  }
  return { x: edge === 'right' ? box.right : box.left, y };
}

function _roundedPolyline(points, radius = 14) {
  if (points.length < 2) return '';
  const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
  const toward = (from, to, amount) => {
    const length = distance(from, to);
    if (!length) return { ...from };
    return {
      x: from.x + (to.x - from.x) * amount / length,
      y: from.y + (to.y - from.y) * amount / length,
    };
  };
  let path = `M${points[0].x},${points[0].y}`;
  for (let index = 1; index < points.length - 1; index++) {
    const previous = points[index - 1];
    const corner = points[index];
    const next = points[index + 1];
    const cornerRadius = Math.min(radius, distance(corner, previous) / 2, distance(corner, next) / 2);
    const entry = toward(corner, previous, cornerRadius);
    const exit = toward(corner, next, cornerRadius);
    path += ` L${entry.x},${entry.y} Q${corner.x},${corner.y} ${exit.x},${exit.y}`;
  }
  const last = points[points.length - 1];
  return `${path} L${last.x},${last.y}`;
}

function _orthogonalRoute(conn) {
  const from = _nodeBox(conn.from);
  const to = _nodeBox(conn.to);
  if (!from || !to) return null;
  const horizontal = conn.direction === 'LR' || conn.direction === 'RL';
  const reverse = conn.direction === 'BT' || conn.direction === 'RL';
  let points;

  if (conn.routeType === 'back') {
    const boxes = Object.keys(state.nodes).map(_nodeBox).filter(Boolean);
    const laneOffset = 68 + (conn.routeLane || 0) * 28;
    if (horizontal) {
      const centerY = boxes.reduce((sum, box) => sum + box.cy, 0) / boxes.length;
      const useTop = (from.cy + to.cy) / 2 <= centerY;
      const laneY = useTop
        ? Math.min(...boxes.map(box => box.top)) - laneOffset
        : Math.max(...boxes.map(box => box.bottom)) + laneOffset;
      const start = _horizontalPort(from, to.cy, useTop ? 'left' : 'right');
      const end = _horizontalPort(to, from.cy, useTop ? 'left' : 'right');
      points = [start, { x: start.x + (reverse ? -28 : 28), y: start.y }, { x: start.x + (reverse ? -28 : 28), y: laneY }, { x: end.x + (reverse ? 28 : -28), y: laneY }, { x: end.x + (reverse ? 28 : -28), y: end.y }, end];
    } else {
      const centerX = boxes.reduce((sum, box) => sum + box.cx, 0) / boxes.length;
      const useLeft = (from.cx + to.cx) / 2 <= centerX;
      const laneX = useLeft
        ? Math.min(...boxes.map(box => box.left)) - laneOffset
        : Math.max(...boxes.map(box => box.right)) + laneOffset;
      const start = _horizontalPort(from, to.cy, useLeft ? 'left' : 'right');
      const end = _horizontalPort(to, from.cy, useLeft ? 'left' : 'right');
      points = [start, { x: start.x, y: start.y + (reverse ? -28 : 28) }, { x: laneX, y: start.y + (reverse ? -28 : 28) }, { x: laneX, y: end.y + (reverse ? 28 : -28) }, { x: end.x, y: end.y + (reverse ? 28 : -28) }, end];
    }
  } else if (horizontal) {
    const start = _horizontalPort(from, to.cy, reverse ? 'left' : 'right');
    const end = _horizontalPort(to, from.cy, reverse ? 'right' : 'left');
    const middleX = (start.x + end.x) / 2;
    points = [start, { x: middleX, y: start.y }, { x: middleX, y: end.y }, end];
  } else {
    const start = _verticalPort(from, to.cx, reverse ? 'top' : 'bottom');
    const end = _verticalPort(to, from.cx, reverse ? 'bottom' : 'top');
    const middleY = (start.y + end.y) / 2;
    points = [start, { x: start.x, y: middleY }, { x: end.x, y: middleY }, end];
  }

  const longestSegment = points.slice(1).reduce((best, point, index) => {
    const previous = points[index];
    const length = Math.hypot(point.x - previous.x, point.y - previous.y);
    return length > best.length ? { length, from: previous, to: point } : best;
  }, { length: 0, from: points[0], to: points[1] });
  return {
    d: _roundedPolyline(points),
    label: {
      x: (longestSegment.from.x + longestSegment.to.x) / 2,
      y: (longestSegment.from.y + longestSegment.to.y) / 2,
    },
  };
}

// For a diamond node, compute where a line from the node's center
// toward (tx, ty) exits the diamond boundary.
// Diamond boundary: |X|/h + |Y|/h = 1  where h = half-size (65px for 130px node)
function diamondEdgePoint(id, tx, ty) {
  const n = state.nodes[id], e = $el(id);
  if (!n || !e) return null;
  const h  = (n.width ?? 130) / 2;          // half-width = half-height (square)
  const cx = n.x + h;
  const cy = n.y + (e.offsetHeight ?? 130) / 2;
  const dx = tx - cx, dy = ty - cy;
  const dist = Math.abs(dx) + Math.abs(dy); // L1 norm (diamond metric)
  if (dist < 0.01) return { x: cx, y: cy - h }; // degenerate → top tip
  return { x: cx + h * dx / dist, y: cy + h * dy / dist };
}

export function makePath(x1, y1, x2, y2, stroke, sw, op, style = 'curved') {
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  let d;
  if (style === 'straight' || style === 'arrow' || style === 'bidirectional') {
    d = `M${x1},${y1} L${x2},${y2}`;
  } else {
    const dx = Math.abs(x2 - x1) * 0.5;
    d = `M${x1},${y1} C${x1+dx},${y1} ${x2-dx},${y2} ${x2},${y2}`;
  }
  p.setAttribute('d', d);
  p.setAttribute('stroke', stroke);
  p.setAttribute('stroke-width', sw);
  p.setAttribute('stroke-opacity', op);
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke-linecap', 'round');
  if (style === 'dashed') p.setAttribute('stroke-dasharray', '8 5');
  // Arrow markers
  if (style === 'arrow') {
    p.setAttribute('marker-end', 'url(#wcf-arrow)');
  }
  if (style === 'bidirectional') {
    p.setAttribute('marker-end', 'url(#wcf-arrow)');
    p.setAttribute('marker-start', 'url(#wcf-arrow-rev)');
  }
  return p;
}

// ── Obstacle-aware routing helpers ──────────────────────────────

/**
 * Liang-Barsky line-segment vs AABB intersection test.
 * Returns true if segment ax,ay→bx,by intersects rectangle [rx0,ry0]–[rx1,ry1].
 */
function _segHitsRect(ax, ay, bx, by, rx0, ry0, rx1, ry1) {
  const dx = bx - ax, dy = by - ay;
  let t0 = 0, t1 = 1;
  const clip = (p, q) => {
    if (Math.abs(p) < 1e-9) return q >= 0;
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else        { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  };
  return clip(-dx, ax - rx0) && clip(dx, rx1 - ax) &&
         clip(-dy, ay - ry0) && clip(dy, ry1 - ay);
}

/**
 * Find the node (not fromId/toId) whose bounding box blocks segment ax,ay→bx,by.
 * Returns the one closest to the midpoint of the segment, or null.
 */
function _findBlocker(ax, ay, bx, by, fromId, toId) {
  const PAD = 14;
  let best = null, bestDist = Infinity;
  const midX = (ax + bx) / 2, midY = (ay + by) / 2;
  for (const id in state.nodes) {
    if (id === fromId || id === toId) continue;
    const n  = state.nodes[id];
    const el = $el(id);
    if (!el) continue;
    const w = n.width ?? el.offsetWidth;
    const h = el.offsetHeight;
    if (h <= 0) continue;
    if (_segHitsRect(ax, ay, bx, by,
        n.x - PAD, n.y - PAD, n.x + w + PAD, n.y + h + PAD)) {
      const d = Math.hypot(n.x + w / 2 - midX, n.y + h / 2 - midY);
      if (d < bestDist) {
        bestDist = d;
        best = { cx: n.x + w / 2, cy: n.y + h / 2, w, h };
      }
    }
  }
  return best;
}

/**
 * Build a smooth obstacle-avoidance path around `blocker`.
 *
 * Strategy: try four L-routes (above/below/left/right of the blocker).
 * Each route uses two axis-aligned waypoints so no sub-segment crosses
 * the blocker. Sub-segments are validated; only fully-clear routes are
 * considered. Corners are rounded with quadratic-bezier arcs.
 */
function _avoidPath(ax, ay, bx, by, blocker) {
  if (Math.hypot(bx - ax, by - ay) < 1) return `M${ax},${ay} L${bx},${by}`;

  const PAD = 48;
  const bL = blocker.cx - blocker.w / 2 - PAD;
  const bR = blocker.cx + blocker.w / 2 + PAD;
  const bT = blocker.cy - blocker.h / 2 - PAD;
  const bB = blocker.cy + blocker.h / 2 + PAD;

  const D   = (x1,y1,x2,y2) => Math.hypot(x2-x1, y2-y1);
  // Segment clear check against the actual (unpadded) blocker rect
  const clr = (x1,y1,x2,y2) => !_segHitsRect(x1,y1,x2,y2,
    blocker.cx - blocker.w / 2 - 2, blocker.cy - blocker.h / 2 - 2,
    blocker.cx + blocker.w / 2 + 2, blocker.cy + blocker.h / 2 + 2);

  const all = [
    { w1:[ax, bT], w2:[bx, bT] }, // above
    { w1:[ax, bB], w2:[bx, bB] }, // below
    { w1:[bL, ay], w2:[bL, by] }, // left
    { w1:[bR, ay], w2:[bR, by] }, // right
  ].map(r => {
    const [x1,y1] = r.w1, [x2,y2] = r.w2;
    return {
      ...r,
      c:  D(ax,ay,x1,y1) + D(x1,y1,x2,y2) + D(x2,y2,bx,by),
      ok: clr(ax,ay,x1,y1) && clr(x1,y1,x2,y2) && clr(x2,y2,bx,by),
    };
  });

  // Prefer fully-clear routes; fall back to lowest-cost if none
  const pool = (all.some(r => r.ok) ? all.filter(r => r.ok) : all)
    .sort((a, b) => a.c - b.c);

  const [wx1, wy1] = pool[0].w1;
  const [wx2, wy2] = pool[0].w2;

  const s0 = D(ax,ay,wx1,wy1);
  const s1 = D(wx1,wy1,wx2,wy2);
  const s2 = D(wx2,wy2,bx,by);

  // Degenerate: waypoints are the same → single smooth arc
  if (s1 < 2) {
    if (s0 < 2 || s2 < 2) return `M${ax},${ay} L${bx},${by}`;
    const R2 = Math.min(40, s0 * 0.45, s2 * 0.45);
    const lx = ax + (wx1-ax) * (1 - R2/s0), ly = ay + (wy1-ay) * (1 - R2/s0);
    const rx = wx2 + (bx-wx2) * (R2/s2),    ry = wy2 + (by-wy2) * (R2/s2);
    return `M${ax},${ay} L${lx},${ly} Q${wx1},${wy1} ${rx},${ry} L${bx},${by}`;
  }

  // Corner radius: capped at 45 % of the shortest adjacent segment
  const R  = Math.min(42, s0 * 0.45, s1 * 0.45, s2 * 0.45);
  const Lp = (x1,y1,x2,y2,t) => [x1+(x2-x1)*t, y1+(y2-y1)*t];

  const [e0x,e0y] = Lp(ax,ay,   wx1,wy1, 1-R/s0);  // end of first straight
  const [s1x,s1y] = Lp(wx1,wy1, wx2,wy2, R/s1);    // start of middle straight
  const [e1x,e1y] = Lp(wx1,wy1, wx2,wy2, 1-R/s1);  // end of middle straight
  const [s2x,s2y] = Lp(wx2,wy2, bx,by,   R/s2);    // start of last straight

  // Straight segments with quadratic-bezier rounded corners at W1 and W2
  return (
    `M${ax},${ay} ` +
    `L${e0x},${e0y} ` +
    `Q${wx1},${wy1} ${s1x},${s1y} ` +
    `L${e1x},${e1y} ` +
    `Q${wx2},${wy2} ${s2x},${s2y} ` +
    `L${bx},${by}`
  );
}

// ── Collapse helper: kumpulkan semua descendant dari nodeId (BFS) ──
function _collectDescendants(rootId, visited) {
  for (const conn of state.connections) {
    if (conn.from === rootId && !visited.has(conn.to)) {
      visited.add(conn.to);
      _collectDescendants(conn.to, visited);
    }
  }
}

// ── Group badge renderer ──────────────────────────────────────
// Shows a small colored dot on each grouped node (behavioral group,
// no visual container — moving one member moves all members).
function _syncGroupBadges() {
  // Remove stale badges first
  document.querySelectorAll('.node-group-badge').forEach(b => b.remove());
  if (!state.groups || !Object.keys(state.groups).length) return;

  for (const id in state.nodes) {
    const n = state.nodes[id];
    if (!n.groupId || !state.groups[n.groupId]) continue;
    const el = $el(id);
    if (!el) continue;
    const col = state.groups[n.groupId].color ?? { stroke: '#a78bfa' };
    const badge = document.createElement('div');
    badge.className = 'node-group-badge';
    badge.style.cssText =
      'position:absolute;top:-5px;right:-5px;width:11px;height:11px;' +
      'border-radius:50%;background:' + col.stroke + ';' +
      'border:2px solid rgba(0,0,0,.45);pointer-events:none;z-index:10;' +
      'box-shadow:0 0 5px ' + col.stroke + '99;';
    el.appendChild(badge);
  }
}

// ── External collapse buttons (di canvas-view, bukan di dalam node) ──
// Pendekatan ini menghindari masalah overflow:hidden dan z-index dari node element.
function _syncCollapseButtons(hidden) {
  const cv = $cv;
  if (!cv) return;
  // Hapus tombol lama
  cv.querySelectorAll('.node-collapse-btn').forEach(b => b.remove());

  for (const id in state.nodes) {
    const n  = state.nodes[id];
    const el = $el(id);
    if (!el || el.style.display === 'none') continue;           // node tersembunyi → skip
    if (!state.connections.some(c => c.from === id)) continue; // tidak punya anak → skip

    const w = n.width ?? el.offsetWidth;
    const h = el.offsetHeight;
    if (!h) continue;

    // Hitung jumlah descendant node
    const descSet = new Set();
    _collectDescendants(id, descSet);
    const descCount = descSet.size;

    const btn = document.createElement('button');
    btn.className = 'node-collapse-btn';
    btn.dataset.nodeId = id;
    btn.textContent = n.collapsed ? `▸ ${descCount}` : '▾';
    btn.title = n.collapsed
      ? `Expand ${descCount} node tersembunyi`
      : `Collapse subtree (${descCount} node)`;
    if (n.collapsed) btn.classList.add('is-collapsed');

    // Posisi: tengah-bawah node (koordinat canvas)
    btn.style.cssText =
      `position:absolute;` +
      `left:${n.x + w / 2}px;` +
      `top:${n.y + h}px;` +
      `transform:translateX(-50%);` +
      `z-index:20;`;

    btn.addEventListener('mousedown', e => { e.stopPropagation(); e.preventDefault(); });
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const nd = state.nodes[id];
      if (!nd) return;
      nd.collapsed = !nd.collapsed;
      refs.dirty = true;
      renderLines();
    });

    cv.appendChild(btn);
  }
}

// Ensure arrow markers exist in SVG
function ensureArrow() {
  if (document.getElementById('wcf-arrow-def')) return;
  const defs = document.createElementNS('http://www.w3.org/2000/svg','defs');
  defs.id = 'wcf-arrow-def';
  defs.innerHTML = `
    <marker id="wcf-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="rgba(255,255,255,0.6)"/>
    </marker>
    <marker id="wcf-arrow-rev" markerWidth="8" markerHeight="8" refX="2" refY="3" orient="auto">
      <path d="M8,0 L8,6 L0,3 z" fill="rgba(255,255,255,0.6)"/>
    </marker>`;
  $svg.prepend(defs);
}

export function renderLines() {
  while ($svg.lastChild) $svg.removeChild($svg.lastChild);
  ensureArrow();
  _syncGroupBadges(); // Colored dot badges on grouped nodes
  const lvls = getLevels();

  // ── Collapse/expand: hitung node yang tersembunyi ──────────
  const hidden = new Set();
  for (const id in state.nodes) {
    if (state.nodes[id].collapsed) _collectDescendants(id, hidden);
  }
  // Sembunyikan/tampilkan node DOM element
  for (const id in state.nodes) {
    const el = $el(id);
    if (el) el.style.display = hidden.has(id) ? 'none' : '';
  }
  // Render external collapse buttons (langsung di canvas-view, bukan di dalam node)
  _syncCollapseButtons(hidden);

  for (const conn of state.connections) {
    if (!state.nodes[conn.from] || !state.nodes[conn.to]) continue;
    // Skip koneksi yang melibatkan node tersembunyi
    if (hidden.has(conn.from) || hidden.has(conn.to)) continue;

    // Get centers for direction calculation
    const fc = nodeCenter(conn.from);
    const tc = nodeCenter(conn.to);

    // For diamond nodes use the exact boundary intersection point
    const fromDiamond = $el(conn.from)?.classList.contains('shape-diamond');
    const toDiamond   = $el(conn.to)?.classList.contains('shape-diamond');
    const f = fromDiamond ? (diamondEdgePoint(conn.from, tc.x, tc.y) ?? fc) : fc;
    const t = toDiamond   ? (diamondEdgePoint(conn.to,   fc.x, fc.y) ?? tc) : tc;

    const col = conn.color || COLORS[Math.min(lvls[conn.from] ?? 0, COLORS.length - 1)].bg;
    const sty = conn.style || 'curved';
    const path = makePath(f.x, f.y, t.x, t.y, col, 2.5, 0.65, sty);
    const orthogonalRoute = conn.routing === 'orthogonal' ? _orthogonalRoute(conn) : null;
    if (orthogonalRoute) path.setAttribute('d', orthogonalRoute.d);
    // Obstacle-aware routing: arc around any node blocking the direct path (all styles)
    if (!orthogonalRoute) {
      const blocker = _findBlocker(f.x, f.y, t.x, t.y, conn.from, conn.to);
      if (blocker) path.setAttribute('d', _avoidPath(f.x, f.y, t.x, t.y, blocker));
    }
    // Waypoints: if conn has waypoints, override the path d attribute
    if (conn.waypoints?.length) {
      const pts = [{ x: f.x, y: f.y }, ...conn.waypoints, { x: t.x, y: t.y }];
      let d = `M${pts[0].x},${pts[0].y}`;
      // Catmull-Rom-ish smoothing via bezier through waypoints
      for (let i = 1; i < pts.length; i++) {
        const prev = pts[i - 1], cur = pts[i];
        const cpx = (prev.x + cur.x) / 2;
        d += ` C${cpx},${prev.y} ${cpx},${cur.y} ${cur.x},${cur.y}`;
      }
      path.setAttribute('d', d);
    }

    path.style.pointerEvents = 'stroke';
    path.style.cursor = 'pointer';
    path.dataset.from = conn.from;
    path.dataset.to   = conn.to;
    // right-click on line → connection ctx menu
    path.addEventListener('contextmenu', e => {
      e.preventDefault(); e.stopPropagation();
      ui.connCtx = { from: conn.from, to: conn.to };
      showConnCtx(e.clientX, e.clientY, conn);
    });
    // dblclick on line → edit label
    path.addEventListener('dblclick', e => {
      e.stopPropagation();
      editConnLabel(conn, f, t);
    });
    // click on path → add waypoint
    path.addEventListener('click', e => {
      if (e.shiftKey) {
        e.stopPropagation();
        pushUndo();
        const p = toCanvas(e.clientX, e.clientY);
        if (!conn.waypoints) conn.waypoints = [];
        // Insert at position closest to click
        const pts = [{ x: f.x, y: f.y }, ...conn.waypoints, { x: t.x, y: t.y }];
        let bestSeg = 0, bestDist = Infinity;
        for (let i = 0; i < pts.length - 1; i++) {
          const mx = (pts[i].x + pts[i+1].x)/2, my = (pts[i].y + pts[i+1].y)/2;
          const d = Math.hypot(p.x - mx, p.y - my);
          if (d < bestDist) { bestDist = d; bestSeg = i; }
        }
        conn.waypoints.splice(bestSeg, 0, { x: p.x, y: p.y });
        refs.dirty = true;
        renderLines();
      }
    });
    $svg.appendChild(path);

    // Waypoint handles (draggable circles)
    if (conn.waypoints?.length) {
      _setupWpDragListeners();
      conn.waypoints.forEach((wp, idx) => {
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', wp.x);
        circle.setAttribute('cy', wp.y);
        circle.setAttribute('r', 5);
        circle.setAttribute('fill', col);
        circle.setAttribute('fill-opacity', '0.85');
        circle.setAttribute('stroke', '#fff');
        circle.setAttribute('stroke-width', '1.5');
        circle.setAttribute('stroke-opacity', '0.6');
        circle.style.cursor = 'move';
        circle.addEventListener('mousedown', e => {
          e.stopPropagation(); e.preventDefault();
          pushUndo();
          _wpDrag = { conn, idx };
        });
        // Right-click waypoint → delete it
        circle.addEventListener('contextmenu', e => {
          e.preventDefault(); e.stopPropagation();
          pushUndo();
          conn.waypoints.splice(idx, 1);
          if (!conn.waypoints.length) delete conn.waypoints;
          refs.dirty = true;
          renderLines();
        });
        $svg.appendChild(circle);
      });
    }

    // Draw label if set
    if (conn.label) {
      const mx = orthogonalRoute?.label.x ?? (f.x + t.x) / 2;
      const my = orthogonalRoute?.label.y ?? (f.y + t.y) / 2;
      const fo = document.createElementNS('http://www.w3.org/2000/svg','foreignObject');
      fo.setAttribute('x', mx - 40); fo.setAttribute('y', my - 11);
      fo.setAttribute('width', 80); fo.setAttribute('height', 22);
      const span = document.createElement('span');
      span.textContent = conn.label;
      span.className = 'wcf-conn-label';
      fo.appendChild(span);
      $svg.appendChild(fo);
    }
  }

  // Preview line while connecting — glowing accent with marching ants
  if (ui.connecting) {
    const f = nodeCenter(ui.connecting.fromId);
    const preview = makePath(f.x, f.y, ui.connecting.curX, ui.connecting.curY, 'transparent', 2.5, 1, 'dashed');
    preview.style.stroke       = 'var(--accent, #8b7cf8)';
    preview.style.strokeOpacity = '0.85';
    preview.style.filter       = 'drop-shadow(0 0 5px var(--accent-glow, rgba(139,124,248,0.5)))';
    preview.style.animation    = 'conn-march 0.4s linear infinite';
    $svg.appendChild(preview);
  }

  updateMinimap();
  // Update empty canvas hint
  if (typeof window.wcfUpdateEmptyState === 'function') window.wcfUpdateEmptyState();
}

export function addConnection(fromId, toId) {
  if (fromId === toId) return;
  if (state.connections.some(c => c.from===fromId&&c.to===toId)) return;
  if (state.connections.some(c => c.from===toId  &&c.to===fromId)) return;
  pushUndo();
  state.connections.push({ from: fromId, to: toId, style: 'curved', label: '' });
  const fn = state.nodes[fromId];
  if (fn) {
    const children = fn.children || (fn.children = []);
    if (!children.includes(toId)) children.push(toId);
  }
  syncColors();
  renderLines();
}

export function deleteConnection(from, to) {
  pushUndo();
  state.connections = state.connections.filter(c => !(c.from===from&&c.to===to));
  if (state.nodes[from]) {
    state.nodes[from].children = (state.nodes[from].children || []).filter(id => id !== to);
  }
  syncColors();
  renderLines();
}

// ── Connection context menu ──────────────────────────────────
export function showConnCtx(x, y, conn) {
  const menu = document.getElementById('conn-ctx');
  if (!menu) return;
  menu.style.left = Math.min(x, innerWidth  - 200) + 'px';
  menu.style.top  = Math.min(y, innerHeight - 240) + 'px';
  menu.classList.remove('hidden');
  // Sync color picker
  const cp = document.getElementById('conn-ctx-color-pick');
  if (cp && conn.color) cp.value = conn.color;

  // populate style options
  const styles = ['curved','straight','dashed','arrow','bidirectional'];
  const styleEl = document.getElementById('conn-ctx-style');
  if (styleEl) {
    styleEl.innerHTML = styles.map(s =>
      `<div data-style="${s}" class="flex items-center gap-2 px-3 py-1.5 rounded-lg text-[12px] cursor-pointer ${conn.style===s?'text-purple-400':'text-white/60 hover:bg-white/[0.07] hover:text-white/90'} transition-colors">
        ${s==='curved'?'〜 Melengkung':s==='straight'?'── Lurus':s==='dashed'?'- - Putus-putus':s==='arrow'?'→ Panah':'↔ Dua Arah'}
      </div>`
    ).join('');
    styleEl.querySelectorAll('[data-style]').forEach(el => {
      el.addEventListener('click', () => {
        conn.style = el.dataset.style;
        refs.dirty = true;
        renderLines();
        hideConnCtx();
      });
    });
  }
}

export function hideConnCtx() {
  const menu = document.getElementById('conn-ctx');
  if (menu) menu.classList.add('hidden');
  ui.connCtx = null;
}

// ── Inline edit connection label ─────────────────────────────
export async function editConnLabel(conn, f, t) {
  const mx = (f.x + t.x)/2 * state.zoom + state.pan.x;
  const my = (f.y + t.y)/2 * state.zoom + state.pan.y;
  const rect = $svg.parentElement?.getBoundingClientRect() ?? { left:0, top:0 };
  const inp = document.createElement('input');
  inp.value = conn.label || '';
  inp.placeholder = 'Label koneksi...';
  inp.style.cssText = `position:fixed;left:${rect.left+mx-60}px;top:${rect.top+my-12}px;
    width:120px;background:#1a1a2e;border:1px solid rgba(167,139,250,0.5);
    border-radius:6px;padding:2px 8px;color:#e2e8f0;font-size:11px;z-index:2000;outline:none;`;
  document.body.appendChild(inp);
  inp.focus(); inp.select();
  const finish = () => {
    conn.label = inp.value.trim();
    refs.dirty  = true;
    inp.remove();
    renderLines();
  };
  inp.addEventListener('blur', finish);
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); inp.blur(); }
  });
}

// ── By-ID wrapper for ctx-menu ────────────────────────────────
export function editConnLabelById(fromId, toId) {
  const conn = state.connections.find(c => c.from === fromId && c.to === toId);
  if (!conn) return;
  const f = nodeCenter(fromId), t = nodeCenter(toId);
  editConnLabel(conn, f, t);
}
