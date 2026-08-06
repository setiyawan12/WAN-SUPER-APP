// ── js/ui/toolbar.js ─────────────────────────────────────────
import { state, hist, refs, pushUndo, snapshot, snapshotData } from '../state.js';
import { flash }              from './flash.js';
import { wcfConfirm }         from './modal.js';
import { applyTransform, fitToNodes } from '../canvas/transform.js';
import { applyData }          from '../canvas/node.js';
import { apiSave, apiLoad }   from '../api.js';
import { renderSidebar }      from '../sidebar/tree.js';
import { exportJSON, exportPNG } from '../features/export.js';
import { logAction }          from '../features/history-log.js';
import { workspaceContext }   from '../data/repository.js';

const LS_KEY = id => `wcf_data_${id}`;
let saveQueue = Promise.resolve();

// ── Dirty indicator helper ────────────────────────────────────
function syncDirtyBtn() {
  const btn = document.getElementById('btn-save');
  if (!btn) return;
  if (refs.dirty) btn.classList.add('is-dirty');
  else             btn.classList.remove('is-dirty');
}

// ── Undo / Redo (snapshot = JSON string) ─────────────────────
export function undo() {
  if (!hist.undo.length) return;
  hist.redo.push(snapshot());
  const snap = JSON.parse(hist.undo.pop());
  applyData(snap);
  refs.dirty = true;
  syncDirtyBtn();
  flash('↩ Undo', true);
}

export function redo() {
  if (!hist.redo.length) return;
  hist.undo.push(snapshot());
  const snap = JSON.parse(hist.redo.pop());
  applyData(snap);
  refs.dirty = true;
  syncDirtyBtn();
  flash('↪ Redo', true);
}

// ── Save ──────────────────────────────────────────────────────
export function save(silent = false) {
  // Blokir save saat admin sedang melihat workspace user lain
  if (window.wcfViewMode) {
    if (!silent) flash('⚠ Mode baca saja — tidak bisa menyimpan', false);
    return Promise.resolve();
  }
  if (!state.currentProject) return Promise.resolve();
  const projectId = state.currentProject;
  const serialized = JSON.stringify(snapshotData());
  const payload = JSON.parse(serialized);

  // 1. Selalu simpan ke localStorage dulu sebagai backup
  if (workspaceContext().type === 'personal') {
    try {
      localStorage.setItem(LS_KEY(projectId), serialized);
    } catch {}
  }

  // 2. Serialkan request agar save lama tidak menimpa perubahan yang lebih baru.
  const operation = async () => {
    try {
      const res = await apiSave(payload, projectId);
      if (res && res.ok) {
        const stateUnchanged = state.currentProject === projectId
          && JSON.stringify(snapshotData()) === serialized;
        if (state.currentProject === projectId) {
          refs.dirty = !stateUnchanged;
          syncDirtyBtn();
        }
        const cnt = Object.keys(payload.nodes || {}).length;
        if (!silent) { flash(`✓ Tersimpan (${cnt} node)`, true); logAction('save', projectId); }
        renderSidebar();
        console.log('[WCF] saved to DB:', projectId, 'nodes:', cnt,
                    '| current:', stateUnchanged ? 'yes' : 'newer changes pending');
      } else {
        console.warn('[WCF] DB save failed:', res);
        if (!silent) flash('⚠ DB gagal, data di localStorage', false);
      }
    } catch (err) {
      console.error('[WCF] save error:', err);
      if (!silent) flash('⚠ Tersimpan lokal saja', false);
    }
  };
  saveQueue = saveQueue.catch(() => {}).then(operation);
  return saveQueue;
}

export async function persistNow(message = 'Perubahan tersimpan') {
  refs.dirty = true;
  syncDirtyBtn();
  await save(true);
  if (refs.dirty) {
    flash('Node dihapus lokal, sinkronisasi cloud belum berhasil', false);
    return false;
  }
  flash(message, true);
  return true;
}

// ── Load ──────────────────────────────────────────────────────
export async function load() {
  if (!state.currentProject) return;

  // 1. DB DULU — sumber kebenaran utama (sync antar browser/tab/incognito)
  try {
    const res = await apiLoad(state.currentProject);
    if (res && res.ok && res.data !== null && res.data !== undefined
        && typeof res.data.nodes === 'object') {
      applyData(res.data);
      refs.dirty = false;
      syncDirtyBtn();
      // Perbarui cache localStorage
      try { localStorage.setItem(LS_KEY(state.currentProject), JSON.stringify(res.data)); } catch {}
      flash(`✓ Dimuat dari DB (${Object.keys(state.nodes).length} node)`, true);
      return;
    }
  } catch (err) {
    console.warn('[WCF] DB load error, coba localStorage:', err);
  }

  // 2. Fallback: localStorage (jika DB tidak tersedia)
  if (workspaceContext().type === 'personal') try {
    const raw = localStorage.getItem(LS_KEY(state.currentProject));
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.nodes === 'object') {
        applyData(parsed);
        refs.dirty = false;
        syncDirtyBtn();
        flash(`✓ Dimuat dari cache lokal (${Object.keys(state.nodes).length} node)`, true);
        return;
      }
    }
  } catch (err) {
    console.warn('[WCF] localStorage load failed:', err);
  }

  flash('⚠ Tidak ada data tersimpan', false);
}

// ── Clear ─────────────────────────────────────────────────────
export async function clearAll() {
  if (!await wcfConfirm('Hapus semua isi canvas ini?', 'Hapus')) return;
  pushUndo();
  applyData({
    nodes: {}, connections: [], nextId: 1, groups: {},
    stickies: {}, nextStickyId: 1, frames: {}, nextFrameId: 1,
  });
  syncDirtyBtn();
  logAction('clear', state.currentProject);
  flash('🗑 Canvas dikosongkan', true);
}

// ── Zoom ──────────────────────────────────────────────────────
export function zoomBy(delta) {
  state.zoom = Math.min(3, Math.max(0.15, state.zoom + delta));
  applyTransform();
  const zl = document.getElementById('zoom-label');
  if (zl) zl.textContent = Math.round(state.zoom * 100) + '%';
}
export function zoomReset() {
  state.zoom = 1; state.pan.x = 0; state.pan.y = 0;
  applyTransform();
  const zl = document.getElementById('zoom-label');
  if (zl) zl.textContent = '100%';
}

// ── Init ─────────────────────────────────────────────────────
export function initToolbar() {
  const on = (id, fn) => document.getElementById(id)?.addEventListener('click', fn);
  on('btn-save',        () => save());
  on('btn-load',        () => load());
  on('btn-clear',       () => clearAll());
  on('btn-undo',        () => undo());
  on('btn-redo',        () => redo());
  on('btn-zoom-in',     () => zoomBy(0.05));
  on('btn-zoom-out',    () => zoomBy(-0.05));
  on('btn-zoom-reset',  () => zoomReset());
  on('btn-export-json', () => exportJSON());
  on('btn-export-png',  () => exportPNG());
  on('btn-zoom-fit',    () => fitToNodes());
  on('btn-auto-layout', () =>
    import('../features/auto-layout.js').then(m => {
      m.applyAutoLayout();
      flash('✓ Auto-layout diterapkan', true);
    })
  );

  document.addEventListener('wcf:persist-now', event => {
    void persistNow(event.detail?.message || 'Perubahan tersimpan');
  });

  // Sync dirty indicator every 500ms (covers all refs.dirty=true from other modules)
  setInterval(() => syncDirtyBtn(), 500);

  // Auto-save setiap 2 detik — hanya setelah init selesai (refs.initialized)
  setInterval(async () => {
    if (refs.initialized && refs.dirty && state.currentProject && !window.wcfViewMode) {
      await save(true);
    }
  }, 2000);

  // Simpan ke localStorage SELALU saat reload/tutup (tidak perlu cek dirty)
  window.addEventListener('beforeunload', () => {
    if (state.currentProject && refs.initialized && workspaceContext().type === 'personal') {
      try {
        const payload = snapshotData();
        localStorage.setItem(LS_KEY(state.currentProject), JSON.stringify(payload));
      } catch {}
    }
  });

  // Keyboard — Ctrl/Cmd+S selalu dicegat di capture phase agar tidak trigger Save HTML browser
  window.addEventListener('keydown', e => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key === 's') {
      e.preventDefault();   // selalu blok browser save dialog, apapun yang sedang fokus
      save();
      return;
    }
    // Shortcut lain hanya aktif kalau tidak sedang edit teks
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.contentEditable === 'true') return;
    if (ctrl && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    if (ctrl && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
  }, { capture: true }); // capture:true = jalan sebelum listener lain & sebelum default browser
}
