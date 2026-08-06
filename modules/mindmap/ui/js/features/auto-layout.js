// ── js/features/auto-layout.js — Auto-arrange nodes ─────────
// Strategi:
//   1. Deteksi struktur tree dari koneksi (root = node tanpa parent)
//   2. Layout tree hierarkis: root di kiri, children ke kanan
//   3. Node yang tidak terhubung: susun grid di bawah tree
// Dipanggil dari toolbar: applyAutoLayout()

import { state, pushUndo, $el } from '../state.js';
import { renderLines }          from '../canvas/connection.js';
import { fitToNodes }           from '../canvas/transform.js';

const NODE_W   = 160;   // lebar node estimasi
const NODE_H   = 56;    // tinggi node estimasi
const H_GAP    = 80;    // horizontal gap antar level
const V_GAP    = 24;    // vertical gap antar sibling
const GRID_GAP = 40;    // gap untuk node isolat

/** Hitung posisi tiap node dalam tree secara rekursif */
function calcTreeLayout(nodeId, adjMap, visited, level, yOffset) {
  if (visited.has(nodeId)) return { height: 0, positions: [] };
  visited.add(nodeId);

  const children = adjMap.get(nodeId) || [];
  const unvisitedChildren = children.filter(c => !visited.has(c));

  if (!unvisitedChildren.length) {
    // Leaf node
    return {
      height: NODE_H,
      positions: [{ id: nodeId, x: level * (NODE_W + H_GAP), y: yOffset }],
    };
  }

  const positions = [];
  let childY = yOffset;
  let totalH  = 0;

  for (const child of unvisitedChildren) {
    const sub = calcTreeLayout(child, adjMap, visited, level + 1, childY);
    positions.push(...sub.positions);
    childY += sub.height + V_GAP;
    totalH += sub.height + V_GAP;
  }
  totalH = Math.max(totalH - V_GAP, NODE_H);

  // Root node: posisi Y di tengah children
  const rootY = yOffset + totalH / 2 - NODE_H / 2;
  positions.push({ id: nodeId, x: level * (NODE_W + H_GAP), y: rootY });

  return { height: totalH, positions };
}

/** Terapkan posisi ke DOM dan state */
function applyPositions(positions) {
  for (const { id, x, y } of positions) {
    const n = state.nodes[id];
    if (!n) continue;
    n.x = Math.round(x);
    n.y = Math.round(y);
    const el = $el(id);
    if (el) { el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; }
  }
}

/**
 * Jalankan auto-layout.
 * @param {boolean} [fitAfter=true] — apakah zoom-to-fit setelah layout
 */
export function applyAutoLayout(fitAfter = true) {
  const nodes = state.nodes;
  const conns = state.connections;
  if (!Object.keys(nodes).length) return;

  pushUndo();

  // Bangun adjacency map (berarah: from → to) dan set semua target
  const adjMap  = new Map();   // nodeId → [children]
  const hasParent = new Set(); // node yang punya induk (in-edge)

  for (const id in nodes) adjMap.set(id, []);

  for (const c of conns) {
    if (nodes[c.from] && nodes[c.to]) {
      adjMap.get(c.from).push(c.to);
      hasParent.add(c.to);
    }
  }

  // Root = node yang tidak punya parent dalam koneksi
  const roots = Object.keys(nodes).filter(id => !hasParent.has(id));

  const visited   = new Set();
  const allPos    = [];
  let   currentY  = 0;

  // Layout tiap root tree
  for (const root of roots) {
    if (visited.has(root)) continue;
    const { height, positions } = calcTreeLayout(root, adjMap, visited, 0, currentY);
    allPos.push(...positions);
    currentY += height + V_GAP * 3;
  }

  // Isolat (belum ter-visit, bisa ada jika ada siklus tak terjangkau)
  const isolats = Object.keys(nodes).filter(id => !visited.has(id));
  const gridCols = Math.ceil(Math.sqrt(isolats.length)) || 1;
  isolats.forEach((id, i) => {
    const col = i % gridCols;
    const row = Math.floor(i / gridCols);
    allPos.push({
      id,
      x: col * (NODE_W + GRID_GAP),
      y: currentY + row * (NODE_H + GRID_GAP),
    });
  });

  applyPositions(allPos);
  renderLines();

  if (fitAfter) {
    requestAnimationFrame(() => fitToNodes());
  }
}
