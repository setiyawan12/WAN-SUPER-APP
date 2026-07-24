# HANDBOOK — Integrasi WANN SSH ke WAN Super App

> Menjadikan **WAN Super App** memiliki **3 modul**:
> **WANN X RENN CLIProxyAPI** · **WAN NET** · **WANN SSH**
>
> Dokumen ini adalah panduan langkah-demi-langkah (bukan ringkasan). Ikuti fase secara berurutan.
> Setiap fase punya *acceptance check* — jangan lanjut sebelum check hijau.

---

## Daftar Isi

- [0. Ringkasan & Verdict Kelayakan](#0-ringkasan--verdict-kelayakan)
- [1. Arsitektur Target & Keputusan Desain](#1-arsitektur-target--keputusan-desain)
- [2. Matriks Kompatibilitas & Risiko](#2-matriks-kompatibilitas--risiko)
- [3. Peta Perubahan File](#3-peta-perubahan-file)
- [Fase A — Persiapan & Kompatibilitas](#fase-a--persiapan--kompatibilitas)
- [Fase B — Embed-Adapt Sumber WANN SSH](#fase-b--embed-adapt-sumber-wann-ssh)
- [Fase C — Build & Vendor ke `modules/ssh`](#fase-c--build--vendor-ke-modulesssh)
- [Fase D — Boot Adapter Modul SSH](#fase-d--boot-adapter-modul-ssh)
- [Fase E — Wiring Shell Super App](#fase-e--wiring-shell-super-app)
- [Fase F — Hub UI: Kartu Ketiga](#fase-f--hub-ui-kartu-ketiga)
- [Fase G — Native Module (argon2) & Packaging](#fase-g--native-module-argon2--packaging)
- [Fase H — Build Script & vendor-sync](#fase-h--build-script--vendor-sync)
- [Fase I — Jalankan, Uji, Rilis](#fase-i--jalankan-uji-rilis)
- [Data & Konfigurasi Runtime](#data--konfigurasi-runtime)
- [Keamanan yang WAJIB Dipertahankan](#keamanan-yang-wajib-dipertahankan)
- [Checklist Akhir (copy-paste)](#checklist-akhir-copy-paste)
- [Troubleshooting](#troubleshooting)

---

## 0. Ringkasan & Verdict Kelayakan

**Verdict: LAYAK.** WANN SSH bisa masuk sebagai modul ketiga tanpa menulis ulang.

Alasan teknis:

| Aspek | Temuan | Dampak integrasi |
|-------|--------|------------------|
| Lifecycle | wann-ssh punya `app.whenReady`, single-instance, protocol `wannssh://`, `powerMonitor` | Harus di-guard `WAN_SUPER_APP_EMBED` — **persis pola WAN NET** |
| Native module | **Hanya `argon2`** yang native. `db.ts` pakai JSON-store (bukan better-sqlite3), `ssh2`/`firebase`/`zod` pure-JS | Cuma 1 modul native untuk di-rebuild + `asarUnpack` |
| Preload | Expose `window.api` via `contextBridge`, `sandbox:true` | Tidak bentrok — tiap BrowserWindow punya preload sendiri (hub=`window.superApp`, ssh=`window.api`) |
| Renderer | React + Zustand + xterm.js, di-bundle Vite | Aset renderer *self-contained* setelah build; tak butuh node_modules saat runtime |
| Build system | electron-vite (beda dari super-app yang tsc+vite manual) | Kita **biarkan** electron-vite membangun bundle, lalu *vendor* hasilnya (pola WAN NET yang sudah CJS verbatim) |

Konflik utama yang harus ditangani: **versi Electron berbeda** (super-app `^43`, wann-ssh `^37`) → `argon2` wajib di-rebuild terhadap ABI Electron 43. Ditangani di [Fase G](#fase-g--native-module-argon2--packaging).

---

## 1. Arsitektur Target & Keputusan Desain

### 1.1 Bentuk akhir

```
┌──────────────────────────────────────────────────────────────────┐
│                    WAN Super App (Electron 43)                     │
│  Main Process — app.whenReady · tray · lifecycle · auto-update    │
│  ┌───────────────┬──────────────────┬──────────────────────────┐  │
│  │  Hub Renderer │   Module Windows / Replace-mode Shell        │  │
│  │   (3 cards)   │  cliproxy (ESM import) · net (createRequire) │  │
│  │               │  ssh (createRequire → modules/ssh/adapter)   │  │
│  └───────────────┴──────────────────┴──────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

- Hanya Super App yang memegang `app.whenReady`, tray, dan `before-quit`.
- Modul SSH dimuat **lazy** saat kartu diklik (sama seperti dua modul lain).

### 1.2 Keputusan: **Vendored Built-Bundle** (bukan source-integrated)

Ada dua jalur. Kita **pilih Jalur A**.

**Jalur A — Vendor bundle hasil build (DIPILIH, meniru WAN NET).**
wann-ssh dibangun oleh electron-vite-nya sendiri → output CJS (`out/main/*.js`, `out/preload/index.js`, `out/renderer/*`) di-*copy* ke `wan-super-app/modules/ssh/`. Super App hanya menambah `boot.cjs` tipis + deps runtime.

- ✅ Path alias `@shared`, format CJS untuk preload (wajib karena `sandbox:true`), dan bundling xterm.js **sudah** ditangani electron-vite.
- ✅ Tidak menyentuh `tsconfig.main.json` super-app.
- ✅ Cocok dengan model repo: `vendor/` = snapshot read-only, `modules/` = working copy.

**Jalur B — Pindahkan `src/` ke super-app dan kompilasi via tsc+vite super-app.** Ditolak: harus mem-porting path alias `@shared`, mencampur ESM/CJS, dan re-plumbing native rebuild. Jauh lebih rapuh. (Hanya pertimbangkan bila tim ingin satu toolchain tunggal jangka panjang.)

### 1.3 Kontrak modul

`ModuleHandle` (lihat [src/main/module-types.ts](src/main/module-types.ts)) tidak berubah bentuknya; kita tambah `"ssh"` ke `ModuleId`. Adapter SSH mengembalikan handle dengan `id/show/hide/shutdown/isRunning/getStatus/presentIn` — sama seperti `bootNet`.

---

## 2. Matriks Kompatibilitas & Risiko

| Item | wann-ssh (asli) | wan-super-app | Aksi |
|------|-----------------|---------------|------|
| Electron | `^37` | `^43` | Rebuild `argon2` ke Electron 43 (Fase G) |
| Node types | `@types/node ^22` | `^20` | Aman (bundle sudah jadi; types cuma dev) |
| Module format main | CJS (electron-vite `format:'cjs'`) | root `type:module` | Tandai subtree `modules/ssh` sebagai CommonJS via `package.json` lokal (Fase C) |
| Preload | CJS `contextBridge` | — | Dipakai apa adanya |
| Native | `argon2` | tidak ada native | Tambah `postinstall` rebuild + `asarUnpack` |
| Deps runtime main | `ssh2`, `argon2`, `firebase`, `zod` | tak ada | Tambahkan ke `package.json` super-app (Fase G) |
| Renderer deps | xterm, react, zustand, cmdk, react-virtual | dibundle | Sudah masuk output vite renderer |
| Global var renderer | `window.api` | hub `window.superApp` | Tak bentrok (preload per-window) |

**Risiko tertinggi:** rebuild `argon2` gagal di CI (butuh toolchain C++/Python). Mitigasi lengkap di Fase G + Troubleshooting.

---

## 3. Peta Perubahan File

**Di repo `wann-ssh`** (patch embed, non-destruktif):
- `src/main/index.ts` → guard lifecycle + export embed API.
- `src/main/window/main-window.ts` → dukung `attachWindow` (replace-mode) + preload path robust.
- `src/main/embed.ts` → **BARU**, permukaan API untuk Super App.

**Di repo `wan-super-app`** (yang benar-benar dirilis):

| File | Perubahan |
|------|-----------|
| `modules/ssh/**` | **BARU** — hasil build wann-ssh (main/preload/renderer) + `adapter/boot.cjs` + `package.json` penanda CJS |
| `src/main/module-types.ts` | `ModuleId` tambah `"ssh"` |
| `src/main/index.ts` | `openModule()` cabang `ssh`, `getHandles()` sertakan ssh |
| `src/main/hub/hub-window.ts` | `sshPreloadPath()`, `loadSshContent()`, cabang `ensureModuleShell("ssh")` |
| `src/main/hub/hub-ipc.ts` | izinkan `id === "ssh"`, `super:moduleState` sertakan ssh |
| `src/main/hub/hub-settings.ts` | `sanitize()` terima `lastModule === "ssh"` |
| `src/main/tray.ts` | submenu **WANN SSH**, tipe `getHandles` |
| `src/main/lifecycle.ts` | `shutdownAll` sertakan ssh |
| `src/hub-renderer/App.tsx` | kartu ketiga **WANN SSH** |
| `src/hub-renderer/wan.d.ts` | `ModuleId` + `moduleState` sertakan ssh |
| `scripts/copy-assets.mjs` | copy `modules/ssh` + penanda CJS |
| `scripts/vendor-sync.mjs` | sinkron sibling `wann-ssh` |
| `package.json` | deps `ssh2/argon2/firebase/zod`, script `build:ssh`, `postinstall` rebuild |
| `electron-builder.yml` | `asarUnpack` argon2 |

---

## Fase A — Persiapan & Kompatibilitas

### A.1 Struktur direktori sibling

Pastikan ketiga repo bersebelahan (vendor-sync mengandalkan ini):

```
DEV/
  wan-super-app/
  wan-cliproxyapi/     (sibling cliproxy — sudah ada)
  wan-net/             (sibling net — sudah ada)
  wann-ssh/            (sibling BARU untuk modul ke-3)
```

### A.2 Baseline hijau

Sebelum menyentuh apa pun, pastikan keduanya sehat sendiri-sendiri:

```bash
# wann-ssh berdiri sendiri
cd wann-ssh && npm install && npm run typecheck && npm test && npm run build

# super-app berdiri sendiri
cd ../wan-super-app && npm install && npm run typecheck && npm run build && npm start
```

**Acceptance A:** kedua build sukses; super-app terbuka dengan 2 kartu.

---

## Fase B — Embed-Adapt Sumber WANN SSH

Tujuan: wann-ssh berhenti "memiliki" lifecycle saat berjalan di dalam Super App, tapi **tetap** jalan normal sebagai app mandiri. Polanya identik dengan [`modules/net/electron/main.js`](modules/net/electron/main.js) yang meng-guard lifecycle di balik `WAN_SUPER_APP_EMBED`.

### B.1 Buat permukaan embed — `wann-ssh/src/main/embed.ts` (BARU)

```ts
// src/main/embed.ts
// Permukaan API untuk WAN Super App. Tidak dipakai saat standalone.
import type { BrowserWindow } from 'electron';
import { initDb } from './store/db';
import { AppContext } from './context';
import { registerIpc } from './ipc/register';
import { createMainWindow, attachWindow } from './window/main-window';
import { logger } from './util/logger';

let ctx: AppContext | null = null;
let ownWindow: BrowserWindow | null = null;
let booted = false;
let ipcRegistered = false;

/** Inisialisasi service (DB, context, IPC) sekali saja. */
export async function initSsh(): Promise<void> {
  if (booted) return;
  initDb();
  ctx = new AppContext();
  if (!ipcRegistered) {
    registerIpc(ctx);           // ipcMain.handle hanya boleh sekali
    ipcRegistered = true;
  }
  // Auto-lock saat sleep/lock-screen tetap aktif di embed.
  const { powerMonitor } = await import('electron');
  powerMonitor.on('suspend', () => ctx?.vault.lock());
  powerMonitor.on('lock-screen', () => ctx?.vault.lock());
  booted = true;
  logger.info('WANN SSH embed runtime siap');
}

/** Window-mode: buka jendela SSH khusus. */
export function openSshWindow(): void {
  if (ownWindow && !ownWindow.isDestroyed()) {
    if (ownWindow.isMinimized()) ownWindow.restore();
    ownWindow.show();
    ownWindow.focus();
    return;
  }
  ownWindow = createMainWindow();
  ctx?.setSender(ownWindow.webContents);
  ownWindow.on('closed', () => { ownWindow = null; });
}

/** Replace-mode: pakai shell window milik Super App sebagai jendela SSH. */
export function attachSshWindow(win: BrowserWindow): void {
  attachWindow(win);                 // load renderer ke window shell
  ctx?.setSender(win.webContents);
  win.on('closed', () => { /* Super App yang mengelola destroy */ });
}

export function shutdownSsh(): void {
  try { ctx?.vault.lock(); } catch { /* ignore */ }
  if (ownWindow && !ownWindow.isDestroyed()) {
    try { ownWindow.destroy(); } catch { /* ignore */ }
  }
  ownWindow = null;
  booted = false;
}

export function getSshStatus(): Record<string, unknown> {
  return { running: booted, vault: ctx ? ctx.vault.status() : 'locked' };
}
```

> Catatan: `ipcMain.handle` **tidak boleh** didaftarkan dua kali (crash). Guard `ipcRegistered` menjaga itu — sama seperti komentar di `boot.cjs` WAN NET ("Do NOT delete require.cache — re-registering ipcMain.handle crashes Electron").

### B.2 Tambah `attachWindow` ke `wann-ssh/src/main/window/main-window.ts`

Sisipkan fungsi berikut (dan pastikan preload path memakai `../preload/index.js`, yang sudah benar):

```ts
/** Super App replace-mode: muat renderer SSH ke window shell eksternal. */
export function attachWindow(win: BrowserWindow): void {
  if (!win || win.isDestroyed()) return;
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) void import('electron').then(({ shell }) => shell.openExternal(url));
    return { action: 'deny' };
  });
  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
  if (!win.isVisible()) win.show();
  win.focus();
}
```

### B.3 Guard lifecycle di `wann-ssh/src/main/index.ts`

Bungkus **seluruh** blok lifecycle standalone agar tidak jalan saat embed. Versi hasil edit:

```ts
import { app, BrowserWindow } from 'electron';
import { APP } from '@shared/constants';
import { initDb } from './store/db';
import { AppContext } from './context';
import { registerIpc } from './ipc/register';
import { createMainWindow } from './window/main-window';
import { buildMenu } from './window/menu';
import { logger } from './util/logger';

// Re-export permukaan embed supaya Super App bisa require bundle ini.
export { initSsh, openSshWindow, attachSshWindow, shutdownSsh, getSshStatus } from './embed';

// ── Standalone lifecycle — hanya saat BUKAN embed (Super App set WAN_SUPER_APP_EMBED=1)
if (!process.env.WAN_SUPER_APP_EMBED) {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    let ctx: AppContext;
    let mainWindow: BrowserWindow | null = null;

    function registerProtocol(): void {
      if (process.defaultApp && process.argv.length >= 2) {
        app.setAsDefaultProtocolClient(APP.scheme, process.execPath, [process.argv[1]!]);
      } else {
        app.setAsDefaultProtocolClient(APP.scheme);
      }
    }

    app.whenReady().then(() => {
      registerProtocol();
      initDb();
      ctx = new AppContext();
      registerIpc(ctx);
      buildMenu();
      mainWindow = createMainWindow();
      ctx.setSender(mainWindow.webContents);
      import('electron').then(({ powerMonitor }) => {
        powerMonitor.on('suspend', () => ctx.vault.lock());
        powerMonitor.on('lock-screen', () => ctx.vault.lock());
      });
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          mainWindow = createMainWindow();
          ctx.setSender(mainWindow.webContents);
        }
      });
      logger.info(`${APP.name} ${APP.version} siap`);
    });

    app.on('open-url', (event, url) => {
      event.preventDefault();
      logger.info('deep link diterima:', url);
      mainWindow?.webContents.send('deeplink', url);
    });

    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') app.quit();
    });
  }
}
```

**Acceptance B:** di wann-ssh, `npm run build` sukses; `npm run dev` (standalone) masih membuka app normal (belum ada `WAN_SUPER_APP_EMBED`).

---

## Fase C — Build & Vendor ke `modules/ssh`

### C.1 Build bundle wann-ssh

```bash
cd wann-ssh
npm run build          # electron-vite build → out/main, out/preload, out/renderer
```

Struktur output yang relevan:
```
wann-ssh/out/
  main/        # index.js (+ chunk) — CJS
  preload/     # index.js — CJS (contextBridge)
  renderer/    # index.html + assets (xterm, react ter-bundle)
```

### C.2 Copy ke super-app `modules/ssh`

```bash
cd ../wan-super-app
mkdir -p modules/ssh/main modules/ssh/preload modules/ssh/renderer modules/ssh/adapter

# hasil build wann-ssh
cp -R ../wann-ssh/out/main/.      modules/ssh/main/
cp -R ../wann-ssh/out/preload/.   modules/ssh/preload/
cp -R ../wann-ssh/out/renderer/.  modules/ssh/renderer/
```

### C.3 Tandai subtree sebagai CommonJS

Root `wan-super-app/package.json` memakai `"type":"module"`, sehingga tanpa penanda, Node akan mem-parse `modules/ssh/main/*.js` (yang `require/module.exports`) sebagai ESM dan crash. Ini **persis** alasan `modules/net/package.json` ada (lihat komentar di [scripts/copy-assets.mjs](scripts/copy-assets.mjs)).

Buat `wan-super-app/modules/ssh/package.json`:

```json
{
  "name": "wan-super-app-module-ssh",
  "private": true,
  "type": "commonjs"
}
```

**Acceptance C:** `modules/ssh/main/index.js`, `modules/ssh/preload/index.js`, `modules/ssh/renderer/index.html`, dan `modules/ssh/package.json` ada.

---

## Fase D — Boot Adapter Modul SSH

Buat `wan-super-app/modules/ssh/adapter/boot.cjs` — kembaran `bootNet`:

```js
'use strict';
/**
 * Super App adapter untuk WANN SSH (CJS bundle).
 * Memuat modules/ssh/main/index.js dengan WAN_SUPER_APP_EMBED agar tidak
 * mengambil alih app.whenReady / tray / before-quit.
 */
const path = require('path');

let handle = null;

async function bootSsh(opts = {}) {
  const show = opts.show !== false;
  const embedOnly = !!opts.embedOnly;

  if (handle) {
    if (show && !embedOnly) handle.show();
    return handle;
  }

  process.env.WAN_SUPER_APP_EMBED = '1';

  // JANGAN hapus require.cache — re-register ipcMain.handle akan crash Electron.
  const mainPath = path.join(__dirname, '../main/index.js');
  const ssh = require(mainPath).default ?? require(mainPath);

  await ssh.initSsh();
  if (show && !embedOnly) ssh.openSshWindow();

  handle = {
    id: 'ssh',
    show: () => ssh.openSshWindow(),
    hide: () => {
      try {
        const { BrowserWindow } = require('electron');
        for (const w of BrowserWindow.getAllWindows()) {
          if (String(w.getTitle() || '').includes('SSH')) w.hide();
        }
      } catch { /* ignore */ }
    },
    /** Replace-mode: pakai shell Super App sebagai jendela SSH. */
    presentIn: (win) => {
      if (typeof ssh.attachSshWindow === 'function') ssh.attachSshWindow(win);
    },
    shutdown: async () => {
      try { ssh.shutdownSsh(); }
      catch (e) { console.warn('[ssh] shutdown:', e && e.message); }
      handle = null;
    },
    isRunning: () => true,
    getStatus: () => {
      try { return ssh.getSshStatus(); }
      catch { return { running: true }; }
    },
  };

  return handle;
}

module.exports = { bootSsh };
```

> `require(mainPath).default ?? require(mainPath)` menangani kedua kemungkinan bentuk export dari bundle electron-vite (named vs default). Verifikasi bentuk aktual dengan `node -p "Object.keys(require('./modules/ssh/main/index.js'))"` **di dalam runtime Electron** (bukan Node biasa, karena bundle butuh modul `electron`).

**Acceptance D:** file adapter ada; `node --check modules/ssh/adapter/boot.cjs` lulus (cek sintaks; jangan panggil `bootSsh` di luar Electron).

---

## Fase E — Wiring Shell Super App

### E.1 `src/main/module-types.ts`

```ts
export type ModuleId = "cliproxy" | "net" | "ssh";
```

### E.2 `src/main/index.ts` — cabang `ssh` di `openModule()`

Tambah handle & cabang (menyusul pola `net` yang pakai `require`):

```ts
let cliproxyHandle: ModuleHandle | null = null;
let netHandle: ModuleHandle | null = null;
let sshHandle: ModuleHandle | null = null;      // ← BARU

function getHandles() {
  return { cliproxy: cliproxyHandle, net: netHandle, ssh: sshHandle }; // ← ssh
}
```

Di dalam `openModule`, tambah cabang setelah blok `net`:

```ts
} else if (id === "ssh") {
  if (!sshHandle) {
    const bootPath = path.join(__dirname, "../modules/ssh/adapter/boot.cjs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(bootPath) as {
      bootSsh: (o: { show: boolean; embedOnly?: boolean; moduleRoot: string }) => Promise<ModuleHandle>;
    };
    sshHandle = await mod.bootSsh({
      show: show && openInNewWindow,
      embedOnly: !openInNewWindow,
      moduleRoot: path.join(__dirname, "../modules/ssh"),
    });
  } else if (show && openInNewWindow) {
    sshHandle.show();
  }
  handle = sshHandle!;
}
```

> `getHandles` bertipe `{ cliproxy; net; ssh }` — perbarui juga anotasi tipe di `setTrayCallbacks`, `registerHubIpc`, dan `shutdownAll`.

### E.3 `src/main/hub/hub-window.ts`

Tambah path preload + loader konten, lalu cabang di `ensureModuleShell`:

```ts
function sshPreloadPath(): string {
  return path.join(__dirname, "../../modules/ssh/preload/index.js");
}

function loadSshContent(win: BrowserWindow): void {
  const devUrl = process.env.VITE_DEV_SERVER_URL_SSH; // opsional untuk HMR
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(path.join(__dirname, "../../modules/ssh/renderer/index.html"));
}
```

Di `ensureModuleShell(id, ...)`, tambah cabang sebelum fallback net:

```ts
if (id === "ssh") {
  const win = createShellWindow({
    title: "WAN Super App — WANN SSH",
    preload: sshPreloadPath(),
    startHidden: opts.startHidden,
    minWidth: 900,
    minHeight: 560,
    width: getSettings().windowBoundsHub?.width ?? 1200,
    height: getSettings().windowBoundsHub?.height ?? 780,
    sandbox: true,          // wann-ssh WAJIB sandbox:true (Bab 18 handbook SSH)
  });
  shellView = "ssh";
  loadSshContent(win);
  return win;
}
```

> `ShellView` type = `"hub" | ModuleId`, jadi otomatis ikut `"ssh"` setelah E.1.

### E.4 `src/main/hub/hub-ipc.ts`

Longgarkan guard modul & sertakan status ssh:

```ts
ipcMain.handle("super:openModule", async (_e, id: ModuleId) => {
  if (id !== "cliproxy" && id !== "net" && id !== "ssh") {   // ← ssh
    return { ok: false, error: "unknown module" };
  }
  // ... sama
});

ipcMain.handle("super:moduleState", async () => {
  const h = opts.getHandles();
  // ... cliproxy, net seperti semula ...
  let sshStatus: Record<string, unknown> = { running: !!h.ssh?.isRunning() };
  try {
    if (h.ssh?.getStatus) sshStatus = { ...sshStatus, ...(await h.ssh.getStatus()) };
  } catch { /* ignore */ }
  return { cliproxy: cliproxyStatus, net: netStatus, ssh: sshStatus };  // ← ssh
});
```

Perbarui juga anotasi tipe `getHandles` di parameter `registerHubIpc` menjadi menyertakan `ssh: ModuleHandle | null`.

### E.5 `src/main/hub/hub-settings.ts`

Pada `sanitize()`, izinkan `lastModule === "ssh"`:

```ts
lastModule: last === "cliproxy" || last === "net" || last === "ssh" ? last : null,
```

### E.6 `src/main/lifecycle.ts`

```ts
export async function shutdownAll(handles: {
  cliproxy: ModuleHandle | null;
  net: ModuleHandle | null;
  ssh: ModuleHandle | null;         // ← BARU
}): Promise<void> {
  const jobs: Promise<void>[] = [];
  if (handles.cliproxy?.isRunning()) jobs.push(handles.cliproxy.shutdown());
  if (handles.net?.isRunning()) jobs.push(handles.net.shutdown());
  if (handles.ssh?.isRunning()) jobs.push(handles.ssh.shutdown());   // ← BARU
  await Promise.allSettled(jobs);
}
```

### E.7 `src/main/tray.ts`

Perbarui tipe `getHandles` (tambah `ssh`) dan tambahkan submenu setelah WAN NET:

```ts
{
  label: "WANN SSH",
  submenu: [
    { label: "Buka dashboard", click: () => void openModuleFn?.("ssh", { show: true }) },
    { label: handles.ssh?.isRunning() ? "Running" : "Not started", enabled: false },
  ],
},
```

**Acceptance E:** `npm run typecheck` di super-app hijau (semua tipe `ModuleId`/`getHandles` konsisten).

---

## Fase F — Hub UI: Kartu Ketiga

### F.1 `src/hub-renderer/wan.d.ts`

```ts
export type ModuleId = "cliproxy" | "net" | "ssh";
// ...
moduleState: () => Promise<{
  cliproxy: Record<string, unknown>;
  net: Record<string, unknown>;
  ssh: Record<string, unknown>;        // ← BARU
}>;
```

### F.2 `src/hub-renderer/App.tsx`

Perbarui state awal & tambah kartu:

```tsx
const [state, setState] = useState<{
  cliproxy: Record<string, unknown>;
  net: Record<string, unknown>;
  ssh: Record<string, unknown>;
}>({ cliproxy: {}, net: {}, ssh: {} });
```

Turunan status:

```tsx
const sshRunning = !!state.ssh.running;
const sshVault = String(state.ssh.vault ?? "");
```

Sisipkan kartu ketiga di dalam `<div className="grid">`, setelah kartu `net`:

```tsx
<section className="card ssh">
  <h2>WANN SSH</h2>
  <p className="desc">
    SSH client dengan encrypted vault (Argon2id + AES-256-GCM), TOFU host-key,
    xterm.js, dan sinkronisasi cloud opsional (Firebase).
  </p>
  <div className="pills">
    <span className={`pill ${sshRunning ? "on" : "off"}`}>
      {sshRunning ? "Running" : "Idle"}
    </span>
    {sshVault && <span className="pill">vault: {sshVault}</span>}
  </div>
  <div className="actions">
    <button disabled={opening === "ssh"} onClick={() => void openModule("ssh")}>
      {opening === "ssh" ? "Opening…" : "Buka WANN SSH"}
    </button>
  </div>
</section>
```

> `EMPTY_SETTINGS`, `refresh()`, `openModule()`, dan `moduleState()` tidak perlu logika baru — hanya tipe. Grid CSS di `styles.css` sudah `auto-fit`/`minmax` (2 kartu → 3 kartu otomatis; verifikasi di Fase I, sesuaikan bila di-hardcode 2 kolom).

**Acceptance F:** Hub menampilkan **3 kartu**; klik "Buka WANN SSH" memanggil `super:openModule("ssh")`.

---

## Fase G — Native Module (argon2) & Packaging

### G.1 Tambah dependency runtime ke `wan-super-app/package.json`

Deps main yang di-`require` bundle wann-ssh saat runtime:

```jsonc
"dependencies": {
  // ... yang sudah ada ...
  "argon2": "^0.45.1",
  "ssh2": "^1.16.0",
  "firebase": "^11.10.0",
  "zod": "^3.23.0"
}
```

> Renderer (xterm, react, zustand, cmdk, react-virtual) **tidak** perlu di sini — sudah ter-bundle vite ke `modules/ssh/renderer`.

### G.2 Rebuild native ke Electron 43

`argon2` adalah satu-satunya native. Tambahkan rebuild setelah install:

```jsonc
"scripts": {
  "postinstall": "electron-builder install-app-deps"
}
```

Lalu:

```bash
cd wan-super-app
npm install                 # menarik argon2/ssh2/firebase/zod
npm run postinstall         # rebuild argon2 terhadap ABI Electron 43
```

Jika toolchain butuh venv Python (Node ≥26 / Python ≥3.12 kehilangan `distutils`), sama seperti README wann-ssh:

```bash
python3 -m venv /tmp/gypvenv && /tmp/gypvenv/bin/pip install setuptools
export npm_config_python=/tmp/gypvenv/bin/python
npm install
```

### G.3 `electron-builder.yml` — unpack native dari asar

Native `.node` tidak boleh di dalam asar. Tambah:

```yaml
asarUnpack:
  - "**/node_modules/argon2/**"
  - "**/node_modules/ssh2/**"        # ssh2 punya optional native (cpu-features); aman di-unpack
```

`files:` sudah `out/**` + `package.json`, jadi `out/modules/ssh/**` otomatis ikut. Tidak ada `extraResources` baru (SSH tidak butuh binary eksternal seperti cloudflared).

### G.4 Prasyarat build native per-OS (untuk CI)

| OS | Kebutuhan |
|----|-----------|
| macOS | Xcode Command Line Tools |
| Windows | VS 2022 Build Tools (C++), Python 3.x |
| Linux | build-essential, python3, libsecret-1-dev |

**Acceptance G:** membuka modul SSH dari Super App (`npm start`) tidak melempar `NODE_MODULE_VERSION mismatch` saat create/unlock vault.

---

## Fase H — Build Script & vendor-sync

### H.1 Script build di `package.json`

Karena bundle wann-ssh dibuat oleh electron-vite (di repo wann-ssh), Super App **tidak** mengkompilasi ulang SSH — ia hanya menyalin. Langkah copy dijalankan `copy-assets.mjs` (H.3). Opsional, sediakan script convenience:

```jsonc
"scripts": {
  "vendor:ssh": "cd ../wann-ssh && npm run build && cd ../wan-super-app && node scripts/vendor-sync.mjs"
}
```

`build` utama tidak perlu berubah bila `modules/ssh` sudah terisi; `copy-assets` yang memindahkannya ke `out/`.

### H.2 `scripts/vendor-sync.mjs` — sinkron sibling wann-ssh

Setelah blok net, tambahkan (mengikuti gaya rsync yang ada — mengecualikan `node_modules`, dan **membangun** wann-ssh dulu supaya `out/` terisi):

```js
const sshSrc = path.join(mono, "wann-ssh");
if (existsSync(sshSrc)) {
  // Bangun bundle wann-ssh lalu vendor hasilnya (main/preload/renderer).
  execSync("npm run build", { cwd: sshSrc, stdio: "inherit" });
  for (const part of ["main", "preload", "renderer"]) {
    execSync(
      `rsync -a --delete "${path.join(sshSrc, "out", part)}/" "${path.join(root, "modules/ssh", part)}/"`,
      { stdio: "inherit" }
    );
  }
  // Jangan hapus adapter/ & package.json penanda CJS (patch lokal Super App).
}
```

> Sama seperti catatan cliproxy/net: **jangan** `--delete` folder `adapter/` dan `package.json` lokal — itu patch Super App, bukan hasil vendor. Karena rsync di atas menarget sub-folder `main/preload/renderer` saja, `adapter/` & `package.json` di `modules/ssh/` aman.

### H.3 `scripts/copy-assets.mjs` — pindahkan modul SSH ke `out/`

Tambah di akhir file (meniru blok net, termasuk penanda CJS):

```js
// SSH module (CJS bundle: main + preload + renderer)
await copyFile(
  path.join(root, "modules/ssh/package.json"),
  path.join(root, "out/modules/ssh/package.json")
);
await copyDir(path.join(root, "modules/ssh/main"),     path.join(root, "out/modules/ssh/main"));
await copyDir(path.join(root, "modules/ssh/preload"),  path.join(root, "out/modules/ssh/preload"));
await copyDir(path.join(root, "modules/ssh/renderer"), path.join(root, "out/modules/ssh/renderer"));
await copyDir(path.join(root, "modules/ssh/adapter"),  path.join(root, "out/modules/ssh/adapter"));
console.log("[copy-assets] ssh main/preload/renderer/adapter → out/");
```

> Ingat: jalur load runtime di `src/main/index.ts` memakai `path.join(__dirname, "../modules/ssh/adapter/boot.cjs")`, dan `__dirname` = `out/main`. Maka target di atas (`out/modules/ssh/...`) sudah benar.

**Acceptance H:** `npm run build` menghasilkan `out/modules/ssh/{main,preload,renderer,adapter,package.json}`.

---

## Fase I — Jalankan, Uji, Rilis

### I.1 Dev / run

```bash
cd wan-super-app
npm run build
npm start
```

Skenario uji manual (window-mode, default):

1. Hub muncul dengan **3 kartu**.
2. Klik **Buka WANN SSH** → jendela SSH terbuka, layar unlock vault tampil.
3. Buat/unlock vault → daftar host, tambah host, buka terminal xterm, ketik perintah.
4. Kembali ke Hub (tray → "Buka Hub"); pill SSH = **Running**, `vault: unlocked`.
5. Buka **WAN NET** dan **CLIProxyAPI** → ketiganya hidup berdampingan.
6. Tray → submenu **WANN SSH → Buka dashboard** berfungsi.
7. Quit dari tray → `shutdownAll` mengunci vault & menutup sesi tanpa error.

Skenario replace-mode:

8. Hub → Preferences → matikan **Open modules in new window**.
9. Klik **Buka WANN SSH** → isi window Hub berganti jadi UI SSH (preload = ssh, `window.api` aktif). "Buka Hub" mengembalikan ke landing.

### I.2 Uji auto-lock & keamanan

10. Kunci layar OS → vault SSH otomatis lock, sesi tertutup (`vaultLocked` event).
11. Verifikasi tak ada secret bocor: DevTools renderer SSH → `window.api` hanya berisi fungsi; tak ada `ipcRenderer`/`require`.

### I.3 Packaging

```bash
npm run dist        # electron-builder — pastikan argon2 ter-rebuild & asarUnpack aktif
```

Smoke-test installer di mesin bersih: buka 3 modul, buat vault, connect SSH, cek auto-update Hub tetap jalan.

### I.4 Rilis (tetap seperti README utama)

Alur rilis tidak berubah: commit di `main` → push → bump `package.json` → tag `vX.Y.Z` → push tag → CI `build.yml` mempublikasikan installer. Sertakan highlight "modul WANN SSH" di catatan rilis.

**Acceptance I:** semua skenario 1–11 lolos; installer hasil `dist` berjalan di mesin bersih.

---

## Data & Konfigurasi Runtime

Karena Super App dan modul berbagi satu `userData` (`~/Library/Application Support/WAN Super App/` di macOS), file config wann-ssh ikut ke sana:

| Data | Lokasi (userData Super App) |
|------|------------------------------|
| Hub settings | `super-app.json` |
| CLIProxyAPI home | `~/.wan-super-app/cliproxyapi` |
| WAN NET config | `wan-net-cfg.json` |
| **WANN SSH store** | `wann-ssh.json` (field: `schemaVersion`, `vaultMeta`, `items`, `outbox`, `outboxSeq`, `syncCursor`; timestamp epoch-millis — lihat [store/db.ts](../wann-ssh/src/main/store/db.ts)) |
| **WANN SSH known_hosts** | file known-hosts di userData |
| **WANN SSH Firebase config** | `firebase-config.json` (opsional; sync M6) |

> Konsekuensi: menjalankan Super App vs menjalankan wann-ssh standalone memakai **userData berbeda** (appId `com.wan.superapp` vs `com.wann.wannssh`). Vault yang dibuat di standalone tidak otomatis muncul di Super App. Bila perlu berbagi, aktifkan Firebase sync, atau tetapkan `app.setPath('userData', ...)` bersama (tidak disarankan tanpa migrasi terencana).

---

## Keamanan yang WAJIB Dipertahankan

Integrasi **tidak boleh** menurunkan postur keamanan wann-ssh (handbook SSH Bab 18):

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` pada shell SSH → dijaga di `ensureModuleShell("ssh")` (Fase E.3).
- Preload SSH tetap **CJS** dan hanya expose fungsi (`window.api`). Jangan ganti ke ESM (sandbox mematikan preload ESM).
- Secret tidak pernah melewati IPC ke renderer; enkripsi di main sebelum simpan (tidak berubah — logika main dibawa apa adanya).
- `hostVerifier` TOFU tidak pernah `return true` tanpa syarat.
- Semua input IPC divalidasi zod (registrasi IPC tetap lewat `registerIpc(ctx)`).
- Auto-lock 15 menit + saat sleep/lock-screen → dipertahankan di `initSsh()` (Fase B.1).
- External link dibuka di browser sistem via `setWindowOpenHandler` (Fase B.2).

---

## Checklist Akhir (copy-paste)

```text
FASE A — Prasyarat
[ ] wann-ssh sibling folder di sebelah wan-super-app
[ ] wann-ssh: install + typecheck + test + build hijau
[ ] wan-super-app: install + typecheck + build + start hijau (2 kartu)

FASE B — Embed adapt (repo wann-ssh)
[ ] src/main/embed.ts dibuat (initSsh/openSshWindow/attachSshWindow/shutdownSsh/getSshStatus)
[ ] main-window.ts: attachWindow() ditambah
[ ] index.ts: lifecycle di-guard WAN_SUPER_APP_EMBED + re-export embed
[ ] build wann-ssh sukses; standalone masih normal

FASE C — Vendor bundle
[ ] modules/ssh/{main,preload,renderer} terisi hasil build
[ ] modules/ssh/package.json ("type":"commonjs")

FASE D — Adapter
[ ] modules/ssh/adapter/boot.cjs (bootSsh) dibuat + node --check lulus

FASE E — Shell wiring
[ ] module-types.ts: ModuleId += "ssh"
[ ] index.ts: openModule cabang ssh + getHandles.ssh
[ ] hub-window.ts: sshPreloadPath + loadSshContent + ensureModuleShell("ssh")
[ ] hub-ipc.ts: guard ssh + moduleState.ssh
[ ] hub-settings.ts: sanitize lastModule "ssh"
[ ] lifecycle.ts: shutdownAll.ssh
[ ] tray.ts: submenu WANN SSH + tipe getHandles
[ ] typecheck hijau

FASE F — Hub UI
[ ] wan.d.ts: ModuleId + moduleState.ssh
[ ] App.tsx: kartu ketiga WANN SSH + state.ssh
[ ] grid CSS menampung 3 kartu

FASE G — Native & packaging
[ ] package.json deps: argon2, ssh2, firebase, zod
[ ] postinstall: electron-builder install-app-deps
[ ] argon2 rebuild ke Electron 43 sukses
[ ] electron-builder.yml: asarUnpack argon2 (+ ssh2)

FASE H — Scripts
[ ] copy-assets.mjs: copy modules/ssh → out/ (+ penanda CJS)
[ ] vendor-sync.mjs: sinkron sibling wann-ssh

FASE I — Verifikasi
[ ] 3 kartu, buka SSH, unlock vault, terminal xterm jalan
[ ] window-mode & replace-mode dua-duanya OK
[ ] auto-lock saat lock-screen bekerja
[ ] npm run dist → installer jalan di mesin bersih
```

---

## Troubleshooting

| Gejala | Penyebab | Perbaikan |
|--------|----------|-----------|
| `Cannot use import statement outside a module` di `modules/ssh` | Root `type:module` men-treat bundle CJS sebagai ESM | Pastikan `modules/ssh/package.json` `"type":"commonjs"` tercopy ke `out/` (Fase C.3 + H.3) |
| `NODE_MODULE_VERSION xx vs yy` saat unlock vault | `argon2` di-build untuk Node/Electron lain | `electron-builder install-app-deps` (Fase G.2); hapus `node_modules/argon2` lalu install ulang |
| `ModuleNotFoundError: No module named 'distutils'` | Python ≥3.12 saat rebuild native | venv + `setuptools`, `export npm_config_python=...` (Fase G.2) |
| App crash "Attempted to register a second handler for 'vault:status'" | `registerIpc` dipanggil dua kali | Jaga guard `ipcRegistered` di `initSsh`; jangan hapus `require.cache` di adapter (Fase B.1/D) |
| Jendela SSH putih/blank | Renderer gagal load path | Cek `modules/ssh/renderer/index.html` ada di `out/`; base vite `./` (electron-vite default sudah relatif) |
| `window.api` undefined di renderer SSH | Preload salah/ESM | Preload harus `modules/ssh/preload/index.js` (CJS) dan shell `sandbox:true` memuat preload CJS (Fase E.3) |
| Vault SSH kosong padahal ada data di app standalone | userData berbeda (appId `com.wan.superapp` vs `com.wann.wannssh`) | Pakai Firebase sync, atau migrasi manual `wann-ssh.json` |
| `argon2`/`ssh2` hilang di installer | Native di dalam asar | Tambah `asarUnpack` (Fase G.3) |
| Native gagal di CI Windows/Linux | Toolchain build absen | Pasang VS Build Tools / build-essential + python3 (Fase G.4) |
| Renderer SSH minta node module saat runtime | Ada dep yang ter-*externalize* padahal renderer | Pastikan hanya main/preload yang externalize; renderer di-bundle penuh (electron.vite.config renderer tanpa `externalizeDepsPlugin`) |

---

## Lampiran — Kenapa Jalur Vendor-Bundle, bukan Merge Source

`wann-ssh` memakai **electron-vite** dengan:
- alias `@shared`, `@` (di `electron.vite.config.ts`),
- preload dipaksa **CJS** (`format:'cjs'`) karena `sandbox:true`,
- `externalizeDepsPlugin()` untuk `ssh2/argon2/firebase/zod`.

Super App memakai **tsc (NodeNext)** untuk main dan **vite manual** untuk tiap renderer, dengan root `type:module`. Menggabungkan sumber berarti mem-porting semua alias + aturan ESM/CJS ke tsconfig super-app dan menyamakan native rebuild — kompleksitas tinggi, gain rendah. Vendor-bundle memisahkan toolchain: setiap modul dibangun oleh pemiliknya, Super App hanya jadi shell. Ini identik dengan cara **WAN NET** (CJS verbatim) dan sejalan dengan filosofi `vendor/` + `modules/` yang sudah ada di repo.

---

**Selesai.** Setelah semua fase hijau, WAN Super App resmi menjadi shell 3-modul: **WANN X RENN CLIProxyAPI · WAN NET · WANN SSH**.
