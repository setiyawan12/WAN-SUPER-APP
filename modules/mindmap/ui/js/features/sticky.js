// ── js/features/sticky.js — Sticky note canvas annotations ───
import { state, refs, hist, pushUndo, snapshot, $cv } from '../state.js';

const STICKY_COLORS = ['#fef08a','#86efac','#93c5fd','#f9a8d4','#fda4af','#fdba74'];
const MIN_W = 140, MIN_H = 80;

// ── Render all stickies from state ───────────────────────────
export function renderStickies() {
  // Remove all existing sticky DOM elements
  document.querySelectorAll('.sticky-note').forEach(el => el.remove());
  for (const id in state.stickies) {
    _buildStickyEl(state.stickies[id]);
  }
}

// ── Build DOM element for one sticky ─────────────────────────
function _buildStickyEl(sticky) {
  const el = document.createElement('div');
  el.className = 'sticky-note';
  el.id = 'sticky-' + sticky.id;
  el.style.left   = sticky.x + 'px';
  el.style.top    = sticky.y + 'px';
  el.style.width  = (sticky.w || 160) + 'px';
  el.style.minHeight = (sticky.h || 100) + 'px';
  el.style.background = sticky.color || STICKY_COLORS[0];

  // Header toolbar
  const hdr = document.createElement('div');
  hdr.className = 'sticky-hdr';

  // Color dots
  const dots = document.createElement('div');
  dots.className = 'sticky-colors';
  STICKY_COLORS.forEach(c => {
    const d = document.createElement('button');
    d.className = 'sticky-dot';
    d.style.background = c;
    d.title = c;
    d.addEventListener('click', e => { e.stopPropagation(); _setColor(sticky.id, c); });
    dots.appendChild(d);
  });

  // Delete button
  const del = document.createElement('button');
  del.className = 'sticky-del';
  del.textContent = '×';
  del.title = 'Hapus sticky note';
  del.addEventListener('click', e => { e.stopPropagation(); deleteSticky(sticky.id); });

  hdr.appendChild(dots);
  hdr.appendChild(del);

  // Textarea
  const ta = document.createElement('textarea');
  ta.className = 'sticky-text';
  ta.placeholder = 'Catatan…';
  ta.value = sticky.text || '';
  ta.spellcheck = false;
  ta.addEventListener('input', () => {
    state.stickies[sticky.id].text = ta.value;
    refs.dirty = true;
  });
  ta.addEventListener('mousedown', e => e.stopPropagation());

  el.appendChild(hdr);
  el.appendChild(ta);

  // Drag handle (header)
  _makeDraggable(el, hdr, sticky.id);

  // Resize handle
  const rsz = document.createElement('div');
  rsz.className = 'sticky-resize';
  rsz.addEventListener('mousedown', e => _startResize(e, el, sticky.id));
  el.appendChild(rsz);

  $cv.appendChild(el);
}

// ── Drag ─────────────────────────────────────────────────────
function _makeDraggable(el, handle, stickyId) {
  handle.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const zoom = state.zoom;
    const startMX = e.clientX, startMY = e.clientY;
    const startX = state.stickies[stickyId].x;
    const startY = state.stickies[stickyId].y;
    const beforeSnap = snapshot();
    let moved = false;

    function onMove(ev) {
      moved = true;
      const dx = (ev.clientX - startMX) / zoom;
      const dy = (ev.clientY - startMY) / zoom;
      let nx = startX + dx, ny = startY + dy;
      if (refs.snapGrid) {
        nx = Math.round(nx / refs.snapSize) * refs.snapSize;
        ny = Math.round(ny / refs.snapSize) * refs.snapSize;
      }
      state.stickies[stickyId].x = nx;
      state.stickies[stickyId].y = ny;
      el.style.left = nx + 'px';
      el.style.top  = ny + 'px';
      refs.dirty = true;
    }
    function onUp() {
      if (moved) {
        hist.undo.push(beforeSnap);
        if (hist.undo.length > hist.MAX) hist.undo.shift();
        hist.redo = [];
      }
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ── Resize ────────────────────────────────────────────────────
function _startResize(e, el, stickyId) {
  e.preventDefault(); e.stopPropagation();
  const zoom = state.zoom;
  const startMX = e.clientX, startMY = e.clientY;
  const startW = state.stickies[stickyId].w || 160;
  const startH = state.stickies[stickyId].h || 100;
  const beforeSnap = snapshot();
  let resized = false;

  function onMove(ev) {
    resized = true;
    const dw = (ev.clientX - startMX) / zoom;
    const dh = (ev.clientY - startMY) / zoom;
    const nw = Math.max(MIN_W, startW + dw);
    const nh = Math.max(MIN_H, startH + dh);
    state.stickies[stickyId].w = nw;
    state.stickies[stickyId].h = nh;
    el.style.width     = nw + 'px';
    el.style.minHeight = nh + 'px';
    refs.dirty = true;
  }
  function onUp() {
    if (resized) {
      hist.undo.push(beforeSnap);
      if (hist.undo.length > hist.MAX) hist.undo.shift();
      hist.redo = [];
    }
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// ── Color change ──────────────────────────────────────────────
function _setColor(id, color) {
  pushUndo();
  state.stickies[id].color = color;
  const el = document.getElementById('sticky-' + id);
  if (el) el.style.background = color;
  refs.dirty = true;
}

// ── Create sticky at canvas coords ───────────────────────────
export function createSticky(canvasX, canvasY) {
  pushUndo();
  const id = 's' + state.nextStickyId++;
  const sticky = { id, x: canvasX - 80, y: canvasY - 50, text: '', color: STICKY_COLORS[0], w: 160, h: 100 };
  state.stickies[id] = sticky;
  _buildStickyEl(sticky);
  refs.dirty = true;
  // Focus textarea
  setTimeout(() => {
    document.getElementById('sticky-' + id)?.querySelector('.sticky-text')?.focus();
  }, 50);
}

// ── Delete ────────────────────────────────────────────────────
export function deleteSticky(id) {
  pushUndo();
  delete state.stickies[id];
  document.getElementById('sticky-' + id)?.remove();
  refs.dirty = true;
}
