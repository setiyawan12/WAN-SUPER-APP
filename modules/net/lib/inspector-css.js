'use strict';

/** Inspector dashboard CSS — extracted from inspector-html.js */
module.exports = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  color-scheme:dark;
  --bg:#080a0c; --s1:#101317; --s2:#15191e; --brd:rgba(255,255,255,.09); --brd2:rgba(255,255,255,.17);
  --txt:#f2f0e9; --dim:#858b93; --dim2:#555b63;
  --acc:#d7c38d; --acc2:#e4d29f;
  --g:#72d89b; --y:#e6b86a; --o:#e99062; --r:#ff7d83; --b:#6edbd0; --p:#b9a7df;
  --font:'Avenir Next','Helvetica Neue',sans-serif; --mono:'SF Mono','Menlo','Monaco',monospace;
}
html.light{
  color-scheme:light;
  --bg:#f4f4f0; --s1:#ffffff; --s2:#eeefeb; --brd:rgba(26,31,29,.11); --brd2:rgba(26,31,29,.22);
  --txt:#171a18; --dim:#686f6b; --dim2:#909692;
  --acc:#76642f; --acc2:#59491f;
  --g:#188958; --y:#9b6714; --o:#b6532b; --r:#c43d48; --b:#167e78; --p:#70559d;
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

/* Premium production workspace */
body::before{
  content:'';position:fixed;inset:0;pointer-events:none;opacity:.14;
  background-image:linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px);
  background-size:44px 44px;mask-image:linear-gradient(to bottom,#000,transparent 78%)
}
html.light body::before{opacity:.2}
header{height:auto;min-height:94px;padding:0;display:flex;flex-direction:column;align-items:stretch;gap:0;background:rgba(12,15,17,.94);backdrop-filter:blur(18px)}
html.light header{background:rgba(255,255,255,.94)}
.header-primary{height:55px;padding:0 16px;display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--brd)}
.brand-lockup{display:flex;align-items:center;gap:10px;min-width:224px}
.logo-icon{position:relative;width:32px;height:32px;border:1px solid rgba(215,195,141,.5);border-radius:5px;background:#11130f;color:var(--acc);box-shadow:inset 0 0 0 3px #090a08,0 0 20px rgba(215,195,141,.08)}
.logo-icon::after{content:'';position:absolute;inset:5px;border:1px solid rgba(215,195,141,.16)}
.logo-icon span{position:relative;z-index:1;font-size:13px;font-weight:700}
html.light .logo-icon{background:#f4f0e3;box-shadow:inset 0 0 0 3px #fff}
.brand-copy{display:flex;flex-direction:column;gap:1px}
.brand-copy strong{font-size:13px;font-weight:600;letter-spacing:0}
.brand-copy span,.rail-label,.section-index{font-size:7px;font-weight:700;letter-spacing:.15em;color:var(--dim2)}
.live-badge{height:24px;padding:0 9px;border-radius:4px;text-transform:uppercase;font-size:8px;font-weight:700;letter-spacing:.1em}
.stat-grp{height:100%;gap:0;border-left:1px solid var(--brd);border-right:1px solid var(--brd)}
.stat{min-width:78px;height:100%;padding:9px 13px;text-align:left;border-right:1px solid var(--brd);display:flex;flex-direction:column;justify-content:center;gap:3px}
.stat-val{font-size:13px;line-height:1.1}
.stat-lbl{order:-1;margin:0;font-size:7px;font-weight:700;letter-spacing:.12em}
.rate-wrap{height:100%;padding:0 12px;gap:8px}
.rate-lbl{font-size:7px;font-weight:700;letter-spacing:.1em;line-height:1.4}
.header-primary>.rail-label{margin-left:auto;color:var(--dim)}
.command-rail{height:39px;padding:0 12px 0 16px;display:flex;align-items:center;gap:6px;overflow-x:auto;overflow-y:hidden}
.command-rail::-webkit-scrollbar{height:0}
.command-rail>.rail-label{margin-right:3px;white-space:nowrap}
.rail-spacer{flex:1;min-width:12px}
.shortcut-wrap{position:relative}
.sep{height:20px}
.hbtn{height:26px;padding:0 9px;border-radius:4px;background:rgba(255,255,255,.025);font-size:10px;font-weight:500}
.hbtn svg{flex-shrink:0}
.hbtn.icon-only{width:28px;padding:0;justify-content:center}
.hbtn.active{background:rgba(215,195,141,.1);border-color:rgba(215,195,141,.35);color:var(--acc)}
.badge-cnt{background:var(--acc);color:#11140f;border-radius:3px;font-size:8px}
.shortcut-popup{top:33px;border-radius:6px;background:var(--s1)}

main{position:relative}
#sidebar{width:310px;background:rgba(16,19,23,.9);backdrop-filter:blur(12px)}
html.light #sidebar{background:rgba(255,255,255,.92)}
.sb-top{padding:14px 12px 0}
.sb-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.sb-heading>div{display:flex;align-items:center;gap:9px}
.sb-heading strong{font-size:12px;font-weight:600}
.sb-heading>span{font-size:7px;font-weight:700;letter-spacing:.13em;color:var(--g)}
.section-index{color:var(--acc)}
.search-wrap{margin-bottom:9px}
#search{height:34px;padding-left:31px;border-radius:4px;background:rgba(0,0,0,.16);font-size:11px}
html.light #search{background:var(--s2)}
.filter-bar{gap:5px;padding-bottom:10px}
.fbtn{height:24px;padding:0 8px;border-radius:3px;font-size:9px;font-weight:600}
.fbtn.on{color:#11140f}
html.light .fbtn.on{color:#fff}
.fbtn.all.on{background:var(--acc)}
.fbtn.pin.on{background:var(--y)}
.sb-cnt{padding:7px 12px;background:rgba(0,0,0,.1)}
.cnt-lbl{font-size:8px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}
.cnt-num{color:var(--txt);font-size:10px}
.reqrow{padding:11px 12px;gap:5px 7px;border-left-width:2px;background:transparent}
.reqrow:hover{background:rgba(215,195,141,.035)}
.reqrow.active{background:rgba(215,195,141,.07);border-left-color:var(--acc)}
.method{border-radius:3px;font-size:9px}
.rpath{font-size:11px}
.rstatus{font-size:10px;border-radius:3px}
.pin-btn{font-size:0;width:15px;height:15px;position:relative}
.pin-btn::before{content:'';position:absolute;left:5px;top:2px;width:5px;height:8px;border:1px solid currentColor;border-radius:1px;transform:rotate(45deg)}
.rmeta{gap:7px}
.port-badge,.mock-tag{border-radius:2px}
.wfall{height:1px}
.empty-state{height:100%;padding:34px 26px;gap:9px}
.empty-icon{position:relative;width:54px;height:54px;border-radius:50%;background:transparent}
.empty-icon::before{content:'';position:absolute;inset:12px;border:1px solid var(--brd2);border-radius:50%;box-shadow:0 0 24px rgba(110,219,208,.08)}
.empty-icon::after{content:'';position:absolute;left:9px;right:9px;top:26px;height:1px;background:var(--brd2);box-shadow:0 -9px 0 -8px var(--brd2),0 9px 0 -8px var(--brd2)}
.empty-title{font-size:12px;font-weight:600;color:var(--txt)}
.empty-sub{max-width:220px;font-size:10px}

#resize-handle{width:5px}
#resize-handle:hover,#resize-handle.resizing{background:var(--acc)}
#detail-pane{position:relative;background:rgba(8,10,12,.82)}
html.light #detail-pane{background:rgba(244,244,240,.84)}
.no-sel{gap:8px;text-align:center;padding:30px}
.no-sel-art{position:relative;width:90px;height:70px;margin-bottom:12px}
.no-sel-art::before,.no-sel-art::after,.no-sel-art span{content:'';position:absolute;border:1px solid var(--brd2);background:rgba(255,255,255,.012)}
.no-sel-art::before{inset:8px 20px 12px 0}
.no-sel-art::after{inset:0 0 20px 28px}
.no-sel-art span{left:18px;right:8px;top:20px;height:1px;border:0;background:var(--acc);box-shadow:0 13px 0 var(--brd2),0 26px 0 var(--brd2);opacity:.55}
.no-sel-eyebrow{font-size:7px;font-weight:700;letter-spacing:.15em;color:var(--acc)}
.no-sel-title{font-size:15px;font-weight:600;color:var(--txt)}
.no-sel-txt{max-width:360px;font-size:10px;line-height:1.6}
.det-head{min-height:62px;padding:13px 18px;background:rgba(16,19,23,.92)}
html.light .det-head{background:rgba(255,255,255,.92)}
.det-method{margin-top:1px}
.det-url{font-size:12px;line-height:1.5}
.chip,.chip-ip,.chip-size,.chip-mock{border-radius:3px}
.tabs{min-height:43px;padding:0 16px;background:rgba(16,19,23,.9);gap:4px}
html.light .tabs{background:rgba(255,255,255,.9)}
.tab{padding:13px 9px 11px;font-size:10px;text-transform:uppercase;letter-spacing:.06em}
.tab.on{color:var(--acc);border-bottom-color:var(--acc)}
.action-btn{height:26px;padding:0 8px;border-radius:4px;font-size:9px;background:rgba(255,255,255,.025)}
.action-btn.replay-btn{background:var(--acc);border-color:var(--acc);color:#11140f}
.action-btn.replay-btn:hover{background:var(--acc2)}
html.light .action-btn.replay-btn{color:#fff}
.action-btn.curl-btn{color:var(--b);border-color:rgba(110,219,208,.22);background:rgba(110,219,208,.05)}
.action-btn.edit-btn{color:var(--y);border-color:rgba(230,184,106,.22);background:rgba(230,184,106,.05)}
.action-btn.mock-btn{color:var(--p);border-color:rgba(185,167,223,.22);background:rgba(185,167,223,.05)}
.tab-body{padding:18px 20px}
.section{margin-bottom:22px}
.sec-title{font-size:8px;letter-spacing:.12em;margin-bottom:9px;color:var(--dim)}
.htable{border-radius:4px;background:rgba(16,19,23,.72)}
html.light .htable{background:#fff}
.htable td{padding:7px 11px;font-size:10.5px}
.htable td:first-child{color:var(--b);background:rgba(110,219,208,.025)}
.body-view{border-radius:4px;padding:14px;background:rgba(16,19,23,.84);font-size:10.5px;line-height:1.75}
html.light .body-view{background:#fff}
.modal{border-radius:6px;background:var(--s1)}
.modal-head{padding:15px 18px}
.modal-title{font-size:13px}
.form-group input,.form-group select,.form-group textarea{border-radius:4px}
.btn-ghost,.btn-primary{border-radius:4px}
.btn-primary{background:var(--acc);color:#11140f;font-weight:600}
html.light .btn-primary{color:#fff}

@media(max-width:1050px){
  .brand-lockup{min-width:auto}.brand-copy span,.header-primary>.rail-label,.rate-wrap{display:none}
  .stat{min-width:64px;padding:8px 10px}.command-rail{padding-left:12px}.rail-spacer{min-width:4px}
}
@media(max-width:760px){
  .header-primary{padding:0 10px;gap:7px}.brand-copy{display:none}.stat-grp{margin-left:0}.stat{min-width:54px;padding:7px 8px}.stat-lbl{display:none}
  .header-primary .hbtn{width:28px;padding:0;justify-content:center;font-size:0}.header-primary .hbtn svg{width:12px;height:12px}
  .command-rail .rail-label{display:none}#sidebar{width:250px}.tabs{overflow-x:auto}.tab-spacer{min-width:8px}.action-btn{font-size:0;width:28px;justify-content:center;padding:0}.action-btn svg{width:11px;height:11px}.action-btn.replay-btn{margin-left:2px}
}
`;
