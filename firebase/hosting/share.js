import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import { doc, getFirestore, onSnapshot } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';

const canvas = document.getElementById('canvas');
const status = document.getElementById('status');
const error = document.getElementById('error');
const name = document.getElementById('name');
const token = location.pathname.split('/').filter(Boolean).pop();

const COLORS = [
  { bg: '#7c6dfa', glow: 'rgba(124,109,250,0.45)' },
  { bg: '#f43f5e', glow: 'rgba(244,63,94,0.40)' },
  { bg: '#0ea5e9', glow: 'rgba(14,165,233,0.40)' },
  { bg: '#f59e0b', glow: 'rgba(245,158,11,0.40)' },
  { bg: '#10b981', glow: 'rgba(16,185,129,0.40)' },
  { bg: '#ec4899', glow: 'rgba(236,72,153,0.40)' },
  { bg: '#06b6d4', glow: 'rgba(6,182,212,0.40)' },
];

function levelsFor(nodes, connections) {
  const incoming = {};
  const children = {};
  for (const id of Object.keys(nodes)) {
    incoming[id] = 0;
    children[id] = [];
  }
  for (const connection of connections) {
    if (!nodes[connection.from] || !nodes[connection.to]) continue;
    incoming[connection.to] = (incoming[connection.to] || 0) + 1;
    children[connection.from].push(connection.to);
  }
  const levels = {};
  const queue = Object.keys(nodes).filter(id => !incoming[id]);
  for (const id of queue) levels[id] = 0;
  while (queue.length) {
    const id = queue.shift();
    for (const child of children[id] || []) {
      const nextLevel = (levels[id] || 0) + 1;
      if (levels[child] == null || nextLevel < levels[child]) {
        levels[child] = nextLevel;
        queue.push(child);
      }
    }
  }
  for (const id of Object.keys(nodes)) if (levels[id] == null) levels[id] = 0;
  return levels;
}

function connectionPath(from, to, style, waypoints = []) {
  const points = [from, ...waypoints, to];
  if (waypoints.length) {
    let path = `M${points[0].x},${points[0].y}`;
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1];
      const current = points[index];
      const controlX = (previous.x + current.x) / 2;
      path += ` C${controlX},${previous.y} ${controlX},${current.y} ${current.x},${current.y}`;
    }
    return path;
  }
  if (style === 'straight' || style === 'arrow' || style === 'bidirectional') {
    return `M${from.x},${from.y} L${to.x},${to.y}`;
  }
  const dx = Math.abs(to.x - from.x) * 0.5;
  return `M${from.x},${from.y} C${from.x + dx},${from.y} ${to.x - dx},${to.y} ${to.x},${to.y}`;
}

function addBadge(element, className, text) {
  const badge = document.createElement('span');
  badge.className = className;
  badge.textContent = text;
  element.appendChild(badge);
}

function render(data) {
  canvas.hidden = false;
  canvas.innerHTML = '';
  const nodes = data?.nodes || {};
  const connections = data?.connections || [];
  const values = Object.values(nodes);
  if (!values.length) {
    canvas.innerHTML = '<p class="empty">Mindmap ini belum memiliki node.</p>';
    return;
  }
  const minX = Math.min(...values.map(node => Number(node.x || 0)));
  const minY = Math.min(...values.map(node => Number(node.y || 0)));
  const maxX = Math.max(...values.map(node => Number(node.x || 0) + Math.min(360, Math.max(120, Number(node.width || 140)))));
  const maxY = Math.max(...values.map(node => Number(node.y || 0) + 90));
  const offsetX = 72 - minX;
  const offsetY = 72 - minY;
  const width = Math.max(900, maxX - minX + 144);
  const height = Math.max(560, maxY - minY + 144);
  canvas.style.setProperty('--map-width', `${width}px`);
  canvas.style.setProperty('--map-height', `${height}px`);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  canvas.appendChild(svg);
  const levels = levelsFor(nodes, connections);
  const elements = new Map();
  for (const [id, node] of Object.entries(nodes)) {
    const element = document.createElement('article');
    element.className = 'node';
    if (node.shape) element.classList.add(`shape-${node.shape}`);
    if (node.fontSize) element.classList.add(`fs-${node.fontSize}`);
    if (node.borderStyle && node.borderStyle !== 'solid') element.classList.add(`border-${node.borderStyle}`);
    element.style.left = `${Number(node.x || 0) + offsetX}px`;
    element.style.top = `${Number(node.y || 0) + offsetY}px`;
    if (node.width) element.style.width = `${Math.min(360, Math.max(120, Number(node.width)))}px`;
    const tone = node.customColor
      ? { bg: node.customColor, glow: `${node.customColor}70` }
      : COLORS[Math.min(levels[id] || 0, COLORS.length - 1)];
    element.style.setProperty('--node-tone', tone.bg);
    element.style.setProperty('--node-tone-glow', tone.glow);

    const title = document.createElement('div');
    title.className = 'node-title';
    title.textContent = `${node.emoji ? `${node.emoji} ` : ''}${node.text || 'Untitled'}`;
    if (node.textColor) title.style.color = node.textColor;
    if (node.textAlign) title.style.textAlign = node.textAlign;
    element.appendChild(title);
    if (node.note) {
      const note = document.createElement('div');
      note.className = 'node-note';
      note.textContent = node.note;
      element.appendChild(note);
    }
    if (node.status) {
      const labels = { todo: '○ Todo', progress: '◑ Progress', done: '● Done' };
      addBadge(element, `node-status status-${node.status}`, labels[node.status] || node.status);
    }
    if (node.dueDate) {
      const due = new Date(node.dueDate);
      if (!Number.isNaN(due.getTime())) {
        addBadge(element, 'node-due', `▣ ${due.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }).toUpperCase()}`);
      }
    }
    for (const tag of node.tags || []) addBadge(element, 'node-tag', tag);
    canvas.appendChild(element);
    elements.set(id, element);
  }

  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  defs.innerHTML = `
    <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="rgba(255,255,255,0.65)"/>
    </marker>
    <marker id="arrow-reverse" markerWidth="8" markerHeight="8" refX="2" refY="3" orient="auto">
      <path d="M8,0 L8,6 L0,3 z" fill="rgba(255,255,255,0.65)"/>
    </marker>`;
  svg.appendChild(defs);

  for (const connection of connections) {
    const fromNode = nodes[connection.from];
    const toNode = nodes[connection.to];
    const fromElement = elements.get(connection.from);
    const toElement = elements.get(connection.to);
    if (!fromNode || !toNode || !fromElement || !toElement) continue;
    const from = {
      x: Number(fromNode.x || 0) + offsetX + fromElement.offsetWidth / 2,
      y: Number(fromNode.y || 0) + offsetY + fromElement.offsetHeight / 2,
    };
    const to = {
      x: Number(toNode.x || 0) + offsetX + toElement.offsetWidth / 2,
      y: Number(toNode.y || 0) + offsetY + toElement.offsetHeight / 2,
    };
    const color = connection.color || COLORS[Math.min(levels[connection.from] || 0, COLORS.length - 1)].bg;
    const style = connection.style || 'curved';
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const waypoints = (connection.waypoints || []).map(point => ({
      x: Number(point.x || 0) + offsetX,
      y: Number(point.y || 0) + offsetY,
    }));
    path.setAttribute('d', connectionPath(from, to, style, waypoints));
    path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', '2.5');
    path.setAttribute('stroke-opacity', '0.72');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke-linecap', 'round');
    path.style.filter = `drop-shadow(0 0 5px ${color}66)`;
    if (style === 'dashed') path.setAttribute('stroke-dasharray', '8 5');
    if (style === 'arrow' || style === 'bidirectional') path.setAttribute('marker-end', 'url(#arrow)');
    if (style === 'bidirectional') path.setAttribute('marker-start', 'url(#arrow-reverse)');
    svg.appendChild(path);

    if (connection.label) {
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', String((from.x + to.x) / 2));
      label.setAttribute('y', String((from.y + to.y) / 2 - 8));
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('class', 'connection-label');
      label.textContent = connection.label;
      svg.appendChild(label);
    }
  }
}

function showUnavailable(message) {
  canvas.hidden = true;
  error.hidden = false;
  error.textContent = message;
  name.textContent = 'Link unavailable';
  status.textContent = 'ERROR';
}

try {
  if (!/^[A-Za-z0-9_-]{32}$/.test(token || '')) throw new Error('Token public share tidak valid.');
  const configResponse = await fetch('/__/firebase/init.json');
  if (!configResponse.ok) throw new Error('Konfigurasi Firebase Hosting tidak tersedia.');
  const config = await configResponse.json();
  const firestore = getFirestore(initializeApp(config));
  onSnapshot(doc(firestore, 'publicShares', token), snapshot => {
    if (!snapshot.exists() || snapshot.data().enabled !== true || !snapshot.data().snapshot) {
      showUnavailable('Link tidak ditemukan atau sudah dicabut.');
      return;
    }
    const payload = snapshot.data();
    error.hidden = true;
    name.textContent = payload.displayName || 'Shared mindmap';
    render(payload.snapshot);
    status.textContent = 'LIVE · READ ONLY';
  }, cause => showUnavailable(
    cause?.code === 'permission-denied'
      ? 'Link tidak ditemukan atau sudah dicabut.'
      : cause?.message || 'Share tidak dapat dimuat.'
  ));
} catch (cause) {
  showUnavailable(cause.message);
}