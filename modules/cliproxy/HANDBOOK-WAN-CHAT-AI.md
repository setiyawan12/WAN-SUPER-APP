# Handbook: Fitur Chat AI (wan-cliproxyapi-dekstop)

Panduan lengkap menambahkan **Chat AI di dalam app** (ala Claude Desktop) ke `wan-cliproxyapi-dekstop`, memanfaatkan infrastruktur yang sudah ada: chat-proxy `127.0.0.1:4317`, katalog model `/api/models`, multi-akun CLIProxyAPI, usage-store, dan sistem desain aurora.

Prinsip: **tidak menyentuh backend verbatim** dan **tidak membuka port baru**. Chat mengalir lewat main process (IPC) → chat-proxy yang sudah ada → CLIProxyAPI.

---

## 1. Gambaran Arsitektur

```
┌─────────────────────────── Electron App ───────────────────────────┐
│  Renderer (React)                                                   │
│  └── pages/Chat.tsx  ─ ConversationSidebar · MessageList · Composer │
│         │  window.wan.chat.start(reqId, payload)                    │
│         │  window.wan.chat.onStream(cb)   ← delta/usage/done/error  │
│         ▼ contextBridge (preload)                                   │
│  Main Process                                                       │
│  ├── chat-service.ts   spawn fetch stream → parse SSE → broadcast   │
│  ├── chat-store.ts      simpan percakapan JSON di userData          │
│  └── ipc.ts             chat:start · chat:abort · convo:* handlers  │
│         │ fetch (loopback)                                          │
│         ▼                                                           │
│  chat-proxy (verbatim)  POST /api/proxy/v1/chat/completions :4317   │
│         │  strip top_p/temperature/top_k utk Claude, pipe SSE       │
│         ▼                                                           │
│  CLIProxyAPI :8317  →  provider (Claude / Gemini / GPT / …)         │
└─────────────────────────────────────────────────────────────────────┘
```

**Kunci desain — streaming lewat IPC.** Renderer memakai `file://` (produksi), jadi `fetch` ke `127.0.0.1` diblok CORS dan CSP `connect-src 'none'` tetap dipertahankan. Karena itu **main process** yang melakukan fetch streaming ke chat-proxy, lalu **mem-broadcast tiap potongan token** ke renderer via event channel. Renderer tidak pernah menyentuh HTTP.

Yang **tidak** perlu diubah: chat-proxy sudah mendukung streaming SSE (itu yang dipakai VS Code). Jadi fitur chat = kode baru di main (service + store + ipc) + halaman renderer, tanpa mengutak-atik `backend/`.

---

## 2. Prasyarat & Dependensi

Tambahan di renderer (di-bundle Vite, semua dari npm, tidak ada remote script → CSP aman):

```bash
npm i react-markdown remark-gfm rehype-highlight highlight.js
# opsional fase lanjut:
npm i js-tiktoken            # hitung token akurat
npm i katex rehype-katex remark-math   # render rumus matematika
```

Tidak ada dependensi baru di main process — cukup `fetch` global (Electron/Node 20) dan modul `node:*` bawaan.

---

## 3. Model Data & Penyimpanan

Percakapan disimpan sebagai JSON di `app.getPath("userData")/conversations/<id>.json`, plus satu `index.json` (daftar ringkas untuk sidebar). Pola sama seperti `app-settings.ts`.

```ts
// src/main/chat-types.ts  (dibagi ke renderer via type-only import)
export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;                 // markdown mentah
  model?: string;                  // model yang menjawab (assistant)
  provider?: string;               // atribusi akun/provider
  createdAt: number;
  usage?: { input: number; output: number; total: number; costUsd?: number };
  attachments?: { type: "image"; dataUrl: string }[]; // fase 2
  error?: string;
}

export interface Conversation {
  id: string;
  title: string;                   // auto dari pesan pertama, bisa di-rename
  model: string;                   // model aktif percakapan
  systemPrompt?: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface ConversationSummary {
  id: string; title: string; model: string; updatedAt: number; messageCount: number;
}
```

Aturan: index.json = sumber cepat untuk sidebar; file per-percakapan = isi penuh. Tulis atomik (tulis ke `.tmp` lalu rename) agar tidak korup saat app ditutup di tengah simpan.

---

## 4. Tahap 1 (MVP) — Chat Service + Streaming

### 4.1 `src/main/chat-service.ts`

```ts
import { randomUUID } from "node:crypto";
import { backendUrl } from "./config.js";
import { broadcast } from "./events.js";

// Ambil proxy API key sekali (chat-proxy meneruskan Authorization; CLIProxyAPI
// menerapkan proxy-auth-nya sendiri). Di-cache; refresh saat 401.
let cachedKey: string | null = null;
async function proxyKey(): Promise<string> {
  if (cachedKey) return cachedKey;
  try {
    const r = await fetch(`${backendUrl()}/api/models/export`);
    cachedKey = (await r.json()).apiKey ?? "";
  } catch { cachedKey = ""; }
  return cachedKey!;
}

const inflight = new Map<string, AbortController>();

export interface ChatStartPayload {
  reqId: string;
  model: string;
  messages: { role: string; content: unknown }[]; // OpenAI shape
  temperature?: number;
  maxTokens?: number;
}

export async function startChat(p: ChatStartPayload): Promise<void> {
  const ctrl = new AbortController();
  inflight.set(p.reqId, ctrl);

  const body = {
    model: p.model,
    messages: p.messages,
    stream: true,
    stream_options: { include_usage: true }, // usage di chunk terakhir
    ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
    ...(p.maxTokens !== undefined ? { max_tokens: p.maxTokens } : {}),
  };

  try {
    const res = await fetch(`${backendUrl()}/api/proxy/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${await proxyKey()}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      broadcast("chat", { reqId: p.reqId, type: "error", error: `HTTP ${res.status} ${text}` });
      return;
    }

    // --- Parse SSE: "data: {json}\n\n", diakhiri "data: [DONE]" ---
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";            // sisakan baris tak lengkap
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const data = t.slice(5).trim();
        if (data === "[DONE]") { broadcast("chat", { reqId: p.reqId, type: "done" }); return; }
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) broadcast("chat", { reqId: p.reqId, type: "delta", text: delta });
          if (json.usage) broadcast("chat", { reqId: p.reqId, type: "usage", usage: json.usage });
        } catch { /* keep-alive / baris kosong — abaikan */ }
      }
    }
    broadcast("chat", { reqId: p.reqId, type: "done" });
  } catch (err: any) {
    if (err?.name === "AbortError") broadcast("chat", { reqId: p.reqId, type: "aborted" });
    else broadcast("chat", { reqId: p.reqId, type: "error", error: err?.message ?? String(err) });
  } finally {
    inflight.delete(p.reqId);
  }
}

export function abortChat(reqId: string): void {
  inflight.get(reqId)?.abort();
}
```

> Catatan: `broadcast` (di `events.ts`) mengirim ke channel `wan:event`. Untuk chat, dipakai sub-type `"chat"` supaya bisa dibedakan dari event lain (health, sync). Alternatif rapi: tambahkan channel khusus `wan:chat`.

### 4.2 IPC & Preload

`src/main/ipc.ts` — tambah:

```ts
import { startChat, abortChat } from "./chat-service.js";
// ...
ipcMain.handle("chat:start", (_e, p) => { void startChat(p); });     // fire-and-forget
ipcMain.handle("chat:abort", (_e, reqId: string) => abortChat(reqId));
```

`src/preload/index.cjs` — tambah namespace `chat`:

```js
chat: {
  start: (payload) => invoke("chat:start", payload),
  abort: (reqId) => invoke("chat:abort", reqId),
  onStream: (cb) => {
    const listener = (_e, data) => { if (data?.type && data.reqId) cb(data); };
    ipcRenderer.on("wan:event", listener);
    return () => ipcRenderer.removeListener("wan:event", listener);
  },
},
```

`src/renderer/wan.d.ts` — tambah tipe:

```ts
export type ChatStreamEvent =
  | { reqId: string; type: "delta"; text: string }
  | { reqId: string; type: "usage"; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }
  | { reqId: string; type: "done" }
  | { reqId: string; type: "aborted" }
  | { reqId: string; type: "error"; error: string };

// di dalam WanBridge:
chat: {
  start: (p: { reqId: string; model: string; messages: unknown[]; temperature?: number; maxTokens?: number }) => Promise<void>;
  abort: (reqId: string) => Promise<void>;
  onStream: (cb: (ev: ChatStreamEvent) => void) => () => void;
};
```

### 4.3 Halaman Renderer `src/renderer/pages/Chat.tsx`

Struktur komponen:

```
Chat.tsx
├── ConversationSidebar   (daftar chat, New chat, search, rename/delete)
├── ChatHeader            (judul, ModelPicker, tombol Clear)
├── MessageList
│    └── MessageBubble    (markdown + code copy + aksi: Copy/Retry/Edit/Delete)
└── Composer              (textarea auto-grow, Send/Stop, lampiran fase 2)
```

Inti alur kirim + streaming:

```tsx
const reqId = crypto.randomUUID();
// 1. push pesan user + pesan assistant kosong (placeholder streaming)
setMessages((m) => [...m, userMsg, { id: aid, role: "assistant", content: "", model, createdAt: Date.now() }]);

// 2. subscribe stream SEBELUM start
const off = window.wan.chat.onStream((ev) => {
  if (ev.reqId !== reqId) return;
  if (ev.type === "delta") setMessages((m) => patch(m, aid, (x) => ({ ...x, content: x.content + ev.text })));
  else if (ev.type === "usage") setMessages((m) => patch(m, aid, (x) => ({ ...x, usage: mapUsage(ev.usage, model) })));
  else if (ev.type === "done" || ev.type === "aborted") { off(); setBusy(false); void saveConvo(); }
  else if (ev.type === "error") { off(); setBusy(false); toast.error(ev.error); }
});

// 3. start
setBusy(true);
await window.wan.chat.start({
  reqId, model,
  messages: buildOpenAiMessages(systemPrompt, messages, userMsg),
  temperature, maxTokens,
});
```

`buildOpenAiMessages`: gabungkan system prompt (jika ada) + seluruh riwayat + pesan baru menjadi array `{ role, content }`. Untuk teks biasa `content` = string; untuk vision (fase 2) `content` = array `[{type:"text",text},{type:"image_url",image_url:{url:dataUrl}}]`.

**Stop:** tombol Stop memanggil `window.wan.chat.abort(reqId)`.

### 4.4 Render Markdown + Kode

```tsx
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";   // atau tema aurora custom

<Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}
  components={{ pre: CodeBlockWithCopy, a: ExternalLink }}>
  {message.content}
</Markdown>
```

- `CodeBlockWithCopy`: bungkus `<pre>` dengan tombol Copy (pakai `window.wan.copyText`).
- `ExternalLink`: link buka lewat `window.wan.openExternal` (jangan navigasi di dalam app).
- Saat streaming, tampilkan kursor kedip (`▍`) di akhir konten assistant sampai `done`.

### 4.5 Penyimpanan Percakapan (`chat-store.ts` + IPC)

Handler IPC baru: `convo:list`, `convo:get`, `convo:save`, `convo:delete`, `convo:rename`. Semua baca/tulis di `userData/conversations/`. Debounce `convo:save` 500ms saat streaming agar tidak menulis tiap token.

Judul otomatis: ambil ~6 kata pertama dari pesan user pertama (atau minta model membuat judul singkat di panggilan terpisah — fase lanjut).

---

## 5. Integrasi Model & Parameter

- **Daftar model**: `api.getModels()` (yang sudah ada) → filter `enabled`, tampilkan di ModelPicker beserta badge `vision`/`thinking`.
- **Ganti model di tengah chat**: simpan `conversation.model`; pesan berikutnya pakai model baru (tandai per pesan model mana yang menjawab).
- **Parameter Claude**: kirim `temperature`/`max_tokens` bebas — chat-proxy **otomatis membuang** `top_p/temperature/top_k` untuk model Claude, jadi tidak akan error 400. Untuk non-Claude parameter diteruskan.
- **Context length**: ambil dari katalog model; tampilkan meter "x / N token" di composer; peringatkan sebelum melebihi (fase 2 pakai tokenizer, MVP pakai heuristik `chars/4`).

---

## 6. Usage & Estimasi Biaya

- Minta usage lewat `stream_options.include_usage` → chunk terakhir berisi `usage`.
- Hitung biaya dengan `ratesFor(provider)` + `PRICING_PER_MILLION` (sudah ada di `lib/utils.ts`):
  `costUsd = input/1e6*rate.input + output/1e6*rate.output`.
- Tampilkan kecil di bawah tiap balasan: `1.2K in · 340 out · ~$0.01`.
- Opsional: akumulasi ke usage-store agar muncul di halaman Usage.

---

## 7. Tahap 2 — Lampiran, Vision, Persona

- **Gambar (vision)**: drag-drop / paste → encode base64 data URL → sisipkan sebagai `image_url`. Hanya aktifkan tombol lampiran gambar bila `model.capabilities.vision === true`.
- **File teks/PDF**: baca isi (PDF via ekstraksi teks) → sisipkan sebagai blok konteks di pesan user, dengan penanda nama file.
- **System prompt / Persona**: field per percakapan; simpan preset persona (mirip ProxyAI Personas) di app-settings.
- **Token counter akurat**: `js-tiktoken` untuk model OpenAI-like; untuk Claude pakai estimasi (tokenizer resmi tak tersedia offline).
- **Regenerate / ganti model**: tombol Retry pada balasan → ulang dengan model yang dipilih.
- **Edit & resend**: edit pesan user → potong riwayat setelahnya → kirim ulang (branching sederhana).

---

## 8. Tahap 3 — Konteks Lanjut & Artifacts

- **@-mention file/folder**: picker file dalam workspace/proyek → sisipkan isi sebagai konteks (batasi ukuran, tampilkan chip).
- **Web fetch**: ambil URL (lewat main, bukan renderer) → ringkas jadi konteks.
- **Panel Artifacts**: deteksi blok ```html / ```svg / ```mermaid atau markdown panjang → render live di panel samping (iframe sandbox untuk HTML). Ini fitur khas Claude yang memberi "wow".
- **Bandingkan model**: kirim prompt sama ke 2 model berdampingan (dua kolom streaming).

---

## 9. Tahap 4 — Quick-Chat, Hotkey Global, Tools

- **Global hotkey** (`globalShortcut.register("CommandOrControl+Shift+Space")`) → buka **jendela quick-chat** mini (BrowserWindow kecil, frameless, always-on-top) untuk tanya cepat lalu tutup.
- **Quick-chat dari tray**: item menu "Ask AI…".
- **Projects/Spaces**: kelompokkan percakapan + konteks + persona per proyek.
- **Tools / function-calling (gaya MCP)**: definisikan tool lokal; parsing `tool_calls` dari respons; eksekusi di main; kirim hasil balik. (Perlu model yang mendukung tool-calling.)
- **Voice input**: Web Speech API / whisper lokal (opsional).

---

## 10. Keamanan

- **Tetap loopback-only** — main yang fetch `127.0.0.1`; renderer tak pernah buka koneksi (CSP `connect-src 'none'` dipertahankan).
- **contextIsolation + sandbox tetap `true`** — chat lewat channel `wan.chat.*` bernama, tidak expose `ipcRenderer` mentah.
- **Penyimpanan 100% lokal** di `userData`; sediakan "Clear all conversations".
- **Jangan log isi chat / API key**; maskkan bila perlu.
- **Artifacts HTML** wajib `<iframe sandbox>` tanpa `allow-same-origin` untuk mencegah skrip artifact mengakses app.
- **Lampiran file**: batasi ukuran & tipe; jangan eksekusi apa pun.

---

## 11. Daftar Jebakan (wajib diperhatikan)

1. **Subscribe stream SEBELUM `chat.start`** — kalau start dulu, delta pertama bisa hilang (race).
2. **Buffer SSE lintas-chunk** — satu event JSON bisa terbelah dua `reader.read()`. Selalu simpan sisa baris tak lengkap (`buf`), jangan `JSON.parse` per-chunk mentah.
3. **`[DONE]` menandai akhir**, tapi tetap pasang fallback `done` saat reader habis (beberapa upstream tak kirim `[DONE]`).
4. **Abort dua arah** — kalau user Stop atau menutup chat, panggil `abort(reqId)` agar stream upstream ke CLIProxyAPI ikut ditutup (hemat kuota).
5. **Backpressure event** — untuk model super cepat, broadcast per-token bisa membanjiri IPC. Kalau UI tersendat, batch delta ~16–33ms sebelum kirim.
6. **Jangan simpan tiap token ke disk** — debounce `convo:save`; simpan final saat `done`.
7. **`reqId` unik & cocokkan di renderer** — event channel dibagi banyak fitur (health, sync). Selalu filter `ev.reqId`.
8. **Parameter Claude** sudah di-strip chat-proxy — jangan tambah strip lagi di sisi chat (dobel kerja), cukup kirim apa adanya.
9. **Model prefixed** (`claude/…`) valid sebagai `model` — kirim `m.id` apa adanya, jangan dipangkas.
10. **Markdown mid-stream** — konten belum lengkap (code block belum ditutup) bisa bikin highlighter "meloncat". Aman kok, tapi jangan memoize berat per token; render ringan.
11. **StrictMode double-mount** (dev) — pastikan unsubscribe `onStream` di cleanup effect agar listener tidak dobel.
12. **Tulis percakapan atomik** (`.tmp` → rename) supaya tidak korup saat quit di tengah simpan.

---

## 12. Checklist Smoke Test

1. Kirim pesan sederhana → token mengalir, kursor kedip, selesai bersih.
2. Model Claude → **tidak** ada error `temperature is deprecated`; streaming lancar.
3. Stop di tengah → berhenti seketika; `ps`/log CLIProxyAPI tak menyisakan stream nyangkut.
4. Ganti model di tengah percakapan → balasan berikut pakai model baru, riwayat utuh.
5. Tutup app saat streaming → tidak crash, tak ada file percakapan korup.
6. Buka lagi → riwayat tampil, judul & isi benar.
7. Code block panjang → highlight benar + tombol Copy jalan.
8. Usage muncul (`x in · y out · ~$…`) setelah `done`.
9. Model vision + gambar (fase 2) → dijawab; model non-vision → tombol gambar nonaktif.
10. Buat banyak percakapan → sidebar cepat (pakai index.json), search jalan.

---

## 13. Peta File (ringkas)

```
src/main/
├── chat-types.ts        # tipe dibagi (type-only) ke renderer
├── chat-service.ts      # fetch stream + parse SSE + broadcast + abort
├── chat-store.ts        # CRUD percakapan JSON di userData
└── ipc.ts               # + chat:start/abort, convo:*
src/preload/index.cjs    # + namespace wan.chat.*
src/renderer/
├── pages/Chat.tsx
├── chat/ConversationSidebar.tsx
├── chat/MessageList.tsx
├── chat/MessageBubble.tsx
├── chat/Composer.tsx
├── chat/ModelPicker.tsx
├── chat/CodeBlock.tsx           # markdown code + copy
├── chat/useChat.ts              # hook: state pesan + streaming
└── wan.d.ts                     # + tipe chat
```

Tambah entri nav `{ id: "chat", label: "Chat" }` di `App.tsx` (ikon balon chat), render `<Chat/>`.

---

## 14. Milestones

| # | Milestone | Isi | Estimasi |
|---|---|---|---|
| M1 | Streaming inti | Tahap 4: chat-service, IPC, satu thread, streaming, stop | 2–3 hari |
| M2 | Riwayat + Markdown | chat-store, sidebar, render markdown+kode, judul otomatis | 2–3 hari |
| M3 | Model & biaya | ModelPicker, ganti model, usage/estimasi biaya, token meter | 1–2 hari |
| M4 | Lampiran & persona | Tahap 7: vision, file, system prompt, regenerate/edit | 2–4 hari |
| M5 | Konteks & artifacts | Tahap 8: @-file, web fetch, panel artifacts | 3–5 hari |
| M6 | Quick-chat & tools | Tahap 9: hotkey global, jendela mini, projects, tools | 3–5 hari |

**MVP yang benar-benar berguna = M1 + M2 + M3** (±1 minggu): chat streaming penuh, multi-percakapan tersimpan, ganti model, dengan tampilan aurora yang sudah ada. Sisanya penambahan bertahap.

---

## 15. Catatan Integrasi dengan App Sekarang

- **Reuse komponen**: `PageHeader`, `CardHead`, `EmptyState`, `Skeleton`, `toast`, dan token CSS aurora — chat langsung senada.
- **Reuse transport**: pola `window.wan.*` + `broadcast`/`wan:event` persis seperti fitur health/sync yang sudah jalan.
- **Reuse data**: `/api/models`, usage-store, tabel harga — tanpa endpoint baru.
- **Zero perubahan backend**: chat-proxy verbatim sudah streaming-ready; hanya lapisan main + renderer yang bertambah.
```
