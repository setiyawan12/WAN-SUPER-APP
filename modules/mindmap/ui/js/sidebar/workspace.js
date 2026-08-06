// ── js/sidebar/workspace.js ──────────────────────────────────
import { state, refs, hist, selectedNodes, snapshotData } from '../state.js';
import { apiLoad, apiSave, apiGetWorkspace, apiSaveWorkspace, apiDelete } from '../api.js';
import { applyData }  from '../canvas/node.js';
import { fitToNodes } from '../canvas/transform.js';
import { renderSidebar } from './tree.js';
import { flash }         from '../ui/flash.js';
import { workspaceContext } from '../data/repository.js';

const MAX_DEPTH = 5;
export { MAX_DEPTH };

// ── Tree helpers ─────────────────────────────────────────────
export function findNode(root, id) {
  if (root.id === id) return root;
  for (const child of (root.children || [])) {
    const f = findNode(child, id);
    if (f) return f;
  }
  return null;
}

export function findParent(root, targetId, parent = null) {
  if (root.id === targetId) return parent;
  for (const child of (root.children || [])) {
    const f = findParent(child, targetId, root);
    if (f !== undefined) return f;
  }
  return undefined;
}

export function removeNode(root, targetId) {
  const ch = root.children;
  if (!ch) return false;
  const idx = ch.findIndex(c => c.id === targetId);
  if (idx !== -1) { ch.splice(idx, 1); return true; }
  return ch.some(c => removeNode(c, targetId));
}

export function isDescendant(parent, targetId) {
  return (parent.children || []).some(c =>
    c.id === targetId || (c.type === 'folder' && isDescendant(c, targetId))
  );
}

export function collectFileIds(node) {
  if (node.type === 'file') return [node.id];
  return (node.children || []).flatMap(collectFileIds);
}

export function genId() {
  return 'wcf_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Save / Load workspace tree ───────────────────────────────
export async function saveWorkspaceTree() {
  try { await apiSaveWorkspace(refs.workspaceTree); } catch {}
}

export async function loadWorkspace() {
  try {
    const json = await apiGetWorkspace();
    if (json.ok && json.tree) {
      refs.workspaceTree = json.tree;
    } else {
      refs.workspaceTree = {
        id: 'root', name: 'root', type: 'folder', expanded: true,
        children: [{ id: 'default', name: 'Default', type: 'file' }],
      };
      await saveWorkspaceTree();
    }
  } catch (error) {
    if (workspaceContext().type === 'group') throw error;
    refs.workspaceTree = {
      id: 'root', name: 'root', type: 'folder', expanded: true,
      children: [{ id: 'default', name: 'Default', type: 'file' }],
    };
  }
  renderSidebar();
}

// ── Switch project ───────────────────────────────────────────
export async function switchProject(id) {
  if (id === state.currentProject) { renderSidebar(); return; }
  // Simpan proyek lama ke localStorage dulu
  try {
    if (state.currentProject && workspaceContext().type === 'personal') {
      const payload = snapshotData();
      localStorage.setItem(LS_KEY(state.currentProject), JSON.stringify(payload));
      if (refs.dirty) {
        await apiSave(payload, state.currentProject).catch(() => {});
        refs.dirty = false;
      }
    }
  } catch {}
  hist.undo = []; hist.redo = [];
  state.currentProject = id;
  localStorage.setItem('wcf_active_project', id);

  // Load proyek baru: DB dulu (sumber utama), fallback localStorage
  let data = null;
  try {
    const json = await apiLoad(id);
    if (json && json.ok && json.data !== null && json.data !== undefined
        && typeof json.data.nodes === 'object') {
      data = json.data;
      try { localStorage.setItem(LS_KEY(id), JSON.stringify(data)); } catch {}
    }
  } catch {
    // DB gagal, coba localStorage
    if (workspaceContext().type === 'personal') {
      try {
        const raw = localStorage.getItem(LS_KEY(id));
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed.nodes === 'object') data = parsed;
        }
      } catch {}
    }
  }

  const loaded = data ?? { nodes: {}, connections: [], nextId: 1 };
  applyData(loaded);
  if (loaded.nodes && Object.keys(loaded.nodes).length > 0) {
    requestAnimationFrame(() => fitToNodes());
  }
  refs.dirty = false;
  renderSidebar();
  document.dispatchEvent(new CustomEvent('wcf:project-changed', { detail: { projectId: id } }));
}

// ── Paste file ───────────────────────────────────────────────
export async function pasteFile(targetArr, parentNode) {
  if (!refs.fileClipboard) return;
  const cb = refs.fileClipboard;
  const newId   = genId();
  const newName = cb.name + ' (salinan)';
  if (cb.data) {
    await apiSave(cb.data, newId).catch(() => {});
  }
  targetArr.push({ id: newId, name: newName, type: 'file' });
  if (parentNode) parentNode.expanded = true;
  // update badge
  if (cb.data) refs.nodeCounts[newId] = Object.keys(cb.data.nodes || {}).length;
  await saveWorkspaceTree();
  renderSidebar();
  flash(`✓ "${newName}" ditempel`, true);
}

// ── Load data canvas untuk proyek aktif saat startup ─────────
const LS_KEY = id => `wcf_data_${id}`;

export async function loadCurrentProject() {
  const projectId = state.currentProject;
  if (!projectId) { refs.initialized = true; return; }

  console.log('[WCF] loadCurrentProject start, projectId:', projectId);

  let data   = null;
  let source = 'none';

  // 1. DB DULU — sumber kebenaran utama (sync antar browser/incognito)
  try {
    const json = await apiLoad(projectId);
    console.log('[WCF] DB response ok:', json?.ok, 'data:', json?.data != null,
                'nodes:', json?.data?.nodes ? Object.keys(json.data.nodes).length : 'null');
    if (json && json.ok && json.data !== null && json.data !== undefined
        && typeof json.data.nodes === 'object') {
      data   = json.data;
      source = 'database';
      console.log('[WCF] found in DB, nodes:', Object.keys(data.nodes).length);
      // Sinkronkan ke localStorage sebagai cache lokal
      try { localStorage.setItem(LS_KEY(projectId), JSON.stringify(data)); } catch {}
    }
  } catch (e) {
    console.warn('[WCF] DB load error, akan coba localStorage:', e);
  }

  // 2. Fallback: localStorage (jika DB gagal/tidak tersedia)
  if (!data && workspaceContext().type === 'personal') {
    try {
      const raw = localStorage.getItem(LS_KEY(projectId));
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.nodes === 'object') {
          data   = parsed;
          source = 'localStorage';
          console.log('[WCF] found in localStorage (fallback), nodes:', Object.keys(data.nodes).length);
        }
      }
    } catch (e) {
      console.warn('[WCF] localStorage load error:', e);
    }
  }

  console.log('[WCF] loadCurrentProject result — source:', source,
              '| nodes:', data ? Object.keys(data.nodes).length : 0);

  if (data) {
    applyData(data);
    // Auto-fit ke posisi node setelah load — supaya tidak kelihatan canvas kosong
    if (Object.keys(data.nodes).length > 0) {
      requestAnimationFrame(() => fitToNodes());
    }
  } else {
    // Proyek benar-benar baru — tampilkan canvas kosong, tidak auto-create node
    // supaya auto-save tidak langsung menimpa data yang belum terload
    console.log('[WCF] new project — empty canvas');
    applyData({ nodes: {}, connections: [], nextId: 1 });
  }

  // Tandai init selesai — auto-save boleh jalan mulai sekarang
  refs.initialized = true;
  refs.dirty       = false; // reset dirty setelah load
  document.dispatchEvent(new CustomEvent('wcf:project-changed', { detail: { projectId } }));
}
