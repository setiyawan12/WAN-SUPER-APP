'use strict';

const http    = require('http');
const net     = require('net');
const state   = require('./state');
const { uid, sse, broadcast, readBody } = require('./utils');
const { MAX_LOG } = require('./config');
const persist = require('./persist');

/**
 * Factory — creates a tunnel server for one local port.
 * Cloudflare points here. Each incoming request is either:
 *   1. Returned immediately from a mock, or
 *   2. Forwarded to the connected tunnel client via SSE.
 */
function createTunnelServer(tunnelKey) {
  return http.createServer(async (req, res) => {
    const tunnel    = state.tunnels.get(tunnelKey) || {};
    const requestId = uid();
    const t0        = Date.now();

    // Read body with 20 MB limit
    let bodyBuf, payloadError;
    try {
      bodyBuf = await readBody(req);
    } catch (err) {
      if (err.code === 'PAYLOAD_TOO_LARGE') {
        payloadError = err;
        bodyBuf = Buffer.alloc(0);
      } else throw err;
    }

    const entry = {
      id         : requestId,
      localPort  : tunnelKey,
      time       : new Date().toISOString(),
      method     : req.method,
      url        : req.url,
      reqHeaders : req.headers,
      reqBody    : payloadError ? '[Body too large — truncated]' : bodyBuf.toString(),
      status     : null,
      resHeaders : null,
      resBody    : null,
      ms         : null,
      mocked     : false,
      size       : null,
    };

    // ── 0. Payload too large ─────────────────────────────────────────────────
    if (payloadError) {
      entry.status  = 413;
      entry.ms      = Date.now() - t0;
      entry.resBody = payloadError.message;
      _log(entry);
      res.writeHead(413, { 'Content-Type': 'text/plain' });
      res.end(payloadError.message);
      return;
    }

    // ── 1. Rate limit check (sliding window per-tunnel) ──────────────────────
    if (tunnel.rateLimit && tunnel.rateLimit.maxReq > 0) {
      const _now = Date.now();
      const _win = tunnel.rateLimit.windowMs || 1000;
      if (!tunnel.rateWindow) tunnel.rateWindow = [];
      tunnel.rateWindow = tunnel.rateWindow.filter(ts => _now - ts < _win);
      if (tunnel.rateWindow.length >= tunnel.rateLimit.maxReq) {
        entry.status  = 429;
        entry.ms      = Date.now() - t0;
        entry.resBody = 'Too Many Requests';
        _log(entry);
        res.writeHead(429, {
          'Content-Type'         : 'text/plain',
          'Retry-After'          : '1',
          'X-RateLimit-Limit'    : String(tunnel.rateLimit.maxReq),
          'X-RateLimit-Window-Ms': String(_win),
        });
        res.end('429 Too Many Requests — WAN NET rate limit active');
        return;
      }
      tunnel.rateWindow.push(_now);
    }

    // ── 2. Mock check (works even without a client) ───────────────────────────
    const urlPath = req.url.split('?')[0];
    const mock    = state.mocks.get(req.method + ':' + req.url)
                 || state.mocks.get(req.method + ':' + urlPath);

    if (mock) {
      const mockBodyBuf = Buffer.from(mock.body || '');
      const mockHeaders = Object.assign(
        { 'content-type': 'application/json' },
        mock.headers,
        { 'x-mocked-by': 'WAN NET', 'content-length': String(mockBodyBuf.length) },
      );
      entry.status     = mock.status;
      entry.resHeaders = mockHeaders;
      entry.resBody    = mock.body || '';
      entry.mocked     = true;
      entry.size       = mockBodyBuf.length;
      const _sendMock = () => {
        entry.ms = Date.now() - t0;
        _log(entry);
        res.writeHead(mock.status, mockHeaders);
        res.end(mockBodyBuf);
      };
      if (mock.delayMs > 0) setTimeout(_sendMock, mock.delayMs);
      else _sendMock();
      return;
    }

    // ── 2. No client connected ────────────────────────────────────────────────
    if (!tunnel.clientSSE || tunnel.clientSSE.writableEnded) {
      res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><body style="font-family:monospace;background:#0a0b14;color:#e0e0f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
        <div style="text-align:center">
          <div style="font-size:48px;margin-bottom:16px">⚡</div>
          <h2 style="color:#f43f5e;margin-bottom:8px">502 — No Tunnel Connected</h2>
          <p style="color:#888">Tunnel: <code style="background:#1a1a2e;padding:4px 10px;border-radius:6px;color:#818cf8">${tunnelKey}</code></p>
        </div>
      </body></html>`);
      return;
    }

    // ── 3. Forward to tunnel client via SSE ───────────────────────────────────
    // Apply header injection rules (global '*' merged with per-port rules)
    const _injGlobal = state.headerInjections.get('*') || {};
    const _injPort   = state.headerInjections.get(tunnelKey) || {};
    const _headers   = Object.keys(_injGlobal).length || Object.keys(_injPort).length
      ? { ...req.headers, ..._injGlobal, ..._injPort }
      : req.headers;

    sse(tunnel.clientSSE, 'request', {
      requestId,
      method : req.method,
      url    : req.url,
      headers: _headers,
      body   : bodyBuf.toString('base64'),
    });

    // Binary bodies are capped at 256 KB to prevent memory bloat.
    // Larger binaries are dropped (entry.resBodyB64 = null, entry.resBinary = true).
    const MAX_BINARY_BODY = 256 * 1024; // 256 KB binary ≈ 341 KB base64

    let done = false;

    const _cleanup = () => {
      tunnel.pending.delete(requestId);
    };

    tunnel.pending.set(requestId, (msg) => {
      if (done) return;
      done = true;
      _cleanup();
      const rb   = Buffer.from(msg.body || '', 'base64');
      const _ct  = (msg.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
      const _bin = /^image\/|^application\/octet|^application\/pdf|^audio\/|^video\//.test(_ct);
      entry.status     = msg.status;
      entry.resHeaders = msg.headers;
      entry.resBody    = _bin ? '' : rb.toString();
      // Only keep binary payload if it fits under the cap; otherwise drop to save RAM.
      entry.resBodyB64 = (_bin && rb.length <= MAX_BINARY_BODY) ? rb.toString('base64') : null;
      entry.resBinary  = _bin;
      entry.ms         = Date.now() - t0;
      entry.size       = rb.length;
      _log(entry);
      const h = { ...msg.headers };
      delete h['transfer-encoding'];
      delete h['content-encoding'];
      h['content-length'] = rb.length;
      res.writeHead(msg.status, h);
      res.end(rb);
    });

    // Clean up pending if the upstream client disconnects before response arrives
    res.on('close', () => {
      if (!done) {
        done = true;
        _cleanup();
        entry.status = 0;   // 0 = aborted / no response
        entry.ms     = Date.now() - t0;
        _log(entry);
      }
    });

    // Timeout after 30 s
    setTimeout(() => {
      if (!done) {
        done = true;
        _cleanup();
        entry.status = 504;
        entry.ms     = Date.now() - t0;
        _log(entry);
        try { res.writeHead(504); res.end('Gateway Timeout'); } catch {}
      }
    }, 30_000);
  });
}

/**
 * Attach WebSocket upgrade handler to an existing tunnel server instance.
 * Proxies WS connections directly to localhost:localPort via raw TCP.
 */
function attachWebSocketProxy(server, tunnelKey, localPort) {
  server.on('upgrade', (req, socket, head) => {
    // Log WS upgrade as a special entry
    _log({
      id        : require('./utils').uid(),
      localPort : tunnelKey,
      time      : new Date().toISOString(),
      method    : 'WS',
      url       : req.url,
      reqHeaders: req.headers,
      status    : 101,
      resHeaders: null,
      resBody   : null,
      ms        : 0,
      mocked    : false,
      size      : 0,
    });

    const rawHdrs = Object.entries(req.headers)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
      .join('\r\n');
    const httpUpgrade = `${req.method} ${req.url} HTTP/1.1\r\n${rawHdrs}\r\n\r\n`;

    const proxy = net.createConnection(localPort, 'localhost');
    proxy.once('connect', () => {
      proxy.write(httpUpgrade);
      if (head && head.length) proxy.write(head);
      socket.pipe(proxy);
      proxy.pipe(socket);
    });
    proxy.on('error', () => { try { socket.destroy(); } catch {} });
    socket.on('error', () => { try { proxy.destroy(); } catch {} });
    socket.on('close', () => { try { proxy.destroy(); } catch {} });
    proxy.on('close', () => { try { socket.destroy(); } catch {} });
  });
}

/** Push entry to log, broadcast to inspector, schedule disk save */
function _log(entry) {
  state.requestLog.push(entry);   // RingLog: O(1), auto-evicts oldest
  broadcast({ type: 'req', data: entry });
  persist.scheduleSave();
}

module.exports = { createTunnelServer, attachWebSocketProxy };
