'use strict';

const http           = require('http');
const state          = require('./state');
const { readBody, checkAuth, broadcast, broadcastMocks } = require('./utils');
const persist        = require('./persist');
const INSPECTOR_HTML = require('./inspector-html');

/**
 * Inspector server — auto port (8080+)
 * Serves the browser dashboard and REST endpoints used by it.
 */
const inspectorServer = http.createServer(async (req, res) => {
  if (!checkAuth(req, res)) return;

  // ── Dashboard HTML ──────────────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(INSPECTOR_HTML); return;
  }

  // ── Health check ────────────────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/health') {
    const tunnels = [...state.tunnels.entries()].map(([lp, t]) => ({
      localPort      : lp,
      tunnelPort     : t.tunnelPort,
      publicUrl      : t.publicUrl,
      connected      : !!(t.clientSSE && !t.clientSSE.writableEnded),
      pendingRequests: t.pending?.size || 0,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status   : 'ok',
      uptime   : Math.round(process.uptime()),
      startedAt: state.startedAt,
      requests : {
        total  : state.requestLog.length,
        errors : state.requestLog.filter(r => r.status >= 400).length,
        pending: state.requestLog.filter(r => r.status == null).length,
      },
      mocks: state.mocks.size,
      tunnels,
    }, null, 2)); return;
  }

  // ── Header injection rules ───────────────────────────────────────────────
  const _injectList = () =>
    [...state.headerInjections.entries()].map(([port, headers]) => ({ port, headers }));

  if (req.method === 'GET' && req.url === '/inject') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(_injectList())); return;
  }
  if (req.method === 'POST' && req.url === '/inject') {
    try {
      const { port, headers } = JSON.parse((await readBody(req)).toString());
      const key = (!port || port === '*') ? '*' : Number(port);
      if (headers && Object.keys(headers).length) state.headerInjections.set(key, headers);
      else state.headerInjections.delete(key);
      broadcast({ type: 'inject', data: _injectList() });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }
  if (req.method === 'DELETE' && req.url === '/inject') {
    try {
      const { port } = JSON.parse((await readBody(req)).toString());
      const key = (!port || port === '*') ? '*' : Number(port);
      state.headerInjections.delete(key);
      broadcast({ type: 'inject', data: _injectList() });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  // ── Full log snapshot ───────────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/log') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(state.requestLog.toArray())); return;
  }

  // ── Clear log ───────────────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/clear') {
    state.requestLog.clear();
    broadcast({ type: 'clear' });
    persist.clear();
    res.writeHead(204); res.end(); return;
  }

  // ── SSE stream for real-time updates ────────────────────────────────────
  if (req.method === 'GET' && req.url === '/stream') {
    res.writeHead(200, {
      'Content-Type'     : 'text/event-stream',
      'Cache-Control'    : 'no-cache',
      'Connection'       : 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    state.inspStreams.add(res);
    const initPayload = {
      type  : 'init',
      data  : state.requestLog.toArray(),
      mocks : [...state.mocks.entries()].map(([k, v]) => ({ key: k, ...v })),
      inject: [...state.headerInjections.entries()].map(([p, h]) => ({ port: p, headers: h })),
    };
    try { res.write(`event: msg\ndata: ${JSON.stringify(initPayload)}\n\n`); } catch {}
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20_000);
    req.on('close', () => { state.inspStreams.delete(res); clearInterval(ping); });
    return;
  }

  // ── Replay original request ─────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/replay') {
    try {
      const { id } = JSON.parse((await readBody(req)).toString());
      const entry  = state.requestLog.find(r => r.id === id);
      if (!entry) { res.writeHead(404); res.end(JSON.stringify({ ok: false, error: 'Not found' })); return; }
      const tport  = _tunnelPortFor(entry.localPort);
      await _forward(entry.method, entry.url, entry.reqHeaders, entry.reqBody || '', res, tport);
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  // ── Replay with custom edits ────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/replay-custom') {
    try {
      const { method, url, headers, bodyB64, localPort } = JSON.parse((await readBody(req)).toString());
      const rawBody = bodyB64 ? Buffer.from(bodyB64, 'base64').toString() : '';
      const tport   = _tunnelPortFor(localPort);
      await _forward(method, url, headers, rawBody, res, tport);
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  // ── Mocks: list ─────────────────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/mocks') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([...state.mocks.entries()].map(([k, v]) => ({ key: k, ...v })))); return;
  }

  // ── Mocks: create / update ──────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/mocks') {
    try {
      const { method, path, status, headers, body, name, delayMs } = JSON.parse((await readBody(req)).toString());
      const key = (method || 'GET') + ':' + (path || '/');
      state.mocks.set(key, {
        status : parseInt(status) || 200,
        headers: headers || {},
        body   : body || '',
        name   : name || key,
        delayMs: parseInt(delayMs) || 0,
      });
      broadcastMocks();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, key }));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  // ── Mocks: delete ───────────────────────────────────────────────────────
  if (req.method === 'DELETE' && req.url === '/mocks') {
    try {
      const { key } = JSON.parse((await readBody(req)).toString());
      state.mocks.delete(key);
      broadcastMocks();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  // ── Serve raw response body for preview ────────────────────────────────
  if (req.method === 'GET' && req.url.startsWith('/body/')) {
    const id    = decodeURIComponent(req.url.slice(6));
    const entry = state.requestLog.find(r => r.id === id);
    if (!entry) { res.writeHead(404); res.end(); return; }
    const ct = entry.resHeaders?.['content-type'] || 'application/octet-stream';
    if (entry.resBodyB64) {
      const buf = Buffer.from(entry.resBodyB64, 'base64');
      res.writeHead(200, { 'Content-Type': ct, 'Content-Length': buf.length,
        'X-Content-Type-Options': 'nosniff' });
      res.end(buf); return;
    }
    const body = entry.resBody || '';
    res.writeHead(200, { 'Content-Type': ct });
    res.end(body); return;
  }

  res.writeHead(404); res.end();
});

/** Get tunnel server port for a given localPort, fallback to first available. */
function _tunnelPortFor(localPort) {
  if (localPort) {
    const t = state.tunnels.get(localPort);
    if (t && t.tunnelPort) return t.tunnelPort;
  }
  // Fallback: use first tunnel
  for (const [, t] of state.tunnels) {
    if (t.tunnelPort) return t.tunnelPort;
  }
  return 3000;
}

/** Forward a request to the tunnel server and reply with {ok, status} */
function _forward(method, url, headers, bodyStr, res, tunnelPort) {
  return new Promise(resolve => {
    const rb   = bodyStr ? Buffer.from(bodyStr) : Buffer.alloc(0);
    const hdrs = { ...headers };
    delete hdrs['connection'];
    delete hdrs['content-length'];
    if (rb.length) hdrs['content-length'] = rb.length;

    const pr = http.request(
      { hostname: 'localhost', port: tunnelPort, path: url, method, headers: hdrs },
      proxyRes => {
        proxyRes.resume();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, status: proxyRes.statusCode }));
        resolve();
      },
    );
    pr.on('error', err => {
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, error: err.message }));
      resolve();
    });
    if (rb.length) pr.write(rb);
    pr.end();
  });
}

module.exports = inspectorServer;
