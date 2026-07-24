'use strict';

/**
 * electron/cf-manager.js — Cloudflare IPC handlers
 *
 * Extracted from main.js for maintainability.
 * Call registerCFHandlers(ipcMain, ctx) once at startup.
 *
 * ctx = {
 *   getCfg()         → current config object (mutable)
 *   saveCfg()        → persist current config to disk
 *   cfEnv()          → env vars with CF credentials injected
 *   getLauncherWin() → current BrowserWindow (or null)
 *   startTunnel      → async (localPort, opts) → {ok}
 *   stopTunnel       → (tunnelKey) → {ok}
 *   pushUpdate       → ()
 *   cloudflared      → lib/cloudflared module
 * }
 */
module.exports = function registerCFHandlers(ipcMain, _ctx) {
  // ── Aliases ─────────────────────────────────────────────────────────────────
  const _c              = () => _ctx.getCfg();          // current config (mutable ref)
  const _saveCfg        = () => _ctx.saveCfg();         // persist config
  const _cfEnv          = () => _ctx.cfEnv();           // env vars with CF credentials
  const _getLauncherWin = () => _ctx.getLauncherWin();  // launcher BrowserWindow
  const _cloudflared    = _ctx.cloudflared;

  const https = require('https');
  const path  = require('path');
  const fs    = require('fs');
  const os    = require('os');
  const { BrowserWindow, session } = require('electron');

  let _loginProc    = null;
  let _loginAuthWin = null;

// ── Cloudflare Login IPC ──────────────────────────────────────────────────────

ipcMain.handle('cf:login-status', () => ({
  loggedIn: _cloudflared.checkLoginStatus() || !!(_c().cfApiToken && _c().cfAccountId),
  mode: _c().cfLoginMode || 'sso',
}));

ipcMain.handle('cf:logout', () => {
  const certPath = path.join(os.homedir(), '.cloudflared', 'cert.pem');
  try {
    if (fs.existsSync(certPath)) fs.unlinkSync(certPath);
    // Hapus login mode, tapi cfApiToken & cfZoneId tetap tersimpan
    _c().cfLoginMode  = null;
    _c().cfAccountId  = null;
    _saveCfg();
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Login via API Token — tanpa cert.pem, gunakan CLOUDFLARE_API_TOKEN env var
ipcMain.handle('cf:login-api-token', async (_e, { token, accountId }) => {
  if (!token || !accountId) return { ok: false, error: 'Token dan Account ID wajib diisi' };
  // Verifikasi token ke CF API
  try {
    const res = await _cfApiRequest(token, '/user/tokens/verify');
    if (!res.success) return { ok: false, error: res.errors?.[0]?.message || 'Token tidak valid' };
  } catch (e) { return { ok: false, error: e.message }; }

  _c().cfApiToken   = token;
  _c().cfAccountId  = accountId;
  _c().cfLoginMode  = 'api-token';
  _saveCfg();
  return { ok: true };
});

ipcMain.handle('cf:login-cancel', () => {
  if (_loginProc)    { try { _loginProc.kill(); }       catch {} _loginProc    = null; }
  if (_loginAuthWin) { try { _loginAuthWin.destroy(); } catch {} _loginAuthWin = null; }
  // Clear ephemeral session agar next login selalu fresh
  try {
    /* session imported at module top */
    session.fromPartition('cf-login-tmp').clearStorageData().catch(() => {});
  } catch {}
  return { ok: true };
});

ipcMain.handle('cf:login', () => new Promise((resolve) => {
  const certPath = path.join(os.homedir(), '.cloudflared', 'cert.pem');
  if (fs.existsSync(certPath)) { resolve({ ok: true }); return; }

  const { spawn: _spawn } = require('child_process');

  // Buat fake browser opener agar cloudflared tidak buka browser sendiri.
  // cloudflared memanggil `open` (macOS) / `xdg-open` (Linux) dari PATH.
  // Kita buat skrip kosong di tmpdir dan inject ke depan PATH.
  let fakeBinDir = null;
  try {
    fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wan-net-login-'));
    const names = process.platform === 'linux' ? ['xdg-open', 'x-www-browser', 'sensible-browser'] : ['open'];
    for (const name of names) {
      const p = path.join(fakeBinDir, name);
      fs.writeFileSync(p, '#!/bin/sh\nexit 0\n', 'utf8');
      fs.chmodSync(p, 0o755);
    }
  } catch {}

  const injectedPath = fakeBinDir
    ? `${fakeBinDir}:${process.env.PATH || ''}`
    : process.env.PATH;

  const proc = _spawn(_cloudflared.BIN_PATH, ['tunnel', 'login'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: injectedPath },
  });
  _loginProc = proc;

  // Cleanup fake bin dir saat proses selesai
  proc.on('close', () => {
    if (fakeBinDir) try { fs.rmSync(fakeBinDir, { recursive: true, force: true }); } catch {}
  });

  let resolved  = false;
  let pollTimer = null;

  const done = (ok, error) => {
    if (resolved) return;
    resolved = true;
    clearInterval(pollTimer);
    clearTimeout(loginTimeout);
    try { proc.kill(); } catch {}
    _loginProc = null;
    if (_loginAuthWin && !_loginAuthWin.isDestroyed()) {
      _loginAuthWin.destroy();
      _loginAuthWin = null;
    }
    if (ok) {
      _c().cfLoginMode = 'sso';
      _saveCfg();
    }
    resolve(ok ? { ok: true } : { ok: false, error });
  };

  // Poll cert.pem setiap 500ms — cloudflared tulis file ini setelah user authorize
  pollTimer = setInterval(() => {
    if (fs.existsSync(certPath)) done(true);
  }, 500);

  // Timeout 5 menit
  const loginTimeout = setTimeout(() => done(false, 'Timeout: login tidak selesai dalam 5 menit'), 5 * 60 * 1000);

  // Buka URL di embedded BrowserWindow (bukan browser external)
  const onData = text => {
    if (_loginAuthWin) return; // sudah dibuka
    const m = text.match(/https:\/\/dash\.cloudflare\.com\/argotunnel[^\s]*/);
    if (!m) return;

    const authURL = m[0];

    // Tampilkan loading window dengan instruksi sebelum buka CF
    _loginAuthWin = new BrowserWindow({
      width          : 560,
      height         : 720,
      title          : 'Authorize Cloudflare Tunnel',
      parent         : _getLauncherWin(),
      modal          : true,
      resizable      : false,
      minimizable    : false,
      maximizable    : false,
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      webPreferences : {
        nodeIntegration  : false,
        contextIsolation : true,
        // Pakai ephemeral session (tanpa persist) agar flow authorize selalu fresh
        partition        : 'cf-login-tmp',
      },
    });

    _loginAuthWin.setMenuBarVisibility(false);

    // Tampilkan halaman instruksi dulu, lalu navigate ke CF
    _loginAuthWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
      <!DOCTYPE html><html><head><meta charset="UTF-8">
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: system-ui, sans-serif; background: #f9fafb;
               display: flex; flex-direction: column; align-items: center;
               justify-content: center; height: 100vh; gap: 16px; padding: 32px; text-align: center; }
        .icon { font-size: 48px; }
        h2 { font-size: 18px; font-weight: 700; color: #111; }
        p  { font-size: 13px; color: #555; line-height: 1.6; max-width: 380px; }
        .step { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px;
                padding: 12px 16px; font-size: 12px; color: #333; text-align: left;
                width: 100%; max-width: 400px; }
        .step b { color: #f6821f; }
        .loader { width: 32px; height: 32px; border: 3px solid #e5e7eb;
                  border-top-color: #f6821f; border-radius: 50%;
                  animation: spin 0.8s linear infinite; margin-top: 8px; }
        @keyframes spin { to { transform: rotate(360deg); } }
      </style></head><body>
        <div class="icon">🔐</div>
        <h2>Authorize Cloudflare Tunnel</h2>
        <p>Sedang memuat halaman Cloudflare...<br>Pilih domain yang ingin digunakan untuk tunnel.</p>
        <div class="step">
          1. Login ke akun Cloudflare kamu<br>
          2. <b>Klik domain</b> yang ingin dipakai (contoh: setiyawan.online)<br>
          3. Window ini akan otomatis tertutup setelah authorize
        </div>
        <div class="loader"></div>
      </body></html>
    `));

    // Setelah 1.5 detik tampilkan loading, langsung navigate ke CF authorize URL
    setTimeout(() => {
      if (_loginAuthWin && !_loginAuthWin.isDestroyed()) {
        _loginAuthWin.loadURL(authURL);
      }
    }, 1500);

    // Pantau navigasi — kalau landing di dashboard home setelah OAuth,
    // redirect balik ke argotunnel URL agar zone selector tampil
    let _autoRedirects = 0;
    _loginAuthWin.webContents.on('did-navigate', (_, url) => {
      if (resolved || _autoRedirects >= 3) return;
      try {
        const u = new URL(url);
        const isDashHome = u.hostname === 'dash.cloudflare.com' &&
          !u.pathname.includes('argotunnel') &&
          !u.pathname.includes('login') &&
          (u.pathname === '/' || u.pathname === '' || /^\/[a-f0-9]{32}\/?$/.test(u.pathname));
        if (isDashHome) {
          _autoRedirects++;
          setTimeout(() => {
            if (_loginAuthWin && !_loginAuthWin.isDestroyed()) {
              _loginAuthWin.loadURL(authURL);
            }
          }, 600);
        }
      } catch {}
    });

    // User tutup window = cancel
    _loginAuthWin.on('closed', () => {
      _loginAuthWin = null;
      if (!resolved) done(false, 'Login dibatalkan');
    });
  };

  proc.stdout.on('data', d => onData(d.toString()));
  proc.stderr.on('data', d => onData(d.toString()));
  proc.on('close', () => {
    if (fs.existsSync(certPath)) done(true);
    else done(false, 'Login gagal atau dibatalkan');
  });
  proc.on('error', err => done(false, err.message));
}));

ipcMain.handle('cf:tunnel-list', async () => {
  try {
    // Jika API token mode: gunakan CF REST API langsung (lebih reliable, tidak butuh cert.pem)
    if (_c().cfApiToken && _c().cfAccountId) {
      const res = await _cfApiRequest(
        _c().cfApiToken,
        `/accounts/${_c().cfAccountId}/cfd_tunnel?is_deleted=false&per_page=100`
      );
      const tunnels = (res.result || []).map(t => ({
        id: t.id, name: t.name, createdAt: t.created_at,
        status: t.status, connections: t.connections,
      }));
      return { ok: true, tunnels };
    }
    // Fallback: cloudflared CLI (SSO mode, cert.pem)
    const tunnels = await _cloudflared.listTunnels(_cfEnv());
    return { ok: true, tunnels };
  } catch (e) {
    return { ok: false, tunnels: [], error: e.message };
  }
});

ipcMain.handle('cf:create-tunnel', async (_e, name) => {
  // API token mode: gunakan REST API agar tidak butuh cert.pem
  if (_c().cfApiToken && _c().cfAccountId) {
    try {
      // Generate 32-byte random tunnel secret
      const secret = require('crypto').randomBytes(32).toString('base64');
      const res = await _cfApiRequest(
        _c().cfApiToken,
        `/accounts/${_c().cfAccountId}/cfd_tunnel`,
        'POST',
        { name, tunnel_secret: secret }
      );
      if (!res.success) {
        console.error('[cf:create-tunnel] CF API error:', JSON.stringify(res.errors));
        console.error('[cf:create-tunnel] accountId:', _c().cfAccountId?.slice(0,8) + '…');
        console.error('[cf:create-tunnel] token prefix:', _c().cfApiToken?.slice(0,10) + '…');
        console.error('[cf:create-tunnel] cfLoginMode:', _c().cfLoginMode);
        const msg = res.errors?.[0]?.message || JSON.stringify(res.errors);
        return { ok: false, error: msg };
      }
      const t = res.result;
      // Tulis credentials file agar cloudflared bisa run tunnel ini
      const cfDir = path.join(os.homedir(), '.cloudflared');
      if (!fs.existsSync(cfDir)) fs.mkdirSync(cfDir, { recursive: true });
      const credFile = path.join(cfDir, `${t.id}.json`);
      fs.writeFileSync(credFile, JSON.stringify({
        AccountTag  : _c().cfAccountId,
        TunnelSecret: secret,
        TunnelID    : t.id,
      }), 'utf8');
      return { ok: true, id: t.id, name: t.name };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  // SSO fallback: pakai cloudflared CLI (butuh cert.pem)
  try { return await _cloudflared.createTunnel(name, _cfEnv()); }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('cf:add-dns-route', async (_e, tunnelName, hostname) => {
  try { return await _cloudflared.addDNSRoute(tunnelName, hostname, _cfEnv()); }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('cf:delete-domain', (_e, port) => {
  const lp = Number(port);
  if (_c().domains) delete _c().domains[lp];
  const t = _tunnelMap.get(lp);
  if (t) { t.customDomain = null; t.tunnelId = null; }
  _saveCfg();
  _ctx.pushUpdate();
  return { ok: true };
});

// ── Route management ──────────────────────────────────────────────────────────
ipcMain.handle('cf:get-routes', () => _c().routes || []);

ipcMain.handle('cf:add-route', async (_e, { tunnelId, tunnelName, hostname, port }) => {
  // Add DNS CNAME via cloudflared
  const dns = await _cloudflared.addDNSRoute(tunnelName, hostname, _cfEnv());
  if (!dns.ok && !dns.output?.includes('already exists')) {
    return { ok: false, error: dns.output || dns.error || 'Gagal tambah DNS' };
  }
  // Store in config (upsert by hostname)
  if (!_c().routes) _c().routes = [];
  _c().routes = _c().routes.filter(r => r.hostname !== hostname);
  _c().routes.push({ tunnelId, tunnelName, hostname, port: Number(port) });
  _saveCfg();
  return { ok: true };
});

ipcMain.handle('cf:remove-route', (_e, hostname) => {
  if (_c().routes) _c().routes = _c().routes.filter(r => r.hostname !== hostname);
  _saveCfg();
  // Note: DNS record remains in Cloudflare — user should delete from CF Dashboard
  return { ok: true };
});

ipcMain.handle('cf:delete-tunnel-named', async (_e, name) => {
  try {
    // API token mode: REST API (tidak butuh cert.pem)
    if (_c().cfApiToken && _c().cfAccountId) {
      // Cari tunnel ID dari nama
      const listRes = await _cfApiRequest(
        _c().cfApiToken,
        `/accounts/${_c().cfAccountId}/cfd_tunnel?name=${encodeURIComponent(name)}&per_page=10`
      );
      const tunnel = (listRes.result || []).find(t => t.name === name);
      if (!tunnel) return { ok: false, error: `Tunnel "${name}" tidak ditemukan` };

      // Delete via REST API
      const delRes = await _cfApiRequest(
        _c().cfApiToken,
        `/accounts/${_c().cfAccountId}/cfd_tunnel/${tunnel.id}`,
        'DELETE'
      );
      if (!delRes.success) {
        return { ok: false, error: delRes.errors?.[0]?.message || 'Gagal hapus tunnel' };
      }
      // Hapus credentials file lokal
      const credFile = path.join(os.homedir(), '.cloudflared', `${tunnel.id}.json`);
      try { if (fs.existsSync(credFile)) fs.unlinkSync(credFile); } catch {}
    } else {
      // SSO fallback
      const res = await _cloudflared.deleteTunnel(name, _cfEnv());
      if (!res.ok) return res;
    }
    if (_c().routes) _c().routes = _c().routes.filter(r => r.tunnelName !== name);
    _saveCfg();
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Cloudflare API helpers ────────────────────────────────────────────────────
/* https imported at module top */

function _cfApiRequest(token, reqPath, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.cloudflare.com',
      path: `/client/v4${reqPath}`,
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const req = https.request(options, res => {
      let out = '';
      res.on('data', d => { out += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(out)); }
        catch { resolve({ success: false, errors: [{ message: 'Invalid JSON' }] }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

ipcMain.handle('cf:get-api-config', () => ({
  token:     _c().cfApiToken   || '',
  zoneId:    _c().cfZoneId     || '',
  accountId: _c().cfAccountId  || '',
}));

ipcMain.handle('cf:save-api-config', (_e, { token, zoneId, accountId }) => {
  _c().cfApiToken  = token;
  _c().cfZoneId    = zoneId;
  if (accountId) {
    _c().cfAccountId  = accountId;
    _c().cfLoginMode  = 'api-token';
  }
  _saveCfg();
  return { ok: true };
});

ipcMain.handle('cf:list-dns-records', async () => {
  const { cfApiToken, cfZoneId } = _c();
  if (!cfApiToken || !cfZoneId) return { ok: false, needsSetup: true };
  try {
    const res = await _cfApiRequest(cfApiToken, `/zones/${cfZoneId}/dns_records?type=CNAME&per_page=200`);
    if (!res.success) return { ok: false, error: res.errors?.[0]?.message || 'API error' };
    return { ok: true, records: res.result };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('cf:add-cname', async (_e, { name, tunnelId, port }) => {
  const { cfApiToken, cfZoneId } = _c();
  if (!cfApiToken || !cfZoneId) return { ok: false, needsSetup: true };
  try {
    const content = `${tunnelId}.cfargotunnel.com`;
    const res = await _cfApiRequest(cfApiToken, `/zones/${cfZoneId}/dns_records`, 'POST', {
      type: 'CNAME', name, content, proxied: true, ttl: 1,
      comment: 'Added by WAN NET',
    });
    if (!res.success) return { ok: false, error: res.errors?.[0]?.message || 'Failed' };
    // Also save to local routes
    if (port && res.result) {
      if (!_c().routes) _c().routes = [];
      const tunnelInfo = (await _cloudflared.listTunnels()).find(t => t.id === tunnelId);
      const tunnelName = tunnelInfo?.name || tunnelId;
      _c().routes = _c().routes.filter(r => r.hostname !== name);
      _c().routes.push({ tunnelId, tunnelName, hostname: name, port: Number(port) });
      _saveCfg();
    }
    return { ok: true, record: res.result };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('cf:delete-cname', async (_e, { recordId, hostname }) => {
  const { cfApiToken, cfZoneId } = _c();
  if (!cfApiToken || !cfZoneId) return { ok: false, needsSetup: true };
  try {
    const res = await _cfApiRequest(cfApiToken, `/zones/${cfZoneId}/dns_records/${recordId}`, 'DELETE');
    if (!res.success) return { ok: false, error: res.errors?.[0]?.message || 'Failed' };
    // Remove from local routes too
    if (hostname && _c().routes) {
      _c().routes = _c().routes.filter(r => r.hostname !== hostname);
      _saveCfg();
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

};
