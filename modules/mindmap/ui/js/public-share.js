import { doc, onSnapshot } from 'firebase/firestore';
import { applyData } from './canvas/node.js';
import { renderLines } from './canvas/connection.js';
import { applyTransform } from './canvas/transform.js';
import { renderFrames } from './features/frames.js';
import { renderStickies } from './features/sticky.js';
import { firebaseServices } from './firebase/client.js';
import { state } from './state.js';

const container = document.getElementById('container');
const canvas = document.getElementById('canvas');
const loading = document.getElementById('share-loading');
const error = document.getElementById('share-error');
const errorTitle = document.getElementById('share-error-title');
const errorMessage = document.getElementById('share-error-message');
const fileName = document.getElementById('hdr-file-name');
const owner = document.getElementById('hdr-owner');
const zoomLabel = document.getElementById('zoom-label');

let autoFit = true;
let panState = null;
let unsubscribe = null;
let fitFrame = 0;

function tokenFromLocation() {
  const queryToken = new URLSearchParams(location.search).get('t');
  if (queryToken) return queryToken;
  const match = location.pathname.match(/\/share\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

function updateZoomLabel() {
  if (zoomLabel) zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
}

function setTransform() {
  applyTransform();
  updateZoomLabel();
}

function addBounds(bounds, left, top, right, bottom) {
  if (![left, top, right, bottom].every(Number.isFinite)) return;
  bounds.minX = Math.min(bounds.minX, left);
  bounds.minY = Math.min(bounds.minY, top);
  bounds.maxX = Math.max(bounds.maxX, right);
  bounds.maxY = Math.max(bounds.maxY, bottom);
}

function measureContent() {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const canvasRect = canvas.getBoundingClientRect();
  const elements = canvas.querySelectorAll('.node, .sticky-note, .canvas-frame, .canvas-frame-label, .node-collapse-btn');

  for (const element of elements) {
    if (!element.getClientRects().length || getComputedStyle(element).display === 'none') continue;
    const rect = element.getBoundingClientRect();
    addBounds(
      bounds,
      rect.left - canvasRect.left,
      rect.top - canvasRect.top,
      rect.right - canvasRect.left,
      rect.bottom - canvasRect.top,
    );
  }

  for (const element of document.querySelectorAll('#svg-lines path, #svg-lines foreignObject')) {
    try {
      const box = element.getBBox();
      addBounds(bounds, box.x, box.y, box.x + box.width, box.y + box.height);
    } catch {
      // SVG may not be measurable until the next animation frame.
    }
  }

  return Number.isFinite(bounds.minX) ? bounds : null;
}

export function fitPublicContent({ animate = true } = {}) {
  if (!container || !canvas) return;
  cancelAnimationFrame(fitFrame);
  fitFrame = requestAnimationFrame(() => {
    const previousTransition = canvas.style.transition;
    canvas.style.transition = 'none';
    state.zoom = 1;
    state.pan.x = 0;
    state.pan.y = 0;
    setTransform();
    void canvas.offsetWidth;

    const bounds = measureContent();
    if (!bounds) {
      canvas.style.transition = previousTransition;
      return;
    }

    const padding = innerWidth <= 700 ? 28 : 56;
    const viewportWidth = Math.max(1, container.clientWidth);
    const viewportHeight = Math.max(1, container.clientHeight);
    const contentWidth = Math.max(1, bounds.maxX - bounds.minX);
    const contentHeight = Math.max(1, bounds.maxY - bounds.minY);
    const scaleX = Math.max(1, viewportWidth - padding * 2) / contentWidth;
    const scaleY = Math.max(1, viewportHeight - padding * 2) / contentHeight;

    state.zoom = Math.max(.06, Math.min(scaleX, scaleY, 1.25));
    state.pan.x = (viewportWidth - contentWidth * state.zoom) / 2 - bounds.minX * state.zoom;
    state.pan.y = (viewportHeight - contentHeight * state.zoom) / 2 - bounds.minY * state.zoom;
    canvas.style.transition = animate ? 'transform .28s cubic-bezier(.2,.75,.25,1)' : 'none';
    setTransform();
    window.setTimeout(() => { canvas.style.transition = previousTransition; }, animate ? 300 : 0);
  });
}

function enforceReadOnly() {
  for (const input of canvas.querySelectorAll('input, textarea, select, button, [contenteditable]')) {
    input.tabIndex = -1;
    if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) input.readOnly = true;
    if (input.hasAttribute('contenteditable')) input.setAttribute('contenteditable', 'false');
  }
}

function waitForImages() {
  const pending = [...canvas.querySelectorAll('img')].filter(image => !image.complete);
  return Promise.all(pending.map(image => new Promise(resolve => {
    image.addEventListener('load', resolve, { once: true });
    image.addEventListener('error', resolve, { once: true });
  })));
}

export async function renderSharedSnapshot(payload) {
  const snapshot = payload?.snapshot;
  if (!snapshot || typeof snapshot.nodes !== 'object') throw new Error('Snapshot mindmap tidak valid.');

  fileName.textContent = payload.displayName || 'Shared mindmap';
  owner.textContent = payload.ownerType === 'group' ? 'Workspace grup' : 'Workspace personal';
  document.title = `${payload.displayName || 'Shared mindmap'} — WAN Case Flow`;

  state.zoom = 1;
  state.pan.x = 0;
  state.pan.y = 0;
  applyData(snapshot);
  renderStickies();
  renderFrames();
  renderLines();
  enforceReadOnly();

  await document.fonts?.ready;
  await waitForImages();
  renderLines();
  enforceReadOnly();
  autoFit = true;
  fitPublicContent({ animate: false });
  loading.style.display = 'none';
  error.hidden = true;
}

function showError(title, message) {
  loading.style.display = 'none';
  errorTitle.textContent = title;
  errorMessage.textContent = message;
  error.hidden = false;
}

async function initialize() {
  const token = tokenFromLocation();
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) {
    showError('Link tidak valid', 'Token public share tidak ditemukan atau formatnya salah.');
    return;
  }

  try {
    const services = await firebaseServices();
    if (!services.configured || !services.firestore) throw new Error('Konfigurasi Firebase Hosting tidak tersedia.');
    unsubscribe = onSnapshot(doc(services.firestore, 'publicShares', token), snapshot => {
      const payload = snapshot.data();
      if (!snapshot.exists() || payload?.enabled !== true || !payload?.snapshot) {
        showError('Link tidak tersedia', 'Link tidak ditemukan atau sudah dicabut oleh pemilik.');
        return;
      }
      void renderSharedSnapshot(payload).catch(cause => showError('Mindmap gagal dirender', cause.message));
    }, cause => showError(
      'Share tidak dapat dimuat',
      cause?.code === 'permission-denied' ? 'Link tidak ditemukan atau sudah dicabut.' : cause?.message || 'Terjadi kesalahan Firebase.',
    ));
  } catch (cause) {
    showError('Share tidak dapat dimuat', cause.message);
  }
}

container?.addEventListener('mousedown', event => {
  if (event.button !== 0 && event.button !== 1) return;
  autoFit = false;
  panState = { x: event.clientX - state.pan.x, y: event.clientY - state.pan.y };
  container.classList.add('grabbing');
  canvas.classList.add('is-panning');
  event.preventDefault();
});

window.addEventListener('mousemove', event => {
  if (!panState) return;
  state.pan.x = event.clientX - panState.x;
  state.pan.y = event.clientY - panState.y;
  setTransform();
});

window.addEventListener('mouseup', () => {
  if (!panState) return;
  panState = null;
  container.classList.remove('grabbing');
  canvas.classList.remove('is-panning');
});

container?.addEventListener('wheel', event => {
  event.preventDefault();
  autoFit = false;
  const rect = container.getBoundingClientRect();
  const mouseX = event.clientX - rect.left;
  const mouseY = event.clientY - rect.top;
  const beforeX = (mouseX - state.pan.x) / state.zoom;
  const beforeY = (mouseY - state.pan.y) / state.zoom;
  state.zoom = Math.min(3, Math.max(.06, state.zoom + (event.deltaY < 0 ? .08 : -.08)));
  state.pan.x = mouseX - beforeX * state.zoom;
  state.pan.y = mouseY - beforeY * state.zoom;
  setTransform();
}, { passive: false });

function zoomBy(delta) {
  autoFit = false;
  const centerX = container.clientWidth / 2;
  const centerY = container.clientHeight / 2;
  const beforeX = (centerX - state.pan.x) / state.zoom;
  const beforeY = (centerY - state.pan.y) / state.zoom;
  state.zoom = Math.min(3, Math.max(.06, state.zoom + delta));
  state.pan.x = centerX - beforeX * state.zoom;
  state.pan.y = centerY - beforeY * state.zoom;
  setTransform();
}

document.getElementById('btn-zoom-in')?.addEventListener('click', () => zoomBy(.15));
document.getElementById('btn-zoom-out')?.addEventListener('click', () => zoomBy(-.15));
document.getElementById('btn-zoom-fit')?.addEventListener('click', () => {
  autoFit = true;
  fitPublicContent();
});

window.addEventListener('resize', () => {
  if (autoFit) fitPublicContent({ animate: false });
});

window.addEventListener('beforeunload', () => unsubscribe?.());

void initialize();