// ── js/sidebar/search.js ─────────────────────────────────────
import { refs }           from '../state.js';
import { renderSidebar }  from './tree.js';

export function initSearch() {
  const inp = document.getElementById('sidebar-search');
  if (!inp) return;
  inp.addEventListener('input', () => {
    refs.treeFilter = inp.value.trim();
    renderSidebar();
  });
  inp.addEventListener('keydown', e => {
    if (e.key === 'Escape') { inp.value = ''; refs.treeFilter = ''; renderSidebar(); }
  });
}
