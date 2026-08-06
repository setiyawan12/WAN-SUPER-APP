// ── js/ui/modal.js — wcfPrompt / wcfConfirm ─────────────────
const $modal   = () => document.getElementById('wcf-modal');
const $mMsg    = () => document.getElementById('wcf-modal-msg');
const $mInput  = () => document.getElementById('wcf-modal-input');
const $mOk     = () => document.getElementById('wcf-modal-ok');
const $mCancel = () => document.getElementById('wcf-modal-cancel');

function open()  { $modal().classList.remove('hidden'); }
function close() {
  $modal().classList.add('hidden');
  const inp = $mInput();
  if (inp) { inp.value = ''; inp.classList.add('hidden'); }
  const ok = $mOk();
  if (ok) { ok.textContent = 'OK'; ok.className = okCls; }
}

const okCls  = 'px-4 py-2 rounded-lg text-xs font-semibold bg-purple-500 hover:bg-purple-600 text-white transition';
const delCls = 'px-4 py-2 rounded-lg text-xs font-semibold bg-red-500 hover:bg-red-600 text-white transition';

export function wcfPrompt(title, def = '') {
  return new Promise(resolve => {
    $mMsg().textContent = title;
    const inp = $mInput();
    inp.value = def;
    inp.classList.remove('hidden');
    open();
    setTimeout(() => { inp.focus(); inp.select(); }, 50);

    const ok     = () => { const v = inp.value.trim(); cleanup(); close(); resolve(v || null); };
    const cancel = () => { cleanup(); close(); resolve(null); };
    const onKey  = e => {
      if (e.key === 'Enter')  { e.preventDefault(); ok(); }
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    };
    const onBack = e => { if (e.target === $modal()) cancel(); };

    function cleanup() {
      $mOk().removeEventListener('click', ok);
      $mCancel().removeEventListener('click', cancel);
      $modal().removeEventListener('click', onBack);
      inp.removeEventListener('keydown', onKey);
    }
    $mOk().addEventListener('click', ok);
    $mCancel().addEventListener('click', cancel);
    $modal().addEventListener('click', onBack);
    inp.addEventListener('keydown', onKey);
  });
}

export function wcfConfirm(title, okLabel = 'Hapus') {
  return new Promise(resolve => {
    $mMsg().textContent = title;
    const inp = $mInput();
    inp.classList.add('hidden');
    const okBtn = $mOk();
    okBtn.textContent = okLabel;
    okBtn.className   = delCls;
    open();

    const ok     = () => { cleanup(); close(); resolve(true); };
    const cancel = () => { cleanup(); close(); resolve(false); };
    const onKey  = e => {
      if (e.key === 'Enter')  { e.preventDefault(); ok(); }
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    };
    const onBack = e => { if (e.target === $modal()) cancel(); };

    function cleanup() {
      okBtn.removeEventListener('click', ok);
      $mCancel().removeEventListener('click', cancel);
      $modal().removeEventListener('click', onBack);
      document.removeEventListener('keydown', onKey);
    }
    okBtn.addEventListener('click', ok);
    $mCancel().addEventListener('click', cancel);
    $modal().addEventListener('click', onBack);
    document.addEventListener('keydown', onKey);
  });
}
