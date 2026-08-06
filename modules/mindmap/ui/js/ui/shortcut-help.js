// ── js/ui/shortcut-help.js ───────────────────────────────────
const shortcuts = [
  ['Klik ganda canvas',   'Buat node baru'],
  ['Seret node',          'Pindah node'],
  ['Titik putih → node',  'Buat koneksi'],
  ['Klik node',           'Pilih node'],
  ['Ctrl/⌘ + Klik',      'Pilih banyak'],
  ['Shift + Klik',        'Tambah ke seleksi'],
  ['Ctrl/⌘ + A',         'Pilih semua'],
  ['Arrow Keys',          'Geser node terpilih (5px)'],
  ['Shift + Arrow',       'Geser besar (20px)'],
  ['Escape',              'Batal seleksi'],
  ['Delete / Backspace',  'Hapus node terpilih'],
  ['Ctrl/⌘ + C',         'Salin node / file'],
  ['Ctrl/⌘ + V',         'Tempel'],
  ['Ctrl/⌘ + Z',         'Undo'],
  ['Ctrl/⌘ + Shift + Z', 'Redo'],
  ['Ctrl/⌘ + S',         'Simpan'],
  ['Scroll wheel',        'Zoom in/out'],
  ['Seret canvas',        'Geser tampilan'],
  ['Klik kanan node',     'Menu hapus / warna / catatan'],
  ['Klik kanan garis',    'Ganti gaya / hapus koneksi'],
  ['Dblclick garis',      'Edit label koneksi'],
  ['?',                   'Tampilkan shortcut ini'],
];

export function initShortcutHelp() {
  // Populate table
  const tbody = document.querySelector('#shortcut-table tbody');
  if (tbody) {
    tbody.innerHTML = shortcuts.map(([k, v]) =>
      `<tr>
         <td>${k}</td>
         <td>${v}</td>
       </tr>`
    ).join('');
  }
  document.getElementById('btn-shortcut-close')?.addEventListener('click', hideHelp);
  document.getElementById('shortcut-modal')?.addEventListener('click', e => {
    if (e.target === document.getElementById('shortcut-modal')) hideHelp();
  });
  document.getElementById('btn-help')?.addEventListener('click', showHelp);
}

export function showHelp() {
  document.getElementById('shortcut-modal')?.classList.remove('hidden');
}
export function hideHelp() {
  document.getElementById('shortcut-modal')?.classList.add('hidden');
}
