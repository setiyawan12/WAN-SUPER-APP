// ── js/features/presentation.js — mode presentasi fullscreen ─
import { state }          from '../state.js';
import { applyTransform } from '../canvas/transform.js';

let active  = false;
let nodes   = [];   // sorted node ids
let idx     = 0;

const CLS = 'wcf-presentation';

// ── Public API ───────────────────────────────────────────────

export function isPresentation() { return active; }

export function togglePresentation() {
  active ? exit() : enter();
}

export function presentationKey(e) {
  if (!active) return false;
  if (e.key === 'Escape')      { exit(); return true; }
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { next(); return true; }
  if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')   { prev(); return true; }
  return false;
}

// ── Private ──────────────────────────────────────────────────

function enter() {
  // Jangan masuk jika tidak ada node
  if (!Object.keys(state.nodes).length) {
    alert('Canvas kosong — tidak ada node untuk ditampilkan.');
    return;
  }

  active = true;
  document.body.classList.add(CLS);
  document.getElementById('btn-presentation')?.setAttribute('title', 'Keluar Presentasi (Esc)');
  document.getElementById('btn-presentation')?.classList.add('wcf-pres-active');

  // Sort nodes: atas-ke-bawah, kiri-ke-kanan
  nodes = Object.values(state.nodes)
    .sort((a, b) => (a.y - b.y) || (a.x - b.x))
    .map(n => n.id);
  idx = 0;

  buildHUD();
  focusCurrent();
}

function exit() {
  active = false;
  document.body.classList.remove(CLS);
  document.getElementById('btn-presentation')?.removeAttribute('title');
  document.getElementById('btn-presentation')?.classList.remove('wcf-pres-active');
  document.querySelectorAll('.node').forEach(el => el.classList.remove('wcf-pres-focus'));
  document.getElementById('wcf-pres-hud')?.remove();
}

function next() {
  if (!nodes.length) return;
  idx = (idx + 1) % nodes.length;
  focusCurrent();
}

function prev() {
  if (!nodes.length) return;
  idx = (idx - 1 + nodes.length) % nodes.length;
  focusCurrent();
}

function focusCurrent() {
  const id = nodes[idx];
  if (!id) return;

  // Highlight
  document.querySelectorAll('.node').forEach(el => el.classList.remove('wcf-pres-focus'));
  const el = document.getElementById('node-' + id);
  if (el) el.classList.add('wcf-pres-focus');

  // Pan canvas agar node ada di tengah viewport
  const n = state.nodes[id];
  if (n) {
    const nodeW = el?.offsetWidth  || 120;
    const nodeH = el?.offsetHeight || 40;
    const vw = window.innerWidth  / 2;
    const vh = window.innerHeight / 2;
    state.pan.x = vw - (n.x + nodeW / 2) * state.zoom;
    state.pan.y = vh - (n.y + nodeH / 2) * state.zoom;
    applyTransform();
  }

  // Update HUD counter
  const counter = document.getElementById('wcf-pres-counter');
  if (counter) counter.textContent = `${idx + 1} / ${nodes.length}`;

  // Update HUD node preview
  const preview = document.getElementById('wcf-pres-preview');
  if (preview) {
    const nodeData = state.nodes[id];
    preview.textContent = nodeData ? (nodeData.text.length > 60 ? nodeData.text.slice(0, 60) + '…' : nodeData.text) : '';
  }
}

function buildHUD() {
  document.getElementById('wcf-pres-hud')?.remove();
  const hud = document.createElement('div');
  hud.id = 'wcf-pres-hud';
  hud.innerHTML = `
    <button id="wcf-pres-prev" title="Sebelumnya (←)">◀</button>
    <span id="wcf-pres-counter">${idx + 1} / ${nodes.length}</span>
    <span id="wcf-pres-preview" style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.6;font-size:10px;"></span>
    <button id="wcf-pres-next" title="Berikutnya (→)">▶</button>
    <button id="wcf-pres-exit" title="Keluar (Esc)" style="margin-left:8px;opacity:.5;">✕</button>
  `;
  document.body.appendChild(hud);

  hud.querySelector('#wcf-pres-prev').addEventListener('click', e => { e.stopPropagation(); prev(); });
  hud.querySelector('#wcf-pres-next').addEventListener('click', e => { e.stopPropagation(); next(); });
  hud.querySelector('#wcf-pres-exit').addEventListener('click', e => { e.stopPropagation(); exit(); });
}
