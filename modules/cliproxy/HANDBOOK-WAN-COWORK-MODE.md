# Handbook: Cowork Mode (wan-cliproxyapi-dekstop)

Panduan lengkap menambahkan **mode agentik ala Claude Cowork / Claude Code** ke app: pilih folder project, lalu AI bisa **baca, buat, ubah, hapus file, cari, dan menjalankan perintah** — dengan persetujuan dan pengaman.

Prinsip: **bangun di atas yang sudah ada** — chat streaming, loop tool (`fetch_url` sudah ada), IPC bridge, dan main process dengan akses filesystem penuh. Tidak menyentuh backend verbatim; semua operasi file hidup di **main process** (aman: renderer tak pernah menyentuh fs).

---

## 1. Gambaran Arsitektur

```
┌──────────────────────────── Electron App ────────────────────────────┐
│  Renderer (Chat + Cowork UI)                                          │
│  ├── ProjectBar     pilih folder · status git · checkpoint            │
│  ├── ToolTimeline   daftar tool-call (read/edit/run) live             │
│  ├── ApprovalCard   Approve / Reject aksi menulis/menjalankan         │
│  └── DiffViewer     before/after tiap edit                            │
│        │ window.wan.chat.start()  ·  chat.approve(id)/reject(id)      │
│        ▼ contextBridge                                                │
│  Main Process                                                         │
│  ├── agent-loop.ts     kirim tools → tangani tool_calls → ulang       │
│  ├── tools/            registry: fs.read/write/edit/delete/list/search│
│  │                      + run_command (terminal)                      │
│  ├── project.ts        root terpilih · path-guard · git checkpoint    │
│  ├── approvals.ts      janji (promise) menunggu keputusan user        │
│  └── chat-service.ts   (yang sudah ada) streaming SSE + tool deltas   │
│        │ fetch (loopback)                                             │
│        ▼                                                              │
│  chat-proxy :4317  →  CLIProxyAPI :8317  →  model (tool-calling)      │
└───────────────────────────────────────────────────────────────────────┘
        │ fs (Node)                    │ child_process
        ▼                              ▼
  <project root>/**              terminal (approval-gated)
```

**Alur agent (agentic loop):**
1. User kirim pesan + folder project terpilih.
2. Main kirim request ke model **beserta daftar `tools`** (function schemas) + konteks pohon folder.
3. Model membalas dengan `tool_calls` (mis. `read_file`, `edit_file`).
4. Main mengeksekusi tool (tool baca langsung; tool tulis/jalankan **menunggu approval user**), lalu kirim hasil balik sebagai pesan `role:"tool"`.
5. Ulangi ke langkah 2 sampai model selesai (`finish_reason: "stop"`).

Kamu **sudah punya** loop ini untuk `fetch_url`. Cowork = tambah tool filesystem + project root + approval + diff.

---

## 2. Prasyarat

- **Model harus mendukung function/tool-calling.** Claude, GPT, Gemini mendukung. Sebagian model via CLIProxyAPI mungkin tidak — sediakan fallback (lihat Jebakan #9).
- Sanitizer 4317 **tidak** membuang param `tools` — jadi tool-calling lewat aman (hanya `temperature/top_p/top_k` yang di-strip untuk Claude).
- Dependensi baru (renderer): `diff` (unified diff) untuk DiffViewer. Main: cukup `node:fs`, `node:path`, `node:child_process`, `node:crypto`.

```bash
npm i diff
```

---

## 3. Model Data & Penyimpanan

`Project` disimpan per-percakapan (atau global) di `app-settings`/conversation JSON:

```ts
// src/main/cowork-types.ts (type-only dibagi ke renderer)
export interface Project {
  id: string;
  name: string;        // basename folder
  root: string;        // absolute path folder terpilih
  git: boolean;        // ada .git?
  addedAt: number;
}

export type ToolStatus = "running" | "ok" | "error" | "rejected";

export interface ToolCallView {
  id: string;
  name: string;               // read_file, edit_file, run_command, …
  args: Record<string, unknown>;
  status: ToolStatus;
  summary?: string;           // "read src/App.tsx (120 lines)"
  diff?: string;              // unified diff utk edit/write
  output?: string;            // stdout/stderr utk run_command
  error?: string;
}

export interface ApprovalRequest {
  id: string;
  tool: string;               // edit_file / delete_file / run_command
  title: string;              // "Edit src/App.tsx"
  detail: string;             // diff atau command
  danger: boolean;
}
```

Konvensi: percakapan yang punya `projectId` = "Cowork session"; tanpa itu = chat biasa. Tool filesystem hanya aktif kalau ada project root.

---

## 4. Tahap 1 — Project Root & Path Guard

### 4.1 Pilih folder (main)

```ts
// src/main/project.ts
import { dialog } from "electron";
import fs from "node:fs";
import path from "node:path";

let root: string | null = null;

export async function pickProject(): Promise<Project | null> {
  const r = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  if (r.canceled || !r.filePaths[0]) return null;
  root = fs.realpathSync(r.filePaths[0]);
  return {
    id: crypto.randomUUID(),
    name: path.basename(root),
    root,
    git: fs.existsSync(path.join(root, ".git")),
    addedAt: Date.now(),
  };
}

export function setRoot(p: string) { root = fs.realpathSync(p); }
export function getRoot(): string | null { return root; }
```

### 4.2 Path guard (WAJIB — pagar keamanan utama)

Setiap tool yang menerima `path` HARUS lewat ini. Menolak keluar dari root, `..`, dan symlink yang lolos keluar.

```ts
export function resolveInside(rel: string): string {
  if (!root) throw new Error("No project selected");
  const abs = path.resolve(root, rel);
  // realpath melindungi dari symlink yang menembus keluar root
  const real = fs.existsSync(abs) ? fs.realpathSync(abs) : abs;
  const rootReal = fs.realpathSync(root);
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    throw new Error(`Path escapes project root: ${rel}`);
  }
  return abs;
}
```

---

## 5. Tahap 2 — Tool Registry

Tiap tool = schema (untuk dikirim ke model) + implementasi + flag butuh-approval.

```ts
// src/main/tools/index.ts
export interface Tool {
  name: string;
  description: string;
  parameters: object;          // JSON Schema
  needsApproval: boolean;      // write/delete/run = true
  danger?: boolean;            // delete/run = true
  run: (args: any, ctx: ToolCtx) => Promise<string>;   // hasil (string) utk model
}

export interface ToolCtx {
  emit: (patch: Partial<ToolCallView>) => void;   // update UI live
}

export const TOOLS: Tool[] = [ readFile, listDir, search, writeFile, editFile, createFile, deleteFile, runCommand ];

// Format yang dikirim ke model (OpenAI tools):
export function toolSchemas() {
  return TOOLS.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}
export const byName = (n: string) => TOOLS.find((t) => t.name === n);
```

---

## 6. Tahap 3 — Agentic Loop (inti)

Perluasan `chat-service.ts`. Bedanya dari chat biasa: streaming bisa berisi **`tool_calls`** (bukan hanya teks), dan setelah tool dieksekusi, **panggil model lagi** (multi-round).

### 6.1 Akumulasi tool-call dari stream

Delta streaming mengirim `tool_calls` secara **terpotong**: `index`, `id` & `name` di chunk awal, `arguments` sebagai potongan string yang harus digabung.

```ts
// di dalam loop baca SSE:
const delta = json.choices?.[0]?.delta;
if (delta?.content) broadcast("chat", { reqId, type: "delta", text: delta.content });
for (const tc of delta?.tool_calls ?? []) {
  const slot = (calls[tc.index] ??= { id: tc.id, name: "", args: "" });
  if (tc.id) slot.id = tc.id;
  if (tc.function?.name) slot.name = tc.function.name;
  if (tc.function?.arguments) slot.args += tc.function.arguments;   // gabung fragmen
}
const finish = json.choices?.[0]?.finish_reason;   // "tool_calls" | "stop" | …
```

### 6.2 Loop utama

```ts
async function runAgent(reqId, messages, model, projectOn) {
  for (let round = 0; round < MAX_ROUNDS; round++) {   // batasi mis. 25
    const { text, calls, finish } = await streamOnce(reqId, {
      model, messages, stream: true,
      tools: projectOn ? toolSchemas() : undefined,
    });

    // Simpan giliran assistant (dengan tool_calls) ke riwayat
    messages.push({ role: "assistant", content: text || null, tool_calls: calls.map(toApiCall) });

    if (finish !== "tool_calls" || calls.length === 0) { broadcast("chat", { reqId, type: "done" }); return; }

    // Eksekusi tiap tool → hasil jadi pesan role:"tool"
    for (const c of calls) {
      const tool = byName(c.name);
      const args = safeJson(c.args) ?? {};
      const view = { id: c.id, name: c.name, args, status: "running" };
      broadcast("chat", { reqId, type: "tool", view });

      let result: string;
      try {
        if (tool.needsApproval && !(await requestApproval(reqId, tool, args))) {
          result = "User rejected this action.";
          broadcast("chat", { reqId, type: "tool", view: { ...view, status: "rejected" } });
        } else {
          result = await tool.run(args, { emit: (p) => broadcast("chat", { reqId, type: "tool", view: { ...view, ...p } }) });
          broadcast("chat", { reqId, type: "tool", view: { ...view, status: "ok" } });
        }
      } catch (e) {
        result = `Error: ${e.message}`;
        broadcast("chat", { reqId, type: "tool", view: { ...view, status: "error", error: e.message } });
      }
      messages.push({ role: "tool", tool_call_id: c.id, content: result });
    }
    // lanjut round berikutnya: model membaca hasil tool, lalu lanjut/selesai
  }
  broadcast("chat", { reqId, type: "error", error: "Max tool rounds reached" });
}
```

> `streamOnce` = pembungkus fetch+SSE (dari chat-service) yang mengembalikan `{ text, calls, finish }`.

---

## 7. Tahap 4 — Tools Read-only (mulai dari sini)

Aman, tanpa approval. Sudah berguna untuk "ngobrol soal project-ku".

- **`list_dir(path=".")`** → daftar isi (hormati `.gitignore`, sembunyikan `node_modules/.git`). Untuk konteks awal, kirim **pohon ringkas** (kedalaman terbatas).
- **`read_file(path, [start,end])`** → isi file (batasi ukuran; potong file besar, kirimkan rentang baris).
- **`search(query, [glob])`** → grep sederhana (ripgrep bila ada, atau scan JS) → daftar `file:line: match`.

Contoh implementasi `read_file`:

```ts
const readFile: Tool = {
  name: "read_file",
  description: "Read a UTF-8 text file inside the project.",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  needsApproval: false,
  async run({ path: rel }, { emit }) {
    const abs = resolveInside(rel);
    const text = fs.readFileSync(abs, "utf8");
    const lines = text.split("\n").length;
    emit({ summary: `read ${rel} (${lines} lines)` });
    return text.length > 60_000 ? text.slice(0, 60_000) + "\n…(truncated)" : text;
  },
};
```

---

## 8. Tahap 5 — Tools Write + Approval + Diff

Semua yang mengubah disk: **butuh approval** dan **tampilkan diff**.

### 8.1 Approval (janji yang menunggu user)

```ts
// src/main/approvals.ts
const pending = new Map<string, (ok: boolean) => void>();

export function requestApproval(reqId, tool, args): Promise<boolean> {
  const id = crypto.randomUUID();
  broadcast("chat", { reqId, type: "approval", request: buildApprovalView(id, tool, args) });
  return new Promise((resolve) => pending.set(id, resolve));
}
export function resolveApproval(id: string, ok: boolean) {
  pending.get(id)?.(ok);
  pending.delete(id);
}
```

Renderer menampilkan `ApprovalCard` → tombol Approve/Reject → `window.wan.chat.approve(id)` / `reject(id)` → IPC → `resolveApproval`.

### 8.2 `edit_file` dengan diff

```ts
import { createTwoFilesPatch } from "diff";

const editFile: Tool = {
  name: "edit_file",
  description: "Replace the full contents of a file. Provide the complete new file.",
  parameters: { type: "object", properties: { path: {type:"string"}, content: {type:"string"} }, required: ["path","content"] },
  needsApproval: true,
  async run({ path: rel, content }, { emit }) {
    const abs = resolveInside(rel);
    const before = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
    const diff = createTwoFilesPatch(rel, rel, before, content);
    emit({ diff, summary: `edit ${rel}` });
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
    return `Wrote ${rel} (${content.split("\n").length} lines).`;
  },
};
```

> **Penting:** hitung `diff` dan kirim ke UI **sebelum** approval (di `requestApproval`), supaya user melihat perubahan sebelum menyetujui. Terapkan tulisan hanya setelah Approve.

Tool lain sepola: `create_file`, `write_file`, `delete_file` (danger:true — konfirmasi ekstra).

---

## 9. Tahap 6 — `run_command` (Terminal)

Paling kuat, paling berisiko → **selalu approval**, danger, dan **jangan** auto-run destruktif.

```ts
import { spawn } from "node:child_process";

const runCommand: Tool = {
  name: "run_command",
  description: "Run a shell command in the project root. Output is returned.",
  parameters: { type: "object", properties: { command: {type:"string"} }, required: ["command"] },
  needsApproval: true, danger: true,
  run({ command }, { emit }) {
    return new Promise((resolve) => {
      const child = spawn(command, { cwd: getRoot()!, shell: true });
      let out = "";
      const push = (b) => { out += b; emit({ output: out.slice(-8000) }); };   // stream live ke UI
      child.stdout.on("data", push);
      child.stderr.on("data", push);
      child.on("close", (code) => resolve(`exit ${code}\n${out.slice(-12000)}`));
      setTimeout(() => child.kill(), 120_000);   // timeout aman
    });
  },
};
```

Opsi keamanan tambahan: daftar-blokir perintah (`rm -rf /`, `sudo`, dll), atau mode "read-only shell".

---

## 10. Tahap 7 — Keamanan & Undo (Git Checkpoint)

- **Path guard** di setiap tool (§4.2). Non-negosiabel.
- **Approval** untuk semua write/delete/run; **diff/preview** sebelum setuju.
- **Checkpoint sebelum agent bekerja** supaya bisa undo:
  - Kalau folder ber-git: `git add -A && git commit -m "wan: checkpoint <ts>"` (atau tag). Undo = `git reset --hard <checkpoint>`.
  - Kalau tanpa git: tawarkan `git init` sekali, atau snapshot file yang akan diubah ke `.wan/backups/<ts>/`.
- **Batasi ronde** tool (`MAX_ROUNDS`) agar loop tak jalan tanpa henti.
- **contextIsolation/sandbox tetap on**; fs & child_process **hanya di main**.
- **Jangan kirim file rahasia** ke model tanpa sadar: hormati `.gitignore`, lewati `.env`, kunci/secret.

---

## 11. Tahap 8 — Konteks Project

- Saat sesi Cowork dimulai, sisipkan **pohon folder ringkas** (mis. kedalaman 2–3, tanpa `node_modules/.git`, hormati `.gitignore`) ke system/context message, plus `README`/`package.json` bila ada.
- `@`-mention (sudah ada) → tambahkan isi file spesifik.
- Biarkan model **meminta file sendiri** via `read_file` daripada mengirim semuanya (hemat token, akurat).

---

## 12. Tahap 9 — UI

- **ProjectBar** (di composer/header Cowork): tombol "Open folder…", nama project, badge git, tombol "Checkpoint" & "Undo".
- **ToolTimeline**: tiap `tool` event jadi baris — ikon per jenis (📖 read, ✏️ edit, ➕ create, 🗑 delete, ▶ run), status (spinner/ok/error/rejected), ringkasan.
- **ApprovalCard**: muncul saat `approval` event — judul + diff/command + Approve/Reject. Blokir lanjut sampai dijawab.
- **DiffViewer**: render unified diff (hijau/merah) untuk edit/write.
- **Output panel**: stdout/stderr `run_command` streaming.

Semua reuse token aurora + komponen (`CardHead`, `EmptyState`, `toast`).

---

## 13. Kontrak IPC (tambahan)

```
chat:start            (sudah ada, diperluas: kirim tools bila projectOn)
chat:approve(id)      → resolveApproval(id, true)
chat:reject(id)       → resolveApproval(id, false)
project:pick          → pickProject()  (dialog)
project:set(root)     → setRoot
project:state         → { root, name, git }
project:checkpoint    → git commit / snapshot
project:undo          → git reset / restore
```

Event ke renderer (via `wan:event`, sub-type "chat"): `delta` · `tool` (ToolCallView) · `approval` (ApprovalRequest) · `usage` · `done` · `error`.

Preload: tambah `wan.chat.approve/reject`, `wan.project.pick/state/checkpoint/undo`.

---

## 14. Daftar Jebakan

1. **Path traversal / symlink escape** — selalu `resolveInside` + `realpath`. Ini bug keamanan paling berbahaya.
2. **Akumulasi `tool_calls` streaming** — argumen datang terpotong; gabung per `index`, jangan `JSON.parse` sebelum lengkap.
3. **Riwayat tool** — setelah `tool_calls`, WAJIB push pesan `role:"assistant"` (dengan tool_calls) LALU satu `role:"tool"` per `tool_call_id`, baru panggil model lagi. Salah urutan → API menolak.
4. **Loop tak berhenti** — batasi `MAX_ROUNDS`; deteksi tool yang gagal berulang.
5. **Approval race** — simpan promise per-id; kalau user menutup chat/abort, resolve semua pending sebagai reject.
6. **File besar/biner** — batasi ukuran read; deteksi biner (byte NUL) dan tolak, jangan kirim ke model.
7. **Diff dihitung sebelum tulis** — tampilkan diff saat approval; tulis hanya setelah Approve. Jangan tulis dulu baru minta izin.
8. **`.gitignore`/secret** — jangan auto-baca `.env`/kunci ke konteks. Hormati ignore.
9. **Model tanpa tool-calling** — fallback: instruksikan model mengeluarkan blok aksi JSON (`{"tool":"edit_file","args":{…}}`) dan parse manual. Kurang andal; tandai model yang mendukung tools di katalog.
10. **`run_command` berbahaya** — approval + timeout + (opsional) blocklist; jalankan di `cwd = root`, jangan shell global.
11. **Abort di tengah tool** — batalkan child_process & tandai tool "aborted"; jangan tinggalkan proses orphan.
12. **Tulisan konkuren** — proses satu tool-call selesai sebelum berikutnya (serial) agar edit tak saling menimpa.

---

## 15. Checklist Smoke Test

1. Pilih folder → tree muncul; tanya "jelaskan struktur project" → model pakai `list_dir`/`read_file`.
2. Minta "tambahkan komentar di atas fungsi X di file Y" → muncul ApprovalCard + diff → Approve → file berubah, diff benar.
3. Reject sebuah edit → file **tidak** berubah; model menerima "rejected" dan menyesuaikan.
4. `read_file` di luar root (`../../etc/passwd`) → ditolak path-guard.
5. `run_command` "npm test" → approval → output streaming → hasil kembali ke model.
6. Checkpoint sebelum tugas → Undo mengembalikan semua perubahan.
7. Abort di tengah multi-round → berhenti bersih, tak ada proses/janji nyangkut.
8. Model Claude → tool-calling jalan (param sampling di-strip tak mengganggu tools).
9. File biner / .env → tidak terbaca ke konteks.
10. Loop 25 ronde tercapai → berhenti dengan pesan jelas, bukan hang.

---

## 16. Peta File

```
src/main/
├── cowork-types.ts       # tipe dibagi (type-only)
├── project.ts            # root, pickProject, resolveInside, git checkpoint/undo
├── approvals.ts          # requestApproval / resolveApproval
├── agent-loop.ts         # loop multi-round + akumulasi tool_calls
├── tools/
│   ├── index.ts          # registry + toolSchemas
│   ├── fs-read.ts        # read_file, list_dir, search
│   ├── fs-write.ts       # write/edit/create/delete (+diff)
│   └── run.ts            # run_command
└── ipc.ts                # + chat:approve/reject, project:*
src/renderer/
├── chat/ProjectBar.tsx
├── chat/ToolTimeline.tsx
├── chat/ApprovalCard.tsx
├── chat/DiffViewer.tsx
└── (Chat.tsx: render timeline + approval + project bar)
```

---

## 17. Milestones

| # | Milestone | Isi | Estimasi |
|---|---|---|---|
| C1 | Project + read-only | Tahap 1–4,7(guard): pilih folder, tree, read/list/search | 2–3 hari |
| C2 | Agentic loop | Tahap 3,6: multi-round tool loop + ToolTimeline | 2–4 hari |
| C3 | Write + approval + diff | Tahap 5,9: edit/create/delete + ApprovalCard + DiffViewer | 3–5 hari |
| C4 | Terminal | Tahap 6: run_command + output streaming + approval | 1–2 hari |
| C5 | Safety & undo | Tahap 10: git checkpoint/undo, blocklist, .gitignore | 1–2 hari |
| C6 | Konteks & polish | Tahap 8,12: tree injection, @-file, undo UI, empty states | 2–3 hari |

**MVP yang terasa "Cowork" = C1 + C2 + C3** (±1,5 minggu): pilih folder, agent baca & edit file dengan approval + diff. C4–C6 memperkuat & mengamankan.

---

## 18. Kenapa ini realistis untuk app-mu

- **Loop tool sudah ada** (`fetch_url`) — tinggal tambah tool filesystem + multi-round.
- **Main process = akses fs penuh** (Node) — tak perlu sandbox web yang membatasi.
- **Streaming, IPC, app-settings, komponen aurora** semua sudah jalan.
- **Model tool-calling** tersedia lewat CLIProxyAPI (Claude/GPT/Gemini).

Yang benar-benar baru dan wajib serius: **path guard, approval + diff, dan git-checkpoint** — tiga pengaman yang bikin agent aman dipakai di folder asli. Sisanya perpanjangan dari yang sudah kamu bangun.
```
