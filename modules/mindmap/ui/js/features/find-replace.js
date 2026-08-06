// ── js/features/find-replace.js ──────────────────────────────
import { state, $id, pushUndo, refs }  from '../state.js';
import { flash }                       from '../ui/flash.js';
import { renderLines }                 from '../canvas/connection.js';
import { applyNodeStyle }              from '../canvas/node.js';

let _matches   = [];   // array of node ids matching current search
let _cursor    = -1;   // index into _matches

// ── public API ───────────────────────────────────────────────

export function openFindReplace() {
  const panel = $id('find-replace-panel');
  if (!panel) return;
  panel.classList.remove('hidden');
  $id('fr-find')?.focus();
  _clearHighlights();
}

export function closeFindReplace() {
  const panel = $id('find-replace-panel');
  if (!panel) return;
  panel.classList.add('hidden');
  _clearHighlights();
  _matches = []; _cursor = -1;
}

export function initFindReplace() {
  const panel    = $id('find-replace-panel');
  if (!panel) return;

  const inp      = $id('fr-find');
  const repInp   = $id('fr-replace');
  const btnPrev  = $id('fr-prev');
  const btnNext  = $id('fr-next');
  const btnRep   = $id('fr-replace-one');
  const btnRepAll= $id('fr-replace-all');
  const btnClose = $id('fr-close');
  const counter  = $id('fr-counter');
  const cbCase   = $id('fr-case');

  function doSearch() {
    _clearHighlights();
    const q = inp?.value.trim();
    if (!q) { _matches = []; _cursor = -1; _updateCounter(); return; }
    const cs = cbCase?.checked;
    _matches = Object.keys(state.nodes).filter(id => {
      const t = state.nodes[id].text || '';
      return cs ? t.includes(q) : t.toLowerCase().includes(q.toLowerCase());
    });
    _cursor = _matches.length ? 0 : -1;
    _highlightAll();
    _scrollToCurrent();
    _updateCounter();
  }

  inp?.addEventListener('input', doSearch);
  cbCase?.addEventListener('change', doSearch);

  btnNext?.addEventListener('click', () => {
    if (!_matches.length) return;
    _cursor = (_cursor + 1) % _matches.length;
    _scrollToCurrent();
    _updateCounter();
  });

  btnPrev?.addEventListener('click', () => {
    if (!_matches.length) return;
    _cursor = (_cursor - 1 + _matches.length) % _matches.length;
    _scrollToCurrent();
    _updateCounter();
  });

  btnRep?.addEventListener('click', () => {
    if (_cursor < 0 || !_matches.length) return;
    const id  = _matches[_cursor];
    const n   = state.nodes[id];
    if (!n) return;
    const q   = inp?.value || '';
    const rep = repInp?.value || '';
    if (!q) return;
    pushUndo();
    const cs  = cbCase?.checked;
    n.text = cs
      ? n.text.replaceAll(q, rep)
      : n.text.replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), rep);
    applyNodeStyle(id);
    refs.dirty = true;
    flash(`✓ 1 penggantian`, true);
    doSearch();
  });

  btnRepAll?.addEventListener('click', () => {
    const q   = inp?.value || '';
    const rep = repInp?.value || '';
    if (!q || !_matches.length) return;
    pushUndo();
    const cs  = cbCase?.checked;
    let count = 0;
    for (const id of _matches) {
      const n = state.nodes[id];
      if (!n) continue;
      const before = n.text;
      n.text = cs
        ? n.text.replaceAll(q, rep)
        : n.text.replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), rep);
      if (n.text !== before) { applyNodeStyle(id); count++; }
    }
    refs.dirty = true;
    renderLines();
    flash(`✓ ${count} penggantian selesai`, true);
    doSearch();
  });

  btnClose?.addEventListener('click', closeFindReplace);

  // Keyboard: Enter = next, Shift+Enter = prev, Escape = close
  panel.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeFindReplace(); return; }
    if (e.key === 'Enter' && e.target === inp) {
      e.preventDefault();
      if (e.shiftKey) btnPrev?.click();
      else            btnNext?.click();
    }
  });

  function _updateCounter() {
    if (!counter) return;
    if (!_matches.length) { counter.textContent = inp?.value ? '0 ditemukan' : ''; return; }
    counter.textContent = `${_cursor + 1} / ${_matches.length}`;
  }
}

// ── helpers ──────────────────────────────────────────────────

function _clearHighlights() {
  document.querySelectorAll('.node.fr-match, .node.fr-current').forEach(el => {
    el.classList.remove('fr-match', 'fr-current');
  });
}

function _highlightAll() {
  _matches.forEach((id, i) => {
    const el = document.getElementById('node-' + id);
    if (el) el.classList.add(i === _cursor ? 'fr-current' : 'fr-match');
  });
}

function _scrollToCurrent() {
  _clearHighlights();
  _highlightAll();
  if (_cursor < 0) return;
  const id = _matches[_cursor];
  // Import lazily to avoid circular dep
  import('../canvas/transform.js').then(({ panToNode }) => panToNode(id));
}
