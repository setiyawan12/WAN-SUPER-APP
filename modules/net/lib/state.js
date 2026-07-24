'use strict';

/**
 * RingLog — fixed-capacity circular buffer, O(1) push + auto-eviction.
 * Exposes the subset of Array API used by the rest of the codebase.
 */
class RingLog {
  constructor(capacity) {
    this._buf  = new Array(capacity);
    this._cap  = capacity;
    this._size = 0;
    this._head = 0; // index of the oldest entry
  }

  /** Append one entry. Silently evicts oldest when full. O(1). */
  push(item) {
    if (this._size < this._cap) {
      this._buf[(this._head + this._size) % this._cap] = item;
      this._size++;
    } else {
      // Overwrite oldest slot and advance head
      this._buf[this._head] = item;
      this._head = (this._head + 1) % this._cap;
    }
  }

  /** Append multiple entries (e.g. from disk load). */
  pushAll(items) {
    for (const item of items) this.push(item);
  }

  /**
   * Return a plain array, newest entry first.
   * Allocates a new array — use sparingly (init/persist/export).
   */
  toArray() {
    const result = new Array(this._size);
    for (let i = 0; i < this._size; i++) {
      result[i] = this._buf[(this._head + this._size - 1 - i) % this._cap];
    }
    return result;
  }

  /** Same semantics as Array.prototype.find (searches newest-first). */
  find(fn) {
    for (let i = this._size - 1; i >= 0; i--) {
      const item = this._buf[(this._head + i) % this._cap];
      if (fn(item)) return item;
    }
    return undefined;
  }

  /** Same semantics as Array.prototype.filter (newest-first). */
  filter(fn) {
    return this.toArray().filter(fn);
  }

  get length() { return this._size; }

  clear() { this._size = 0; this._head = 0; }
}

/**
 * createState() — factory that returns a fresh, isolated state object.
 * Used in tests so each test gets its own state without module cache pollution.
 *
 * Example:
 *   const { createState } = require('./state');
 *   const s = createState();
 */
function createState(capacity = 500) {
  return {
    INSP_PORT  : 0,
    startedAt  : Date.now(),
    // Per-tunnel state keyed by tunnelKey
    // Map<tunnelKey, { clientSSE, pending: Map, tunnelPort, publicUrl }>
    tunnels    : new Map(),
    // Ring buffer — newest-first via .toArray(); direct .push() for O(1) insert
    requestLog : new RingLog(capacity),
    inspStreams : new Set(),
    mocks      : new Map(),
    // Header injection rules: Map<tunnelKey|'*', { headerName: value }>
    headerInjections: new Map(),
  };
}

/**
 * Shared singleton — used by all runtime modules (tunnel-server, inspector, etc.).
 * Import this for production use; use createState() in tests.
 */
const state = createState();

module.exports = state;
module.exports.createState = createState;
module.exports.RingLog     = RingLog;
