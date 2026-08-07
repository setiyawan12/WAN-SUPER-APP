// ── js/features/kanban.js — Kanban view of nodes by status ───
import { state, refs } from '../state.js';
import { pushUndo }    from '../state.js';
import { selectNode }  from '../canvas/selection.js';
import { panToNode }   from '../canvas/transform.js';

const COLS = [
  { status: '',         label: '—',    color: 'rgba(255,255,255,0.12)', badge: '#888' },
  { status: 'todo',     label: '○ Todo',  color: 'rgba(100,116,139,0.25)', badge: '#94a3b8' },
  { status: 'progress', label: '◑ WIP',   color: 'rgba(245,158,11,0.18)', badge: '#fbbf24' },
  { status: 'done',     label: '● Done',  color: 'rgba(16,185,129,0.18)', badge: '#34d399' },
];

let _open = false;

function _cardHTML(n) {
  const tags   = (n.tags || []).map(t => `<span style="background:rgba(139,124,248,0.18);color:#a5b4fc;border-radius:3px;padding:0 5px;font-size:10px">${t}</span>`).join('');
  const due    = n.dueDate ? `<span style="font-size:9px;color:${_dueColor(n.dueDate)}">${n.dueDate}</span>` : '';
  const emoji  = n.emoji ? `<span style="margin-right:4px">${n.emoji}</span>` : '';
  const checks = (n.checklist || []).length;
  const done   = (n.checklist || []).filter(c => c.done).length;
  const prog   = checks ? `<span style="font-size:9px;color:rgba(255,255,255,0.35)">${done}/${checks} ✓</span>` : '';
  return `
    <div class="kb-card" data-id="${n.id}" draggable="true" title="Klik untuk fokus node">
      <div class="kb-card-text">${emoji}${n.text || '(kosong)'}</div>
      ${tags  ? `<div class="kb-card-tags">${tags}</div>` : ''}
      <div class="kb-card-meta">${due}${prog}</div>
    </div>`;
}

function _dueColor(d) {
  const diff = (new Date(d) - Date.now()) / 86400000;
  if (diff < 0)  return '#f87171';
  if (diff < 1)  return '#fbbf24';
  return 'rgba(255,255,255,0.35)';
}

function _render() {
  const overlay = document.getElementById('kanban-overlay');
  if (!overlay) return;

  const cols = COLS.map(col => {
    const nodes = Object.values(state.nodes).filter(n => (n.status || '') === col.status);
    const cards = nodes.map(n => _cardHTML(n)).join('');
    return `
      <div class="kb-col" data-status="${col.status}"
           style="background:${col.color};border:1px solid rgba(255,255,255,0.07);border-radius:12px;display:flex;flex-direction:column;min-width:220px;max-width:280px;flex:1">
        <div style="padding:12px 14px 8px;display:flex;align-items:center;gap:8px">
          <span style="font-size:12px;font-weight:600;color:${col.badge}">${col.label}</span>
          <span style="font-size:10px;color:rgba(255,255,255,0.35);margin-left:auto">${nodes.length}</span>
        </div>
        <div class="kb-cards" data-status="${col.status}"
             style="padding:0 8px 8px;display:flex;flex-direction:column;gap:6px;overflow-y:auto;flex:1">
          ${cards || '<div style="font-size:11px;color:rgba(255,255,255,0.2);text-align:center;padding:16px 0">Kosong</div>'}
        </div>
      </div>`;
  }).join('');

  overlay.innerHTML = `
    <div style="position:absolute;inset:0;background:rgba(0,0,0,0.65);backdrop-filter:blur(6px);z-index:200;display:flex;flex-direction:column">
      <div style="display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid rgba(255,255,255,0.07)">
        <span style="font-size:13px;font-weight:600;color:rgba(255,255,255,0.85)">📋 Kanban View</span>
        <span style="font-size:11px;color:rgba(255,255,255,0.35)">${Object.keys(state.nodes).length} node</span>
        <button id="kb-close" style="margin-left:auto;background:rgba(255,255,255,0.08);border:none;color:rgba(255,255,255,0.6);padding:4px 12px;border-radius:6px;cursor:pointer;font-size:12px" title="Kembali ke canvas">✕ Tutup</button>
      </div>
      <div id="kb-board" style="display:flex;gap:12px;padding:16px 20px;flex:1;overflow-x:auto;overflow-y:hidden;align-items:flex-start">
        ${cols}
      </div>
    </div>`;

  // Wire events
  document.getElementById('kb-close')?.addEventListener('click', closeKanban);

  overlay.querySelectorAll('.kb-card').forEach(card => {
    card.addEventListener('click', () => {
      const id = card.dataset.id;
      closeKanban();
      selectNode(id);
      panToNode(id);
    });

    // Drag to change status
    card.addEventListener('dragstart', e => { e.dataTransfer.setData('nodeId', card.dataset.id); });
  });

  overlay.querySelectorAll('.kb-cards').forEach(col => {
    col.addEventListener('dragover', e => e.preventDefault());
    col.addEventListener('drop', e => {
      e.preventDefault();
      const id     = e.dataTransfer.getData('nodeId');
      const status = col.dataset.status;
      if (!id || !state.nodes[id]) return;
      pushUndo();
      state.nodes[id].status = status || undefined;
      refs.dirty = true;
      _render(); // re-render board
    });
  });
}

export function openKanban() {
  const overlay = document.getElementById('kanban-overlay');
  if (!overlay) return;
  overlay.classList.remove('hidden');
  _open = true;
  _render();
}

export function closeKanban() {
  const overlay = document.getElementById('kanban-overlay');
  if (overlay) overlay.classList.add('hidden');
  _open = false;
}

export function initKanban() {
  document.addEventListener('wcf:cmd', e => {
    if (e.detail === 'kanban-view') openKanban();
  });
}
