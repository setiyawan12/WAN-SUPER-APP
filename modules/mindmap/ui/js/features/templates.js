// ── js/features/templates.js — node template siap pakai ──────
import { state, refs, $cv, COLORS, pushUndo }  from '../state.js';
import { renderLines, syncColors }              from '../canvas/connection.js';
import { buildEl }                              from '../canvas/node.js';

// ── Definisi template ─────────────────────────────────────────
const TEMPLATES = [
  {
    id:   'swot',
    icon: '🟦',
    name: 'SWOT Analysis',
    desc: 'Strengths · Weaknesses · Opportunities · Threats',
    build: (cx, cy) => {
      const nodes = [
        { text: 'Topik', x: cx,       y: cy,       color: '#7c6dfa' },
        { text: '💪 Strengths',     x: cx - 240, y: cy - 130, color: '#10b981' },
        { text: '⚠ Weaknesses',     x: cx + 60,  y: cy - 130, color: '#f43f5e' },
        { text: '🌟 Opportunities', x: cx - 240, y: cy + 80,  color: '#0ea5e9' },
        { text: '☁ Threats',        x: cx + 60,  y: cy + 80,  color: '#f59e0b' },
      ];
      const conns = [[0,1],[0,2],[0,3],[0,4]];
      return { nodes, conns };
    },
  },
  {
    id:   'fishbone',
    icon: '🐟',
    name: 'Fishbone (Ishikawa)',
    desc: 'Analisis akar masalah dengan 6 kategori penyebab',
    build: (cx, cy) => {
      const nodes = [
        { text: 'Masalah / Efek', x: cx + 200, y: cy,        color: '#f43f5e' },
        { text: '🧑 Manusia',     x: cx - 80,  y: cy - 140,  color: '#7c6dfa' },
        { text: '⚙ Mesin',       x: cx + 20,  y: cy - 140,  color: '#7c6dfa' },
        { text: '📋 Metode',      x: cx + 120, y: cy - 140,  color: '#7c6dfa' },
        { text: '🌿 Material',    x: cx - 80,  y: cy + 100,  color: '#0ea5e9' },
        { text: '🌍 Lingkungan',  x: cx + 20,  y: cy + 100,  color: '#0ea5e9' },
        { text: '📏 Pengukuran',  x: cx + 120, y: cy + 100,  color: '#0ea5e9' },
      ];
      const conns = [[1,0],[2,0],[3,0],[4,0],[5,0],[6,0]];
      return { nodes, conns };
    },
  },
  {
    id:   'decision',
    icon: '🌳',
    name: 'Decision Tree',
    desc: 'Pohon keputusan dengan 3 opsi dan 2 hasil masing-masing',
    build: (cx, cy) => {
      const nodes = [
        { text: '❓ Keputusan',  x: cx,       y: cy,        color: '#7c6dfa' },
        { text: '🅐 Opsi A',     x: cx - 300, y: cy - 50,   color: '#10b981' },
        { text: '🅑 Opsi B',     x: cx - 50,  y: cy - 50,   color: '#0ea5e9' },
        { text: '🅒 Opsi C',     x: cx + 200, y: cy - 50,   color: '#f59e0b' },
        { text: '✅ Hasil A1',   x: cx - 380, y: cy + 120,  color: '#10b981' },
        { text: '❌ Hasil A2',   x: cx - 240, y: cy + 120,  color: '#f43f5e' },
        { text: '✅ Hasil B1',   x: cx - 130, y: cy + 120,  color: '#10b981' },
        { text: '❌ Hasil B2',   x: cx + 10,  y: cy + 120,  color: '#f43f5e' },
        { text: '✅ Hasil C1',   x: cx + 120, y: cy + 120,  color: '#10b981' },
        { text: '❌ Hasil C2',   x: cx + 260, y: cy + 120,  color: '#f43f5e' },
      ];
      const conns = [[0,1],[0,2],[0,3],[1,4],[1,5],[2,6],[2,7],[3,8],[3,9]];
      return { nodes, conns };
    },
  },
  {
    id:   '5w1h',
    icon: '❓',
    name: '5W1H',
    desc: 'Who · What · When · Where · Why · How',
    build: (cx, cy) => {
      const labels = [
        { text: '🧑 Who (Siapa)',     color: '#7c6dfa' },
        { text: '📌 What (Apa)',      color: '#f43f5e' },
        { text: '📅 When (Kapan)',    color: '#0ea5e9' },
        { text: '📍 Where (Di mana)', color: '#10b981' },
        { text: '🤔 Why (Mengapa)',   color: '#f59e0b' },
        { text: '🔧 How (Bagaimana)', color: '#ec4899' },
      ];
      const angles = [-90, -30, 30, 90, 150, 210].map(d => d * Math.PI / 180);
      const r = 200;
      const nodes = [
        { text: 'Topik', x: cx, y: cy, color: '#7c6dfa' },
        ...labels.map((l, i) => ({
          text: l.text,
          x: cx + Math.round(Math.cos(angles[i]) * r) - 60,
          y: cy + Math.round(Math.sin(angles[i]) * r) - 20,
          color: l.color,
        })),
      ];
      const conns = labels.map((_, i) => [0, i + 1]);
      return { nodes, conns };
    },
  },
];

// ── Modal HTML ID ─────────────────────────────────────────────
const MODAL_ID = 'template-modal';

// ── Public API ───────────────────────────────────────────────

export function initTemplates() {
  const modal = document.getElementById(MODAL_ID);
  if (!modal) return;

  // Klik di luar modal → tutup
  modal.addEventListener('click', e => {
    if (e.target === modal) closeTemplateModal();
  });
  document.getElementById('template-modal-close')?.addEventListener('click', closeTemplateModal);
}

export function openTemplateModal() {
  const modal = document.getElementById(MODAL_ID);
  if (!modal) return;
  modal.classList.remove('hidden');
}

function closeTemplateModal() {
  document.getElementById(MODAL_ID)?.classList.add('hidden');
}

export function applyTemplate(id) {
  const tpl = TEMPLATES.find(t => t.id === id);
  if (!tpl) return;
  closeTemplateModal();

  // Posisi tengah canvas yang terlihat
  const cv   = document.getElementById('canvas');
  const cont = document.getElementById('container');
  const vw   = (cont?.offsetWidth  || window.innerWidth)  / 2;
  const vh   = (cont?.offsetHeight || window.innerHeight) / 2;
  const cx   = (vw - state.pan.x) / state.zoom;
  const cy   = (vh - state.pan.y) / state.zoom;

  pushUndo();

  const { nodes, conns } = tpl.build(cx, cy);

  // Buat node-node template
  const idMap = {};
  nodes.forEach((n, i) => {
    const nid = 'n' + (state.nextId++);
    idMap[i] = nid;
    state.nodes[nid] = { id: nid, text: n.text, x: n.x, y: n.y, children: [], note: '', customColor: n.color };
    const el = buildEl(state.nodes[nid]);
    el.style.background = n.color;
    el.style.boxShadow  = `0 4px 22px ${n.color}55`;
    cv?.appendChild(el);
  });

  // Buat koneksi
  conns.forEach(([from, to]) => {
    const f = idMap[from], t = idMap[to];
    if (!f || !t) return;
    state.connections.push({ from: f, to: t, style: 'curved', label: '' });
    state.nodes[f].children = [...(state.nodes[f].children || []), t];
  });

  refs.dirty = true;
  syncColors();
  renderLines();
}

// ── Render template picker grid ────────────────────────────────
export function renderTemplatePicker() {
  const grid = document.getElementById('template-grid');
  if (!grid) return;
  grid.innerHTML = '';
  TEMPLATES.forEach(t => {
    const card = document.createElement('div');
    card.className = 'tpl-card';
    card.innerHTML = `
      <div class="tpl-icon">${t.icon}</div>
      <div class="tpl-name">${t.name}</div>
      <div class="tpl-desc">${t.desc}</div>
    `;
    card.addEventListener('click', () => applyTemplate(t.id));
    grid.appendChild(card);
  });
}
