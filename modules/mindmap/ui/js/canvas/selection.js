// ── js/canvas/selection.js ───────────────────────────────────
import { state, selectedNodes, refs, $cv, $el, pushUndo } from '../state.js';
import { renderLines, syncColors }                         from './connection.js';
import { flash }                                           from '../ui/flash.js';
import { panToNode }                                       from './transform.js';

export function selectNode(id, additive = false) {
  if (additive) {
    if (selectedNodes.has(id)) selectedNodes.delete(id);
    else selectedNodes.add(id);
  } else {
    selectedNodes.clear();
    const groupId = state.nodes[id]?.groupId;
    if (groupId) {
      for (const nId in state.nodes) {
        if (state.nodes[nId].groupId === groupId) selectedNodes.add(nId);
      }
    } else {
      selectedNodes.add(id);
    }
    // Auto-pan ke node agar selalu terlihat di viewport
    requestAnimationFrame(() => panToNode(id));
  }
  updateSelectionUI();
}

export function selectAll() {
  for (const id in state.nodes) selectedNodes.add(id);
  updateSelectionUI();
}

export function clearSelection() {
  selectedNodes.clear();
  updateSelectionUI();
}

export function updateSelectionUI() {
  for (const id in state.nodes) {
    const el = $el(id);
    if (el) el.classList.toggle('is-selected', selectedNodes.has(id));
  }
  document.dispatchEvent(new CustomEvent('wcf:selection-changed', { detail: { size: selectedNodes.size } }));
}

// ── Copy / Paste nodes ───────────────────────────────────────
export function copyNodes() {
  if (!selectedNodes.size) return;
  const nodes = {};
  for (const id of selectedNodes) {
    if (state.nodes[id]) nodes[id] = JSON.parse(JSON.stringify(state.nodes[id]));
  }
  const connections = state.connections.filter(
    c => selectedNodes.has(c.from) && selectedNodes.has(c.to)
  );
  refs.nodeClipboard = { nodes, connections };
  flash(`📋 ${selectedNodes.size} node disalin`, true);
}

export function pasteNodes() {
  if (!refs.nodeClipboard) return Promise.resolve(false);
  // Import buildEl lazily to avoid circular at load time
  return import('../canvas/node.js').then(({ buildEl }) => {
    pushUndo();
    const idMap = {};
    const OFFSET = 30;
    for (const oldId in refs.nodeClipboard.nodes) {
      const old   = refs.nodeClipboard.nodes[oldId];
      const newId = 'n' + (state.nextId++);
      idMap[oldId] = newId;
      state.nodes[newId] = { ...old, id: newId, x: old.x + OFFSET, y: old.y + OFFSET, children: [] };
      $cv.appendChild(buildEl(state.nodes[newId]));
    }
    for (const conn of refs.nodeClipboard.connections) {
      const nf = idMap[conn.from], nt = idMap[conn.to];
      if (nf && nt) {
        state.connections.push({ from: nf, to: nt, style: conn.style || 'curved', label: conn.label || '' });
        const children = state.nodes[nf].children || (state.nodes[nf].children = []);
        if (!children.includes(nt)) children.push(nt);
      }
    }
    selectedNodes.clear();
    for (const newId of Object.values(idMap)) selectedNodes.add(newId);
    syncColors(); renderLines(); updateSelectionUI();
    flash(`✓ ${Object.keys(idMap).length} node ditempel`, true);
    return true;
  });
}

export function deleteSelectedNodes() {
  if (!selectedNodes.size) return;
  const deletedCount = selectedNodes.size;
  pushUndo();
  for (const id of [...selectedNodes]) {
    state.connections = state.connections.filter(c => c.from !== id && c.to !== id);
    for (const nid in state.nodes) {
      state.nodes[nid].children = (state.nodes[nid].children || []).filter(c => c !== id);
    }
    delete state.nodes[id];
    $el(id)?.remove();
  }
  selectedNodes.clear();
  // Clean up groups that lost all members
  if (state.groups) {
    for (const gid in state.groups) {
      const hasMembers = Object.values(state.nodes).some(n => n.groupId === gid);
      if (!hasMembers) delete state.groups[gid];
    }
  }
  syncColors(); renderLines();
  refs.nodeCounts[state.currentProject] = Object.keys(state.nodes).length;
  import('../sidebar/tree.js').then(({ renderSidebar }) => renderSidebar());
  window.wcfUpdateEmptyState?.();
  document.dispatchEvent(new CustomEvent('wcf:persist-now', {
    detail: { message: `${deletedCount} node dihapus` },
  }));
}

export function moveSelected(dx, dy) {
  if (!selectedNodes.size) return;
  pushUndo();
  // Lock explicit width on unsized nodes BEFORE updating positions.
  // #canvas has inset:0 (width ≈ viewport), so nodes dragged past the right
  // edge lose shrink-to-fit available width and collapse to min-width:110px.
  // Reading offsetWidth here (before any style change) returns the natural
  // rendered width from the still-valid cached layout.
  for (const id of selectedNodes) {
    const n = state.nodes[id];
    const el = $el(id);
    if (n && el && !el.style.width) {
      const w = el.offsetWidth;
      el.style.width = w + 'px';
      n.width = w; // persist so width survives save/reload
    }
  }
  for (const id of selectedNodes) {
    const n = state.nodes[id];
    if (!n) continue;
    if (n.pinned) continue;   // skip pinned nodes
    n.x += dx; n.y += dy;
    const el = $el(id);
    if (el) { el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; }
  }
  renderLines();
}
