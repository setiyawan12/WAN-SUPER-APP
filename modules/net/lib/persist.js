'use strict';

/**
 * Log persistence — save/load requestLog to wan-net-log.json in CWD.
 * Writes are debounced (10 s). Bodies > 8 KB are truncated before saving
 * so the file stays manageable even with large API responses.
 */

const fs    = require('fs');
const path  = require('path');
const state = require('./state');
const { MAX_LOG } = require('./config');

const LOG_FILE = path.join(process.cwd(), 'wan-net-log.json');
const MAX_BODY = 8_000;   // bytes per entry before body truncation
const DEBOUNCE = 10_000;  // ms between disk writes
let _timer = null;

/** Load persisted log from disk into state.requestLog. Call once at startup. */
function load() {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const data = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
    if (Array.isArray(data) && data.length) {
      // File stored newest-first; reverse so pushAll fills ring oldest→newest
      state.requestLog.pushAll(data.slice(0, MAX_LOG).reverse());
      console.log(`📂 Loaded ${state.requestLog.length} saved request(s) from wan-net-log.json`);
    }
  } catch (e) {
    console.warn(`⚠  Could not load wan-net-log.json: ${e.message}`);
  }
}

/** Schedule a debounced write. Idempotent — only one timer active at a time. */
function scheduleSave() {
  if (_timer) return;   // don't reset the clock on every request
  _timer = setTimeout(_write, DEBOUNCE);
}

/** Flush immediately (call on SIGINT/SIGTERM). */
function saveSync() {
  clearTimeout(_timer);
  _timer = null;
  _write();
}

/** Clear the persisted log file. */
function clear() {
  clearTimeout(_timer);
  _timer = null;
  try { fs.writeFileSync(LOG_FILE, '[]'); } catch {}
}

function _write() {
  _timer = null;
  try {
    // toArray() = newest-first; strip/truncate heavy fields before serialising
    const entries = state.requestLog.toArray().map(e => {
      // Never persist binary blobs to disk — they're large and reconstructible
      // from the original request if needed. resBodyB64 > MAX_BINARY_BODY is
      // already null (capped in tunnel-server), but drop any that slipped through.
      const b64Len = e.resBodyB64?.length || 0;
      const rqLen  = e.reqBody?.length    || 0;
      const rsLen  = e.resBody?.length    || 0;

      const out = b64Len > 0 ? { ...e, resBodyB64: null } : e;

      if (rqLen + rsLen <= MAX_BODY) return out;
      return {
        ...out,
        reqBody: rqLen > MAX_BODY / 2 ? e.reqBody.slice(0, MAX_BODY / 2) + '…[truncated]' : e.reqBody,
        resBody: rsLen > MAX_BODY / 2 ? e.resBody.slice(0, MAX_BODY / 2) + '…[truncated]' : e.resBody,
      };
    });
    fs.writeFileSync(LOG_FILE, JSON.stringify(entries));
  } catch (e) {
    console.warn(`⚠  Could not save wan-net-log.json: ${e.message}`);
  }
}

module.exports = { load, scheduleSave, saveSync, clear };
