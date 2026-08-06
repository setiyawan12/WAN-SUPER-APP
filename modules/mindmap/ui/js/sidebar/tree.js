// ── js/sidebar/tree.js ───────────────────────────────────────
import { state, refs }                         from '../state.js';
import { switchProject, saveWorkspaceTree, findNode, findParent,
         removeNode, isDescendant, collectFileIds,
         genId, escHtml, MAX_DEPTH, pasteFile } from './workspace.js';
import { flash }                               from '../ui/flash.js';
import { wcfPrompt, wcfConfirm }              from '../ui/modal.js';
import { apiDelete }                           from '../api.js';
import { renderLog }                           from '../features/history-log.js';

const $list     = () => document.getElementById('project-list');
const $projCtx  = () => document.getElementById('proj-ctx');
let treeCtxNode = null, treeCtxDepth = 0;

// ── Render ───────────────────────────────────────────────────
export function renderSidebar() {
  const list = $list();
  if (!list || !refs.workspaceTree) return;
  // Keep scroll position
  const scrollTop = list.scrollTop;
  list.innerHTML = '';
  const filter = refs.treeFilter.toLowerCase();
  renderChildren(refs.workspaceTree.children || [], list, 1, filter);
  list.scrollTop = scrollTop;
  renderLog();
}

function matchesFilter(node, filter) {
  if (!filter) return true;
  if (node.name.toLowerCase().includes(filter)) return true;
  if (node.type === 'folder') return (node.children || []).some(c => matchesFilter(c, filter));
  return false;
}

function renderChildren(children, container, depth, filter) {
  for (const node of children) {
    if (filter && !matchesFilter(node, filter)) continue;
    container.appendChild(buildTreeItem(node, depth, filter));
    if (node.type === 'folder' && (node.expanded || filter) && node.children?.length) {
      renderChildren(node.children, container, depth + 1, filter);
    }
  }
}

function buildTreeItem(node, depth, filter = '') {
  const isActive  = node.type === 'file' && node.id === state.currentProject;

  const el = document.createElement('div');
  el.className = [
    'group flex items-center gap-1 py-[5px] pr-2 cursor-pointer text-[12.5px]',
    'transition-colors select-none overflow-hidden whitespace-nowrap',
    isActive ? 'wcf-tree-active' : 'wcf-tree-inactive',
  ].join(' ');
  el.dataset.id   = node.id;
  el.dataset.type = node.type;
  el.style.paddingLeft = (10 + depth * 14) + 'px';

  const togCls  = 'flex-shrink-0 wcf-tree-toggle' + ' ' + 'w-3.5 text-center text-[9px]';
  const spcCls  = 'flex-shrink-0 w-3.5';
  const icoCls  = 'flex-shrink-0 text-xs leading-none';
  const namCls  = 'flex-1 overflow-hidden text-ellipsis font-medium min-w-0';
  const badgeCls = 'flex-shrink-0 text-[9px] wcf-tree-badge tabular-nums mr-0.5';
  const mnuCls  = 'flex-shrink-0 opacity-0 group-hover:opacity-100 text-[11px] tracking-widest px-1 py-0.5 rounded transition-all wcf-tree-menu-btn';

  // Highlight filter match
  const displayName = filter
    ? escHtml(node.name).replace(new RegExp(`(${escHtml(filter)})`, 'gi'), '<mark class="bg-yellow-400/30 rounded px-0.5">$1</mark>')
    : escHtml(node.name);

  // Badge (node count for files)
  const count = node.type === 'file' && refs.nodeCounts[node.id] != null
    ? `<span class="${badgeCls}">${refs.nodeCounts[node.id]}</span>` : '';

  if (node.type === 'folder') {
    el.innerHTML = `
      <span class="${togCls}">${node.expanded ? '▾' : '▸'}</span>
      <span class="${icoCls}">${node.expanded ? '📂' : '📁'}</span>
      <span class="${namCls}">${displayName}</span>
      ${count}
      <span class="${mnuCls}" title="Opsi">···</span>`;
    el.addEventListener('click', e => {
      if (e.target.title === 'Opsi') return;
      node.expanded = !node.expanded;
      renderSidebar();
      saveWorkspaceTree();
    });
  } else {
    el.innerHTML = `
      <span class="${spcCls}"></span>
      <span class="${icoCls}">${isActive ? '⚡' : '📄'}</span>
      <span class="${namCls}">${displayName}</span>
      ${count}
      <span class="${mnuCls}" title="Opsi">···</span>`;
    el.addEventListener('click', e => {
      if (e.target.title === 'Opsi') return;
      switchProject(node.id);
    });
    // Dblclick name → inline rename
    el.querySelector(`.${namCls.split(' ')[0]}`)?.addEventListener('dblclick', e => {
      e.stopPropagation();
      startInlineRename(el, node);
    });
  }

  // ··· menu
  el.querySelector('[title="Opsi"]').addEventListener('click', e => {
    e.stopPropagation();
    showTreeCtx(e.clientX, e.clientY, node, depth);
  });
  el.addEventListener('contextmenu', e => {
    e.preventDefault();
    showTreeCtx(e.clientX, e.clientY, node, depth);
  });

  // ── Drag & Drop ──────────────────────────────────────────────
  el.setAttribute('draggable', 'true');
  el.addEventListener('dragstart', e => {
    refs.dragSrcId = node.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', node.id);
    setTimeout(() => el.classList.add('wcf-dragging'), 0);
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('wcf-dragging');
    document.querySelectorAll('.wcf-drag-over,.wcf-drag-insert').forEach(x => {
      x.classList.remove('wcf-drag-over','wcf-drag-insert');
    });
    refs.dragSrcId = null;
  });
  el.addEventListener('dragover', e => {
    if (!refs.dragSrcId || refs.dragSrcId === node.id) return;
    const src = findNode(refs.workspaceTree, refs.dragSrcId);
    if (src?.type === 'folder' && isDescendant(src, node.id)) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.wcf-drag-over,.wcf-drag-insert').forEach(x => {
      x.classList.remove('wcf-drag-over','wcf-drag-insert');
    });
    el.classList.add('wcf-drag-over');
    if (node.type !== 'folder') el.classList.add('wcf-drag-insert');
  });
  el.addEventListener('dragleave', e => {
    if (el.contains(e.relatedTarget)) return;
    el.classList.remove('wcf-drag-over','wcf-drag-insert');
  });
  el.addEventListener('drop', async e => {
    e.preventDefault();
    el.classList.remove('wcf-drag-over','wcf-drag-insert');
    if (!refs.dragSrcId || refs.dragSrcId === node.id) return;
    const srcNode = findNode(refs.workspaceTree, refs.dragSrcId);
    if (!srcNode) return;
    if (srcNode.type === 'folder' && isDescendant(srcNode, node.id)) return;
    removeNode(refs.workspaceTree, refs.dragSrcId);
    if (node.type === 'folder') {
      (node.children = node.children || []).push(srcNode);
      node.expanded = true;
    } else {
      const parent = findParent(refs.workspaceTree, node.id);
      const arr    = parent?.children ?? refs.workspaceTree.children;
      const idx    = arr.findIndex(c => c.id === node.id);
      arr.splice(idx + 1, 0, srcNode);
    }
    await saveWorkspaceTree();
    renderSidebar();
    flash('✓ Dipindahkan', true);
  });

  return el;
}

// ── Inline rename ────────────────────────────────────────────
function startInlineRename(el, node) {
  const nameEl = el.querySelector('.flex-1');
  if (!nameEl) return;
  const before = node.name;
  nameEl.contentEditable = 'true';
  nameEl.focus();
  const sel = window.getSelection(), rng = document.createRange();
  rng.selectNodeContents(nameEl); sel.removeAllRanges(); sel.addRange(rng);

  const finish = async () => {
    nameEl.contentEditable = 'false';
    const newName = nameEl.textContent.trim();
    if (!newName || newName === before) { nameEl.textContent = before; return; }
    node.name = newName;
    await saveWorkspaceTree();
    flash('✓ Diubah namanya', true);
    renderSidebar();
  };
  nameEl.addEventListener('blur', finish, { once: true });
  nameEl.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
    if (e.key === 'Escape') { nameEl.textContent = before; nameEl.blur(); }
  });
}

// ── Context menu ─────────────────────────────────────────────
function showTreeCtx(x, y, node, depth) {
  treeCtxNode  = node;
  treeCtxDepth = depth;
  const isFolder = node.type === 'folder';
  const S = s => { const el = document.getElementById(s); if(el) el.style.display = ''; return el; };
  const H = s => { const el = document.getElementById(s); if(el) el.style.display = 'none'; };

  isFolder ? S('proj-ctx-add-file') : H('proj-ctx-add-file');
  (isFolder && depth < MAX_DEPTH) ? S('proj-ctx-add-folder') : H('proj-ctx-add-folder');
  isFolder ? S('proj-ctx-sep') : H('proj-ctx-sep');
  !isFolder ? S('proj-ctx-copy') : H('proj-ctx-copy');
  refs.fileClipboard ? S('proj-ctx-paste') : H('proj-ctx-paste');
  // Bagikan — hanya untuk file
  !isFolder ? S('proj-ctx-share') : H('proj-ctx-share');
  !isFolder ? S('proj-ctx-sep2') : H('proj-ctx-sep2');

  const menu = $projCtx();
  const menuW = 180, menuH = 200;
  menu.style.left = Math.min(x, innerWidth  - menuW - 8) + 'px';
  menu.style.top  = Math.min(y, innerHeight - menuH - 8) + 'px';
  menu.classList.remove('hidden');
}

function hideTreeCtx() {
  $projCtx()?.classList.add('hidden');
  treeCtxNode = null;
}

// ── Context menu actions ─────────────────────────────────────
export function initTreeCtxHandlers() {
  document.getElementById('proj-ctx-add-file')?.addEventListener('click', async () => {
    const folder = treeCtxNode; hideTreeCtx();
    if (!folder) return;
    const name = await wcfPrompt('Nama file baru:');
    if (!name) return;
    const id = genId();
    (folder.children = folder.children || []).push({ id, name, type: 'file' });
    folder.expanded = true;
    await saveWorkspaceTree(); renderSidebar();
    await switchProject(id);
  });

  document.getElementById('proj-ctx-add-folder')?.addEventListener('click', async () => {
    const parent = treeCtxNode; const depth = treeCtxDepth; hideTreeCtx();
    if (!parent) return;
    if (depth >= MAX_DEPTH) { flash(`Maks ${MAX_DEPTH} level sub-folder`, false); return; }
    const name = await wcfPrompt('Nama folder baru:');
    if (!name) return;
    (parent.children = parent.children || []).push(
      { id: genId(), name, type: 'folder', expanded: true, children: [] }
    );
    parent.expanded = true;
    await saveWorkspaceTree(); renderSidebar();
  });

  document.getElementById('proj-ctx-copy')?.addEventListener('click', async () => {
    const node = treeCtxNode; hideTreeCtx();
    if (!node || node.type !== 'file') return;
    try {
      const { apiLoad } = await import('../api.js');
      const res = await apiLoad(node.id);
      refs.fileClipboard = { id: node.id, name: node.name, data: res.ok ? res.data : null };
    } catch { refs.fileClipboard = { id: node.id, name: node.name, data: null }; }
    document.getElementById('btn-paste-root').hidden = false;
    flash(`📋 "${node.name}" disalin`, true);
  });

  document.getElementById('proj-ctx-paste')?.addEventListener('click', async () => {
    const folder = treeCtxNode; hideTreeCtx();
    if (!folder || !refs.fileClipboard) return;
    await pasteFile(folder.children = folder.children || [], folder);
  });

  document.getElementById('proj-ctx-rename')?.addEventListener('click', async () => {
    const node = treeCtxNode; hideTreeCtx();
    if (!node) return;
    const newName = await wcfPrompt('Nama baru:', node.name);
    if (!newName || newName === node.name) return;
    node.name = newName;
    await saveWorkspaceTree(); renderSidebar();
    flash('✓ Diubah namanya', true);
  });

  document.getElementById('proj-ctx-delete')?.addEventListener('click', async () => {
    const node = treeCtxNode; hideTreeCtx();
    if (!node) return;
    if (node.id === 'default') { flash('File "Default" tidak bisa dihapus', false); return; }
    // Move to trash instead of permanent delete
    const trashKey = 'wcf_trash_' + (state.currentUser?.id || 'personal');
    let trashItems;
    try { trashItems = JSON.parse(localStorage.getItem(trashKey) || '[]'); } catch { trashItems = []; }
    trashItems.unshift({ node: JSON.parse(JSON.stringify(node)), deletedAt: Date.now() });
    if (trashItems.length > 30) trashItems = trashItems.slice(0, 30);
    localStorage.setItem(trashKey, JSON.stringify(trashItems));
    const ids        = collectFileIds(node);
    const needSwitch = ids.includes(state.currentProject) || node.id === state.currentProject;
    removeNode(refs.workspaceTree, node.id);
    await saveWorkspaceTree();
    if (needSwitch) await switchProject('default');
    renderSidebar();
    flash(`🗑 "${node.name}" dipindahkan ke Sampah`, true);
    renderTrash();
  });

  document.getElementById('proj-ctx-share')?.addEventListener('click', () => {
    const node = treeCtxNode; hideTreeCtx();
    if (!node || node.type !== 'file') return;
    // Delegate ke fungsi share modal yang ada di index.html (inline script)
    if (typeof window.wcfOpenShareModal === 'function') {
      window.wcfOpenShareModal({ id: node.id, name: node.name });
    }
  });

  document.addEventListener('click', e => {
    if (!$projCtx()?.contains(e.target)) hideTreeCtx();
  });
}

// ── Trash / Recycle Bin ───────────────────────────────────────
export function renderTrash() {
  const wrap = document.getElementById('trash-section');
  if (!wrap) return;
  const trashKey = 'wcf_trash_' + (state.currentUser?.id || 'personal');
  let items;
  try { items = JSON.parse(localStorage.getItem(trashKey) || '[]'); } catch { items = []; }
  const countEl = document.getElementById('trash-count');
  if (countEl) countEl.textContent = items.length ? String(items.length) : '';
  const list = document.getElementById('trash-list');
  if (!list) return;
  if (!items.length) {
    list.innerHTML = '<div style="padding:8px 12px;font-size:11px;color:var(--text-3)">Sampah kosong</div>';
    return;
  }
  list.innerHTML = '';
  items.forEach((item, idx) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 8px;border-radius:6px;';
    row.innerHTML = `
      <span style="flex:1;font-size:11px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${item.node.type === 'folder' ? '📁' : '📄'} ${item.node.name}</span>
      <button data-idx="${idx}" data-action="restore" style="font-size:10px;padding:2px 6px;border-radius:4px;background:var(--accent-muted);color:var(--accent);border:1px solid var(--accent-border)">Pulihkan</button>
      <button data-idx="${idx}" data-action="purge"   style="font-size:10px;padding:2px 6px;border-radius:4px;background:rgba(239,68,68,0.1);color:#f87171;border:1px solid rgba(239,68,68,0.3)">✕</button>
    `;
    list.appendChild(row);
  });
  list.addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const idx = parseInt(btn.dataset.idx);
    let trashItems;
    try { trashItems = JSON.parse(localStorage.getItem(trashKey) || '[]'); } catch { trashItems = []; }
    const item = trashItems[idx];
    if (!item) return;
    if (btn.dataset.action === 'restore') {
      // Restore to workspace root
      (refs.workspaceTree.children = refs.workspaceTree.children || []).push(item.node);
      trashItems.splice(idx, 1);
      localStorage.setItem(trashKey, JSON.stringify(trashItems));
      await saveWorkspaceTree();
      renderSidebar(); renderTrash();
      flash(`✓ "${item.node.name}" dipulihkan`, true);
    } else if (btn.dataset.action === 'purge') {
      // Permanently delete
      const ids = collectFileIds(item.node);
      for (const id of ids) await apiDelete(id).catch(() => {});
      trashItems.splice(idx, 1);
      localStorage.setItem(trashKey, JSON.stringify(trashItems));
      renderTrash();
      flash('🗑 Dihapus permanen', true);
    }
  }, { capture: true });
}

// ── Root header buttons ──────────────────────────────────────
export function initSidebarButtons() {
  document.getElementById('btn-new-file')?.addEventListener('click', async () => {
    const name = await wcfPrompt('Nama file baru:');
    if (!name) return;
    const id = genId();
    (refs.workspaceTree.children = refs.workspaceTree.children || []).push({ id, name, type: 'file' });
    await saveWorkspaceTree(); renderSidebar();
    await switchProject(id);
  });

  document.getElementById('btn-new-folder')?.addEventListener('click', async () => {
    const name = await wcfPrompt('Nama folder baru:');
    if (!name) return;
    (refs.workspaceTree.children = refs.workspaceTree.children || []).push(
      { id: genId(), name, type: 'folder', expanded: true, children: [] }
    );
    await saveWorkspaceTree(); renderSidebar();
  });

  document.getElementById('btn-paste-root')?.addEventListener('click', async () => {
    if (!refs.fileClipboard) return;
    await pasteFile(refs.workspaceTree.children = refs.workspaceTree.children || [], null);
  });
}
