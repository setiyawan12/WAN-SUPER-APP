// ── js/features/cmd-palette.js — Command Palette (Ctrl+K) ────
import { state, $el } from '../state.js';
import { zoomReset } from '../ui/toolbar.js';

let _active = false;
let _cursor = 0;

// ── Built-in commands ────────────────────────────────────────
const CMDS = [
  { icon: '🔍', label: 'Cari & Ganti',        key: 'find-replace',   kbd: 'Ctrl+H' },
  { icon: '📐', label: 'Auto Layout',           key: 'auto-layout'                   },
  { icon: '🔲', label: 'Zoom Fit',              key: 'zoom-fit',       kbd: 'Ctrl+Shift+F' },
  { icon: '⬜', label: 'Zoom 100%',             key: 'zoom-100'                      },
  { icon: '📋', label: 'Kanban View',           key: 'kanban-view'                   },
  { icon: '🖼', label: 'Export PNG',            key: 'export-png'                    },
  { icon: '↗', label: 'Export SVG',            key: 'export-svg'                    },
  { icon: '📝', label: 'Export Markdown',       key: 'export-md'                     },
  { icon: '📌', label: 'Sticky Note Baru',      key: 'new-sticky'                    },
  { icon: '🎨', label: 'Background: Dots',      key: 'bg-dots'                       },
  { icon: '🎨', label: 'Background: Grid',      key: 'bg-grid'                       },
  { icon: '🎨', label: 'Background: None',      key: 'bg-none'                       },
  { icon: '🌙', label: 'Toggle Dark/Light',     key: 'toggle-theme'                  },
  { icon: '📥', label: 'Import JSON/MD',        key: 'import'                        },
  { icon: '✂',  label: 'Pilih Semua Node',      key: 'select-all',     kbd: 'Ctrl+A' },
  { icon: '🗑', label: 'Hapus Node Terpilih',   key: 'delete-selected', kbd: 'Del'  },
];

function _getItems(q) {
  const lq = q.toLowerCase().trim();
  const results = [];

  // Node matches
  for (const id in state.nodes) {
    const n   = state.nodes[id];
    const txt = (n.text || '').toLowerCase();
    if (!lq || txt.includes(lq)) {
      results.push({ type: 'node', icon: n.emoji || '◈', label: n.text || '(kosong)', id, score: txt.startsWith(lq) ? 2 : 1 });
    }
  }

  // Command matches
  for (const cmd of CMDS) {
    const match = !lq || cmd.label.toLowerCase().includes(lq) || (cmd.key && cmd.key.includes(lq));
    if (match) results.push({ type: 'cmd', icon: cmd.icon, label: cmd.label, key: cmd.key, kbd: cmd.kbd, score: cmd.label.toLowerCase().startsWith(lq) ? 2 : 1 });
  }

  return results.sort((a, b) => b.score - a.score || (a.type === 'node' ? -1 : 1)).slice(0, 12);
}

function _render(q) {
  const list  = document.getElementById('cp-list');
  const items = _getItems(q);
  if (!list) return items;
  list.innerHTML = items.map((item, i) => `
    <div class="cp-item${i === _cursor ? ' active' : ''}" data-idx="${i}" data-type="${item.type}" data-id="${item.id || ''}" data-key="${item.key || ''}">
      <span class="cp-item-icon">${item.icon}</span>
      <span class="cp-item-label">${item.label}</span>
      ${item.kbd ? `<span class="cp-item-kbd">${item.kbd}</span>` : ''}
      ${item.type === 'node' ? '<span class="cp-item-badge">node</span>' : ''}
    </div>`).join('');
  return items;
}

function _execute(item) {
  close();
  if (!item) return;

  if (item.type === 'node') {
    // Navigate to node
    import('./align.js').then(() => {});
    const el = $el(item.id);
    if (el) {
      import('../canvas/transform.js').then(({ panToNode }) => panToNode(item.id));
      import('../canvas/selection.js').then(({ selectNode }) => selectNode(item.id));
    }
    return;
  }

  // Commands
  switch (item.key) {
    case 'find-replace':   document.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', ctrlKey: true, bubbles: true })); break;
    case 'auto-layout':    document.getElementById('btn-auto-layout')?.click(); break;
    case 'zoom-fit':       document.getElementById('btn-zoom-fit')?.click(); break;
    case 'zoom-100':       zoomReset(); break;
    case 'kanban-view':    document.dispatchEvent(new CustomEvent('wcf:cmd', { detail: 'kanban-view' })); break;
    case 'export-png':     document.getElementById('btn-export-png')?.click(); break;
    case 'export-svg':     document.getElementById('btn-export-svg')?.click(); break;
    case 'export-md':      document.getElementById('btn-export-md')?.click(); break;
    case 'new-sticky':     document.getElementById('btn-sticky')?.click(); break;
    case 'bg-dots':        document.dispatchEvent(new CustomEvent('wcf:cmd', { detail: 'bg-dots' })); break;
    case 'bg-grid':        document.dispatchEvent(new CustomEvent('wcf:cmd', { detail: 'bg-grid' })); break;
    case 'bg-none':        document.dispatchEvent(new CustomEvent('wcf:cmd', { detail: 'bg-none' })); break;
    case 'toggle-theme':   document.getElementById('btn-theme')?.click?.(); break;
    case 'import':         document.getElementById('btn-import-json')?.click(); break;
    case 'select-all':     document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true })); break;
    case 'delete-selected': document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })); break;
  }
}

export function open() {
  const modal = document.getElementById('cmd-palette');
  if (!modal) return;
  _active = true;
  _cursor = 0;
  modal.classList.remove('hidden');
  const input = document.getElementById('cp-input');
  if (input) { input.value = ''; input.focus(); }
  _render('');
}

export function close() {
  const modal = document.getElementById('cmd-palette');
  if (modal) modal.classList.add('hidden');
  _active = false;
}

export function initCmdPalette() {
  const modal = document.getElementById('cmd-palette');
  const input = document.getElementById('cp-input');
  if (!modal || !input) return;

  // Keyboard shortcut
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      _active ? close() : open();
      return;
    }
    if (!_active) return;
    if (e.key === 'Escape') { close(); return; }
    if (e.key === 'ArrowDown')  { e.preventDefault(); _cursor = Math.min(_cursor + 1, 11); _render(input.value); return; }
    if (e.key === 'ArrowUp')    { e.preventDefault(); _cursor = Math.max(_cursor - 1, 0);  _render(input.value); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const items = _getItems(input.value);
      _execute(items[_cursor]);
      return;
    }
  });

  // Input filter
  input.addEventListener('input', () => { _cursor = 0; _render(input.value); });

  // Click item
  document.getElementById('cp-list')?.addEventListener('click', e => {
    const row = e.target.closest('.cp-item');
    if (!row) return;
    const idx   = +row.dataset.idx;
    const items = _getItems(input.value);
    _execute(items[idx]);
  });

  // Click backdrop
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
}
