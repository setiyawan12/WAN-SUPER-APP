# ⚡ WAN NET

Buat URL publik HTTPS instan dari komputer kamu — gratis, tanpa akun, tanpa batas.  
Setiap request yang masuk bisa dilihat, di-replay, di-mock, dan diekspor langsung dari dashboard.

```
Internet  →  URL Publik (Cloudflare)  →  WAN NET  →  Aplikasi kamu di localhost
```

---

## Dua Cara Pakai

| | Desktop App | CLI (Terminal) |
|---|---|---|
| **Cocok untuk** | Semua orang | Developer |
| **Cara pakai** | Klik-klik | Ketik perintah |
| **Fitur** | Lengkap + GUI | Lengkap |
| **Syarat** | Tidak ada | Node.js |

---

## 🖥 Cara 1 — Desktop App (Direkomendasikan)

### Download & Install

1. Buka halaman **Releases**: [github.com/setiyawan12/absenku-inspector-request/releases](https://github.com/setiyawan12/absenku-inspector-request/releases)
2. Pilih versi terbaru
3. Download file sesuai OS kamu:

| File | OS |
|------|----|
| `WAN NET-x.x.x-arm64.dmg` | macOS (Apple Silicon M1/M2/M3) |
| `WAN NET-x.x.x.dmg` | macOS (Intel) |
| `WAN NET-x.x.x-win-installer.exe` | Windows |
| `WAN NET-x.x.x.AppImage` | Linux |
| `WAN NET-x.x.x.deb` | Linux (Debian/Ubuntu) |

4. Install seperti aplikasi biasa:
   - **macOS** → buka `.dmg`, drag ke folder Applications
   - **Windows** → jalankan `.exe`, ikuti wizard
   - **Linux** → jalankan `.AppImage` langsung atau install `.deb` via `sudo dpkg -i`

> **macOS — muncul peringatan "developer tidak dikenal"?**  
> Buka **System Settings → Privacy & Security → Security** → klik **Open Anyway**

---

### Menggunakan Desktop App

**1. Jalankan aplikasi lokal kamu dulu** (misal di port 3000):
```bash
node app.js
# atau
php -S localhost:3000
# atau apapun yang berjalan di localhost
```

**2. Buka WAN NET** dari Applications / Start Menu

**3. Masukkan port** aplikasi kamu di kolom input, klik **▶ Start**

**4. URL publik muncul** dalam beberapa detik — bagikan ke siapa saja!

**5. Klik 🔍 Inspector** untuk melihat semua request yang masuk

---

### Fitur Desktop App

**Multi-tunnel** — jalankan beberapa port sekaligus dari satu tampilan

**Auto-start** — klik ⚡ di kartu tunnel agar tunnel otomatis hidup setiap buka app

**Custom domain** — hubungkan domain Cloudflare kamu sendiri (login CF diperlukan)

**Rate limit** — klik 🚦 di kartu tunnel, set maksimal request per detik (contoh: `10` = max 10 req/s, lebih dari itu dapat 429)

**QR Code** — klik ▦ di sebelah URL untuk generate QR, scan dari HP langsung buka URL publik

**Label tunnel** — klik nama tunnel untuk beri nama custom ("API Server", "Frontend", dll.)

**Auto-update** — saat ada versi baru, banner muncul otomatis di bagian bawah:
```
⬆ Update v1.4.0 siap — restart untuk install   [↺ Restart & Install]
```
Klik tombol, app restart sendiri, selesai.

---

## 💻 Cara 2 — CLI (Terminal)

### Syarat

**Node.js versi 16 ke atas** — cek dengan:
```bash
node --version
```
Belum ada? Download di [nodejs.org](https://nodejs.org) → pilih **LTS**

### Install

```bash
npm install -g .
```

> Saat pertama dijalankan, `wan-net` otomatis download `cloudflared` (~30 MB). Cukup sekali.

### Jalankan

```bash
wan-net http <port>
```

Contoh — aplikasi kamu di port 8000:
```bash
wan-net http 8000
```

Output yang muncul:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✅ TUNNEL AKTIF!

  🌐 Public URL  : https://abc-def-123.trycloudflare.com
  🔍 Inspector   : http://localhost:8080
  🎯 Local app   : http://localhost:8000

  Bagikan URL di atas — sudah HTTPS, bisa diakses siapa saja!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Buka **Inspector** di browser untuk melihat request masuk secara real-time.

### Opsi CLI

```bash
wan-net http <port> [opsi]
```

| Opsi | Keterangan |
|------|------------|
| `--pass <password>` | Lindungi inspector dengan password |
| `--tunnel-port <n>` | Port internal tunnel server (default: 3000) |
| `--client-port <n>` | Port internal client server (default: 4040) |

Berhenti: tekan **Ctrl + C**

---

## 🔍 Fitur Inspector

Buka inspector via tombol di desktop app, atau langsung di browser: `http://localhost:8080`

### Melihat Request
Setiap request tampil real-time dengan info lengkap:
- Method (GET, POST, PUT, DELETE, dll.)
- URL dan query string
- Status code (200, 404, 500, dll.)
- Headers request & response
- Body request & response (dengan syntax highlight JSON)
- Waktu respons (ms) dan ukuran body

### Filter & Cari
- Tombol **All / 2xx / 3xx / 4xx / 5xx** untuk filter berdasarkan status
- Kolom **Search** untuk cari berdasarkan URL, method, atau isi body
- Tombol **📌 Pin** untuk kunci request penting agar tidak hilang saat scroll

### Replay Request
Klik **Replay** untuk kirim ulang request ke aplikasi kamu — tanpa perlu membuat request baru dari client.

### Edit & Replay
Klik **Edit & Replay** untuk ubah method, URL, headers, atau body sebelum dikirim ulang.  
Berguna untuk debug atau test variasi request.

### Mock Response
Klik **Mock** pada request untuk membuat respons palsu.  
Saat URL tersebut dipanggil lagi, WAN NET langsung balas dengan respons yang kamu definisikan — tanpa meneruskan ke aplikasi.

**Contoh penggunaan mock:**
- Simulasi error 500 dari server
- Simulasi respons lambat (ada field **Delay ms** — isi `2000` untuk simulasi jaringan lambat 2 detik)
- Return data spesifik untuk test frontend tanpa backend jalan

### Rate Limiting
Atur maksimal request per detik per tunnel.  
Request yang melebihi batas otomatis mendapat respons **429 Too Many Requests**.  
Berguna untuk test behavior aplikasi saat API di-throttle.

### Diff Request
Klik **Diff** untuk bandingkan dua request secara berdampingan — lihat perbedaan headers, body, atau URL.

### Timeline View
Klik **Timeline** untuk lihat semua request dalam visualisasi waterfall — cocok untuk analisis performa.

### Header Injection
Klik **Inject** untuk otomatis menambahkan header ke setiap request masuk.  
Berguna untuk inject token auth, trace ID, atau header custom lainnya.

### Export HAR
Klik **HAR** untuk export semua request dalam format HAR (HTTP Archive).  
Bisa dibuka di Chrome DevTools → Network → Import HAR untuk analisis lebih lanjut.

### Export Postman Collection
Klik **Postman** untuk export request sebagai Postman Collection v2.1.  
Import langsung ke Postman — semua request, headers, dan body sudah siap.

### Shortcut Keyboard

| Tombol | Fungsi |
|--------|--------|
| `↑` `↓` | Navigasi antar request |
| `R` | Replay request yang dipilih |
| `U` | Copy request sebagai perintah cURL |
| `C` | Copy request body |
| `Esc` | Tutup modal |

---

## 👨‍💻 Untuk Developer

### Menjalankan dari Source Code

**Syarat:** Node.js 18+, Git

```bash
# 1. Clone repository
git clone https://github.com/setiyawan12/absenku-inspector-request.git
cd absenku-inspector-request

# 2. Install dependencies
npm install

# 3. Jalankan versi CLI
npm run dev
# atau
node bin/wan-net.js http 3000

# 4. Jalankan versi Electron (desktop app, mode development)
npm run electron
```

### Build Desktop App

Pastikan sudah install dependencies dulu:
```bash
npm install
```

**Build untuk macOS:**
```bash
npm run build:mac
# Output: dist/WAN NET-x.x.x-arm64.dmg
```

**Build untuk Windows:**
```bash
npm run build:win
# Output: dist/WAN NET-x.x.x-win-installer.exe
```

**Build untuk Linux:**
```bash
npm run build:linux
# Output: dist/*.deb dan dist/*.AppImage
```

**Build semua platform sekaligus:**
```bash
npm run build
```

> File hasil build ada di folder `dist/`

### Release Versi Baru

Workflow ini otomatis build dan upload ke GitHub Releases via GitHub Actions:

```bash
# 1. Naikkan versi (ganti 1.4.0 dengan versi yang diinginkan)
npm version 1.4.0 --no-git-tag-version
git add package.json
git commit -m "chore: bump version to 1.4.0"
git push origin main

# 2. Push tag → trigger GitHub Actions build otomatis
git tag v1.4.0
git push origin v1.4.0
```

GitHub Actions akan:
1. Build DMG (macOS), EXE (Windows), DEB + AppImage (Linux)
2. Upload semua file ke GitHub Releases
3. Generate `latest-mac.yml` yang dibaca auto-updater

Semua user yang sudah install versi lama akan mendapat notifikasi update otomatis.

### Struktur Folder

```
NGROK/
├── bin/
│   └── wan-net.js              ← CLI entry point
├── electron/
│   ├── main.js                 ← Electron main process
│   ├── launcher.html           ← UI dashboard desktop
│   ├── launcher.js             ← Logika UI dashboard
│   ├── launcher.css            ← Styling dashboard
│   ├── launcher-preload.js     ← Bridge renderer ↔ main (contextBridge)
│   ├── preload.js              ← Preload untuk settings window
│   └── settings.html           ← Halaman settings
├── lib/
│   ├── config.js               ← Konfigurasi global
│   ├── state.js                ← State bersama antar modul
│   ├── utils.js                ← Helper: SSE, uid, auth, dll.
│   ├── persist.js              ← Simpan/load log ke disk
│   ├── tunnel-server.js        ← Terima request publik + rate limit + mock
│   ├── client-server.js        ← Komunikasi dengan tunnel client
│   ├── inspector-server.js     ← API + SSE untuk dashboard browser
│   ├── inspector-html.js       ← Assembler HTML dashboard
│   ├── inspector-client.js     ← Logika browser dashboard
│   ├── inspector-css.js        ← Styling dashboard
│   ├── tunnel-client.js        ← Forward request ke app lokal
│   └── cloudflared.js          ← Download & spawn cloudflared
├── scripts/
│   ├── notarize.js             ← Script notarisasi macOS
│   └── entitlements.mac.plist  ← Entitlements untuk hardenedRuntime
├── .github/
│   └── workflows/
│       └── build.yml           ← CI/CD: build + release otomatis
├── package.json
└── README.md
```

---

## ❓ FAQ

**URL publik berubah setiap sesi — normal?**  
Ya, normal. Cloudflare Quick Tunnel (gratis) memang memberi URL acak tiap sesi. Untuk URL permanen, gunakan fitur Custom Domain dengan akun Cloudflare.

**Apakah data request tersimpan di server?**  
Tidak. Semua data hanya di memori komputer kamu dan hilang saat WAN NET ditutup.

**Inspector tidak terbuka di browser?**  
Pastikan WAN NET sedang berjalan, lalu buka manual: `http://localhost:8080`

**Bisa jalankan lebih dari satu tunnel?**  
Bisa. Di desktop app, tambahkan port baru dari kolom input. Di CLI, jalankan `wan-net http <port>` di terminal berbeda.

**Mock tidak aktif?**  
Pastikan method dan path mock persis sama dengan request yang masuk. Mock tidak mendukung wildcard/regex — harus exact match.

**Auto-update tidak muncul?**  
Pastikan kamu memakai versi yang terinstall dari GitHub Releases (bukan build manual). Cek koneksi internet, lalu restart app.

---

## Platform

| OS | Status |
|----|--------|
| macOS Apple Silicon (M1/M2/M3) | ✅ |
| macOS Intel | ✅ |
| Windows 10/11 (x64) | ✅ |
| Linux (x64) | ✅ |
