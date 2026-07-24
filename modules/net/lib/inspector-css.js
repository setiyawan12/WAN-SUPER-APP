'use strict';

/** Inspector dashboard CSS — extracted from inspector-html.js */
module.exports = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0a0b14; --s1:#0f1020; --s2:#141526; --brd:#1e2038; --brd2:#252845;
  --txt:#d8daf0; --dim:#6b7099; --dim2:#4a4f6e;
  --acc:#6366f1; --acc2:#818cf8;
  --g:#34d399; --y:#fbbf24; --o:#f97316; --r:#f43f5e; --b:#60a5fa; --p:#a78bfa;
  --font:'Inter',system-ui,sans-serif; --mono:'JetBrains Mono','Fira Code',monospace;
}
html.light{
  --bg:#f4f5ff; --s1:#ffffff; --s2:#edf0ff; --brd:#dde1f5; --brd2:#c5caec;
  --txt:#1a1b2e; --dim:#5c6080; --dim2:#8890b5;
  --acc:#4f51d4; --acc2:#4f51d4;
  --g:#059669; --y:#d97706; --o:#ea580c; --r:#e11d48; --b:#2563eb; --p:#7c3aed;
}
/* Method badges */
html.light .mGET{background:rgba(37,99,235,.1);color:#1d4ed8}
html.light .mPOST{background:rgba(5,150,105,.1);color:#065f46}
html.light .mPUT{background:rgba(194,65,12,.1);color:#9a3412}
html.light .mDELETE{background:rgba(190,18,60,.1);color:#9f1239}
html.light .mPATCH{background:rgba(109,40,217,.1);color:#5b21b6}
html.light .mOTHER,html.light .mHEAD,html.light .mOPTIONS{background:rgba(75,85,99,.1);color:#374151}
/* Status badges */
html.light .s2xx{background:rgba(5,150,105,.12);color:#065f46}
html.light .s3xx{background:rgba(180,83,9,.12);color:#92400e}
html.light .s4xx{background:rgba(194,65,12,.12);color:#9a3412}
html.light .s5xx{background:rgba(190,18,60,.12);color:#9f1239}
html.light .sunk{background:rgba(75,85,99,.1);color:#374151}
html.light .sabrt{background:rgba(180,83,9,.1);color:#92400e}
/* JSON syntax highlighting */
html.light .body-view.json .jk{color:#1d4ed8}
html.light .body-view.json .js{color:#047857}
html.light .body-view.json .jn{color:#b45309}
html.light .body-view.json .jb{color:#6d28d9}
html.light .body-view.json .jl{color:#be123c}
/* Code/body view */
html.light .body-view{background:#f0f2ff;color:#1a1b2e;border-color:var(--brd)}
html.light .body-copy{background:#e5e8ff;color:var(--dim)}
/* Header name column in tables */
html.light .htable td:first-child{background:rgba(37,99,235,.04);color:#1d4ed8}
html.light .htable tr:hover td{background:rgba(79,81,212,.04)}
/* Mock/port tags */
html.light .mock-tag{background:rgba(109,40,217,.12);color:#5b21b6;border-color:rgba(109,40,217,.25)}
html.light .port-badge{background:rgba(37,99,235,.1);color:#1d4ed8;border-color:rgba(37,99,235,.2)}
html.light .chip-mock{background:rgba(109,40,217,.1);color:#5b21b6;border-color:rgba(109,40,217,.25)}
html.light .chip-ip,html.light .chip-size{background:var(--s2);color:var(--dim);border-color:var(--brd)}
/* Sidebar */
html.light .reqrow:hover{background:rgba(79,81,212,.04)}
html.light .reqrow.active{background:rgba(79,81,212,.08);border-left-color:var(--acc)}
/* Buttons */
html.light .hbtn{background:#edf0ff;border-color:var(--brd);color:var(--dim)}
html.light .hbtn:hover{background:var(--brd);color:var(--txt)}
html.light .hbtn.active{background:rgba(79,81,212,.15);border-color:rgba(79,81,212,.4);color:var(--acc)}
html.light .hbtn.pause-on{background:rgba(180,83,9,.1);border-color:rgba(180,83,9,.3);color:#92400e}
html.light .action-btn{background:#edf0ff;border-color:var(--brd);color:var(--dim)}
html.light .action-btn:hover{background:var(--brd);color:var(--txt)}
html.light .action-btn.replay-btn{background:rgba(79,81,212,.1);border-color:rgba(79,81,212,.3);color:var(--acc)}
html.light .action-btn.edit-btn{background:rgba(180,83,9,.08);border-color:rgba(180,83,9,.25);color:#92400e}
html.light .action-btn.mock-btn{background:rgba(109,40,217,.08);border-color:rgba(109,40,217,.25);color:#5b21b6}
/* Forms in modal */
html.light .form-group input,html.light .form-group select,html.light .form-group textarea{background:#fff;border-color:var(--brd);color:var(--txt)}
html.light .btn-ghost{background:#edf0ff;border-color:var(--brd);color:var(--dim)}
html.light .btn-ghost:hover{background:var(--brd);color:var(--txt)}
html.light .mock-list-item{background:#f8f9ff;border-color:var(--brd)}
/* Modal */
html.light .modal{box-shadow:0 24px 80px rgba(0,0,0,.15)}
html.light .overlay{background:rgba(30,32,56,.4)}
/* Scrollbar */
html.light ::-webkit-scrollbar-thumb{background:var(--brd2)}
html,body{height:100%;overflow:hidden}
body{background:var(--bg);color:var(--txt);font-family:var(--font);font-size:13px;display:flex;flex-direction:column;-webkit-font-smoothing:antialiased}
::-webkit-scrollbar{width:5px;height:5px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--brd2);border-radius:10px}

/* Header */
header{height:52px;background:var(--s1);border-bottom:1px solid var(--brd);padding:0 14px;display:flex;align-items:center;gap:10px;flex-shrink:0}
.logo{display:flex;align-items:center;gap:8px;font-weight:600;font-size:14px}
.logo-icon{width:28px;height:28px;background:linear-gradient(135deg,#6366f1,#8b5cf6);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0}
.live-badge{display:flex;align-items:center;gap:5px;background:rgba(52,211,153,.12);border:1px solid rgba(52,211,153,.25);color:var(--g);padding:3px 9px;border-radius:100px;font-size:11px;font-weight:500}
.live-badge.off{background:rgba(244,63,94,.1);border-color:rgba(244,63,94,.2);color:var(--r)}
.live-dot{width:6px;height:6px;border-radius:50%;background:currentColor}
.live-badge:not(.off) .live-dot{animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.sep{width:1px;height:28px;background:var(--brd);flex-shrink:0}
.stat-grp{display:flex;gap:14px;align-items:center}
.stat{text-align:center}
.stat-val{font-size:13px;font-weight:600;font-family:var(--mono)}
.stat-lbl{font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.5px;margin-top:1px}
.spacer{flex:1}
.hbtn{background:var(--s2);border:1px solid var(--brd);color:var(--dim);padding:5px 10px;border-radius:7px;cursor:pointer;font:12px var(--font);transition:all .15s;display:flex;align-items:center;gap:5px;white-space:nowrap}
.hbtn:hover{background:var(--brd);color:var(--txt);border-color:var(--brd2)}
.hbtn.active{background:rgba(99,102,241,.15);border-color:rgba(99,102,241,.4);color:var(--acc2)}
.hbtn.pause-on{background:rgba(251,191,36,.1);border-color:rgba(251,191,36,.3);color:var(--y)}
.badge-cnt{background:var(--acc);color:#fff;font-size:10px;padding:1px 5px;border-radius:10px;font-family:var(--mono)}
.kbd{display:inline-flex;align-items:center;justify-content:center;background:var(--s2);border:1px solid var(--brd2);border-bottom-width:2px;border-radius:4px;padding:1px 5px;font:10px var(--mono);color:var(--txt);min-width:18px}
.shortcut-popup{position:absolute;top:52px;right:0;background:var(--s1);border:1px solid var(--brd2);border-radius:10px;padding:12px 14px;min-width:220px;box-shadow:0 12px 40px rgba(0,0,0,.4);z-index:200;display:none}
.shortcut-popup.open{display:block}
.shortcut-popup table{border-collapse:collapse;width:100%}
.shortcut-popup td{padding:4px 0;font-size:11px;vertical-align:middle}
.shortcut-popup td:first-child{padding-right:12px;white-space:nowrap}
.shortcut-popup td:last-child{color:var(--dim);font-size:11px}
.shortcut-popup .sc-title{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:var(--dim2);margin-bottom:8px}

/* Layout */
main{flex:1;display:flex;overflow:hidden;min-height:0}

/* Sidebar */
#sidebar{width:290px;flex-shrink:0;border-right:1px solid var(--brd);display:flex;flex-direction:column;background:var(--s1)}
.sb-top{padding:8px 10px 0;border-bottom:1px solid var(--brd)}
.search-wrap{position:relative;margin-bottom:8px}
.search-wrap svg{position:absolute;left:8px;top:50%;transform:translateY(-50%);color:var(--dim2);pointer-events:none}
#search{width:100%;background:var(--bg);border:1px solid var(--brd);border-radius:7px;color:var(--txt);padding:5px 8px 5px 28px;font:12px var(--font);outline:none;transition:border-color .15s}
#search:focus{border-color:var(--acc)}
#search::placeholder{color:var(--dim2)}
.filter-bar{display:flex;gap:4px;padding-bottom:8px;flex-wrap:wrap}
.fbtn{background:transparent;border:1px solid var(--brd);color:var(--dim);padding:3px 8px;border-radius:5px;cursor:pointer;font:11px var(--font);transition:all .12s}
.fbtn:hover{background:var(--s2);color:var(--txt)}
.fbtn.on{color:#fff;border-color:transparent}
.fbtn.all.on{background:var(--acc)}
.fbtn.f2xx.on{background:#059669}
.fbtn.f3xx.on{background:#b45309}
.fbtn.f4xx.on{background:#c2410c}
.fbtn.f5xx.on{background:#be123c}
.fbtn.pin.on{background:#7c3aed}
#port-bar{padding-top:0;padding-bottom:6px;border-top:1px solid var(--brd);margin-top:2px}
#port-bar .fbtn.on{background:#0e7490;color:#fff;border-color:transparent}
.sb-cnt{display:flex;align-items:center;justify-content:space-between;padding:6px 10px;border-bottom:1px solid var(--brd)}
.cnt-lbl{font-size:11px;color:var(--dim)}
.cnt-num{font-size:11px;font-family:var(--mono);color:var(--dim2);font-weight:500}
#reqlist{flex:1;overflow-y:auto}

/* Request row */
.reqrow{padding:9px 10px;border-bottom:1px solid var(--brd);cursor:pointer;transition:background .1s;display:grid;grid-template-columns:auto 1fr auto auto;grid-template-rows:auto auto;gap:3px 6px;align-items:center;border-left:2px solid transparent;position:relative;overflow:hidden}
.reqrow:hover{background:rgba(99,102,241,.05)}
.reqrow.active{background:rgba(99,102,241,.08);border-left-color:var(--acc)}
.reqrow.new-in{animation:slideIn .22s ease}
@keyframes slideIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
.method{font-size:10px;font-weight:600;padding:2px 5px;border-radius:4px;text-transform:uppercase;font-family:var(--mono);letter-spacing:.3px}
.mGET{background:rgba(96,165,250,.15);color:#93c5fd}
.mPOST{background:rgba(52,211,153,.15);color:#6ee7b7}
.mPUT{background:rgba(249,115,22,.15);color:#fdba74}
.mDELETE{background:rgba(244,63,94,.15);color:#fda4af}
.mPATCH{background:rgba(167,139,250,.15);color:#c4b5fd}
.mOTHER,.mHEAD,.mOPTIONS{background:rgba(107,112,153,.15);color:var(--dim)}
.rpath{font-size:12px;color:var(--txt);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;grid-column:2;grid-row:1;font-family:var(--mono)}
.rstatus{font-size:11px;font-weight:600;font-family:var(--mono);padding:1px 5px;border-radius:4px}
.pin-btn{background:none;border:none;cursor:pointer;color:var(--dim2);padding:0 2px;font-size:12px;transition:color .1s;grid-row:1;line-height:1}
.pin-btn:hover,.pin-btn.on{color:var(--y)}
.rmeta{grid-column:2/5;grid-row:2;display:flex;gap:8px;align-items:center}
.rtime{font-size:10px;color:var(--dim2)}
.rms{font-size:10px;font-family:var(--mono)}
.rsize{font-size:10px;color:var(--dim2);font-family:var(--mono)}
.wfall{position:absolute;bottom:0;left:0;height:2px;border-radius:0 1px 1px 0;transition:width .4s ease;pointer-events:none}
.mock-tag{font-size:9px;font-weight:600;background:rgba(167,139,250,.2);color:var(--p);border:1px solid rgba(167,139,250,.3);padding:1px 5px;border-radius:3px;text-transform:uppercase;letter-spacing:.5px}
.port-badge{font-size:9px;font-weight:600;background:rgba(96,165,250,.12);color:#7dd3fc;border:1px solid rgba(96,165,250,.2);padding:1px 5px;border-radius:3px;font-family:var(--mono)}
.empty-state{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px;gap:12px;text-align:center}
.empty-icon{width:48px;height:48px;border-radius:12px;background:var(--s2);border:1px solid var(--brd);display:flex;align-items:center;justify-content:center;font-size:22px}
.empty-title{font-size:13px;font-weight:500;color:var(--dim)}
.empty-sub{font-size:11px;color:var(--dim2);line-height:1.6}

/* Resize handle */
#resize-handle{width:4px;cursor:col-resize;background:transparent;flex-shrink:0;transition:background .15s;position:relative;z-index:10}
#resize-handle:hover,#resize-handle.resizing{background:var(--acc)}
#resize-handle::after{content:'';position:absolute;inset:-4px 0;cursor:col-resize}

/* Detail pane */
#detail-pane{flex:1;display:flex;flex-direction:column;overflow:hidden;background:var(--bg)}
.no-sel{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:var(--dim)}
.no-sel-icon{font-size:32px;opacity:.25}
.no-sel-txt{font-size:12px;color:var(--dim2)}
#detail{flex:1;display:none;flex-direction:column;overflow:hidden}
.det-head{padding:12px 16px;border-bottom:1px solid var(--brd);background:var(--s1);display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap}
.det-method{font-size:12px;font-weight:600;padding:3px 8px;border-radius:5px;font-family:var(--mono);flex-shrink:0}
.det-url{flex:1;font-size:13px;font-family:var(--mono);color:var(--txt);word-break:break-all;line-height:1.4;padding-top:2px;min-width:0}
.det-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.chip{font-size:11px;font-weight:600;padding:2px 8px;border-radius:5px;font-family:var(--mono);flex-shrink:0}
.chip-ip{font-size:10px;color:var(--dim2);background:var(--s2);border:1px solid var(--brd);padding:2px 7px;border-radius:4px;font-family:var(--mono)}
.chip-ms{font-size:11px;font-family:var(--mono)}
.chip-size{font-size:10px;color:var(--dim2);background:var(--s2);border:1px solid var(--brd);padding:2px 7px;border-radius:4px;font-family:var(--mono)}
.chip-mock{font-size:10px;font-weight:600;background:rgba(167,139,250,.15);color:var(--p);border:1px solid rgba(167,139,250,.3);padding:2px 7px;border-radius:4px;text-transform:uppercase;letter-spacing:.5px}

/* Tabs */
.tabs{display:flex;align-items:center;border-bottom:1px solid var(--brd);padding:0 14px;background:var(--s1);gap:2px;flex-shrink:0}
.tab{padding:9px 10px;cursor:pointer;color:var(--dim);border-bottom:2px solid transparent;font-size:12px;font-weight:500;transition:color .15s;position:relative;top:1px;white-space:nowrap}
.tab:hover{color:var(--txt)}
.tab.on{color:var(--acc2);border-bottom-color:var(--acc)}
.tab-spacer{flex:1}
.action-btn{display:flex;align-items:center;gap:4px;background:var(--s2);border:1px solid var(--brd);color:var(--dim);padding:4px 9px;border-radius:6px;font:11px var(--font);font-weight:500;cursor:pointer;transition:all .12s;white-space:nowrap}
.action-btn:hover{background:var(--brd);color:var(--txt)}
.action-btn.replay-btn{background:rgba(99,102,241,.12);border-color:rgba(99,102,241,.3);color:var(--acc2);margin-left:6px}
.action-btn.replay-btn:hover{background:rgba(99,102,241,.22)}
.action-btn.edit-btn{background:rgba(251,191,36,.08);border-color:rgba(251,191,36,.25);color:var(--y)}
.action-btn.edit-btn:hover{background:rgba(251,191,36,.15)}
.action-btn.mock-btn{background:rgba(167,139,250,.08);border-color:rgba(167,139,250,.25);color:var(--p)}
.action-btn.mock-btn:hover{background:rgba(167,139,250,.15)}
.action-btn.ok{background:rgba(52,211,153,.12);border-color:rgba(52,211,153,.3);color:var(--g)}
.action-btn.err{background:rgba(244,63,94,.1);border-color:rgba(244,63,94,.25);color:var(--r)}
.action-btn.curl-btn{background:rgba(96,165,250,.08);border-color:rgba(96,165,250,.25);color:var(--b)}
.action-btn.curl-btn:hover{background:rgba(96,165,250,.16)}
.action-btn.curl-btn.copied{background:rgba(52,211,153,.12);border-color:rgba(52,211,153,.3);color:var(--g)}

/* Tab body */
.tab-body{flex:1;overflow-y:auto;padding:14px 16px}
.section{margin-bottom:18px}
.sec-title{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.8px;color:var(--dim2);margin-bottom:8px;display:flex;align-items:center;gap:6px}
.sec-title::after{content:'';flex:1;height:1px;background:var(--brd)}
.htable{width:100%;border-collapse:collapse;border:1px solid var(--brd);border-radius:8px;overflow:hidden}
.htable tr:last-child td{border-bottom:none}
.htable td{padding:5px 10px;border-bottom:1px solid var(--brd);vertical-align:top;font-size:11.5px}
.htable td:first-child{color:var(--b);font-family:var(--mono);white-space:nowrap;padding-right:14px;width:1%;background:rgba(96,165,250,.04);border-right:1px solid var(--brd)}
.htable td:last-child{color:var(--txt);word-break:break-all;font-family:var(--mono);position:relative;padding-right:56px}
.htable tr:hover td{background:rgba(99,102,241,.04)}
.copy-btn{position:absolute;right:6px;top:50%;transform:translateY(-50%);background:var(--s2);border:1px solid var(--brd);color:var(--dim);padding:2px 6px;border-radius:4px;font-size:10px;cursor:pointer;opacity:0;transition:opacity .12s;font-family:var(--font)}
.htable tr:hover .copy-btn{opacity:1}
.copy-btn:hover{background:var(--brd);color:var(--txt)}
.body-view{background:var(--s1);border:1px solid var(--brd);border-radius:8px;padding:12px;font-family:var(--mono);font-size:11.5px;line-height:1.7;white-space:pre-wrap;word-break:break-all;max-height:380px;overflow-y:auto;color:var(--txt);position:relative}
.body-view.json .jk{color:#93c5fd}
.body-view.json .js{color:#86efac}
.body-view.json .jn{color:#fdba74}
.body-view.json .jb{color:#c4b5fd}
.body-view.json .jl{color:#fda4af}
.body-copy{position:absolute;top:7px;right:7px;background:var(--s2);border:1px solid var(--brd);color:var(--dim);padding:2px 8px;border-radius:5px;font-size:10px;cursor:pointer;font-family:var(--font);transition:all .12s}
.body-copy:hover{background:var(--brd);color:var(--txt)}
.nobody{color:var(--dim2);font-style:italic;font-size:12px;padding:10px 0}
.s2xx{background:rgba(52,211,153,.15);color:#6ee7b7}
.s3xx{background:rgba(251,191,36,.15);color:#fde68a}
.s4xx{background:rgba(249,115,22,.15);color:#fdba74}
.s5xx{background:rgba(244,63,94,.15);color:#fda4af}
.sunk{background:rgba(107,112,153,.15);color:var(--dim)}
.sabrt{background:rgba(251,191,36,.12);color:#fbbf24}

/* Modal */
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.65);display:none;align-items:center;justify-content:center;z-index:1000;backdrop-filter:blur(2px)}
.overlay.open{display:flex}
.modal{background:var(--s1);border:1px solid var(--brd2);border-radius:12px;width:min(560px,94vw);max-height:88vh;display:flex;flex-direction:column;box-shadow:0 24px 80px rgba(0,0,0,.6)}
.modal-head{padding:14px 18px;border-bottom:1px solid var(--brd);display:flex;align-items:center;gap:8px;flex-shrink:0}
.modal-title{font-weight:600;font-size:14px;flex:1}
.modal-close{background:none;border:none;color:var(--dim);cursor:pointer;font-size:16px;line-height:1;padding:2px;transition:color .12s}
.modal-close:hover{color:var(--txt)}
.modal-body{padding:16px 18px;overflow-y:auto;flex:1}
.modal-footer{display:flex;justify-content:flex-end;gap:8px;padding-top:14px;border-top:1px solid var(--brd);margin-top:14px}
.form-row{display:flex;gap:10px;margin-bottom:12px}
.form-group{display:flex;flex-direction:column;gap:5px;flex:1}
.form-group label{font-size:11px;font-weight:500;color:var(--dim);text-transform:uppercase;letter-spacing:.5px}
.form-group input,.form-group select,.form-group textarea{background:var(--bg);border:1px solid var(--brd);border-radius:6px;color:var(--txt);padding:7px 10px;font:12px var(--mono);outline:none;transition:border-color .12s;resize:vertical}
.form-group input:focus,.form-group select:focus,.form-group textarea:focus{border-color:var(--acc)}
.form-group textarea{min-height:90px;line-height:1.6}
.form-group select option{background:var(--s2)}
.btn-ghost{background:var(--s2);border:1px solid var(--brd);color:var(--dim);padding:7px 16px;border-radius:7px;cursor:pointer;font:12px var(--font);transition:all .12s}
.btn-ghost:hover{background:var(--brd);color:var(--txt)}
.btn-primary{background:var(--acc);border:1px solid transparent;color:#fff;padding:7px 16px;border-radius:7px;cursor:pointer;font:12px var(--font);font-weight:500;transition:all .12s}
.btn-primary:hover{background:#4f52d4}
.mock-list-item{display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--bg);border:1px solid var(--brd);border-radius:7px;margin-bottom:7px}
.mock-list-path{flex:1;font-family:var(--mono);font-size:11px;color:var(--txt);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mock-list-status{font-family:var(--mono);font-size:11px;font-weight:600;flex-shrink:0}
.mock-del{background:none;border:none;color:var(--dim2);cursor:pointer;font-size:13px;padding:2px;transition:color .12s;flex-shrink:0}
.mock-del:hover{color:var(--r)}
.form-hint{font-size:10px;color:var(--dim2);margin-top:2px}
.empty-mocks{text-align:center;padding:24px 0;color:var(--dim2);font-size:12px}

/* Wide modal variant */
.modal.wide{width:min(820px,96vw)}

/* Diff view */
.diff-same{color:var(--dim);padding:1px 0;font-size:11px;font-family:var(--mono)}
.diff-add{color:var(--g);background:rgba(52,211,153,.08);padding:1px 4px;font-size:11px;font-family:var(--mono)}
.diff-del{color:var(--r);background:rgba(244,63,94,.08);padding:1px 4px;font-size:11px;font-family:var(--mono);text-decoration:line-through;opacity:.8}

/* Rate chart */
.rate-wrap{display:flex;align-items:center;gap:5px;padding:0 2px}
.rate-lbl{font-size:9px;color:var(--dim2);text-align:center;line-height:1.2;white-space:nowrap}

/* Timeline view */
.tl-row{padding:5px 10px;border-bottom:1px solid var(--brd);cursor:pointer;transition:background .1s}
.tl-row:hover{background:rgba(99,102,241,.05)}
.tl-row.active{background:rgba(99,102,241,.08)}
.tl-hdr{padding:4px 10px 2px;border-bottom:1px solid var(--brd);display:flex;align-items:center;justify-content:space-between}
.tl-hdr-txt{font-size:9px;color:var(--dim2);text-transform:uppercase;letter-spacing:.5px}
.tl-label{display:flex;align-items:center;gap:5px;margin-bottom:3px}
.tl-url{font-size:10px;font-family:var(--mono);color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tl-track{position:relative;height:10px;background:var(--brd);border-radius:6px;overflow:visible}
.tl-bar{position:absolute;top:0;height:100%;border-radius:6px;min-width:3px;display:flex;align-items:center;padding-left:3px;overflow:hidden}
.tl-ms{font-size:8px;font-family:var(--mono);color:rgba(255,255,255,.85);white-space:nowrap}
.tl-axis{display:flex;justify-content:space-between;padding:2px 10px 0;font-size:9px;color:var(--dim2)}

/* Inject rules list */
.inj-item{display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--bg);border:1px solid var(--brd);border-radius:7px;margin-bottom:7px;flex-wrap:wrap}
.inj-port{font-family:var(--mono);font-size:11px;font-weight:600;color:var(--b);flex-shrink:0}
.inj-headers{flex:1;font-family:var(--mono);font-size:10px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
html.light .diff-add{background:rgba(5,150,105,.08)}
html.light .diff-del{background:rgba(190,18,60,.08)}
`;
