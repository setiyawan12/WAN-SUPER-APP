// ── js/ui/flash.js ───────────────────────────────────────────
// Toast mandiri: semua gaya diset via inline-style agar pasti tampil
// (tidak bergantung pada kelas CSS eksternal yang bisa konflik/tertimpa).
import { $ind } from '../state.js';

let _t;

export function flash(msg, ok = true) {
  if (!$ind) return;
  $ind.textContent = msg;
  $ind.classList.remove('hidden');

  Object.assign($ind.style, {
    position:       'fixed',
    bottom:         '22px',
    left:           '50%',
    top:            'auto',
    right:          'auto',
    zIndex:         '600',
    maxWidth:       'min(90vw, 460px)',
    padding:        '9px 18px',
    borderRadius:   '99px',
    fontSize:       '12px',
    fontWeight:     '600',
    lineHeight:     '1.3',
    whiteSpace:     'nowrap',
    overflow:       'hidden',
    textOverflow:   'ellipsis',
    pointerEvents:  'none',
    userSelect:     'none',
    backdropFilter: 'blur(20px)',
    WebkitBackdropFilter: 'blur(20px)',
    transition:     'opacity .22s ease, transform .22s cubic-bezier(.4,0,.2,1)',
    background:     ok ? 'rgba(16,185,129,0.16)' : 'rgba(239,68,68,0.16)',
    border:        ok ? '1px solid rgba(16,185,129,0.40)' : '1px solid rgba(239,68,68,0.40)',
    color:         ok ? '#34d399' : '#f87171',
    boxShadow:     ok ? '0 6px 24px rgba(16,185,129,0.25)' : '0 6px 24px rgba(239,68,68,0.25)',
    opacity:       '0',
    transform:     'translateX(-50%) translateY(12px)',
  });

  // Force reflow agar transisi opacity selalu mengulang walau flash beruntun
  void $ind.offsetWidth;
  $ind.style.opacity   = '1';
  $ind.style.transform = 'translateX(-50%) translateY(0)';

  clearTimeout(_t);
  _t = setTimeout(() => {
    if (!$ind) return;
    $ind.style.opacity   = '0';
    $ind.style.transform = 'translateX(-50%) translateY(12px)';
  }, 2600);
}

// Ekspos global agar skrip inline (index.html / group.html) memakai toast yang sama
if (typeof window !== 'undefined') window.wcfFlash = flash;
