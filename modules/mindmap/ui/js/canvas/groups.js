// ── js/canvas/groups.js ─────────────────────────────────────
// State manipulation for node groups (Figma-style).
// Rendering is done in connection.js → _renderGroups().
import { state, selectedNodes, pushUndo } from '../state.js';
import { flash }                           from '../ui/flash.js';

const PALETTE = [
  { stroke: '#a78bfa', fill: 'rgba(167,139,250,0.09)' },
  { stroke: '#34d399', fill: 'rgba(52,211,153,0.09)'  },
  { stroke: '#fb923c', fill: 'rgba(251,146,60,0.09)'  },
  { stroke: '#60a5fa', fill: 'rgba(96,165,250,0.09)'  },
  { stroke: '#f472b6', fill: 'rgba(244,114,182,0.09)' },
  { stroke: '#facc15', fill: 'rgba(250,204,21,0.09)'  },
];
let _ci = 0;

function _gid() {
  return 'grp' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
}

function _init() {
  if (!state.groups) state.groups = {};
}

// ── Group selected nodes (Ctrl+G) ───────────────────────────
export function createGroup() {
  _init();
  if (selectedNodes.size < 2) {
    flash('Pilih minimal 2 node untuk membuat grup', false);
    return null;
  }
  pushUndo();

  // Pull selected nodes out of any existing groups
  const oldGids = new Set();
  for (const id of selectedNodes) {
    const g = state.nodes[id]?.groupId;
    if (g) oldGids.add(g);
  }
  for (const id of selectedNodes) {
    if (state.nodes[id]) delete state.nodes[id].groupId;
  }
  // Remove orphaned groups (no members left)
  for (const gid of oldGids) {
    if (!Object.values(state.nodes).some(n => n.groupId === gid))
      delete state.groups[gid];
  }

  // Create new group
  const gid = _gid();
  state.groups[gid] = {
    id:    gid,
    label: 'Grup',
    color: PALETTE[_ci++ % PALETTE.length],
  };
  for (const id of selectedNodes) {
    if (state.nodes[id]) state.nodes[id].groupId = gid;
  }

  flash(`✓ ${selectedNodes.size} node dikelompokkan — geser satu, semua ikut  ·  Ctrl+Shift+G untuk ungroup`, true);
  return gid;
}

// ── Ungroup selected nodes (Ctrl+Shift+G) ───────────────────
export function ungroupSelected() {
  _init();
  const gids = new Set();
  for (const id of selectedNodes) {
    const g = state.nodes[id]?.groupId;
    if (g) gids.add(g);
  }
  if (!gids.size) {
    flash('Node yang dipilih tidak berada dalam grup', false);
    return;
  }
  pushUndo();
  for (const gid of gids) {
    for (const id in state.nodes) {
      if (state.nodes[id].groupId === gid) delete state.nodes[id].groupId;
    }
    delete state.groups[gid];
  }
  flash(`✓ ${gids.size} grup dibubarkan`, true);
}
