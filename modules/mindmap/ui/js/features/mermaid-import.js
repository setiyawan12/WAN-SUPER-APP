// ── js/features/mermaid-import.js ────────────────────────────
// Parse Mermaid flowchart/graph syntax → WCF node+connection format
'use strict';

import { state, refs, pushUndo } from '../state.js';
import { applyData }             from '../canvas/node.js';

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
  if (!ids.length) return {};

  // Build children list & in-degree (dedup edges)
  const children = {};
  const inDeg    = {};
  ids.forEach(id => { children[id] = []; inDeg[id] = 0; });

  const seenEdge = new Set();
  for (const e of edges) {
    const key = `${e.from}→${e.to}`;
    if (seenEdge.has(key) || !children[e.from] || inDeg[e.to] === undefined) continue;
    seenEdge.add(key);
    children[e.from].push(e.to);
    inDeg[e.to]++;
  }

  // BFS level assignment — longest-path variant (handles diamonds)
  const level = {};
  const queue = [];
  ids.forEach(id => { if (inDeg[id] === 0) { level[id] = 0; queue.push(id); } });
  if (!queue.length) { level[ids[0]] = 0; queue.push(ids[0]); } // all in cycle → pick first

  const visited = new Set();
  while (queue.length) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    for (const child of children[id]) {
      if (visited.has(child)) continue;  // back-edge → skip (breaks cycles)
      const proposed = (level[id] ?? 0) + 1;
      if (level[child] === undefined || level[child] < proposed) {
        level[child] = proposed;
        queue.push(child);
      }
    }
  }
  // Assign any still-unvisited (isolated or in-cycle) nodes
  ids.forEach(id => { if (level[id] === undefined) level[id] = 0; });

  // Group by level
  const byLevel = {};
  ids.forEach(id => {
    const lv = level[id];
    (byLevel[lv] = byLevel[lv] || []).push(id);
  });

  // Dimensions — use diamond size (130px square) as the baseline unit
  const NODE_W = 140, NODE_H = 130;
  const GAP_X  = 60,  GAP_Y  = 50;
  const ORIG_X  = 80,  ORIG_Y  = 60;
  const maxCount = Math.max(...Object.values(byLevel).map(a => a.length));
  const isH     = direction === 'LR' || direction === 'RL';

  const positions = {};
  for (const [lv, lvIds] of Object.entries(byLevel)) {
    const lvNum  = Number(lv);
    const count  = lvIds.length;
    lvIds.forEach((id, i) => {
      if (isH) {
        const x       = ORIG_X + lvNum * (NODE_W + GAP_X);
        const totalH  = count * NODE_H + (count - 1) * GAP_Y;
        const canvasH = maxCount * NODE_H + (maxCount - 1) * GAP_Y;
        const y       = ORIG_Y + (canvasH - totalH) / 2 + i * (NODE_H + GAP_Y);
        positions[id] = { x, y: Math.round(y) };
      } else {
        const y       = ORIG_Y + lvNum * (NODE_H + GAP_Y);
        const totalW  = count * NODE_W + (count - 1) * GAP_X;
        const canvasW = maxCount * NODE_W + (maxCount - 1) * GAP_X;
        const x       = ORIG_X + (canvasW - totalW) / 2 + i * (NODE_W + GAP_X);
        positions[id] = { x: Math.round(x), y };
      }
    });
  }
  return positions;
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

  const positions = layoutNodes(nodeMap, rawEdges, direction);

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
    if (wcfShape === 'oval') node.customColor = '#06b6d4';

    wcfNodes[wcfId] = node;
  }

  // Deduplicate connections
  const wcfConnections = [];
  const seenConn       = new Set();
  for (const e of rawEdges) {
    const from = idMap[e.from], to = idMap[e.to];
    if (!from || !to || from === to) continue;
    const key = `${from}→${to}`;
    if (seenConn.has(key)) continue;
    seenConn.add(key);
    wcfConnections.push({ from, to, style: 'arrow', label: e.label || '', color: '' });
  }

  return { nodes: wcfNodes, connections: wcfConnections, nextId };
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
