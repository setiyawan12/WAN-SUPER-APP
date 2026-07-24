# Handbook: Neuron Activity — Visual Otak Model yang Sedang Di-hit (Hybrid A + B/C)

Panduan membangun **visualisasi "otak"** di `wan-cliproxyapi-dekstop`: jaringan neuron di mana **tiap neuron = model/provider**, dan neuron **"menyala" (firing)** saat model itu di-hit. Idle → neuron berdenyut lembut (resting); ada request → neuron berkilat + pulsa berjalan di sepanjang sinaps.

Pendekatan: **HYBRID.**
- **A — proxy-tap (instan, milidetik):** instrumentasi `chat-proxy.js` + `chat-service.ts` agar **memancarkan event live** `start`/`end` per request. **Semua model IDE** (Claude/Grok/Gemini/GPT) diarahkan lewat `/api/proxy/v1/chat/completions` (`toCopilotModelEntry` + `ownBaseUrl`) supaya path A sama rata; chat in-app juga.
- **B — poll `recent[]` (near-live, ≤~15 dtk):** jaring pengaman (URL lama direct ke CLIProxyAPI, lag, offline) + fold `auth_index` ke pulse path A.
- **C — log-tap (opsional):** enhancement di belakang flag; tidak wajib.

> Perubahan vs versi B/C murni: sekarang **kita menyentuh proxy** (`chat-proxy.js`) demi realtime. Konsekuensinya file itu **tidak lagi 100% verbatim** — mitigasinya lihat §3.4 & §10 (emit dibungkus try/catch agar tak pernah bisa merusak pipa proxy produksi).

---

## 1. Konsep Visual

```
                          ┌───────────────────────────────┐
                          │            THE BRAIN          │
                          │                                │
             caller ◦─────┼──►  ( ) claude-opus-4-6  ⚡    │   ⚡ = firing INSTAN (jalur A)
          (VS Code /      │      │  ╲                      │   ◦ = resting (denyut lembut)
           JetBrains /    │      │   ╲___ ( ) claude-...   │   ✕ = failed (kilat merah)
           in-app chat)   │      │                         │   ~ = firing NEAR-LIVE (jalur B)
                          │   ( ) gemini-3-pro ~           │
                          │        ╲                        │  Sinaps menyala saat pulsa
                          │         ( ) gpt-5 ✕            │  berjalan caller → neuron.
                          └───────────────────────────────┘
```

- **Neuron (node)** = satu `provider::model` (mis. `anthropic::claude-opus-4-6`, `gemini::gemini-3-pro`).
- **Lobe (cluster)** = satu provider; model se-provider mengelompok, berbagi warna aksen.
- **Firing** = model di-hit. Dua rasa:
  - **Instan (A):** dari event proxy `start` → neuron langsung berkilat + pulsa berjalan; saat event `end` datang, tandai sukses/gagal + latensi.
  - **Near-live (B):** dari diff `recent[]` (untuk provider yang tak lewat proxy). Boleh diberi corak sedikit beda (mis. glow "tertunda") supaya jujur.
- **Resting** = tak ada hit; denyut redup, makin lama makin redup (decay).
- **Failed** = firing merah.
- **Ukuran neuron** ∝ request kumulatif (`byProviderModel[].requests`).
- **Kecepatan pulsa** ∝ latensi (`latency_ms` dari `end` event atau `recent[]`).

Tetap konsisten dengan sistem desain aurora (glow, blur, warna aksen per provider).

---

## 2. Arsitektur Data (Hybrid)

```
┌──────────────────────────────── Electron App (SATU proses) ────────────────────────────────┐
│                                                                                             │
│  backend (plain-JS, di-loadBackend oleh index.ts)                                           │
│   ├─ chat-proxy.js  ──(A)──►  activity-bus.js  .emit("hit", {phase,reqId,model,provider,…}) │
│   │     (semua model IDE via ownBaseUrl → /api/proxy/v1/chat/completions)                   │
│   ├─ routes.js  GET /api/usage/tokens → recent[]   (B, semua provider)                      │
│   └─ usage-poller.js  drain /usage-queue (default 15s)                                       │
│                                   │                                                          │
│  main (TypeScript, kita miliki)   │ activity-bus.js singleton (EventEmitter, Node murni)     │
│   ├─ index.ts  ── on("hit") ──────┴──►  broadcast("activity", payload)   (events.ts)         │
│   ├─ chat-service.ts  ──(A, chat in-app)──►  broadcast("activity", {model,provider,…})       │
│   └─ ipc.ts  handleRequest → fetch backend (untuk poll B)                                    │
│                                   │  wan:event / wan:request  (IPC, sudah ada)               │
│                                   ▼                                                          │
│  Renderer (React)  pages/Neuron.tsx                                                          │
│   ├─ window.wan.onEvent(cb)   ← event "activity" INSTAN (jalur A)                            │
│   ├─ usePolling(api.getUsageTokens, 2500)  ← recent[] NEAR-LIVE (jalur B)                    │
│   └─ useNeuronGraph(activityEvents, recent, byProviderModel) → merge + dedupe → firings      │
│         └── <NeuronCanvas nodes edges firings />   (Canvas 2D + rAF)                         │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Yang dipakai apa adanya (terverifikasi di kode):**

| Kebutuhan | Sudah ada | Lokasi |
|---|---|---|
| Proxy melihat `body.model` per request | `proxyChatCompletions` | `src/main/backend/chat-proxy.js:13` |
| Backend di-load satu proses dgn main | `loadBackend("./backend/index.js")` | `src/main/index.ts:40` |
| Broadcast event → renderer | `broadcast(type, payload)` (`wan:event`) | `src/main/events.ts:18` |
| Listener event di renderer | `window.wan.onEvent(cb)` | `src/preload/index.cjs:90` |
| Chat in-app tahu model live | `chat-service.ts` (sudah `broadcast` stream) | `src/main/chat-service.ts` |
| Ambil `recent[]` (semua provider) | `api.getUsageTokens(days)` | `src/renderer/api/client.ts:248` |
| Ambil log CLIProxyAPI (opsional C) | `api.getProxyLogs(after?)` | `src/renderer/api/client.ts:218` |
| Polling berkala | `usePolling(fetcher, ms, enabled)` | `src/renderer/hooks/usePolling.ts:7` |
| Shape `recent[i]` | `{ timestamp, provider, model, failed, latency_ms, tokens, endpoint, auth_type, auth_index }` | `src/main/backend/usage-store.js:118` |
| Bobot neuron kumulatif | `byProviderModel[]: { provider, model, requests, … }` | `src/main/backend/usage-store.js:146` |
| Copy backend verbatim → out | `scripts/copy-assets.mjs` | (build) |

**File BARU:** `src/main/backend/activity-bus.js` + berkas renderer `pages/neuron/*`.
**File DISENTUH:** `chat-proxy.js` (3–6 baris emit), `index.ts` (wiring bus→broadcast), `chat-service.ts` (1 emit), `App.tsx` (nav). **Tidak** ada endpoint/port baru.

---

## 3. Jalur A — Proxy-tap Instan

### 3.1 Seam: `activity-bus.js` (backend tetap Electron-agnostic)
Kunci desain: **`chat-proxy.js` tidak boleh `import` kode Electron/main.** Ia hanya emit ke bus lokal backend; main yang menjembatani ke `broadcast`. Ini menjaga backend tetap "portable" dan kopling Electron ada di kode TS kita.

```js
// src/main/backend/activity-bus.js  (BARU — Node murni, tanpa Electron)
import { EventEmitter } from "node:events";
// Singleton bus untuk sinyal "request lewat proxy". Sengaja modul terpisah &
// ringan supaya chat-proxy.js cukup import sibling ini, bukan reach ke main.
export const activityBus = new EventEmitter();
activityBus.setMaxListeners(0); // main + (test) boleh subscribe tanpa warning
```

### 3.2 Emit di `chat-proxy.js` (edit minimal, aman)
Tambahkan **start** setelah `model` diketahui, dan **end** saat respons selesai/gagal. **Semua dibungkus try/catch** agar bug di sini tak pernah bisa menjatuhkan pipa proxy yang dipakai VS Code.

```js
// src/main/backend/chat-proxy.js  (tambahan)
import { randomUUID } from "node:crypto";
import { activityBus } from "./activity-bus.js";

function emitHit(evt) {
  try { activityBus.emit("hit", evt); } catch { /* never break the proxy */ }
}

export async function proxyChatCompletions(req, res) {
  const body = { ...req.body };
  const model = typeof body.model === "string" ? body.model : "unknown";
  const isClaude = /claude/i.test(model);
  if (isClaude) { for (const k of DEPRECATED_SAMPLING_PARAMS) delete body[k]; }

  const reqId = randomUUID().slice(0, 8);
  const startedAt = Date.now();
  // Proxy ini hanya dilewati Claude-family (lihat komentar file:9), jadi
  // provider ≈ anthropic; biarkan best-effort, jalur B mengoreksi lainnya.
  emitHit({ phase: "start", reqId, model, provider: isClaude ? "anthropic" : "unknown", ts: startedAt });

  let ended = false;
  const finish = (ok) => {
    if (ended) return; ended = true;
    emitHit({ phase: "end", reqId, model, ok, latency_ms: Date.now() - startedAt, ts: Date.now() });
  };

  const upstream = await fetch(`${proxyBaseUrl()}/v1/chat/completions`, { /* …tak berubah… */ });
  res.status(upstream.status);
  // …forward headers seperti semula…

  const upstreamOk = upstream.status < 400;
  if (!upstream.body) { finish(upstreamOk); res.end(); return; }

  upstream.body.on("error", () => { finish(false); res.destroy(); });
  res.on("close", () => { upstream.body.destroy(); finish(upstreamOk); }); // done ATAU client abort
  res.on("finish", () => finish(upstreamOk));                             // terkirim penuh
  upstream.body.pipe(res);
}
```

> Catatan: `res.on("close")` menyala baik saat selesai normal maupun saat VS Code memutus. Flag `ended` menjamin `end` cuma sekali. Untuk membedakan abort vs sukses secara presisi butuh cek `res.writableFinished` — cukup untuk visual, tak perlu sempurna.

### 3.3 Wiring di `index.ts` (kopling Electron di sini, bukan di backend)
Setelah `loadBackend("./backend/index.js")`:

```ts
// src/main/index.ts (tambahan, sesudah backend siap)
const { activityBus } = await loadBackend("./backend/activity-bus.js");
activityBus.on("hit", (evt: unknown) => broadcast("activity", evt));
```

`broadcast` sudah fan-out ke semua window (`events.ts:22`), termasuk Quick Chat.

### 3.4 Chat in-app (`chat-service.ts`)
Chat in-app sudah di main dan tahu `model`/`provider` secara live. Saat mulai stream, tambahkan satu baris:

```ts
broadcast("activity", { phase: "start", reqId, model, provider, ts: Date.now() });
// …dan saat selesai/gagal:
broadcast("activity", { phase: "end", reqId, model, ok, latency_ms, ts: Date.now() });
```

Karena chat-service memilih model sendiri, provider di sini **akurat** (tak perlu tebak).

### 3.5 Keamanan perubahan proxy
- Emit **tak pernah** `await`, **selalu** `try/catch`, tak menyentuh `body`/stream → mustahil mengubah perilaku proxy.
- Jika `activity-bus.js` gagal di-import di main (mis. build lama), `broadcast` wiring dilewati; proxy tetap jalan; UI jatuh ke jalur B saja.

---

## 4. Jalur B — Poll `recent[]` (jaring semua provider)

Tetap seperti rancangan near-live, kini sebagai **pelengkap**, bukan satu-satunya sumber.

- Poll `api.getUsageTokens(1)` tiap **~2500 ms**; diff `recent[]` via `lastSeenTs` (fallback hash `provider|model|timestamp|latency_ms` bila `timestamp` null/duplikat).
- **Fungsi utama sekarang:** menangkap **Gemini/GPT** yang dikirim VS Code **langsung ke :8317** (tak lewat proxy-tap), plus rekonsiliasi angka kumulatif (`byProviderModel`).
- Jeda drain 15 dtk tetap ada (`usage-poller.js:9`) → firing jalur B diberi label "~Ns lalu" + corak "tertunda".
- **Dedupe lintas-jalur (penting):** request Claude akan muncul di **kedua** jalur (A instan, lalu B ~detik kemudian). Buang duplikat: jika sudah ada firing dgn `reqId` sama **atau** `(model, ts)` dalam jendela ±20 dtk, **jangan** picu firing kedua — cukup update metrik (latensi/failed) dari B bila A belum mengisinya.

---

## 5. Jalur C — Log-tap (opsional, di belakang flag)
`api.getProxyLogs(after)` (`client.ts:218`, ring-buffer `cliproxy-manager.js:61`) bisa mempercepat deteksi provider non-Claude ke ~1–3 dtk sebelum `recent[]` menyusul. **Rapuh terhadap format log** → flag `useLogTap`, fallback senyap ke B. Simpan untuk fase lanjut; tidak wajib.

---

## 6. Model Data untuk Graph

```ts
// src/renderer/pages/neuron/types.ts
export interface ActivityEvent {           // dari window.wan.onEvent("activity")
  phase: "start" | "end";
  reqId: string;
  model: string;
  provider?: string;
  ok?: boolean;
  latency_ms?: number;
  ts: number;
  source?: "proxy" | "chat";               // opsional utk atribusi
}

export interface NeuronNode {
  id: string;                 // `${provider}::${model}`
  provider: string;
  model: string;
  requests: number;           // kumulatif (byProviderModel) → ukuran node
  lastHitTs: number | null;
  lastFailed: boolean;
  avgLatencyMs: number | null;
  x: number; y: number;       // hasil layout (ternormalisasi 0..1)
}

export interface Firing {
  nodeId: string;
  reqId?: string;             // dari jalur A (utk dedupe)
  startedAt: number;          // performance.now()
  failed: boolean;
  latencyMs: number | null;
  live: boolean;              // true = instan (A), false = near-live (B)
}
```

`useNeuronGraph(activityEvents, tokenData, prevSnapshot)`:
1. Merge `NeuronNode[]` dari `byProviderModel` ∪ `provider::model` di `recent` ∪ model dari `ActivityEvent`.
2. **Jalur A:** tiap `phase:"start"` → firing `live:true` (dedupe by `reqId`); `phase:"end"` → update `failed`/`latency` + set `lastHitTs`.
3. **Jalur B:** diff `recent` → firing `live:false`, **kecuali** sudah tercakup jalur A (dedupe §4).
4. Warna per provider (anthropic=amber, gemini=cyan, gpt/openai=emerald, xai=violet, lainnya=slate).
5. Kembalikan `{ nodes, synapses, firings }`.

---

## 7. Layout & Rendering (Canvas 2D + rAF)

*(Sama seperti rancangan visual; ringkas.)*
- **Layout radial per-lobe:** pusat = "caller"; tiap provider satu sektor; model tersebar radial (jarak ∝ 1/requests). Hitung sekali per perubahan set node; simpan `x,y` ternormalisasi; skala pakai `devicePixelRatio`.
- **rAF loop:** gambar latar → sinaps → pulsa firing (durasi dari `latencyMs`, clamp 400–1500ms; firing `live:false` bisa lebih redup/putus-putus) → neuron (radius=f(requests), kecerahan=f(aktivasi+decay)) → buang firing selesai.
- **Hemat CPU:** turunkan fps saat semua resting; **stop total** saat `document.hidden` atau server mati; hormati `prefers-reduced-motion` (mode highlight statis).
- **Overlay DOM:** label `model` + "~Ns lalu"/"live"; hover → tooltip (provider, requests, latensi rata-rata, akun `auth_index`/`auth_type`, hit terakhir).

---

## 8. Struktur Berkas

```
BARU (backend):
  src/main/backend/activity-bus.js         # EventEmitter singleton (Node murni)

DISENTUH (main):
  src/main/backend/chat-proxy.js           # + emit start/end (try/catch)
  src/main/index.ts                        # + activityBus.on("hit") → broadcast
  src/main/chat-service.ts                 # + 2 baris broadcast("activity",…)

BARU (renderer):
  src/renderer/pages/Neuron.tsx            # onEvent(A) + usePolling(B) + <NeuronCanvas>
  src/renderer/pages/neuron/
    types.ts  useNeuronGraph.ts  NeuronCanvas.tsx
    layout.ts  palette.ts  physics.ts  neuron.test.ts

DISENTUH (renderer):
  src/renderer/App.tsx                     # + entri PAGES[] "Activity" + ikon
```

---

## 9. Fase Implementasi

- **N0 — Seam A.** Buat `activity-bus.js`; emit di `chat-proxy.js`; wiring di `index.ts`; verifikasi via `console.log` di `onEvent("activity")` saat Claude di-hit dari VS Code. *DoD:* event start/end muncul instan.
- **N1 — Data & merge.** `types.ts`, `useNeuronGraph.ts`: gabung jalur A (onEvent) + jalur B (poll recent[]) dgn dedupe. Verifikasi lewat list teks ("firing: claude-opus-4-6 · live").
- **N2 — Canvas statis.** Layout radial + gambar neuron/sinaps dari data.
- **N3 — Animasi firing.** rAF: pulsa/ripple/decay; bedakan `live` vs near-live; failed merah; hemat CPU + stop saat hidden/mati.
- **N4 — Overlay & interaksi.** Label live/"~Ns lalu", tooltip detail.
- **N5 — Integrasi.** Emit di `chat-service.ts`; daftar halaman + ikon; guard server; empty state.
- **N6 (opsional) — Enhancement.** Mini-widget Overview; jalur C log-tap di belakang flag; badge/tray berkedip.

---

## 10. Rencana Uji

- **Unit (util murni):**
  - `useNeuronGraph`: (a) start→firing live; end→update failed/latency; (b) **dedupe**: request Claude yang muncul di A lalu B **tidak** dobel-firing; (c) recent[] Gemini (tak ada di A) → firing near-live; (d) `timestamp` null → fallback hash.
  - `layout.ts` deterministik & tak tumpang-tindih; `palette.ts` fallback; `physics.ts` easing clamp + decay monotonik.
- **Manual:** hit Claude dari VS Code → neuron **instan**; hit Gemini dari VS Code → neuron menyala **~beberapa detik** (jalur B) tanpa dobel; chat in-app → instan (akurat provider); matikan server → animasi stop + hint; sembunyikan window → rAF stop (cek CPU); bug sengaja di emit → proxy **tetap** melayani (try/catch).
- Pola tes mengikuti `*.test.ts` yang sudah ada.

---

## 11. Jebakan (Pitfalls)

1. **`chat-proxy.js` kini disentuh → tak lagi verbatim.** Wajib: emit **non-blocking + try/catch**, tak menyentuh `body`/stream. Sasaran mutlak: **mustahil** memengaruhi request VS Code/JetBrains. Uji jalur gagal (§10).
2. **Dedupe lintas-jalur.** Claude muncul di A **dan** B. Tanpa dedupe → neuron dobel-firing/berkedip ganda. Kunci: `reqId` (A) + jendela `(model, ts)` ±20 dtk (§4).
3. **Backend jangan import Electron.** `chat-proxy.js` hanya import `./activity-bus.js`; `broadcast` di-wire dari `index.ts`. Melanggar ini = backend tak lagi bisa dijalankan di luar Electron + risiko import cycle.
4. **Provider dari proxy = best-effort.** Proxy hanya lihat string `model` (dan hanya Claude yang lewat). Provider sebenarnya untuk non-Claude datang dari `recent[]`/chat-service. Jangan hard-code atribusi.
5. **Jeda 15 dtk jalur B nyata** (`usage-poller.js:9`). Firing near-live diberi label jujur ("~Ns lalu"), beda corak dari `live`. Jangan klaim semua realtime.
6. **`recent[]` hanya terisi bila usage-statistics ON** (`usage-poller.js:16`) & CLIProxyAPI reachable. Tangani empty state.
7. **Ring buffer `unshift`, dipotong 50** (`usage-store.js:118,131,186`): deret menurun waktu; burst >50 antar-poll bisa hilang — cukup untuk visual, angka akurat dari `byProviderModel`.
8. **Biaya animasi.** Stop rAF saat `document.hidden`/server mati; turunkan fps saat resting; `prefers-reduced-motion` → statis. DPR untuk anti-buram Retina; label DOM relayout saat resize.
9. **`broadcast` fan-out ke semua window** (`events.ts:22`) — Quick Chat juga menerima "activity". Pastikan hanya halaman Neuron (dan mini-widget) yang subscribe; halaman lain abaikan.
10. **Log-tap (C) rapuh** — flag + fallback senyap; jangan jadikan sumber kebenaran metrik.

---

## 12. Ringkas Keputusan

- **Pendekatan:** **Hybrid A + B** (C opsional). A = proxy-tap instan (Claude + chat in-app) via `activity-bus.js`→`broadcast`; B = poll `recent[]` untuk Gemini/GPT & rekonsiliasi. Dedupe lintas-jalur wajib.
- **Realtime:** Claude & chat in-app **instan (milidetik)**; provider lain **near-live (≤~15 dtk)**, ditandai jujur.
- **Sentuhan kode:** 1 file backend baru (`activity-bus.js`) + edit kecil aman `chat-proxy.js`/`index.ts`/`chat-service.ts` + renderer `pages/neuron/*`. Nol endpoint/port baru. Reuse `broadcast`, `onEvent`, `api.getUsageTokens`, `usePolling`.
- **Visual:** Canvas 2D + rAF (pulsa/ripple/glow, bedakan live vs near-live) + overlay DOM, warna aurora per provider.
