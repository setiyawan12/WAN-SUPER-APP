// ── js/ui/theme.js ───────────────────────────────────────────
// Mendukung dua varian tombol: #btn-theme (index.html) dan
// #btn-theme-toggle (group.html) — keduanya ditangani bersama.

function updateThemeButton(theme) {
  const icon = theme === 'light' ? '◑' : '◐';
  const title = theme === 'light' ? 'Ganti ke dark mode' : 'Ganti ke light mode';
  for (const id of ['btn-theme', 'btn-theme-toggle']) {
    const btn = document.getElementById(id);
    if (btn) { btn.textContent = icon; btn.title = title; }
  }
}

export function applyTheme(theme) {
  const html = document.documentElement;
  if (theme === 'light') {
    html.classList.remove('dark');
  } else {
    html.classList.add('dark');
  }
  updateThemeButton(theme);
  localStorage.setItem('wcf_theme', theme);
  import('../sidebar/tree.js').then(({ renderSidebar }) => renderSidebar());
}

export function initTheme() {
  const saved = localStorage.getItem('wcf_theme') || 'dark';
  applyTheme(saved);
  // Wire up all theme toggle buttons (index.html + group.html)
  const toggle = () => {
    const isDark = document.documentElement.classList.contains('dark');
    applyTheme(isDark ? 'light' : 'dark');
  };
  document.getElementById('btn-theme')?.addEventListener('click', toggle);
  // group.html wires its own listener via initThemeToggle()
}
