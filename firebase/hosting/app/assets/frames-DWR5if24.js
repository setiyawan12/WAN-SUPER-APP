import{s,p as f,r as p}from"./node-BqTsueCe.js";const g=[{bg:"rgba(139,124,248,0.06)",stroke:"rgba(139,124,248,0.35)",label:"#a5b4fc"},{bg:"rgba(14,165,233,0.06)",stroke:"rgba(14,165,233,0.35)",label:"#7dd3fc"},{bg:"rgba(16,185,129,0.06)",stroke:"rgba(16,185,129,0.35)",label:"#6ee7b7"},{bg:"rgba(245,158,11,0.06)",stroke:"rgba(245,158,11,0.35)",label:"#fcd34d"},{bg:"rgba(236,72,153,0.06)",stroke:"rgba(236,72,153,0.35)",label:"#f9a8d4"}];let m=!1,d=null,l=null,u=null;function v(){return document.getElementById("canvas")}function y(){return document.getElementById("frame-layer")}function b(){const t=y();if(t){t.innerHTML="";for(const r in s.frames||{}){const n=s.frames[r],e=g[n.colorIdx??0],a=document.createElement("div");a.id="frame-"+r,a.className="canvas-frame",a.dataset.frameId=r,a.style.cssText=`
      position:absolute;
      left:${n.x}px; top:${n.y}px;
      width:${n.w}px; height:${n.h}px;
      background:${e.bg};
      border:2px solid ${e.stroke};
      border-radius:10px;
      pointer-events:all;
      box-sizing:border-box;
    `;const o=document.createElement("div");o.className="canvas-frame-label",o.textContent=n.label||"Frame",o.style.cssText=`
      position:absolute;top:-22px;left:6px;
      font-size:11px;font-weight:600;
      color:${e.label};
      background:${e.bg.replace("0.06","0.5")};
      border:1px solid ${e.stroke};
      padding:1px 7px;border-radius:4px;
      cursor:default;white-space:nowrap;
      backdrop-filter:blur(4px);
    `,o.addEventListener("dblclick",()=>{const i=prompt("Nama frame:",n.label||"Frame");i!==null&&(f(),n.label=i,p.dirty=!0,b())}),a.appendChild(o),a.addEventListener("contextmenu",i=>{i.preventDefault(),i.stopPropagation(),w(r,i.clientX,i.clientY)}),t.appendChild(a)}}}function w(t,r,n){var a,o,i;let e=document.getElementById("frame-ctx");e||(e=document.createElement("div"),e.id="frame-ctx",e.className="ctx-menu",e.style.cssText="z-index:150;min-width:160px;position:fixed",e.innerHTML=`
      <div id="fctx-rename" class="px-3 py-1.5 text-xs text-white/60 hover:bg-white/[0.07] hover:text-white cursor-pointer transition">✏️ Ganti Nama</div>
      <div id="fctx-color"  class="px-3 py-1.5 text-xs text-white/60 hover:bg-white/[0.07] hover:text-white cursor-pointer transition">🎨 Ganti Warna</div>
      <div class="h-px bg-white/[0.06] mx-2 my-0.5"></div>
      <div id="fctx-delete" class="px-3 py-1.5 text-xs text-red-400/70 hover:bg-red-500/10 hover:text-red-400 cursor-pointer transition">🗑 Hapus Frame</div>`,document.body.appendChild(e),e.addEventListener("click",c=>c.stopPropagation()),(a=document.getElementById("fctx-rename"))==null||a.addEventListener("click",()=>{var h;e.classList.add("hidden");const c=(h=s.frames)==null?void 0:h[u];if(!c)return;const x=prompt("Nama frame:",c.label||"Frame");x!==null&&(f(),c.label=x,p.dirty=!0,b())}),(o=document.getElementById("fctx-color"))==null||o.addEventListener("click",()=>{var x;e.classList.add("hidden");const c=(x=s.frames)==null?void 0:x[u];c&&(f(),c.colorIdx=((c.colorIdx??0)+1)%g.length,p.dirty=!0,b())}),(i=document.getElementById("fctx-delete"))==null||i.addEventListener("click",()=>{e.classList.add("hidden"),!(!u||!s.frames)&&(f(),delete s.frames[u],p.dirty=!0,b())})),u=t,e.style.left=Math.min(r,innerWidth-170)+"px",e.style.top=Math.min(n,innerHeight-120)+"px",e.classList.remove("hidden")}function E(){m=!m;const t=document.getElementById("btn-frame");t&&t.classList.toggle("active",m);const r=v();if(r)return r.style.cursor=m?"crosshair":"",m}function F(){return m}function k(t,r,n){var e;return m?(d={x:r,y:n},l=document.createElement("div"),l.style.cssText=`
    position:absolute;left:${r}px;top:${n}px;width:0;height:0;
    border:2px dashed rgba(139,124,248,0.7);border-radius:8px;
    background:rgba(139,124,248,0.05);pointer-events:none;box-sizing:border-box;z-index:5`,(e=y())==null||e.appendChild(l),!0):!1}function L(t,r){if(!m||!d||!l)return;const n=Math.min(d.x,t),e=Math.min(d.y,r),a=Math.abs(t-d.x),o=Math.abs(r-d.y);l.style.left=n+"px",l.style.top=e+"px",l.style.width=a+"px",l.style.height=o+"px"}function I(t,r){if(!m||!d)return!1;l==null||l.remove(),l=null;const n=Math.min(d.x,t),e=Math.min(d.y,r),a=Math.abs(t-d.x),o=Math.abs(r-d.y);if(d=null,a<40||o<30)return!0;f(),s.frames||(s.frames={}),s.nextFrameId||(s.nextFrameId=1);const i="f"+s.nextFrameId++;return s.frames[i]={id:i,x:n,y:e,w:a,h:o,label:"Frame",colorIdx:0},p.dirty=!0,b(),E(),!0}function $(){document.addEventListener("click",()=>{var t;(t=document.getElementById("frame-ctx"))==null||t.classList.add("hidden")})}export{k as handleFrameMouseDown,L as handleFrameMouseMove,I as handleFrameMouseUp,$ as initFrames,F as isFrameDrawMode,b as renderFrames,E as toggleFrameDrawMode};
