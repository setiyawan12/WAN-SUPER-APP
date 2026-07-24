'use strict';

const http  = require('http');
const state = require('./state');
const { sse, readBody } = require('./utils');

/**
 * Factory — creates a client server for one local port.
 *
 * GET  /connect  → SSE stream; tunnel client holds this open
 * POST /response → tunnel client posts the proxied response back here
 */
function createClientServer(tunnelKey) {
  return http.createServer(async (req, res) => {
    const tunnel = state.tunnels.get(tunnelKey);
    if (!tunnel) { res.writeHead(500); res.end('Unknown tunnel'); return; }

    // ── Tunnel client connects ────────────────────────────────────────────────
    if (req.method === 'GET' && req.url === '/connect') {
      res.writeHead(200, {
        'Content-Type'     : 'text/event-stream',
        'Cache-Control'    : 'no-cache',
        'Connection'       : 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      tunnel.clientSSE = res;
      console.log(`✓ Client connected → ${tunnelKey}`);
      sse(res, 'connected', {
        tunnelPort  : tunnel.tunnelPort,
        inspectorUrl: `http://localhost:${state.INSP_PORT}`,
      });
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20_000);
      req.on('close', () => {
        if (tunnel.clientSSE === res) tunnel.clientSSE = null;
        clearInterval(ping);
        console.log(`✗ Client disconnected → ${tunnelKey}`);
      });
      return;
    }

    // ── Tunnel client posts response back ─────────────────────────────────────
    if (req.method === 'POST' && req.url === '/response') {
      try {
        const msg = JSON.parse((await readBody(req)).toString());
        const cb  = tunnel.pending.get(msg.requestId);
        if (cb) { cb(msg); tunnel.pending.delete(msg.requestId); }
      } catch {}
      res.writeHead(204); res.end();
      return;
    }

    res.writeHead(404); res.end();
  });
}

module.exports = { createClientServer };
