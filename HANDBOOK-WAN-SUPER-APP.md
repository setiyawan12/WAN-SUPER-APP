# Handbook: WAN Super App

Panduan lengkap menggabungkan **wan-cliproxyapi** + **wan-net** menjadi **satu aplikasi Electron** bernama **WAN Super App**, dengan:

- **Desain & fungsi masing-masing sub-app tetap sama persis** (tidak di-rewrite).
- Saat dibuka: **2 menu pilihan** → **WAN CLIProxyAPI** | **WAN NET**.
- Setelah pilih: masuk ke UI & logic app tersebut utuh.
- Semua logic **diambil dari existing project** (di-vendor / di-copy ke folder referensi) supaya AI/implementer tidak perlu memuat seluruh monorepo ke konteks.

---

## 0. Prinsip non-nego (baca dulu)

| # | Prinsip | Arti praktis |
|---|---------|--------------|
| P1 | **Reuse-verbatim** | Salin tree sumber dari `wan-cliproxyapi/` dan `wan-net/` ke subfolder; **jangan** reimplement fitur. Hanya bungkus shell. |
| P2 | **Isolation by namespace** | IPC channel, `userData`, port, tray menu, env prefix **berbeda per module**. Tidak ada bentrok `start-tunnel` vs `wan:request`. |
| P3 | **Lazy boot** | Sub-app **tidak** start server/binary sampai user **masuk** module itu (kecuali auto-resume opt-in). |
| P4 | **Hub is thin** | Hub/launcher hanya navigasi + branding + prefs global. Nol logika proxy/tunnel di hub. |
| P5 | **One Electron process** | Satu `app`, satu single-instance lock, banyak `BrowserWindow` atau satu window multi-view. Main process mendaftarkan **dua modul** terpisah. |
| P6 | **Referensi lokal** | Folder `vendor/` (atau `modules/`) berisi salinan kode sumber yang sudah jalan. Handbook ini + vendor = cukup untuk implementasi tanpa buka repo lain. |

**Nama produk**

| Field | Nilai |
|-------|--------|
| productName | `WAN Super App` |
| appId | `com.wan.superapp` |
| package name | `wan-super-app` |
| userData dir (default Electron) | `WAN Super App` / `wan-super-app` (platform-dependent) |
| Config hub | `{userData}/super-app.json` |
| Home cliproxy | `~/.wan-super-app/cliproxyapi` (atau `CLIPROXY_HOME`) |
| Config net | `{userData}/wan-net-cfg.json` (sama pola wan-net) |

---

## 1. Pengalaman pengguna (UX) — harus sama

### 1.1 First paint = Hub

```
┌──────────────────────────────────────────────────────────┐
│  WAN Super App                              [−] [□] [×]  │
│                                                          │
│         ⚡  WAN Super App                                 │
│         satu shell · dua alat dev                        │
│                                                          │
│   ┌────────────────────┐   ┌────────────────────┐        │
│   │  🧠 CLIProxyAPI    │   │  🌐 WAN NET         │        │
│   │  Proxy multi-model │   │  Tunnel + Inspector │        │
│   │  Chat · Cowork ·   │   │  Cloudflare URL     │        │
│   │  VS Code / JB      │   │  Replay · Mock      │        │
│   │                    │   │                    │        │
│   │     [ Buka → ]     │   │     [ Buka → ]     │        │
│   └────────────────────┘   └────────────────────┘        │
│                                                          │
│  ☑ Ingat pilihan terakhir   ☑ Start di tray              │
│  Version x.y.z                                           │
└──────────────────────────────────────────────────────────┘
```

- Desain hub **mengikuti visual language** wan-cliproxyapi (aurora dark: `#0b0c16`, ungu/violet glass sidebar) supaya terasa satu brand.
- Kartu WAN NET boleh pakai aksen ⚡ dari launcher wan-net, tapi **palette** diselaraskan (bukan rewrite UI internal NET).

### 1.2 Setelah pilih module

| Aksi | Hasil |
|------|--------|
| Klik **CLIProxyAPI** | Buka window/view **dashboard CLIProxyAPI utuh** (Overview, Chat, Providers, Models, Usage, Neuron, VS Code, JetBrains, Logs, Config). Semua halaman & fitur seperti app standalone. |
| Klik **WAN NET** | Buka window/view **launcher WAN NET utuh** (multi-tunnel, CF manager, inspector, rate limit, QR, settings). Sama seperti `electron/launcher.html` + logic `main.js`. |
| Tombol **← Super App** (di chrome tiap module) | Kembali ke Hub; **module boleh tetap hidup di background** (tray) atau di-pause — lihat §6. |
| Quit dari tray | Matikan **semua** module (CLIProxyAPI child + cloudflared + tunnel servers). |

### 1.3 Tray (global)

```
WAN Super App
├── Buka Hub
├── CLIProxyAPI
│   ├── Buka dashboard
│   ├── Start / Stop server   (jika module sudah di-boot)
│   └── Copy API key
├── WAN NET
│   ├── Buka dashboard
│   └── Tunnel status (N live)
├── ─────────
├── Launch at login
└── Quit
```

Ikon tray: gabungan sederhana atau ikon Super App; health indicator bisa dual-dot (proxy green/red + tunnel count).

---

## 2. Arsitektur target

### 2.1 Diagram proses

```
┌─────────────────────────── Electron: WAN Super App ───────────────────────────┐
│  Main process (entry: src/main/index.ts)                                       │
│  ├── single-instance lock                                                      │
│  ├── hub/                                                                      │
│  │   ├── hub-window.ts      BrowserWindow hub (2 kartu)                        │
│  │   ├── hub-settings.ts    super-app.json (lastModule, autoLaunch, …)         │
│  │   └── hub-ipc.ts         channel prefix: super:*                            │
│  ├── modules/cliproxy/      ← VENDOR dari wan-cliproxyapi (logic 1:1)         │
│  │   ├── boot.ts            lazy import backend + registerIpc + sync           │
│  │   ├── window.ts          dashboard window (preload cliproxy)                │
│  │   ├── tray-slice.ts      submenu CLIProxyAPI                                │
│  │   └── … salinan main/backend/preload/renderer                               │
│  ├── modules/net/           ← VENDOR dari wan-net (logic 1:1)                 │
│  │   ├── boot.ts            lazy start inspector + register net IPC            │
│  │   ├── window.ts          launcher window (preload net)                      │
│  │   ├── tray-slice.ts      submenu WAN NET                                    │
│  │   └── … salinan electron/* + lib/* + bin/*                                  │
│  ├── tray.ts                merge tray dari hub + 2 slice                      │
│  └── lifecycle.ts           before-quit → cliproxy.stop + net.stopAll          │
│                                                                                │
│  Preloads (terpisah, jangan digabung)                                          │
│  ├── preload/hub.cjs        → window.superApp                                  │
│  ├── preload/cliproxy.cjs   → window.wan          (sama API existing)          │
│  └── preload/net.cjs        → window.api / launcher bridge (sama existing)     │
│                                                                                │
│  Renderers                                                                     │
│  ├── hub/                   React/Vite mini (2 kartu) — BARU, tipis            │
│  ├── cliproxy-renderer/     salinan src/renderer wan-cliproxyapi               │
│  └── net-renderer/          salinan electron/launcher.html + css + js          │
└────────────────────────────────────────────────────────────────────────────────┘

  CLIProxyAPI path (hanya setelah boot cliproxy):
    chat-proxy/backend :4317*  →  CLIProxyAPI :8317*  →  providers
    * port resolve free-port; env CLIPROXY_HOME terisolasi

  WAN NET path (hanya setelah boot net):
    Internet → cloudflared → tunnel-server → tunnel-client → localhost:app
    Inspector :8080+
```

### 2.2 Kenapa bukan “satu React app dengan 2 route”?

| Pendekatan | Pro | Kontra | Keputusan handbook |
|------------|-----|--------|-------------------|
| A. Micro-frontend routes | Satu window | Harus rewrite NET (HTML/CJS) ke React; IPC campur; risiko regresi | **Ditolak** untuk v1 |
| B. Dua window + hub (shell) | Verbatim UI/logic; isolasi preload | Beberapa window | **Dipilih** |
| C. Satu window, `loadFile` ganti konten | Sedikit window | State hilang saat ganti; preload beda sulit | Opsional v2 |

**v1 = Opsi B:** Hub window + module windows. Navigasi “kembali ke hub” = `show hub` + optional `hide module window` (module process state di main **tetap hidup**).

### 2.3 Module lifecycle state machine

```
                    openModule('cliproxy'|'net')
   ┌────────┐  ──────────────────────────────►  ┌──────────┐
   │ idle   │                                   │ booting  │
   └────────┘  ◄── error / cancel ────────────  └────┬─────┘
       ▲                                             │ ready
       │ stopModule / quit                           ▼
   ┌────────┐  ◄────────────────────────────  ┌──────────┐
   │stopped │     (resources released)          │ running  │
   └────────┘                                   └────┬─────┘
                                                     │ hide UI only
                                                     ▼
                                               ┌──────────┐
                                               │background│  (tray keeps servers)
                                               └──────────┘
```

- **idle → booting → running**: pertama kali user klik kartu.
- **running → background**: user tutup window module (close-to-tray) atau kembali ke hub.
- **running/background → stopped**: user “Stop module” atau app quit.
- **Preferensi** `keepAliveWhenLeaving: true` (default): meninggalkan module **tidak** mematikan CLIProxyAPI / tunnels (penting untuk Copilot Chat & URL publik).

---

## 3. Layout folder (scaffold)

```
wan-super-app/
├── package.json
├── electron-builder.yml
├── tsconfig.json                 # hub + main shell (TS)
├── tsconfig.main.json
├── vite.config.hub.ts            # hanya hub UI
├── vite.config.cliproxy.ts       # salinan/adapt path dari wan-cliproxyapi
├── README.md
├── HANDBOOK-WAN-SUPER-APP.md     # file ini (copy)
│
├── vendor/                       # REFERENSI READ-ONLY (opsional mirror)
│   ├── README.md                 # “sumber kebenaran sebelum di-copy ke modules/”
│   ├── wan-cliproxyapi/          # git subtree / copy snapshot
│   └── wan-net/
│
├── modules/
│   ├── cliproxy/                 # WORKING COPY (boleh patch tipis adapter)
│   │   ├── package.fragment.json # deps yang dibutuhkan module
│   │   ├── main/                 # ← copy dari wan-cliproxyapi/src/main/**
│   │   ├── preload/              # ← copy index.cjs
│   │   ├── renderer/             # ← copy src/renderer/**
│   │   ├── backend/              # jika dipisah; atau tetap di main/backend
│   │   └── adapter/              # HANYA file baru: boot.ts, namespace.ts, paths.ts
│   │
│   └── net/                      # WORKING COPY
│       ├── main/                 # ← copy electron/main.js logic (dipecah) + cf-manager
│       ├── lib/                  # ← copy wan-net/lib/**
│       ├── preload/              # launcher-preload + settings preload
│       ├── renderer/             # launcher.html/css/js, settings.html
│       ├── bin/                  # opsional CLI tetap
│       └── adapter/              # boot.ts, namespace.ts, paths.ts
│
├── src/                          # SHELL Super App (kode BARU, tipis)
│   ├── main/
│   │   ├── index.ts              # app ready, single-instance, quit
│   │   ├── tray.ts
│   │   ├── lifecycle.ts
│   │   └── hub/
│   │       ├── hub-window.ts
│   │       ├── hub-settings.ts
│   │       └── hub-ipc.ts
│   ├── preload/
│   │   └── hub.cjs
│   └── hub-renderer/             # UI 2 kartu
│       ├── index.html
│       ├── main.tsx
│       ├── App.tsx
│       └── styles.css            # aurora, mirror cliproxy tokens
│
├── build/                        # icon.icns / ico / png / tray
└── scripts/
    ├── vendor-sync.mjs           # copy dari vendor/ atau sibling repos
    ├── copy-assets.mjs
    ├── dev.mjs                   # jalankan hub vite + electron
    └── dist-prepare.mjs
```

### 3.1 Cara mengisi `vendor/` dan `modules/` (wajib di handbook agar AI hemat konteks)

Di mesin development (workspace monorepo `Projects/`):

```bash
# Dari root monorepo Projects/
mkdir -p wan-super-app/vendor wan-super-app/modules

# Snapshot referensi (read-only intent)
rsync -a --delete \
  --exclude node_modules --exclude dist --exclude out --exclude build \
  --exclude graphify-out --exclude .git \
  wan-cliproxyapi/ wan-super-app/vendor/wan-cliproxyapi/

rsync -a --delete \
  --exclude node_modules --exclude dist --exclude .git \
  wan-net/ wan-super-app/vendor/wan-net/

# Working modules (salinan yang diedit adapter-nya)
rsync -a vendor/wan-cliproxyapi/src/main/   modules/cliproxy/main/
rsync -a vendor/wan-cliproxyapi/src/preload/ modules/cliproxy/preload/
rsync -a vendor/wan-cliproxyapi/src/renderer/ modules/cliproxy/renderer/
# handbooks module-level (opsional, untuk AI lokal)
cp vendor/wan-cliproxyapi/HANDBOOK-*.md modules/cliproxy/ 2>/dev/null || true

rsync -a vendor/wan-net/lib/              modules/net/lib/
rsync -a vendor/wan-net/electron/         modules/net/electron-src/
# pecah electron-src → main/renderer/preload di langkah adapter (§5)
```

**Aturan AI/implementer:**

1. Baca **handbook ini** dulu.
2. Untuk detail fitur CLIProxyAPI → baca hanya `modules/cliproxy/**` + handbook module yang di-copy (`HANDBOOK-WAN-CHAT-AI.md`, dll.).
3. Untuk detail fitur NET → baca hanya `modules/net/**` + README cuplikan di `modules/net/README.fragment.md`.
4. **Jangan** import path ke luar `wan-super-app/` saat coding production.

---

## 4. Konflik yang harus diselesaikan (peta risiko)

| Area | wan-cliproxyapi | wan-net | Resolusi Super App |
|------|-----------------|---------|---------------------|
| Module system | ESM (`"type":"module"`) | CJS `require` | Main shell **ESM**; module net di-load via `createRequire` atau tetap `.cjs` entry `boot.cjs` |
| Electron | ^43 (dev), ESM main | ^31, CJS main | **Pin satu versi Electron** (rekomendasi **31 atau 33 LTS-ish yang lulus kedua**); test smoke §14. Prefer naikkan net ke Electron yang dipakai cliproxy jika memungkinkan |
| Preload API | `window.wan` | `window.electronAPI` + API di launcher-preload | **Jangan digabung**. Tiap window pakai preload sendiri |
| IPC channels | `wan:*`, `chat:*`, `convo:*`, … | `start-tunnel`, `cf:*`, … | Biarkan; pastikan **tidak ada string channel sama**. Audit: `grep ipcMain.handle` di kedua module. Prefix opsional `net:` jika bentrok (butuh patch launcher.js) |
| Port | 4317 backend, 8317 proxy | 3000/4040/8080 dinamis | Tetap; free-port logic existing. Dokumentasikan di About Hub |
| userData paths | app-settings JSON | `wan-net-cfg.json` | Keduanya di bawah `app.getPath('userData')` Super App — **otomatis terisolasi dari standalone** (path beda). Migrasi opsional §12 |
| Tray | createTray cliproxy | tray di main.js net | **Hanya** `src/main/tray.ts` super-app yang buat Tray; module export `getMenuTemplate()` |
| single-instance | `requestSingleInstanceLock` | (biasanya ada di electron main) | **Hanya** shell yang lock |
| `before-quit` | stop CLIProxyAPI | kill cf + servers | Shell panggil `cliproxy.shutdown()` + `net.shutdown()` |
| Auto-updater | (opsional / belum) | electron-updater GitHub | Satu updater di shell; feed release Super App |
| CSP / sandbox | sandbox true, ketat | launcher HTML file://, inspector HTTP | Cliproxy tetap sandbox; net window ikuti existing (jangan paksakan sandbox jika preload net butuh lebih) |
| Branding title | “WAN X RENN…” | “WAN NET” | Window title: `WAN Super App — CLIProxyAPI` / `WAN Super App — NET` |

### 4.1 Audit channel IPC (wajib sebelum merge)

Jalankan di vendor:

```bash
rg "ipcMain\.handle\(['\`]" modules/cliproxy modules/net
rg "invoke\(['\`]" modules/cliproxy/preload modules/net
```

Daftar channel cliproxy (existing, jangan diubah kecuali perlu):

- `wan:request`, `wan:syncNow`, `wan:copyApiKey`, `wan:openExternal`, `wan:vscodeState`, `wan:backendInfo`, `wan:copyText`, `wan:jetbrainsSync`, `wan:jetbrainsState`, `wan:health`, `wan:getSettings`, `wan:setSetting`, `wan:focus`
- `chat:start|abort|approve|reject`
- `convo:*`, `context:*`, `project:*`, `cowork:*`, `quick:hide`

Daftar channel net (existing):

- `start-tunnel`, `stop-tunnel`, `delete-tunnel`, `delete-all-tunnels`, `list-tunnels`, `get-insp-port`, `get-version`, `open-inspector`, `open-external`, `open-settings`, `copy-text`, `show-notification`, `generate-qr`, `set-label`, `install-update`, `set-rate-limit`, `toggle-autostart`, `get-config`, `save-config`, `check-for-update`, `start-download-update`
- `cf:*` (login, tunnel, dns, routes, …)

Channel **baru** shell saja:

- `super:getSettings`, `super:setSetting`, `super:openModule`, `super:closeModule`, `super:moduleState`, `super:showHub`

**Tidak ada overlap string** dengan daftar di atas → aman tanpa rename.

---

## 5. Adapter layer (satu-satunya kode “baru” di module)

Tujuan adapter: **mengikat** kode existing ke shell tanpa mengedit ratusan file.

### 5.1 `modules/cliproxy/adapter/boot.ts`

```ts
// Pseudocode — implement sesuai path aktual setelah copy
import type { ModuleHandle } from "../../../src/main/module-types.js";

let booted = false;
let window: BrowserWindow | null = null;

export async function bootCliproxy(opts: { show: boolean }): Promise<ModuleHandle> {
  if (!booted) {
    // 1) set env SEBELUM import backend (verbatim settings.js)
    process.env.CLIPROXY_HOME ??= path.join(os.homedir(), ".wan-super-app", "cliproxyapi");
    // 2) prepareBackendEnv + ensureFreePort (copy logic dari main/index.ts existing)
    // 3) dynamic import modules/cliproxy/main/backend/index.js
    // 4) activityBus → broadcast (namespace event tetap 'activity' ke window cliproxy)
    // 5) registerIpc() dari modules/cliproxy/main/ipc.ts  — HANYA SEKALI
    // 6) startVsCodeAutoSync, registerQuickChat (quick chat = milik cliproxy)
    booted = true;
  }
  if (opts.show) window = createCliproxyWindow(); // dari window.ts existing (title diubah tipis)
  return {
    id: "cliproxy",
    show: () => { window?.show(); window?.focus(); },
    hide: () => window?.hide(),
    shutdown: async () => { /* stopServer cliproxy-manager; stop sync; close window */ },
    isRunning: () => booted,
  };
}
```

**Patch tipis yang diizinkan di kode existing cliproxy:**

| File | Patch | Alasan |
|------|-------|--------|
| `window.ts` | title → `WAN Super App — CLIProxyAPI`; optional tombol back via IPC `super:showHub` di chrome React | Branding |
| `App.tsx` | tambah item sidebar paling atas “← Super App” memanggil `window.wan` **atau** `window.superApp?.showHub` lewat preload gabungan terbatas | Navigasi hub |
| `index.ts` (main lama) | **jangan dipakai sebagai entry**; logic dipindah ke `adapter/boot.ts` | Cegah double app.whenReady |
| `tray.ts` | export template saja, jangan `new Tray` | Tray global |
| `app-settings` path | tetap userData Super App (otomatis) | Isolasi |

Preload cliproxy: **tetap** expose `window.wan` 1:1. Opsional tambah:

```js
// di ujung preload cliproxy — thin bridge ke shell
superApp: {
  showHub: () => ipcRenderer.invoke("super:showHub"),
  openNet: () => ipcRenderer.invoke("super:openModule", "net"),
}
```

### 5.2 `modules/net/adapter/boot.cjs` (CJS, karena net CJS)

```js
// Pseudocode
let booted = false;
const netMain = require("../electron-src/main-core.js"); // hasil pecahan main.js

async function bootNet(opts) {
  if (!booted) {
    await netMain.initRuntime(); // inspector port, register ipcMain handlers, load cfg
    booted = true;
  }
  if (opts.show) netMain.openLauncherWindow();
  return { id: "net", show, hide, shutdown: netMain.shutdownAll, isRunning: () => booted };
}
module.exports = { bootNet };
```

**Pecah `electron/main.js` wan-net** (refactor struktural, behavior sama):

| File hasil | Isi dari main.js lama |
|------------|------------------------|
| `runtime.js` | state `_tunnelMap`, `startTunnel`, `stopTunnel`, config load/save, inspector listen |
| `ipc-register.js` | semua `ipcMain.handle(...)` |
| `windows.js` | launcher + settings BrowserWindow |
| `tray-slice.js` | menu items only |
| `lifecycle.js` | shutdown all tunnels + cf |
| `boot.cjs` | orkestrasi di atas |

**Jangan** ubah `lib/**` kecuali path `ROOT` / cloudflared binary resolution (lihat §5.3).

### 5.3 Path binary cloudflared & CLIProxyAPI

```
Packaged app:
  process.resourcesPath/
    cloudflared          ← extraResources dari wan-net
    (CLIProxyAPI TIDAK di-bundle — download runtime seperti cliproxy)

Dev:
  modules/net/cloudflared atau project root cloudflared
  ~/.wan-super-app/cliproxyapi/  binary CLIProxyAPI
```

`electron-builder.yml` Super App:

```yaml
appId: com.wan.superapp
productName: WAN Super App
directories:
  output: dist
  buildResources: build
files:
  - out/**
  - modules/**
  - package.json
extraResources:
  - from: modules/net/cloudflared   # atau scripts unduh saat dist
    to: cloudflared
# CLIProxyAPI: jangan bundle (sama handbook cliproxy)
```

Patch tipis `modules/net/lib/cloudflared.js` `_binDir()`:

- jika `app.isPackaged` → `process.resourcesPath`
- else → `path.join(__dirname, '..')` dalam module net

---

## 6. Shell Super App (kode baru)

### 6.1 `src/main/index.ts` (alur)

```
app.requestSingleInstanceLock() → else quit
app.whenReady:
  load hub settings
  register hub IPC (super:*)
  createTray (merged)
  createHubWindow()
  if settings.reopenLastModule && lastModule:
      openModule(lastModule, { show: !startHidden })
  if settings.autoStartCliproxyBackground: bootCliproxy({ show:false })  // opsional advanced
  if settings.autoStartNetBackground: bootNet({ show:false })

second-instance → showHub() atau focus last window
window-all-closed → JANGAN quit (tray-first) — sama cliproxy
before-quit → lifecycle.shutdownAll()
```

### 6.2 `openModule(id)`

```ts
async function openModule(id: "cliproxy" | "net", opts = { show: true }) {
  if (id === "cliproxy") {
    const h = await bootCliproxy(opts);
    setSetting("lastModule", "cliproxy");
    if (opts.show) hubWindow?.hide(); // atau biarkan hub terbuka di belakang
    return h;
  }
  // net: createRequire untuk boot.cjs
  const h = await bootNet(opts);
  setSetting("lastModule", "net");
  ...
}
```

### 6.3 Hub settings schema (`super-app.json`)

```json
{
  "lastModule": null,
  "reopenLastModule": false,
  "autoLaunch": false,
  "startHidden": false,
  "keepAliveWhenLeaving": true,
  "theme": "aurora-dark",
  "windowBoundsHub": { "width": 920, "height": 640 }
}
```

### 6.4 Hub UI (fitur minimal)

- 2 kartu module + short description (copy dari README masing-masing).
- Status pill: `CLIProxyAPI: stopped|running` · `NET: 0 tunnels|N live` (query `super:moduleState`).
- Footer: version (`app.getVersion()`), link docs internal.
- Settings mini: reopen last, launch at login, keep-alive.
- **Jangan** taruh form tunnel atau model list di hub.

### 6.5 Visual tokens hub (selaraskan cliproxy)

Ambil dari `wan-cliproxyapi/src/renderer/theme.css` / `styles.css`:

- Background: `#0b0c16` + aurora gradient
- Accent: violet `rgba(124, 106, 240, …)`
- Glass card, border `var(--wan-border)`
- Font: system UI stack yang sama

Kartu NET: ikon ⚡; kartu CLIProxy: ikon stack/model (sama Overview).

---

## 7. package.json (gabungan dependensi)

Gabungkan **union** deps; jangan hilangkan yang dipakai salah satu module.

```json
{
  "name": "wan-super-app",
  "productName": "WAN Super App",
  "version": "0.1.0",
  "description": "WAN Super App — CLIProxyAPI desktop + WAN NET tunnel/inspector",
  "type": "module",
  "main": "out/main/index.js",
  "scripts": {
    "vendor:sync": "node scripts/vendor-sync.mjs",
    "build:main": "tsc -p tsconfig.main.json",
    "build:hub": "vite build --config vite.config.hub.ts",
    "build:cliproxy-renderer": "vite build --config vite.config.cliproxy.ts",
    "copy:assets": "node scripts/copy-assets.mjs",
    "build": "npm run build:main && npm run copy:assets && npm run build:hub && npm run build:cliproxy-renderer",
    "dev": "node scripts/dev.mjs",
    "start": "npm run build && electron .",
    "dist": "npm run build && electron-builder",
    "typecheck": "tsc -p tsconfig.main.json --noEmit"
  },
  "dependencies": {
    "cors": "^2.8.5",
    "diff": "^9.0.0",
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "extract-zip": "^2.0.1",
    "highlight.js": "^11.11.1",
    "js-yaml": "^4.1.0",
    "node-fetch": "^3.3.2",
    "react-markdown": "^10.1.0",
    "rehype-highlight": "^7.0.2",
    "remark-gfm": "^4.0.1",
    "tar": "^7.4.3",
    "electron-updater": "^6.3.9",
    "qrcode": "^1.5.4"
  },
  "devDependencies": {
    "electron": "^31.0.0",
    "electron-builder": "^24.13.3",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "typescript": "^5.5.4",
    "vite": "^5.4.0",
    "@vitejs/plugin-react": "^4.3.1",
    "@types/node": "^20.14.0",
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0"
  }
}
```

Catatan:

- Jika cliproxy **wajib** Electron 43, pin 43 dan uji net (BrowserWindow, tray, updater).
- Net tidak butuh React; cliproxy renderer butuh.
- `modules/net` tetap `require()`; pastikan `copy-assets` tidak men-transpile lib net ke ESM.

---

## 8. Build & copy assets

### 8.1 `scripts/copy-assets.mjs`

Copy ke `out/`:

| Sumber | Tujuan |
|--------|--------|
| `src/preload/hub.cjs` | `out/preload/hub.cjs` |
| `modules/cliproxy/preload/index.cjs` | `out/modules/cliproxy/preload/index.cjs` |
| `modules/cliproxy/main/backend/**` | `out/modules/cliproxy/main/backend/**` (verbatim JS) |
| `modules/net/lib/**` | `out/modules/net/lib/**` |
| `modules/net/electron-src/**` atau hasil pecahan | `out/modules/net/**` |
| `modules/net/renderer/**` (html/css/js) | `out/modules/net/renderer/**` |
| hub vite dist | `out/hub-renderer/**` |
| cliproxy vite dist | `out/modules/cliproxy/renderer/**` |

### 8.2 Dev loop

```bash
# Terminal mental model (scripts/dev.mjs):
# 1. tsc -w main shell + cliproxy main TS
# 2. vite hub (port mis. 5173)
# 3. vite cliproxy renderer (port mis. 5174)  OR loadFile built
# 4. electron . dengan env:
#    VITE_DEV_SERVER_URL_HUB=http://localhost:5173
#    VITE_DEV_SERVER_URL_CLIPROXY=http://localhost:5174
```

NET renderer: loadFile HTML (tidak wajib Vite) — sama seperti existing wan-net.

---

## 9. Keamanan (warisan + shell)

| Kontrol | Cliproxy | Net | Super App |
|---------|----------|-----|-----------|
| contextIsolation | yes | yes (settings/launcher preload) | wajib di semua window |
| nodeIntegration | false | false di window dengan preload | wajib false |
| Renderer fetch ke backend | tidak (IPC only) | inspector = HTTP localhost | jangan longgarkan CSP cliproxy |
| CORS backend 4317 | hanya no-origin / webview | n/a | main-only fetch tetap |
| Secret API keys | di cliproxy home | CF token di cfg net | userData Super App; jangan log |
| external links | openExternal | openExternal | shell openExternal only |

---

## 10. Tahapan implementasi (urutan kerja)

Kerjakan **berurutan**. Jangan loncat ke packaging sebelum smoke §11 hijau.

### Tahap 0 — Repo scaffold (½–1 hari)

1. Buat folder `wan-super-app/` + `package.json` + tsconfig + electron-builder.
2. `scripts/vendor-sync.mjs` + jalankan sync dari sibling `wan-cliproxyapi` & `wan-net`.
3. Copy ke `modules/cliproxy` dan `modules/net`.
4. Commit snapshot vendor (atau git submodule) — **baseline referensi**.

### Tahap 1 — Shell + Hub only (½ hari)

1. `src/main/index.ts` single-instance + hub window load hub renderer.
2. Hub UI 2 kartu (dummy `console.log` dulu).
3. Tray minimal: Show Hub, Quit.
4. Smoke: app buka, kartu tampil, quit bersih.

### Tahap 2 — Integrasi CLIProxyAPI verbatim (1–2 hari)

1. Adapter `bootCliproxy`: pindahkan urutan boot dari `wan-cliproxyapi/src/main/index.ts`.
2. Register IPC + backend import + window + **tanpa** tray module.
3. Preload path benar; renderer load (dev URL atau file).
4. Patch title + tombol “← Super App”.
5. Smoke checklist cliproxy standalone (§11.1).

### Tahap 3 — Integrasi WAN NET verbatim (1–2 hari)

1. Pecah `electron/main.js` → runtime/ipc/windows tanpa `app.whenReady` ganda.
2. `bootNet` dari shell; register IPC sekali.
3. Launcher HTML + preload path; cloudflared resolve.
4. Smoke checklist net (§11.2).

### Tahap 4 — Tray gabungan + lifecycle (½ hari)

1. Merge menu.
2. `before-quit` shutdown kedua module.
3. Close-to-tray per window; hub hide ≠ quit.

### Tahap 5 — Polish UX (½ hari)

1. Status pill di hub.
2. `lastModule` / reopen optional.
3. About: port numbers, paths home.
4. Auto-launch OS (login item) di shell.

### Tahap 6 — Packaging (1 hari)

1. electron-builder icons.
2. extraResources cloudflared.
3. Uji dmg/nsis/AppImage.
4. Notarize/sign menyusul (opsional).

### Tahap 7 — Dokumentasi user

1. README Super App: unduh, pilih module, first-run cliproxy (install binary), first-run net (start port).
2. Link ke handbook module untuk fitur dalam.

---

## 11. Smoke test checklist

### 11.1 CLIProxyAPI (fungsi sama persis)

- [ ] Hub → Buka CLIProxyAPI → Overview tampil
- [ ] Install/Update binary CLIProxyAPI
- [ ] Start server; health reachable
- [ ] Providers OAuth / list models
- [ ] Toggle model → file VS Code `chatLanguageModels.json` ter-update (jika VS Code terpasang)
- [ ] Chat in-app stream token
- [ ] Cowork: pilih folder, tool read (approval write)
- [ ] Neuron activity ada event saat traffic proxy
- [ ] JetBrains page tidak crash
- [ ] Close window → tetap di tray; Copilot masih bisa hit proxy
- [ ] ← Super App → hub; buka lagi state server tetap (keepAlive)

### 11.2 WAN NET (fungsi sama persis)

- [ ] Hub → Buka WAN NET → launcher dashboard
- [ ] Start tunnel port lokal (mis. 3000) → URL `trycloudflare.com`
- [ ] Browser publik hit → request muncul di inspector
- [ ] Replay / mock / rate limit / QR / label / auto-start
- [ ] Multi-tunnel 2 port
- [ ] CF login chip (jika diuji named tunnel)
- [ ] Stop tunnel; delete; inspector health
- [ ] ← Super App; tunnel tetap live jika keepAlive
- [ ] Quit app → cloudflared & ports lepas

### 11.3 Super App shell

- [ ] Single-instance: second launch focus window
- [ ] Tray: buka hub / module / quit
- [ ] Tidak ada crash jika buka **kedua** module bersamaan
- [ ] Port 4317 & 8080+ & cloudflared tidak konflik
- [ ] `userData` Super App terpisah dari install standalone lama

### 11.4 Regresi IPC

- [ ] Dari renderer cliproxy, `window.wan.request` OK
- [ ] Dari launcher net, `start-tunnel` OK
- [ ] Tidak ada `Error: No handler registered` silang module

---

## 12. Migrasi dari app standalone (opsional)

Pengguna lama mungkin punya:

| Sumber | Path tipikal |
|--------|----------------|
| Cliproxy home | `~/.wan-cliproxyapi/cliproxyapi` |
| Cliproxy settings | `~/Library/Application Support/WAN X RENN CLIProxyAPI Desktop/` (macOS) |
| Net cfg | `~/Library/Application Support/WAN-NET/wan-net-cfg.json` |

**v1:** tidak auto-migrate (aman). Settings Super App kosong; user login provider ulang / start tunnel ulang.

**v1.1 (opsional):** wizard Hub “Impor dari instalasi lama”:

1. Deteksi path standalone.
2. Copy `config.yaml` + auth dir cliproxy → `~/.wan-super-app/cliproxyapi`.
3. Copy `wan-net-cfg.json` → userData Super App.
4. Jangan pindahkan — **copy**.

---

## 13. Apa yang **tidak** boleh dilakukan

1. **Jangan** merge `window.wan` dan API net jadi satu objek giant.
2. **Jangan** jalankan dua `app.whenReady` dari module.
3. **Jangan** rewrite inspector NET ke React di v1.
4. **Jangan** bundle CLIProxyAPI binary ke installer.
5. **Jangan** share Express app atau HTTP server antara module.
6. **Jangan** matikan CLIProxyAPI hanya karena user buka WAN NET.
7. **Jangan** ubah path channel IPC existing tanpa update preload + renderer + handbook module.
8. **Jangan** taruh secrets di renderer localStorage.

---

## 14. Prompt kerja untuk AI (copy-paste, hemat konteks)

Gunakan prompt berikut saat implementasi di folder `wan-super-app/`:

```
Kamu mengimplementasikan WAN Super App sesuai HANDBOOK-WAN-SUPER-APP.md.

Aturan:
1. Baca handbook di root project dulu.
2. Logic fitur HANYA dari modules/cliproxy dan modules/net (sudah di-vendor).
3. Kode baru hanya di src/ (shell+hub) dan modules/*/adapter/.
4. Jangan rewrite UI/fitur module; patch tipis branding/navigasi saja.
5. Satu Electron app; lazy boot module; tray-first quit.
6. Setelah ubah, jalankan smoke relevan dari handbook §11.

Tugas saat ini: <TAHAP X — deskripsi singkat>
```

Untuk bug di dalam chat/cowork/neuron → arahkan AI ke handbook module yang sudah di-copy:

- `modules/cliproxy/HANDBOOK-WAN-CHAT-AI.md`
- `modules/cliproxy/HANDBOOK-WAN-COWORK-MODE.md`
- `modules/cliproxy/HANDBOOK-WAN-NEURON-ACTIVITY.md`

Untuk bug tunnel/inspector → baca `modules/net/lib/*` + `modules/net/electron-src/*` saja.

---

## 15. Referensi sumber (peta file penting)

### 15.1 Dari wan-cliproxyapi (copy → modules/cliproxy)

| Path sumber | Peran |
|-------------|--------|
| `src/main/index.ts` | Urutan boot (dipindah ke adapter) |
| `src/main/ipc.ts` | Semua handler desktop + chat |
| `src/main/window.ts` | BrowserWindow dashboard |
| `src/main/backend/**` | Express :4317 + cliproxy-manager + chat-proxy |
| `src/main/vscode-sync.ts` | chatLanguageModels.json |
| `src/main/chat-service.ts` + `tools/**` | Chat + cowork tools |
| `src/preload/index.cjs` | `window.wan` |
| `src/renderer/**` | Seluruh UI dashboard |
| `electron-builder.yml` | Pola files/mac/win/linux |
| `HANDBOOK-WAN-*.md` | Fitur lanjut |

### 15.2 Dari wan-net (copy → modules/net)

| Path sumber | Peran |
|-------------|--------|
| `electron/main.js` | Tunnel map, window, tray, quit (dipecah) |
| `electron/cf-manager.js` | IPC Cloudflare |
| `electron/launcher.html/js/css` | UI dashboard |
| `electron/preload.js` / `launcher-preload.js` | Bridge |
| `lib/tunnel-server.js` | Ingress + mock + rate limit |
| `lib/tunnel-client.js` | SSE client + reconnect |
| `lib/client-server.js` | `/connect` |
| `lib/inspector-server.js` | Dashboard inspector HTTP |
| `lib/cloudflared.js` | Binary + quick/named tunnel |
| `lib/state.js` | Multi-tunnel + RingLog |
| `bin/wan-net.js` | CLI (opsional ship) |
| `package.json` build.extraResources | cloudflared |

### 15.3 Handbook sibling di monorepo

| File | Pakai untuk |
|------|-------------|
| `HANDBOOK-WAN-CLIPROXYAPI-DEKSTOP.md` | Sejarah keputusan Electron cliproxy |
| `HANDBOOK-WAN-CHAT-AI.md` | Chat in-app |
| `HANDBOOK-WAN-COWORK-MODE.md` | Agent tools |
| `HANDBOOK-WAN-SUPER-APP.md` | **File ini** — integrasi |

---

## 16. Definisi selesai (DoD)

WAN Super App **selesai v1** jika:

1. Installer/name **WAN Super App** jalan di macOS (arm64 minimal).
2. Cold start menampilkan **Hub 2 menu**.
3. Masuk CLIProxyAPI → fitur setara standalone (smoke §11.1 lulus).
4. Masuk WAN NET → fitur setara standalone (smoke §11.2 lulus).
5. Kedua module bisa **running bersamaan**.
6. Quit dari tray membersihkan proses child (tidak orphan `cliproxyapi` / `cloudflared`).
7. `modules/*` berisi logic dari existing; shell tidak menduplikasi bisnis logik.
8. README + handbook ini ada di repo; `vendor:sync` terdokumentasi.

---

## 17. Roadmap pasca-v1 (jangan kerjakan di v1)

- Tab strip satu window (Hub | Proxy | Net) dengan WebContentsView.
- Shared notification center.
- Auto-migrate settings standalone.
- Deep link `wansuper://open/net?port=3000`.
- Plugin ketiga (mis. wan-ssh) dengan kontrak `ModuleHandle` yang sama.

---

## 18. Ringkasan satu halaman

```
WAN Super App = Electron shell tipis
              + modules/cliproxy (copy wan-cliproxyapi, adapter boot)
              + modules/net      (copy wan-net, adapter boot)

UI awal     = Hub 2 kartu
Navigasi    = buka window module masing-masing
Logic       = verbatim existing
IPC         = terpisah, audit no-overlap
Lifecycle   = lazy boot, keep-alive, tray quit global
Konteks AI  = handbook ini + modules/* saja
```

---

*Dokumen ini adalah kontrak implementasi. Jika ada konflik antara “ide baru” dan “perilaku existing di modules/”, **existing menang** kecuali handbook ini secara eksplisit mengizinkan patch tipis di §5.*
