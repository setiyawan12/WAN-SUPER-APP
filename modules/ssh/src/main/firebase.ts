import * as node_fs from "node:fs";
import * as path from "node:path";
import { app, safeStorage } from "electron";
import { VAULT, logger } from "./constants.js";

export function firebaseConfigPath() {
  return path.join(app.getPath("userData"), "firebase-config.json");
}
/** Sesi Auth Firebase (refresh token) — password tidak disimpan. */
export function firebaseAuthPersistencePath() {
  return path.join(app.getPath("userData"), "firebase-auth-session.bin");
}

/**
 * Persistence LOCAL berbasis file untuk proses main Electron.
 *
 * PENTING: Firebase Auth memanggil `_getInstance(cls)` → `new cls()`.
 * Harus berupa **class/constructor**, bukan plain object. Kalau object,
 * initializeAuth gagal diam-diam dan jatuh ke in-memory → Sign in hilang tiap restart.
 */
export class FileAuthPersistence {
  static type = "LOCAL";
  type = "LOCAL";
  filePath() {
    return firebaseAuthPersistencePath();
  }
  async readStore(): Promise<any> {
    try {
      const buf = await node_fs.promises.readFile(this.filePath());
      let raw: string;
      if (safeStorage.isEncryptionAvailable()) {
        try {
          raw = safeStorage.decryptString(buf);
        } catch {
          // Fallback: file mungkin plain JSON (dev / safeStorage off dulu).
          raw = buf.toString("utf8");
        }
      } else {
        raw = buf.toString("utf8");
      }
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  async writeStore(obj: any) {
    const raw = JSON.stringify(obj);
    const target = this.filePath();
    await node_fs.promises.mkdir(path.dirname(target), { recursive: true });
    if (safeStorage.isEncryptionAvailable()) {
      const blob = safeStorage.encryptString(raw);
      await node_fs.promises.writeFile(target, blob);
    } else {
      await node_fs.promises.writeFile(target, raw, "utf8");
    }
  }
  async _isAvailable() {
    try {
      await node_fs.promises.mkdir(path.dirname(this.filePath()), { recursive: true });
      return true;
    } catch {
      return false;
    }
  }
  async _set(key: string, value: any) {
    const all = await this.readStore();
    all[key] = value;
    await this.writeStore(all);
    logger.info("Auth persistence _set", key);
  }
  async _get(key: string) {
    const all = await this.readStore();
    return Object.prototype.hasOwnProperty.call(all, key) ? all[key] : null;
  }
  async _remove(key: string) {
    const all = await this.readStore();
    if (Object.prototype.hasOwnProperty.call(all, key)) {
      delete all[key];
      await this.writeStore(all);
    }
  }
  _addListener(_key: string, _listener: any) {
    // File store single-process; multi-window listener tidak diperlukan.
  }
  _removeListener(_key: string, _listener: any) {
  }
}

export async function clearFileAuthPersistence() {
  try {
    await node_fs.promises.unlink(firebaseAuthPersistencePath());
  } catch {
  }
}

export async function loadFirebase() {
  try {
    const appMod = await import("firebase/app");
    const authMod = await import("firebase/auth");
    // Sync cloud memakai Realtime Database (bukan Firestore).
    const dbMod = await import("firebase/database");
    return { appMod, authMod, dbMod };
  } catch (e) {
    logger.warn("firebase belum terpasang; sync nonaktif", e);
    return null;
  }
}

export function loadConfig(): any {
  const env = process.env.WANN_FIREBASE_CONFIG;
  if (env) {
    try {
      return JSON.parse(env);
    } catch {
    }
  }
  try {
    const p = firebaseConfigPath();
    if (node_fs.existsSync(p)) return JSON.parse(node_fs.readFileSync(p, "utf8"));
  } catch {
  }
  return null;
}

/**
 * Transport sync → Firebase Realtime Database.
 * Path: users/{uid}/vaults/{vaultId}/items/{itemId}
 * Kontrak sama dengan transport lama (push/pull/signIn) agar SyncEngine tidak berubah.
 */
export class RealtimeDbTransport {
  config: any = loadConfig();
  fb: any = null;
  db: any = null;
  auth: any = null;
  uid: string | null = null;
  authReady: Promise<any> | null = null;
  /** Fungsi unsubscribe listener realtime RTDB (onValue) yang sedang aktif. */
  liveUnsub: any = null;
  /** UID yang sedang di-listen, agar tidak dobel-subscribe akun yang sama. */
  liveUid: string | null = null;
  /** Dipanggil saat data cloud berubah (di-set oleh AppContext → syncNow). */
  onRemoteChange: (() => void) | null = null;
  /** Dipanggil saat akun berganti (uid baru ≠ lama) → reset store lokal cloud. */
  onAccountSwitch: (() => void) | null = null;
  /** Dipanggil tiap sign-in sukses → reset cursor agar full pull akun ini. */
  onFreshLogin: (() => void) | null = null;

  isConfigured() {
    // RTDB butuh databaseURL di firebase-config.json / WANN_FIREBASE_CONFIG.
    return this.config !== null && !!this.config.databaseURL;
  }
  /** Baca ulang config dari disk (dipanggil setelah import). Reset app agar init ulang. */
  reloadConfig() {
    this.stopLiveListener();
    this.config = loadConfig();
    this.fb = null;
    this.db = null;
    this.auth = null;
    this.uid = null;
    this.authReady = null;
    return this.isConfigured();
  }
  /** Hentikan listener realtime yang sedang aktif (bila ada). */
  stopLiveListener() {
    if (typeof this.liveUnsub === "function") {
      try {
        this.liveUnsub();
      } catch (e) {
        logger.warn("stopLiveListener:", e);
      }
    }
    this.liveUnsub = null;
    this.liveUid = null;
  }
  /**
   * Pasang listener realtime ke seluruh node vault user aktif. Setiap perubahan
   * di RTDB (dari device lain / akun ini) memicu onRemoteChange → syncNow → UI reload.
   * Listener pertama kali langsung fire (initial snapshot) — diabaikan agar tidak dobel
   * dengan pull awal, kecuali memang ada data.
   */
  startLiveListener(vaultId: string) {
    if (!this.db || !this.uid) return;
    if (this.liveUid === this.uid && this.liveUnsub) return;
    this.stopLiveListener();
    const { ref, onValue } = this.fb.dbMod;
    const node = ref(this.db, `users/${this.uid}/vaults/${vaultId}/items`);
    let first = true;
    this.liveUnsub = onValue(
      node,
      () => {
        if (first) {
          first = false;
          return;
        }
        logger.info("RTDB berubah (realtime) untuk uid =", this.uid);
        if (typeof this.onRemoteChange === "function") this.onRemoteChange();
      },
      (err: any) => logger.warn("onValue error:", err)
    );
    this.liveUid = this.uid;
    logger.info("Listener realtime RTDB aktif untuk uid =", this.uid, "vault =", vaultId);
  }
  /**
   * Tangani perubahan UID (login/logout/ganti akun). Bila akun benar-benar
   * berganti (uid baru ≠ lama & keduanya tidak null), beri tahu AppContext agar
   * data cloud akun lama dibuang. Lalu pasang/lepas listener realtime.
   */
  handleUidChange(nextUid: string | null) {
    const prevUid = this.uid;
    this.uid = nextUid;
    if (prevUid && nextUid && prevUid !== nextUid) {
      logger.info("Ganti akun terdeteksi:", prevUid, "→", nextUid);
      if (typeof this.onAccountSwitch === "function") this.onAccountSwitch();
    }
    if (nextUid) {
      this.startLiveListener(VAULT.personalVaultId);
    } else {
      this.stopLiveListener();
    }
  }
  currentUser() {
    return this.uid;
  }
  async waitForAuthUser() {
    if (!this.auth) return null;
    if (typeof this.auth.authStateReady === "function") {
      await this.auth.authStateReady();
      const user = this.auth.currentUser;
      this.uid = user ? user.uid : null;
      return this.uid;
    }
    return await new Promise((resolve) => {
      const unsub = this.fb.authMod.onAuthStateChanged(this.auth, (user: any) => {
        unsub();
        this.uid = user ? user.uid : null;
        resolve(this.uid);
      });
    });
  }
  /** Key yang dipakai @firebase/auth di PersistenceUserManager. */
  authUserPersistenceKey() {
    const apiKey = this.config?.apiKey || "";
    const appName = "[DEFAULT]";
    return `firebase:authUser:${apiKey}:${appName}`;
  }
  /** Tulis user.toJSON() ke file — cadangan karena setPersistence di entry Node = no-op. */
  async persistUserSnapshot(user: any) {
    if (!user || typeof user.toJSON !== "function") return false;
    const key = this.authUserPersistenceKey();
    const snap = user.toJSON();
    const store = new FileAuthPersistence();
    await store._set(key, snap);
    // Verifikasi baca balik.
    const roundtrip = await store._get(key);
    const ok = !!(roundtrip && roundtrip.uid);
    logger.info("persistUserSnapshot", key, "ok =", ok, "uid =", snap.uid);
    return ok;
  }
  async ensureInit() {
    if (!this.config) return;
    if (!this.config.databaseURL) {
      throw new Error("firebase-config.json harus berisi databaseURL (Realtime Database)");
    }
    if (this.db && this.auth) {
      if (this.authReady) await this.authReady;
      return;
    }
    this.fb = await loadFirebase();
    if (!this.fb) throw new Error("Paket firebase belum terpasang (npm install firebase)");
    const apps = typeof this.fb.appMod.getApps === "function" ? this.fb.appMod.getApps() : [];
    const application = apps.length > 0 ? this.fb.appMod.getApp() : this.fb.appMod.initializeApp(this.config);
    // Auth DULU (sebelum getDatabase/getAuth) agar FileAuthPersistence terpasang.
    // Di entry Node, setPersistence() di-stub no-op — HANYA initializeAuth({ persistence: Class }) yang efektif.
    try {
      this.auth = this.fb.authMod.initializeAuth(application, {
        persistence: FileAuthPersistence
      });
      logger.info("Auth diinit dengan FileAuthPersistence (LOCAL file)");
    } catch (e) {
      logger.warn("initializeAuth:", e instanceof Error ? e.message : e);
      // already-initialized tanpa file persistence → sesi mungkin tidak bertahan di process ini.
      this.auth = this.fb.authMod.getAuth(application);
    }
    this.db = this.fb.dbMod.getDatabase(application);
    if (this.fb?.authMod?.onAuthStateChanged && this.auth) {
      this.fb.authMod.onAuthStateChanged(this.auth, (user: any) => {
        const nextUid = user ? user.uid : null;
        this.handleUidChange(nextUid);
        logger.info("onAuthStateChanged uid =", this.uid);
      });
    }
    this.authReady = this.waitForAuthUser().catch((e2) => {
      logger.warn("restore sesi Auth gagal", e2);
      return null;
    });
    await this.authReady;
  }
  /**
   * Pulihkan sesi dari disk (jika ada). Dipanggil saat boot / status sync.
   * Password tidak disimpan — hanya token Auth Firebase.
   */
  async restoreSession() {
    if (!this.isConfigured()) return null;
    await this.ensureInit();
    // authStateReady kadang selesai sebelum persistence file di-load — tunggu sebentar.
    if (!this.uid && this.auth) {
      for (let i = 0; i < 20 && !this.uid; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const user = this.auth.currentUser;
        this.uid = user ? user.uid : null;
      }
    }
    logger.info(
      "restoreSession uid =",
      this.uid,
      "sessionFile =",
      node_fs.existsSync(firebaseAuthPersistencePath())
    );
    // Pasang listener realtime untuk sesi yang dipulihkan (bukan lewat signIn).
    if (this.uid) this.startLiveListener(VAULT.personalVaultId);
    return this.uid;
  }
  /** Sign-in email/password. Password TIDAK disimpan (Bab 18). */
  async signIn(email: string, password: string) {
    await this.ensureInit();
    const cred = await this.fb.authMod.signInWithEmailAndPassword(this.auth, email, password);
    // handleUidChange: bila akun berbeda dari sebelumnya → reset data cloud lokal.
    this.handleUidChange(cred.user.uid);
    // Paksa FULL pull untuk akun ini: reset cursor agar startAt(0+1) menyerap
    // semua item (kalau login akun sama setelah logout, cursor lama bisa
    // menutup semua data sehingga list host kosong).
    if (typeof this.onFreshLogin === "function") this.onFreshLogin();
    try {
      if (cred.user && typeof cred.user.getIdToken === "function") {
        await cred.user.getIdToken(true);
      }
      // Cadangan eksplisit: tulis snapshot user ke file (Node setPersistence = no-op).
      await this.persistUserSnapshot(cred.user);
      await new Promise((r) => setTimeout(r, 150));
    } catch (e) {
      logger.warn("post-signIn persist:", e);
    }
    logger.info(
      "signIn OK uid =",
      this.uid,
      "sessionFile =",
      node_fs.existsSync(firebaseAuthPersistencePath())
    );
    if (!node_fs.existsSync(firebaseAuthPersistencePath())) {
      throw new Error("Sign in berhasil tapi sesi gagal disimpan ke disk");
    }
    return this.uid;
  }
  async signOut() {
    this.stopLiveListener();
    if (this.auth) await this.fb.authMod.signOut(this.auth);
    this.uid = null;
    this.liveUid = null;
    // Buang data cloud lokal agar host akun lama tidak tertinggal di UI.
    if (typeof this.onAccountSwitch === "function") this.onAccountSwitch();
    await clearFileAuthPersistence();
  }
  itemsPath(vaultId: string) {
    return `users/${this.uid}/vaults/${vaultId}/items`;
  }
  itemRef(vaultId: string, itemId: string) {
    return this.fb.dbMod.ref(this.db, `${this.itemsPath(vaultId)}/${itemId}`);
  }
  /** RTDB menolak nilai `undefined` — buang key undefined (Firestore diam-diam skip). */
  sanitize(entity: any) {
    return JSON.parse(JSON.stringify(entity));
  }
  async push(vaultId: string, entities: any[]) {
    if (!this.uid) throw new Error("Belum sign-in");
    await this.ensureInit();
    const { set } = this.fb.dbMod;
    for (const entity of entities) {
      // Soft-delete tetap disimpan sebagai node (deletedAt terisi) agar pull peer konsisten.
      await set(this.itemRef(vaultId, entity.id), this.sanitize(entity));
    }
  }
  async pull(vaultId: string, since: number) {
    if (!this.uid) throw new Error("Belum sign-in");
    await this.ensureInit();
    const { ref, query, orderByChild, startAt, get } = this.fb.dbMod;
    // startAt(since+1) meniru where("updatedAt", ">", since) di Firestore.
    // Butuh index: users/{uid}/vaults/{vaultId}/items → ".indexOn": ["updatedAt"]
    const q = query(
      ref(this.db, this.itemsPath(vaultId)),
      orderByChild("updatedAt"),
      startAt(Number(since) + 1)
    );
    const snap = await get(q);
    if (!snap.exists()) return [];
    const val = snap.val();
    if (!val || typeof val !== "object") return [];
    return Object.values(val).filter((e: any) => e && typeof e === "object" && e.id);
  }
}
