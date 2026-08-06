const canvas = document.getElementById('canvas');
const status = document.getElementById('status');
const error = document.getElementById('error');
const name = document.getElementById('name');
const token = location.pathname.split('/').filter(Boolean).pop();

function center(node) {
  return { x: Number(node.x || 0) + 70, y: Number(node.y || 0) + 28 };
}

function render(data) {
  const nodes = data?.nodes || {};
  const connections = data?.connections || [];
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const connection of connections) {
    const from = nodes[connection.from];
    const to = nodes[connection.to];
    if (!from || !to) continue;
    const a = center(from);
    const b = center(to);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', a.x);
    line.setAttribute('y1', a.y);
    line.setAttribute('x2', b.x);
    line.setAttribute('y2', b.y);
    svg.appendChild(line);
  }
  canvas.appendChild(svg);
  for (const node of Object.values(nodes)) {
    const element = document.createElement('article');
    element.className = 'node';
    element.style.left = `${Number(node.x || 0)}px`;
    element.style.top = `${Number(node.y || 0)}px`;
    if (node.width) element.style.width = `${Math.min(360, Math.max(120, Number(node.width)))}px`;
    if (node.customColor) element.style.background = node.customColor;
    element.textContent = `${node.emoji ? `${node.emoji} ` : ''}${node.text || 'Untitled'}`;
    canvas.appendChild(element);
  }
}

try {
  const response = await fetch(`/api/public-share/${encodeURIComponent(token)}`);
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(payload.error || 'Share tidak dapat dimuat.');
  name.textContent = payload.name || 'Shared mindmap';
  render(payload.data);
  status.textContent = 'READ ONLY';
} catch (cause) {
  canvas.hidden = true;
  error.hidden = false;
  error.textContent = cause.message;
  name.textContent = 'Link unavailable';
  status.textContent = 'ERROR';
}