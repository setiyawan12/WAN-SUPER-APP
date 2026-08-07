// ── js/ui/minimap.js ─────────────────────────────────────────
import { state, $c } from '../state.js';
import { applyTransform } from '../canvas/transform.js';

const CANVAS_SIZE = 6000;
let _canvas, _ctx, _wrap;

export function initMinimap() {
  _canvas = document.getElementById('minimap');
  _wrap   = document.getElementById('minimap-wrap');
  if (!_canvas) return;
  _ctx = _canvas.getContext('2d');
  _canvas.addEventListener('click', onMinimapClick);
  document.getElementById('btn-minimap')?.addEventListener('click', () => {
    _wrap?.classList.toggle('hidden');
    if (_wrap && !_wrap.classList.contains('hidden')) updateMinimap();
  });
  // Show minimap by default
  _wrap?.classList.remove('hidden');
  updateMinimap();
}

export function updateMinimap() {
  if (!_canvas || !_ctx || !_wrap || _wrap.classList.contains('hidden')) return;
  const W = _canvas.width, H = _canvas.height;
  _ctx.clearRect(0, 0, W, H);

  const dark = document.documentElement.classList.contains('dark');
  _ctx.fillStyle = dark ? 'rgba(10,13,14,0.96)' : 'rgba(233,233,228,0.96)';
  _ctx.fillRect(0, 0, W, H);

  const scaleX = W / CANVAS_SIZE;
  const scaleY = H / CANVAS_SIZE;

  // Connections
  _ctx.strokeStyle = 'rgba(214,184,109,0.38)';
  _ctx.lineWidth = 0.8;
  for (const conn of state.connections) {
    const a = state.nodes[conn.from], b = state.nodes[conn.to];
    if (!a || !b) continue;
    _ctx.beginPath();
    _ctx.moveTo(a.x * scaleX, a.y * scaleY);
    _ctx.lineTo(b.x * scaleX, b.y * scaleY);
    _ctx.stroke();
  }

  // Nodes
  _ctx.globalAlpha = 0.8;
  for (const id in state.nodes) {
    const n = state.nodes[id];
    const el = document.getElementById('node-' + id);
    const w  = Math.max((n.w ?? (el?.offsetWidth ?? 120)) * scaleX, 4);
    const h  = Math.max((el?.offsetHeight ?? 36) * scaleY, 3);
    _ctx.fillStyle = n.customColor || (dark ? '#d6b86d' : '#8d6e2d');
    roundRect(_ctx, n.x * scaleX, n.y * scaleY, w, h, 2);
    _ctx.fill();
  }
  _ctx.globalAlpha = 1;

  // Viewport rect
  const vx = (-state.pan.x / state.zoom) * scaleX;
  const vy = (-state.pan.y / state.zoom) * scaleY;
  const vw = ($c.offsetWidth  / state.zoom) * scaleX;
  const vh = ($c.offsetHeight / state.zoom) * scaleY;
  _ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  _ctx.lineWidth   = 1;
  _ctx.strokeRect(vx, vy, vw, vh);
}

function onMinimapClick(e) {
  if (!_canvas) return;
  const r  = _canvas.getBoundingClientRect();
  const mx = (e.clientX - r.left) / _canvas.width  * CANVAS_SIZE;
  const my = (e.clientY - r.top)  / _canvas.height * CANVAS_SIZE;
  state.pan.x = -mx * state.zoom + $c.offsetWidth  / 2;
  state.pan.y = -my * state.zoom + $c.offsetHeight / 2;
  applyTransform();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}
