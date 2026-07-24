# WAN Super App

Satu shell Electron untuk:

1. **WAN CLIProxyAPI** — Chat, Cowork, Neuron, VS Code / JetBrains (logic dari `wan-cliproxyapi`)
2. **WAN NET** — Cloudflare tunnel + inspector (logic dari `wan-net`)

Buka app → Hub (2 kartu) → pilih modul → UI & fungsi seperti app aslinya.

Lihat [HANDBOOK-WAN-SUPER-APP.md](./HANDBOOK-WAN-SUPER-APP.md) untuk arsitektur lengkap.

## Requirements

- Node.js 20+
- macOS / Windows / Linux

## Setup

```bash
cd wan-super-app
npm install
npm run build
npm start
```

Dev (HMR hub + cliproxy renderer):

```bash
npm run dev
```

## Scripts

| Script | Fungsi |
|--------|--------|
| `npm run build` | compile main + cliproxy main, copy assets, vite hub + cliproxy |
| `npm run dev` | vite dual + electron |
| `npm start` | build lalu electron |
| `npm run dist` | electron-builder |
| `npm run vendor:sync` | rsync dari sibling `wan-cliproxyapi` / `wan-net` |

## Data paths

| Data | Path |
|------|------|
| Hub settings | `{userData}/super-app.json` |
| CLIProxyAPI home | `~/.wan-super-app/cliproxyapi` |
| WAN NET config | `{userData}/wan-net-cfg.json` |

## Layout

```
src/main/           Super App shell (hub, tray, lifecycle)
src/hub-renderer/   Hub UI (2 cards)
modules/cliproxy/   Working copy CLIProxyAPI + super-boot
modules/net/        Working copy WAN NET + embed API
vendor/             Read-only snapshots
```

## Notes

- Electron pinned `^31` (compatible with wan-net CJS + cliproxy ESM shell).
- Net module loads via `createRequire` (`boot.cjs`); cliproxy via dynamic `import`.
- Only Super App owns `app.whenReady`, tray, and quit.

---

## Commit, push, dan release (step by step)

Alur resmi Super App: **commit di `main` → push → bump versi → tag `vX.Y.Z` → push tag**.  
Push tag `v*` memicu workflow **Release** (`.github/workflows/build.yml`) yang build macOS / Windows / Linux lalu publish ke **GitHub Releases**.

Repo: `https://github.com/setiyawan12/WAN-SUPER-APP`

### Ringkasan cepat

| Langkah | Perintah / aksi | Hasil |
|--------|------------------|--------|
| 1. Siapkan perubahan | edit + cek lokal | kode siap |
| 2. Commit | `git add` + `git commit` | history lokal |
| 3. Push branch | `git push origin main` | kode di GitHub |
| 4. Bump versi | edit `package.json` (ikut commit) | semver naik |
| 5. Tag release | `git tag -a vX.Y.Z` | penanda rilis |
| 6. Push tag | `git push origin vX.Y.Z` | **CI Release jalan** |
| 7. Pantau | Actions + Releases | installer terbit |

> **Penting:** push `main` **saja tidak** membuat installer. Release hanya jalan jika ada **tag** `v*` (contoh `v0.1.4`) atau lewat **Actions → Release → Run workflow**.

---

### A. Persiapan sebelum commit

1. Pastikan di branch yang benar (biasanya `main`):

```bash
cd wan-super-app
git checkout main
git pull origin main
```

2. Cek status & diff:

```bash
git status
git diff
```

3. Validasi build lokal (disarankan, terutama sebelum release):

```bash
npm run typecheck
npm run build
# opsional: coba jalankan
npm start
# atau
npm run dev
```

4. Jangan commit artefak build / secrets:

- Jangan commit `out/`, `dist/`, `node_modules/`, file `.env`, sertifikat, password.
- Commit source + config yang relevan (`src/`, `modules/`, `build/icon*`, `package.json`, workflow, dsb.).

---

### B. Commit perubahan

1. Stage file yang ingin di-commit:

```bash
# semua perubahan relevan
git add -A

# atau pilih file
git add path/ke/file1 path/ke/file2
```

2. Commit dengan pesan jelas (Conventional Commits disarankan):

```bash
git commit -m "$(cat <<'EOF'
feat(hub): ringkas apa yang berubah

Opsional: baris kedua menjelaskan kenapa / dampak user.
EOF
)"
```

Contoh tipe pesan:

| Prefix | Kapan dipakai |
|--------|----------------|
| `feat:` | fitur baru |
| `fix:` | perbaikan bug |
| `chore:` | maintenance, bump version, tooling |
| `ci:` | GitHub Actions / release pipeline |
| `docs:` | README / handbook |

3. Pastikan working tree bersih (atau sisa file memang sengaja tidak di-commit):

```bash
git status
git log -3 --oneline
```

---

### C. Push ke GitHub (`main`)

```bash
git push origin main
```

Cek remote:

```bash
git status
# harus: main...origin/main (up to date)
```

Ini hanya menyimpan kode. **Belum** memicu build installer.

---

### D. Release versi baru (lengkap)

Release Super App memakai **semver** di `package.json` dan **git tag** `v` + versi yang sama.

Contoh: versi sekarang `0.1.3` → rilis berikutnya `0.1.4` / `0.2.0` / `1.0.0`.

#### 1) Tentukan nomor versi

| Jenis perubahan | Naikkan | Contoh |
|-----------------|--------|--------|
| Bugfix / patch kecil | patch | `0.1.3` → `0.1.4` |
| Fitur mundur-kompatibel | minor | `0.1.3` → `0.2.0` |
| Breaking change besar | major | `0.1.3` → `1.0.0` |

Cek versi saat ini:

```bash
node -p "require('./package.json').version"
git tag -l 'v*' | tail -10
```

Tag **harus belum ada** di remote:

```bash
git ls-remote --tags origin 'v0.1.4'
# kosong = aman dipakai
```

#### 2) Bump `package.json` lalu commit

Edit `"version"` di `package.json`, **atau**:

```bash
# ganti 0.1.4 sesuai target
npm version 0.1.4 --no-git-tag-version
```

Commit bump + perubahan fitur (boleh digabung satu commit, atau commit fitur dulu lalu commit `chore: bump version`):

```bash
git add package.json
# + file fitur/fix lain jika belum di-commit
git add -u
git commit -m "$(cat <<'EOF'
chore: release v0.1.4

Ringkas highlight rilis (fitur/fix) di body commit.
EOF
)"
git push origin main
```

> Versi di tag **`v0.1.4`** harus selaras dengan `package.json` (`0.1.4`). CI juga men-set versi dari nama tag saat build.

#### 3) Buat annotated tag

```bash
# ganti 0.1.4 dan pesan tag
git tag -a v0.1.4 -m "v0.1.4 — ringkas highlight rilis"
```

Cek tag mengarah ke commit yang benar:

```bash
git show v0.1.4 --stat
git log -1 --oneline
```

#### 4) Push tag → trigger Release CI

```bash
git push origin v0.1.4
```

Jangan hanya `git push` tanpa nama tag. Push tag eksplisit:

```bash
git push origin v0.1.4
# atau semua tag lokal yang belum terkirim (hati-hati):
# git push origin --tags
```

#### 5) Pantau build & rilis

1. **Actions:**  
   https://github.com/setiyawan12/WAN-SUPER-APP/actions  
   Workflow name: **Release** (jobs macOS / Windows / Linux + Finalize).

2. **GitHub Releases:**  
   https://github.com/setiyawan12/WAN-SUPER-APP/releases  
   Setelah job sukses, asset muncul (mis. DMG/ZIP mac, NSIS Windows, AppImage/deb Linux).

3. Draft release di-finalize job **Finalize release** (notes singkat + daftar asset).

#### 6) (Opsional) Release manual tanpa push tag dulu

Di GitHub:

1. **Actions** → workflow **Release**
2. **Run workflow**
3. Branch: `main`
4. Input `version` opsional (contoh `0.1.4`); kosong = pakai `package.json`

Catatan: finalize notes penuh paling andal saat trigger dari **tag** `refs/tags/v*`. Alur standar tetap: **push tag**.

---

### E. Checklist satu kali (copy-paste)

Ganti `0.1.4` dan pesan sesuai rilis:

```bash
cd wan-super-app
git checkout main
git pull origin main

# 1) validasi
npm run typecheck
npm run build

# 2) commit perubahan (jika belum)
git status
git add -A
git commit -m "feat: deskripsi perubahan"
git push origin main

# 3) bump version
npm version 0.1.4 --no-git-tag-version
git add package.json
git commit -m "chore: release v0.1.4"
git push origin main

# 4) tag + push tag (INI yang memicu installer)
git tag -a v0.1.4 -m "v0.1.4 — deskripsi rilis"
git push origin v0.1.4

# 5) pantau
echo "Actions:  https://github.com/setiyawan12/WAN-SUPER-APP/actions"
echo "Release:  https://github.com/setiyawan12/WAN-SUPER-APP/releases/tag/v0.1.4"
```

---

### F. Auto-update in-app

- Feed updater: GitHub Releases repo **`setiyawan12/WAN-SUPER-APP`** (`electron-builder.yml` → `publish`).
- Setelah release assets terbit, build **packaged** bisa cek update lewat Hub → **App Update** / tray **Check for Update**.
- Mode `npm run dev` / unpackaged: cek update manual saja; **install update hanya di app ter-install** (bukan dev).

File terkait:

- `dev-app-update.yml` — feed dev unpackaged
- `src/main/hub/app-updater.ts` — service updater
- `electron-builder.yml` — `publish.provider: github`

---

### G. Troubleshooting release

| Gejala | Penyebab umum | Perbaikan |
|--------|----------------|-----------|
| Actions tidak jalan | Tag tidak di-push / nama bukan `v*` | `git push origin vX.Y.Z`; tag harus `v0.1.4` bukan `0.1.4` |
| Tag sudah ada | Rilis ulang nomor sama | Naikkan versi baru, atau hapus tag remote **hanya jika yakin** (`git push origin :refs/tags/vX.Y.Z`) lalu buat ulang |
| Job mac gagal sign/notarize | Secret Apple kosong/salah | Isi `APPLE_CERT_P12`, `APPLE_CERT_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` di repo secrets |
| Windows/Linux gagal | dependency / cloudflared download | Buka log job; pastikan network CI & `npm ci` OK |
| Release kosong / partial | salah satu OS job gagal | Perbaiki job gagal, push **tag versi baru** (lebih aman daripada force tag lama) |
| In-app update tidak melihat versi baru | assets belum ready / versi app ≥ release | Tunggu job publish selesai; pastikan `package.json` app terpasang lebih rendah dari tag rilis |
| Salah commit ter-tag | tag di commit lama | `git tag -d vX.Y.Z` lokal, buat ulang di commit benar, force-push tag hanya jika belum diandalkan orang lain |

Hapus tag salah (hati-hati, mengganggu yang sudah download):

```bash
# lokal
git tag -d v0.1.4
# remote
git push origin :refs/tags/v0.1.4
```

---

### H. Apa yang di-build CI

Workflow **Release** (`.github/workflows/build.yml`):

| Job | Platform | Artefak utama |
|-----|----------|----------------|
| `build-mac` | macOS arm64 | `.dmg`, `.zip` (sign + notarize jika secret ada) |
| `build-win` | Windows | installer NSIS |
| `build-linux` | Linux | `.AppImage`, `.deb` |
| `finalize-release` | Ubuntu | merapikan GitHub Release notes (hanya saat ref tag `v*`) |

Publish memakai `electron-builder --publish always` + `GH_TOKEN`.

---

### I. Aturan praktis tim

1. **Jangan** force-push `main` yang sudah di-release kecuali darurat.
2. **Satu tag = satu nomor versi** yang sama dengan `package.json`.
3. Fitur dulu di `main`, baru tag release (hindari tag di commit setengah jadi).
4. Tulis highlight rilis di pesan tag / body commit `chore: release …`.
5. Setelah release, smoke-test installer di mesin bersih (buka Hub, buka modul, cek update).
