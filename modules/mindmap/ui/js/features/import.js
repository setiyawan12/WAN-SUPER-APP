// ── js/features/import.js — Import JSON / Markdown ───────────
import { state, refs, pushUndo } from '../state.js';
import { flash } from '../ui/flash.js';

// ── Import JSON ───────────────────────────────────────────────
export function importJSON(jsonStr) {
  let data;
  try { data = JSON.parse(jsonStr); } catch { flash('⚠ File JSON tidak valid', false); return; }
  if (!data.nodes && !data.connections) { flash('⚠ Bukan format mindmap yang dikenal', false); return; }
  pushUndo();
  // Use applyData from node.js
  import('../canvas/node.js').then(({ applyData }) => {
    applyData(data);
    refs.dirty = true;
    flash('✓ Import JSON berhasil', true);
  });
}

// ── Import Markdown (indented list → tree) ────────────────────
export function importMarkdown(mdStr) {
  const lines = mdStr.split('\n').filter(l => l.trim());
  if (!lines.length) { flash('⚠ File Markdown kosong', false); return; }

  pushUndo();

  // Clear current state
  import('../canvas/node.js').then(({ applyData }) => {
    // Build tree from markdown
    const nodes = {}, connections = [];
    let nextId = 1;
    const stack = []; // { id, level }
    let x = 100, y = 100;
    const X_GAP = 200, Y_GAP = 70;
    const levelX = {};

    function indentLevel(line) {
      // h1/h2/h3 headings
      const hm = line.match(/^(#{1,6})\s/);
      if (hm) return hm[1].length - 1;
      // Bullet / numbered list
      const bm = line.match(/^(\s*)([-*+]|\d+\.)\s/);
      if (bm) return Math.floor(bm[1].length / 2) + 1;
      return 0;
    }

    function cleanText(line) {
      return line.replace(/^#{1,6}\s+/, '').replace(/^\s*([-*+]|\d+\.)\s+/, '').replace(/^\s+/, '').trim();
    }

    lines.forEach(line => {
      if (!line.trim()) return;
      const level = indentLevel(line);
      const text = cleanText(line);
      if (!text) return;

      const id = String(nextId++);
      // X based on level
      if (!(level in levelX)) levelX[level] = x + level * X_GAP;
      const nx = level * X_GAP + 100;
      const ny = y;
      y += Y_GAP;

      nodes[id] = { id, x: nx, y: ny, text, children: [], note: '' };

      // Find parent: last node with level - 1
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      if (stack.length) {
        const parentId = stack[stack.length - 1].id;
        nodes[parentId].children.push(id);
        connections.push({ from: parentId, to: id, style: 'curved', label: '' });
      }
      stack.push({ id, level });
    });

    applyData({ nodes, connections, nextId, groups: {}, stickies: {}, nextStickyId: 1 });
    refs.dirty = true;
    flash(`✓ Import Markdown: ${Object.keys(nodes).length} node`, true);
  });
}

// ── File picker helper ────────────────────────────────────────
export function openImportDialog() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,.md,.markdown';
  input.style.display = 'none';
  document.body.appendChild(input);
  input.addEventListener('change', () => {
    const file = input.files[0];
    if (!file) { document.body.removeChild(input); return; }
    const reader = new FileReader();
    reader.onload = ev => {
      const content = ev.target.result;
      const ext = file.name.split('.').pop().toLowerCase();
      if (ext === 'json') importJSON(content);
      else if (ext === 'md' || ext === 'markdown') importMarkdown(content);
      else flash('⚠ Format tidak dikenal (.json atau .md)', false);
    };
    reader.readAsText(file);
    document.body.removeChild(input);
  });
  input.click();
}
