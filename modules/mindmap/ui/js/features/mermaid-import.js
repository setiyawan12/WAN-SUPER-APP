// ── js/features/mermaid-import.js ────────────────────────────
// Parse Mermaid flowchart/graph syntax → WCF node+connection format
'use strict';

import { state, refs, pushUndo } from '../state.js';
import { applyData }             from '../canvas/node.js';
import { fitToNodes }            from '../canvas/transform.js';

// ── Node token parser ─────────────────────────────────────────
// Extracts { id, label, shape } from a Mermaid node token
// e.g.  A(["Dashboard"])  B["text"]  C{"Decision"}
function parseNodeToken(token) {
  token = token.trim();
  if (!token) return null;

  const idMatch = token.match(/^([A-Za-z0-9_]+)/);
  if (!idMatch) return null;
  const id   = idMatch[1];
  const rest = token.slice(id.length);

  let label = id, shape = 'rect', m;

  // Stadium  (["text"]) or (['text'])
  if      ((m = rest.match(/^\(\["([\s\S]*?)"\]\)/)))  { label = m[1]; shape = 'rounded'; }
  else if ((m = rest.match(/^\(\['([\s\S]*?)'\]\)/)))  { label = m[1]; shape = 'rounded'; }
  // Circle   ((text))
  else if ((m = rest.match(/^\(\(([\s\S]*?)\)\)/)))    { label = m[1]; shape = 'circle';  }
  // Rectangle  ["text"] or ['text'] or [text]
  else if ((m = rest.match(/^\["([\s\S]*?)"\]/)))      { label = m[1]; shape = 'rect';    }
  else if ((m = rest.match(/^\['([\s\S]*?)'\]/)))      { label = m[1]; shape = 'rect';    }
  else if ((m = rest.match(/^\[([\s\S]*?)\]/)))        { label = m[1]; shape = 'rect';    }
  // Diamond  {"text"} or {text}
  else if ((m = rest.match(/^\{"([\s\S]*?)"\}/)))      { label = m[1]; shape = 'diamond'; }
  else if ((m = rest.match(/^\{([\s\S]*?)\}/)))        { label = m[1]; shape = 'diamond'; }
  // Rounded  ("text") or (text)
  else if ((m = rest.match(/^\("([\s\S]*?)"\)/)))      { label = m[1]; shape = 'rounded'; }
  else if ((m = rest.match(/^\(([\s\S]*?)\)/)))        { label = m[1]; shape = 'rounded'; }

  return { id, label: label.trim(), shape };
}

// ── Line parser ───────────────────────────────────────────────
// Handles: A --> B,  A -- label --> B,  A -->|label| B,  chained A-->B-->C
function parseLine(line, nodeMap, edges) {
  // Strip comments and trailing whitespace
  line = line.replace(/%%.*$/, '').trim();
  if (!line) return;
  // Skip directives
  if (/^(subgraph|end|classDef|class\s|style\s|linkStyle|click\s)/i.test(line)) return;

  // Edge pattern (order matters — labeled dash before bare arrow):
  //  1.  -- label -->    (dash-label-arrow)
  //  2.  -->|label|      (pipe-label arrow)
  //  3.  -->             (plain arrow)
  //  4.  ---             (plain line)
  //  5.  -.->  ==>  ===>  (dotted / thick)
  const edgeRe = /\s*(--\s*([^>\-|][^>\-]*?)\s*-->|-->(?:\|([^|]*)\|)?|---|-\.-?>|===?>|==?>)\s*/g;

  const nodeParts  = [];
  const edgeLabels = [];
  let lastEnd = 0, m;

  while ((m = edgeRe.exec(line)) !== null) {
    nodeParts.push(line.slice(lastEnd, m.index).trim());
    // m[2] = label from "-- label -->"  |  m[3] = label from "-->|label|"
    edgeLabels.push((m[2] || m[3] || '').trim());
    lastEnd = m.index + m[0].length;
  }
  nodeParts.push(line.slice(lastEnd).trim());

  // Parse each node part, register in map
  const nodeIds = nodeParts.map(part => {
    const parsed = parseNodeToken(part);
    if (!parsed) return null;
    if (!nodeMap[parsed.id]) nodeMap[parsed.id] = { label: parsed.label, shape: parsed.shape };
    return parsed.id;
  }).filter(Boolean);

  // Create edges between consecutive nodes
  for (let i = 1; i < nodeIds.length; i++) {
    edges.push({ from: nodeIds[i - 1], to: nodeIds[i], label: edgeLabels[i - 1] || '' });
  }
}

// ── Hierarchical layout ───────────────────────────────────────
function layoutNodes(nodeMap, edges, direction) {
  const ids = Object.keys(nodeMap);
  if (!ids.length) return { positions: {}, levels: {} };

  // Build a spanning forest. Cycle/back edges remain connections, but they do
  // not participate in placement so they cannot pull nodes across the tree.
  const children = {};
  const inDeg = {};
  ids.forEach(id => { children[id] = []; inDeg[id] = 0; });

  const seenEdge = new Set();
  for (const e of edges) {
    const key = `${e.from}→${e.to}`;
    if (seenEdge.has(key) || !children[e.from] || inDeg[e.to] === undefined) continue;
    seenEdge.add(key);
    children[e.from].push(e.to);
    inDeg[e.to]++;
  }

  const levels = {};
  const treeChildren = Object.fromEntries(ids.map(id => [id, []]));
  const assigned = new Set();
  const roots = ids.filter(id => inDeg[id] === 0);
  if (!roots.length) roots.push(ids[0]);

  const visit = (id, level, ancestors) => {
    if (assigned.has(id)) return;
    assigned.add(id);
    levels[id] = level;
    const branch = new Set(ancestors);
    branch.add(id);
    for (const child of children[id]) {
      if (branch.has(child) || assigned.has(child)) continue;
      treeChildren[id].push(child);
      visit(child, level + 1, branch);
    }
  };
  roots.forEach(root => visit(root, 0, new Set()));
  ids.forEach(id => {
    if (!assigned.has(id)) {
      roots.push(id);
      visit(id, 0, new Set());
    }
  });

  // Leaves get stable slots; every parent is centered over the full span of
  // its descendants. This prevents sibling subtrees from occupying the same
  // columns while keeping long decision chains visually balanced.
  const crossAxis = {};
  const SLOT = 250;
  let cursor = 0;
  const placeTree = id => {
    const descendants = treeChildren[id];
    if (!descendants.length) {
      crossAxis[id] = cursor;
      cursor += SLOT;
      return;
    }
    descendants.forEach(placeTree);
    crossAxis[id] = (crossAxis[descendants[0]] + crossAxis[descendants[descendants.length - 1]]) / 2;
  };
  roots.forEach((root, index) => {
    if (index) cursor += SLOT * .6;
    placeTree(root);
  });

  const minCross = Math.min(...Object.values(crossAxis));
  const maxCross = Math.max(...Object.values(crossAxis));
  const DEPTH = 190;
  const ORIGIN_X = 110;
  const ORIGIN_Y = 70;
  const isHorizontal = direction === 'LR' || direction === 'RL';
  const positions = {};
  ids.forEach(id => {
    const cross = crossAxis[id] - minCross;
    const depth = levels[id] * DEPTH;
    if (isHorizontal) {
      positions[id] = { x: ORIGIN_X + depth, y: ORIGIN_Y + cross };
    } else {
      positions[id] = { x: ORIGIN_X + cross, y: ORIGIN_Y + depth };
    }
  });

  if (direction === 'RL') {
    const maxDepth = Math.max(...Object.values(positions).map(position => position.x));
    ids.forEach(id => { positions[id].x = ORIGIN_X + maxDepth - positions[id].x; });
  } else if (direction === 'BT') {
    const maxDepth = Math.max(...Object.values(positions).map(position => position.y));
    ids.forEach(id => { positions[id].y = ORIGIN_Y + maxDepth - positions[id].y; });
  }

  return { positions, levels };
}

// ── Main parser ───────────────────────────────────────────────
export function parseMermaidToWCF(text) {
  const lines = text.split('\n');

  // Detect direction from first non-empty line
  let direction = 'TB';
  const firstLine = lines.find(l => l.trim())?.trim() || '';
  const dirMatch  = firstLine.match(/^(?:flowchart|graph)\s+(TB|TD|LR|BT|RL)/i);
  if (dirMatch) direction = dirMatch[1].toUpperCase() === 'TD' ? 'TB' : dirMatch[1].toUpperCase();

  const nodeMap  = {};  // mermaidId → { label, shape }
  const rawEdges = [];  // { from, to, label }

  // Skip first meaningful line (direction declaration)
  let skippedFirst = false;
  for (const line of lines) {
    const t = line.trim();
    if (!skippedFirst && /^(?:flowchart|graph)\s/i.test(t)) { skippedFirst = true; continue; }
    parseLine(t, nodeMap, rawEdges);
  }

  const ids = Object.keys(nodeMap);
  if (!ids.length) return null;

  const { positions, levels } = layoutNodes(nodeMap, rawEdges, direction);

  // Map Mermaid shape names → WCF shape names (CSS classes)
  //   diamond → 'diamond'  (::before rotated square, CSS handles amber color)
  //   rounded / circle → 'oval'  (large border-radius, teal customColor)
  //   rect → undefined  (normal node, default color palette)
  function mmdShapeToWCF(s) {
    if (s === 'diamond') return 'diamond';
    if (s === 'rounded' || s === 'circle') return 'oval';
    return null; // rect — no special shape class
  }

  // Build WCF state
  let nextId = state.nextId;
  const idMap    = {};   // mermaidId → wcfId
  const wcfNodes = {};

  for (const mId of ids) {
    const wcfId   = String(nextId++);
    idMap[mId]    = wcfId;
    const pos     = positions[mId] || { x: 100, y: 100 };
    const info    = nodeMap[mId];
    const wcfShape = mmdShapeToWCF(info.shape);

    const node = {
      id:       wcfId,
      text:     info.label,
      x:        pos.x,
      y:        pos.y,
      children: [],
      note:     '',
      // Diamond needs a square node (130×130); oval/rect use 180px
      width:    wcfShape === 'diamond' ? 130 : 180,
    };

    // Store shape so buildEl can apply the CSS class
    if (wcfShape) node.shape = wcfShape;

    // Color:
    //   diamond → no customColor (CSS ::before handles amber color)
    //   oval    → teal, applied via syncColors
    if (wcfShape === 'oval') node.customColor = '#6d9fc9';
    node.mermaidLevel = levels[mId] ?? 0;

    wcfNodes[wcfId] = node;
  }

  // Deduplicate connections
  const wcfConnections = [];
  const seenConn       = new Set();
  let backEdgeLane = 0;
  for (const e of rawEdges) {
    const from = idMap[e.from], to = idMap[e.to];
    if (!from || !to || from === to) continue;
    const key = `${from}→${to}`;
    if (seenConn.has(key)) continue;
    seenConn.add(key);
    const isForward = (levels[e.to] ?? 0) > (levels[e.from] ?? 0);
    wcfConnections.push({
      from,
      to,
      style: 'arrow',
      label: e.label || '',
      color: '',
      routing: 'orthogonal',
      direction,
      routeType: isForward ? 'forward' : 'back',
      routeLane: isForward ? 0 : backEdgeLane++,
    });
    if (isForward) {
      const children = wcfNodes[from].children;
      if (!children.includes(to)) children.push(to);
    }
  }

  return { nodes: wcfNodes, connections: wcfConnections, nextId };
}

// ── Modal preview renderer ────────────────────────────────────
export function renderMermaidPreview(container, data) {
  if (!container) return;
  container.replaceChildren();

  const nodes = data ? Object.values(data.nodes) : [];
  if (!nodes.length) {
    const empty = document.createElement('div');
    empty.className = 'mmd-diagram-empty';
    empty.innerHTML = '<span></span><strong>Preview diagram</strong><small>Diagram akan tampil saat kode Mermaid terbaca.</small>';
    container.appendChild(empty);
    return;
  }

  const NS = 'http://www.w3.org/2000/svg';
  const createSvg = (tag, attrs = {}) => {
    const element = document.createElementNS(NS, tag);
    Object.entries(attrs).forEach(([key, value]) => element.setAttribute(key, String(value)));
    return element;
  };
  const dimensions = new Map(nodes.map(node => [node.id, {
    x: node.x,
    y: node.y,
    width: node.width || 180,
    height: node.shape === 'diamond' ? 130 : 72,
    shape: node.shape || 'rect',
  }]));
  const nodeBounds = [...dimensions.values()].reduce((result, box) => ({
    minX: Math.min(result.minX, box.x),
    minY: Math.min(result.minY, box.y),
    maxX: Math.max(result.maxX, box.x + box.width),
    maxY: Math.max(result.maxY, box.y + box.height),
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  const backLanes = data.connections.filter(connection => connection.routeType === 'back').length;
  const routePadding = backLanes ? 110 + (backLanes - 1) * 28 : 52;
  const padding = 52;
  const viewX = nodeBounds.minX - routePadding;
  const viewY = nodeBounds.minY - routePadding;
  const viewW = Math.max(320, nodeBounds.maxX - nodeBounds.minX + routePadding * 2);
  const viewH = Math.max(240, nodeBounds.maxY - nodeBounds.minY + routePadding * 2);

  const svg = createSvg('svg', {
    class: 'mmd-diagram-svg',
    viewBox: `${viewX} ${viewY} ${viewW} ${viewH}`,
    preserveAspectRatio: 'xMidYMid meet',
    role: 'img',
    'aria-label': `Preview Mermaid berisi ${nodes.length} node dan ${data.connections.length} koneksi`,
  });
  const defs = createSvg('defs');
  const marker = createSvg('marker', {
    id: 'mmd-preview-arrow',
    markerWidth: 8,
    markerHeight: 8,
    refX: 7,
    refY: 4,
    orient: 'auto',
    markerUnits: 'strokeWidth',
  });
  marker.appendChild(createSvg('path', { d: 'M0,0 L8,4 L0,8 Z', class: 'mmd-preview-arrow' }));
  defs.appendChild(marker);
  svg.appendChild(defs);

  const edgePoint = (box, targetX, targetY) => {
    const centerX = box.x + box.width / 2;
    const centerY = box.y + box.height / 2;
    const dx = targetX - centerX;
    const dy = targetY - centerY;
    const radiusX = box.width / 2;
    const radiusY = box.height / 2;
    let scale;
    if (box.shape === 'oval') {
      scale = 1 / Math.sqrt((dx * dx) / (radiusX * radiusX) + (dy * dy) / (radiusY * radiusY));
    } else if (box.shape === 'diamond') {
      scale = 1 / (Math.abs(dx) / radiusX + Math.abs(dy) / radiusY);
    } else {
      scale = 1 / Math.max(Math.abs(dx) / radiusX, Math.abs(dy) / radiusY);
    }
    return { x: centerX + dx * scale, y: centerY + dy * scale };
  };

  const roundedPolyline = (points, radius = 13) => {
    const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
    const toward = (from, to, amount) => {
      const length = distance(from, to);
      if (!length) return { ...from };
      return {
        x: from.x + (to.x - from.x) * amount / length,
        y: from.y + (to.y - from.y) * amount / length,
      };
    };
    let path = `M ${points[0].x} ${points[0].y}`;
    for (let index = 1; index < points.length - 1; index++) {
      const previous = points[index - 1];
      const corner = points[index];
      const next = points[index + 1];
      const cornerRadius = Math.min(radius, distance(corner, previous) / 2, distance(corner, next) / 2);
      const entry = toward(corner, previous, cornerRadius);
      const exit = toward(corner, next, cornerRadius);
      path += ` L ${entry.x} ${entry.y} Q ${corner.x} ${corner.y} ${exit.x} ${exit.y}`;
    }
    const last = points[points.length - 1];
    return `${path} L ${last.x} ${last.y}`;
  };

  const orthogonalRoute = connection => {
    const from = dimensions.get(connection.from);
    const to = dimensions.get(connection.to);
    if (!from || !to) return null;
    const fromBox = { ...from, left: from.x, right: from.x + from.width, top: from.y, bottom: from.y + from.height, cx: from.x + from.width / 2, cy: from.y + from.height / 2 };
    const toBox = { ...to, left: to.x, right: to.x + to.width, top: to.y, bottom: to.y + to.height, cx: to.x + to.width / 2, cy: to.y + to.height / 2 };
    const horizontal = connection.direction === 'LR' || connection.direction === 'RL';
    const reverse = connection.direction === 'BT' || connection.direction === 'RL';
    const verticalPort = (box, targetX, edge) => {
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
    };
    const horizontalPort = (box, targetY, edge) => {
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
    };
    let points;

    if (connection.routeType === 'back') {
      const laneOffset = 68 + (connection.routeLane || 0) * 28;
      if (horizontal) {
        const centerY = (nodeBounds.minY + nodeBounds.maxY) / 2;
        const useTop = (fromBox.cy + toBox.cy) / 2 <= centerY;
        const laneY = useTop ? nodeBounds.minY - laneOffset : nodeBounds.maxY + laneOffset;
        const start = horizontalPort(fromBox, toBox.cy, useTop ? 'left' : 'right');
        const end = horizontalPort(toBox, fromBox.cy, useTop ? 'left' : 'right');
        points = [start, { x: start.x + (reverse ? -28 : 28), y: start.y }, { x: start.x + (reverse ? -28 : 28), y: laneY }, { x: end.x + (reverse ? 28 : -28), y: laneY }, { x: end.x + (reverse ? 28 : -28), y: end.y }, end];
      } else {
        const centerX = (nodeBounds.minX + nodeBounds.maxX) / 2;
        const useLeft = (fromBox.cx + toBox.cx) / 2 <= centerX;
        const laneX = useLeft ? nodeBounds.minX - laneOffset : nodeBounds.maxX + laneOffset;
        const start = horizontalPort(fromBox, toBox.cy, useLeft ? 'left' : 'right');
        const end = horizontalPort(toBox, fromBox.cy, useLeft ? 'left' : 'right');
        points = [start, { x: start.x, y: start.y + (reverse ? -28 : 28) }, { x: laneX, y: start.y + (reverse ? -28 : 28) }, { x: laneX, y: end.y + (reverse ? 28 : -28) }, { x: end.x, y: end.y + (reverse ? 28 : -28) }, end];
      }
    } else if (horizontal) {
      const start = horizontalPort(fromBox, toBox.cy, reverse ? 'left' : 'right');
      const end = horizontalPort(toBox, fromBox.cy, reverse ? 'right' : 'left');
      const middleX = (start.x + end.x) / 2;
      points = [start, { x: middleX, y: start.y }, { x: middleX, y: end.y }, end];
    } else {
      const start = verticalPort(fromBox, toBox.cx, reverse ? 'top' : 'bottom');
      const end = verticalPort(toBox, fromBox.cx, reverse ? 'bottom' : 'top');
      const middleY = (start.y + end.y) / 2;
      points = [start, { x: start.x, y: middleY }, { x: end.x, y: middleY }, end];
    }

    const longestSegment = points.slice(1).reduce((best, point, index) => {
      const previous = points[index];
      const length = Math.hypot(point.x - previous.x, point.y - previous.y);
      return length > best.length ? { length, from: previous, to: point } : best;
    }, { length: 0, from: points[0], to: points[1] });
    return {
      d: roundedPolyline(points),
      label: {
        x: (longestSegment.from.x + longestSegment.to.x) / 2,
        y: (longestSegment.from.y + longestSegment.to.y) / 2,
      },
    };
  };

  const edgeLayer = createSvg('g', { class: 'mmd-preview-edges' });
  data.connections.forEach(connection => {
    const from = dimensions.get(connection.from);
    const to = dimensions.get(connection.to);
    if (!from || !to) return;
    const fromCenter = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
    const toCenter = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
    const route = connection.routing === 'orthogonal' ? orthogonalRoute(connection) : null;
    const start = edgePoint(from, toCenter.x, toCenter.y);
    const end = edgePoint(to, fromCenter.x, fromCenter.y);
    const horizontal = Math.abs(end.x - start.x) >= Math.abs(end.y - start.y);
    const bend = horizontal ? Math.abs(end.x - start.x) * .42 : Math.abs(end.y - start.y) * .42;
    const pathData = route?.d || (horizontal
      ? `M ${start.x} ${start.y} C ${start.x + Math.sign(end.x - start.x) * bend} ${start.y}, ${end.x - Math.sign(end.x - start.x) * bend} ${end.y}, ${end.x} ${end.y}`
      : `M ${start.x} ${start.y} C ${start.x} ${start.y + Math.sign(end.y - start.y) * bend}, ${end.x} ${end.y - Math.sign(end.y - start.y) * bend}, ${end.x} ${end.y}`);
    edgeLayer.appendChild(createSvg('path', {
      d: pathData,
      class: 'mmd-preview-edge',
      'marker-end': 'url(#mmd-preview-arrow)',
    }));
    if (connection.label) {
      const label = createSvg('text', {
        x: route?.label.x ?? (start.x + end.x) / 2,
        y: (route?.label.y ?? (start.y + end.y) / 2) - 7,
        class: 'mmd-preview-edge-label',
        'text-anchor': 'middle',
      });
      label.textContent = connection.label;
      edgeLayer.appendChild(label);
    }
  });
  svg.appendChild(edgeLayer);

  const splitLabel = (text, maxChars = 23) => {
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = [];
    for (const word of words) {
      const current = lines[lines.length - 1];
      if (!current || `${current} ${word}`.length > maxChars) lines.push(word);
      else lines[lines.length - 1] = `${current} ${word}`;
    }
    if (lines.length > 3) {
      lines.length = 3;
      lines[2] = `${lines[2].slice(0, Math.max(1, maxChars - 1))}…`;
    }
    return lines;
  };

  const nodeLayer = createSvg('g', { class: 'mmd-preview-nodes' });
  nodes.forEach((node, index) => {
    const box = dimensions.get(node.id);
    const group = createSvg('g', { class: `mmd-preview-node is-${box.shape}` });
    const colorIndex = index % 5;
    group.setAttribute('data-color-index', String(colorIndex));
    if (box.shape === 'diamond') {
      group.appendChild(createSvg('polygon', {
        points: `${box.x + box.width / 2},${box.y} ${box.x + box.width},${box.y + box.height / 2} ${box.x + box.width / 2},${box.y + box.height} ${box.x},${box.y + box.height / 2}`,
      }));
    } else if (box.shape === 'oval') {
      group.appendChild(createSvg('ellipse', {
        cx: box.x + box.width / 2,
        cy: box.y + box.height / 2,
        rx: box.width / 2,
        ry: box.height / 2,
      }));
    } else {
      group.appendChild(createSvg('rect', {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        rx: 7,
      }));
    }
    const lines = splitLabel(node.text, box.shape === 'diamond' ? 17 : 23);
    const text = createSvg('text', {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2 - ((lines.length - 1) * 8),
      class: 'mmd-preview-node-label',
      'text-anchor': 'middle',
    });
    lines.forEach((line, lineIndex) => {
      const tspan = createSvg('tspan', {
        x: box.x + box.width / 2,
        dy: lineIndex === 0 ? 0 : 16,
      });
      tspan.textContent = line;
      text.appendChild(tspan);
    });
    group.appendChild(text);
    nodeLayer.appendChild(group);
  });
  svg.appendChild(nodeLayer);
  container.appendChild(svg);
}

// ── Apply import to canvas ────────────────────────────────────
function doImport(text) {
  const flash = window.wcfFlash ?? ((m) => alert(m));

  if (!text.trim()) { flash('⚠ Teks Mermaid kosong', false); return; }

  const data = parseMermaidToWCF(text);
  if (!data || !Object.keys(data.nodes).length) {
    flash('⚠ Tidak ada node yang berhasil diparsing dari file Mermaid', false);
    return;
  }

  pushUndo();
  applyData(data);
  requestAnimationFrame(() => fitToNodes(72));
  refs.dirty = true;
  flash(`✓ Import Mermaid berhasil — ${Object.keys(data.nodes).length} node`, true);
  if (typeof window.wcfUpdateEmptyState === 'function') window.wcfUpdateEmptyState();
}

// ── Public API ────────────────────────────────────────────────
export function importMermaidText(text) { doImport(text); }

// Opens file-picker (.mmd/.md/.txt)
export function openMermaidFilePicker() {
  const input = Object.assign(document.createElement('input'), {
    type:   'file',
    accept: '.mmd,.txt,.md',
  });
  input.onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    doImport(text);
  };
  input.click();
}

// Expose globally so index.html / group.html inline scripts can call these
if (typeof window !== 'undefined') {
  window.wcfImportMermaidText      = importMermaidText;
  window.wcfOpenMermaidFilePicker  = openMermaidFilePicker;
}
