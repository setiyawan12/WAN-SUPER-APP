'use strict';

/** Inspector browser-side JavaScript — extracted from inspector-html.js */
module.exports = `
// ── State ─────────────────────────────────────────────────────────────────────
let reqs=[], sel=null, curtab='req';
let paused=false, pauseQueue=[];
let statusFilter='all', portFilter='all', notifEnabled=false;

// ── Persist helpers ────────────────────────────────────────────────────────────
const LS = {
  get: (k,def='') => { try { return localStorage.getItem(k)??def; } catch { return def; } },
  set: (k,v)      => { try { localStorage.setItem(k,v); } catch {} },
};

// ── Virtual scroll state ───────────────────────────────────────────────────────
const VS_PAGE = 80;   // rows rendered on first pass
const VS_STEP = 50;   // additional rows loaded per sentinel trigger
let _vsCount  = VS_PAGE;
let _vsObs    = null; // IntersectionObserver for sentinel
const pinned=new Set();
let mockList=[], injectList=[];
let editLocalPort=null;
let timelineMode=false;

// ── EventSource ───────────────────────────────────────────────────────────────
let _renderTimer=null;
// Debounce render: batch event yang datang dalam 80ms jadi satu render
function schedRender(){ clearTimeout(_renderTimer); _renderTimer=setTimeout(render,80); }

const es=new EventSource('/stream');
es.addEventListener('msg',e=>{
  const m=JSON.parse(e.data);
  if(m.type==='init'){
    reqs=m.data||[]; mockList=m.mocks||[]; injectList=m.inject||[];
    // Restore persisted filter/search state
    statusFilter=LS.get('insp-status-filter','all');
    portFilter=LS.get('insp-port-filter','all');
    const savedQ=LS.get('insp-search','');
    if(savedQ) document.getElementById('search').value=savedQ;
    // Sync filter button .on classes to restored statusFilter
    const sfCls=statusFilter==='all'?'all':statusFilter==='pin'?'pin':'f'+statusFilter;
    document.querySelectorAll('.fbtn').forEach(b=>b.classList.toggle('on',b.classList.contains(sfCls)));
    render(); updateStats(); updateMocksBadge(); updateInjectBadge();
  }
  if(m.type==='req'){
    if(paused){ pauseQueue.push(m.data); updatePauseBtn(); }
    else{
      const isFirst=!sel;
      reqs.unshift(m.data);
      prependRow(m.data);     // O(1) DOM insert, tanpa rebuild seluruh list
      updateStats();
      if(isFirst) pick(m.data.id);
      notify(m.data);
    }
  }
  if(m.type==='clear'){ reqs=[]; sel=null; pauseQueue=[]; render(); updateStats(); showNoSel(); updatePauseBtn(); }
  if(m.type==='mocks'){ mockList=m.data||[]; updateMocksBadge(); }
  if(m.type==='inject'){ injectList=m.data||[]; updateInjectBadge(); }
});
es.onopen=()=>setLive(true);
es.onerror=()=>setLive(false);

function setLive(on){
  const b=document.getElementById('badge');
  b.className='live-badge'+(on?'':' off');
  document.getElementById('badge-txt').textContent=on?'live':'connecting';
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function updateStats(){
  document.getElementById('s-total').textContent=reqs.length;
  const done=reqs.filter(r=>r.ms!=null);
  document.getElementById('s-avg').textContent=done.length?Math.round(done.reduce((a,r)=>a+r.ms,0)/done.length)+'ms':'—';
  document.getElementById('s-err').textContent=reqs.filter(r=>r.status>=400).length;
  updateRateChart();
}

// ── Request rate sparkline ────────────────────────────────────────────────────
function updateRateChart(){
  const svg=document.getElementById('rate-chart');
  if(!svg) return;
  const now=Date.now(), buckets=new Array(10).fill(0);
  for(const r of reqs){
    const age=(now-new Date(r.time).getTime())/60000;
    if(age>=0&&age<10) buckets[Math.floor(age)]++;
  }
  // buckets[0]=most recent, draw right→left
  const max=Math.max(...buckets,1);
  const BW=6,BG=2,H=24,PY=2;
  svg.innerHTML=buckets.slice().reverse().map((v,i)=>{
    const bh=Math.max(2,Math.round((v/max)*(H-PY)));
    const x=2+i*(BW+BG), y=H-bh;
    const fill=(v===max&&max>1)?'var(--r)':'var(--acc)';
    return\`<rect x="\${x}" y="\${y}" width="\${BW}" height="\${bh}" rx="1" fill="\${fill}" opacity=".75"><title>\${v} req (\${10-i}min ago)</title></rect>\`;
  }).join('');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function mc(m){return['GET','POST','PUT','DELETE','PATCH','HEAD','OPTIONS'].includes(m)?m:'OTHER';}
function statusClass(s){if(s===0)return'sabrt';if(!s)return'sunk';if(s<300)return's2xx';if(s<400)return's3xx';if(s<500)return's4xx';return's5xx';}
function msColor(ms){if(ms==null)return'#555';if(ms<200)return'#34d399';if(ms<500)return'#fbbf24';return'#f97316';}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function escAttr(s){return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function isJSON(s){try{JSON.parse(s);return true;}catch{return false;}}
function formatSize(n){if(n==null)return'';if(n<1024)return n+'B';if(n<1048576)return(n/1024).toFixed(1)+'KB';return(n/1048576).toFixed(1)+'MB';}
function sizeColor(n){if(n<10240)return'var(--dim2)';if(n<102400)return'var(--y)';return'var(--r)';}
function relTime(iso){const d=Date.now()-new Date(iso).getTime();if(d<60000)return Math.round(d/1000)+'s ago';if(d<3600000)return Math.round(d/60000)+'m ago';return new Date(iso).toLocaleTimeString();}
function highlightJSON(str){
  try{
    const p=JSON.stringify(JSON.parse(str),null,2);
    return p.replace(/("(\\\\u[a-zA-Z0-9]{4}|\\\\[^u]|[^\\\\"])*"(\\s*:)?|\\b(true|false|null)\\b|-?\\d+(?:\\.\\d*)?(?:[eE][+\\-]?\\d+)?)/g,m=>{
      let c='jn';
      if(/^"/.test(m)){if(/:$/.test(m))c='jk';else c='js';}
      else if(/true|false/.test(m))c='jb';
      else if(/null/.test(m))c='jl';
      return \`<span class="\${c}">\${esc(m)}</span>\`;
    });
  }catch{return esc(str);}
}

// ── Visible reqs helper (shared by render + keyboard nav) ─────────────────────
function getVisibleReqs(){
  const q=document.getElementById('search').value.toLowerCase();
  return reqs.filter(r=>matchFilter(r)&&(!q||
    r.url.toLowerCase().includes(q)||
    r.method.toLowerCase().includes(q)||
    (r.localPort&&String(r.localPort).includes(q))||
    (r.reqBody&&r.reqBody.toLowerCase().includes(q))||
    (r.resBody&&r.resBody.toLowerCase().includes(q))
  ));
}

// ── Filter ────────────────────────────────────────────────────────────────────
function onSearchInput(){
  LS.set('insp-search', document.getElementById('search').value);
  _vsCount=VS_PAGE; render();
}
function setFilter(f,btn){
  statusFilter=f;
  LS.set('insp-status-filter',f);
  document.querySelectorAll('.fbtn').forEach(b=>b.classList.remove('on'));
  btn.classList.add('on'); render();
}
function matchFilter(r){
  if(portFilter!=='all'&&r.localPort!==portFilter) return false;
  if(statusFilter==='all') return true;
  if(statusFilter==='pin') return pinned.has(r.id);
  const s=r.status||0;
  if(statusFilter==='2xx') return s>=200&&s<300;
  if(statusFilter==='3xx') return s>=300&&s<400;
  if(statusFilter==='4xx') return s>=400&&s<500;
  if(statusFilter==='5xx') return s>=500;
  return true;
}
function setPortFilter(p){
  portFilter=p;
  LS.set('insp-port-filter',p);
  render();
}
function updatePortBar(){
  const ports=[...new Set(reqs.map(r=>r.localPort).filter(Boolean))].sort((a,b)=>{
    const na=!isNaN(a),nb=!isNaN(b);
    if(na&&nb) return Number(a)-Number(b);
    return String(a).localeCompare(String(b));
  });
  const bar=document.getElementById('port-bar');
  if(ports.length<=1){bar.style.display='none';return;}
  bar.style.display='flex';
  bar.innerHTML=
    \`<button class="fbtn\${portFilter==='all'?' on':''}" onclick="setPortFilter('all')">All</button>\`+
    ports.map(p=>\`<button class="fbtn\${portFilter===p?' on':''}" onclick="setPortFilter(\${JSON.stringify(p)})">\${!isNaN(p)?':'+p:p}</button>\`).join('');
}

// ── Pause ─────────────────────────────────────────────────────────────────────
function togglePause(){
  paused=!paused;
  if(!paused&&pauseQueue.length>0){
    pauseQueue.reverse().forEach(r=>reqs.unshift(r));
    pauseQueue=[]; render(); updateStats();
  }
  updatePauseBtn();
}
function updatePauseBtn(){
  const btn=document.getElementById('pause-btn');
  if(paused){
    btn.className='hbtn pause-on';
    btn.innerHTML=\`<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg> Resume\${pauseQueue.length?\` <span class="badge-cnt">\${pauseQueue.length}</span>\`:''}\`;
  } else {
    btn.className='hbtn';
    btn.innerHTML='<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Pause';
  }
}

// ── Notifications ─────────────────────────────────────────────────────────────
// Gunakan Electron native Notification via postMessage → launcher → IPC → main.
// Web Notification API tidak reliable di production macOS build (cross-origin
// iframe + hardenedRuntime menyebabkan permission selalu denied/tidak muncul).
function toggleNotif(){
  notifEnabled=!notifEnabled;
  document.getElementById('notif-btn').className=notifEnabled?'hbtn active':'hbtn';
}
function notify(r){
  if(!notifEnabled) return;
  const status=r.status||'…';
  try{
    window.parent.postMessage({
      type :'wan-net-notify',
      title:'WAN NET — Request Masuk',
      body :\`\${r.method} \${r.url} → \${status}\`,
    },'*');
  }catch{}
}

// ── Export HAR (exports visible/filtered requests) ────────────────────────────
function exportHAR(){
  const toExport=getVisibleReqs().filter(r=>r.status);
  const entries=toExport.map(r=>({
    startedDateTime:r.time,time:r.ms||0,
    request:{method:r.method,url:'http://tunnel'+r.url,httpVersion:'HTTP/1.1',
      headers:Object.entries(r.reqHeaders||{}).map(([name,value])=>({name,value:String(value)})),
      queryString:[],bodySize:r.reqBody?r.reqBody.length:-1,
      ...(r.reqBody?{postData:{mimeType:r.reqHeaders?.['content-type']||'text/plain',text:r.reqBody}}:{})},
    response:{status:r.status,statusText:'',httpVersion:'HTTP/1.1',
      headers:Object.entries(r.resHeaders||{}).map(([name,value])=>({name,value:String(value)})),
      content:{size:r.size||0,mimeType:r.resHeaders?.['content-type']||'text/plain',text:r.resBody||''},
      bodySize:r.size||-1,redirectURL:'',headersSize:-1},
    timings:{send:0,wait:r.ms||0,receive:0},cache:{},
  }));
  const blob=new Blob([JSON.stringify({log:{version:'1.2',creator:{name:'WAN NET',version:'1.0'},entries}},null,2)],{type:'application/json'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=\`wan-net-\${toExport.length}req-\${new Date().toISOString().slice(0,10)}.har\`;
  a.click(); URL.revokeObjectURL(a.href);
}

// ── Export Postman Collection v2.1 ────────────────────────────────────────────
function exportPostman(){
  const toExport=getVisibleReqs().filter(r=>r.status);
  const items=toExport.map(r=>{
    const rawUrl=r.url||'/';
    const qIdx=rawUrl.indexOf('?');
    const pathStr=qIdx>=0?rawUrl.slice(0,qIdx):rawUrl;
    const queryStr=qIdx>=0?rawUrl.slice(qIdx+1):'';
    const pathArr=pathStr.split('/').filter(Boolean);
    const queryArr=queryStr?queryStr.split('&').map(p=>{
      const sep=p.indexOf('=');
      return{key:decodeURIComponent(sep>=0?p.slice(0,sep):p),
             value:decodeURIComponent(sep>=0?p.slice(sep+1):'')};
    }):[];
    const skipHdrs=new Set(['host','connection','content-length','transfer-encoding']);
    const hdrs=Object.entries(r.reqHeaders||{})
      .filter(([k])=>!skipHdrs.has(k.toLowerCase()))
      .map(([key,value])=>({key,value:String(value)}));
    const urlObj={raw:'{{base_url}}'+rawUrl,host:['{{base_url}}'],path:pathArr,query:queryArr};
    return{
      name:r.method+' '+rawUrl.slice(0,80),
      request:{
        method:r.method, header:hdrs, url:urlObj,
        ...(r.reqBody&&r.reqBody.trim()
          ?{body:{mode:'raw',raw:r.reqBody,options:{raw:{language:isJSON(r.reqBody)?'json':'text'}}}}
          :{}),
      },
      response:[{
        name:'Actual response',
        status:'',code:r.status||0,
        header:Object.entries(r.resHeaders||{}).map(([key,value])=>({key,value:String(value)})),
        body:r.resBody||'',
        _postman_previewlanguage:isJSON(r.resBody||'')?'json':'text',
        originalRequest:{method:r.method,header:hdrs,url:urlObj},
      }],
    };
  });
  const col={
    info:{
      name:'WAN NET Export',
      schema:'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      _postman_id:Math.random().toString(36).slice(2),
    },
    item:items,
    variable:[{key:'base_url',value:'http://localhost',type:'string'}],
  };
  const blob=new Blob([JSON.stringify(col,null,2)],{type:'application/json'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=\`wan-net-\${toExport.length}req-\${new Date().toISOString().slice(0,10)}.postman_collection.json\`;
  a.click(); URL.revokeObjectURL(a.href);
}

// ── Mocks badge ───────────────────────────────────────────────────────────────
function updateMocksBadge(){
  const cnt=document.getElementById('mocks-cnt');
  cnt.textContent=mockList.length;
  cnt.style.display=mockList.length?'inline':'none';
}

// ── Row builder (shared by render + prependRow) ───────────────────────────────
function makeRow(r, maxMs){
  const d=document.createElement('div');
  d.className='reqrow'+(r.id===sel?' active':'');
  d.dataset.id=r.id; d.onclick=()=>pick(r.id);
  const sc=statusClass(r.status), msc=msColor(r.ms);
  const pct=r.ms?Math.max(2,Math.round((r.ms/maxMs)*100)):0;
  d.innerHTML=\`
    <span class="method m\${mc(r.method)}">\${r.method}</span>
    <span class="rpath">\${esc(r.url)}</span>
    <span class="rstatus \${sc}" style="\${r.status?'':'color:var(--dim2)'}">\${r.status||'…'}</span>
    <button class="pin-btn\${pinned.has(r.id)?' on':''}" onclick="togglePin(event,'\${r.id}')">📌</button>
    <div class="rmeta">
      <span class="rtime" data-time="\${esc(r.time)}">\${relTime(r.time)}</span>
      \${r.localPort?(\`<span class="port-badge">\${!isNaN(r.localPort)?':'+r.localPort:r.localPort}</span>\`):''}
      \${r.mocked?'<span class="mock-tag">mock</span>':''}
      \${r.ms!=null
        ?\`<span class="rms" style="color:\${msc}">\${r.ms}ms</span>
          \${r.size!=null?\`<span class="rsize" style="color:\${sizeColor(r.size)}">\${formatSize(r.size)}</span>\`:''}\`
        :'<span style="color:var(--dim2);font-size:10px">pending…</span>'}
    </div>
    \${r.ms!=null?\`<div class="wfall" style="width:\${pct}%;background:\${msc}"></div>\`:''}\`;
  return d;
}

// ── Incremental prepend — O(1) DOM insert for a single new request ────────────
function prependRow(r){
  if(!matchFilter(r)) return; // hidden by current filter — skip
  if(timelineMode){ render(); return; } // timeline needs full rebuild
  const list=document.getElementById('reqlist');
  const maxMs=Math.max(...reqs.filter(x=>x.ms!=null).map(x=>x.ms),1);
  list.insertBefore(makeRow(r,maxMs), list.firstChild);
  _vsCount++; // new row prepended at top → visible window expands by 1 to match
  document.getElementById('empty').style.display='none';
  const cnt=document.getElementById('cnt');
  cnt.textContent=parseInt(cnt.textContent||'0',10)+1; // O(1) vs querySelectorAll
  updatePortBar();
}

// ── Full render — used on init / clear / filter change ────────────────────────
function render(){
  const f=getVisibleReqs();
  updatePortBar();
  document.getElementById('cnt').textContent=f.length;
  if(timelineMode){ renderTimeline(f); if(sel){const r=reqs.find(x=>x.id===sel);if(r)drawDetail(r);} return; }
  document.getElementById('empty').style.display=f.length?'none':'flex';
  _vsCount=VS_PAGE; // reset virtual scroll window on every full render
  _renderSlice(f);
  if(sel){const r=reqs.find(x=>x.id===sel);if(r)drawDetail(r);}
}

/** Render up to _vsCount rows from filtered list, attach sentinel for lazy-load. */
function _renderSlice(f){
  const list=document.getElementById('reqlist');
  // Remove existing rows + old sentinel
  [...list.querySelectorAll('.reqrow,.vs-sentinel')].forEach(e=>e.remove());
  const slice=f.slice(0,_vsCount);
  const maxMs=Math.max(...f.filter(r=>r.ms!=null).map(r=>r.ms),1);
  slice.forEach(r=>list.appendChild(makeRow(r,maxMs)));

  // Disconnect previous observer
  if(_vsObs){ _vsObs.disconnect(); _vsObs=null; }

  if(f.length>_vsCount){
    // Append sentinel — when it enters viewport, load next batch
    const sentinel=document.createElement('div');
    sentinel.className='vs-sentinel';
    sentinel.style.cssText='height:1px;width:100%';
    list.appendChild(sentinel);
    _vsObs=new IntersectionObserver(entries=>{
      if(!entries[0].isIntersecting) return;
      _vsCount+=VS_STEP;
      _renderSlice(getVisibleReqs());
    },{root:list,rootMargin:'120px'});
    _vsObs.observe(sentinel);
  }
}

function togglePin(e,id){e.stopPropagation();if(pinned.has(id))pinned.delete(id);else pinned.add(id);render();}

// ── Pick / deselect ───────────────────────────────────────────────────────────
function pick(id){
  sel=id;
  document.querySelectorAll('.reqrow').forEach(e=>e.classList.toggle('active',e.dataset.id===id));
  document.getElementById('nosel').style.display='none';
  document.getElementById('detail').style.display='flex';
  const r=reqs.find(x=>x.id===id); if(r) drawDetail(r);
}
function showNoSel(){
  sel=null;
  document.getElementById('nosel').style.display='flex';
  document.getElementById('detail').style.display='none';
}

// ── Detail header ─────────────────────────────────────────────────────────────
function drawDetail(r){
  const sc=statusClass(r.status);
  const ip=r.reqHeaders?.['cf-connecting-ip']||r.reqHeaders?.['x-forwarded-for']||'';
  document.getElementById('det-head').innerHTML=\`
    <span class="method det-method m\${mc(r.method)}">\${r.method}</span>
    <span class="det-url">\${esc(r.url)}</span>
    <div class="det-meta">
      \${ip?\`<span class="chip-ip">\${esc(ip.split(',')[0].trim())}</span>\`:''}
      \${r.localPort?\`<span class="chip-ip">:\${r.localPort}</span>\`:''}
      \${r.mocked?'<span class="chip-mock">mocked</span>':''}
      <span class="chip \${sc}">\${r.status||'—'}</span>
      \${r.ms!=null?\`<span class="chip-ms" style="color:\${msColor(r.ms)}">\${r.ms}ms</span>\`:''}
      \${r.size!=null?\`<span class="chip-size">\${formatSize(r.size)}</span>\`:''}
    </div>\`;
  drawTab(r);
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
function setTab(name,el){
  curtab=name;
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('on'));
  el.classList.add('on');
  const r=reqs.find(x=>x.id===sel); if(r) drawTab(r);
}
function drawTab(r){
  const el=document.getElementById('tab-body');
  if(curtab==='req')         el.innerHTML=renderHeaders(r.reqHeaders)+renderBody(r.reqBody);
  else if(curtab==='res')    el.innerHTML=renderHeaders(r.resHeaders)+renderBody(r.resBody);
  else if(curtab==='preview') el.innerHTML=renderPreview(r);
  else el.innerHTML=\`<div class="section"><div class="sec-title">Raw Request</div>
    <pre class="body-view">\${esc(r.method+' '+r.url+' HTTP/1.1\\n'+
      Object.entries(r.reqHeaders||{}).map(([k,v])=>k+': '+v).join('\\n')+
      (r.reqBody?'\\n\\n'+r.reqBody:''))}</pre></div>\`;
}
function renderHeaders(h){
  if(!h||!Object.keys(h).length) return'<div class="section"><div class="sec-title">Headers</div><p class="nobody">No headers</p></div>';
  const rows=Object.entries(h).map(([k,v])=>
    \`<tr><td>\${esc(k)}</td><td>\${esc(String(v))}<button class="copy-btn" data-val="\${escAttr(String(v))}" onclick="copyAttr(event)">copy</button></td></tr>\`
  ).join('');
  return\`<div class="section"><div class="sec-title">Headers</div><table class="htable">\${rows}</table></div>\`;
}
function renderBody(b){
  if(!b||!b.trim()) return'<div class="section"><div class="sec-title">Body</div><p class="nobody">Empty body</p></div>';
  const json=isJSON(b);
  const code=json
    ?\`<div class="body-view json">\${highlightJSON(b)}<button class="body-copy" data-val="\${escAttr(b)}" onclick="copyAttr(event)">copy</button></div>\`
    :\`<pre class="body-view">\${esc(b)}<button class="body-copy" data-val="\${escAttr(b)}" onclick="copyAttr(event)">copy</button></pre>\`;
  return\`<div class="section"><div class="sec-title">Body \${json?'<span style="color:var(--acc2);font-size:10px;font-weight:500;text-transform:none;letter-spacing:0">JSON</span>':''}</div>\${code}</div>\`;
}
function _copyText(text){
  // navigator.clipboard requires permission in Electron; fallback ke execCommand
  if(navigator.clipboard&&navigator.clipboard.writeText){
    return navigator.clipboard.writeText(text).catch(()=>_copyFallback(text));
  }
  return Promise.resolve(_copyFallback(text));
}
function _copyFallback(text){
  const ta=document.createElement('textarea');
  ta.value=text; ta.style.cssText='position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.appendChild(ta); ta.focus(); ta.select();
  try{document.execCommand('copy');}catch{}
  document.body.removeChild(ta);
}
function copyAttr(e){
  e.stopPropagation();
  const btn=e.currentTarget, val=btn.dataset.val, orig=btn.textContent;
  _copyText(val).then(()=>{btn.textContent='✓';setTimeout(()=>btn.textContent=orig,1200);});
}

// ── Replay ────────────────────────────────────────────────────────────────────
async function replayReq(){
  if(!sel) return;
  const btn=document.getElementById('replay-btn');
  btn.disabled=true; btn.className='action-btn replay-btn';
  btn.innerHTML='… Sending';
  try{
    const d=await(await fetch('/replay',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:sel})})).json();
    btn.className='action-btn replay-btn '+(d.ok?'ok':'err');
    btn.innerHTML=d.ok?\`✓ \${d.status}\`:'✗ Failed';
  }catch{ btn.className='action-btn replay-btn err'; btn.innerHTML='✗ Error'; }
  setTimeout(()=>{btn.disabled=false;btn.className='action-btn replay-btn';btn.innerHTML='<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg> Replay';},2500);
}

// ── Edit & Replay modal ───────────────────────────────────────────────────────
function openEditReplay(){
  if(!sel) return;
  const r=reqs.find(x=>x.id===sel); if(!r) return;
  editLocalPort=r.localPort||null;
  openModal('Edit & Replay',\`
    <div class="form-row">
      <div class="form-group" style="flex:0 0 110px"><label>Method</label>
        <select id="ed-method"><option>GET</option><option>POST</option><option>PUT</option><option>DELETE</option><option>PATCH</option><option>HEAD</option></select></div>
      <div class="form-group"><label>URL / Path</label><input type="text" id="ed-url"></div>
    </div>
    <div class="form-group" style="margin-bottom:12px"><label>Headers <span class="form-hint">(JSON object)</span></label>
      <textarea id="ed-headers" rows="6" spellcheck="false"></textarea></div>
    <div class="form-group"><label>Body</label><textarea id="ed-body" rows="5" spellcheck="false"></textarea></div>
    <div class="modal-footer">
      <button class="btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" id="ed-send-btn" onclick="sendEditReplay()">▶ Send</button>
    </div>\`);
  document.getElementById('ed-method').value=r.method;
  document.getElementById('ed-url').value=r.url;
  const h={...r.reqHeaders}; delete h['host']; delete h['connection']; delete h['content-length'];
  document.getElementById('ed-headers').value=JSON.stringify(h,null,2);
  document.getElementById('ed-body').value=r.reqBody||'';
}
async function sendEditReplay(){
  const method=document.getElementById('ed-method').value;
  const url=document.getElementById('ed-url').value.trim();
  if(!url){alert('URL tidak boleh kosong');return;}
  let headers={};
  try{ headers=JSON.parse(document.getElementById('ed-headers').value||'{}'); }
  catch{ alert('Headers bukan JSON valid'); return; }
  const bodyStr=document.getElementById('ed-body').value;
  const bodyB64=bodyStr?btoa(unescape(encodeURIComponent(bodyStr))):'';
  const btn=document.getElementById('ed-send-btn');
  btn.disabled=true; btn.textContent='Sending…';
  try{
    const d=await(await fetch('/replay-custom',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({method,url,headers,bodyB64,localPort:editLocalPort})})).json();
    btn.textContent=d.ok?\`✓ \${d.status}\`:'✗ Failed';
    if(d.ok) setTimeout(closeModal,1000);
  }catch{ btn.textContent='✗ Error'; }
  btn.disabled=false;
}

// ── Mock modal ────────────────────────────────────────────────────────────────
function openMockFromReq(){
  if(!sel) return;
  const r=reqs.find(x=>x.id===sel); if(!r) return;
  openMockEditor({method:r.method,path:r.url.split('?')[0],status:r.status||200,
    headers:JSON.stringify(r.resHeaders||{'content-type':'application/json'},null,2),body:r.resBody||''});
}
function openMockEditor(p){
  openModal('Create / Edit Mock',\`
    <div class="form-row">
      <div class="form-group" style="flex:0 0 110px"><label>Method</label>
        <select id="mk-method"><option>GET</option><option>POST</option><option>PUT</option><option>DELETE</option><option>PATCH</option></select></div>
      <div class="form-group"><label>Path pattern</label><input type="text" id="mk-path" placeholder="/api/endpoint">
        <span class="form-hint">Exact match atau tanpa query string</span></div>
    </div>
    <div class="form-group" style="margin-bottom:12px"><label>Status code</label>
      <input type="number" id="mk-status" min="100" max="599" style="width:100px"></div>
    <div class="form-group" style="margin-bottom:12px"><label>Delay <span class="form-hint">(ms — simulate slow network, 0 = instant)</span></label>
      <input type="number" id="mk-delay" min="0" max="30000" value="0" style="width:120px"></div>
    <div class="form-group" style="margin-bottom:12px"><label>Response Headers <span class="form-hint">(JSON)</span></label>
      <textarea id="mk-headers" rows="4" spellcheck="false"></textarea></div>
    <div class="form-group"><label>Response Body</label>
      <textarea id="mk-body" rows="5" spellcheck="false"></textarea></div>
    <div class="modal-footer">
      <button class="btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" id="mk-save-btn" onclick="saveMock()">💾 Save Mock</button>
    </div>\`);
  if(p){
    document.getElementById('mk-method').value=p.method;
    document.getElementById('mk-path').value=p.path||'';
    document.getElementById('mk-status').value=p.status||200;
    document.getElementById('mk-delay').value=p.delayMs||0;
    document.getElementById('mk-headers').value=p.headers||'{"content-type":"application/json"}';
    document.getElementById('mk-body').value=p.body||'';
  }
}
async function saveMock(){
  const method=document.getElementById('mk-method').value;
  const path=document.getElementById('mk-path').value.trim();
  if(!path){alert('Path tidak boleh kosong');return;}
  const status=parseInt(document.getElementById('mk-status').value)||200;
  let headers={};
  try{ headers=JSON.parse(document.getElementById('mk-headers').value||'{}'); }
  catch{ alert('Headers bukan JSON valid'); return; }
  const body=document.getElementById('mk-body').value;
  const delayMs=parseInt(document.getElementById('mk-delay').value)||0;
  const btn=document.getElementById('mk-save-btn');
  btn.disabled=true; btn.textContent='Saving…';
  try{
    const d=await(await fetch('/mocks',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({method,path,status,headers,body,delayMs})})).json();
    if(d.ok){ closeModal(); }
    else{ btn.textContent='✗ Error'; btn.disabled=false; }
  }catch{ btn.textContent='✗ Error'; btn.disabled=false; }
}

// ── Mocks list ────────────────────────────────────────────────────────────────
function openMocksList(){ renderMocksList(); }
function renderMocksList(){
  const items=mockList.length
    ?mockList.map(m=>{
      const[method,path]=m.key.split(':');
      return\`<div class="mock-list-item">
        <span class="method m\${mc(method)}">\${method}</span>
        <span class="mock-list-path">\${esc(path)}</span>
        <span class="mock-list-status \${statusClass(m.status)}">\${m.status}</span>
        \${m.delayMs>0?\`<span class="mock-delay" title="Delay \${m.delayMs}ms">⏱\${m.delayMs}ms</span>\`:''}
        <button class="mock-del" data-key="\${escAttr(m.key)}" onclick="deleteMock(this)">✕</button>
      </div>\`;}).join('')
    :'<div class="empty-mocks">Belum ada mock. Pilih request lalu klik <b>Mock</b>.</div>';
  openModal(\`Mocks (\${mockList.length})\`,\`
    <div id="mocks-items">\${items}</div>
    <div class="modal-footer" style="margin-top:8px">
      <button class="btn-ghost" onclick="closeModal()">Close</button>
      <button class="btn-primary" onclick="closeModal();openMockEditor(null)">+ New Mock</button>
    </div>\`);
}
async function deleteMock(btn){
  const key=btn.dataset.key; btn.textContent='…'; btn.disabled=true;
  try{
    await fetch('/mocks',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({key})});
    mockList=mockList.filter(m=>m.key!==key);
    updateMocksBadge(); renderMocksList();
  }catch{ btn.textContent='✕'; btn.disabled=false; }
}

// ── Modal helpers ─────────────────────────────────────────────────────────────
function openModal(title,html,wide=false){
  document.getElementById('modal-title').textContent=title;
  document.getElementById('modal-body').innerHTML=html;
  const m=document.querySelector('#overlay .modal');
  if(wide) m.classList.add('wide'); else m.classList.remove('wide');
  document.getElementById('overlay').classList.add('open');
}
function closeModal(){ document.getElementById('overlay').classList.remove('open'); }
function overlayClick(e){ if(e.target===document.getElementById('overlay')) closeModal(); }
document.addEventListener('keydown',e=>{ if(e.key==='Escape') closeModal(); });

function clearAll(){ sel=null; showNoSel(); fetch('/clear',{method:'POST'}); }

// ── Shortcuts popup ───────────────────────────────────────────────────────────
function toggleShortcuts(){
  document.getElementById('shortcut-popup').classList.toggle('open');
}
document.addEventListener('click',e=>{
  const popup=document.getElementById('shortcut-popup');
  if(!popup.classList.contains('open')) return;
  if(!popup.contains(e.target)&&!document.getElementById('shortcuts-btn').contains(e.target))
    popup.classList.remove('open');
});

// ── Copy as cURL ──────────────────────────────────────────────────────────────
function copyAsCurl(){
  if(!sel) return;
  const r=reqs.find(x=>x.id===sel); if(!r) return;

  // Headers to skip: infra noise, browser-only hints, proxy-injected
  const skipExact=new Set([
    'host','connection','content-length','transfer-encoding',
    'accept-encoding',           // replaced by --compressed flag
    'cdn-loop',
    'x-forwarded-for','x-forwarded-proto','x-forwarded-host',
    'upgrade-insecure-requests','priority',
  ]);
  // Prefixes to skip entirely
  const skipPrefix=['cf-','sec-ch-ua','sec-fetch'];

  const host=r.reqHeaders?.host||'<tunnel-url>';
  const hasEncoding=(r.reqHeaders?.['accept-encoding']||'').match(/gzip|br|deflate/);

  let cmd='curl';
  if(r.method!=='GET') cmd+=\` -X \${r.method}\`;
  if(hasEncoding) cmd+=' --compressed';
  cmd+=\` 'https://\${host}\${r.url}'\`;

  for(const[k,v] of Object.entries(r.reqHeaders||{})){
    const kl=k.toLowerCase();
    if(skipExact.has(kl)) continue;
    if(skipPrefix.some(p=>kl.startsWith(p))) continue;
    cmd+=\` \\\\\n  -H '\${k}: \${String(v).replace(/'/g,"'\\\\''")}\`+\`'\`;
  }
  if(r.reqBody&&r.reqBody.trim()) cmd+=\` \\\\\n  -d '\${r.reqBody.replace(/'/g,"'\\\\''")}\`+\`'\`;

  _copyText(cmd).then(()=>{
    const btn=document.getElementById('curl-btn');
    const orig=btn.innerHTML; btn.className='action-btn curl-btn copied'; btn.textContent='✓ Copied';
    setTimeout(()=>{btn.className='action-btn curl-btn';btn.innerHTML=orig;},2000);
  });
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
document.addEventListener('keydown',e=>{
  const tag=e.target.tagName;
  if(tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT') return;
  if(document.getElementById('overlay').classList.contains('open')) return;
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){
    e.preventDefault();
    const visible=getVisibleReqs(); if(!visible.length) return;
    const idx=sel?visible.findIndex(r=>r.id===sel):-1;
    const next=e.key==='ArrowDown'?Math.min(idx+1,visible.length-1):Math.max(idx-1,0);
    if(visible[next]){
      pick(visible[next].id);
      const el=document.querySelector(\`.reqrow[data-id="\${visible[next].id}"]\`);
      if(el) el.scrollIntoView({block:'nearest'});
    }
  }
  if((e.key==='r'||e.key==='R')&&!e.metaKey&&!e.ctrlKey) replayReq();
  if((e.key==='u'||e.key==='U')&&!e.metaKey&&!e.ctrlKey) copyAsCurl();
  if((e.key==='c'||e.key==='C')&&!e.metaKey&&!e.ctrlKey&&sel){
    const r=reqs.find(x=>x.id===sel);
    if(r?.reqBody) navigator.clipboard.writeText(r.reqBody);
  }
});

// ── Resize sidebar ────────────────────────────────────────────────────────────
(function initResize(){
  const handle=document.getElementById('resize-handle');
  const sidebar=document.getElementById('sidebar');
  let dragging=false,startX=0,startW=0;
  handle.addEventListener('mousedown',e=>{
    dragging=true; startX=e.clientX; startW=sidebar.offsetWidth;
    handle.classList.add('resizing');
    document.body.style.cssText+='cursor:col-resize!important;user-select:none!important';
  });
  document.addEventListener('mousemove',e=>{
    if(!dragging) return;
    const w=Math.max(180,Math.min(560,startW+(e.clientX-startX)));
    sidebar.style.width=w+'px';
  });
  document.addEventListener('mouseup',()=>{
    if(!dragging) return;
    dragging=false; handle.classList.remove('resizing');
    document.body.style.cursor=''; document.body.style.userSelect='';
    localStorage.setItem('wan-net-sidebar-w',sidebar.style.width);
  });
  const saved=localStorage.getItem('wan-net-sidebar-w');
  if(saved) sidebar.style.width=saved;
})();

// ── Theme toggle ──────────────────────────────────────────────────────────────
function _applyTheme(isLight){
  document.documentElement.classList.toggle('light',isLight);
  const moon=document.getElementById('theme-icon-moon');
  const sun =document.getElementById('theme-icon-sun');
  if(moon) moon.style.display=isLight?'none':'block';
  if(sun)  sun.style.display =isLight?'block':'none';
}
function toggleTheme(){
  const isLight=!document.documentElement.classList.contains('light');
  LS.set('wan-net-theme',isLight?'light':'dark');
  _applyTheme(isLight);
  try{window.parent.postMessage({type:'wan-net-theme',theme:isLight?'light':'dark'},'*');}catch{}
}
(function initTheme(){
  const saved=LS.get('wan-net-theme','');
  const preferLight=saved?saved==='light':window.matchMedia('(prefers-color-scheme: light)').matches;
  _applyTheme(preferLight);
})();
// Receive theme push from Electron launcher
window.addEventListener('message',e=>{
  if(!e.data)return;
  if(e.data.type==='wan-net-theme'){
    const t=e.data.theme||'dark';
    _applyTheme(t==='light');
    LS.set('wan-net-theme',t); // sync ke LS inspector agar initTheme() dapat nilai terbaru saat reload
    return;
  }
  if(e.data.type==='wan-net-port-filter'){
    const p=e.data.port;
    portFilter=p||'all';
    render();
    // Scroll sidebar to top so user sees filtered results
    const sb=document.getElementById('req-list');
    if(sb)sb.scrollTop=0;
  }
});

// ── Request Diff ──────────────────────────────────────────────────────────────
function openDiff(){
  if(reqs.length<2){alert('Perlu minimal 2 request untuk diff.');return;}
  const opts=reqs.map((r,i)=>
    \`<option value="\${escAttr(r.id)}">\${esc(r.method+' '+r.url.slice(0,55))} (\${r.status||'…'})</option>\`
  ).join('');
  const opts2=reqs.slice(1).map(r=>
    \`<option value="\${escAttr(r.id)}">\${esc(r.method+' '+r.url.slice(0,55))} (\${r.status||'…'})</option>\`
  ).join('');
  openModal('Request Diff',\`
    <div style="display:flex;gap:10px;margin-bottom:12px">
      <div style="flex:1">
        <div class="sec-title" style="margin-bottom:5px">Request A</div>
        <select id="diff-a" style="width:100%;background:var(--bg);border:1px solid var(--brd);border-radius:6px;color:var(--txt);padding:7px 10px;font:11px var(--mono);outline:none">\${opts}</select>
      </div>
      <div style="flex:1">
        <div class="sec-title" style="margin-bottom:5px">Request B</div>
        <select id="diff-b" style="width:100%;background:var(--bg);border:1px solid var(--brd);border-radius:6px;color:var(--txt);padding:7px 10px;font:11px var(--mono);outline:none">\${opts2}</select>
      </div>
    </div>
    <div style="text-align:center;margin-bottom:14px">
      <button class="btn-primary" onclick="runDiff()">↔ Compare</button>
    </div>
    <div id="diff-result"></div>
    <div style="display:flex;justify-content:flex-end;margin-top:12px;padding-top:12px;border-top:1px solid var(--brd)">
      <button class="btn-ghost" onclick="closeModal()">Close</button>
    </div>\`,true);
  if(sel) document.getElementById('diff-a').value=sel;
}
function runDiff(){
  const idA=document.getElementById('diff-a').value;
  const idB=document.getElementById('diff-b').value;
  if(idA===idB){document.getElementById('diff-result').innerHTML='<p class="nobody" style="text-align:center">Pilih request yang berbeda</p>';return;}
  const a=reqs.find(r=>r.id===idA), b=reqs.find(r=>r.id===idB);
  if(!a||!b) return;
  function lineDiff(ta,tb){
    const la=(ta||'').split('\\n'), lb=(tb||'').split('\\n');
    let h=''; const max=Math.max(la.length,lb.length);
    for(let i=0;i<max;i++){
      const la_=la[i]??null, lb_=lb[i]??null;
      if(la_===lb_) h+=\`<div class="diff-same">\${esc(la_||'')}</div>\`;
      else{
        if(la_!==null) h+=\`<div class="diff-del">- \${esc(la_)}</div>\`;
        if(lb_!==null) h+=\`<div class="diff-add">+ \${esc(lb_)}</div>\`;
      }
    }
    return h||'<span class="nobody">Empty</span>';
  }
  const hdrStr=r=>(Object.entries(r||{}).map(([k,v])=>k+': '+v).join('\\n'));
  document.getElementById('diff-result').innerHTML=\`
    <div class="section"><div class="sec-title">URL & Method</div>
      <div class="body-view" style="max-height:80px">\${lineDiff(a.method+' '+a.url,b.method+' '+b.url)}</div></div>
    <div class="section"><div class="sec-title">Request Headers</div>
      <div class="body-view" style="max-height:160px">\${lineDiff(hdrStr(a.reqHeaders),hdrStr(b.reqHeaders))}</div></div>
    <div class="section"><div class="sec-title">Request Body</div>
      <div class="body-view" style="max-height:130px">\${lineDiff(a.reqBody,b.reqBody)}</div></div>
    <div class="section"><div class="sec-title">Response (\${a.status||'—'} vs \${b.status||'—'})</div>
      <div class="body-view" style="max-height:130px">\${lineDiff(a.resBody,b.resBody)}</div></div>\`;
}

// ── Timeline view ─────────────────────────────────────────────────────────────
function toggleTimeline(){
  timelineMode=!timelineMode;
  const btn=document.getElementById('tl-btn');
  btn.className=timelineMode?'hbtn active':'hbtn';
  render();
}
function renderTimeline(f){
  const list=document.getElementById('reqlist');
  [...list.children].forEach(e=>e.remove());
  if(!f.length){
    document.getElementById('empty').style.display='flex'; return;
  }
  document.getElementById('empty').style.display='none';
  const times=f.map(r=>new Date(r.time).getTime());
  const t0=Math.min(...times);
  const t1=Math.max(...times,t0+500);
  const span=t1-t0||1000;
  // Header axis
  const hdr=document.createElement('div');
  hdr.className='tl-hdr';
  hdr.innerHTML=\`<span class="tl-hdr-txt">0ms</span><span class="tl-hdr-txt">\${f.length} requests · span: \${span<1000?span+'ms':(span/1000).toFixed(1)+'s'}</span><span class="tl-hdr-txt">\${span<1000?span+'ms':(span/1000).toFixed(1)+'s'}</span>\`;
  list.appendChild(hdr);
  const maxMs=Math.max(...f.filter(r=>r.ms!=null).map(r=>r.ms),50);
  f.forEach(r=>{
    const d=document.createElement('div');
    d.className='tl-row'+(r.id===sel?' active':'');
    d.dataset.id=r.id; d.onclick=()=>pick(r.id);
    const tStart=new Date(r.time).getTime()-t0;
    const leftPct=Math.max(0,(tStart/span)*100);
    const widPct=r.ms?Math.max(.5,(r.ms/span)*100):0.5;
    const msc=msColor(r.ms);
    d.innerHTML=\`
      <div class="tl-label">
        <span class="method m\${mc(r.method)}" style="font-size:9px;padding:1px 4px">\${r.method}</span>
        <span class="tl-url">\${esc(r.url.split('?')[0])}</span>
        \${r.ms!=null?\`<span style="font-size:9px;font-family:var(--mono);color:\${msc};margin-left:auto;flex-shrink:0">\${r.ms}ms</span>\`:''}
      </div>
      <div class="tl-track">
        <div class="tl-bar" style="left:\${leftPct.toFixed(1)}%;width:\${Math.min(widPct,100-leftPct).toFixed(1)}%;background:\${msc}">
          \${r.ms&&r.ms>80?\`<span class="tl-ms">\${r.ms}ms</span>\`:''}
        </div>
      </div>\`;
    list.appendChild(d);
  });
}

// ── Header injection UI ───────────────────────────────────────────────────────
function updateInjectBadge(){
  const cnt=document.getElementById('inject-cnt');
  if(!cnt) return;
  cnt.textContent=injectList.length;
  cnt.style.display=injectList.length?'inline':'none';
}
function openInject(){
  renderInjectList();
}
function renderInjectList(){
  const ports=[...new Set(reqs.map(r=>r.localPort).filter(Boolean))].sort((a,b)=>a-b);
  const portOpts=\`<option value="*">* (Global — semua port)</option>\`+
    ports.map(p=>\`<option value="\${p}">:\${p}</option>\`).join('');
  const items=injectList.length
    ?injectList.map(rule=>{
      const portLbl=rule.port==='*'?'* global':':'+rule.port;
      const hdrs=Object.entries(rule.headers||{}).map(([k,v])=>k+': '+v).join(', ');
      return\`<div class="inj-item">
        <span class="inj-port">\${esc(String(portLbl))}</span>
        <span class="inj-headers">\${esc(hdrs)}</span>
        <button class="mock-del" data-port="\${escAttr(String(rule.port))}" onclick="deleteInject(this)" title="Hapus">✕</button>
      </div>\`;
    }).join('')
    :'<div class="empty-mocks">Belum ada injection rule.</div>';
  openModal('Header Injection',\`
    <div id="inj-items">\${items}</div>
    <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--brd)">
      <div style="font-size:11px;font-weight:600;color:var(--dim);margin-bottom:10px;text-transform:uppercase;letter-spacing:.5px">Tambah Rule Baru</div>
      <div class="form-row">
        <div class="form-group" style="flex:0 0 160px"><label>Berlaku untuk</label>
          <select id="inj-port" style="background:var(--bg);border:1px solid var(--brd);border-radius:6px;color:var(--txt);padding:7px 10px;font:12px var(--mono);outline:none;width:100%">\${portOpts}</select></div>
        <div class="form-group"><label>Headers <span class="form-hint">(JSON object)</span></label>
          <textarea id="inj-headers" rows="3" placeholder='{"Authorization":"Bearer token","X-Custom":"value"}' spellcheck="false"></textarea></div>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button class="btn-ghost" onclick="closeModal()">Close</button>
        <button class="btn-primary" onclick="saveInject()">+ Add Rule</button>
      </div>
    </div>\`);
}
async function saveInject(){
  const port=document.getElementById('inj-port').value;
  let headers={};
  try{ headers=JSON.parse(document.getElementById('inj-headers').value||'{}'); }
  catch{ alert('Headers harus JSON valid. Contoh: {"Authorization":"Bearer token"}'); return; }
  if(!Object.keys(headers).length){alert('Headers tidak boleh kosong');return;}
  const key=port==='*'?'*':Number(port);
  // Merge with existing rule for this port
  const existing=(injectList.find(r=>String(r.port)===String(key))||{}).headers||{};
  const merged={...existing,...headers};
  try{
    await fetch('/inject',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({port,headers:merged})});
    document.getElementById('inj-headers').value='';
    renderInjectList();
  }catch(e){alert('Error: '+e.message);}
}
async function deleteInject(btn){
  const port=btn.dataset.port; btn.textContent='…'; btn.disabled=true;
  try{
    await fetch('/inject',{method:'DELETE',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({port:port==='*'?'*':Number(port)})});
  }catch(e){btn.textContent='✕';btn.disabled=false;}
}

// ── Response Preview ──────────────────────────────────────────────────────────
function renderPreview(r){
  const ct=(r.resHeaders?.['content-type']||'').split(';')[0].trim().toLowerCase();
  if(!ct&&!r.resBody&&!r.resBodyB64)
    return'<div class="section"><p class="nobody">No response body</p></div>';

  // Binary images — served via /body/:id endpoint (only if body was stored)
  if(ct.startsWith('image/')){
    if(!r.resBodyB64&&r.resBinary)
      return\`<div class="section"><p class="nobody">Image terlalu besar untuk preview (>\${formatSize(256*1024)}). Size: <b>\${formatSize(r.size)}</b></p></div>\`;
    return\`<div class="section">
      <div class="sec-title">Image Preview <span style="color:var(--dim2);font-size:9px;text-transform:none;letter-spacing:0;font-weight:400">\${ct}</span></div>
      <div style="background:repeating-conic-gradient(rgba(128,128,128,.15) 0% 25%,transparent 0% 50%) 0 0/16px 16px;border:1px solid var(--brd);border-radius:8px;padding:12px;text-align:center">
        <img src="/body/\${r.id}" alt="response" style="max-width:100%;max-height:420px;border-radius:4px;display:block;margin:0 auto">
      </div>
    </div>\`;
  }

  // HTML — render in sandboxed iframe via srcdoc
  if(ct==='text/html'||ct==='application/xhtml+xml'){
    if(!r.resBody) return'<div class="section"><p class="nobody">Empty HTML response</p></div>';
    const safe=escAttr(r.resBody);
    return\`<div class="section">
      <div class="sec-title">HTML Preview <span style="color:var(--dim2);font-size:9px;text-transform:none;letter-spacing:0;font-weight:400">sandboxed · scripts disabled</span></div>
      <iframe srcdoc="\${safe}" sandbox="allow-same-origin allow-forms" style="width:100%;height:420px;border:1px solid var(--brd);border-radius:8px;background:#fff;display:block"></iframe>
    </div>\`;
  }

  // SVG — render inline in a white box
  if(ct==='image/svg+xml'&&r.resBody){
    return\`<div class="section">
      <div class="sec-title">SVG Preview</div>
      <div style="background:#fff;border:1px solid var(--brd);border-radius:8px;padding:16px;text-align:center;overflow:auto">
        \${r.resBody}
      </div>
    </div>\`;
  }

  return\`<div class="section"><p class="nobody">No preview available for <code style="background:var(--s2);padding:2px 6px;border-radius:4px">\${esc(ct||'unknown content-type')}</code><br><span style="font-size:11px;color:var(--dim2)">HTML, SVG dan image (PNG/JPG/GIF/WebP) yang bisa di-preview</span></p></div>\`;
}

// ── Stats per endpoint ────────────────────────────────────────────────────────
function computeStats(){
  const map=new Map();
  for(const r of reqs){
    const key=(r.method||'?')+' '+(r.url||'').split('?')[0];
    if(!map.has(key)) map.set(key,{count:0,msTotal:0,msCnt:0,errors:0});
    const s=map.get(key);
    s.count++;
    if(r.ms!=null){s.msTotal+=r.ms;s.msCnt++;}
    if(r.status>=400) s.errors++;
  }
  return[...map.entries()]
    .map(([key,s])=>{const[m,...pp]=key.split(' ');return{method:m,path:pp.join(' '),
      count:s.count,avgMs:s.msCnt?Math.round(s.msTotal/s.msCnt):null,
      errPct:Math.round((s.errors/s.count)*100)};})
    .sort((a,b)=>b.count-a.count);
}
function openStats(){
  if(!reqs.length){alert('Belum ada request.');return;}
  const stats=computeStats();
  const rows=stats.map(s=>{
    const avgStr=s.avgMs!=null?\`<span style="color:\${msColor(s.avgMs)};font-family:var(--mono)">\${s.avgMs}ms</span>\`:'<span style="color:var(--dim2)">—</span>';
    const errStr=s.errPct>0?\`<span style="color:var(--r);font-family:var(--mono)">\${s.errPct}%</span>\`:'<span style="color:var(--g);font-family:var(--mono)">0%</span>';
    const barW=Math.max(2,Math.round((s.count/stats[0].count)*100));
    const barC=msColor(s.avgMs);
    return\`<tr style="border-bottom:1px solid var(--brd)">
      <td style="padding:7px 10px 7px 0"><span class="method m\${mc(s.method)}">\${s.method}</span></td>
      <td style="padding:7px 10px;font-family:var(--mono);font-size:11px;max-width:0;width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="\${escAttr(s.path)}">\${esc(s.path)}</td>
      <td style="padding:7px 10px;vertical-align:middle;min-width:80px">
        <div style="display:flex;align-items:center;gap:6px">
          <span style="font-family:var(--mono);font-size:12px;font-weight:600;min-width:24px">\${s.count}</span>
          <div style="flex:1;height:4px;background:var(--brd);border-radius:2px;min-width:40px">
            <div style="width:\${barW}%;height:100%;background:\${barC};border-radius:2px;opacity:.7"></div>
          </div>
        </div>
      </td>
      <td style="padding:7px 10px;text-align:center">\${avgStr}</td>
      <td style="padding:7px 0;text-align:center">\${errStr}</td>
    </tr>\`;
  }).join('');
  openModal(\`Stats — \${stats.length} endpoint\${stats.length!==1?'s':''}\`,\`
    <div style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-size:11px">
      <thead><tr style="color:var(--dim2);font-size:10px;text-transform:uppercase;letter-spacing:.5px;border-bottom:2px solid var(--brd)">
        <th style="text-align:left;padding:0 10px 8px 0;font-weight:600">Method</th>
        <th style="text-align:left;padding:0 10px 8px;font-weight:600">Endpoint</th>
        <th style="text-align:left;padding:0 10px 8px;font-weight:600">Calls</th>
        <th style="text-align:center;padding:0 10px 8px;font-weight:600">Avg ms</th>
        <th style="text-align:center;padding:0 0 8px;font-weight:600">Errors</th>
      </tr></thead>
      <tbody>\${rows}</tbody>
    </table>
    </div>
    <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--brd);display:flex;justify-content:space-between;align-items:center">
      <span style="font-size:11px;color:var(--dim2)">Total: \${reqs.length} request dari \${stats.length} endpoint</span>
      <button class="btn-ghost" onclick="closeModal()">Close</button>
    </div>\`);
}

// Update hanya kolom waktu relatif setiap 60 detik — tanpa rebuild seluruh DOM
setInterval(()=>{
  document.querySelectorAll('.rtime[data-time]').forEach(el=>{
    el.textContent=relTime(el.dataset.time);
  });
},60000);
`;
