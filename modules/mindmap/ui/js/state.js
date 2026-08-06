// ── js/state.js — shared state, history, colors ─────────────
'use strict';

export const COLORS = [
  { bg: '#7c6dfa', glow: 'rgba(124,109,250,0.45)' },
  { bg: '#f43f5e', glow: 'rgba(244,63,94,0.40)'   },
  { bg: '#0ea5e9', glow: 'rgba(14,165,233,0.40)'  },
  { bg: '#f59e0b', glow: 'rgba(245,158,11,0.40)'  },
  { bg: '#10b981', glow: 'rgba(16,185,129,0.40)'  },
  { bg: '#ec4899', glow: 'rgba(236,72,153,0.40)'  },
  { bg: '#06b6d4', glow: 'rgba(6,182,212,0.40)'   },
];

export const state = {
  nodes: {},        // { [id]: { id, text, x, y, children[], customColor?, note?, width?, groupId? } }
  connections: [],  // { from, to, style?, label? }[]
  groups: {},       // { [gid]: { id, label, color: {stroke,fill} } }
  stickies: {},     // { [id]: { id, x, y, text, color? } }
  nextStickyId: 1,
  frames: {},       // { [id]: { id, x, y, w, h, label, colorIdx } }
  nextFrameId: 1,
  nextId: 1,
  zoom: 1,
  pan: { x: 0, y: 0 },
  currentProject: localStorage.getItem('wcf_active_project') || 'default',
  currentUser: null, // { id, username, role } — diisi saat boot oleh app.js
};

export const ui = {
  dragging:      null,   // { nodeId, offX, offY, startX, startY, beforeSnap }
  connecting:    null,   // { fromId, curX, curY }
  panning:       false,
  panAnchor:     null,
  ctxTarget:     null,   // nodeId for node ctx menu
  suppressClick: false,
  resizing:      null,   // { nodeId, startW, startX }
  connCtx:       null,   // { from, to } connection being right-clicked
};

export const hist = { undo: [], redo: [], MAX: 50 };

// Mutable singletons via wrapper object (live across modules)
export const refs = {
  workspaceTree:  null,
  dragSrcId:      null,
  dirty:          false,
  initialized:    false, // true setelah loadCurrentProject selesai
  nodeClipboard:  null,  // { nodes:{}, connections:[] }
  fileClipboard:  null,  // { id, name, data }
  treeFilter:     '',
  actionLog:      [],    // [{ ts, project, action, details }]
  nodeCounts:     {},    // { [projectId]: count }
  snapGrid:       false, // snap-to-grid toggle
  snapSize:       20,    // grid size in canvas px
};

export const selectedNodes = new Set();

// ── History helpers ─────────────────────────────────────────

export function snapshotData() {
  return {
    nodes:        state.nodes,
    connections:  state.connections,
    nextId:       state.nextId,
    groups:       state.groups ?? {},
    stickies:     state.stickies ?? {},
    nextStickyId: state.nextStickyId ?? 1,
    frames:       state.frames ?? {},
    nextFrameId:  state.nextFrameId ?? 1,
  };
}

export function snapshot() {
  return JSON.stringify(snapshotData());
}

export function pushUndo() {
  hist.undo.push(snapshot());
  if (hist.undo.length > hist.MAX) hist.undo.shift();
  hist.redo = [];
  refs.dirty = true;
}

// ── DOM helpers (safe because type=module defers) ───────────
export const $c   = document.getElementById('container');
export const $cv  = document.getElementById('canvas');
export const $svg = document.getElementById('svg-lines');
export const $ind = document.getElementById('flash-toast');
export const $zlb = document.getElementById('zoom-label');
export const $el  = id => document.getElementById('node-' + id);
export const $id  = id => document.getElementById(id);
