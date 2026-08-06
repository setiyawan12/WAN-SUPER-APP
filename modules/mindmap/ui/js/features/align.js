// ── js/features/align.js — Node alignment tools ──────────────
import { state, selectedNodes, pushUndo, refs, $el } from '../state.js';
import { renderLines } from '../canvas/connection.js';

function getRect(id) {
  const n  = state.nodes[id];
  const el = $el(id);
  if (!n || !el) return null;
  return { id, x: n.x, y: n.y, w: el.offsetWidth, h: el.offsetHeight };
}

export function alignNodes(type) {
  const rects = [...selectedNodes].map(getRect).filter(Boolean);
  if (rects.length < 2) return;
  pushUndo();

  const minX = Math.min(...rects.map(r => r.x));
  const maxX = Math.max(...rects.map(r => r.x + r.w));
  const minY = Math.min(...rects.map(r => r.y));
  const maxY = Math.max(...rects.map(r => r.y + r.h));
  const cxH  = (minX + maxX) / 2;
  const cyV  = (minY + maxY) / 2;

  if (type === 'dist-h') {
    const sorted  = [...rects].sort((a, b) => a.x - b.x);
    const totalW  = sorted.reduce((s, r) => s + r.w, 0);
    const gap     = (maxX - minX - totalW) / Math.max(sorted.length - 1, 1);
    let cx = minX;
    sorted.forEach(r => {
      state.nodes[r.id].x = cx;
      const el = $el(r.id);
      if (el) el.style.left = cx + 'px';
      cx += r.w + gap;
    });
  } else if (type === 'dist-v') {
    const sorted  = [...rects].sort((a, b) => a.y - b.y);
    const totalH  = sorted.reduce((s, r) => s + r.h, 0);
    const gap     = (maxY - minY - totalH) / Math.max(sorted.length - 1, 1);
    let cy = minY;
    sorted.forEach(r => {
      state.nodes[r.id].y = cy;
      const el = $el(r.id);
      if (el) el.style.top = cy + 'px';
      cy += r.h + gap;
    });
  } else {
    rects.forEach(r => {
      const n = state.nodes[r.id];
      switch (type) {
        case 'left':     n.x = minX;             break;
        case 'center-h': n.x = cxH  - r.w / 2;  break;
        case 'right':    n.x = maxX - r.w;       break;
        case 'top':      n.y = minY;             break;
        case 'middle-v': n.y = cyV  - r.h / 2;  break;
        case 'bottom':   n.y = maxY - r.h;       break;
      }
      const el = $el(r.id);
      if (el) { el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; }
    });
  }

  renderLines();
  refs.dirty = true;
}

export function updateAlignBar() {
  const bar = document.getElementById('align-bar');
  if (!bar) return;
  bar.classList.toggle('hidden', selectedNodes.size < 2);
}

export function initAlignBar() {
  const bar = document.getElementById('align-bar');
  if (!bar) return;
  bar.addEventListener('click', e => {
    const btn = e.target.closest('[data-align]');
    if (btn) alignNodes(btn.dataset.align);
  });
  // Show/hide based on selection changes
  document.addEventListener('wcf:selection-changed', updateAlignBar);
}
