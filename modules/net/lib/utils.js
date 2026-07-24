'use strict';

const net    = require('net');
const crypto = require('crypto');
const state  = require('./state');
const { INSP_PASS } = require('./config');

/** Random 12-char hex ID */
const uid = () => crypto.randomBytes(6).toString('hex');

/** Try ports sequentially from start, resolve with first free one */
function findFreePort(start = 8080) {
  return new Promise(resolve => {
    let port = start;
    const try_ = () => {
      const s = net.createServer();
      s.once('error', () => { port++; try_(); });
      s.once('listening', () => s.close(() => resolve(port)));
      s.listen(port);
    };
    try_();
  });
}

/** Write one SSE frame to a response */
function sse(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
}

/** Broadcast a JSON object to all open inspector SSE streams */
function broadcast(obj) {
  const str = `event: msg\ndata: ${JSON.stringify(obj)}\n\n`;
  for (const s of state.inspStreams) { try { s.write(str); } catch {} }
}

/** Broadcast the current mocks list to all inspector streams */
function broadcastMocks() {
  broadcast({
    type: 'mocks',
    data: [...state.mocks.entries()].map(([k, v]) => ({ key: k, ...v })),
  });
}

const BODY_LIMIT = 20 * 1024 * 1024; // 20 MB

/**
 * Consume and buffer the full request body.
 * Rejects with err.code === 'PAYLOAD_TOO_LARGE' if body exceeds limit.
 */
function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', d => {
      if (tooLarge) return;
      size += d.length;
      if (size > limit) {
        tooLarge = true;
        req.destroy();
        const err = new Error(`Request body exceeds ${Math.round(limit / 1024 / 1024)} MB limit`);
        err.code       = 'PAYLOAD_TOO_LARGE';
        err.statusCode = 413;
        reject(err);
        return;
      }
      chunks.push(d);
    });
    req.on('end',   () => { if (!tooLarge) resolve(Buffer.concat(chunks)); });
    req.on('error', () => { if (!tooLarge) resolve(Buffer.alloc(0)); });
  });
}

/** Basic-auth gate for the inspector. Returns true if allowed. */
function checkAuth(req, res) {
  if (!INSP_PASS) return true;
  const auth = req.headers['authorization'] || '';
  const b64  = Buffer.from('admin:' + INSP_PASS).toString('base64');
  if (auth === 'Basic ' + b64) return true;
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="WAN NET"',
    'Content-Type'    : 'text/plain',
  });
  res.end('Unauthorized');
  return false;
}

module.exports = { uid, findFreePort, sse, broadcast, broadcastMocks, readBody, checkAuth };
