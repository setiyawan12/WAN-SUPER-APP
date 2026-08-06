// ── js/features/history-log.js ───────────────────────────────
import { state, refs } from '../state.js';

export function logAction(action, details = '') {
  refs.actionLog.unshift({
    ts:      new Date().toLocaleTimeString('id-ID', { hour:'2-digit', minute:'2-digit', second:'2-digit' }),
    project: state.currentProject,
    action,
    details: String(details || '').substring(0, 60),
  });
  if (refs.actionLog.length > 100) refs.actionLog.pop();
  renderLog();
}

export function renderLog() {
  const list = document.getElementById('history-list');
  if (!list) return;
  const entries = refs.actionLog.filter(e => !state.currentProject || e.project === state.currentProject);
  if (!entries.length) {
    list.innerHTML = '<p class="text-white/20 text-[10px] px-1 py-1 italic">Belum ada riwayat.</p>';
    return;
  }
  list.innerHTML = entries.map(e => `
    <div class="history-entry">
      <span class="he-time">${e.ts}</span>
      <span class="font-medium text-purple-300/60">${e.action}</span>
      ${e.details ? `<span class="text-white/30 truncate">${e.details}</span>` : ''}
    </div>
  `).join('');
}

export function initHistoryPanel() {
  document.getElementById('btn-history')?.addEventListener('click', () => {
    const panel = document.getElementById('history-panel');
    if (!panel) return;
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) renderLog();
  });
  document.getElementById('btn-history-clear')?.addEventListener('click', () => {
    refs.actionLog = refs.actionLog.filter(e => e.project !== state.currentProject);
    renderLog();
  });
}
