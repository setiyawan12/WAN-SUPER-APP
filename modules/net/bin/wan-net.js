#!/usr/bin/env node
'use strict';

/**
 * wan-net CLI
 *
 * Usage:
 *   wan-net http <port> [port2] [port3...] [options]
 *
 * Options:
 *   --pass <password>      Protect inspector with password
 *
 * Examples:
 *   wan-net http 8000
 *   wan-net http 8000 8001 8002
 *   wan-net http 8000 --pass secret123
 */

// ── Load .wan-netrc FIRST (before env vars so CLI args can override) ──────────
const _fs = require('fs'), _path = require('path');
let _rc = {};
try {
  const _rcFile = _path.join(process.cwd(), '.wan-netrc');
  if (_fs.existsSync(_rcFile)) {
    _rc = JSON.parse(_fs.readFileSync(_rcFile, 'utf8'));
    console.log('📋 Config loaded from .wan-netrc');
  }
} catch (e) { console.warn('⚠  Could not parse .wan-netrc:', e.message); }

// ── Parse args ────────────────────────────────────────────────────────────────
const args       = process.argv.slice(2);
const subcommand = args[0];

// Collect numeric args as local ports — skip flag names and their values
const cliPorts = [];
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--')) { i++; continue; }
  if (/^\d+$/.test(a)) cliPorts.push(Number(a));
}

// CLI ports override rc ports
const localPorts = cliPorts.length > 0
  ? cliPorts
  : (Array.isArray(_rc.ports) ? _rc.ports.map(Number).filter(n => n > 0) : []);

if (subcommand !== 'http' || localPorts.length === 0) {
  console.log('');
  console.log('  ⚡ WAN NET');
  console.log('');
  console.log('  Usage:   wan-net http <port> [port2] [port3...] [options]');
  console.log('  Example: wan-net http 8000');
  console.log('  Example: wan-net http 8000 8001 8002   # multi-port tunnel');
  console.log('');
  console.log('  Options:');
  console.log('    --pass <password>    Protect inspector with password');
  console.log('');
  console.log('  Config file (.wan-netrc in current directory):');
  console.log('    { "pass": "mypassword", "ports": [8000] }');
  console.log('');
  process.exit(1);
}

function getFlag(flag, fallback) {
  const i = args.indexOf(flag);
  return (i !== -1 && args[i + 1]) ? args[i + 1] : fallback;
}

// Priority: CLI flag > .wan-netrc > default
process.env.INSPECTOR_PASS = getFlag('--pass', _rc.pass || process.env.INSPECTOR_PASS || '');

// ── Load modules ──────────────────────────────────────────────────────────────
const path = require('path');
const root  = path.join(__dirname, '..');

const state                  = require(path.join(root, 'lib/state'));
const { findFreePort }       = require(path.join(root, 'lib/utils'));
const { INSP_PASS }          = require(path.join(root, 'lib/config'));
const { createTunnelServer, attachWebSocketProxy } = require(path.join(root, 'lib/tunnel-server'));
const { createClientServer } = require(path.join(root, 'lib/client-server'));
const inspectorServer        = require(path.join(root, 'lib/inspector-server'));
const { createClient }       = require(path.join(root, 'lib/tunnel-client'));
const cloudflared            = require(path.join(root, 'lib/cloudflared'));
const persist                = require(path.join(root, 'lib/persist'));

// ── Banner ────────────────────────────────────────────────────────────────────
console.log('');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  ⚡ WAN NET  ×  Cloudflare Tunnel');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');

// ── Main ──────────────────────────────────────────────────────────────────────
const allServers = [];
const allClients = [];
const allCfProcs = [];

async function main() {
  // 1. Download cloudflared if not present
  await cloudflared.ensureCloudflared();

  // 2. Start inspector (auto port)
  const inspPort = await findFreePort(4040);
  state.INSP_PORT = inspPort;

  await new Promise(resolve => inspectorServer.listen(inspPort, resolve));
  persist.load();  // load saved requests before any client connects
  console.log(`▶  Inspector started → http://localhost:${inspPort}`);
  if (INSP_PASS) console.log(`🔒 Auth: admin / ${INSP_PASS}`);
  console.log('');

  // 3. For each local port: start tunnel server + client server + client + cloudflared
  console.log(`▶  Starting ${localPorts.length} tunnel(s)…`);
  console.log('');

  let readyCount = 0;

  for (const localPort of localPorts) {
    // Auto-detect free ports — sequential loop means prev port is already bound, no conflict
    const tunnelPort = await findFreePort(3000);
    const clientPort = await findFreePort(4040);

    // Register per-tunnel state
    state.tunnels.set(localPort, {
      clientSSE : null,
      pending   : new Map(),
      tunnelPort,
      publicUrl : null,
    });

    // Create and start servers
    const tunnelSrv = createTunnelServer(localPort);
    attachWebSocketProxy(tunnelSrv, localPort);   // WebSocket pass-through
    const clientSrv = createClientServer(localPort);
    allServers.push(tunnelSrv, clientSrv);

    await new Promise(resolve => {
      tunnelSrv.listen(tunnelPort, () => clientSrv.listen(clientPort, resolve));
    });

    // Connect tunnel client inline (no subprocess needed)
    const client = createClient();
    allClients.push(client);
    client.connect({ localPort, serverHost: 'localhost', clientPort });

    // Spawn Cloudflare Quick Tunnel for this port
    const cf = cloudflared.startTunnel(tunnelPort, url => {
      state.tunnels.get(localPort).publicUrl = url;
      readyCount++;
      console.log(`  ✅ :${localPort}  →  ${url}`);
      if (readyCount === localPorts.length) {
        console.log('');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`  🔍 Inspector : http://localhost:${inspPort}`);
        console.log('  Bagikan URL di atas — sudah HTTPS, bisa diakses siapa saja!');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('');
      }
    });
    allCfProcs.push(cf);
  }

  console.log('▶  Connecting to Cloudflare… (tunggu ~5-10 detik per tunnel)');
  console.log('');
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function cleanup() {
  console.log('\nStopping…');
  persist.saveSync();  // flush log to disk before exit
  allClients.forEach(c => c.disconnect());
  allCfProcs.forEach(p => { try { p.kill(); } catch {} });
  allServers.forEach(s => { try { s.close(); } catch {} });
  inspectorServer.close();
  process.exit(0);
}
process.on('SIGINT',  cleanup);
process.on('SIGTERM', cleanup);

main().catch(err => {
  console.error('\n✗ Error:', err.message);
  process.exit(1);
});
