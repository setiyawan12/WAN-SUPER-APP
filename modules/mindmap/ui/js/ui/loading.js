const shell = () => document.getElementById('wcf-loading-shell');
const label = () => document.getElementById('wcf-loading-label');

export function showLoadingShell(message = 'Menghubungkan workspace...') {
  const element = shell();
  if (!element) return;
  if (label()) label().textContent = message;
  element.hidden = false;
  requestAnimationFrame(() => element.classList.add('is-visible'));
}

export function updateLoadingShell(message) {
  if (label()) label().textContent = message;
}

export function hideLoadingShell() {
  const element = shell();
  if (!element) return;
  element.classList.remove('is-visible');
  window.setTimeout(() => {
    if (!element.classList.contains('is-visible')) element.hidden = true;
  }, 220);
}

export function shimmerRows(columns, rows = 4) {
  return Array.from({ length: rows }, (_, rowIndex) => `
    <tr class="wcf-shimmer-table-row" aria-hidden="true">
      ${Array.from({ length: columns }, (_, columnIndex) => `
        <td><span class="wcf-shimmer-line" style="--shimmer-width:${48 + ((rowIndex * 23 + columnIndex * 17) % 44)}%"></span></td>`).join('')}
    </tr>`).join('');
}

export function shimmerCards(count = 4) {
  return `<div class="wcf-shimmer-card-grid" aria-hidden="true">${Array.from({ length: count }, (_, index) => `
    <div class="wcf-shimmer-card">
      <span class="wcf-shimmer-line is-short"></span>
      <span class="wcf-shimmer-line is-title"></span>
      <span class="wcf-shimmer-line" style="--shimmer-width:${64 + (index % 3) * 9}%"></span>
      <span class="wcf-shimmer-block"></span>
    </div>`).join('')}</div>`;
}

export function shimmerList(count = 4) {
  return `<div class="wcf-shimmer-list" aria-hidden="true">${Array.from({ length: count }, (_, index) => `
    <div class="wcf-shimmer-list-row">
      <span class="wcf-shimmer-avatar"></span>
      <span class="wcf-shimmer-list-copy">
        <span class="wcf-shimmer-line is-title" style="--shimmer-width:${55 + (index % 3) * 11}%"></span>
        <span class="wcf-shimmer-line is-short"></span>
      </span>
    </div>`).join('')}</div>`;
}