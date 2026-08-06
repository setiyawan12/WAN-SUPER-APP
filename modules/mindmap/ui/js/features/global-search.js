// ── js/features/global-search.js — cari di semua file/grup ──
import { apiSearchGlobal } from '../api.js';

let panel       = null;
let searchInput = null;
let debounce    = null;
const PANEL_ID  = 'global-search-panel';

// ── Public API ────────────────────────────────────────────────

export function initGlobalSearch(onOpenFile) {
  panel       = document.getElementById(PANEL_ID);
  searchInput = document.getElementById('gs-input');
  if (!panel || !searchInput) return;

  // Tutup panel
  document.getElementById('gs-close')?.addEventListener('click', closePanel);
  panel.addEventListener('click', e => { if (e.target === panel) closePanel(); });

  // Ketik → debounce → cari
  searchInput.addEventListener('input', () => {
    clearTimeout(debounce);
    const q = searchInput.value.trim();
    if (q.length < 2) {
      renderResults(null, q);
      return;
    }
    setLoading(true);
    debounce = setTimeout(() => doSearch(q, onOpenFile), 350);
  });

  // Escape → tutup
  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') closePanel();
  });
}

export function openGlobalSearch() {
  panel?.classList.remove('hidden');
  searchInput?.focus();
  searchInput?.select();
}

export function closePanel() {
  panel?.classList.add('hidden');
}

// ── Internal ──────────────────────────────────────────────────

async function doSearch(q, onOpenFile) {
  const r = await apiSearchGlobal(q).catch(() => null);
  setLoading(false);
  renderResults(r, q, onOpenFile);
}

function setLoading(on) {
  const el = document.getElementById('gs-loading');
  if (el) el.style.display = on ? 'flex' : 'none';
}

function hl(text, q) {
  // Highlight kata kunci dalam teks (case-insensitive).
  // PENTING: escape HTML dulu agar teks node (dari user lain) tidak bisa
  // menyuntikkan markup — cegah stored XSS.
  const safe   = esc(text);
  const escQ   = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safe.replace(new RegExp(`(${escQ})`, 'gi'), '<mark class="gs-hl">$1</mark>');
}

function renderResults(r, q, onOpenFile) {
  const body = document.getElementById('gs-results');
  const meta = document.getElementById('gs-meta');
  if (!body) return;
  body.innerHTML = '';

  if (!r) {
    meta.textContent = '';
    body.innerHTML = '<div class="gs-empty">Gagal menghubungi server</div>';
    return;
  }

  if (q.length < 2) {
    meta.textContent = '';
    body.innerHTML = '<div class="gs-empty">Ketik minimal 2 karakter untuk mencari…</div>';
    return;
  }

  const results = r.results || [];
  meta.textContent = results.length
    ? `${results.length} hasil${r.total > results.length ? ` (dari ${r.total} total, menampilkan ${results.length})` : ''}`
    : '';

  if (!results.length) {
    body.innerHTML = `<div class="gs-empty">Tidak ditemukan hasil untuk "<strong>${esc(q)}</strong>"</div>`;
    return;
  }

  // Group by group
  const byGroup = {};
  results.forEach(item => {
    const key = item.groupId;
    if (!byGroup[key]) byGroup[key] = { name: item.groupName, groupId: item.groupId, items: [] };
    byGroup[key].items.push(item);
  });

  for (const gid in byGroup) {
    const g = byGroup[gid];

    // Group header
    const gh = document.createElement('div');
    gh.className = 'gs-group-header';
    gh.innerHTML = `👥 <strong>${esc(g.name)}</strong> <span class="gs-group-count">${g.items.length}</span>`;
    body.appendChild(gh);

    // Group by file
    const byFile = {};
    g.items.forEach(item => {
      if (!byFile[item.fileId]) byFile[item.fileId] = { name: item.fileName, fileId: item.fileId, groupId: item.groupId, groupName: item.groupName, items: [] };
      byFile[item.fileId].items.push(item);
    });

    for (const fid in byFile) {
      const f = byFile[fid];

      // File header
      const fh = document.createElement('div');
      fh.className = 'gs-file-header';
      fh.innerHTML = `📄 ${esc(f.name)}`;
      body.appendChild(fh);

      f.items.forEach(item => {
        const row = document.createElement('div');
        row.className = 'gs-result-row';
        row.innerHTML = `
          <div class="gs-result-text">${hl(item.nodeText, q)}</div>
          ${item.context ? `<div class="gs-result-ctx">${hl(item.context, q)}</div>` : ''}
        `;
        row.addEventListener('click', () => {
          if (onOpenFile) onOpenFile(item.groupId, item.fileId, item.nodeId);
          closePanel();
        });
        body.appendChild(row);
      });
    }
  }
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
