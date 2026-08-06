// ── js/features/frames.js — Canvas sections/frames ───────────
import { state, refs, pushUndo } from '../state.js';

const FRAME_COLORS = [
  { bg: 'rgba(139,124,248,0.06)', stroke: 'rgba(139,124,248,0.35)', label: '#a5b4fc' },
  { bg: 'rgba(14,165,233,0.06)',  stroke: 'rgba(14,165,233,0.35)',  label: '#7dd3fc' },
  { bg: 'rgba(16,185,129,0.06)',  stroke: 'rgba(16,185,129,0.35)',  label: '#6ee7b7' },
  { bg: 'rgba(245,158,11,0.06)',  stroke: 'rgba(245,158,11,0.35)',  label: '#fcd34d' },
  { bg: 'rgba(236,72,153,0.06)',  stroke: 'rgba(236,72,153,0.35)',  label: '#f9a8d4' },
];

let _drawMode  = false;
let _drawStart = null;
let _drawEl    = null;   // preview div
let _ctxFrame  = null;   // frame id for context menu

function _canvasEl() { return document.getElementById('canvas'); }
function _frameLayer() { return document.getElementById('frame-layer'); }

// ── Rendering ────────────────────────────────────────────────
export function renderFrames() {
  const layer = _frameLayer();
  if (!layer) return;
  layer.innerHTML = '';
  const { zoom, pan } = state;
  for (const id in (state.frames || {})) {
    const f  = state.frames[id];
    const c  = FRAME_COLORS[f.colorIdx ?? 0];
    // Frame coords are canvas-space; layer is the same canvas div
    const el = document.createElement('div');
    el.id               = 'frame-' + id;
    el.className        = 'canvas-frame';
    el.dataset.frameId  = id;
    el.style.cssText    = `
      position:absolute;
      left:${f.x}px; top:${f.y}px;
      width:${f.w}px; height:${f.h}px;
      background:${c.bg};
      border:2px solid ${c.stroke};
      border-radius:10px;
      pointer-events:all;
      box-sizing:border-box;
    `;
    // Label
    const lbl = document.createElement('div');
    lbl.className = 'canvas-frame-label';
    lbl.textContent = f.label || 'Frame';
    lbl.style.cssText = `
      position:absolute;top:-22px;left:6px;
      font-size:11px;font-weight:600;
      color:${c.label};
      background:${c.bg.replace('0.06','0.5')};
      border:1px solid ${c.stroke};
      padding:1px 7px;border-radius:4px;
      cursor:default;white-space:nowrap;
      backdrop-filter:blur(4px);
    `;
    // Edit label on double-click
    lbl.addEventListener('dblclick', () => {
      const v = prompt('Nama frame:', f.label || 'Frame');
      if (v !== null) { pushUndo(); f.label = v; refs.dirty = true; renderFrames(); }
    });
    el.appendChild(lbl);
    // Right-click context on frame body
    el.addEventListener('contextmenu', e => {
      e.preventDefault(); e.stopPropagation();
      _showFrameCtx(id, e.clientX, e.clientY);
    });
    layer.appendChild(el);
  }
}

// ── Frame context menu ───────────────────────────────────────
function _showFrameCtx(id, x, y) {
  let ctx = document.getElementById('frame-ctx');
  if (!ctx) {
    ctx = document.createElement('div');
    ctx.id = 'frame-ctx';
    ctx.className = 'ctx-menu';
    ctx.style.cssText = 'z-index:150;min-width:160px;position:fixed';
    ctx.innerHTML = `
      <div id="fctx-rename" class="px-3 py-1.5 text-xs text-white/60 hover:bg-white/[0.07] hover:text-white cursor-pointer transition">✏️ Ganti Nama</div>
      <div id="fctx-color"  class="px-3 py-1.5 text-xs text-white/60 hover:bg-white/[0.07] hover:text-white cursor-pointer transition">🎨 Ganti Warna</div>
      <div class="h-px bg-white/[0.06] mx-2 my-0.5"></div>
      <div id="fctx-delete" class="px-3 py-1.5 text-xs text-red-400/70 hover:bg-red-500/10 hover:text-red-400 cursor-pointer transition">🗑 Hapus Frame</div>`;
    document.body.appendChild(ctx);
    ctx.addEventListener('click', e => e.stopPropagation());
    document.getElementById('fctx-rename')?.addEventListener('click', () => {
      ctx.classList.add('hidden');
      const f = state.frames?.[_ctxFrame];
      if (!f) return;
      const v = prompt('Nama frame:', f.label || 'Frame');
      if (v !== null) { pushUndo(); f.label = v; refs.dirty = true; renderFrames(); }
    });
    document.getElementById('fctx-color')?.addEventListener('click', () => {
      ctx.classList.add('hidden');
      const f = state.frames?.[_ctxFrame];
      if (!f) return;
      pushUndo();
      f.colorIdx = ((f.colorIdx ?? 0) + 1) % FRAME_COLORS.length;
      refs.dirty = true; renderFrames();
    });
    document.getElementById('fctx-delete')?.addEventListener('click', () => {
      ctx.classList.add('hidden');
      if (!_ctxFrame || !state.frames) return;
      pushUndo();
      delete state.frames[_ctxFrame];
      refs.dirty = true; renderFrames();
    });
  }
  _ctxFrame = id;
  ctx.style.left = Math.min(x, innerWidth - 170) + 'px';
  ctx.style.top  = Math.min(y, innerHeight - 120) + 'px';
  ctx.classList.remove('hidden');
}

// ── Draw mode ────────────────────────────────────────────────
export function toggleFrameDrawMode() {
  _drawMode = !_drawMode;
  const btn = document.getElementById('btn-frame');
  if (btn) btn.classList.toggle('active', _drawMode);
  const cv  = _canvasEl();
  if (!cv) return;
  cv.style.cursor = _drawMode ? 'crosshair' : '';
  return _drawMode;
}

export function isFrameDrawMode() { return _drawMode; }

export function handleFrameMouseDown(e, canvasX, canvasY) {
  if (!_drawMode) return false;
  _drawStart = { x: canvasX, y: canvasY };
  _drawEl    = document.createElement('div');
  _drawEl.style.cssText = `
    position:absolute;left:${canvasX}px;top:${canvasY}px;width:0;height:0;
    border:2px dashed rgba(139,124,248,0.7);border-radius:8px;
    background:rgba(139,124,248,0.05);pointer-events:none;box-sizing:border-box;z-index:5`;
  _frameLayer()?.appendChild(_drawEl);
  return true;
}

export function handleFrameMouseMove(canvasX, canvasY) {
  if (!_drawMode || !_drawStart || !_drawEl) return;
  const x = Math.min(_drawStart.x, canvasX);
  const y = Math.min(_drawStart.y, canvasY);
  const w = Math.abs(canvasX - _drawStart.x);
  const h = Math.abs(canvasY - _drawStart.y);
  _drawEl.style.left   = x + 'px';
  _drawEl.style.top    = y + 'px';
  _drawEl.style.width  = w + 'px';
  _drawEl.style.height = h + 'px';
}

export function handleFrameMouseUp(canvasX, canvasY) {
  if (!_drawMode || !_drawStart) return false;
  _drawEl?.remove();
  _drawEl = null;
  const x = Math.min(_drawStart.x, canvasX);
  const y = Math.min(_drawStart.y, canvasY);
  const w = Math.abs(canvasX - _drawStart.x);
  const h = Math.abs(canvasY - _drawStart.y);
  _drawStart = null;
  if (w < 40 || h < 30) return true; // too small, ignore
  pushUndo();
  if (!state.frames) state.frames = {};
  if (!state.nextFrameId) state.nextFrameId = 1;
  const id = 'f' + (state.nextFrameId++);
  state.frames[id] = { id, x, y, w, h, label: 'Frame', colorIdx: 0 };
  refs.dirty = true;
  renderFrames();
  // Exit draw mode after creating a frame
  toggleFrameDrawMode();
  return true;
}

export function initFrames() {
  // Close frame ctx on outside click
  document.addEventListener('click', () => {
    document.getElementById('frame-ctx')?.classList.add('hidden');
  });
}
