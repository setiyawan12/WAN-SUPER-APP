// ── js/canvas/node.js ────────────────────────────────────────
import { state, ui, $c, $cv, $el, COLORS, pushUndo, snapshot, selectedNodes, refs } from '../state.js';
import { renderLines, syncColors, addConnection }                          from './connection.js';
import { selectNode, clearSelection }                                        from './selection.js';
import { logAction }                                                         from '../features/history-log.js';
import { showCtxMenu }                                                       from '../ui/ctx-menu.js';
import { toCanvas }                                                          from './transform.js';
import { renderMd }                                                          from '../features/markdown.js';

// Batas ukuran gambar: 200KB base64 (≈ 150KB file asli)
const MAX_IMG_BYTES = 200 * 1024;

export function buildEl(node) {
  const el = document.createElement('div');
  el.className  = 'node';
  el.id         = 'node-' + node.id;
  el.dataset.id = node.id;
  el.style.left = node.x + 'px';
  el.style.top  = node.y + 'px';
  if (node.width) el.style.width = node.width + 'px';

  // ── Visual style props ───────────────────────────────────────
  const WCF_SHAPES = ['sharp','pill','diamond','oval','circle','hexagon','triangle',
                      'parallelogram','trapezoid','pentagon','chevron','cylinder','star'];
  if (node.shape && WCF_SHAPES.includes(node.shape)) {
    el.classList.add('shape-' + node.shape);
  }
  if (node.fontSize === 'sm') el.classList.add('fs-sm');
  else if (node.fontSize === 'lg') el.classList.add('fs-lg');
  else if (node.fontSize === 'xl') el.classList.add('fs-xl');
  if (node.pinned) el.classList.add('is-pinned');
  if (node.borderStyle && node.borderStyle !== 'solid') el.classList.add('border-' + node.borderStyle);

  // ── Gambar (opsional) ────────────────────────────────────────
  if (node.image) {
    const imgWrap = document.createElement('div');
    imgWrap.className = 'node-img-wrap';

    const img = document.createElement('img');
    img.className  = 'node-img';
    img.src        = node.image;
    img.alt        = '';
    img.draggable  = false;
    imgWrap.appendChild(img);

    const rmBtn = document.createElement('button');
    rmBtn.className   = 'node-img-remove';
    rmBtn.title       = 'Hapus gambar';
    rmBtn.textContent = '✕';
    rmBtn.addEventListener('click', e => {
      e.stopPropagation();
      pushUndo();
      delete state.nodes[node.id].image;
      imgWrap.remove();
      refs.dirty = true;
    });
    imgWrap.appendChild(rmBtn);

    el.appendChild(imgWrap);
  }

  // Emoji prefix
  if (node.emoji) {
    const ep = document.createElement('span');
    ep.className = 'node-emoji';
    ep.textContent = node.emoji;
    el.appendChild(ep);
  }

  // Main text (rendered markdown)
  const span = document.createElement('span');
  span.className = 'node-text';
  span.innerHTML = renderMd(node.text);
  if (node.textColor) span.style.color = node.textColor;
  if (node.textAlign && node.textAlign !== 'left') span.classList.add('ta-' + node.textAlign);
  el.appendChild(span);

  // Note/label
  const note = document.createElement('span');
  note.className   = 'node-note';
  note.textContent = node.note || '';
  note.style.display = node.note ? 'block' : 'none';
  el.appendChild(note);

  // Connector dot
  const dot = document.createElement('div');
  dot.className = 'conn-dot';
  el.appendChild(dot);

  // Resize handle
  const rz = document.createElement('div');
  rz.className = 'node-resize-handle';
  el.appendChild(rz);

  // Pin badge
  if (node.pinned) {
    const pin = document.createElement('div');
    pin.className = 'node-pin-badge';
    pin.textContent = '📌';
    el.appendChild(pin);
  }

  // Status badge (todo / progress / done)
  if (node.status) {
    const sb = document.createElement('div');
    sb.className = `node-status-badge status-${node.status}`;
    const labels = { todo: '○ Todo', progress: '◑ Progress', done: '● Done' };
    sb.textContent = labels[node.status] || node.status;
    el.appendChild(sb);
  }

  // File link badge
  if (node.fileLink) {
    const fl = document.createElement('div');
    fl.className = 'node-file-link-badge';
    fl.textContent = '🔗 ' + node.fileLink;
    fl.title = `Ctrl+klik untuk buka: ${node.fileLink}`;
    el.appendChild(fl);
  }

  // Due date badge
  _applyDueDateBadge(el, node);
  // Tags
  _applyTagBadges(el, node);
  // Checklist
  _applyChecklistBadge(el, node);

  // ── Events ──────────────────────────────────────────────────

  // Click → select
  el.addEventListener('click', e => {
    if (e.target === dot || e.target === rz || e.target.classList.contains('node-resize-handle')) return;
    if (e.target.classList.contains('node-collapse-btn')) return; // tombol collapse handle sendiri
    if (span.contentEditable === 'true' || note.contentEditable === 'true') return;
    if (ui.suppressClick) { ui.suppressClick = false; return; }
    e.stopPropagation();
    // Ctrl+click → buka linked file jika ada
    if ((e.ctrlKey || e.metaKey) && state.nodes[node.id]?.fileLink) {
      const fileLink = state.nodes[node.id].fileLink;
      // Dispatch custom event agar app.js bisa handle switchProject
      document.dispatchEvent(new CustomEvent('wcf:open-file-link', { detail: { name: fileLink } }));
      return;
    }
    selectNode(node.id, e.ctrlKey || e.metaKey || e.shiftKey);
  });

  // Drag node
  el.addEventListener('mousedown', e => {
    if (e.button !== 0 || e.target === dot || e.target === rz || e.target.classList.contains('node-resize-handle')) return;
    if (e.target.classList.contains('node-collapse-btn')) return; // jangan trigger drag saat klik collapse
    if (span.contentEditable === 'true' || note.contentEditable === 'true') return;
    if (e.target.classList.contains('node-edit-textarea')) return; // don't drag while editing
    if (e.target.classList.contains('node-img-remove')) return;
    if (e.target.closest('a.node-link')) return; // biarkan klik link jalan normal
    e.preventDefault(); e.stopPropagation();

    // Jika node ini ada di grup, auto-expand selection ke semua member grup
    // sehingga drag satu node = semua node se-grup ikut bergerak.
    const gId = state.nodes[node.id]?.groupId;
    if (gId && state.groups?.[gId]) {
      for (const nId in state.nodes) {
        if (state.nodes[nId].groupId === gId) selectedNodes.add(nId);
      }
      // Update visual selection state
      for (const nId of selectedNodes) {
        const nEl = $el(nId);
        if (nEl) nEl.classList.add('is-selected');
      }
    }

    const p = toCanvas(e.clientX, e.clientY);
    ui.dragging = {
      nodeId: node.id,
      offX: p.x - node.x,
      offY: p.y - node.y,
      startX: node.x, startY: node.y,
      startClientX: e.clientX,
      startClientY: e.clientY,
      hasMoved: false,
      beforeSnap: snapshot(),
    };
    el.classList.add('is-dragging');
  });

  // Dblclick node text → edit
  span.addEventListener('dblclick', e => {
    e.stopPropagation();
    clearSelection();
    beginEdit(node.id, span);
  });

  // Dblclick note → edit note
  note.addEventListener('dblclick', e => {
    e.stopPropagation();
    beginNoteEdit(node.id, note);
  });

  // Right-click → ctx menu
  el.addEventListener('contextmenu', e => {
    e.preventDefault(); e.stopPropagation();
    showCtxMenu(e.clientX, e.clientY, node.id);
  });

  // Connector dot
  dot.addEventListener('mousedown', e => {
    e.preventDefault(); e.stopPropagation();
    const p = toCanvas(e.clientX, e.clientY);
    ui.connecting = { fromId: node.id, curX: p.x, curY: p.y };
  });

  // Resize handle
  rz.addEventListener('mousedown', e => {
    e.preventDefault(); e.stopPropagation();
    ui.resizing = {
      nodeId: node.id, startW: el.offsetWidth, startX: e.clientX,
      beforeSnap: snapshot(),
    };
  });

  return el;
}

// ── Wrap selection in textarea with markdown marker ──────────
function _wrapTa(ta, marker) {
  const s = ta.selectionStart, e = ta.selectionEnd;
  const v = ta.value;
  const sel = v.slice(s, e);
  if (sel) {
    ta.value = v.slice(0, s) + marker + sel + marker + v.slice(e);
    ta.selectionStart = s + marker.length;
    ta.selectionEnd   = e + marker.length;
  } else {
    ta.value = v.slice(0, s) + marker + marker + v.slice(s);
    ta.selectionStart = ta.selectionEnd = s + marker.length;
  }
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
}

// ── Toggle list prefix on current line ──────────────────────
function _togglePrefix(ta, prefix) {
  const s  = ta.selectionStart;
  const v  = ta.value;
  const ls = v.lastIndexOf('\n', s - 1) + 1;
  const le = v.indexOf('\n', s);
  const ln = v.slice(ls, le === -1 ? v.length : le);

  if (ln.startsWith(prefix)) {
    // Already has this prefix → remove it
    ta.value = v.slice(0, ls) + ln.slice(prefix.length) + v.slice(le === -1 ? v.length : le);
    ta.selectionStart = ta.selectionEnd = Math.max(ls, s - prefix.length);
  } else {
    // Remove any existing list prefix, add new one
    const stripped = ln.replace(/^([-*•]\s|\d+\.\s)/, '');
    const removed  = ln.length - stripped.length;
    ta.value = v.slice(0, ls) + prefix + stripped + v.slice(le === -1 ? v.length : le);
    ta.selectionStart = ta.selectionEnd = s + prefix.length - removed;
  }
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
}

// ── Floating mini-toolbar ────────────────────────────────────
function _createEditToolbar(id, ta) {
  document.querySelector('.node-edit-toolbar')?.remove();

  const n      = state.nodes[id];
  const nodeEl = $el(id);
  if (!n || !nodeEl) return null;

  const tb = document.createElement('div');
  tb.className = 'node-edit-toolbar';
  document.body.appendChild(tb);

  const mkBtn = (html, title, fn, cls = '') => {
    const b = document.createElement('button');
    b.innerHTML = html;
    b.title     = title;
    if (cls) b.className = cls;
    b.addEventListener('mousedown', e => { e.preventDefault(); fn(b); });
    tb.appendChild(b);
    return b;
  };
  const sep = () => {
    const s = document.createElement('span');
    s.className = 'tb-sep';
    tb.appendChild(s);
  };

  // Format buttons
  mkBtn('<b>B</b>', 'Bold — Ctrl+B',   () => _wrapTa(ta, '**'), 'tb-bold');
  mkBtn('<i>I</i>', 'Italic — Ctrl+I', () => _wrapTa(ta, '*'),  'tb-italic');
  sep();
  mkBtn('•',  'Bullet list',   () => _togglePrefix(ta, '- '));
  mkBtn('1.', 'Numbered list', () => _togglePrefix(ta, '1. '));
  sep();

  // Alignment buttons
  const setAlign = (val) => {
    pushUndo();
    n.textAlign = val;
    const nt = nodeEl.querySelector('.node-text');
    if (nt) {
      nt.classList.remove('ta-left','ta-center','ta-right','ta-justify');
      if (val && val !== 'left') nt.classList.add('ta-' + val);
    }
    tb.querySelectorAll('[data-align]').forEach(b =>
      b.classList.toggle('active', b.dataset.align === val));
    refs.dirty = true;
  };

  [['⬅','left','Rata kiri'],['▤','justify','Justify'],['↔','center','Tengah'],['➡','right','Rata kanan']].forEach(([icon, val, title]) => {
    const b = mkBtn(icon, title, () => setAlign(val));
    b.dataset.align = val;
    if ((n.textAlign ?? 'left') === val) b.classList.add('active');
  });

  // Keep the fixed toolbar anchored while the canvas pans, zooms, or resizes.
  const positionToolbar = () => {
    if (!tb.isConnected || !nodeEl.isConnected || !ta.isConnected) return;
    const rect = nodeEl.getBoundingClientRect();
    const tbH  = tb.offsetHeight || 38;
    const tbW  = tb.offsetWidth  || 320;
    let left = rect.left + (rect.width - tbW) / 2;
    let top  = rect.top - tbH - 8;
    if (left + tbW > window.innerWidth  - 8) left = window.innerWidth  - tbW - 8;
    if (left < 8) left = 8;
    if (top  < 8) top  = rect.bottom + 8; // flip below if no room above
    tb.style.left = Math.round(left) + 'px';
    tb.style.top  = Math.round(top)  + 'px';
  };
  let positionFrame = 0;
  let trackUntil = 0;
  const trackToolbar = (duration = 350) => {
    trackUntil = Math.max(trackUntil, performance.now() + duration);
    if (positionFrame) return;
    const tick = () => {
      positionToolbar();
      if (tb.isConnected && ta.isConnected && performance.now() < trackUntil) {
        positionFrame = requestAnimationFrame(tick);
      } else {
        positionFrame = 0;
      }
    };
    positionFrame = requestAnimationFrame(tick);
  };
  const handleLayoutChange = () => trackToolbar();
  positionToolbar();
  trackToolbar();
  window.addEventListener('resize', handleLayoutChange);
  document.addEventListener('wcf:canvas-transform', handleLayoutChange);
  tb.wcfDispose = () => {
    cancelAnimationFrame(positionFrame);
    window.removeEventListener('resize', handleLayoutChange);
    document.removeEventListener('wcf:canvas-transform', handleLayoutChange);
    tb.remove();
  };
  tb.wcfPosition = trackToolbar;

  return tb;
}

// ── Edit text — textarea overlay approach ────────────────────
// Using a real <textarea> gives accurate cursor control, native undo/redo,
// reliable selection APIs (selectionStart/End), and proper line-break handling.
export function beginEdit(id, spanEl) {
  const span = spanEl || $el(id)?.querySelector('.node-text');
  if (!span) return;
  const n = state.nodes[id];
  if (!n) return;
  // Bail if already editing this node
  if (span.querySelector('.node-edit-textarea')) return;

  const rawText = n.text ?? '';
  const before  = rawText;

  // ── Create textarea inside span ───────────────────────────
  span.innerHTML = ''; // clear rendered content
  const ta = document.createElement('textarea');
  ta.className   = 'node-edit-textarea';
  ta.value       = rawText;
  ta.spellcheck  = false;
  ta.autocorrect = 'off';
  span.appendChild(ta);

  // Auto-grow to fit content
  const autoGrow = () => {
    ta.style.height = '0';
    ta.style.height = ta.scrollHeight + 'px';
    renderLines();
  };

  // Show toolbar and focus after layout
  const tb = _createEditToolbar(id, ta);
  requestAnimationFrame(() => {
    autoGrow();
    tb?.wcfPosition?.();
    ta.focus();
    // Cursor di akhir teks — tidak select-all agar tidak muncul kotak seleksi per baris
    ta.selectionStart = ta.selectionEnd = rawText.length;
  });

  ta.addEventListener('input', autoGrow);

  // ── Commit ───────────────────────────────────────────────
  function commit() {
    if (!span.contains(ta)) return; // guard double-commit
    tb?.wcfDispose?.();
    const t = ta.value.replace(/\n{3,}/g, '\n\n').trim();
    const newText = t || 'Node';
    if (newText !== before) {
      pushUndo();
      logAction('edit', `"${before}" → "${newText}"`);
    }
    n.text = newText;
    span.innerHTML = renderMd(newText);
    // Re-apply alignment class
    span.classList.remove('ta-left','ta-center','ta-right','ta-justify');
    if (n.textAlign && n.textAlign !== 'left') span.classList.add('ta-' + n.textAlign);
    renderLines();
  }

  ta.addEventListener('blur', commit, { once: true });

  // ── Keyboard shortcuts ───────────────────────────────────
  ta.addEventListener('keydown', e => {
    const ctrl = e.ctrlKey || e.metaKey;

    // Format
    if (ctrl && e.key === 'b') { e.preventDefault(); _wrapTa(ta, '**'); return; }
    if (ctrl && e.key === 'i') { e.preventDefault(); _wrapTa(ta, '*');  return; }

    // Commit shortcuts
    if (e.key === 'Escape') {
      e.preventDefault();
      ta.removeEventListener('blur', commit);
      tb?.wcfDispose?.();
      n.text = before; // cancel — restore original
      span.innerHTML = renderMd(before);
      span.classList.remove('ta-left','ta-center','ta-right','ta-justify');
      if (n.textAlign && n.textAlign !== 'left') span.classList.add('ta-' + n.textAlign);
      renderLines();
      return;
    }
    if (e.key === 'Enter' && (e.shiftKey || e.metaKey)) { e.preventDefault(); ta.blur(); return; }

    // ── Smart Enter: auto-continue lists ─────────────────
    if (e.key === 'Enter') {
      const v  = ta.value;
      const s  = ta.selectionStart;
      const ls = v.lastIndexOf('\n', s - 1) + 1; // current line start
      const ln = v.slice(ls, s);                  // text from line start to cursor

      const bullM = ln.match(/^([-*•]) (.*)/s);
      const olM   = ln.match(/^(\d+)\. (.*)/s);

      if (bullM) {
        e.preventDefault();
        if (bullM[2].trim() === '') {
          // Empty bullet → exit list (remove prefix)
          ta.value = v.slice(0, ls) + v.slice(ls + bullM[1].length + 1);
          ta.selectionStart = ta.selectionEnd = ls;
        } else {
          // Continue bullet on next line
          const pfx = bullM[1] + ' ';
          ta.value = v.slice(0, s) + '\n' + pfx + v.slice(s);
          ta.selectionStart = ta.selectionEnd = s + 1 + pfx.length;
        }
        autoGrow(); return;
      }
      if (olM) {
        e.preventDefault();
        if (olM[2].trim() === '') {
          // Empty numbered → exit list
          ta.value = v.slice(0, ls) + v.slice(ls + olM[1].length + 2);
          ta.selectionStart = ta.selectionEnd = ls;
        } else {
          // Increment number and continue
          const pfx = (parseInt(olM[1]) + 1) + '. ';
          ta.value = v.slice(0, s) + '\n' + pfx + v.slice(s);
          ta.selectionStart = ta.selectionEnd = s + 1 + pfx.length;
        }
        autoGrow(); return;
      }
      // Normal Enter — let browser handle (inserts \n in textarea)
    }

    // Tab → create child node
    if (e.key === 'Tab') {
      e.preventDefault();
      ta.blur();
      setTimeout(() => {
        const nd = state.nodes[id];
        if (!nd) return;
        const w = $el(id)?.offsetWidth ?? (nd.width ?? 140);
        const cid = createNode(nd.x + w + 60, nd.y, 'Node baru');
        addConnection(id, cid);
        syncColors(); renderLines();
      }, 60);
    }
  });
}

function beginNoteEdit(id, noteEl) {
  noteEl.contentEditable = 'true';
  noteEl.style.display   = 'block';
  noteEl.focus();
  if (!noteEl.textContent) noteEl.textContent = '';
  const before = state.nodes[id]?.note ?? '';
  noteEl.addEventListener('blur', () => {
    noteEl.contentEditable = 'false';
    const t = (noteEl.innerText ?? noteEl.textContent).trim();
    if (t !== before) { pushUndo(); state.nodes[id].note = t; }
    if (!t) noteEl.style.display = 'none';
    renderLines();
  }, { once: true });
  noteEl.addEventListener('keydown', e => {
    if (e.key === 'Escape' || (e.key === 'Enter' && e.shiftKey)) { e.preventDefault(); noteEl.blur(); }
  });
}

// ── Apply visual style to existing node ─────────────────────
export function applyNodeStyle(id) {
  const n = state.nodes[id];
  const el = $el(id);
  if (!n || !el) return;
  // Shape — remove all shape classes then apply current one
  const WCF_SHAPES = ['sharp','pill','diamond','oval','circle','hexagon','triangle',
                      'parallelogram','trapezoid','pentagon','chevron','cylinder','star'];
  WCF_SHAPES.forEach(s => el.classList.remove('shape-' + s));
  if (n.shape && WCF_SHAPES.includes(n.shape)) el.classList.add('shape-' + n.shape);
  // Font size
  el.classList.remove('fs-sm', 'fs-lg', 'fs-xl');
  if (n.fontSize === 'sm') el.classList.add('fs-sm');
  else if (n.fontSize === 'lg') el.classList.add('fs-lg');
  else if (n.fontSize === 'xl') el.classList.add('fs-xl');
  // Text color + text align
  const span = el.querySelector('.node-text');
  if (span) {
    span.style.color = n.textColor || '';
    span.classList.remove('ta-left','ta-center','ta-right','ta-justify');
    if (n.textAlign && n.textAlign !== 'left') span.classList.add('ta-' + n.textAlign);
  }
  // Pin
  el.classList.toggle('is-pinned', !!n.pinned);
  el.querySelector('.node-pin-badge')?.remove();
  if (n.pinned) {
    const pin = document.createElement('div');
    pin.className = 'node-pin-badge';
    pin.textContent = '📌';
    el.appendChild(pin);
  }
  // File link badge
  el.querySelector('.node-file-link-badge')?.remove();
  if (n.fileLink) {
    const fl = document.createElement('div');
    fl.className = 'node-file-link-badge';
    fl.textContent = '🔗 ' + n.fileLink;
    fl.title = `Ctrl+klik untuk buka: ${n.fileLink}`;
    el.appendChild(fl);
  }
  // Emoji prefix
  el.querySelector('.node-emoji')?.remove();
  if (n.emoji) {
    const ep = document.createElement('span');
    ep.className = 'node-emoji';
    ep.textContent = n.emoji;
    el.insertBefore(ep, el.querySelector('.node-text'));
  }
  // Status badge
  el.querySelector('.node-status-badge')?.remove();
  if (n.status) {
    const sb = document.createElement('div');
    sb.className = `node-status-badge status-${n.status}`;
    const labels = { todo: '○ Todo', progress: '◑ Progress', done: '● Done' };
    sb.textContent = labels[n.status] || n.status;
    el.appendChild(sb);
  }
  // Border style
  el.classList.remove('border-dashed','border-dotted','border-none');
  if (n.borderStyle && n.borderStyle !== 'solid') el.classList.add('border-' + n.borderStyle);
  // Due date badge
  _applyDueDateBadge(el, n);
  // Tags
  _applyTagBadges(el, n);
  // Checklist progress
  _applyChecklistBadge(el, n);
  renderLines();
}

function _applyDueDateBadge(el, n) {
  el.querySelector('.node-due-badge')?.remove();
  if (!n.dueDate) return;
  const due = new Date(n.dueDate);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  const diff = dueDay - today;
  let cls = 'due-future';
  if (diff < 0) cls = 'due-overdue';
  else if (diff === 0) cls = 'due-today';
  const badge = document.createElement('div');
  badge.className = `node-due-badge ${cls}`;
  badge.textContent = '📅 ' + due.toLocaleDateString('id-ID', { day:'numeric', month:'short' });
  el.appendChild(badge);
}

function _applyTagBadges(el, n) {
  el.querySelectorAll('.node-tag-badge').forEach(b => b.remove());
  if (!n.tags?.length) return;
  const wrap = document.createElement('div');
  wrap.className = 'node-tags-wrap';
  n.tags.forEach(tag => {
    const b = document.createElement('span');
    b.className = 'node-tag-badge';
    b.textContent = tag;
    wrap.appendChild(b);
  });
  el.appendChild(wrap);
}

function _applyChecklistBadge(el, n) {
  el.querySelector('.node-checklist-wrap')?.remove();
  if (!n.checklist?.length) return;
  const done = n.checklist.filter(c => c.done).length;
  const total = n.checklist.length;
  const wrap = document.createElement('div');
  wrap.className = 'node-checklist-wrap';
  n.checklist.forEach((item, idx) => {
    const row = document.createElement('label');
    row.className = 'node-checklist-item' + (item.done ? ' done' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = item.done;
    cb.addEventListener('change', e => {
      e.stopPropagation();
      pushUndo();
      state.nodes[n.id].checklist[idx].done = cb.checked;
      row.classList.toggle('done', cb.checked);
      refs.dirty = true;
      _applyChecklistBadge(el, state.nodes[n.id]);
    });
    cb.addEventListener('mousedown', e => e.stopPropagation());
    const txt = document.createElement('span');
    txt.textContent = item.text;
    row.appendChild(cb);
    row.appendChild(txt);
    wrap.appendChild(row);
  });
  // Progress bar
  const prog = document.createElement('div');
  prog.className = 'node-checklist-progress';
  const bar = document.createElement('div');
  bar.className = 'node-checklist-bar';
  bar.style.width = total ? Math.round(done / total * 100) + '%' : '0%';
  prog.appendChild(bar);
  wrap.appendChild(prog);
  el.appendChild(wrap);
}

// ── Create / Delete ─────────────────────────────────────────
export function createNode(x, y, text = 'Kasus') {
  pushUndo();
  const id = 'n' + (state.nextId++);
  state.nodes[id] = { id, text, x, y, children: [], note: '' };
  const el = buildEl(state.nodes[id]);
  el.classList.add('is-new');
  el.addEventListener('animationend', () => el.classList.remove('is-new'), { once: true });
  $cv.appendChild(el);
  logAction('create', text);
  setTimeout(() => beginEdit(id), 20);
  renderLines();
  refs.nodeCounts[state.currentProject] = Object.keys(state.nodes).length;
  import('../sidebar/tree.js').then(({ renderSidebar }) => renderSidebar());
  window.wcfUpdateEmptyState?.();
  return id;
}

// ── Buat node baru + langsung koneksikan ke fromId (satu undo step) ──
export function createConnectedNode(fromId, x, y) {
  pushUndo();
  const id = 'n' + (state.nextId++);
  state.nodes[id] = { id, text: 'Node baru', x, y, children: [], note: '' };
  // Tambah koneksi tanpa pushUndo tambahan
  const duplicate = state.connections.some(c => c.from === fromId && c.to === id);
  if (!duplicate) {
    state.connections.push({ from: fromId, to: id, style: 'curved', label: '' });
    const fn = state.nodes[fromId];
    if (fn && !fn.children.includes(id)) fn.children.push(id);
  }
  const el = buildEl(state.nodes[id]);
  el.classList.add('is-new');
  el.addEventListener('animationend', () => el.classList.remove('is-new'), { once: true });
  $cv.appendChild(el);
  logAction('create', 'Node baru (dari koneksi)');
  syncColors();
  refs.dirty = true;
  renderLines();
  refs.nodeCounts[state.currentProject] = Object.keys(state.nodes).length;
  import('../sidebar/tree.js').then(({ renderSidebar }) => renderSidebar());
  window.wcfUpdateEmptyState?.();
  setTimeout(() => beginEdit(id), 20);
  return id;
}

export function deleteNode(id) {
  pushUndo();
  logAction('delete', state.nodes[id]?.text ?? id);
  state.connections = state.connections.filter(c => c.from !== id && c.to !== id);
  for (const nid in state.nodes) {
    state.nodes[nid].children = (state.nodes[nid].children || []).filter(c => c !== id);
  }
  delete state.nodes[id];
  $el(id)?.remove();
  syncColors(); renderLines();
  refs.nodeCounts[state.currentProject] = Object.keys(state.nodes).length;
  import('../sidebar/tree.js').then(({ renderSidebar }) => renderSidebar());
  window.wcfUpdateEmptyState?.();
  document.dispatchEvent(new CustomEvent('wcf:persist-now', {
    detail: { message: 'Node dihapus' },
  }));
}

// ── Apply data (load) ────────────────────────────────────────
export function applyData(data) {
  const cv  = document.getElementById('canvas');
  const svg = document.getElementById('svg-lines');
  if (!cv)  { console.error('[WCF] applyData: #canvas tidak ditemukan!');    return; }
  if (!svg) { console.error('[WCF] applyData: #svg-lines tidak ditemukan!'); return; }

  document.querySelectorAll('.node').forEach(n => n.remove());
  while (svg.lastChild) svg.removeChild(svg.lastChild);
  selectedNodes.clear();
  state.nodes       = data.nodes       ?? {};
  state.connections = data.connections ?? [];
  state.nextId      = data.nextId      ?? 1;
  state.groups      = data.groups      ?? {};
  state.stickies    = data.stickies    ?? {};
  state.nextStickyId = data.nextStickyId ?? 1;
  const stickyIds = Object.keys(state.stickies)
    .map(id => Number.parseInt(id.replace(/^s/, ''), 10))
    .filter(Number.isFinite);
  if (stickyIds.length) {
    state.nextStickyId = Math.max(state.nextStickyId, Math.max(...stickyIds) + 1);
  }
  state.frames      = data.frames      ?? {};
  state.nextFrameId = data.nextFrameId ?? 1;
  for (const c of state.connections) {
    if (!c.style) c.style = 'curved';
    if (c.label == null) c.label = '';
  }
  console.log('[WCF] applyData: rendering', Object.keys(state.nodes).length, 'nodes');
  for (const id in state.nodes) {
    const n = state.nodes[id];
    if (!n.note) n.note = '';
    if (!Array.isArray(n.children)) n.children = [];
    cv.appendChild(buildEl(n));
  }
  refs.nodeCounts[state.currentProject] = Object.keys(state.nodes).length;
  import('../sidebar/tree.js').then(({ renderSidebar }) => renderSidebar());
  syncColors(); renderLines();
  window.wcfUpdateEmptyState?.();
  // Render auxiliary canvas objects lazily to avoid circular imports.
  import('../features/sticky.js').then(({ renderStickies }) => renderStickies());
  import('../features/frames.js').then(({ renderFrames }) => renderFrames());
}

// ── Attach image to node ─────────────────────────────────────
export function attachImageToNode(id, dataUrl) {
  if (!state.nodes[id]) return;
  // Cek ukuran
  if (dataUrl.length > MAX_IMG_BYTES) {
    const kb = Math.round(dataUrl.length / 1024);
    alert(`Gambar terlalu besar (${kb} KB). Maksimum ~150 KB. Coba kompres gambar terlebih dahulu.`);
    return;
  }
  pushUndo();
  state.nodes[id].image = dataUrl;
  refs.dirty = true;
  // Re-render node
  const el = $el(id);
  if (!el) return;
  // Remove existing img-wrap if any
  el.querySelector('.node-img-wrap')?.remove();
  // Build fresh wrap
  const imgWrap = document.createElement('div');
  imgWrap.className = 'node-img-wrap';
  const img = document.createElement('img');
  img.className = 'node-img'; img.src = dataUrl; img.alt = ''; img.draggable = false;
  imgWrap.appendChild(img);
  const rmBtn = document.createElement('button');
  rmBtn.className = 'node-img-remove'; rmBtn.title = 'Hapus gambar'; rmBtn.textContent = '✕';
  rmBtn.addEventListener('click', e => {
    e.stopPropagation();
    pushUndo();
    delete state.nodes[id].image;
    imgWrap.remove();
    refs.dirty = true;
  });
  imgWrap.appendChild(rmBtn);
  el.insertBefore(imgWrap, el.firstChild);
  renderLines();
}
