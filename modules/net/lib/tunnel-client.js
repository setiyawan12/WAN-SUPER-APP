'use strict';

/**
 * Tunnel client — instance factory.
 * Call createClient() to get an independent { connect, disconnect } instance.
 * Multiple instances can run simultaneously for multi-port tunnels.
 */

const http = require('http');

/**
 * Create a new independent tunnel client instance.
 * @returns {{ connect: Function, disconnect: Function }}
 */
function createClient() {
  let _active     = false;
  let _retryTimer = null;
  let _retryDelay = 1000;        // current backoff delay (ms)
  let _attempt    = 0;
  const _MAX_DELAY = 30_000;     // cap at 30 s

  /** Start connecting to the tunnel server. Auto-reconnects on disconnect. */
  function connect({ localPort, serverHost = 'localhost', clientPort = 4040, staticHost = null, onConnected } = {}) {
    _active     = true;
    _retryDelay = 1000;
    _attempt    = 0;
    _doConnect({ localPort, serverHost, clientPort, staticHost, onConnected });
  }

  /** Stop reconnecting and cancel any pending retry. */
  function disconnect() {
    _active = false;
    clearTimeout(_retryTimer);
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  function _doConnect(opts) {
    if (!_active) return;
    const { serverHost, clientPort } = opts;

    const req = http.request({
      hostname: serverHost, port: clientPort,
      path: '/connect', method: 'GET',
      headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' },
    }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        _retry(opts); return;
      }
      // Successful connection — reset backoff
      _retryDelay = 1000;
      _attempt    = 0;

      let buf = '', evt = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (line.startsWith('event: '))     evt = line.slice(7).trim();
          else if (line.startsWith('data: ')) {
            try { _handleEvent(evt, JSON.parse(line.slice(6)), opts); } catch {}
            evt = '';
          }
        }
      });
      res.on('end',   () => {
        if (_active) console.log(`  ↩  ${opts.staticHost || (':' + opts.localPort)} tunnel disconnected — reconnecting…`);
        _retry(opts);
      });
      res.on('error', () => _retry(opts));
    });

    req.on('error', () => _retry(opts));
    req.end();
  }

  function _retry(opts) {
    if (!_active) return;
    _attempt++;
    const delay = _retryDelay;
    _retryDelay = Math.min(_retryDelay * 2, _MAX_DELAY);
    if (_attempt > 1) {
      console.log(`  ↻  ${opts.staticHost || (':' + opts.localPort)} retry #${_attempt} in ${Math.round(delay / 1000)}s…`);
    }
    _retryTimer = setTimeout(() => _doConnect(opts), delay);
  }

  function _handleEvent(evt, data, opts) {
    if (evt === 'connected' && opts.onConnected) opts.onConnected(data);
    if (evt === 'request')  _forward(data, opts);
  }

  function _forward(msg, { localPort, serverHost, clientPort, staticHost }) {
    const body = Buffer.from(msg.body || '', 'base64');

    // Determine target: static host (e.g. setiyawan.test[:port]) or localhost:localPort
    let targetHost, targetPort, hostHeader;
    if (staticHost) {
      const colonIdx = staticHost.lastIndexOf(':');
      targetHost  = colonIdx > 0 ? staticHost.slice(0, colonIdx) : staticHost;
      targetPort  = colonIdx > 0 ? (parseInt(staticHost.slice(colonIdx + 1)) || 80) : 80;
      hostHeader  = staticHost;
    } else {
      targetHost  = 'localhost';
      targetPort  = localPort;
      hostHeader  = `localhost:${localPort}`;
    }

    const hdrs = { ...msg.headers, host: hostHeader };
    delete hdrs['content-length'];
    delete hdrs['accept-encoding'];   // force uncompressed — proxy can't re-encode
    if (body.length) hdrs['content-length'] = body.length;

    const displayTarget = staticHost || `:${localPort}`;

    const pr = http.request({
      hostname: targetHost, port: targetPort,
      path: msg.url, method: msg.method,
      headers: hdrs, timeout: 25000,
    }, proxyRes => {
      const chunks = [];
      proxyRes.on('data', c => chunks.push(c));
      proxyRes.on('end', () => {
        const rb = Buffer.concat(chunks);
        _reply(msg.requestId, proxyRes.statusCode, proxyRes.headers, rb, serverHost, clientPort);
        const icon = proxyRes.statusCode < 300 ? '✓' : proxyRes.statusCode < 500 ? '⚠' : '✗';
        console.log(`  ${icon} ${displayTarget} ${msg.method.padEnd(6)} ${msg.url.padEnd(36)} ${proxyRes.statusCode}`);
      });
    });

    pr.on('timeout', () => {
      pr.destroy();
      _reply(msg.requestId, 504, { 'content-type': 'text/plain' }, Buffer.from('Timeout'), serverHost, clientPort);
    });
    pr.on('error', err => {
      const s = err.code === 'ECONNREFUSED' ? 503 : 502;
      console.error(`  ✗ ${displayTarget} ${msg.method} ${msg.url} → ${err.message}`);
      _reply(msg.requestId, s, { 'content-type': 'text/plain' }, Buffer.from(err.message), serverHost, clientPort);
    });

    if (body.length) pr.write(body);
    pr.end();
  }

  function _reply(requestId, status, headers, body, serverHost, clientPort) {
    const payload = JSON.stringify({ requestId, status, headers, body: body.toString('base64') });
    const r = http.request({
      hostname: serverHost, port: clientPort,
      path: '/response', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    });
    r.on('error', () => {});
    r.write(payload);
    r.end();
  }

  return { connect, disconnect };
}

module.exports = { createClient };
