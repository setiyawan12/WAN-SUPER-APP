<div align="center">

<img src="build/icon.png" alt="WAN Super App" width="120" height="120" />

# WAN Super App

**Satu shell Electron. Dua modul kelas produksi. Nol ribet.**

CLIProxyAPI desktop (Chat · Cowork · Neuron · VS Code / JetBrains) berpadu dengan
WAN NET (Cloudflare tunnel + inspector) dalam satu aplikasi native yang elegan.

<br/>

![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-1f2937?style=for-the-badge)
![Electron](https://img.shields.io/badge/Electron-31%2B-47848F?style=for-the-badge&logo=electron&logoColor=white)
![Node](https://img.shields.io/badge/Node-20%2B-339933?style=for-the-badge&logo=node.js&logoColor=white)
![Release](https://img.shields.io/badge/release-v0.1.4-c9a227?style=for-the-badge)
![License](https://img.shields.io/badge/license-MIT-6b7280?style=for-the-badge)

</div>

---

## Daftar Isi

- [Sekilas](#sekilas)
- [Fitur Utama](#fitur-utama)
- [Requirements](#requirements)
- [Instalasi & Menjalankan](#instalasi--menjalankan)
- [Scripts](#scripts)
- [Arsitektur Singkat](#arsitektur-singkat)
- [Struktur Direktori](#struktur-direktori)
- [Data & Konfigurasi](#data--konfigurasi)
- [Catatan Teknis](#catatan-teknis)
- [🚀 Commit, Push & Release](#-commit-push--release)
- [Auto-Update In-App](#auto-update-in-app)
- [Troubleshooting](#troubleshooting)
- [Referensi CI/CD](#referensi-cicd)
- [Aturan Praktis Tim](#aturan-praktis-tim)
- [License](#license)

---

## Sekilas

WAN Super App membungkus **dua aplikasi mandiri** ke dalam satu shell Electron:

| Modul | Berbasis | Kemampuan |
|-------|----------|-----------|
| **WAN CLIProxyAPI** | `wan-cliproxyapi` | Chat AI, Cowork Mode, Neuron Activity, sinkronisasi VS Code / JetBrains |
| **WAN NET** | `wan-net` | Cloudflare Tunnel + inspector lalu-lintas |

> **Alur pemakaian:** Buka app → **Hub** (2 kartu) → pilih modul → UI & fungsi persis seperti app aslinya.

Arsitektur lengkap ada di **[HANDBOOK-WAN-SUPER-APP.md](./HANDBOOK-WAN-SUPER-APP.md)**.

---

## Fitur Utama

- 🧩 **Dua modul, satu binary** — tidak perlu memasang dua aplikasi terpisah.
- 🪟 **Hub terpusat** — landing dengan dua kartu modul, dukungan mode window/replace.
- 🔄 **Auto-update in-app** — feed langsung dari GitHub Releases.
- 🖥️ **Cross-platform** — macOS (arm64), Windows (NSIS), Linux (AppImage/deb).
- 🎨 **Branding premium** — ikon monogram + tray template icon adaptif dark/light.
- ⚙️ **Vendor sync** — snapshot read-only sumber modul agar mudah diperbarui.

---

## Requirements

| Komponen | Versi |
|----------|-------|
| Node.js  | **20+** |
| OS       | macOS · Windows · Linux |
| Electron | `^31` (dikelola otomatis) |

---

## Instalasi & Menjalankan

```bash
# 1. Masuk folder proyek
cd wan-super-app

# 2. Pasang dependency
npm install

# 3. Build seluruh bagian (main + renderer)
npm run build

# 4. Jalankan
npm start
```

### Mode Pengembangan (HMR)

```bash
npm run dev
```

> `npm run dev` menjalankan Vite dual (hub + cliproxy renderer) bersama Electron dengan hot-reload.

---

## Scripts

| Script | Fungsi |
|--------|--------|
| `npm run build` | Compile main + cliproxy main, copy assets, build Vite hub + cliproxy |
| `npm run dev` | Vite dual + Electron dengan HMR |
| `npm start` | Build lalu jalankan Electron |
| `npm run typecheck` | Type-check tanpa emit (main + cliproxy) |
| `npm run dist` | Bundling installer via `electron-builder` |
| `npm run vendor:sync` | Rsync dari sibling `wan-cliproxyapi` / `wan-net` |
| `npm run clean` | Hapus folder `out/` |

---

## Arsitektur Singkat

```
┌──────────────────────────────────────────────────────────┐
│                   WAN Super App (Electron)                │
│  ┌────────────────────────────────────────────────────┐  │
│  │   Main Process — app.whenReady · tray · lifecycle  │  │
│  └───────────────┬───────────────────┬────────────────┘  │
│                  │                   │                    │
│        ┌─────────▼────────┐ ┌────────▼─────────┐          │
│        │   Hub Renderer   │ │  Module Windows  │          │
│        │   (2 cards)      │ │  cliproxy / net  │          │
│        └──────────────────┘ └──────────────────┘          │
└──────────────────────────────────────────────────────────┘
```

- **WAN NET** dimuat via `createRequire` (`boot.cjs`, CommonJS).
- **CLIProxyAPI** dimuat via dynamic `import` (ESM).
- Hanya Super App yang memiliki `app.whenReady`, tray, dan proses quit.

---

## Struktur Direktori

```
src/main/           # Super App shell (hub, tray, lifecycle)
src/hub-renderer/   # Hub UI (2 cards)
modules/cliproxy/   # Working copy CLIProxyAPI + super-boot
modules/net/        # Working copy WAN NET + embed API
vendor/             # Snapshot read-only sumber modul
build/              # Ikon, entitlements, notarize
scripts/            # Build helper (copy-assets, dev, vendor-sync)
```

---

## Data & Konfigurasi

| Data | Lokasi |
|------|--------|
| Hub settings | `{userData}/super-app.json` |
| CLIProxyAPI home | `~/.wan-super-app/cliproxyapi` |
| WAN NET config | `{userData}/wan-net-cfg.json` |

> `{userData}` di macOS = `~/Library/Application Support/WAN Super App/`.

---

## Catatan Teknis

- Electron dipin ke `^31` — kompatibel dengan wan-net (CJS) dan cliproxy (ESM shell).
- Modul Net dimuat lewat `createRequire` (`boot.cjs`); cliproxy lewat dynamic `import`.
- Hanya Super App yang mengelola `app.whenReady`, tray, dan quit.

---

## 🚀 Commit, Push & Release

> **Alur resmi:** `commit di main` → `push` → `bump versi` → `tag vX.Y.Z` → `push tag`
>
> Push tag `v*` memicu workflow **Release** (`.github/workflows/build.yml`) yang membangun
> installer macOS / Windows / Linux lalu mempublikasikannya ke **GitHub Releases**.

**Repo:** `https://github.com/setiyawan12/WAN-SUPER-APP`

### Peta Alur

| # | Langkah | Perintah / aksi | Hasil |
|---|---------|-----------------|-------|
| 1 | Siapkan perubahan | edit + cek lokal | kode siap |
| 2 | Commit | `git add` + `git commit` | history lokal |
| 3 | Push branch | `git push origin main` | kode di GitHub |
| 4 | Bump versi | edit `package.json` | semver naik |
| 5 | Tag release | `git tag -a vX.Y.Z` | penanda rilis |
| 6 | Push tag | `git push origin vX.Y.Z` | **CI Release jalan** |
| 7 | Pantau | Actions + Releases | installer terbit |

> ⚠️ **Penting:** push `main` **saja tidak** membuat installer.
> Release hanya jalan jika ada **tag** `v*` (contoh `v0.1.4`) atau lewat **Actions → Release → Run workflow**.

<br/>

<details open>
<summary><b>A · Persiapan sebelum commit</b></summary>

<br/>

**1. Pastikan berada di branch yang benar:**

```bash
cd wan-super-app
git checkout main
git pull origin main
```

**2. Cek status & diff:**

```bash
git status
git diff
```

**3. Validasi build lokal (disarankan sebelum release):**

```bash
npm run typecheck
npm run build
npm start        # atau: npm run dev
```

**4. Jangan commit artefak build / secrets:**

- ❌ `out/`, `dist/`, `node_modules/`, `.env`, sertifikat, password.
- ✅ Source & config relevan: `src/`, `modules/`, `build/icon*`, `package.json`, workflow.

</details>

<details>
<summary><b>B · Commit perubahan</b></summary>

<br/>

**1. Stage file:**

```bash
git add -A                       # semua perubahan
git add path/ke/file1 file2      # atau pilih file
```

**2. Commit dengan pesan jelas (Conventional Commits):**

```bash
git commit -m "$(cat <<'EOF'
feat(hub): ringkas apa yang berubah

Opsional: baris kedua menjelaskan kenapa / dampak user.
EOF
)"
```

| Prefix | Kapan dipakai |
|--------|---------------|
| `feat:` | fitur baru |
| `fix:` | perbaikan bug |
| `chore:` | maintenance, bump version, tooling |
| `ci:` | GitHub Actions / release pipeline |
| `docs:` | README / handbook |

**3. Pastikan working tree bersih:**

```bash
git status
git log -3 --oneline
```

</details>

<details>
<summary><b>C · Push ke GitHub (main)</b></summary>

<br/>

```bash
git push origin main
git status        # harus: main...origin/main (up to date)
```

> Langkah ini hanya menyimpan kode. **Belum** memicu build installer.

</details>

<details>
<summary><b>D · Release versi baru (lengkap)</b></summary>

<br/>

Release memakai **semver** di `package.json` + **git tag** `v` dengan angka yang sama.

**1) Tentukan nomor versi:**

| Jenis perubahan | Naikkan | Contoh |
|-----------------|---------|--------|
| Bugfix / patch kecil | patch | `0.1.4` → `0.1.5` |
| Fitur mundur-kompatibel | minor | `0.1.4` → `0.2.0` |
| Breaking change besar | major | `0.1.4` → `1.0.0` |

```bash
node -p "require('./package.json').version"     # versi saat ini
git tag -l 'v*' | tail -10                       # tag terakhir
git ls-remote --tags origin 'v0.1.5'             # kosong = aman
```

**2) Bump `package.json` lalu commit:**

```bash
npm version 0.1.5 --no-git-tag-version
git add package.json
git add -u
git commit -m "$(cat <<'EOF'
chore: release v0.1.5

Ringkas highlight rilis (fitur/fix) di body commit.
EOF
)"
git push origin main
```

> Versi di tag **`v0.1.5`** harus selaras dengan `package.json` (`0.1.5`).

**3) Buat annotated tag:**

```bash
git tag -a v0.1.5 -m "v0.1.5 — ringkas highlight rilis"
git show v0.1.5 --stat
```

**4) Push tag → memicu Release CI:**

```bash
git push origin v0.1.5
```

**5) Pantau build & rilis:**

- **Actions:** https://github.com/setiyawan12/WAN-SUPER-APP/actions
- **Releases:** https://github.com/setiyawan12/WAN-SUPER-APP/releases

**6) (Opsional) Release manual tanpa push tag:**

`Actions` → workflow **Release** → **Run workflow** → branch `main` → input `version` opsional.
Untuk finalize notes paling lengkap, tetap gunakan alur **push tag**.

</details>

<details>
<summary><b>E · Checklist Satu Kali (copy-paste)</b></summary>

<br/>

Ganti `0.1.5` dan pesan sesuai rilis:

```bash
cd wan-super-app
git checkout main
git pull origin main

# 1) validasi
npm run typecheck
npm run build

# 2) commit perubahan (jika belum)
git add -A
git commit -m "feat: deskripsi perubahan"
git push origin main

# 3) bump version
npm version 0.1.5 --no-git-tag-version
git add package.json
git commit -m "chore: release v0.1.5"
git push origin main

# 4) tag + push tag (INI yang memicu installer)
git tag -a v0.1.5 -m "v0.1.5 — deskripsi rilis"
git push origin v0.1.5

# 5) pantau
echo "Actions:  https://github.com/setiyawan12/WAN-SUPER-APP/actions"
echo "Release:  https://github.com/setiyawan12/WAN-SUPER-APP/releases/tag/v0.1.5"
```

</details>

---

## Auto-Update In-App

- **Feed updater:** GitHub Releases repo `setiyawan12/WAN-SUPER-APP` (`electron-builder.yml` → `publish`).
- Build **packaged** dapat cek update lewat **Hub → App Update** atau tray **Check for Update**.
- Mode `npm run dev` / unpackaged hanya bisa cek manual; **instalasi update hanya di app ter-install**.

**File terkait:**

| File | Peran |
|------|-------|
| `dev-app-update.yml` | Feed dev unpackaged |
| `src/main/hub/app-updater.ts` | Service updater |
| `electron-builder.yml` | `publish.provider: github` |

---

## Troubleshooting

| Gejala | Penyebab umum | Perbaikan |
|--------|---------------|-----------|
| Actions tidak jalan | Tag tidak di-push / nama bukan `v*` | `git push origin vX.Y.Z`; tag harus `v0.1.5`, bukan `0.1.5` |
| Tag sudah ada | Rilis ulang nomor sama | Naikkan versi baru, atau hapus tag remote **hanya jika yakin** lalu buat ulang |
| Job mac gagal sign/notarize | Secret Apple kosong/salah | Isi `APPLE_CERT_P12`, `APPLE_CERT_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |
| Windows/Linux gagal | Dependency / download cloudflared | Buka log job; pastikan network CI & `npm ci` OK |
| Release kosong / partial | Salah satu OS job gagal | Perbaiki job gagal, push **tag versi baru** |
| Update tak melihat versi baru | Assets belum ready / versi app ≥ release | Tunggu publish selesai; pastikan versi app terpasang < tag rilis |
| Salah commit ter-tag | Tag di commit lama | `git tag -d vX.Y.Z` lokal, buat ulang di commit benar |

**Hapus tag salah** (hati-hati — mengganggu yang sudah mengunduh):

```bash
git tag -d v0.1.5                       # lokal
git push origin :refs/tags/v0.1.5       # remote
```

---

## Referensi CI/CD

Workflow **Release** (`.github/workflows/build.yml`):

| Job | Platform | Artefak utama |
|-----|----------|---------------|
| `build-mac` | macOS arm64 | `.dmg`, `.zip` (sign + notarize jika secret ada) |
| `build-win` | Windows | Installer NSIS |
| `build-linux` | Linux | `.AppImage`, `.deb` |
| `finalize-release` | Ubuntu | Merapikan GitHub Release notes (hanya saat ref tag `v*`) |

> Publish memakai `electron-builder --publish always` + `GH_TOKEN`.

---

## Aturan Praktis Tim

1. **Jangan** force-push `main` yang sudah di-release kecuali darurat.
2. **Satu tag = satu nomor versi** yang sama dengan `package.json`.
3. Selesaikan fitur di `main` dulu, baru tag release (hindari tag di commit setengah jadi).
4. Tulis highlight rilis di pesan tag / body commit `chore: release …`.
5. Setelah release, smoke-test installer di mesin bersih (buka Hub, buka modul, cek update).

---

## License

Dirilis di bawah lisensi **MIT**. Lihat `package.json` untuk detail.

<div align="center">

<br/>

**WAN Super App** — dibuat dengan ⚡ oleh tim WAN.

</div>
