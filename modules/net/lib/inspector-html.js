'use strict';

const CSS    = require('./inspector-css');
const CLIENT = require('./inspector-client');

/**
 * Inspector dashboard HTML — assembled from:
 *   inspector-css.js    (~290 lines CSS)
 *   inspector-client.js (~908 lines browser JS)
 */
const INSPECTOR_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WAN NET</title>
<style>${CSS}</style>
</head>
<body>

<header>
  <div class="logo"><div class="logo-icon">⚡</div>WAN NET</div>
  <div class="live-badge off" id="badge"><div class="live-dot"></div><span id="badge-txt">connecting</span></div>
  <div class="sep"></div>
  <div class="stat-grp">
    <div class="stat"><div class="stat-val" id="s-total">0</div><div class="stat-lbl">Requests</div></div>
    <div class="stat"><div class="stat-val" id="s-avg">—</div><div class="stat-lbl">Avg ms</div></div>
    <div class="stat"><div class="stat-val" id="s-err">0</div><div class="stat-lbl">Errors</div></div>
  </div>
  <div class="sep"></div>
  <div class="rate-wrap" title="Requests per minute (last 10 min)">
    <svg id="rate-chart" width="80" height="28" style="display:block"></svg>
    <div class="rate-lbl">req<br>/min</div>
  </div>
  <div class="spacer"></div>
  <div style="position:relative">
    <button class="hbtn" id="shortcuts-btn" onclick="toggleShortcuts()" title="Keyboard shortcuts">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="13" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"/></svg>
    </button>
    <div class="shortcut-popup" id="shortcut-popup">
      <div class="sc-title">Keyboard Shortcuts</div>
      <table>
        <tr><td><span class="kbd">↑</span> <span class="kbd">↓</span></td><td>Navigasi request</td></tr>
        <tr><td><span class="kbd">R</span></td><td>Replay request</td></tr>
        <tr><td><span class="kbd">U</span></td><td>Copy as cURL</td></tr>
        <tr><td><span class="kbd">C</span></td><td>Copy request body</td></tr>
        <tr><td><span class="kbd">Esc</span></td><td>Tutup modal</td></tr>
      </table>
    </div>
  </div>
  <button class="hbtn" id="pause-btn" onclick="togglePause()">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
    Pause
  </button>
  <button class="hbtn" id="notif-btn" onclick="toggleNotif()">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0"/></svg>
    Notify
  </button>
  <button class="hbtn" id="mocks-btn" onclick="openMocksList()">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
    Mocks <span class="badge-cnt" id="mocks-cnt" style="display:none">0</span>
  </button>
  <button class="hbtn" onclick="openDiff()">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 00-2 2v14a2 2 0 002 2h3M16 3h3a2 2 0 012 2v14a2 2 0 01-2 2h-3M12 8v8M9 11l3-3 3 3"/></svg>
    Diff
  </button>
  <button class="hbtn" id="tl-btn" onclick="toggleTimeline()">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="4" rx="1"/><rect x="3" y="10" width="12" height="4" rx="1"/><rect x="3" y="16" width="15" height="4" rx="1"/></svg>
    Timeline
  </button>
  <button class="hbtn" id="inject-btn" onclick="openInject()">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 20l4-16M4 15l16-6M4 9l16 6"/></svg>
    Inject <span class="badge-cnt" id="inject-cnt" style="display:none">0</span>
  </button>
  <button class="hbtn" onclick="openStats()">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>
    Stats
  </button>
  <button class="hbtn" onclick="exportHAR()">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
    HAR
  </button>
  <button class="hbtn" onclick="exportPostman()" title="Export sebagai Postman Collection v2.1">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
    Postman
  </button>
  <div class="sep"></div>
  <button class="hbtn" id="theme-btn" onclick="toggleTheme()" title="Toggle light/dark mode">
    <svg id="theme-icon-moon" width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>
    <svg id="theme-icon-sun" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="display:none"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
  </button>
  <div class="sep"></div>
  <button class="hbtn" onclick="clearAll()">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3,6 5,6 21,6"/><path d="M19,6l-1,14H6L5,6"/></svg>
    Clear
  </button>
</header>

<main>
  <div id="sidebar">
    <div class="sb-top">
      <div class="search-wrap">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input id="search" placeholder="Filter path, method, or :port…" oninput="onSearchInput()">
      </div>
      <div class="filter-bar">
        <button class="fbtn all on" onclick="setFilter('all',this)">All</button>
        <button class="fbtn f2xx" onclick="setFilter('2xx',this)">2xx</button>
        <button class="fbtn f3xx" onclick="setFilter('3xx',this)">3xx</button>
        <button class="fbtn f4xx" onclick="setFilter('4xx',this)">4xx</button>
        <button class="fbtn f5xx" onclick="setFilter('5xx',this)">5xx</button>
        <button class="fbtn pin" onclick="setFilter('pin',this)">📌 Pinned</button>
      </div>
      <div class="filter-bar" id="port-bar" style="display:none"></div>
    </div>
    <div class="sb-cnt">
      <span class="cnt-lbl">Requests</span>
      <span class="cnt-num" id="cnt">0</span>
    </div>
    <div id="reqlist">
      <div class="empty-state" id="empty">
        <div class="empty-icon">🌐</div>
        <div class="empty-title">No requests yet</div>
        <div class="empty-sub">Requests akan muncul<br>di sini secara real-time</div>
      </div>
    </div>
  </div>

  <div id="resize-handle"></div>
  <div id="detail-pane">
    <div class="no-sel" id="nosel">
      <div class="no-sel-icon">↖</div>
      <div class="no-sel-txt">Pilih request untuk melihat detail</div>
    </div>
    <div id="detail">
      <div class="det-head" id="det-head"></div>
      <div class="tabs">
        <div class="tab on" onclick="setTab('req',this)">Request</div>
        <div class="tab" onclick="setTab('res',this)">Response</div>
        <div class="tab" onclick="setTab('preview',this)">Preview</div>
        <div class="tab" onclick="setTab('raw',this)">Raw</div>
        <div class="tab-spacer"></div>
        <button class="action-btn curl-btn" id="curl-btn" onclick="copyAsCurl()" title="Copy as cURL">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4,17 10,11 4,5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
          cURL
        </button>
        <button class="action-btn edit-btn" onclick="openEditReplay()">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          Edit &amp; Replay
        </button>
        <button class="action-btn mock-btn" onclick="openMockFromReq()">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          Mock
        </button>
        <button class="action-btn replay-btn" id="replay-btn" onclick="replayReq()">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
          Replay
        </button>
      </div>
      <div class="tab-body" id="tab-body"></div>
    </div>
  </div>
</main>

<div class="overlay" id="overlay" onclick="overlayClick(event)">
  <div class="modal">
    <div class="modal-head">
      <span class="modal-title" id="modal-title"></span>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body" id="modal-body"></div>
  </div>
</div>

<script>${CLIENT}</script>
</body>
</html>`;

module.exports = INSPECTOR_HTML;
