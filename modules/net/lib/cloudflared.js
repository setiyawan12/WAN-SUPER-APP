'use strict';

/**
 * cloudflared helper — download binary if missing, start Quick Tunnel.
 */

const { spawn }  = require('child_process');
const path       = require('path');
const fs         = require('fs');
const https      = require('https');

const BIN_NAME = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';

// In a packaged Electron app, extra resources are in process.resourcesPath.
// In dev (electron .) or CLI, app.isPackaged is false/undefined — use project root.
function _binDir() {
  if (typeof process.resourcesPath === 'string') {
    try {
      const { app } = require('electron');
      if (app && app.isPackaged) return process.resourcesPath;
    } catch {}
  }
  return path.join(__dirname, '..');
}
const BIN_DIR  = _binDir();
const BIN_PATH = path.join(BIN_DIR, BIN_NAME);

/** Return the correct GitHub release download URL for this OS/arch. */
function _downloadURL() {
  const { platform, arch } = process;
  if (platform === 'darwin') {
    return arch === 'arm64'
      ? 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz'
      : 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz';
  }
  if (platform === 'linux') {
    return (arch === 'arm64' || arch === 'aarch64')
      ? 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64'
      : 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';
  }
  if (platform === 'win32') {
    return 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
  }
  throw new Error(`Unsupported platform: ${platform}`);
}

/** Download a file via HTTPS, following redirects. */
function _downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = u => {
      https.get(u, res => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          follow(res.headers.location); return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${u}`)); return;
        }
        const f = fs.createWriteStream(dest);
        res.pipe(f);
        f.on('finish', () => f.close(resolve));
        f.on('error',  reject);
      }).on('error', reject);
    };
    follow(url);
  });
}

/**
 * Ensure the cloudflared binary exists.
 * Downloads and extracts it if not present.
 */
async function ensureCloudflared() {
  if (fs.existsSync(BIN_PATH)) return;

  process.stdout.write('📥 Downloading cloudflared (sekali saja)… ');
  const url = _downloadURL();

  if (url.endsWith('.tgz')) {
    const tgzPath = BIN_PATH + '.tgz';
    await _downloadFile(url, tgzPath);
    // Extract using system tar (available on macOS & Linux)
    await new Promise((resolve, reject) => {
      const tar = spawn('tar', ['xz', '-C', BIN_DIR, '-f', tgzPath]);
      tar.on('close', code => {
        try { fs.unlinkSync(tgzPath); } catch {}
        code === 0 ? resolve() : reject(new Error('tar extraction failed'));
      });
      tar.on('error', reject);
    });
  } else {
    await _downloadFile(url, BIN_PATH);
  }

  fs.chmodSync(BIN_PATH, 0o755);
  console.log('✓');
}

/**
 * Spawn cloudflared Quick Tunnel.
 * Calls onURL(url) when the public URL is ready.
 * Returns the child process.
 */
function startTunnel(tunnelPort, onURL) {
  const cf = spawn(BIN_PATH, [
    'tunnel', '--url', `http://localhost:${tunnelPort}`, '--no-autoupdate',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let capturedURL = null;
  let urlReported = false;

  cf.stderr.on('data', data => {
    if (urlReported) return;
    const text = data.toString();

    // Capture URL as soon as it appears in stderr
    if (!capturedURL) {
      const match = text.match(/https:\/\/[a-zA-Z0-9._-]+\.trycloudflare\.com/);
      if (match) capturedURL = match[0];
    }

    // Only report after tunnel connection is actually established
    if (capturedURL && (
      text.includes('Registered tunnel connection') ||
      text.includes('Connection registered') ||
      text.includes('Registered new connection') ||
      text.includes('conns=1')
    )) {
      urlReported = true;
      onURL(capturedURL);
    }
  });

  cf.on('error', err => console.error('\n cloudflared error:', err.message));
  return cf;
}

// ── Cloudflare Login & Named Tunnel ──────────────────────────────────────────

const os     = require('os');
const CF_DIR  = path.join(os.homedir(), '.cloudflared');
const CF_CERT = path.join(CF_DIR, 'cert.pem');

/** Returns true if user is logged in (cert.pem exists). */
function checkLoginStatus() {
  return fs.existsSync(CF_CERT);
}

/**
 * List named tunnels via `cloudflared tunnel list --output json`.
 * Returns array of { id, name, createdAt, ... } or [].
 */
function listTunnels(env) {
  return new Promise(resolve => {
    const proc = spawn(BIN_PATH, ['tunnel', 'list', '--output', 'json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(env ? { env } : {}),
    });
    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.on('close', () => {
      try {
        const data = JSON.parse(out);
        resolve(Array.isArray(data) ? data : []);
      } catch { resolve([]); }
    });
    proc.on('error', () => resolve([]));
  });
}

/**
 * Start a named tunnel with a fixed hostname.
 * Writes a temp YAML config and runs `cloudflared tunnel run`.
 * Calls onURL(url) when connection is established (url = https://hostname).
 * Returns the child process.
 */
function startNamedTunnel(tunnelId, localPort, hostname, onURL, env) {
  const credFile   = path.join(CF_DIR, `${tunnelId}.json`);
  const configPath = path.join(os.tmpdir(), `wan-net-named-${localPort}.yml`);

  fs.writeFileSync(configPath, [
    `tunnel: ${tunnelId}`,
    `credentials-file: ${credFile}`,
    `ingress:`,
    `  - hostname: ${hostname}`,
    `    service: http://localhost:${localPort}`,
    `  - service: http_status:404`,
    '',
  ].join('\n'), 'utf8');

  const cf = spawn(BIN_PATH, [
    'tunnel', '--no-autoupdate', '--config', configPath, 'run',
  ], { stdio: ['ignore', 'ignore', 'pipe'], ...(env ? { env } : {}) });

  let urlReported = false;
  cf.stderr.on('data', data => {
    if (urlReported) return;
    const txt = data.toString();
    // Detect when tunnel is fully connected
    if (txt.includes('Registered tunnel connection') ||
        txt.includes('Connection registered') ||
        txt.includes('conns=1') ||
        txt.includes('Registered new connection')) {
      urlReported = true;
      onURL(`https://${hostname}`);
    }
  });

  cf.on('error', err => console.error('cloudflared named error:', err.message));
  return cf;
}

/**
 * Create a new named tunnel.
 * Returns { ok: true, id, name } or { ok: false, error }.
 */
function createTunnel(name, env) {
  return new Promise((resolve) => {
    const proc = spawn(BIN_PATH, ['tunnel', 'create', name], {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(env ? { env } : {}),
    });
    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { out += d.toString(); });
    proc.on('close', code => {
      const m = out.match(/Created tunnel .+ with id ([a-f0-9-]{36})/i);
      if (m) resolve({ ok: true, id: m[1], name });
      else   resolve({ ok: false, error: out.trim() || `Exit code ${code}` });
    });
    proc.on('error', e => resolve({ ok: false, error: e.message }));
  });
}

/**
 * Add a DNS CNAME route for a named tunnel.
 * Returns { ok: bool, output }.
 */
function addDNSRoute(tunnelName, hostname, env) {
  return new Promise((resolve) => {
    const proc = spawn(BIN_PATH, ['tunnel', 'route', 'dns', tunnelName, hostname], {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(env ? { env } : {}),
    });
    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { out += d.toString(); });
    proc.on('close', code => {
      resolve({ ok: code === 0, output: out.trim() });
    });
    proc.on('error', e => resolve({ ok: false, error: e.message }));
  });
}

/**
 * Delete a named tunnel (force). Returns { ok, output }.
 */
function deleteTunnel(name, env) {
  return new Promise(resolve => {
    const proc = spawn(BIN_PATH, ['tunnel', 'delete', '-f', name], {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(env ? { env } : {}),
    });
    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { out += d.toString(); });
    proc.on('close', code => resolve({ ok: code === 0, output: out.trim() }));
    proc.on('error', e => resolve({ ok: false, error: e.message }));
  });
}

module.exports = { ensureCloudflared, startTunnel, BIN_PATH, checkLoginStatus, listTunnels, startNamedTunnel, createTunnel, addDNSRoute, deleteTunnel };
