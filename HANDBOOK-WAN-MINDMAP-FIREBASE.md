# Handbook: WAN Mindmap Fresh Firebase Setup

Panduan production untuk menjalankan WAN Mindmap sebagai modul WAN Super App
dengan project Firebase baru. Sistem MySQL/Docker lama, akun lama, password lama,
dan data lama tidak digunakan.

---

## 1. Arsitektur

```text
WAN Super App
├── Electron main + sandboxed preload
├── WAN Mindmap renderer
│   ├── Firebase Authentication
│   ├── Firestore metadata, workspace, group, sharing
│   ├── Realtime Database canvas dan access mirror
│   └── local cache untuk recovery/offline
└── Firebase backend
    ├── Security Rules
    ├── Cloud Functions
    └── Hosting public share
```

Pembagian data:

| Komponen | Fungsi |
|----------|--------|
| Firebase Auth | Signup, login, reset password, session |
| Firestore | Profil, metadata, workspace tree, grup, share, activity |
| RTDB | Snapshot canvas, revision, access mirror |
| Functions | Admin user, grup, sharing, public link, email |
| Hosting | Public read-only share |
| Local storage | Cache personal dan recovery offline |

---

## 2. Prasyarat

- Node.js 22.
- Firebase CLI.
- Project Firebase baru.
- Billing Firebase bila Functions production membutuhkannya.
- Service account atau Application Default Credentials hanya untuk bootstrap admin.

```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH node --version
firebase --version
```

Service-account JSON tidak boleh masuk repository atau bundle Electron.

---

## 3. Buat Project Firebase

Pada Firebase Console:

1. Buat project baru.
2. Aktifkan Authentication provider Email/Password.
3. Buat Firestore database.
4. Buat Realtime Database.
5. Aktifkan Functions dan Hosting.
6. Pilih region yang konsisten dengan Functions, default proyek ini
   `asia-southeast2`.
7. Buat Firebase Web App dan catat web config.

Salin `.firebaserc.example` menjadi `.firebaserc`:

```json
{
  "projects": {
    "default": "project-id-anda"
  }
}
```

---

## 4. Install dan Test Lokal

```bash
npm install
npm --prefix firebase/functions install
npm run firebase:test:rules
npm run firebase:test:bootstrap
```

Test Rules memverifikasi:

- owner dapat membaca/menulis mindmap personal;
- outsider ditolak;
- shared editor diizinkan;
- editor grup dapat membuat dan menulis;
- anggota grup dapat membaca;
- outsider grup ditolak.

Test bootstrap memverifikasi:

- admin pertama mendapat custom claim;
- profil Firestore menjadi admin;
- retry akun yang sama idempotent;
- akun kedua ditolak oleh bootstrap lock.

Untuk menjalankan seluruh emulator:

```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run firebase:emulators
```

Hosting emulator menggunakan port `5002` karena port `5000` digunakan macOS
Control Center pada mesin development ini.

---

## 5. Deploy Backend

Deploy Rules, indexes, RTDB Rules, Functions, dan Hosting:

```bash
firebase use project-id-anda
firebase functions:secrets:set RESEND_API_KEY
npm run firebase:deploy
```

Untuk public-share URL absolut, set environment Functions:

```text
PUBLIC_BASE_URL=https://project-id-anda.web.app
```

Jangan menyimpan `RESEND_API_KEY` di Electron, source code, Docker Compose, atau
Firebase web config.

---

## 6. Konfigurasi Electron

Buat file berikut:

```text
{userData}/firebase-config.json
```

macOS:

```text
~/Library/Application Support/WAN Super App/firebase-config.json
```

Isi:

```json
{
  "apiKey": "...",
  "authDomain": "project-id.firebaseapp.com",
  "projectId": "project-id",
  "appId": "...",
  "databaseURL": "https://project-id-default-rtdb.firebaseio.com"
}
```

Firebase web config bukan private credential. Keamanan tetap dikontrol Auth,
Security Rules, dan Functions.

Tanpa file tersebut, WAN Mindmap berjalan local-only. Dengan config valid, label
status toolbar berubah menjadi `FIREBASE`.

---

## 7. Buat Admin Pertama

Akun admin lama tidak diperlukan.

1. Buka WAN Mindmap.
2. Pilih `Create account`.
3. Daftar menggunakan email baru yang masih dapat diakses.
4. Siapkan Application Default Credentials.
5. Jalankan bootstrap satu kali:

```bash
export FIREBASE_PROJECT_ID="project-id-anda"
export GOOGLE_APPLICATION_CREDENTIALS="/absolute/path/service-account.json"
npm run firebase:bootstrap-admin -- admin-baru@domain.com
```

Hasil yang diharapkan:

```json
{
  "ok": true,
  "email": "admin-baru@domain.com"
}
```

Logout lalu login kembali agar ID token mengambil custom claim `admin: true`.

### Bootstrap lock

Bootstrap menyimpan lock internal di:

```text
system/bootstrap
```

Client tidak dapat membaca atau menulis dokumen tersebut. Setelah admin pertama
aktif, email lain akan ditolak oleh bootstrap. Admin berikutnya dibuat melalui
panel admin yang memanggil Cloud Functions.

Jika proses terputus, menjalankan ulang email admin pertama aman dan idempotent.

---

## 8. Workflow Fresh Production

Urutan resmi:

```text
Create Firebase project
  -> Enable services
  -> Run emulator tests
  -> Deploy backend
  -> Install firebase-config.json
  -> Create new user account
  -> Bootstrap first admin
  -> Logout/login
  -> Create groups and users from admin panel
  -> Start using WAN Mindmap
```

Tidak ada langkah export/import MySQL.

---

## 9. Security Checklist

- [ ] Project Firebase baru digunakan.
- [ ] Email/Password Auth aktif.
- [ ] Firestore dan RTDB Rules berhasil dideploy.
- [ ] `npm run firebase:test:rules` lolos.
- [ ] `npm run firebase:test:bootstrap` lolos.
- [ ] Service-account JSON berada di luar repository.
- [ ] `RESEND_API_KEY` berada di Functions Secret.
- [ ] Admin pertama dibuat melalui bootstrap CLI.
- [ ] Bootstrap admin kedua ditolak.
- [ ] User telah logout/login ulang setelah promosi admin.
- [ ] Budget alert Firebase aktif.
- [ ] Public share diuji read-only.

---

## 10. Release Checklist

```bash
npm run typecheck
npm run build
npm audit --omit=dev --audit-level=high
PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run firebase:test:rules
PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run firebase:test:bootstrap
```

Kemudian:

```bash
npm run firebase:deploy
npm run dist
```

---

## 11. Reset Fresh Project

Untuk benar-benar mulai ulang, buat project Firebase baru dan ganti
`firebase-config.json`. Jangan mencoba menghapus semua data production melalui
renderer.

Project lama dapat dinonaktifkan setelah:

- project baru sudah dideploy;
- admin baru dapat login;
- Rules tests lolos;
- public share dan group permission tervalidasi;
- tidak ada user yang masih memakai project lama.

---

## 12. Definition of Done

Fresh setup selesai bila:

- WAN Mindmap terbuka sebagai modul keempat WAN Super App;
- Firebase config terdeteksi;
- akun baru dapat signup/login/reset password;
- admin pertama berhasil di-bootstrap satu kali;
- admin dapat membuat user berikutnya;
- CRUD mindmap personal berfungsi;
- workspace grup dan sharing mengikuti Rules;
- public share dapat dibuka dari Hosting;
- build, audit, Rules test, dan bootstrap test lolos;
- tidak ada ketergantungan runtime pada Docker atau MySQL.
