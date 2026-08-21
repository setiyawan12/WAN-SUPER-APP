# Handbook: WAN SSH Web Gateway

Panduan implementasi end-to-end untuk membuat WAN SSH dapat dipakai dari
browser melalui SSH gateway berbasis Node.js dan `ssh2`. Tahap pertama berjalan
sepenuhnya di komputer development menggunakan Docker. Image dan kontrak yang
sama kemudian dapat dipindahkan ke VPS tanpa menulis ulang terminal web.

> Status dokumen: **LOCAL MVP IMPLEMENTED**, `AUTH-SSH-01` **IMPLEMENTED / EMULATOR VERIFIED**,
> `SEC-SSH-01` **IMPLEMENTED / UNIT VERIFIED**, dan `OPS-SSH-01` **IMPLEMENTED / UNIT VERIFIED**;
> `HOSTKEY-SSH-01` **IMPLEMENTED / FIRESTORE EMULATOR VERIFIED**;
> live Firebase/Firestore, TLS/WSS, dan canary production tetap deployment gate.
>
> Checkpoint repository 2026-08-13:
>
> - mode desktop tetap memakai Electron preload/IPC dan seluruh 31 regression
>   test SSH desktop lulus;
> - transport terminal bersama, protocol WebSocket v1, gateway Node.js/`ssh2`,
>   web quick-connect, TOFU IndexedDB, Docker images, same-origin Nginx proxy,
>   fixture OpenSSH, dan wrapper local stack sudah tersedia;
> - `npm run ssh-web:up` mempublikasikan hanya `127.0.0.1:5179`, sedangkan
>   gateway dan fixture tetap internal pada Docker network;
> - `npm run qa:ssh-web` lulus: gateway unit/integration, desktop 31 test, real SSH E2E
>   dengan private key dan password, browser/mobile E2E, Compose/container
>   policy, credential/image scan, dan audit dependency tanpa High/Critical;
>   gate selalu membersihkan container serta credential fixture temporary;
> - Firebase Web Auth, ID-token WebSocket auth/refresh, Admin SDK verification,
>   server-owned expiry, same-UID enforcement, auth-failure session cleanup, dan
>   logout cleanup tersedia. `npm run test:ssh-web:firebase` lulus terhadap Auth
>   Emulator untuk browser login serta token invalid, wrong-project, expired,
>   revoked, dan disabled;
> - trusted-proxy identity, spoofed `X-Forwarded-For` isolation, connect rate
>   limit, target port policy, forbidden/allowlist egress, dan preconnected
>   `ssh2` socket ke IP yang sudah diperiksa sudah diuji di repository;
> - `/metrics`, reconnect socket setelah close `1012`, Caddy/WSS example, dan
>   runbook rollback/incident tersedia di repository;
> - durable tenant-scoped known-host store berbasis Firestore Admin SDK,
>   authoritative lookup, normalized identity, transactional compare-and-set,
>   immutable audit entry, dan deny-all direct-client Security Rules tersedia.
>   Firestore Emulator membuktikan persistence, tenant isolation, race conflict,
>   audit continuity, dan penolakan direct-client read/write;
> - live Firebase project/ADC/Firestore validation, production egress allowlist operator flow, live TLS/WSS
>   deployment, canary, rollback rehearsal, dan public deployment belum selesai.

Dokumen menggunakan empat label:

| Label | Arti |
|-------|------|
| `CURRENT` | Sudah ada dan digunakan oleh aplikasi Electron |
| `LOCAL MVP` | Wajib agar web dan gateway berjalan lokal melalui Docker |
| `PRODUCTION` | Wajib sebelum gateway dapat dibuka melalui internet |
| `NEXT` | Fitur lanjutan setelah terminal remote stabil |

Prinsip selesai:

- UI yang dapat dibuild belum berarti SSH web sudah berfungsi;
- local MVP belum berarti aman untuk dipublikasikan;
- private key, passphrase, password, dan auth answer bersifat ephemeral: tidak
  boleh dipersist ke image, volume, database, log, browser storage, crash
  report, atau analytics; pembersihan
  memory JavaScript/Node hanya best-effort dan tidak boleh diklaim sebagai
  secure erasure;
- mode Electron yang sudah ada tidak boleh rusak;
- task belum `done` jika acceptance test dan rollback terkait belum tersedia;
- tidak ada deploy publik dengan autentikasi development, host-key verification
  yang dimatikan, atau vulnerability High/Critical terbuka.

---

## 1. Keputusan Utama

Target produk memiliki dua runtime SSH yang memakai UI terminal bersama:

```text
WAN SSH
|-- Desktop
|   |-- React + xterm.js
|   |-- Electron preload + IPC
|   |-- ssh2 dan node-pty pada Electron main
|   `-- key, vault, filesystem, tunnel, dan local shell pada device
|
`-- Web
    |-- React + xterm.js
    |-- HTTPS + WebSocket
    |-- WAN SSH Gateway Node.js + ssh2
    `-- koneksi TCP port 22 dibuat oleh gateway
```

Keputusan yang wajib dipertahankan:

1. Browser tidak mencoba membuka TCP port 22 secara langsung.
2. Electron IPC tidak dipublikasikan ke jaringan.
3. Gateway dibuat sebagai service baru di `services/wan-ssh-gateway`.
4. Local MVP memakai Docker dan hanya dipublikasikan ke
   `127.0.0.1:5179` pada host development.
5. Web dan gateway lokal memakai origin yang sama melalui reverse proxy.
6. Pengguna memilih private key atau password untuk setiap sesi. Credential
  diproses sementara di memory browser/gateway, tidak dipersist, dan seluruh
  reference aplikasi dibuang secepat mungkin setelah request autentikasi.
7. Browser tidak membaca `~/.ssh` secara otomatis dan gateway tidak me-mount
   direktori `~/.ssh` milik host.
8. Host-key verification selalu aktif. Tidak ada mode `accept all`.
9. Runtime web MVP tidak berpura-pura mendukung local shell, local port
   forwarding, OS keychain, biometric, atau SSH agent lokal.
10. Firebase Auth dan TLS tidak wajib untuk local MVP, tetapi wajib sebelum
    gateway dibuka ke internet.
11. Protokol browser-gateway dibuat stabil dan terversi agar Docker lokal dan
    VPS menggunakan client yang sama.
12. Deploy awal VPS tetap modular monolith satu instance. Multi-instance baru
    dipertimbangkan setelah session lifecycle dan observability stabil.

Jawaban arsitektural akhirnya:

```text
Web murni tanpa komponen perantara     : tidak dapat menjalankan SSH port 22
Web + Docker gateway lokal             : dapat, untuk development
Web + gateway pada VPS                 : dapat, untuk akses web production
Web + local agent terinstal             : opsi lain, bukan scope handbook ini
```

---

## 2. Kondisi Repository Saat Ini (`CURRENT`)

### 2.1 Alur desktop

```mermaid
flowchart LR
    UI[React dan xterm.js] --> API[window.api]
    API --> Preload[Electron preload]
    Preload --> IPC[Electron IPC]
    IPC --> Context[AppContext]
    Context --> SSH[SshManager dan ssh2]
    Context --> Native[node-pty, fs, net, safeStorage]
    SSH --> Target[SSH target port 22]
```

Titik pemilik perilaku:

| Lokasi | Tanggung jawab saat ini |
|--------|--------------------------|
| `modules/ssh/ui/src/App.tsx` | Workspace, host, sesi, split pane, transfer, tunnel, recording |
| `modules/ssh/ui/src/TerminalPane.tsx` | xterm.js, input, output, resize, clipboard, search |
| `modules/ssh/ui/src/api.ts` | Memilih preload API atau mock development |
| `modules/ssh/preload/index.js` | Mengekspos namespace API Electron yang dibatasi |
| `modules/ssh/src/main/ipc.ts` | Validasi dan pemetaan IPC ke service |
| `modules/ssh/src/main/context.ts` | Membuat seluruh service runtime desktop |
| `modules/ssh/src/main/ssh.ts` | SSH, PTY remote, jump host, auth, reconnect |
| `modules/ssh/src/main/transfer.ts` | SFTP dan transfer file terhadap filesystem desktop |
| `modules/ssh/src/main/tunnels.ts` | Local, remote, dan dynamic forwarding |
| `modules/ssh/src/main/local.ts` | Shell lokal melalui `node-pty` |
| `modules/ssh/src/main/store.ts` | JSON store satu instalasi Electron |
| `modules/ssh/src/main/keychain.ts` | Electron `safeStorage` dan file vault key |
| `modules/ssh/src/main/firebase.ts` | Firebase desktop auth dan RTDB sync |

### 2.2 Mengapa bundle sekarang belum menjadi web SSH

Dalam production, `modules/ssh/ui/src/api.ts` menganggap bridge gagal bila
`window.api` tidak tersedia. Pada Vite development, file tersebut memakai data
mock. Karena itu membuka renderer di browser dapat terlihat berfungsi tanpa
pernah membuat koneksi SSH nyata.

Browser juga tidak menyediakan raw TCP socket untuk protokol SSH. Memilih
private key dari file picker hanya memberi akses ke key; hal itu tidak memberi
browser kemampuan membuat koneksi ke `host:22`.

### 2.3 Bagian yang dapat digunakan ulang

- komponen React dan styling;
- xterm.js beserta addon fit, search, Unicode, dan WebGL;
- bentuk event terminal: output, exit, state, auth prompt, host-key prompt;
- schema dan error taxonomy yang tidak bergantung Electron;
- sebagian besar `SshSession` dan `SshManager` setelah dependency storage dan
  event emitter dipisahkan;
- SFTP setelah sumber/tujuan file diubah menjadi stream browser;
- recording setelah save dialog diganti browser download.

Bagian yang tidak boleh dipakai langsung pada gateway publik:

- singleton `runtime.ctx`;
- JSON store global satu file;
- pemeriksaan trusted Electron `webContents`;
- Electron dialog, `safeStorage`, `app.getPath`, dan `shell.openExternal`;
- `node-pty` untuk memberikan shell gateway kepada pengguna web;
- local dan dynamic forwarding tanpa definisi jaringan yang baru.

---

## 3. Tujuan dan Bukan Tujuan

### 3.1 Tujuan `LOCAL MVP`

- Setelah Node/npm dependency awal terpasang, seluruh setup fixture, build, dan
  Docker Compose dapat dijalankan melalui satu root command
  `npm run ssh-web:up`.
- Browser membuka WAN SSH melalui `http://127.0.0.1:5179`.
- UI mendeteksi status gateway.
- Pengguna mengisi host, port, dan username.
- Pengguna memilih private key lokal dan memasukkan passphrase bila diperlukan.
- Browser membuka WebSocket ke gateway melalui same-origin reverse proxy.
- Gateway membuat koneksi `ssh2` ke target.
- Pengguna harus menerima atau menolak fingerprint host yang belum dikenal.
- Input, output, resize, close, error, dan idle timeout berfungsi.
- Private key tidak dipersist; reference aplikasi dibersihkan best-effort
  setelah autentikasi gagal/berhasil dan setelah sesi selesai.
- Ada fixture SSH deterministik untuk automated test.
- Mode Electron dan seluruh test SSH desktop tetap lulus.

### 3.2 Tujuan `PRODUCTION`

- Frontend dapat dihosting di Firebase Hosting atau di reverse proxy VPS.
- Gateway hanya dapat diakses melalui HTTPS/WSS.
- Firebase ID token diverifikasi oleh gateway.
- Setiap socket dan `sessionId` terikat kepada satu `uid`.
- Ada rate limit, session limit, egress policy, audit metadata, metrics, dan
  graceful shutdown.
- Origin frontend adalah exact allowlist.
- Deployment, health check, backup metadata, rollback, dan incident runbook
  tersedia.

### 3.3 Bukan tujuan `LOCAL MVP`

- Menyimpan private key di cloud.
- Membaca `~/.ssh` tanpa interaksi pengguna.
- Menggunakan local `ssh-agent` atau hardware/FIDO key.
- Local shell komputer pengguna.
- Local atau SOCKS port forwarding pada komputer pengguna.
- SFTP, upload/download, tunnel, recording, dan split pane penuh.
- Multi-instance gateway.
- Session resume setelah container atau gateway restart.
- Menjalankan arbitrary command tanpa sesi terminal interaktif.

Fitur tersebut berada pada fase `NEXT`; sebagian membutuhkan local agent dan
tidak akan mempunyai arti yang sama pada gateway cloud.

---

## 4. Arsitektur Target

### 4.1 Local Docker

```mermaid
flowchart LR
    Browser[Browser 127.0.0.1:5179] --> Proxy[Web container dan reverse proxy]
    Proxy -->|Static files| UI[React dan xterm.js]
    Proxy -->|WebSocket /v1/ws| Gateway[WAN SSH Gateway container]
    Gateway -->|TCP port 22| Remote[SSH target LAN atau internet]
    Gateway -->|Docker network| Fixture[SSH fixture untuk test]
```

Hanya web container yang mempublikasikan port ke host:

```text
127.0.0.1:5179 -> web:8080
gateway:8788   -> hanya Docker network, tidak dipublish ke host
ssh-target:22  -> hanya Docker network, profile test
```

Keuntungan same-origin:

- browser memakai `ws://127.0.0.1:5179/v1/ws`;
- tidak ada CORS untuk local MVP;
- gateway tetap memeriksa header `Origin`;
- bentuk routing hampir sama dengan reverse proxy production;
- tidak perlu sertifikat lokal pada tahap awal.

### 4.2 Production pada VPS

```mermaid
flowchart TB
    Browser[Browser] -->|HTTPS| Edge[Caddy atau Nginx]
    Edge -->|Static web| Web[WAN SSH Web]
    Edge -->|WSS /v1/ws| Gateway[WAN SSH Gateway]
    Browser -->|Login| Firebase[Firebase Authentication]
    Gateway -->|Verify ID token| FirebaseAdmin[Firebase Admin SDK]
    Gateway -->|TCP 22| Targets[SSH targets]
    Gateway --> Metadata[(PostgreSQL metadata, NEXT)]
```

Deployment paling sederhana memakai satu domain:

```text
https://ssh.example.com/       -> static frontend
wss://ssh.example.com/v1/ws   -> gateway
https://ssh.example.com/healthz -> gateway health melalui reverse proxy
```

Firebase Hosting juga dapat dipakai:

```text
https://ssh-web.example.com        -> Firebase Hosting
wss://ssh-api.example.com/v1/ws    -> VPS gateway
```

Pada bentuk dua domain, gateway harus mengizinkan origin frontend secara exact
dan frontend harus menerima WebSocket URL dari build/runtime configuration.

### 4.3 Trust boundary

| Boundary | Data yang lewat | Kontrol minimum |
|----------|-----------------|-----------------|
| Browser ke web server | HTML, JS, CSS | CSP, immutable assets, no secret in bundle |
| Browser ke gateway | Token, target, key sementara, terminal I/O | WSS, auth, origin, size limit |
| Gateway ke SSH target | SSH handshake dan terminal | Host-key verification, timeout, egress policy |
| Gateway memory | Credential dan session state | Short lifetime, bounded sessions, no dump/log |
| Gateway ke Firebase | ID-token verification | Admin SDK, project/audience validation |

Catatan keamanan penting:

- Pada Docker lokal, key berpindah dari browser ke container pada device yang
  sama.
- Pada VPS, key berpindah ke RAM server yang dikelola operator. Pengguna harus
  diberi penjelasan eksplisit tentang trust model ini.
- Browser-side SSH signing agar key tidak pernah keluar device adalah desain
  lanjutan, bukan bagian local MVP.

---

## 5. Runtime dan Feature Matrix

| Fitur | Electron `CURRENT` | Web `LOCAL MVP` | Web `PRODUCTION` | `NEXT` |
|-------|--------------------|-----------------|------------------|--------|
| Remote SSH terminal | Ya | Ya | Ya | - |
| Key dari file lokal | Import ke vault | Ephemeral, tidak dipersist | Ephemeral pada gateway | Browser-side signing |
| Password auth | Ya | Ya, ephemeral | Ya, sesuai policy | Policy per workspace |
| Host-key prompt | Ya | Ya | Ya | Shared policy |
| Keyboard-interactive | Ya | Ya bila protocol selesai | Ya | WebAuthn mapping |
| Host catalog | Ya | Browser profile nonsecret | API tenant | Shared teams |
| Split pane | Ya | Setelah terminal tunggal | Ya | Session restore |
| SFTP | Ya | Tidak | Tidak pada rilis pertama | Streaming browser |
| Recording | Ya | Tidak | Tidak pada rilis pertama | Browser Blob download |
| Remote forwarding | Ya | Tidak | Policy khusus | Terbatas |
| Local/SOCKS forwarding | Ya | Tidak bermakna pada browser | Tidak | Local agent |
| Local shell | Ya | Tidak | Tidak | Local agent |
| SSH agent forwarding | Ya | Tidak | Tidak | Local agent/browser signing |
| OS biometric | Ya | Tidak | Tidak | WebAuthn untuk web vault |
| Firebase sync | Ya | Tidak wajib | Auth wajib | Metadata sync |

UI harus menggunakan capability, bukan menampilkan tombol yang selalu gagal.

Target capability minimum:

```ts
export interface SshRuntimeCapabilities {
  runtime: "electron" | "web-local" | "web-cloud" | "mock";
  remoteTerminal: boolean;
  hostProfiles: boolean;
  localShell: boolean;
  sftp: boolean;
  tunnels: boolean;
  recording: boolean;
  biometric: boolean;
  openSshImport: boolean;
  firebaseSync: boolean;
}
```

---

## 6. Model Credential dan SSH Key

### 6.1 Pilihan `LOCAL MVP`

Alur private-key:

```text
User gesture
  -> browser file picker
  -> File.arrayBuffer()
  -> batas ukuran dan format dasar
  -> session.open melalui WebSocket
  -> gateway membuat Buffer bounded dan parser `ssh2` membuat state internal
  -> ssh2.connect()
  -> Buffer aplikasi di-overwrite best-effort setelah ready/gagal
  -> seluruh credential reference aplikasi dibuang
```

Alur password:

```text
Form password
  -> session.open melalui WebSocket
  -> gateway meneruskan credential sementara ke ssh2.connect()
  -> field browser dan reference aplikasi dibersihkan setelah request dikirim
  -> seluruh reference sesi dibuang setelah ready/gagal/close
```

Aturan implementasi:

1. File picker hanya dibuka dari klik pengguna.
2. Jangan mengandalkan ekstensi file karena private key sering tidak mempunyai
   ekstensi.
3. Batas default private key: 256 KiB.
4. Key tidak ditempatkan pada React global state, Redux, URL, query parameter,
   `localStorage`, `sessionStorage`, IndexedDB, service worker, atau telemetry.
5. Passphrase/password hanya berada pada state form sampai request dikirim,
  lalu field dibersihkan.
6. Gateway mengubah key menjadi `Buffer` bounded secepat mungkin dan melakukan
  best-effort overwrite dengan `fill(0)` pada Buffer yang dimilikinya.
7. WebSocket parsing, JSON encoding, JavaScript string, Buffer internal, dan
  parser `ssh2` dapat membuat salinan yang tidak dapat dihapus secara
  deterministik. Karena itu istilah `secure erase` atau `key hanya ada satu
  kali di RAM` dilarang; scope dan lifetime dibuat sesingkat mungkin.
8. Error tidak boleh mengembalikan potongan key atau object konfigurasi `ssh2`.
9. Gateway tidak pernah mengirim credential kembali ke browser.
10. Key/password pengguna tidak pernah ditulis ke filesystem, termasuk `/tmp`.

### 6.2 Yang dilarang

- mount `~/.ssh` ke container gateway;
- memasukkan private key ke Docker build context;
- environment variable berisi private key pengguna;
- menyimpan key pada Firebase, PostgreSQL, volume, log, Sentry, atau audit;
- menyimpan password atau auth answer pada browser storage, database, log,
  telemetry, environment, atau filesystem;
- mengirim key melalui URL atau WebSocket subprotocol;
- menonaktifkan host verifier;
- memakai key fixture untuk server nyata.

### 6.3 Host-key trust on first use

Local MVP menyimpan fingerprint, bukan private credential, di IndexedDB browser.

Alur:

1. Browser mencari fingerprint lama berdasarkan `host:port`.
2. `session.open` mengirim `expectedHostKeyFingerprint` bila ada.
3. Gateway menghitung fingerprint key yang diberikan target.
4. Bila cocok, koneksi dilanjutkan.
5. Bila belum ada, gateway mengirim `hostkey.prompt`.
6. Bila berbeda, gateway mengirim prompt dengan `previousFingerprint` dan
   `observedFingerprint` serta menandainya sebagai `changed`.
7. Hanya jawaban eksplisit pengguna yang dapat melanjutkan.
8. Jawaban accept disimpan browser untuk koneksi berikutnya.

Production **wajib** memindahkan known-host record ke durable storage yang
tenant-scoped dan mempunyai audit perubahan. Public release tidak boleh
bergantung hanya pada IndexedDB karena browser/profile baru akan mereset TOFU
dan menghilangkan deteksi perubahan lintas device. Storage production hanya
menyimpan host identity, algorithm, fingerprint, timestamps, dan actor; tidak
menyimpan private key.

Pada production, langkah 1-2 di atas hanya berlaku sebagai hint UI dan **bukan
authority**. Setelah principal diverifikasi, gateway wajib melakukan lookup
authoritative berdasarkan `(tenantId, normalizedHost, port)` pada durable
known-host store. Nilai `expectedHostKeyFingerprint` dari client diabaikan atau
harus cocok dengan record server; client tidak dapat menghapus/mengganti nilai
tersebut untuk menurunkan status `changed` menjadi `unknown`. Accept unknown atau
changed key dilakukan sebagai compare-and-set transaction yang menulis
fingerprint baru beserta actor/audit sebelum koneksi dianggap trusted. Race dua
browser tidak boleh saling overwrite tanpa conflict handling.

Implementasi awal boleh memakai Firebase RTDB/Firestore melalui Admin SDK atau
PostgreSQL. Pada Firebase, path known-host harus ditutup dari direct client
write oleh Security Rules; browser mengaksesnya melalui gateway. Bila memakai
PostgreSQL, migration, tenant isolation, backup/restore rehearsal, dan rollback
menjadi gate tambahan.

### 6.4 Pilihan lanjutan

| Model | Key keluar device | Kompleksitas | Rekomendasi |
|-------|-------------------|-------------|-------------|
| Key ephemeral pada gateway | Ya pada cloud | Rendah | MVP |
| Encrypted cloud vault | Ya, tersimpan terenkripsi | Sedang-tinggi | Setelah KMS tersedia |
| Browser-side signing | Tidak | Tinggi | Target keamanan lanjut |
| Local agent dan ssh-agent | Tidak | Sedang-tinggi | Untuk LAN/FIDO/local tunnel |

---

## 7. Struktur Repository Target

```text
modules/ssh/
|-- ui/
|   `-- src/
|       |-- api.ts                    # runtime selector
|       |-- transport/
|       |   |-- contract.ts
|       |   |-- electron.ts
|       |   |-- web-socket.ts
|       |   `-- mock.ts
|       |-- WebApp.tsx                # local MVP quick-connect shell
|       |-- WebConnectDialog.tsx
|       |-- TerminalPane.tsx
|       |-- web-profile-store.ts      # nonsecret only
|       `-- capabilities.ts
`-- HANDBOOK-WAN-SSH-WEB-GATEWAY.md

services/wan-ssh-gateway/
|-- package.json
|-- package-lock.json
|-- tsconfig.json
|-- .dockerignore
|-- .env.local.example
|-- Dockerfile
|-- docker-compose.local.yml
|-- docker/
|   |-- web.Dockerfile
|   |-- nginx.local.conf
|   `-- ssh-target/
|       |-- Dockerfile
|       `-- entrypoint.sh
|-- src/
|   |-- server.ts
|   |-- app.ts
|   |-- config.ts
|   |-- protocol.ts
|   |-- errors.ts
|   |-- auth/
|   |   |-- principal.ts
|   |   |-- dev.ts
|   |   `-- firebase.ts
|   |-- websocket/
|   |   |-- upgrade.ts
|   |   |-- connection.ts
|   |   `-- send.ts
|   |-- sessions/
|   |   |-- manager.ts
|   |   |-- ssh-session.ts
|   |   |-- host-key.ts
|   |   `-- target-policy.ts
|   |-- observability/
|   |   |-- logger.ts
|   |   `-- metrics.ts
|   `-- security/
|       |-- origin.ts
|       |-- limits.ts
|       `-- redact.ts
|-- test/
|   |-- protocol.test.ts
|   |-- auth.test.ts
|   |-- ownership.test.ts
|   |-- ssh-session.test.ts
|   `-- websocket.test.ts
`-- scripts/
  |-- local-stack.mjs
  |-- create-fixture-key.mjs
  `-- qa-verify.mjs

firebase/hosting/ssh/
`-- hasil build web, tidak diedit manual

vite.config.ssh-web.ts
.dockerignore                         # context web dari root repository
```

Aturan ownership:

- `modules/ssh/src/main/*` tetap pemilik runtime Electron.
- Gateway tidak mengimpor `ipc.ts`, `window.ts`, `store.ts`, `keychain.ts`, atau
  `local.ts`.
- Pure schema, error code, dan utility SSH boleh dipindahkan ke shared package
  setelah ada test yang membuktikan desktop tetap berjalan.
- Jangan membuat symlink atau runtime import dari output build
  `modules/ssh/main/*`.
- Web build mempunyai output terpisah dari renderer Electron agar hosting tidak
  menyalin preload assumption secara tidak sengaja.

---

## 8. Kontrak Transport UI

### 8.1 Prinsip migrasi

Perubahan pertama pada UI harus mempertahankan perilaku Electron. Jangan
langsung mengganti seluruh `window.api`.

Target interface terminal minimum:

```ts
export type SshTransportEvent =
  | { type: "session.state"; sessionId: string; state: string; reason?: string; message?: string }
  | { type: "session.output"; sessionId: string; data: string }
  | { type: "session.exit"; sessionId: string; code: number; reason: string; message?: string }
  | { type: "hostkey.prompt"; sessionId: string; kind: "unknown" | "changed"; host: string; port: number; algorithm: string; fingerprint: string; previousFingerprint?: string }
  | { type: "auth.prompt"; sessionId: string; prompts: Array<{ prompt: string; echo: boolean }> };

export interface RemoteTerminalTransport {
  readonly capabilities: SshRuntimeCapabilities;
  health(): Promise<{ ok: boolean; version: string; protocolVersion: 1 }>;
  open(input: WebSessionOpenInput): Promise<{ sessionId: string }>;
  write(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  answerHostKey(sessionId: string, accept: boolean): void;
  answerAuthPrompt(sessionId: string, answers: string[]): void;
  close(sessionId: string): Promise<void>;
  onEvent(listener: (event: SshTransportEvent) => void): () => void;
  dispose(): void;
}
```

Implementasi:

```text
ElectronRemoteTerminalTransport
  -> wrapper tipis window.api.session dan window.api.on

WebSocketRemoteTerminalTransport
  -> /v1/ws
  -> request correlation
  -> reconnect socket, bukan resume sesi pada MVP

MockRemoteTerminalTransport
  -> hanya saat VITE_SSH_MOCK=true
```

Mock tidak boleh otomatis aktif hanya karena preload hilang. Web production yang
salah konfigurasi harus menampilkan gateway unavailable, bukan data demo.

### 8.2 Pemilihan runtime

Urutan eksplisit:

```text
window.api tersedia                 -> electron
VITE_WAN_SSH_RUNTIME=web            -> web-local atau web-cloud
VITE_SSH_MOCK=true                  -> mock
selain itu                          -> configuration error
```

`WebApp.tsx` pada local MVP hanya membutuhkan quick connect, satu atau beberapa
terminal remote, host-key dialog, auth dialog, status gateway, dan close.
Workspace desktop tetap memakai `App.tsx`. Komponen dapat digabung bertahap
setelah kontrak transport stabil.

---

## 9. Protokol WebSocket Versi 1

### 9.1 Endpoint

```text
GET /healthz       health proses, tidak membuka detail sensitif
GET /readyz        readiness setelah konfigurasi valid
GET /runtime-config.json public client-safe mode dan protocol configuration
WS  /v1/ws         control dan terminal stream
```

Response health minimum:

```json
{
  "ok": true,
  "service": "wan-ssh-gateway",
  "version": "0.1.0",
  "protocolVersion": 1
}
```

Jangan menampilkan environment, allowed origins, target policy, session count
per user, token, filesystem path, atau stack trace pada health response.

Runtime config minimum:

```json
{
  "service": "wan-ssh-gateway",
  "protocolVersion": 1,
  "authMode": "dev-anonymous"
}
```

Nilai `authMode` hanya `dev-anonymous` atau `firebase`; response tidak memuat
token, project secret, allowlist, atau internal address. Web membaca endpoint
same-origin ini sebelum membuka socket.

### 9.2 Handshake

Browser WebSocket API tidak dapat menambahkan `Authorization` header bebas.
Token tidak boleh diletakkan pada URL. Gunakan frame autentikasi pertama.

Firebase mode:

```json
{
  "type": "auth",
  "requestId": "5e1bbfc4-63b0-42f1-8e14-d79d8fd97b95",
  "protocolVersion": 1,
  "mode": "firebase",
  "token": "firebase-id-token"
}
```

Local `dev-anonymous` mode:

```json
{
  "type": "auth",
  "requestId": "5e1bbfc4-63b0-42f1-8e14-d79d8fd97b95",
  "protocolVersion": 1,
  "mode": "dev-anonymous"
}
```

`dev-anonymous` tidak menerbitkan atau memverifikasi token. Mode ini hanya dapat
aktif ketika seluruh startup guard local terpenuhi: environment development,
origin exact loopback, gateway tidak dipublish ke host, dan request datang
melalui web reverse proxy lokal. Principal deterministik adalah
`development:local-browser`; seluruh browser lokal berbagi principal tersebut,
sehingga mode ini tidak boleh dipakai lintas pengguna atau jaringan.

Aturan:

1. HTTP upgrade ditolak sebelum socket dibuat bila `Origin` tidak diizinkan.
2. Setelah upgrade, client harus mengirim `auth` dalam 5 detik.
3. Frame selain `auth` sebelum autentikasi menutup socket.
4. Mode frame harus sama dengan runtime config. Firebase token diverifikasi;
  `dev-anonymous` hanya melewati startup/origin guard lokal. Keduanya
  menghasilkan `Principal` server-side.
5. Raw Firebase token dibuang dan tidak disimpan pada connection context.
6. Server mengirim `auth.ok` dengan principal-safe metadata.
7. Untuk Firebase, server memasang expiry timer berdasarkan claim `exp` yang
  sudah diverifikasi; timer ini tidak bergantung pada kejujuran client.
8. Client mengirim `auth.refresh` sebelum deadline server. Refresh harus
  menghasilkan UID yang sama; perubahan UID menutup seluruh sesi socket.
9. Bila refresh valid belum diterima sebelum expiry, server menutup socket dan
  seluruh sesinya dengan code `4401`, walaupun terminal masih aktif.
10. Kebijakan revocation harus eksplisit: production memverifikasi token refresh
   dengan `checkRevoked` dan membatasi interval sampai status disabled/revoked
   diperiksa lagi.

Response:

```json
{
  "type": "auth.ok",
  "requestId": "5e1bbfc4-63b0-42f1-8e14-d79d8fd97b95",
  "protocolVersion": 1,
  "principal": { "kind": "firebase", "uid": "uid-safe-to-return" },
  "expiresAt": 1786600000000
}
```

Pada `dev-anonymous`, response memakai principal
`{ "kind": "development", "uid": "local-browser" }` dan tidak mempunyai
`expiresAt` atau flow `auth.refresh`.

Refresh request dan response:

```json
{
  "type": "auth.refresh",
  "requestId": "86db0268-ae2a-4dc8-9891-f08f094a7990",
  "token": "fresh-firebase-id-token"
}
```

```json
{
  "type": "auth.refreshed",
  "requestId": "86db0268-ae2a-4dc8-9891-f08f094a7990",
  "expiresAt": 1786603600000
}
```

`auth.refresh` tidak boleh membuka grace period tak terbatas. Token invalid,
expired, revoked, disabled, berbeda UID, atau datang setelah deadline menutup
socket dan seluruh session.

### 9.3 Membuka sesi

```json
{
  "type": "session.open",
  "requestId": "51bf5d23-0dbf-45b1-9cde-592c330469ae",
  "target": {
    "host": "server.example.com",
    "port": 22,
    "username": "deploy"
  },
  "terminal": {
    "cols": 100,
    "rows": 32,
    "term": "xterm-256color"
  },
  "authentication": {
    "method": "privateKey",
    "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\n...",
    "passphrase": "optional"
  },
  "expectedHostKeyFingerprint": "SHA256:localMvpHintOnly"
}
```

Aturan schema:

- `requestId`: UUID;
- `host`: hostname atau IP, panjang maksimum 253;
- `port`: integer 1 sampai 65535;
- `username`: 1 sampai 128 karakter, tanpa control character;
- `cols` dan `rows`: integer 1 sampai 1000;
- hanya satu metode autentikasi per request;
- private key maksimum 256 KiB;
- passphrase/password maksimum 4096 karakter;
- total frame default maksimum 512 KiB;
- unknown property ditolak pada security-sensitive message;
- `expectedHostKeyFingerprint` hanya authoritative pada local MVP. Production
  selalu memakai tenant-scoped server record dan tidak mengizinkan payload
  client menghapus atau menggantinya.

Server membuat `sessionId`; client tidak boleh memilihnya.

```json
{
  "type": "session.opened",
  "requestId": "51bf5d23-0dbf-45b1-9cde-592c330469ae",
  "sessionId": "4299a3a9-38bf-485b-9648-c343c861f9b6"
}
```

`session.opened` berarti record sesi sudah dibuat, bukan berarti SSH sudah
connected. Status berikutnya dikirim sebagai event.

Alternatif password memakai target/terminal yang sama dan authentication union:

```json
{
  "authentication": {
    "method": "password",
    "password": "session-only"
  }
}
```

### 9.4 State dan output

```json
{ "type": "session.state", "sessionId": "...", "state": "connecting" }
{ "type": "session.state", "sessionId": "...", "state": "authenticating" }
{ "type": "session.state", "sessionId": "...", "state": "connected" }
{ "type": "session.output", "sessionId": "...", "data": "Linux ...\r\n" }
{ "type": "session.exit", "sessionId": "...", "code": 0, "reason": "remote-closed" }
```

MVP boleh memakai JSON string untuk output. Setelah profiling, binary frame dapat
ditambahkan pada protocol version baru atau capability negotiation; jangan
mengubah arti frame versi 1 diam-diam.

### 9.5 Input, resize, dan close

```json
{ "type": "session.input", "sessionId": "...", "data": "ls -la\r" }
{ "type": "session.resize", "sessionId": "...", "cols": 120, "rows": 36 }
{ "type": "session.close", "requestId": "...", "sessionId": "..." }
```

Input terminal dibatasi per frame, default 64 KiB. Server menyentuh idle timer
pada input, resize, auth answer, dan output aktivitas yang relevan.

### 9.6 Host-key prompt

```json
{
  "type": "hostkey.prompt",
  "sessionId": "...",
  "kind": "unknown",
  "host": "server.example.com",
  "port": 22,
  "algorithm": "ssh-ed25519",
  "fingerprint": "SHA256:..."
}
```

Jawaban:

```json
{
  "type": "hostkey.answer",
  "requestId": "...",
  "sessionId": "...",
  "accept": true
}
```

Prompt memiliki timeout, default 60 detik. Timeout sama dengan reject.

### 9.7 Keyboard-interactive

```json
{
  "type": "auth.prompt",
  "sessionId": "...",
  "prompts": [
    { "prompt": "Verification code: ", "echo": false }
  ]
}
```

```json
{
  "type": "auth.answer",
  "requestId": "...",
  "sessionId": "...",
  "answers": ["123456"]
}
```

Jawaban tidak boleh dicatat. Jumlah dan panjang jawaban harus dibatasi.

### 9.8 Error envelope

```json
{
  "type": "error",
  "requestId": "optional",
  "sessionId": "optional",
  "code": "SSH_AUTH_FAILED",
  "message": "Authentication failed",
  "retryable": false
}
```

Error code minimum:

| Code | Arti |
|------|------|
| `AUTH_REQUIRED` | Socket belum terautentikasi |
| `AUTH_INVALID` | Token ditolak |
| `ORIGIN_DENIED` | Origin tidak diizinkan |
| `PROTOCOL_UNSUPPORTED` | Versi protocol tidak cocok |
| `MESSAGE_INVALID` | Schema atau ukuran message salah |
| `SESSION_NOT_FOUND` | Session tidak ada atau bukan milik principal |
| `SESSION_LIMIT` | Batas sesi tercapai |
| `RATE_LIMIT` | Batas koneksi/upgrade tercapai |
| `TARGET_DENIED` | Target ditolak egress policy |
| `SSH_TIMEOUT` | Connect atau handshake timeout |
| `SSH_AUTH_FAILED` | SSH authentication gagal |
| `SSH_HOST_KEY_REJECTED` | Fingerprint ditolak atau berubah |
| `SSH_CONNECTION_FAILED` | Network/transport SSH gagal |
| `BACKPRESSURE_LIMIT` | Client terlalu lambat |
| `IDLE_TIMEOUT` | Sesi tidak aktif terlalu lama |
| `INTERNAL` | Error internal yang sudah dinormalisasi |

Stack trace hanya berada pada log internal development dan tidak dikirim ke
browser.

### 9.9 Close code

Gunakan close code aplikasi secara konsisten, misalnya:

| Code | Kondisi |
|------|---------|
| `4400` | Message/protocol invalid |
| `4401` | Authentication invalid/expired |
| `4403` | Origin atau policy denied |
| `4408` | Authentication timeout |
| `4429` | Rate/session limit |
| `4500` | Internal fatal error |
| `1012` | Gateway restart/service restart |

---

## 10. Implementasi Gateway

### 10.1 Dependency target

`services/wan-ssh-gateway/package.json` minimum:

```text
runtime:
  express
  ws
  ssh2
  zod
  firebase-admin       # production auth; boleh lazy-load

development:
  typescript
  @types/node
  @types/express
  @types/ws
  @types/ssh2
```

Jangan menambahkan database, Redis, queue, atau framework RPC pada local MVP.

### 10.2 Konfigurasi

Semua konfigurasi dibaca dan divalidasi sekali saat startup:

| Variable | Local default | Production requirement |
|----------|---------------|------------------------|
| `WAN_SSH_ENV` | `development` | `production` |
| `WAN_SSH_BIND_HOST` | `0.0.0.0` di dalam container | `0.0.0.0` internal container |
| `WAN_SSH_PORT` | `8788` | `8788` internal |
| `WAN_SSH_AUTH_MODE` | `dev-anonymous` | `firebase` |
| `WAN_SSH_FIREBASE_PROJECT_ID` | kosong | wajib untuk Firebase |
| `WAN_SSH_ALLOWED_ORIGINS` | `http://127.0.0.1:5179` | exact HTTPS origins |
| `WAN_SSH_MAX_SESSIONS_PER_USER` | `3` | ditinjau berdasarkan kapasitas |
| `WAN_SSH_MAX_SESSIONS_TOTAL` | `20` | wajib dan bounded |
| `WAN_SSH_CONNECT_TIMEOUT_MS` | `15000` | wajib |
| `WAN_SSH_IDLE_TIMEOUT_MS` | `900000` | wajib |
| `WAN_SSH_MAX_SESSION_MS` | `14400000` | wajib |
| `WAN_SSH_AUTH_TIMEOUT_MS` | `5000` | wajib |
| `WAN_SSH_HOST_KEY_TIMEOUT_MS` | `60000` | wajib |
| `WAN_SSH_MAX_MESSAGE_BYTES` | `524288` | wajib |
| `WAN_SSH_MAX_PRIVATE_KEY_BYTES` | `262144` | wajib |
| `WAN_SSH_OUTPUT_HIGH_WATER_BYTES` | `1048576` | wajib |
| `WAN_SSH_OUTPUT_LOW_WATER_BYTES` | `262144` | wajib, lebih kecil dari high-water |
| `WAN_SSH_BACKPRESSURE_TIMEOUT_MS` | `10000` | wajib |
| `WAN_SSH_OUTPUT_BATCH_BYTES` | `65536` | wajib |
| `WAN_SSH_EGRESS_MODE` | `development` | `allowlist` atau reviewed policy |
| `WAN_SSH_KNOWN_HOST_MODE` | `client-hint` | `firestore` |
| `WAN_SSH_TRUSTED_PROXY_CIDRS` | Docker subnet yang dibuat stack | wajib, CIDR/hop proxy internal exact |
| `WAN_SSH_CONNECT_RATE_LIMIT` | `30` | wajib, bounded per client identity |
| `WAN_SSH_CONNECT_RATE_WINDOW_MS` | `60000` | wajib |
| `WAN_SSH_LOG_LEVEL` | `info` | `info` |

Startup harus gagal bila:

- `WAN_SSH_ENV=production` memakai `dev-anonymous` atau `dev-static`;
- production origin memakai HTTP atau wildcard;
- Firebase project ID kosong pada Firebase mode;
- limit tidak valid atau tidak bounded;
- egress production masih `development`;
- production tidak mempunyai `WAN_SSH_TRUSTED_PROXY_CIDRS` valid;
- trusted proxy production mencakup public internet, wildcard, atau CIDR yang
  lebih luas dari network proxy internal yang direview;
- konfigurasi memuat private key pengguna.

Untuk local Compose, wrapper membuat network dengan subnet eksplisit dan
menulis CIDR tersebut ke `.runtime/compose.env`; jangan mengandalkan subnet
Docker acak bila forwarded source IP dipakai. Untuk production, prefer koneksi
gateway yang hanya dapat berasal dari network reverse proxy. Gateway memakai
socket peer address sebagai trust decision; `X-Forwarded-For`/`X-Real-IP` hanya
dibaca bila peer berada dalam configured trusted CIDR, lalu nilainya diparse
sebagai satu IP yang ditulis ulang proxy.

### 10.3 Principal

Semua message setelah auth menerima context berikut dari server, bukan client:

```ts
export interface Principal {
  kind: "development" | "firebase";
  id: string;
  uid: string;
  tenantId: string;
  email?: string;
  expiresAt?: number;
}
```

Client tidak pernah mengirim workspace/user ID untuk menentukan ownership.

### 10.4 Session manager

Session manager wajib mempunyai index berikut:

```text
sessionId -> SessionRecord
connectionId -> Set<sessionId>
principalId -> Set<sessionId>
```

Setiap operasi melakukan pemeriksaan:

```text
session ada
AND session.connectionId == currentConnection.id
AND session.principalId == currentPrincipal.id
```

Jangan hanya mengandalkan UUID yang sulit ditebak.

`SessionRecord` minimum:

```ts
interface SessionRecord {
  id: string;
  connectionId: string;
  principalId: string;
  originalHost: string;
  resolvedAddress: string;
  port: number;
  username: string;
  state: "created" | "connecting" | "authenticating" | "connected" | "closing" | "closed";
  client: import("ssh2").Client;
  stream?: NodeJS.ReadWriteStream;
  createdAt: number;
  lastActivityAt: number;
  close(reason: string): void;
}
```

### 10.5 Session lifecycle

```text
session.open
  -> validate schema
  -> authenticate principal
  -> enforce rate/session limits
  -> resolve DNS
  -> apply target/egress policy
  -> allocate server sessionId
  -> convert credential to bounded Buffer
  -> ssh2 connect with hostVerifier
  -> wait host-key answer when needed
  -> open shell PTY
  -> wipe key/passphrase references
  -> stream input/output
  -> close on client request, SSH exit, socket close, idle, max age, or shutdown
```

Cleanup harus idempotent. Semua path error harus:

- menghapus session dari seluruh index;
- membatalkan timer;
- menyelesaikan pending host-key/auth prompt;
- menutup stream dan `ssh2.Client`;
- melakukan best-effort credential wipe;
- menghapus reference konfigurasi/parser credential yang masih dimiliki
  aplikasi, tanpa mengklaim secure erasure terhadap salinan internal runtime;
- menurunkan active-session metric tepat sekali;
- mengirim exit/error paling banyak sekali.

Production runtime yang menerima credential ephemeral juga wajib:

- menonaktifkan core dump process/container;
- tidak mengaktifkan Node diagnostic report, automatic heap snapshot, request
  body capture, APM payload capture, atau crash uploader pada gateway;
- mencegah swap bila platform/operator mendukungnya, atau mendokumentasikan dan
  menerima risikonya secara eksplisit;
- membatasi siapa yang dapat menjalankan debugger, `docker exec`, atau mengambil
  memory dump pada host;
- memperlakukan compromise gateway sebagai kemungkinan compromise credential
  sesi aktif.

### 10.6 Host verifier

Gunakan callback verifier dari `ssh2`; jangan `hostVerifier: () => true`.

Fingerprint harus berasal dari raw host public key yang diberikan handshake,
misalnya SHA-256 base64 dengan format `SHA256:<value>`. Simpan algorithm dan
fingerprint, bukan raw key kecuali ada kebutuhan known-host format yang teruji.

### 10.7 DNS dan egress policy

Gateway publik dapat disalahgunakan sebagai port scanner atau SSRF transport.

Local development boleh mengizinkan LAN agar pengguna dapat menguji server
sendiri. Production harus mempunyai policy eksplisit:

```text
resolve hostname
  -> dapatkan seluruh IP
  -> klasifikasikan loopback, link-local, private, public, metadata
  -> tolak kategori yang tidak diizinkan workspace/operator
  -> pilih satu address yang sudah divalidasi
  -> buat `node:net.Socket` ke address tersebut
  -> berikan socket itu ke `ssh2` melalui opsi `sock`
```

Minimum production:

- blok cloud metadata dan link-local;
- blok loopback gateway;
- batasi port, default hanya 22;
- optional allowlist CIDR/domain per workspace;
- lindungi dari DNS rebinding dengan tidak memberikan hostname asli kepada
  `ssh2` untuk lookup kedua; gunakan `net.Socket` ke IP yang sudah diperiksa dan
  pertahankan hostname asli hanya untuk display serta identity known-host;
- batasi connect attempt per user dan per source IP yang sudah dinormalisasi;
- di belakang reverse proxy, socket peer harus merupakan proxy tepercaya dan
  proxy harus overwrite, bukan append/meneruskan mentah, header forwarding.
  Gateway hanya mempercayai forwarding header dari CIDR/hop proxy internal yang
  dikonfigurasi; header client langsung diabaikan;
- catat target hostname/IP/port sebagai metadata audit, tanpa credential atau
  terminal content.

### 10.8 Output batching dan backpressure

Pola batching pada desktop dapat dipakai sebagai acuan:

- kumpulkan output selama sekitar 16 ms atau sampai threshold;
- kirim satu frame, bukan satu frame per byte/token;
- monitor `webSocket.bufferedAmount`;
- pause SSH stream paling lambat 250 ms setelah buffered output melewati
  high-water mark default 1 MiB;
- resume setelah turun di bawah low-water mark default 256 KiB;
- tutup sesi dengan `BACKPRESSURE_LIMIT` bila tetap di atas high-water selama
  10 detik;
- batasi scrollback di browser seperti saat ini.

Acceptance fixture menghasilkan sekurangnya 64 MiB output sementara test client
berhenti membaca. Dengan default di atas, RSS gateway tidak boleh bertambah lebih
dari 64 MiB terhadap baseline test, sesi harus ditutup maksimal 12 detik, dan
jumlah session/timer harus kembali nol maksimal 2 detik setelah close. Threshold
boleh diubah hanya berdasarkan benchmark terdokumentasi dan tetap bounded.

### 10.9 Heartbeat

- server mengirim WebSocket ping berkala;
- connection yang tidak menjawab pong diterminasi;
- heartbeat WebSocket berbeda dari SSH keepalive;
- socket close menutup seluruh sesi milik socket pada MVP;
- session resume lintas socket tidak diimplementasikan pada MVP.

### 10.10 Graceful shutdown

Pada `SIGTERM`/`SIGINT`:

1. readiness menjadi false;
2. upgrade WebSocket baru ditolak;
3. client aktif menerima service restart/close code `1012`;
4. seluruh sesi ditutup dalam grace period bounded;
5. HTTP server ditutup;
6. process keluar nonzero bila grace period terlampaui.

### 10.11 Logging

Log JSON allowlist minimum:

```text
timestamp
level
event
request_id
connection_id
session_id
principal_id_hash
target_host_hash atau target class
target_port
duration_ms
error_code
```

Yang dilarang pada log:

- private key, password, passphrase, auth answers;
- Firebase token atau Authorization value;
- terminal input/output;
- raw WebSocket frame;
- full SSH config object;
- stack trace pada response client.

---

## 11. Implementasi Web UI

### 11.1 Web entry point

Tambahkan `vite.config.ssh-web.ts` dengan karakteristik:

- root tetap `modules/ssh/ui` agar komponen dapat digunakan ulang;
- runtime define adalah `web`;
- output terpisah, misalnya `firebase/hosting/ssh`;
- base `/` untuk domain khusus atau nilai eksplisit bila menjadi subpath;
- source map production tidak dipublikasikan tanpa keputusan operator;
- CSP `connect-src` hanya same-origin pada Docker lokal dan gateway WSS resmi
  pada hosting terpisah.

Root script target:

```json
{
  "scripts": {
    "build:ssh-web": "vite build --config vite.config.ssh-web.ts",
    "dev:ssh-web": "vite --config vite.config.ssh-web.ts",
    "ssh-gateway:install": "npm --prefix services/wan-ssh-gateway install",
    "ssh-gateway:build": "npm --prefix services/wan-ssh-gateway run build",
    "ssh-gateway:test": "npm --prefix services/wan-ssh-gateway test",
    "ssh-web:stack": "node services/wan-ssh-gateway/scripts/local-stack.mjs",
    "ssh-web:up": "node services/wan-ssh-gateway/scripts/local-stack.mjs up",
    "ssh-web:ps": "node services/wan-ssh-gateway/scripts/local-stack.mjs ps",
    "ssh-web:logs": "node services/wan-ssh-gateway/scripts/local-stack.mjs logs",
    "ssh-web:down": "node services/wan-ssh-gateway/scripts/local-stack.mjs down",
    "qa:ssh-web": "npm --prefix services/wan-ssh-gateway run qa:verify"
  }
}
```

Script tersebut adalah target dan baru ditambahkan bersama implementasi.
`local-stack.mjs up` wajib memvalidasi prerequisite, membuat `.env.local` dari
example bila belum ada, membuat fixture key dan password acak di temporary
directory **di luar repository**, lalu menulis path tersebut ke
`services/wan-ssh-gateway/.runtime/compose.env`. Semua subcommand menjalankan
Compose dengan `--env-file .runtime/compose.env`; karena itu interpolation
`WAN_SSH_FIXTURE_DIR` tetap tersedia untuk `up`, `ps`, `logs`, `exec`, `config`,
dan `down`. `up` memakai profile fixture dengan
`--build --wait --wait-timeout 120`, lalu mencetak URL web serta path credential
fixture. Hanya public key dan salted password hash yang di-mount read-only ke
fixture; plaintext password tetap di temporary directory host untuk E2E.
`down` menghentikan stack, menghapus fixture temporary directory, dan menghapus
`.runtime/compose.env`.

### 11.2 Quick Connect

Local MVP memakai form minimum:

| Field | Aturan |
|-------|--------|
| Host | Wajib, hostname/IP, max 253 |
| Port | 1-65535; form lokal saat ini memakai default `2244` |
| Username | Wajib, max 128 |
| Authentication | Password atau private key |
| Password | Wajib pada mode password, max 4096, tidak dipersist |
| Private key file | Wajib pada mode private key, dipilih pengguna |
| Passphrase | Opsional pada mode private key, tidak dipersist |
| Initial directory/command | Tidak ada pada MVP |

UX wajib:

- gunakan segmented control untuk memilih password/private key;
- tampilkan nama file dan ukuran, bukan isi key;
- jangan tampilkan kembali password/passphrase setelah submit;
- tombol Connect disabled selama credential belum valid atau file belum selesai
  dibaca;
- error file terlalu besar tampil sebelum WebSocket send;
- dialog host-key menampilkan host, port, algorithm, fingerprint, dan warning
  lebih tegas bila fingerprint berubah;
- setelah sesi berhasil dibuat, state credential pada UI dibersihkan;
- jangan menampilkan fitur desktop yang tidak didukung.

### 11.3 Gateway status

UI membedakan:

```text
Checking gateway
Gateway online
Gateway authentication required
Gateway version incompatible
Gateway unavailable
Connection lost
```

Jangan fallback ke mock ketika gateway unavailable.

### 11.4 Terminal

`TerminalPane.tsx` dapat dipakai dengan transport baru bila:

- input memanggil transport `write`;
- resize memanggil transport `resize`;
- output berasal dari event transport;
- listener dilepas saat pane unmount;
- terminal tidak dibuat dua kali oleh StrictMode;
- socket dan session cleanup tidak bergantung pada React unmount saja;
- paste tetap memerlukan browser clipboard permission.

### 11.5 Profile nonsecret lokal

Setelah quick connect stabil, web boleh menyimpan profil berikut di IndexedDB:

```ts
interface WebHostProfile {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  tags: string[];
  favorite: boolean;
  updatedAt: number;
}
```

Yang tidak boleh menjadi bagian profile:

- private key atau isi file;
- passphrase/password;
- Firebase ID token;
- keyboard-interactive answer;
- terminal history.

Known-host fingerprint boleh berada pada IndexedDB local MVP dengan schema dan
migration version tersendiri.

---

## 12. Docker Local MVP

### 12.1 Prasyarat

- Node.js 22 dan npm untuk tooling repository serta wrapper command;
- Docker Desktop atau Docker Engine dengan Compose v2;
- Docker Compose minimal versi yang telah diuji dengan `--wait-timeout`
  (target awal `2.24.0` atau lebih baru);
- browser modern;
- target SSH yang dapat dijangkau dari container, atau fixture test;
- tidak memerlukan VPS, Firebase project, atau domain.

Validasi:

```sh
node --version
npm --version
docker version
docker compose version
```

### 12.2 Environment lokal target

`services/wan-ssh-gateway/.env.local.example`:

```dotenv
WAN_SSH_ENV=development
WAN_SSH_AUTH_MODE=dev-anonymous
WAN_SSH_BIND_HOST=0.0.0.0
WAN_SSH_PORT=8788
WAN_SSH_ALLOWED_ORIGINS=http://127.0.0.1:5179
WAN_SSH_MAX_SESSIONS_PER_USER=3
WAN_SSH_MAX_SESSIONS_TOTAL=20
WAN_SSH_CONNECT_TIMEOUT_MS=15000
WAN_SSH_IDLE_TIMEOUT_MS=900000
WAN_SSH_MAX_SESSION_MS=14400000
WAN_SSH_AUTH_TIMEOUT_MS=5000
WAN_SSH_HOST_KEY_TIMEOUT_MS=60000
WAN_SSH_MAX_MESSAGE_BYTES=524288
WAN_SSH_MAX_PRIVATE_KEY_BYTES=262144
WAN_SSH_OUTPUT_HIGH_WATER_BYTES=1048576
WAN_SSH_OUTPUT_LOW_WATER_BYTES=262144
WAN_SSH_BACKPRESSURE_TIMEOUT_MS=10000
WAN_SSH_OUTPUT_BATCH_BYTES=65536
WAN_SSH_EGRESS_MODE=development
WAN_SSH_TRUSTED_PROXY_CIDRS=172.30.0.0/24
WAN_SSH_CONNECT_RATE_LIMIT=30
WAN_SSH_CONNECT_RATE_WINDOW_MS=60000
WAN_SSH_LOG_LEVEL=info
```

Subnet contoh harus sama dengan subnet eksplisit pada Compose. Bila bentrok
dengan network lokal, wrapper memilih subnet private lain, menulis override
Compose/runtime env yang konsisten, lalu gateway memercayai hanya subnet itu.

`dev-anonymous` hanya boleh berjalan bila seluruh kondisi berikut benar:

- environment `development`;
- gateway tidak mempublikasikan port ke host;
- reverse proxy web dipublish hanya pada `127.0.0.1`;
- allowed origin exact localhost;
- startup guard menolak mode ini di production.

Untuk development lintas device, jangan sekadar mengganti bind ke `0.0.0.0`.
Gunakan TLS dan autentikasi development yang bounded atau lanjutkan langsung ke
Firebase mode.

### 12.3 Compose target

Karakteristik wajib `docker-compose.local.yml`:

```yaml
services:
  gateway:
    build:
      context: .
      dockerfile: Dockerfile
    env_file:
      - .env.local
    environment:
      WAN_SSH_TRUSTED_PROXY_CIDRS: ${WAN_SSH_DOCKER_SUBNET:-172.30.0.0/24}
    expose:
      - "8788"
    networks:
      - wan-ssh-local
    read_only: true
    tmpfs:
      - /tmp:size=16m,noexec,nosuid
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8788/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
      interval: 5s
      timeout: 3s
      retries: 20
    restart: unless-stopped

  web:
    build:
      context: ../..
      dockerfile: services/wan-ssh-gateway/docker/web.Dockerfile
    depends_on:
      gateway:
        condition: service_healthy
    ports:
      - "127.0.0.1:5179:8080"
    networks:
      - wan-ssh-local
    read_only: true
    tmpfs:
      - /var/cache/nginx:size=16m
      - /var/run:size=1m
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1"]
      interval: 5s
      timeout: 3s
      retries: 20
    restart: unless-stopped

  ssh-target:
    profiles: ["fixture"]
    build:
      context: docker/ssh-target
      dockerfile: Dockerfile
    volumes:
      - type: bind
        source: ${WAN_SSH_FIXTURE_DIR:?WAN_SSH_FIXTURE_DIR wajib diisi}/id_ed25519.pub
        target: /run/fixture/id_ed25519.pub
        read_only: true
    expose:
      - "22"
    networks:
      - wan-ssh-local
    healthcheck:
      test: ["CMD-SHELL", "ssh-keyscan -T 2 -p 22 127.0.0.1 >/dev/null 2>&1 || exit 1"]
      interval: 3s
      timeout: 3s
      retries: 30
    restart: unless-stopped

networks:
  wan-ssh-local:
    ipam:
      config:
        - subnet: ${WAN_SSH_DOCKER_SUBNET:-172.30.0.0/24}
```

Compose final boleh memerlukan penyesuaian UID/path agar Nginx benar-benar dapat
berjalan read-only dan non-root. Acceptance test harus memeriksa konfigurasi
aktual, bukan hanya menyalin snippet. Container fixture hanya menerima public
key read-only; private fixture key tidak boleh di-mount ke container apa pun.

### 12.4 Docker build context

Repository saat checkpoint belum mempunyai `.dockerignore`. Implementasi wajib
menambahkan dua file karena gateway memakai context service, sedangkan web
memakai context root repository:

```text
/.dockerignore
/services/wan-ssh-gateway/.dockerignore
```

Minimum exclusion pada keduanya, disesuaikan terhadap letak context:

```dockerignore
.git
**/node_modules
**/.tmp
**/.runtime
**/.env
**/.env.*
!**/.env.*.example
**/id_rsa*
**/id_ed25519*
**/*.pem
**/*.key
out
firebase/hosting/ssh
modules/ssh/renderer
```

Aturan:

- fixture private key dan password acak dibuat pada `${TMPDIR:-/tmp}`, bukan di
  dalam repository;
- `.gitignore` tidak menggantikan `.dockerignore`;
- hanya public fixture key dan salted password hash yang boleh di-bind read-only
  ke `ssh-target`; plaintext password tidak di-mount;
- gateway dan web build tidak menerima fixture directory sebagai context,
  secret, build argument, environment, atau mount;
- QA membuat sentinel pada path yang di-ignore, membangun kedua image, dan
  membuktikan sentinel tidak ada pada build output, image filesystem, history,
  atau exported image tar.

### 12.5 Gateway Dockerfile

Gunakan multi-stage build dan user non-root:

```dockerfile
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8788
CMD ["node", "dist/src/server.js"]
```

Pin base image digest pada release production. Jangan menyalin repository penuh
atau file `.env` ke image gateway.

### 12.6 Web container

Web image melakukan Vite build pada stage Node lalu menyalin static output ke
Nginx/Caddy. Reverse proxy:

```text
/             -> static SPA, fallback index.html
/healthz      -> gateway:8788/healthz
/readyz       -> gateway:8788/readyz
/runtime-config.json -> gateway:8788/runtime-config.json
/v1/ws        -> gateway:8788/v1/ws dengan WebSocket upgrade
```

Header minimum local:

```text
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:5179; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
Cross-Origin-Opener-Policy: same-origin
```

`frame-ancestors` adalah directive di dalam CSP, bukan header mandiri. CSP
production mengganti `ws://127.0.0.1:5179` dengan origin WSS resmi.

### 12.7 Menjalankan stack setelah implementasi

```sh
npm run ssh-web:up
```

Cek:

```sh
curl --fail http://127.0.0.1:5179/healthz
open http://127.0.0.1:5179
```

Log gateway:

```sh
npm run ssh-web:logs -- gateway
```

Stop tanpa menghapus image:

```sh
npm run ssh-web:down
```

Karena local MVP tidak menyimpan credential, tidak diperlukan volume credential.

### 12.8 Menjangkau target SSH

| Target | Host yang diisi di UI |
|--------|-----------------------|
| Server internet/LAN | Hostname atau IP biasa bila Docker dapat merutekannya |
| macOS/Windows host Docker | `host.docker.internal` |
| Linux host Docker | `host.docker.internal` dengan `host-gateway` mapping |
| Compose fixture | Nama service, misalnya `ssh-target` |

Jangan mempublikasikan port target fixture ke internet.

### 12.9 Fixture SSH deterministik

Automated local gate harus mempunyai profile `fixture` yang:

- membuat key client test pada temporary directory di luar repository;
- membangun container OpenSSH test atau `ssh2.Server` fixture;
- membuat user non-root `wan`;
- menerima hanya public key fixture melalui read-only bind dan memasangnya
  sebagai `authorized_keys` saat startup;
- memakai host key fixture khusus test;
- hanya tersedia pada internal Compose network;
- mempunyai command aman seperti shell terbatas/container disposable;
- diberi banner jelas bahwa key tidak boleh dipakai di luar test.

Target command:

```sh
npm run ssh-web:up
```

Nilai quick connect fixture:

```text
Host      : ssh-target
Port      : 22
Username  : wan
Key       : path temporary yang dicetak `npm run ssh-web:up`
Passphrase: kosong
```

Wrapper menyimpan hanya path nonsecret yang diperlukan untuk shutdown pada
`.runtime/fixture-dir`; directory tersebut di-ignore Git dan Docker. Private key
tetap berada di temporary directory luar repository dan dihapus oleh
`npm run ssh-web:down`.

---

## 13. Urutan Implementasi

### Phase 0: Guardrail dan kontrak

#### `ARC-01` - Capability dan transport seam

Pekerjaan:

- definisikan `RemoteTerminalTransport`;
- bungkus bridge Electron saat ini tanpa mengubah behavior;
- ubah `TerminalPane` agar memakai transport;
- jadikan mock eksplisit;
- tambahkan test mapping event Electron.

Acceptance:

- build dan test desktop lulus;
- membuka Electron tetap memakai preload;
- tidak ada request network baru pada desktop production;
- mode tanpa preload dan tanpa web config menampilkan configuration error.

#### `ARC-02` - Protocol schema bersama

Pekerjaan:

- definisikan protocol version 1;
- schema Zod untuk seluruh client message;
- server event type untuk frontend;
- error code dan close code;
- fixture JSON valid/invalid.

Acceptance:

- unknown message dan oversized message ditolak deterministik;
- schema tidak menerima client-supplied principal/session owner;
- frontend dan gateway menggunakan contract version yang sama.

### Phase 1: Gateway foundation

#### `GAT-01` - Service scaffold

Pekerjaan:

- package TypeScript Node 22;
- config fail-fast;
- `/healthz`, `/readyz`;
- structured redacted logger;
- signal handling;
- unit test config.

Acceptance:

- build dan test berjalan tanpa Electron;
- production menolak dev auth;
- process keluar bersih pada `SIGTERM`;
- health response tidak membocorkan config.

#### `GAT-02` - WebSocket auth dan origin

Pekerjaan:

- exact-origin upgrade guard;
- auth-first frame dan timeout;
- development principal;
- request correlation;
- heartbeat dan size limit.

Acceptance:

- origin salah ditolak;
- unauthenticated message ditolak;
- timeout menutup socket;
- raw token tidak muncul di log;
- malformed JSON tidak menjatuhkan process.

#### `GAT-03` - Session manager dan ownership

Pekerjaan:

- map per session, connection, principal;
- per-user/global limits;
- idempotent cleanup;
- idle dan max-session timer;
- socket-close cleanup.

Acceptance:

- principal A tidak dapat mengakses session B;
- menutup socket menutup seluruh sesi miliknya;
- limit tidak dapat dilewati dengan request paralel;
- metric/counter tidak bocor setelah failure.

### Phase 2: SSH terminal

#### `SSH-WEB-01` - SSH connect dan PTY

Pekerjaan:

- bounded private key dan password parsing;
- `ssh2.Client` connect;
- host/port/username validation;
- shell PTY, input, resize, output, close;
- normalized error;
- credential wipe.

Acceptance:

- key dan password valid dapat login ke fixture;
- key/passphrase/password salah menghasilkan error yang benar;
- resize terlihat melalui `stty size`;
- close UI menutup TCP connection;
- key dan plaintext password fixture tidak ditemukan pada log/image/filesystem
  container.

#### `SSH-WEB-02` - Host-key verification

Pekerjaan:

- fingerprint SHA-256;
- unknown/changed prompt;
- answer timeout;
- expected fingerprint comparison;
- browser known-host storage.

Acceptance:

- unknown key tidak auto-connect;
- reject menghentikan koneksi;
- accept melanjutkan;
- key sama tidak prompt lagi;
- changed key memberi warning dan tidak auto-accept.

#### `SSH-WEB-03` - Backpressure dan lifecycle

Pekerjaan:

- output batching;
- WebSocket high/low water;
- SSH keepalive;
- heartbeat;
- graceful shutdown active sessions.

Acceptance:

- fixture mengirim minimal 64 MiB saat client berhenti membaca; kenaikan RSS
  maksimal 64 MiB dari baseline;
- stream dipause paling lambat 250 ms setelah high-water, slow client ditutup
  maksimal 12 detik dengan `BACKPRESSURE_LIMIT`, lalu seluruh session/timer nol
  maksimal 2 detik setelah close;
- container restart menghasilkan state disconnect yang jelas;
- tidak ada session/timer tersisa setelah test.

### Phase 3: Web application

#### `WEB-SSH-01` - Web build dan runtime

Pekerjaan:

- `vite.config.ssh-web.ts`;
- `WebApp.tsx`;
- WebSocket transport;
- gateway status;
- runtime error screen;
- CSP yang sesuai.

Acceptance:

- web production build tidak membutuhkan `window.api`;
- bundle tidak memakai mock secara otomatis;
- refresh SPA tetap membuka aplikasi;
- protocol mismatch tampil jelas.

#### `WEB-SSH-02` - Quick Connect

Pekerjaan:

- form host/port/username;
- private-key file picker;
- passphrase field;
- host-key dialog;
- connect/cancel/error state;
- credential UI cleanup.

Acceptance:

- file terlalu besar ditolak client dan server;
- key tidak berada di browser storage;
- koneksi sukses membuka terminal;
- cancel saat connecting membersihkan session;
- dialog changed fingerprint tidak ambigu.

#### `WEB-SSH-03` - Terminal integration

Pekerjaan:

- input/output/resize;
- search/copy/paste;
- reconnect socket UX;
- tab close cleanup;
- responsive desktop/mobile minimum.

Acceptance:

- command interaktif berjalan;
- resize tidak merusak kolom;
- listener tidak dobel pada StrictMode;
- terminal tidak menerima output sesi lain;
- mobile tidak mempunyai overlap kontrol.

### Phase 4: Docker dan QA local

#### `DOCKER-SSH-01` - Images dan Compose

Pekerjaan:

- gateway multi-stage image;
- web static image dan reverse proxy;
- loopback-only published port;
- root dan service `.dockerignore`;
- health dependencies;
- read-only/non-root hardening;
- fixture profile.

Acceptance:

- setelah `npm ci`, `npm run ssh-web:up` sukses dari checkout bersih dalam
  timeout 120 detik pada environment CI yang didokumentasikan;
- hanya `127.0.0.1:5179` dipublish;
- gateway tidak memiliki mount `~/.ssh` atau Docker socket;
- private fixture key berada di temporary directory luar repository dan tidak
  ditemukan pada kedua build context, image filesystem/history/tar, atau log;
- `--wait` baru sukses setelah gateway, web, dan `ssh-target` sehat;
- restart gateway tidak memulihkan credential/session lama;
- `npm run ssh-web:down` membersihkan container dan fixture temporary directory
  tanpa menghapus source.

#### `QA-SSH-01` - Unified local gate

Pekerjaan:

- unit + integration tests;
- browser E2E terhadap fixture;
- secret/log leak scan;
- Docker config inspection;
- desktop regression build/test;
- satu command `qa:ssh-web`.

Acceptance:

- tidak ada skipped test wajib;
- test unknown/rejected/changed host key lulus;
- cross-session/cross-principal negative test lulus;
- Electron SSH regression lulus;
- dependency audit tidak mempunyai High/Critical tanpa exception tertulis.

Local MVP dianggap berjalan setelah `ARC-01` sampai `QA-SSH-01` lulus.

### Phase 5: Production auth dan deployment

#### `AUTH-SSH-01` - Firebase Auth

Status repository 2026-08-13: **implemented dan Auth Emulator/browser verified**.
Live Firebase project, production ADC/workload identity, serta HTTPS/WSS rollout
tetap menjadi deployment gate dan bukan bagian dari klaim ini.

Pekerjaan:

- [x] login frontend Email/Password;
- [x] login frontend Google OAuth (`GoogleAuthProvider` + `signInWithPopup`,
  fallback `signInWithRedirect` saat popup diblokir);
- [x] halaman `/login`, protected route `/dashboard`, dan redirect dua arah;
- [x] state auth global `loading`/`authenticated`/`unauthenticated` sehingga
  halaman login tidak tampil sebelum pengecekan sesi selesai;
- [x] session persistence IndexedDB/localStorage yang bertahan setelah refresh;
- [x] menu akun `uid`, `displayName`, `email`, `photoURL` dan logout ke `/login`;
- [x] konfigurasi Web SDK hanya dari environment `VITE_FIREBASE_*` atau
  `/__/firebase/init.json`; tidak ada credential server-side di bundle web;
- [x] `getIdToken()` sebelum WebSocket auth;
- [x] Admin SDK `verifyIdToken(..., true)`;
- [x] refresh token protocol dan server-owned expiry timer;
- [x] revoked/disabled user handling;
- [x] emulator backend dan browser tests.

Acceptance:

- invalid project/audience/expired token ditolak;
- UID hanya berasal dari verified token;
- auth refresh tidak boleh mengganti UID;
- socket tanpa refresh valid ditutup `4401` paling lambat saat verified `exp`;
- expired/revoked/disabled refresh dan refresh setelah deadline ditolak serta
  menutup seluruh sesi;
- logout menutup socket dan seluruh sesi;
- Firebase emulator integration lulus.

Verification:

```sh
npm run ssh-gateway:test
npm run test:ssh-web:firebase
```

Test emulator memverifikasi UID dari claim server-side, invalid/wrong-project/
expired/revoked/disabled token, refresh UID berbeda, expiry tanpa refresh,
cleanup sesi pada auth fatal, login browser, token handoff tanpa URL, logout,
dan layout auth mobile. Browser test juga memverifikasi redirect protected route
ke `/login`, kehadiran tombol Continue with Google, sesi yang bertahan sehingga
`/login` kembali ke `/dashboard`, dan logout yang kembali ke `/login`.

Konfigurasi Firebase untuk web gateway memakai Firebase project yang sama dengan
WAN SSH Desktop dan hanya membaca nilai publik Web SDK:

```sh
# modules/ssh/ui/.env.local — lihat modules/ssh/ui/.env.example
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
```

Saat web di-host oleh Firebase Hosting, seluruh variabel tersebut boleh kosong
karena konfigurasi dibaca dari `/__/firebase/init.json`; deployment tidak perlu
meng-upload `firebase.json` atau credential apa pun. Service account tetap hanya
dipakai gateway melalui Application Default Credentials.

Deployment gate tambahan untuk Google sign-in: provider Google harus diaktifkan
pada Firebase Authentication, domain web gateway harus masuk Authorized domains,
dan edge harus mengirim `Cross-Origin-Opener-Policy: same-origin-allow-popups`
beserta `frame-src` authDomain Firebase agar popup dapat menyelesaikan sign-in.

#### `SEC-SSH-01` - Production network policy

Status repository 2026-08-14: **implemented dan unit/integration verified**.
Production egress allowlist operator, live TLS/WSS, dan durable known-host store
telah tersedia di repository; live Firestore/ADC dan rollout tetap menjadi
deployment gate.

Pekerjaan:

- [x] egress/CIDR policy dan metadata/link-local block;
- [x] connect rate limit keyed by trusted client identity;
- [x] trusted-proxy hop parsing untuk `X-Forwarded-For`/`X-Real-IP`;
- [x] preconnected `ssh2` socket ke resolved IP yang sudah diperiksa;
- [x] target port policy production;
- [x] audit metadata hashed, tanpa terminal content/credential.

Acceptance:

- metadata IP dan forbidden range ditolak;
- DNS rebinding fixture membuktikan `ssh2` memakai preconnected `net.Socket` ke
  address yang sudah diperiksa dan tidak melakukan lookup hostname kedua;
- spoofed `X-Forwarded-For` dari client tidak memengaruhi rate-limit identity;
- hanya forwarding header dari configured trusted proxy hop yang diterima;
- target port policy enforced;
- terminal content dan credential tidak masuk audit/log.

Verification:

```sh
npm run ssh-gateway:test
```

#### `HOSTKEY-SSH-01` - Durable authoritative known-host

Status repository 2026-08-14: **implemented dan Firestore Emulator verified**.
Live Firestore project, ADC/workload identity, backup/export, dan restore
rehearsal tetap deployment gate.

Pekerjaan:

- [x] lookup authoritative `(tenantId, normalizedHost, port)`;
- [x] client `expectedHostKeyFingerprint` hanya menjadi local-mode hint;
- [x] accept unknown/changed memakai Firestore transaction compare-and-set;
- [x] actor, timestamp, previous/new fingerprint, algorithm, dan version diaudit;
- [x] direct client read/write ditolak Firestore Security Rules;
- [x] production startup mewajibkan `WAN_SSH_KNOWN_HOST_MODE=firestore`.
- [x] Firestore Emulator persistence, multi-client CAS conflict, audit, tenant
  isolation, dan direct-client denial test.

Acceptance repository:

- normalisasi hostname stabil dan document identity terisolasi antar tenant;
- stale concurrent writer ditolak sebagai conflict;
- koneksi production tidak dapat memakai IndexedDB fingerprint sebagai authority;
- gateway gagal start pada production tanpa authoritative store.

Verification:

```sh
npm run ssh-gateway:test
npm run test:ssh-web:known-host
```

#### `OPS-SSH-01` - TLS, metrics, runbook, rollback

Status repository 2026-08-14: **implemented dan unit/integration verified**.
Live certificate, public WSS, canary traffic, dan rollback rehearsal di VPS
tetap menjadi deployment gate.

Pekerjaan:

- [x] Caddy/Nginx TLS example dan WSS proxy timeout;
- [x] `/metrics` Prometheus dengan label bounded;
- [x] alert catalog dan audit/redaction allowlist;
- [x] health/readiness plus graceful close `1012`;
- [x] reconnect socket UX tanpa resume sesi;
- [x] rollback dan incident credential runbook.

Acceptance:

- browser HTTPS memakai `wss:`; mixed-content `ws://` tidak dipakai pada origin TLS;
- shutdown/restart menutup socket `1012` dan client harus membuka sesi baru;
- `/metrics` memuat active sessions, auth failure, dan readiness tanpa secret;
- previous image digest adalah unit rollback, bukan `git pull`;
- incident credential exposure runbook tersedia.

Verification:

```sh
npm run ssh-gateway:test
```

Lihat `services/wan-ssh-gateway/docs/OPS-SSH-01.md`.

---

## 14. Testing Strategy

### 14.1 Unit test

- config validation dan production guard;
- protocol schema valid/invalid;
- origin exact matching;
- auth timeout;
- auth expiry, missing refresh, revoked refresh, dan UID substitution;
- principal/session ownership;
- session limits dan race paralel;
- target IP classification;
- trusted-proxy dan spoofed forwarding header;
- preconnected socket tanpa lookup kedua;
- error normalization;
- redaction allowlist;
- fingerprint calculation;
- cleanup idempotency.

### 14.2 Integration test gateway

Gunakan fixture `ssh2.Server` atau OpenSSH disposable untuk menguji:

- successful private-key auth;
- encrypted private key + passphrase;
- wrong key/passphrase;
- unknown host key accept/reject;
- changed host key;
- keyboard-interactive;
- PTY dimensions;
- large output dan backpressure;
- remote close;
- idle timeout;
- socket disconnect;
- gateway shutdown.

### 14.3 Browser E2E

Gunakan Playwright pada target test:

1. Buka web.
2. Pastikan gateway online.
3. Isi fixture host.
4. Pilih key fixture melalui file input.
5. Klik Connect.
6. Terima fingerprint.
7. Tunggu prompt shell.
8. Jalankan `printf 'WAN_SSH_E2E_OK\n'`.
9. Verifikasi output.
10. Jalankan `stty size` setelah resize viewport.
11. Tutup tab terminal.
12. Verifikasi active session kembali nol melalui test-only inspector internal,
    bukan endpoint production.

Test tambahan:

- reject fingerprint;
- changed fingerprint;
- key terlalu besar;
- malformed WS frame;
- origin salah;
- session ownership;
- gateway restart;
- mobile viewport.

### 14.4 Secret leak test

Buat key/passphrase fixture dengan marker unik, lalu setelah test cari marker
pada:

- stdout/stderr gateway;
- web log;
- Docker inspect;
- mounted volume;
- temporary directory container;
- browser local/session storage dan IndexedDB;
- generated build assets.

Test gagal bila marker ditemukan di luar frame test yang memang mengirimkannya.
Secret test juga memeriksa dua Docker build context, image history, exported
image tar, dan membuktikan core dump/Node diagnostic report/heap snapshot serta
APM request-body capture tidak aktif pada production configuration.

### 14.5 Desktop regression

Gate minimum:

```sh
npm run build:ssh
npm run build:ssh-renderer
npm --prefix modules/ssh test
npm run typecheck
```

Jika root typecheck mempunyai kegagalan unrelated yang sudah ada, catat secara
eksplisit dan tetap jalankan check paling sempit untuk file SSH yang berubah.

### 14.6 Target QA command

```sh
npm run qa:ssh-web
```

Command tersebut harus:

1. build gateway;
2. menjalankan unit/integration test;
3. build web;
4. build/test desktop SSH;
5. membangun Compose fixture;
6. menjalankan browser E2E;
7. memeriksa secret/log leak;
8. memeriksa Docker config dan published ports;
9. menjalankan production dependency audit;
10. mengukur threshold RSS/backpressure dan cleanup deadline;
11. membersihkan fixture/container/temporary key walau test gagal.

---

## 15. Menjalankan Local MVP dari Checkout Bersih

Bagian ini adalah target operator flow setelah Phase 0-4 selesai.

### 15.1 Install

```sh
npm ci
npm --prefix services/wan-ssh-gateway ci
```

### 15.2 Siapkan environment

```sh
cp services/wan-ssh-gateway/.env.local.example \
  services/wan-ssh-gateway/.env.local
```

Langkah copy boleh dilewati karena `npm run ssh-web:up` membuatnya bila belum
ada. Edit file hanya untuk mengubah konfigurasi nonsecret. Tidak ada private key
yang dimasukkan ke `.env.local`.

### 15.3 Jalankan fixture dan stack

```sh
npm run ssh-web:up
```

Command harus selesai maksimal 120 detik atau gagal dengan diagnosis yang
jelas. Output mencetak URL aplikasi dan path temporary private key fixture.

### 15.4 Verifikasi service

```sh
curl --fail http://127.0.0.1:5179/healthz
curl --fail http://127.0.0.1:5179/readyz
npm run ssh-web:ps
```

### 15.5 Buka aplikasi

```sh
open http://127.0.0.1:5179
```

Isi fixture:

```text
Host      : ssh-target
Port      : 22
Username  : wan
Private key:
<path temporary yang dicetak npm run ssh-web:up>
```

Terima fingerprint fixture, lalu jalankan:

```sh
whoami
pwd
printf 'WAN_SSH_OK\n'
stty size
```

Expected:

```text
wan
...
WAN_SSH_OK
<rows> <cols>
```

### 15.6 Uji server nyata

Gunakan hostname/IP yang dapat dicapai dari container. Jika SSH server berada
pada macOS host, gunakan `host.docker.internal`. Pilih private key melalui UI;
jangan copy key ke container.

Sebelum menerima fingerprint, bandingkan dengan fingerprint dari channel lain
yang dipercaya, misalnya console provider atau administrator server.

### 15.7 Jalankan gate

```sh
npm run qa:ssh-web
```

### 15.8 Stop

```sh
npm run ssh-web:down
```

Verifikasi directory key temporary yang dicetak saat startup sudah terhapus.

---

## 16. Firebase Auth untuk Production

### 16.1 Frontend

- gunakan Firebase Web SDK;
- login Email/Password dan/atau Google sesuai kebijakan produk;
- sebelum membuka socket, panggil `user.getIdToken()`;
- token dikirim hanya pada frame `auth`, bukan query URL;
- jadwalkan `getIdToken(true)` sebelum expiry dan kirim `auth.refresh`;
- kegagalan refresh menutup socket dan menghapus session UI; client tidak boleh
  memperpanjang deadline sendiri;
- logout menutup WebSocket sebelum menghapus UI state;
- jangan menyimpan token manual di `localStorage`.

### 16.2 Gateway

- gunakan `firebase-admin`;
- verifikasi signature, expiry, project/audience, disabled/revoked user sesuai
  kebutuhan keamanan;
- pasang expiry timer dari verified `exp`; timer ditutup/diganti hanya setelah
  refresh valid dengan UID yang sama;
- tutup socket `4401` dan seluruh sesi saat deadline terlewati;
- buat principal dari verified claims;
- hash UID pada log bila raw UID tidak diperlukan;
- jangan menerima UID/email/workspace dari payload client sebagai authority;
- cache public verification keys melalui SDK, bukan implementasi JWT manual.

### 16.3 Local emulator

Target environment:

```dotenv
WAN_SSH_ENV=development
WAN_SSH_AUTH_MODE=firebase
WAN_SSH_FIREBASE_PROJECT_ID=demo-wan-super-app
FIREBASE_AUTH_EMULATOR_HOST=host.docker.internal:9099
WAN_SSH_ALLOWED_ORIGINS=http://127.0.0.1:5179
```

Gateway dalam container perlu mengakses emulator host melalui
`host.docker.internal`, bukan `127.0.0.1` container.

### 16.4 Credential Firebase server

Jangan memasukkan service-account JSON ke image.

Pilihan:

- GCP: Application Default Credentials/workload identity;
- VPS: secret file di luar repository, mount read-only dengan permission ketat;
- CI: workload identity federation;
- local emulator: tidak memerlukan production service-account.

---

## 17. Deployment VPS

### 17.1 Prasyarat

- VPS Linux yang masih didukung;
- domain dan DNS;
- inbound TCP 443;
- outbound TCP ke target SSH yang diizinkan;
- Docker Engine/Compose atau orchestrator setara;
- Firebase project untuk auth;
- backup dan patching policy.

Inbound port gateway internal tidak dipublish langsung. Reverse proxy adalah
satu-satunya entry point.

### 17.2 Production environment minimum

```dotenv
WAN_SSH_ENV=production
WAN_SSH_AUTH_MODE=firebase
WAN_SSH_FIREBASE_PROJECT_ID=wan-project-id
WAN_SSH_BIND_HOST=0.0.0.0
WAN_SSH_PORT=8788
WAN_SSH_ALLOWED_ORIGINS=https://ssh.example.com
WAN_SSH_MAX_SESSIONS_PER_USER=3
WAN_SSH_MAX_SESSIONS_TOTAL=100
WAN_SSH_CONNECT_TIMEOUT_MS=15000
WAN_SSH_IDLE_TIMEOUT_MS=900000
WAN_SSH_MAX_SESSION_MS=14400000
WAN_SSH_AUTH_TIMEOUT_MS=5000
WAN_SSH_HOST_KEY_TIMEOUT_MS=60000
WAN_SSH_MAX_MESSAGE_BYTES=524288
WAN_SSH_MAX_PRIVATE_KEY_BYTES=262144
WAN_SSH_OUTPUT_HIGH_WATER_BYTES=1048576
WAN_SSH_OUTPUT_LOW_WATER_BYTES=262144
WAN_SSH_BACKPRESSURE_TIMEOUT_MS=10000
WAN_SSH_OUTPUT_BATCH_BYTES=65536
WAN_SSH_EGRESS_MODE=allowlist
WAN_SSH_KNOWN_HOST_MODE=firestore
WAN_SSH_TRUSTED_PROXY_CIDRS=172.31.0.0/24
WAN_SSH_CONNECT_RATE_LIMIT=30
WAN_SSH_CONNECT_RATE_WINDOW_MS=60000
WAN_SSH_LOG_LEVEL=info
```

CIDR production adalah contoh dan harus diganti dengan network reverse proxy
internal aktual. Nilai kapasitas adalah starting point, bukan benchmark final.

### 17.3 Reverse proxy

Reverse proxy wajib:

- TLS valid;
- HTTP ke HTTPS redirect;
- WebSocket upgrade;
- bounded request header/body;
- long-lived connection timeout yang sesuai;
- tidak mencatat query/body/frame;
- security headers untuk static frontend;
- overwrite forwarding headers dari koneksi publik;
- gateway hanya mempercayai CIDR/hop reverse proxy internal;
- health endpoint untuk operator;
- gateway container tetap internal.

Contoh bentuk Caddy target:

```caddyfile
ssh.example.com {
  encode zstd gzip

  header {
    Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: https://*.googleusercontent.com; connect-src 'self' wss://ssh.example.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    X-Content-Type-Options "nosniff"
    Referrer-Policy "no-referrer"
    Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
    Cross-Origin-Opener-Policy "same-origin"
  }

  handle /v1/ws {
    reverse_proxy gateway:8788 {
      header_up X-Forwarded-For {remote_host}
      header_up X-Real-IP {remote_host}
    }
  }

  handle /healthz {
    reverse_proxy gateway:8788
  }

  handle /readyz {
    reverse_proxy gateway:8788
  }

  handle /runtime-config.json {
    reverse_proxy gateway:8788
  }

  handle {
    root * /srv/wan-ssh-web
    try_files {path} /index.html
    file_server
  }
}
```

CSP di atas adalah baseline untuk Firebase Email/Password. Bila Google sign-in
memakai popup/redirect, tambahkan hanya origin yang benar-benar dibutuhkan oleh
versi Firebase SDK yang dipin, misalnya `https://accounts.google.com` dan
`https://*.firebaseapp.com`, pada directive `script-src`, `frame-src`,
`connect-src`, dan/atau `form-action` yang relevan. Jangan memakai wildcard
umum. Browser E2E harus menjalankan setiap metode login yang diaktifkan dan
gagal bila CSP violation terjadi. Bila frontend di Firebase Hosting dan gateway
berada pada domain berbeda, CSP juga memasukkan exact `wss://ssh-api...` dan
gateway exact-origin allowlist memasukkan domain Hosting.

Konfigurasi final harus diuji terhadap WebSocket idle/restart dan header origin.
Gateway menerima source IP forwarding hanya karena koneksi berasal dari proxy
internal yang dikonfigurasi; request langsung atau header tambahan dari client
tidak dipercaya. Jika syntax Caddy berubah pada versi yang dipin, validasi hasil
header aktual dengan integration test, bukan hanya parser config.

### 17.4 Deploy sequence

```text
Build immutable images
  -> dependency/security scan
  -> push registry
  -> deploy staging
  -> run auth + SSH fixture smoke
  -> verify metrics/log redaction
  -> canary production
  -> monitor active sessions/error rate
  -> full rollout
```

Jangan melakukan in-place source edit pada VPS.

### 17.5 Rollback

- simpan previous known-good image digest;
- tidak ada session migration pada MVP;
- readiness instance baru harus lulus sebelum menerima traffic;
- rolling restart memberi close code `1012` agar client dapat menampilkan
  reconnect;
- rollback berarti deploy digest sebelumnya, bukan `git pull` acak;
- schema metadata harus backward-compatible satu versi bila database sudah
  ditambahkan.

---

## 17A. Local Agent Egress (target di balik VPN)

Ketika target SSH hanya bisa dijangkau lewat VPN, gateway di VPS tidak perlu
ikut memasang VPN. Sesi bisa dialihkan lewat mesin operator yang sudah
terhubung VPN: browser tetap bicara ke gateway, gateway meminta agent lokal
membuka koneksi TCP-nya.

```text
Browser ──wss──► Gateway (VPS) ──bridge.open──► Agent (laptop, VPN aktif) ──► Target 10.x
```

Seluruh koneksi bersifat outbound dari laptop ke VPS (443), sehingga VPN tidak
perlu mengizinkan inbound apa pun.

### 17A.1 Komponen

| Bagian | Lokasi | Catatan |
| --- | --- | --- |
| Hub `/v1/agent` | `services/wan-ssh-gateway/src/agent/` | Auth Firebase, principal-scoped, framing biner |
| Agent CLI | `services/wan-ssh-gateway/src/agent-client/` | `wan-ssh-agent` (`pair`/`run`/`status`/`unpair`) |
| Toggle host | `modules/ssh/ui/src/Dialogs.tsx` → tab Routing | Menyimpan `useLocalAgent`, mengirim `egress.mode = "client-agent"` |
| Pairing code | Menu akun → **Local agent** | `WANSSH1.<base64url>` berisi `apiKey` + `refreshToken` |

Env gateway: `WAN_SSH_AGENT_BRIDGE_ENABLED` (default `true`),
`WAN_SSH_AGENT_REGISTRATION_TIMEOUT_MS`, `WAN_SSH_AGENT_OPEN_TIMEOUT_MS`,
`WAN_SSH_AGENT_MAX_BUFFERED_BYTES`.

### 17A.2 Menjalankan agent

Agent runtime hanya memerlukan `ws` dan modul bawaan Node, jadi mesin operator
tidak perlu checkout repo maupun `npm install` 103 MB milik gateway. Bungkus
sekali di mesin developer, lalu salin satu file hasilnya:

```bash
npm run ssh-agent:bundle
```

Keluarannya `services/wan-ssh-gateway/dist/wan-ssh-agent.cjs` (~150 KB, sengaja
tanpa minify agar tetap bisa diaudit — file ini memegang refresh token). Salin
ke mesin yang terhubung VPN, lalu:

```bash
node wan-ssh-agent.cjs pair WANSSH1.xxxxx --allow 10.8.0.0/24
node wan-ssh-agent.cjs run
```

Di dalam checkout repo, jalur setara tanpa bundle tetap tersedia:

```bash
npm run ssh-gateway:build
npm run ssh-agent -- pair WANSSH1.xxxxx --allow 10.8.0.0/24
npm run ssh-agent -- run
```

Pairing tersimpan di `~/.wan-ssh/agent.json` dengan mode `0600`
(`WAN_SSH_AGENT_HOME` / `WAN_SSH_AGENT_STORE` untuk mengubah lokasi). Untuk
stack lokal `dev-anonymous`: `npm run ssh-agent -- run --dev-anonymous --url
http://localhost:5179`.

Agent mencetak ID token sendiri dari refresh token lewat endpoint Secure Token,
melakukan `agent.auth.refresh` sebelum kedaluwarsa, dan reconnect dengan
exponential backoff bila koneksi putus.

### 17A.3 Konsekuensi keamanan

- `connectClient` melewati `resolveTarget` untuk mode agent
  (`services/wan-ssh-gateway/src/sessions/ssh-session.ts`), jadi
  `WAN_SSH_EGRESS_ALLOW_CIDRS` **tidak** berlaku pada jalur ini. Penyaringan
  sepenuhnya di `src/agent-client/policy.ts`: loopback, `0.0.0.0/8`,
  `169.254.0.0/16`, multicast, dan link-local ditolak; `--allow` mempersempit
  ke CIDR VPN.
- Resolusi DNS memakai resolver mesin agent, sehingga hostname internal ikut
  bekerja tanpa konfigurasi DNS di VPS.
- Pairing code setara sesi login penuh. Jangan dikirim lewat chat; cabut dengan
  `wan-ssh-agent unpair` di mesin yang tidak dipakai lagi.
- Registry agent bersifat in-memory per instance. Bila gateway diskalakan lebih
  dari satu replica, browser dan agent wajib mendarat di instance yang sama
  (sticky session).
- Hanya hop pertama yang lewat agent; jump host berikutnya tetap
  `forwardOut` di dalam rantai SSH.

---

## 17B. Egress lewat Tailscale

Alternatif dari 17A ketika Anda bisa memasang software di jaringan target.
Berbeda dengan jalur agent, jalur ini **tidak** melewati `resolveTarget`,
sehingga `WAN_SSH_EGRESS_ALLOW_CIDRS` tetap menjadi penjaga sesungguhnya, dan
sesi tidak bergantung pada laptop yang menyala.

```text
Browser ──wss──► Gateway (VPS, node tailnet) ──100.x.y.z──► Target SSH
```

### 17B.1 Dua skenario

| | Pemasangan | Allowlist |
| --- | --- | --- |
| A. Tailscale di server target | `tailscale up` di target | `100.64.0.0/10` |
| B. Subnet router | `tailscale up --advertise-routes=10.8.0.0/24 --accept-routes` di satu mesin dalam jaringan, lalu setujui route di admin console | `100.64.0.0/10,10.8.0.0/24` |

`--accept-routes` wajib eksplisit di Linux; tanpa itu subnet router tidak
terpakai walaupun sudah disetujui.

### 17B.2 Menjalankan

Auth key dibuat di admin console Tailscale dan hanya diekspor di shell — ia
tidak pernah ditulis ke `compose.env`, repository, maupun image:

```bash
export TS_AUTHKEY=tskey-auth-xxxxx
export WAN_SSH_EGRESS_ALLOW_CIDRS=100.64.0.0/10
npm run ssh-web:up
```

`scripts/local-stack.mjs` menambahkan `docker-compose.tailscale.yml` secara
otomatis ketika `TS_AUTHKEY` ada. Sidecar bergabung ke network namespace
gateway (`network_mode: service:gateway`), jadi `proxy_pass
http://gateway:8788` di `docker/nginx.local.conf` dan seluruh `expose` tetap
tidak berubah. Container gateway sendiri tetap `cap_drop: ALL` dan
`read_only: true`; hanya sidecar yang memegang `NET_ADMIN` dan `/dev/net/tun`.

Verifikasi sebelum membuat host profile:

```bash
npm run ssh-web:tailscale-check -- 100.101.102.103 22
```

Skrip memeriksa allowlist memakai `ipMatchesCidrs` milik gateway sendiri, lalu
menguji TCP dari dalam container. Kegagalan allowlist muncul lebih dulu karena
`TARGET_DENIED` memang terjadi sebelum socket dibuka.

### 17B.3 Catatan operasional

- Isi host profile dengan **IP tailnet**, bukan nama MagicDNS: resolver di
  dalam container tidak mengenal MagicDNS sehingga gagal di fase resolve.
- Toggle "Route through the local agent" dibiarkan mati untuk jalur ini.
- Batasi jangkauan VPS lewat ACL Tailscale, bukan hanya allowlist gateway.
  Beri tag saat mendaftar (`--advertise-tags=tag:wan-ssh-gateway`) lalu izinkan
  hanya `tag:ssh-target:22`. Tanpa ACL, VPS yang terekspos internet bisa
  menjangkau seluruh tailnet.
- Paket Personal Tailscale gratis, tetapi ditujukan untuk penggunaan pribadi;
  pemakaian atas nama perusahaan masuk paket berbayar. Alternatif self-hosted:
  Headscale di VPS yang sama.

---

## 18. Observability dan Operasi

### 18.1 Metrics minimum

```text
wan_ssh_ws_connections
wan_ssh_ws_auth_total{result,reason}
wan_ssh_sessions_active
wan_ssh_sessions_open_total{result,error_code}
wan_ssh_session_duration_seconds
wan_ssh_connect_duration_seconds
wan_ssh_bytes_total{direction}
wan_ssh_hostkey_prompts_total{kind,result}
wan_ssh_backpressure_total{action}
wan_ssh_target_denied_total{reason}
wan_ssh_process_ready
```

Labels harus bounded. Jangan memakai UID, email, hostname, IP, session ID, atau
fingerprint sebagai metric label.

### 18.2 Alert minimum

- gateway not ready;
- elevated SSH connect failure;
- elevated auth failure;
- active sessions mendekati limit;
- memory/CPU tinggi;
- abnormal backpressure disconnect;
- container restart loop;
- TLS expiry;
- dependency/security release gate failure.

### 18.3 Audit metadata

Event production:

```text
session.open.requested
session.open.succeeded
session.open.failed
hostkey.accepted
hostkey.rejected
hostkey.changed.accepted
session.closed
target.denied
auth.failed
```

Metadata allowlist:

- event ID dan timestamp;
- principal/workspace internal ID;
- session/request ID;
- target host/port sesuai retention policy atau hash/alias;
- host-key fingerprint bila security policy mengizinkan;
- result/error code/duration;
- bytes count.

Tidak ada terminal content atau credential.

### 18.4 Capacity baseline

Sebelum production, ukur:

- memory per idle session;
- memory dan CPU per active high-output session;
- WebSocket buffered output;
- connect latency;
- maximum stable concurrent session;
- graceful shutdown duration;
- file descriptor usage;
- outbound connection limit VPS.

Set `MAX_SESSIONS_TOTAL` di bawah hasil load test dengan headroom, bukan
berdasarkan perkiraan.

---

## 19. Fitur Lanjutan (`NEXT`)

### 19.1 Host catalog cloud

Setelah auth stabil:

- PostgreSQL atau Firebase server-side menyimpan metadata host per tenant;
- tidak menyimpan private key pada fase pertama;
- API CRUD memakai Firebase principal;
- optimistic concurrency/version;
- audit create/update/delete;
- known-host fingerprint **sudah wajib** server-side pada production walaupun
  host catalog penuh masih ditunda;
- bila memakai PostgreSQL, migration dan backup rehearsal wajib; bila memakai
  Firebase, Admin SDK-only write path dan Rules/emulator tests wajib.

### 19.2 SFTP browser

Semantik desktop tidak dapat dipakai verbatim karena gateway tidak boleh diberi
path filesystem browser.

Target:

```text
Upload   : browser File stream -> HTTPS/WS bounded stream -> SFTP write stream
Download : SFTP read stream -> HTTP response/ReadableStream -> browser save
```

Wajib:

- backpressure end-to-end;
- size/concurrency limit;
- cancel;
- no temp file bila tidak diperlukan;
- filename/path normalization;
- CSRF/auth untuk HTTP endpoint;
- session ownership;
- malware/content policy sesuai produk.

### 19.3 Recording

- capture output pada browser atau gateway;
- default tidak merekam input;
- hasil dibuat sebagai Blob `.cast` dan di-download;
- jangan simpan server-side tanpa consent dan retention policy;
- secret masking tidak dapat dijamin untuk terminal output, jadi warning wajib.

### 19.4 Split pane

Satu WebSocket boleh memiliki beberapa session dengan limit per principal.
Gunakan state split yang sudah ada setelah routing event per `sessionId` teruji.

### 19.5 Tunnel

Semantik cloud harus dijelaskan kepada pengguna:

- local forwarding akan membuka port pada VPS gateway, bukan laptop;
- dynamic SOCKS pada VPS tidak langsung berguna bagi browser;
- remote forwarding dapat membuka akses ke network gateway dan berisiko tinggi;
- semua tunnel membutuhkan allowlist, auth tambahan, bind policy, audit, dan
  lifecycle terpisah.

Untuk tunnel pada laptop, gunakan Electron atau local agent.

### 19.6 Browser-side signing

Target keamanan lanjut agar private key tidak pernah dikirim ke VPS:

- parser key pada browser;
- WebCrypto/WASM untuk algorithm yang didukung;
- remote signing callback dari `ssh2` gateway;
- protocol challenge/signature;
- encrypted IndexedDB atau user-selected key per sesi;
- compatibility matrix RSA/ECDSA/Ed25519/FIDO;
- side-channel dan memory review.

Jangan mengklaim fitur ini selesai hanya karena browser dapat membaca key.

### 19.7 Local agent

Diperlukan untuk:

- membaca `~/.ssh` dengan izin lokal;
- `ssh-agent` dan hardware/FIDO key;
- server yang hanya dapat dijangkau dari LAN/VPN device;
- local shell;
- local/SOCKS forwarding pada device.

Local agent adalah produk/runtime terpisah dan membutuhkan pairing, origin
allowlist, installer, auto-update, loopback transport, dan security review.

---

## 20. Security Checklist

### Local MVP

- [x] Hanya `127.0.0.1:5179` dipublish ke host.
- [x] Gateway tidak mempublish `8788` ke host.
- [x] Gateway tidak me-mount `~/.ssh`.
- [x] Gateway tidak me-mount Docker socket.
- [x] Root dan service `.dockerignore` mengecualikan key, `.env`, `.tmp`, dan
  `.runtime`.
- [x] Gateway dan web berjalan non-root; fixture hanya memperoleh capability
  minimum OpenSSH yang diperiksa gate.
- [x] Origin diperiksa exact.
- [x] Host-key verification aktif.
- [x] Private key dibatasi ukuran, ephemeral, tidak dipersist, dan reference
  aplikasi dibersihkan best-effort tanpa klaim secure erasure.
- [x] Password maksimum 4096 karakter, ephemeral, tidak dipersist, dan field UI
  dibersihkan setelah submit.
- [x] Key/passphrase/password/token/terminal content tidak dicatat.
- [x] Session ownership dan limit diuji negatif.
- [x] Idle/max-session timeout aktif.
- [x] Web build tidak memuat mock atau preload desktop.
- [x] Fixture key/password berada di temporary directory luar repository; hanya
  public key dan salted password hash yang di-mount read-only ke fixture.
- [x] Desktop regression lulus.

### Production

- [ ] `WAN_SSH_ENV=production`.
- [ ] `WAN_SSH_AUTH_MODE=firebase`.
- [x] Dev auth ditolak oleh startup guard.
- [ ] HTTPS/WSS valid tanpa mixed content.
- [x] Firebase token diverifikasi server-side.
- [x] Verified token expiry dipaksa timer server; missing/invalid/revoked refresh
  menutup socket `4401` dan seluruh sesi.
- [ ] Origin menggunakan exact HTTPS allowlist, tanpa wildcard.
- [x] Egress policy menolak metadata/link-local/forbidden ranges.
- [x] SSH memakai preconnected socket ke resolved IP yang sudah diperiksa.
- [x] Forwarding header hanya dipercaya dari reverse proxy internal; spoofed
  client header ditolak/diabaikan.
- [x] Target port policy diterapkan.
- [x] Rate/session/message/key/output limits diterapkan.
- [x] UID/session ownership tidak berasal dari client.
- [x] Token tidak berada pada URL atau log.
- [ ] Image immutable, non-root, scanned, dan dipin.
- [ ] Service-account tidak berada dalam image/repository.
- [x] Known-host fingerprint durable, tenant-scoped, diaudit server-side, dan
  diverifikasi dengan Firestore Emulator.
- [ ] Core dump, Node diagnostic report, heap snapshot, APM/request-body capture,
      dan unauthorized debug/exec dinonaktifkan atau dibatasi.
- [x] Audit/metrics tidak memuat secret atau terminal content.
- [x] Graceful shutdown close `1012` dan rollback runbook tersedia.
- [ ] Live canary/rollback rehearsal di VPS.
- [x] Dependency audit tidak mempunyai High/Critical terbuka.
- [x] Incident response untuk kemungkinan credential exposure tersedia.
- [ ] Privacy/retention disclosure untuk terminal metadata ditinjau.

---

## 21. Troubleshooting

### Gateway status offline

Periksa:

```sh
npm run ssh-web:ps

npm run ssh-web:logs -- gateway

curl -v http://127.0.0.1:5179/healthz
curl -v http://127.0.0.1:5179/runtime-config.json
```

Kemungkinan:

- config startup ditolak;
- gateway health belum ready;
- reverse proxy path salah;
- port 5179 sudah dipakai;
- image build gagal.

### WebSocket langsung tertutup

Periksa:

- browser origin sama persis dengan allowlist;
- protocol version;
- frame auth sesuai `authMode` dari `/runtime-config.json`;
- auth frame terkirim dalam timeout;
- frame tidak melebihi limit;
- reverse proxy meneruskan Upgrade/Connection header;
- Firebase token belum expired.

### Target timeout

Masuk container hanya untuk diagnosis network nonsecret:

```sh
npm run ssh-web:stack -- exec gateway node -e \
  "require('node:net').connect(22, 'TARGET').once('connect',()=>{console.log('ok');process.exit(0)}).once('error',e=>{console.error(e.code);process.exit(1)})"
```

Jangan menempelkan key atau password ke command diagnosis.

Kemungkinan:

- target hanya listen loopback;
- firewall/VPN tidak dapat dijangkau Docker;
- hostname berbeda dari dalam container;
- port bukan 22;
- target policy menolak alamat.

### `host.docker.internal` gagal pada Linux

Tambahkan mapping Compose target:

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

### Key ditolak

- pastikan file private key, bukan `.pub`;
- pastikan ukuran di bawah limit;
- isi passphrase bila key encrypted;
- pastikan public key pasang pada user target yang benar;
- jangan log atau paste key ke terminal untuk diagnosis;
- gunakan `ssh -i <path> user@host` langsung dari host sebagai pembanding lokal.

### Fingerprint berubah

Jangan langsung accept. Verifikasi perubahan melalui console/provider/admin
server. Bila perubahan tidak direncanakan, hentikan koneksi dan investigasi.

### Output macet

Periksa:

- `webSocket.bufferedAmount` dan backpressure metric;
- reverse proxy timeout;
- browser tab throttling;
- SSH stream pause/resume;
- output batching;
- container memory/file descriptor.

---

## 22. Release Gate

Local MVP boleh disebut selesai hanya bila:

- `ARC-01` sampai `QA-SSH-01` selesai;
- Docker stack berjalan dari checkout bersih;
- fixture E2E menghasilkan terminal nyata;
- unknown/rejected/changed host key teruji;
- key/passphrase marker tidak ditemukan pada log/storage/build;
- session ownership, limits, idle timeout, backpressure, dan cleanup lulus;
- `dev-anonymous` runtime discovery/auth handshake dan local trusted-proxy
  subnet tests lulus;
- Electron build/test tidak regress;
- handbook command sesuai dengan command repository aktual.

Production boleh dirilis hanya bila tambahan berikut selesai:

- `AUTH-SSH-01`, `SEC-SSH-01`, dan `OPS-SSH-01` selesai;
- staging WSS dan Firebase auth teruji;
- auth expiry/refresh/revocation, egress policy, DNS rebinding, spoofed
  forwarding-header, dan authoritative known-host transaction tests lulus;
- CSP E2E lulus untuk setiap Firebase login provider yang diaktifkan;
- load/capacity test menentukan session limit;
- metrics, alert, audit, log redaction, TLS, backup metadata, canary, dan
  rollback direhearsal;
- legal/privacy review menjelaskan bahwa key ephemeral dikirim dan diproses di
  memory gateway cloud tanpa jaminan secure erasure;
- tidak ada P0/P1 atau High/Critical vulnerability terbuka.

---

## 23. Definition of Done

### Local Docker MVP

- Setelah dependency install, pengguna menjalankan satu root command
  `npm run ssh-web:up`.
- Browser terbuka pada `http://127.0.0.1:5179`.
- Gateway health dan protocol version terdeteksi.
- Pengguna memilih private key dari device.
- Browser tidak menyimpan key/passphrase.
- Gateway tidak mempersist atau mencatat key/passphrase dan melakukan
  best-effort application-reference cleanup.
- Fingerprint unknown/changed meminta keputusan pengguna.
- Terminal SSH menerima input, output, resize, dan close.
- Socket/container close membersihkan semua sesi.
- Fixture E2E otomatis wajib lulus; uji server nyata tersedia sebagai verifikasi
  manual non-gating karena tidak reproducible pada checkout bersih.
- Unified QA dan desktop regression lulus.

### Production Web + VPS

- Frontend tersedia melalui HTTPS.
- Gateway tersedia hanya melalui WSS/reverse proxy.
- Firebase login, server-owned token expiry, dan token refresh berfungsi.
- Session terisolasi per UID.
- Durable tenant-scoped known-host continuity serta target/egress policy, rate
  limit, session limit, dan timeout aktif.
- Metrics, alert, audit metadata, redacted logs, graceful deploy, dan rollback
  tersedia.
- Pengguna mendapat disclosure bahwa private key ephemeral diproses di memory
  gateway dan secure erasure tidak dapat dijamin oleh runtime.
- Staging, canary, security gate, dan recovery rehearsal lulus.

---

## 24. Ringkasan Jalur Pengerjaan

```text
CURRENT Electron SSH
  -> transport seam tanpa regression
  -> protocol WebSocket v1
  -> gateway Node.js foundation
  -> SSH key ephemeral + host-key verification
  -> WebApp Quick Connect + xterm.js
  -> Docker web + gateway + SSH fixture
  -> unified local QA
  = LOCAL MVP BERJALAN TANPA VPS

LOCAL MVP
  -> Firebase Auth
  -> production egress/security policy
  -> TLS/WSS + observability
  -> staging + canary + rollback
  = WEB + SSH GATEWAY VPS PRODUCTION

Setelah stabil
  -> host catalog cloud
  -> SFTP streaming
  -> recording
  -> split pane penuh
  -> browser-side signing atau local agent
```

Urutan ini menjaga target awal tetap sederhana: membuktikan terminal SSH web
secara lokal dengan Docker, tanpa menyimpan credential dan tanpa menunggu VPS.
Hanya setelah alur tersebut lulus seluruh gate, container yang sama dipromosikan
ke staging dan VPS dengan Firebase Auth, TLS, egress policy, dan observability.