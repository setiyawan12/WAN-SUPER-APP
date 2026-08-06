// ── js/app.js — Entry Point ───────────────────────────────────
import { state, refs, ui, hist, selectedNodes, snapshotData, $c, $cv, $svg, $el, $id }
  from './state.js';
import { applyTransform, toCanvas } from './canvas/transform.js';
import { renderLines, addConnection, hideConnCtx, syncColors }
  from './canvas/connection.js';
import { createNode, applyData, beginEdit, createConnectedNode } from './canvas/node.js';
import { selectNode, clearSelection, selectAll,
         copyNodes, pasteNodes, deleteSelectedNodes,
         moveSelected }              from './canvas/selection.js';
import { flash }                     from './ui/flash.js';
import { initTheme }                 from './ui/theme.js';
import { initMinimap, updateMinimap } from './ui/minimap.js';
import { initShortcutHelp }          from './ui/shortcut-help.js';
import { initCtxMenu, hideCtxMenu }  from './ui/ctx-menu.js';
import { loadWorkspace, switchProject, loadCurrentProject, findParent, pasteFile }
  from './sidebar/workspace.js';
import { renderSidebar, initTreeCtxHandlers, initSidebarButtons, renderTrash }
  from './sidebar/tree.js';
import { initSearch }                from './sidebar/search.js';
import { initToolbar, save }         from './ui/toolbar.js';
import { initHistoryPanel }          from './features/history-log.js';
import { exportPDF, exportPNG, exportSVG, exportJSON, exportMarkdown } from './features/export.js';
import { openImportDialog } from './features/import.js';
import './features/mermaid-import.js';
import { smartPaste, looksLikeTree }        from './features/smart-paste.js';
import { initFindReplace, openFindReplace, closeFindReplace } from './features/find-replace.js';
import { apiGroupGetInfo, apiMe }    from './api.js';
import { ensureAuthenticated }       from './auth-gate.js';
import { hideLoadingShell, updateLoadingShell } from './ui/loading.js';
import { firebaseServices }          from './firebase/client.js';
import { reloadMindmap, setWorkspaceContext, workspaceContext } from './data/repository.js';
import { createGroup, ungroupSelected } from './canvas/groups.js';
import { createSticky } from './features/sticky.js';
import { initAlignBar }         from './features/align.js';
import { initCmdPalette, open as openCmdPalette } from './features/cmd-palette.js';
import { initKanban, openKanban } from './features/kanban.js';
import { initFrames, toggleFrameDrawMode,
         handleFrameMouseDown, handleFrameMouseMove,
         handleFrameMouseUp, isFrameDrawMode } from './features/frames.js';
import { renderMd } from './features/markdown.js';
import { createGroupRealtime } from './collaboration/realtime.js';

let collaboration = null;
const remoteCursors = new Map();
const remoteLocks = new Map();

// ── Canvas events ─────────────────────────────────────────────
function initCanvasEvents() {

  // Pan: middle-mouse or click on empty canvas
  $c.addEventListener('mousedown', e => {
    // Frame draw mode intercepts left-click on canvas
    if (e.button === 0 && isFrameDrawMode() && (e.target === $c || e.target === $cv || e.target?.id === 'frame-layer')) {
      const p = toCanvas(e.clientX, e.clientY);
      handleFrameMouseDown(e, p.x, p.y);
      e.preventDefault();
      return;
    }
    if (e.button === 1 || (e.button === 0 && (e.target === $c || e.target === $cv))) {
      ui.panning   = true;
      ui.panAnchor = { x: e.clientX - state.pan.x, y: e.clientY - state.pan.y };
      $c.style.cursor = 'grabbing';
      $cv?.classList.add('is-panning');
      e.preventDefault();
    }
  });

  window.addEventListener('mousemove', e => {
    // Pan
    if (ui.panning) {
      state.pan.x = e.clientX - ui.panAnchor.x;
      state.pan.y = e.clientY - ui.panAnchor.y;
      applyTransform();
      updateMinimap();
    }

    // Frame draw preview
    if (isFrameDrawMode()) {
      const p = toCanvas(e.clientX, e.clientY);
      handleFrameMouseMove(p.x, p.y);
    }

    // Live connection preview
    if (ui.connecting) {
      const p = toCanvas(e.clientX, e.clientY);
      ui.connecting.curX = p.x;
      ui.connecting.curY = p.y;
      renderLines(p.x, p.y);
    }

    // Node drag — ui.dragging set by node.js with: { nodeId, offX, offY }
    if (ui.dragging) {
      const { nodeId, offX, offY, startClientX, startClientY } = ui.dragging;
      if (!ui.dragging.hasMoved) {
        const distance = Math.hypot(e.clientX - startClientX, e.clientY - startClientY);
        if (distance < 3) return;
        ui.dragging.hasMoved = true;
      }
      const n = state.nodes[nodeId];
      if (!n) return;
      const p   = toCanvas(e.clientX, e.clientY);
      let newX = p.x - offX;
      let newY = p.y - offY;
      if (refs.snapGrid) {
        newX = Math.round(newX / refs.snapSize) * refs.snapSize;
        newY = Math.round(newY / refs.snapSize) * refs.snapSize;
      }
      if (selectedNodes.size > 1 && selectedNodes.has(nodeId)) {
        const dx = newX - n.x, dy = newY - n.y;
        if (Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1) moveSelected(dx, dy);
      } else {
        const el = $el(nodeId);
        // Lock width before position change to prevent shrink-to-fit collapse
        if (el && !el.style.width) { const w = el.offsetWidth; el.style.width = w + 'px'; n.width = w; }
        n.x = newX; n.y = newY;
        if (el) { el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; }
      }
      renderLines(); updateMinimap();
      collaboration?.sendNodePosition(nodeId, n.x, n.y);
      ui.suppressClick = true;
    }

    // Node resize — ui.resizing set by node.js with: { nodeId, startW, startX }
    if (ui.resizing) {
      const { nodeId, startW, startX } = ui.resizing;
      const n  = state.nodes[nodeId];
      const el = $el(nodeId);
      if (!n || !el) return;
      const newW = Math.max(80, Math.min(600, startW + (e.clientX - startX)));
      n.width = newW;
      el.style.width = newW + 'px';
      renderLines(); updateMinimap();
    }
  });

  window.addEventListener('mouseup', e => {
    // Frame draw complete
    if (isFrameDrawMode()) {
      const p = toCanvas(e.clientX, e.clientY);
      handleFrameMouseUp(p.x, p.y);
    }
    if (ui.panning)   { ui.panning = false; $c.style.cursor = ''; $cv?.classList.remove('is-panning'); }
    if (ui.dragging) {
      // Push pre-drag snapshot to undo stack so move is undoable
      if (ui.dragging.hasMoved && ui.dragging.beforeSnap) {
        hist.undo.push(ui.dragging.beforeSnap);
        if (hist.undo.length > hist.MAX) hist.undo.shift();
        hist.redo = [];
      }
      const moved = ui.dragging.hasMoved;
      $el(ui.dragging.nodeId)?.classList.remove('is-dragging');
      ui.dragging = null;
      if (moved) {
        refs.dirty = true;
        renderLines(); updateMinimap();
        setTimeout(() => { ui.suppressClick = false; }, 0);
      }
    }
    if (ui.resizing) {
      // Push pre-resize snapshot to undo stack so resize is undoable
      if (ui.resizing.beforeSnap) {
        hist.undo.push(ui.resizing.beforeSnap);
        if (hist.undo.length > hist.MAX) hist.undo.shift();
        hist.redo = [];
      }
      refs.dirty = true; ui.resizing = null;
    }

    // Complete connection: drop onto a node element OR empty canvas
    if (ui.connecting) {
      const target = document.elementFromPoint(e.clientX, e.clientY);
      const nodeEl = target?.closest?.('.node');
      const fromId = ui.connecting.fromId;
      if (nodeEl && nodeEl.dataset.id && nodeEl.dataset.id !== fromId) {
        // Drop on existing node → connect
        addConnection(fromId, nodeEl.dataset.id);
        syncColors();
        ui.connecting = null;
        renderLines(); updateMinimap();
      } else if (!nodeEl) {
        // Drop on empty canvas → auto-create new connected node
        const p = toCanvas(e.clientX, e.clientY);
        ui.connecting = null;
        createConnectedNode(fromId, p.x - 70, p.y - 20);
        updateMinimap();
      } else {
        ui.connecting = null;
        renderLines(); updateMinimap();
      }
    }
  });

  // Wheel zoom
  $c.addEventListener('wheel', e => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.05 : -0.05;
    const r  = $c.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const bx = (mx - state.pan.x) / state.zoom;
    const by = (my - state.pan.y) / state.zoom;
    state.zoom  = Math.min(3, Math.max(0.15, state.zoom + delta));
    state.pan.x = mx - bx * state.zoom;
    state.pan.y = my - by * state.zoom;
    applyTransform();
    const zl = $id('zoom-label');
    if (zl) zl.textContent = Math.round(state.zoom * 100) + '%';
    updateMinimap();
  }, { passive: false });

  // Canvas coordinates HUD
  const _coordsEl = $id('canvas-coords');
  if (_coordsEl) {
    $c.addEventListener('mousemove', e => {
      const p = toCanvas(e.clientX, e.clientY);
      _coordsEl.style.display = 'block';
      _coordsEl.textContent = `X: ${Math.round(p.x)}  Y: ${Math.round(p.y)}`;
    });
    $c.addEventListener('mouseleave', () => { _coordsEl.style.display = 'none'; });
  }

  // ── Pinch zoom (touch) ────────────────────────────────────────
  let _touches = {};
  let _pinchDist0 = null, _pinchZoom0 = null, _pinchMid = null;
  let _panTouch = null;

  $c.addEventListener('touchstart', e => {
    e.preventDefault();
    for (const t of e.changedTouches) _touches[t.identifier] = { x: t.clientX, y: t.clientY };
    const ids = Object.keys(_touches);
    if (ids.length === 2) {
      const a = _touches[ids[0]], b = _touches[ids[1]];
      _pinchDist0 = Math.hypot(b.x - a.x, b.y - a.y);
      _pinchZoom0 = state.zoom;
      _pinchMid   = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      _panTouch   = null;
    } else if (ids.length === 1) {
      _panTouch = { id: ids[0], x: _touches[ids[0]].x, y: _touches[ids[0]].y, px: state.pan.x, py: state.pan.y };
    }
  }, { passive: false });

  $c.addEventListener('touchmove', e => {
    e.preventDefault();
    for (const t of e.changedTouches) _touches[t.identifier] = { x: t.clientX, y: t.clientY };
    const ids = Object.keys(_touches);
    if (ids.length === 2 && _pinchDist0 !== null) {
      const a = _touches[ids[0]], b = _touches[ids[1]];
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const scale = dist / _pinchDist0;
      const newZoom = Math.min(3, Math.max(0.1, _pinchZoom0 * scale));
      const bx = toCanvas(_pinchMid.x, _pinchMid.y);
      state.zoom = newZoom;
      state.pan.x = _pinchMid.x - bx.x * newZoom;
      state.pan.y = _pinchMid.y - bx.y * newZoom;
      applyTransform();
      const zl = $id('zoom-label');
      if (zl) zl.textContent = Math.round(newZoom * 100) + '%';
    } else if (ids.length === 1 && _panTouch) {
      const t = _touches[_panTouch.id];
      if (t) {
        state.pan.x = _panTouch.px + (t.x - _panTouch.x);
        state.pan.y = _panTouch.py + (t.y - _panTouch.y);
        applyTransform();
      }
    }
  }, { passive: false });

  $c.addEventListener('touchend', e => {
    for (const t of e.changedTouches) delete _touches[t.identifier];
    if (Object.keys(_touches).length < 2) { _pinchDist0 = null; _pinchMid = null; }
    if (Object.keys(_touches).length === 0) _panTouch = null;
  }, { passive: false });

  // Dblclick canvas → create node / sticky note (Shift+dblclick)
  $c.addEventListener('dblclick', e => {
    if (e.target !== $c && e.target !== $cv) return;
    const p = toCanvas(e.clientX, e.clientY);
    if (e.shiftKey) {
      createSticky(p.x, p.y);
    } else {
      createNode(p.x, p.y, 'Node baru');
      updateMinimap();
    }
  });

  // Click canvas → deselect
  $c.addEventListener('click', e => {
    if (e.target !== $c && e.target !== $cv) return;
    clearSelection();
    hideCtxMenu();
    hideConnCtx();
  });

  $c.addEventListener('contextmenu', e => e.preventDefault());
}

function initCollaborationUi() {
  const online = document.createElement('div');
  online.id = 'collaboration-online';
  online.style.cssText = 'display:none;align-items:center;gap:3px;margin-right:4px;';
  document.getElementById('cloud-state')?.before(online);

  const status = document.createElement('span');
  status.id = 'collaboration-status';
  status.style.cssText = 'font-size:9px;color:var(--text-4);margin-right:5px;white-space:nowrap;';
  online.after(status);

  const renderPresence = users => {
    online.innerHTML = '';
    online.style.display = users.length ? 'flex' : 'none';
    for (const user of users.slice(0, 6)) {
      const avatar = document.createElement('span');
      avatar.title = `${user.username || 'WAN User'}${user.fileId === state.currentProject ? ' · file ini' : ''}`;
      avatar.textContent = String(user.username || '?').slice(0, 1).toUpperCase();
      avatar.style.cssText = `display:inline-flex;align-items:center;justify-content:center;width:21px;height:21px;border-radius:50%;background:${user.color || '#7c6dfa'};color:#fff;font-size:9px;font-weight:700;border:2px solid ${user.fileId === state.currentProject ? '#4ade80' : 'var(--border-md)'};`;
      online.appendChild(avatar);
    }
    status.textContent = users.length ? `${users.length + 1} online` : 'Realtime aktif';
  };

  const positionCursor = cursor => {
    cursor.el.style.transform = `translate(${cursor.x * state.zoom + state.pan.x}px,${cursor.y * state.zoom + state.pan.y}px)`;
  };

  const updateCursor = (sessionId, value) => {
    if (!value) {
      remoteCursors.get(sessionId)?.el.remove();
      remoteCursors.delete(sessionId);
      return;
    }
    let cursor = remoteCursors.get(sessionId);
    if (!cursor) {
      const el = document.createElement('div');
      el.style.cssText = 'position:absolute;top:0;left:0;z-index:999;pointer-events:none;display:flex;align-items:flex-end;gap:3px;transition:transform 80ms linear;will-change:transform;';
      const pointer = document.createElement('span');
      pointer.textContent = '◆';
      pointer.style.cssText = `font-size:13px;color:${value.color || '#7c6dfa'};filter:drop-shadow(0 1px 2px rgba(0,0,0,.6));`;
      const label = document.createElement('span');
      label.textContent = value.username || 'WAN User';
      label.style.cssText = `max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:1px 6px;border-radius:99px;background:${value.color || '#7c6dfa'};color:#fff;font-size:9px;font-weight:700;`;
      el.append(pointer, label);
      $c.appendChild(el);
      cursor = { el, x: 0, y: 0 };
      remoteCursors.set(sessionId, cursor);
    }
    cursor.x = Number(value.x || 0);
    cursor.y = Number(value.y || 0);
    positionCursor(cursor);
  };

  const applyLock = (nodeKey, value) => {
    const previous = remoteLocks.get(nodeKey);
    if (previous?.nodeId && (!value || previous.nodeId !== value.nodeId)) {
      const oldEl = $el(previous.nodeId);
      oldEl?.classList.remove('is-collab-locked');
      oldEl?.querySelector('.collab-lock-badge')?.remove();
    }
    if (!value?.nodeId) {
      remoteLocks.delete(nodeKey);
      return;
    }
    remoteLocks.set(nodeKey, value);
    const el = $el(value.nodeId);
    if (!el) return;
    el.classList.add('is-collab-locked');
    let badge = el.querySelector('.collab-lock-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'collab-lock-badge';
      badge.style.cssText = 'position:absolute;top:-9px;right:-7px;z-index:20;padding:1px 5px;border-radius:99px;color:#fff;font-size:9px;font-weight:700;pointer-events:none;white-space:nowrap;';
      el.appendChild(badge);
    }
    badge.style.background = value.color || '#7c6dfa';
    badge.textContent = `${value.username || 'User'} mengedit`;
  };

  document.addEventListener('wcf:canvas-transform', () => {
    for (const cursor of remoteCursors.values()) positionCursor(cursor);
  });

  $c.addEventListener('mousemove', event => {
    if (!collaboration) return;
    const point = toCanvas(event.clientX, event.clientY);
    collaboration.sendCursor(point.x, point.y);
  });

  $c.addEventListener('dblclick', event => {
    const text = event.target.closest?.('.node-text');
    const nodeId = text?.closest?.('.node')?.dataset.id;
    if (!nodeId || !collaboration) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const locked = [...remoteLocks.values()].some(value => value.nodeId === nodeId);
    if (locked) {
      flash('Node sedang diedit pengguna lain', false);
      return;
    }
    void collaboration.lockNode(nodeId).then(acquired => {
      if (!acquired) {
        flash('Node baru saja dikunci pengguna lain', false);
        return;
      }
      beginEdit(nodeId, text, { skipCollaborationGuard: true });
    }).catch(error => {
      console.warn('[WCF] lock node:', error);
      flash('Gagal mengunci node untuk diedit', false);
    });
  }, { capture: true });

  document.addEventListener('keydown', event => {
    if (!collaboration || !['F2', 'Enter'].includes(event.key) || selectedNodes.size !== 1) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.contentEditable === 'true') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!collaboration.canWrite) {
      flash('Workspace ini hanya dapat dibaca', false);
      return;
    }
    const [nodeId] = [...selectedNodes];
    const locked = [...remoteLocks.values()].some(value => value.nodeId === nodeId);
    if (locked) {
      flash('Node sedang diedit pengguna lain', false);
      return;
    }
    void collaboration.lockNode(nodeId).then(acquired => {
      if (acquired) beginEdit(nodeId, null, { skipCollaborationGuard: true });
      else flash('Node baru saja dikunci pengguna lain', false);
    });
  }, { capture: true });

  document.addEventListener('wcf:before-node-edit', event => {
    if (!collaboration) return;
    event.preventDefault();
    const nodeId = event.detail?.nodeId;
    if (!nodeId) return;
    if (!collaboration.canWrite) {
      flash('Workspace ini hanya dapat dibaca', false);
      return;
    }
    const locked = [...remoteLocks.values()].some(value => value.nodeId === nodeId);
    if (locked) {
      flash('Node sedang diedit pengguna lain', false);
      return;
    }
    void collaboration.lockNode(nodeId).then(acquired => {
      if (acquired) beginEdit(nodeId, event.detail?.span, { skipCollaborationGuard: true });
      else flash('Node baru saja dikunci pengguna lain', false);
    });
  });

  $c.addEventListener('focusin', event => {
    const nodeId = event.target.closest?.('.node')?.dataset.id;
    if (nodeId && event.target.classList.contains('node-edit-textarea')) void collaboration?.lockNode(nodeId);
  });
  $c.addEventListener('focusout', event => {
    const nodeId = event.target.closest?.('.node')?.dataset.id;
    if (nodeId && event.target.classList.contains('node-edit-textarea')) void collaboration?.unlockNode(nodeId);
  });
  $c.addEventListener('input', event => {
    const nodeId = event.target.closest?.('.node')?.dataset.id;
    if (!nodeId || !event.target.classList.contains('node-edit-textarea')) return;
    collaboration?.sendTyping(nodeId);
    collaboration?.sendNodeText(nodeId, event.target.value);
  });

  return {
    renderPresence,
    updateCursor,
    applyLock,
    setStatus(connected) {
      status.textContent = connected ? 'Realtime aktif' : 'Realtime offline';
      status.style.color = connected ? 'var(--green)' : '#f87171';
    },
    removeSession(sessionId) {
      updateCursor(sessionId, null);
      for (const [key, value] of remoteLocks) {
        if (value.sessionId === sessionId) applyLock(key, null);
      }
    },
  };
}

function canApplyRemoteCanvas() {
  return refs.initialized && !refs.dirty && !ui.dragging && !ui.resizing && !ui.connecting
    && !document.querySelector('.node-edit-textarea:focus');
}

function enableGroupReadOnlyMode() {
  document.body.classList.add('wcf-group-read-only');
  const blockedButtons = [
    'btn-save', 'btn-clear', 'btn-undo', 'btn-redo', 'btn-auto-layout', 'btn-cmd',
    'btn-sticky', 'btn-frame', 'btn-import-json', 'btn-import-mermaid', 'btn-snap-grid',
  ];
  for (const id of blockedButtons) {
    const button = $id(id);
    if (!button) continue;
    button.disabled = true;
    button.title = 'Workspace hanya dapat dibaca';
  }
  const blockPointerMutation = event => {
    const target = event.target;
    const node = target.closest?.('.node');
    const mutatingNodeControl = node && (
      event.type === 'dblclick'
      || target.closest?.('.conn-dot')
      || target.closest?.('.node-resize-handle')
      || (event.type === 'mousedown' && event.button === 0)
    );
    if (!mutatingNodeControl) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type === 'dblclick') flash('Workspace ini hanya dapat dibaca', false);
  };
  $c.addEventListener('mousedown', blockPointerMutation, { capture: true });
  $c.addEventListener('dblclick', blockPointerMutation, { capture: true });
  document.addEventListener('keydown', event => {
    const tag = document.activeElement?.tagName;
    const editing = tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.contentEditable === 'true';
    if (editing) return;
    const ctrl = event.ctrlKey || event.metaKey;
    const mutation = ['Delete', 'Backspace', 'F2', 'Enter'].includes(event.key)
      || ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)
      || (ctrl && ['v', 'd', 'g', 'z', 'y', 's'].includes(event.key.toLowerCase()));
    if (!mutation) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    flash('Workspace ini hanya dapat dibaca', false);
  }, { capture: true });
}

async function startGroupCollaboration(context) {
  const uiBindings = initCollaborationUi();
  const groupInfo = await apiGroupGetInfo(context.groupId);
  if (!groupInfo?.ok) throw new Error(groupInfo?.error || 'Akses grup tidak tersedia.');
  const canWrite = ['owner', 'editor', 'admin'].includes(groupInfo.group?.role);
  if (!canWrite) {
    window.wcfViewMode = true;
    enableGroupReadOnlyMode();
  }
  collaboration = await createGroupRealtime({
    groupId: context.groupId,
    username: state.currentUser?.username,
    canWrite,
    onStatus: connected => uiBindings.setStatus(connected),
    onPresence: users => uiBindings.renderPresence(users),
    onCursor: (sessionId, value) => uiBindings.updateCursor(sessionId, value),
    onSessionLeft: sessionId => uiBindings.removeSession(sessionId),
    onLock: (nodeKey, value) => uiBindings.applyLock(nodeKey, value),
    onTyping: (payload, actor) => {
      const el = $el(payload.nodeId);
      if (!el) return;
      let badge = el.querySelector('.collab-typing-badge');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'collab-typing-badge';
        badge.style.cssText = 'position:absolute;bottom:-18px;left:0;padding:1px 5px;border-radius:99px;color:#fff;font-size:8px;font-weight:700;pointer-events:none;white-space:nowrap;';
        el.appendChild(badge);
      }
      badge.style.background = actor.color;
      badge.textContent = `${actor.username} mengetik...`;
      clearTimeout(el._collabTypingTimer);
      el._collabTypingTimer = setTimeout(() => badge.remove(), 1600);
    },
    onNodePosition: payload => {
      const node = state.nodes[payload.nodeId];
      const el = $el(payload.nodeId);
      if (!node || !el || ui.dragging?.nodeId === payload.nodeId) return;
      node.x = Number(payload.x);
      node.y = Number(payload.y);
      el.style.left = `${node.x}px`;
      el.style.top = `${node.y}px`;
      renderLines();
      updateMinimap();
    },
    onNodeText: payload => {
      const node = state.nodes[payload.nodeId];
      const el = $el(payload.nodeId);
      if (!node || !el || el.querySelector('.node-edit-textarea:focus')) return;
      node.text = String(payload.text || '');
      const text = el.querySelector('.node-text');
      if (text) text.innerHTML = renderMd(node.text);
      renderLines();
    },
    onCanvas: canvas => {
      if (!canApplyRemoteCanvas()) return false;
      applyData(canvas);
      refs.dirty = false;
      updateMinimap();
      for (const [key, value] of remoteLocks) uiBindings.applyLock(key, value);
      return true;
    },
    onWorkspace: tree => {
      if (!tree || JSON.stringify(tree) === JSON.stringify(refs.workspaceTree)) return;
      refs.workspaceTree = tree;
      renderSidebar();
    },
    onError: error => console.warn('[WCF] realtime collaboration:', error),
  });
  await collaboration.setProject(state.currentProject);
  document.addEventListener('wcf:project-changed', event => {
    remoteCursors.forEach(cursor => cursor.el.remove());
    remoteCursors.clear();
    remoteLocks.forEach((value, key) => uiBindings.applyLock(key, null));
    void collaboration?.setProject(event.detail?.projectId);
  });
  setInterval(() => collaboration?.flushPending(), 500);
  window.addEventListener('beforeunload', () => { void collaboration?.stop(); });
}

// ── Keyboard ──────────────────────────────────────────────────
function initKeyboard() {
  document.addEventListener('keydown', e => {
    const tag     = document.activeElement?.tagName;
    const editing = tag === 'INPUT' || tag === 'TEXTAREA' ||
                    document.activeElement?.contentEditable === 'true';
    const ctrl    = e.ctrlKey || e.metaKey;

    if (!editing) {
      if (ctrl && e.key === 'a') { e.preventDefault(); selectAll(); }
      // Group / Ungroup (Figma-style)
      if (ctrl && !e.shiftKey && e.key === 'g') {
        e.preventDefault(); createGroup(); renderLines(); refs.dirty = true;
      }
      if (ctrl && e.shiftKey && e.key === 'G') {
        e.preventDefault(); ungroupSelected(); renderLines(); refs.dirty = true;
      }
      if (ctrl && e.key === 'c') { e.preventDefault(); copyNodes(); }
      if (ctrl && e.key === 'v') {
        e.preventDefault();
        // If node clipboard has content, paste nodes
        if (refs.nodeClipboard) { pasteNodes(); return; }
        // Try smart paste from system clipboard text
        if (navigator.clipboard && navigator.clipboard.readText) {
          navigator.clipboard.readText().then(text => {
            if (text && looksLikeTree(text)) {
              // Place tree at center of viewport
              const cw = $c.offsetWidth || window.innerWidth;
              const ch = $c.offsetHeight || window.innerHeight;
              const cx = (cw / 2 - state.pan.x) / state.zoom - 70;
              const cy = (ch / 3 - state.pan.y) / state.zoom;
              smartPaste(text, cx, cy);
              return;
            }
            // Else paste file into folder of active project
            if (refs.fileClipboard) {
              const parent = findParent(refs.workspaceTree, state.currentProject);
              const arr    = parent?.children ?? (refs.workspaceTree?.children || []);
              pasteFile(arr, parent || null);
            }
          }).catch(() => {
            // Clipboard read failed — fallback to file paste
            if (refs.fileClipboard) {
              const parent = findParent(refs.workspaceTree, state.currentProject);
              const arr    = parent?.children ?? (refs.workspaceTree?.children || []);
              pasteFile(arr, parent || null);
            }
          });
          return;
        }
        // No clipboard API — paste file
        if (refs.fileClipboard) {
          const parent = findParent(refs.workspaceTree, state.currentProject);
          const arr    = parent?.children ?? (refs.workspaceTree?.children || []);
          pasteFile(arr, parent || null);
        }
      }
      // Ctrl+D — duplicate subtree (selected nodes + semua descendant)
      if (ctrl && e.key === 'd' && selectedNodes.size) {
        e.preventDefault();
        // Expand selection to include all descendants of selected nodes
        const toAdd = new Set([...selectedNodes]);
        function collectDesc(id) {
          state.connections.filter(c => c.from === id).forEach(c => {
            if (!toAdd.has(c.to)) { toAdd.add(c.to); collectDesc(c.to); }
          });
        }
        [...selectedNodes].forEach(id => collectDesc(id));
        // Temporarily expand selectedNodes to full subtree, copy, paste, restore
        const prev = [...selectedNodes];
        selectedNodes.clear();
        toAdd.forEach(id => selectedNodes.add(id));
        copyNodes();
        selectedNodes.clear();
        prev.forEach(id => selectedNodes.add(id));
        pasteNodes();
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedNodes.size) {
        e.preventDefault(); deleteSelectedNodes();
      }
      const d = e.shiftKey ? 20 : 5;
      if (e.key === 'ArrowUp')    { e.preventDefault(); moveSelected(0, -d); renderLines(); updateMinimap(); refs.dirty = true; }
      if (e.key === 'ArrowDown')  { e.preventDefault(); moveSelected(0,  d); renderLines(); updateMinimap(); refs.dirty = true; }
      if (e.key === 'ArrowLeft')  { e.preventDefault(); moveSelected(-d, 0); renderLines(); updateMinimap(); refs.dirty = true; }
      if (e.key === 'ArrowRight') { e.preventDefault(); moveSelected( d, 0); renderLines(); updateMinimap(); refs.dirty = true; }

      // F2 atau Enter → mulai edit node yang sedang dipilih
      if ((e.key === 'F2' || e.key === 'Enter') && selectedNodes.size === 1) {
        e.preventDefault();
        const [id] = [...selectedNodes];
        beginEdit(id);
      }

      // Tab → navigasi ke node anak pertama; Shift+Tab → ke parent
      if (e.key === 'Tab' && selectedNodes.size === 1) {
        e.preventDefault();
        const [id] = [...selectedNodes];
        if (e.shiftKey) {
          // Shift+Tab → pilih parent (node yang punya koneksi KE node ini)
          const parentConn = state.connections.find(c => c.to === id);
          if (parentConn) selectNode(parentConn.from, false);
        } else {
          // Tab → pilih anak pertama
          const childConn = state.connections.find(c => c.from === id);
          if (childConn) selectNode(childConn.to, false);
        }
      }

      // Space → toggle collapse/expand subtree pada node yang dipilih
      if (e.key === ' ' && selectedNodes.size === 1) {
        e.preventDefault();
        const [id] = [...selectedNodes];
        const nd = state.nodes[id];
        if (nd && state.connections.some(c => c.from === id)) {
          nd.collapsed = !nd.collapsed;
          refs.dirty = true;
          renderLines();
        }
      }

      if (e.key === '?') { import('./ui/shortcut-help.js').then(m => m.showHelp()); }
      // Ctrl+H — Find & Replace
      if (ctrl && e.key === 'h') { e.preventDefault(); openFindReplace(); }
      if (e.key === 'Escape') {
        clearSelection(); hideCtxMenu(); hideConnCtx(); closeFindReplace();
        if (ui.connecting) { ui.connecting = null; renderLines(); }
        $id('shortcut-modal')?.classList.add('hidden');
        $id('conn-style-picker')?.classList.add('hidden');
      }
    }
  });
}

// ── Rerender hook (used by group label rename, etc.) ─────────
document.addEventListener('wcf:rerender', () => renderLines());

// ── Boot ──────────────────────────────────────────────────────
async function init() {
  updateLoadingShell('Memeriksa sesi Firebase...');
  await ensureAuthenticated();
  updateLoadingShell('Memuat profil dan izin...');
  const meRes = await apiMe().catch(() => null);
  if (!meRes || !meRes.ok) {
    throw new Error(meRes?.error || 'Autentikasi gagal');
  }
  state.currentUser = meRes.user;

  const context = workspaceContext();
  const contextEl = document.getElementById('workspace-context');
  if (contextEl) {
    contextEl.textContent = context.type === 'group' ? context.name : 'Personal';
    contextEl.classList.toggle('is-group', context.type === 'group');
    contextEl.title = context.type === 'group' ? 'Klik untuk kembali ke workspace personal' : 'Workspace personal';
    contextEl.addEventListener('click', () => {
      if (context.type !== 'group') return;
      setWorkspaceContext({ type: 'personal' });
      localStorage.setItem('wcf_active_project', 'default');
      void reloadMindmap();
    });
  }

  const cloudState = document.getElementById('cloud-state');
  const services = await firebaseServices();
  if (cloudState) {
    cloudState.classList.toggle('is-cloud', services.configured);
    const label = cloudState.querySelector('span');
    if (label) label.textContent = services.configured ? 'FIREBASE' : 'LOCAL';
  }
  document.getElementById('btn-back-hub')?.addEventListener('click', () => {
    setWorkspaceContext({ type: 'personal' });
    localStorage.setItem('wcf_active_project', 'default');
    if (window.mindmapHost?.showHub) void window.mindmapHost.showHub();
  });

  // Tampilkan info user di header
  const uEl = document.getElementById('user-display');
  if (uEl) {
    uEl.textContent = meRes.user.username;
    uEl.title       = `Role: ${meRes.user.role}`;
  }
  // Tampilkan tombol admin jika role admin
  const adminBtn = document.getElementById('btn-admin-panel');
  if (adminBtn && meRes.user.role === 'admin') adminBtn.style.display = 'inline-flex';

  console.log('[WCF] app init start, project:', state.currentProject);
  initTheme();
  initToolbar();
  initCanvasEvents();
  initCtxMenu();
  initAlignBar();
  initCmdPalette();
  initKanban();
  initFrames();
  initKeyboard();
  initSearch();
  initTreeCtxHandlers();
  initSidebarButtons();
  initMinimap();
  initShortcutHelp();
  initHistoryPanel();
  initFindReplace();
  try {
    updateLoadingShell('Menyusun proyek dan folder...');
    await loadWorkspace();
    updateLoadingShell('Mengambil mindmap dari Firebase...');
    await loadCurrentProject();   // sets refs.initialized = true di dalamnya
  } catch (error) {
    if (workspaceContext().type === 'group') {
      setWorkspaceContext({ type: 'personal' });
      localStorage.setItem('wcf_active_project', 'default');
      flash(`Workspace grup gagal dibuka: ${error?.message || error}`, false);
      setTimeout(() => void reloadMindmap(), 1800);
      return;
    }
    throw error;
  }
  refs.initialized = true;      // pastikan selalu true walau loadCurrentProject throw
  refs.dirty       = false;     // reset dirty setelah load awal
  renderTrash();
  if (context.type === 'group') {
    try {
      await startGroupCollaboration(context);
    } catch (error) {
      console.warn('[WCF] collaboration unavailable:', error);
      flash(`Realtime belum aktif: ${error?.message || error}`, false);
    }
  }
  // Trash toggle
  $id('btn-toggle-trash')?.addEventListener('click', () => {
    const list = $id('trash-list');
    const trigger = $id('btn-toggle-trash');
    if (!list) return;
    const open = list.style.display === 'none' || !list.style.display;
    list.style.display = open ? 'block' : 'none';
    trigger?.setAttribute('aria-expanded', String(open));
    if (open) renderTrash();
  });
  applyTransform();
  const zl = $id('zoom-label');
  if (zl) zl.textContent = '100%';
  // Expose applyData ke window agar admin workspace viewer bisa pakai
  window.wcfApplyData = applyData;
  hideLoadingShell();

  // Zoom presets
  const zoomLbl = $id('zoom-label');
  const zoomPresets = $id('zoom-presets');
  if (zoomLbl && zoomPresets) {
    zoomLbl.addEventListener('click', e => {
      e.stopPropagation();
      const showing = zoomPresets.style.display !== 'none';
      zoomPresets.style.display = showing ? 'none' : 'block';
    });
    document.querySelectorAll('.zoom-preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const z = parseFloat(btn.dataset.zoom);
        const cw = $c.offsetWidth || window.innerWidth;
        const ch = $c.offsetHeight || window.innerHeight;
        state.pan.x = cw / 2 - (cw / 2 - state.pan.x) / state.zoom * z;
        state.pan.y = ch / 2 - (ch / 2 - state.pan.y) / state.zoom * z;
        state.zoom = z;
        $cv.style.transition = 'transform 0.2s ease';
        applyTransform();
        setTimeout(() => { $cv.style.transition = ''; }, 220);
        zoomPresets.style.display = 'none';
      });
    });
    document.addEventListener('click', () => { if (zoomPresets) zoomPresets.style.display = 'none'; });
  }

  // File link Ctrl+click handler
  document.addEventListener('wcf:open-file-link', async e => {
    const { name } = e.detail;
    // Find file by name in workspace tree
    function findByName(node, nm) {
      if (!node) return null;
      if (node.type === 'file' && node.name === nm) return node.id;
      for (const c of node.children || []) { const r = findByName(c, nm); if (r) return r; }
      return null;
    }
    const fileId = findByName(refs.workspaceTree, name);
    if (fileId) {
      await switchProject(fileId);
      flash(`🔗 Membuka: ${name}`, true);
    } else {
      flash(`⚠ File "${name}" tidak ditemukan`, false);
    }
  });

  // Canvas background pattern toggle
  const bgPatterns = ['', 'bg-dots', 'bg-grid', 'bg-lines', 'bg-none'];
  const bgLabels   = ['Dots (default)', 'Dots besar', 'Grid', 'Garis', 'Kosong'];
  let bgIdx = 0;
  const bgBtn = $id('btn-canvas-bg');
  function setCanvasBackground(nextIdx) {
    $c.classList.remove(...bgPatterns.filter(Boolean));
    bgIdx = (nextIdx + bgPatterns.length) % bgPatterns.length;
    if (bgPatterns[bgIdx]) $c.classList.add(bgPatterns[bgIdx]);
    flash(`BG: ${bgLabels[bgIdx]}`, true);
    try { localStorage.setItem('wcf_canvas_bg', String(bgIdx)); } catch {}
  }
  if (bgBtn) {
    bgBtn.addEventListener('click', () => setCanvasBackground(bgIdx + 1));
    const savedBg = parseInt(localStorage.getItem('wcf_canvas_bg') || '0');
    if (savedBg && savedBg < bgPatterns.length) {
      bgIdx = savedBg;
      if (bgPatterns[bgIdx]) $c.classList.add(bgPatterns[bgIdx]);
    }
  }
  document.addEventListener('wcf:cmd', e => {
    const backgroundIndex = { 'bg-dots': 1, 'bg-grid': 2, 'bg-none': 4 }[e.detail];
    if (backgroundIndex !== undefined) setCanvasBackground(backgroundIndex);
  });

  // Snap to grid toggle
  const snapBtn = $id('btn-snap-grid');
  if (snapBtn) {
    snapBtn.addEventListener('click', () => {
      refs.snapGrid = !refs.snapGrid;
      snapBtn.style.color     = refs.snapGrid ? 'var(--accent)' : '';
      snapBtn.style.background = refs.snapGrid ? 'var(--accent-muted)' : '';
      flash(refs.snapGrid ? '⊞ Snap grid aktif' : '⊞ Snap grid nonaktif', true);
    });
  }

  // Sticky Note button
  $id('btn-sticky')?.addEventListener('click', () => {
    // Place sticky at center of current viewport
    const rect = $c.getBoundingClientRect();
    const cx = rect.left + rect.width  / 2;
    const cy = rect.top  + rect.height / 2;
    const p = toCanvas(cx, cy);
    createSticky(p.x, p.y);
    flash('🗒 Sticky note ditambahkan', true);
  });

  // Frame draw mode
  $id('btn-frame')?.addEventListener('click', () => {
    const active = toggleFrameDrawMode();
    if (active) flash('📐 Klik & drag di canvas untuk membuat frame. Tekan lagi untuk batal.', true);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && isFrameDrawMode()) toggleFrameDrawMode();
  });

  // Kanban view
  $id('btn-kanban')?.addEventListener('click', () => openKanban());

  // Command palette button
  $id('btn-cmd')?.addEventListener('click', () => openCmdPalette());

  // Import
  $id('btn-import-json')?.addEventListener('click', () => openImportDialog());

  // Export buttons not handled by ui/toolbar.js
  $id('btn-export-svg')?.addEventListener('click',  () => exportSVG());
  $id('btn-export-md')?.addEventListener('click',   () => exportMarkdown());
  $id('btn-export-pdf')?.addEventListener('click',  () => exportPDF());

  // Snapshot versi file (personal workspace)
  const LS_SNAPS = 'wcf_snaps_personal_';
  const MAX_SNAPS = 5;
  function getSnaps() {
    try { return JSON.parse(localStorage.getItem(LS_SNAPS + state.currentProject) || '[]'); } catch { return []; }
  }
  function saveSnap(label) {
    const data = JSON.stringify(snapshotData());
    let snaps = getSnaps();
    snaps.unshift({ ts: Date.now(), label: label || new Date().toLocaleTimeString(), data });
    if (snaps.length > MAX_SNAPS) snaps = snaps.slice(0, MAX_SNAPS);
    try { localStorage.setItem(LS_SNAPS + state.currentProject, JSON.stringify(snaps)); } catch { flash('⚠ Snapshot terlalu besar', false); }
  }
  function renderSnapPanel() {
    const snaps = getSnaps();
    const list  = $id('snap-list');
    const empty = $id('snap-empty');
    if (!list) return;
    list.querySelectorAll('.snap-row').forEach(r => r.remove());
    if (!snaps.length) { if (empty) empty.style.display = 'block'; return; }
    if (empty) empty.style.display = 'none';
    for (const snap of snaps) {
      const row = document.createElement('div');
      row.className = 'snap-row';
      const d = new Date(snap.ts);
      const timeStr = d.toLocaleDateString('id') + ' ' + d.toLocaleTimeString('id', { hour:'2-digit', minute:'2-digit' });
      const escLabel = String(snap.label ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      row.innerHTML = `<span class="snap-label">${escLabel}</span><span class="snap-time">${timeStr}</span><button class="snap-restore">Pulihkan</button>`;
      row.querySelector('.snap-restore')?.addEventListener('click', async e => {
        e.stopPropagation();
        if (!confirm(`Pulihkan snapshot "${snap.label}"? Canvas saat ini akan diganti.`)) return;
        const d2 = JSON.parse(snap.data);
        refs.initialized = false;
        applyData(d2);
        refs.initialized = true; refs.dirty = true;
        flash(`✓ Dipulihkan: ${snap.label}`, true);
        $id('snap-panel')?.classList.add('hidden');
      });
      list.appendChild(row);
    }
  }
  $id('btn-snapshot')?.addEventListener('click', () => {
    const panel = $id('snap-panel');
    panel?.classList.toggle('hidden');
    if (!panel?.classList.contains('hidden')) renderSnapPanel();
  });
  $id('snap-panel-close')?.addEventListener('click', () => $id('snap-panel')?.classList.add('hidden'));
  $id('snap-save-btn')?.addEventListener('click', () => {
    const label = prompt('Nama snapshot:', new Date().toLocaleString('id'));
    if (!label?.trim()) return;
    saveSnap(label.trim());
    renderSnapPanel();
    flash('✓ Snapshot disimpan', true);
  });

  // ── Sidebar resize drag ──────────────────────────────────────
  (function initSidebarResize() {
    const handle  = document.getElementById('sidebar-resize');
    const sidebar = document.getElementById('sidebar');
    if (!handle || !sidebar) return;
    let dragging = false, startX = 0, startW = 0;
    handle.addEventListener('mousedown', e => {
      dragging = true; startX = e.clientX; startW = sidebar.offsetWidth;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });
    window.addEventListener('mousemove', e => {
      if (!dragging) return;
      const w = Math.min(340, Math.max(160, startW + (e.clientX - startX)));
      sidebar.style.width = w + 'px';
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });
  })();

  // ── Empty canvas state ───────────────────────────────────────
  const $emptyState = document.getElementById('empty-canvas-state');
  function updateEmptyState() {
    if (!$emptyState) return;
    const empty = Object.keys(state.nodes).length === 0;
    $emptyState.hidden = !empty;
    $emptyState.setAttribute('aria-hidden', empty ? 'false' : 'true');
    $emptyState.style.opacity     = empty ? '1' : '0';
    $emptyState.style.pointerEvents = empty ? 'none' : 'none'; // always none
  }
  window.wcfUpdateEmptyState = updateEmptyState;
  updateEmptyState();

  flash('👋 WAN Case Flow siap!', true);
  console.log('[WCF] app init complete, nodes:', Object.keys(state.nodes).length);

  // ── Mobile sidebar overlay ──────────────────────────────────
  // Tombol #btn-toggle-sidebar sudah ada di toolbar;
  // di layar kecil kita tambahkan overlay backdrop agar bisa tap-to-close.
  (function initMobileSidebar() {
    const sidebar = document.getElementById('sidebar');
    const toggle  = document.getElementById('btn-toggle-sidebar');
    if (!sidebar || !toggle) return;
    const backdrop = document.createElement('div');
    backdrop.className = 'mobile-sidebar-backdrop';
    backdrop.hidden = true;
    document.body.appendChild(backdrop);
    const setOpen = open => {
      sidebar.classList.toggle('mobile-open', open);
      backdrop.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
    };
    // Wrap existing click: kalau mobile (< 768px), pakai overlay mode
    toggle.addEventListener('click', () => {
      if (window.innerWidth > 768) return; // biarkan existing handler jalan di desktop
      setOpen(!sidebar.classList.contains('mobile-open'));
    }, true); // capture: true agar jalan sebelum existing listener
    backdrop.addEventListener('click', () => setOpen(false));
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && sidebar.classList.contains('mobile-open')) setOpen(false);
    });
    // Tutup sidebar mobile saat resize ke desktop
    window.addEventListener('resize', () => {
      if (window.innerWidth > 768) {
        setOpen(false);
      }
    });
  })();
}

init().catch(error => {
  console.error('[WCF] init failed:', error);
  updateLoadingShell(error?.message || 'Workspace gagal dimuat.');
  window.setTimeout(() => hideLoadingShell(), 1600);
});
