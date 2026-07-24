let _tunnels        = [];
let _inspPort       = 0;
let _inspLoaded     = false;
let _inspTargetPort = null;  // port filter to apply when inspector opens
let _reqCounts      = {};    // { [localPort]: count }
let _qrCurrentUrl   = '';
let _toastTimer;
let _uptimeTimer;
let _pollTimer;
let _histExpanded   = {};    // { [tunnelKey]: bool } — expanded state for URL history

// Update state (global agar bisa diakses dari fungsi-fungsi di luar init)
let _pendingUpdateInfo = null;
let _updFakeIv         = null;
let _updRealProg       = false;

// Cloudflare state
let _cfLoggedIn    = false;
let _cfTunnels     = [];   // [{ id, name, ... }] from cloudflared
let _cfRoutes      = [];   // [{ tunnelId, tunnelName, hostname, port }] from app config
let _cfDnsRecords  = [];   // [{ id, name, content, proxied, ... }] from CF API
let _cfApiConfigured = false;

// ═══ Theme ════════════════════════════════════════════════════════════════════
function _applyLauncherTheme(isLight) {
  document.documentElement.classList.toggle('light', isLight);
  document.getElementById('lnch-moon').style.display = isLight ? 'none' : '';
  document.getElementById('lnch-sun' ).style.display = isLight ? ''     : 'none';
}
function toggleTheme() {
  const isLight = document.documentElement.classList.toggle('light');
  const theme   = isLight ? 'light' : 'dark';
  localStorage.setItem('wan-net-theme', theme);
  _applyLauncherTheme(isLight);
  const frame = document.getElementById('insp-frame');
  try { frame.contentWindow.postMessage({ type: 'wan-net-theme', theme }, '*'); } catch {}
}
window.addEventListener('message', e => {
  if (!e.data) return;
  if (e.data.type === 'wan-net-theme') {
    const isLight = e.data.theme === 'light';
    localStorage.setItem('wan-net-theme', e.data.theme);
    _applyLauncherTheme(isLight);
    return;
  }
  // Inspector minta native notification via Electron (Web Notification API
  // tidak reliable di production macOS build)
  if (e.data.type === 'wan-net-notify') {
    window.wanNet.showNotification(e.data.title || 'WAN NET', e.data.body || '');
  }
});
(function() {
  const saved = localStorage.getItem('wan-net-theme');
  const preferLight = saved ? saved === 'light' : window.matchMedia('(prefers-color-scheme: light)').matches;
  _applyLauncherTheme(preferLight);
})();

// ═══ Init ═════════════════════════════════════════════════════════════════════
async function init() {
  const _ver = await window.wanNet.getVersion().catch(() => '');
  if (_ver) document.getElementById('app-version').textContent = `v${_ver}`;

  _inspPort = await window.wanNet.getInspPort();
  document.getElementById('insp-link').textContent  = `http://localhost:${_inspPort}`;
  document.getElementById('topbar-url').textContent = `http://localhost:${_inspPort}`;

  _tunnels = await window.wanNet.listTunnels();
  render();

  window.wanNet.onTunnelUpdate(tunnels => { _tunnels = tunnels; render(); });

  _pollTimer   = setInterval(pollRequests, 3000);
  pollRequests();

  // Uptime updater (every second, DOM only — no re-render)
  _uptimeTimer = setInterval(updateUptimes, 1000);

  // Cleanup intervals saat window unload (penting kalau HMR / reload)
  window.addEventListener('beforeunload', () => {
    clearInterval(_pollTimer);
    clearInterval(_uptimeTimer);
  }, { once: true });

  // Check Cloudflare login status
  await initCF();

  // ── Auto-update listeners ──────────────────────────────────────────────────
  if (window.wanNet.onUpdateAvailable) {
    window.wanNet.onUpdateAvailable(info => {
      _pendingUpdateInfo = info;
      _updStateConfirm(info);
    });
    window.wanNet.onUpdateNotAvailable(() => {
      document.getElementById('upd-title').textContent   = 'Aplikasi sudah terbaru';
      document.getElementById('upd-icon').textContent    = '✅';
      document.getElementById('upd-status').textContent  = 'Kamu sudah menggunakan versi terbaru.';
      document.getElementById('upd-version').textContent = '';
      document.getElementById('upd-later-btn').textContent   = 'OK';
      document.getElementById('upd-later-btn').style.display = '';
      document.getElementById('upd-now-btn').style.display   = 'none';
    });
    window.wanNet.onDownloadProgress(prog => {
      _updRealProg = true;
      clearInterval(_updFakeIv);
      _setUpdPct(prog.percent || 0, prog.bytesPerSecond ? (prog.bytesPerSecond/1024).toFixed(0)+' KB/s' : '');
    });
    window.wanNet.onUpdateDownloaded(info  => _updStateReady(info));
    window.wanNet.onUpdateError(err => {
      document.getElementById('upd-icon').textContent    = '⚠️';
      document.getElementById('upd-title').textContent   = 'Update Gagal';
      document.getElementById('upd-status').textContent  = err.message || 'Terjadi kesalahan saat update.';
      document.getElementById('upd-later-btn').style.display = '';
      document.getElementById('upd-now-btn').style.display   = 'none';
      clearInterval(_updFakeIv);
    });
    window.wanNet.onTriggerCheckUpdate(() => checkForUpdate());
  }
}

// ═══ Cloudflare ═══════════════════════════════════════════════════════════════
async function initCF() {
  try {
    const [res, apiCfg] = await Promise.all([
      window.wanNet.cfLoginStatus(),
      window.wanNet.cfGetApiConfig().catch(() => ({})),
    ]);
    // Logged in via SSO (cert.pem) OR api-token mode dengan token+accountId tersimpan
    _cfLoggedIn = res.loggedIn || !!(apiCfg.token && apiCfg.accountId);
    if (_cfLoggedIn) await _loadCFData();
    renderCFChip();
  } catch {}
}

async function _loadCFData() {
  const [tunnelRes, routes, apiCfg, dnsRes] = await Promise.all([
    window.wanNet.cfTunnelList().catch(() => ({ tunnels: [] })),
    window.wanNet.cfGetRoutes().catch(() => []),
    window.wanNet.cfGetApiConfig().catch(() => ({ token: '', zoneId: '' })),
    window.wanNet.cfListDnsRecords().catch(() => ({ ok: false })),
  ]);
  _cfTunnels     = tunnelRes.tunnels || [];
  _cfRoutes      = Array.isArray(routes) ? routes : [];
  _cfApiConfigured = !!(apiCfg.token && apiCfg.zoneId);
  _cfDnsRecords  = (dnsRes.ok && Array.isArray(dnsRes.records)) ? dnsRes.records : [];
}

function renderCFChip() {
  const chip  = document.getElementById('cf-chip');
  const dot   = document.getElementById('cf-dot');
  const label = document.getElementById('cf-label');
  if (!chip) return;
  if (_cfLoggedIn) {
    chip.className    = 'cf-chip loggedin';
    dot.textContent   = '●';
    const tunnelCount = _cfTunnels.length;
    label.textContent = `Cloudflare ✓${tunnelCount ? ' · ' + tunnelCount + ' tunnel' : ''}`;
    chip.title        = 'Klik untuk kelola tunnel & subdomain';
  } else {
    chip.className    = 'cf-chip';
    dot.textContent   = '○';
    label.textContent = 'Login CF';
    chip.title        = 'Login ke Cloudflare untuk custom domain';
  }
  showModeRow();
}

let _isLoggingIn = false;

function handleCFChipClick() {
  if (_cfLoggedIn) { openCFManager(); return; }
  if (_isLoggingIn) { _cancelLogin(); return; }
  openCFLoginPicker();
}

// ─── CF Login Picker ──────────────────────────────────────────────────────────
function openCFLoginPicker() {
  document.getElementById('cf-login-overlay').classList.add('open');
  backToPickerStep();
}
function closeCFLoginPicker() {
  document.getElementById('cf-login-overlay').classList.remove('open');
}
function showAPITokenStep() {
  document.getElementById('cf-picker-step').style.display = 'none';
  document.getElementById('cf-apitoken-step').classList.add('open');
  document.getElementById('cf-at-msg').textContent = '';
  // Pre-fill semua field dari config tersimpan
  window.wanNet.cfGetApiConfig().then(cfg => {
    if (cfg.token)     document.getElementById('cf-at-token').value   = cfg.token;
    if (cfg.accountId) document.getElementById('cf-at-account').value = cfg.accountId;
    if (cfg.zoneId)    document.getElementById('cf-at-zone').value    = cfg.zoneId;
  }).catch(() => {});
}
function backToPickerStep() {
  document.getElementById('cf-picker-step').style.display = '';
  document.getElementById('cf-apitoken-step').classList.remove('open');
}

function startSSOLogin() {
  closeCFLoginPicker();
  _doLogin();
}

async function submitAPIToken() {
  const token     = (document.getElementById('cf-at-token')?.value   || '').trim();
  const accountId = (document.getElementById('cf-at-account')?.value || '').trim();
  const zoneId    = (document.getElementById('cf-at-zone')?.value    || '').trim();
  const msg       = document.getElementById('cf-at-msg');
  const btn       = document.getElementById('cf-at-submit');

  if (!token)     { msg.className = 'cf-login-msg err'; msg.textContent = '✗ API Token wajib diisi'; return; }
  if (!accountId) { msg.className = 'cf-login-msg err'; msg.textContent = '✗ Account ID wajib diisi'; return; }

  btn.disabled = true; btn.textContent = 'Memverifikasi…';
  msg.className = 'cf-login-msg'; msg.textContent = '';

  const res = await window.wanNet.cfLoginApiToken({ token, accountId });
  btn.disabled = false; btn.textContent = 'Masuk';

  if (res.ok) {
    // Simpan Zone ID juga jika diisi (untuk DNS operations)
    if (zoneId) await window.wanNet.cfSaveApiConfig({ token, accountId, zoneId }).catch(() => {});

    msg.className = 'cf-login-msg ok'; msg.textContent = '✓ Berhasil!';
    _cfLoggedIn = true;
    await _loadCFData();
    renderCFChip();
    setTimeout(closeCFLoginPicker, 800);
  } else {
    msg.className = 'cf-login-msg err';
    msg.textContent = '✗ ' + (res.error || 'Gagal verifikasi token');
  }
}

async function _cancelLogin() {
  await window.wanNet.cfLoginCancel().catch(() => {});
  _isLoggingIn = false;
  renderCFChip();
}

async function _doLogin() {
  _isLoggingIn = true;
  const chip  = document.getElementById('cf-chip');
  const label = document.getElementById('cf-label');
  chip.className    = 'cf-chip logging';
  label.textContent = '⟳ Buka browser… (klik untuk batal)';
  chip.title        = 'Klik untuk batalkan login';
  try {
    const res = await window.wanNet.cfLogin();
    _isLoggingIn = false;
    if (res.ok) {
      _cfLoggedIn = true;
      await _loadCFData();
      renderCFChip();
    } else {
      label.textContent = res.error?.includes('Timeout') ? 'Timeout — coba lagi' : 'Login gagal';
      chip.className = 'cf-chip';
      setTimeout(renderCFChip, 3000);
    }
  } catch {
    _isLoggingIn = false;
    chip.className = 'cf-chip';
    renderCFChip();
  }
}

// ═══ Tunnel mode selector ══════════════════════════════════════════════════════
let _tunnelMode = 'quick'; // 'quick' | 'custom' | 'host'

function onPortInput() {
  updateModeRouteSelect();
}

function setTunnelMode(mode) {
  _tunnelMode = mode;
  document.getElementById('mode-quick').classList.toggle('active', mode === 'quick');
  document.getElementById('mode-custom').classList.toggle('active', mode === 'custom');
  document.getElementById('mode-host').classList.toggle('active', mode === 'host');

  // Toggle port vs host input
  const portInput = document.getElementById('port-input');
  const hostInput = document.getElementById('host-input');
  if (portInput) portInput.style.display = mode === 'host' ? 'none' : '';
  if (hostInput) hostInput.style.display = mode === 'host' ? '' : 'none';

  const sel      = document.getElementById('mode-route-select');
  const noRoutes = document.getElementById('mode-no-routes');
  if (mode === 'custom' || mode === 'host') {
    updateModeRouteSelect();
  } else {
    if (sel)      sel.style.display = 'none';
    if (noRoutes) noRoutes.style.display = 'none';
  }
}

function updateModeRouteSelect() {
  if (_tunnelMode !== 'custom' && _tunnelMode !== 'host') return;
  const sel      = document.getElementById('mode-route-select');
  const noRoutes = document.getElementById('mode-no-routes');
  if (!sel) return;

  // Gabungkan local routes + DNS records dari CF API
  const merged = [..._cfRoutes];
  for (const rec of _cfDnsRecords) {
    const m = rec.content && rec.content.match(/^([a-f0-9-]{36})\.cfargotunnel\.com$/i);
    if (!m) continue;
    if (!merged.find(r => r.hostname === rec.name)) {
      merged.push({ hostname: rec.name, tunnelId: m[1], port: null });
    }
  }

  if (!merged.length) {
    sel.style.display = 'none';
    if (noRoutes) noRoutes.style.display = '';
    return;
  }

  if (noRoutes) noRoutes.style.display = 'none';
  sel.style.display = '';

  if (_tunnelMode === 'host') {
    // Host mode: tampilkan semua route tanpa filter port, domain opsional
    let opts = '<option value="">– Tanpa custom domain (quick tunnel) –</option>';
    opts += merged.map(r =>
      `<option value="${esc(r.hostname)}" data-tid="${esc(r.tunnelId)}">${esc(r.hostname)} ${r.port ? `(:${r.port})` : ''}</option>`
    ).join('');
    sel.innerHTML = opts;
    return;
  }

  // Custom domain mode: filter berdasarkan port
  const port = parseInt(document.getElementById('port-input')?.value, 10);
  const portRoutes  = merged.filter(r => r.port === port);
  const otherRoutes = merged.filter(r => r.port !== port);

  let opts = '<option value="">– Pilih subdomain route –</option>';
  if (portRoutes.length) {
    opts += portRoutes.map(r =>
      `<option value="${esc(r.hostname)}" data-tid="${esc(r.tunnelId)}">${esc(r.hostname)} (:${r.port})</option>`
    ).join('');
  }
  if (portRoutes.length && otherRoutes.length) {
    opts += '<option disabled>──────────────</option>';
  }
  opts += otherRoutes.map(r =>
    `<option value="${esc(r.hostname)}" data-tid="${esc(r.tunnelId)}">${esc(r.hostname)} ${r.port ? `(:${r.port})` : ''}</option>`
  ).join('');
  sel.innerHTML = opts;

  // Auto-select if only one route matches the port
  if (portRoutes.length === 1) sel.value = portRoutes[0].hostname;
}

function onModeRouteChange() { /* just reading value on submit is enough */ }

function showModeRow() {
  // Mode row selalu tampil; tombol Custom Domain hanya muncul jika login CF
  const btnCustom = document.getElementById('mode-custom');
  if (btnCustom) btnCustom.style.display = _cfLoggedIn ? '' : 'none';
  // Jika logout dan sedang di mode custom, kembali ke quick
  if (!_cfLoggedIn && _tunnelMode === 'custom') setTunnelMode('quick');
}

// ═══ (removed) Port route hint — replaced by mode-row ══════════════════════
function updateRouteHint() { /* no-op: kept for safety */ }

// ═══ CF Manager Modal ══════════════════════════════════════════════════════════
async function openCFManager() {
  document.getElementById('cf-manager-overlay').classList.add('open');
  document.getElementById('cf-manager-body').innerHTML =
    '<div style="color:var(--muted);font-size:12px;padding:10px 0">Memuat…</div>';
  // Pre-fill API inputs if configured
  try {
    const cfg = await window.wanNet.cfGetApiConfig();
    if (cfg.token)     document.getElementById('cf-api-token').value   = cfg.token;
    if (cfg.accountId) document.getElementById('cf-account-id').value  = cfg.accountId;
    if (cfg.zoneId)    document.getElementById('cf-zone-id').value     = cfg.zoneId;
  } catch {}
  await _loadCFData();   // selalu refresh saat buka
  renderCFManager();
}
function closeCFManager() {
  document.getElementById('cf-manager-overlay').classList.remove('open');
}

function toggleApiSetup() {
  document.getElementById('api-setup-panel').classList.toggle('open');
}

async function saveApiSetup() {
  const token     = (document.getElementById('cf-api-token')?.value  || '').trim();
  const accountId = (document.getElementById('cf-account-id')?.value || '').trim();
  const zoneId    = (document.getElementById('cf-zone-id')?.value    || '').trim();
  const msg       = document.getElementById('api-setup-msg');
  if (!token || !accountId || !zoneId) {
    msg.style.color = 'var(--red)';
    msg.textContent = '✗ Token, Account ID, dan Zone ID wajib diisi';
    return;
  }
  msg.style.color = 'var(--muted)'; msg.textContent = 'Menyimpan…';
  await window.wanNet.cfSaveApiConfig({ token, accountId, zoneId });
  _cfLoggedIn = true;   // token+accountId cukup → anggap logged in
  msg.style.color = 'var(--green)'; msg.textContent = '✓ Tersimpan, memuat ulang data…';
  await _loadCFData();
  renderCFChip();
  renderCFManager();
  setTimeout(() => { msg.textContent = ''; document.getElementById('api-setup-panel').classList.remove('open'); }, 1500);
}

async function cfLogout() {
  if (!confirm('Logout dari Cloudflare?\n\nAPI Token & Zone ID tetap tersimpan untuk login berikutnya.')) return;
  await window.wanNet.cfLogout();
  _cfLoggedIn   = false;
  _cfTunnels    = [];
  _cfRoutes     = [];
  _cfDnsRecords = [];
  closeCFManager();
  renderCFChip();
  showModeRow();
}

function renderCFManager() {
  const body = document.getElementById('cf-manager-body');
  if (!body) return;

  // Build a map: tunnelId → CNAME records from CF API
  const cnameByTunnel = {};
  for (const rec of _cfDnsRecords) {
    // content is like "tunnelId.cfargotunnel.com"
    const m = rec.content && rec.content.match(/^([a-f0-9-]{36})\.cfargotunnel\.com$/i);
    if (m) {
      const tid = m[1];
      if (!cnameByTunnel[tid]) cnameByTunnel[tid] = [];
      cnameByTunnel[tid].push(rec);
    }
  }

  // Build port lookup from local routes
  const portByHostname = {};
  for (const r of _cfRoutes) portByHostname[r.hostname] = r.port;

  let html = '';

  if (!_cfApiConfigured) {
    html += `<div class="cname-status err" style="padding:4px 0 10px">
      ⚠ API Token belum dikonfigurasi. Klik <b>⚙ API Setup</b> di atas untuk menampilkan CNAME records.</div>`;
    // Jangan tampilkan daftar tunnel jika API belum dikonfigurasi
    const createSection = `<div class="create-new-section">
      <label>Buat tunnel baru:</label>
      <input class="create-new-input" id="new-tname" value="wan-net" maxlength="32" placeholder="nama-tunnel" />
      <button class="btn-create-new" id="btn-create-new" onclick="cfCreateTunnel()">＋ Buat</button>
    </div>
    <div class="cfm-create-msg" id="cfm-create-msg"></div>`;
    body.innerHTML = html + createSection;
    return;
  }

  for (const t of _cfTunnels) {
    const cnames = cnameByTunnel[t.id] || [];

    let cnameRows = '';
    if (!_cfApiConfigured) {
      // Show local routes only
      const localRoutes = _cfRoutes.filter(r => r.tunnelId === t.id);
      cnameRows = localRoutes.length
        ? localRoutes.map(r => `
            <div class="cname-row">
              <span class="cname-hostname" title="${esc(r.hostname)}">${esc(r.hostname)}</span>
              <span class="cname-port">:${r.port}</span>
              <span class="cname-proxy" title="Proxied">🟠</span>
              <button class="btn-del-cname" onclick="cfRemoveRoute('${esc(r.hostname)}')" title="Hapus dari local config">✕</button>
            </div>`).join('')
        : `<div class="cname-empty">Belum ada route tersimpan.</div>`;
    } else {
      cnameRows = cnames.length
        ? cnames.map(r => {
            const port    = portByHostname[r.name];
            const portLbl = port ? `:${port}` : '–';
            const portCls = port ? 'cname-port' : 'cname-port unset';
            const proxied = r.proxied ? '🟠' : '⚫';
            return `
              <div class="cname-row">
                <span class="cname-hostname" title="${esc(r.name)}">${esc(r.name)}</span>
                <span class="${portCls}">${portLbl}</span>
                <span class="cname-proxy" title="${r.proxied ? 'Proxied' : 'DNS only'}">${proxied}</span>
                <button class="btn-del-cname" onclick="cfDeleteCname('${esc(r.id)}','${esc(r.name)}')" title="Hapus CNAME dari Cloudflare">🗑</button>
              </div>`;
          }).join('')
        : `<div class="cname-empty">Belum ada CNAME record untuk tunnel ini.</div>`;
    }

    html += `
      <div class="tunnel-card" id="tc-${t.id}">
        <div class="tunnel-card-header">
          <span class="tunnel-name-lbl">${esc(t.name)}</span>
          <span class="tunnel-id-lbl">ID: ${t.id.slice(0,12)}…</span>
          <button class="btn-delete-tunnel" onclick="cfDeleteTunnel('${esc(t.name)}','${t.id}')">🗑 Hapus</button>
        </div>
        <div class="cname-section">
          <div class="cname-header">
            <span>CNAME Records ${_cfApiConfigured ? `(${cnames.length})` : '(local)'}</span>
          </div>
          ${cnameRows}
        </div>
        <div class="route-msg" id="rmsg-${t.id}"></div>
        <div class="add-route-form" id="arf-${t.id}" style="display:none">
          <input class="arf-input host" id="arf-host-${t.id}" placeholder="sub.example.com" />
          <input class="arf-input port" id="arf-port-${t.id}" placeholder=":3000" type="number" min="1" max="65535" />
          <button class="btn-add-route" onclick="cfAddCname('${t.id}','${esc(t.name)}')">＋ Tambah</button>
          <button class="btn-remove-route" onclick="toggleAddCname('${t.id}')" title="Batal">✕</button>
        </div>
        <button class="add-cname-toggle" onclick="toggleAddCname('${t.id}')">＋ Tambah CNAME</button>
      </div>`;
  }

  // Create new tunnel section
  html += `
    <div class="create-new-section">
      <label>Buat tunnel baru:</label>
      <input class="create-new-input" id="new-tname" value="wan-net" maxlength="32" placeholder="nama-tunnel" />
      <button class="btn-create-new" id="btn-create-new" onclick="cfCreateTunnel()">＋ Buat</button>
    </div>
    <div class="cfm-create-msg" id="cfm-create-msg"></div>`;

  if (_cfTunnels.length === 0) {
    html = `<div style="color:var(--muted);font-size:12px;padding:0 0 12px">Belum ada named tunnel.</div>` + html;
  }

  body.innerHTML = html;
}

function toggleAddCname(tunnelId) {
  const form = document.getElementById(`arf-${tunnelId}`);
  const btn  = form?.nextElementSibling; // the "＋ Tambah CNAME" toggle button
  if (!form) return;
  const showing = form.style.display !== 'none';
  form.style.display = showing ? 'none' : '';
  if (btn) btn.style.display = showing ? '' : 'none';
}

async function cfAddCname(tunnelId, tunnelName) {
  const hostname = (document.getElementById(`arf-host-${tunnelId}`)?.value || '').trim();
  const port     = parseInt(document.getElementById(`arf-port-${tunnelId}`)?.value, 10);
  const msg      = document.getElementById(`rmsg-${tunnelId}`);

  if (!hostname || !hostname.includes('.')) { _cfmMsg(msg, '✗ Domain tidak valid', 'err'); return; }
  if (!port || port < 1 || port > 65535)    { _cfmMsg(msg, '✗ Port tidak valid', 'err'); return; }

  const btn = document.querySelector(`#tc-${tunnelId} .btn-add-route`);
  if (btn) { btn.disabled = true; btn.textContent = '⟳'; }

  if (_cfApiConfigured) {
    _cfmMsg(msg, 'Menambahkan CNAME via API…', '');
    const res = await window.wanNet.cfAddCname({ name: hostname, tunnelId, port });
    if (btn) { btn.disabled = false; btn.textContent = '＋ Tambah'; }
    if (res.ok) {
      _cfmMsg(msg, `✓ ${hostname} ditambahkan`, 'ok');
      await _loadCFData(); renderCFChip(); renderCFManager();
    } else {
      _cfmMsg(msg, '✗ ' + (res.error || 'Gagal'), 'err');
    }
  } else {
    // Fallback: use cloudflared CLI
    _cfmMsg(msg, 'Menambahkan DNS route via cloudflared…', '');
    const res = await window.wanNet.cfAddRoute({ tunnelId, tunnelName, hostname, port });
    if (btn) { btn.disabled = false; btn.textContent = '＋ Tambah'; }
    if (res.ok) {
      _cfmMsg(msg, `✓ ${hostname} → :${port} ditambahkan`, 'ok');
      await _loadCFData(); renderCFChip(); renderCFManager();
    } else {
      _cfmMsg(msg, '✗ ' + (res.error || 'Gagal'), 'err');
    }
  }
}

async function cfDeleteCname(recordId, hostname) {
  if (!confirm(`Hapus CNAME "${hostname}" dari Cloudflare DNS?\n\nIni akan menghapus record secara permanen.`)) return;
  const res = await window.wanNet.cfDeleteCname({ recordId, hostname });
  if (res.ok) {
    await _loadCFData(); renderCFChip(); renderCFManager();
  } else {
    alert('Gagal hapus CNAME: ' + (res.error || 'unknown'));
  }
}

async function cfRemoveRoute(hostname) {
  if (!confirm(`Hapus "${hostname}" dari local config?\n(DNS record di Cloudflare tidak terhapus)`)) return;
  await window.wanNet.cfRemoveRoute(hostname);
  await _loadCFData(); renderCFChip(); renderCFManager();
}

async function cfDeleteTunnel(name, id) {
  if (!confirm(`Hapus tunnel "${name}"?\nSemua route-nya juga akan dihapus.`)) return;
  const res = await window.wanNet.cfDeleteTunnelNamed(name);
  if (res.ok) {
    await _loadCFData(); renderCFChip(); renderCFManager();
  } else {
    alert('Gagal hapus tunnel: ' + (res.output || res.error || 'unknown'));
  }
}

async function cfCreateTunnel() {
  const name = (document.getElementById('new-tname')?.value || '').trim();
  const msg  = document.getElementById('cfm-create-msg');
  const btn  = document.getElementById('btn-create-new');
  if (!name) { _cfmMsg(msg, '✗ Masukkan nama tunnel', 'err'); return; }

  btn.disabled = true; btn.textContent = '⟳ Membuat…';
  _cfmMsg(msg, '', '');

  const res = await window.wanNet.cfCreateTunnel(name);
  btn.disabled = false; btn.textContent = '＋ Buat';

  if (res.ok) {
    _cfmMsg(msg, `✓ Tunnel "${name}" berhasil dibuat`, 'ok');
    await _loadCFData(); renderCFChip(); renderCFManager();
  } else {
    _cfmMsg(msg, '✗ ' + (res.error || 'Gagal'), 'err');
  }
}

function _cfmMsg(el, text, cls) {
  if (!el) return;
  el.textContent = text;
  el.className   = 'cfm-create-msg' + (cls ? ' ' + cls : '');
}

// ═══ Poll ═════════════════════════════════════════════════════════════════════
async function pollRequests() {
  try {
    const r = await fetch(`http://localhost:${_inspPort}/log`);
    if (!r.ok) return;
    const log = await r.json();

    // ── Per-port counts (untuk chip di kartu) ─────────────────────────────────
    const counts = {};
    for (const e of log) if (e.localPort) counts[e.localPort] = (counts[e.localPort] || 0) + 1;
    _reqCounts = counts;
    for (const [port, cnt] of Object.entries(counts)) {
      const el = document.getElementById(`req-count-${port}`);
      if (el) el.textContent = `${cnt} req`;
    }

    // ── Global stats ──────────────────────────────────────────────────────────
    const total  = log.length;
    const errors = log.filter(e => (e.status >= 400 && e.status !== null) || e.status === 0).length;
    const done   = log.filter(e => e.ms != null);
    const avgMs  = done.length ? Math.round(done.reduce((a, e) => a + e.ms, 0) / done.length) : 0;
    const errPct = total ? Math.round(errors / total * 100) : 0;
    const hasErr = errors > 0;

    // Bottom bar request button
    const reqBtn = document.getElementById('insp-requests');
    reqBtn.textContent = hasErr ? `${total} req · ${errors} err` : `${total} req`;
    reqBtn.style.color = hasErr ? 'var(--red)' : '';

    // Mini global stats bar
    const gs = document.getElementById('global-stats');
    if (total > 0) {
      gs.style.display = 'flex';
      document.getElementById('gs-total').textContent = `${total} req`;
      const gsErr = document.getElementById('gs-err');
      gsErr.textContent  = `${errors} err${total ? ' ('+errPct+'%)' : ''}`;
      gsErr.style.color  = hasErr ? 'var(--red)' : 'var(--green)';
      document.getElementById('gs-avg').textContent = avgMs ? `avg ${avgMs}ms` : '– ms';
    } else {
      gs.style.display = 'none';
    }
  } catch {}
}

function updateUptimes() {
  for (const t of _tunnels) {
    if (!t.startedAt || t.status === 'stopped') continue;
    const el = document.getElementById(`uptime-${t.tunnelKey}`);
    if (el) el.textContent = formatUptime(Math.floor((Date.now() - t.startedAt) / 1000));
  }
}

// ═══ View switching ════════════════════════════════════════════════════════════
function _pushInspectorState(frame) {
  const theme = document.documentElement.classList.contains('light') ? 'light' : 'dark';
  try { frame.contentWindow.postMessage({ type: 'wan-net-theme', theme }, '*'); } catch {}
  if (_inspTargetPort !== null) {
    try { frame.contentWindow.postMessage({ type: 'wan-net-port-filter', port: _inspTargetPort }, '*'); } catch {}
  }
}

function showInspector(key) {
  // key can be a tunnelKey string ("3000" or "setiyawan.test") or undefined
  _inspTargetPort = (key !== undefined && key !== null) ? key : null;
  const frame = document.getElementById('insp-frame');

  // Update topbar port indicator
  const filterLabel = _inspTargetPort
    ? (!isNaN(_inspTargetPort) ? `:${_inspTargetPort}` : _inspTargetPort)
    : '';
  document.getElementById('insp-filter-label').textContent = filterLabel ? `Filter: ${filterLabel}` : '';

  if (!_inspLoaded) {
    _inspLoaded = true;
    frame.src   = `http://localhost:${_inspPort}`;
    frame.onload = () => _pushInspectorState(frame);
  } else {
    // Already loaded — push filter immediately
    _pushInspectorState(frame);
  }
  document.getElementById('view-dashboard').classList.add('hidden');
  document.getElementById('view-inspector').classList.add('visible');
}
function showDashboard() {
  document.getElementById('view-inspector').classList.remove('visible');
  document.getElementById('view-dashboard').classList.remove('hidden');
}
function reloadInsp() {
  const frame = document.getElementById('insp-frame');
  _inspLoaded = false;
  frame.src = `http://localhost:${_inspPort}`;
  frame.onload = () => { _inspLoaded = true; _pushInspectorState(frame); };
}
function clearPortFilter() {
  _inspTargetPort = null;
  document.getElementById('insp-filter-label').textContent = '';
  const frame = document.getElementById('insp-frame');
  try { frame.contentWindow.postMessage({ type: 'wan-net-port-filter', port: null }, '*'); } catch {}
}

// ═══ Tunnel actions ════════════════════════════════════════════════════════════
async function addTunnel() {
  setErr('');
  let port = 0, opts = {};

  if (_tunnelMode === 'host') {
    // Static Host mode — input adalah hostname lokal
    const hostInput = document.getElementById('host-input');
    const host = hostInput.value.trim();
    if (!host) { setErr('Masukkan hostname lokal.'); return; }
    if (!host.includes('.')) { setErr('Host tidak valid. Contoh: setiyawan.test atau myapp.local'); return; }
    const existing = _tunnels.find(t => t.tunnelKey === host && t.status !== 'stopped');
    if (existing) { setErr(`Host ${host} sudah berjalan.`); return; }
    opts.staticHost = host;

    // Opsional: pakai custom domain untuk static host
    if (_cfLoggedIn) {
      const sel = document.getElementById('mode-route-select');
      const hostname = sel?.value;
      if (hostname) {
        let route = _cfRoutes.find(r => r.hostname === hostname);
        if (!route) {
          for (const rec of _cfDnsRecords) {
            const m = rec.content && rec.content.match(/^([a-f0-9-]{36})\.cfargotunnel\.com$/i);
            if (m && rec.name === hostname) { route = { hostname: rec.name, tunnelId: m[1] }; break; }
          }
        }
        if (route) { opts.customDomain = route.hostname; opts.tunnelId = route.tunnelId; }
      }
    }
  } else {
    // Port mode
    const portInput = document.getElementById('port-input');
    port = parseInt(portInput.value, 10);
    if (!port || port < 1 || port > 65535) { setErr('Port tidak valid (1–65535).'); return; }
    const existing = _tunnels.find(t => t.tunnelKey === String(port) && t.status !== 'stopped');
    if (existing) { setErr(`Port ${port} sudah berjalan.`); return; }

    if (_cfLoggedIn && _tunnelMode === 'custom') {
      const sel = document.getElementById('mode-route-select');
      const hostname = sel?.value;
      if (!hostname) { setErr('Pilih subdomain route terlebih dahulu.'); return; }
      let route = _cfRoutes.find(r => r.hostname === hostname);
      if (!route) {
        for (const rec of _cfDnsRecords) {
          const m = rec.content && rec.content.match(/^([a-f0-9-]{36})\.cfargotunnel\.com$/i);
          if (m && rec.name === hostname) { route = { hostname: rec.name, tunnelId: m[1] }; break; }
        }
      }
      if (route) opts = { customDomain: route.hostname, tunnelId: route.tunnelId };
    }
  }

  const btn = document.getElementById('btn-add');
  btn.disabled = true; btn.textContent = 'Memulai…';
  try {
    const res = await window.wanNet.startTunnel(port, opts);
    if (!res.ok) setErr(res.error || 'Gagal memulai tunnel.');
    else {
      document.getElementById('port-input').value = '';
      document.getElementById('host-input').value = '';
    }
  } catch (e) { setErr('Error: ' + e.message); }
  finally { btn.disabled = false; btn.textContent = '▶ Start'; }
}
async function stopTunnel(key)   { await window.wanNet.stopTunnel(key); }
async function deleteTunnel(key) { await window.wanNet.deleteTunnel(key); }
async function deleteAll() {
  if (!confirm('Hapus semua tunnel?')) return;
  await window.wanNet.deleteAllTunnels();
}
async function restartTunnel(key) {
  const t = _tunnels.find(x => x.tunnelKey === key);
  await window.wanNet.stopTunnel(key);
  await new Promise(r => setTimeout(r, 400));
  if (t?.staticHost) await window.wanNet.startTunnel(0, { staticHost: t.staticHost });
  else await window.wanNet.startTunnel(Number(key));
}
async function toggleAutoStart(key) {
  await window.wanNet.toggleAutoStart(key);
}
async function setRateLimit(key) {
  const t = _tunnels.find(x => x.tunnelKey === key);
  const current = t?.rateLimit?.maxReq || 0;
  const input = prompt(
    `Rate limit untuk ${key}\n\nMaksimal request per detik (0 = nonaktif):`,
    String(current)
  );
  if (input === null) return;
  const maxReq = parseInt(input, 10) || 0;
  const res = await window.wanNet.setRateLimit(key, maxReq, 1000);
  if (res && res.ok) showToast();
}
async function removeDomain(key) {
  await window.wanNet.cfDeleteDomain(key);
  pushUpdate();
}

// ═══ Label editing ═════════════════════════════════════════════════════════════
function editLabel(key) {
  const spanId  = `label-span-${key}`;
  const span = document.getElementById(spanId);
  if (!span) return;

  const t = _tunnels.find(t => t.tunnelKey === key);
  const current = t?.label || '';

  span.style.display = 'none';
  const inp = document.createElement('input');
  inp.className   = 'label-input';
  inp.value       = current;
  inp.placeholder = 'Nama tunnel…';
  inp.maxLength   = 30;
  span.parentNode.insertBefore(inp, span.nextSibling);
  inp.focus();
  inp.select();

  const save = async () => {
    const label = inp.value.trim();
    await window.wanNet.setLabel(key, label);
    inp.remove();
    span.style.display = '';
  };
  inp.onblur = save;
  inp.onkeydown = e => {
    if (e.key === 'Enter') { inp.blur(); }
    if (e.key === 'Escape') { inp.value = current; inp.blur(); }
  };
}

// ═══ QR Code ═══════════════════════════════════════════════════════════════════
async function openQR(url) {
  _qrCurrentUrl = url;
  document.getElementById('qr-url-text').textContent = url;
  document.getElementById('qr-img').src = '';
  document.getElementById('qr-overlay').classList.add('open');

  const dataUrl = await window.wanNet.generateQR(url);
  if (dataUrl) document.getElementById('qr-img').src = dataUrl;
  else document.getElementById('qr-img').alt = 'Gagal generate QR';
}
function closeQR() { document.getElementById('qr-overlay').classList.remove('open'); }

// ── Update dialog state helpers (global scope) ────────────────────────────────
function _setUpdPct(pct, speed) {
  document.getElementById('upd-bar').style.width = pct + '%';
  document.getElementById('upd-pct').textContent = Math.round(pct) + '%';
  if (speed !== undefined) document.getElementById('upd-speed').textContent = speed;
}
function _updStateChecking() {
  document.getElementById('upd-icon').textContent            = '🔄';
  document.getElementById('upd-title').textContent           = 'Memeriksa pembaruan…';
  document.getElementById('upd-version').textContent         = '';
  document.getElementById('upd-status').textContent          = '';
  document.getElementById('upd-progress-wrap').style.display = 'none';
  document.getElementById('upd-later-btn').style.display     = 'none';
  document.getElementById('upd-now-btn').style.display       = 'none';
  document.getElementById('upd-install-btn').style.display   = 'none';
  document.getElementById('update-overlay').style.display    = 'flex';
}
function _updStateConfirm(info) {
  document.getElementById('upd-icon').textContent            = '⬆️';
  document.getElementById('upd-title').textContent           = 'Update Tersedia';
  document.getElementById('upd-version').textContent         = `Versi ${info.version}`;
  document.getElementById('upd-status').textContent          = `Versi ${info.version} siap diunduh. Mau update sekarang?`;
  document.getElementById('upd-progress-wrap').style.display = 'none';
  document.getElementById('upd-later-btn').textContent       = 'Nanti';
  document.getElementById('upd-later-btn').style.display     = '';
  document.getElementById('upd-now-btn').style.display       = '';
  document.getElementById('upd-install-btn').style.display   = 'none';
  document.getElementById('update-overlay').style.display    = 'flex';
}
function _updStateDownloading(version) {
  document.getElementById('upd-icon').textContent            = '⬆️';
  document.getElementById('upd-title').textContent           = 'Mengunduh Update…';
  document.getElementById('upd-version').textContent         = `Versi ${version}`;
  document.getElementById('upd-status').textContent          = 'Harap tunggu, sedang mengunduh pembaruan.';
  document.getElementById('upd-progress-wrap').style.display = 'flex';
  document.getElementById('upd-later-btn').style.display     = 'none';
  document.getElementById('upd-now-btn').style.display       = 'none';
  document.getElementById('upd-install-btn').style.display   = 'none';
  _setUpdPct(0, '');
  _updRealProg = false;
  clearInterval(_updFakeIv);
  let fake = 0;
  _updFakeIv = setInterval(() => {
    if (_updRealProg) { clearInterval(_updFakeIv); return; }
    const step = fake < 30 ? 1.2 : fake < 60 ? 0.6 : fake < 80 ? 0.25 : 0.05;
    fake = Math.min(fake + step, 88);
    _setUpdPct(fake, '');
    if (fake >= 88) clearInterval(_updFakeIv);
  }, 200);
}
function _updStateReady(info) {
  clearInterval(_updFakeIv);
  _setUpdPct(100, '');
  document.getElementById('upd-icon').textContent            = '✅';
  document.getElementById('upd-title').textContent           = 'Update Siap Diinstall';
  document.getElementById('upd-version').textContent         = `Versi ${info.version}`;
  document.getElementById('upd-status').textContent          = `v${info.version} berhasil diunduh. Restart untuk menerapkan.`;
  document.getElementById('upd-later-btn').style.display     = '';
  document.getElementById('upd-now-btn').style.display       = 'none';
  document.getElementById('upd-install-btn').style.display   = '';
  document.getElementById('update-overlay').style.display    = 'flex';
}
function closeUpdateDialog() { document.getElementById('update-overlay').style.display = 'none'; }

async function checkForUpdate() {
  _updStateChecking();
  await window.wanNet.checkForUpdate().catch(() => {
    document.getElementById('upd-icon').textContent   = '⚠️';
    document.getElementById('upd-title').textContent  = 'Gagal Memeriksa';
    document.getElementById('upd-status').textContent = 'Tidak dapat menghubungi server update. Periksa koneksi internet.';
    document.getElementById('upd-later-btn').style.display = '';
  });
}

async function startUpdateDownload() {
  if (!_pendingUpdateInfo) return;
  _updStateDownloading(_pendingUpdateInfo.version);
  await window.wanNet.startDownloadUpdate().catch(e => {
    document.getElementById('upd-icon').textContent   = '⚠️';
    document.getElementById('upd-title').textContent  = 'Download Gagal';
    document.getElementById('upd-status').textContent = e?.message || 'Gagal mengunduh update.';
    document.getElementById('upd-later-btn').style.display = '';
    clearInterval(_updFakeIv);
  });
}

// ── TEST shortcut: Ctrl+Shift+U → simulasi update dialog ─────────────────────
window.addEventListener('keydown', e => {
  if (e.ctrlKey && e.shiftKey && e.key === 'U') {
    document.getElementById('upd-version').textContent  = 'Versi 1.5.0';
    document.getElementById('upd-title').textContent    = 'Update Tersedia';
    document.getElementById('upd-status').textContent   = 'Mengunduh pembaruan…';
    document.getElementById('upd-bar').style.width      = '0%';
    document.getElementById('upd-pct').textContent      = '0%';
    document.getElementById('upd-speed').textContent    = '';
    document.getElementById('upd-progress-wrap').style.display = 'flex';
    document.getElementById('upd-install-btn').style.display   = 'none';
    document.getElementById('update-overlay').style.display    = 'flex';
    let pct = 0;
    const iv = setInterval(() => {
      pct += 2;
      document.getElementById('upd-bar').style.width  = pct + '%';
      document.getElementById('upd-pct').textContent  = pct + '%';
      document.getElementById('upd-speed').textContent = (Math.random()*500+200).toFixed(0)+' KB/s';
      if (pct >= 100) {
        clearInterval(iv);
        setTimeout(() => {
          document.getElementById('upd-title').textContent  = 'Update Siap Diinstall';
          document.getElementById('upd-status').textContent = 'v1.5.0 berhasil diunduh. Restart untuk menerapkan.';
          document.getElementById('upd-speed').textContent  = '';
          document.getElementById('upd-install-btn').style.display = '';
        }, 300);
      }
    }, 100);
  }
});
async function copyQR() {
  await window.wanNet.copyText(_qrCurrentUrl);
  showToast();
}

// ═══ Copy helpers ══════════════════════════════════════════════════════════════
async function copyInsp() { await window.wanNet.copyText(`http://localhost:${_inspPort}`); showToast(); }
async function copyUrl(url){ await window.wanNet.copyText(url); showToast(); }
function openUrl(url)      { if (url) window.wanNet.openExternal(url); }
function openSettings()    { window.wanNet.openSettings(); }

// ═══ Render ════════════════════════════════════════════════════════════════════
function render() {
  const container = document.getElementById('tunnel-list');
  const live  = _tunnels.filter(t => t.status === 'live').length;
  const total = _tunnels.filter(t => t.status !== 'stopped').length;
  const sub = document.getElementById('insp-subtitle');
  if (total === 0) {
    sub.innerHTML = 'Tidak ada tunnel aktif';
  } else {
    sub.innerHTML = `<span class="lc">${live}</span>/<span>${total}</span> live`;
  }
  document.getElementById('btn-delete-all').style.display = _tunnels.length ? '' : 'none';

  if (_tunnels.length === 0) {
    container.innerHTML = `
      <div class="empty">
        <div class="empty-icon">🌐</div>
        <span class="empty-title">Belum ada tunnel aktif</span>
        <span class="empty-sub">Masukkan port lokal di atas dan klik <b>▶ Start</b></span>
      </div>`;
    return;
  }
  container.innerHTML = _tunnels.map(cardHTML).join('');
}

function toggleHistory(port) {
  _histExpanded[port] = !_histExpanded[port];
  render();
}

function cardHTML(t) {
  const k = t.tunnelKey; // string key — used for all IPC calls and element IDs
  const statusText = { live:'Live', starting:'Menghubungkan…', reconnecting:'Reconnecting…', stopped:'Stopped' }[t.status] ?? t.status;
  const reqCnt  = _reqCounts[k] || 0;
  const uptime  = t.startedAt && t.status !== 'stopped' ? formatUptime(Math.floor((Date.now() - t.startedAt) / 1000)) : '–';
  const labelTxt = t.label ? esc(t.label) : '<span style="opacity:.4">Tambah nama…</span>';
  const rc   = t.reconnectCount || 0;
  const hist = t.urlHistory || [];
  const rl   = t.rateLimit || null;
  const kq   = `'${escOnclick(k)}'`; // key di-escape untuk JS string + HTML attr context

  // Named tunnel badge
  const namedBadge = t.customDomain
    ? `<div class="named-badge">🔗 ${esc(t.customDomain)}
         <button onclick="removeDomain(${kq})" title="Hapus custom domain"
           style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:10px;padding:0 0 0 4px;line-height:1">✕</button>
       </div>` : '';

  // Static host badge
  const hostBadge = t.staticHost
    ? `<div class="named-badge" style="background:rgba(99,102,241,.15);color:#818cf8">🖥 ${esc(t.staticHost)}</div>` : '';

  // URL block
  const urlBlock = `
    <div class="tcard-url">
      <div class="tcard-url-inner">
        ${t.url
          ? `<span class="tcard-url-link" onclick="openUrl('${escOnclick(t.url)}')" title="Buka di browser">${esc(t.url)}</span>
             <button class="btn-icon" title="Salin URL" onclick="copyUrl('${escOnclick(t.url)}')">⎘</button>
             <button class="btn-icon" title="QR Code"   onclick="openQR('${escOnclick(t.url)}')">▦</button>`
          : `<span class="tcard-url-placeholder">${t.status === 'stopped' ? '–' : t.customDomain ? `Menghubungkan ke ${esc(t.customDomain)}…` : 'Menunggu URL…'}</span>`
        }
      </div>
    </div>`;

  // URL History
  const histSection = hist.length > 1 ? (() => {
    const expanded = _histExpanded[k];
    const prev = hist.slice(0, -1).reverse();
    const items = expanded ? prev.map(u => `
      <div class="url-history-item">
        <span title="${esc(u)}">${esc(u)}</span>
        <button onclick="copyUrl('${escOnclick(u)}')" title="Salin">⎘</button>
      </div>`).join('') : '';
    return `<div class="url-history">
      <button class="url-history-toggle" onclick="toggleHistory(${kq})">
        <span>${expanded ? '▾' : '▸'}</span>
        <span>${prev.length} URL sebelumnya</span>
      </button>
      ${expanded ? `<div class="url-history-list">${items}</div>` : ''}
    </div>`;
  })() : '';

  // Action bar
  const actionsBtns = t.status === 'stopped'
    ? `<button class="tact warn"   onclick="restartTunnel(${kq})">↺ Restart</button>
       <button class="tact danger" onclick="deleteTunnel(${kq})">🗑 Hapus</button>`
    : `<button class="tact primary" onclick="showInspector(${kq})" ${t.status !== 'live' ? 'disabled' : ''}>🔍 Inspector</button>
       <button class="tact sm" onclick="setRateLimit(${kq})" title="${rl ? `🚦 ${rl.maxReq} req/s — klik untuk ubah` : 'Set rate limit'}">🚦${rl ? rl.maxReq+'/s' : ''}</button>
       <button class="tact"         onclick="stopTunnel(${kq})">■ Stop</button>
       <button class="tact danger sm" onclick="deleteTunnel(${kq})" title="Hapus">🗑</button>`;

  return `
    <div class="tcard ${t.status}">
      <div class="tcard-head">
        <span class="tcard-port">${esc(t.displayName || k)}</span>
        <div class="tcard-dot dot-${t.status}"></div>
        <span class="tcard-status ${t.status}">${statusText}</span>
        <div class="tcard-sep"></div>
        <div class="tcard-label">
          <span id="label-span-${k}" class="label-text" onclick="editLabel(${kq})" title="Klik untuk ubah nama">${labelTxt}</span>
        </div>
        <div class="tcard-chips">
          <span class="chip green" id="req-count-${k}">${reqCnt} req</span>
          <span class="chip" id="uptime-${k}">${uptime}</span>
          ${rc > 0 ? `<span class="chip warn" title="${rc}x reconnect">↻${rc}</span>` : ''}
          ${rl ? `<span class="chip warn" title="Rate limit aktif: ${rl.maxReq} req/s">🚦${rl.maxReq}/s</span>` : ''}
          <button class="btn-autostart ${t.autoStart ? 'on' : ''}"
            onclick="toggleAutoStart(${kq})"
            title="${t.autoStart ? 'Auto-start aktif' : 'Auto-start nonaktif'}">⚡</button>
        </div>
      </div>
      ${hostBadge}${namedBadge}
      ${urlBlock}
      ${histSection}
      <div class="tcard-actions">${actionsBtns}</div>
    </div>`;
}

// ═══ Utils ═════════════════════════════════════════════════════════════════════
function setErr(msg) { document.getElementById('err-msg').textContent = msg; }
function showToast() {
  const el = document.getElementById('toast');
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 1600);
}
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
/**
 * escOnclick(s) — aman untuk nilai di dalam onclick="fn('VALUE')"
 * Gabungan dua konteks:
 *   1. HTML attribute  → escape & < > "
 *   2. JS string (\'…')→ escape \ dan ' (sebagai \x27 agar HTML parser
 *      tidak decode ulang sebelum JS engine melihatnya)
 */
function escOnclick(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
    .replace(/\\/g,'\\\\').replace(/'/g,'\\x27')
    .replace(/\n/g,'\\n').replace(/\r/g,'\\r');
}
function formatUptime(s) {
  if (s < 60) return `${s}d`;
  const m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d > 0) return `${d}h ${h % 24}j`;
  if (h > 0) return `${h}j ${m % 60}m`;
  return `${m}m ${s % 60}d`;
}

init();
