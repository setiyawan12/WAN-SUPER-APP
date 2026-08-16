import { getApp, getApps, initializeApp, type FirebaseApp, type FirebaseOptions } from "firebase/app";
import {
  browserLocalPersistence,
  browserPopupRedirectResolver,
  connectAuthEmulator,
  getAuth,
  getRedirectResult,
  GoogleAuthProvider,
  indexedDBLocalPersistence,
  initializeAuth,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type Auth,
  type User
} from "firebase/auth";
import { connectDatabaseEmulator, getDatabase, type Database } from "firebase/database";

export interface WebFirebaseServices {
  app: FirebaseApp;
  auth: Auth;
  database?: Database;
  emulator: boolean;
}

/** Popup yang diblokir atau environment tanpa popup dialihkan ke redirect flow. */
const REDIRECT_FALLBACK_CODES = new Set([
  "auth/popup-blocked",
  "auth/operation-not-supported-in-this-environment",
  "auth/web-storage-unsupported"
]);

/**
 * Penanda bahwa halaman ini memang meninggalkan browser menuju Google. Tanpa
 * penanda, `getRedirectResult()` tidak dipanggil sehingga auth handler iframe
 * Firebase tidak pernah dimuat pada login biasa.
 */
const REDIRECT_PENDING_KEY = "wan-ssh:google-redirect";

let servicesPromise: Promise<WebFirebaseServices> | undefined;
let googleSignInPending = false;

function readRedirectFlag(): boolean {
  try {
    return window.sessionStorage.getItem(REDIRECT_PENDING_KEY) === "1";
  } catch {
    return false;
  }
}

function writeRedirectFlag(pending: boolean): void {
  try {
    if (pending) window.sessionStorage.setItem(REDIRECT_PENDING_KEY, "1");
    else window.sessionStorage.removeItem(REDIRECT_PENDING_KEY);
  } catch {
    // Session storage yang diblokir hanya menonaktifkan redirect fallback.
  }
}

function environmentValue(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function parseFirebaseConfig(raw: string): FirebaseOptions | null {
  try {
    const config = JSON.parse(raw) as FirebaseOptions;
    return config.apiKey && config.projectId && config.appId ? config : null;
  } catch {
    return null;
  }
}

/**
 * Hanya konfigurasi Firebase Web SDK yang boleh dipublikasikan ke browser.
 * Service account, private key, Admin credential, dan OAuth client secret tetap
 * server-side dan tidak pernah masuk bundle web.
 */
function environmentFirebaseConfig(): FirebaseOptions | null {
  const config: FirebaseOptions = {
    apiKey: environmentValue(import.meta.env.VITE_FIREBASE_API_KEY),
    authDomain: environmentValue(import.meta.env.VITE_FIREBASE_AUTH_DOMAIN),
    projectId: environmentValue(import.meta.env.VITE_FIREBASE_PROJECT_ID),
    databaseURL: environmentValue(import.meta.env.VITE_FIREBASE_DATABASE_URL),
    storageBucket: environmentValue(import.meta.env.VITE_FIREBASE_STORAGE_BUCKET),
    messagingSenderId: environmentValue(import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID),
    appId: environmentValue(import.meta.env.VITE_FIREBASE_APP_ID)
  };
  return config.apiKey && config.projectId && config.appId ? config : null;
}

async function loadFirebaseConfig(): Promise<FirebaseOptions> {
  const discrete = environmentFirebaseConfig();
  if (discrete) return discrete;

  const configured = import.meta.env.VITE_FIREBASE_CONFIG as string | undefined;
  const fromEnvironment = configured ? parseFirebaseConfig(configured) : null;
  if (fromEnvironment) return fromEnvironment;

  const response = await fetch("/__/firebase/init.json", { cache: "no-store" });
  if (!response.ok) throw new Error("Firebase configuration is unavailable for WAN SSH.");
  const config = await response.json() as FirebaseOptions;
  if (!config.apiKey || !config.projectId || !config.appId) {
    throw new Error("Firebase configuration is incomplete for WAN SSH.");
  }
  return config;
}

async function createServices(): Promise<WebFirebaseServices> {
  const config = await loadFirebaseConfig();
  const existing = getApps().find((candidate) => candidate.name === "wan-ssh-web");
  const app = existing ?? initializeApp(config, "wan-ssh-web");
  let auth: Auth;
  try {
    auth = initializeAuth(app, {
      persistence: [indexedDBLocalPersistence, browserLocalPersistence],
      popupRedirectResolver: browserPopupRedirectResolver
    });
  } catch {
    auth = getAuth(getApp("wan-ssh-web"));
  }

  const emulatorUrl = import.meta.env.VITE_FIREBASE_AUTH_EMULATOR_HOST as string | undefined;
  if (emulatorUrl && !(auth as Auth & { __wanEmulatorConnected?: boolean }).__wanEmulatorConnected) {
    connectAuthEmulator(auth, emulatorUrl, { disableWarnings: true });
    (auth as Auth & { __wanEmulatorConnected?: boolean }).__wanEmulatorConnected = true;
  }

  const database = config.databaseURL ? getDatabase(app) : undefined;
  const databaseEmulator = import.meta.env.VITE_FIREBASE_DATABASE_EMULATOR_HOST as string | undefined;
  if (database && databaseEmulator && !(database as Database & { __wanEmulatorConnected?: boolean }).__wanEmulatorConnected) {
    const emulator = new URL(databaseEmulator);
    connectDatabaseEmulator(database, emulator.hostname, Number(emulator.port));
    (database as Database & { __wanEmulatorConnected?: boolean }).__wanEmulatorConnected = true;
  }

  return { app, auth, database, emulator: Boolean(emulatorUrl || databaseEmulator) };
}

export function webFirebaseServices(): Promise<WebFirebaseServices> {
  servicesPromise ??= createServices();
  return servicesPromise;
}

export async function signInWebSsh(email: string, password: string): Promise<User> {
  const { auth } = await webFirebaseServices();
  return (await signInWithEmailAndPassword(auth, email, password)).user;
}

/**
 * Google sign-in memakai popup dan hanya jatuh ke redirect saat popup tidak
 * tersedia. Satu percobaan aktif dalam satu waktu agar popup tidak dobel.
 * Hasil `null` berarti browser sedang dialihkan ke Google.
 */
export async function signInWebSshGoogle(): Promise<User | null> {
  if (googleSignInPending) return null;
  googleSignInPending = true;
  try {
    const { auth } = await webFirebaseServices();
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    try {
      return (await signInWithPopup(auth, provider)).user;
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
      if (!REDIRECT_FALLBACK_CODES.has(code)) throw error;
      writeRedirectFlag(true);
      try {
        await signInWithRedirect(auth, provider);
      } catch (redirectError) {
        writeRedirectFlag(false);
        throw redirectError;
      }
      return null;
    }
  } finally {
    googleSignInPending = false;
  }
}

/**
 * Menyelesaikan redirect flow setelah browser kembali dari Google. Tanpa
 * redirect yang tertunda fungsi ini tidak menyentuh Firebase sama sekali.
 */
export async function resumeWebSshGoogleRedirect(): Promise<User | null> {
  if (!readRedirectFlag()) return null;
  writeRedirectFlag(false);
  const { auth } = await webFirebaseServices();
  const credential = await getRedirectResult(auth);
  return credential?.user ?? null;
}

export async function resetWebSshPassword(email: string): Promise<void> {
  const { auth } = await webFirebaseServices();
  await sendPasswordResetEmail(auth, email);
}

export async function signOutWebSsh(): Promise<void> {
  const { auth } = await webFirebaseServices();
  await signOut(auth);
}
