// ── js/ui/ctx-menu.js ────────────────────────────────────────
import { state, ui, $id, pushUndo, refs }    from '../state.js';
import { renderLines, syncColors,
         deleteConnection, hideConnCtx,
         editConnLabelById }                    from '../canvas/connection.js';
import { flash }                               from './flash.js';

// Lazily import applyNodeStyle to avoid circular dep (node.js → ctx-menu.js)
async function _applyNodeStyle(id) {
  const { applyNodeStyle } = await import('../canvas/node.js');
  applyNodeStyle(id);
}

const $ctx = () => $id('ctx-menu');

export function showCtxMenu(x, y, nodeId) {
  ui.ctxTarget = nodeId;
  const m = $ctx();
  m.style.left = Math.min(x, innerWidth  - 220) + 'px';
  m.style.top  = Math.min(y, innerHeight - 320) + 'px';
  m.classList.remove('hidden');
  // Reset to first tab (Tampilan) on every open
  document.querySelectorAll('#ctx-menu .ctx-tab-btn').forEach((b,i) => b.classList.toggle('active', i === 0));
  document.querySelectorAll('#ctx-menu .ctx-tab-panel').forEach((p,i) => p.classList.toggle('hidden', i !== 0));
  // Sync pickers & labels to current node values
  const n = state.nodes[nodeId];
  const picker = $id('ctx-color-pick');
  if (picker && n?.customColor) picker.value = n.customColor;
  const txtPicker = $id('ctx-text-color-pick');
  if (txtPicker) txtPicker.value = n?.textColor || '#ffffff';
  const pinEl = $id('ctx-pin');
  if (pinEl) pinEl.textContent = n?.pinned ? '📌 Lepas Pin' : '📌 Pin Node';
  // Highlight active shape button
  const currentShape = n?.shape ?? '';
  document.querySelectorAll('#ctx-shape-grid [data-shape]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.shape === currentShape);
  });
  // Highlight active emoji button
  const currentEmoji = n?.emoji ?? '';
  document.querySelectorAll('.ctx-emoji-btn').forEach(btn => {
    btn.style.outline = btn.dataset.emoji === currentEmoji && currentEmoji !== '' ? '1px solid var(--accent)' : '';
  });
  // Highlight active status button
  const currentStatus = n?.status ?? '';
  const statusIds = { '': 'ctx-status-none', 'todo': 'ctx-status-todo', 'progress': 'ctx-status-progress', 'done': 'ctx-status-done' };
  Object.entries(statusIds).forEach(([val, id]) => {
    const btn = $id(id);
    if (btn) btn.style.outline = val === currentStatus ? '1px solid var(--accent)' : '';
  });
  // Highlight active border button
  const currentBorder = n?.borderStyle ?? 'solid';
  const borderIds = { solid: 'ctx-border-solid', dashed: 'ctx-border-dashed', dotted: 'ctx-border-dotted', none: 'ctx-border-none' };
  Object.entries(borderIds).forEach(([val, bid]) => {
    const b = $id(bid);
    if (b) b.style.color = val === currentBorder ? 'var(--accent)' : '';
  });
  // Highlight active align button
  const currentAlign = n?.textAlign ?? 'left';
  document.querySelectorAll('.ctx-align-btn').forEach(btn => {
    const val = btn.id.replace('ctx-align-', '');
    btn.classList.toggle('active', val === currentAlign);
    btn.style.color = val === currentAlign ? 'var(--accent)' : '';
    btn.style.background = val === currentAlign ? 'var(--accent-muted)' : '';
  });
}

export function hideCtxMenu() {
  $ctx().classList.add('hidden');
  ui.ctxTarget = null;
}

export function initCtxMenu() {
  // Delete node (dynamic import to break circular dep)
  $id('ctx-delete')?.addEventListener('pointerdown', async event => {
    event.preventDefault();
    event.stopPropagation();
    const id = ui.ctxTarget;
    hideCtxMenu();
    if (id) {
      const { deleteNode } = await import('../canvas/node.js');
      deleteNode(id);
    }
  });

  // Disconnect all
  $id('ctx-disconnect')?.addEventListener('click', () => {
    if (!ui.ctxTarget) { hideCtxMenu(); return; }
    pushUndo();
    const id = ui.ctxTarget;
    state.connections = state.connections.filter(c => c.from !== id && c.to !== id);
    for (const nid in state.nodes) {
      state.nodes[nid].children = (state.nodes[nid].children || []).filter(c => c !== id);
    }
    syncColors(); renderLines();
    hideCtxMenu();
  });

  // Color: clicking the row triggers the hidden color input
  $id('ctx-color')?.addEventListener('click', () => {
    // keep menu open so user can pick color
    $id('ctx-color-pick')?.click();
  });

  $id('ctx-color-pick')?.addEventListener('input', e => {
    if (!ui.ctxTarget) return;
    const n = state.nodes[ui.ctxTarget];
    if (!n) return;
    n.customColor = e.target.value;
    syncColors();
    refs.dirty = true;
  });
  $id('ctx-color-pick')?.addEventListener('change', () => {
    pushUndo();
    hideCtxMenu();
  });

  // Reset color
  $id('ctx-reset-color')?.addEventListener('click', () => {
    if (ui.ctxTarget) {
      pushUndo();
      delete state.nodes[ui.ctxTarget].customColor;
      syncColors();
      refs.dirty = true;
    }
    hideCtxMenu();
  });

  // Note toggle
  $id('ctx-note')?.addEventListener('click', () => {
    const id = ui.ctxTarget; hideCtxMenu();
    if (!id) return;
    const el   = document.getElementById('node-' + id);
    const note = el?.querySelector('.node-note');
    if (note) {
      const wasHidden = note.style.display === 'none' || !note.style.display;
      note.style.display   = wasHidden ? 'block' : 'none';
      if (wasHidden) {
        note.contentEditable = 'true';
        note.focus();
        const range = document.createRange(), sel = window.getSelection();
        range.selectNodeContents(note); sel.removeAllRanges(); sel.addRange(range);
      }
    }
  });

  // ── Node text color ──────────────────────────────────────────
  $id('ctx-text-color')?.addEventListener('click', () => {
    $id('ctx-text-color-pick')?.click();
  });
  $id('ctx-text-color-pick')?.addEventListener('input', e => {
    if (!ui.ctxTarget) return;
    const n = state.nodes[ui.ctxTarget];
    if (!n) return;
    n.textColor = e.target.value;
    _applyNodeStyle(ui.ctxTarget);
    refs.dirty = true;
  });
  $id('ctx-text-color-pick')?.addEventListener('change', () => {
    pushUndo(); hideCtxMenu();
  });
  $id('ctx-reset-text-color')?.addEventListener('click', () => {
    if (ui.ctxTarget) {
      pushUndo();
      delete state.nodes[ui.ctxTarget].textColor;
      _applyNodeStyle(ui.ctxTarget);
      refs.dirty = true;
    }
    hideCtxMenu();
  });

  // ── Font size ────────────────────────────────────────────────
  ['sm','md','lg','xl'].forEach(size => {
    $id(`ctx-fs-${size}`)?.addEventListener('click', () => {
      if (!ui.ctxTarget) { hideCtxMenu(); return; }
      pushUndo();
      const n = state.nodes[ui.ctxTarget];
      if (!n) { hideCtxMenu(); return; }
      n.fontSize = size === 'md' ? undefined : size;
      if (size === 'md') delete n.fontSize;
      _applyNodeStyle(ui.ctxTarget);
      refs.dirty = true;
      hideCtxMenu();
    });
  });

  // ── Node shape (grid picker) ──────────────────────────────────
  document.querySelectorAll('#ctx-shape-grid [data-shape]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!ui.ctxTarget) { hideCtxMenu(); return; }
      pushUndo();
      const n = state.nodes[ui.ctxTarget];
      if (!n) { hideCtxMenu(); return; }
      const shape = btn.dataset.shape; // '' = default (no shape class)
      if (shape) n.shape = shape;
      else delete n.shape;
      _applyNodeStyle(ui.ctxTarget);
      refs.dirty = true;
      hideCtxMenu();
    });
  });

  // ── Text alignment ───────────────────────────────────────────
  ['left','center','right','justify'].forEach(align => {
    $id(`ctx-align-${align}`)?.addEventListener('click', () => {
      if (!ui.ctxTarget) { hideCtxMenu(); return; }
      pushUndo();
      const n = state.nodes[ui.ctxTarget];
      if (!n) { hideCtxMenu(); return; }
      n.textAlign = align;
      _applyNodeStyle(ui.ctxTarget);
      refs.dirty = true;
      hideCtxMenu();
    });
  });

  // ── Emoji picker ─────────────────────────────────────────────
  document.querySelectorAll('.ctx-emoji-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!ui.ctxTarget) { hideCtxMenu(); return; }
      pushUndo();
      const n = state.nodes[ui.ctxTarget];
      if (!n) { hideCtxMenu(); return; }
      const emoji = btn.dataset.emoji;
      if (emoji) n.emoji = emoji;
      else delete n.emoji;
      _applyNodeStyle(ui.ctxTarget);
      refs.dirty = true;
      hideCtxMenu();
    });
  });

  // ── Status node ─────────────────────────────────────────────
  const STATUS_MAP = { 'ctx-status-none': null, 'ctx-status-todo': 'todo', 'ctx-status-progress': 'progress', 'ctx-status-done': 'done' };
  Object.entries(STATUS_MAP).forEach(([btnId, status]) => {
    $id(btnId)?.addEventListener('click', () => {
      if (!ui.ctxTarget) { hideCtxMenu(); return; }
      pushUndo();
      const n = state.nodes[ui.ctxTarget];
      if (!n) { hideCtxMenu(); return; }
      if (status) n.status = status;
      else delete n.status;
      _applyNodeStyle(ui.ctxTarget);
      refs.dirty = true;
      hideCtxMenu();
    });
  });

  // ── Link ke file lain ───────────────────────────────────────
  $id('ctx-file-link')?.addEventListener('click', async () => {
    const id = ui.ctxTarget; hideCtxMenu();
    if (!id) return;
    const n = state.nodes[id];
    if (!n) return;
    // Show simple prompt for file name/id
    const { wcfPrompt } = await import('./modal.js');
    const current = n.fileLink || '';
    const val = await wcfPrompt(
      current
        ? `Link file saat ini: "${current}"\n\nKetik nama file baru (kosongkan untuk hapus link):`
        : 'Ketik nama file yang ingin dituju (misalnya "Proyek Alpha"):',
      current
    );
    if (val === null) return; // cancelled
    pushUndo();
    if (val.trim()) n.fileLink = val.trim();
    else delete n.fileLink;
    _applyNodeStyle(id);
    refs.dirty = true;
    flash(val.trim() ? `🔗 Link ke "${val.trim()}"` : '🔗 Link dihapus', true);
  });

  // ── Due Date ────────────────────────────────────────────────
  $id('ctx-due-date')?.addEventListener('click', async () => {
    const id = ui.ctxTarget; hideCtxMenu();
    if (!id) return;
    const n = state.nodes[id];
    if (!n) return;
    const { wcfPrompt } = await import('./modal.js');
    const current = n.dueDate || '';
    const val = await wcfPrompt('Tenggat waktu (YYYY-MM-DD, kosongkan untuk hapus):', current);
    if (val === null) return;
    pushUndo();
    if (val.trim()) n.dueDate = val.trim();
    else delete n.dueDate;
    _applyNodeStyle(id);
    refs.dirty = true;
    flash(val.trim() ? `📅 Due: ${val.trim()}` : '📅 Due date dihapus', true);
  });

  // ── Tags ─────────────────────────────────────────────────────
  $id('ctx-tags')?.addEventListener('click', async () => {
    const id = ui.ctxTarget; hideCtxMenu();
    if (!id) return;
    const n = state.nodes[id];
    if (!n) return;
    const { wcfPrompt } = await import('./modal.js');
    const current = (n.tags || []).join(', ');
    const val = await wcfPrompt('Tags (pisahkan dengan koma, kosongkan untuk hapus semua):', current);
    if (val === null) return;
    pushUndo();
    const tags = val.split(',').map(t => t.trim()).filter(Boolean);
    if (tags.length) n.tags = tags;
    else delete n.tags;
    _applyNodeStyle(id);
    refs.dirty = true;
    flash(tags.length ? `🏷 Tags: ${tags.join(', ')}` : '🏷 Tags dihapus', true);
  });

  // ── Checklist ────────────────────────────────────────────────
  $id('ctx-checklist')?.addEventListener('click', async () => {
    const id = ui.ctxTarget; hideCtxMenu();
    if (!id) return;
    const n = state.nodes[id];
    if (!n) return;
    const { wcfPrompt } = await import('./modal.js');
    const current = (n.checklist || []).map(c => (c.done ? '[x] ' : '[ ] ') + c.text).join('\n');
    const val = await wcfPrompt(
      'Checklist items (satu per baris, awali dengan [x] jika selesai):\n\nContoh:\n[ ] Buat desain\n[x] Review brief',
      current
    );
    if (val === null) return;
    pushUndo();
    const items = val.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
      const done = /^\[x\]/i.test(line);
      const text = line.replace(/^\[.\]\s*/, '').trim();
      return { text, done };
    }).filter(c => c.text);
    if (items.length) n.checklist = items;
    else delete n.checklist;
    _applyNodeStyle(id);
    refs.dirty = true;
    flash(items.length ? `☑ ${items.length} item checklist` : '☑ Checklist dihapus', true);
  });

  // ── Border style ─────────────────────────────────────────────
  const BORDER_MAP = { 'ctx-border-solid': 'solid', 'ctx-border-dashed': 'dashed', 'ctx-border-dotted': 'dotted', 'ctx-border-none': 'none' };
  Object.entries(BORDER_MAP).forEach(([btnId, style]) => {
    $id(btnId)?.addEventListener('click', () => {
      if (!ui.ctxTarget) { hideCtxMenu(); return; }
      pushUndo();
      const n = state.nodes[ui.ctxTarget];
      if (!n) { hideCtxMenu(); return; }
      if (style === 'solid') delete n.borderStyle;
      else n.borderStyle = style;
      _applyNodeStyle(ui.ctxTarget);
      refs.dirty = true;
      hideCtxMenu();
    });
  });

  // ── Pin node ────────────────────────────────────────────────
  $id('ctx-pin')?.addEventListener('click', () => {
    if (!ui.ctxTarget) { hideCtxMenu(); return; }
    pushUndo();
    const n = state.nodes[ui.ctxTarget];
    if (!n) { hideCtxMenu(); return; }
    n.pinned = !n.pinned;
    if (!n.pinned) delete n.pinned;
    _applyNodeStyle(ui.ctxTarget);
    flash(n.pinned ? '📌 Node dipin' : '📌 Pin dilepas', true);
    refs.dirty = true;
    hideCtxMenu();
  });

  // Tab switching
  $ctx()?.addEventListener('click', e => {
    const tab = e.target.closest('.ctx-tab-btn');
    if (!tab) return;
    const name = tab.dataset.tab;
    document.querySelectorAll('#ctx-menu .ctx-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('#ctx-menu .ctx-tab-panel').forEach(p => p.classList.toggle('hidden', p.dataset.panel !== name));
  });

  // Stop all clicks inside the menu from bubbling — prevents the outside-click
  // handler from firing on legitimate in-menu interactions
  $ctx()?.addEventListener('click', e => e.stopPropagation());

  // Close on outside click (only reaches here because of stopPropagation above)
  document.addEventListener('click', e => {
    const m = $ctx();
    if (m && !m.classList.contains('hidden') && !m.contains(e.target)) hideCtxMenu();
  });

  // ── Connection color ─────────────────────────────────────────
  $id('conn-ctx-color')?.addEventListener('click', () => {
    $id('conn-ctx-color-pick')?.click();
  });
  $id('conn-ctx-color-pick')?.addEventListener('input', e => {
    if (!ui.connCtx) return;
    const conn = state.connections.find(c => c.from === ui.connCtx.from && c.to === ui.connCtx.to);
    if (!conn) return;
    conn.color = e.target.value;
    refs.dirty = true;
    renderLines();
  });
  $id('conn-ctx-color-pick')?.addEventListener('change', () => {
    pushUndo(); hideConnCtx();
  });
  $id('conn-ctx-reset-color')?.addEventListener('click', () => {
    if (ui.connCtx) {
      pushUndo();
      const conn = state.connections.find(c => c.from === ui.connCtx.from && c.to === ui.connCtx.to);
      if (conn) { delete conn.color; refs.dirty = true; renderLines(); }
    }
    hideConnCtx();
  });

  // ── Connection ctx menu ──────────────────────────────────────
  $id('conn-ctx-delete')?.addEventListener('click', () => {
    if (ui.connCtx) deleteConnection(ui.connCtx.from, ui.connCtx.to);
    hideConnCtx();
  });

  $id('conn-ctx-label')?.addEventListener('click', () => {
    if (ui.connCtx) editConnLabelById(ui.connCtx.from, ui.connCtx.to);
    hideConnCtx();
  });

  $id('conn-ctx-style')?.addEventListener('click', e => {
    showStylePicker(e.clientX, e.clientY);
    hideConnCtx();
  });

  // Style picker buttons
  document.querySelectorAll('.conn-style-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const style = btn.dataset.style;
      if (ui.connCtx) {
        const conn = state.connections.find(c => c.from === ui.connCtx.from && c.to === ui.connCtx.to);
        if (conn) { pushUndo(); conn.style = style; renderLines(); refs.dirty = true; }
      }
      hideStylePicker();
    });
  });

  // Stop propagation inside conn-ctx and style-picker too
  $id('conn-ctx')?.addEventListener('click', e => e.stopPropagation());
  $id('conn-style-picker')?.addEventListener('click', e => e.stopPropagation());

  document.addEventListener('click', e => {
    const m = $id('conn-ctx');
    if (m && !m.classList.contains('hidden') && !m.contains(e.target)) hideConnCtx();
    const sp = $id('conn-style-picker');
    if (sp && !sp.classList.contains('hidden') && !sp.contains(e.target)) hideStylePicker();
  });
}

function showStylePicker(x, y) {
  const sp = $id('conn-style-picker');
  if (!sp) return;
  sp.style.left = Math.min(x, innerWidth  - 180) + 'px';
  sp.style.top  = Math.min(y, innerHeight - 160) + 'px';
  sp.classList.remove('hidden');
}
function hideStylePicker() {
  $id('conn-style-picker')?.classList.add('hidden');
}
