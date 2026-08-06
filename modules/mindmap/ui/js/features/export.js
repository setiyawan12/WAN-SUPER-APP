// ── js/features/export.js ────────────────────────────────────
import { state, snapshotData } from '../state.js';
import { flash } from '../ui/flash.js';
import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';

export function exportJSON() {
  const data = JSON.stringify(snapshotData(), null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = (state.currentProject || 'project') + '.json';
  a.click();
  URL.revokeObjectURL(url);
  flash('✓ JSON diunduh', true);
}

export async function exportPNG() {
  flash('Mengekspor PNG…', true);
  try {
    const container = document.getElementById('container');
    const cvs = await html2canvas(container, {
      backgroundColor: document.documentElement.classList.contains('dark') ? '#090914' : '#e4e7ff',
      scale: 2,
      useCORS: true,
      logging: false,
    });
    const a      = document.createElement('a');
    a.href       = cvs.toDataURL('image/png');
    a.download   = (state.currentProject || 'project') + '.png';
    a.click();
    flash('✓ PNG diunduh', true);
  } catch (err) {
    flash('✗ Gagal ekspor PNG', false);
    console.error(err);
  }
}

export async function exportPDF() {
  flash('Mengekspor PDF…', true);
  try {
    const container = document.getElementById('container');
    const cvs = await html2canvas(container, {
      backgroundColor: document.documentElement.classList.contains('dark') ? '#090914' : '#e4e7ff',
      scale: 1.5,
      useCORS: true,
      logging: false,
    });
    const imgData = cvs.toDataURL('image/png');
    const pdf = new jsPDF({
      orientation: cvs.width > cvs.height ? 'landscape' : 'portrait',
      unit: 'px',
      format: [cvs.width, cvs.height],
    });
    pdf.addImage(imgData, 'PNG', 0, 0, cvs.width, cvs.height);
    pdf.save((state.currentProject || 'mindmap') + '.pdf');
    flash('✓ PDF diunduh', true);
  } catch (err) {
    flash('✗ Gagal ekspor PDF', false);
    console.error(err);
  }
}

export function exportMarkdown() {
  try {
    const nodes = state.nodes;
    const conns = state.connections;

    // Find root nodes (no incoming connection)
    const hasParent = new Set(conns.map(c => c.to));
    const roots = Object.keys(nodes).filter(id => !hasParent.has(id));
    if (!roots.length) { flash('Tidak ada node untuk diekspor', false); return; }

    // BFS/DFS traverse to build indented markdown
    const lines = [];
    function traverse(id, depth) {
      const n = nodes[id];
      if (!n) return;
      const prefix = depth === 0 ? '# ' : '  '.repeat(depth - 1) + '- ';
      const text = (n.emoji ? n.emoji + ' ' : '') + (n.text || '').replace(/\n/g, ' ');
      lines.push(prefix + text);
      const children = conns.filter(c => c.from === id).map(c => c.to);
      children.forEach(cid => traverse(cid, depth + 1));
    }
    roots.forEach(id => { traverse(id, 0); lines.push(''); });

    const md   = lines.join('\n');
    const blob = new Blob([md], { type: 'text/markdown' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = (state.currentProject || 'mindmap') + '.md';
    a.click();
    URL.revokeObjectURL(url);
    flash('✓ Markdown diunduh', true);
  } catch (err) {
    flash('✗ Gagal ekspor Markdown', false);
    console.error(err);
  }
}

export function exportSVG() {
  try {
    const nodes = state.nodes;
    const conns = state.connections;
    const PAD   = 40;

    // Compute bounding box from visible DOM nodes
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id in nodes) {
      const n  = nodes[id];
      const el = document.getElementById('node-' + id);
      if (!el || el.style.display === 'none') continue;
      const w  = el.offsetWidth  || (n.width ?? 140);
      const h  = el.offsetHeight || 56;
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + w);
      maxY = Math.max(maxY, n.y + h);
    }
    if (!isFinite(minX)) { flash('Tidak ada node untuk diekspor', false); return; }
    const W = maxX - minX + PAD * 2;
    const H = maxY - minY + PAD * 2;
    const ox = -minX + PAD;
    const oy = -minY + PAD;

    const isDark = document.documentElement.classList.contains('dark');
    const bgColor   = isDark ? '#090914' : '#f0f2ff';
    const nodeColor = isDark ? '#1e2030' : '#ffffff';
    const nodeBorder= isDark ? '#4b5563' : '#d1d5db';
    const textColor = isDark ? '#e2e8f0' : '#1e293b';
    const lineColor = isDark ? '#6366f1' : '#818cf8';

    let svgParts = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
      `<rect width="${W}" height="${H}" fill="${bgColor}"/>`,
      `<defs><marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="${lineColor}"/></marker></defs>`,
      `<g id="connections">`,
    ];

    // Draw connections as straight lines (simplified)
    for (const c of conns) {
      const fn = nodes[c.from], tn = nodes[c.to];
      if (!fn || !tn) continue;
      const fel = document.getElementById('node-' + c.from);
      const tel = document.getElementById('node-' + c.to);
      if (fel?.style.display === 'none' || tel?.style.display === 'none') continue;
      const fw = (fel?.offsetWidth  || fn.width  || 140);
      const fh = (fel?.offsetHeight || 56);
      const tw = (tel?.offsetWidth  || tn.width  || 140);
      const th = (tel?.offsetHeight || 56);
      const x1 = fn.x + fw / 2 + ox;
      const y1 = fn.y + fh / 2 + oy;
      const x2 = tn.x + tw / 2 + ox;
      const y2 = tn.y + th / 2 + oy;
      const color = c.color || lineColor;
      svgParts.push(
        `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${color}" stroke-width="2" stroke-opacity="0.7" marker-end="url(#arr)"/>`
      );
    }
    svgParts.push(`</g>`, `<g id="nodes">`);

    // Draw nodes as rounded rects with text
    for (const id in nodes) {
      const n  = nodes[id];
      const el = document.getElementById('node-' + id);
      if (!el || el.style.display === 'none') continue;
      const w  = el.offsetWidth  || (n.width ?? 140);
      const h  = el.offsetHeight || 56;
      const x  = n.x + ox;
      const y  = n.y + oy;
      const fill   = n.customColor || nodeColor;
      const stroke = nodeBorder;
      // Escape XML
      const txt = (n.emoji ? n.emoji + ' ' : '') + (n.text || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      svgParts.push(
        `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w}" height="${h}" rx="10" ry="10" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`,
        `<text x="${(x + w/2).toFixed(1)}" y="${(y + h/2 + 5).toFixed(1)}" text-anchor="middle" font-family="sans-serif" font-size="13" fill="${n.textColor || textColor}" dominant-baseline="middle">${txt}</text>`
      );
      if (n.status) {
        const statusColor = { todo:'#94a3b8', progress:'#fbbf24', done:'#34d399' }[n.status] || '#666';
        const statusLabel = { todo:'○ Todo', progress:'◑ WIP', done:'● Done' }[n.status] || '';
        svgParts.push(
          `<rect x="${(x + w/2 - 24).toFixed(1)}" y="${(y + h - 18).toFixed(1)}" width="48" height="14" rx="7" fill="${statusColor}22" stroke="${statusColor}" stroke-width="0.8"/>`,
          `<text x="${(x + w/2).toFixed(1)}" y="${(y + h - 8).toFixed(1)}" text-anchor="middle" font-family="sans-serif" font-size="9" fill="${statusColor}">${statusLabel}</text>`
        );
      }
    }
    svgParts.push(`</g></svg>`);

    const svgStr = svgParts.join('\n');
    const blob   = new Blob([svgStr], { type: 'image/svg+xml' });
    const url    = URL.createObjectURL(blob);
    const a      = document.createElement('a');
    a.href       = url;
    a.download   = (state.currentProject || 'mindmap') + '.svg';
    a.click();
    URL.revokeObjectURL(url);
    flash('✓ SVG diunduh', true);
  } catch (err) {
    flash('✗ Gagal ekspor SVG', false);
    console.error(err);
  }
}
